import asyncio
import logging
import os
import time

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request
import orjson
from ..rate_limit import limiter
from ..db import rest_select, rest_upsert, rest_delete
from ..cache_utils import invalidate_namespace
from ..models import FavouriteCourt, FavouriteCourtCreate

router = APIRouter(prefix="/favouritecourts", tags=["favouritecourts"])
logger = logging.getLogger("favouritecourts")

_FAV_CACHE_FRESH_SECONDS = int(os.getenv("FAVOURITECOURTS_CACHE_FRESH_SECONDS", "60"))
_FAV_CACHE_STALE_SECONDS = int(os.getenv("FAVOURITECOURTS_CACHE_STALE_SECONDS", "180"))
_FAV_CACHE_HARD_SECONDS = _FAV_CACHE_FRESH_SECONDS + _FAV_CACHE_STALE_SECONDS
_FAV_REFRESH_LOCK_SECONDS = int(os.getenv("FAVOURITECOURTS_REFRESH_LOCK_SECONDS", "30"))


def _favourites_cache_key(*, userid: int | None, ids_only: bool) -> str:
    uid = "all" if userid is None else str(userid)
    return f"sportsconnect:favouritecourts:list:userid={uid}:ids_only={int(ids_only)}"


def _favourites_refresh_lock_key(cache_key: str) -> str:
    return f"{cache_key}:refresh-lock"


def _pack_cached_payload(payload: list[dict]) -> bytes:
    return orjson.dumps({"cached_at": time.time(), "data": payload})


def _unpack_cached_payload(raw: bytes | str) -> tuple[list[dict] | None, float | None]:
    parsed = orjson.loads(raw)
    if not isinstance(parsed, dict):
        return None, None
    data = parsed.get("data")
    cached_at = parsed.get("cached_at")
    if not isinstance(data, list):
        return None, None
    normalized = [row for row in data if isinstance(row, dict)]
    try:
        age_seconds = max(0.0, time.time() - float(cached_at))
    except Exception:
        age_seconds = None
    return normalized, age_seconds


def _load_favourites_sync(*, userid: int | None, ids_only: bool) -> list[dict]:
    select = "courtid" if ids_only else "favouriteid,userid,courtid"
    filters = {"userid": userid} if userid is not None else None
    rows = rest_select("favouritecourts", select, filters=filters)
    return rows if isinstance(rows, list) else []


async def _load_favourites(*, userid: int | None, ids_only: bool) -> list[dict]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: _load_favourites_sync(userid=userid, ids_only=ids_only))


async def _refresh_favourites_cache(*, app: object, cache_key: str, userid: int | None, ids_only: bool) -> None:
    redis = getattr(app.state, "redis", None)
    if redis is None:
        return
    lock_key = _favourites_refresh_lock_key(cache_key)
    acquired = False
    try:
        acquired = bool(await redis.set(lock_key, "1", ex=_FAV_REFRESH_LOCK_SECONDS, nx=True))
        if not acquired:
            return
        fresh_rows = await _load_favourites(userid=userid, ids_only=ids_only)
        await redis.set(cache_key, _pack_cached_payload(fresh_rows), ex=_FAV_CACHE_HARD_SECONDS)
    except Exception as exc:
        logger.warning("favouritecourts_swr_refresh_failed key=%s err=%s", cache_key, exc)
    finally:
        if acquired:
            try:
                await redis.delete(lock_key)
            except Exception:
                pass


def _schedule_background_refresh(coro: object) -> None:
    task = asyncio.create_task(coro)

    def _on_done(done: asyncio.Task) -> None:
        try:
            done.result()
        except Exception as exc:
            logger.warning("favouritecourts_background_task_failed err=%s", exc)

    task.add_done_callback(_on_done)


async def _invalidate_favouritecourts_swr_cache(request: Request) -> None:
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        return
    async for key in redis.scan_iter(match="sportsconnect:favouritecourts:list:*", count=100):
        await redis.delete(key)


@router.get("", response_model=list[FavouriteCourt])
async def list_favourite_courts(request: Request, userid: int | None = Query(default=None), ids_only: bool = Query(default=False)):
    """Public list of favourite courts. Optionally filter by userid; ids_only returns only courtids."""
    try:
        cache_key = _favourites_cache_key(userid=userid, ids_only=ids_only)
        redis = getattr(request.app.state, "redis", None)
        if redis is not None:
            raw = await redis.get(cache_key)
            if raw is not None:
                cached_rows, age_seconds = _unpack_cached_payload(raw)
                if cached_rows is not None and age_seconds is not None:
                    if age_seconds <= _FAV_CACHE_FRESH_SECONDS:
                        return cached_rows
                    if age_seconds <= _FAV_CACHE_HARD_SECONDS:
                        _schedule_background_refresh(
                            _refresh_favourites_cache(
                                app=request.app,
                                cache_key=cache_key,
                                userid=userid,
                                ids_only=ids_only,
                            )
                        )
                        return cached_rows

        fresh_rows = await _load_favourites(userid=userid, ids_only=ids_only)
        if redis is not None:
            await redis.set(cache_key, _pack_cached_payload(fresh_rows), ex=_FAV_CACHE_HARD_SECONDS)
        return fresh_rows
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("", response_model=FavouriteCourt)
@limiter.limit("12/minute")
async def add_favourite_court(request: Request, body: FavouriteCourtCreate, background_tasks: BackgroundTasks):
    """Idempotent add: returns existing favourite if (userid,courtid) already present.

    Performs existence checks for referenced user & court to avoid 500 errors from FK violations.
    Returns 400 with a clear message if either does not exist.
    """
    try:
        # Attach userid for per-user rate limiting
        request.state.user_id = body.userid
        # Validate referenced user exists
        user_row = rest_select("users", "userid", filters={"userid": body.userid}, single=True)
        if user_row is None:
            raise HTTPException(status_code=400, detail=f"User {body.userid} does not exist")
        # Validate referenced court exists
        court_row = rest_select("courts", "courtid", filters={"courtid": body.courtid}, single=True)
        if court_row is None:
            raise HTTPException(status_code=400, detail=f"Court {body.courtid} does not exist")

        # Check for existing favourite first (manual uniqueness until DB constraint added)
        existing = rest_select(
            "favouritecourts",
            "favouriteid,userid,courtid",
            filters={"userid": body.userid, "courtid": body.courtid},
            single=False,
        )
        if isinstance(existing, list) and existing:
            return existing[0]
        payload = {"userid": body.userid, "courtid": body.courtid}
        resp = rest_upsert("favouritecourts", payload)
        if isinstance(resp, list) and resp:
            background_tasks.add_task(invalidate_namespace, "favouritecourts")
            background_tasks.add_task(_invalidate_favouritecourts_swr_cache, request)
            return resp[0]
        return {"favouriteid": -1, **payload}
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/toggle")
@limiter.limit("20/minute")  # toggle can be a bit higher to avoid frustration
async def toggle_favourite(request: Request, body: FavouriteCourtCreate, background_tasks: BackgroundTasks):
    """Toggle favourite for a user/court pair. Returns action and record.

    Response shape:
    { action: "added"|"removed", favourite: FavouriteCourt | None }
    Performs existence checks for user & court.
    """
    try:
        request.state.user_id = body.userid
        user_row = rest_select("users", "userid", filters={"userid": body.userid}, single=True)
        if user_row is None:
            raise HTTPException(status_code=400, detail=f"User {body.userid} does not exist")
        court_row = rest_select("courts", "courtid", filters={"courtid": body.courtid}, single=True)
        if court_row is None:
            raise HTTPException(status_code=400, detail=f"Court {body.courtid} does not exist")

        existing = rest_select(
            "favouritecourts",
            "favouriteid,userid,courtid",
            filters={"userid": body.userid, "courtid": body.courtid},
            single=False,
        )
        if isinstance(existing, list) and existing:
            fav_id = existing[0]["favouriteid"]
            rest_delete("favouritecourts", {"favouriteid": fav_id})
            background_tasks.add_task(invalidate_namespace, "favouritecourts")
            background_tasks.add_task(_invalidate_favouritecourts_swr_cache, request)
            return {"action": "removed", "favourite": None}
        payload = {"userid": body.userid, "courtid": body.courtid}
        resp = rest_upsert("favouritecourts", payload)
        favourite = resp[0] if isinstance(resp, list) and resp else {"favouriteid": -1, **payload}
        background_tasks.add_task(invalidate_namespace, "favouritecourts")
        background_tasks.add_task(_invalidate_favouritecourts_swr_cache, request)
        return {"action": "added", "favourite": favourite}
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{favouriteid}")
@limiter.limit("12/minute")
async def remove_favourite_court(request: Request, favouriteid: int, background_tasks: BackgroundTasks):
    """Public delete favourite by primary key favouriteid."""
    try:
        # Optionally scope by user if we can resolve it quickly
        row = rest_select("favouritecourts", "userid", filters={"favouriteid": favouriteid}, single=True)
        if isinstance(row, dict) and "userid" in row:
            request.state.user_id = row["userid"]
        resp = rest_delete("favouritecourts", {"favouriteid": favouriteid})
        background_tasks.add_task(invalidate_namespace, "favouritecourts")
        background_tasks.add_task(_invalidate_favouritecourts_swr_cache, request)
        return {"deleted": True, "count": len(resp) if isinstance(resp, list) else 0}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

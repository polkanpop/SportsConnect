import re
import asyncio
import logging
import os
import time
from typing import Any

import orjson
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Depends
from fastapi_cache.decorator import cache
from fastapi import Request
from ..db import rest_select, rest_upsert, rest_update
from ..auth import get_current_user
from ..cache_utils import invalidate_namespace, make_key_builder

router = APIRouter(prefix="/courtavailability", tags=["courts"])
logger = logging.getLogger("courtavailability")

PRIMARY_KEY = "availabilityid"
_CACHE_FRESH_SECONDS = int(os.getenv("COURTAVAILABILITY_CACHE_FRESH_SECONDS", "60"))
_CACHE_STALE_SECONDS = int(os.getenv("COURTAVAILABILITY_CACHE_STALE_SECONDS", "240"))
_CACHE_HARD_SECONDS = _CACHE_FRESH_SECONDS + _CACHE_STALE_SECONDS
_REFRESH_LOCK_SECONDS = int(os.getenv("COURTAVAILABILITY_REFRESH_LOCK_SECONDS", "30"))

ALLOWED_DAYS: set[str] = {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
_TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$")


def _normalize_time(s: Any) -> str | None:
    if s is None:
        return None
    raw = str(s).strip()
    if not _TIME_RE.match(raw):
        raise ValueError("Invalid time format; expected HH:MM")
    parts = raw.split(":")
    hh = int(parts[0])
    mm = int(parts[1])
    ss = int(parts[2]) if len(parts) == 3 else 0
    ss = max(0, min(59, ss))
    return f"{hh:02d}:{mm:02d}:{ss:02d}"


def _normalize_days(v: Any) -> list[str] | None:
    if v is None:
        return None
    if not isinstance(v, list):
        raise ValueError("booking_date must be a list")
    out = [str(x).strip() for x in v if isinstance(x, str) and str(x).strip()]
    out = [x for x in out if x in ALLOWED_DAYS]
    # Deduplicate preserving order
    dedup: list[str] = []
    seen: set[str] = set()
    for d in out:
        if d in seen:
            continue
        seen.add(d)
        dedup.append(d)
    return dedup


def _enforce_owner_by_courtid(*, courtid: int, current_user: str) -> None:
    try:
        numeric_subject = int(current_user) if str(current_user).isdigit() else None
    except Exception:
        numeric_subject = None
    if numeric_subject is None:
        return
    court = rest_select("courts", "courtid,ownerid", filters={"courtid": courtid}, single=True)
    if not court:
        raise HTTPException(status_code=404, detail="Court not found")
    try:
        ownerid = int(court.get("ownerid"))
    except Exception:
        ownerid = None
    if ownerid is not None and ownerid != numeric_subject:
        raise HTTPException(status_code=403, detail="Not allowed")


def _list_playingcourt_ids_for_courtid(courtid: int) -> list[int]:
    rows = rest_select("playingcourt", "playingcourtid", filters={"courtid": courtid}, order={"column": "playingcourtid"})
    out: list[int] = []
    if isinstance(rows, list):
        for r in rows:
            if isinstance(r, dict) and r.get("playingcourtid") is not None:
                try:
                    out.append(int(r.get("playingcourtid")))
                except Exception:
                    pass
    return out


def _enforce_owner_by_playingcourtid(*, playingcourtid: int, current_user: str) -> None:
    pc = rest_select("playingcourt", "courtid", filters={"playingcourtid": playingcourtid}, single=True)
    if not pc:
        raise HTTPException(status_code=404, detail="Playing court not found")
    try:
        courtid = int(pc.get("courtid"))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid playingcourtid")
    _enforce_owner_by_courtid(courtid=courtid, current_user=current_user)


def _cache_by_id_key(availabilityid: int) -> str:
    return f"sportsconnect:courtavailability:id:{availabilityid}"


def _refresh_lock_key(cache_key: str) -> str:
    return f"{cache_key}:refresh-lock"


def _pack_cached_payload(payload: Any) -> bytes:
    return orjson.dumps({"cached_at": time.time(), "data": payload})


def _unpack_cached_payload(raw: bytes | str) -> tuple[Any | None, float | None]:
    parsed = orjson.loads(raw)
    if not isinstance(parsed, dict):
        return None, None
    try:
        age_seconds = max(0.0, time.time() - float(parsed.get("cached_at")))
    except Exception:
        age_seconds = None
    return parsed.get("data"), age_seconds


def _schedule_background_refresh(coro: Any) -> None:
    task = asyncio.create_task(coro)

    def _on_done(done: asyncio.Task) -> None:
        try:
            done.result()
        except Exception as exc:
            logger.warning("courtavailability_background_refresh_failed err=%s", exc)

    task.add_done_callback(_on_done)


async def _invalidate_courtavailability_swr_cache(request: Request) -> None:
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        return
    async for key in redis.scan_iter(match="sportsconnect:courtavailability:*", count=100):
        await redis.delete(key)


def _load_courtavailability_by_id_sync(availabilityid: int) -> dict[str, Any] | None:
    row = rest_select("courtavailability", "*", filters={PRIMARY_KEY: availabilityid}, single=True)
    if not row:
        return None

    pcid = row.get("playingcourtid")
    try:
        pcid = int(pcid) if pcid is not None else None
    except Exception:
        pcid = None

    pc = rest_select(
        "playingcourt",
        "playingcourtid,courtid,name,base_name,part,surface,price",
        filters={"playingcourtid": pcid},
        single=True,
    ) if pcid is not None else None

    courtid = None
    if isinstance(pc, dict) and pc.get("courtid") is not None:
        try:
            courtid = int(pc.get("courtid"))
        except Exception:
            courtid = None
    if courtid is None and row.get("courtid") is not None:
        try:
            courtid = int(row.get("courtid"))
        except Exception:
            courtid = None

    court = rest_select("courts", "courtid,courtinfo,ownerid", filters={"courtid": courtid}, single=True) if courtid is not None else None
    info = rest_select("courtinfo", "courtid,name,address,images,venue", filters={"courtid": courtid}, single=True) if courtid is not None else None

    ownerid = None
    if isinstance(court, dict) and court.get("ownerid") is not None:
        try:
            ownerid = int(court.get("ownerid"))
        except Exception:
            ownerid = None
    owner_profile = rest_select("userinfo", "userid,name,pfp", filters={"userid": ownerid}, single=True) if ownerid is not None else None

    thumbnail = None
    images = info.get("images") if isinstance(info, dict) else None
    if isinstance(images, list) and images:
        first = images[0]
        if isinstance(first, str) and first.strip():
            thumbnail = first.strip()

    return {
        **row,
        "courtid": courtid,
        "playingcourt": pc if isinstance(pc, dict) else None,
        "court": court if isinstance(court, dict) else None,
        "courtinfo": info if isinstance(info, dict) else None,
        "court_name": (pc or {}).get("name") if isinstance(pc, dict) else ((info or {}).get("name") if isinstance(info, dict) else None),
        "court_address": (info or {}).get("address") if isinstance(info, dict) else None,
        "court_thumbnail": thumbnail,
        "ownerid": ownerid,
        "owner_name": (owner_profile or {}).get("name") if isinstance(owner_profile, dict) else None,
        "owner_pfp": (owner_profile or {}).get("pfp") if isinstance(owner_profile, dict) else None,
    }


async def _load_courtavailability_by_id(availabilityid: int) -> dict[str, Any] | None:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: _load_courtavailability_by_id_sync(availabilityid))


async def _refresh_by_id_cache(*, app: Any, cache_key: str, availabilityid: int) -> None:
    redis = getattr(app.state, "redis", None)
    if redis is None:
        return
    lock_key = _refresh_lock_key(cache_key)
    acquired = False
    try:
        acquired = bool(await redis.set(lock_key, "1", ex=_REFRESH_LOCK_SECONDS, nx=True))
        if not acquired:
            return
        fresh_row = await _load_courtavailability_by_id(availabilityid)
        await redis.set(cache_key, _pack_cached_payload(fresh_row), ex=_CACHE_HARD_SECONDS)
    finally:
        if acquired:
            try:
                await redis.delete(lock_key)
            except Exception:
                pass

@router.get("", response_model=list[dict])
@cache(expire=120, key_builder=make_key_builder("courtavailability"))
def list_court_availability(
    courtid: int | None = Query(None),
    playingcourtid: int | None = Query(None),
    status: str | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    try:
        if playingcourtid is not None:
            filters: dict[str, int | str] = {"playingcourtid": playingcourtid}
            if status is not None:
                filters["status"] = status
            data = rest_select("courtavailability", "*", filters=filters or None, order={"column": PRIMARY_KEY})
            if isinstance(data, list):
                data = data[offset : offset + limit]
            return data if isinstance(data, list) else []

        # Backward-compatible mode: list by courtid (resolve to playingcourtid list).
        if courtid is None:
            filters: dict[str, int | str] = {}
            if status is not None:
                filters["status"] = status
            data = rest_select("courtavailability", "*", filters=filters or None, order={"column": PRIMARY_KEY})
            if isinstance(data, list):
                data = data[offset : offset + limit]
            return data if isinstance(data, list) else []

        pc_ids = _list_playingcourt_ids_for_courtid(courtid)
        rows: list[dict] = []
        for pcid in pc_ids:
            filters = {"playingcourtid": pcid}
            if status is not None:
                filters["status"] = status
            data = rest_select("courtavailability", "*", filters=filters or None, order={"column": PRIMARY_KEY})
            if isinstance(data, list):
                rows.extend([r for r in data if isinstance(r, dict)])
        rows.sort(key=lambda r: int(r.get(PRIMARY_KEY) or 0))
        return rows[offset : offset + limit]
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{availabilityid}", response_model=dict)
async def get_court_availability(request: Request, availabilityid: int):
    try:
        cache_key = _cache_by_id_key(availabilityid)
        redis = getattr(request.app.state, "redis", None)
        if redis is not None:
            raw = await redis.get(cache_key)
            if raw is not None:
                cached_row, age_seconds = _unpack_cached_payload(raw)
                if age_seconds is not None:
                    if age_seconds <= _CACHE_FRESH_SECONDS:
                        if cached_row:
                            return cached_row
                        raise HTTPException(status_code=404, detail="Availability slot not found")
                    if age_seconds <= _CACHE_HARD_SECONDS:
                        _schedule_background_refresh(
                            _refresh_by_id_cache(
                                app=request.app,
                                cache_key=cache_key,
                                availabilityid=availabilityid,
                            )
                        )
                        if cached_row:
                            return cached_row
                        raise HTTPException(status_code=404, detail="Availability slot not found")

        row = await _load_courtavailability_by_id(availabilityid)
        if redis is not None:
            await redis.set(cache_key, _pack_cached_payload(row), ex=_CACHE_HARD_SECONDS)
        if not row:
            raise HTTPException(status_code=404, detail="Availability slot not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_court_availability(request: Request, body: dict, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
    """Create an availability slot.

    New schema: body should include playingcourtid, start_time, end_time, status, booking_date.
    """
    try:
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Invalid payload")

        payload: dict[str, Any] = dict(body)
        # Back-compat: if courtid is provided but playingcourtid is not, default to the first FULL playing court.
        if payload.get("playingcourtid") in (None, "") and payload.get("courtid") is not None:
            try:
                courtid = int(payload.get("courtid"))
            except Exception:
                raise HTTPException(status_code=400, detail="Invalid courtid")
            pcs = rest_select("playingcourt", "playingcourtid", filters={"courtid": courtid, "part": "full"}, order={"column": "playingcourtid"})
            pc = pcs[0] if isinstance(pcs, list) and pcs else None
            pcid = pc.get("playingcourtid") if isinstance(pc, dict) else None
            if pcid is None:
                raise HTTPException(status_code=400, detail="No playing courts exist for this court")
            payload["playingcourtid"] = int(pcid)

        # Strip legacy column if present (DB may have dropped it).
        payload.pop("courtid", None)

        resp = rest_upsert("courtavailability", payload)
        background_tasks.add_task(invalidate_namespace, "courtavailability")
        background_tasks.add_task(_invalidate_courtavailability_swr_cache, request)
        return resp[0] if isinstance(resp, list) and resp else body
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/by-courtid/{courtid}", response_model=list[dict])
def patch_court_availability_by_courtid(request: Request, courtid: int, body: dict, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
    """Update availability slots for a court.

    Intended for updating the default schedule row created by /courts/register.
    """
    _enforce_owner_by_courtid(courtid=courtid, current_user=current_user)

    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")

    patch: dict[str, Any] = {}
    try:
        if "start_time" in body:
            patch["start_time"] = _normalize_time(body.get("start_time"))
        if "end_time" in body:
            patch["end_time"] = _normalize_time(body.get("end_time"))
        if "booking_date" in body:
            patch["booking_date"] = _normalize_days(body.get("booking_date"))
        if "status" in body:
            patch["status"] = str(body.get("status") or "").strip()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    patch = {k: v for k, v in patch.items() if v is not None}
    if not patch:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    try:
        pc_ids = _list_playingcourt_ids_for_courtid(courtid)
        updated_all: list[dict] = []
        for pcid in pc_ids:
            updated = rest_update("courtavailability", {"playingcourtid": pcid}, patch)
            if isinstance(updated, list):
                updated_all.extend([r for r in updated if isinstance(r, dict)])
            elif isinstance(updated, dict):
                updated_all.append(updated)
        background_tasks.add_task(invalidate_namespace, "courtavailability")
        background_tasks.add_task(_invalidate_courtavailability_swr_cache, request)
        return updated_all
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/by-playingcourtid/{playingcourtid}", response_model=list[dict])
def patch_court_availability_by_playingcourtid(
    request: Request,
    playingcourtid: int,
    body: dict,
    background_tasks: BackgroundTasks,
    current_user: str = Depends(get_current_user),
):
    """Update availability slot(s) for a specific playing court.

    New schema expects courtavailability rows keyed by playingcourtid.
    """

    _enforce_owner_by_playingcourtid(playingcourtid=playingcourtid, current_user=current_user)

    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")

    patch: dict[str, Any] = {}
    try:
        if "start_time" in body:
            patch["start_time"] = _normalize_time(body.get("start_time"))
        if "end_time" in body:
            patch["end_time"] = _normalize_time(body.get("end_time"))
        if "booking_date" in body:
            patch["booking_date"] = _normalize_days(body.get("booking_date"))
        if "status" in body:
            patch["status"] = str(body.get("status") or "").strip()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    patch = {k: v for k, v in patch.items() if v is not None}
    if not patch:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    try:
        updated = rest_update("courtavailability", {"playingcourtid": playingcourtid}, patch)
        result: list[dict]
        if isinstance(updated, list):
            result = [r for r in updated if isinstance(r, dict)]
        elif isinstance(updated, dict):
            result = [updated]
        else:
            result = []
        background_tasks.add_task(invalidate_namespace, "courtavailability")
        background_tasks.add_task(_invalidate_courtavailability_swr_cache, request)
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

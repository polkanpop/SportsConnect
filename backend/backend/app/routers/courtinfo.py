import asyncio
import logging
import os
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
import orjson
from ..auth import get_current_user
from ..cache_utils import invalidate_namespace
from ..cloudinary_urls import apply_cloudinary_transform, apply_cloudinary_transform_list
from ..db import rest_select, rest_update
from ..models import CourtInfo

router = APIRouter(prefix="/courtinfo", tags=["courtinfo"])
logger = logging.getLogger("courtinfo")

ALLOWED_VENUES: set[str] = {"Indoor", "Outdoor"}
_COURTINFO_CACHE_FRESH_SECONDS = int(os.getenv("COURTINFO_CACHE_FRESH_SECONDS", "120"))
_COURTINFO_CACHE_STALE_SECONDS = int(os.getenv("COURTINFO_CACHE_STALE_SECONDS", "300"))
_COURTINFO_CACHE_HARD_SECONDS = _COURTINFO_CACHE_FRESH_SECONDS + _COURTINFO_CACHE_STALE_SECONDS
_COURTINFO_REFRESH_LOCK_SECONDS = int(os.getenv("COURTINFO_REFRESH_LOCK_SECONDS", "45"))
_COURTINFO_DEFAULT_PREWARM_LIMIT = int(os.getenv("COURTINFO_DEFAULT_PREWARM_LIMIT", "15"))
_COURTINFO_LIST_IMAGE_WIDTH = 500
_COURTINFO_DETAIL_IMAGE_WIDTH = 1000


def _attach_min_full_prices(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    court_ids: list[int] = []
    for row in rows:
        try:
            court_ids.append(int(row.get("courtid")))
        except Exception:
            continue

    if not court_ids:
        return rows

    min_price_by_courtid: dict[int, float] = {}
    try:
        price_rows = rest_select(
            "playingcourt",
            "courtid,price",
            filters={"courtid": sorted(set(court_ids)), "part": "full"},
            order={"column": "price"},
        )
        for row in price_rows if isinstance(price_rows, list) else []:
            try:
                courtid = int(row.get("courtid"))
                price = float(row.get("price"))
            except Exception:
                continue
            prev = min_price_by_courtid.get(courtid)
            if prev is None or price < prev:
                min_price_by_courtid[courtid] = price
    except Exception:
        return rows

    for row in rows:
        try:
            courtid = int(row.get("courtid"))
        except Exception:
            continue
        if courtid in min_price_by_courtid:
            row["price"] = min_price_by_courtid[courtid]
    return rows


def _compact_courtinfo_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    compact: list[dict[str, Any]] = []
    for row in rows:
        images = row.get("images")
        thumbnail = None
        if isinstance(images, list):
            for candidate in images:
                if isinstance(candidate, str) and candidate.strip():
                    thumbnail = apply_cloudinary_transform(candidate.strip(), width=_COURTINFO_LIST_IMAGE_WIDTH)
                    break
        compact.append(
            {
                "courtinfoid": row.get("courtinfoid"),
                "courtid": row.get("courtid"),
                "name": row.get("name"),
                "thumbnail": thumbnail,
                "price": row.get("price"),
            }
        )
    return compact


def _apply_detail_image_transform_to_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for row in rows:
        images = row.get("images")
        if isinstance(images, list):
            row["images"] = apply_cloudinary_transform_list(images, width=_COURTINFO_DETAIL_IMAGE_WIDTH)
    return rows


def _normalize_images(v: Any) -> list[str] | None:
    if v is None:
        return None
    if isinstance(v, list):
        out = [str(x).strip() for x in v if isinstance(x, str) and str(x).strip()]
        return out
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return []
        # Accept JSON-ish list string; fallback to comma-separated.
        if s.startswith("[") and s.endswith("]"):
            inner = s[1:-1]
            parts = [p.strip().strip('"') for p in inner.split(",")]
            return [p for p in parts if p]
        if "," in s:
            return [p.strip() for p in s.split(",") if p.strip()]
        return [s]
    return None


def _normalize_venue(v: Any) -> list[str] | None:
    if v is None:
        return None
    if isinstance(v, str):
        raw = v.strip()
        if raw == "Both":
            return ["Indoor", "Outdoor"]
        if raw in ALLOWED_VENUES:
            return [raw]
        return None
    if isinstance(v, list):
        cleaned = [str(x).strip() for x in v if isinstance(x, str)]
        cleaned = [x for x in cleaned if x in ALLOWED_VENUES]
        if not cleaned:
            return []
        # Deduplicate while preserving order
        out: list[str] = []
        seen: set[str] = set()
        for x in cleaned:
            if x in seen:
                continue
            seen.add(x)
            out.append(x)
        return out
    return None


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


def _courtinfo_list_cache_key(*, courtids: str | None, limit: int | None, compact: bool) -> str:
    cid_part = (courtids or "").strip() or "all"
    mode = "compact" if compact else "full"
    limit_part = str(limit) if limit is not None else "all"
    return f"sportsconnect:courtinfo:list:mode={mode}:courtids={cid_part}:limit={limit_part}"


def _courtinfo_list_refresh_lock_key(cache_key: str) -> str:
    return f"{cache_key}:refresh-lock"


def _pack_cached_payload(payload: list[dict[str, Any]]) -> bytes:
    return orjson.dumps({"cached_at": time.time(), "data": payload})


def _unpack_cached_payload(raw: bytes | str) -> tuple[list[dict[str, Any]] | None, float | None]:
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


def _load_courtinfo_rows_sync(*, courtids: str | None, limit: int | None, compact: bool) -> list[dict[str, Any]]:
    select_cols = (
        "courtinfoid,courtid,name,address,latitude,longitude,venue,images,availability,accuracy_type,auto_approve"
        if not compact
        else "courtinfoid,courtid,name,images"
    )
    data_all = rest_select(
        "courtinfo",
        select_cols,
        order={"column": "courtinfoid"},
    )
    rows = data_all if isinstance(data_all, list) else []

    if courtids:
        try:
            wanted = {int(x) for x in courtids.split(",") if x.strip().isdigit()}
        except ValueError:
            wanted = set()
        if wanted:
            rows = [d for d in rows if isinstance(d, dict) and d.get("courtid") in wanted]

    rows = [d for d in rows if isinstance(d, dict)]
    rows = _attach_min_full_prices(rows)
    if limit is not None:
        rows = rows[: max(1, limit)]
    if compact:
        return _compact_courtinfo_rows(rows)
    rows = _apply_detail_image_transform_to_rows(rows)
    return rows


async def _load_courtinfo_rows(*, courtids: str | None, limit: int | None, compact: bool) -> list[dict[str, Any]]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None,
        lambda: _load_courtinfo_rows_sync(courtids=courtids, limit=limit, compact=compact),
    )


async def _refresh_courtinfo_list_cache(*, app: Any, cache_key: str, courtids: str | None, limit: int | None, compact: bool) -> None:
    redis = getattr(app.state, "redis", None)
    if redis is None:
        return

    lock_key = _courtinfo_list_refresh_lock_key(cache_key)
    acquired = False
    try:
        acquired = bool(await redis.set(lock_key, "1", ex=_COURTINFO_REFRESH_LOCK_SECONDS, nx=True))
        if not acquired:
            return
        fresh_rows = await _load_courtinfo_rows(courtids=courtids, limit=limit, compact=compact)
        await redis.set(cache_key, _pack_cached_payload(fresh_rows), ex=_COURTINFO_CACHE_HARD_SECONDS)
    except Exception as exc:
        logger.warning("courtinfo_swr_refresh_failed key=%s err=%s", cache_key, exc)
    finally:
        if acquired:
            try:
                await redis.delete(lock_key)
            except Exception:
                pass


def _schedule_background_refresh(coro: Any) -> None:
    task = asyncio.create_task(coro)

    def _on_done(done: asyncio.Task) -> None:
        try:
            done.result()
        except Exception as exc:
            logger.warning("courtinfo_background_task_failed err=%s", exc)

    task.add_done_callback(_on_done)


async def prewarm_default_courtinfo_and_venues_cache(app: Any) -> None:
    """Warm the exact default courtinfo list query (limit=15) and related venue booking-data caches."""
    redis = getattr(app.state, "redis", None)
    if redis is None:
        logger.info("courtinfo_default_prewarm skipped: redis unavailable")
        return

    limit = max(1, _COURTINFO_DEFAULT_PREWARM_LIMIT)
    cache_key = _courtinfo_list_cache_key(courtids=None, limit=limit, compact=False)
    rows = await _load_courtinfo_rows(courtids=None, limit=limit, compact=False)
    await redis.set(cache_key, _pack_cached_payload(rows), ex=_COURTINFO_CACHE_HARD_SECONDS)

    court_ids: list[int] = []
    for row in rows:
        try:
            court_ids.append(int(row.get("courtid")))
        except Exception:
            continue

    if court_ids:
        from . import venues

        await venues.prewarm_venues_cache_for_courts(app, court_ids)
    logger.info("courtinfo_default_prewarm completed rows=%s linked_venues=%s", len(rows), len(court_ids))

@router.get("", response_model=list[CourtInfo])
async def list_courts(
    request: Request,
    courtids: str | None = Query(default=None),
    limit: int | None = Query(default=None, ge=1, le=500),
    compact: bool = Query(default=False),
):
    """List courtinfo rows. Optional filter: ?courtids=1,2,3
    (Client-side subset until REST helper supports IN filter)."""
    try:
        cache_key = _courtinfo_list_cache_key(courtids=courtids, limit=limit, compact=compact)
        redis = getattr(request.app.state, "redis", None)

        if redis is not None:
            raw = await redis.get(cache_key)
            if raw is not None:
                cached_rows, age_seconds = _unpack_cached_payload(raw)
                if cached_rows is not None and age_seconds is not None:
                    if age_seconds <= _COURTINFO_CACHE_FRESH_SECONDS:
                        return cached_rows
                    if age_seconds <= _COURTINFO_CACHE_HARD_SECONDS:
                        _schedule_background_refresh(
                            _refresh_courtinfo_list_cache(
                                app=request.app,
                                cache_key=cache_key,
                                courtids=courtids,
                                limit=limit,
                                compact=compact,
                            )
                        )
                        return cached_rows

        fresh_rows = await _load_courtinfo_rows(courtids=courtids, limit=limit, compact=compact)
        if redis is not None:
            await redis.set(cache_key, _pack_cached_payload(fresh_rows), ex=_COURTINFO_CACHE_HARD_SECONDS)
        return fresh_rows
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/by-courtid/{courtid}", response_model=CourtInfo)
async def get_court_by_courtid(courtid: int):
    try:
        data = rest_select(
            "courtinfo",
            "courtinfoid,courtid,name,address,latitude,longitude,venue,images,availability,accuracy_type,auto_approve",
            filters={"courtid": courtid},
            single=True,
        )
        if not data:
            raise HTTPException(status_code=404, detail="Court not found")
        if isinstance(data.get("images"), list):
            data["images"] = apply_cloudinary_transform_list(data.get("images"), width=_COURTINFO_DETAIL_IMAGE_WIDTH)
        rows = _attach_min_full_prices([data])
        return rows[0] if rows else data
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.patch("/by-courtid/{courtid}", response_model=CourtInfo)
async def patch_courtinfo_by_courtid(request: Request, courtid: int, body: dict, current_user: str = Depends(get_current_user)):
    """Update courtinfo row by courtid.

    Security:
    - Requires Bearer token
    - If the token subject is numeric, enforce ownerid == subject
    """
    _enforce_owner_by_courtid(courtid=courtid, current_user=current_user)

    existing = rest_select(
        "courtinfo",
        "courtinfoid,courtid,name,address,latitude,longitude,venue,images,availability,accuracy_type,auto_approve",
        filters={"courtid": courtid},
        single=True,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Court not found")

    patch: dict[str, Any] = {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")

    if "name" in body:
        v = body.get("name")
        patch["name"] = (v or "").strip() if isinstance(v, str) else v
    if "address" in body:
        v = body.get("address")
        patch["address"] = (v or "").strip() if isinstance(v, str) else v
    if "latitude" in body:
        v = body.get("latitude")
        patch["latitude"] = float(v) if v is not None else None
    if "longitude" in body:
        v = body.get("longitude")
        patch["longitude"] = float(v) if v is not None else None
    if "availability" in body:
        v = body.get("availability")
        patch["availability"] = (v or "").strip() if isinstance(v, str) else v
    if "accuracy_type" in body:
        v = body.get("accuracy_type")
        patch["accuracy_type"] = (v or "").strip() if isinstance(v, str) else v
    if "images" in body:
        patch["images"] = _normalize_images(body.get("images"))
    if "venue" in body:
        venue_norm = _normalize_venue(body.get("venue"))
        if venue_norm is None:
            raise HTTPException(status_code=400, detail="Invalid venue")
        patch["venue"] = venue_norm
    if "auto_approve" in body:
        v = body.get("auto_approve")
        patch["auto_approve"] = bool(v) if v is not None else False

    patch = {k: v for k, v in patch.items() if v is not None}
    if not patch:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    try:
        updated = rest_update("courtinfo", {"courtid": courtid}, patch)
        row = updated[0] if isinstance(updated, list) and updated else updated
        await invalidate_namespace("courtinfo")
        redis = getattr(request.app.state, "redis", None)
        if redis is not None:
            async for key in redis.scan_iter(match="sportsconnect:courtinfo:list:*", count=100):
                await redis.delete(key)
        if isinstance(row.get("images"), list):
            row["images"] = apply_cloudinary_transform_list(row.get("images"), width=_COURTINFO_DETAIL_IMAGE_WIDTH)
        rows = _attach_min_full_prices([row])
        return rows[0] if rows else row
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{courtinfoid}", response_model=CourtInfo)
async def get_court(courtinfoid: int):
    try:
        data = rest_select(
            "courtinfo",
            "courtinfoid,courtid,name,address,latitude,longitude,venue,images,availability,accuracy_type,auto_approve",
            filters={"courtinfoid": courtinfoid},
            single=True,
        )
        if not data:
            raise HTTPException(status_code=404, detail="Court not found")
        if isinstance(data.get("images"), list):
            data["images"] = apply_cloudinary_transform_list(data.get("images"), width=_COURTINFO_DETAIL_IMAGE_WIDTH)
        rows = _attach_min_full_prices([data])
        return rows[0] if rows else data
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

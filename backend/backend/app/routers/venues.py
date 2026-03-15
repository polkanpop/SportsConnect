"""
GET /api/venues/{courtid}/booking-data

Returns courtinfo + all playing courts + their images + court availability
in one round-trip, using asyncio.gather for parallel supabase fetches.
This eliminates the N+1 problem on the booking screen.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from datetime import datetime
import json
import logging
import os
import time
from typing import Any
import uuid

from fastapi import APIRouter, HTTPException, Request
import orjson

from ..db import fetch_venue_booking_bundle_pg, has_pg_pool, rest_select, probe_pg_connection

router = APIRouter(prefix="/venues", tags=["venues"])
logger = logging.getLogger("uvicorn.error")

_pool = ThreadPoolExecutor(max_workers=10)
_first_request_profiled = False
_startup_warmed = False
_startup_warmup_ms: float | None = None

_CACHE_FRESH_SECONDS = int(os.getenv("VENUES_CACHE_FRESH_SECONDS", "120"))
_CACHE_STALE_SECONDS = int(os.getenv("VENUES_CACHE_STALE_SECONDS", "300"))
_CACHE_HARD_SECONDS = _CACHE_FRESH_SECONDS + _CACHE_STALE_SECONDS
_SWR_REFRESH_LOCK_SECONDS = int(os.getenv("VENUES_SWR_REFRESH_LOCK_SECONDS", "45"))
_PREWARM_TOP_VENUES = int(os.getenv("VENUES_PREWARM_TOP_VENUES", "10"))
_PREWARM_CHUNK_SIZE = int(os.getenv("VENUES_PREWARM_CHUNK_SIZE", "10"))
_PREWARM_SEMAPHORE_LIMIT = int(os.getenv("VENUES_PREWARM_SEMAPHORE", "3"))


def mark_venues_startup_warmup(warmup_ms: float) -> None:
    global _startup_warmed, _startup_warmup_ms
    _startup_warmed = True
    _startup_warmup_ms = warmup_ms


def warmup_venues_cold_path() -> None:
    """Warm thread pool + DB path used by /venues/{courtid}/booking-data."""
    if has_pg_pool():
        return
    t0 = time.perf_counter()
    fut = _pool.submit(_probe_db_connection)
    fut.result(timeout=20)
    mark_venues_startup_warmup((time.perf_counter() - t0) * 1000.0)


def _fetch_courtinfo(courtid: int) -> dict | None:
    return rest_select(
        "courtinfo",
        "courtinfoid,courtid,name,address,latitude,longitude,venue,images,availability,accuracy_type,auto_approve",
        filters={"courtid": courtid},
        single=True,
    )


def _fetch_playing_courts(courtid: int) -> list[dict]:
    rows = rest_select(
        "playingcourt",
        "playingcourtid,courtid,part,name,base_name,price,allow_half_booking,surface",
        filters={"courtid": courtid},
        order={"column": "playingcourtid"},
    )
    return rows if isinstance(rows, list) else []


def _fetch_playing_court_images(pc_ids: list[int]) -> list[dict]:
    if not pc_ids:
        return []
    rows = rest_select("playingcourtinfo", "playingcourtid,images", filters={"playingcourtid": pc_ids})
    return rows if isinstance(rows, list) else []


def _jsonb_date_literal(value: date) -> str:
    return json.dumps(value.isoformat())


def _fetch_availability(courtid: int) -> list[dict]:
    """Fetch availability for a court within the next 14 days using DB-side JSONB filtering."""
    today = date.today()
    two_weeks_out = today + timedelta(days=14)

    # booking_date is JSONB; range filters must compare against JSON string literals.
    rows = rest_select(
        "courtavailability",
        "*",
        filters={
            "courtid": courtid,
            "booking_date__gte": _jsonb_date_literal(today),
            "booking_date__lte": _jsonb_date_literal(two_weeks_out),
        },
        order={"column": "availabilityid"},
    )
    return rows if isinstance(rows, list) else []


def _fetch_services(courtid: int) -> list[dict]:
    rows = rest_select(
        "services",
        "*",
        filters={"courtid": courtid},
        order={"column": "serviceid"},
    )
    return rows if isinstance(rows, list) else []


def _probe_db_connection() -> None:
    # Tiny query to surface connection acquisition cost separately.
    _ = rest_select("courtinfo", "courtid", single=True)


def _venue_cache_key(courtid: int) -> str:
    return f"sportsconnect:venues:booking-data:{courtid}"


def _venue_refresh_lock_key(courtid: int) -> str:
    return f"sportsconnect:venues:booking-data:{courtid}:refresh-lock"


def _pack_cached_payload(payload: dict[str, Any]) -> bytes:
    return orjson.dumps({"cached_at": time.time(), "data": payload})


def _unpack_cached_payload(raw: bytes | str) -> tuple[dict[str, Any] | None, float | None]:
    parsed = orjson.loads(raw)
    if not isinstance(parsed, dict):
        return None, None
    data = parsed.get("data")
    cached_at = parsed.get("cached_at")
    if not isinstance(data, dict):
        return None, None
    try:
        age_seconds = max(0.0, time.time() - float(cached_at))
    except Exception:
        age_seconds = None
    return data, age_seconds


def _fetch_top_popular_courts(limit: int) -> list[int]:
    """Best-effort popularity ranking using favouritecourts, with safe fallback."""
    counts: dict[int, int] = {}
    try:
        favourites = rest_select("favouritecourts", "courtid")
    except Exception:
        favourites = []

    if isinstance(favourites, list):
        for row in favourites:
            try:
                courtid = int((row or {}).get("courtid"))
            except Exception:
                continue
            counts[courtid] = counts.get(courtid, 0) + 1

    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ranked_ids = [cid for cid, _ in ranked][:limit]
    if ranked_ids:
        return ranked_ids

    try:
        fallback_rows = rest_select("courts", "courtid", order={"column": "courtid"})
    except Exception:
        fallback_rows = []

    fallback_ids: list[int] = []
    if isinstance(fallback_rows, list):
        for row in fallback_rows:
            try:
                fallback_ids.append(int((row or {}).get("courtid")))
            except Exception:
                continue

    return fallback_ids[:limit]


async def prewarm_top_venues_cache(app: Any) -> None:
    """Warm Redis with top-N venue booking bundles on startup."""
    redis = getattr(app.state, "redis", None)
    if redis is None:
        logger.info("venues_prewarm skipped: redis unavailable")
        return

    loop = asyncio.get_running_loop()
    court_ids: list[int] = await loop.run_in_executor(_pool, _fetch_top_popular_courts, _PREWARM_TOP_VENUES)
    if not court_ids:
        logger.info("venues_prewarm skipped: no candidate venues")
        return

    semaphore = asyncio.Semaphore(_PREWARM_SEMAPHORE_LIMIT)
    warmed = 0

    async def _warm_one(courtid: int) -> None:
        nonlocal warmed
        async with semaphore:
            try:
                payload = await _load_venue_booking_data(courtid, profile_cold=False)
                await redis.set(_venue_cache_key(courtid), _pack_cached_payload(payload), ex=_CACHE_HARD_SECONDS)
                warmed += 1
            except Exception as exc:
                logger.warning("venues_prewarm failed courtid=%s err=%s", courtid, exc)

    for i in range(0, len(court_ids), max(1, _PREWARM_CHUNK_SIZE)):
        chunk = court_ids[i : i + max(1, _PREWARM_CHUNK_SIZE)]
        await asyncio.gather(*(_warm_one(courtid) for courtid in chunk))

    logger.info("venues_prewarm completed warmed=%s requested=%s", warmed, len(court_ids))


async def prewarm_venues_cache_for_courts(app: Any, court_ids: list[int]) -> None:
    """Warm booking-data cache for an explicit court-id list with bounded concurrency."""
    redis = getattr(app.state, "redis", None)
    if redis is None:
        return
    if not court_ids:
        return

    semaphore = asyncio.Semaphore(_PREWARM_SEMAPHORE_LIMIT)
    warmed = 0

    async def _warm_one(courtid: int) -> None:
        nonlocal warmed
        async with semaphore:
            try:
                payload = await _load_venue_booking_data(courtid, profile_cold=False)
                await redis.set(_venue_cache_key(courtid), _pack_cached_payload(payload), ex=_CACHE_HARD_SECONDS)
                warmed += 1
            except Exception as exc:
                logger.warning("venues_targeted_prewarm failed courtid=%s err=%s", courtid, exc)

    chunk_size = max(1, _PREWARM_CHUNK_SIZE)
    for i in range(0, len(court_ids), chunk_size):
        chunk = court_ids[i : i + chunk_size]
        await asyncio.gather(*(_warm_one(courtid) for courtid in chunk))

    logger.info("venues_targeted_prewarm completed warmed=%s requested=%s", warmed, len(court_ids))


async def _load_venue_booking_data(courtid: int, *, profile_cold: bool) -> dict[str, Any]:
    global _first_request_profiled

    loop = asyncio.get_running_loop()
    cold_profile = profile_cold and (not _first_request_profiled)

    db_connection_acquire_ms = None
    query_execution_ms = None
    json_serialization_ms = None

    if cold_profile:
        if _startup_warmed and _startup_warmup_ms is not None:
            db_connection_acquire_ms = _startup_warmup_ms
        elif has_pg_pool():
            t_conn0 = time.perf_counter()
            await probe_pg_connection()
            db_connection_acquire_ms = (time.perf_counter() - t_conn0) * 1000.0
        else:
            t_conn0 = time.perf_counter()
            await loop.run_in_executor(_pool, _probe_db_connection)
            db_connection_acquire_ms = (time.perf_counter() - t_conn0) * 1000.0

    t_query0 = time.perf_counter()
    if has_pg_pool():
        today = date.today().isoformat()
        two_weeks_out = (date.today() + timedelta(days=14)).isoformat()
        response_payload = await fetch_venue_booking_bundle_pg(courtid, today, two_weeks_out)
    else:
        (
            courtinfo,
            playing_courts,
            availability,
            services,
        ) = await asyncio.gather(
            loop.run_in_executor(_pool, _fetch_courtinfo, courtid),
            loop.run_in_executor(_pool, _fetch_playing_courts, courtid),
            loop.run_in_executor(_pool, _fetch_availability, courtid),
            loop.run_in_executor(_pool, _fetch_services, courtid),
        )

        pc_ids: list[int] = [
            int(r["playingcourtid"])
            for r in playing_courts
            if r.get("playingcourtid") is not None
        ]
        pc_images_rows: list[dict] = await loop.run_in_executor(_pool, _fetch_playing_court_images, pc_ids)

        images_by_pcid: dict[int, list[str]] = {}
        for row in pc_images_rows:
            pcid = row.get("playingcourtid")
            imgs = row.get("images") or []
            if pcid is not None:
                images_by_pcid[int(pcid)] = imgs if isinstance(imgs, list) else []

        for pc in playing_courts:
            pcid = pc.get("playingcourtid")
            pc["images"] = images_by_pcid.get(int(pcid), []) if pcid is not None else []

        response_payload = {
            "courtinfo": courtinfo,
            "playing_courts": playing_courts,
            "availability": availability,
            "services": services,
        }
    query_execution_ms = (time.perf_counter() - t_query0) * 1000.0

    if cold_profile:
        t_json0 = time.perf_counter()
        _ = orjson.dumps(response_payload)
        json_serialization_ms = (time.perf_counter() - t_json0) * 1000.0
        logger.info(
            "venues_booking_data_cold_profile courtid=%s db_connection_acquire_ms=%.2f query_execution_ms=%.2f json_serialization_ms=%.2f",
            courtid,
            db_connection_acquire_ms or 0.0,
            query_execution_ms or 0.0,
            json_serialization_ms or 0.0,
        )
        _first_request_profiled = True

    return response_payload


async def _refresh_venue_booking_cache(app: Any, courtid: int) -> None:
    redis = getattr(app.state, "redis", None)
    if redis is None:
        return

    lock_key = _venue_refresh_lock_key(courtid)
    lock_token = str(uuid.uuid4())
    acquired = False
    try:
        acquired = bool(await redis.set(lock_key, lock_token, ex=_SWR_REFRESH_LOCK_SECONDS, nx=True))
        if not acquired:
            return

        payload = await _load_venue_booking_data(courtid, profile_cold=False)
        await redis.set(_venue_cache_key(courtid), _pack_cached_payload(payload), ex=_CACHE_HARD_SECONDS)
    except Exception as exc:
        logger.warning("venues_swr_refresh_failed courtid=%s err=%s", courtid, exc)
    finally:
        if acquired:
            try:
                current = await redis.get(lock_key)
                if current is not None and current.decode() == lock_token:
                    await redis.delete(lock_key)
            except Exception:
                pass


def _schedule_background_refresh(coro: Any) -> None:
    task = asyncio.create_task(coro)

    def _on_done(done: asyncio.Task) -> None:
        try:
            done.result()
        except Exception as exc:
            logger.warning("venues_background_task_failed err=%s", exc)

    task.add_done_callback(_on_done)


@router.get("/{courtid}/booking-data", response_model=dict)
async def get_venue_booking_data(courtid: int, request: Request):
    """SWR cache: serve fresh or stale-fast and refresh stale entries in background."""
    redis = getattr(request.app.state, "redis", None)
    cache_key = _venue_cache_key(courtid)

    try:
        if redis is not None:
            raw = await redis.get(cache_key)
            if raw is not None:
                try:
                    cached_payload, age_seconds = _unpack_cached_payload(raw)
                except Exception:
                    cached_payload, age_seconds = None, None

                if cached_payload is not None and age_seconds is not None:
                    if age_seconds <= _CACHE_FRESH_SECONDS:
                        return cached_payload
                    if age_seconds <= _CACHE_HARD_SECONDS:
                        _schedule_background_refresh(_refresh_venue_booking_cache(request.app, courtid))
                        return cached_payload

        fresh_payload = await _load_venue_booking_data(courtid, profile_cold=True)
        if redis is not None:
            await redis.set(cache_key, _pack_cached_payload(fresh_payload), ex=_CACHE_HARD_SECONDS)
        return fresh_payload
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

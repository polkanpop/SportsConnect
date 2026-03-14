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
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi_cache.decorator import cache

from ..cache_utils import make_key_builder
from ..db import fetch_venue_booking_bundle_pg, has_pg_pool, rest_select, probe_pg_connection

router = APIRouter(prefix="/venues", tags=["venues"])
logger = logging.getLogger("uvicorn.error")

_pool = ThreadPoolExecutor(max_workers=10)
_first_request_profiled = False
_startup_warmed = False
_startup_warmup_ms: float | None = None


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


@router.get("/{courtid}/booking-data", response_model=dict)
@cache(expire=120, key_builder=make_key_builder("venues"))
async def get_venue_booking_data(courtid: int):
    """
    Single-request booking bundle: fetches courtinfo, playing courts,
    playing court images, availability, and services in parallel.
    """
    try:
        global _first_request_profiled
        loop = asyncio.get_running_loop()
        cold_profile = not _first_request_profiled

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
            # Fire all DB reads in parallel using the thread pool.
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

            # Fetch images for all playing courts (needs pc ids from previous result)
            pc_ids: list[int] = [
                int(r["playingcourtid"])
                for r in playing_courts
                if r.get("playingcourtid") is not None
            ]
            pc_images_rows: list[dict] = await loop.run_in_executor(
                _pool, _fetch_playing_court_images, pc_ids
            )

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
            _ = json.dumps(response_payload, ensure_ascii=False, default=str)
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
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

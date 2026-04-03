"""GET /api/me/dashboard — Single bootstrap endpoint.

Returns everything the Activity and Home screens need on startup in one
network round-trip. Booking payloads are fetched as user-scoped relational
queries (with nested linked rows) so PostgreSQL/PostgREST performs the joins
and Python does not load full unrelated tables into memory.

Response shape:
    {
        "userinfo": { ...row } | null,
        "favourite_courts": [ ...rows ],
        "court_bookings":    [ ...rows ],
        "event_bookings":    [ ...rows ],
        "training_bookings": [ ...rows ],
        "events_combined": [ ...rows ],
        "training_sessions_combined": [ ...rows ]
    }
"""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import logging
import os
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi_cache.decorator import cache
import orjson

from ..auth import get_current_user
from ..cache_utils import make_key_builder
from ..db import rest_select

router = APIRouter(prefix="/me", tags=["me"])
logger = logging.getLogger("me")

_DASHBOARD_CACHE_FRESH_SECONDS = int(os.getenv("ME_DASHBOARD_CACHE_FRESH_SECONDS", "120"))
_DASHBOARD_CACHE_STALE_SECONDS = int(os.getenv("ME_DASHBOARD_CACHE_STALE_SECONDS", "300"))
_DASHBOARD_CACHE_HARD_SECONDS = _DASHBOARD_CACHE_FRESH_SECONDS + _DASHBOARD_CACHE_STALE_SECONDS
_DASHBOARD_REFRESH_LOCK_SECONDS = int(os.getenv("ME_DASHBOARD_REFRESH_LOCK_SECONDS", "45"))

# Shared thread pool; 10 workers is enough for concurrent REST fetches without
# flooding the Supabase connection pool.
_pool = ThreadPoolExecutor(max_workers=10)


def _fetch(table: str, filters: Optional[Dict[str, Any]] = None) -> List[Any]:
    """Synchronous REST fetch — runs inside the thread pool."""
    try:
        rows = rest_select(table, "*", filters)
        return rows if isinstance(rows, list) else []
    except Exception:
        return []


def _fetch_court_bookings_relational(userid: int) -> List[Dict[str, Any]]:
    """Fetch only the user's court bookings with nested availability/courtinfo/events/sessions."""
    try:
        rows = rest_select(
            "courtbooking",
            (
                "*,"
                "courtavailability!courtbooking_availabilityid_fkey("
                "availabilityid,courtid,status,start_time,end_time,booking_date,"
                "courts!courtavailability_courtid_fkey("
                "courtid,"
                "courtinfo!courtinfo_courtid_fkey("
                "courtid,name,address,latitude,longitude,venue,images,availability,accuracy_type,auto_approve"
                ")"
                ")"
                "),"
                "events!events_courtbookingid_fkey("
                "eventid,courtbookingid,time,status,organizerid,"
                "eventinfo!eventinfo_eventid_fkey("
                "eventinfoid,title,description,images,numberofpeople,"
                "entry_fee,support_payment_method,participants_cap,join_status)),"
                "trainingsessions!trainingsessions_courtbookingid_fkey("
                "sessionid,courtbookingid,time,status,coachid,"
                "trainingsessioninfo!trainingsessioninfo_sessionid_fkey("
                "sessioninfoid,title,description,images,numberofpeople,"
                "entry_fee,support_payment_method,participants_cap,join_status))"
            ),
            filters={"userid": userid},
            order={"column": "courtbookingid"},
        )
        return rows if isinstance(rows, list) else []
    except Exception:
        return []


def _fetch_event_bookings_relational(userid: int) -> List[Dict[str, Any]]:
    """Fetch only the user's event bookings with nested event + eventinfo + court context."""
    try:
        rows = rest_select(
            "eventbooking",
            (
                "*,"
                "events!eventbooking_eventid_fkey("
                "eventid,time,status,organizerid,courtbookingid,"
                "courtbooking!events_courtbookingid_fkey("
                "courtbookingid,selected_court_name,selected_base_name,availabilityid,"
                "courtavailability!courtbooking_availabilityid_fkey("
                "availabilityid,courtid,"
                "courts!courtavailability_courtid_fkey("
                "courtid,courtinfo,"
                "courtinfo!courtinfo_courtid_fkey(courtid,name,address,venue,images)"
                ")"
                ")"
                "),"
                "eventinfo!eventinfo_eventid_fkey("
                "eventinfoid,eventid,title,description,numberofpeople,entry_fee,"
                "support_payment_method,participants_cap,join_status,auto_approve,images"
                ")"
                ")"
            ),
            filters={"userid": userid},
            order={"column": "eventbookingid"},
        )
        return rows if isinstance(rows, list) else []
    except Exception:
        return []


def _fetch_ts_bookings_relational(userid: int) -> List[Dict[str, Any]]:
    """Fetch only the user's training bookings with nested session + sessioninfo + court context."""
    try:
        rows = rest_select(
            "tsbookings",
            (
                "*,"
                "trainingsessions!tsbookings_sessionid_fkey("
                "sessionid,courtbookingid,time,status,coachid,"
                "courtbooking!trainingsessions_courtbookingid_fkey("
                "courtbookingid,selected_court_name,selected_base_name,availabilityid,"
                "courtavailability!courtbooking_availabilityid_fkey("
                "availabilityid,courtid,"
                "courts!courtavailability_courtid_fkey("
                "courtid,courtinfo,"
                "courtinfo!courtinfo_courtid_fkey(courtid,name,address,venue,images)"
                ")"
                ")"
                "),"
                "trainingsessioninfo!trainingsessioninfo_sessionid_fkey("
                "sessioninfoid,sessionid,title,description,numberofpeople,entry_fee,"
                "support_payment_method,participants_cap,join_status,images"
                ")"
                ")"
            ),
            filters={"userid": userid},
            order={"column": "tsbookingid"},
        )
        return rows if isinstance(rows, list) else []
    except Exception:
        return []


def _to_int(v: Any) -> Optional[int]:
    try:
        n = int(v)
        return n
    except Exception:
        return None


def _attach_linked_details(
    court_bookings: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    if not isinstance(court_bookings, list) or not court_bookings:
        return []

    out: List[Dict[str, Any]] = []
    for row in court_bookings:
        if not isinstance(row, dict):
            continue

        availability = row.get("courtavailability")
        if not isinstance(availability, dict):
            availability = {}
        courtid = _to_int(availability.get("courtid"))

        court_rel = availability.get("courts")
        if isinstance(court_rel, list):
            court_rel = court_rel[0] if court_rel and isinstance(court_rel[0], dict) else {}
        elif not isinstance(court_rel, dict):
            court_rel = {}

        courtinfo_rel = court_rel.get("courtinfo")
        if courtinfo_rel is None:
            courtinfo_rel = availability.get("courtinfo")
        if isinstance(courtinfo_rel, list):
            courtinfo = courtinfo_rel[0] if courtinfo_rel and isinstance(courtinfo_rel[0], dict) else {}
        elif isinstance(courtinfo_rel, dict):
            courtinfo = courtinfo_rel
        else:
            courtinfo = {}

        events_rel = row.get("events") if isinstance(row.get("events"), list) else []
        sessions_rel = row.get("trainingsessions") if isinstance(row.get("trainingsessions"), list) else []
        court_name = courtinfo.get("name") if isinstance(courtinfo.get("name"), str) else None

        base = {
            k: v
            for k, v in row.items()
            if k not in {"courtavailability", "events", "trainingsessions"}
        }

        out.append({
            **base,
            "courtid": courtid,
            "court_name": court_name,
            "linked_events": events_rel,
            "linked_trainingsessions": sessions_rel,
        })
    return out


def _collect_combined(rows: List[Dict[str, Any]], rel_key: str) -> List[Dict[str, Any]]:
    # Meta-info key varies by rel type.
    _META_KEYS = {"events": "eventinfo", "trainingsessions": "trainingsessioninfo"}
    meta_key = _META_KEYS.get(rel_key, "")
    combined: List[Dict[str, Any]] = []
    if not isinstance(rows, list):
        return combined
    for row in rows:
        if not isinstance(row, dict):
            continue
        parent_courtid = row.get("courtid")
        parent_court_name = row.get("court_name")
        parent_start = row.get("start_timestamp")
        parent_end = row.get("end_timestamp")
        rel = row.get(rel_key)
        if isinstance(rel, list):
            for child in rel:
                if not isinstance(child, dict):
                    continue
                # Flatten nested eventinfo / trainingsessioninfo if present.
                meta = child.get(meta_key) if meta_key else None
                if isinstance(meta, list):
                    meta = meta[0] if meta else {}
                if not isinstance(meta, dict):
                    meta = {}
                base_child = {k: v for k, v in child.items() if k != meta_key}
                combined.append(
                    {
                        **base_child,
                        "courtid": child.get("courtid") if child.get("courtid") is not None else parent_courtid,
                        "court_name": child.get("court_name") if child.get("court_name") else parent_court_name,
                        "start_timestamp": child.get("start_timestamp") if child.get("start_timestamp") else parent_start,
                        "end_timestamp": child.get("end_timestamp") if child.get("end_timestamp") else parent_end,
                        "title": meta.get("title"),
                        "description": meta.get("description"),
                        "images": meta.get("images"),
                        "numberofpeople": meta.get("numberofpeople"),
                        "participants_cap": meta.get("participants_cap"),
                        "entry_fee": meta.get("entry_fee"),
                        "support_payment_method": meta.get("support_payment_method"),
                        "join_status": meta.get("join_status"),
                    }
                )
        elif isinstance(rel, dict):
            meta = rel.get(meta_key) if meta_key else None
            if isinstance(meta, list):
                meta = meta[0] if meta else {}
            if not isinstance(meta, dict):
                meta = {}
            base_rel = {k: v for k, v in rel.items() if k != meta_key}
            combined.append(
                {
                    **base_rel,
                    "courtid": rel.get("courtid") if rel.get("courtid") is not None else parent_courtid,
                    "court_name": rel.get("court_name") if rel.get("court_name") else parent_court_name,
                    "start_timestamp": rel.get("start_timestamp") if rel.get("start_timestamp") else parent_start,
                    "end_timestamp": rel.get("end_timestamp") if rel.get("end_timestamp") else parent_end,
                    "title": meta.get("title"),
                    "description": meta.get("description"),
                    "images": meta.get("images"),
                    "numberofpeople": meta.get("numberofpeople"),
                    "participants_cap": meta.get("participants_cap"),
                    "entry_fee": meta.get("entry_fee"),
                    "support_payment_method": meta.get("support_payment_method"),
                    "join_status": meta.get("join_status"),
                }
            )
    return combined


def _dashboard_cache_key(userid: int) -> str:
    return f"sportsconnect:me:dashboard:v2:userid={userid}"


def _dashboard_refresh_lock_key(cache_key: str) -> str:
    return f"{cache_key}:refresh-lock"


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


async def _load_dashboard(userid: int) -> dict[str, Any]:
    loop = asyncio.get_running_loop()

    (
        userinfo_rows,
        favs,
        court_bookings,
        event_bookings,
        ts_bookings,
        notifications,
    ) = await asyncio.gather(
        loop.run_in_executor(_pool, partial(_fetch, "userinfo", {"userid": userid})),
        loop.run_in_executor(_pool, partial(_fetch, "favouritecourts", {"userid": userid})),
        loop.run_in_executor(_pool, partial(_fetch_court_bookings_relational, userid)),
        loop.run_in_executor(_pool, partial(_fetch_event_bookings_relational, userid)),
        loop.run_in_executor(_pool, partial(_fetch_ts_bookings_relational, userid)),
        loop.run_in_executor(_pool, partial(_fetch, "notifications", {"userid": userid})),
    )

    enriched_court_bookings = _attach_linked_details(court_bookings)
    events_combined = _collect_combined(court_bookings, "events")
    training_sessions_combined = _collect_combined(court_bookings, "trainingsessions")

    return {
        "userinfo": userinfo_rows[0] if userinfo_rows else None,
        "favourite_courts": favs,
        "court_bookings": enriched_court_bookings,
        "event_bookings": event_bookings,
        "training_bookings": ts_bookings,
        "notifications": notifications,
        "events_combined": events_combined,
        "training_sessions_combined": training_sessions_combined,
    }


async def _refresh_dashboard_cache(*, app: Any, cache_key: str, userid: int) -> None:
    redis = getattr(app.state, "redis", None)
    if redis is None:
        return

    lock_key = _dashboard_refresh_lock_key(cache_key)
    acquired = False
    try:
        acquired = bool(await redis.set(lock_key, "1", ex=_DASHBOARD_REFRESH_LOCK_SECONDS, nx=True))
        if not acquired:
            return
        fresh_payload = await _load_dashboard(userid)
        await redis.set(cache_key, _pack_cached_payload(fresh_payload), ex=_DASHBOARD_CACHE_HARD_SECONDS)
    except Exception as exc:
        logger.warning("dashboard_swr_refresh_failed userid=%s err=%s", userid, exc)
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
            logger.warning("me_background_task_failed err=%s", exc)

    task.add_done_callback(_on_done)


@router.get("/identity")
@cache(expire=120, key_builder=make_key_builder("me_identity"))
async def get_identity(user_sub: str = Depends(get_current_user)):
    """Return only the authenticated user's profile identity row."""
    try:
        userid = int(user_sub)
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=422,
            detail="Identity endpoint requires a numeric user-id in the JWT subject.",
        )

    row = rest_select(
        "userinfo",
        "infoid,userid,name,email,contactnumber,biography,pfp,emailvisiblestatus,phonevisiblestatus",
        filters={"userid": userid},
        single=True,
    )
    return row


@router.get("/providers")
async def get_my_providers(user_sub: str = Depends(get_current_user)):
    """Return which OAuth providers are linked to the authenticated user."""
    try:
        userid = int(user_sub)
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=422,
            detail="Providers endpoint requires a numeric user-id in the JWT subject.",
        )

    rows = rest_select(
        "user_auth_providers",
        "provider,provider_uid",
        filters={"userid": userid},
    )
    providers = rows if isinstance(rows, list) else []
    return {"providers": providers}


@router.get("/account")
async def get_account(user_sub: str = Depends(get_current_user)):
    """Return login info (username, logintype) + verification status for the authenticated user."""
    try:
        userid = int(user_sub)
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=422,
            detail="Account endpoint requires a numeric user-id in the JWT subject.",
        )

    login_row = rest_select("userlogin", "loginid, username, logintype", {"userid": userid}, single=True)
    unver_rows = rest_select("unverified_users", "email, phone, email_verified, phone_verified", {"userid": userid})

    email_verified = False
    phone_verified = False
    unverified_email = None
    unverified_phone = None
    if isinstance(unver_rows, list):
        for row in unver_rows:
            if row.get("email_verified"):
                email_verified = True
            if row.get("phone_verified"):
                phone_verified = True
            if row.get("email") and not unverified_email:
                unverified_email = row.get("email")
            if row.get("phone") and not unverified_phone:
                unverified_phone = row.get("phone")

    return {
        "username": (login_row or {}).get("username"),
        "logintype": (login_row or {}).get("logintype"),
        "email_verified": email_verified,
        "phone_verified": phone_verified,
        "unverified_email": unverified_email,
        "unverified_phone": unverified_phone,
    }


@router.get("/dashboard")
async def get_dashboard(request: Request, user_sub: str = Depends(get_current_user)):
    """Return all startup data for the authenticated user in a single call.

    The numeric ``userid`` is resolved from the JWT ``sub`` claim.  If the
    backend issues numeric subjects this resolves automatically; otherwise the
    frontend must ensure the JWT subject matches the integer ``userid`` stored
    in the ``userinfo`` / booking tables.
    """
    try:
        userid = int(user_sub)
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=422,
            detail="Dashboard requires a numeric user-id in the JWT subject.",
        )

    cache_key = _dashboard_cache_key(userid)
    redis = getattr(request.app.state, "redis", None)

    if redis is not None:
        raw = await redis.get(cache_key)
        if raw is not None:
            cached_payload, age_seconds = _unpack_cached_payload(raw)
            if cached_payload is not None and age_seconds is not None:
                if age_seconds <= _DASHBOARD_CACHE_FRESH_SECONDS:
                    return cached_payload
                if age_seconds <= _DASHBOARD_CACHE_HARD_SECONDS:
                    _schedule_background_refresh(
                        _refresh_dashboard_cache(app=request.app, cache_key=cache_key, userid=userid)
                    )
                    return cached_payload

    fresh_payload = await _load_dashboard(userid)
    if redis is not None:
        await redis.set(cache_key, _pack_cached_payload(fresh_payload), ex=_DASHBOARD_CACHE_HARD_SECONDS)
    return fresh_payload

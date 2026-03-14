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
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi_cache.decorator import cache

from ..auth import get_current_user
from ..cache_utils import make_key_builder
from ..db import rest_select

router = APIRouter(prefix="/me", tags=["me"])

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
                "events!events_courtbookingid_fkey(eventid,courtbookingid,time,status,organizerid),"
                "trainingsessions!trainingsessions_courtbookingid_fkey(sessionid,courtbookingid,time,status,coachid)"
            ),
            filters={"userid": userid},
            order={"column": "courtbookingid"},
        )
        return rows if isinstance(rows, list) else []
    except Exception:
        return []


def _fetch_event_bookings_relational(userid: int) -> List[Dict[str, Any]]:
    """Fetch only the user's event bookings with nested event + eventinfo."""
    try:
        rows = rest_select(
            "eventbooking",
            (
                "*,"
                "events!eventbooking_eventid_fkey("
                "eventid,time,status,organizerid,courtbookingid,"
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
    """Fetch only the user's training bookings with nested session + sessioninfo."""
    try:
        rows = rest_select(
            "tsbookings",
            (
                "*,"
                "trainingsessions!tsbookings_sessionid_fkey("
                "sessionid,courtbookingid,time,status,coachid,"
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
    combined: List[Dict[str, Any]] = []
    if not isinstance(rows, list):
        return combined
    for row in rows:
        if not isinstance(row, dict):
            continue
        rel = row.get(rel_key)
        if isinstance(rel, list):
            combined.extend([x for x in rel if isinstance(x, dict)])
        elif isinstance(rel, dict):
            combined.append(rel)
    return combined


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
        "infoid,userid,name,email,contactnumber,biography,pfp,contactvisiblestatus",
        filters={"userid": userid},
        single=True,
    )
    return row


@router.get("/dashboard")
@cache(expire=120, key_builder=make_key_builder("dashboard"))
async def get_dashboard(user_sub: str = Depends(get_current_user)):
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

    loop = asyncio.get_running_loop()

    # Fire all reads at the same time.
    (
        userinfo_rows,
        favs,
        court_bookings,
        event_bookings,
        ts_bookings,
        notifications,
    ) = await asyncio.gather(
        loop.run_in_executor(_pool, partial(_fetch, "userinfo",        {"userid": userid})),
        loop.run_in_executor(_pool, partial(_fetch, "favouritecourts", {"userid": userid})),
        loop.run_in_executor(_pool, partial(_fetch_court_bookings_relational, userid)),
        loop.run_in_executor(_pool, partial(_fetch_event_bookings_relational, userid)),
        loop.run_in_executor(_pool, partial(_fetch_ts_bookings_relational, userid)),
        loop.run_in_executor(_pool, partial(_fetch, "notifications",   {"userid": userid})),
    )

    enriched_court_bookings = _attach_linked_details(court_bookings)

    events_combined = _collect_combined(court_bookings, "events")
    training_sessions_combined = _collect_combined(court_bookings, "trainingsessions")

    return {
        "userinfo":          userinfo_rows[0] if userinfo_rows else None,
        "favourite_courts":  favs,
        "court_bookings":    enriched_court_bookings,
        "event_bookings":    event_bookings,
        "training_bookings": ts_bookings,
        "notifications":     notifications,
        "events_combined":   events_combined,
        "training_sessions_combined": training_sessions_combined,
    }

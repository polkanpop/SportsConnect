from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Depends, Request
from fastapi_cache.decorator import cache
from ..db import rest_select, rest_upsert, rest_delete, rest_insert, rest_update
from ..auth import get_current_user
from ..cache_utils import invalidate_namespace, make_key_builder
from ..notifications_service import create_notification
from typing import Any, Dict
import json
import logging

logger = logging.getLogger(__name__)


def _ascii_safe(obj: Any) -> str:
    """Return an ASCII-only string for logging.

    Prevents UnicodeEncodeError on Windows consoles when payloads contain Vietnamese.
    """
    try:
        return json.dumps(obj, ensure_ascii=True, default=str)
    except Exception:
        try:
            return ascii(obj)
        except Exception:
            return "<unprintable>"

router = APIRouter(prefix="/events", tags=["events"])


async def _invalidate_user_dashboard_cache(app: Any, userid: int) -> None:
    """Delete the dashboard SWR cache entry so the next request fetches fresh data."""
    redis = getattr(app.state, "redis", None)
    if redis is None:
        return
    await redis.delete(f"sportsconnect:me:dashboard:v2:userid={userid}")

PRIMARY_KEY = "eventid"


def _normalize_images(v: Any):
    if v is None:
        return None
    if isinstance(v, list):
        out: list[str] = []
        for x in v:
            s = str(x).strip()
            if s:
                out.append(s)
        return out
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return []
        if s.startswith("[") and s.endswith("]"):
            try:
                parsed = json.loads(s)
                if isinstance(parsed, list):
                    return [str(x).strip() for x in parsed if str(x).strip()]
            except Exception:
                pass
        if s.startswith("{") and s.endswith("}"):
            inner = s[1:-1]
            parts = [p.strip().strip('"') for p in inner.split(",")]
            return [p for p in parts if p]
        if "," in s:
            return [p.strip() for p in s.split(",") if p.strip()]
        return [s]
    return []

@router.get("", response_model=list[dict])
@cache(expire=120, key_builder=make_key_builder("events"))
def list_events(organizerid: int | None = Query(None), status: str | None = Query(None), courtbookingid: int | None = Query(None), limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0)):
    try:
        filters: dict[str, int | str] = {}
        if organizerid is not None:
            filters["organizerid"] = organizerid
        if status is not None:
            filters["status"] = status
        if courtbookingid is not None:
            filters["courtbookingid"] = courtbookingid
        data = rest_select("events", "eventid,organizerid,courtbookingid,status,time", filters=filters or None, order={"column": PRIMARY_KEY, "desc": True})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/map-pins", response_model=list[dict])
@cache(expire=60, key_builder=make_key_builder("events_map_pins"))
def events_map_pins(
    minLat: float = Query(...),
    maxLat: float = Query(...),
    minLng: float = Query(...),
    maxLng: float = Query(...),
    limit: int = Query(100, ge=1, le=500),
):
    """Return upcoming events with lat/lng coords for map pin display.

    Join path: courtinfo → courts → playingcourt → courtbooking → events
    """
    try:
        # 1) courtinfo rows within the bounding box
        courtinfo_rows = rest_select(
            "courtinfo",
            "courtinfoid,courtid,name,address,latitude,longitude",
            filters={
                "latitude__gte": minLat,
                "latitude__lte": maxLat,
                "longitude__gte": minLng,
                "longitude__lte": maxLng,
            },
        )
        if not courtinfo_rows:
            return []
        court_ids = list({row["courtid"] for row in courtinfo_rows if row.get("courtid") is not None})
        if not court_ids:
            return []

        # 2) playing courts for those court IDs
        pc_rows = rest_select(
            "playingcourt",
            "playingcourtid,courtid",
            filters={"courtid": court_ids},
        )
        if not pc_rows:
            return []
        pc_ids = [row["playingcourtid"] for row in pc_rows]
        pc_court_map: dict = {row["playingcourtid"]: row["courtid"] for row in pc_rows}

        # 3) courtbookings for those playing courts
        booking_rows = rest_select(
            "courtbooking",
            "courtbookingid,playingcourtid,start_timestamp,end_timestamp",
            filters={"playingcourtid": pc_ids},
        )
        if not booking_rows:
            return []
        booking_by_id: dict = {row["courtbookingid"]: row for row in booking_rows}
        booking_ids = list(booking_by_id.keys())

        # 4) upcoming events for those bookings
        event_rows = rest_select(
            "events",
            "eventid,courtbookingid,status",
            filters={"courtbookingid": booking_ids, "status": "upcoming"},
        )
        if not event_rows:
            return []
        event_rows = event_rows[:limit]
        event_ids = [row["eventid"] for row in event_rows]

        # 5) eventinfo for titles/fees
        eventinfo_rows = rest_select(
            "eventinfo",
            "eventinfoid,eventid,title,entry_fee,participants_cap,images",
            filters={"eventid": event_ids},
        )
        eventinfo_by_eventid: dict = {row["eventid"]: row for row in (eventinfo_rows or [])}
        courtinfo_by_courtid: dict = {row["courtid"]: row for row in courtinfo_rows}

        # 6) count current participants per event (joined bookings)
        eventbooking_rows = rest_select(
            "eventbooking", "eventbookingid,eventid",
            filters={"eventid": event_ids, "status": "joined"},
        )
        participant_count_by_event: dict[int, int] = {}
        for eb in (eventbooking_rows or []):
            eid = eb.get("eventid")
            if eid is not None:
                participant_count_by_event[eid] = participant_count_by_event.get(eid, 0) + 1

        result = []
        for ev in event_rows:
            booking = booking_by_id.get(ev["courtbookingid"])
            if not booking:
                continue
            court_id = pc_court_map.get(booking.get("playingcourtid"))
            ci = courtinfo_by_courtid.get(court_id) if court_id else None
            if not ci or ci.get("latitude") is None or ci.get("longitude") is None:
                continue
            info = eventinfo_by_eventid.get(ev["eventid"], {})
            result.append({
                "eventid": ev["eventid"],
                "title": info.get("title"),
                "entry_fee": info.get("entry_fee"),
                "participants_cap": info.get("participants_cap"),
                "participant_count": participant_count_by_event.get(ev["eventid"], 0),
                "latitude": ci["latitude"],
                "longitude": ci["longitude"],
                "address": ci.get("address"),
                "court_name": ci.get("name"),
                "start_timestamp": booking.get("start_timestamp"),
                "end_timestamp": booking.get("end_timestamp"),
                "cover_image": (info.get("images") or [None])[0],
            })
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{eventid}", response_model=dict)
@cache(expire=120, key_builder=make_key_builder("events"))
def get_event(eventid: int):
    try:
        row = rest_select("events", "*", filters={PRIMARY_KEY: eventid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Event not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_event(body: dict, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
    """Create an event with validation:
    - Inject organizerid from auth
    - Ensure courtbooking exists and belongs to organizer
    - Ensure time (if supplied) falls within booking window
    - Prevent duplicate event on same courtbookingid
    """
    try:
        organizer_raw = body.get("organizerid") or current_user
        try:
            organizerid = int(organizer_raw)
        except Exception:
            raise HTTPException(status_code=400, detail="Organizer id must be numeric; include organizerid in body")
        courtbookingid = body.get("courtbookingid")
        if not courtbookingid:
            raise HTTPException(status_code=422, detail="courtbookingid required")
        # Verify booking belongs to user
        booking = rest_select("courtbooking", "courtbookingid, userid, start_timestamp, end_timestamp", filters={"courtbookingid": courtbookingid}, single=True)
        if not booking:
            raise HTTPException(status_code=404, detail="Court booking not found")
        if int(booking.get("userid")) != organizerid:
            raise HTTPException(status_code=403, detail="User does not own this court booking")
        # Check existing event for this booking
        existing_event = rest_select("events", "eventid", filters={"courtbookingid": courtbookingid})
        if isinstance(existing_event, list) and existing_event:
            raise HTTPException(status_code=409, detail="Event already exists for this court booking")
        # If time provided, validate within window
        event_time = body.get("time")
        if event_time:
            try:
                # Simple string comparison acceptable if ISO format; deeper validation omitted
                start_ts = booking.get("start_timestamp")
                end_ts = booking.get("end_timestamp")
                if start_ts and end_ts and not (start_ts <= event_time <= end_ts):
                    raise HTTPException(status_code=422, detail="Event time must be within booked time window")
            except HTTPException:
                raise
            except Exception:
                raise HTTPException(status_code=422, detail="Invalid time format")
        payload = {**body, "organizerid": organizerid}
        # Default status if not provided
        if "status" not in payload:
            payload["status"] = "upcoming"
        # Debug logging (ASCII-safe; avoid crashing on non-ASCII input)
        logger.info("[create_event] payload=%s", _ascii_safe(payload))
        try:
            resp = rest_insert("events", payload)
        except RuntimeError as e:
            logger.warning("[create_event] insert error: %s", str(e))
            raise
        background_tasks.add_task(invalidate_namespace, "events")
        return resp[0] if isinstance(resp, list) and resp else payload
    except HTTPException:
        raise
    except RuntimeError as e:
        if "409" in str(e):
            # Unique violation surfaces as 409
            raise HTTPException(status_code=409, detail="Duplicate event or sequence conflict")
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/create_with_info", response_model=dict)
async def create_event_with_info(body: dict, request: Request, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
    """Create an event plus its eventinfo metadata atomically (best-effort rollback).

    Expected body keys:
      courtbookingid (int) REQUIRED
      time (ISO timestamp) OPTIONAL (validated against booking window if present)
      title (str) REQUIRED
      description (str) OPTIONAL
      participants_cap (int) REQUIRED
      monetize (bool) REQUIRED
      entry_fee (numeric) OPTIONAL (required if monetize)
      payment_methods (array[str]) OPTIONAL (required if monetize) values: cash | vnpay | both

    Derived mapping:
      event.status defaults to 'upcoming'
      eventinfo.numberofpeople starts at 0
      eventinfo.support_payment_method: null when monetize false; 'cash'/'vnpay'/'both' when true
    Rollback: if eventinfo insert fails, delete created event.
    """
    organizer_raw = body.get("organizerid") or current_user
    try:
        organizerid = int(organizer_raw)
    except Exception:
        raise HTTPException(status_code=400, detail="Organizer id must be numeric; include organizerid in body")

    # Prevent spoofing organizerid via body.
    try:
        token_userid = int(current_user)
        if organizerid != token_userid:
            raise HTTPException(status_code=403, detail="Organizer id must match the authenticated user")
    except ValueError:
        pass
    courtbookingid = body.get("courtbookingid")
    title = body.get("title")
    participants_cap = body.get("participants_cap")
    monetize = body.get("monetize")
    if courtbookingid is None or title is None or participants_cap is None or monetize is None:
        raise HTTPException(status_code=422, detail="Missing required fields: courtbookingid, title, participants_cap, monetize")
    # Validate booking ownership
    booking = rest_select("courtbooking", "courtbookingid, userid, start_timestamp, end_timestamp", filters={"courtbookingid": courtbookingid}, single=True)
    if not booking:
        raise HTTPException(status_code=404, detail="Court booking not found")
    if int(booking.get("userid")) != organizerid:
        raise HTTPException(status_code=403, detail="User does not own this court booking")
    # Prevent duplicate event
    existing_event = rest_select("events", "eventid", filters={"courtbookingid": courtbookingid})
    if isinstance(existing_event, list) and existing_event:
        raise HTTPException(status_code=409, detail="Event already exists for this court booking")
    # Validate time
    event_time = body.get("time")
    if event_time:
        start_ts = booking.get("start_timestamp")
        end_ts = booking.get("end_timestamp")
        if start_ts and end_ts and not (start_ts <= event_time <= end_ts):
            raise HTTPException(status_code=422, detail="Event time must be within booked window")
    # Monetization logic
    support_payment_method: Any = None
    entry_fee = body.get("entry_fee")
    payment_methods = body.get("payment_methods")
    if monetize:
        if entry_fee is None or payment_methods is None:
            raise HTTPException(status_code=422, detail="entry_fee and payment_methods required when monetize is true")
        # Normalize payment_methods to enum value
        if isinstance(payment_methods, list):
            normalized = sorted(set(str(m).lower() for m in payment_methods))
            if "cash" in normalized and "vnpay" in normalized:
                support_payment_method = "both"
            elif "cash" in normalized:
                support_payment_method = "cash"
            elif "vnpay" in normalized:
                support_payment_method = "vnpay"
            else:
                raise HTTPException(status_code=422, detail="payment_methods must include cash and/or vnpay")
        elif isinstance(payment_methods, str):
            pm = payment_methods.lower()
            if pm not in {"cash", "vnpay", "both"}:
                raise HTTPException(status_code=422, detail="payment_methods string must be cash|vnpay|both")
            support_payment_method = pm
        else:
            raise HTTPException(status_code=422, detail="payment_methods must be array or string")
    # Build event payload
    event_payload: Dict[str, Any] = {
        "courtbookingid": courtbookingid,
        "organizerid": organizerid,
        "status": body.get("status") or "upcoming",
    }
    if event_time:
        event_payload["time"] = event_time
    else:
        # fallback: use booking start_timestamp
        start_ts = booking.get("start_timestamp")
        if not start_ts:
            raise HTTPException(status_code=422, detail="Cannot infer event time; supply time explicitly")
        event_payload["time"] = start_ts
    # Insert event first
    try:
        logger.info("[create_event_with_info] event_payload=%s", _ascii_safe(event_payload))
        event_resp = rest_insert("events", event_payload)
    except RuntimeError as e:
        logger.warning("[create_event_with_info] events insert error: %s", str(e))
        if "409" in str(e):
            raise HTTPException(status_code=409, detail="Duplicate event or sequence conflict")
        # Pass through 403/permission context
        if "403" in str(e):
            raise HTTPException(status_code=403, detail=str(e))
        raise HTTPException(status_code=400, detail=str(e))
    if not isinstance(event_resp, list) or not event_resp:
        raise HTTPException(status_code=500, detail="Event insert did not return representation")
    event_row = event_resp[0]
    eventid = event_row.get("eventid")
    if not eventid:
        raise HTTPException(status_code=500, detail="Missing eventid after insert")
    # Build eventinfo payload
    auto_approve_raw = body.get("auto_approve")
    auto_approve = bool(auto_approve_raw) if isinstance(auto_approve_raw, bool) else str(auto_approve_raw).lower() in {"1", "true", "yes", "y", "on"}
    eventinfo_payload: Dict[str, Any] = {
        "eventid": eventid,
        "title": title,
        "description": body.get("description"),
        "participants_cap": participants_cap,
        "numberofpeople": 0,
        "join_status": True,
        "auto_approve": auto_approve,
    }
    images = _normalize_images(body.get("images"))
    if images is not None:
        eventinfo_payload["images"] = images
    if monetize:
        eventinfo_payload["entry_fee"] = entry_fee
        eventinfo_payload["support_payment_method"] = support_payment_method
    # Insert eventinfo; rollback if fails
    try:
        logger.info("[create_event_with_info] eventinfo_payload=%s", _ascii_safe(eventinfo_payload))
        info_resp = rest_insert("eventinfo", eventinfo_payload)
    except RuntimeError as e:
        logger.warning("[create_event_with_info] eventinfo insert error: %s", str(e))
        # Rollback event
        try:
            rest_delete("events", {"eventid": eventid})
        except Exception:
            pass
        if "409" in str(e):
            raise HTTPException(status_code=409, detail="Duplicate eventinfo or sequence conflict")
        if "403" in str(e):
            raise HTTPException(status_code=403, detail=str(e))
        raise HTTPException(status_code=400, detail=str(e))
    if not isinstance(info_resp, list) or not info_resp:
        # Rollback
        try:
            rest_delete("events", {"eventid": eventid})
        except Exception:
            pass
        raise HTTPException(status_code=500, detail="Eventinfo insert did not return representation")

    # Best-effort notification: creation success (do not block core workflow).
    try:
        create_notification(
            userid=organizerid,
            notificationtype="event",
            notificationtypeid=int(eventid),
            category="event",
            kind="created",
            title="Event created",
            message=f"Your event '{title}' was created successfully.",
            data={"eventid": int(eventid), "courtbookingid": int(courtbookingid)},
            message_key="event_created",
            message_params={"title": title},
        )
    except Exception:
        pass
    # Invalidate server-side Redis list cache BEFORE returning the response so
    # any client pull-to-refresh that follows immediately gets a cache miss and
    # fetches fresh DB data (includes the new event).  This avoids the race where
    # a background-task-based invalidation on Upstash Redis (SCAN + N deletes at
    # ~100ms/round-trip) finishes AFTER the client already pulled fresh data.
    await invalidate_namespace("events", "eventinfo")
    await _invalidate_user_dashboard_cache(request.app, organizerid)
    return {"event": event_row, "eventinfo": info_resp[0]}


@router.patch("/{eventid}", response_model=dict)
def update_event(eventid: int, body: dict, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
    """Patch fields on an event (creator/organizer).

    Used by the mobile app to cancel a created upcoming event by setting status.
    """
    try:
        existing = rest_select("events", "eventid, organizerid", filters={PRIMARY_KEY: eventid}, single=True)
        if not existing:
            raise HTTPException(status_code=404, detail="Event not found")

        try:
            auth_userid = int(current_user)
            if int(existing.get("organizerid")) != auth_userid:
                raise HTTPException(status_code=403, detail="User does not own this event")
        except ValueError:
            pass

        payload = dict(body or {})
        payload.pop(PRIMARY_KEY, None)
        if not payload:
            raise HTTPException(status_code=422, detail="No fields to update")

        # Update event first
        resp = rest_update("events", {PRIMARY_KEY: eventid}, payload)
        out = resp[0] if isinstance(resp, list) and resp else payload

        # Cascade cancellation: if the organizer cancels the event, cancel all bookings and reset count.
        new_status = payload.get("status")
        if isinstance(new_status, str) and "cancel" in new_status.lower():
            try:
                rest_update("eventbooking", {"eventid": eventid}, {"bookingstatus": "cancelled", "status": "cancelled"})
            except Exception:
                # Best effort; don't fail the whole cancel if some booking updates fail
                pass
            try:
                rest_update("eventinfo", {"eventid": eventid}, {"numberofpeople": 0})
            except Exception:
                pass

        background_tasks.add_task(invalidate_namespace, "events")
        if isinstance(new_status, str) and "cancel" in new_status.lower():
            # cancel also zeroes eventinfo.numberofpeople — bust that cache too
            background_tasks.add_task(invalidate_namespace, "eventinfo")
        return out
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Depends, Request
from fastapi_cache.decorator import cache
from ..db import rest_select, rest_update, rest_insert, rest_delete
from ..auth import get_current_user
from ..cache_utils import invalidate_namespace, make_key_builder
from ..notifications_service import create_notification

import json
from typing import Any

router = APIRouter(prefix="/trainingsessions", tags=["training"])


async def _invalidate_user_dashboard_cache(app: Any, userid: int) -> None:
    """Delete the dashboard SWR cache entry so the next request fetches fresh data."""
    redis = getattr(app.state, "redis", None)
    if redis is None:
        return
    await redis.delete(f"sportsconnect:me:dashboard:v2:userid={userid}")

PRIMARY_KEY = "sessionid"


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
@cache(expire=120, key_builder=make_key_builder("trainingsessions"))
def list_training_sessions(
    coachid: int | None = Query(None),
    status: str | None = Query(None),
    courtbookingid: int | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    try:
        filters = {}
        if coachid is not None:
            filters["coachid"] = coachid
        if status is not None:
            filters["status"] = status
        if courtbookingid is not None:
            filters["courtbookingid"] = courtbookingid
        data = rest_select("trainingsessions", "*", filters=filters or None, order={"column": PRIMARY_KEY, "desc": True})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/map-pins", response_model=list[dict])
@cache(expire=60, key_builder=make_key_builder("ts_map_pins"))
def training_sessions_map_pins(
    minLat: float = Query(...),
    maxLat: float = Query(...),
    minLng: float = Query(...),
    maxLng: float = Query(...),
    limit: int = Query(100, ge=1, le=500),
):
    """Return upcoming training sessions with lat/lng coords for map pin display.

    Join path: courtinfo → courts → playingcourt → courtbooking → trainingsessions
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

        # 4) upcoming training sessions for those bookings
        session_rows = rest_select(
            "trainingsessions",
            "sessionid,courtbookingid,status",
            filters={"courtbookingid": booking_ids, "status": "upcoming"},
        )
        if not session_rows:
            return []
        session_rows = session_rows[:limit]
        session_ids = [row["sessionid"] for row in session_rows]

        # 5) trainingsessioninfo for titles/fees
        tsinfo_rows = rest_select(
            "trainingsessioninfo",
            "sessionid,title,entry_fee,participants_cap,images",
            filters={"sessionid": session_ids},
        )
        tsinfo_by_sessionid: dict = {row["sessionid"]: row for row in (tsinfo_rows or [])}
        courtinfo_by_courtid: dict = {row["courtid"]: row for row in courtinfo_rows}

        # 6) count current participants per session (joined bookings)
        tsbooking_rows = rest_select(
            "tsbookings", "tsbookingid,sessionid",
            filters={"sessionid": session_ids, "status": "joined"},
        )
        participant_count_by_session: dict[int, int] = {}
        for tb in (tsbooking_rows or []):
            sid = tb.get("sessionid")
            if sid is not None:
                participant_count_by_session[sid] = participant_count_by_session.get(sid, 0) + 1

        result = []
        for s in session_rows:
            booking = booking_by_id.get(s["courtbookingid"])
            if not booking:
                continue
            court_id = pc_court_map.get(booking.get("playingcourtid"))
            ci = courtinfo_by_courtid.get(court_id) if court_id else None
            if not ci or ci.get("latitude") is None or ci.get("longitude") is None:
                continue
            info = tsinfo_by_sessionid.get(s["sessionid"], {})
            result.append({
                "sessionid": s["sessionid"],
                "title": info.get("title"),
                "entry_fee": info.get("entry_fee"),
                "participants_cap": info.get("participants_cap"),
                "participant_count": participant_count_by_session.get(s["sessionid"], 0),
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

@router.get("/{sessionid}", response_model=dict)
@cache(expire=120, key_builder=make_key_builder("trainingsessions"))
def get_training_session(sessionid: int):
    try:
        row = rest_select("trainingsessions", "*", filters={PRIMARY_KEY: sessionid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Training session not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/create_with_info", response_model=dict)
async def create_training_session_with_info(body: dict, request: Request, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
    """Create a training session plus its trainingsessioninfo metadata.

    Body keys expected:
      courtbookingid (int) REQUIRED
      time (ISO timestamp) OPTIONAL
      title (str) REQUIRED
      description (str) OPTIONAL
      participants_cap (int) REQUIRED
      monetize (bool) REQUIRED
      entry_fee (numeric) OPTIONAL when monetize true
      payment_methods (array[str] or str) OPTIONAL when monetize true

    Behavior mirrors events.create_with_info but inserts into trainingsessions and trainingsessioninfo.
    """
    try:
        courtbookingid = body.get("courtbookingid")
        title = body.get("title")
        participants_cap = body.get("participants_cap")
        monetize = body.get("monetize")
        if courtbookingid is None or title is None or participants_cap is None or monetize is None:
            raise HTTPException(status_code=422, detail="Missing required fields: courtbookingid, title, participants_cap, monetize")
        coach_raw = body.get("coachid") or current_user
        try:
            coachid = int(coach_raw)
        except Exception:
            raise HTTPException(status_code=400, detail="Coach id must be numeric; include coachid in body")

        # Prevent spoofing coachid via body.
        try:
            token_userid = int(current_user)
            if coachid != token_userid:
                raise HTTPException(status_code=403, detail="Coach id must match the authenticated user")
        except ValueError:
            pass

        # Validate booking exists
        booking = rest_select("courtbooking", "courtbookingid, userid, start_timestamp, end_timestamp", filters={"courtbookingid": courtbookingid}, single=True)
        if not booking:
            raise HTTPException(status_code=404, detail="Court booking not found")

        # Enforce booking ownership (mirrors events.create_with_info)
        if int(booking.get("userid")) != coachid:
            raise HTTPException(status_code=403, detail="User does not own this court booking")
        # Prevent duplicate session for booking
        existing = rest_select("trainingsessions", "sessionid", filters={"courtbookingid": courtbookingid})
        if isinstance(existing, list) and existing:
            raise HTTPException(status_code=409, detail="Training session already exists for this court booking")
        # Validate time if provided
        ts_time = body.get("time")
        if ts_time:
            start_ts = booking.get("start_timestamp")
            end_ts = booking.get("end_timestamp")
            if start_ts and end_ts and not (start_ts <= ts_time <= end_ts):
                raise HTTPException(status_code=422, detail="Session time must be within booked window")
        # Monetization normalization
        support_payment_method = None
        entry_fee = body.get("entry_fee")
        payment_methods = body.get("payment_methods")
        if monetize:
            if entry_fee is None or payment_methods is None:
                raise HTTPException(status_code=422, detail="entry_fee and payment_methods required when monetize is true")
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
                if pm not in {"cash","vnpay","both"}:
                    raise HTTPException(status_code=422, detail="payment_methods string must be cash|vnpay|both")
                support_payment_method = pm
            else:
                raise HTTPException(status_code=422, detail="payment_methods must be array or string")
        # Build trainingsessions payload
        session_payload = {
            "courtbookingid": courtbookingid,
            "status": body.get("status") or "upcoming",
            "coachid": coachid,
        }
        if ts_time:
            session_payload["time"] = ts_time
        else:
            start_ts = booking.get("start_timestamp")
            if not start_ts:
                raise HTTPException(status_code=422, detail="Cannot infer session time; supply time explicitly")
            session_payload["time"] = start_ts
        try:
            session_insert = rest_insert("trainingsessions", session_payload)
        except RuntimeError as e:
            if "409" in str(e):
                raise HTTPException(status_code=409, detail="Duplicate session or sequence conflict")
            raise HTTPException(status_code=400, detail=str(e))
        if not isinstance(session_insert, list) or not session_insert:
            raise HTTPException(status_code=500, detail="Session insert did not return representation")
        session_row = session_insert[0]
        sessionid = session_row.get("sessionid")
        if not sessionid:
            raise HTTPException(status_code=500, detail="Missing sessionid after insert")
        # Build trainingsessioninfo payload and insert
        auto_approve_raw = body.get("auto_approve")
        auto_approve = bool(auto_approve_raw) if isinstance(auto_approve_raw, bool) else str(auto_approve_raw).lower() in {"1", "true", "yes", "y", "on"}
        info_payload = {
            "sessionid": sessionid,
            "title": title,
            "description": body.get("description"),
            "participants_cap": participants_cap,
            "numberofpeople": 0,
            "join_status": True,
        }

        images = _normalize_images(body.get("images"))
        if images is not None:
            info_payload["images"] = images
        # trainingsessioninfo may or may not have auto_approve yet. We'll try and gracefully fallback.
        info_payload_with_auto = {**info_payload, "auto_approve": auto_approve}
        if monetize:
            info_payload["entry_fee"] = entry_fee
            info_payload["support_payment_method"] = support_payment_method
            info_payload_with_auto["entry_fee"] = entry_fee
            info_payload_with_auto["support_payment_method"] = support_payment_method
        try:
            try:
                info_resp = rest_insert("trainingsessioninfo", info_payload_with_auto)
            except RuntimeError as e:
                # If auto_approve column doesn't exist yet, retry without it.
                if "auto_approve" in str(e).lower() and ("column" in str(e).lower() or "unknown" in str(e).lower()):
                    info_resp = rest_insert("trainingsessioninfo", info_payload)
                else:
                    raise
        except RuntimeError as e:
            try:
                rest_delete("trainingsessions", {"sessionid": sessionid})
            except Exception:
                pass
            if "409" in str(e):
                raise HTTPException(status_code=409, detail="Duplicate trainingsessioninfo or sequence conflict")
            raise HTTPException(status_code=400, detail=str(e))
        if not isinstance(info_resp, list) or not info_resp:
            try:
                rest_delete("trainingsessions", {"sessionid": sessionid})
            except Exception:
                pass
            raise HTTPException(status_code=500, detail="Trainingsessioninfo insert did not return representation")

        # Best-effort notification: creation success (do not block core workflow).
        try:
            create_notification(
                userid=coachid,
                notificationtype="trainingsession",
                notificationtypeid=int(sessionid),
                category="training",
                kind="created",
                title="Training session created",
                message=f"Your training session '{title}' was created successfully.",
                data={"sessionid": int(sessionid), "courtbookingid": int(courtbookingid)},
                message_key="ts_created",
                message_params={"title": title},
            )
        except Exception:
            pass
        # Invalidate server-side Redis list cache BEFORE returning the response
        # (same fix as events.create_event_with_info — Upstash latency race).
        await invalidate_namespace("trainingsessions", "trainingsessioninfo")
        await _invalidate_user_dashboard_cache(request.app, coachid)
        return {"session": session_row, "sessioninfo": info_resp[0]}
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/{sessionid}", response_model=dict)
def update_training_session(sessionid: int, body: dict, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
    """Patch fields on a training session (creator/coach).

    Used by the mobile app to cancel a created upcoming session by setting status.
    """
    try:
        existing = rest_select("trainingsessions", "sessionid, coachid", filters={PRIMARY_KEY: sessionid}, single=True)
        if not existing:
            raise HTTPException(status_code=404, detail="Training session not found")

        try:
            auth_userid = int(current_user)
            if int(existing.get("coachid")) != auth_userid:
                raise HTTPException(status_code=403, detail="User does not own this training session")
        except ValueError:
            pass

        payload = dict(body or {})
        payload.pop(PRIMARY_KEY, None)
        if not payload:
            raise HTTPException(status_code=422, detail="No fields to update")

        resp = rest_update("trainingsessions", {PRIMARY_KEY: sessionid}, payload)
        out = resp[0] if isinstance(resp, list) and resp else payload

        new_status = payload.get("status")
        if isinstance(new_status, str) and "cancel" in new_status.lower():
            try:
                rest_update("tsbookings", {"sessionid": sessionid}, {"bookingstatus": "cancelled", "status": "cancelled"})
            except Exception:
                pass
            try:
                rest_update("trainingsessioninfo", {"sessionid": sessionid}, {"numberofpeople": 0})
            except Exception:
                pass

        background_tasks.add_task(invalidate_namespace, "trainingsessions", "trainingsessioninfo")
        return out
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
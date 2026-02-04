from fastapi import APIRouter, HTTPException, Query, Depends
from ..db import rest_select, rest_upsert, rest_update, rest_insert
from ..auth import get_current_user

router = APIRouter(prefix="/eventbookings", tags=["bookings"])  # Keep plural route, underlying table is singular 'eventbooking'

PRIMARY_KEY = "eventbookingid"


def _sync_event_participant_count(eventid: int) -> None:
    """Recompute eventinfo.numberofpeople from joined bookings.

    This avoids counter drift if approvals/rejections/cancellations happen out of order,
    or if eventinfo rows were duplicated.
    """
    joined_rows = rest_select(
        "eventbooking",
        "eventbookingid",
        filters={"eventid": eventid, "status": "joined"},
    )
    joined_count = len(joined_rows) if isinstance(joined_rows, list) else 0
    # Update by eventid (not eventinfoid) to handle potential duplicate eventinfo rows.
    rest_update("eventinfo", {"eventid": eventid}, {"numberofpeople": joined_count})

@router.get("", response_model=list[dict])
def list_event_bookings(
    userid: int | None = Query(None),
    eventid: int | None = Query(None),
    status: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    try:
        filters = {}
        if userid is not None:
            filters["userid"] = userid
        if eventid is not None:
            filters["eventid"] = eventid
        if status is not None:
            filters["status"] = status
        data = rest_select("eventbooking", "*", filters=filters or None, order={"column": PRIMARY_KEY})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{eventbookingid}", response_model=dict)
def get_event_booking(eventbookingid: int):
    try:
        row = rest_select("eventbooking", "*", filters={PRIMARY_KEY: eventbookingid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Event booking not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_event_booking(body: dict, current_user: str = Depends(get_current_user)):
    try:
        userid_raw = body.get("userid") or current_user
        try:
            userid = int(userid_raw)
        except Exception:
            raise HTTPException(status_code=400, detail="userid must be numeric")

        eventid = body.get("eventid")
        if eventid is None:
            raise HTTPException(status_code=422, detail="eventid required")
        try:
            eventid = int(eventid)
        except Exception:
            raise HTTPException(status_code=400, detail="eventid must be numeric")

        ev = rest_select("events", "eventid,status", filters={"eventid": eventid}, single=True)
        if not ev:
            raise HTTPException(status_code=404, detail="Event not found")
        status = str(ev.get("status") or "").lower()
        if "cancel" in status:
            raise HTTPException(status_code=409, detail="Event was cancelled")

        # Join controls live in eventinfo
        info = rest_select("eventinfo", "join_status,auto_approve", filters={"eventid": eventid}, single=True)
        if info:
            if info.get("join_status") is False:
                raise HTTPException(status_code=409, detail="Event is not accepting participants")
            auto_approve_val = info.get("auto_approve")
        else:
            auto_approve_val = False

        should_auto = bool(auto_approve_val) if isinstance(auto_approve_val, bool) else str(auto_approve_val).lower() in {"1", "true", "yes", "y", "on"}
        desired_status = "joined" if should_auto else "pending"

        existing = rest_select("eventbooking", "eventbookingid,bookingstatus,status", filters={"userid": userid, "eventid": eventid})
        if isinstance(existing, list):
            for row in existing:
                s = str(row.get("bookingstatus") or row.get("status") or "").lower()
                if "cancel" not in s:
                    raise HTTPException(status_code=409, detail="Already booked")

        payload = {**body, "userid": userid, "eventid": eventid}
        # Override/ensure status based on auto-approve rule.
        payload["status"] = desired_status
        # Keep bookingstatus as upcoming unless explicitly provided.
        if "bookingstatus" not in payload:
            payload["bookingstatus"] = "upcoming"
        # Prefer insert to avoid unintended upserts; fallback to upsert for legacy behavior.
        try:
            resp = rest_insert("eventbooking", payload)
        except Exception:
            resp = rest_upsert("eventbooking", payload)

        # If auto-approved, keep event participant count consistent.
        if desired_status == "joined":
            try:
                _sync_event_participant_count(eventid)
            except Exception as e:
                print("[eventbookings] failed to sync numberofpeople on create:", str(e))

        return resp[0] if isinstance(resp, list) and resp else payload
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/{eventbookingid}", response_model=dict)
def update_event_booking(eventbookingid: int, body: dict, current_user: str = Depends(get_current_user)):
    """Patch fields on an event booking.

    Used by the mobile app to cancel an upcoming event booking by setting bookingstatus/status.
    """
    try:
        existing = rest_select(
            "eventbooking",
            "eventbookingid, userid, eventid, status",
            filters={PRIMARY_KEY: eventbookingid},
            single=True,
        )
        if not existing:
            raise HTTPException(status_code=404, detail="Event booking not found")

        auth_userid: int | None
        try:
            auth_userid = int(current_user)
        except Exception:
            auth_userid = None

        is_owner = auth_userid is not None and int(existing.get("userid")) == auth_userid
        is_organizer = False
        if not is_owner and auth_userid is not None:
            try:
                ev = rest_select(
                    "events",
                    "eventid, organizerid",
                    filters={"eventid": int(existing.get("eventid"))},
                    single=True,
                )
                if ev and int(ev.get("organizerid")) == auth_userid:
                    is_organizer = True
            except Exception:
                is_organizer = False

        if not (is_owner or is_organizer):
            raise HTTPException(status_code=403, detail="Not allowed to update this event booking")

        payload = dict(body or {})
        payload.pop(PRIMARY_KEY, None)
        if is_organizer and not is_owner:
            # Organizer moderation: limit surface area to approval/reject.
            payload = {k: v for k, v in payload.items() if k in {"status", "bookingstatus"}}
        if not payload:
            raise HTTPException(status_code=422, detail="No fields to update")

        resp = rest_update("eventbooking", {PRIMARY_KEY: eventbookingid}, payload)

        # Keep eventinfo.numberofpeople consistent whenever status changes.
        if "status" in payload:
            try:
                _sync_event_participant_count(int(existing.get("eventid")))
            except Exception as e:
                # Never block booking updates due to counter sync issues.
                print("[eventbookings] failed to sync numberofpeople:", str(e))
        if isinstance(resp, list) and resp:
            return resp[0]
        return payload
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
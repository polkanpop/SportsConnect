from fastapi import APIRouter, HTTPException, Query, Depends
from ..db import rest_select, rest_upsert, rest_update, rest_insert
from ..auth import get_current_user

router = APIRouter(prefix="/eventbookings", tags=["bookings"])  # Keep plural route, underlying table is singular 'eventbooking'

PRIMARY_KEY = "eventbookingid"

@router.get("", response_model=list[dict])
def list_event_bookings(userid: int | None = Query(None), status: str | None = Query(None), limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    try:
        filters = {}
        if userid is not None:
            filters["userid"] = userid
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

        existing = rest_select("eventbooking", "eventbookingid,bookingstatus,status", filters={"userid": userid, "eventid": eventid})
        if isinstance(existing, list):
            for row in existing:
                s = str(row.get("bookingstatus") or row.get("status") or "").lower()
                if "cancel" not in s:
                    raise HTTPException(status_code=409, detail="Already booked")

        payload = {**body, "userid": userid, "eventid": eventid}
        # Prefer insert to avoid unintended upserts; fallback to upsert for legacy behavior.
        try:
            resp = rest_insert("eventbooking", payload)
        except Exception:
            resp = rest_upsert("eventbooking", payload)
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
        existing = rest_select("eventbooking", "eventbookingid, userid", filters={PRIMARY_KEY: eventbookingid}, single=True)
        if not existing:
            raise HTTPException(status_code=404, detail="Event booking not found")

        try:
            auth_userid = int(current_user)
            if int(existing.get("userid")) != auth_userid:
                raise HTTPException(status_code=403, detail="User does not own this event booking")
        except ValueError:
            pass

        payload = dict(body or {})
        payload.pop(PRIMARY_KEY, None)
        if not payload:
            raise HTTPException(status_code=422, detail="No fields to update")

        resp = rest_update("eventbooking", {PRIMARY_KEY: eventbookingid}, payload)
        if isinstance(resp, list) and resp:
            return resp[0]
        return payload
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
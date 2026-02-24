from fastapi import APIRouter, HTTPException, Query, Depends
from ..db import rest_select, rest_insert, rest_update
from ..auth import get_current_user

router = APIRouter(prefix="/courtbookings", tags=["bookings"])  # Route keeps plural for consistency, underlying table is singular

PRIMARY_KEY = "courtbookingid"

@router.get("", response_model=list[dict])
def list_court_bookings(userid: int | None = Query(None), status: str | None = Query(None), limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    try:
        filters = {}
        if userid is not None:
            filters["userid"] = userid
        if status is not None:
            filters["status"] = status
        # Table name in schema is singular 'courtbooking'
        data = rest_select("courtbooking", "*", filters=filters or None, order={"column": PRIMARY_KEY})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{courtbookingid}", response_model=dict)
def get_court_booking(courtbookingid: int):
    try:
        row = rest_select("courtbooking", "*", filters={PRIMARY_KEY: courtbookingid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Court booking not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_court_booking(body: dict, current_user: str = Depends(get_current_user)):
    """Create a court booking.

    Relaxed logic:
      - Multiple bookings per user allowed.
      - Accepts numeric `userid` from body; if missing attempts to coerce auth subject.
      - Does NOT block when token subject differs from provided userid (diagnostic print only).
      - Optional `note` field persisted.
    """
    try:
        auth_sub = current_user
        supplied_userid = body.get("userid")
        final_userid = None
        if supplied_userid is not None:
            # Require numeric
            if not isinstance(supplied_userid, int):
                try:
                    supplied_userid = int(str(supplied_userid))
                except ValueError:
                    raise HTTPException(status_code=400, detail="userid must be numeric")
            final_userid = supplied_userid
        else:
            # Coerce auth subject to int if possible
            try:
                final_userid = int(auth_sub)
            except ValueError:
                raise HTTPException(status_code=400, detail="Provide numeric userid in body; token subject is not numeric")

        payload = { **body, "userid": final_userid }
        if "note" in body:
            payload["note"] = body.get("note")

        print(f"[create_court_booking] auth_sub={auth_sub} supplied_userid={supplied_userid} final_userid={final_userid} availabilityid={payload.get('availabilityid')}")

        resp = rest_insert("courtbooking", payload)
        if not isinstance(resp, list) or not resp:
            raise HTTPException(status_code=500, detail="Insert did not return representation; check Supabase headers/policies")
        row = resp[0]
        if PRIMARY_KEY not in row:
            raise HTTPException(status_code=500, detail="Insert succeeded but missing primary key in response")
        return row
    except HTTPException:
        raise
    except RuntimeError as e:
        if "409" in str(e):
            raise HTTPException(status_code=409, detail="Duplicate primary key on insert; sequence likely misaligned")
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/{courtbookingid}", response_model=dict)
def update_court_booking(courtbookingid: int, body: dict, current_user: str = Depends(get_current_user)):
    """Patch fields on a court booking.

    Used by the mobile app to cancel an upcoming booking by setting bookingstatus/status.
    """
    try:
        existing = rest_select("courtbooking", "courtbookingid, userid", filters={PRIMARY_KEY: courtbookingid}, single=True)
        if not existing:
            raise HTTPException(status_code=404, detail="Court booking not found")

        # Best-effort ownership check when auth subject is numeric.
        try:
            auth_userid = int(current_user)
            if int(existing.get("userid")) != auth_userid:
                raise HTTPException(status_code=403, detail="User does not own this court booking")
        except ValueError:
            pass

        payload = dict(body or {})
        payload.pop(PRIMARY_KEY, None)
        if not payload:
            raise HTTPException(status_code=422, detail="No fields to update")

        # Hard guard: you cannot cancel a court booking while an upcoming event or training session
        # still references this courtbookingid.
        bookingstatus = payload.get("bookingstatus")
        if isinstance(bookingstatus, str) and bookingstatus.strip().lower() == "cancelled":
            def is_blocking_status(s: object) -> bool:
                st = str(s or "").strip().lower()
                if not st:
                    return True
                return ("cancel" not in st) and ("complete" not in st)

            # Check events
            evs = rest_select("events", "eventid,status,time", filters={"courtbookingid": courtbookingid})
            if isinstance(evs, list):
                for ev in evs:
                    if not isinstance(ev, dict):
                        continue
                    if is_blocking_status(ev.get("status")):
                        raise HTTPException(status_code=409, detail="You must cancel the event first.")

            # Check training sessions
            ses = rest_select("trainingsessions", "sessionid,status,time", filters={"courtbookingid": courtbookingid})
            if isinstance(ses, list):
                for s in ses:
                    if not isinstance(s, dict):
                        continue
                    if is_blocking_status(s.get("status")):
                        raise HTTPException(status_code=409, detail="You must cancel the training session first.")

        resp = rest_update("courtbooking", {PRIMARY_KEY: courtbookingid}, payload)
        if isinstance(resp, list) and resp:
            return resp[0]
        return payload
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
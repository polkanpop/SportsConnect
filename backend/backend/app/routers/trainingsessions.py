from fastapi import APIRouter, HTTPException, Query, Depends
from ..db import rest_select, rest_update
from ..auth import get_current_user

router = APIRouter(prefix="/trainingsessions", tags=["training"])

PRIMARY_KEY = "sessionid"

@router.get("", response_model=list[dict])
def list_training_sessions(coachid: int | None = Query(None), status: str | None = Query(None), limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    try:
        filters = {}
        if coachid is not None:
            filters["coachid"] = coachid
        if status is not None:
            filters["status"] = status
        data = rest_select("trainingsessions", "*", filters=filters or None, order={"column": PRIMARY_KEY})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{sessionid}", response_model=dict)
def get_training_session(sessionid: int):
    try:
        row = rest_select("trainingsessions", "*", filters={PRIMARY_KEY: sessionid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Training session not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/create_with_info", response_model=dict)
def create_training_session_with_info(body: dict):
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
        # Validate booking exists
        booking = rest_select("courtbooking", "courtbookingid, userid, start_timestamp, end_timestamp", filters={"courtbookingid": courtbookingid}, single=True)
        if not booking:
            raise HTTPException(status_code=404, detail="Court booking not found")
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
            "coachid": body.get("coachid")
        }
        if ts_time:
            session_payload["time"] = ts_time
        else:
            start_ts = booking.get("start_timestamp")
            if not start_ts:
                raise HTTPException(status_code=422, detail="Cannot infer session time; supply time explicitly")
            session_payload["time"] = start_ts
        try:
            sess_resp = rest_select("trainingsessions", "*", filters=None)
        except Exception:
            sess_resp = None
        try:
            from ..db import rest_insert, rest_delete
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
        info_payload = {
            "sessionid": sessionid,
            "title": title,
            "description": body.get("description"),
            "participants_cap": participants_cap,
            "numberofpeople": 0
        }
        if monetize:
            info_payload["entry_fee"] = entry_fee
            info_payload["support_payment_method"] = support_payment_method
        try:
            from ..db import rest_insert as _rest_insert, rest_delete as _rest_delete
            info_resp = _rest_insert("trainingsessioninfo", info_payload)
        except RuntimeError as e:
            try:
                _rest_delete("trainingsessions", {"sessionid": sessionid})
            except Exception:
                pass
            if "409" in str(e):
                raise HTTPException(status_code=409, detail="Duplicate trainingsessioninfo or sequence conflict")
            raise HTTPException(status_code=400, detail=str(e))
        if not isinstance(info_resp, list) or not info_resp:
            try:
                _rest_delete("trainingsessions", {"sessionid": sessionid})
            except Exception:
                pass
            raise HTTPException(status_code=500, detail="Trainingsessioninfo insert did not return representation")
        return {"session": session_row, "sessioninfo": info_resp[0]}
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/{sessionid}", response_model=dict)
def update_training_session(sessionid: int, body: dict, current_user: str = Depends(get_current_user)):
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
        if isinstance(resp, list) and resp:
            return resp[0]
        return payload
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
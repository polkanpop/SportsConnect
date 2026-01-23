from fastapi import APIRouter, HTTPException, Query, Depends
from ..db import rest_select, rest_upsert, rest_update
from ..auth import get_current_user

router = APIRouter(prefix="/tsbookings", tags=["training"])

PRIMARY_KEY = "tsbookingid"

@router.get("", response_model=list[dict])
def list_ts_bookings(sessionid: int | None = Query(None), userid: int | None = Query(None), status: str | None = Query(None), limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
    try:
        filters: dict[str, int | str] = {}
        if sessionid is not None:
            filters["sessionid"] = sessionid
        if userid is not None:
            filters["userid"] = userid
        if status is not None:
            filters["status"] = status
        data = rest_select("tsbookings", "*", filters=filters or None, order={"column": PRIMARY_KEY})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{tsbookingid}", response_model=dict)
def get_ts_booking(tsbookingid: int):
    try:
        row = rest_select("tsbookings", "*", filters={PRIMARY_KEY: tsbookingid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Training session booking not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_ts_booking(body: dict, current_user: str = Depends(get_current_user)):
    """Create a training session booking. Inject userid from auth if not provided."""
    try:
        payload = {**body, "userid": body.get("userid") or current_user}
        resp = rest_upsert("tsbookings", payload)
        return resp[0] if isinstance(resp, list) and resp else payload
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/{tsbookingid}", response_model=dict)
def update_ts_booking(tsbookingid: int, body: dict, current_user: str = Depends(get_current_user)):
    """Patch fields on a training session booking.

    Used by the mobile app to cancel an upcoming training booking by setting bookingstatus/status.
    """
    try:
        existing = rest_select("tsbookings", "tsbookingid, userid", filters={PRIMARY_KEY: tsbookingid}, single=True)
        if not existing:
            raise HTTPException(status_code=404, detail="Training session booking not found")

        try:
            auth_userid = int(current_user)
            if int(existing.get("userid")) != auth_userid:
                raise HTTPException(status_code=403, detail="User does not own this training booking")
        except ValueError:
            pass

        payload = dict(body or {})
        payload.pop(PRIMARY_KEY, None)
        if not payload:
            raise HTTPException(status_code=422, detail="No fields to update")

        resp = rest_update("tsbookings", {PRIMARY_KEY: tsbookingid}, payload)
        if isinstance(resp, list) and resp:
            return resp[0]
        return payload
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

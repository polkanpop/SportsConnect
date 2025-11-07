from fastapi import APIRouter, HTTPException, Query, Depends
from ..db import rest_select, rest_upsert
from ..auth import get_current_user

router = APIRouter(prefix="/courtbookings", tags=["bookings"])

PRIMARY_KEY = "courtbookingid"

@router.get("", response_model=list[dict])
def list_court_bookings(userid: int | None = Query(None), status: str | None = Query(None), limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    try:
        filters = {}
        if userid is not None:
            filters["userid"] = userid
        if status is not None:
            filters["status"] = status
        data = rest_select("courtbookings", "*", filters=filters or None, order={"column": PRIMARY_KEY})
        # manual slicing for pagination (Supabase REST lacks limit/offset w/out query modification; could add ?limit=?&offset=? if enabled)
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{courtbookingid}", response_model=dict)
def get_court_booking(courtbookingid: int):
    try:
        row = rest_select("courtbookings", "*", filters={PRIMARY_KEY: courtbookingid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Court booking not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_court_booking(body: dict, current_user: str = Depends(get_current_user)):
    """Create a court booking. Expects JSON with at least courtbookingid or necessary scheduling fields.
    Demo-only: trusts body and injects userid from auth subject."""
    try:
        payload = {**body, "userid": body.get("userid") or current_user}
        resp = rest_upsert("courtbookings", payload)
        return resp[0] if isinstance(resp, list) and resp else payload
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
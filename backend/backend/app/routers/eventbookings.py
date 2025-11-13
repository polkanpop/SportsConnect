from fastapi import APIRouter, HTTPException, Query, Depends
from ..db import rest_select, rest_upsert
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
        payload = {**body, "userid": body.get("userid") or current_user}
        resp = rest_upsert("eventbooking", payload)
        return resp[0] if isinstance(resp, list) and resp else payload
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
from fastapi import APIRouter, HTTPException, Query, Depends
from ..db import rest_select, rest_upsert
from ..auth import get_current_user

router = APIRouter(prefix="/courtavailability", tags=["courts"])

PRIMARY_KEY = "availabilityid"

@router.get("", response_model=list[dict])
def list_court_availability(courtid: int | None = Query(None), status: str | None = Query(None), limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
    try:
        filters: dict[str, int | str] = {}
        if courtid is not None:
            filters["courtid"] = courtid
        if status is not None:
            filters["status"] = status
        data = rest_select("courtavailability", "*", filters=filters or None, order={"column": PRIMARY_KEY})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{availabilityid}", response_model=dict)
def get_court_availability(availabilityid: int):
    try:
        row = rest_select("courtavailability", "*", filters={PRIMARY_KEY: availabilityid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Availability slot not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_court_availability(body: dict, current_user: str = Depends(get_current_user)):
    """Create an availability slot. Body must include courtid, start_time, end_time, status, booking_date."""
    try:
        # No user column, just trust body; optionally could audit with current_user.
        resp = rest_upsert("courtavailability", body)
        return resp[0] if isinstance(resp, list) and resp else body
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

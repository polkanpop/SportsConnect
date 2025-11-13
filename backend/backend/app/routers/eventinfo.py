from fastapi import APIRouter, HTTPException, Query, Depends
from ..db import rest_select, rest_upsert
from ..auth import get_current_user

router = APIRouter(prefix="/eventinfo", tags=["events"])

PRIMARY_KEY = "eventinfoid"

@router.get("", response_model=list[dict])
def list_event_info(eventid: int | None = Query(None), limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
    try:
        filters: dict[str, int] = {}
        if eventid is not None:
            filters["eventid"] = eventid
        data = rest_select("eventinfo", "*", filters=filters or None, order={"column": PRIMARY_KEY})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{eventinfoid}", response_model=dict)
def get_event_info(eventinfoid: int):
    try:
        row = rest_select("eventinfo", "*", filters={PRIMARY_KEY: eventinfoid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Event info not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_event_info(body: dict, current_user: str = Depends(get_current_user)):
    """Create event info metadata. Body must include eventid and title."""
    try:
        resp = rest_upsert("eventinfo", body)
        return resp[0] if isinstance(resp, list) and resp else body
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

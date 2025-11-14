from fastapi import APIRouter, HTTPException, Query, Depends
from ..db import rest_select, rest_upsert
from ..auth import get_current_user
from fastapi_cache.decorator import cache

router = APIRouter(prefix="/events", tags=["events"])

PRIMARY_KEY = "eventid"

@router.get("", response_model=list[dict])
@cache(expire=60)
def list_events(organizerid: int | None = Query(None), status: str | None = Query(None), courtbookingid: int | None = Query(None), limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    try:
        filters: dict[str, int | str] = {}
        if organizerid is not None:
            filters["organizerid"] = organizerid
        if status is not None:
            filters["status"] = status
        if courtbookingid is not None:
            filters["courtbookingid"] = courtbookingid
        data = rest_select("events", "*", filters=filters or None, order={"column": PRIMARY_KEY})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{eventid}", response_model=dict)
@cache(expire=120)
def get_event(eventid: int):
    try:
        row = rest_select("events", "*", filters={PRIMARY_KEY: eventid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Event not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_event(body: dict, current_user: str = Depends(get_current_user)):
    """Create an event. Inject organizerid from auth if not provided."""
    try:
        payload = {**body, "organizerid": body.get("organizerid") or current_user}
        resp = rest_upsert("events", payload)
        return resp[0] if isinstance(resp, list) and resp else payload
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

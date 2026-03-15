from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Depends
from fastapi_cache.decorator import cache
from ..db import rest_select, rest_upsert, rest_update
from ..auth import get_current_user
from ..cache_utils import invalidate_namespace, make_key_builder

router = APIRouter(prefix="/eventinfo", tags=["events"])

PRIMARY_KEY = "eventinfoid"

@router.get("", response_model=list[dict])
@cache(expire=120, key_builder=make_key_builder("eventinfo"))
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
@cache(expire=120, key_builder=make_key_builder("eventinfo"))
def get_event_info(eventinfoid: int):
    try:
        row = rest_select("eventinfo", "*", filters={PRIMARY_KEY: eventinfoid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Event info not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_event_info(body: dict, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
    """Create event info metadata. Body must include eventid and title."""
    try:
        resp = rest_upsert("eventinfo", body)
        background_tasks.add_task(invalidate_namespace, "eventinfo", "events")
        return resp[0] if isinstance(resp, list) and resp else body
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/{eventinfoid}", response_model=dict)
def update_event_info(eventinfoid: int, body: dict, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
    """Patch eventinfo fields (used to update numberofpeople)."""
    try:
        payload = dict(body or {})
        payload.pop(PRIMARY_KEY, None)
        if not payload:
            raise HTTPException(status_code=422, detail="No fields to update")

        resp = rest_update("eventinfo", {PRIMARY_KEY: eventinfoid}, payload)
        if isinstance(resp, list) and resp:
            background_tasks.add_task(invalidate_namespace, "eventinfo", "events")
            return resp[0]
        return payload
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/adjust/{eventid}", response_model=dict)
def adjust_event_participants(eventid: int, background_tasks: BackgroundTasks, delta: int = Query(..., ge=-1000, le=1000), current_user: str = Depends(get_current_user)):
    """Adjust eventinfo.numberofpeople by delta (clamped at >= 0)."""
    try:
        row = rest_select("eventinfo", "*", filters={"eventid": eventid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Event info not found")

        current = row.get("numberofpeople")
        try:
            current_n = int(current) if current is not None else 0
        except Exception:
            current_n = 0
        new_n = current_n + int(delta)
        if new_n < 0:
            new_n = 0

        resp = rest_update("eventinfo", {PRIMARY_KEY: row.get(PRIMARY_KEY)}, {"numberofpeople": new_n})
        background_tasks.add_task(invalidate_namespace, "eventinfo")
        if isinstance(resp, list) and resp:
            return resp[0]
        out = dict(row)
        out["numberofpeople"] = new_n
        return out
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

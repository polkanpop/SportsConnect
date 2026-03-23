from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Depends
from fastapi_cache.decorator import cache
from ..db import rest_select, rest_upsert, rest_update
from ..auth import get_current_user
from ..cache_utils import invalidate_namespace, make_key_builder

router = APIRouter(prefix="/trainingsessioninfo", tags=["training"])

PRIMARY_KEY = "sessioninfoid"

@router.get("", response_model=list[dict])
@cache(expire=120, key_builder=make_key_builder("trainingsessioninfo"))
def list_training_session_info(sessionid: int | None = Query(None), limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
    try:
        filters: dict[str, int] = {}
        if sessionid is not None:
            filters["sessionid"] = sessionid
        data = rest_select("trainingsessioninfo", "*", filters=filters or None, order={"column": PRIMARY_KEY, "desc": True})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{sessioninfoid}", response_model=dict)
@cache(expire=120, key_builder=make_key_builder("trainingsessioninfo"))
def get_training_session_info(sessioninfoid: int):
    try:
        row = rest_select("trainingsessioninfo", "*", filters={PRIMARY_KEY: sessioninfoid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Training session info not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_training_session_info(body: dict, background_tasks: BackgroundTasks):
    try:
        resp = rest_upsert("trainingsessioninfo", body)
        background_tasks.add_task(invalidate_namespace, "trainingsessioninfo", "trainingsessions")
        return resp[0] if isinstance(resp, list) and resp else body
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/{sessioninfoid}", response_model=dict)
def update_training_session_info(sessioninfoid: int, body: dict, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
    """Patch trainingsessioninfo fields (used to update numberofpeople)."""
    try:
        payload = dict(body or {})
        payload.pop(PRIMARY_KEY, None)
        if not payload:
            raise HTTPException(status_code=422, detail="No fields to update")

        resp = rest_update("trainingsessioninfo", {PRIMARY_KEY: sessioninfoid}, payload)
        background_tasks.add_task(invalidate_namespace, "trainingsessioninfo", "trainingsessions")
        if isinstance(resp, list) and resp:
            return resp[0]
        return payload
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/adjust/{sessionid}", response_model=dict)
def adjust_training_participants(sessionid: int, background_tasks: BackgroundTasks, delta: int = Query(..., ge=-1000, le=1000), current_user: str = Depends(get_current_user)):
    """Adjust trainingsessioninfo.numberofpeople by delta (clamped at >= 0)."""
    try:
        row = rest_select("trainingsessioninfo", "*", filters={"sessionid": sessionid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Training session info not found")

        current = row.get("numberofpeople")
        try:
            current_n = int(current) if current is not None else 0
        except Exception:
            current_n = 0
        new_n = current_n + int(delta)
        if new_n < 0:
            new_n = 0

        resp = rest_update("trainingsessioninfo", {PRIMARY_KEY: row.get(PRIMARY_KEY)}, {"numberofpeople": new_n})
        if isinstance(resp, list) and resp:
            return resp[0]
        out = dict(row)
        out["numberofpeople"] = new_n
        return out
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

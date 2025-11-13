from fastapi import APIRouter, HTTPException, Query
from ..db import rest_select, rest_upsert

router = APIRouter(prefix="/trainingsessioninfo", tags=["training"])

PRIMARY_KEY = "sessioninfoid"

@router.get("", response_model=list[dict])
def list_training_session_info(sessionid: int | None = Query(None), limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
    try:
        filters: dict[str, int] = {}
        if sessionid is not None:
            filters["sessionid"] = sessionid
        data = rest_select("trainingsessioninfo", "*", filters=filters or None, order={"column": PRIMARY_KEY})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{sessioninfoid}", response_model=dict)
def get_training_session_info(sessioninfoid: int):
    try:
        row = rest_select("trainingsessioninfo", "*", filters={PRIMARY_KEY: sessioninfoid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Training session info not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_training_session_info(body: dict):
    try:
        resp = rest_upsert("trainingsessioninfo", body)
        return resp[0] if isinstance(resp, list) and resp else body
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

from fastapi import APIRouter, HTTPException, Query
from ..db import rest_select

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
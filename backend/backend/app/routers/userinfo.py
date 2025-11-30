from fastapi import APIRouter, HTTPException, Query, Body
from ..db import rest_select, rest_update

router = APIRouter(prefix="/userinfo", tags=["users"])

PRIMARY_KEY = "infoid"  # actual PK column

@router.get("", response_model=list[dict])
def list_userinfo(userid: int | None = Query(None, description="Filter by userid")):
    try:
        filters = {"userid": userid} if userid is not None else None
        data = rest_select("userinfo", "*", filters=filters, order={"column": PRIMARY_KEY})
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{infoid}", response_model=dict)
def get_userinfo(infoid: int):
    try:
        row = rest_select("userinfo", "*", filters={PRIMARY_KEY: infoid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="User info not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.patch("/{userid}", response_model=dict)
def update_userinfo(userid: int, payload: dict = Body(...)):
    try:
        # Update by userid
        updated = rest_update("userinfo", {"userid": userid}, payload)
        if not updated:
             raise HTTPException(status_code=404, detail="User info not found")
        return updated[0]
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

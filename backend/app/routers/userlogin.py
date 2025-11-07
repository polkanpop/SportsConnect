from fastapi import APIRouter, HTTPException, Query
from ..db import rest_select

router = APIRouter(prefix="/userlogin", tags=["users"])

PRIMARY_KEY = "loginid"

@router.get("", response_model=list[dict])
def list_userlogin(userid: int | None = Query(None, description="Filter by userid")):
    try:
        filters = {"userid": userid} if userid is not None else None
        data = rest_select("userlogin", "*", filters=filters, order={"column": PRIMARY_KEY})
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{loginid}", response_model=dict)
def get_userlogin(loginid: int):
    try:
        row = rest_select("userlogin", "*", filters={PRIMARY_KEY: loginid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="User login record not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

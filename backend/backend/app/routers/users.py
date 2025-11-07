from fastapi import APIRouter, HTTPException
from ..db import rest_select

router = APIRouter(prefix="/users", tags=["users"])

PRIMARY_KEY = "userid"

@router.get("", response_model=list[dict])
def list_users():
    try:
        data = rest_select("users", "*", order={"column": PRIMARY_KEY})
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{userid}", response_model=dict)
def get_user(userid: int):
    try:
        row = rest_select("users", "*", filters={PRIMARY_KEY: userid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

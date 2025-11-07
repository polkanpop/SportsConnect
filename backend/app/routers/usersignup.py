from fastapi import APIRouter, HTTPException
from ..db import rest_select

router = APIRouter(prefix="/usersignup", tags=["users"])

PRIMARY_KEY = "userid"  # signup table uses userid as PK

@router.get("", response_model=list[dict])
def list_usersignup():
    try:
        data = rest_select("usersignup", "*", order={"column": PRIMARY_KEY})
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{userid}", response_model=dict)
def get_usersignup(userid: int):
    try:
        row = rest_select("usersignup", "*", filters={PRIMARY_KEY: userid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="User signup record not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

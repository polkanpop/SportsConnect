from fastapi import APIRouter, HTTPException, Query, Body, Depends
from pydantic import BaseModel, Field
from ..db import rest_select, rest_update
from ..auth import get_current_user

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


class UpdatePfpRequest(BaseModel):
    pfp: str | None = Field(default=None, max_length=2048, description="Public URL for the user's profile picture")


@router.patch("/{userid}/pfp", response_model=dict)
def update_user_pfp(userid: int, req: UpdatePfpRequest, sub: str = Depends(get_current_user)):
    """Update the user's profile picture URL.

    Security:
    - Requires Bearer token
    - Token subject must be numeric and match {userid}
    """
    try:
        token_userid = int(str(sub))
    except Exception:
        raise HTTPException(status_code=403, detail="Token subject is not a numeric userid")
    if token_userid != userid:
        raise HTTPException(status_code=403, detail="Cannot update another user's profile picture")

    try:
        updated = rest_update("userinfo", {"userid": userid}, {"pfp": req.pfp})
        if not updated:
            raise HTTPException(status_code=404, detail="User info not found")
        return updated[0]
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

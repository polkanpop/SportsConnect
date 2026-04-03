from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Body, Depends
from fastapi_cache.decorator import cache
from pydantic import BaseModel, Field
from ..db import rest_select, rest_update
from ..auth import get_current_user
from ..cache_utils import invalidate_namespace, make_key_builder

router = APIRouter(prefix="/userinfo", tags=["users"])

PRIMARY_KEY = "infoid"  # actual PK column

@router.get("", response_model=list[dict])
@cache(expire=60, key_builder=make_key_builder("userinfo"))
def list_userinfo(userid: int | None = Query(None, description="Filter by userid")):
    try:
        filters = {"userid": userid} if userid is not None else None
        data = rest_select(
            "userinfo",
            "infoid,userid,name,email,contactnumber,biography,pfp,emailvisiblestatus,phonevisiblestatus",
            filters=filters,
            order={"column": PRIMARY_KEY},
        )
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{infoid}", response_model=dict)
@cache(expire=60, key_builder=make_key_builder("userinfo"))
def get_userinfo(infoid: int):
    try:
        row = rest_select("userinfo", "*", filters={PRIMARY_KEY: infoid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="User info not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.patch("/{userid}", response_model=dict)
def update_userinfo(userid: int, background_tasks: BackgroundTasks, payload: dict = Body(...)):
    try:
        # Update by userid
        updated = rest_update("userinfo", {"userid": userid}, payload)
        if not updated:
             raise HTTPException(status_code=404, detail="User info not found")
        background_tasks.add_task(invalidate_namespace, "userinfo")
        return updated[0]
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


class UpdatePfpRequest(BaseModel):
    pfp: str | None = Field(default=None, max_length=2048, description="Public URL for the user's profile picture")


@router.patch("/{userid}/pfp", response_model=dict)
def update_user_pfp(userid: int, req: UpdatePfpRequest, background_tasks: BackgroundTasks, sub: str = Depends(get_current_user)):
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
        background_tasks.add_task(invalidate_namespace, "userinfo")
        return updated[0]
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

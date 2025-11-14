from fastapi import APIRouter, HTTPException, Depends
from fastapi import Request
from ..rate_limit import limiter
from ..db import rest_select, rest_upsert, rest_delete
from ..models import Favorite, FavoriteCreate
from ..auth import get_current_user

router = APIRouter(prefix="/favorites", tags=["favorites"])

def _attach_user_state(request: Request, user_id: str = Depends(get_current_user)):
    """Dependency to attach user id to request.state before limiter key_func evaluates."""
    request.state.user_id = user_id
    return user_id

@router.get("", response_model=list[Favorite])
async def list_favorites(user_id: str = Depends(get_current_user)):
    try:
        data = rest_select("user_favorites", "user_id,courtinfoid", filters={"user_id": user_id})
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("", response_model=Favorite, dependencies=[Depends(_attach_user_state)])
@limiter.limit("8/minute")
async def add_favorite(request: Request, body: FavoriteCreate, user_id: str = Depends(get_current_user)):
    try:
        # Attach user id to request state for user-scoped rate limiting
        request.state.user_id = user_id
        payload = {"user_id": user_id, "courtinfoid": body.courtinfoid}
        resp = rest_upsert("user_favorites", payload)
        return resp[0] if isinstance(resp, list) and resp else payload
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/{courtinfoid}", dependencies=[Depends(_attach_user_state)])
@limiter.limit("8/minute")
async def remove_favorite(request: Request, courtinfoid: int, user_id: str = Depends(get_current_user)):
    try:
        request.state.user_id = user_id
        resp = rest_delete("user_favorites", {"user_id": user_id, "courtinfoid": courtinfoid})
        return {"deleted": True, "count": len(resp) if isinstance(resp, list) else 0}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

from fastapi import APIRouter, HTTPException, Depends, Header
from ..db import rest_select, rest_upsert, rest_delete
from ..models import Favorite, FavoriteCreate

router = APIRouter(prefix="/favorites", tags=["favorites"])

# NOTE: For production you should validate a Supabase user access token. Here we accept X-User-Id header for simplicity.

def get_user_id(x_user_id: str | None = Header(default=None, alias="X-User-Id")) -> str:
    if not x_user_id:
        raise HTTPException(status_code=401, detail="X-User-Id header required")
    return x_user_id

@router.get("", response_model=list[Favorite])  # remove trailing slash to avoid 307 redirect
async def list_favorites(user_id: str = Depends(get_user_id)):
    try:
        data = rest_select("user_favorites", "user_id,courtinfoid", filters={"user_id": user_id})
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("", response_model=Favorite)  # consistency without trailing slash
async def add_favorite(body: FavoriteCreate, user_id: str = Depends(get_user_id)):
    try:
        payload = {"user_id": user_id, "courtinfoid": body.courtinfoid}
        resp = rest_upsert("user_favorites", payload)
        # REST upsert returns list of rows
        return resp[0] if isinstance(resp, list) and resp else payload
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/{courtinfoid}")
async def remove_favorite(courtinfoid: int, user_id: str = Depends(get_user_id)):
    try:
        resp = rest_delete("user_favorites", {"user_id": user_id, "courtinfoid": courtinfoid})
        return {"deleted": True, "count": len(resp) if isinstance(resp, list) else 0}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

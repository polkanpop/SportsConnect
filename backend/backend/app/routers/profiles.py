from fastapi import APIRouter, HTTPException, Depends
from ..db import rest_select, rest_upsert
from ..models import Profile, ProfileUpdate
from ..auth import get_current_user

router = APIRouter(prefix="/profiles", tags=["profiles"])

@router.get("/{user_id}", response_model=Profile)
async def get_profile(user_id: str):
    try:
        data = rest_select("profiles", "id,username,full_name,avatar_url", filters={"id": user_id}, single=True)
        if not data:
            raise HTTPException(status_code=404, detail="Profile not found")
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.patch("/{user_id}", response_model=Profile)
async def update_profile(user_id: str, body: ProfileUpdate, current_user: str = Depends(get_current_user)):
    if current_user != user_id:
        raise HTTPException(status_code=403, detail="Cannot modify another user's profile")
    try:
        update_data = {k: v for k, v in body.dict(exclude_unset=True).items() if v is not None}
        if not update_data:
            # Return existing profile unchanged if no updates provided
            existing = rest_select("profiles", "id,username,full_name,avatar_url", filters={"id": user_id}, single=True)
            if not existing:
                raise HTTPException(status_code=404, detail="Profile not found")
            return existing
        update_data["id"] = user_id
        resp = rest_upsert("profiles", update_data)
        return resp[0] if isinstance(resp, list) and resp else update_data
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

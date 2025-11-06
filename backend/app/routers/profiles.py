from fastapi import APIRouter, HTTPException
from ..db import rest_select
from ..models import Profile

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

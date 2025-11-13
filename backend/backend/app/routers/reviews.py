from fastapi import APIRouter, HTTPException, Query, Depends
from ..db import rest_select, rest_upsert
from ..auth import get_current_user

router = APIRouter(prefix="/reviews", tags=["reviews"])

PRIMARY_KEY = "reviewid"

@router.get("", response_model=list[dict])
def list_reviews(targettype: str | None = Query(None), targetid: int | None = Query(None), userid: int | None = Query(None), limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
    try:
        filters: dict[str, int | str] = {}
        if targettype is not None:
            filters["targettype"] = targettype
        if targetid is not None:
            filters["targetid"] = targetid
        if userid is not None:
            filters["userid"] = userid
        data = rest_select("reviews", "*", filters=filters or None, order={"column": PRIMARY_KEY})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{reviewid}", response_model=dict)
def get_review(reviewid: int):
    try:
        row = rest_select("reviews", "*", filters={PRIMARY_KEY: reviewid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Review not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_review(body: dict, current_user: str = Depends(get_current_user)):
    """Create a review. Inject userid from auth if not provided."""
    try:
        payload = {**body, "userid": body.get("userid") or current_user}
        resp = rest_upsert("reviews", payload)
        return resp[0] if isinstance(resp, list) and resp else payload
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

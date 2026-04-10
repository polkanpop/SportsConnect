from typing import Literal, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Depends
from fastapi_cache.decorator import cache
from pydantic import BaseModel, Field, field_validator

from ..auth import get_current_user
from ..cache_utils import invalidate_namespace, make_key_builder
from ..db import RpcError, rest_insert, rest_rpc, rest_select

router = APIRouter(prefix="/reviews", tags=["reviews"])

PRIMARY_KEY = "reviewid"

@router.get("", response_model=list[dict])
@cache(expire=120, key_builder=make_key_builder("reviews"))
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
@cache(expire=120, key_builder=make_key_builder("reviews"))
def get_review(reviewid: int):
    try:
        row = rest_select("reviews", "*", filters={PRIMARY_KEY: reviewid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Review not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

# ── Pydantic request models ───────────────────────────────────────────────────

class ReviewIn(BaseModel):
    targettype: Literal['court', 'event', 'trainingsession'] = Field(..., description="'court', 'event', or 'trainingsession'")
    targetid: int
    rating: int = Field(..., ge=1, le=5)
    comment: str
    userid: Optional[int] = None  # falls back to auth subject

    @field_validator('targettype', mode='before')
    @classmethod
    def normalize_targettype(cls, v: str) -> str:
        normalized = str(v or '').lower().strip()
        if normalized not in ('court', 'event', 'trainingsession'):
            return 'court'  # default to court review
        return normalized


class ReactIn(BaseModel):
    reviewid: int
    reaction: Optional[str] = Field(
        None,
        description="'like', 'dislike', or null / omit to retract",
    )


# ── Write endpoints ───────────────────────────────────────────────────────────

@router.post("", response_model=dict, summary="Create or update a review (RPC)")
def create_review(
    body: ReviewIn,
    background_tasks: BackgroundTasks,
    current_user: str = Depends(get_current_user),
):
    """Call ``rpc_create_review``.

    Blocked with HTTP 403 when the user has no completed booking for the target.
    Blocked with HTTP 403 if user is not eligible (no completed booking).
    One review per user per target is enforced: subsequent calls update the
    existing review instead of inserting a duplicate.
    """
    try:
        userid = int(body.userid or current_user)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token subject (expected numeric userid)")

    try:
        result = rest_rpc(
            "rpc_create_review",
            {
                "p_userid":     userid,
                "p_targettype": body.targettype,
                "p_targetid":   body.targetid,
                "p_rating":     body.rating,
                "p_comment":    body.comment,
            },
        )
    except RpcError as e:
        if e.code == "P0001":  # REVIEW_NOT_ELIGIBLE
            raise HTTPException(status_code=403, detail=e.message)
        if e.code == "P0002":  # INVALID_RATING
            raise HTTPException(status_code=400, detail=e.message)
        raise HTTPException(status_code=400, detail=e.message)

    row = result[0] if isinstance(result, list) and result else {}
    background_tasks.add_task(invalidate_namespace, "reviews")
    return row


@router.post("/react", response_model=dict, summary="Cast, change, or retract a review reaction (RPC)")
def react_to_review(
    body: ReactIn,
    background_tasks: BackgroundTasks,
    current_user: str = Depends(get_current_user),
):
    """Call ``rpc_upsert_review_reaction``.

    - Pass ``reaction='like'`` or ``reaction='dislike'`` to set / change.
    - Pass ``reaction=null`` (or omit the field) to retract an existing reaction.
    - Returns HTTP 403 when the caller has no completed booking for the review's target.
    - Returns HTTP 404 when the reviewid does not exist.
    """
    try:
        userid = int(current_user)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token subject (expected numeric userid)")

    if body.reaction is not None and body.reaction not in {"like", "dislike"}:
        raise HTTPException(status_code=422, detail="reaction must be 'like', 'dislike', or null to retract")

    try:
        rest_rpc(
            "rpc_upsert_review_reaction",
            {
                "p_userid":   userid,
                "p_reviewid": body.reviewid,
                "p_reaction": body.reaction,  # None → omitted by rest_rpc → SQL DEFAULT NULL
            },
        )
    except RpcError as e:
        if e.code == "P0001":  # REACTION_NOT_ELIGIBLE
            raise HTTPException(status_code=403, detail=e.message)
        if e.code == "P0003":  # REVIEW_NOT_FOUND
            raise HTTPException(status_code=404, detail=e.message)
        raise HTTPException(status_code=400, detail=e.message)

    background_tasks.add_task(invalidate_namespace, "reviews", "review_reactions")
    return {"ok": True, "reviewid": body.reviewid, "reaction": body.reaction}


@router.get("/{reviewid}/reactions", response_model=dict)
@cache(expire=60, key_builder=make_key_builder("review_reactions"))
def get_review_reactions(reviewid: int, current_user: str = Depends(get_current_user)):
    """Get reaction counts for a review + the current user's reaction (if any)."""
    try:
        userid = int(current_user)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token subject (expected numeric userid)")

    try:
        rows = rest_select("review_reactions", "userid,reaction", filters={"reviewid": reviewid})
        if not isinstance(rows, list):
            rows = []
        like_count = 0
        dislike_count = 0
        my_reaction = None
        for r in rows:
            reaction = r.get("reaction")
            if reaction == "like":
                like_count += 1
            elif reaction == "dislike":
                dislike_count += 1
            if r.get("userid") is not None and int(r.get("userid")) == userid:
                my_reaction = reaction
        return {"reviewid": reviewid, "like": like_count, "dislike": dislike_count, "my_reaction": my_reaction}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{reviewid}/reactions", response_model=dict)
def create_review_reaction(reviewid: int, body: dict, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
    """React to a review once (DB enforces eligibility + uniqueness)."""
    try:
        userid = int(current_user)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token subject (expected numeric userid)")

    reaction = (body or {}).get("reaction")
    if reaction not in {"like", "dislike"}:
        raise HTTPException(status_code=422, detail="reaction must be 'like' or 'dislike'")

    try:
        resp = rest_insert(
            "review_reactions",
            {"reviewid": int(reviewid), "userid": int(userid), "reaction": reaction},
        )
        row = resp[0] if isinstance(resp, list) and resp else {"reviewid": reviewid, "userid": userid, "reaction": reaction}
        background_tasks.add_task(invalidate_namespace, "review_reactions")
        return {"ok": True, "reaction": row}
    except RuntimeError as e:
        # Supabase surfaces unique violation as 409.
        if "409" in str(e):
            raise HTTPException(status_code=409, detail="You have already reacted to this review")
        raise HTTPException(status_code=400, detail=str(e))

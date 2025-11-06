from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from ..db import rest_select
from ..models import Notification

router = APIRouter(prefix="/notifications", tags=["notifications"])

@router.get("", response_model=list[Notification])  # no trailing slash to avoid 307 redirect
async def list_notifications(
    category: Optional[str] = Query(None, description="Filter by category"),
    debug: bool = Query(False, description="Return raw error detail on failure"),
):
    """List notifications. Optional category filter.

    If supabase returns an error (e.g. wrong column name or RLS block), we fallback to [] unless debug=true.
    """
    filters = {"category": category} if category else None
    order_column_candidates = ["id", "created_at"]
    last_error: Optional[str] = None
    for col in order_column_candidates:
        try:
            data = rest_select(
                "notifications",
                "*",
                filters=filters,
                order={"column": col, "desc": True},
            )
            return data
        except RuntimeError as e:
            last_error = str(e)
            # try next column
            continue
    # All attempts failed
    if debug and last_error:
        raise HTTPException(status_code=500, detail=last_error)
    return []

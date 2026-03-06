from fastapi import APIRouter, Query
from typing import Any

from ..db import rest_select

router = APIRouter(prefix="/services", tags=["services"])


@router.get("", response_model=list[dict])
def list_services(
    courtid: int | None = Query(None),
    status: str | None = Query(None),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """List services (optionally filtered by courtid/status)."""
    filters: dict[str, Any] = {}
    if courtid is not None:
        filters["courtid"] = courtid
    if status is not None:
        filters["status"] = status

    data = rest_select("services", "*", filters=filters or None)
    if not isinstance(data, list):
        return []
    return data[offset : offset + limit]

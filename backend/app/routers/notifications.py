from fastapi import APIRouter, HTTPException, Query
from typing import Optional, List, Any
from ..db import rest_select
from ..models import Notification

router = APIRouter(prefix="/notifications", tags=["notifications"])

# We start with '*' to avoid column name mismatches. We'll trim/transform after fetch.
RAW_SELECT = "*"

EXPECTED_FIELDS = {"id", "status", "user_id", "message", "time", "notificationtype", "notificationtypeid"}

def normalize_row(row: dict[str, Any]) -> dict[str, Any]:
    """Map alternative primary key names to 'id' and ensure expected keys exist.
    Supports common patterns: notification_id, notificationid.
    """
    if "id" not in row:
        for alt in ["notification_id", "notificationid"]:
            if alt in row:
                row["id"] = row[alt]
                break
    return {k: row.get(k) for k in EXPECTED_FIELDS}

@router.get("", response_model=List[Notification])
async def list_notifications(
    user_id: Optional[int] = Query(None, description="Filter by user id"),
    notificationtype: Optional[str] = Query(None, description="Filter by notification type"),
    debug: bool = Query(False, description="Show upstream error detail"),
):
    filters = {}
    if user_id is not None:
        filters["user_id"] = user_id
    if notificationtype is not None:
        filters["notificationtype"] = notificationtype
    if not filters:
        filters = None
    try:
        data = rest_select(
            "notifications",
            RAW_SELECT,
            filters=filters,
        )
        if not isinstance(data, list):
            return []
        # Normalize rows & sort if 'id' present.
        normalized = [normalize_row(r) for r in data]
        if all("id" in r and r["id"] is not None for r in normalized):
            normalized.sort(key=lambda r: r["id"])  # ascending like courtinfo
        return normalized
    except RuntimeError as e:
        if debug:
            raise HTTPException(status_code=500, detail=str(e))
        raise HTTPException(status_code=500, detail="Failed to fetch notifications. Add ?debug=true for details")

@router.get("/{notification_id}", response_model=Notification)
async def get_notification(notification_id: int, debug: bool = Query(False)):
    try:
        data = rest_select(
            "notifications",
            RAW_SELECT,
            filters={"id": notification_id},
            single=True,
        )
        if not data or ("id" not in data and "notification_id" not in data and "notificationid" not in data):
            raise HTTPException(status_code=404, detail="Notification not found")
        data = normalize_row(data)
        return data
    except RuntimeError as e:
        if debug:
            raise HTTPException(status_code=500, detail=str(e))
        raise HTTPException(status_code=404, detail="Notification not found or fetch error. Add ?debug=true for details")

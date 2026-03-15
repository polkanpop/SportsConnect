from fastapi import APIRouter, HTTPException, Query, Depends
from typing import Optional, List, Any
from datetime import datetime, timezone
from pydantic import BaseModel
from ..db import rest_select, rest_update
from ..auth import get_current_user
from ..models import Notification

router = APIRouter(prefix="/notifications", tags=["notifications"])

# We start with '*' to avoid column name mismatches. We'll trim/transform after fetch.
RAW_SELECT = "*"

EXPECTED_FIELDS = {
    "notificationid",
    "status",
    "userid",
    "title",
    "message",
    "time",
    "notificationtype",
    "notificationtypeid",
    "category",
    "kind",
    "data",
    "read_at",
}


class DeleteManyPayload(BaseModel):
    notificationids: List[int]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_row(row: dict[str, Any]) -> dict[str, Any]:
    """Normalize Supabase rows into stable response shape.

    This router intentionally matches the DB column names because the mobile app
    already uses them (notificationid/userid).
    """
    if "notificationid" not in row:
        for alt in ["id", "notification_id"]:
            if alt in row:
                row["notificationid"] = row[alt]
                break
    if "userid" not in row:
        for alt in ["user_id", "userId"]:
            if alt in row:
                row["userid"] = row[alt]
                break
    return {k: row.get(k) for k in EXPECTED_FIELDS}


def _coerce_numeric_userid(sub: str | None) -> int | None:
    if sub is None:
        return None
    try:
        return int(str(sub))
    except Exception:
        return None

@router.get("", response_model=List[Notification])
async def list_notifications(
    category: Optional[str] = Query(None, description="Filter by category: court | event | training"),
    status: Optional[str] = Query(None, description="Filter by status: unread | read"),
    notificationtype: Optional[str] = Query(None, description="Filter by notification type"),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    userid: Optional[int] = Query(None, description="Debug only: override userid (must match token)"),
    debug: bool = Query(False, description="Show upstream error detail"),
    sub: str = Depends(get_current_user),
):
    token_userid = _coerce_numeric_userid(sub)
    if token_userid is None:
        raise HTTPException(status_code=401, detail="Invalid token subject (expected numeric userid)")

    final_userid = userid if userid is not None else token_userid
    if final_userid != token_userid:
        raise HTTPException(status_code=403, detail="Cannot access another user's notifications")

    filters: dict[str, Any] = {"userid": final_userid}
    if category is not None:
        filters["category"] = category
    if status is not None:
        filters["status"] = status
    if notificationtype is not None:
        filters["notificationtype"] = notificationtype

    try:
        data = rest_select(
            "notifications",
            RAW_SELECT,
            filters=filters,
            order={"column": "time", "desc": True},
        )
        if not isinstance(data, list):
            return []
        normalized = [normalize_row(r) for r in data]
        sliced = normalized[offset: offset + limit]
        return sliced
    except RuntimeError as e:
        if debug:
            raise HTTPException(status_code=500, detail=str(e))
        raise HTTPException(status_code=500, detail="Failed to fetch notifications. Add ?debug=true for details")

@router.get("/{notificationid}", response_model=Notification)
async def get_notification(notificationid: int, debug: bool = Query(False), sub: str = Depends(get_current_user)):
    token_userid = _coerce_numeric_userid(sub)
    if token_userid is None:
        raise HTTPException(status_code=401, detail="Invalid token subject (expected numeric userid)")
    try:
        row = rest_select(
            "notifications",
            RAW_SELECT,
            filters={"notificationid": notificationid},
            single=True,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Notification not found")
        row = normalize_row(row)
        if row.get("userid") is not None and int(row.get("userid")) != token_userid:
            raise HTTPException(status_code=403, detail="Not allowed")
        return row
    except HTTPException:
        raise
    except RuntimeError as e:
        if debug:
            raise HTTPException(status_code=500, detail=str(e))
        raise HTTPException(status_code=404, detail="Notification not found or fetch error. Add ?debug=true for details")


@router.patch("/{notificationid}/read", response_model=Notification)
async def mark_notification_read(notificationid: int, sub: str = Depends(get_current_user)):
    token_userid = _coerce_numeric_userid(sub)
    if token_userid is None:
        raise HTTPException(status_code=401, detail="Invalid token subject (expected numeric userid)")
    try:
        row = rest_select(
            "notifications",
            RAW_SELECT,
            filters={"notificationid": notificationid},
            single=True,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Notification not found")
        if row.get("userid") is not None and int(row.get("userid")) != token_userid:
            raise HTTPException(status_code=403, detail="Not allowed")

        updated = rest_update(
            "notifications",
            {"notificationid": notificationid},
            {"status": "read", "read_at": _now_iso()},
        )
        if isinstance(updated, list) and updated:
            return normalize_row(updated[0])
        # Fallback
        row["status"] = "read"
        row["read_at"] = _now_iso()
        return normalize_row(row)
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/mark_all_read", response_model=dict)
async def mark_all_read(
    category: Optional[str] = Query(None, description="Optional category filter: court|event|training"),
    sub: str = Depends(get_current_user),
):
    token_userid = _coerce_numeric_userid(sub)
    if token_userid is None:
        raise HTTPException(status_code=401, detail="Invalid token subject (expected numeric userid)")
    try:
        filters: dict[str, Any] = {"userid": token_userid, "status": "unread"}
        if category is not None:
            filters["category"] = category
        rest_update("notifications", filters, {"status": "read", "read_at": _now_iso()})
        return {"ok": True}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{notificationid}", response_model=dict)
async def delete_notification(notificationid: int, sub: str = Depends(get_current_user)):
    token_userid = _coerce_numeric_userid(sub)
    if token_userid is None:
        raise HTTPException(status_code=401, detail="Invalid token subject (expected numeric userid)")
    try:
        row = rest_select(
            "notifications",
            RAW_SELECT,
            filters={"notificationid": notificationid},
            single=True,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Notification not found")
        if row.get("userid") is not None and int(row.get("userid")) != token_userid:
            raise HTTPException(status_code=403, detail="Not allowed")
        # Soft-delete style not available in current schema; hard delete the row.
        from ..db import rest_delete
        deleted = rest_delete("notifications", {"notificationid": notificationid})
        return {"ok": True, "count": len(deleted) if isinstance(deleted, list) else 0}
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/delete_many", response_model=dict)
async def delete_many_notifications(payload: DeleteManyPayload, sub: str = Depends(get_current_user)):
    token_userid = _coerce_numeric_userid(sub)
    if token_userid is None:
        raise HTTPException(status_code=401, detail="Invalid token subject (expected numeric userid)")

    notificationids = [int(x) for x in payload.notificationids if isinstance(x, int)]
    if not notificationids:
        return {"ok": True, "count": 0}

    try:
        rows = rest_select(
            "notifications",
            RAW_SELECT,
            filters={"notificationid": notificationids},
        )
        if not isinstance(rows, list):
            rows = []

        owned_ids: List[int] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            row_userid = row.get("userid")
            row_id = row.get("notificationid")
            if row_userid is None or row_id is None:
                continue
            if int(row_userid) == token_userid:
                owned_ids.append(int(row_id))

        if not owned_ids:
            return {"ok": True, "count": 0}

        from ..db import rest_delete
        deleted_count = 0
        for nid in owned_ids:
            out = rest_delete("notifications", {"notificationid": nid})
            if isinstance(out, list):
                deleted_count += len(out)
        return {"ok": True, "count": deleted_count}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

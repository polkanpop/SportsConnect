from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from .db import rest_insert


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_notification(
    *,
    userid: int,
    notificationtype: str,
    title: str,
    message: str,
    category: Optional[str] = None,  # court | event | training
    kind: Optional[str] = None,  # submitted | approved | rejected | created | incoming_booking
    notificationtypeid: Optional[int] = None,
    data: Optional[dict[str, Any]] = None,
    status: str = "unread",
    time_iso: Optional[str] = None,
) -> dict[str, Any] | None:
    """Best-effort insert into public.notifications.

    This is intentionally tolerant: if the target DB schema doesn't have some of the
    optional columns yet, Supabase will reject the insert; callers should catch and
    avoid blocking their main workflow.
    """
    payload: dict[str, Any] = {
        "userid": int(userid),
        "status": status,
        "title": title,
        "message": message,
        "notificationtype": notificationtype,
        "notificationtypeid": notificationtypeid,
        "time": time_iso or _now_iso(),
    }
    if category is not None:
        payload["category"] = category
    if kind is not None:
        payload["kind"] = kind
    if data is not None:
        payload["data"] = data

    rows = rest_insert("notifications", payload)
    if isinstance(rows, list) and rows:
        return rows[0]
    return None

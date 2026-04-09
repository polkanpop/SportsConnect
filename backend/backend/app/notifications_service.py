from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from .db import rest_insert
from .push_service import send_push_to_user


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
    message_key: Optional[str] = None,
    message_params: Optional[dict[str, Any]] = None,
) -> dict[str, Any] | None:
    """Best-effort insert into public.notifications and send push.

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
    if message_key is not None:
        payload["message_key"] = message_key
    if message_params is not None:
        payload["message_params"] = message_params

    rows = rest_insert("notifications", payload)
    result = rows[0] if isinstance(rows, list) and rows else None

    # Best-effort push notification to the user's active devices
    try:
        push_data: dict[str, Any] = {"category": category or "", "kind": kind or ""}
        if data:
            push_data.update(data)
        send_push_to_user(
            userid=userid,
            title=title,
            body=message,
            data=push_data,
            category_id=category,
        )
    except Exception:
        pass  # never block the main flow

    return result

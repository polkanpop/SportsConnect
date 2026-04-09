"""
Expo Push Notification sender.

Reads active device tokens from `user_devices` and POSTs to the Expo Push API.
All calls are best-effort — failures are logged but never block the caller.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from .db import rest_select

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
_TIMEOUT = 10  # seconds


def send_push_to_user(
    *,
    userid: int,
    title: str,
    body: str,
    data: Optional[dict[str, Any]] = None,
    category_id: Optional[str] = None,
) -> None:
    """Send a push notification to all active devices of a user.

    Best-effort: logs errors but never raises.
    """
    try:
        rows = rest_select(
            "user_devices",
            "push_token",
            filters={"userid": userid, "is_active": True},
        )
        if not rows:
            return

        tokens = [r["push_token"] for r in rows if r.get("push_token")]
        if not tokens:
            return

        messages = []
        for token in tokens:
            msg: dict[str, Any] = {
                "to": token,
                "title": title,
                "body": body,
                "sound": "default",
                "priority": "high",
            }
            if data:
                msg["data"] = data
            if category_id:
                msg["categoryId"] = category_id
            messages.append(msg)

        with httpx.Client(timeout=_TIMEOUT) as client:
            resp = client.post(
                EXPO_PUSH_URL,
                json=messages,
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
            )
            if resp.status_code != 200:
                logger.warning(
                    "[push] Expo API returned %s for userid=%s: %s",
                    resp.status_code, userid, resp.text[:300],
                )
            else:
                resp_data = resp.json().get("data", [])
                for i, ticket in enumerate(resp_data):
                    if ticket.get("status") == "error":
                        logger.warning(
                            "[push] ticket error userid=%s token=%s detail=%s",
                            userid, tokens[i][:30], ticket.get("message", ""),
                        )

    except Exception as exc:
        logger.warning("[push] send_push_to_user failed userid=%s err=%s", userid, exc)

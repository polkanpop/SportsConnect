"""
POST /api/test-push   — Send a test push notification to the authenticated user.
GET  /api/test-push/status — Check push configuration for the authenticated user.

These endpoints exist solely for verifying the push notification pipeline.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..auth import get_current_user
from ..db import rest_select
from ..push_service import send_push_to_user

router = APIRouter(prefix="/test-push", tags=["test-push"])
logger = logging.getLogger(__name__)


@router.get("/status")
async def push_status(user: str = Depends(get_current_user)):
    """Return the user's registered push tokens and device info."""
    userid = int(user)
    rows = rest_select(
        "user_devices",
        "push_token, platform, token_type, is_active, updated_at",
        filters={"userid": userid},
    )
    active = [r for r in (rows or []) if r.get("is_active")]
    return {
        "userid": userid,
        "total_devices": len(rows or []),
        "active_devices": len(active),
        "tokens": [
            {
                "push_token": r.get("push_token", "")[:40] + "...",
                "platform": r.get("platform"),
                "token_type": r.get("token_type"),
                "is_active": r.get("is_active"),
            }
            for r in (rows or [])
        ],
    }


@router.post("")
async def send_test_push(user: str = Depends(get_current_user)):
    """Send a test push notification to all active devices of the authenticated user.

    Returns the Expo Push API response tickets for verification.
    """
    import httpx

    userid = int(user)

    # 1. Check tokens exist
    rows = rest_select(
        "user_devices",
        "push_token",
        filters={"userid": userid, "is_active": True},
    )
    if not rows:
        raise HTTPException(
            status_code=404,
            detail="No active push tokens found for this user. Open the app and allow notifications first.",
        )

    tokens = [r["push_token"] for r in rows if r.get("push_token")]
    if not tokens:
        raise HTTPException(status_code=404, detail="No push tokens found.")

    # 2. Build test messages
    messages: list[dict[str, Any]] = []
    for token in tokens:
        messages.append({
            "to": token,
            "title": "SportConnect Test",
            "body": "Push notifications are working!",
            "sound": "default",
            "priority": "high",
            "data": {"test": True},
        })

    # 3. Send directly to Expo Push API and return the raw response
    try:
        with httpx.Client(timeout=15) as client:
            resp = client.post(
                "https://exp.host/--/api/v2/push/send",
                json=messages,
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
            )
            result = resp.json()
    except Exception as exc:
        logger.error("[test-push] Expo API call failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"Expo Push API call failed: {exc}")

    # 4. Summarize
    tickets = result.get("data", [])
    ok_count = sum(1 for t in tickets if t.get("status") == "ok")
    err_count = sum(1 for t in tickets if t.get("status") == "error")
    errors = [
        {"token": tokens[i][:40], "message": t.get("message", "")}
        for i, t in enumerate(tickets)
        if t.get("status") == "error"
    ]

    return {
        "sent_to": len(tokens),
        "tickets_ok": ok_count,
        "tickets_error": err_count,
        "errors": errors,
        "raw_tickets": tickets,
    }

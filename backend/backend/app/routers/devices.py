"""
POST /api/devices/register-token   — Upsert a push token for the authenticated user.
DELETE /api/devices/unregister-token — Mark a push token inactive (e.g., on logout).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..auth import get_current_user
from ..db import rest_select, rest_update, rest_upsert

router = APIRouter(prefix="/devices", tags=["devices"])
logger = logging.getLogger(__name__)

_ALLOWED_PLATFORMS   = {"android", "ios", "web"}
_ALLOWED_TOKEN_TYPES = {"expo", "fcm", "apns"}


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─── POST /api/devices/register-token ─────────────────────────────────────────
@router.post("/register-token")
async def register_device_token(
    payload: dict[str, Any],
    userid_str: str = Depends(get_current_user),
):
    """
    Upsert a push notification token for the currently authenticated user.

    Body JSON:
        push_token  (str)  — Expo Push Token or raw FCM/APNs token.
        platform    (str)  — 'android' | 'ios' | 'web'
        token_type  (str)  — 'expo' | 'fcm' | 'apns'  (default 'expo')

    On conflict (same push_token) the row is updated with:
        userid, is_active=True, last_seen_at=now.

    Side-effect: deactivates any *other* tokens this user already owns on the
    same platform+type combination so only the latest device slot is active.
    This cleanly handles app reinstalls and device swaps.
    """
    userid = int(userid_str)

    push_token = (payload.get("push_token") or "").strip()
    platform   = (payload.get("platform")   or "").lower().strip()
    token_type = (payload.get("token_type") or "expo").lower().strip()

    if not push_token:
        raise HTTPException(status_code=400, detail="push_token is required")
    if platform not in _ALLOWED_PLATFORMS:
        raise HTTPException(
            status_code=400,
            detail=f"platform must be one of {sorted(_ALLOWED_PLATFORMS)}",
        )
    if token_type not in _ALLOWED_TOKEN_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"token_type must be one of {sorted(_ALLOWED_TOKEN_TYPES)}",
        )

    now = _utcnow_iso()

    try:
        # ── 1. Deactivate superseded tokens for this user/platform/type ──────
        # When the user reinstalls the app or gets a new device, the OS issues
        # a fresh token. Mark the old ones inactive so the notification sender
        # skips them and avoids FCM "invalid registration" errors.
        old_rows = rest_select(
            "user_devices",
            "deviceid,push_token",
            {"userid": userid, "platform": platform, "token_type": token_type, "is_active": True},
        ) or []

        for row in old_rows:
            if row.get("push_token") != push_token:
                try:
                    rest_update(
                        "user_devices",
                        {"deviceid": row["deviceid"]},
                        {"is_active": False},
                    )
                except Exception as deact_err:
                    logger.warning(
                        "[devices] deactivate stale token failed deviceid=%s err=%s",
                        row.get("deviceid"), deact_err,
                    )

        # ── 2. Upsert on the globally unique push_token column ───────────────
        result = rest_upsert(
            "user_devices",
            {
                "userid":       userid,
                "push_token":   push_token,
                "platform":     platform,
                "token_type":   token_type,
                "is_active":    True,
                "last_seen_at": now,
            },
            on_conflict="push_token",
        )

        device_row = result[0] if isinstance(result, list) and result else {}
        logger.info(
            "[devices] token registered userid=%s platform=%s type=%s deviceid=%s",
            userid, platform, token_type, device_row.get("deviceid"),
        )
        return {"ok": True, "deviceid": device_row.get("deviceid")}

    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[devices] register token failed userid=%s err=%s", userid, exc)
        raise HTTPException(status_code=500, detail="Failed to register device token")


# ─── DELETE /api/devices/unregister-token ─────────────────────────────────────
@router.delete("/unregister-token")
async def unregister_device_token(
    payload: dict[str, Any],
    userid_str: str = Depends(get_current_user),
):
    """
    Mark a push token as inactive.
    Call this on logout so the user no longer receives push notifications on
    this device until they log in again.

    Body JSON:
        push_token (str) — the token to deactivate
    """
    userid = int(userid_str)

    push_token = (payload.get("push_token") or "").strip()
    if not push_token:
        raise HTTPException(status_code=400, detail="push_token is required")

    try:
        rest_update(
            "user_devices",
            {"userid": userid, "push_token": push_token},
            {"is_active": False},
        )
        logger.info("[devices] token unregistered userid=%s", userid)
        return {"ok": True}
    except Exception as exc:
        logger.error("[devices] unregister token failed userid=%s err=%s", userid, exc)
        raise HTTPException(status_code=500, detail="Failed to unregister device token")

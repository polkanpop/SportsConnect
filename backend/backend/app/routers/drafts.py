"""/api/drafts — Ephemeral form-state cache backed by Redis.

Keeps a user's in-progress booking form alive for 24 hours so that if the
app closes or crashes mid-flow, the note, selected surface, time slot, etc.
are all restored on next open.

Key schema
----------
    draft:{user_id}:{target_type}:{target_id}

    target_type : "court" | "event" | "training"
    target_id   : courtid / eventid / sessionid  (whatever the front-end uses
                  when saving; must match the value used in the booking call)

Security
--------
Users may only read, write, or delete their own drafts.
The userid from the JWT subject is compared against the url path param.

TTL
---
24 hours by default.  Overridable via the ``DRAFT_TTL_SECONDS`` env var.
The bookmark is refreshed to the full TTL on every successful POST.

Auto-deletion
-------------
The /api/bookings/* endpoints call ``_clear_draft_internal`` (imported from
here) as a background task immediately after a successful booking so the user
never sees stale data when they come back to the same form.
"""

from __future__ import annotations

import json
import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..auth import get_current_user

router = APIRouter(prefix="/drafts", tags=["drafts"])

_DRAFT_TTL_SECONDS: int = int(os.getenv("DRAFT_TTL_SECONDS", str(24 * 3600)))
_VALID_TARGET_TYPES: frozenset[str] = frozenset({"court", "event", "training"})


# ── Internal helpers (also used by routers/bookings.py) ──────────────────────

def _draft_key(user_id: int, target_type: str, target_id: int) -> str:
    return f"draft:{user_id}:{target_type}:{target_id}"


def _require_redis(request: Request):
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(
            status_code=503,
            detail="Draft storage unavailable (Redis offline or not initialised)",
        )
    return redis


def _validate_target_type(target_type: str) -> str:
    t = target_type.lower()
    if t not in _VALID_TARGET_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"target_type must be one of {sorted(_VALID_TARGET_TYPES)}",
        )
    return t


def _assert_owner(user_id: int, current_user: str) -> None:
    """Prevent one user from reading / overwriting another user's draft."""
    if str(user_id) != str(current_user):
        raise HTTPException(status_code=403, detail="Cannot access another user's draft")


# ── Request model ─────────────────────────────────────────────────────────────

class DraftBody(BaseModel):
    """Arbitrary JSON form state.  The backend is intentionally schema-less here
    so any future form field is persisted without a backend change."""
    data: dict[str, Any]


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get(
    "/{user_id}/{target_type}/{target_id}",
    response_model=dict,
    summary="Retrieve a saved form draft",
)
async def get_draft(
    user_id: int,
    target_type: str,
    target_id: int,
    request: Request,
    current_user: str = Depends(get_current_user),
):
    """Return the saved draft payload and remaining TTL in seconds.

    Returns ``404`` when no draft exists for this user/target combination.
    The front-end should treat a 404 as an empty form (no draft to restore).
    """
    _validate_target_type(target_type)
    _assert_owner(user_id, current_user)

    redis = _require_redis(request)
    key = _draft_key(user_id, target_type.lower(), target_id)

    raw = await redis.get(key)
    if raw is None:
        raise HTTPException(status_code=404, detail="No draft found for this target")

    ttl = await redis.ttl(key)
    try:
        payload = json.loads(raw)
    except Exception:
        payload = {}

    return {"draft": payload, "ttl_seconds": max(ttl, 0)}


@router.post(
    "/{user_id}/{target_type}/{target_id}",
    response_model=dict,
    summary="Save (or overwrite) a form draft",
)
async def save_draft(
    user_id: int,
    target_type: str,
    target_id: int,
    body: DraftBody,
    request: Request,
    current_user: str = Depends(get_current_user),
):
    """Persist the current form state in Redis for 24 hours.

    Calling this repeatedly resets the TTL to the full 24 hours each time,
    so long in-progress sessions are never silently evicted.

    The ``data`` field accepts any JSON object — the backend stores it
    verbatim and returns it verbatim on ``GET``.
    """
    _validate_target_type(target_type)
    _assert_owner(user_id, current_user)

    redis = _require_redis(request)
    key = _draft_key(user_id, target_type.lower(), target_id)

    await redis.set(key, json.dumps(body.data), ex=_DRAFT_TTL_SECONDS)

    return {"ok": True, "ttl_seconds": _DRAFT_TTL_SECONDS}


@router.delete(
    "/{user_id}/{target_type}/{target_id}",
    response_model=dict,
    summary="Delete a form draft",
)
async def delete_draft(
    user_id: int,
    target_type: str,
    target_id: int,
    request: Request,
    current_user: str = Depends(get_current_user),
):
    """Explicitly clear a saved draft.

    This is called automatically by the /api/bookings/* endpoints on a
    successful booking so the user never sees stale data.  The front-end may
    also call it directly (e.g. on cancel / form reset).

    Always returns ``{"ok": true}`` — a missing draft is not an error.
    """
    _validate_target_type(target_type)
    _assert_owner(user_id, current_user)

    redis = _require_redis(request)
    key = _draft_key(user_id, target_type.lower(), target_id)
    await redis.delete(key)

    return {"ok": True}

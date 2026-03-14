"""/api/bookings — Race-safe booking endpoints backed by PostgreSQL RPCs.

These three POST endpoints replace the direct-insert logic for *create*
operations.  Each one calls a stored procedure that holds a ``FOR UPDATE``
row lock for the duration of the transaction, preventing:
  - double-booking of the same court slot
  - overbooking of events / training sessions

Read / list / update operations remain in the original routers:
  courtbookings · eventbookings · tsbookings

Error code → HTTP mapping
  P0010  slot not found              → 404
  P0011  slot already taken          → 409
  P0020  event not found             → 404
  P0021  event not joinable          → 409
  P0022  event closed                → 409
  P0023  event full                  → 409
  P0024  already joined event        → 409
  P0025  event info missing          → 500
  P0030  session not found           → 404
  P0031  session not joinable        → 409
  P0032  session closed              → 409
  P0033  session full                → 409
  P0034  already joined session      → 409
  P0035  session info missing        → 500
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..auth import get_current_user
from ..cache_utils import invalidate_namespace
from ..db import RpcError, rest_rpc
from ..notifications_service import create_notification

router = APIRouter(prefix="/bookings", tags=["bookings"])


# ── Domain error → HTTP status mapping ───────────────────────────────────────

_NOT_FOUND_CODES = {"P0010", "P0020", "P0030"}
_CONFLICT_CODES  = {"P0011", "P0021", "P0022", "P0023", "P0024", "P0031", "P0032", "P0033", "P0034"}
_SERVER_CODES    = {"P0025", "P0035"}


def _http_from_rpc(e: RpcError) -> HTTPException:
    if e.code in _NOT_FOUND_CODES:
        return HTTPException(status_code=404, detail=e.message)
    if e.code in _CONFLICT_CODES:
        return HTTPException(status_code=409, detail=e.message)
    if e.code in _SERVER_CODES:
        return HTTPException(status_code=500, detail=e.message)
    return HTTPException(status_code=400, detail=e.message)


# ── Draft cleanup helper ──────────────────────────────────────────────────────

async def _delete_draft(
    request: Request,
    user_id: int,
    target_type: str,
    target_id: int,
) -> None:
    """Best-effort draft deletion after a successful booking.

    never raises — a missing draft or an offline Redis are both fine.
    """
    try:
        redis = getattr(request.app.state, "redis", None)
        if redis is None:
            return
        await redis.delete(f"draft:{user_id}:{target_type}:{target_id}")
    except Exception:
        pass


# ── Request models ─────────────────────────────────────────────────────────

class CourtBookingIn(BaseModel):
    userid: int
    availabilityid: int
    start_timestamp: str  # ISO-8601, passed straight through to Postgres
    end_timestamp: str
    bookingdate: str      # YYYY-MM-DD
    playingcourtid: Optional[int] = None
    selected_court_name: Optional[str] = None
    selected_base_name: Optional[str] = None
    selected_part: Optional[str] = Field(
        None,
        pattern=r"^(full|half_a|half_b)$",
        description="'full', 'half_a', or 'half_b'",
    )
    selected_surface: Optional[str] = None
    court_price_at_booking: Optional[float] = None
    duration_minutes: Optional[int] = Field(None, ge=60, le=180)
    total_amount: Optional[float] = None
    note: Optional[str] = None


class EventBookingIn(BaseModel):
    userid: int
    eventid: int
    paymentid: Optional[int] = None
    note: Optional[str] = None


class TrainingBookingIn(BaseModel):
    userid: int
    sessionid: int
    paymentid: Optional[int] = None
    note: Optional[str] = None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/court", response_model=dict, summary="Create a court booking (race-safe)")
async def create_court_booking(
    body: CourtBookingIn,
    request: Request,
    background_tasks: BackgroundTasks,
    current_user: str = Depends(get_current_user),
):
    """Call ``rpc_create_court_booking`` to atomically lock the availability slot,
    validate it is still open, and insert the booking — all inside one PG transaction.

    On success, invalidates the ``courtbookings`` and ``courtavailability`` cache
    namespaces and removes any saved form draft for this user/slot.
    """
    try:
        result = rest_rpc(
            "rpc_create_court_booking",
            {
                "p_availabilityid":         body.availabilityid,
                "p_userid":                 body.userid,
                "p_start_timestamp":        body.start_timestamp,
                "p_end_timestamp":          body.end_timestamp,
                "p_bookingdate":            body.bookingdate,
                "p_playingcourtid":         body.playingcourtid,
                "p_selected_court_name":    body.selected_court_name,
                "p_selected_base_name":     body.selected_base_name,
                "p_selected_part":          body.selected_part,
                "p_selected_surface":       body.selected_surface,
                "p_court_price_at_booking": body.court_price_at_booking,
                "p_duration_minutes":       body.duration_minutes,
                "p_total_amount":           body.total_amount,
                "p_note":                   body.note,
            },
        )
    except RpcError as e:
        raise _http_from_rpc(e)

    row = result[0] if isinstance(result, list) and result else {}

    # Cache invalidation + draft cleanup (best-effort, non-blocking)
    background_tasks.add_task(invalidate_namespace, "courtbookings", "courtavailability")
    background_tasks.add_task(_delete_draft, request, body.userid, "court", body.availabilityid)

    return row


@router.post("/event", response_model=dict, summary="Join an event (race-safe)")
async def join_event(
    body: EventBookingIn,
    request: Request,
    background_tasks: BackgroundTasks,
    current_user: str = Depends(get_current_user),
):
    """Call ``rpc_join_event`` to lock the event row, verify capacity against
    ``eventinfo.participants_cap``, prevent duplicate bookings, and insert.

    Returns ``{out_eventbookingid, out_booking_status}`` on success.
    """
    try:
        result = rest_rpc(
            "rpc_join_event",
            {
                "p_eventid":   body.eventid,
                "p_userid":    body.userid,
                "p_paymentid": body.paymentid,
                "p_note":      body.note,
            },
        )
    except RpcError as e:
        raise _http_from_rpc(e)

    row = result[0] if isinstance(result, list) and result else {}

    background_tasks.add_task(invalidate_namespace, "eventbookings", "events", "eventinfo")
    background_tasks.add_task(_delete_draft, request, body.userid, "event", body.eventid)

    return row


@router.post("/training", response_model=dict, summary="Join a training session (race-safe)")
async def join_training_session(
    body: TrainingBookingIn,
    request: Request,
    background_tasks: BackgroundTasks,
    current_user: str = Depends(get_current_user),
):
    """Call ``rpc_join_training_session`` to lock the session row, verify capacity
    against ``trainingsessioninfo.participants_cap``, prevent duplicates, and insert.

    Returns ``{out_tsbookingid, out_booking_status}`` on success.
    """
    try:
        result = rest_rpc(
            "rpc_join_training_session",
            {
                "p_sessionid": body.sessionid,
                "p_userid":    body.userid,
                "p_paymentid": body.paymentid,
                "p_note":      body.note,
            },
        )
    except RpcError as e:
        raise _http_from_rpc(e)

    row = result[0] if isinstance(result, list) and result else {}

    background_tasks.add_task(invalidate_namespace, "tsbookings", "trainingsessions", "trainingsessioninfo")
    background_tasks.add_task(_delete_draft, request, body.userid, "training", body.sessionid)

    return row

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Depends, Request
from fastapi_cache.decorator import cache
from ..db import rest_select, rest_upsert, rest_update, rest_insert
from ..auth import get_current_user
from ..cache_utils import invalidate_namespace, make_key_builder
from ..notifications_service import create_notification
from typing import Any

router = APIRouter(prefix="/tsbookings", tags=["training"])

PRIMARY_KEY = "tsbookingid"


async def _invalidate_user_dashboard_cache(app: Any, userid: int) -> None:
    """Delete the dashboard Redis cache so the next fetch returns fresh data."""
    redis = getattr(app.state, "redis", None)
    if redis is None:
        return
    await redis.delete(f"sportsconnect:me:dashboard:v2:userid={userid}")


def _sync_ts_participant_count(sessionid: int) -> None:
    """Recompute trainingsessioninfo.numberofpeople from joined bookings.
    Mirrors _sync_event_participant_count in eventbookings.py."""
    joined_rows = rest_select(
        "tsbookings",
        "tsbookingid",
        filters={"sessionid": sessionid, "status": "joined"},
    )
    joined_count = len(joined_rows) if isinstance(joined_rows, list) else 0
    rest_update("trainingsessioninfo", {"sessionid": sessionid}, {"numberofpeople": joined_count})

@router.get("", response_model=list[dict])
@cache(expire=30, key_builder=make_key_builder("tsbookings"))
def list_ts_bookings(sessionid: int | None = Query(None), userid: int | None = Query(None), status: str | None = Query(None), limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
    try:
        filters: dict[str, int | str] = {}
        if sessionid is not None:
            filters["sessionid"] = sessionid
        if userid is not None:
            filters["userid"] = userid
        if status is not None:
            filters["status"] = status
        data = rest_select("tsbookings", "*", filters=filters or None, order={"column": PRIMARY_KEY})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{tsbookingid}", response_model=dict)
@cache(expire=30, key_builder=make_key_builder("tsbookings"))
def get_ts_booking(tsbookingid: int):
    try:
        row = rest_select("tsbookings", "*", filters={PRIMARY_KEY: tsbookingid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Training session booking not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_ts_booking(body: dict, request: Request, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
    """Create a training session booking. Inject userid from auth if not provided."""
    try:
        userid_raw = body.get("userid") or current_user
        try:
            userid = int(userid_raw)
        except Exception:
            raise HTTPException(status_code=400, detail="userid must be numeric")

        sessionid = body.get("sessionid")
        if sessionid is None:
            raise HTTPException(status_code=422, detail="sessionid required")
        try:
            sessionid = int(sessionid)
        except Exception:
            raise HTTPException(status_code=400, detail="sessionid must be numeric")

        sess = rest_select("trainingsessions", "sessionid,status", filters={"sessionid": sessionid}, single=True)
        if not sess:
            raise HTTPException(status_code=404, detail="Training session not found")
        status = str(sess.get("status") or "").lower()
        if "cancel" in status:
            raise HTTPException(status_code=409, detail="Training session was cancelled")

        # Join controls live in trainingsessioninfo
        info = rest_select("trainingsessioninfo", "*", filters={"sessionid": sessionid}, single=True)
        if info and info.get("join_status") is False:
            raise HTTPException(status_code=409, detail="Training session is not accepting participants")
        auto_approve_val = info.get("auto_approve") if isinstance(info, dict) else False
        should_auto = bool(auto_approve_val) if isinstance(auto_approve_val, bool) else str(auto_approve_val).lower() in {"1", "true", "yes", "y", "on"}
        desired_status = "joined" if should_auto else "pending"

        existing = rest_select("tsbookings", "tsbookingid,bookingstatus,status", filters={"userid": userid, "sessionid": sessionid})
        if isinstance(existing, list):
            for row in existing:
                s = str(row.get("bookingstatus") or row.get("status") or "").lower()
                if "cancel" not in s:
                    raise HTTPException(status_code=409, detail="Already booked")

        payload = {**body, "userid": userid, "sessionid": sessionid}
        payload["status"] = desired_status
        if "bookingstatus" not in payload:
            payload["bookingstatus"] = "upcoming"
        try:
            resp = rest_insert("tsbookings", payload)
        except Exception:
            resp = rest_upsert("tsbookings", payload)

        if desired_status == "joined":
            try:
                _sync_ts_participant_count(sessionid)
            except Exception as e:
                print("[tsbookings] failed to sync numberofpeople on create:", str(e))

        # Notifications (best-effort)
        try:
            booking_row = resp[0] if isinstance(resp, list) and resp else None
            booking_id = int((booking_row or {}).get(PRIMARY_KEY) or 0) or None
            create_notification(
                userid=userid,
                category="training",
                notificationtype="tsbooking",
                kind="approved" if desired_status == "joined" else "submitted",
                notificationtypeid=booking_id or sessionid,
                title="Training booking confirmed" if desired_status == "joined" else "Training booking submitted",
                message="Your training booking is confirmed." if desired_status == "joined" else "Your training booking is pending approval.",
                data={"sessionid": sessionid, "tsbookingid": booking_id, "status": desired_status},
            )

            sess = rest_select("trainingsessions", "sessionid,coachid", filters={"sessionid": sessionid}, single=True)
            coachid = int(sess.get("coachid")) if isinstance(sess, dict) and sess.get("coachid") is not None else None
            if coachid is not None and coachid != userid:
                create_notification(
                    userid=coachid,
                    category="training",
                    notificationtype="tsbooking",
                    kind="incoming_booking",
                    notificationtypeid=booking_id or sessionid,
                    title="New training booking",
                    message="Someone requested to join your training session.",
                    data={"sessionid": sessionid, "tsbookingid": booking_id, "booker_userid": userid, "status": desired_status},
                )
        except Exception as e:
            print("[tsbookings] notification insert failed:", str(e))

        background_tasks.add_task(invalidate_namespace, "tsbookings", "trainingsessioninfo")
        # Bust the booker's dashboard Redis cache so Activity shows the booking immediately on pull-to-refresh.
        background_tasks.add_task(_invalidate_user_dashboard_cache, request.app, userid)
        try:
            _sess = rest_select("trainingsessions", "sessionid,coachid", filters={"sessionid": sessionid}, single=True)
            _coachid = int(_sess.get("coachid")) if isinstance(_sess, dict) and _sess.get("coachid") is not None else None
            if _coachid is not None and _coachid != userid:
                background_tasks.add_task(_invalidate_user_dashboard_cache, request.app, _coachid)
        except Exception:
            pass
        return resp[0] if isinstance(resp, list) and resp else payload
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/{tsbookingid}", response_model=dict)
def update_ts_booking(tsbookingid: int, body: dict, request: Request, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
    """Patch fields on a training session booking.

    Used by the mobile app to cancel an upcoming training booking by setting bookingstatus/status.
    """
    try:
        existing = rest_select("tsbookings", "tsbookingid, userid, sessionid, status", filters={PRIMARY_KEY: tsbookingid}, single=True)
        if not existing:
            raise HTTPException(status_code=404, detail="Training session booking not found")

        auth_userid: int | None
        try:
            auth_userid = int(current_user)
        except Exception:
            auth_userid = None

        is_owner = auth_userid is not None and int(existing.get("userid")) == auth_userid
        is_coach = False
        if not is_owner and auth_userid is not None:
            try:
                sess = rest_select("trainingsessions", "sessionid,coachid", filters={"sessionid": int(existing.get("sessionid"))}, single=True)
                if sess and int(sess.get("coachid")) == auth_userid:
                    is_coach = True
            except Exception:
                is_coach = False

        if not (is_owner or is_coach):
            raise HTTPException(status_code=403, detail="Not allowed to update this training booking")

        payload = dict(body or {})
        payload.pop(PRIMARY_KEY, None)
        if not payload:
            raise HTTPException(status_code=422, detail="No fields to update")

        prev_status = str(existing.get("status") or "")
        # Coach moderation: limit surface area.
        if is_coach and not is_owner:
            payload = {k: v for k, v in payload.items() if k in {"status", "bookingstatus"}}
            if not payload:
                raise HTTPException(status_code=422, detail="No fields to update")

        resp = rest_update("tsbookings", {PRIMARY_KEY: tsbookingid}, payload)

        if "status" in payload:
            try:
                _sync_ts_participant_count(int(existing.get("sessionid")))
            except Exception as e:
                print("[tsbookings] failed to sync numberofpeople:", str(e))

        # Coach moderation notifications (best-effort)
        try:
            if "status" in payload and is_coach:
                new_status = str(payload.get("status") or "")
                if new_status and new_status.lower() != prev_status.lower():
                    booker_userid = int(existing.get("userid"))
                    if new_status.lower() == "joined":
                        create_notification(
                            userid=booker_userid,
                            category="training",
                            notificationtype="tsbooking",
                            kind="approved",
                            notificationtypeid=int(tsbookingid),
                            title="Training booking approved",
                            message="Your training booking has been approved.",
                            data={"sessionid": int(existing.get("sessionid")), "tsbookingid": int(tsbookingid), "status": new_status},
                        )
                    elif new_status.lower() == "rejected":
                        create_notification(
                            userid=booker_userid,
                            category="training",
                            notificationtype="tsbooking",
                            kind="rejected",
                            notificationtypeid=int(tsbookingid),
                            title="Training booking rejected",
                            message="Your training booking was rejected.",
                            data={"sessionid": int(existing.get("sessionid")), "tsbookingid": int(tsbookingid), "status": new_status},
                        )
        except Exception as e:
            print("[tsbookings] notification update failed:", str(e))

        background_tasks.add_task(invalidate_namespace, "tsbookings", "trainingsessioninfo")
        # Bust the booker's dashboard Redis cache so Activity reflects status change (joined/cancelled) immediately.
        try:
            background_tasks.add_task(_invalidate_user_dashboard_cache, request.app, int(existing.get("userid")))
        except Exception:
            pass
        if isinstance(resp, list) and resp:
            return resp[0]
        return payload
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

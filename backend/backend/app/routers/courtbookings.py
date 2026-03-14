from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Depends
from fastapi_cache.decorator import cache
from ..db import rest_select, rest_insert, rest_update
from ..auth import get_current_user
from ..cache_utils import invalidate_namespace, make_key_builder
from ..notifications_service import create_notification
from datetime import datetime

router = APIRouter(prefix="/courtbookings", tags=["bookings"])  # Route keeps plural for consistency, underlying table is singular

PRIMARY_KEY = "courtbookingid"


def _to_int(v):
    try:
        return int(v)
    except Exception:
        return None


def _enrich_court_bookings(rows: list[dict]) -> list[dict]:
    if not isinstance(rows, list) or not rows:
        return []

    all_availability = rest_select("courtavailability", "availabilityid,courtid")
    courtid_by_availabilityid: dict[int, int] = {}
    for av in (all_availability if isinstance(all_availability, list) else []):
        aid = _to_int(av.get("availabilityid"))
        cid = _to_int(av.get("courtid"))
        if aid is not None and cid is not None:
            courtid_by_availabilityid[aid] = cid

    all_courts = rest_select("courts", "courtid,courtinfo")
    court_name_by_courtid: dict[int, str] = {}
    for c in (all_courts if isinstance(all_courts, list) else []):
        cid = _to_int(c.get("courtid"))
        name = c.get("courtinfo")
        if cid is not None and isinstance(name, str) and name.strip():
            court_name_by_courtid[cid] = name.strip()

    all_events = rest_select("events", "eventid,courtbookingid,time,status,organizerid")
    events_by_cbid: dict[int, list[dict]] = {}
    for ev in (all_events if isinstance(all_events, list) else []):
        cbid = _to_int(ev.get("courtbookingid"))
        if cbid is not None:
            events_by_cbid.setdefault(cbid, []).append(ev)

    all_sessions = rest_select("trainingsessions", "sessionid,courtbookingid,time,status,coachid")
    sessions_by_cbid: dict[int, list[dict]] = {}
    for ts in (all_sessions if isinstance(all_sessions, list) else []):
        cbid = _to_int(ts.get("courtbookingid"))
        if cbid is not None:
            sessions_by_cbid.setdefault(cbid, []).append(ts)

    out: list[dict] = []
    for row in rows:
        aid = _to_int(row.get("availabilityid"))
        cbid = _to_int(row.get(PRIMARY_KEY))
        courtid = courtid_by_availabilityid.get(aid) if aid is not None else None
        court_name = court_name_by_courtid.get(courtid) if courtid is not None else None
        out.append({
            **row,
            "courtid": courtid,
            "court_name": court_name,
            "linked_events": events_by_cbid.get(cbid or -1, []),
            "linked_trainingsessions": sessions_by_cbid.get(cbid or -1, []),
        })
    return out

@router.get("", response_model=list[dict])
@cache(expire=120, key_builder=make_key_builder("courtbookings"))
def list_court_bookings(userid: int | None = Query(None), courtid: int | None = Query(None), status: str | None = Query(None), limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    try:
        # If courtid provided, resolve bookings through playingcourt -> courtavailability -> courtbooking
        if courtid is not None:
            pc_rows = rest_select("playingcourt", "playingcourtid", filters={"courtid": courtid})
            pc_ids = [int(r["playingcourtid"]) for r in (pc_rows if isinstance(pc_rows, list) else []) if r.get("playingcourtid") is not None]
            all_bookings: list[dict] = []
            for pcid in pc_ids:
                av_rows = rest_select("courtavailability", "availabilityid", filters={"playingcourtid": pcid})
                av_ids = [int(r["availabilityid"]) for r in (av_rows if isinstance(av_rows, list) else []) if r.get("availabilityid") is not None]
                for avid in av_ids:
                    b_filters: dict = {"availabilityid": avid}
                    if status is not None:
                        b_filters["status"] = status
                    bookings = rest_select("courtbooking", "*", filters=b_filters, order={"column": PRIMARY_KEY})
                    if isinstance(bookings, list):
                        all_bookings.extend(bookings)
            all_bookings.sort(key=lambda r: int(r.get(PRIMARY_KEY) or 0))
            return _enrich_court_bookings(all_bookings[offset: offset + limit])
        filters = {}
        if userid is not None:
            filters["userid"] = userid
        if status is not None:
            filters["status"] = status
        # Table name in schema is singular 'courtbooking'
        data = rest_select("courtbooking", "*", filters=filters or None, order={"column": PRIMARY_KEY})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return _enrich_court_bookings(data if isinstance(data, list) else [])
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{courtbookingid}", response_model=dict)
@cache(expire=120, key_builder=make_key_builder("courtbookings"))
def get_court_booking(courtbookingid: int):
    try:
        row = rest_select("courtbooking", "*", filters={PRIMARY_KEY: courtbookingid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Court booking not found")
        return (_enrich_court_bookings([row])[0]) if isinstance(row, dict) else row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_court_booking(body: dict, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
    """Create a court booking.

    Relaxed logic:
      - Multiple bookings per user allowed.
      - Accepts numeric `userid` from body; if missing attempts to coerce auth subject.
      - Does NOT block when token subject differs from provided userid (diagnostic print only).
      - Optional `note` field persisted.
    """
    try:
        auth_sub = current_user
        supplied_userid = body.get("userid")
        final_userid = None
        if supplied_userid is not None:
            # Require numeric
            if not isinstance(supplied_userid, int):
                try:
                    supplied_userid = int(str(supplied_userid))
                except ValueError:
                    raise HTTPException(status_code=400, detail="userid must be numeric")
            final_userid = supplied_userid
        else:
            # Coerce auth subject to int if possible
            try:
                final_userid = int(auth_sub)
            except ValueError:
                raise HTTPException(status_code=400, detail="Provide numeric userid in body; token subject is not numeric")

        payload = { **body, "userid": final_userid }
        if "note" in body:
            payload["note"] = body.get("note")

        # Normalize new optional booking detail columns.
        def _to_int_or_none(v):
            if v is None or v == "":
                return None
            try:
                return int(v)
            except Exception:
                return None

        def _to_float_or_none(v):
            if v is None or v == "":
                return None
            try:
                return float(v)
            except Exception:
                return None

        part = payload.get("selected_part")
        if isinstance(part, str):
            part = part.strip().lower()
            if part not in {"full", "half_a", "half_b"}:
                raise HTTPException(status_code=400, detail="selected_part must be full, half_a, or half_b")
            payload["selected_part"] = part

        playingcourtid = _to_int_or_none(payload.get("playingcourtid"))
        payload["playingcourtid"] = playingcourtid

        duration = _to_int_or_none(payload.get("duration_minutes"))
        if duration is None:
            start_ts = payload.get("start_timestamp")
            end_ts = payload.get("end_timestamp")
            if isinstance(start_ts, str) and isinstance(end_ts, str):
                try:
                    s = datetime.fromisoformat(start_ts.replace(" ", "T"))
                    e = datetime.fromisoformat(end_ts.replace(" ", "T"))
                    mins = int((e - s).total_seconds() // 60)
                    if mins > 0:
                        duration = mins
                except Exception:
                    pass
        payload["duration_minutes"] = duration

        payload["court_price_at_booking"] = _to_float_or_none(payload.get("court_price_at_booking"))
        payload["total_amount"] = _to_float_or_none(payload.get("total_amount"))

        # Auto-fill selected_* fields from playingcourt when frontend omits them.
        if playingcourtid is not None:
            pc = rest_select(
                "playingcourt",
                "name,base_name,part,surface,price",
                filters={"playingcourtid": playingcourtid},
                single=True,
            )
            if isinstance(pc, dict):
                if not payload.get("selected_court_name"):
                    payload["selected_court_name"] = pc.get("name")
                if not payload.get("selected_base_name"):
                    payload["selected_base_name"] = pc.get("base_name")
                if not payload.get("selected_part"):
                    payload["selected_part"] = pc.get("part")
                if not payload.get("selected_surface"):
                    payload["selected_surface"] = pc.get("surface")
                if payload.get("court_price_at_booking") is None:
                    payload["court_price_at_booking"] = _to_float_or_none(pc.get("price"))

        # Booking approval policy:
        # - default: pending
        # - if venue auto_approve is true: approved/booked
        auto_approve = False
        courtid: int | None = None
        try:
            availabilityid = payload.get("availabilityid")
            av = rest_select("courtavailability", "courtid", filters={"availabilityid": availabilityid}, single=True)
            courtid = int(av.get("courtid")) if isinstance(av, dict) and av.get("courtid") is not None else None
            if courtid is not None:
                ci = rest_select("courtinfo", "auto_approve", filters={"courtid": courtid}, single=True)
                if isinstance(ci, dict):
                    auto_approve = bool(ci.get("auto_approve"))
        except Exception:
            auto_approve = False

        payload["status"] = "approved" if auto_approve else "pending"
        payload["bookingstatus"] = "upcoming"

        print(f"[create_court_booking] auth_sub={auth_sub} supplied_userid={supplied_userid} final_userid={final_userid} availabilityid={payload.get('availabilityid')}")

        resp = rest_insert("courtbooking", payload)
        if not isinstance(resp, list) or not resp:
            raise HTTPException(status_code=500, detail="Insert did not return representation; check Supabase headers/policies")
        row = resp[0]
        if PRIMARY_KEY not in row:
            raise HTTPException(status_code=500, detail="Insert succeeded but missing primary key in response")

        # Notifications (best-effort; never block booking creation)
        try:
            booking_id = int(row.get(PRIMARY_KEY))
            base_name = payload.get("selected_base_name") or payload.get("selected_court_name") or "Court"

            # Booker notification
            if auto_approve:
                create_notification(
                    userid=final_userid,
                    category="court",
                    notificationtype="courtbooking",
                    kind="approved",
                    notificationtypeid=booking_id,
                    title="Booking confirmed",
                    message=f"Your booking for {base_name} has been approved.",
                    data={"courtbookingid": booking_id, "courtid": courtid, "base_name": base_name},
                )
            else:
                create_notification(
                    userid=final_userid,
                    category="court",
                    notificationtype="courtbooking",
                    kind="submitted",
                    notificationtypeid=booking_id,
                    title="Booking submitted",
                    message=f"Your booking for {base_name} is pending approval.",
                    data={"courtbookingid": booking_id, "courtid": courtid, "base_name": base_name},
                )

            # Owner notification (incoming booking)
            if courtid is not None:
                court = rest_select("courts", "courtid,ownerid", filters={"courtid": courtid}, single=True)
                ownerid = int(court.get("ownerid")) if isinstance(court, dict) and court.get("ownerid") is not None else None
                if ownerid is not None and ownerid != final_userid:
                    create_notification(
                        userid=ownerid,
                        category="court",
                        notificationtype="courtbooking",
                        kind="incoming_booking",
                        notificationtypeid=booking_id,
                        title="New booking request",
                        message=f"A user requested to book {base_name}.",
                        data={"courtbookingid": booking_id, "courtid": courtid, "base_name": base_name, "booker_userid": final_userid},
                    )
        except Exception as e:
            print("[courtbookings] notification insert failed:", str(e))

        background_tasks.add_task(invalidate_namespace, "courtbookings")
        return row
    except HTTPException:
        raise
    except RuntimeError as e:
        if "409" in str(e):
            raise HTTPException(status_code=409, detail="Duplicate primary key on insert; sequence likely misaligned")
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/{courtbookingid}", response_model=dict)
def update_court_booking(courtbookingid: int, body: dict, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
    """Patch fields on a court booking.

    Used by the mobile app to cancel an upcoming booking by setting bookingstatus/status.
    """
    try:
        existing = rest_select("courtbooking", "courtbookingid, userid, status, availabilityid", filters={PRIMARY_KEY: courtbookingid}, single=True)
        if not existing:
            raise HTTPException(status_code=404, detail="Court booking not found")

        # Ownership check:
        # - booking owner may patch
        # - court owner may approve/reject
        auth_userid: int | None
        try:
            auth_userid = int(current_user)
        except Exception:
            auth_userid = None

        is_booking_owner = auth_userid is not None and int(existing.get("userid")) == auth_userid
        is_court_owner = False
        courtid: int | None = None
        if not is_booking_owner and auth_userid is not None:
            try:
                av_id = existing.get("availabilityid")
                av = rest_select("courtavailability", "courtid", filters={"availabilityid": av_id}, single=True)
                courtid = int(av.get("courtid")) if isinstance(av, dict) and av.get("courtid") is not None else None
                if courtid is not None:
                    c = rest_select("courts", "courtid,ownerid", filters={"courtid": courtid}, single=True)
                    ownerid = int(c.get("ownerid")) if isinstance(c, dict) and c.get("ownerid") is not None else None
                    if ownerid is not None and ownerid == auth_userid:
                        is_court_owner = True
            except Exception:
                is_court_owner = False

        if not (is_booking_owner or is_court_owner):
            raise HTTPException(status_code=403, detail="Not allowed to update this court booking")

        payload = dict(body or {})
        payload.pop(PRIMARY_KEY, None)
        if not payload:
            raise HTTPException(status_code=422, detail="No fields to update")

        # Hard guard: you cannot cancel a court booking while an upcoming event or training session
        # still references this courtbookingid.
        bookingstatus = payload.get("bookingstatus")
        if isinstance(bookingstatus, str) and bookingstatus.strip().lower() == "cancelled":
            def is_blocking_status(s: object) -> bool:
                st = str(s or "").strip().lower()
                if not st:
                    return True
                return ("cancel" not in st) and ("complete" not in st)

            # Check events
            evs = rest_select("events", "eventid,status,time", filters={"courtbookingid": courtbookingid})
            if isinstance(evs, list):
                for ev in evs:
                    if not isinstance(ev, dict):
                        continue
                    if is_blocking_status(ev.get("status")):
                        raise HTTPException(status_code=409, detail="You must cancel the event first.")

            # Check training sessions
            ses = rest_select("trainingsessions", "sessionid,status,time", filters={"courtbookingid": courtbookingid})
            if isinstance(ses, list):
                for s in ses:
                    if not isinstance(s, dict):
                        continue
                    if is_blocking_status(s.get("status")):
                        raise HTTPException(status_code=409, detail="You must cancel the training session first.")

        prev_status = str(existing.get("status") or "")
        resp = rest_update("courtbooking", {PRIMARY_KEY: courtbookingid}, payload)
        row = resp[0] if isinstance(resp, list) and resp else {**existing, **payload}

        # Notifications for approval/rejection (best-effort)
        try:
            if "status" in payload and is_court_owner:
                new_status = str(payload.get("status") or "")
                if new_status and new_status.lower() != prev_status.lower():
                    booker_userid = int(existing.get("userid"))
                    base_name = row.get("selected_base_name") or row.get("selected_court_name") or "Court"
                    if new_status.lower() == "approved":
                        create_notification(
                            userid=booker_userid,
                            category="court",
                            notificationtype="courtbooking",
                            kind="approved",
                            notificationtypeid=int(courtbookingid),
                            title="Booking approved",
                            message=f"Your booking for {base_name} has been approved.",
                            data={"courtbookingid": int(courtbookingid), "courtid": courtid, "base_name": base_name},
                        )
                    elif new_status.lower() == "rejected":
                        create_notification(
                            userid=booker_userid,
                            category="court",
                            notificationtype="courtbooking",
                            kind="rejected",
                            notificationtypeid=int(courtbookingid),
                            title="Booking rejected",
                            message=f"Your booking for {base_name} was rejected.",
                            data={"courtbookingid": int(courtbookingid), "courtid": courtid, "base_name": base_name},
                        )
        except Exception as e:
            print("[courtbookings] notification update failed:", str(e))

        background_tasks.add_task(invalidate_namespace, "courtbookings")
        return row
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
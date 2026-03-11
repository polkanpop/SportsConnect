from fastapi import APIRouter, HTTPException, Query, Depends
from ..db import rest_select, rest_insert, rest_update
from ..auth import get_current_user
from datetime import datetime

router = APIRouter(prefix="/courtbookings", tags=["bookings"])  # Route keeps plural for consistency, underlying table is singular

PRIMARY_KEY = "courtbookingid"

@router.get("", response_model=list[dict])
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
            return all_bookings[offset: offset + limit]
        filters = {}
        if userid is not None:
            filters["userid"] = userid
        if status is not None:
            filters["status"] = status
        # Table name in schema is singular 'courtbooking'
        data = rest_select("courtbooking", "*", filters=filters or None, order={"column": PRIMARY_KEY})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{courtbookingid}", response_model=dict)
def get_court_booking(courtbookingid: int):
    try:
        row = rest_select("courtbooking", "*", filters={PRIMARY_KEY: courtbookingid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Court booking not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_court_booking(body: dict, current_user: str = Depends(get_current_user)):
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
        return row
    except HTTPException:
        raise
    except RuntimeError as e:
        if "409" in str(e):
            raise HTTPException(status_code=409, detail="Duplicate primary key on insert; sequence likely misaligned")
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/{courtbookingid}", response_model=dict)
def update_court_booking(courtbookingid: int, body: dict, current_user: str = Depends(get_current_user)):
    """Patch fields on a court booking.

    Used by the mobile app to cancel an upcoming booking by setting bookingstatus/status.
    """
    try:
        existing = rest_select("courtbooking", "courtbookingid, userid", filters={PRIMARY_KEY: courtbookingid}, single=True)
        if not existing:
            raise HTTPException(status_code=404, detail="Court booking not found")

        # Best-effort ownership check when auth subject is numeric.
        try:
            auth_userid = int(current_user)
            if int(existing.get("userid")) != auth_userid:
                raise HTTPException(status_code=403, detail="User does not own this court booking")
        except ValueError:
            pass

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

        resp = rest_update("courtbooking", {PRIMARY_KEY: courtbookingid}, payload)
        if isinstance(resp, list) and resp:
            return resp[0]
        return payload
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
import asyncio
import logging
import os
import time
from typing import Any

import orjson
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from ..db import rest_select, rest_insert, rest_update
from ..auth import get_current_user
from ..cache_utils import invalidate_namespace
from ..notifications_service import create_notification
from datetime import datetime

router = APIRouter(prefix="/courtbookings", tags=["bookings"])  # Route keeps plural for consistency, underlying table is singular
logger = logging.getLogger("courtbookings")

PRIMARY_KEY = "courtbookingid"
_CACHE_FRESH_SECONDS = int(os.getenv("COURTBOOKINGS_CACHE_FRESH_SECONDS", "60"))
_CACHE_STALE_SECONDS = int(os.getenv("COURTBOOKINGS_CACHE_STALE_SECONDS", "240"))
_CACHE_HARD_SECONDS = _CACHE_FRESH_SECONDS + _CACHE_STALE_SECONDS
_REFRESH_LOCK_SECONDS = int(os.getenv("COURTBOOKINGS_REFRESH_LOCK_SECONDS", "30"))


def _to_int(v):
    try:
        return int(v)
    except Exception:
        return None


def _parse_ts(value: Any) -> datetime | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace(" ", "T").replace("Z", "+00:00"))
    except Exception:
        return None


def _first_list_or_obj(v: Any) -> dict[str, Any] | None:
    if isinstance(v, list):
        if v and isinstance(v[0], dict):
            return v[0]
        return None
    if isinstance(v, dict):
        return v
    return None


def _cache_list_key(*, userid: int | None, courtid: int | None, status: str | None, limit: int, offset: int) -> str:
    return (
        "sportsconnect:courtbookings:list:"
        f"userid={userid if userid is not None else 'all'}:"
        f"courtid={courtid if courtid is not None else 'all'}:"
        f"status={status if status else 'all'}:"
        f"limit={limit}:offset={offset}"
    )


def _cache_by_id_key(courtbookingid: int) -> str:
    return f"sportsconnect:courtbookings:id:{courtbookingid}"


def _refresh_lock_key(cache_key: str) -> str:
    return f"{cache_key}:refresh-lock"


def _pack_cached_payload(payload: Any) -> bytes:
    return orjson.dumps({"cached_at": time.time(), "data": payload})


def _unpack_cached_payload(raw: bytes | str) -> tuple[Any | None, float | None]:
    parsed = orjson.loads(raw)
    if not isinstance(parsed, dict):
        return None, None
    try:
        age_seconds = max(0.0, time.time() - float(parsed.get("cached_at")))
    except Exception:
        age_seconds = None
    return parsed.get("data"), age_seconds


async def _invalidate_courtbookings_swr_cache(request: Request) -> None:
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        return
    async for key in redis.scan_iter(match="sportsconnect:courtbookings:*", count=100):
        await redis.delete(key)


async def _invalidate_user_dashboard_cache(app: Any, userid: int) -> None:
    """Delete the dashboard SWR cache entry for a user so the next request fetches fresh data."""
    redis = getattr(app.state, "redis", None)
    if redis is None:
        return
    cache_key = f"sportsconnect:me:dashboard:v2:userid={userid}"
    await redis.delete(cache_key)


def _schedule_background_refresh(coro: Any) -> None:
    task = asyncio.create_task(coro)

    def _on_done(done: asyncio.Task) -> None:
        try:
            done.result()
        except Exception as exc:
            logger.warning("courtbookings_background_refresh_failed err=%s", exc)

    task.add_done_callback(_on_done)


def _enrich_court_bookings(rows: list[dict]) -> list[dict]:
    if not isinstance(rows, list) or not rows:
        return []

    availability_ids = sorted({_to_int(r.get("availabilityid")) for r in rows if _to_int(r.get("availabilityid")) is not None})
    booking_ids = sorted({_to_int(r.get(PRIMARY_KEY)) for r in rows if _to_int(r.get(PRIMARY_KEY)) is not None})
    user_ids = sorted({_to_int(r.get("userid")) for r in rows if _to_int(r.get("userid")) is not None})

    availability_rows = rest_select(
        "courtavailability",
        "availabilityid,courtid,playingcourtid",
        filters={"availabilityid": availability_ids} if availability_ids else None,
    ) if availability_ids else []

    availability_by_id: dict[int, dict[str, Any]] = {}
    playingcourt_ids: set[int] = set()
    court_ids: set[int] = set()
    for av in (availability_rows if isinstance(availability_rows, list) else []):
        aid = _to_int(av.get("availabilityid"))
        if aid is None:
            continue
        availability_by_id[aid] = av
        pcid = _to_int(av.get("playingcourtid"))
        cid = _to_int(av.get("courtid"))
        if pcid is not None:
            playingcourt_ids.add(pcid)
        if cid is not None:
            court_ids.add(cid)

    playingcourt_rows = rest_select(
        "playingcourt",
        "playingcourtid,courtid,name,base_name,part,surface,price",
        filters={"playingcourtid": sorted(playingcourt_ids)} if playingcourt_ids else None,
    ) if playingcourt_ids else []
    playingcourt_by_id: dict[int, dict[str, Any]] = {}
    for pc in (playingcourt_rows if isinstance(playingcourt_rows, list) else []):
        pcid = _to_int(pc.get("playingcourtid"))
        if pcid is None:
            continue
        playingcourt_by_id[pcid] = pc
        cid = _to_int(pc.get("courtid"))
        if cid is not None:
            court_ids.add(cid)

    court_rows = rest_select(
        "courts",
        "courtid,courtinfo,ownerid",
        filters={"courtid": sorted(court_ids)} if court_ids else None,
    ) if court_ids else []
    court_by_id: dict[int, dict[str, Any]] = {}
    owner_ids: set[int] = set()
    for c in (court_rows if isinstance(court_rows, list) else []):
        cid = _to_int(c.get("courtid"))
        if cid is None:
            continue
        court_by_id[cid] = c
        oid = _to_int(c.get("ownerid"))
        if oid is not None:
            owner_ids.add(oid)

    courtinfo_rows = rest_select(
        "courtinfo",
        "courtid,name,address,images",
        filters={"courtid": sorted(court_ids)} if court_ids else None,
    ) if court_ids else []
    courtinfo_by_courtid: dict[int, dict[str, Any]] = {}
    for ci in (courtinfo_rows if isinstance(courtinfo_rows, list) else []):
        cid = _to_int(ci.get("courtid"))
        if cid is not None:
            courtinfo_by_courtid[cid] = ci

    userinfo_rows = rest_select(
        "userinfo",
        "userid,name,pfp",
        filters={"userid": user_ids} if user_ids else None,
    ) if user_ids else []
    userinfo_by_userid: dict[int, dict[str, Any]] = {}
    for u in (userinfo_rows if isinstance(userinfo_rows, list) else []):
        uid = _to_int(u.get("userid"))
        if uid is not None:
            userinfo_by_userid[uid] = u

    owner_userinfo_rows = rest_select(
        "userinfo",
        "userid,name,pfp",
        filters={"userid": sorted(owner_ids)} if owner_ids else None,
    ) if owner_ids else []
    owner_userinfo_by_userid: dict[int, dict[str, Any]] = {}
    for u in (owner_userinfo_rows if isinstance(owner_userinfo_rows, list) else []):
        uid = _to_int(u.get("userid"))
        if uid is not None:
            owner_userinfo_by_userid[uid] = u

    event_rows = rest_select(
        "events",
        "eventid,courtbookingid,time,status,organizerid",
        filters={"courtbookingid": booking_ids} if booking_ids else None,
    ) if booking_ids else []
    events_by_cbid: dict[int, list[dict]] = {}
    for ev in (event_rows if isinstance(event_rows, list) else []):
        cbid = _to_int(ev.get("courtbookingid"))
        if cbid is not None:
            events_by_cbid.setdefault(cbid, []).append(ev)

    session_rows = rest_select(
        "trainingsessions",
        "sessionid,courtbookingid,time,status,coachid",
        filters={"courtbookingid": booking_ids} if booking_ids else None,
    ) if booking_ids else []
    sessions_by_cbid: dict[int, list[dict]] = {}
    for ts in (session_rows if isinstance(session_rows, list) else []):
        cbid = _to_int(ts.get("courtbookingid"))
        if cbid is not None:
            sessions_by_cbid.setdefault(cbid, []).append(ts)

    out: list[dict] = []
    for row in rows:
        aid = _to_int(row.get("availabilityid"))
        cbid = _to_int(row.get(PRIMARY_KEY))
        uid = _to_int(row.get("userid"))

        av = availability_by_id.get(aid) if aid is not None else None
        pcid = _to_int(av.get("playingcourtid")) if isinstance(av, dict) else None
        pc = playingcourt_by_id.get(pcid) if pcid is not None else None

        courtid = _to_int((pc or {}).get("courtid")) if pc else _to_int((av or {}).get("courtid"))
        c = court_by_id.get(courtid) if courtid is not None else None
        ci = courtinfo_by_courtid.get(courtid) if courtid is not None else None
        ownerid = _to_int((c or {}).get("ownerid"))
        owner_profile = owner_userinfo_by_userid.get(ownerid) if ownerid is not None else None
        booker_profile = userinfo_by_userid.get(uid) if uid is not None else None

        images = ci.get("images") if isinstance(ci, dict) else None
        thumbnail = None
        if isinstance(images, list) and images:
            first = images[0]
            if isinstance(first, str) and first.strip():
                thumbnail = first.strip()

        playing_name = (pc or {}).get("name") if isinstance(pc, dict) else None
        base_name = (pc or {}).get("base_name") if isinstance(pc, dict) else None
        display_court_name = (
            row.get("selected_court_name")
            or playing_name
            or row.get("selected_base_name")
            or base_name
            or (ci or {}).get("name")
            or (c or {}).get("courtinfo")
        )

        out.append({
            **row,
            "courtid": courtid,
            "court_name": display_court_name,
            "playingcourtid": pcid,
            "selected_court_name": row.get("selected_court_name") or playing_name,
            "selected_base_name": row.get("selected_base_name") or base_name,
            "selected_part": row.get("selected_part") or ((pc or {}).get("part") if isinstance(pc, dict) else None),
            "selected_surface": row.get("selected_surface") or ((pc or {}).get("surface") if isinstance(pc, dict) else None),
            "court_price_at_booking": row.get("court_price_at_booking") if row.get("court_price_at_booking") is not None else ((pc or {}).get("price") if isinstance(pc, dict) else None),
            "court_address": (ci or {}).get("address") if isinstance(ci, dict) else None,
            "court_thumbnail": thumbnail,
            "booker_name": (booker_profile or {}).get("name") if isinstance(booker_profile, dict) else None,
            "booker_pfp": (booker_profile or {}).get("pfp") if isinstance(booker_profile, dict) else None,
            "ownerid": ownerid,
            "owner_name": (owner_profile or {}).get("name") if isinstance(owner_profile, dict) else None,
            "owner_pfp": (owner_profile or {}).get("pfp") if isinstance(owner_profile, dict) else None,
            "linked_events": events_by_cbid.get(cbid or -1, []),
            "linked_trainingsessions": sessions_by_cbid.get(cbid or -1, []),
        })
    return out


def _list_court_bookings_sync(userid: int | None, courtid: int | None, status: str | None, limit: int, offset: int) -> list[dict[str, Any]]:
    try:
        if courtid is not None:
            pc_rows = rest_select("playingcourt", "playingcourtid", filters={"courtid": courtid})
            pc_ids = [int(r["playingcourtid"]) for r in (pc_rows if isinstance(pc_rows, list) else []) if r.get("playingcourtid") is not None]
            if not pc_ids:
                return []

            av_rows = rest_select("courtavailability", "availabilityid", filters={"playingcourtid": pc_ids})
            av_ids = [int(r["availabilityid"]) for r in (av_rows if isinstance(av_rows, list) else []) if r.get("availabilityid") is not None]
            if not av_ids:
                return []

            filters: dict[str, Any] = {"availabilityid": av_ids}
            if status is not None:
                filters["status"] = status

            all_bookings = rest_select("courtbooking", "*", filters=filters, order={"column": PRIMARY_KEY})
            all_bookings = all_bookings if isinstance(all_bookings, list) else []
            return _enrich_court_bookings(all_bookings[offset: offset + limit])

        filters: dict[str, Any] = {}
        if userid is not None:
            filters["userid"] = userid
        if status is not None:
            filters["status"] = status

        data = rest_select("courtbooking", "*", filters=filters or None, order={"column": PRIMARY_KEY})
        rows = data[offset: offset + limit] if isinstance(data, list) else []
        return _enrich_court_bookings(rows)
    except RuntimeError:
        raise


def _get_court_booking_sync(courtbookingid: int) -> dict[str, Any] | None:
    row = rest_select("courtbooking", "*", filters={PRIMARY_KEY: courtbookingid}, single=True)
    if not row:
        return None
    enriched = _enrich_court_bookings([row])
    if not enriched:
        return row
    return enriched[0]


async def _load_list_court_bookings(userid: int | None, courtid: int | None, status: str | None, limit: int, offset: int) -> list[dict[str, Any]]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: _list_court_bookings_sync(userid, courtid, status, limit, offset))


async def _load_court_booking_by_id(courtbookingid: int) -> dict[str, Any] | None:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: _get_court_booking_sync(courtbookingid))


async def _refresh_list_cache(*, app: Any, cache_key: str, userid: int | None, courtid: int | None, status: str | None, limit: int, offset: int) -> None:
    redis = getattr(app.state, "redis", None)
    if redis is None:
        return
    lock_key = _refresh_lock_key(cache_key)
    acquired = False
    try:
        acquired = bool(await redis.set(lock_key, "1", ex=_REFRESH_LOCK_SECONDS, nx=True))
        if not acquired:
            return
        fresh_rows = await _load_list_court_bookings(userid, courtid, status, limit, offset)
        await redis.set(cache_key, _pack_cached_payload(fresh_rows), ex=_CACHE_HARD_SECONDS)
    finally:
        if acquired:
            try:
                await redis.delete(lock_key)
            except Exception:
                pass


async def _refresh_by_id_cache(*, app: Any, cache_key: str, courtbookingid: int) -> None:
    redis = getattr(app.state, "redis", None)
    if redis is None:
        return
    lock_key = _refresh_lock_key(cache_key)
    acquired = False
    try:
        acquired = bool(await redis.set(lock_key, "1", ex=_REFRESH_LOCK_SECONDS, nx=True))
        if not acquired:
            return
        fresh_row = await _load_court_booking_by_id(courtbookingid)
        await redis.set(cache_key, _pack_cached_payload(fresh_row), ex=_CACHE_HARD_SECONDS)
    finally:
        if acquired:
            try:
                await redis.delete(lock_key)
            except Exception:
                pass


@router.get("", response_model=list[dict])
async def list_court_bookings(request: Request, userid: int | None = Query(None), courtid: int | None = Query(None), status: str | None = Query(None), limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0)):
    try:
        cache_key = _cache_list_key(userid=userid, courtid=courtid, status=status, limit=limit, offset=offset)
        redis = getattr(request.app.state, "redis", None)
        if redis is not None:
            raw = await redis.get(cache_key)
            if raw is not None:
                cached_rows, age_seconds = _unpack_cached_payload(raw)
                if age_seconds is not None:
                    if age_seconds <= _CACHE_FRESH_SECONDS:
                        return cached_rows if isinstance(cached_rows, list) else []
                    if age_seconds <= _CACHE_HARD_SECONDS:
                        _schedule_background_refresh(
                            _refresh_list_cache(
                                app=request.app,
                                cache_key=cache_key,
                                userid=userid,
                                courtid=courtid,
                                status=status,
                                limit=limit,
                                offset=offset,
                            )
                        )
                        return cached_rows if isinstance(cached_rows, list) else []

        fresh_rows = await _load_list_court_bookings(userid, courtid, status, limit, offset)
        if redis is not None:
            await redis.set(cache_key, _pack_cached_payload(fresh_rows), ex=_CACHE_HARD_SECONDS)
        return fresh_rows
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{courtbookingid}", response_model=dict)
async def get_court_booking(request: Request, courtbookingid: int):
    try:
        cache_key = _cache_by_id_key(courtbookingid)
        redis = getattr(request.app.state, "redis", None)
        if redis is not None:
            raw = await redis.get(cache_key)
            if raw is not None:
                cached_row, age_seconds = _unpack_cached_payload(raw)
                if age_seconds is not None:
                    if age_seconds <= _CACHE_FRESH_SECONDS:
                        if cached_row:
                            return cached_row
                        raise HTTPException(status_code=404, detail="Court booking not found")
                    if age_seconds <= _CACHE_HARD_SECONDS:
                        _schedule_background_refresh(
                            _refresh_by_id_cache(
                                app=request.app,
                                cache_key=cache_key,
                                courtbookingid=courtbookingid,
                            )
                        )
                        if cached_row:
                            return cached_row
                        raise HTTPException(status_code=404, detail="Court booking not found")

        row = await _load_court_booking_by_id(courtbookingid)
        if redis is not None:
            await redis.set(cache_key, _pack_cached_payload(row), ex=_CACHE_HARD_SECONDS)
        if not row:
            raise HTTPException(status_code=404, detail="Court booking not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_court_booking(request: Request, body: dict, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
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

        # Treat pending bookings as occupied to prevent duplicate overlap attempts.
        start_dt = _parse_ts(payload.get("start_timestamp"))
        end_dt = _parse_ts(payload.get("end_timestamp"))
        if start_dt and end_dt and end_dt > start_dt:
            existing_rows = rest_select(
                "courtbooking",
                "courtbookingid,status,bookingstatus,start_timestamp,end_timestamp",
                filters={"userid": final_userid},
            )
            if isinstance(existing_rows, list):
                for ex in existing_rows:
                    if not isinstance(ex, dict):
                        continue
                    ex_status = str(ex.get("status") or "").strip().lower()
                    ex_booking_status = str(ex.get("bookingstatus") or "").strip().lower()
                    is_inactive = (
                        "cancel" in ex_status
                        or "reject" in ex_status
                        or "cancel" in ex_booking_status
                        or "complete" in ex_booking_status
                    )
                    if is_inactive:
                        continue

                    ex_start = _parse_ts(ex.get("start_timestamp"))
                    ex_end = _parse_ts(ex.get("end_timestamp"))
                    if not ex_start or not ex_end or ex_end <= ex_start:
                        continue

                    overlaps = max(start_dt, ex_start) < min(end_dt, ex_end)
                    if overlaps:
                        raise HTTPException(
                            status_code=409,
                            detail="You already have a pending or active booking that overlaps this time slot.",
                        )

        print(f"[create_court_booking] auth_sub={auth_sub} supplied_userid={supplied_userid} final_userid={final_userid} availabilityid={payload.get('availabilityid')}")

        # Strip frontend-only or non-schema fields before inserting into Supabase.
        _non_schema_keys = {'venue_name'}
        insert_payload = {k: v for k, v in payload.items() if k not in _non_schema_keys}
        resp = rest_insert("courtbooking", insert_payload)
        if not isinstance(resp, list) or not resp:
            raise HTTPException(status_code=500, detail="Insert did not return representation; check Supabase headers/policies")
        row = resp[0]
        if PRIMARY_KEY not in row:
            raise HTTPException(status_code=500, detail="Insert succeeded but missing primary key in response")

        # Notifications (best-effort; never block booking creation)
        try:
            booking_id = int(row.get(PRIMARY_KEY))
            base_name = payload.get("selected_base_name") or payload.get("selected_court_name") or "Court"
            venue_name = payload.get("venue_name") or base_name
            if courtid is not None and venue_name == base_name:
                try:
                    court_row = rest_select("courtinfo", "name", filters={"courtid": courtid}, single=True)
                    if isinstance(court_row, dict) and court_row.get("name"):
                        venue_name = str(court_row.get("name"))
                except Exception:
                    pass

            # Booker notification
            if auto_approve:
                create_notification(
                    userid=final_userid,
                    category="court",
                    notificationtype="courtbooking",
                    kind="approved",
                    notificationtypeid=booking_id,
                    title="Booking confirmed",
                    message=f"Your court booking for {venue_name} has been approved.",
                    data={"courtbookingid": booking_id, "courtid": courtid, "base_name": base_name, "venue_name": venue_name},
                    message_key="court_booking_approved",
                    message_params={"venue": venue_name},
                )
            else:
                create_notification(
                    userid=final_userid,
                    category="court",
                    notificationtype="courtbooking",
                    kind="submitted",
                    notificationtypeid=booking_id,
                    title="Booking submitted",
                    message=f"Your court booking for {venue_name} is pending approval.",
                    data={"courtbookingid": booking_id, "courtid": courtid, "base_name": base_name, "venue_name": venue_name},
                    message_key="court_booking_submitted",
                    message_params={"venue": venue_name},
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
                        message_key="court_booking_incoming",
                        message_params={"venue": base_name},
                    )
        except Exception as e:
            print("[courtbookings] notification insert failed:", str(e))

        background_tasks.add_task(invalidate_namespace, "courtbookings", "courtavailability")
        background_tasks.add_task(_invalidate_courtbookings_swr_cache, request)
        if final_userid is not None:
            background_tasks.add_task(_invalidate_user_dashboard_cache, request.app, final_userid)
        return row
    except HTTPException:
        raise
    except RuntimeError as e:
        if "409" in str(e):
            raise HTTPException(status_code=409, detail="Duplicate primary key on insert; sequence likely misaligned")
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/{courtbookingid}", response_model=dict)
def update_court_booking(request: Request, courtbookingid: int, body: dict, background_tasks: BackgroundTasks, current_user: str = Depends(get_current_user)):
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
                    venue_name = row.get("venue_name") or base_name
                    if courtid is not None and venue_name == base_name:
                        try:
                            court_row = rest_select("courtinfo", "name", filters={"courtid": courtid}, single=True)
                            if isinstance(court_row, dict) and court_row.get("name"):
                                venue_name = str(court_row.get("name"))
                        except Exception:
                            pass
                    if new_status.lower() == "approved":
                        create_notification(
                            userid=booker_userid,
                            category="court",
                            notificationtype="courtbooking",
                            kind="approved",
                            notificationtypeid=int(courtbookingid),
                            title="Booking approved",
                            message=f"Your court booking for {venue_name} has been approved.",
                            data={"courtbookingid": int(courtbookingid), "courtid": courtid, "base_name": base_name, "venue_name": venue_name},
                            message_key="court_booking_approved",
                            message_params={"venue": venue_name},
                        )
                    elif new_status.lower() == "rejected":
                        create_notification(
                            userid=booker_userid,
                            category="court",
                            notificationtype="courtbooking",
                            kind="rejected",
                            notificationtypeid=int(courtbookingid),
                            title="Booking rejected",
                            message=f"Your court booking for {venue_name} has been rejected.",
                            data={"courtbookingid": int(courtbookingid), "courtid": courtid, "base_name": base_name, "venue_name": venue_name},
                            message_key="court_booking_rejected",
                            message_params={"venue": venue_name},
                        )
        except Exception as e:
            print("[courtbookings] notification update failed:", str(e))

        background_tasks.add_task(invalidate_namespace, "courtbookings", "courtavailability")
        background_tasks.add_task(_invalidate_courtbookings_swr_cache, request)
        # Bust the booker's dashboard cache so their next pull sees the updated status
        if existing:
            _booker_id = existing.get("userid")
            if _booker_id is not None:
                background_tasks.add_task(_invalidate_user_dashboard_cache, request.app, int(_booker_id))
        if auth_userid is not None:
            background_tasks.add_task(_invalidate_user_dashboard_cache, request.app, auth_userid)
        return row
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
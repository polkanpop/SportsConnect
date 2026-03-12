import re
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Depends
from ..db import rest_select, rest_upsert, rest_update
from ..auth import get_current_user

router = APIRouter(prefix="/courtavailability", tags=["courts"])

PRIMARY_KEY = "availabilityid"

ALLOWED_DAYS: set[str] = {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
_TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$")


def _normalize_time(s: Any) -> str | None:
    if s is None:
        return None
    raw = str(s).strip()
    if not _TIME_RE.match(raw):
        raise ValueError("Invalid time format; expected HH:MM")
    parts = raw.split(":")
    hh = int(parts[0])
    mm = int(parts[1])
    ss = int(parts[2]) if len(parts) == 3 else 0
    ss = max(0, min(59, ss))
    return f"{hh:02d}:{mm:02d}:{ss:02d}"


def _normalize_days(v: Any) -> list[str] | None:
    if v is None:
        return None
    if not isinstance(v, list):
        raise ValueError("booking_date must be a list")
    out = [str(x).strip() for x in v if isinstance(x, str) and str(x).strip()]
    out = [x for x in out if x in ALLOWED_DAYS]
    # Deduplicate preserving order
    dedup: list[str] = []
    seen: set[str] = set()
    for d in out:
        if d in seen:
            continue
        seen.add(d)
        dedup.append(d)
    return dedup


def _enforce_owner_by_courtid(*, courtid: int, current_user: str) -> None:
    try:
        numeric_subject = int(current_user) if str(current_user).isdigit() else None
    except Exception:
        numeric_subject = None
    if numeric_subject is None:
        return
    court = rest_select("courts", "courtid,ownerid", filters={"courtid": courtid}, single=True)
    if not court:
        raise HTTPException(status_code=404, detail="Court not found")
    try:
        ownerid = int(court.get("ownerid"))
    except Exception:
        ownerid = None
    if ownerid is not None and ownerid != numeric_subject:
        raise HTTPException(status_code=403, detail="Not allowed")


def _list_playingcourt_ids_for_courtid(courtid: int) -> list[int]:
    rows = rest_select("playingcourt", "playingcourtid", filters={"courtid": courtid}, order={"column": "playingcourtid"})
    out: list[int] = []
    if isinstance(rows, list):
        for r in rows:
            if isinstance(r, dict) and r.get("playingcourtid") is not None:
                try:
                    out.append(int(r.get("playingcourtid")))
                except Exception:
                    pass
    return out


def _enforce_owner_by_playingcourtid(*, playingcourtid: int, current_user: str) -> None:
    pc = rest_select("playingcourt", "courtid", filters={"playingcourtid": playingcourtid}, single=True)
    if not pc:
        raise HTTPException(status_code=404, detail="Playing court not found")
    try:
        courtid = int(pc.get("courtid"))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid playingcourtid")
    _enforce_owner_by_courtid(courtid=courtid, current_user=current_user)

@router.get("", response_model=list[dict])
def list_court_availability(
    courtid: int | None = Query(None),
    playingcourtid: int | None = Query(None),
    status: str | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    try:
        if playingcourtid is not None:
            filters: dict[str, int | str] = {"playingcourtid": playingcourtid}
            if status is not None:
                filters["status"] = status
            data = rest_select("courtavailability", "*", filters=filters or None, order={"column": PRIMARY_KEY})
            if isinstance(data, list):
                data = data[offset : offset + limit]
            return data if isinstance(data, list) else []

        # Backward-compatible mode: list by courtid (resolve to playingcourtid list).
        if courtid is None:
            filters: dict[str, int | str] = {}
            if status is not None:
                filters["status"] = status
            data = rest_select("courtavailability", "*", filters=filters or None, order={"column": PRIMARY_KEY})
            if isinstance(data, list):
                data = data[offset : offset + limit]
            return data if isinstance(data, list) else []

        pc_ids = _list_playingcourt_ids_for_courtid(courtid)
        rows: list[dict] = []
        for pcid in pc_ids:
            filters = {"playingcourtid": pcid}
            if status is not None:
                filters["status"] = status
            data = rest_select("courtavailability", "*", filters=filters or None, order={"column": PRIMARY_KEY})
            if isinstance(data, list):
                rows.extend([r for r in data if isinstance(r, dict)])
        rows.sort(key=lambda r: int(r.get(PRIMARY_KEY) or 0))
        return rows[offset : offset + limit]
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{availabilityid}", response_model=dict)
def get_court_availability(availabilityid: int):
    try:
        row = rest_select("courtavailability", "*", filters={PRIMARY_KEY: availabilityid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Availability slot not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_court_availability(body: dict, current_user: str = Depends(get_current_user)):
    """Create an availability slot.

    New schema: body should include playingcourtid, start_time, end_time, status, booking_date.
    """
    try:
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Invalid payload")

        payload: dict[str, Any] = dict(body)
        # Back-compat: if courtid is provided but playingcourtid is not, default to the first FULL playing court.
        if payload.get("playingcourtid") in (None, "") and payload.get("courtid") is not None:
            try:
                courtid = int(payload.get("courtid"))
            except Exception:
                raise HTTPException(status_code=400, detail="Invalid courtid")
            pcs = rest_select("playingcourt", "playingcourtid", filters={"courtid": courtid, "part": "full"}, order={"column": "playingcourtid"})
            pc = pcs[0] if isinstance(pcs, list) and pcs else None
            pcid = pc.get("playingcourtid") if isinstance(pc, dict) else None
            if pcid is None:
                raise HTTPException(status_code=400, detail="No playing courts exist for this court")
            payload["playingcourtid"] = int(pcid)

        # Strip legacy column if present (DB may have dropped it).
        payload.pop("courtid", None)

        resp = rest_upsert("courtavailability", payload)
        return resp[0] if isinstance(resp, list) and resp else body
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/by-courtid/{courtid}", response_model=list[dict])
def patch_court_availability_by_courtid(courtid: int, body: dict, current_user: str = Depends(get_current_user)):
    """Update availability slots for a court.

    Intended for updating the default schedule row created by /courts/register.
    """
    _enforce_owner_by_courtid(courtid=courtid, current_user=current_user)

    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")

    patch: dict[str, Any] = {}
    try:
        if "start_time" in body:
            patch["start_time"] = _normalize_time(body.get("start_time"))
        if "end_time" in body:
            patch["end_time"] = _normalize_time(body.get("end_time"))
        if "booking_date" in body:
            patch["booking_date"] = _normalize_days(body.get("booking_date"))
        if "status" in body:
            patch["status"] = str(body.get("status") or "").strip()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    patch = {k: v for k, v in patch.items() if v is not None}
    if not patch:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    try:
        pc_ids = _list_playingcourt_ids_for_courtid(courtid)
        updated_all: list[dict] = []
        for pcid in pc_ids:
            updated = rest_update("courtavailability", {"playingcourtid": pcid}, patch)
            if isinstance(updated, list):
                updated_all.extend([r for r in updated if isinstance(r, dict)])
            elif isinstance(updated, dict):
                updated_all.append(updated)
        return updated_all
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/by-playingcourtid/{playingcourtid}", response_model=list[dict])
def patch_court_availability_by_playingcourtid(
    playingcourtid: int,
    body: dict,
    current_user: str = Depends(get_current_user),
):
    """Update availability slot(s) for a specific playing court.

    New schema expects courtavailability rows keyed by playingcourtid.
    """

    _enforce_owner_by_playingcourtid(playingcourtid=playingcourtid, current_user=current_user)

    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")

    patch: dict[str, Any] = {}
    try:
        if "start_time" in body:
            patch["start_time"] = _normalize_time(body.get("start_time"))
        if "end_time" in body:
            patch["end_time"] = _normalize_time(body.get("end_time"))
        if "booking_date" in body:
            patch["booking_date"] = _normalize_days(body.get("booking_date"))
        if "status" in body:
            patch["status"] = str(body.get("status") or "").strip()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    patch = {k: v for k, v in patch.items() if v is not None}
    if not patch:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    try:
        updated = rest_update("courtavailability", {"playingcourtid": playingcourtid}, patch)
        if isinstance(updated, list):
            return [r for r in updated if isinstance(r, dict)]
        if isinstance(updated, dict):
            return [updated]
        return []
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

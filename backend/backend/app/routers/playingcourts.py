from typing import Any
import hashlib
from datetime import time, timedelta, datetime

from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth import get_current_user
from ..db import rest_insert, rest_select, rest_update, rest_upsert

router = APIRouter(prefix="/playingcourts", tags=["courts"])

PRIMARY_KEY = "playingcourtid"


def _stable_hash_int(value: str) -> int:
    # Stable across processes and platforms (unlike Python's built-in hash())
    h = hashlib.md5(value.encode("utf-8")).hexdigest()
    return int(h[:8], 16)


def _desired_san_count(*, courtid: int, max_san: int) -> int:
    if max_san < 1:
        return 1
    return (_stable_hash_int(str(courtid)) % max_san) + 1


def _make_time_str(t: time) -> str:
    return t.strftime("%H:%M:%S")


def _generate_availability(*, courtid: int, base_name: str, part: str) -> dict:
    seed = f"{courtid}:{base_name}:{part}"
    h_h = _stable_hash_int(seed + ":h")
    h_m = _stable_hash_int(seed + ":m")
    h_d = _stable_hash_int(seed + ":d")
    h_mask = _stable_hash_int(seed + ":mask")

    start_hour = 6 + (h_h % 8)  # 06..13
    start_min = (h_m % 4) * 15  # 00,15,30,45
    start_t = time(start_hour, start_min, 0)

    dur_hours = 5 + (h_d % 8)  # 5..12
    # Cap end time to <= 22:45, keep minutes aligned
    start_dt = datetime(2000, 1, 1, start_t.hour, start_t.minute, 0)
    end_dt = start_dt + timedelta(hours=dur_hours)
    cap_dt = datetime(2000, 1, 1, 22, start_t.minute, 0)
    if end_dt > cap_dt:
        end_dt = cap_dt
    if end_dt <= start_dt:
        end_dt = start_dt + timedelta(hours=1)
    end_t = time(end_dt.hour, end_dt.minute, 0)

    days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    mask = h_mask % 128
    booking_days = [d for i, d in enumerate(days) if (mask >> i) & 1]
    if not booking_days:
        booking_days = ["Mon", "Tue", "Wed", "Thu", "Fri"]

    return {
        "start_time": _make_time_str(start_t),
        "end_time": _make_time_str(end_t),
        "booking_date": booking_days,
        "status": "available",
    }


def _enforce_owner_by_playingcourtid(*, playingcourtid: int, current_user: str) -> dict:
    """Return playingcourt row and enforce ownership when auth subject is numeric."""
    pc = rest_select("playingcourt", "playingcourtid,courtid", filters={PRIMARY_KEY: playingcourtid}, single=True)
    if not pc:
        raise HTTPException(status_code=404, detail="Playing court not found")

    try:
        numeric_subject = int(current_user) if str(current_user).isdigit() else None
    except Exception:
        numeric_subject = None

    if numeric_subject is None:
        return pc

    courtid = pc.get("courtid")
    court = rest_select("courts", "courtid,ownerid", filters={"courtid": courtid}, single=True)
    if not court:
        raise HTTPException(status_code=404, detail="Court not found")
    try:
        ownerid = int(court.get("ownerid"))
    except Exception:
        ownerid = None
    if ownerid is not None and ownerid != numeric_subject:
        raise HTTPException(status_code=403, detail="Not allowed")

    return pc


@router.post("/seed-missing", response_model=dict)
def seed_missing_playingcourts(
    courtid: int | None = Query(None),
    max_san: int = Query(3, ge=1, le=10),
    current_user: str = Depends(get_current_user),
):
    """Dev utility: ensure each court has San 1..N playingcourts (full/half_a/half_b),
    a playingcourtinfo row, and at least one courtavailability row per playing court.

    Security model:
    - If token subject is numeric: seeds only courts owned by that user (or a specific courtid they own).
    - If token subject is non-numeric: requires explicit courtid (prevents seeding the entire DB).
    """

    try:
        numeric_subject = int(current_user) if str(current_user).isdigit() else None
    except Exception:
        numeric_subject = None

    if numeric_subject is None and courtid is None:
        raise HTTPException(status_code=400, detail="courtid is required for non-numeric auth subjects")

    courts: list[dict] = []
    if courtid is not None:
        row = rest_select("courts", "courtid,ownerid", filters={"courtid": courtid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Court not found")
        if numeric_subject is not None:
            try:
                ownerid = int(row.get("ownerid"))
            except Exception:
                ownerid = None
            if ownerid is not None and ownerid != numeric_subject:
                raise HTTPException(status_code=403, detail="Not allowed")
        courts = [row]
    else:
        # numeric_subject must exist here
        courts = rest_select("courts", "courtid,ownerid", filters={"ownerid": numeric_subject}, order={"column": "courtid"})
        if not isinstance(courts, list):
            courts = []

    created_playingcourts = 0
    ensured_info = 0
    created_availability = 0
    processed_courts = 0

    for c in courts:
        try:
            cid = int(c.get("courtid"))
        except Exception:
            continue
        processed_courts += 1
        san_count = _desired_san_count(courtid=cid, max_san=max_san)

        for san_idx in range(1, san_count + 1):
            base_name = f"San {san_idx}"
            for part in ("full", "half_a", "half_b"):
                name = (f"Full San {san_idx}" if part == "full" else f"Half San {san_idx}")
                existing = rest_select(
                    "playingcourt",
                    "playingcourtid,courtid",
                    filters={"courtid": cid, "base_name": base_name, "part": part},
                    single=True,
                )
                if existing and existing.get("playingcourtid") is not None:
                    pcid = int(existing.get("playingcourtid"))
                else:
                    rows = rest_insert(
                        "playingcourt",
                        {"courtid": cid, "base_name": base_name, "name": name, "part": part},
                    )
                    row = rows[0] if isinstance(rows, list) and rows else rows
                    pcid = int(row.get("playingcourtid"))
                    created_playingcourts += 1

                # Ensure info exists
                try:
                    rest_upsert("playingcourtinfo", {"playingcourtid": pcid}, on_conflict="playingcourtid")
                    ensured_info += 1
                except Exception:
                    pass

                # Ensure at least one availability exists for this playing court
                existing_av = rest_select(
                    "courtavailability",
                    "availabilityid",
                    filters={"playingcourtid": pcid},
                    single=True,
                )
                if not existing_av:
                    av = _generate_availability(courtid=cid, base_name=base_name, part=part)
                    rest_insert(
                        "courtavailability",
                        {
                            "courtid": cid,
                            "playingcourtid": pcid,
                            "status": av["status"],
                            "start_time": av["start_time"],
                            "end_time": av["end_time"],
                            "booking_date": av["booking_date"],
                        },
                    )
                    created_availability += 1

    return {
        "processedCourts": processed_courts,
        "createdPlayingcourts": created_playingcourts,
        "ensuredPlayingcourtInfo": ensured_info,
        "createdAvailability": created_availability,
        "maxSan": max_san,
        "mode": "seed-missing",
    }


@router.get("", response_model=list[dict])
def list_playingcourts(
    courtid: int | None = Query(None),
    part: str | None = Query(None),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    filters: dict[str, Any] = {}
    if courtid is not None:
        filters["courtid"] = courtid
    if part is not None:
        filters["part"] = part
    data = rest_select("playingcourt", "*", filters=filters or None, order={"column": PRIMARY_KEY})
    if isinstance(data, list):
        data = data[offset : offset + limit]
    return data if isinstance(data, list) else []


@router.get("/{playingcourtid}", response_model=dict)
def get_playingcourt(playingcourtid: int):
    row = rest_select("playingcourt", "*", filters={PRIMARY_KEY: playingcourtid}, single=True)
    if not row:
        raise HTTPException(status_code=404, detail="Playing court not found")
    return row


@router.patch("/{playingcourtid}", response_model=dict)
def patch_playingcourt(playingcourtid: int, body: dict, current_user: str = Depends(get_current_user)):
    _enforce_owner_by_playingcourtid(playingcourtid=playingcourtid, current_user=current_user)
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")

    payload = dict(body)
    payload.pop(PRIMARY_KEY, None)
    payload.pop("courtid", None)
    payload.pop("part", None)
    if not payload:
        raise HTTPException(status_code=422, detail="No fields to update")

    updated = rest_update("playingcourt", {PRIMARY_KEY: playingcourtid}, payload)
    if isinstance(updated, list) and updated:
        return updated[0]
    return payload


@router.get("/{playingcourtid}/info", response_model=dict)
def get_playingcourtinfo(playingcourtid: int):
    row = rest_select("playingcourtinfo", "*", filters={"playingcourtid": playingcourtid}, single=True)
    if not row:
        # Return a default-shaped object (client can PATCH later)
        return {"playingcourtid": playingcourtid, "images": []}
    return row


@router.patch("/{playingcourtid}/info", response_model=dict)
def patch_playingcourtinfo(playingcourtid: int, body: dict, current_user: str = Depends(get_current_user)):
    _enforce_owner_by_playingcourtid(playingcourtid=playingcourtid, current_user=current_user)
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")

    payload = dict(body)
    payload["playingcourtid"] = playingcourtid
    payload.pop("playingcourtinfoid", None)
    # description column removed; ignore if client sends it.
    payload.pop("description", None)

    updated = rest_upsert("playingcourtinfo", payload, on_conflict="playingcourtid")
    if isinstance(updated, list) and updated:
        return updated[0]
    return payload

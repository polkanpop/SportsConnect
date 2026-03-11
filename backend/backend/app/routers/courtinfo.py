from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from ..auth import get_current_user
from ..db import rest_select, rest_update
from ..models import CourtInfo

router = APIRouter(prefix="/courtinfo", tags=["courtinfo"])

ALLOWED_VENUES: set[str] = {"Indoor", "Outdoor"}


def _attach_min_full_price(row: dict) -> dict:
    try:
        courtid = int(row.get("courtid"))
    except Exception:
        return row

    try:
        # Minimum FULL court price only (not half courts)
        pc = rest_select(
            "playingcourt",
            "price",
            filters={"courtid": courtid, "part": "full"},
            single=True,
            order={"column": "price"},
        )
        if pc and pc.get("price") is not None:
            row["price"] = float(pc.get("price"))
    except Exception:
        # If price column isn't present yet (or any REST error), keep payload unchanged.
        pass
    return row


def _normalize_images(v: Any) -> list[str] | None:
    if v is None:
        return None
    if isinstance(v, list):
        out = [str(x).strip() for x in v if isinstance(x, str) and str(x).strip()]
        return out
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return []
        # Accept JSON-ish list string; fallback to comma-separated.
        if s.startswith("[") and s.endswith("]"):
            inner = s[1:-1]
            parts = [p.strip().strip('"') for p in inner.split(",")]
            return [p for p in parts if p]
        if "," in s:
            return [p.strip() for p in s.split(",") if p.strip()]
        return [s]
    return None


def _normalize_venue(v: Any) -> list[str] | None:
    if v is None:
        return None
    if isinstance(v, str):
        raw = v.strip()
        if raw == "Both":
            return ["Indoor", "Outdoor"]
        if raw in ALLOWED_VENUES:
            return [raw]
        return None
    if isinstance(v, list):
        cleaned = [str(x).strip() for x in v if isinstance(x, str)]
        cleaned = [x for x in cleaned if x in ALLOWED_VENUES]
        if not cleaned:
            return []
        # Deduplicate while preserving order
        out: list[str] = []
        seen: set[str] = set()
        for x in cleaned:
            if x in seen:
                continue
            seen.add(x)
            out.append(x)
        return out
    return None


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

@router.get("", response_model=list[CourtInfo])
async def list_courts(courtids: str | None = Query(default=None)):
    """List courtinfo rows. Optional filter: ?courtids=1,2,3
    (Client-side subset until REST helper supports IN filter)."""
    try:
        # Keep select list aligned with the actual DB schema.
        # NOTE: courtinfo does NOT have city/state/postal_code/accuracy_score columns in current schema.
        select_cols = "courtinfoid,courtid,name,address,latitude,longitude,venue,images,availability,accuracy_type,auto_approve"
        data_all = rest_select(
            "courtinfo",
            select_cols,
            order={"column": "courtinfoid"},
        )
        if courtids:
            try:
                wanted = {int(x) for x in courtids.split(',') if x.strip().isdigit()}
            except ValueError:
                wanted = set()
            if wanted:
                data_all = [d for d in data_all if d.get("courtid") in wanted]

        return [_attach_min_full_price(d) for d in data_all]
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/by-courtid/{courtid}", response_model=CourtInfo)
async def get_court_by_courtid(courtid: int):
    try:
        data = rest_select(
            "courtinfo",
            "courtinfoid,courtid,name,address,latitude,longitude,venue,images,availability,accuracy_type,auto_approve",
            filters={"courtid": courtid},
            single=True,
        )
        if not data:
            raise HTTPException(status_code=404, detail="Court not found")
        return _attach_min_full_price(data)
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.patch("/by-courtid/{courtid}", response_model=CourtInfo)
async def patch_courtinfo_by_courtid(courtid: int, body: dict, current_user: str = Depends(get_current_user)):
    """Update courtinfo row by courtid.

    Security:
    - Requires Bearer token
    - If the token subject is numeric, enforce ownerid == subject
    """
    _enforce_owner_by_courtid(courtid=courtid, current_user=current_user)

    existing = rest_select(
        "courtinfo",
        "courtinfoid,courtid,name,address,latitude,longitude,venue,images,availability,accuracy_type,auto_approve",
        filters={"courtid": courtid},
        single=True,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Court not found")

    patch: dict[str, Any] = {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")

    if "name" in body:
        v = body.get("name")
        patch["name"] = (v or "").strip() if isinstance(v, str) else v
    if "address" in body:
        v = body.get("address")
        patch["address"] = (v or "").strip() if isinstance(v, str) else v
    if "latitude" in body:
        v = body.get("latitude")
        patch["latitude"] = float(v) if v is not None else None
    if "longitude" in body:
        v = body.get("longitude")
        patch["longitude"] = float(v) if v is not None else None
    if "availability" in body:
        v = body.get("availability")
        patch["availability"] = (v or "").strip() if isinstance(v, str) else v
    if "accuracy_type" in body:
        v = body.get("accuracy_type")
        patch["accuracy_type"] = (v or "").strip() if isinstance(v, str) else v
    if "images" in body:
        patch["images"] = _normalize_images(body.get("images"))
    if "venue" in body:
        venue_norm = _normalize_venue(body.get("venue"))
        if venue_norm is None:
            raise HTTPException(status_code=400, detail="Invalid venue")
        patch["venue"] = venue_norm
    if "auto_approve" in body:
        v = body.get("auto_approve")
        patch["auto_approve"] = bool(v) if v is not None else False

    patch = {k: v for k, v in patch.items() if v is not None}
    if not patch:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    try:
        updated = rest_update("courtinfo", {"courtid": courtid}, patch)
        row = updated[0] if isinstance(updated, list) and updated else updated
        return _attach_min_full_price(row)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{courtinfoid}", response_model=CourtInfo)
async def get_court(courtinfoid: int):
    try:
        data = rest_select(
            "courtinfo",
            "courtinfoid,courtid,name,address,latitude,longitude,venue,images,availability,accuracy_type,auto_approve",
            filters={"courtinfoid": courtinfoid},
            single=True,
        )
        if not data:
            raise HTTPException(status_code=404, detail="Court not found")
        return _attach_min_full_price(data)
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

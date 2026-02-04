import os
import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ..auth import get_current_user
from ..db import get_http_client, rest_insert, rest_select
from fastapi_cache.decorator import cache

router = APIRouter(prefix="/courts", tags=["courts"])

logger = logging.getLogger("courts")

SELECT_COLUMNS = "*"  # adjust if you want a slimmer payload


ALLOWED_VENUES: set[str] = {"Indoor", "Outdoor"}


class GeocodeResponse(BaseModel):
    formatted_address: Optional[str] = None
    latitude: float
    longitude: float
    location_type: Optional[str] = None
    place_id: Optional[str] = None
    types: list[str] = Field(default_factory=list)
    city: Optional[str] = None
    state: Optional[str] = None
    postal_code: Optional[str] = None
    accuracy_type: Optional[str] = None
    accuracy_score: Optional[float] = None
    warnings: list[str] = Field(default_factory=list)


class CourtRegisterRequest(BaseModel):
    name: str
    address: str
    ownerid: int
    price: float = Field(default=0, ge=0)
    venue: str  # Indoor | Outdoor | Both
    images: list[str] = Field(default_factory=list)


class CourtRegisterResponse(BaseModel):
    courtid: int
    courtinfoid: int
    geocode: GeocodeResponse


def _require_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise HTTPException(status_code=500, detail=f"Missing env var: {name}")
    return v


def _extract_component(components: list[dict[str, Any]], want: str) -> Optional[str]:
    for c in components or []:
        types = c.get("types") or []
        if want in types:
            return c.get("long_name") or c.get("short_name")
    return None


def _geocode_address(address: str) -> GeocodeResponse:
    key = _require_env("GEOCODIO_API_KEY").strip().strip('"').strip("'")
    client = get_http_client()
    r = client.get(
        "https://api.geocod.io/v1.7/geocode",
        params={"q": address, "api_key": key, "limit": 1},
    )
    if r.status_code >= 400:
        logger.warning(
            "[geocode] http_error provider=geocodio status=%s address=%r body=%s",
            r.status_code,
            address,
            (r.text or "")[:500],
        )
        raise HTTPException(status_code=502, detail=f"Geocoding provider error (HTTP {r.status_code})")

    data = r.json() or {}
    results = data.get("results") or []
    first = results[0] if results else None
    if not first:
        raise HTTPException(status_code=400, detail="Geocoding returned no results")

    loc = (first.get("location") or {})
    lat = loc.get("lat")
    lng = loc.get("lng")
    if lat is None or lng is None:
        raise HTTPException(status_code=400, detail="Geocoding result missing lat/lng")

    ac = first.get("address_components") or {}
    city = ac.get("city") or ac.get("town") or ac.get("village")
    state = ac.get("state")
    postal_code = ac.get("zip") or ac.get("postal_code")

    accuracy = first.get("accuracy")
    accuracy_type = first.get("accuracy_type")

    warnings: list[str] = []
    if accuracy_type and str(accuracy_type).lower() not in {"rooftop", "point"}:
        warnings.append(f"Low geocode precision (accuracy_type={accuracy_type})")
    if isinstance(accuracy, (int, float)) and float(accuracy) < 0.8:
        warnings.append(f"Low geocode confidence (accuracy={accuracy})")

    # Geocodio does not provide Google-like place types/place_id; keep shape compatible.
    return GeocodeResponse(
        formatted_address=first.get("formatted_address") or None,
        latitude=float(lat),
        longitude=float(lng),
        location_type=str(accuracy_type) if accuracy_type else None,
        place_id=None,
        types=[],
        city=str(city) if city else None,
        state=str(state) if state else None,
        postal_code=str(postal_code) if postal_code else None,
        accuracy_type=str(accuracy_type) if accuracy_type else None,
        accuracy_score=float(accuracy) if isinstance(accuracy, (int, float)) else None,
        warnings=warnings,
    )


@router.get("/geocode", response_model=GeocodeResponse)
async def geocode(address: str = Query(..., min_length=3), _: str = Depends(get_current_user)):
    try:
        return _geocode_address(address)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("", response_model=list[dict])
@cache(expire=300)
async def list_courts():
    try:
        data = rest_select("courts", SELECT_COLUMNS, order={"column": "courtid"})
        return data if isinstance(data, list) else []
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{courtid}", response_model=dict)
@cache(expire=300)
async def get_court(courtid: int):
    try:
        row = rest_select("courts", SELECT_COLUMNS, filters={"courtid": courtid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Court not found")
        return row
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/register", response_model=CourtRegisterResponse)
async def register_court(req: CourtRegisterRequest, current_user: str = Depends(get_current_user)):
    """Register a new court + courtinfo row.

    Security:
    - Requires Bearer token
    - If the token subject is numeric, enforce ownerid == subject
    """
    try:
        numeric_subject = int(current_user) if str(current_user).isdigit() else None
    except Exception:
        numeric_subject = None
    if numeric_subject is not None and req.ownerid != numeric_subject:
        raise HTTPException(status_code=403, detail="ownerid does not match token subject")

    name = (req.name or "").strip()
    address = (req.address or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Missing name")
    if not address:
        raise HTTPException(status_code=400, detail="Missing address")

    venue_raw = (req.venue or "").strip()
    if venue_raw == "Both":
        venues = ["Indoor", "Outdoor"]
    else:
        venues = [venue_raw]
    if any(v not in ALLOWED_VENUES for v in venues):
        raise HTTPException(status_code=400, detail="Invalid venue; expected Indoor/Outdoor/Both")

    geocode = _geocode_address(address)

    try:
        created_court = rest_insert(
            "courts",
            {
                "courtinfo": address,
                "ownerid": req.ownerid,
                "price": req.price,
            },
        )
        court_row = created_court[0] if isinstance(created_court, list) and created_court else created_court
        courtid = int(court_row.get("courtid"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed creating court: {str(e)}")

    courtinfo_payload: dict[str, Any] = {
        "courtid": courtid,
        "name": name,
        "address": geocode.formatted_address or address,
        "latitude": geocode.latitude,
        "longitude": geocode.longitude,
        "venue": venues,
        "images": req.images or [],
        "availability": "Available",
        "city": geocode.city,
        "state": geocode.state,
        "postal_code": geocode.postal_code,
        "accuracy_type": geocode.accuracy_type or geocode.location_type,
        "accuracy_score": geocode.accuracy_score,
    }
    # Remove Nones to reduce REST errors on NOT NULL / unknown columns
    courtinfo_payload = {k: v for k, v in courtinfo_payload.items() if v is not None}

    try:
        created_info = rest_insert("courtinfo", courtinfo_payload)
        info_row = created_info[0] if isinstance(created_info, list) and created_info else created_info
        courtinfoid = int(info_row.get("courtinfoid"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed creating courtinfo: {str(e)}")

    return CourtRegisterResponse(courtid=courtid, courtinfoid=courtinfoid, geocode=geocode)

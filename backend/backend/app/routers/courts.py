import asyncio
import hashlib
import os
import logging
import re
from typing import Any, Optional
from datetime import time

from fastapi import APIRouter, Depends, HTTPException, Query, Request
import httpx
import orjson
from pydantic import BaseModel, Field
from fastapi_cache.decorator import cache

from ..auth import get_current_user
from ..cache_utils import make_key_builder
from ..db import get_http_client, rest_delete, rest_insert, rest_select, rest_update, rest_upsert

router = APIRouter(prefix="/courts", tags=["courts"])

logger = logging.getLogger("courts")

SELECT_COLUMNS = "*"  # adjust if you want a slimmer payload


ALLOWED_VENUES: set[str] = {"Indoor", "Outdoor"}


_TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$")


def _parse_time_hhmm_or_hhmmss(s: str) -> tuple[int, str]:
    """Parse `HH:MM` or `HH:MM:SS`.

    Returns:
      - minutes since midnight (seconds ignored for ordering)
      - normalized time string `HH:MM:SS` for DB insert
    """
    raw = (s or "").strip()
    if not _TIME_RE.match(raw):
        raise ValueError("Invalid time format; expected HH:MM")
    parts = raw.split(":")
    hh = int(parts[0])
    mm = int(parts[1])
    ss = int(parts[2]) if len(parts) == 3 else 0
    # Safety clamp (regex already ensures ranges)
    ss = max(0, min(59, ss))
    return hh * 60 + mm, f"{hh:02d}:{mm:02d}:{ss:02d}"


def _best_effort_cleanup_new_court(*, courtid: Optional[int]) -> None:
    if not courtid:
        return
    # Delete dependents first to satisfy FK constraints.
    # Best-effort only; never mask the original error.
    try:
        rest_delete("courtavailability", {"courtid": courtid})
    except Exception:
        pass

    try:
        playing_rows = rest_select("playingcourt", "playingcourtid", filters={"courtid": courtid})
    except Exception:
        playing_rows = []
    if isinstance(playing_rows, list):
        for r in playing_rows:
            try:
                pid = int(r.get("playingcourtid"))
            except Exception:
                continue
            try:
                rest_delete("playingcourtinfo", {"playingcourtid": pid})
            except Exception:
                pass

    try:
        rest_delete("playingcourt", {"courtid": courtid})
    except Exception:
        pass

    try:
        rest_delete("services", {"courtid": courtid})
    except Exception:
        pass

    for table in ("courtinfo", "courts"):
        try:
            rest_delete(table, {"courtid": courtid})
        except Exception:
            pass


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


class CourtSchedule(BaseModel):
    booking_date: list[str] = Field(default_factory=list)  # e.g. ["Mon", "Tue", ...]
    start_time: str = Field(default="08:00")
    end_time: str = Field(default="22:00")


class PlayingCourtRegister(BaseModel):
    # A "playing court" group (e.g. San 1). We will create a FULL and (optionally) HALF_A/HALF_B rows.
    name: str  # base name (stored in playingcourt.base_name)
    full_price: Optional[float] = None
    allow_half_booking: Optional[bool] = True
    half_a_name: Optional[str] = None
    half_b_name: Optional[str] = None
    half_a_price: Optional[float] = None
    half_b_price: Optional[float] = None
    description: Optional[str] = None
    images: list[str] = Field(default_factory=list)
    half_a_images: list[str] = Field(default_factory=list)
    half_b_images: list[str] = Field(default_factory=list)
    surface: Optional[str] = None  # courtsurface enum value (e.g. concrete/hardwood/synthetic)


class ServiceRegister(BaseModel):
    name: str
    category: str
    price: float
    stock: Optional[int] = 0
    images: list[str] = Field(default_factory=list)


class CourtRegisterRequest(BaseModel):
    name: str
    address: str
    ownerid: int
    venue: str  # Indoor | Outdoor | Both
    images: list[str] = Field(default_factory=list)
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    accuracy_type: Optional[str] = None
    schedule: Optional[CourtSchedule] = None
    allow_half_court: Optional[bool] = True
    playing_courts: list[PlayingCourtRegister] = Field(default_factory=list)
    services: list[ServiceRegister] = Field(default_factory=list)


class CourtRegisterResponse(BaseModel):
    courtid: int
    courtinfoid: int
    geocode: GeocodeResponse


class DistanceMatrixResponse(BaseModel):
    distance_meters: Optional[int] = None
    duration_seconds: Optional[int] = None
    distance_text: Optional[str] = None
    duration_text: Optional[str] = None
    warnings: list[str] = Field(default_factory=list)


class DistanceMatrixBatchDestination(BaseModel):
    dest_lat: float
    dest_lng: float


class DistanceMatrixBatchRequest(BaseModel):
    origin_lat: float
    origin_lng: float
    destinations: list[DistanceMatrixBatchDestination] = Field(default_factory=list)


class DistanceMatrixBatchResponse(BaseModel):
    results: list[DistanceMatrixResponse] = Field(default_factory=list)


_DISTANCE_CACHE_TTL_SECONDS = int(os.getenv("DISTANCE_MATRIX_CACHE_TTL_SECONDS", "300"))
_DISTANCE_BATCH_REQUEST_CACHE_TTL_SECONDS = int(os.getenv("DISTANCE_MATRIX_BATCH_REQUEST_CACHE_TTL_SECONDS", "86400"))
_DISTANCE_COORD_DECIMALS = int(os.getenv("DISTANCE_MATRIX_COORD_DECIMALS", "6"))
_DISTANCE_BATCH_CHUNK_SIZE = int(os.getenv("DISTANCE_BATCH_CHUNK_SIZE", "10"))
_DISTANCE_BATCH_SEMAPHORE_LIMIT = int(os.getenv("DISTANCE_BATCH_SEMAPHORE", "3"))
_distance_batch_semaphore = asyncio.Semaphore(_DISTANCE_BATCH_SEMAPHORE_LIMIT)


def _distance_cache_key(origin: str, destination: str) -> str:
    return f"sportsconnect:distance-matrix:{origin}:{destination}"


def _distance_batch_request_cache_key(origin: str, destinations: list[str]) -> str:
    # Keep order-sensitive hash because response order matches request order.
    payload = {"origin": origin, "destinations": destinations}
    digest = hashlib.sha1(orjson.dumps(payload)).hexdigest()
    return f"sportsconnect:distance-matrix:batch:{digest}"


def _normalize_coord(value: float) -> str:
    return f"{round(float(value), _DISTANCE_COORD_DECIMALS):.{_DISTANCE_COORD_DECIMALS}f}"


def _serialize_distance_result(result: DistanceMatrixResponse) -> bytes:
    return orjson.dumps(result.model_dump())


def _deserialize_distance_result(raw: bytes | str) -> DistanceMatrixResponse | None:
    parsed = orjson.loads(raw)
    if not isinstance(parsed, dict):
        return None
    return DistanceMatrixResponse(**parsed)


def _require_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise HTTPException(status_code=500, detail=f"Missing env var: {name}")
    return v


def _get_env(name: str) -> Optional[str]:
    v = os.getenv(name)
    return v if v and str(v).strip() else None


def _get_goong_geo_key() -> Optional[str]:
    """Preferred env var for Goong Geocoding/Places.

    Uses GOONG_GEO_API_KEY, with a backward-compatible fallback to GOONG_API_KEY.
    """
    return _get_env("GOONG_GEO_API_KEY") or _get_env("GOONG_API_KEY")


def _get_goong_distance_key() -> Optional[str]:
    return _get_env("GOONG_DISTANCE_API_KEY")


async def _goong_distance_matrix(*, origin: str, destination: str) -> DistanceMatrixResponse:
    key_raw = _get_goong_distance_key()
    if not key_raw:
        raise HTTPException(status_code=500, detail="Missing env var: GOONG_DISTANCE_API_KEY")
    key = key_raw.strip().strip('"').strip("'")

    params = {
        "origins": origin,
        "destinations": destination,
        "api_key": key,
    }
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            # Goong docs/examples commonly use /DistanceMatrix; some deployments are case-sensitive.
            r = await client.get("https://rsapi.goong.io/DistanceMatrix", params=params)
            if r.status_code == 404:
                r = await client.get("https://rsapi.goong.io/distancematrix", params=params)
    except httpx.HTTPError as exc:
        logger.warning(
            "[distance_matrix] transport_error provider=goong origin=%r destination=%r error=%s",
            origin,
            destination,
            str(exc),
        )
        raise HTTPException(status_code=502, detail="Goong provider transport error") from exc

    if r.status_code >= 400:
        logger.warning(
            "[distance_matrix] http_error provider=goong status=%s origin=%r destination=%r body=%s",
            r.status_code,
            origin,
            destination,
            (r.text or "")[:500],
        )
        raise HTTPException(status_code=502, detail=f"Goong provider error (HTTP {r.status_code})")

    data = r.json() or {}
    status = str(data.get("status") or "").upper()
    if status and status != "OK":
        if status in {"ZERO_RESULTS", "NOT_FOUND"}:
            raise HTTPException(status_code=400, detail="Distance Matrix returned no results")
        raise HTTPException(status_code=502, detail=f"Goong provider error (status={status})")

    rows = data.get("rows") or []
    first_row = rows[0] if isinstance(rows, list) and rows else None
    elements = first_row.get("elements") if isinstance(first_row, dict) else None
    first_el = elements[0] if isinstance(elements, list) and elements else None
    if not isinstance(first_el, dict):
        raise HTTPException(status_code=400, detail="Distance Matrix returned no results")

    el_status = str(first_el.get("status") or "").upper()
    if el_status and el_status != "OK":
        raise HTTPException(status_code=400, detail=f"Distance Matrix returned no results (status={el_status})")

    distance = first_el.get("distance") if isinstance(first_el.get("distance"), dict) else {}
    duration = first_el.get("duration") if isinstance(first_el.get("duration"), dict) else {}

    dist_val = distance.get("value")
    dur_val = duration.get("value")
    warnings: list[str] = []
    if dist_val is None or dur_val is None:
        warnings.append("Missing distance/duration values")

    try:
        dist_m = int(dist_val) if dist_val is not None else None
    except Exception:
        dist_m = None
    try:
        dur_s = int(dur_val) if dur_val is not None else None
    except Exception:
        dur_s = None

    return DistanceMatrixResponse(
        distance_meters=dist_m,
        duration_seconds=dur_s,
        distance_text=str(distance.get("text")) if distance.get("text") else None,
        duration_text=str(duration.get("text")) if duration.get("text") else None,
        warnings=warnings,
    )


async def _goong_distance_matrix_batch(*, origin: str, destinations: list[str]) -> list[DistanceMatrixResponse]:
    # Goong supports multiple destinations with "lat,lng|lat,lng".
    key_raw = _get_goong_distance_key()
    if not key_raw:
        raise HTTPException(status_code=500, detail="Missing env var: GOONG_DISTANCE_API_KEY")
    key = key_raw.strip().strip('"').strip("'")
    destination = "|".join(destinations)

    params = {
        "origins": origin,
        "destinations": destination,
        "api_key": key,
    }
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get("https://rsapi.goong.io/DistanceMatrix", params=params)
            if r.status_code == 404:
                r = await client.get("https://rsapi.goong.io/distancematrix", params=params)
    except httpx.HTTPError as exc:
        logger.warning(
            "[distance_matrix_batch] transport_error provider=goong origin=%r destinations_count=%s error=%s",
            origin,
            len(destinations),
            str(exc),
        )
        raise HTTPException(status_code=502, detail="Goong provider transport error") from exc

    if r.status_code >= 400:
        logger.warning(
            "[distance_matrix_batch] http_error provider=goong status=%s origin=%r destinations_count=%s body=%s",
            r.status_code,
            origin,
            len(destinations),
            (r.text or "")[:500],
        )
        raise HTTPException(status_code=502, detail=f"Goong provider error (HTTP {r.status_code})")

    data = r.json() or {}
    status = str(data.get("status") or "").upper()
    if status and status != "OK":
        if status in {"ZERO_RESULTS", "NOT_FOUND"}:
            # Return empty-ish results rather than failing entire batch.
            return [DistanceMatrixResponse(warnings=["Distance Matrix returned no results"]) for _ in destinations]
        raise HTTPException(status_code=502, detail=f"Goong provider error (status={status})")

    rows = data.get("rows") or []
    first_row = rows[0] if isinstance(rows, list) and rows else None
    elements = first_row.get("elements") if isinstance(first_row, dict) else None
    elements = elements if isinstance(elements, list) else []

    out: list[DistanceMatrixResponse] = []
    for i in range(len(destinations)):
        el = elements[i] if i < len(elements) and isinstance(elements[i], dict) else None
        if not isinstance(el, dict):
            out.append(DistanceMatrixResponse(warnings=["Missing element result"]))
            continue

        el_status = str(el.get("status") or "").upper()
        if el_status and el_status != "OK":
            out.append(DistanceMatrixResponse(warnings=[f"Element status={el_status}"]))
            continue

        distance = el.get("distance") if isinstance(el.get("distance"), dict) else {}
        duration = el.get("duration") if isinstance(el.get("duration"), dict) else {}
        dist_val = distance.get("value")
        dur_val = duration.get("value")
        warnings: list[str] = []
        if dist_val is None or dur_val is None:
            warnings.append("Missing distance/duration values")

        try:
            dist_m = int(dist_val) if dist_val is not None else None
        except Exception:
            dist_m = None
        try:
            dur_s = int(dur_val) if dur_val is not None else None
        except Exception:
            dur_s = None

        out.append(
            DistanceMatrixResponse(
                distance_meters=dist_m,
                duration_seconds=dur_s,
                distance_text=str(distance.get("text")) if distance.get("text") else None,
                duration_text=str(duration.get("text")) if duration.get("text") else None,
                warnings=warnings,
            )
        )

    return out


def _extract_component(components: list[dict[str, Any]], want: str) -> Optional[str]:
    for c in components or []:
        types = c.get("types") or []
        if want in types:
            return c.get("long_name") or c.get("short_name")
    return None


def _geocode_goong(address: str) -> GeocodeResponse:
    key_raw = _get_goong_geo_key()
    if not key_raw:
        raise HTTPException(status_code=500, detail="Missing env var: GOONG_GEO_API_KEY")
    key = key_raw.strip().strip('"').strip("'")

    client = get_http_client()

    def _call(url: str):
        return client.get(url, params={"address": address, "api_key": key})

    # Goong docs/examples commonly use /Geocode; some deployments are case-sensitive.
    r = _call("https://rsapi.goong.io/Geocode")
    if r.status_code == 404:
        r = _call("https://rsapi.goong.io/geocode")

    if r.status_code >= 400:
        logger.warning(
            "[geocode] http_error provider=goong status=%s address=%r body=%s",
            r.status_code,
            address,
            (r.text or "")[:500],
        )
        raise HTTPException(status_code=502, detail=f"Geocoding provider error (HTTP {r.status_code})")

    data = r.json() or {}
    status = str(data.get("status") or "").upper()
    if status and status != "OK":
        if status in {"ZERO_RESULTS", "NOT_FOUND"}:
            raise HTTPException(status_code=400, detail="Geocoding returned no results")
        raise HTTPException(status_code=502, detail=f"Geocoding provider error (status={status})")

    results = data.get("results") or []
    first = results[0] if isinstance(results, list) and results else None
    if not isinstance(first, dict):
        raise HTTPException(status_code=400, detail="Geocoding returned no results")

    geometry = first.get("geometry") or {}
    location = geometry.get("location") if isinstance(geometry, dict) else None
    location = location if isinstance(location, dict) else {}
    lat = location.get("lat")
    lng = location.get("lng")
    if lat is None or lng is None:
        raise HTTPException(status_code=400, detail="Geocoding result missing lat/lng")

    formatted_address = first.get("formatted_address") or None
    place_id = first.get("place_id") or None
    types = first.get("types") if isinstance(first.get("types"), list) else []

    components = first.get("address_components") if isinstance(first.get("address_components"), list) else []
    city = (
        _extract_component(components, "locality")
        or _extract_component(components, "administrative_area_level_2")
        or None
    )
    state = _extract_component(components, "administrative_area_level_1") or None
    postal_code = _extract_component(components, "postal_code") or None

    location_type = geometry.get("location_type") if isinstance(geometry, dict) else None
    warnings: list[str] = []
    if location_type and str(location_type).lower() not in {"rooftop", "premise", "street_address"}:
        warnings.append(f"Low geocode precision (location_type={location_type})")

    return GeocodeResponse(
        formatted_address=formatted_address,
        latitude=float(lat),
        longitude=float(lng),
        location_type=str(location_type) if location_type else None,
        place_id=str(place_id) if place_id else None,
        types=[str(t) for t in types if t is not None],
        city=str(city) if city else None,
        state=str(state) if state else None,
        postal_code=str(postal_code) if postal_code else None,
        accuracy_type="goong",
        accuracy_score=None,
        warnings=warnings,
    )


def _geocode_nominatim(address: str) -> GeocodeResponse:
    """Global geocoding via OpenStreetMap Nominatim.

    Notes:
    - Must send a descriptive User-Agent per Nominatim usage policy.
    - Results are best-effort and may still be low precision for vague inputs.
    """
    client = get_http_client()
    user_agent = _get_env("NOMINATIM_USER_AGENT") or "sport_app/1.0"

    def _search(q: str, *, limit: int = 5) -> list[dict[str, Any]]:
        r = client.get(
            "https://nominatim.openstreetmap.org/search",
            params={
                "q": q,
                "format": "jsonv2",
                "addressdetails": 1,
                "extratags": 1,
                "namedetails": 1,
                # Restrict to Vietnam only
                "countrycodes": "vn",
                # Do not dedupe so we can pick the best match ourselves
                "dedupe": 0,
                "limit": max(1, min(int(limit), 10)),
            },
            headers={
                "User-Agent": user_agent,
                "Accept-Language": "en",
            },
        )
        if r.status_code >= 400:
            logger.warning(
                "[geocode] http_error provider=nominatim status=%s address=%r body=%s",
                r.status_code,
                q,
                (r.text or "")[:500],
            )
            raise HTTPException(status_code=502, detail=f"Geocoding provider error (HTTP {r.status_code})")
        data = r.json() or []
        return data if isinstance(data, list) else []

    def _simplify_query(q: str) -> Optional[str]:
        raw = (q or "").strip()
        if not raw:
            return None
        tokens = raw.split()
        if len(tokens) < 6:
            return None
        # Heuristic: Nominatim can return 0 results when users add building/complex names.
        # For Vietnam addresses, dropping district/complex words often makes it resolvable.
        stopwords = {
            "the",
            "avenue",
            "tower",
            "block",
            "building",
            "apartment",
            "complex",
            "thap",
            "tháp",
            "quan",
            "quận",
            "phuong",
            "phường",
            "ward",
            "district",
            "city",
            "tp",
            "hcm",
            "hochiminh",
            "saigon",
            "sai",
            "gon",
        }
        cut = None
        for i, t in enumerate(tokens):
            if i <= 3:
                continue
            if t.strip(".,-").lower() in stopwords:
                cut = i
                break
        if cut is None:
            # Fallback: keep a conservative street-ish prefix.
            cut = 4 if tokens[0].isdigit() else 6
        simplified = " ".join(tokens[:cut]).strip()
        return simplified if simplified and simplified != raw else None

    def _has_building_hint(q: str) -> bool:
        ql = (q or "").lower()
        return any(k in ql for k in ("thap", "tháp", "tower", "block", "building", "apartment", "chung cu", "chung cư"))

    def _starts_with_house_number(q: str) -> bool:
        q = (q or "").strip()
        return bool(q) and bool(re.match(r"^\d+[a-zA-Z]?\b", q))

    def _score_candidate(q: str, cand: dict[str, Any]) -> int:
        score = 0
        addr_d = cand.get("address") or {}
        cls = str(cand.get("class") or "").lower()
        typ = str(cand.get("type") or "").lower()
        addresstype = str(cand.get("addresstype") or "").lower()
        house_number = str(addr_d.get("house_number") or "").strip()

        if _has_building_hint(q):
            if cls in {"building", "amenity", "tourism"}:
                score += 40
            if typ in {"building", "apartments", "house", "residential"}:
                score += 30
            if addresstype in {"building", "amenity"}:
                score += 20

        # If user starts with a number, prefer candidates with a house_number.
        if _starts_with_house_number(q):
            score += 25 if house_number else -10

        # Prefer smaller, more specific ranks when available.
        try:
            place_rank = int(cand.get("place_rank"))
            # Higher place_rank in Nominatim usually means more specific.
            score += min(max(place_rank, 0), 30)
        except Exception:
            pass

        # Prefer candidates that actually mention more of the query tokens.
        display_name = str(cand.get("display_name") or "").lower()
        tokens = [t.strip(" ,.-").lower() for t in (q or "").split()]
        tokens = [t for t in tokens if t and len(t) >= 3]
        if tokens:
            hits = sum(1 for t in tokens if t in display_name)
            score += int(20 * (hits / max(len(tokens), 1)))

        return score

    warnings: list[str] = []
    data = _search(address, limit=5)
    candidates = [c for c in data if isinstance(c, dict)]

    if not candidates:
        simplified = _simplify_query(address)
        if simplified:
            data2 = _search(simplified, limit=5)
            candidates = [c for c in data2 if isinstance(c, dict)]
            if candidates:
                warnings.append("No results for full address; used simplified street query")
        if not candidates:
            raise HTTPException(status_code=400, detail="Geocoding returned no results")

    # Pick best candidate by heuristic scoring.
    first = max(candidates, key=lambda c: _score_candidate(address, c))

    lat = first.get("lat")
    lon = first.get("lon")
    if lat is None or lon is None:
        raise HTTPException(status_code=400, detail="Geocoding result missing lat/lng")

    addr = first.get("address") or {}
    country_code = (addr.get("country_code") or "").strip().lower()
    if country_code and country_code != "vn":
        raise HTTPException(status_code=400, detail="Geocoding result is outside Vietnam")

    # Extra safety warnings for "exact location" needs.
    q_has_building_hint = _has_building_hint(address)
    q_has_house_number = _starts_with_house_number(address)
    cls = str(first.get("class") or "").lower()
    typ = str(first.get("type") or "").lower()
    house_number = str(addr.get("house_number") or "").strip()
    formatted_lc = str(first.get("display_name") or "").lower()
    if q_has_house_number and not house_number:
        warnings.append("Query includes a house number, but result has no house_number; location may be approximate")
    if q_has_building_hint and cls not in {"building", "amenity", "tourism"} and typ not in {"building", "apartments", "house", "residential"}:
        warnings.append("Building/tower info not resolved; result is likely street-level")

    # If user specified a tower/block number, but the formatted address doesn't contain it, flag it.
    # Example: "thap 4" but result is "Tháp S06" -> not the same tower.
    ql = (address or "").lower()
    m_tower = re.search(r"\b(?:thap|tháp)\s*([0-9]{1,3})\b", ql)
    if m_tower:
        want_num = m_tower.group(1)
        if want_num and want_num not in formatted_lc:
            warnings.append("Requested tower/block number not reflected in geocode result; cannot guarantee exact building")

    # If user specified District 2 (Quan 2), but the result doesn't mention it, warn.
    if re.search(r"\b(?:quan|quận)\s*2\b", ql) and ("quan 2" not in formatted_lc and "quận 2" not in formatted_lc and "district 2" not in formatted_lc):
        warnings.append("Requested district (Quan 2) not reflected in geocode result; location may be generalized")
    city = addr.get("city") or addr.get("town") or addr.get("village")
    state = addr.get("state")
    postal_code = addr.get("postcode")

    # Nominatim doesn't provide a single "accuracy score"; expose basic type info.
    cls = first.get("class")
    typ = first.get("type")
    types: list[str] = []
    if cls:
        types.append(str(cls))
    if typ and typ not in types:
        types.append(str(typ))

    return GeocodeResponse(
        formatted_address=first.get("display_name") or None,
        latitude=float(lat),
        longitude=float(lon),
        location_type=str(typ) if typ else None,
        place_id=str(first.get("place_id")) if first.get("place_id") is not None else None,
        types=types,
        city=str(city) if city else None,
        state=str(state) if state else None,
        postal_code=str(postal_code) if postal_code else None,
        accuracy_type="nominatim",
        accuracy_score=None,
        warnings=warnings,
    )


_VIETNAMESE_HINT_RE = re.compile(r"\b(viet\s*nam|vietnam|vn)\b", re.IGNORECASE)


def _looks_non_us_address(address: str) -> bool:
    a = (address or "").strip()
    if not a:
        return False
    # Non-ASCII is a strong hint this isn't a typical US street address.
    if any(ord(ch) > 127 for ch in a):
        return True
    # Explicit Vietnam hints.
    if _VIETNAMESE_HINT_RE.search(a):
        return True
    return False


def _geocode_address(address: str) -> GeocodeResponse:
    """Geocode address restricted to Vietnam only.

    This prevents false positives where foreign geocoders return an unrelated US/other
    location for Vietnamese inputs.
    """
    # Prefer Goong when configured; fallback to Nominatim.
    if _get_goong_geo_key():
        return _geocode_goong(address)
    return _geocode_nominatim(address)


class GoongAutocompleteItem(BaseModel):
    description: str
    place_id: str
    main_text: Optional[str] = None
    secondary_text: Optional[str] = None


def _goong_autocomplete(input_text: str, limit: int = 5) -> list[GoongAutocompleteItem]:
    key_raw = _get_goong_geo_key()
    if not key_raw:
        raise HTTPException(status_code=500, detail="Missing env var: GOONG_GEO_API_KEY")
    key = key_raw.strip().strip('"').strip("'")

    client = get_http_client()
    r = client.get(
        "https://rsapi.goong.io/Place/AutoComplete",
        params={
            "input": input_text,
            "api_key": key,
            "limit": max(1, min(int(limit), 10)),
        },
    )
    if r.status_code >= 400:
        logger.warning(
            "[autocomplete] http_error provider=goong status=%s input=%r body=%s",
            r.status_code,
            input_text,
            (r.text or "")[:500],
        )
        raise HTTPException(status_code=502, detail=f"Goong provider error (HTTP {r.status_code})")

    data = r.json() or {}
    status = str(data.get("status") or "").upper()
    if status and status != "OK":
        if status in {"ZERO_RESULTS", "NOT_FOUND"}:
            return []
        raise HTTPException(status_code=502, detail=f"Goong provider error (status={status})")

    preds = data.get("predictions") or []
    out: list[GoongAutocompleteItem] = []
    if isinstance(preds, list):
        for p in preds:
            if not isinstance(p, dict):
                continue
            desc = p.get("description")
            pid = p.get("place_id")
            if not desc or not pid:
                continue
            sf = p.get("structured_formatting") if isinstance(p.get("structured_formatting"), dict) else {}
            out.append(
                GoongAutocompleteItem(
                    description=str(desc),
                    place_id=str(pid),
                    main_text=str(sf.get("main_text")) if sf.get("main_text") else None,
                    secondary_text=str(sf.get("secondary_text")) if sf.get("secondary_text") else None,
                )
            )
    return out


def _goong_place_detail(place_id: str) -> GeocodeResponse:
    key_raw = _get_goong_geo_key()
    if not key_raw:
        raise HTTPException(status_code=500, detail="Missing env var: GOONG_GEO_API_KEY")
    key = key_raw.strip().strip('"').strip("'")

    client = get_http_client()
    r = client.get(
        "https://rsapi.goong.io/Place/Detail",
        params={
            "place_id": place_id,
            "api_key": key,
        },
    )
    if r.status_code >= 400:
        logger.warning(
            "[place_detail] http_error provider=goong status=%s place_id=%r body=%s",
            r.status_code,
            place_id,
            (r.text or "")[:500],
        )
        raise HTTPException(status_code=502, detail=f"Goong provider error (HTTP {r.status_code})")

    data = r.json() or {}
    status = str(data.get("status") or "").upper()
    if status and status != "OK":
        if status in {"ZERO_RESULTS", "NOT_FOUND"}:
            raise HTTPException(status_code=400, detail="Geocoding returned no results")
        raise HTTPException(status_code=502, detail=f"Goong provider error (status={status})")

    result = data.get("result") if isinstance(data.get("result"), dict) else None
    if not isinstance(result, dict):
        raise HTTPException(status_code=400, detail="Geocoding returned no results")

    geometry = result.get("geometry") if isinstance(result.get("geometry"), dict) else {}
    location = geometry.get("location") if isinstance(geometry.get("location"), dict) else {}
    lat = location.get("lat")
    lng = location.get("lng")
    if lat is None or lng is None:
        raise HTTPException(status_code=400, detail="Geocoding result missing lat/lng")

    formatted_address = result.get("formatted_address") or result.get("name") or None

    return GeocodeResponse(
        formatted_address=str(formatted_address) if formatted_address else None,
        latitude=float(lat),
        longitude=float(lng),
        location_type=None,
        place_id=str(place_id),
        types=[],
        city=None,
        state=None,
        postal_code=None,
        accuracy_type="goong_place",
        accuracy_score=None,
        warnings=[],
    )


@router.get("/geocode", response_model=GeocodeResponse)
async def geocode(address: str = Query(..., min_length=3), _: str = Depends(get_current_user)):
    try:
        return _geocode_address(address)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/autocomplete", response_model=list[GoongAutocompleteItem])
async def autocomplete(
    input: str = Query(..., min_length=2),
    limit: int = Query(5, ge=1, le=10),
    _: str = Depends(get_current_user),
):
    try:
        return _goong_autocomplete(input_text=input, limit=limit)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/geocode-place", response_model=GeocodeResponse)
async def geocode_place(place_id: str = Query(..., min_length=3), _: str = Depends(get_current_user)):
    try:
        return _goong_place_detail(place_id=place_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/distance-matrix", response_model=DistanceMatrixResponse)
async def distance_matrix(
    origin_lat: float = Query(...),
    origin_lng: float = Query(...),
    dest_lat: float = Query(...),
    dest_lng: float = Query(...),
    _: str = Depends(get_current_user),
):
    try:
        origin = f"{origin_lat},{origin_lng}"
        destination = f"{dest_lat},{dest_lng}"
        return await _goong_distance_matrix(origin=origin, destination=destination)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/distance-matrix/batch", response_model=DistanceMatrixBatchResponse)
async def distance_matrix_batch(req: DistanceMatrixBatchRequest, request: Request, _: str = Depends(get_current_user)):
    try:
        if not req.destinations:
            return DistanceMatrixBatchResponse(results=[])
        if len(req.destinations) > 25:
            raise HTTPException(status_code=400, detail="Too many destinations; max 25")

        origin = f"{_normalize_coord(req.origin_lat)},{_normalize_coord(req.origin_lng)}"
        destinations = [f"{_normalize_coord(d.dest_lat)},{_normalize_coord(d.dest_lng)}" for d in req.destinations]
        cache_keys = [_distance_cache_key(origin, destination) for destination in destinations]
        batch_cache_key = _distance_batch_request_cache_key(origin, destinations)

        redis = getattr(request.app.state, "redis", None)
        cached_raw: list[Any] = []
        if redis is not None:
            try:
                batch_raw = await redis.get(batch_cache_key)
                if batch_raw is not None:
                    parsed = orjson.loads(batch_raw)
                    if isinstance(parsed, list):
                        return DistanceMatrixBatchResponse(results=[DistanceMatrixResponse(**item) for item in parsed if isinstance(item, dict)])
            except Exception as exc:
                logger.warning("distance_matrix_batch request-cache read failed err=%s", exc)
            try:
                cached_raw = await redis.mget(cache_keys)
            except Exception as exc:
                logger.warning("distance_matrix_batch mget failed err=%s", exc)
                cached_raw = []

        if len(cached_raw) != len(destinations):
            cached_raw = [None] * len(destinations)

        merged_results: list[DistanceMatrixResponse | None] = [None] * len(destinations)
        missing_indices: list[int] = []
        for idx, raw in enumerate(cached_raw):
            if raw is None:
                missing_indices.append(idx)
                continue
            try:
                cached_item = _deserialize_distance_result(raw)
            except Exception:
                cached_item = None
            if cached_item is None:
                missing_indices.append(idx)
            else:
                merged_results[idx] = cached_item

        async def _fetch_chunk(chunk_indices: list[int]) -> tuple[list[int], list[DistanceMatrixResponse]]:
            chunk_destinations = [destinations[i] for i in chunk_indices]
            async with _distance_batch_semaphore:
                chunk_results = await _goong_distance_matrix_batch(origin=origin, destinations=chunk_destinations)
            return chunk_indices, chunk_results

        if missing_indices:
            chunk_size = max(1, _DISTANCE_BATCH_CHUNK_SIZE)
            chunk_tasks = [
                _fetch_chunk(missing_indices[i : i + chunk_size])
                for i in range(0, len(missing_indices), chunk_size)
            ]
            fetched_chunks = await asyncio.gather(*chunk_tasks)

            for chunk_indices, chunk_results in fetched_chunks:
                for offset, idx in enumerate(chunk_indices):
                    if offset < len(chunk_results):
                        merged_results[idx] = chunk_results[offset]

            if redis is not None:
                try:
                    pipe = redis.pipeline(transaction=False)
                    for idx in missing_indices:
                        result = merged_results[idx]
                        if result is not None:
                            pipe.set(cache_keys[idx], _serialize_distance_result(result), ex=_DISTANCE_CACHE_TTL_SECONDS)
                    await pipe.execute()
                except Exception as exc:
                    logger.warning("distance_matrix_batch cache write failed err=%s", exc)

        final_results = [item if item is not None else DistanceMatrixResponse(warnings=["Missing result"]) for item in merged_results]
        if redis is not None:
            try:
                await redis.set(
                    batch_cache_key,
                    orjson.dumps([item.model_dump() for item in final_results]),
                    ex=_DISTANCE_BATCH_REQUEST_CACHE_TTL_SECONDS,
                )
            except Exception as exc:
                logger.warning("distance_matrix_batch request-cache write failed err=%s", exc)
        return DistanceMatrixBatchResponse(results=final_results)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("", response_model=list[dict])
@cache(expire=300, key_builder=make_key_builder("courts"))
async def list_courts():
    try:
        data = rest_select("courts", SELECT_COLUMNS, order={"column": "courtid"})
        return data if isinstance(data, list) else []
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{courtid}", response_model=dict)
@cache(expire=300, key_builder=make_key_builder("courts"))
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


@router.patch("/{courtid}", response_model=dict)
async def update_court(courtid: int, body: dict, current_user: str = Depends(get_current_user)):
    """Update court base fields.

    Security:
    - Requires Bearer token
    - If the token subject is numeric, enforce ownerid == subject
    """
    try:
        numeric_subject = int(current_user) if str(current_user).isdigit() else None
    except Exception:
        numeric_subject = None

    existing = rest_select("courts", "courtid,ownerid", filters={"courtid": courtid}, single=True)
    if not existing:
        raise HTTPException(status_code=404, detail="Court not found")
    if numeric_subject is not None:
        try:
            ownerid = int(existing.get("ownerid"))
        except Exception:
            ownerid = None
        if ownerid is not None and ownerid != numeric_subject:
            raise HTTPException(status_code=403, detail="Not allowed")

    patch: dict[str, Any] = {}

    if isinstance(body, dict) and "courtinfo" in body:
        v = body.get("courtinfo")
        patch["courtinfo"] = (v or "").strip() if isinstance(v, str) else v

    patch = {k: v for k, v in patch.items() if v is not None}
    if not patch:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    try:
        updated = rest_update("courts", {"courtid": courtid}, patch)
        row = updated[0] if isinstance(updated, list) and updated else updated
        return row
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

    # Validate schedule early to avoid partial inserts (courts created without availability).
    allowed_days = {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
    schedule = req.schedule or CourtSchedule()
    schedule_days = [d for d in (schedule.booking_date or []) if isinstance(d, str) and d.strip()]
    schedule_days = [d.strip() for d in schedule_days if d.strip() in allowed_days]
    if not schedule_days:
        schedule_days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    try:
        start_m, start_db = _parse_time_hhmm_or_hhmmss(schedule.start_time)
        end_m, end_db = _parse_time_hhmm_or_hhmmss(schedule.end_time)
        if start_m >= end_m:
            raise ValueError("start_time must be earlier than end_time")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid schedule: {str(e)}")

    geocode = _geocode_address(address)

    has_user_coords = req.latitude is not None and req.longitude is not None
    latitude = float(req.latitude) if has_user_coords else geocode.latitude
    longitude = float(req.longitude) if has_user_coords else geocode.longitude
    accuracy_type = (req.accuracy_type or ("user_selected" if has_user_coords else None) or geocode.accuracy_type or geocode.location_type)

    requested = req.playing_courts or []
    if not requested:
        raise HTTPException(status_code=400, detail="My court is required (playing_courts)")

    for pc in requested:
        if pc.full_price is None:
            raise HTTPException(status_code=400, detail="Missing full_price for a playing court")
        try:
            fp = float(pc.full_price)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid full_price")
        if fp < 0:
            raise HTTPException(status_code=400, detail="full_price must be >= 0")

    courtid: Optional[int] = None
    try:
        court_insert_payload: dict[str, Any] = {
            "courtinfo": address,
            "ownerid": req.ownerid,
            "allow_half_court": True if req.allow_half_court is None else bool(req.allow_half_court),
            # No court verification workflow yet; mark as verified so it appears in map features.
            "status": "verified",
        }
        try:
            created_court = rest_insert("courts", court_insert_payload)
        except Exception as e:
            # Some environments may not have a 'status' column on courts.
            # Fall back gracefully to avoid breaking registrations.
            msg = str(e).lower()
            if ("column" in msg or "unknown" in msg or "does not exist" in msg) and any(
                k in msg for k in ("status", "allow_half_court")
            ):
                # Drop fields that might not exist in older DBs.
                if "status" in msg:
                    court_insert_payload.pop("status", None)
                if "allow_half_court" in msg:
                    court_insert_payload.pop("allow_half_court", None)
                created_court = rest_insert("courts", court_insert_payload)
            else:
                raise
        court_row = created_court[0] if isinstance(created_court, list) and created_court else created_court
        courtid = int(court_row.get("courtid"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed creating court: {str(e)}")

    courtinfo_payload: dict[str, Any] = {
        "courtid": courtid,
        "name": name,
        "address": geocode.formatted_address or address,
        "latitude": latitude,
        "longitude": longitude,
        "venue": venues,
        "images": req.images or [],
        "availability": "Available",
        "accuracy_type": accuracy_type,
    }
    # Remove Nones to reduce REST errors on NOT NULL / unknown columns
    courtinfo_payload = {k: v for k, v in courtinfo_payload.items() if v is not None}

    try:
        created_info = rest_insert("courtinfo", courtinfo_payload)
        info_row = created_info[0] if isinstance(created_info, list) and created_info else created_info
        courtinfoid = int(info_row.get("courtinfoid"))
    except Exception as e:
        _best_effort_cleanup_new_court(courtid=courtid)
        raise HTTPException(status_code=500, detail=f"Failed creating courtinfo: {str(e)}")

    # Create playing courts, playingcourtinfo, availability rows, and optional services.
    # Requires DB migration: public.playingcourt, public.playingcourtinfo and public.courtavailability.playingcourtid.
    try:
        allow_half_global = True if req.allow_half_court is None else bool(req.allow_half_court)
        created_playing_ids: list[int] = []
        for pc in requested:
            base = (pc.name or "").strip()
            if not base:
                raise HTTPException(status_code=400, detail="Playing court name is required")
            surface = (pc.surface or "").strip() or None

            try:
                full_price = float(pc.full_price) if pc.full_price is not None else None
            except Exception:
                full_price = None
            if full_price is None or full_price < 0:
                raise HTTPException(status_code=400, detail=f"Invalid full_price for {base}")

            allow_half_group = True if pc.allow_half_booking is None else bool(pc.allow_half_booking)
            allow_half_group = allow_half_global and allow_half_group

            half_a_name = (pc.half_a_name or "").strip()
            half_b_name = (pc.half_b_name or "").strip()

            half_a_price: Optional[float]
            half_b_price: Optional[float]
            try:
                half_a_price = float(pc.half_a_price) if pc.half_a_price is not None else None
            except Exception:
                half_a_price = None
            try:
                half_b_price = float(pc.half_b_price) if pc.half_b_price is not None else None
            except Exception:
                half_b_price = None

            if allow_half_group:
                if not half_a_name or not half_b_name:
                    raise HTTPException(status_code=400, detail=f"Half court names are required for {base}")
                if half_a_price is None or half_a_price < 0:
                    raise HTTPException(status_code=400, detail=f"Invalid half_a_price for {base}")
                if half_b_price is None or half_b_price < 0:
                    raise HTTPException(status_code=400, detail=f"Invalid half_b_price for {base}")

            group_ids: list[int] = []

            # FULL
            full_payload: dict[str, Any] = {
                "courtid": courtid,
                "base_name": base,
                "name": base,
                "part": "full",
                "allow_half_booking": allow_half_group,
                "price": full_price,
            }
            if surface:
                full_payload["surface"] = surface
            try:
                rows = rest_insert("playingcourt", full_payload)
            except Exception as e:
                msg = str(e).lower()
                if "price" in msg and ("column" in msg or "does not exist" in msg or "unknown" in msg):
                    full_payload.pop("price", None)
                    rows = rest_insert("playingcourt", full_payload)
                else:
                    raise
            row = rows[0] if isinstance(rows, list) and rows else rows
            full_id = int(row.get("playingcourtid"))
            group_ids.append(full_id)

            half_a_id: Optional[int] = None
            half_b_id: Optional[int] = None

            if allow_half_group:
                for half_name, half_price, part in (
                    (half_a_name, half_a_price, "half_a"),
                    (half_b_name, half_b_price, "half_b"),
                ):
                    half_payload: dict[str, Any] = {
                        "courtid": courtid,
                        "base_name": base,
                        "name": half_name,
                        "part": part,
                        "allow_half_booking": allow_half_group,
                        "price": half_price,
                    }
                    if surface:
                        half_payload["surface"] = surface
                    try:
                        hrows = rest_insert("playingcourt", half_payload)
                    except Exception as e:
                        msg = str(e).lower()
                        if "price" in msg and ("column" in msg or "does not exist" in msg or "unknown" in msg):
                            half_payload.pop("price", None)
                            hrows = rest_insert("playingcourt", half_payload)
                        else:
                            raise
                    hrow = hrows[0] if isinstance(hrows, list) and hrows else hrows
                    hid = int(hrow.get("playingcourtid"))
                    group_ids.append(hid)
                    if part == "half_a":
                        half_a_id = hid
                    elif part == "half_b":
                        half_b_id = hid

            # Info rows (allow separate images per part)
            full_images = [x for x in (pc.images or []) if isinstance(x, str) and x.strip()]
            half_a_images = [x for x in (pc.half_a_images or []) if isinstance(x, str) and x.strip()]
            half_b_images = [x for x in (pc.half_b_images or []) if isinstance(x, str) and x.strip()]

            info_common: dict[str, Any] = {}

            try:
                rest_upsert("playingcourtinfo", {"playingcourtid": full_id, "images": full_images, **info_common}, on_conflict="playingcourtid")
            except Exception:
                pass

            if allow_half_group:
                try:
                    if half_a_id is not None:
                        rest_upsert(
                            "playingcourtinfo",
                            {
                                "playingcourtid": half_a_id,
                                "images": (half_a_images or full_images),
                                **info_common,
                            },
                            on_conflict="playingcourtid",
                        )
                except Exception:
                    pass

                try:
                    if half_b_id is not None:
                        rest_upsert(
                            "playingcourtinfo",
                            {
                                "playingcourtid": half_b_id,
                                "images": (half_b_images or full_images),
                                **info_common,
                            },
                            on_conflict="playingcourtid",
                        )
                except Exception:
                    pass

            created_playing_ids.extend(group_ids)

        # Availability rows (one per created playing court)
        for pid in created_playing_ids:
            rest_insert(
                "courtavailability",
                {
                    "courtid": courtid,
                    "playingcourtid": pid,
                    "start_time": start_db,
                    "end_time": end_db,
                    "booking_date": schedule_days,
                    "status": "available",
                },
            )

        # Optional services
        for s in (req.services or []):
            svc_name = (s.name or "").strip()
            if not svc_name:
                raise HTTPException(status_code=400, detail="Service name is required")
            category = (s.category or "").strip()
            if not category:
                raise HTTPException(status_code=400, detail="Service category is required")
            try:
                price = float(s.price)
            except Exception:
                raise HTTPException(status_code=400, detail="Invalid service price")
            if price < 0:
                raise HTTPException(status_code=400, detail="Service price must be >= 0")
            try:
                stock = int(s.stock) if s.stock is not None else 0
            except Exception:
                stock = 0
            if stock < 0:
                raise HTTPException(status_code=400, detail="Service stock must be >= 0")

            svc_images = [x for x in (s.images or []) if isinstance(x, str) and x.strip()]
            payload: dict[str, Any] = {
                "courtid": courtid,
                "name": svc_name,
                "category": category,
                "price": price,
                "stock": stock,
                "status": "active",
                "images": svc_images,
            }
            try:
                rest_insert("services", payload)
            except Exception as e:
                msg = str(e).lower()
                if "images" in msg and ("column" in msg or "does not exist" in msg or "unknown" in msg):
                    payload.pop("images", None)
                    rest_insert("services", payload)
                else:
                    raise
    except Exception as e:
        _best_effort_cleanup_new_court(courtid=courtid)
        raise HTTPException(status_code=500, detail=f"Failed creating playing courts / availability: {str(e)}")

    return CourtRegisterResponse(courtid=courtid, courtinfoid=courtinfoid, geocode=geocode)

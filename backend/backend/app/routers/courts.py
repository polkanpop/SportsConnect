import os
import logging
import re
from typing import Any, Optional
from datetime import time

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ..auth import get_current_user
from ..db import get_http_client, rest_delete, rest_insert, rest_select

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
    for table in ("courtavailability", "courtinfo", "courts"):
        try:
            rest_delete(table, {"courtid": courtid})
        except Exception:
            # Best-effort only; never mask the original error.
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


class CourtRegisterRequest(BaseModel):
    name: str
    address: str
    ownerid: int
    price: float = Field(default=0, ge=0)
    venue: str  # Indoor | Outdoor | Both
    images: list[str] = Field(default_factory=list)
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    accuracy_type: Optional[str] = None
    schedule: Optional[CourtSchedule] = None


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


def _goong_distance_matrix(*, origin: str, destination: str) -> DistanceMatrixResponse:
    key_raw = _get_goong_distance_key()
    if not key_raw:
        raise HTTPException(status_code=500, detail="Missing env var: GOONG_DISTANCE_API_KEY")
    key = key_raw.strip().strip('"').strip("'")

    client = get_http_client()

    def _call(url: str):
        return client.get(
            url,
            params={
                "origins": origin,
                "destinations": destination,
                "api_key": key,
            },
        )

    # Goong docs/examples commonly use /DistanceMatrix; some deployments are case-sensitive.
    r = _call("https://rsapi.goong.io/DistanceMatrix")
    if r.status_code == 404:
        r = _call("https://rsapi.goong.io/distancematrix")

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


def _goong_distance_matrix_batch(*, origin: str, destinations: list[str]) -> list[DistanceMatrixResponse]:
    # Goong supports multiple destinations with "lat,lng|lat,lng".
    key_raw = _get_goong_distance_key()
    if not key_raw:
        raise HTTPException(status_code=500, detail="Missing env var: GOONG_DISTANCE_API_KEY")
    key = key_raw.strip().strip('"').strip("'")

    client = get_http_client()
    destination = "|".join(destinations)

    def _call(url: str):
        return client.get(
            url,
            params={
                "origins": origin,
                "destinations": destination,
                "api_key": key,
            },
        )

    r = _call("https://rsapi.goong.io/DistanceMatrix")
    if r.status_code == 404:
        r = _call("https://rsapi.goong.io/distancematrix")

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
        return _goong_distance_matrix(origin=origin, destination=destination)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/distance-matrix/batch", response_model=DistanceMatrixBatchResponse)
async def distance_matrix_batch(req: DistanceMatrixBatchRequest, _: str = Depends(get_current_user)):
    try:
        if not req.destinations:
            return DistanceMatrixBatchResponse(results=[])
        if len(req.destinations) > 25:
            raise HTTPException(status_code=400, detail="Too many destinations; max 25")
        origin = f"{req.origin_lat},{req.origin_lng}"
        destinations = [f"{d.dest_lat},{d.dest_lng}" for d in req.destinations]
        results = _goong_distance_matrix_batch(origin=origin, destinations=destinations)
        return DistanceMatrixBatchResponse(results=results)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("", response_model=list[dict])
async def list_courts():
    try:
        data = rest_select("courts", SELECT_COLUMNS, order={"column": "courtid"})
        return data if isinstance(data, list) else []
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{courtid}", response_model=dict)
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

    courtid: Optional[int] = None
    try:
        court_insert_payload: dict[str, Any] = {
            "courtinfo": address,
            "ownerid": req.ownerid,
            "price": req.price,
            # No court verification workflow yet; mark as verified so it appears in map features.
            "status": "verified",
        }
        try:
            created_court = rest_insert("courts", court_insert_payload)
        except Exception as e:
            # Some environments may not have a 'status' column on courts.
            # Fall back gracefully to avoid breaking registrations.
            msg = str(e).lower()
            if "status" in msg and ("column" in msg or "unknown" in msg or "does not exist" in msg):
                court_insert_payload.pop("status", None)
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

    try:
        rest_insert(
            "courtavailability",
            {
                "courtid": courtid,
                "start_time": start_db,
                "end_time": end_db,
                "booking_date": schedule_days,
                "status": "available",
            },
        )
    except Exception as e:
        _best_effort_cleanup_new_court(courtid=courtid)
        raise HTTPException(status_code=500, detail=f"Failed creating court availability: {str(e)}")

    return CourtRegisterResponse(courtid=courtid, courtinfoid=courtinfoid, geocode=geocode)

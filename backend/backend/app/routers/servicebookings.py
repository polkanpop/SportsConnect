from fastapi import APIRouter, HTTPException, Query, Depends, Body
from typing import Any
import logging

from ..auth import get_current_user
from ..db import rest_insert, rest_select

router = APIRouter(prefix="/servicebookings", tags=["servicebookings"])

# Use Uvicorn's logger so warnings show up in typical deployments.
logger = logging.getLogger("uvicorn.error")


def _as_nonempty_str(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip()
        return s or None
    return str(v).strip() or None


def _coerce_intish(v: Any) -> int | None:
    """Parse an int from common shapes: int/float/'123'/'123.0'. Returns None if not parseable."""
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        if v != v:  # NaN
            return None
        return int(v)
    s = _as_nonempty_str(v)
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        try:
            f = float(s)
            if f != f:
                return None
            return int(f)
        except ValueError:
            return None


def _insert_rows(table: str, rows: Any):
    try:
        resp = rest_insert(table, rows)
    except RuntimeError as e:
        sample = None
        if isinstance(rows, list) and rows:
            sample = rows[0]
        logger.warning("supabase_insert_failed table=%s err=%s sample=%s", table, str(e), sample)
        raise
    if not isinstance(resp, list):
        raise HTTPException(status_code=500, detail="Insert did not return list representation")
    return resp


@router.get("", response_model=list[dict])
def list_service_bookings(
    courtbookingid: int | None = Query(None),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """List service booking line items.

    Note: underlying table name may be singular/plural depending on your schema.
    """
    filters = {}
    if courtbookingid is not None:
        filters["courtbookingid"] = courtbookingid
    try:
        data = rest_select("servicebooking", "*", filters=filters or None)
    except RuntimeError:
        data = rest_select("servicebookings", "*", filters=filters or None)
    if isinstance(data, list):
        return data[offset : offset + limit]
    return []


@router.post("", response_model=list[dict])
def create_service_bookings(body: Any = Body(...), current_user: str = Depends(get_current_user)):
    """Create service booking line items.

        Expected payload from client: a JSON array of rows like:
            [{"courtbookingid": 123, "serviceid": 1, "quantity": 2, "unit_price": 5000, "paymentid": 10}, ...]

    This endpoint is intentionally permissive while the schema is being finalized.
    """
    try:
        rows = body
        # Accept both a raw array payload and wrapper objects like {"rows": [...]}.
        if isinstance(rows, dict):
            rows = rows.get("rows", rows.get("items", rows.get("data")))
        # Accept a single object row as a convenience.
        if isinstance(rows, dict):
            rows = [rows]
        if not isinstance(rows, list) or not rows:
            logger.warning("reject: empty_or_not_list type=%s sample=%s", type(body).__name__, (list(body.keys()) if isinstance(body, dict) else (rows[0] if isinstance(rows, list) and rows else None)))
            raise HTTPException(
                status_code=422,
                detail={
                    "message": "Body must be a non-empty list (or {rows:[...]})",
                    "received_type": type(body).__name__,
                },
            )

        # Minimal validation to avoid garbage inserts.
        cleaned: list[dict] = []
        dropped = {
            "non_dict": 0,
            "missing_required": 0,
            "parse_error": 0,
            "non_positive": 0,
        }
        for r in rows:
            if not isinstance(r, dict):
                dropped["non_dict"] += 1
                continue
            cbid = r.get("courtbookingid", r.get("courtBookingId"))
            sid = r.get("serviceid", r.get("serviceId"))
            qty = r.get("quantity", r.get("qty"))
            unit_price = r.get("unit_price", r.get("unitPrice"))
            paymentid = r.get("paymentid", r.get("paymentId"))
            if cbid is None or sid is None or qty is None:
                dropped["missing_required"] += 1
                continue
            try:
                qty_i = _coerce_intish(qty)
                unit_price_n = float(unit_price) if unit_price is not None else 0.0
            except ValueError:
                dropped["parse_error"] += 1
                continue

            # Schema uses SERIAL integer keys; only accept integer-ish values.
            cbid_i = _coerce_intish(cbid)
            sid_i = _coerce_intish(sid)

            if qty_i is None:
                dropped["parse_error"] += 1
                continue

            if qty_i <= 0:
                dropped["non_positive"] += 1
                continue

            if cbid_i is None or sid_i is None:
                dropped["parse_error"] += 1
                continue

            # If numeric IDs are used, enforce positivity.
            if cbid_i is not None and cbid_i <= 0:
                dropped["non_positive"] += 1
                continue
            if sid_i is not None and sid_i <= 0:
                dropped["non_positive"] += 1
                continue

            # DB schema requires unit_price NOT NULL; default to 0.0 if missing/invalid.
            if unit_price_n != unit_price_n:  # NaN
                unit_price_n = 0.0

            row_out: dict[str, Any] = {
                "courtbookingid": cbid_i,
                "serviceid": sid_i,
                "quantity": qty_i,
                "unit_price": unit_price_n,
            }
            if paymentid is not None:
                paymentid_i = _coerce_intish(paymentid)
                if paymentid_i is not None and paymentid_i > 0:
                    row_out["paymentid"] = paymentid_i

            cleaned.append(row_out)

        if not cleaned:
            sample = rows[0] if rows else None
            logger.warning("reject: no_valid_rows dropped=%s sample=%s", dropped, sample)
            raise HTTPException(
                status_code=422,
                detail={
                    "message": "No valid rows to insert",
                    "dropped": dropped,
                    "sample": sample,
                    "expected": {
                        "required": ["courtbookingid", "serviceid", "quantity"],
                        "optional": ["unit_price", "unitPrice", "paymentid"],
                    },
                },
            )

        logger.info("servicebookings_insert attempting count=%d sample=%s", len(cleaned), cleaned[0] if cleaned else None)
        try:
            return _insert_rows("servicebooking", cleaned)
        except RuntimeError:
            return _insert_rows("servicebookings", cleaned)
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

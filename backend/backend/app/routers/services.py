from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi_cache.decorator import cache
from typing import Any

from ..auth import get_current_user
from ..cache_utils import invalidate_namespace, make_key_builder
from ..db import rest_delete, rest_insert, rest_select, rest_update

router = APIRouter(prefix="/services", tags=["services"])


def _numeric_subject(current_user: str) -> int | None:
    try:
        return int(current_user) if str(current_user).isdigit() else None
    except Exception:
        return None


def _enforce_owner_by_courtid(*, courtid: int, current_user: str) -> None:
    numeric = _numeric_subject(current_user)
    if numeric is None:
        raise HTTPException(status_code=403, detail="Not allowed")
    court = rest_select("courts", "courtid,ownerid", filters={"courtid": courtid}, single=True)
    if not court:
        raise HTTPException(status_code=404, detail="Court not found")
    try:
        ownerid = int(court.get("ownerid"))
    except Exception:
        ownerid = None
    if ownerid is not None and ownerid != numeric:
        raise HTTPException(status_code=403, detail="Not allowed")


def _enforce_owner_by_serviceid(*, serviceid: int, current_user: str) -> dict:
    svc = rest_select("services", "*", filters={"serviceid": serviceid}, single=True)
    if not svc:
        raise HTTPException(status_code=404, detail="Service not found")
    try:
        courtid = int(svc.get("courtid"))
    except Exception:
        courtid = None
    if courtid is None:
        raise HTTPException(status_code=404, detail="Court not found")
    _enforce_owner_by_courtid(courtid=courtid, current_user=current_user)
    return svc


@router.get("", response_model=list[dict])
@cache(expire=180, key_builder=make_key_builder("services"))
def list_services(
    courtid: int | None = Query(None),
    status: str | None = Query(None),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """List services (optionally filtered by courtid/status)."""
    filters: dict[str, Any] = {}
    if courtid is not None:
        filters["courtid"] = courtid
    if status is not None:
        filters["status"] = status

    data = rest_select("services", "*", filters=filters or None)
    if not isinstance(data, list):
        return []
    return data[offset : offset + limit]


@router.post("", response_model=dict)
async def create_service(body: dict, current_user: str = Depends(get_current_user)):
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")

    try:
        courtid = int(body.get("courtid"))
    except Exception:
        raise HTTPException(status_code=422, detail="courtid is required")

    _enforce_owner_by_courtid(courtid=courtid, current_user=current_user)

    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    category = str(body.get("category") or "").strip()
    if not category:
        raise HTTPException(status_code=422, detail="category is required")

    try:
        price = float(body.get("price"))
    except Exception:
        raise HTTPException(status_code=422, detail="price is required")
    if price < 0:
        raise HTTPException(status_code=422, detail="price must be >= 0")

    try:
        stock = int(body.get("stock")) if body.get("stock") is not None else 0
    except Exception:
        stock = 0
    if stock < 0:
        raise HTTPException(status_code=422, detail="stock must be >= 0")

    status = str(body.get("status") or "active").strip() or "active"
    images_raw = body.get("images")
    images: list[str] = []
    if isinstance(images_raw, list):
        images = [str(x).strip() for x in images_raw if isinstance(x, str) and str(x).strip()]

    payload: dict[str, Any] = {
        "courtid": courtid,
        "name": name,
        "category": category,
        "price": price,
        "stock": stock,
        "status": status,
        "images": images,
    }

    try:
        created = rest_insert("services", payload)
    except Exception as e:
        msg = str(e).lower()
        if "images" in msg and ("column" in msg or "does not exist" in msg or "unknown" in msg):
            payload.pop("images", None)
            created = rest_insert("services", payload)
        else:
            raise

    row = created[0] if isinstance(created, list) and created else created
    await invalidate_namespace("services")
    return row or payload


@router.patch("/{serviceid}", response_model=dict)
async def patch_service(serviceid: int, body: dict, current_user: str = Depends(get_current_user)):
    _enforce_owner_by_serviceid(serviceid=serviceid, current_user=current_user)
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")

    payload = dict(body)
    payload.pop("serviceid", None)
    payload.pop("courtid", None)
    if not payload:
        raise HTTPException(status_code=422, detail="No fields to update")

    updated = rest_update("services", {"serviceid": serviceid}, payload)
    await invalidate_namespace("services")
    if isinstance(updated, list) and updated:
        return updated[0]
    return payload


@router.delete("/{serviceid}", response_model=dict)
async def delete_service(serviceid: int, current_user: str = Depends(get_current_user)):
    _enforce_owner_by_serviceid(serviceid=serviceid, current_user=current_user)
    deleted = rest_delete("services", {"serviceid": serviceid})
    await invalidate_namespace("services")
    if isinstance(deleted, list) and deleted:
        return {"deleted": True, "row": deleted[0]}
    return {"deleted": True}

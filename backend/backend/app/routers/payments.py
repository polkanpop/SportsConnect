from fastapi import APIRouter, HTTPException, Query
from ..db import rest_select, rest_upsert

router = APIRouter(prefix="/payments", tags=["payments"])

PRIMARY_KEY = "paymentid"

@router.get("", response_model=list[dict])
def list_payments(status: str | None = Query(None), method: str | None = Query(None), limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
    try:
        filters: dict[str, str] = {}
        if status is not None:
            filters["status"] = status
        if method is not None:
            filters["method"] = method
        data = rest_select("payments", "*", filters=filters or None, order={"column": PRIMARY_KEY})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{paymentid}", response_model=dict)
def get_payment(paymentid: int):
    try:
        row = rest_select("payments", "*", filters={PRIMARY_KEY: paymentid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Payment not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_payment(body: dict):
    try:
        resp = rest_upsert("payments", body)
        return resp[0] if isinstance(resp, list) and resp else body
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

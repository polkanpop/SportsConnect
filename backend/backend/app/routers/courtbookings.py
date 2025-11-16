from fastapi import APIRouter, HTTPException, Query, Depends
from ..db import rest_select, rest_insert
from ..auth import get_current_user

router = APIRouter(prefix="/courtbookings", tags=["bookings"])  # Route keeps plural for consistency, underlying table is singular

PRIMARY_KEY = "courtbookingid"

@router.get("", response_model=list[dict])
def list_court_bookings(userid: int | None = Query(None), status: str | None = Query(None), limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    try:
        filters = {}
        if userid is not None:
            filters["userid"] = userid
        if status is not None:
            filters["status"] = status
        # Table name in schema is singular 'courtbooking'
        data = rest_select("courtbooking", "*", filters=filters or None, order={"column": PRIMARY_KEY})
        if isinstance(data, list):
            data = data[offset: offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{courtbookingid}", response_model=dict)
def get_court_booking(courtbookingid: int):
    try:
        row = rest_select("courtbooking", "*", filters={PRIMARY_KEY: courtbookingid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Court booking not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("", response_model=dict)
def create_court_booking(body: dict, current_user: str = Depends(get_current_user)):
    """Create a court booking with single-booking-per-user enforcement.

    New logic:
      - A user may only have ONE booking (any status) in the system. Adjust rule by filtering on date or availability if needed.
      - Optional `note` field is accepted and persisted when present.
    """
    try:
        userid = body.get("userid") or current_user
        # Single booking rule: check existing rows for userid
        existing = rest_select("courtbooking", PRIMARY_KEY, filters={"userid": userid})
        if isinstance(existing, list) and existing:
            raise HTTPException(status_code=403, detail="User already has a booking and cannot create another.")

        # Build payload; include note if provided
        payload = {
            **body,
            "userid": userid,
        }
        # Pass through note if present (nullable column)
        if "note" in body:
            payload["note"] = body.get("note")

        resp = rest_insert("courtbooking", payload)
        if not isinstance(resp, list) or not resp:
            raise HTTPException(status_code=500, detail="Insert did not return representation; check Supabase headers/policies")
        row = resp[0]
        if PRIMARY_KEY not in row:
            raise HTTPException(status_code=500, detail="Insert succeeded but missing primary key in response")
        return row
    except HTTPException:
        raise
    except RuntimeError as e:
        if "409" in str(e):
            raise HTTPException(status_code=409, detail="Duplicate primary key on insert; sequence likely misaligned")
        raise HTTPException(status_code=400, detail=str(e))
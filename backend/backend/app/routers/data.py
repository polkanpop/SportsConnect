from fastapi import APIRouter, HTTPException
from typing import Any, Dict
from ..db import rest_select

router = APIRouter(prefix="/data", tags=["data"])

# Mapping of tables to their primary key column name.
# Extend this dict as needed; values are kept simple for read-only listing.
TABLES: Dict[str, Dict[str, str]] = {
    # Core court & availability
    "courts": {"pk": "courtid"},
    "courtinfo": {"pk": "courtinfoid"},
    "courtbookings": {"pk": "courtbookingid"},
    "courtavailability": {"pk": "availabilityid"},
    # Events
    "eventbookings": {"pk": "eventbookingid"},
    "eventinfo": {"pk": "eventinfoid"},
    "events": {"pk": "eventid"},
    # Training sessions
    "trainingsessions": {"pk": "sessionid"},
    "trainingsessioninfo": {"pk": "sessioninfoid"},
    "tsbookings": {"pk": "tsbookingid"},
    # Users & auth
    "userinfo": {"pk": "infoid"},
    "userlogin": {"pk": "loginid"},
    "users": {"pk": "userid"},
    # Misc
    "notifications": {"pk": "notificationid"},
    "payments": {"pk": "paymentid"},
    "reviews": {"pk": "reviewid"},
    "favouritecourts": {"pk": "favouriteid"},
}

@router.get("/{table}", response_model=list[dict])
def list_rows(table: str):
    meta = TABLES.get(table)
    if not meta:
        raise HTTPException(status_code=404, detail="Unknown table")
    try:
        data = rest_select(table, "*", order={"column": meta["pk"]})
        # Ensure each item is a dict (PostgREST returns list[dict])
        return [d for d in data if isinstance(d, dict)]
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{table}/{pk}", response_model=dict)
def get_row(table: str, pk: str):
    meta = TABLES.get(table)
    if not meta:
        raise HTTPException(status_code=404, detail="Unknown table")
    pk_col = meta["pk"]
    try:
        data = rest_select(table, "*", filters={pk_col: pk}, single=True)
        if not data:
            raise HTTPException(status_code=404, detail="Row not found")
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

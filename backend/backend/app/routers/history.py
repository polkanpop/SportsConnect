from fastapi import APIRouter, HTTPException, Query
from ..db import rest_select

router = APIRouter(prefix="/history", tags=["history"])

@router.get("", response_model=dict)
def user_history(userid: int = Query(..., description="User id to aggregate history")):
    """Aggregate a user's court bookings, event bookings, and training sessions into a single payload."""
    try:
        court = rest_select("courtbookings", "*", filters={"userid": userid})
        event = rest_select("eventbookings", "*", filters={"userid": userid})
        sessions = rest_select("trainingsessions", "*")  # no direct userid; derive via courtbooking if needed
        # Filter sessions to only those whose courtbooking belongs to user (if courtbookingid matches)
        session_map = {c.get("courtbookingid"): c.get("userid") for c in court if isinstance(c, dict)}
        user_sessions = [s for s in sessions if session_map.get(s.get("courtbookingid")) == userid]
        return {
            "userid": userid,
            "court_bookings": court if isinstance(court, list) else [],
            "event_bookings": event if isinstance(event, list) else [],
            "training_sessions": user_sessions,
        }
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
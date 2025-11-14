from fastapi import APIRouter, HTTPException, Query, Request
from ..rate_limit import limiter
from ..db import rest_select, rest_upsert, rest_delete
from ..models import FavouriteCourt, FavouriteCourtCreate

router = APIRouter(prefix="/favouritecourts", tags=["favouritecourts"])


@router.get("", response_model=list[FavouriteCourt])
async def list_favourite_courts(userid: int | None = Query(default=None), ids_only: bool = Query(default=False)):
    """Public list of favourite courts. Optionally filter by userid; ids_only returns only courtids."""
    try:
        select = "courtid" if ids_only else "favouriteid,userid,courtid"
        filters = {"userid": userid} if userid is not None else None
        data = rest_select("favouritecourts", select, filters=filters)
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("", response_model=FavouriteCourt)
@limiter.limit("12/minute")
async def add_favourite_court(request: Request, body: FavouriteCourtCreate):
    """Idempotent add: returns existing favourite if (userid,courtid) already present.

    Performs existence checks for referenced user & court to avoid 500 errors from FK violations.
    Returns 400 with a clear message if either does not exist.
    """
    try:
        # Attach userid for per-user rate limiting
        request.state.user_id = body.userid
        # Validate referenced user exists
        user_row = rest_select("users", "userid", filters={"userid": body.userid}, single=True)
        if user_row is None:
            raise HTTPException(status_code=400, detail=f"User {body.userid} does not exist")
        # Validate referenced court exists
        court_row = rest_select("courts", "courtid", filters={"courtid": body.courtid}, single=True)
        if court_row is None:
            raise HTTPException(status_code=400, detail=f"Court {body.courtid} does not exist")

        # Check for existing favourite first (manual uniqueness until DB constraint added)
        existing = rest_select(
            "favouritecourts",
            "favouriteid,userid,courtid",
            filters={"userid": body.userid, "courtid": body.courtid},
            single=False,
        )
        if isinstance(existing, list) and existing:
            return existing[0]
        payload = {"userid": body.userid, "courtid": body.courtid}
        resp = rest_upsert("favouritecourts", payload)
        if isinstance(resp, list) and resp:
            return resp[0]
        return {"favouriteid": -1, **payload}
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/toggle")
@limiter.limit("20/minute")  # toggle can be a bit higher to avoid frustration
async def toggle_favourite(request: Request, body: FavouriteCourtCreate):
    """Toggle favourite for a user/court pair. Returns action and record.

    Response shape:
    { action: "added"|"removed", favourite: FavouriteCourt | None }
    Performs existence checks for user & court.
    """
    try:
        request.state.user_id = body.userid
        user_row = rest_select("users", "userid", filters={"userid": body.userid}, single=True)
        if user_row is None:
            raise HTTPException(status_code=400, detail=f"User {body.userid} does not exist")
        court_row = rest_select("courts", "courtid", filters={"courtid": body.courtid}, single=True)
        if court_row is None:
            raise HTTPException(status_code=400, detail=f"Court {body.courtid} does not exist")

        existing = rest_select(
            "favouritecourts",
            "favouriteid,userid,courtid",
            filters={"userid": body.userid, "courtid": body.courtid},
            single=False,
        )
        if isinstance(existing, list) and existing:
            fav_id = existing[0]["favouriteid"]
            rest_delete("favouritecourts", {"favouriteid": fav_id})
            return {"action": "removed", "favourite": None}
        payload = {"userid": body.userid, "courtid": body.courtid}
        resp = rest_upsert("favouritecourts", payload)
        favourite = resp[0] if isinstance(resp, list) and resp else {"favouriteid": -1, **payload}
        return {"action": "added", "favourite": favourite}
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{favouriteid}")
@limiter.limit("12/minute")
async def remove_favourite_court(request: Request, favouriteid: int):
    """Public delete favourite by primary key favouriteid."""
    try:
        # Optionally scope by user if we can resolve it quickly
        row = rest_select("favouritecourts", "userid", filters={"favouriteid": favouriteid}, single=True)
        if isinstance(row, dict) and "userid" in row:
            request.state.user_id = row["userid"]
        resp = rest_delete("favouritecourts", {"favouriteid": favouriteid})
        return {"deleted": True, "count": len(resp) if isinstance(resp, list) else 0}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

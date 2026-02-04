from fastapi import APIRouter, HTTPException, Query, Depends
from ..db import rest_select, rest_insert, rest_delete
from ..auth import get_current_user

router = APIRouter(prefix="/blocklist", tags=["blocklist"])


def _as_int(v, name: str) -> int:
    try:
        return int(v)
    except Exception:
        raise HTTPException(status_code=400, detail=f"{name} must be numeric")


def _require_owner(targettype: str, targetid: int, current_user: str) -> None:
    """Only the event organizer / session coach can mutate block list."""
    auth_userid: int | None
    try:
        auth_userid = int(current_user)
    except Exception:
        auth_userid = None

    if auth_userid is None:
        raise HTTPException(status_code=401, detail="Invalid auth subject")

    tt = str(targettype or "").lower().strip()
    if tt == "event":
        ev = rest_select("events", "eventid,organizerid", filters={"eventid": targetid}, single=True)
        if not ev:
            raise HTTPException(status_code=404, detail="Event not found")
        if int(ev.get("organizerid")) != auth_userid:
            raise HTTPException(status_code=403, detail="Not allowed")
        return

    if tt == "trainingsession":
        sess = rest_select("trainingsessions", "sessionid,coachid", filters={"sessionid": targetid}, single=True)
        if not sess:
            raise HTTPException(status_code=404, detail="Training session not found")
        if int(sess.get("coachid")) != auth_userid:
            raise HTTPException(status_code=403, detail="Not allowed")
        return

    raise HTTPException(status_code=400, detail="targettype must be 'event' or 'trainingsession'")


@router.get("", response_model=list[dict])
def list_block_list(
    targettype: str | None = Query(None),
    targetid: int | None = Query(None),
    blocked_userid: int | None = Query(None),
    blocked_by_userid: int | None = Query(None),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    try:
        filters: dict[str, int | str] = {}
        if targettype is not None:
            filters["targettype"] = targettype
        if targetid is not None:
            filters["targetid"] = targetid
        if blocked_userid is not None:
            filters["blocked_userid"] = blocked_userid
        if blocked_by_userid is not None:
            filters["blocked_by_userid"] = blocked_by_userid
        data = rest_select("block_list", "*", filters=filters or None, order={"column": "blockid"})
        if isinstance(data, list):
            data = data[offset : offset + limit]
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("", response_model=dict)
def create_block(body: dict, current_user: str = Depends(get_current_user)):
    try:
        targettype = str(body.get("targettype") or "").lower().strip()
        targetid = _as_int(body.get("targetid"), "targetid")
        blocked_userid = _as_int(body.get("blocked_userid"), "blocked_userid")

        _require_owner(targettype, targetid, current_user)

        blocked_by_userid = _as_int(current_user, "blocked_by_userid")

        payload = {
            "targettype": targettype,
            "targetid": targetid,
            "blocked_userid": blocked_userid,
            "blocked_by_userid": blocked_by_userid,
        }

        try:
            resp = rest_insert("block_list", payload)
        except Exception as e:
            # Most common: unique constraint violation.
            msg = str(e)
            if "duplicate" in msg.lower() or "409" in msg:
                raise HTTPException(status_code=409, detail="User already blocked")
            raise

        return resp[0] if isinstance(resp, list) and resp else payload
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("", response_model=dict)
def delete_block(
    targettype: str = Query(...),
    targetid: int = Query(...),
    blocked_userid: int = Query(...),
    current_user: str = Depends(get_current_user),
):
    try:
        tt = str(targettype or "").lower().strip()
        tid = _as_int(targetid, "targetid")
        buid = _as_int(blocked_userid, "blocked_userid")

        _require_owner(tt, tid, current_user)

        deleted = rest_delete("block_list", {"targettype": tt, "targetid": tid, "blocked_userid": buid})
        return {"deleted": True, "rows": deleted if isinstance(deleted, list) else []}
    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

from fastapi import APIRouter, Depends
from ..auth import get_current_user, decode_token
from ..db import rest_select

router = APIRouter(prefix="/debug", tags=["debug"])

@router.get("/identity")
def debug_identity(current_user: str = Depends(get_current_user)):
    """Return token subject, attempt numeric coercion, and any matching userinfo row.

    Helps diagnose mismatched userid vs token subject issues on client.
    """
    raw_sub = current_user
    try:
        numeric_sub = int(raw_sub)
    except ValueError:
        numeric_sub = None
    userinfo_row = None
    if numeric_sub is not None:
        try:
            userinfo_row = rest_select("userinfo", "*", filters={"userid": numeric_sub}, single=True)
        except Exception:
            userinfo_row = None
    return {
        "token_subject": raw_sub,
        "numeric_subject": numeric_sub,
        "userinfo": userinfo_row,
    }
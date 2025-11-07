import time
import logging
from typing import Optional
from fastapi import APIRouter, HTTPException
from ..db import rest_select, rest_upsert

logger = logging.getLogger("auth")
if not logger.handlers:
    handler = logging.StreamHandler()
    formatter = logging.Formatter('[AUTH] %(asctime)s %(levelname)s %(message)s')
    handler.setFormatter(formatter)
    logger.addHandler(handler)
logger.setLevel(logging.DEBUG)

router = APIRouter(prefix="/auth", tags=["auth"])

def _now_ms() -> int:
    return int(time.time() * 1000)

def find_user_by_email(email: str) -> Optional[dict]:
    start = _now_ms()
    row = rest_select("userinfo", "infoid, userid, email, name", {"email": email}, single=True)
    logger.debug(f"find_user_by_email email={email} ms={_now_ms()-start} row={row}")
    return row

def find_userlogin_by_username(username: str) -> Optional[dict]:
    start = _now_ms()
    row = rest_select("userlogin", "loginid, userid, username, passwordhash", {"username": username}, single=True)
    logger.debug(f"find_userlogin_by_username username={username} ms={_now_ms()-start} row={row}")
    return row

def find_userinfo_by_userid(userid: int) -> Optional[dict]:
    start = _now_ms()
    row = rest_select("userinfo", "infoid, userid, email, name", {"userid": userid}, single=True)
    logger.debug(f"find_userinfo_by_userid userid={userid} ms={_now_ms()-start} row={row}")
    return row

@router.post('/signup')
def signup(payload: dict):
    """
    Minimal signup: create rows in users, userinfo, userlogin.
    EXPECTS JSON: {username, email, password, accountName?, role?}
    Returns created summary without any token (client may store locally).
    NOTE: Password stored in plain text (per user request). DO NOT USE IN PRODUCTION.
    """
    t0 = _now_ms()
    username = (payload.get('username') or '').strip()
    email = (payload.get('email') or '').strip()
    password = payload.get('password') or ''
    account_name = (payload.get('accountName') or '').strip()
    role = (payload.get('role') or 'player').strip()

    logger.debug(f"/signup START username={username} email={email} role={role} accountName={account_name}")

    if not username or not email or not password:
        raise HTTPException(status_code=400, detail="Missing username/email/password")

    # Check duplicates (email OR username)
    if find_user_by_email(email):
        raise HTTPException(status_code=409, detail="Email already exists")
    if find_userlogin_by_username(username):
        raise HTTPException(status_code=409, detail="Username already exists")

    # 1. users with sequence permission fallback
    try:
        users_rows = rest_upsert("users", {"role": role})
    except Exception as e:
        msg = str(e)
        if "permission denied for sequence users_userid_seq" in msg:
            logger.warning("users sequence permission denied, performing manual userid allocation")
            try:
                max_row = rest_select("users", "userid", single=True, order={"column": "userid", "desc": True})
            except Exception as e2:
                logger.exception("Failed max userid fetch")
                raise HTTPException(status_code=500, detail=f"fetch max userid failed: {e2}")
            next_userid = (max_row.get('userid') if max_row else 0) + 1
            logger.debug(f"next_userid={next_userid}")
            try:
                users_rows = rest_upsert("users", {"userid": next_userid, "role": role})
            except Exception as e3:
                logger.exception("Manual userid insert failed")
                raise HTTPException(status_code=500, detail=f"manual userid insert failed: {e3}")
        else:
            logger.exception("Failed inserting users")
            raise HTTPException(status_code=500, detail=f"users insert failed: {e}")
    if not users_rows or not isinstance(users_rows, list):
        raise HTTPException(status_code=500, detail="Unexpected users insert response")
    user_row = users_rows[0]
    userid = user_row.get('userid')
    if not userid:
        raise HTTPException(status_code=500, detail="No userid returned from users insert")
    logger.debug(f"Inserted/allocated users userid={userid}")

    # 2. userinfo with sequence fallback
    try:
        info_rows = rest_upsert("userinfo", {"userid": userid, "name": account_name, "email": email})
    except Exception as e:
        msg = str(e)
        if "permission denied for sequence userinfo_infoid_seq" in msg:
            logger.warning("userinfo sequence permission denied, performing manual infoid allocation")
            try:
                max_row = rest_select("userinfo", "infoid", single=True, order={"column": "infoid", "desc": True})
            except Exception as e2:
                logger.exception("Failed max infoid fetch")
                raise HTTPException(status_code=500, detail=f"fetch max infoid failed: {e2}")
            next_infoid = (max_row.get('infoid') if max_row else 0) + 1
            logger.debug(f"next_infoid={next_infoid}")
            try:
                info_rows = rest_upsert("userinfo", {"infoid": next_infoid, "userid": userid, "name": account_name, "email": email})
            except Exception as e3:
                logger.exception("Manual infoid insert failed")
                raise HTTPException(status_code=500, detail=f"manual infoid insert failed: {e3}")
        else:
            logger.exception("Failed inserting userinfo")
            raise HTTPException(status_code=500, detail=f"userinfo insert failed: {e}")
    if not info_rows or not isinstance(info_rows, list):
        raise HTTPException(status_code=500, detail="Unexpected userinfo insert response")
    info_row = info_rows[0]
    infoid = info_row.get('infoid')
    logger.debug(f"Inserted/allocated userinfo infoid={infoid}")

    # 3. userlogin with sequence fallback
    try:
        login_rows = rest_upsert("userlogin", {"userid": userid, "username": username, "passwordhash": password, "logintype": "Local"})
    except Exception as e:
        msg = str(e)
        if "permission denied for sequence userlogin_loginid_seq" in msg:
            logger.warning("userlogin sequence permission denied, performing manual loginid allocation")
            try:
                max_row = rest_select("userlogin", "loginid", single=True, order={"column": "loginid", "desc": True})
            except Exception as e2:
                logger.exception("Failed max loginid fetch")
                raise HTTPException(status_code=500, detail=f"fetch max loginid failed: {e2}")
            next_loginid = (max_row.get('loginid') if max_row else 0) + 1
            logger.debug(f"next_loginid={next_loginid}")
            try:
                login_rows = rest_upsert("userlogin", {"loginid": next_loginid, "userid": userid, "username": username, "passwordhash": password, "logintype": "Local"})
            except Exception as e3:
                logger.exception("Manual loginid insert failed")
                raise HTTPException(status_code=500, detail=f"manual loginid insert failed: {e3}")
        else:
            logger.exception("Failed inserting userlogin")
            raise HTTPException(status_code=500, detail=f"userlogin insert failed: {e}")
    if not login_rows or not isinstance(login_rows, list):
        raise HTTPException(status_code=500, detail="Unexpected userlogin insert response")
    login_row = login_rows[0]
    loginid = login_row.get('loginid')
    logger.debug(f"Inserted/allocated userlogin loginid={loginid}")

    elapsed = _now_ms() - t0
    logger.debug(f"/signup COMPLETE userid={userid} elapsedMs={elapsed}")
    return {
        "status": "ok",
        "userid": userid,
        "username": username,
        "email": email,
        "infoid": infoid,
        "loginid": loginid,
        "elapsedMs": elapsed,
    }

@router.post('/login')
def login(payload: dict):
    """
    Minimal login: Accept identifier (email OR username) + password.
    Resolves to user via userlogin or userinfo then compares raw passwordhash.
    Returns basic profile data if match.
    """
    t0 = _now_ms()
    identifier = (payload.get('identifier') or '').strip()
    password = payload.get('password') or ''
    logger.debug(f"/login START identifier={identifier}")
    if not identifier or not password:
        raise HTTPException(status_code=400, detail="Missing identifier/password")

    looks_like_email = '@' in identifier
    if looks_like_email:
        info_row = find_user_by_email(identifier)
        if not info_row:
            raise HTTPException(status_code=404, detail="Account not found")
        userid = info_row.get('userid')
        login_row = rest_select("userlogin", "loginid, userid, username, passwordhash", {"userid": userid}, single=True)
    else:
        login_row = find_userlogin_by_username(identifier)
        if not login_row:
            raise HTTPException(status_code=404, detail="Account not found")
        userid = login_row.get('userid')
        info_row = find_userinfo_by_userid(userid)

    if not login_row:
        raise HTTPException(status_code=404, detail="Login record not found")

    stored_pw = login_row.get('passwordhash')
    if stored_pw != password:
        raise HTTPException(status_code=401, detail="Incorrect password")

    elapsed = _now_ms() - t0
    logger.debug(f"/login SUCCESS userid={userid} elapsedMs={elapsed}")
    return {
        "status": "ok",
        "userid": userid,
        "username": login_row.get('username'),
        "email": info_row.get('email') if info_row else None,
        "name": info_row.get('name') if info_row else None,
        "elapsedMs": elapsed,
    }

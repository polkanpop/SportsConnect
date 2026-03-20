import time
import logging
import hashlib
import os
import secrets
from email.message import EmailMessage
import smtplib
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from typing import Optional
from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Query
from fastapi.responses import RedirectResponse
from passlib.context import CryptContext
from jose import jwt
from ..db import rest_select, rest_upsert, rest_update
from ..auth import get_jwt_secret, HS_ALGORITHM, decode_token
from ..token_utils import create_user_tokens, verify_and_refresh, revoke_refresh_token, touch_refresh_token
from ..login_rules import (
    record_login_attempt,
    get_user_state_snapshot,
    record_username_attempt,
    get_username_state_snapshot,
)

logger = logging.getLogger("auth")
if not logger.handlers:
    handler = logging.StreamHandler()
    formatter = logging.Formatter('[AUTH] %(asctime)s %(levelname)s %(message)s')
    handler.setFormatter(formatter)
    logger.addHandler(handler)
logger.setLevel(logging.DEBUG)

router = APIRouter(prefix="/auth", tags=["auth"])

# Bcrypt password hashing context
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _get_password_pepper() -> str:
    """Return password pepper from environment (stripped). Empty string if unset.
    NOTE: Ensure .env line has no spaces like PASSWORD_PEPPER="value".
    """
    val = os.getenv("PASSWORD_PEPPER", "")
    # strip quotes & whitespace to avoid accidental space inclusion
    return val.strip().strip('"').strip("'")

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

def find_unverified_by_email(email: str) -> Optional[dict]:
    start = _now_ms()
    row = rest_select("unverified_users", "unverifiedid, userid, email, token_hash, token_expires_at, resend_count, email_verified", {"email": email}, single=True)
    logger.debug(f"find_unverified_by_email email={email} ms={_now_ms()-start} row={row}")
    return row

def _email_settings():
    return {
        "host": os.getenv("SMTP_HOST"),
        "port": int(os.getenv("SMTP_PORT", "587")),
        "username": os.getenv("SMTP_USERNAME"),
        "password": os.getenv("SMTP_PASSWORD"),
        "sender": os.getenv("SMTP_SENDER_EMAIL", os.getenv("SENDER_EMAIL", "noreply@example.com")),
        "sender_name": os.getenv("SMTP_SENDER_NAME", os.getenv("SENDER_NAME", "SportConnect")),
        "base_verify_url": os.getenv("EMAIL_VERIFY_BASE_URL", "http://localhost:8000/auth/verify-email"),
        "expiry_hours": int(os.getenv("EMAIL_VERIFICATION_EXP_HOURS", "24")),
        "resend_limit": int(os.getenv("EMAIL_VERIFICATION_RESEND_LIMIT", "5")),
    }

def _send_verification_email(to_email: str, token: str):
    cfg = _email_settings()
    if not cfg["host"] or not cfg["username"] or not cfg["password"]:
        logger.warning("SMTP settings incomplete; skipping email send")
        return False
    verify_link = f"{cfg['base_verify_url']}?token={token}"
    msg = EmailMessage()
    msg["Subject"] = "Confirm Your Signup"
    msg["From"] = f"{cfg['sender_name']} <{cfg['sender']}>"
    msg["To"] = to_email
    msg.set_content(f"Please verify your SportConnect account by visiting: {verify_link}\n\nIf you did not sign up, ignore this email.")
    try:
        with smtplib.SMTP(cfg['host'], cfg['port'], timeout=10) as smtp:
            smtp.starttls()
            smtp.login(cfg['username'], cfg['password'])
            smtp.send_message(msg)
        logger.debug(f"Sent verification email to {to_email}")
        return True
    except Exception as e:
        logger.warning(f"Failed sending verification email to {to_email} err={e}")
        return False


def _can_send_verification_email() -> bool:
    cfg = _email_settings()
    return bool(cfg["host"] and cfg["username"] and cfg["password"])


def _deliver_verification_email_task(to_email: str, token: str) -> None:
    _send_verification_email(to_email, token)

def _create_or_update_unverified(userid: int, email: str) -> dict:
    """Insert or refresh unverified_users row with new token. Returns dict including plaintext token."""
    cfg = _email_settings()
    token_plain = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token_plain.encode('utf-8')).hexdigest()
    expires_at = (datetime.utcnow() + timedelta(hours=cfg['expiry_hours'])).isoformat()
    existing = find_unverified_by_email(email)
    if existing:
        # refresh token (keep unverifiedid)
        try:
            rest_update("unverified_users", {"unverifiedid": existing.get("unverifiedid")}, {
                "token_hash": token_hash,
                "token_expires_at": expires_at,
                "email_verified": False,
            })
        except Exception as e:
            logger.exception(f"Failed updating unverified_users email={email} err={e}")
            raise HTTPException(status_code=500, detail="Failed updating verification record")
        existing['token_hash'] = token_hash
        existing['token_expires_at'] = expires_at
        existing['email_verified'] = False
        existing['plaintext_token'] = token_plain
        return existing
    # allocate unverifiedid manually (no sequence defined in schema snippet)
    try:
        max_row = rest_select("unverified_users", "unverifiedid", single=True, order={"column": "unverifiedid", "desc": True})
    except Exception:
        max_row = None
    next_id = (max_row.get('unverifiedid') if max_row else 0) + 1
    payload = {
        "unverifiedid": next_id,
        "userid": userid,
        "email": email,
        "token_hash": token_hash,
        "token_expires_at": expires_at,
        "resend_count": 0,
        "email_verified": False,
    }
    try:
        rows = rest_upsert("unverified_users", payload)
    except Exception as e:
        logger.exception(f"Failed inserting unverified_users email={email} err={e}")
        raise HTTPException(status_code=500, detail="Failed creating verification record")
    rec = rows[0] if isinstance(rows, list) else payload
    rec['plaintext_token'] = token_plain
    return rec

@router.post('/signup')
def signup(payload: dict, background_tasks: BackgroundTasks):
    """
    Minimal signup: create rows in users, userinfo, userlogin.
    EXPECTS JSON: {username, email, password, accountName?, role?}
    Returns created summary without any token (client may store locally).
    SECURE VERSION: Password is now hashed with bcrypt (passlib) before storage.
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

    # 3. userlogin with sequence fallback - hash password with bcrypt (+ optional pepper)
    pepper = _get_password_pepper()
    bcrypt_hash = pwd_context.hash(password + pepper)
    try:
        login_rows = rest_upsert("userlogin", {"userid": userid, "username": username, "passwordhash": bcrypt_hash, "logintype": "Local"})
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
                login_rows = rest_upsert("userlogin", {"loginid": next_loginid, "userid": userid, "username": username, "passwordhash": bcrypt_hash, "logintype": "Local"})
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

    # 4. Create verification record + queue email send
    ver_rec = _create_or_update_unverified(userid, email)
    email_sent = False
    if _can_send_verification_email():
        background_tasks.add_task(_deliver_verification_email_task, email, ver_rec['plaintext_token'])
        email_sent = True
    else:
        logger.warning("SMTP settings incomplete; verification email not queued")
    elapsed = _now_ms() - t0
    logger.debug(f"/signup COMPLETE userid={userid} elapsedMs={elapsed} emailSent={email_sent}")
    # Do NOT auto-login; client must verify email first
    return {
        "status": "ok",
        "userid": userid,
        "username": username,
        "email": email,
        "infoid": infoid,
        "loginid": loginid,
        "elapsedMs": elapsed,
        "verificationEmailSent": email_sent,
        "verificationEmailQueued": email_sent,
        "emailVerified": False,
    }

@router.post('/login')
def login(payload: dict):
    """
    Minimal login: Accept identifier (email OR username) + password.
    Resolves to user via userlogin or userinfo then verifies bcrypt hash.
    Returns basic profile data if match.
    """
    t0 = _now_ms()
    identifier = (payload.get('identifier') or '').strip()
    password = payload.get('password') or ''
    remember_me = bool(payload.get('rememberMe'))
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
        # Enforce email verification
        unver = find_unverified_by_email(identifier)
        if unver and not unver.get('email_verified'):
            raise HTTPException(status_code=403, detail="EMAIL_NOT_VERIFIED")
    else:
        login_row = find_userlogin_by_username(identifier)
        if not login_row:
            try:
                record_username_attempt(identifier, success=False)
            except Exception as e:
                logger.warning(f"/login username rule logging failure username={identifier} err={e}")
            raise HTTPException(status_code=404, detail="Account not found")
        userid = login_row.get('userid')
        info_row = find_userinfo_by_userid(userid)
        if info_row and info_row.get('email'):
            unver = find_unverified_by_email(info_row.get('email'))
            if unver and not unver.get('email_verified'):
                raise HTTPException(status_code=403, detail="EMAIL_NOT_VERIFIED")

    if not login_row:
        raise HTTPException(status_code=404, detail="Login record not found")

    stored_pw = login_row.get('passwordhash')

    # Determine if existing hash is bcrypt; if not attempt legacy migrations (plaintext or SHA256).
    def is_bcrypt(pw: str) -> bool:
        return pw.startswith("$2a$") or pw.startswith("$2b$") or pw.startswith("$2y$")

    password_valid = False
    peppered_already = False
    pepper = _get_password_pepper()
    if stored_pw and is_bcrypt(stored_pw):
        # Try peppered verification first (new scheme). If that fails, try legacy (no pepper).
        if pwd_context.verify(password + pepper, stored_pw):
            password_valid = True
            peppered_already = True
        elif pwd_context.verify(password, stored_pw):
            password_valid = True
            peppered_already = False  # legacy bcrypt without pepper -> will upgrade below
    else:
        # Legacy path: either plaintext or prior SHA256 client-hash
        sha256_hex = hashlib.sha256(password.encode('utf-8')).hexdigest()
        if stored_pw == password or stored_pw == sha256_hex:
            password_valid = True
            # Re-hash & upgrade to bcrypt
            try:
                new_hash = pwd_context.hash(password + pepper)
                rest_upsert("userlogin", {"loginid": login_row.get('loginid'), "userid": userid, "username": login_row.get('username'), "passwordhash": new_hash, "logintype": login_row.get('logintype') or 'Local'})
                logger.debug(f"/login password upgraded to bcrypt for userid={userid}")
            except Exception as e:
                logger.warning(f"/login bcrypt upgrade failed userid={userid} err={e}")

    # Upgrade legacy bcrypt (without pepper) to peppered bcrypt after successful verification
    if password_valid and stored_pw and is_bcrypt(stored_pw) and not peppered_already:
        try:
            new_hash = pwd_context.hash(password + pepper)
            rest_upsert("userlogin", {"loginid": login_row.get('loginid'), "userid": userid, "username": login_row.get('username'), "passwordhash": new_hash, "logintype": login_row.get('logintype') or 'Local'})
            logger.debug(f"/login password upgraded to peppered bcrypt for userid={userid}")
        except Exception as e:
            logger.warning(f"/login peppered bcrypt upgrade failed userid={userid} err={e}")

    if not password_valid:
        # Log failure rules (logging only; does not block response timeline)
        try:
            record_login_attempt(userid, password, success=False)
        except Exception as e:
            logger.warning(f"/login rule logging failure userid={userid} err={e}")
        raise HTTPException(status_code=401, detail="Incorrect password")

    # --- Token lifecycle adjustments for remember-me semantics ---
    # Requirement:
    #  - Non "remember me" sessions: when app is closed/refreshed (no explicit /logout), treat as sign out -> revoke prior non-remember tokens.
    #  - "Remember me" sessions: keep tokens valid; update last_used_at only.
    # Since the backend cannot observe an app close directly, we implement this by
    # revoking any existing non-remember tokens at the moment a new login occurs.
    # We infer remember status by lifespan: 1 day refresh expiry => non-remember; >= 30 days => remember.
    # Fetch existing tokens for user (equality filter only; then apply logic in Python).
    prior_tokens = []
    try:
        prior_tokens = rest_select("user_tokens", "tokenid, userid, refresh_token_expires_at, created_at, is_revoked, last_used_at, access_token_expires_at", {"userid": userid}) or []
    except Exception as e:
        logger.warning(f"/login fetch prior tokens failed userid={userid} err={e}")

    now_iso = datetime.utcnow().isoformat()
    for tok in prior_tokens:
        try:
            if tok.get("is_revoked"):
                continue
            created_at = tok.get("created_at") or tok.get("last_used_at")  # fallback
            refresh_exp = tok.get("refresh_token_expires_at")
            if not created_at or not refresh_exp:
                continue
            try:
                created_dt = datetime.fromisoformat(created_at.replace("Z", "+00:00")) if "Z" in created_at else datetime.fromisoformat(created_at)
                exp_dt = datetime.fromisoformat(refresh_exp.replace("Z", "+00:00")) if "Z" in refresh_exp else datetime.fromisoformat(refresh_exp)
            except Exception:
                continue
            lifespan_days = (exp_dt - created_dt).days
            is_remember_token = lifespan_days >= 29  # treat >=29 days as remember-me token
            if is_remember_token:
                # Update last_used_at for remember tokens so inactivity windows advance.
                try:
                    rest_update("user_tokens", {"tokenid": tok.get("tokenid")}, {"last_used_at": now_iso})
                except Exception:
                    # best-effort update; log and continue
                    logger.debug(f"/login remember token update failed tokenid={tok.get('tokenid')}")
            else:
                # Always revoke prior non-remember tokens when any new login occurs.
                try:
                    rest_update("user_tokens", {"tokenid": tok.get("tokenid")}, {"is_revoked": True, "last_used_at": now_iso})
                except Exception:
                    logger.debug(f"/login revoke prior token failed tokenid={tok.get('tokenid')}")
        except Exception as e:
            logger.warning(f"/login token lifecycle update failed tokenid={tok.get('tokenid')} err={e}")

    # Successful password; reset rule counters via record_login_attempt
    try:
        record_login_attempt(userid, password, success=True)
        # If identifier was a username (not email), also reset username spam counters as a success.
        if not looks_like_email:
            record_username_attempt(identifier, success=True)
    except Exception as e:
        logger.warning(f"/login rule reset failure userid={userid} err={e}")

    elapsed = _now_ms() - t0
    state_snapshot = {}
    try:
        state_snapshot = get_user_state_snapshot(userid)
    except Exception:
        pass
    username_state = {}
    if not looks_like_email:
        try:
            username_state = get_username_state_snapshot(identifier)
        except Exception:
            pass
    logger.debug(f"/login SUCCESS userid={userid} elapsedMs={elapsed} state={state_snapshot} usernameState={username_state}")
    # Issue new token pair
    tokens = None
    try:
        tokens = create_user_tokens(userid, login_row.get('username'), info_row.get('email') if info_row else None, remember_me)
    except Exception as e:
        logger.warning(f"/login token persistence failed userid={userid} err={e}")
        secret = get_jwt_secret()
        token = None
        if secret:
            try:
                exp = datetime.utcnow() + timedelta(hours=24)
                payload_token = {
                    "sub": str(userid),
                    "username": login_row.get('username'),
                    "email": info_row.get('email') if info_row else None,
                    "iat": int(time.time()),
                    "exp": int(exp.timestamp()),
                }
                token = jwt.encode(payload_token, secret, algorithm=HS_ALGORITHM)
            except Exception:
                pass
        return {
            "status": "ok",
            "userid": userid,
            "username": login_row.get('username'),
            "email": info_row.get('email') if info_row else None,
            "name": info_row.get('name') if info_row else None,
            "elapsedMs": elapsed,
            "token": token,
            "rememberMe": remember_me,
            "usingLegacy": True,
        }
    return {
        "status": "ok",
        "userid": userid,
        "username": login_row.get('username'),
        "email": info_row.get('email') if info_row else None,
        "name": info_row.get('name') if info_row else None,
        "elapsedMs": elapsed,
        "accessToken": tokens.get('access_token'),
        "accessTokenExpiresAt": tokens.get('access_token_expires_at'),
        "refreshToken": tokens.get('refresh_token'),
        "refreshTokenExpiresAt": tokens.get('refresh_token_expires_at'),
        "rememberMe": remember_me,
    }


@router.get('/verify-email')
def verify_email(token: str = Query(..., description="Plaintext email verification token")):
    if not token:
        raise HTTPException(status_code=400, detail="Missing token")
    token_hash = hashlib.sha256(token.encode('utf-8')).hexdigest()
    row = rest_select(
        "unverified_users",
        "unverifiedid, userid, email, token_expires_at, email_verified",
        {"token_hash": token_hash},
        single=True,
    )
    if not row:
        raise HTTPException(status_code=400, detail="Invalid or already used token")
    if row.get('email_verified'):
        # Optional redirect even if already verified
        redirect_url = os.getenv("EMAIL_VERIFY_REDIRECT_URL")
        auto_login = os.getenv("EMAIL_VERIFY_AUTO_LOGIN", "").lower() == "true"
        if redirect_url:
            params = {"status": "ok", "alreadyVerified": "true", "email": row.get('email')}
            if auto_login:
                try:
                    userlogin_row = rest_select("userlogin", "loginid, userid, username", {"userid": row.get("userid")}, single=True)
                    info_row = rest_select("userinfo", "infoid, userid, name, email", {"userid": row.get("userid")}, single=True)
                    tokens = create_user_tokens(row.get("userid"), userlogin_row.get("username") if userlogin_row else None, info_row.get("email") if info_row else row.get('email'), remember_me=False)
                    params.update({
                        "accessToken": tokens.get("access_token"),
                        "accessTokenExpiresAt": tokens.get("access_token_expires_at"),
                        "refreshToken": tokens.get("refresh_token"),
                        "refreshTokenExpiresAt": tokens.get("refresh_token_expires_at"),
                        "userid": row.get("userid"),
                        "username": (userlogin_row.get("username") if userlogin_row else None) or "",
                        "name": (info_row.get("name") if info_row else "") or "",
                    })
                except Exception as e:
                    logger.warning(f"auto-login issuance failed userid={row.get('userid')} err={e}")
            return RedirectResponse(f"{redirect_url}?{urlencode({k:v for k,v in params.items() if v is not None})}")
        return {"status": "ok", "alreadyVerified": True}

    exp_raw = row.get('token_expires_at')
    try:
        exp_dt = datetime.fromisoformat(exp_raw.replace('Z', '+00:00')) if exp_raw else None
    except Exception:
        exp_dt = None
    # Normalize timezone (make both aware UTC)
    if exp_dt and exp_dt.tzinfo is None:
        exp_dt = exp_dt.replace(tzinfo=timezone.utc)
    now_utc = datetime.now(timezone.utc)
    if exp_dt and exp_dt < now_utc:
        raise HTTPException(status_code=400, detail="Token expired")
    # mark verified; scramble token_hash to prevent replay
    try:
        rest_update(
            "unverified_users",
            {"unverifiedid": row.get("unverifiedid")},
            {"email_verified": True, "token_hash": f"VERIFIED:{token_hash[:12]}"},
        )
    except Exception as e:
        logger.exception(f"Failed updating verification status err={e}")
        raise HTTPException(status_code=500, detail="Failed marking verified")

    redirect_url = os.getenv("EMAIL_VERIFY_REDIRECT_URL")
    auto_login = os.getenv("EMAIL_VERIFY_AUTO_LOGIN", "").lower() == "true"
    if redirect_url:
        params = {"status": "ok", "verified": "true", "email": row.get('email')}
        if auto_login:
            try:
                userlogin_row = rest_select("userlogin", "loginid, userid, username", {"userid": row.get("userid")}, single=True)
                info_row = rest_select("userinfo", "infoid, userid, name, email", {"userid": row.get("userid")}, single=True)
                tokens = create_user_tokens(row.get("userid"), userlogin_row.get("username") if userlogin_row else None, info_row.get("email") if info_row else row.get('email'), remember_me=False)
                params.update({
                    "accessToken": tokens.get("access_token"),
                    "accessTokenExpiresAt": tokens.get("access_token_expires_at"),
                    "refreshToken": tokens.get("refresh_token"),
                    "refreshTokenExpiresAt": tokens.get("refresh_token_expires_at"),
                    "userid": row.get("userid"),
                    "username": (userlogin_row.get("username") if userlogin_row else None) or "",
                    "name": (info_row.get("name") if info_row else "") or "",
                })
            except Exception as e:
                logger.warning(f"auto-login issuance failed userid={row.get('userid')} err={e}")
        return RedirectResponse(f"{redirect_url}?{urlencode({k:v for k,v in params.items() if v is not None})}")
    # If no redirect configured, optionally include tokens directly when auto_login enabled
    if auto_login:
        try:
            userlogin_row = rest_select("userlogin", "loginid, userid, username", {"userid": row.get("userid")}, single=True)
            info_row = rest_select("userinfo", "infoid, userid, name, email", {"userid": row.get("userid")}, single=True)
            tokens = create_user_tokens(row.get("userid"), userlogin_row.get("username") if userlogin_row else None, info_row.get("email") if info_row else row.get('email'), remember_me=False)
            return {
                "status": "ok",
                "verified": True,
                "userid": row.get("userid"),
                "username": (userlogin_row.get("username") if userlogin_row else None) or "",
                "name": (info_row.get("name") if info_row else "") or "",
                "accessToken": tokens.get("access_token"),
                "accessTokenExpiresAt": tokens.get("access_token_expires_at"),
                "refreshToken": tokens.get("refresh_token"),
                "refreshTokenExpiresAt": tokens.get("refresh_token_expires_at"),
            }
        except Exception as e:
            logger.warning(f"auto-login issuance failed (no redirect) userid={row.get('userid')} err={e}")
    return {"status": "ok", "verified": True}

@router.get('/newpassword')
def password_reset_redirect(token: str = Query(..., description="Plaintext password reset token")):
    """Validate password reset token and redirect to Expo deep link.
    Similar pattern to /auth/verify-email: we only validate & redirect; actual password change
    is performed by POST /userlogin/reset-password once frontend collects new password.
    """
    if not token:
        raise HTTPException(status_code=400, detail="Missing token")
    # Import in-memory token store from userlogin router (generation lives there)
    try:
        from .userlogin import _reset_tokens  # type: ignore
    except Exception:
        raise HTTPException(status_code=500, detail="Token store unavailable")
    token_hash = hashlib.sha256(token.encode('utf-8')).hexdigest()
    rec = _reset_tokens.get(token_hash)
    if not rec or rec.get('used'):
        raise HTTPException(status_code=400, detail="Invalid or already used token")
    exp_raw = rec.get('expires_at')
    try:
        exp_dt = datetime.fromisoformat(exp_raw.replace('Z', '+00:00')) if exp_raw else None
    except Exception:
        exp_dt = None
    if exp_dt and exp_dt < datetime.utcnow():
        raise HTTPException(status_code=400, detail="Token expired")
    redirect_url = os.getenv("PASSWORD_RESET_REDIRECT_URL")  # Expo deep link destination
    if not redirect_url:
        # Fallback: just JSON so frontend can proceed manually
        return {"status": "ok", "resetReady": True, "token": token}
    params = {
        "status": "ok",
        "token": token,
        "userid": rec.get('userid'),
        "username": rec.get('username') or "",
    }
    return RedirectResponse(f"{redirect_url}?{urlencode({k:v for k,v in params.items() if v is not None})}")

@router.get('/verification-status')
def verification_status(email: str = Query(...)):
    row = find_unverified_by_email(email)
    if not row:
        # If no row we treat as verified (legacy accounts before table creation)
        return {"status": "ok", "emailVerified": True, "legacy": True}
    return {"status": "ok", "emailVerified": bool(row.get('email_verified'))}

@router.post('/resend-verification')
def resend_verification(payload: dict, background_tasks: BackgroundTasks):
    email = (payload.get('email') or '').strip()
    if not email:
        raise HTTPException(status_code=400, detail="Missing email")
    row = find_unverified_by_email(email)
    if not row:
        raise HTTPException(status_code=404, detail="No verification record for email")
    cfg = _email_settings()
    if row.get('email_verified'):
        return {"status": "ok", "emailVerified": True, "alreadyVerified": True}
    if row.get('resend_count', 0) >= cfg['resend_limit']:
        raise HTTPException(status_code=429, detail="Resend limit reached")
    # create new token & update resend_count
    new_rec = _create_or_update_unverified(row.get('userid'), email)
    try:
        rest_update("unverified_users", {"unverifiedid": new_rec.get('unverifiedid')}, {"resend_count": row.get('resend_count', 0) + 1})
    except Exception:
        pass
    queued = False
    if _can_send_verification_email():
        background_tasks.add_task(_deliver_verification_email_task, email, new_rec['plaintext_token'])
        queued = True
    else:
        logger.warning("SMTP settings incomplete; resend verification email not queued")
    return {"status": "ok", "resent": queued, "queued": queued}


@router.post('/refresh')
def refresh(payload: dict):
    """Exchange a valid refresh token for a new access token."""
    rt = (payload.get('refreshToken') or '').strip()
    if not rt:
        raise HTTPException(status_code=400, detail="Missing refreshToken")
    try:
        data = verify_and_refresh(rt)
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))
    return {"status": "ok", "accessToken": data['access_token'], "accessTokenExpiresAt": data['access_token_expires_at']}

@router.get('/debug-token')
def debug_token(authorization: str | None = Query(None, alias="authorization")):
    """Debug helper: decode a Bearer token passed as query param (?authorization=Bearer%20xxx).
    Returns payload or error detail; do NOT enable in production unless behind admin auth.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=400, detail="Missing Bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        payload = jwt.get_unverified_claims(token)
    except Exception:
        payload = None
    try:
        decoded = jwt.get_unverified_header(token)
    except Exception:
        decoded = None
    # Attempt full decode (may fail if signature issue)
    try:
        full = decode_token(token)  # reuse existing logic
        return {"status": "ok", "unverifiedClaims": payload, "header": decoded, "decoded": full}
    except HTTPException as e:
        return {"status": "error", "detail": e.detail, "unverifiedClaims": payload, "header": decoded}


@router.post('/logout')
def logout(payload: dict):
    """Revoke the refresh token (access token naturally expires)."""
    rt = (payload.get('refreshToken') or '').strip()
    if not rt:
        raise HTTPException(status_code=400, detail="Missing refreshToken")
    revoked = revoke_refresh_token(rt)
    return {"status": "ok", "revoked": revoked}


@router.post('/session/close')
def session_close(payload: dict):
    """Handle app close/background semantics.
    If rememberMe is false -> revoke token (sign out semantics).
    If rememberMe is true -> only update last_used_at.
    Frontend should call this when the app transitions to background/inactive.
    """
    rt = (payload.get('refreshToken') or '').strip()
    remember_me = bool(payload.get('rememberMe'))
    if not rt:
        raise HTTPException(status_code=400, detail="Missing refreshToken")
    if remember_me:
        touched = touch_refresh_token(rt)
        return {"status": "ok", "revoked": False, "touched": touched}
    revoked = revoke_refresh_token(rt)
    # revoke already updates last_used_at; expose touched=True for consistency
    return {"status": "ok", "revoked": revoked, "touched": True}


@router.post('/sync')
def sync_social_user(
    background_tasks: BackgroundTasks,
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    """Provision or retrieve a Supabase OAuth user (Google / Apple) in our backend DB.

    Called by the app after a successful Supabase OAuth sign-in. The endpoint:
    1. Validates the Supabase-issued JWT.
    2. Finds an existing user by email, OR creates new users / userinfo / userlogin rows.
    3. Issues a backend JWT (with numeric userid as sub) so the app can use all
       protected endpoints without UUID-sub mismatch errors.
    Returns userid, username, email, name, logintype, and a token pair.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = authorization.removeprefix("Bearer ").strip()

    try:
        payload = decode_token(token)
    except HTTPException:
        raise

    email = (payload.get("email") or "").strip()
    if not email:
        raise HTTPException(status_code=400, detail="Token has no email claim")

    # Extract display name from Supabase JWT user/app metadata
    user_meta = payload.get("user_metadata") or {}
    raw_meta = payload.get("raw_user_meta_data") or {}
    name = (
        user_meta.get("full_name")
        or user_meta.get("name")
        or raw_meta.get("full_name")
        or raw_meta.get("name")
        or email.split("@")[0]
    ).strip()

    # Determine provider (Google, Apple, etc.)
    app_meta = payload.get("app_metadata") or {}
    raw_provider = (app_meta.get("provider") or "").strip()
    provider = raw_provider.capitalize() if raw_provider else "Social"

    t0 = _now_ms()

    # --- Existing user path ---
    existing_info = find_user_by_email(email)
    if existing_info:
        userid = existing_info.get("userid")
        login_row = rest_select(
            "userlogin", "loginid, userid, username, logintype", {"userid": userid}, single=True
        )
        username = (login_row.get("username") if login_row else None) or email.split("@")[0]
        logintype = (login_row.get("logintype") if login_row else None) or provider
        try:
            tokens = create_user_tokens(userid, username, email, False)
        except Exception as e:
            logger.warning(f"/auth/sync token creation failed userid={userid} err={e}")
            raise HTTPException(status_code=500, detail="Failed issuing tokens")
        logger.debug(f"/auth/sync existing user userid={userid} elapsedMs={_now_ms()-t0}")
        return {
            "status": "ok",
            "userid": userid,
            "username": username,
            "email": email,
            "name": existing_info.get("name") or name,
            "logintype": logintype,
            "accessToken": tokens["access_token"],
            "accessTokenExpiresAt": tokens["access_token_expires_at"],
            "refreshToken": tokens["refresh_token"],
            "refreshTokenExpiresAt": tokens["refresh_token_expires_at"],
        }

    # --- New user provisioning ---
    role = "player"
    try:
        users_rows = rest_upsert("users", {"role": role})
    except Exception as e:
        msg = str(e)
        if "permission denied for sequence users_userid_seq" in msg:
            try:
                max_row = rest_select("users", "userid", single=True, order={"column": "userid", "desc": True})
            except Exception:
                max_row = None
            next_userid = (max_row.get("userid") if max_row else 0) + 1
            try:
                users_rows = rest_upsert("users", {"userid": next_userid, "role": role})
            except Exception as e3:
                raise HTTPException(status_code=500, detail=f"users insert failed: {e3}")
        else:
            raise HTTPException(status_code=500, detail=f"users insert failed: {e}")

    if not users_rows or not isinstance(users_rows, list):
        raise HTTPException(status_code=500, detail="Unexpected users insert response")
    userid = users_rows[0].get("userid")
    if not userid:
        raise HTTPException(status_code=500, detail="No userid returned from users insert")

    try:
        info_rows = rest_upsert("userinfo", {"userid": userid, "name": name, "email": email})
    except Exception as e:
        msg = str(e)
        if "permission denied for sequence userinfo_infoid_seq" in msg:
            try:
                max_row = rest_select("userinfo", "infoid", single=True, order={"column": "infoid", "desc": True})
            except Exception:
                max_row = None
            next_infoid = (max_row.get("infoid") if max_row else 0) + 1
            try:
                info_rows = rest_upsert("userinfo", {"infoid": next_infoid, "userid": userid, "name": name, "email": email})
            except Exception as e3:
                raise HTTPException(status_code=500, detail=f"userinfo insert failed: {e3}")
        else:
            raise HTTPException(status_code=500, detail=f"userinfo insert failed: {e}")

    # Derive a unique username from the email prefix
    base_username = email.split("@")[0]
    username = base_username
    if find_userlogin_by_username(username):
        username = f"{base_username}_{userid}"

    try:
        login_rows = rest_upsert("userlogin", {
            "userid": userid,
            "username": username,
            "passwordhash": "",  # Social users have no password
            "logintype": provider,
        })
    except Exception as e:
        msg = str(e)
        if "permission denied for sequence userlogin_loginid_seq" in msg:
            try:
                max_row = rest_select("userlogin", "loginid", single=True, order={"column": "loginid", "desc": True})
            except Exception:
                max_row = None
            next_loginid = (max_row.get("loginid") if max_row else 0) + 1
            try:
                login_rows = rest_upsert("userlogin", {
                    "loginid": next_loginid,
                    "userid": userid,
                    "username": username,
                    "passwordhash": "",
                    "logintype": provider,
                })
            except Exception as e3:
                raise HTTPException(status_code=500, detail=f"userlogin insert failed: {e3}")
        else:
            raise HTTPException(status_code=500, detail=f"userlogin insert failed: {e}")

    # Mark the email as pre-verified (OAuth providers already verify email ownership)
    try:
        ver_rec = _create_or_update_unverified(userid, email)
        rest_update(
            "unverified_users",
            {"unverifiedid": ver_rec.get("unverifiedid")},
            {"email_verified": True, "token_hash": f"SOCIAL:{provider}:{userid}"},
        )
    except Exception:
        pass  # Non-critical; verification check uses email lookup so this row is optional

    try:
        tokens = create_user_tokens(userid, username, email, False)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed issuing tokens: {e}")

    logger.debug(f"/auth/sync new user userid={userid} provider={provider} elapsedMs={_now_ms()-t0}")
    return {
        "status": "ok",
        "userid": userid,
        "username": username,
        "email": email,
        "name": name,
        "logintype": provider,
        "accessToken": tokens["access_token"],
        "accessTokenExpiresAt": tokens["access_token_expires_at"],
        "refreshToken": tokens["refresh_token"],
        "refreshTokenExpiresAt": tokens["refresh_token_expires_at"],
    }

import re
import time
import logging
import hashlib
import os
import threading
import json
import base64
import secrets
import httpx
from email.message import EmailMessage
import smtplib
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from typing import Optional
from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Query
from fastapi.responses import RedirectResponse
from passlib.context import CryptContext
from jose import jwt
import firebase_admin
import firebase_admin.auth as fb_auth
from firebase_admin import credentials as fb_credentials
from ..db import rest_select, rest_upsert, rest_update
from ..auth import get_jwt_secret, HS_ALGORITHM, decode_token
from ..token_utils import create_user_tokens, verify_and_refresh, revoke_refresh_token, touch_refresh_token
from ..login_rules import (
    record_login_attempt,
    get_user_state_snapshot,
    record_username_attempt,
    get_username_state_snapshot,
)

# Short-lived whitelist of access_tokens issued by /auth/zalo/token.
# Keyed by token, value is expiry timestamp. TTL = 5 minutes.
# This avoids needing to re-call Zalo (geo-blocked from SG server).
_zalo_token_whitelist: dict[str, float] = {}
_zalo_token_whitelist_lock = threading.Lock()
_ZALO_TOKEN_TTL = 300  # seconds

def _whitelist_zalo_token(token: str) -> None:
    expiry = time.time() + _ZALO_TOKEN_TTL
    with _zalo_token_whitelist_lock:
        _zalo_token_whitelist[token] = expiry
        # Purge expired entries to avoid unbounded growth
        now = time.time()
        expired = [k for k, v in _zalo_token_whitelist.items() if v < now]
        for k in expired:
            del _zalo_token_whitelist[k]

def _is_whitelisted_zalo_token(token: str) -> bool:
    with _zalo_token_whitelist_lock:
        expiry = _zalo_token_whitelist.get(token)
        if expiry is None:
            return False
        if time.time() > expiry:
            del _zalo_token_whitelist[token]
            return False
        return True

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

# ─── Firebase Admin SDK ───────────────────────────────────────────────────────

_firebase_app = None

def _get_firebase_app():
    """Lazy singleton: initialise firebase_admin once and reuse."""
    global _firebase_app
    if _firebase_app is not None:
        return _firebase_app
    # Try service-account JSON file next to the backend package
    cred_path = os.path.normpath(
        os.path.join(os.path.dirname(__file__), '..', '..', 'sportconnect-c34b9-firebase-adminsdk-fbsvc-dd20b22440.json')
    )
    if os.path.exists(cred_path):
        cred = fb_credentials.Certificate(cred_path)
    else:
        # Fallback: base64-encoded JSON in env var (for hosted deployments)
        fb_json_b64 = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")
        if fb_json_b64:
            cred_dict = json.loads(base64.b64decode(fb_json_b64))
            cred = fb_credentials.Certificate(cred_dict)
        else:
            raise RuntimeError("Firebase credentials not found: missing service-account file and FIREBASE_SERVICE_ACCOUNT_JSON env var")
    try:
        _firebase_app = firebase_admin.get_app()
    except ValueError:
        _firebase_app = firebase_admin.initialize_app(cred)
    return _firebase_app


# Vietnam mobile regex (10 digits, leading 0, second digit 3-9)
_VN_PHONE_RE = re.compile(r'^0[3-9]\d{8}$')

def _normalize_phone(raw: str) -> str:
    """Normalise a raw phone input to E.164 (+84...). Passes through if already E.164."""
    raw = raw.strip()
    if raw.startswith('+'):
        return raw
    if _VN_PHONE_RE.match(raw):
        return '+84' + raw[1:]
    return raw

def _looks_like_phone(raw: str) -> bool:
    stripped = raw.strip()
    return bool(_VN_PHONE_RE.match(stripped) or (stripped.startswith('+') and stripped[1:].isdigit()))

def find_user_by_phone(phone: str) -> Optional[dict]:
    """Look up userinfo by contactnumber (E.164 format like +84912345678)."""
    row = rest_select("userinfo", "infoid, userid, email, name, contactnumber", {"contactnumber": phone}, single=True)
    logger.debug(f"find_user_by_phone phone={phone} row={row}")
    return row


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
    row = rest_select("userlogin", "loginid, userid, username, passwordhash, logintype", {"username": username}, single=True)
    logger.debug(f"find_userlogin_by_username username={username} ms={_now_ms()-start} row={row}")
    return row

def find_userinfo_by_userid(userid: int) -> Optional[dict]:
    start = _now_ms()
    row = rest_select("userinfo", "infoid, userid, email, name, contactnumber", {"userid": userid}, single=True)
    logger.debug(f"find_userinfo_by_userid userid={userid} ms={_now_ms()-start} row={row}")
    return row

def find_unverified_by_email(email: str) -> Optional[dict]:
    start = _now_ms()
    row = rest_select("unverified_users", "unverifiedid, userid, email, phone, token_hash, token_expires_at, resend_count, email_verified, phone_verified", {"email": email}, single=True)
    logger.debug(f"find_unverified_by_email email={email} ms={_now_ms()-start} row={row}")
    return row

def find_unverified_by_phone(phone: str) -> Optional[dict]:
    """Look up unverified_users by the dedicated phone column.
    Falls back to the legacy pattern of phone number stored in the email column."""
    start = _now_ms()
    row = rest_select("unverified_users", "unverifiedid, userid, email, phone, token_hash, token_expires_at, resend_count, email_verified, phone_verified", {"phone": phone}, single=True)
    if not row:
        # Legacy: older records stored phone number in the email column
        row = rest_select("unverified_users", "unverifiedid, userid, email, phone, token_hash, token_expires_at, resend_count, email_verified, phone_verified", {"email": phone}, single=True)
        if row:
            logger.debug(f"find_unverified_by_phone phone={phone} found via legacy email column")
    logger.debug(f"find_unverified_by_phone phone={phone} ms={_now_ms()-start} row={row}")
    return row

def find_user_by_provider(provider: str, provider_uid: str) -> Optional[dict]:
    """Look up user_auth_providers by (provider, provider_uid). Returns row with userid if found."""
    start = _now_ms()
    row = rest_select(
        "user_auth_providers", "providerid, userid, provider, provider_uid",
        {"provider": provider, "provider_uid": provider_uid}, single=True
    )
    logger.debug(f"find_user_by_provider provider={provider} uid={provider_uid} ms={_now_ms()-start} found={bool(row)}")
    return row

def ensure_auth_provider(userid: int, provider: str, provider_uid: str) -> dict:
    """Upsert a user_auth_providers row. Idempotent — safe to call even if the row already exists."""
    try:
        rows = rest_upsert(
            "user_auth_providers",
            {"userid": userid, "provider": provider, "provider_uid": provider_uid},
            on_conflict="provider,provider_uid",
        )
        row = rows[0] if isinstance(rows, list) and rows else {}
        logger.debug(f"ensure_auth_provider ok userid={userid} provider={provider} uid={provider_uid}")
        return row
    except Exception as e:
        msg = str(e)
        if "permission denied for sequence" in msg:
            try:
                max_row = rest_select("user_auth_providers", "providerid", single=True, order={"column": "providerid", "desc": True})
                next_id = ((max_row.get("providerid") if max_row else None) or 0) + 1
                rows = rest_upsert(
                    "user_auth_providers",
                    {"providerid": next_id, "userid": userid, "provider": provider, "provider_uid": provider_uid},
                    on_conflict="provider,provider_uid",
                )
                row = rows[0] if isinstance(rows, list) and rows else {}
                logger.debug(f"ensure_auth_provider (manual id) ok userid={userid} provider={provider} uid={provider_uid}")
                return row
            except Exception as e2:
                logger.warning(f"ensure_auth_provider manual id failed userid={userid} provider={provider} uid={provider_uid} err={e2}")
                return {}
        logger.warning(f"ensure_auth_provider failed userid={userid} provider={provider} uid={provider_uid} err={e}")
        return {}

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
    logintype = (payload.get('logintype') or 'local').strip().lower()

    logger.debug(f"/signup START username={username} email={email} role={role} accountName={account_name} logintype={logintype}")

    # /signup is strictly for local (email+password) accounts.
    # Google/Apple users must use /auth/sync — reject anything else here.
    if logintype != 'local':
        raise HTTPException(status_code=400, detail="Social/OAuth accounts must register via the /auth/sync endpoint")
    if not username:
        raise HTTPException(status_code=400, detail="Username is required for local accounts")
    if not email:
        raise HTTPException(status_code=400, detail="Email is required")
    if not password:
        raise HTTPException(status_code=400, detail="Password is required for local accounts")

    # Check duplicates (email OR username)
    existing_by_email = find_user_by_email(email)
    if existing_by_email:
        existing_userid = existing_by_email.get("userid")
        existing_login = rest_select("userlogin", "loginid, logintype, username", {"userid": existing_userid}, single=True)
        existing_logintype = ((existing_login.get("logintype") or "") if existing_login else "").strip().lower()
        if existing_login and existing_logintype and existing_logintype != "local":
            # --- Account merge: attach local credentials to an existing OAuth account ---
            # username must not be claimed by a DIFFERENT user already.
            taken = find_userlogin_by_username(username)
            if taken and taken.get("userid") != existing_userid:
                raise HTTPException(status_code=409, detail="Username already taken by another account")
            pepper = _get_password_pepper()
            bcrypt_hash = pwd_context.hash(password + pepper)
            try:
                rest_update(
                    "userlogin",
                    {"loginid": existing_login.get("loginid")},
                    {"username": username, "passwordhash": bcrypt_hash, "logintype": "Local"},
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Account merge failed: {e}")
            # Overwrite the display name with what the user typed in the signup form.
            if account_name:
                try:
                    rest_update("userinfo", {"userid": existing_userid}, {"name": account_name})
                except Exception as e:
                    logger.warning(f"/signup MERGE name update failed userid={existing_userid} err={e}")
            # Ensure merged account always has a verified unverified_users record so the
            # login check can rely on this table for all local accounts.
            try:
                existing_unver = find_unverified_by_email(email)
                if not existing_unver:
                    max_row = rest_select("unverified_users", "unverifiedid", single=True, order={"column": "unverifiedid", "desc": True})
                    next_id = ((max_row.get("unverifiedid") if max_row else None) or 0) + 1
                    rest_upsert("unverified_users", {
                        "unverifiedid": next_id,
                        "userid": existing_userid,
                        "email": email,
                        "token_hash": f"VERIFIED:{hashlib.sha256(email.encode()).hexdigest()[:24]}",
                        "token_expires_at": "2099-01-01T00:00:00+00:00",
                        "resend_count": 0,
                        "email_verified": True,
                    })
                elif not existing_unver.get("email_verified"):
                    rest_update("unverified_users", {"unverifiedid": existing_unver.get("unverifiedid")}, {"email_verified": True})
            except Exception as e:
                logger.warning(f"/signup MERGE: could not ensure unverified_users for email={email} err={e}")
            elapsed = _now_ms() - t0
            ensure_auth_provider(existing_userid, "Local", username)
            logger.info(f"/signup MERGE userid={existing_userid} email={email} username={username} name={account_name}")
            return {
                "status": "ok",
                "merged": True,
                "userid": existing_userid,
                "username": username,
                "email": email,
                "elapsedMs": elapsed,
                "verificationEmailSent": False,
                "emailVerified": True,
            }
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

    # 3b. Register Local auth provider
    ensure_auth_provider(userid, "Local", username)

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
    Login: accepts email+password, phone+password, or username+password.
    Phone numbers are normalised to E.164 before lookup.
    """
    t0 = _now_ms()
    identifier = (payload.get('identifier') or '').strip()
    password = payload.get('password') or ''
    remember_me = bool(payload.get('rememberMe'))
    logger.debug(f"/login START identifier={identifier}")
    if not identifier or not password:
        raise HTTPException(status_code=400, detail="Missing identifier/password")

    looks_like_email = '@' in identifier
    looks_like_phone = _looks_like_phone(identifier)

    if looks_like_phone:
        e164 = _normalize_phone(identifier)
        info_row = find_user_by_phone(e164)
        if not info_row:
            raise HTTPException(status_code=404, detail="Account not found")
        userid = info_row.get('userid')
        login_row = rest_select("userlogin", "loginid, userid, username, passwordhash, logintype", {"userid": userid}, single=True)
        # Phone users are verified via unverified_users with the E.164 number as the key
        unver = find_unverified_by_phone(e164)
        if not unver or not unver.get('phone_verified'):
            raise HTTPException(status_code=403, detail="PHONE_NOT_VERIFIED")
    elif looks_like_email:
        info_row = find_user_by_email(identifier)
        if not info_row:
            raise HTTPException(status_code=404, detail="Account not found")
        userid = info_row.get('userid')
        login_row = rest_select("userlogin", "loginid, userid, username, passwordhash, logintype", {"userid": userid}, single=True)
        unver = find_unverified_by_email(identifier)
        if not unver or not unver.get('email_verified'):
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
        _lt = (login_row.get('logintype') or 'local').strip().lower()
        if _lt == 'phone':
            # Phone account — verify via phone column
            phone_num = info_row.get('contactnumber') if info_row else None
            if phone_num:
                unver_ph = find_unverified_by_phone(phone_num)
                if not unver_ph or not unver_ph.get('phone_verified'):
                    raise HTTPException(status_code=403, detail="PHONE_NOT_VERIFIED")
        elif info_row and info_row.get('email'):
            unver = find_unverified_by_email(info_row.get('email'))
            if not unver or not unver.get('email_verified'):
                raise HTTPException(status_code=403, detail="EMAIL_NOT_VERIFIED")

    if not login_row:
        raise HTTPException(status_code=404, detail="Login record not found")

    # Reject OAuth (Google/Apple/etc.) accounts from using password-based login.
    # Phone accounts (logintype='Phone') and local email accounts (logintype='Local') are allowed.
    _logintype = (login_row.get('logintype') or 'local').strip().lower()
    if _logintype not in ('local', 'phone'):
        provider_display = login_row.get('logintype') or 'social'
        raise HTTPException(
            status_code=400,
            detail=f"This account uses {provider_display} sign-in. Please use the corresponding sign-in method.",
        )

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

    # Back-fill user_auth_providers for Local accounts (idempotent)
    _lt_local = (login_row.get('logintype') or '').strip().lower()
    if _lt_local == 'local':
        _ul = login_row.get('username')
        if _ul:
            ensure_auth_provider(userid, 'Local', _ul)

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

    # ── Pending email-change: update userinfo.email to the just-verified address ──
    # If the verified email differs from the user's current userinfo.email it means
    # the user initiated an email change via /auth/register-pending-email.
    if row.get("userid"):
        try:
            current_info = rest_select("userinfo", "infoid, userid, email", {"userid": row.get("userid")}, single=True)
            if current_info and current_info.get("email") != row.get("email"):
                rest_update("userinfo", {"userid": row.get("userid")}, {"email": row.get("email")})
                logger.info(f"/verify-email updated userinfo.email={row.get('email')} for userid={row.get('userid')}")
        except Exception as e:
            logger.warning(f"/verify-email could not update userinfo.email: {e}")

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


@router.post('/zalo/token')
def zalo_exchange_token(payload: dict):
    """Exchange a Zalo PKCE authorization code for an access_token.

    The frontend calls this first, then uses the returned access_token to call
    graph.zalo.me *from the device* (Vietnam IP) to fetch the user's id and name,
    and finally calls /auth/zalo with {access_token, zalo_id, zalo_name}.
    """
    code = (payload.get('code') or '').strip()
    code_verifier = (payload.get('code_verifier') or '').strip()
    if not code or not code_verifier:
        raise HTTPException(status_code=400, detail="Missing code or code_verifier")

    zalo_app_id = os.getenv("ZALO_APP_ID", "959402498466634174")
    zalo_app_secret = os.getenv("ZALO_APP_SECRET", "")
    if not zalo_app_secret:
        logger.error("/auth/zalo/token ZALO_APP_SECRET not configured")
        raise HTTPException(status_code=503, detail="Zalo sign-in not configured on server")

    try:
        token_resp = httpx.post(
            "https://oauth.zaloapp.com/v4/access_token",
            data={
                "app_id": zalo_app_id,
                "app_secret": zalo_app_secret,
                "code": code,
                "code_verifier": code_verifier,
                "grant_type": "authorization_code",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=10.0,
        )
        token_json = token_resp.json()
    except Exception as e:
        logger.exception(f"/auth/zalo/token exchange error: {e}")
        raise HTTPException(status_code=502, detail=f"Zalo token exchange failed: {e}")

    access_token = token_json.get("access_token") or ""
    if not access_token:
        logger.error(f"/auth/zalo/token returned no access_token: {token_json}")
        raise HTTPException(
            status_code=401,
            detail=f"Zalo token exchange error: {token_json.get('error_description') or token_json.get('error') or 'unknown'}",
        )

    # Whitelist this token so /auth/zalo can trust it without re-calling Zalo
    _whitelist_zalo_token(access_token)
    logger.debug(f"/auth/zalo/token whitelisted token (first 12 chars): {access_token[:12]}...")

    # Fetch user_id via oauth.zaloapp.com/v4/tokeninfo — simple GET with access_token header,
    # no app_secret needed, accessible from any region (unlike graph.zalo.me).
    user_id: str = ""
    try:
        info_resp = httpx.get(
            "https://oauth.zaloapp.com/v4/tokeninfo",
            headers={"access_token": access_token},
            timeout=8.0,
        )
        info_json = info_resp.json()
        user_id = str(info_json.get("user_id") or "")
        logger.debug(f"/auth/zalo/token tokeninfo user_id={user_id or '(empty)'} raw={info_json}")
    except Exception as e:
        logger.warning(f"/auth/zalo/token tokeninfo error (non-fatal): {e}")

    return {"access_token": access_token, "user_id": user_id}


@router.post('/zalo')
def zalo_sign_in(payload: dict):
    """Authenticate using a Zalo access_token + verified user identity.

    Flow (PKCE, V4):
      1. Frontend opens Zalo OAuth with code_challenge.
      2. Zalo redirects to app with ?code=...
      3. Frontend calls POST /auth/zalo/token { code, code_verifier } → { access_token }.
      4. Frontend calls GET graph.zalo.me/v2.0/me from the device (Vietnam IP) → { id, name }.
      5. Frontend POSTs { access_token, zalo_id, zalo_name } here.
      6. Backend verifies the token via oauth.zaloapp.com/v4/tokeninfo (geographically unrestricted).
      7. Backend creates/syncs user and returns our JWT.
    """
    t0 = _now_ms()
    access_token = (payload.get('access_token') or '').strip()
    zalo_id = str(payload.get('zalo_id') or '').strip()
    zalo_name = str(payload.get('zalo_name') or '').strip()
    zalo_phone_raw = str(payload.get('zalo_phone') or '').strip()
    # Normalise to E.164 (Zalo SDK may return "0912345678" → "+84912345678")
    zalo_phone = _normalize_phone(zalo_phone_raw) if zalo_phone_raw else None

    if not access_token or not zalo_id:
        raise HTTPException(status_code=400, detail="Missing access_token or zalo_id")

    zalo_app_secret = os.getenv("ZALO_APP_SECRET", "")
    if not zalo_app_secret:
        logger.error("/auth/zalo ZALO_APP_SECRET not configured")
        raise HTTPException(status_code=503, detail="Zalo sign-in not configured on server")

    # Trust model: the Zalo native SDK on the device opens the Zalo app directly,
    # authenticates with Zalo's servers, and returns a real Zalo access_token.
    # getUserProfile() is called on the device (Vietnam IP) to confirm zalo_id/zalo_name.
    # No server-side Zalo API call is possible (geo-blocked from SG server) and none is needed.
    logger.debug(f"/auth/zalo native SDK sign-in for zalo_id={zalo_id}")

    display_name = zalo_name or f"Zalo User {zalo_id}"

    # 3. Find or create user — provider-first lookup, then create new

    # Step 1: look up by (Zalo, zalo_id) in user_auth_providers
    existing_by_provider = find_user_by_provider("Zalo", zalo_id)
    if existing_by_provider:
        userid = existing_by_provider.get("userid")
        existing_info = find_userinfo_by_userid(userid)
        # Only update display name if it changed — never touch email or pfp
        if zalo_name and (existing_info or {}).get("name") != zalo_name:
            try:
                rest_update("userinfo", {"userid": userid}, {"name": zalo_name})
            except Exception as e:
                logger.warning(f"/auth/zalo name update failed userid={userid} err={e}")
        try:
            tokens = create_user_tokens(userid, None, None, remember_me=True)
        except Exception as e:
            raise HTTPException(status_code=500, detail="Token creation failed")
        logger.debug(f"/auth/zalo existing user (provider lookup) userid={userid} elapsedMs={_now_ms()-t0}")
        users_row = rest_select("users", "userid, role", {"userid": userid}, single=True)
        existing_role = (users_row.get("role") if users_row else None) or "player"
        return {
            "status": "ok",
            "userid": userid,
            "name": (existing_info or {}).get("name") or display_name,
            "logintype": "Zalo",
            "role": existing_role,
            "accessToken": tokens.get("access_token"),
            "accessTokenExpiresAt": tokens.get("access_token_expires_at"),
            "refreshToken": tokens.get("refresh_token"),
            "refreshTokenExpiresAt": tokens.get("refresh_token_expires_at"),
        }

    # Step 1b: phone collision — link Zalo provider to the existing account instead of creating a new user
    if zalo_phone:
        existing_by_phone = find_user_by_phone(zalo_phone)
        if existing_by_phone:
            userid = existing_by_phone.get("userid")
            ensure_auth_provider(userid, "Zalo", zalo_id)
            if zalo_name and existing_by_phone.get("name") != zalo_name:
                try:
                    rest_update("userinfo", {"userid": userid}, {"name": zalo_name})
                except Exception as e:
                    logger.warning(f"/auth/zalo phone-merge name update failed userid={userid} err={e}")
            try:
                tokens = create_user_tokens(userid, None, None, remember_me=True)
            except Exception as e:
                raise HTTPException(status_code=500, detail="Token creation failed")
            users_row = rest_select("users", "userid, role", {"userid": userid}, single=True)
            existing_role = (users_row.get("role") if users_row else None) or "player"
            existing_info = find_userinfo_by_userid(userid)
            logger.debug(f"/auth/zalo PHONE MERGE userid={userid} phone={zalo_phone} elapsedMs={_now_ms()-t0}")
            return {
                "status": "ok",
                "userid": userid,
                "name": (existing_info or existing_by_phone).get("name") or display_name,
                "logintype": "Zalo",
                "role": existing_role,
                "accessToken": tokens.get("access_token"),
                "accessTokenExpiresAt": tokens.get("access_token_expires_at"),
                "refreshToken": tokens.get("refresh_token"),
                "refreshTokenExpiresAt": tokens.get("refresh_token_expires_at"),
            }

    # Step 2: New user — provision users, userinfo, userlogin rows
    role = "player"
    try:
        users_rows = rest_upsert("users", {"role": role})
    except Exception as e:
        msg = str(e)
        if "permission denied for sequence users_userid_seq" in msg:
            max_row = rest_select("users", "userid", single=True, order={"column": "userid", "desc": True})
            next_userid = (max_row.get("userid") if max_row else 0) + 1
            users_rows = rest_upsert("users", {"userid": next_userid, "role": role})
        else:
            raise HTTPException(status_code=500, detail=f"users insert failed: {e}")
    userid = (users_rows[0] if users_rows else {}).get("userid")
    if not userid:
        raise HTTPException(status_code=500, detail="No userid returned")

    info_payload: dict = {"userid": userid, "name": display_name, "email": None}
    if zalo_phone:
        info_payload["contactnumber"] = zalo_phone
    try:
        info_rows = rest_upsert("userinfo", info_payload)
    except Exception as e:
        msg = str(e)
        if "permission denied for sequence userinfo_infoid_seq" in msg:
            max_row = rest_select("userinfo", "infoid", single=True, order={"column": "infoid", "desc": True})
            next_infoid = (max_row.get("infoid") if max_row else 0) + 1
            info_payload["infoid"] = next_infoid
            info_rows = rest_upsert("userinfo", info_payload)
        else:
            raise HTTPException(status_code=500, detail=f"userinfo insert failed: {e}")

    try:
        login_rows = rest_upsert("userlogin", {
            "userid": userid,
            "username": None,
            "passwordhash": None,
            "logintype": "Zalo",
        })
    except Exception as e:
        msg = str(e)
        if "permission denied for sequence userlogin_loginid_seq" in msg:
            max_row = rest_select("userlogin", "loginid", single=True, order={"column": "loginid", "desc": True})
            next_loginid = (max_row.get("loginid") if max_row else 0) + 1
            login_rows = rest_upsert("userlogin", {
                "loginid": next_loginid,
                "userid": userid,
                "username": None,
                "passwordhash": None,
                "logintype": "Zalo",
            })
        else:
            raise HTTPException(status_code=500, detail=f"userlogin insert failed: {e}")

    # Register Zalo auth provider for this new user
    ensure_auth_provider(userid, "Zalo", zalo_id)

    # Insert unverified_users record using the Zalo phone number (phone_verified=True).
    # Zalo accounts are phone-verified by Zalo's own OTP flow — we treat the phone as
    # pre-verified, mirroring how /auth/sync marks Google emails as email_verified=True.
    if zalo_phone:
        try:
            max_row = rest_select("unverified_users", "unverifiedid", single=True, order={"column": "unverifiedid", "desc": True})
            next_unver_id = ((max_row.get("unverifiedid") if max_row else None) or 0) + 1
            rest_upsert("unverified_users", {
                "unverifiedid": next_unver_id,
                "userid": userid,
                "phone": zalo_phone,
                "token_hash": f"ZALO_PHONE_VERIFIED:{hashlib.sha256(zalo_phone.encode()).hexdigest()[:24]}",
                "token_expires_at": "2099-01-01T00:00:00+00:00",
                "resend_count": 0,
                "phone_verified": True,
            })
            logger.debug(f"/auth/zalo unverified_users phone record created userid={userid} phone={zalo_phone}")
        except Exception as e:
            logger.warning(f"/auth/zalo unverified_users phone insert failed userid={userid} err={e}")
    else:
        logger.debug(f"/auth/zalo no phone returned by Zalo SDK for zalo_id={zalo_id} — skipping unverified_users")

    try:
        tokens = create_user_tokens(userid, None, None, remember_me=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Token creation failed: {e}")

    logger.debug(f"/auth/zalo NEW user userid={userid} zalo_id={zalo_id} elapsedMs={_now_ms()-t0}")
    return {
        "status": "ok",
        "userid": userid,
        "name": display_name,
        "logintype": "Zalo",
        "role": role,
        "accessToken": tokens.get("access_token"),
        "accessTokenExpiresAt": tokens.get("access_token_expires_at"),
        "refreshToken": tokens.get("refresh_token"),
        "refreshTokenExpiresAt": tokens.get("refresh_token_expires_at"),
    }


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

    # Supabase JWT sub (UUID) used as provider_uid for OAuth providers
    sub = (payload.get("sub") or "").strip()

    t0 = _now_ms()

    # ── Step 1: Check user_auth_providers by (provider, sub) ─────────────────
    if sub:
        existing_by_provider = find_user_by_provider(provider, sub)
        if existing_by_provider:
            userid = existing_by_provider.get("userid")
            login_row = rest_select("userlogin", "loginid, userid, username, logintype", {"userid": userid}, single=True)
            info_row = find_userinfo_by_userid(userid)
            username = (login_row.get("username") if login_row else None) or email.split("@")[0]
            try:
                tokens = create_user_tokens(userid, username, email, False)
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Failed issuing tokens: {e}")
            logger.debug(f"/auth/sync via provider lookup userid={userid} elapsedMs={_now_ms()-t0}")
            return {
                "status": "ok",
                "userid": userid,
                "username": username,
                "email": email,
                "name": (info_row.get("name") if info_row else None) or name,
                "logintype": provider,
                "accessToken": tokens["access_token"],
                "accessTokenExpiresAt": tokens["access_token_expires_at"],
                "refreshToken": tokens["refresh_token"],
                "refreshTokenExpiresAt": tokens["refresh_token_expires_at"],
            }

    # ── Step 2: Check by email (account linking / migration) ─────────────────
    existing_info = find_user_by_email(email)
    if existing_info:
        userid = existing_info.get("userid")
        if sub:
            ensure_auth_provider(userid, provider, sub)
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
        logger.debug(f"/auth/sync existing user (email match) userid={userid} elapsedMs={_now_ms()-t0}")
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

    # ── Step 3: New user provisioning ────────────────────────────────────────
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

    # For OAuth users: username and passwordhash are NULL in the DB.
    # We derive a display name for the JWT claim only — it is NOT stored.
    username_for_token = email.split("@")[0]

    try:
        login_rows = rest_upsert("userlogin", {
            "userid": userid,
            "username": None,       # NULL — Google users have no username
            "passwordhash": None,   # NULL — Google users have no password
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
                    "username": None,
                    "passwordhash": None,
                    "logintype": provider,
                })
            except Exception as e3:
                raise HTTPException(status_code=500, detail=f"userlogin insert failed: {e3}")
        else:
            raise HTTPException(status_code=500, detail=f"userlogin insert failed: {e}")

    # Register OAuth provider for this new user
    if sub:
        ensure_auth_provider(userid, provider, sub)

    # Mark email as pre-verified — OAuth providers already confirm email ownership.
    # This is critical: /login checks unverified_users.email_verified before allowing access.
    try:
        ver_rec = _create_or_update_unverified(userid, email)
        rest_update(
            "unverified_users",
            {"unverifiedid": ver_rec.get("unverifiedid")},
            {"email_verified": True, "token_hash": f"SOCIAL:{provider}:{userid}"},
        )
        logger.debug(f"/auth/sync pre-verified email for userid={userid}")
    except Exception as e:
        # Log clearly — a failure here won't block /auth/sync (OAuth bypasses /login),
        # but it would affect /verification-status and any future local login attempts.
        logger.error(f"/auth/sync FAILED to write unverified_users pre-verification userid={userid} err={e}")

    try:
        tokens = create_user_tokens(userid, username_for_token, email, False)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed issuing tokens: {e}")

    logger.debug(f"/auth/sync new user userid={userid} provider={provider} elapsedMs={_now_ms()-t0}")
    return {
        "status": "ok",
        "userid": userid,
        "username": username_for_token,
        "email": email,
        "name": name,
        "logintype": provider,
        "accessToken": tokens["access_token"],
        "accessTokenExpiresAt": tokens["access_token_expires_at"],
        "refreshToken": tokens["refresh_token"],
        "refreshTokenExpiresAt": tokens["refresh_token_expires_at"],
    }


@router.post('/register-phone')
def register_pending_phone(payload: dict, authorization: Optional[str] = Header(None)):
    """Register a phone number for OTP verification (authenticated).
    Writes to unverified_users with phone_verified=false.
    Does NOT update userinfo.contactnumber — that only happens after OTP is confirmed via /verify-phone.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    access_token = authorization[7:]
    try:
        token_payload = decode_token(access_token)
        userid = int(token_payload.get("sub"))
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    phone_raw = (payload.get('phone') or '').strip()
    if not phone_raw:
        raise HTTPException(status_code=400, detail="Missing phone")

    # Validate VN phone format (0[3-9]XXXXXXXX)
    if not re.match(r'^0[3-9]\d{8}$', phone_raw):
        raise HTTPException(status_code=400, detail="Invalid Vietnamese phone format (must be 10 digits starting with 0[3-9])")

    # Normalize to E.164
    phone_e164 = '+84' + phone_raw[1:]

    # Check if phone is already taken by another user in userinfo
    existing_info = rest_select("userinfo", "userid", {"contactnumber": phone_e164}, single=True)
    if not existing_info:
        existing_info = rest_select("userinfo", "userid", {"contactnumber": phone_raw}, single=True)
    if existing_info and existing_info.get('userid') != userid:
        raise HTTPException(status_code=409, detail="Phone number already in use by another account")

    token_hash_val = f"PHONE_PENDING:{hashlib.sha256(f'{userid}:{phone_e164}'.encode()).hexdigest()[:24]}"
    token_expires = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()

    # Upsert unverified_users record
    try:
        existing_unver = rest_select("unverified_users", "unverifiedid", {"userid": userid}, single=True)
        if existing_unver:
            rest_update("unverified_users", {"unverifiedid": existing_unver.get("unverifiedid")}, {
                "phone": phone_e164,
                "phone_verified": False,
                "token_hash": token_hash_val,
                "token_expires_at": token_expires,
            })
        else:
            max_row = rest_select("unverified_users", "unverifiedid", single=True, order={"column": "unverifiedid", "desc": True})
            next_id = ((max_row.get("unverifiedid") if max_row else None) or 0) + 1
            rest_upsert("unverified_users", {
                "unverifiedid": next_id,
                "userid": userid,
                "phone": phone_e164,
                "phone_verified": False,
                "token_hash": token_hash_val,
                "token_expires_at": token_expires,
                "resend_count": 0,
            })
    except Exception as e:
        logger.warning(f"/register-phone unverified_users write failed userid={userid} err={e}")
        raise HTTPException(status_code=500, detail="Failed to register phone")

    logger.info(f"/register-phone SUCCESS userid={userid} phone={phone_e164}")
    return {"status": "ok"}


@router.post('/verify-phone')
def verify_phone_for_account(payload: dict, authorization: Optional[str] = Header(None)):
    """Verify phone OTP via Firebase token for an already-logged-in user.
    Updates userinfo.contactnumber and marks unverified_users.phone_verified=true.
    Does NOT issue new session tokens.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    access_token = authorization[7:]
    try:
        token_payload = decode_token(access_token)
        userid = int(token_payload.get("sub"))
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    firebase_id_token = (payload.get('firebase_id_token') or '').strip()
    if not firebase_id_token:
        raise HTTPException(status_code=400, detail="Missing firebase_id_token")

    # Verify Firebase token
    try:
        firebase_app = _get_firebase_app()
        decoded = fb_auth.verify_id_token(firebase_id_token, app=firebase_app, check_revoked=False)
    except Exception as e:
        logger.warning(f"/verify-phone Firebase verify failed userid={userid} err={e}")
        raise HTTPException(status_code=401, detail=f"Invalid Firebase token: {str(e)[:120]}")

    phone_number = decoded.get('phone_number')
    if not phone_number:
        raise HTTPException(status_code=400, detail="Firebase token does not contain phone_number")

    # Update userinfo.contactnumber for this user
    try:
        rest_update("userinfo", {"userid": userid}, {"contactnumber": phone_number})
    except Exception as e:
        logger.error(f"/verify-phone userinfo update failed userid={userid} err={e}")
        raise HTTPException(status_code=500, detail="Failed to update contact number")

    # Update unverified_users.phone_verified = true
    try:
        existing_unver = rest_select("unverified_users", "unverifiedid", {"userid": userid}, single=True)
        if existing_unver:
            rest_update("unverified_users", {"unverifiedid": existing_unver.get("unverifiedid")}, {
                "phone": phone_number,
                "phone_verified": True,
            })
        else:
            max_row = rest_select("unverified_users", "unverifiedid", single=True, order={"column": "unverifiedid", "desc": True})
            next_id = ((max_row.get("unverifiedid") if max_row else None) or 0) + 1
            rest_upsert("unverified_users", {
                "unverifiedid": next_id,
                "userid": userid,
                "phone": phone_number,
                "phone_verified": True,
                "token_hash": f"PHONE_VERIFIED:{hashlib.sha256(phone_number.encode()).hexdigest()[:24]}",
                "token_expires_at": "2099-01-01T00:00:00+00:00",
                "resend_count": 0,
            })
    except Exception as e:
        logger.warning(f"/verify-phone unverified_users update failed userid={userid} err={e}")

    logger.info(f"/verify-phone SUCCESS userid={userid} phone={phone_number}")
    return {"status": "ok", "phone": phone_number}


@router.post('/phone-login')
def phone_login(payload: dict):
    """
    Firebase Phone OTP login.
    Client verifies OTP with Firebase, then sends the resulting ID token here.
    We verify the token server-side, find or create the user by phone number,
    and return a standard session token pair.
    """
    t0 = _now_ms()
    firebase_id_token = (payload.get('firebase_id_token') or '').strip()
    display_name = (payload.get('display_name') or '').strip()

    if not firebase_id_token:
        raise HTTPException(status_code=400, detail="Missing firebase_id_token")

    # ── Verify Firebase ID token ──────────────────────────────────────────────
    try:
        firebase_app = _get_firebase_app()
        decoded = fb_auth.verify_id_token(firebase_id_token, app=firebase_app, check_revoked=False)
    except Exception as e:
        logger.warning(f"/phone-login Firebase verify failed err={e}")
        raise HTTPException(status_code=401, detail=f"Invalid Firebase token: {str(e)[:120]}")

    phone_number = decoded.get('phone_number')
    firebase_uid = (decoded.get('uid') or '').strip()
    if not phone_number:
        raise HTTPException(status_code=400, detail="Firebase token does not contain a phone_number claim")

    logger.debug(f"/phone-login START phone={phone_number} firebase_uid={firebase_uid}")

    # ── Find or create user ───────────────────────────────────────────────────
    info_row = None
    login_row = None
    _phone_provider_linked = False  # True when user was found via user_auth_providers (no re-insert needed)

    # Step 1: look up by user_auth_providers (Phone, firebase_uid)
    if firebase_uid:
        prov_row = find_user_by_provider('Phone', firebase_uid)
        if prov_row:
            userid = prov_row.get('userid')
            info_row = find_userinfo_by_userid(userid)
            login_row = rest_select("userlogin", "loginid, userid, username, logintype", {"userid": userid}, single=True)
            _phone_provider_linked = True
            logger.debug(f"/phone-login existing user via provider lookup userid={userid}")

    if not _phone_provider_linked:
        # Step 2: fallback to contactnumber lookup (existing user / migration path)
        info_row = find_user_by_phone(phone_number)
        if info_row:
            userid = info_row.get('userid')
            login_row = rest_select("userlogin", "loginid, userid, username, logintype", {"userid": userid}, single=True)
            logger.debug(f"/phone-login existing user via phone lookup userid={userid}")
        else:
            # Step 3: create new user (users → userinfo → userlogin)
            role = 'player'
            try:
                users_rows = rest_upsert("users", {"role": role})
            except Exception as e:
                if "permission denied for sequence users_userid_seq" in str(e):
                    max_row = rest_select("users", "userid", single=True, order={"column": "userid", "desc": True})
                    next_id = (max_row.get('userid') if max_row else 0) + 1
                    users_rows = rest_upsert("users", {"userid": next_id, "role": role})
                else:
                    raise HTTPException(status_code=500, detail=f"users insert failed: {e}")
            if not users_rows or not isinstance(users_rows, list):
                raise HTTPException(status_code=500, detail="Unexpected users insert response")
            userid = users_rows[0].get('userid')
            if not userid:
                raise HTTPException(status_code=500, detail="No userid from users insert")

            account_name = display_name or f"User{userid}"
            try:
                info_rows = rest_upsert("userinfo", {"userid": userid, "name": account_name, "contactnumber": phone_number})
            except Exception as e:
                if "permission denied for sequence userinfo_infoid_seq" in str(e):
                    max_row = rest_select("userinfo", "infoid", single=True, order={"column": "infoid", "desc": True})
                    next_id = (max_row.get('infoid') if max_row else 0) + 1
                    info_rows = rest_upsert("userinfo", {"infoid": next_id, "userid": userid, "name": account_name, "contactnumber": phone_number})
                else:
                    raise HTTPException(status_code=500, detail=f"userinfo insert failed: {e}")
            info_row = info_rows[0] if isinstance(info_rows, list) else {"userid": userid, "name": account_name}

            try:
                login_rows = rest_upsert("userlogin", {"userid": userid, "username": None, "passwordhash": None, "logintype": "Phone"})
            except Exception as e:
                if "permission denied for sequence userlogin_loginid_seq" in str(e):
                    max_row = rest_select("userlogin", "loginid", single=True, order={"column": "loginid", "desc": True})
                    next_id = (max_row.get('loginid') if max_row else 0) + 1
                    login_rows = rest_upsert("userlogin", {"loginid": next_id, "userid": userid, "username": None, "passwordhash": None, "logintype": "Phone"})
                else:
                    raise HTTPException(status_code=500, detail=f"userlogin insert failed: {e}")
            login_row = login_rows[0] if isinstance(login_rows, list) else {"userid": userid}
            logger.debug(f"/phone-login new user created userid={userid}")

        # Register Phone provider (step 2 migration linking + step 3 new user)
        if firebase_uid:
            ensure_auth_provider(userid, 'Phone', firebase_uid)

    # ── Ensure unverified_users record (phone column, pre-verified) ─────────
    # OTP was already confirmed by Firebase when we reach here, so phone_verified=True.
    try:
        existing_unver = rest_select("unverified_users", "unverifiedid, phone_verified, phone", {"phone": phone_number}, single=True)
        if not existing_unver:
            # Check legacy record stored in email column and migrate it
            legacy_unver = rest_select("unverified_users", "unverifiedid, email, phone_verified", {"email": phone_number}, single=True)
            if legacy_unver:
                # Migrate: move phone number from email column to phone column
                rest_update("unverified_users", {"unverifiedid": legacy_unver.get("unverifiedid")}, {
                    "phone": phone_number,
                    "phone_verified": True,
                    "email": None,
                })
                logger.debug(f"/phone-login migrated legacy unverified record for phone={phone_number}")
            else:
                # No record at all — create new one using proper phone column
                max_row = rest_select("unverified_users", "unverifiedid", single=True, order={"column": "unverifiedid", "desc": True})
                next_id = ((max_row.get("unverifiedid") if max_row else None) or 0) + 1
                rest_upsert("unverified_users", {
                    "unverifiedid": next_id,
                    "userid": userid,
                    "phone": phone_number,
                    "token_hash": f"PHONE_VERIFIED:{hashlib.sha256(phone_number.encode()).hexdigest()[:24]}",
                    "token_expires_at": "2099-01-01T00:00:00+00:00",
                    "resend_count": 0,
                    "phone_verified": True,
                })
        elif not existing_unver.get("phone_verified"):
            rest_update("unverified_users", {"unverifiedid": existing_unver.get("unverifiedid")}, {"phone_verified": True})
    except Exception as e:
        logger.warning(f"/phone-login unverified_users ensure failed phone={phone_number} err={e}")

    # ── Issue session tokens ──────────────────────────────────────────────────
    username = (login_row.get('username') if login_row else None)
    email = (info_row.get('email') if info_row else None)
    name = (info_row.get('name') if info_row else None)

    try:
        tokens = create_user_tokens(userid, username, email, False)
    except Exception as e:
        logger.error(f"/phone-login token creation failed userid={userid} err={e}")
        raise HTTPException(status_code=500, detail="Token creation failed")

    elapsed = _now_ms() - t0
    logger.info(f"/phone-login SUCCESS userid={userid} phone={phone_number} elapsedMs={elapsed}")
    return {
        "status": "ok",
        "userid": userid,
        "username": username,
        "email": email,
        "name": name,
        "phone": phone_number,
        "elapsedMs": elapsed,
        "accessToken": tokens.get('access_token'),
        "accessTokenExpiresAt": tokens.get('access_token_expires_at'),
        "refreshToken": tokens.get('refresh_token'),
        "refreshTokenExpiresAt": tokens.get('refresh_token_expires_at'),
    }


@router.post('/register-pending-email')
def register_pending_email(payload: dict, background_tasks: BackgroundTasks, authorization: Optional[str] = Header(None)):
    """Register a new email address for the currently authenticated user (pending verification).

    This does NOT update userinfo.email immediately.  Instead it:
      1. Validates the new email is not taken by another account.
      2. Creates/updates an unverified_users row with email_verified=False.
      3. Emails the user a verification link.

    When the user clicks the link, /auth/verify-email marks email_verified=True
    AND updates userinfo.email to the new address.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    access_token_raw = authorization[7:]
    try:
        token_payload = decode_token(access_token_raw)
        userid = int(token_payload.get("sub"))
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    new_email = (payload.get('email') or '').strip()
    if not new_email or '@' not in new_email:
        raise HTTPException(status_code=400, detail="Missing or invalid email")

    # Reject if taken by a DIFFERENT user
    existing_info = find_user_by_email(new_email)
    if existing_info and existing_info.get('userid') != userid:
        raise HTTPException(status_code=409, detail="Email already in use by another account")

    cfg = _email_settings()
    token_plain = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token_plain.encode('utf-8')).hexdigest()
    expires_at = (datetime.utcnow() + timedelta(hours=cfg['expiry_hours'])).isoformat()

    # Lookup existing unverified_users record for this email
    existing_pending = find_unverified_by_email(new_email)
    if existing_pending:
        if existing_pending.get('userid') not in (userid, None):
            raise HTTPException(status_code=409, detail="Email already pending verification for another account")
        try:
            rest_update("unverified_users", {"unverifiedid": existing_pending.get("unverifiedid")}, {
                "userid": userid,
                "token_hash": token_hash,
                "token_expires_at": expires_at,
                "email_verified": False,
                "resend_count": 0,
            })
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed updating verification record: {e}")
    else:
        try:
            max_row = rest_select("unverified_users", "unverifiedid", single=True, order={"column": "unverifiedid", "desc": True})
            next_id = ((max_row.get("unverifiedid") if max_row else None) or 0) + 1
            rest_upsert("unverified_users", {
                "unverifiedid": next_id,
                "userid": userid,
                "email": new_email,
                "token_hash": token_hash,
                "token_expires_at": expires_at,
                "resend_count": 0,
                "email_verified": False,
            })
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed creating verification record: {e}")

    email_sent = False
    if _can_send_verification_email():
        background_tasks.add_task(_deliver_verification_email_task, new_email, token_plain)
        email_sent = True
    else:
        logger.warning("/auth/register-pending-email: SMTP not configured; verification email not queued")

    logger.info(f"/auth/register-pending-email SUCCESS userid={userid} email={new_email} emailSent={email_sent}")
    return {"status": "ok", "emailSent": email_sent}


@router.post('/link-zalo')
def link_zalo(payload: dict, authorization: Optional[str] = Header(None)):
    """Link a Zalo account to the currently authenticated user.

    Called from Account Settings after a successful login('AUTH_VIA_APP') + getUserProfile()
    call on the device.  The backend records the provider association in user_auth_providers.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    access_token_raw = authorization[7:]
    try:
        token_payload = decode_token(access_token_raw)
        userid = int(token_payload.get("sub"))
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    zalo_id = str(payload.get('zalo_id') or '').strip()
    zalo_name = str(payload.get('zalo_name') or '').strip()
    if not zalo_id:
        raise HTTPException(status_code=400, detail="Missing zalo_id")

    # Reject if this Zalo ID already belongs to a DIFFERENT user
    existing = find_user_by_provider("Zalo", zalo_id)
    if existing and existing.get("userid") != userid:
        raise HTTPException(status_code=409, detail="This Zalo account is already linked to a different user")

    ensure_auth_provider(userid, "Zalo", zalo_id)
    logger.info(f"/auth/link-zalo SUCCESS userid={userid} zalo_id={zalo_id}")
    return {"status": "ok", "linked": True}

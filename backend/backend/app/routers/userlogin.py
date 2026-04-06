from fastapi import APIRouter, HTTPException, Query, Header
from typing import Optional
from ..db import rest_select, rest_upsert, rest_insert
from ..auth import decode_token
import logging, hashlib, secrets, os, smtplib
from email.message import EmailMessage
from datetime import datetime, timedelta
from passlib.context import CryptContext

logger = logging.getLogger("password_reset")
if not logger.handlers:
    h = logging.StreamHandler()
    f = logging.Formatter('[PWD_RESET] %(asctime)s %(levelname)s %(message)s')
    h.setFormatter(f)
    logger.addHandler(h)
logger.setLevel(logging.DEBUG)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def _get_password_pepper() -> str:
    val = os.getenv("PASSWORD_PEPPER", "")
    return val.strip().strip('"').strip("'")

_reset_tokens: dict[str, dict] = {}

def _now() -> datetime:
    return datetime.utcnow()

def _exp_minutes() -> int:
    try:
        return int(os.getenv("PASSWORD_RESET_EXP_MINUTES", "60"))
    except Exception:
        return 60

def _password_reset_base_url() -> str:
    return os.getenv("PASSWORD_RESET_BASE_URL", "http://localhost:8081/(auth)/newpassword")

def _email_settings():
    return {
        "host": os.getenv("SMTP_HOST"),
        "port": int(os.getenv("SMTP_PORT", "587")),
        "username": os.getenv("SMTP_USERNAME"),
        "password": os.getenv("SMTP_PASSWORD"),
        "sender": os.getenv("SMTP_SENDER_EMAIL", os.getenv("SENDER_EMAIL", "noreply@example.com")),
        "sender_name": os.getenv("SMTP_SENDER_NAME", os.getenv("SENDER_NAME", "SportConnect")),
    }

def _send_password_reset_email(to_email: str, token_plain: str) -> bool:
    link = f"{_password_reset_base_url()}?token={token_plain}"
    cfg = _email_settings()
    if not cfg["host"] or not cfg["username"] or not cfg["password"]:
        logger.warning(f"SMTP settings incomplete; skipping password reset email to {to_email} link={link}")
        return False
    msg = EmailMessage()
    msg["Subject"] = "Reset Your Password"
    msg["From"] = f"{cfg['sender_name']} <{cfg['sender']}>"
    msg["To"] = to_email
    msg.set_content(f"Reset Password\n\nFollow this link to reset your password: {link}\nIf you did not request a reset, you can ignore this email.")
    msg.add_alternative(f"""\
<html><body style="font-family:Arial,sans-serif;padding:20px;color:#333">
<h2 style="color:#FF6017">Reset Your Password</h2>
<p>Click the button below to reset your password:</p>
<p style="margin:24px 0"><a href="{link}" style="background:#FF6017;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Reset Password</a></p>
<p style="color:#888;font-size:13px">If you did not request a reset, you can safely ignore this email.</p>
</body></html>""", subtype='html')
    try:
        with smtplib.SMTP(cfg['host'], cfg['port'], timeout=10) as smtp:
            smtp.starttls()
            smtp.login(cfg['username'], cfg['password'])
            smtp.send_message(msg)
        logger.info(f"Password reset email sent to {to_email} link={link}")
        return True
    except Exception as e:
        logger.warning(f"Failed sending password reset email to {to_email} err={e}")
        return False

router = APIRouter(prefix="/userlogin", tags=["users"])

PRIMARY_KEY = "loginid"

@router.get("", response_model=list[dict])
def list_userlogin(userid: int | None = Query(None, description="Filter by userid")):
    try:
        filters = {"userid": userid} if userid is not None else None
        data = rest_select("userlogin", "*", filters=filters, order={"column": PRIMARY_KEY})
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{loginid}", response_model=dict)
def get_userlogin(loginid: int):
    try:
        row = rest_select("userlogin", "*", filters={PRIMARY_KEY: loginid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="User login record not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("/forgot-password")
def forgot_password(payload: dict):
    """Initiate password reset by username OR email.
    Always returns {status: ok} even if account not found.
    Debug logs indicate lookup outcome. Generates one-time token stored in memory until used/expired.
    """
    identifier = (payload.get("identifier") or "").strip()
    if not identifier:
        raise HTTPException(status_code=400, detail="Missing identifier")
    looks_like_email = "@" in identifier
    userlogin_row = None
    email_for_send = None
    if looks_like_email:
        # Find via userinfo then userlogin
        info_row = rest_select("userinfo", "infoid, userid, email", {"email": identifier}, single=True)
        if not info_row:
            logger.debug(f"forgot-password identifier={identifier} emailNotFound")
        else:
            userlogin_row = rest_select("userlogin", "loginid, userid, username", {"userid": info_row.get("userid")}, single=True)
            email_for_send = info_row.get("email")
    else:
        userlogin_row = rest_select("userlogin", "loginid, userid, username", {"username": identifier}, single=True)
        if not userlogin_row:
            logger.debug(f"forgot-password identifier={identifier} usernameNotFound")
        else:
            # Fetch email for user (optional)
            info_row = rest_select("userinfo", "infoid, userid, email", {"userid": userlogin_row.get("userid")}, single=True)
            email_for_send = info_row.get("email") if info_row else None
    if not userlogin_row or not email_for_send:
        # Intentionally do NOT reveal non-existence; just return ok
        return {"status": "ok"}
    # Generate token + store hashed
    token_plain = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token_plain.encode("utf-8")).hexdigest()
    expires_at = (_now() + timedelta(minutes=_exp_minutes())).isoformat()
    _reset_tokens[token_hash] = {
        "userid": userlogin_row.get("userid"),
        "loginid": userlogin_row.get("loginid"),
        "username": userlogin_row.get("username"),
        "expires_at": expires_at,
        "used": False,
        "plaintext": token_plain,
    }
    sent = _send_password_reset_email(email_for_send, token_plain)
    logger.debug(f"forgot-password issued userid={userlogin_row.get('userid')} tokenHash={token_hash[:12]} exp={expires_at} sent={sent}")
    return {"status": "ok"}

@router.post("/reset-password")
def reset_password(payload: dict):
    """Complete reset: expects JSON { token, newPassword }"""
    token = (payload.get("token") or "").strip()
    new_pw = payload.get("newPassword") or ""
    if not token or not new_pw:
        raise HTTPException(status_code=400, detail="Missing token/newPassword")
    if len(new_pw) < 8:
        raise HTTPException(status_code=400, detail="Password too short (min 8)")
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    rec = _reset_tokens.get(token_hash)
    if not rec:
        raise HTTPException(status_code=400, detail="Invalid or expired token")
    if rec.get("used"):
        raise HTTPException(status_code=400, detail="Token already used")
    exp_raw = rec.get("expires_at")
    try:
        exp_dt = datetime.fromisoformat(exp_raw.replace("Z", "+00:00")) if exp_raw else None
    except Exception:
        exp_dt = None
    if exp_dt and exp_dt < _now():
        # expire & drop
        _reset_tokens.pop(token_hash, None)
        raise HTTPException(status_code=400, detail="Invalid or expired token")
    pepper = _get_password_pepper()
    bcrypt_hash = pwd_context.hash(new_pw + pepper)
    try:
        rest_upsert("userlogin", {
            "loginid": rec.get("loginid"),
            "userid": rec.get("userid"),
            "username": rec.get("username"),
            "passwordhash": bcrypt_hash,
            "logintype": "Local"
        })
    except Exception as e:
        logger.exception(f"reset-password update failed userid={rec.get('userid')} err={e}")
        raise HTTPException(status_code=500, detail="Failed updating password")
    rec["used"] = True
    logger.info(f"reset-password success userid={rec.get('userid')} tokenHash={token_hash[:12]}")
    return {"status": "ok", "reset": True}


@router.post("/add-local")
def add_local_credentials(payload: dict, authorization: Optional[str] = Header(None)):
    """Allow an OAuth-only user to add a username + password (local) login.
    Expects JSON: { username, newPassword }
    Authorization: Bearer <access_token>
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    access_token = authorization[7:]

    try:
        token_payload = decode_token(access_token)
        userid = int(token_payload.get("sub"))
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    username = (payload.get("username") or "").strip()
    new_pw = payload.get("newPassword") or ""

    if not username or not new_pw:
        raise HTTPException(status_code=400, detail="Missing username or newPassword")
    if len(username) < 3:
        raise HTTPException(status_code=400, detail="Username too short (min 3 characters)")
    if len(new_pw) < 8:
        raise HTTPException(status_code=400, detail="Password too short (min 8)")

    # Reject if user already has local credentials
    existing = rest_select("userlogin", "loginid,logintype", {"userid": userid}, single=True)
    if existing and (existing.get("logintype") or "").strip().lower() == "local":
        raise HTTPException(status_code=409, detail="User already has a local login")

    # Reject if username is taken by another user
    taken = rest_select("userlogin", "loginid", {"username": username}, single=True)
    if taken:
        raise HTTPException(status_code=409, detail="USERNAME_TAKEN")

    pepper = _get_password_pepper()
    new_hash = pwd_context.hash(new_pw + pepper)

    if existing:
        # Update existing OAuth row to become local
        rest_upsert("userlogin", {
            "loginid": existing.get("loginid"),
            "userid": userid,
            "username": username,
            "passwordhash": new_hash,
            "logintype": "Local",
        })
    else:
        rest_insert("userlogin", {
            "userid": userid,
            "username": username,
            "passwordhash": new_hash,
            "logintype": "Local",
        })

    # Ensure Local is recorded in user_auth_providers
    try:
        existing_prov = rest_select("user_auth_providers", "providerid", {"userid": userid, "provider": "Local"}, single=True)
        if not existing_prov:
            rest_insert("user_auth_providers", {"userid": userid, "provider": "Local"})
    except Exception:
        pass  # non-critical

    logger.info(f"add-local success userid={userid} username={username}")
    return {"status": "ok"}


@router.post("/change-password")
def change_password(payload: dict, authorization: Optional[str] = Header(None)):
    """Change password for an authenticated local account user.
    Expects JSON: { currentPassword, newPassword }
    Authorization: Bearer <access_token>
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    access_token = authorization[7:]

    try:
        token_payload = decode_token(access_token)
        userid = int(token_payload.get("sub"))
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    current_pw = payload.get("currentPassword") or ""
    new_pw = payload.get("newPassword") or ""

    if not current_pw or not new_pw:
        raise HTTPException(status_code=400, detail="Missing currentPassword or newPassword")
    if len(new_pw) < 8:
        raise HTTPException(status_code=400, detail="Password too short (min 8)")

    userlogin_row = rest_select("userlogin", "loginid, userid, username, passwordhash, logintype", {"userid": userid}, single=True)
    if not userlogin_row:
        raise HTTPException(status_code=404, detail="No login record found for this user")

    login_type = (userlogin_row.get("logintype") or "").strip().lower()
    if login_type not in ("local", ""):
        raise HTTPException(status_code=400, detail="Password change is only available for local accounts")

    stored_hash = userlogin_row.get("passwordhash") or ""
    pepper = _get_password_pepper()
    if not pwd_context.verify(current_pw + pepper, stored_hash):
        raise HTTPException(status_code=401, detail="Current password is incorrect")

    new_hash = pwd_context.hash(new_pw + pepper)
    try:
        rest_upsert("userlogin", {
            "loginid": userlogin_row.get("loginid"),
            "userid": userid,
            "username": userlogin_row.get("username"),
            "passwordhash": new_hash,
            "logintype": "Local",
        })
    except Exception as e:
        logger.exception(f"change-password update failed userid={userid} err={e}")
        raise HTTPException(status_code=500, detail="Failed updating password")

    logger.info(f"change-password success userid={userid}")
    return {"status": "ok"}

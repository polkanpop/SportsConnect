import os
import base64
import secrets
import hashlib
from datetime import datetime, timedelta
from typing import Tuple, Optional

from jose import jwt
from .auth import HS_ALGORITHM, get_jwt_secret
from .db import rest_insert, rest_upsert, rest_select, rest_update

try:
    # cryptography is available via python-jose extras
    from cryptography.fernet import Fernet
except Exception:  # pragma: no cover
    Fernet = None  # type: ignore


def _now() -> datetime:
    return datetime.utcnow()


def _get_encryption_key() -> Optional[str]:
    """32 url-safe base64-encoded bytes for Fernet. Generate with:
    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    """
    return os.getenv("TOKEN_ENCRYPTION_KEY")


def _get_refresh_pepper() -> str:
    return os.getenv("REFRESH_TOKEN_PEPPER", "pepper")


def _encrypt_access_token(token: str) -> bytes:
    key = _get_encryption_key()
    if key and Fernet:
        f = Fernet(key.encode() if isinstance(key, str) else key)
        return f.encrypt(token.encode())
    # Fallback: return original token bytes (still stored as bytea)
    return token.encode()


def _hash_refresh_token(refresh_token: str) -> str:
    # Deterministic SHA256 hash for lookup (unique index in table)
    h = hashlib.sha256()
    h.update(refresh_token.encode())
    h.update(_get_refresh_pepper().encode())
    return h.hexdigest()


def _issue_access_jwt(userid: int, username: Optional[str], email: Optional[str], access_minutes: int = 15) -> Tuple[str, datetime]:
    secret = get_jwt_secret()
    if not secret:
        raise RuntimeError("JWT secret not configured")
    exp = _now() + timedelta(minutes=access_minutes)
    payload = {
        "sub": str(userid),
        "username": username,
        "email": email,
        "iat": int(_now().timestamp()),
        "exp": int(exp.timestamp()),
    }
    token = jwt.encode(payload, secret, algorithm=HS_ALGORITHM)
    return token, exp


def create_user_tokens(userid: int, username: Optional[str], email: Optional[str], remember_me: bool) -> dict:
    """Create access + refresh token pair and persist in user_tokens.
    remember_me True -> refresh valid 30 days; else 1 day.
    Access token always short-lived (15m).
    Returns dict with plaintext access & refresh tokens plus expiries.
    """
    access_token, access_exp = _issue_access_jwt(userid, username, email)
    refresh_token = secrets.token_urlsafe(48)  # ~288 bits
    refresh_days = 30 if remember_me else 1
    refresh_exp = _now() + timedelta(days=refresh_days)
    encrypted_access_bytes = _encrypt_access_token(access_token)
    # PostgREST expects base64 for bytea JSON input
    encrypted_access_b64 = base64.b64encode(encrypted_access_bytes).decode()
    refresh_hash = _hash_refresh_token(refresh_token)
    row_payload = {
        "userid": userid,
        "access_token_encrypted": encrypted_access_b64,
        "refresh_token_hash": refresh_hash,
        "access_token_expires_at": access_exp.isoformat(),
        "refresh_token_expires_at": refresh_exp.isoformat(),
        "is_revoked": False,
    }
    # Use strict insert so duplicate hash errors surface (should not occur)
    rest_insert("user_tokens", row_payload)
    return {
        "access_token": access_token,
        "access_token_expires_at": access_exp.isoformat(),
        "refresh_token": refresh_token,
        "refresh_token_expires_at": refresh_exp.isoformat(),
        "remember_me": remember_me,
    }


def verify_and_refresh(refresh_token: str) -> dict:
    """Validate refresh token and issue new access token. Optionally rotate refresh (not implemented here)."""
    refresh_hash = _hash_refresh_token(refresh_token)
    row = rest_select("user_tokens", "tokenid, userid, access_token_expires_at, refresh_token_expires_at, is_revoked", {"refresh_token_hash": refresh_hash}, single=True)
    if not row:
        raise RuntimeError("Invalid refresh token")
    if row.get("is_revoked"):
        raise RuntimeError("Token revoked")
    refresh_exp = row.get("refresh_token_expires_at")
    if refresh_exp and datetime.fromisoformat(refresh_exp) < _now():
        raise RuntimeError("Refresh token expired")
    userid = row.get("userid")
    # For metadata we can optionally fetch username/email if needed
    access_token, access_exp = _issue_access_jwt(userid, None, None)
    encrypted_access_b64 = base64.b64encode(_encrypt_access_token(access_token)).decode()
    # Update existing row with new access token + last_used
    # Use PATCH update to avoid identity column insert error
    rest_update("user_tokens", {"tokenid": row.get("tokenid")}, {
        "access_token_encrypted": encrypted_access_b64,
        "access_token_expires_at": access_exp.isoformat(),
        "last_used_at": _now().isoformat(),
    })
    return {
        "access_token": access_token,
        "access_token_expires_at": access_exp.isoformat(),
    }


def revoke_refresh_token(refresh_token: str) -> bool:
    refresh_hash = _hash_refresh_token(refresh_token)
    row = rest_select("user_tokens", "tokenid, userid", {"refresh_token_hash": refresh_hash}, single=True)
    if not row:
        return False
    # PATCH instead of upsert to avoid identity column constraint error
    rest_update("user_tokens", {"tokenid": row.get("tokenid")}, {
        "is_revoked": True,
        "last_used_at": _now().isoformat(),
    })
    return True

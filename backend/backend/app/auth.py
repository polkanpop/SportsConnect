import os
import time
from functools import lru_cache
from typing import Optional, Dict, Any
from fastapi import HTTPException, Header
import httpx
from jose import jwt, JWTError

HS_ALGORITHM = "HS256"
RS_ALGORITHMS = ["RS256", "RS384", "RS512"]
JWKS_CACHE_SECONDS = 600

@lru_cache
def get_supabase_url() -> Optional[str]:
    return os.getenv("SUPABASE_URL")

@lru_cache
def get_jwt_secret() -> Optional[str]:
    return os.getenv("SUPABASE_JWT_SECRET") or os.getenv("SUPABASE_ANON_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")

_jwks_cache: Dict[str, Any] = {"ts": 0, "keys": []}

def fetch_jwks() -> list[dict]:
    supabase_url = get_supabase_url()
    if not supabase_url:
        return []
    now = time.time()
    if now - _jwks_cache["ts"] < JWKS_CACHE_SECONDS and _jwks_cache["keys"]:
        return _jwks_cache["keys"]
    jwks_url = f"{supabase_url}/auth/v1/certs"
    try:
        with httpx.Client(timeout=5) as client:
            r = client.get(jwks_url)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, dict) and "keys" in data:
                    _jwks_cache["keys"] = data["keys"]
                    _jwks_cache["ts"] = now
                    return _jwks_cache["keys"]
    except Exception:
        pass
    return []

def decode_with_jwks(token: str) -> Optional[dict]:
    keys = fetch_jwks()
    if not keys:
        return None
    # Try every key; production would inspect header.kid first
    header = jwt.get_unverified_header(token)
    kid = header.get("kid")
    for k in keys:
        if kid and k.get("kid") != kid:
            continue
        try:
            return jwt.decode(token, k, algorithms=RS_ALGORITHMS)
        except Exception:
            continue
    return None

def decode_token(token: str) -> dict:
    # Attempt RS decode first
    payload = decode_with_jwks(token)
    if payload:
        return payload
    # Fallback HS256
    secret = get_jwt_secret()
    if not secret:
        raise HTTPException(status_code=500, detail="JWT secret not configured; set SUPABASE_JWT_SECRET or SUPABASE_ANON_KEY")
    try:
        return jwt.decode(token, secret, algorithms=[HS_ALGORITHM])
    except JWTError as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}")

def get_current_user(authorization: str | None = Header(None, alias="Authorization")) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    payload = decode_token(token)
    sub = payload.get("sub") or payload.get("user_id")
    if not sub:
        raise HTTPException(status_code=401, detail="Token missing subject")
    return str(sub)

def get_optional_user(authorization: str | None = Header(None, alias="Authorization")) -> Optional[str]:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.removeprefix("Bearer ").strip()
    try:
        payload = decode_token(token)
    except HTTPException:
        return None
    sub = payload.get("sub") or payload.get("user_id")
    return str(sub) if sub else None
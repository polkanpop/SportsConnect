import os
from functools import lru_cache
from typing import Any, Dict, Optional
import httpx
from dotenv import load_dotenv

# Load backend .env first, then fallback to project root
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '..', '.env'))
load_dotenv()

class Settings:
    SUPABASE_URL: str = os.getenv("SUPABASE_URL", "")
    SUPABASE_SERVICE_ROLE_KEY: str = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    ALLOWED_ORIGINS: list[str] = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

@lru_cache
def get_settings() -> Settings:
    s = Settings()
    if not s.SUPABASE_URL or not s.SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("Missing Supabase settings: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
    return s

@lru_cache
def get_http_client() -> httpx.Client:
    return httpx.Client(timeout=20)

def rest_headers(settings: Optional[Settings] = None) -> Dict[str, str]:
    settings = settings or get_settings()
    return {
        "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }

def rest_select(table: str, select: str, filters: Optional[Dict[str, Any]] = None, single: bool = False, order: Optional[Dict[str, Any]] = None) -> Any:
    settings = get_settings()
    client = get_http_client()
    url = f"{settings.SUPABASE_URL}/rest/v1/{table}"
    params: Dict[str, Any] = {"select": select}
    if filters:
        for k, v in filters.items():
            params[k] = f"eq.{v}"  # equality only for now
    if order:
        params["order"] = f"{order['column']}.{ 'desc' if order.get('desc') else 'asc'}"
    if single:
        params["limit"] = 1
    r = client.get(url, headers=rest_headers(settings), params=params)
    if r.status_code >= 400:
        raise RuntimeError(f"Supabase REST error {r.status_code} on {table}: {r.text}")
    data = r.json()
    if single:
        return data[0] if data else None
    return data

def rest_upsert(table: str, payload: Dict[str, Any]) -> Any:
    settings = get_settings()
    client = get_http_client()
    url = f"{settings.SUPABASE_URL}/rest/v1/{table}"
    headers = rest_headers(settings)
    headers["Prefer"] = "resolution=merge-duplicates,return=representation"
    r = client.post(url, headers=headers, json=payload)
    if r.status_code >= 400:
        raise RuntimeError(f"Supabase REST error {r.status_code} on {table}: {r.text}")
    return r.json()

def rest_delete(table: str, filters: Dict[str, Any]) -> Any:
    settings = get_settings()
    client = get_http_client()
    url = f"{settings.SUPABASE_URL}/rest/v1/{table}"
    params: Dict[str, Any] = {}
    for k, v in filters.items():
        params[k] = f"eq.{v}"
    headers = rest_headers(settings)
    headers["Prefer"] = "return=representation"
    r = client.delete(url, headers=headers, params=params)
    if r.status_code >= 400:
        raise RuntimeError(f"Supabase REST error {r.status_code} on {table}: {r.text}")
    return r.json()

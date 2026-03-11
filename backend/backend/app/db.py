import os
from functools import lru_cache
from typing import Any, Dict, Optional
import httpx
from dotenv import load_dotenv

# Load env files in order of preference:
# 1) backend/.env (repo's backend folder)
# 2) backend/backend/.env (legacy nested backend folder)
# 3) whatever python-dotenv finds from CWD
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '..', '..', '.env'))
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

def rest_upsert(table: str, payload: Dict[str, Any], on_conflict: Optional[str] = None) -> Any:
    settings = get_settings()
    client = get_http_client()
    url = f"{settings.SUPABASE_URL}/rest/v1/{table}"
    if on_conflict:
        # PostgREST upsert uses primary key by default; pass on_conflict for UNIQUE keys.
        url = f"{url}?on_conflict={on_conflict}"
    headers = rest_headers(settings)
    headers["Prefer"] = "resolution=merge-duplicates,return=representation"
    r = client.post(url, headers=headers, json=payload)
    if r.status_code >= 400:
        raise RuntimeError(f"Supabase REST error {r.status_code} on {table}: {r.text}")
    return r.json()

def rest_insert(table: str, payload: Dict[str, Any]) -> Any:
    """Strict insert (no upsert). Will raise 409 on duplicate primary key instead of silently updating.
    This protects sample seed data from being overwritten when sequences are misaligned."""
    settings = get_settings()
    client = get_http_client()
    url = f"{settings.SUPABASE_URL}/rest/v1/{table}"
    headers = rest_headers(settings)
    headers["Prefer"] = "return=representation"  # omit resolution=merge-duplicates
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

def rest_update(table: str, filters: Dict[str, Any], payload: Dict[str, Any]) -> Any:
    """PATCH rows matching filters (no identity column override)."""
    settings = get_settings()
    client = get_http_client()
    url = f"{settings.SUPABASE_URL}/rest/v1/{table}"
    params: Dict[str, Any] = {}
    for k, v in filters.items():
        params[k] = f"eq.{v}"
    headers = rest_headers(settings)
    headers["Prefer"] = "return=representation"
    r = client.patch(url, headers=headers, params=params, json=payload)
    if r.status_code >= 400:
        raise RuntimeError(f"Supabase REST error {r.status_code} on {table}: {r.text}")
    return r.json()

import os
import json
from functools import lru_cache
from typing import Any, Dict, Optional
from urllib.parse import urlparse
import asyncpg
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
    SUPABASE_DB_POOLER_URL: str = os.getenv("SUPABASE_DB_POOLER_URL", "")
    SUPABASE_DB_POOL_MIN_SIZE: int = int(os.getenv("SUPABASE_DB_POOL_MIN_SIZE", "1"))
    SUPABASE_DB_POOL_MAX_SIZE: int = int(os.getenv("SUPABASE_DB_POOL_MAX_SIZE", "5"))
    SUPABASE_DB_COMMAND_TIMEOUT_SECONDS: float = float(os.getenv("SUPABASE_DB_COMMAND_TIMEOUT_SECONDS", "10"))
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


_pg_pool: asyncpg.Pool | None = None


def has_pg_pool_config() -> bool:
    return bool(get_settings().SUPABASE_DB_POOLER_URL)


def has_pg_pool() -> bool:
    return _pg_pool is not None


async def _init_pg_connection(conn: asyncpg.Connection) -> None:
    await conn.set_type_codec(
        "json",
        schema="pg_catalog",
        encoder=json.dumps,
        decoder=json.loads,
    )
    await conn.set_type_codec(
        "jsonb",
        schema="pg_catalog",
        encoder=json.dumps,
        decoder=json.loads,
        format="text",
    )


async def init_pg_pool() -> None:
    global _pg_pool
    if _pg_pool is not None:
        return
    settings = get_settings()
    if not settings.SUPABASE_DB_POOLER_URL:
        return
    _validate_supabase_pooler_dsn(settings.SUPABASE_DB_POOLER_URL)
    _pg_pool = await asyncpg.create_pool(
        dsn=settings.SUPABASE_DB_POOLER_URL,
        min_size=max(1, settings.SUPABASE_DB_POOL_MIN_SIZE),
        max_size=max(1, settings.SUPABASE_DB_POOL_MAX_SIZE),
        timeout=settings.SUPABASE_DB_COMMAND_TIMEOUT_SECONDS,
        command_timeout=settings.SUPABASE_DB_COMMAND_TIMEOUT_SECONDS,
        max_inactive_connection_lifetime=300.0,
        init=_init_pg_connection,
        server_settings={
            "application_name": "sportconnect-fastapi",
            "statement_timeout": f"{int(settings.SUPABASE_DB_COMMAND_TIMEOUT_SECONDS * 1000)}",
        },
    )


def _validate_supabase_pooler_dsn(dsn: str) -> None:
    parsed = urlparse(dsn)
    host = (parsed.hostname or "").lower()
    port = parsed.port
    username = parsed.username or ""

    if not host:
        raise RuntimeError("SUPABASE_DB_POOLER_URL is missing a hostname.")

    is_shared_pooler_host = host.endswith(".pooler.supabase.com")
    is_direct_db_host = host.startswith("db.") and host.endswith(".supabase.co")

    if is_shared_pooler_host and port == 6543 and username == "postgres":
        raise RuntimeError(
            "SUPABASE_DB_POOLER_URL is using a mixed Supabase format. "
            "For shared session pooler use postgres.<project-ref>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require. "
            "For transaction mode use the exact transaction DSN from Supabase Connect instead of the shared pooler host with username postgres."
        )

    if is_shared_pooler_host and port == 5432 and not username.startswith("postgres."):
        raise RuntimeError(
            "SUPABASE_DB_POOLER_URL session-mode username must include the project ref, for example postgres.<project-ref>."
        )

    if is_direct_db_host and port == 5432 and username.startswith("postgres."):
        raise RuntimeError(
            "SUPABASE_DB_POOLER_URL is using the direct database host with a session-pooler username. "
            "Use aws-0-<region>.pooler.supabase.com:5432 with username postgres.<project-ref>, or use db.<project-ref>.supabase.co:5432 with username postgres only if your network supports IPv6."
        )

    if is_direct_db_host and port == 6543 and username != "postgres":
        raise RuntimeError(
            "SUPABASE_DB_POOLER_URL transaction-mode DSN should use username postgres with the db.<project-ref>.supabase.co host."
        )


async def close_pg_pool() -> None:
    global _pg_pool
    if _pg_pool is None:
        return
    await _pg_pool.close()
    _pg_pool = None


def _require_pg_pool() -> asyncpg.Pool:
    if _pg_pool is None:
        raise RuntimeError("Supabase DB pooler is not configured. Set SUPABASE_DB_POOLER_URL to enable direct pooled queries.")
    return _pg_pool


async def probe_pg_connection() -> None:
    pool = _require_pg_pool()
    async with pool.acquire() as conn:
        await conn.fetchval("select 1")


async def ensure_insert_review_bypass_rpc() -> None:
    """Create the insert_review_bypass RPC function if it doesn't already exist.

    PostgREST has a long-standing issue where it cannot INSERT into tables with
    enum columns — it sends '' instead of the provided value, causing 22P02.
    This function creates a PL/pgSQL RPC that does the INSERT internally,
    bypassing PostgREST column-binding entirely.

    Called once at startup when an asyncpg pool is available.
    """
    pool = _require_pg_pool()
    ddl = """
    CREATE OR REPLACE FUNCTION public.insert_review_bypass(
        p_userid     int,
        p_targettype text,
        p_targetid   int,
        p_rating     int,
        p_comment    text
    ) RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
    DECLARE
        new_id int;
    BEGIN
        INSERT INTO public.reviews (userid, targettype, targetid, rating, comment)
        VALUES (p_userid, p_targettype::public.reviewtargettype, p_targetid, p_rating, p_comment)
        RETURNING reviewid INTO new_id;
        RETURN new_id;
    END;
    $$;
    GRANT EXECUTE ON FUNCTION public.insert_review_bypass TO anon, authenticated, service_role;
    """
    async with pool.acquire() as conn:
        await conn.execute(ddl)


async def insert_review_pg(userid: int, targettype: str, targetid: int, rating: int, comment: str) -> int:
    """Insert a review row directly via asyncpg, bypassing PostgREST enum-cast bug.

    Returns the new reviewid.
    """
    pool = _require_pg_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO public.reviews (userid, targettype, targetid, rating, comment)
            VALUES ($1, $2::public.reviewtargettype, $3, $4, $5)
            RETURNING reviewid
            """,
            userid, targettype, targetid, rating, comment,
        )
        if row is None:
            raise RuntimeError("insert_review_pg: INSERT returned no row")
        return int(row["reviewid"])


async def update_review_pg(reviewid: int, rating: int, comment: str) -> None:
    """Update an existing review's rating and comment directly via asyncpg."""
    pool = _require_pg_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE public.reviews SET rating=$1, comment=$2 WHERE reviewid=$3",
            rating, comment, reviewid,
        )


async def fetch_venue_booking_bundle_pg(courtid: int, start_date: str, end_date: str) -> dict[str, Any]:
    pool = _require_pg_pool()
    query = """
    with venue as (
        select jsonb_build_object(
            'courtinfoid', ci.courtinfoid,
            'courtid', ci.courtid,
            'name', ci.name,
            'address', ci.address,
            'latitude', ci.latitude,
            'longitude', ci.longitude,
            'venue', ci.venue,
            'images', ci.images,
            'availability', ci.availability,
            'accuracy_type', ci.accuracy_type,
            'auto_approve', ci.auto_approve
        ) as courtinfo
        from public.courtinfo ci
        where ci.courtid = $1
        limit 1
    ),
    playing as (
        select coalesce(
            jsonb_agg(
                jsonb_build_object(
                    'playingcourtid', pc.playingcourtid,
                    'courtid', pc.courtid,
                    'part', pc.part,
                    'name', pc.name,
                    'base_name', pc.base_name,
                    'price', pc.price,
                    'allow_half_booking', pc.allow_half_booking,
                    'surface', pc.surface,
                    'images', coalesce(pci.images, '[]'::jsonb)
                )
                order by pc.playingcourtid
            ),
            '[]'::jsonb
        ) as playing_courts
        from public.playingcourt pc
        left join lateral (
            select pinfo.images
            from public.playingcourtinfo pinfo
            where pinfo.playingcourtid = pc.playingcourtid
            limit 1
        ) pci on true
        where pc.courtid = $1
    ),
    availability as (
        select coalesce(
            jsonb_agg(to_jsonb(ca) order by ca.availabilityid),
            '[]'::jsonb
        ) as availability
        from public.courtavailability ca
        where ca.courtid = $1
          and (ca.booking_date #>> '{}') >= $2::text
          and (ca.booking_date #>> '{}') <= $3::text
    ),
    svc as (
        select coalesce(
            jsonb_agg(to_jsonb(s) order by s.serviceid),
            '[]'::jsonb
        ) as services
        from public.services s
        where s.courtid = $1
    )
    select jsonb_build_object(
        'courtinfo', venue.courtinfo,
        'playing_courts', playing.playing_courts,
        'availability', availability.availability,
        'services', svc.services
    ) as bundle
    from venue
    cross join playing
    cross join availability
    cross join svc
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, courtid, start_date, end_date)
    if row is None:
        return {
            "courtinfo": None,
            "playing_courts": [],
            "availability": [],
            "services": [],
        }
    bundle = row["bundle"] or {}
    return {
        "courtinfo": bundle.get("courtinfo"),
        "playing_courts": bundle.get("playing_courts") or [],
        "availability": bundle.get("availability") or [],
        "services": bundle.get("services") or [],
    }

def rest_headers(settings: Optional[Settings] = None) -> Dict[str, str]:
    settings = settings or get_settings()
    return {
        "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }

def rest_select(table: str, select: str, filters: Optional[Dict[str, Any]] = None, single: bool = False, order: Optional[Dict[str, Any]] = None) -> Any:
    try:
        settings = get_settings()
        client = get_http_client()
        url = f"{settings.SUPABASE_URL}/rest/v1/{table}"
        params: list[tuple[str, Any]] = [("select", select)]
        if filters:
            for k, v in filters.items():
                if isinstance(v, (list, tuple)):
                    # PostgREST IN filter: ?col=in.(1,2,3)
                    params.append((k, f"in.({','.join(str(x) for x in v)})"))
                elif "__" in k:
                    # Operator filter syntax: {"booking_date__gte": "2026-03-14"}
                    col, op = k.split("__", 1)
                    if op not in {"eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is"}:
                        raise RuntimeError(f"Unsupported filter operator: {op}")
                    if isinstance(v, (dict, list, tuple)):
                        raise RuntimeError(f"Operator filter expects scalar value for {k}, got {type(v).__name__}")
                    scalar = "null" if v is None else str(v)
                    # booking_date is jsonb in this schema; range operators need a JSON string literal.
                    if col == "booking_date" and op in {"gt", "gte", "lt", "lte"} and isinstance(v, str):
                        scalar = v if (v.startswith('"') and v.endswith('"')) else json.dumps(v)
                    params.append((col, f"{op}.{scalar}"))
                else:
                    params.append((k, f"eq.{v}"))
        if order:
            params.append(("order", f"{order['column']}.{ 'desc' if order.get('desc') else 'asc'}"))
        if single:
            params.append(("limit", 1))
        r = client.get(url, headers=rest_headers(settings), params=params)
        if r.status_code >= 400:
            raise RuntimeError(f"Supabase REST error {r.status_code} on {table}: {r.text}")
        data = r.json()
        if single:
            return data[0] if data else None
        return data
    except Exception as e:
        print(f"[rest_select] table={table} select={select} filters={filters} single={single} order={order} error={e}")
        if isinstance(e, RuntimeError):
            raise
        raise RuntimeError(str(e))

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


class RpcError(Exception):
    """Raised when a Supabase RPC returns a database-level error (ERRCODE in body).

    Attributes:
        code    -- PostgreSQL ERRCODE string (e.g. 'P0001', 'P0023')
        message -- Human-readable message from RAISE EXCEPTION
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def rest_rpc(function_name: str, params: Dict[str, Any]) -> Any:
    """Call a Supabase PostgreSQL stored procedure via PostgREST.

    Sends ``POST /rest/v1/rpc/{function_name}`` with the supplied params
    serialised as JSON.  ``None`` values are omitted so that SQL ``DEFAULT``
    parameter values take effect.

    Returns the parsed JSON body on success.
      - RETURNS TABLE  → list[dict]
      - RETURNS scalar → the scalar value directly
      - RETURNS void   → empty list []

    Raises:
        RpcError     – database raised an exception (ERRCODE in response body)
        RuntimeError – HTTP-level or network error
    """
    settings = get_settings()
    client = get_http_client()
    url = f"{settings.SUPABASE_URL}/rest/v1/rpc/{function_name}"
    headers = rest_headers(settings)
    headers["Prefer"] = "return=representation"
    # Omit None values — the SQL function's DEFAULT will apply for those params.
    body = {k: v for k, v in params.items() if v is not None}
    r = client.post(url, headers=headers, json=body)
    if r.status_code >= 400:
        try:
            err = r.json()
            code = err.get("code") or str(r.status_code)
            message = err.get("message") or r.text
        except Exception:
            code, message = str(r.status_code), r.text
        raise RpcError(code=code, message=message)
    return r.json()

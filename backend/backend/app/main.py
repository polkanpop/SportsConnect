import time
import os
import warnings

# Suppress deprecation warning emitted during import of limits/slowapi (pkg_resources).
warnings.filterwarnings(
    "ignore",
    message=r"pkg_resources is deprecated as an API",
    category=UserWarning,
)

from fastapi import FastAPI, Response, Request
from fastapi.exceptions import RequestValidationError
from pathlib import Path
from fastapi.responses import JSONResponse, FileResponse
import logging
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from .db import close_pg_pool, get_settings, has_pg_pool_config, init_pg_pool, probe_pg_connection
from .rate_limit import limiter
from slowapi import _rate_limit_exceeded_handler
from slowapi.middleware import SlowAPIMiddleware
from .routers import (
    courtinfo,
    notifications,
    favorites,
    favouritecourts,
    profiles,
    data,
    courts,
    userinfo,
    userlogin,
    users,
    courtbookings,
    servicebookings,
    services,
    eventbookings,
    trainingsessions,
    trainingsessioninfo,
    tsbookings,
    courtavailability,
    events,
    eventinfo,
    payments,
    reviews,
    history,
    auth,
    cloudinary,
    blocklist,
    playingcourts,
    bookings,   # race-safe RPC booking endpoints
    drafts,     # Redis form-draft cache endpoints
    me,         # /api/me/dashboard bootstrap endpoint
    devices,    # push notification token registration
)
from .routers import venues
from .routers import debug_identity
from fastapi_cache import FastAPICache
from fastapi_cache.backends.redis import RedisBackend
from redis import asyncio as aioredis

# Silence deprecation warning emitted by limits (dependency of slowapi) regarding pkg_resources.
warnings.filterwarnings(
    "ignore",
    message="pkg_resources is deprecated as an API",
    category=UserWarning,
)
from fastapi import Response

settings = get_settings()
START_TIME = time.time()

app = FastAPI(title="SportsConnect API", version="0.1.0")

logger = logging.getLogger("uvicorn.error")


def _resolve_redis_url() -> str:
    """Resolve a Redis URL with Upstash-aware fallbacks.

    Priority:
    1) REDIS_URL
    2) UPSTASH_REDIS_URL
    3) default local Redis
    """
    redis_url = (
        os.getenv("REDIS_URL")
        or os.getenv("UPSTASH_REDIS_URL")
        or "redis://localhost:6379/0"
    )

    # Upstash Redis requires TLS. Accept redis:// input and normalize to rediss://.
    if "upstash.io" in redis_url and redis_url.startswith("redis://"):
        redis_url = "rediss://" + redis_url[len("redis://"):]

    return redis_url


@app.exception_handler(RequestValidationError)
async def _validation_exception_handler(request: Request, exc: RequestValidationError):
    """Log 422 validation/parsing errors with a small request-body preview.

    This is mainly to diagnose why /api/servicebookings returns 422 without any
    helpful server logs.
    """
    try:
        body_bytes = await request.body()
        body_preview = body_bytes[:2000].decode("utf-8", errors="replace")
    except Exception:
        body_preview = "<unavailable>"

    logger.warning(
        "request_validation_error path=%s method=%s errors=%s body=%s",
        request.url.path,
        request.method,
        exc.errors(),
        body_preview,
    )
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors()},
    )


@app.middleware("http")
async def _benchmark_middleware(request: Request, call_next):
    """Global performance middleware: logs all requests with timing and injects X-Process-Time header."""
    t0 = time.perf_counter()
    response = await call_next(request)
    duration_ms = (time.perf_counter() - t0) * 1000.0
    
    # Log in standardized format
    logger.info(
        "BENCHMARK: %s %s - %s - %.1fms",
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
    )
    
    # Inject response header
    response.headers["X-Process-Time"] = f"{duration_ms:.1f}"
    return response

@app.middleware("http")
async def _log_servicebookings_422(request: Request, call_next):
    # Only log for the problematic endpoint to avoid noisy logs.
    is_target = request.url.path.startswith("/api/servicebookings") and request.method.upper() == "POST"
    body_preview = None
    if is_target:
        try:
            body_bytes = await request.body()
            body_preview = body_bytes[:2000].decode("utf-8", errors="replace")
        except Exception:
            body_preview = "<unavailable>"

    response = await call_next(request)
    if is_target and response.status_code == 422:
        logger.warning(
            "servicebookings_post_422 content_type=%s body=%s",
            request.headers.get("content-type"),
            body_preview,
        )
    return response

# Attach limiter & middleware (only endpoints decorated with @limiter.limit will be enforced)
app.state.limiter = limiter
app.add_exception_handler(429, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS if settings.ALLOWED_ORIGINS != ["*"] else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(
    GZipMiddleware,
    minimum_size=500,
)

app.include_router(courtinfo.router, prefix="/api")
app.include_router(notifications.router, prefix="/api")
app.include_router(favorites.router, prefix="/api")
app.include_router(favouritecourts.router, prefix="/api")
app.include_router(profiles.router, prefix="/api")
app.include_router(data.router, prefix="/api")
app.include_router(courts.router, prefix="/api")
app.include_router(userinfo.router, prefix="/api")
app.include_router(userlogin.router, prefix="/api")
app.include_router(users.router, prefix="/api")
app.include_router(courtbookings.router, prefix="/api")
app.include_router(servicebookings.router, prefix="/api")
app.include_router(services.router, prefix="/api")
app.include_router(eventbookings.router, prefix="/api")
app.include_router(trainingsessions.router, prefix="/api")
app.include_router(trainingsessioninfo.router, prefix="/api")
app.include_router(tsbookings.router, prefix="/api")
app.include_router(courtavailability.router, prefix="/api")
app.include_router(playingcourts.router, prefix="/api")
app.include_router(events.router, prefix="/api")
app.include_router(eventinfo.router, prefix="/api")
app.include_router(debug_identity.router, prefix="/api")
app.include_router(payments.router, prefix="/api")
app.include_router(reviews.router, prefix="/api")
app.include_router(history.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(cloudinary.router, prefix="/api")
app.include_router(blocklist.router, prefix="/api")
app.include_router(bookings.router, prefix="/api")  # race-safe RPC endpoints
app.include_router(drafts.router,   prefix="/api")  # Redis form-draft endpoints
app.include_router(me.router,       prefix="/api")  # /api/me/dashboard bootstrap
app.include_router(venues.router,   prefix="/api")  # venue booking-data bundle
app.include_router(devices.router,  prefix="/api")  # push notification device tokens

# ── Homepage + Legal document routes (served directly, no auth required) ──
_HTML_DIR = Path(__file__).parent.parent / "static" / "html"
_STATIC_DIR = Path(__file__).parent.parent / "static"

@app.get("/", include_in_schema=False)
async def homepage():
    return FileResponse(
        _HTML_DIR / "index.html",
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "public, max-age=3600", "X-Robots-Tag": "index, follow"},
    )

@app.get("/icon.png", include_in_schema=False)
async def app_icon():
    return FileResponse(_STATIC_DIR / "images" / "icon.png", media_type="image/png",
                        headers={"Cache-Control": "public, max-age=86400"})

@app.get("/privacy", include_in_schema=False)
async def legal_privacy_en():
    return FileResponse(_HTML_DIR / "privacy.html", media_type="text/html",
                        headers={"Cache-Control": "public, max-age=3600", "X-Robots-Tag": "index, follow"})

@app.get("/terms", include_in_schema=False)
async def legal_terms_en():
    return FileResponse(_HTML_DIR / "terms.html", media_type="text/html",
                        headers={"Cache-Control": "public, max-age=3600", "X-Robots-Tag": "index, follow"})

@app.get("/privacy-vi", include_in_schema=False)
async def legal_privacy_vi():
    return FileResponse(_HTML_DIR / "privacy_vi.html", media_type="text/html")

@app.get("/terms-vi", include_in_schema=False)
async def legal_terms_vi():
    return FileResponse(_HTML_DIR / "terms_vi.html", media_type="text/html")


@app.on_event("startup")
async def _init_cache():
    """Initialize fastapi-cache with Redis backend and expose the redis client
    on ``app.state.redis`` so non-cache routers (drafts, bookings) can reach it.
    Uses REDIS_URL/UPSTASH_REDIS_URL from environment (defaults to local docker)."""
    redis_url = _resolve_redis_url()
    redis = aioredis.from_url(redis_url)
    try:
        await redis.ping()
        logger.info("Redis connected successfully at %s", redis_url)
    except Exception as exc:
        logger.warning(
            "Redis unavailable at %s — cache will be non-functional until Redis is reachable: %s",
            redis_url, exc,
        )
    # Store on app.state so request handlers can reach it via request.app.state.redis
    app.state.redis = redis
    FastAPICache.init(RedisBackend(redis), prefix="sportsconnect-cache")

    # Cold-start warmup: initialize the direct Postgres pool when configured,
    # otherwise warm the legacy PostgREST/threadpool path.
    if has_pg_pool_config():
        try:
            t0 = time.perf_counter()
            await init_pg_pool()
            await probe_pg_connection()
            venues.mark_venues_startup_warmup((time.perf_counter() - t0) * 1000.0)
            logger.info("Venues Postgres pool warmup completed successfully")
        except Exception as exc:
            logger.warning(
                "Venues Postgres pool warmup failed during startup, falling back to REST path: %s: %r",
                type(exc).__name__,
                exc,
            )
            try:
                venues.warmup_venues_cold_path()
                logger.info("Venues cold-path REST warmup completed successfully")
            except Exception as rest_exc:
                logger.warning(
                    "Venues cold-path REST warmup failed during startup: %s: %r",
                    type(rest_exc).__name__,
                    rest_exc,
                )
    else:
        try:
            venues.warmup_venues_cold_path()
            logger.info("Venues cold-path REST warmup completed successfully")
        except Exception as exc:
            logger.warning(
                "Venues cold-path REST warmup failed during startup: %s: %r",
                type(exc).__name__,
                exc,
            )

    try:
        await courtinfo.prewarm_default_courtinfo_and_venues_cache(app)
    except Exception as exc:
        logger.warning(
            "Default courtinfo+venues Redis prewarm failed during startup: %s: %r",
            type(exc).__name__,
            exc,
        )


@app.on_event("shutdown")
async def _shutdown_resources():
    redis = getattr(app.state, "redis", None)
    if redis is not None:
        await redis.close()
    await close_pg_pool()


@app.get("/api/health")
async def api_health():
    return {"status": "ok", "scope": "api"}

@app.get("/api")
async def api_index():
    """Return a simple index of available API resource groups to avoid 404 on /api."""
    return {
        "message": "SportsConnect API root",
        "resources": {
            "courtinfo": "/api/courtinfo",
            "notifications": "/api/notifications",
            "favorites": "/api/favorites",
            "favouritecourts": "/api/favouritecourts",
            "profiles": "/api/profiles/{user_id}",
            "data": "/api/data/{table}",
            "courts": "/api/courts",
            "courtbookings": "/api/courtbookings",
            "courtavailability": "/api/courtavailability",
            "eventbookings": "/api/eventbookings",
            "events": "/api/events",
            "eventinfo": "/api/eventinfo",
            "trainingsessions": "/api/trainingsessions",
            "trainingsessioninfo": "/api/trainingsessioninfo",
            "tsbookings": "/api/tsbookings",
            "payments": "/api/payments",
            "reviews": "/api/reviews",
            "history": "/api/history",
            "health": "/api/health",
            "status": "/status"
        }
    }

@app.get("/health")
async def root_health():
    return {"status": "ok"}

@app.get("/")
async def root():
    return {"message": "SportsConnect API", "docs": "/docs", "health": "/health"}

@app.get("/status")
async def status():
    uptime_seconds = int(time.time() - START_TIME)
    return {
        "status": "ok",
        "version": app.version,
        "uptime_seconds": uptime_seconds,
        "endpoints": [
            "/",
            "/health",
            "/api/health",
            "/status",
            "/api/courtinfo",
            "/api/notifications",
            "/api/favorites",
            "/api/favouritecourts",
            "/api/profiles",
            "/api/data/{table}",
            "/api/data/{table}/{pk}",
            "/api/courts",
            "/api/courts/{courtid}",
            "/api/userinfo",
            "/api/userinfo/{id}",
            "/api/userlogin",
            "/api/userlogin/{id}",
            "/api/users",
            "/api/users/{id}",
            "/api/courtbookings",
            "/api/courtbookings/{courtbookingid}",
            "/api/eventbookings",
            "/api/eventbookings/{eventbookingid}",
            "/api/trainingsessions",
            "/api/trainingsessions/{sessionid}",
            "/api/trainingsessioninfo",
            "/api/trainingsessioninfo/{sessioninfoid}",
            "/api/tsbookings",
            "/api/tsbookings/{tsbookingid}",
            "/api/courtavailability",
            "/api/courtavailability/{availabilityid}",
            "/api/events",
            "/api/events/{eventid}",
            "/api/eventinfo",
            "/api/eventinfo/{eventinfoid}",
            "/api/payments",
            "/api/payments/{paymentid}",
            "/api/reviews",
            "/api/reviews/{reviewid}",
            "/api/history",
            
        ],
    }

@app.get("/favicon.ico")
async def favicon():
    tiny_gif = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
    return Response(content=tiny_gif, media_type="image/gif")

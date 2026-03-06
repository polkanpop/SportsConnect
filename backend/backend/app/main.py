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
from fastapi.responses import JSONResponse
import logging
from fastapi.middleware.cors import CORSMiddleware
from .db import get_settings
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
)
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
app.include_router(events.router, prefix="/api")
app.include_router(eventinfo.router, prefix="/api")
app.include_router(debug_identity.router, prefix="/api")
app.include_router(payments.router, prefix="/api")
app.include_router(reviews.router, prefix="/api")
app.include_router(history.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(cloudinary.router, prefix="/api")
app.include_router(blocklist.router, prefix="/api")

@app.on_event("startup")
async def _init_cache():
    """Initialize fastapi-cache with Redis backend.
    Uses REDIS_URL from environment (defaults to local docker)."""
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    redis = aioredis.from_url(redis_url, encoding="utf-8", decode_responses=True)
    FastAPICache.init(RedisBackend(redis), prefix="sportsconnect-cache")


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

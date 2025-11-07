import time
from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from .db import get_settings
from .routers import (
    courtinfo,
    notifications,
    favorites,
    profiles,
    data,
    courts,
    userinfo,
    userlogin,
    users,
    courtbookings,
    eventbookings,
    trainingsessions,
    history,
    auth
)

settings = get_settings()
START_TIME = time.time()

app = FastAPI(title="SportsConnect API", version="0.1.0")

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
app.include_router(profiles.router, prefix="/api")
app.include_router(data.router, prefix="/api")
app.include_router(courts.router, prefix="/api")
app.include_router(userinfo.router, prefix="/api")
app.include_router(userlogin.router, prefix="/api")
app.include_router(users.router, prefix="/api")
app.include_router(courtbookings.router, prefix="/api")
app.include_router(eventbookings.router, prefix="/api")
app.include_router(trainingsessions.router, prefix="/api")
app.include_router(history.router, prefix="/api")
app.include_router(auth.router, prefix = "/api")
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
            "profiles": "/api/profiles/{user_id}",
            "data": "/api/data/{table}",
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
            "/api/history",
        ],
    }

@app.get("/favicon.ico")
async def favicon():
    tiny_gif = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
    return Response(content=tiny_gif, media_type="image/gif")

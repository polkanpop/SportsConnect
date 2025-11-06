import time
from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from .db import get_settings
from .routers import courtinfo, notifications, favorites, profiles

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

@app.get("/api/health")
async def api_health():
    return {"status": "ok", "scope": "api"}

@app.get("/health")
async def root_health():
    # Convenience duplicate so /health also works without /api prefix
    return {"status": "ok"}

@app.get("/")
async def root():
    return {"message": "SportsConnect API", "docs": "/docs", "health": "/health"}

@app.get("/status")
async def status():
    """Runtime status with simple uptime metric."""
    uptime_seconds = int(time.time() - START_TIME)
    return {
        "status": "ok",
        "version": app.version,
        "uptime_seconds": uptime_seconds,
        "endpoints": ["/", "/health", "/api/health", "/status", "/api/courtinfo", "/api/notifications", "/api/favorites", "/api/profiles"],
    }

@app.get("/favicon.ico")
async def favicon():
    """Return a tiny transparent favicon to avoid 404 noise."""
    # 1x1 transparent GIF bytes
    tiny_gif = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
    return Response(content=tiny_gif, media_type="image/gif")

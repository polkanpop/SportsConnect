"""Redis cache utilities for FastAPI-Cache2.

Key design
----------
``make_key_builder(namespace)`` returns a key_builder for ``@cache`` that
stores every entry under ``sportsconnect-cache:{namespace}:{md5}``.
This makes it possible to wipe all cached entries for a given entity group
with a single ``invalidate_namespace("events")`` call.

Usage in routers
----------------

    from fastapi_cache.decorator import cache
    from ..cache_utils import invalidate_namespace, make_key_builder

    # Cache a GET endpoint (TTL in seconds):
    @router.get("", response_model=list[dict])
    @cache(expire=120, key_builder=make_key_builder("events"))
    def list_events(...):
        ...

    # Invalidate from an async mutation endpoint:
    @router.patch("/{eventid}")
    async def update_event(...):
        ...
        await invalidate_namespace("events")
        return result

    # Invalidate from a sync mutation endpoint (via BackgroundTasks):
    @router.post("")
    def create_event(..., background_tasks: BackgroundTasks):
        ...
        background_tasks.add_task(invalidate_namespace, "events")
        return result

Note on sync endpoints
----------------------
``@cache`` wraps the decorated function in an async wrapper. FastAPI will
therefore run it in the event loop rather than a thread pool. Blocking I/O
inside the function (e.g. httpx.Client calls) will block the event loop on
*cache misses only*. After the first call the result is served from Redis
(~1 ms) without any blocking. For a small / dev deployment this trade-off is
acceptable. For production, convert the relevant handlers to ``async def``
and swap ``httpx.Client`` for ``httpx.AsyncClient``.
"""

import hashlib
import logging
from typing import Any, Callable

logger = logging.getLogger("cache_utils")


def make_key_builder(namespace: str) -> Callable:
    """Return a fastapi-cache2 ``key_builder`` that namespaces all keys.

    Redis keys are stored as::

        sportsconnect-cache:{namespace}:{md5_hash}

    This format supports pattern-based invalidation::

        SCAN 0 MATCH sportsconnect-cache:{namespace}:* COUNT 100
    """

    def _key_builder(
        func: Any,
        namespace_inner: str = "",
        request: Any = None,
        response: Any = None,
        *args: Any,
        **kwargs: Any,
    ) -> str:
        # Build deterministic cache key from function identity + query/path params.
        # ``args`` and ``kwargs`` are the endpoint's parameters (request/response
        # already extracted by fastapi-cache2 before this is called).
        from fastapi_cache import FastAPICache
        raw = f"{namespace}:{func.__module__}:{func.__name__}:{args}:{kwargs}"
        prefix = FastAPICache.get_prefix()
        return f"{prefix}:{namespace}:{hashlib.md5(raw.encode()).hexdigest()}"

    return _key_builder


async def invalidate_namespace(*namespaces: str) -> int:
    """Delete all ``sportsconnect-cache:{namespace}:*`` Redis keys.

    Safe to call when Redis is unavailable – logs a warning and returns 0.
    Supports multiple namespaces in a single call::

        await invalidate_namespace("events", "eventinfo")

    Uses a Redis pipeline to batch all DELETEs into a single round-trip,
    eliminating the ~100ms-per-key Upstash latency that caused a race condition
    where the client pull-to-refresh would read stale data before the sequential
    delete loop completed.
    """
    from fastapi_cache import FastAPICache

    total = 0
    try:
        backend = FastAPICache.get_backend()
        redis = getattr(backend, "redis", None)
        if redis is None:
            return 0
        prefix = FastAPICache.get_prefix()
        for ns in namespaces:
            pattern = f"{prefix}:{ns}:*"
            # Collect all matching keys first, then delete in one pipeline batch.
            keys = [key async for key in redis.scan_iter(match=pattern, count=200)]
            if keys:
                async with redis.pipeline(transaction=False) as pipe:
                    for key in keys:
                        pipe.delete(key)
                    await pipe.execute()
                logger.info("Cache invalidated %d keys namespace=%s", len(keys), ns)
            total += len(keys)
    except Exception as exc:
        logger.warning("Cache invalidation error namespaces=%s: %s", namespaces, exc)
    return total

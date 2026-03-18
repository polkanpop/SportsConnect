import os
from slowapi import Limiter
from slowapi.util import get_remote_address


def _resolve_redis_storage_uri() -> str:
	"""Return storage URI for slowapi with Upstash-aware fallbacks."""
	redis_url = os.getenv("REDIS_URL") or os.getenv("UPSTASH_REDIS_URL")
	if not redis_url:
		return "memory://"

	# Upstash Redis requires TLS. Accept redis:// input and normalize to rediss://.
	if "upstash.io" in redis_url and redis_url.startswith("redis://"):
		return "rediss://" + redis_url[len("redis://"):]

	return redis_url

def user_or_ip_key(request):
	"""Prefer authenticated user id (if middleware/dependency set it on request.state), fallback to remote IP.

	This keeps limits user-scoped when possible while still protecting unauthenticated access.
	"""
	uid = getattr(getattr(request, "state", object()), "user_id", None)
	if uid is not None:
		key = f"user:{uid}"
		print(f"[rate_limit] key_func resolved {key}")
		return key
	key = get_remote_address(request)
	print(f"[rate_limit] key_func fallback IP {key}")
	return key

# Use Redis for persistent, cross-process rate limiting when REDIS_URL is set;
# fall back to in-memory for environments without Redis.
_storage_uri = _resolve_redis_storage_uri()
limiter = Limiter(key_func=user_or_ip_key, storage_uri=_storage_uri)

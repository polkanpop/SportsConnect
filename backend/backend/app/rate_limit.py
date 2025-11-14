from slowapi import Limiter
from slowapi.util import get_remote_address

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

# In dev/single-process we use in-memory storage. For production switch to Redis:
# Limiter(key_func=user_or_ip_key, storage_uri="redis://localhost:6379")
limiter = Limiter(key_func=user_or_ip_key, storage_uri="memory://")

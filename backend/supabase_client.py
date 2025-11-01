import os
from functools import lru_cache
from dotenv import load_dotenv
from supabase import create_client, Client

# Load .env if present
load_dotenv()

SUPABASE_URL_ENV = "SUPABASE_URL"
SUPABASE_KEY_ENV = "SUPABASE_ANON_KEY"

class SupabaseConfigError(RuntimeError):
    pass

@lru_cache(maxsize=1)
def get_client() -> Client:
    url = os.getenv(SUPABASE_URL_ENV)
    key = os.getenv(SUPABASE_KEY_ENV)
    if not url or not key:
        raise SupabaseConfigError(
            f"Missing Supabase configuration. Ensure {SUPABASE_URL_ENV} and {SUPABASE_KEY_ENV} are set."
        )
    return create_client(url, key)

# backend/database.py
from supabase import create_client, Client
from dotenv import load_dotenv
import os

load_dotenv()

url: str = os.getenv("SUPABASE_URL")
key: str = os.getenv("SUPABASE_SERVICE_KEY")

if not url or not key:
    raise ValueError("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env")

supabase: Client = create_client(url, key)

# Test connection on import
try:
    # Simple query to test connection
    test = supabase.table("courts").select("courtid", count="exact").limit(1).execute()
    print("Supabase connected successfully!")
except Exception as e:
    print(f"Supabase connection failed: {e}")
    raise
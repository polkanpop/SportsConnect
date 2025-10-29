# backend/main.py
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from database import supabase

app = FastAPI(title="Sports Booking API", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def health():
    return {"status": "API running", "database": "checking..."}

@app.get("/api/test-db")
def test_db():
    try:
        res = supabase.table("courts").select("*").limit(5).execute()
        return {
            "status": "connected",
            "count": len(res.data),
            "data": res.data
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
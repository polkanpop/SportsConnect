from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from typing import List
from supabase import PostgrestAPIError

from supabase_client import get_client, SupabaseConfigError
from schemas import Event, EventCreate, EventsResponse, Booking, BookingCreate

app = FastAPI(title="SportsConnect Demo API", version="0.1.0")

# Allow local dev origins (Expo typically runs on http://localhost:19006 etc.)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # For demo purposes only; tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health():
    try:
        _ = get_client()  # Validate configuration
        return {"status": "ok"}
    except SupabaseConfigError as e:
        return {"status": "error", "detail": str(e)}

# --- Events ---
@app.get("/events", response_model=EventsResponse)
async def list_events():
    sb = get_client()
    try:
        resp = sb.table("events").select("*").execute()
    except PostgrestAPIError as e:
        raise HTTPException(status_code=500, detail=str(e))

    data = resp.data or []
    return {"data": data, "count": len(data)}

@app.post("/events", response_model=Event, status_code=201)
async def create_event(payload: EventCreate):
    sb = get_client()
    insert_data = payload.dict()
    try:
        resp = sb.table("events").insert(insert_data).select("*").single().execute()
    except PostgrestAPIError as e:
        raise HTTPException(status_code=500, detail=str(e))

    if not resp.data:
        raise HTTPException(status_code=500, detail="Failed to create event")
    return resp.data

@app.get("/events/{event_id}", response_model=Event)
async def get_event(event_id: int):
    sb = get_client()
    try:
        resp = sb.table("events").select("*").eq("id", event_id).single().execute()
    except PostgrestAPIError as e:
        raise HTTPException(status_code=500, detail=str(e))
    if not resp.data:
        raise HTTPException(status_code=404, detail="Event not found")
    return resp.data

# --- Bookings ---
@app.post("/bookings", response_model=Booking, status_code=201)
async def create_booking(payload: BookingCreate):
    sb = get_client()
    insert_data = payload.dict()
    try:
        # Optional: ensure event exists
        event_resp = sb.table("events").select("id").eq("id", insert_data["event_id"]).single().execute()
        if not event_resp.data:
            raise HTTPException(status_code=404, detail="Event not found")
        resp = sb.table("bookings").insert(insert_data).select("*").single().execute()
    except PostgrestAPIError as e:
        raise HTTPException(status_code=500, detail=str(e))

    if not resp.data:
        raise HTTPException(status_code=500, detail="Failed to create booking")
    return resp.data

# Root redirect/help
@app.get("/")
async def root():
    return {"message": "SportsConnect Demo API. See /docs for Swagger UI."}

# To run: uvicorn main:app --reload --port 8000

from typing import Optional, List
from pydantic import BaseModel, Field

# --- Event Schemas ---
class EventBase(BaseModel):
    title: str = Field(..., example="Morning Football Game")
    description: Optional[str] = Field(None, example="Casual 5v5 at the park")
    location: Optional[str] = Field(None, example="Central Park Field 3")
    sport: Optional[str] = Field(None, example="soccer")
    starts_at: Optional[str] = Field(None, description="ISO datetime string")
    capacity: Optional[int] = Field(None, ge=1, example=10)

class EventCreate(EventBase):
    pass

class Event(EventBase):
    id: int
    host_user_id: Optional[str] = None

    class Config:
        from_attributes = True

# --- Booking Schemas ---
class BookingBase(BaseModel):
    event_id: int
    user_id: str

class BookingCreate(BookingBase):
    pass

class Booking(BookingBase):
    id: int

    class Config:
        from_attributes = True

# Response wrappers (optional convenience)
class EventsResponse(BaseModel):
    data: List[Event]
    count: int

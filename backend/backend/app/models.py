from pydantic import BaseModel, Field
from typing import Optional, List, Union

class CourtInfo(BaseModel):
    id: int = Field(alias="courtinfoid")
    courtid: Optional[Union[int, str]] = None
    name: Optional[str] = None
    address: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    venue: Optional[Union[List[str], str]] = None
    images: Optional[List[str]] = None
    availability: Optional[str] = None
    accuracy_type: Optional[str] = None
    auto_approve: Optional[bool] = None
    price: Optional[float] = None

class Notification(BaseModel):
    id: int  # primary key column 'id' in table
    status: Optional[str] = None
    user_id: Optional[int] = None
    message: Optional[str] = None
    time: Optional[str] = None  # timestamp string from Supabase
    notificationtype: Optional[str] = None
    notificationtypeid: Optional[int] = None

class Profile(BaseModel):
    id: str
    username: Optional[str] = None
    full_name: Optional[str] = None
    avatar_url: Optional[str] = None

class ProfileUpdate(BaseModel):
    username: Optional[str] = None
    full_name: Optional[str] = None
    avatar_url: Optional[str] = None

class Favorite(BaseModel):
    user_id: str
    courtinfoid: int

class FavoriteCreate(BaseModel):
    courtinfoid: int

class FavouriteCourt(BaseModel):
    favouriteid: int
    userid: int
    courtid: int

class FavouriteCourtCreate(BaseModel):
    courtid: int
    userid: int  # required when auth removed

# --- Newly added models for missing tables ---

class CourtAvailability(BaseModel):
    availabilityid: int
    courtid: Optional[int] = None
    playingcourtid: Optional[int] = None
    status: Optional[str] = None
    start_time: Optional[str] = None  # HH:MM:SS
    end_time: Optional[str] = None
    booking_date: Optional[dict] = None  # stored as jsonb

class EventInfo(BaseModel):
    eventinfoid: int
    eventid: int
    numberofpeople: Optional[int] = None
    description: Optional[str] = None
    images: Optional[List[str]] = None
    title: str

class Event(BaseModel):
    eventid: int
    time: str  # timestamp
    courtbookingid: int
    status: Optional[str] = None
    organizerid: int

class Payment(BaseModel):
    paymentid: int
    status: Optional[str] = None
    time: Optional[str] = None
    method: Optional[str] = None
    amount: Optional[float] = None

class Review(BaseModel):
    reviewid: int
    rating: int
    comment: str
    targettype: str
    targetid: int
    userid: int

class TrainingSessionInfo(BaseModel):
    sessioninfoid: int
    sessionid: Optional[int] = None
    numberofpeople: int
    description: str
    images: Optional[List[str]] = None
    title: str

class TSBooking(BaseModel):
    tsbookingid: int
    sessionid: int
    paymentid: Optional[int] = None
    userid: int
    status: Optional[str] = None


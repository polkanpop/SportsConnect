from pydantic import BaseModel, Field
from typing import Optional, List, Union

class CourtInfo(BaseModel):
    id: int = Field(alias="courtinfoid")
    courtid: Optional[Union[int, str]] = None
    name: Optional[str] = None
    address: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    latitudedelta: Optional[float] = None
    longitudedelta: Optional[float] = None
    sport: Optional[Union[List[str], str]] = None
    venue: Optional[Union[List[str], str]] = None
    images: Optional[List[str]] = None
    availability: Optional[str] = None

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

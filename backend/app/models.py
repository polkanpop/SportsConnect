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
    availability: Optional[str] = None  # adjust if structured

class Notification(BaseModel):
    id: int
    title: Optional[str] = None
    body: Optional[str] = None
    category: Optional[Union[str, List[str]]] = None
    created_at: Optional[str] = None

class Profile(BaseModel):
    id: str
    username: Optional[str] = None
    full_name: Optional[str] = None
    avatar_url: Optional[str] = None

class Favorite(BaseModel):
    user_id: str
    courtinfoid: int

class FavoriteCreate(BaseModel):
    courtinfoid: int

class FavoriteDelete(BaseModel):
    courtinfoid: int

from fastapi import APIRouter, HTTPException
from ..db import rest_select
from ..models import CourtInfo

router = APIRouter(prefix="/courtinfo", tags=["courtinfo"])

@router.get("", response_model=list[CourtInfo])
async def list_courts():
    try:
        data = rest_select(
            "courtinfo",
            "courtinfoid,courtid,name,address,latitude,longitude,latitudedelta,longitudedelta,sport,venue,images,availability",
            order={"column": "courtinfoid"},
        )
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{courtinfoid}", response_model=CourtInfo)
async def get_court(courtinfoid: int):
    try:
        data = rest_select(
            "courtinfo",
            "courtinfoid,courtid,name,address,latitude,longitude,latitudedelta,longitudedelta,sport,venue,images,availability",
            filters={"courtinfoid": courtinfoid},
            single=True,
        )
        if not data:
            raise HTTPException(status_code=404, detail="Court not found")
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

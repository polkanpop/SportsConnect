from fastapi import APIRouter, HTTPException, Query
from ..db import rest_select
from ..models import CourtInfo

router = APIRouter(prefix="/courtinfo", tags=["courtinfo"])

@router.get("", response_model=list[CourtInfo])
async def list_courts(courtids: str | None = Query(default=None)):
    """List courtinfo rows. Optional filter: ?courtids=1,2,3
    (Client-side subset until REST helper supports IN filter)."""
    try:
        # Keep select list aligned with the actual DB schema.
        # NOTE: courtinfo does NOT have city/state/postal_code/accuracy_score columns in current schema.
        select_cols = "courtinfoid,courtid,name,address,latitude,longitude,venue,images,availability,accuracy_type"
        data_all = rest_select(
            "courtinfo",
            select_cols,
            order={"column": "courtinfoid"},
        )
        if courtids:
            try:
                wanted = {int(x) for x in courtids.split(',') if x.strip().isdigit()}
            except ValueError:
                wanted = set()
            if wanted:
                return [d for d in data_all if d.get("courtid") in wanted]
        return data_all
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{courtinfoid}", response_model=CourtInfo)
async def get_court(courtinfoid: int):
    try:
        data = rest_select(
            "courtinfo",
            "courtinfoid,courtid,name,address,latitude,longitude,venue,images,availability,accuracy_type",
            filters={"courtinfoid": courtinfoid},
            single=True,
        )
        if not data:
            raise HTTPException(status_code=404, detail="Court not found")
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

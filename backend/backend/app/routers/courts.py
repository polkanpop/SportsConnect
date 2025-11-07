from fastapi import APIRouter, HTTPException
from ..db import rest_select

router = APIRouter(prefix="/courts", tags=["courts"])

SELECT_COLUMNS = "*"  # adjust if you want a slimmer payload

@router.get("", response_model=list[dict])
def list_courts():
    try:
        data = rest_select("courts", SELECT_COLUMNS, order={"column": "courtid"})
        return data if isinstance(data, list) else []
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{courtid}", response_model=dict)
def get_court(courtid: int):
    try:
        row = rest_select("courts", SELECT_COLUMNS, filters={"courtid": courtid}, single=True)
        if not row:
            raise HTTPException(status_code=404, detail="Court not found")
        return row
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))

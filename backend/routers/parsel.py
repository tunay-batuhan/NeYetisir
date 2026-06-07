from fastapi import APIRouter, Depends, HTTPException, Query, Request

from backend.config import settings
from backend.deps import veri_ip_kota
from backend.models import ParselSonuc
from backend.services import mock, tkgm

router = APIRouter()


@router.get("/parsel", response_model=ParselSonuc)
async def parsel(
    request: Request,
    mahalle_id: str = Query(..., alias="mahalleId"),
    ada: str = Query(...),
    parsel: str = Query(...),
    _ip=Depends(veri_ip_kota),
) -> ParselSonuc:
    if settings.mock_mode:
        result = mock.get_parsel(mahalle_id, ada, parsel)
    else:
        try:
            result = await tkgm.get_parsel(request.app.state.http, mahalle_id, ada, parsel)
        except tkgm.TkgmError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e

    if result is None:
        raise HTTPException(status_code=404, detail="Parsel bulunamadı")
    return result

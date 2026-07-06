import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from backend import db
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
        # Aynı mahalle/ada/parsel daha önce sorgulandıysa (90 gün içinde) DB'den
        # dön — gayri resmi TKGM endpoint'ine tekrar gitme.
        onbellek = await asyncio.to_thread(db.parsel_cache_getir, mahalle_id, ada, parsel)
        if onbellek is not None:
            return ParselSonuc.model_validate_json(onbellek)

        try:
            result = await tkgm.get_parsel(request.app.state.http, mahalle_id, ada, parsel)
        except tkgm.TkgmError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e

        if result is not None:
            await asyncio.to_thread(
                db.parsel_cache_kaydet, mahalle_id, ada, parsel, result.model_dump_json()
            )

    if result is None:
        raise HTTPException(status_code=404, detail="Parsel bulunamadı")
    return result

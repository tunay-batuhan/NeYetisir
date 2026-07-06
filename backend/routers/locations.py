from fastapi import APIRouter, Depends, HTTPException, Query, Request

from backend.config import settings
from backend.deps import genel_ip_kota
from backend.models import IdAd
from backend.services import mock, tkgm

router = APIRouter()


def _strip_geometry(items: list[IdAd]) -> list[IdAd]:
    """Harita çizmeyen çağıranlar (formlardaki il/ilçe select'leri) için sınır
    poligonlarını at — bunlar payload'ın neredeyse tamamını oluşturuyor."""
    return [i if i.geometry is None else i.model_copy(update={"geometry": None}) for i in items]


@router.get("/iller", response_model=list[IdAd])
async def iller(
    request: Request, geo: bool = Query(False), _ip=Depends(genel_ip_kota)
) -> list[IdAd]:
    if settings.mock_mode:
        items = mock.get_iller()
    else:
        try:
            items = await tkgm.get_iller(request.app.state.http)
        except tkgm.TkgmError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e
    return items if geo else _strip_geometry(items)


@router.get("/ilceler", response_model=list[IdAd])
async def ilceler(
    request: Request,
    il_id: str = Query(..., alias="ilId"),
    geo: bool = Query(False),
    _ip=Depends(genel_ip_kota),
) -> list[IdAd]:
    if settings.mock_mode:
        items = mock.get_ilceler(il_id)
    else:
        try:
            items = await tkgm.get_ilceler(request.app.state.http, il_id)
        except tkgm.TkgmError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e
    return items if geo else _strip_geometry(items)


@router.get("/mahalleler", response_model=list[IdAd])
async def mahalleler(
    request: Request,
    ilce_id: str = Query(..., alias="ilceId"),
    geo: bool = Query(False),
    _ip=Depends(genel_ip_kota),
) -> list[IdAd]:
    if settings.mock_mode:
        items = mock.get_mahalleler(ilce_id)
    else:
        try:
            items = await tkgm.get_mahalleler(request.app.state.http, ilce_id)
        except tkgm.TkgmError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e
    return items if geo else _strip_geometry(items)

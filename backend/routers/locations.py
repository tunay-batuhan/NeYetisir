from fastapi import APIRouter, Depends, HTTPException, Query, Request

from backend.config import settings
from backend.deps import genel_ip_kota
from backend.models import IdAd
from backend.services import mock, tkgm

router = APIRouter()


@router.get("/iller", response_model=list[IdAd])
async def iller(request: Request, _ip=Depends(genel_ip_kota)) -> list[IdAd]:
    if settings.mock_mode:
        return mock.get_iller()
    try:
        return await tkgm.get_iller(request.app.state.http)
    except tkgm.TkgmError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.get("/ilceler", response_model=list[IdAd])
async def ilceler(
    request: Request, il_id: str = Query(..., alias="ilId"), _ip=Depends(genel_ip_kota)
) -> list[IdAd]:
    if settings.mock_mode:
        return mock.get_ilceler(il_id)
    try:
        return await tkgm.get_ilceler(request.app.state.http, il_id)
    except tkgm.TkgmError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.get("/mahalleler", response_model=list[IdAd])
async def mahalleler(
    request: Request, ilce_id: str = Query(..., alias="ilceId"), _ip=Depends(genel_ip_kota)
) -> list[IdAd]:
    if settings.mock_mode:
        return mock.get_mahalleler(ilce_id)
    try:
        return await tkgm.get_mahalleler(request.app.state.http, ilce_id)
    except tkgm.TkgmError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

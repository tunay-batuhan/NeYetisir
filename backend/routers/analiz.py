"""2. aşama: hava + toprak analiz endpoint'leri.

Frontend parsel sonucundan sonra bu iki endpoint'i sırayla çağırır.
Toprak içinde DEM (Open-Meteo elevation) SoilGrids ile birleşik dönülür.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from backend.config import settings
from backend.deps import veri_ip_kota
from backend.models import HavaOzet, Koordinat, ToprakOzet
from backend.services import elevation, mock, soilgrids, weather

router = APIRouter()


@router.get("/analiz/hava", response_model=HavaOzet)
async def hava(
    request: Request,
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    _ip=Depends(veri_ip_kota),
) -> HavaOzet:
    if settings.mock_mode:
        return mock.get_hava(lat, lon)
    try:
        return await weather.get_hava(request.app.state.http, lat, lon)
    except weather.WeatherError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.get("/analiz/toprak", response_model=ToprakOzet)
async def toprak(
    request: Request,
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    _ip=Depends(veri_ip_kota),
) -> ToprakOzet:
    if settings.mock_mode:
        return mock.get_toprak(lat, lon)
    client = request.app.state.http
    local = getattr(request.app.state, "soilgrids_local", None)
    try:
        katmanlar, yukseklik = await asyncio.gather(
            soilgrids.get_toprak(client, lat, lon, local=local),
            elevation.get_yukseklik(client, lat, lon),
        )
    except soilgrids.SoilGridsError as e:
        raise HTTPException(status_code=502, detail=f"SoilGrids: {e}") from e
    except elevation.ElevationError as e:
        raise HTTPException(status_code=502, detail=f"Elevation: {e}") from e
    return ToprakOzet(konum=Koordinat(lat=lat, lon=lon), yukseklik=yukseklik, katmanlar=katmanlar)

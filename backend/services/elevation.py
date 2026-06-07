"""Open-Meteo Elevation API (~90m SRTM-derived). Centroid + 4 yön örneklem
ile rakım, eğim ve bakı (aspect) hesaplanır.

Numune düzeni: [C, N, S, E, W], aralarında ~111m. Eğim merkezi farklar yöntemiyle:
    dz/dy = (eN - eS) / 222m
    dz/dx = (eE - eW) / 222m   (lon farkı cos(lat) ile düzeltildiği için)
    eğim  = atan(|grad|) derece
    bakı  = (atan2(dz/dx, dz/dy) + 180) % 360, kuzey=0, saat yönünde
"""

from __future__ import annotations

import math
from typing import Any

import httpx

from backend.cache import yukseklik_cache
from backend.models import Yukseklik

ELEVATION_URL = "https://api.open-meteo.com/v1/elevation"

# 0.001° ≈ 111m (lat). Lon için cos(lat) ile düzeltilir.
SAMPLE_DLAT = 0.001
SAMPLE_M = SAMPLE_DLAT * 111_000  # ≈111
DIST_M = 2 * SAMPLE_M  # N-S ve E-W noktaları arası mesafe (~222m)

# 8 yön — kuzeyden saat yönünde.
DIRS = ["K", "KD", "D", "GD", "G", "GB", "B", "KB"]

# Bu eşiğin altındaki yükseklik farkı için "düz arazi" sayıyoruz; eğim hesabı
# DEM noise'una takılmasın diye bakı hesaplamıyoruz.
FLAT_SPREAD_M = 0.5


class ElevationError(RuntimeError):
    """Open-Meteo Elevation'dan gelen hatalar."""


async def _get_json(client: httpx.AsyncClient, url: str, params: dict[str, Any]) -> Any:
    try:
        r = await client.get(url, params=params)
    except httpx.HTTPError as e:
        raise ElevationError(f"Elevation isteği başarısız: {e}") from e
    if r.status_code >= 400:
        raise ElevationError(f"Elevation {r.status_code}: {r.text[:200]}")
    try:
        return r.json()
    except ValueError as e:
        raise ElevationError(f"Elevation yanıtı JSON değil: {e}") from e


def _aspect_to_dir(deg: float) -> str:
    idx = int((deg + 22.5) // 45) % 8
    return DIRS[idx]


async def get_yukseklik(client: httpx.AsyncClient, lat: float, lon: float) -> Yukseklik:
    key = (round(lat, 3), round(lon, 3))
    if key in yukseklik_cache:
        return yukseklik_cache[key]

    dlat = SAMPLE_DLAT
    # cos(lat) yaklaşmıyor 0'a (TR enlemleri 36-42°N), yine de güvenli taban koy.
    dlon = SAMPLE_DLAT / max(math.cos(math.radians(lat)), 1e-6)

    pts_lat = [lat, lat + dlat, lat - dlat, lat, lat]
    pts_lon = [lon, lon, lon, lon + dlon, lon - dlon]

    raw = await _get_json(
        client,
        ELEVATION_URL,
        {
            "latitude": ",".join(f"{v:.6f}" for v in pts_lat),
            "longitude": ",".join(f"{v:.6f}" for v in pts_lon),
        },
    )
    elevs = raw.get("elevation")
    if not isinstance(elevs, list) or len(elevs) < 5:
        raise ElevationError("Elevation API beklenmeyen yanıt yapısı")

    eC, eN, eS, eE, eW = (float(e) for e in elevs[:5])
    spread = max(eC, eN, eS, eE, eW) - min(eC, eN, eS, eE, eW)

    if spread < FLAT_SPREAD_M:
        result = Yukseklik(rakim_m=round(eC, 1), egim_derece=0.0, baki_derece=None, baki_yon=None)
    else:
        dz_dy = (eN - eS) / DIST_M
        dz_dx = (eE - eW) / DIST_M
        grad = math.hypot(dz_dx, dz_dy)
        egim = math.degrees(math.atan(grad))
        baki = (math.degrees(math.atan2(dz_dx, dz_dy)) + 180.0) % 360.0
        result = Yukseklik(
            rakim_m=round(eC, 1),
            egim_derece=round(egim, 1),
            baki_derece=round(baki, 0),
            baki_yon=_aspect_to_dir(baki),
        )

    yukseklik_cache[key] = result
    return result

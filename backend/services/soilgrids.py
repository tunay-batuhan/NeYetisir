"""ISRIC SoilGrids 2.0 nokta sorgusu.

Tek HTTP isteğiyle 6 property × 3 derinlik için ortalama değerler alınır.
Birim dönüşümü `unit_measure` alanından okunur (raw / d_factor → target_units),
sonra tarımcı dostu birime çevrilir:

- phh2o → pH (target units zaten pH)
- clay/sand/silt → %     (target g/kg ise /10, target % ise olduğu gibi)
- soc → %                (g/kg → /10)
- bdod → g/cm³           (cg/cm³ → /100)
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from backend.cache import toprak_cache
from backend.models import ToprakKatman
from backend.services.soilgrids_local import LocalSoilGrids, LocalSoilGridsError

logger = logging.getLogger(__name__)

SOILGRIDS_URL = "https://rest.isric.org/soilgrids/v2.0/properties/query"

PROPERTIES = ["phh2o", "clay", "sand", "silt", "soc", "bdod"]
DEPTHS = ["0-5cm", "5-15cm", "15-30cm"]

# ISRIC nginx zaman zaman 503/502 ya da read-timeout veriyor; tipik 1-2 saniye
# içinde toparlanıyor. Toplam 5 deneme (1+2+4+8+16 ≈ 31s) yeterli.
_RETRY_COUNT = 5
_RETRY_BASE_S = 1.0
_RETRY_STATUSES = {502, 503, 504}


class SoilGridsError(RuntimeError):
    """SoilGrids servisinden gelen hatalar."""


async def _get_json(client: httpx.AsyncClient, url: str, params: list[tuple[str, Any]]) -> Any:
    last_err: str | None = None
    for attempt in range(_RETRY_COUNT):
        try:
            r = await client.get(url, params=params)
        except httpx.HTTPError as e:
            last_err = f"network: {e}"
        else:
            if r.status_code < 400:
                try:
                    return r.json()
                except ValueError as e:
                    raise SoilGridsError(f"SoilGrids yanıtı JSON değil: {e}") from e
            if r.status_code not in _RETRY_STATUSES:
                raise SoilGridsError(f"SoilGrids {r.status_code}: {r.text[:200]}")
            last_err = f"{r.status_code}: {r.text[:120]}"
        if attempt < _RETRY_COUNT - 1:
            await asyncio.sleep(_RETRY_BASE_S * (2 ** attempt))
    raise SoilGridsError(f"SoilGrids {_RETRY_COUNT} denemede başarısız ({last_err})")


async def get_toprak(
    client: httpx.AsyncClient,
    lat: float,
    lon: float,
    *,
    local: LocalSoilGrids | None = None,
) -> list[ToprakKatman]:
    key = (round(lat, 3), round(lon, 3))
    if key in toprak_cache:
        return toprak_cache[key]

    # Çoklu property/depth aynı anahtarın tekrarıyla iletilir; httpx'e tuple listesi veriyoruz.
    params: list[tuple[str, Any]] = [("lon", lon), ("lat", lat), ("value", "mean")]
    for p in PROPERTIES:
        params.append(("property", p))
    for d in DEPTHS:
        params.append(("depth", d))

    try:
        raw = await _get_json(client, SOILGRIDS_URL, params)
    except SoilGridsError as rest_err:
        # REST düştüyse local raster'lara düş (varsa). Hiç açık değilse veya
        # local'da da hata varsa orijinal REST hatasını yükselt.
        if local is not None and local.is_open():
            try:
                logger.warning("SoilGrids REST düştü, local fallback: %s", rest_err)
                return await local.get_toprak(lat, lon)
            except LocalSoilGridsError as local_err:
                logger.warning("Local fallback da başarısız: %s", local_err)
        raise
    layers = (raw.get("properties") or {}).get("layers")
    if not isinstance(layers, list):
        raise SoilGridsError("SoilGrids yanıtında 'layers' yok")

    # Önce property × depth → target değerine indir
    by_prop: dict[str, dict[str, float | None]] = {p: {d: None for d in DEPTHS} for p in PROPERTIES}
    for layer in layers:
        if not isinstance(layer, dict):
            continue
        name = layer.get("name")
        if name not in by_prop:
            continue
        unit = layer.get("unit_measure") or {}
        d_factor = float(unit.get("d_factor") or 1)
        target_units = str(unit.get("target_units") or "").lower()
        for depth in layer.get("depths") or []:
            if not isinstance(depth, dict):
                continue
            label = depth.get("label")
            if label not in by_prop[name]:
                continue
            mean = (depth.get("values") or {}).get("mean")
            if mean is None:
                continue
            converted = _to_common_unit(name, float(mean) / d_factor, target_units)
            by_prop[name][label] = converted

    katmanlar = [
        ToprakKatman(
            derinlik=d,
            ph=by_prop["phh2o"][d],
            kil_pct=by_prop["clay"][d],
            kum_pct=by_prop["sand"][d],
            silt_pct=by_prop["silt"][d],
            organik_karbon_pct=by_prop["soc"][d],
            yogunluk=by_prop["bdod"][d],
        )
        for d in DEPTHS
    ]
    toprak_cache[key] = katmanlar
    return katmanlar


def _to_common_unit(prop: str, target_value: float, target_units: str) -> float:
    """target_units'tan tarımcı dostu birime çevir."""
    if prop == "phh2o":
        return round(target_value, 2)
    if prop in ("clay", "sand", "silt"):
        # SoilGrids bazen g/kg bazen g/100g (%) döner
        if "kg" in target_units:
            return round(target_value / 10, 1)
        return round(target_value, 1)
    if prop == "soc":
        if "kg" in target_units:
            return round(target_value / 10, 2)
        return round(target_value, 2)
    if prop == "bdod":
        if "cg" in target_units:
            return round(target_value / 100, 2)
        return round(target_value, 2)
    return round(target_value, 2)

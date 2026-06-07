"""Open-Meteo proxy: 7-günlük forecast + 1991-2020 iklim normali (aylık).

İki bağımsız çağrı paralel atılır: forecast (6 saat cache) ve archive (30 gün cache).
Archive ~30 yıl × 365 gün = ~11k günlük satır döner; backend ay bazında aggregate edip
frontend'e 12 satır gönderir.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from backend.cache import hava_cache, iklim_cache
from backend.models import HavaOzet, HavaTahminGunu, IklimNormaliAyi, Koordinat

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

CLIMATE_START = "1991-01-01"
CLIMATE_END = "2020-12-31"
TIMEZONE = "Europe/Istanbul"

# Open-Meteo zaman zaman 429 (rate-limit), 502 ya da diğer 5xx/read-timeout veriyor;
# tipik birkaç saniye içinde toparlanıyor. 5 deneme = 4 backoff uykusu (1+2+4+8 ≈ 15s
# toplam bekleme; son denemeden sonra uyku yok). Sadece geçici hatalarda (429 + 5xx +
# network) retry; 4xx (400 vb.) anında WeatherError yükselir.
_RETRY_COUNT = 5
_RETRY_BASE_S = 1.0
_RETRY_STATUSES = {429, 500, 502, 503, 504}


class WeatherError(RuntimeError):
    """Open-Meteo'dan gelen tüm hatalar."""


async def _get_json(client: httpx.AsyncClient, url: str, params: dict[str, Any]) -> Any:
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
                    raise WeatherError(f"Open-Meteo yanıtı JSON değil ({url}): {e}") from e
            if r.status_code not in _RETRY_STATUSES:
                raise WeatherError(f"Open-Meteo {r.status_code} ({url}): {r.text[:200]}")
            last_err = f"{r.status_code}: {r.text[:120]}"
        if attempt < _RETRY_COUNT - 1:
            await asyncio.sleep(_RETRY_BASE_S * (2 ** attempt))
    raise WeatherError(f"Open-Meteo {_RETRY_COUNT} denemede başarısız ({url}): {last_err}")


def _key(lat: float, lon: float) -> tuple[float, float]:
    # ~110m hassasiyet — yakın parsel sorgularında cache hit.
    return (round(lat, 3), round(lon, 3))


async def get_hava(client: httpx.AsyncClient, lat: float, lon: float) -> HavaOzet:
    key = _key(lat, lon)
    tahmin, iklim = await asyncio.gather(
        _get_tahmin(client, lat, lon, key),
        _get_iklim_normali(client, lat, lon, key),
    )
    return HavaOzet(konum=Koordinat(lat=lat, lon=lon), tahmin=tahmin, iklim_normali=iklim)


async def _get_tahmin(
    client: httpx.AsyncClient, lat: float, lon: float, key: tuple[float, float]
) -> list[HavaTahminGunu]:
    if key in hava_cache:
        return hava_cache[key]
    raw = await _get_json(
        client,
        FORECAST_URL,
        {
            "latitude": lat,
            "longitude": lon,
            "daily": (
                "temperature_2m_min,temperature_2m_max,precipitation_sum,"
                "et0_fao_evapotranspiration,wind_speed_10m_max"
            ),
            "timezone": TIMEZONE,
            "forecast_days": 7,
        },
    )
    daily = raw.get("daily") or {}
    times = daily.get("time") or []
    tmins = daily.get("temperature_2m_min") or []
    tmaxs = daily.get("temperature_2m_max") or []
    yagis = daily.get("precipitation_sum") or []
    et0 = daily.get("et0_fao_evapotranspiration") or []
    ruz = daily.get("wind_speed_10m_max") or []

    def _f(arr: list, i: int) -> float | None:
        if i >= len(arr):
            return None
        v = arr[i]
        return float(v) if v is not None else None

    out: list[HavaTahminGunu] = []
    for i, t in enumerate(times):
        smin = _f(tmins, i)
        smax = _f(tmaxs, i)
        if smin is None or smax is None:
            continue
        out.append(
            HavaTahminGunu(
                tarih=str(t),
                sicaklik_min=smin,
                sicaklik_max=smax,
                yagis_mm=_f(yagis, i) or 0.0,
                et0_mm=_f(et0, i),
                ruzgar_max_kmh=_f(ruz, i),
            )
        )
    hava_cache[key] = out
    return out


async def _get_iklim_normali(
    client: httpx.AsyncClient, lat: float, lon: float, key: tuple[float, float]
) -> list[IklimNormaliAyi]:
    if key in iklim_cache:
        return iklim_cache[key]
    raw = await _get_json(
        client,
        ARCHIVE_URL,
        {
            "latitude": lat,
            "longitude": lon,
            "start_date": CLIMATE_START,
            "end_date": CLIMATE_END,
            "daily": "temperature_2m_mean,precipitation_sum",
            "timezone": TIMEZONE,
        },
    )
    daily = raw.get("daily") or {}
    times: list[str] = daily.get("time") or []
    tmean: list[float | None] = daily.get("temperature_2m_mean") or []
    yagis: list[float | None] = daily.get("precipitation_sum") or []
    out = _aggregate_monthly(times, tmean, yagis)
    iklim_cache[key] = out
    return out


def _aggregate_monthly(
    times: list[str], tmean: list[float | None], yagis: list[float | None]
) -> list[IklimNormaliAyi]:
    # Sıcaklık: ay içi tüm günlerin (yıllar arası) ortalaması.
    # Yağış: yıl bazında ay toplamı, sonra yıllar arası ortalama (mm/ay).
    temp_sum = {m: 0.0 for m in range(1, 13)}
    temp_n = {m: 0 for m in range(1, 13)}
    rain_ym: dict[tuple[int, int], float] = {}

    n = min(len(times), len(tmean), len(yagis)) if tmean and yagis else len(times)
    for i in range(n):
        date_str = times[i]
        if not date_str or len(date_str) < 7:
            continue
        year = int(date_str[0:4])
        month = int(date_str[5:7])
        t = tmean[i] if i < len(tmean) else None
        p = yagis[i] if i < len(yagis) else None
        if t is not None:
            temp_sum[month] += float(t)
            temp_n[month] += 1
        if p is not None:
            ym = (year, month)
            rain_ym[ym] = rain_ym.get(ym, 0.0) + float(p)

    rain_sum = {m: 0.0 for m in range(1, 13)}
    rain_n = {m: 0 for m in range(1, 13)}
    for (_yr, m), v in rain_ym.items():
        rain_sum[m] += v
        rain_n[m] += 1

    return [
        IklimNormaliAyi(
            ay=m,
            sicaklik_ort=(temp_sum[m] / temp_n[m]) if temp_n[m] else 0.0,
            yagis_top=(rain_sum[m] / rain_n[m]) if rain_n[m] else 0.0,
        )
        for m in range(1, 13)
    ]

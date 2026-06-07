"""TKGM MEGSİS proxy.

Endpoint URL'leri config'ten okunur (`settings.il_list_api` vs.) — halka açık,
resmi olmayan servisler. Tüm TKGM çağrıları burada izole.

Response şekli (gözlemlenen):
- Liste endpoint'leri: GeoJSON FeatureCollection. `features[].properties = {text, id}`.
- Parsel endpoint: GeoJSON Feature. `properties` öznitelikler içerir, `geometry`
  ya Polygon'dur ya `null` (parsel taşınmışsa). Taşındıysa
  `properties.gittigiParselListe` alanı, gidilen parselin GeoJSON'ını **string olarak**
  taşır — auto-follow ediyoruz.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from backend.cache import iller_cache, ilceler_cache, mahalleler_cache
from backend.config import settings
from backend.models import IdAd, Koordinat, ParselOzellikleri, ParselSonuc


class TkgmError(RuntimeError):
    """TKGM tarafından gelen tüm hatalar bu tipte fırlar."""


async def _get_json(client: httpx.AsyncClient, url: str) -> Any:
    try:
        r = await client.get(url)
    except httpx.HTTPError as e:
        raise TkgmError(f"TKGM isteği başarısız ({url}): {e}") from e
    if r.status_code == 404:
        # Parsel yok — çağıranın ele alması için sinyal veriyoruz.
        try:
            body = r.json()
        except ValueError:
            body = {}
        raise TkgmNotFound(body.get("Message") or "Parsel bulunamadı")
    if r.status_code >= 400:
        raise TkgmError(f"TKGM {r.status_code} ({url}): {r.text[:200]}")
    try:
        return r.json()
    except ValueError as e:
        raise TkgmError(f"TKGM yanıtı JSON değil ({url}): {e}") from e


class TkgmNotFound(TkgmError):
    """Liste/parsel boş veya bulunamadı."""


def _features_to_id_ad(feature_collection: Any) -> list[IdAd]:
    feats = feature_collection.get("features") if isinstance(feature_collection, dict) else None
    if not isinstance(feats, list):
        raise TkgmError("Beklenen FeatureCollection değil")
    out: list[IdAd] = []
    for f in feats:
        if not isinstance(f, dict):
            continue
        props = f.get("properties") or {}
        rid = props.get("id")
        rad = props.get("text")
        if rid is None or rad is None:
            continue
        geom = f.get("geometry")
        if not (isinstance(geom, dict) and "type" in geom and "coordinates" in geom):
            geom = None
        out.append(IdAd(id=str(rid), ad=str(rad), geometry=geom))
    out.sort(key=lambda x: x.ad)
    return out


# --- Public API ------------------------------------------------------------


async def get_iller(client: httpx.AsyncClient) -> list[IdAd]:
    if "iller" in iller_cache:
        return iller_cache["iller"]
    raw = await _get_json(client, settings.il_list_api)
    iller = _features_to_id_ad(raw)
    iller_cache["iller"] = iller
    return iller


async def get_ilceler(client: httpx.AsyncClient, il_id: str) -> list[IdAd]:
    if il_id in ilceler_cache:
        return ilceler_cache[il_id]
    url = f"{settings.ilce_list_api.rstrip('/')}/{il_id}"
    raw = await _get_json(client, url)
    ilceler = _features_to_id_ad(raw)
    ilceler_cache[il_id] = ilceler
    return ilceler


async def get_mahalleler(client: httpx.AsyncClient, ilce_id: str) -> list[IdAd]:
    if ilce_id in mahalleler_cache:
        return mahalleler_cache[ilce_id]
    url = f"{settings.mahalle_list_api.rstrip('/')}/{ilce_id}"
    raw = await _get_json(client, url)
    mahalleler = _features_to_id_ad(raw)
    mahalleler_cache[ilce_id] = mahalleler
    return mahalleler


async def get_parsel(
    client: httpx.AsyncClient, mahalle_id: str, ada: str, parsel: str
) -> ParselSonuc | None:
    url = f"{settings.parsel_api.rstrip('/')}/{mahalle_id}/{ada}/{parsel}"
    try:
        raw = await _get_json(client, url)
    except TkgmNotFound:
        return None

    feature = _resolve_feature(raw)
    if feature is None:
        return None

    geom = feature.get("geometry")
    if not (isinstance(geom, dict) and "type" in geom and "coordinates" in geom):
        return None

    return ParselSonuc(
        ozellikler=_props_to_ozellikler(feature.get("properties") or {}),
        geometry=geom,
        koordinatlar=_polygon_to_koordinatlar(geom),
    )


# --- Helpers ---------------------------------------------------------------


def _resolve_feature(raw: Any) -> dict[str, Any] | None:
    """Doğrudan Feature ya da geometry=null + gittigiParselListe ise içteki Feature."""
    if not isinstance(raw, dict):
        return None
    if raw.get("geometry"):
        return raw
    props = raw.get("properties") or {}
    inner_str = props.get("gittigiParselListe")
    if not inner_str:
        return None
    try:
        inner = json.loads(inner_str) if isinstance(inner_str, str) else inner_str
    except (TypeError, ValueError):
        return None
    feats = inner.get("features") if isinstance(inner, dict) else None
    if isinstance(feats, list) and feats:
        return feats[0]
    return None


def _polygon_to_koordinatlar(geometry: dict[str, Any]) -> list[Koordinat]:
    geom_type = geometry.get("type")
    coords = geometry.get("coordinates", [])
    ring: list[list[float]] = []
    if geom_type == "Polygon" and coords:
        ring = coords[0]
    elif geom_type == "MultiPolygon" and coords and coords[0]:
        ring = coords[0][0]
    points = [Koordinat(lat=pt[1], lon=pt[0]) for pt in ring if len(pt) >= 2]
    # GeoJSON ring kapalıdır (ilk = son); kullanıcıya tekrar göstermeyelim.
    if len(points) >= 2 and points[0].lat == points[-1].lat and points[0].lon == points[-1].lon:
        points = points[:-1]
    return points


def _props_to_ozellikler(props: dict[str, Any]) -> ParselOzellikleri:
    alan_raw = props.get("alan")
    yuz: float | None = None
    if isinstance(alan_raw, str) and alan_raw.strip():
        try:
            # TKGM "312,93" gibi virgül-ondalık veriyor.
            yuz = float(alan_raw.replace(".", "").replace(",", "."))
        except ValueError:
            yuz = None
    elif isinstance(alan_raw, (int, float)):
        yuz = float(alan_raw)

    def s(key: str) -> str | None:
        v = props.get(key)
        return str(v) if v not in (None, "") else None

    return ParselOzellikleri(
        il=s("ilAd"),
        ilce=s("ilceAd"),
        mahalle=s("mahalleAd"),
        ada=s("adaNo"),
        parsel=s("parselNo"),
        yuzolcumu=yuz,
        nitelik=s("nitelik"),
        mevki=s("mevkii"),
    )

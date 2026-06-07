"""Local GeoTIFF üzerinden SoilGrids okuma — REST düştüğünde fallback.

`scripts/fetch_soilgrids_tr.py` ile Türkiye bbox'ı için 18 katman
(6 property × 3 derinlik) indirilmiş olmalı. Burada file handle'lar lifespan'de
bir kez açılır; her sorgu rasterio ile tek piksel okur (asyncio.to_thread).

Ölçek faktörleri SoilGrids dokümantasyonundan (int16 raw → gerçek birim):
    phh2o: ÷10  → pH
    clay/sand/silt: ÷10  → %     (g/kg → %)
    soc: ÷10    → %     (dg/kg → %)
    bdod: ÷100  → g/cm³ (cg/cm³ → g/cm³)
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TYPE_CHECKING

import rasterio
from pyproj import Transformer

from backend.cache import toprak_cache
from backend.models import ToprakKatman

if TYPE_CHECKING:
    from rasterio.io import DatasetReader

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "soilgrids"

PROPERTIES = ("phh2o", "clay", "sand", "silt", "soc", "bdod")
DEPTHS = ("0-5cm", "5-15cm", "15-30cm")

# raw int16 / scale = gerçek değer (tarımcı dostu birim).
_SCALE: dict[str, float] = {
    "phh2o": 10.0,
    "clay": 10.0,
    "sand": 10.0,
    "silt": 10.0,
    "soc": 10.0,
    "bdod": 100.0,
}

_ROUND: dict[str, int] = {
    "phh2o": 2,
    "clay": 1,
    "sand": 1,
    "silt": 1,
    "soc": 2,
    "bdod": 2,
}


class LocalSoilGridsError(RuntimeError):
    """Local soilgrids okumasında hata."""


class LocalSoilGrids:
    """Lifespan'de open(), shutdown'da close().

    `is_open()` False ise dosyalar henüz indirilmemiş demektir; çağrı tarafı
    fallback kullanmamalı, orijinal REST hatasını yükseltmeli.
    """

    def __init__(self, data_dir: Path = DATA_DIR) -> None:
        self.data_dir = data_dir
        self._datasets: dict[tuple[str, str], DatasetReader] = {}
        self._transformer: Transformer | None = None

    def open(self) -> None:
        if not self.data_dir.exists():
            raise LocalSoilGridsError(f"Klasör yok: {self.data_dir}")
        missing: list[str] = []
        opened: dict[tuple[str, str], DatasetReader] = {}
        try:
            for p in PROPERTIES:
                for d in DEPTHS:
                    path = self.data_dir / f"{p}_{d}.tif"
                    if not path.exists():
                        missing.append(path.name)
                        continue
                    opened[(p, d)] = rasterio.open(path)
            if missing:
                for ds in opened.values():
                    ds.close()
                raise LocalSoilGridsError(f"Eksik dosya(lar): {missing}")
        except Exception:
            for ds in opened.values():
                ds.close()
            raise
        self._datasets = opened
        # SoilGrids native CRS = Homolosine (ESRI:54052 / EPSG:152160).
        self._transformer = Transformer.from_crs("EPSG:4326", "ESRI:54052", always_xy=True)

    def close(self) -> None:
        for ds in self._datasets.values():
            ds.close()
        self._datasets.clear()
        self._transformer = None

    def is_open(self) -> bool:
        return bool(self._datasets) and self._transformer is not None

    def _read_point_sync(self, lat: float, lon: float) -> dict[str, dict[str, float | None]]:
        assert self._transformer is not None
        x, y = self._transformer.transform(lon, lat)
        out: dict[str, dict[str, float | None]] = {p: {d: None for d in DEPTHS} for p in PROPERTIES}
        for (p, d), ds in self._datasets.items():
            try:
                row, col = ds.index(x, y)
            except (IndexError, ValueError):
                continue
            if row < 0 or col < 0 or row >= ds.height or col >= ds.width:
                continue
            arr = ds.read(1, window=((row, row + 1), (col, col + 1)))
            if arr.size == 0:
                continue
            raw = int(arr[0, 0])
            if ds.nodata is not None and raw == ds.nodata:
                continue
            value = raw / _SCALE[p]
            out[p][d] = round(value, _ROUND[p])
        return out

    async def get_toprak(self, lat: float, lon: float) -> list[ToprakKatman]:
        if not self.is_open():
            raise LocalSoilGridsError("LocalSoilGrids açık değil")
        key = (round(lat, 3), round(lon, 3))
        if key in toprak_cache:
            return toprak_cache[key]

        by_prop = await asyncio.to_thread(self._read_point_sync, lat, lon)

        # Hiç değer okunamadıysa muhtemelen nokta TR bbox'ı dışında.
        if all(v is None for d in by_prop.values() for v in d.values()):
            raise LocalSoilGridsError(
                f"Noktada veri yok: ({lat:.4f}, {lon:.4f}) — Türkiye bbox dışında olabilir."
            )

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

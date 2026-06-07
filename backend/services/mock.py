"""TKGM endpoint'leri doğrulanmadan UI/akışı test edebilmek için sabit demo verisi.

Gerçek TKGM moduna geçmek için: .env içinde MOCK_MODE=false ve
backend/services/tkgm.py içindeki PATH_* sabitlerini DevTools'tan çıkardığın
gerçek endpoint'lerle güncelle.
"""

from __future__ import annotations

from datetime import date, timedelta

from backend.models import (
    HavaOzet,
    HavaTahminGunu,
    IdAd,
    IklimNormaliAyi,
    Koordinat,
    ParselOzellikleri,
    ParselSonuc,
    ToprakKatman,
    ToprakOzet,
    Yukseklik,
)

def _box(min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> dict:
    return {
        "type": "Polygon",
        "coordinates": [[
            [min_lon, min_lat], [max_lon, min_lat],
            [max_lon, max_lat], [min_lon, max_lat],
            [min_lon, min_lat],
        ]],
    }


_ILLER: list[IdAd] = [
    IdAd(id="06", ad="Ankara", geometry=_box(31.50, 39.20, 33.80, 40.60)),
    IdAd(id="34", ad="İstanbul", geometry=_box(28.00, 40.80, 29.95, 41.55)),
    IdAd(id="35", ad="İzmir", geometry=_box(26.20, 37.85, 28.40, 39.40)),
]

_ILCELER: dict[str, list[IdAd]] = {
    "06": [
        IdAd(id="06-01", ad="Çankaya", geometry=_box(32.75, 39.83, 32.95, 39.95)),
        IdAd(id="06-02", ad="Polatlı", geometry=_box(32.05, 39.50, 32.30, 39.65)),
    ],
    "34": [
        IdAd(id="34-01", ad="Beşiktaş", geometry=_box(28.99, 41.04, 29.06, 41.10)),
        IdAd(id="34-02", ad="Şile", geometry=_box(29.50, 41.10, 29.75, 41.22)),
    ],
    "35": [
        IdAd(id="35-01", ad="Karşıyaka", geometry=_box(27.04, 38.45, 27.16, 38.52)),
        IdAd(id="35-02", ad="Selçuk", geometry=_box(27.30, 37.92, 27.42, 38.00)),
    ],
}

_MAHALLELER: dict[str, list[IdAd]] = {
    "06-01": [
        IdAd(id="06-01-01", ad="Kızılay", geometry=_box(32.84, 39.91, 32.86, 39.93)),
        IdAd(id="06-01-02", ad="Çayyolu", geometry=_box(32.66, 39.88, 32.70, 39.91)),
    ],
    "06-02": [IdAd(id="06-02-01", ad="Şentepe", geometry=_box(32.142, 39.575, 32.158, 39.585))],
    "34-01": [IdAd(id="34-01-01", ad="Levent", geometry=_box(29.00, 41.07, 29.03, 41.09))],
    "34-02": [IdAd(id="34-02-01", ad="Ağva", geometry=_box(29.83, 41.13, 29.87, 41.16))],
    "35-01": [IdAd(id="35-01-01", ad="Bostanlı", geometry=_box(27.08, 38.45, 27.10, 38.47))],
    "35-02": [IdAd(id="35-02-01", ad="Efes", geometry=_box(27.34, 37.93, 27.37, 37.95))],
}

# Demo parsel: Ankara/Polatlı civarında ~1.2 ha'lık bir tarla poligonu (uydurulmuş).
_DEMO_POLYGON_COORDS = [
    [32.1480, 39.5800],
    [32.1495, 39.5802],
    [32.1497, 39.5790],
    [32.1483, 39.5788],
    [32.1480, 39.5800],
]


def get_iller() -> list[IdAd]:
    return _ILLER


def get_ilceler(il_id: str) -> list[IdAd]:
    return _ILCELER.get(il_id, [])


def get_mahalleler(ilce_id: str) -> list[IdAd]:
    return _MAHALLELER.get(ilce_id, [])


def get_parsel(mahalle_id: str, ada: str, parsel: str) -> ParselSonuc | None:
    # Geçersiz parsel akışını test edebilmek için "0/0" sorgusunu boş döndürüyoruz.
    if ada == "0" or parsel == "0":
        return None

    geometry = {"type": "Polygon", "coordinates": [_DEMO_POLYGON_COORDS]}
    koordinatlar = [Koordinat(lat=pt[1], lon=pt[0]) for pt in _DEMO_POLYGON_COORDS[:-1]]

    # mahalleId'den okunabilir konum metni türet
    konum = _resolve_konum(mahalle_id)

    return ParselSonuc(
        ozellikler=ParselOzellikleri(
            il=konum["il"],
            ilce=konum["ilce"],
            mahalle=konum["mahalle"],
            ada=ada,
            parsel=parsel,
            yuzolcumu=12345.6,
            nitelik="Tarla (mock)",
            mevki="Demo Mevki",
        ),
        geometry=geometry,
        koordinatlar=koordinatlar,
    )


def _resolve_konum(mahalle_id: str) -> dict[str, str | None]:
    parts = mahalle_id.split("-")
    il_id = parts[0] if len(parts) >= 1 else ""
    ilce_id = "-".join(parts[:2]) if len(parts) >= 2 else ""
    il_ad = next((x.ad for x in _ILLER if x.id == il_id), None)
    ilce_ad = next((x.ad for x in _ILCELER.get(il_id, []) if x.id == ilce_id), None)
    mah_ad = next((x.ad for x in _MAHALLELER.get(ilce_id, []) if x.id == mahalle_id), None)
    return {"il": il_ad, "ilce": ilce_ad, "mahalle": mah_ad}


# --- 2. aşama mock verileri --------------------------------------------------

# Konya benzeri iç Anadolu iklim profili (1991-2020 yaklaşık)
_IKLIM_NORMALI: list[tuple[int, float, float]] = [
    # (ay, ortalama sıcaklık °C, aylık yağış mm)
    (1, 0.5, 36.0), (2, 1.8, 30.0), (3, 6.2, 32.0), (4, 11.5, 38.0),
    (5, 16.0, 42.0), (6, 20.5, 25.0), (7, 24.0, 8.0), (8, 23.5, 6.0),
    (9, 18.5, 12.0), (10, 12.5, 28.0), (11, 6.5, 32.0), (12, 2.0, 40.0),
]


def get_hava(lat: float, lon: float) -> HavaOzet:
    today = date.today()
    # 7 günlük ılıman ilkbahar profili
    tahmin = [
        HavaTahminGunu(
            tarih=(today + timedelta(days=i)).isoformat(),
            sicaklik_min=12.0 + i * 0.3,
            sicaklik_max=22.0 + i * 0.4,
            yagis_mm=(2.5 if i in (1, 4) else 0.0),
            et0_mm=4.0 + i * 0.2,
            ruzgar_max_kmh=15.0 + (i % 3) * 2,
        )
        for i in range(7)
    ]
    iklim = [IklimNormaliAyi(ay=m, sicaklik_ort=t, yagis_top=p) for (m, t, p) in _IKLIM_NORMALI]
    return HavaOzet(konum=Koordinat(lat=lat, lon=lon), tahmin=tahmin, iklim_normali=iklim)


def get_toprak(lat: float, lon: float) -> ToprakOzet:
    # Anadolu killi-tınlı toprak profili
    katmanlar = [
        ToprakKatman(
            derinlik="0-5cm",
            ph=7.4, kil_pct=32.0, kum_pct=28.0, silt_pct=40.0,
            organik_karbon_pct=1.6, yogunluk=1.30,
        ),
        ToprakKatman(
            derinlik="5-15cm",
            ph=7.5, kil_pct=34.0, kum_pct=27.0, silt_pct=39.0,
            organik_karbon_pct=1.2, yogunluk=1.34,
        ),
        ToprakKatman(
            derinlik="15-30cm",
            ph=7.7, kil_pct=36.0, kum_pct=26.0, silt_pct=38.0,
            organik_karbon_pct=0.8, yogunluk=1.40,
        ),
    ]
    yukseklik = Yukseklik(rakim_m=1010.0, egim_derece=2.5, baki_derece=135.0, baki_yon="GD")
    return ToprakOzet(konum=Koordinat(lat=lat, lon=lon), yukseklik=yukseklik, katmanlar=katmanlar)

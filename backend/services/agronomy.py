"""Ham hava + toprak verisinden türev tarımsal metrikler (saf Python, dış bağımlılık yok).

LLM'ler aritmetik ve eşik uygulamada zayıf; halüsinasyon tam burada oluyor. Bu modül
USDA tekstür sınıfı, yıllık yağış toplamı, büyüme derece-gün (GDD), don/kuraklık özetleri
gibi türev değerleri kodda hesaplar ve agent'a hazır verir. Model artık bunları
"okuyup aktaran" konuma iner; muhakeme payı küçülür, tutarlılık artar.
"""

from __future__ import annotations

from backend.models import IklimNormaliAyi

# Ay başına gün sayısı (GDD ağırlığı için; şubat 28 yeterli, normal zaten 30-yıl ortalaması).
_GUN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
AY_ADI = [
    "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
    "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık",
]

# USDA tekstür üçgeni sınıfları → Türkçe ad.
_USDA_TR = {
    "sand": "Kum",
    "loamy sand": "Tınlı kum",
    "sandy loam": "Kumlu tın",
    "loam": "Tın",
    "silt loam": "Siltli tın",
    "silt": "Silt",
    "sandy clay loam": "Kumlu killi tın",
    "clay loam": "Killi tın",
    "silty clay loam": "Siltli killi tın",
    "sandy clay": "Kumlu kil",
    "silty clay": "Siltli kil",
    "clay": "Kil",
}


def usda_tekstur(kil: float | None, kum: float | None, silt: float | None) -> str | None:
    """Kil/kum/silt yüzdelerinden USDA tekstür sınıfı (Türkçe). Eksik veri → None.

    Standart USDA toprak tekstür üçgeni algoritması. Tekstür jeolojiktir, on yıllar
    boyunca sabittir → SoilGrids parametreleri içinde en güvenilir olanı.
    """
    if kil is None or kum is None or silt is None:
        return None
    c, s, si = float(kil), float(kum), float(silt)
    # Üçgen dışı/bozuk veride en yakına yuvarlamak yerine None vermek daha dürüst.
    if not (0 <= c <= 100 and 0 <= s <= 100 and 0 <= si <= 100):
        return None

    if si + 1.5 * c < 15:
        key = "sand"
    elif si + 1.5 * c >= 15 and si + 2 * c < 30:
        key = "loamy sand"
    elif (7 <= c < 20 and s > 52 and si + 2 * c >= 30) or (c < 7 and si < 50 and si + 2 * c >= 30):
        key = "sandy loam"
    elif 7 <= c < 27 and 28 <= si < 50 and s <= 52:
        key = "loam"
    elif (50 <= si and 12 <= c < 27) or (50 <= si < 80 and c < 12):
        key = "silt loam"
    elif si >= 80 and c < 12:
        key = "silt"
    elif 20 <= c < 35 and si < 28 and s > 45:
        key = "sandy clay loam"
    elif 27 <= c < 40 and 20 < s <= 45:
        key = "clay loam"
    elif 27 <= c < 40 and s <= 20:
        key = "silty clay loam"
    elif c >= 35 and s > 45:
        key = "sandy clay"
    elif c >= 40 and si >= 40:
        key = "silty clay"
    elif c >= 40 and s <= 45 and si < 40:
        key = "clay"
    else:
        key = "clay loam"  # üçgenin merkezine düşen kenar durumlar
    return _USDA_TR[key]


def iklim_ozeti(normal: list[IklimNormaliAyi]) -> dict | None:
    """1991-2020 aylık iklim normalinden türev iklim metrikleri.

    12 ay gelmezse None döner (eksik veriden metrik üretmek yerine atlanır).
    Dönen değerler:
      - yillik_ort_sicaklik_c, yillik_yagis_mm
      - en_sicak_ay / en_soguk_ay {ay, ad, sicaklik_c}
      - en_soguk_ay_ort_c (çok yıllık don hassasiyeti eşiği için)
      - buyume_derece_gun_baz10 (GDD, aylık ortalamadan yaklaşık)
      - yaz_yagisi_mm (Haz-Ağu), kis_yagisi_mm (Ara-Şub)
      - yazlik_kurak_ay (Haz-Eyl arası <30mm ay sayısı)
      - ortalama_sifir_alti_ay (don şiddeti proxy'si)
    """
    if not normal or len(normal) < 12:
        return None
    aylar = {m.ay: m for m in normal}
    if set(aylar) != set(range(1, 13)):
        return None

    sicakliklar = [aylar[a].sicaklik_ort for a in range(1, 13)]
    yagislar = [aylar[a].yagis_top for a in range(1, 13)]

    yillik_ort = sum(sicakliklar) / 12
    yillik_yagis = sum(yagislar)

    en_sicak_ay = max(range(1, 13), key=lambda a: aylar[a].sicaklik_ort)
    en_soguk_ay = min(range(1, 13), key=lambda a: aylar[a].sicaklik_ort)
    en_kurak_ay = min(range(1, 13), key=lambda a: aylar[a].yagis_top)

    # GDD baz 10°C — aylık ortalamadan yaklaşık (gerçeği günlük veri ister ama
    # iklim normalinde sadece aylık var; sıcak iklim/uzun mevsim ayrımı için yeterli).
    gdd = sum(max(0.0, aylar[a].sicaklik_ort - 10) * _GUN[a - 1] for a in range(1, 13))

    yaz_yagisi = sum(aylar[a].yagis_top for a in (6, 7, 8))
    kis_yagisi = sum(aylar[a].yagis_top for a in (12, 1, 2))
    yazlik_kurak_ay = sum(1 for a in (6, 7, 8, 9) if aylar[a].yagis_top < 30)
    sifir_alti_ay = sum(1 for a in range(1, 13) if aylar[a].sicaklik_ort < 0)

    def _ay(a: int) -> dict:
        return {"ay": a, "ad": AY_ADI[a - 1], "sicaklik_c": round(aylar[a].sicaklik_ort, 1)}

    return {
        "yillik_ort_sicaklik_c": round(yillik_ort, 1),
        "yillik_yagis_mm": round(yillik_yagis),
        "en_sicak_ay": _ay(en_sicak_ay),
        "en_soguk_ay": _ay(en_soguk_ay),
        "en_soguk_ay_ort_c": round(aylar[en_soguk_ay].sicaklik_ort, 1),
        "buyume_derece_gun_baz10": round(gdd),
        "yaz_yagisi_mm": round(yaz_yagisi),
        "kis_yagisi_mm": round(kis_yagisi),
        "en_kurak_ay": {"ad": AY_ADI[en_kurak_ay - 1], "yagis_mm": round(aylar[en_kurak_ay].yagis_top)},
        "yazlik_kurak_ay_sayisi": yazlik_kurak_ay,
        "ortalama_sifir_alti_ay_sayisi": sifir_alti_ay,
    }

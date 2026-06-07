"""Agent için token-verimli context dict.

ParselSonuc + HavaOzet + ToprakOzet → LLM'e gidecek özet sözlük.
Geometry ve köşe koordinatları çıkarılır (token israfı, agent'ın işine yaramaz).

Ayrıca ham veriden türev metrikler (USDA tekstür, GDD, yıllık yağış vb. — `agronomy`)
kodda hesaplanıp context'e eklenir. Böylece model aritmetik/eşik işini yapmaz;
hesaplanmış değerleri gerekçelendirir. Ürün önerisini model kendi bilgisiyle, bu
türev metriklere dayanarak yapar.
"""

from __future__ import annotations

from backend.models import HavaOzet, ParselSonuc, ToprakOzet
from backend.services import agronomy


def build_agent_context(parsel: ParselSonuc, hava: HavaOzet, toprak: ToprakOzet) -> dict:
    o = parsel.ozellikler

    # Her katmana USDA tekstür sınıfı ekle (kil/kum/silt üçgeninden, kodda kesin).
    katmanlar = []
    for k in toprak.katmanlar:
        katmanlar.append(
            {
                "derinlik": k.derinlik,
                "ph": k.ph,
                "kil_pct": k.kil_pct,
                "kum_pct": k.kum_pct,
                "silt_pct": k.silt_pct,
                "tekstur_sinifi": agronomy.usda_tekstur(k.kil_pct, k.kum_pct, k.silt_pct),
                "organik_karbon_pct": k.organik_karbon_pct,
                "yogunluk_g_cm3": k.yogunluk,
            }
        )

    # Türev iklim metrikleri (yıllık yağış, GDD, don ay sayısı, en sıcak/soğuk ay...).
    iklim = agronomy.iklim_ozeti(hava.iklim_normali)

    ctx = {
        "parsel": {
            "il": o.il,
            "ilce": o.ilce,
            "mahalle": o.mahalle,
            "ada": o.ada,
            "parsel": o.parsel,
            "yuzolcumu_m2": o.yuzolcumu,
            "nitelik": o.nitelik,
            "mevki": o.mevki,
            "konum": {"lat": hava.konum.lat, "lon": hava.konum.lon},
        },
        "hava": {
            "tahmin_7gun": [
                {
                    "tarih": g.tarih,
                    "min_c": g.sicaklik_min,
                    "max_c": g.sicaklik_max,
                    "yagis_mm": g.yagis_mm,
                    "et0_mm": g.et0_mm,
                }
                for g in hava.tahmin
            ],
            "iklim_normali_1991_2020": [
                {"ay": m.ay, "sicaklik_ort_c": m.sicaklik_ort, "yagis_top_mm": m.yagis_top}
                for m in hava.iklim_normali
            ],
        },
        "toprak": {
            "rakim_m": toprak.yukseklik.rakim_m,
            "egim_derece": toprak.yukseklik.egim_derece,
            "baki_derece": toprak.yukseklik.baki_derece,
            "baki_yon": toprak.yukseklik.baki_yon,
            "katmanlar": katmanlar,
        },
    }

    # Kodda hesaplanmış türev metrikler (varsa).
    if iklim is not None:
        ctx["turev_metrikler"] = {"iklim": iklim}

    return ctx

"""FastAPI bağımlılıkları — oturum kapısı + LLM endpoint kotası.

`auth.py` stdlib-saf güvenlik primitiflerini tutar; FastAPI'ye bağlı dependency
katmanı (cookie okuma, HTTPException, kota kontrolü) burada yaşar. `/api/rapor`
ve `/api/sohbet` bunları `Depends`/çağrı ile kullanır.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Request

from backend import auth, db
from backend.config import settings

COOKIE = "oturum"  # routers/auth.py ile aynı isim
ADMIN_COOKIE = "admin_oturum"  # routers/admin.py ile aynı isim (kullanıcı cookie'sinden ayrı)


async def gerekli_kullanici(request: Request) -> dict:
    """Oturum cookie'sinden aktif kullanıcıyı döner; yoksa 401.

    `/api/ben` ile aynı doğrulama; endpoint'lerde `Depends(gerekli_kullanici)`.
    """
    token = request.cookies.get(COOKIE)
    user = await asyncio.to_thread(auth.aktif_kullanici_token, token)
    if not user:
        raise HTTPException(status_code=401, detail="Bu işlem için giriş yapın.")
    return user


async def kota_uygula(user_id: int, tur: str) -> None:
    """Burst (dakika, ortak) + aylık (tür bazlı) kota kontrolü; geçerse kaydeder.

    İstek kabul anında sayılır (başarısız stream de sayılır) — süistimale karşı
    kasıtlı muhafazakâr. Aşımda 429 yükselir. Aylık limit rapor ve sohbet için
    ayrı havuzdur (`aylik_rapor_kota` / `aylik_sohbet_kota`); burst freni ikisini
    birlikte sayar.
    """
    now = datetime.now(timezone.utc)

    # Burst: son 60 sn'de tüm türler birlikte.
    son_dakika = (now - timedelta(seconds=60)).isoformat()
    if await asyncio.to_thread(db.kullanim_say, user_id, son_dakika) >= settings.dakika_limit:
        raise HTTPException(status_code=429, detail="Çok sık istek; lütfen biraz bekleyin.")

    # Aylık: sadece bu tür.
    aylik_limit = settings.aylik_rapor_kota if tur == "rapor" else settings.aylik_sohbet_kota
    etiket = "rapor" if tur == "rapor" else "sohbet"
    ay_basi = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
    if await asyncio.to_thread(db.kullanim_say, user_id, ay_basi, tur) >= aylik_limit:
        raise HTTPException(status_code=429, detail=f"Aylık {etiket} kotanız doldu.")

    await asyncio.to_thread(db.kullanim_ekle, user_id, tur)


def istemci_ip(request: Request) -> str:
    """İstemci IP'si. Ters proxy arkasındaysa X-Forwarded-For'un ilk hop'unu
    kullanır (proxy IP'sine düşmemek için), yoksa doğrudan bağlantı IP'si.

    Not: X-Forwarded-For istemci tarafından sahte gönderilebilir; bu limit
    caydırıcıdır, kesin değil. Asıl koruma üye-bazlı kotadır.
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "bilinmeyen"


def ip_dakika_limiti(kategori: str, limit_attr: str, mesaj: str):
    """IP başına dakikalık istek limiti uygulayan bir FastAPI dependency üretir.

    `ip_istek` tablosunda `kategori` ile son 60 sn'yi sayar; `settings.<limit_attr>`
    aşılırsa 429 (`mesaj`) yükselir, aksi halde isteği kaydeder. Tüm public/anonim
    uçlar bu fabrikayla korunur; kategoriler ayrı havuzlardır.
    """
    async def _dep(request: Request) -> None:
        ip = istemci_ip(request)
        son_dakika = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat()
        limit = getattr(settings, limit_attr)
        if await asyncio.to_thread(db.ip_istek_say, ip, kategori, son_dakika) >= limit:
            raise HTTPException(status_code=429, detail=mesaj)
        await asyncio.to_thread(db.ip_istek_ekle, ip, kategori)
    return _dep


# Anonim veri uçları (tapu/hava/toprak): TKGM/Open-Meteo/SoilGrids kazımasını frenler.
# Bir parsel akışı ~3 istek ürettiği için limit buna göre geniş (`dakika_ip_veri_limit`).
veri_ip_kota = ip_dakika_limiti(
    "veri", "dakika_ip_veri_limit", "Çok sık sorgu; lütfen biraz bekleyin."
)

# Hafif okuma uçları (il/ilçe/mahalle listesi, /ben, /cikis, /modeller).
genel_ip_kota = ip_dakika_limiti(
    "genel", "dakika_ip_genel_limit", "Çok sık istek; lütfen biraz bekleyin."
)

# Kimlik uçları (/giris + /kayit): brute-force ve scrypt-burst freni.
kimlik_ip_kota = ip_dakika_limiti(
    "kimlik", "dakika_ip_kimlik_limit", "Çok fazla giriş/kayıt denemesi; lütfen biraz bekleyin."
)

# AI uçları (/rapor + /sohbet): üye kotasının üstüne IP-bazlı ek savunma katmanı.
llm_ip_kota = ip_dakika_limiti(
    "llm", "dakika_ip_llm_limit", "Bu ağdan çok sık AI isteği; lütfen biraz bekleyin."
)


async def gerekli_admin(request: Request) -> dict:
    """Admin oturum cookie'sinden aktif admini döner; yoksa 401.

    `gerekli_kullanici` ikizi; ayrı `admin_oturum` cookie'si üstünde çalışır.
    Admin endpoint'lerinde `Depends(gerekli_admin)`.
    """
    token = request.cookies.get(ADMIN_COOKIE)
    admin = await asyncio.to_thread(auth.aktif_admin_token, token)
    if not admin:
        raise HTTPException(status_code=401, detail="Admin girişi gerekli.")
    return admin


# Anonim başvurular (kiralık/çiftçi/ekim-yardım/kiralama-talebi) için spam freni.
basvuru_ip_kota = ip_dakika_limiti(
    "basvuru", "dakika_ip_basvuru_limit", "Çok sık başvuru; lütfen biraz bekleyin."
)


async def kayit_ip_kota(request: Request) -> str:
    """IP başına aylık kayıt limitini kontrol eder; aşımda 429. IP'yi döner
    (router başarılı kayıttan sonra `db.kayit_olay_ekle` ile kaydeder)."""
    ip = istemci_ip(request)
    now = datetime.now(timezone.utc)
    ay_basi = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
    if await asyncio.to_thread(db.kayit_say, ip, ay_basi) >= settings.aylik_kayit_limit:
        raise HTTPException(
            status_code=429,
            detail="Bu ağdan bu ay çok fazla hesap açıldı; daha sonra tekrar deneyin.",
        )
    return ip

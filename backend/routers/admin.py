"""Admin paneli — kiralık tarla yönetimi (giriş/çıkış + başvuru/ilan CRUD).

Kullanıcı sisteminden bağımsız: ayrı `admin_oturum` cookie'si, ayrı
admin_users/admin_sessions tabloları. Admin hesabı lifespan'de `.env`'den seed
edilir (config.admin_kullanici / admin_parola).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from backend import auth, db
from backend.config import settings
from backend.deps import ADMIN_COOKIE, gerekli_admin
from backend.models import (
    AdminBilgi,
    AdminGirisIstek,
    AdminTarlaIstek,
    CiftciBasvuruAdminView,
    CiftciDurum,
    Durum,
    EkimYardimAdminView,
    EkimYardimDurum,
    KiralamaTalebiAdminView,
    KiralamaTalepDurum,
    KiralikTarlaAdminView,
)

router = APIRouter()


def _set_admin_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=ADMIN_COOKIE,
        value=token,
        max_age=settings.admin_oturum_ttl_gun * 24 * 3600,
        httponly=True,
        samesite="lax",
        path="/",
    )


@router.post("/admin/giris", response_model=AdminBilgi)
async def admin_giris(body: AdminGirisIstek, response: Response) -> AdminBilgi:
    admin = await asyncio.to_thread(db.admin_getir_kullanici, body.kullanici.strip())
    if not admin or not auth.dogrula_parola(body.parola, admin["parola_hash"]):
        raise HTTPException(status_code=401, detail="Kullanıcı adı veya parola hatalı.")
    token = auth.yeni_token()
    expires = datetime.now(timezone.utc) + timedelta(days=settings.admin_oturum_ttl_gun)
    await asyncio.to_thread(db.admin_oturum_ekle, token, admin["id"], expires.isoformat())
    _set_admin_cookie(response, token)
    return AdminBilgi(kullanici=admin["kullanici"])


@router.post("/admin/cikis")
async def admin_cikis(request: Request, response: Response) -> dict:
    token = request.cookies.get(ADMIN_COOKIE)
    if token:
        await asyncio.to_thread(db.admin_oturum_sil, token)
    response.delete_cookie(ADMIN_COOKIE, path="/")
    return {"ok": True}


@router.get("/admin/ben", response_model=AdminBilgi)
async def admin_ben(admin: dict = Depends(gerekli_admin)) -> AdminBilgi:
    return AdminBilgi(kullanici=admin["kullanici"])


@router.get("/admin/tarlalar", response_model=list[KiralikTarlaAdminView])
async def admin_tarlalar(
    durum: Durum | None = None,
    admin: dict = Depends(gerekli_admin),
) -> list[KiralikTarlaAdminView]:
    kayitlar = await asyncio.to_thread(db.kiralik_listele, durum)
    return [KiralikTarlaAdminView(**k) for k in kayitlar]


@router.post("/admin/tarla")
async def admin_tarla_ekle(
    istek: AdminTarlaIstek,
    admin: dict = Depends(gerekli_admin),
) -> dict:
    data = istek.model_dump()
    durum = data.pop("durum")
    kayit_id = await asyncio.to_thread(db.kiralik_ekle, data, "admin", durum)
    return {"ok": True, "id": kayit_id}


@router.patch("/admin/tarla/{kayit_id}")
async def admin_tarla_durum(
    kayit_id: int,
    durum: Durum,
    admin: dict = Depends(gerekli_admin),
) -> dict:
    ok = await asyncio.to_thread(db.kiralik_durum_guncelle, kayit_id, durum)
    if not ok:
        raise HTTPException(status_code=404, detail="Kayıt bulunamadı.")
    return {"ok": True}


@router.delete("/admin/tarla/{kayit_id}")
async def admin_tarla_sil(
    kayit_id: int,
    admin: dict = Depends(gerekli_admin),
) -> dict:
    ok = await asyncio.to_thread(db.kiralik_sil, kayit_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Kayıt bulunamadı.")
    return {"ok": True}


# --- Çiftçi başvuruları ("Çiftçimiz Ol") -----------------------------------


@router.get("/admin/ciftciler", response_model=list[CiftciBasvuruAdminView])
async def admin_ciftciler(
    durum: CiftciDurum | None = None,
    admin: dict = Depends(gerekli_admin),
) -> list[CiftciBasvuruAdminView]:
    kayitlar = await asyncio.to_thread(db.ciftci_listele, durum)
    return [CiftciBasvuruAdminView(**k) for k in kayitlar]


@router.patch("/admin/ciftci/{kayit_id}")
async def admin_ciftci_durum(
    kayit_id: int,
    durum: CiftciDurum,
    admin: dict = Depends(gerekli_admin),
) -> dict:
    ok = await asyncio.to_thread(db.ciftci_durum_guncelle, kayit_id, durum)
    if not ok:
        raise HTTPException(status_code=404, detail="Kayıt bulunamadı.")
    return {"ok": True}


@router.delete("/admin/ciftci/{kayit_id}")
async def admin_ciftci_sil(
    kayit_id: int,
    admin: dict = Depends(gerekli_admin),
) -> dict:
    ok = await asyncio.to_thread(db.ciftci_sil, kayit_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Kayıt bulunamadı.")
    return {"ok": True}


# --- Ekim yardımı ("Tarlama Yardım Al") ------------------------------------


@router.get("/admin/ekim-yardimlar", response_model=list[EkimYardimAdminView])
async def admin_ekim_yardimlar(
    durum: EkimYardimDurum | None = None,
    admin: dict = Depends(gerekli_admin),
) -> list[EkimYardimAdminView]:
    kayitlar = await asyncio.to_thread(db.ekim_yardim_listele, durum)
    return [EkimYardimAdminView(**k) for k in kayitlar]


@router.patch("/admin/ekim-yardim/{kayit_id}")
async def admin_ekim_yardim_durum(
    kayit_id: int,
    durum: EkimYardimDurum,
    admin: dict = Depends(gerekli_admin),
) -> dict:
    ok = await asyncio.to_thread(db.ekim_yardim_durum_guncelle, kayit_id, durum)
    if not ok:
        raise HTTPException(status_code=404, detail="Kayıt bulunamadı.")
    return {"ok": True}


@router.delete("/admin/ekim-yardim/{kayit_id}")
async def admin_ekim_yardim_sil(
    kayit_id: int,
    admin: dict = Depends(gerekli_admin),
) -> dict:
    ok = await asyncio.to_thread(db.ekim_yardim_sil, kayit_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Kayıt bulunamadı.")
    return {"ok": True}


# --- Kiralama talepleri (kiracı → ilan başvurusu) --------------------------


@router.get("/admin/kiralama-talepleri", response_model=list[KiralamaTalebiAdminView])
async def admin_kiralama_talepleri(
    durum: KiralamaTalepDurum | None = None,
    admin: dict = Depends(gerekli_admin),
) -> list[KiralamaTalebiAdminView]:
    kayitlar = await asyncio.to_thread(db.kiralama_talebi_listele, durum)
    return [KiralamaTalebiAdminView(**k) for k in kayitlar]


@router.patch("/admin/kiralama-talebi/{kayit_id}")
async def admin_kiralama_talebi_durum(
    kayit_id: int,
    durum: KiralamaTalepDurum,
    admin: dict = Depends(gerekli_admin),
) -> dict:
    ok = await asyncio.to_thread(db.kiralama_talebi_durum_guncelle, kayit_id, durum)
    if not ok:
        raise HTTPException(status_code=404, detail="Kayıt bulunamadı.")
    return {"ok": True}


@router.delete("/admin/kiralama-talebi/{kayit_id}")
async def admin_kiralama_talebi_sil(
    kayit_id: int,
    admin: dict = Depends(gerekli_admin),
) -> dict:
    ok = await asyncio.to_thread(db.kiralama_talebi_sil, kayit_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Kayıt bulunamadı.")
    return {"ok": True}

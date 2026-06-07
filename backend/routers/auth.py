"""Üyelik/oturum endpoint'leri: /api/kayit, /api/giris, /api/cikis, /api/ben.

Oturum HttpOnly cookie (`oturum`) ile taşınır; token sunucuda SQLite'ta tutulur.
Aynı-origin servis edildiği için cookie ek CORS ayarı gerektirmez.
"""

from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from backend import auth, db
from backend.config import settings
from backend.deps import genel_ip_kota, kayit_ip_kota, kimlik_ip_kota
from backend.models import GirisIstek, KayitIstek, KullaniciBilgi

router = APIRouter()

COOKIE = "oturum"


def _set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=COOKIE,
        value=token,
        max_age=settings.oturum_ttl_gun * 24 * 3600,
        httponly=True,
        samesite="lax",
        path="/",
    )


async def _oturum_olustur(user_id: int) -> str:
    token = auth.yeni_token()
    expires = datetime.now(timezone.utc) + timedelta(days=settings.oturum_ttl_gun)
    await asyncio.to_thread(db.oturum_ekle, token, user_id, expires.isoformat())
    return token


@router.post("/kayit", response_model=KullaniciBilgi)
async def kayit(
    body: KayitIstek, request: Request, response: Response,
    _ip=Depends(kimlik_ip_kota),  # IP başına dakikalık deneme freni (scrypt-burst)
) -> KullaniciBilgi:
    ip = await kayit_ip_kota(request)  # IP başına aylık hesap limiti (aşımda 429)
    mevcut = await asyncio.to_thread(db.kullanici_getir_email, body.email)
    if mevcut:
        raise HTTPException(status_code=409, detail="Bu e-posta zaten kayıtlı.")
    parola_hash = auth.hash_parola(body.parola)
    ad = body.ad.strip()
    try:
        user_id = await asyncio.to_thread(
            db.kullanici_ekle, body.email, ad, parola_hash, body.profil
        )
    except sqlite3.IntegrityError:
        # Eşzamanlı kayıt yarışı — benzersiz e-posta kısıtı.
        raise HTTPException(status_code=409, detail="Bu e-posta zaten kayıtlı.") from None
    await asyncio.to_thread(db.kayit_olay_ekle, ip)  # başarılı kayıt → IP sayacı
    token = await _oturum_olustur(user_id)
    _set_cookie(response, token)
    return KullaniciBilgi(id=user_id, email=body.email, ad=ad, profil=body.profil)


@router.post("/giris", response_model=KullaniciBilgi)
async def giris(
    body: GirisIstek, response: Response, _ip=Depends(kimlik_ip_kota),
) -> KullaniciBilgi:
    email = body.email.strip().lower()
    user = await asyncio.to_thread(db.kullanici_getir_email, email)
    if not user or not auth.dogrula_parola(body.parola, user["parola_hash"]):
        raise HTTPException(status_code=401, detail="E-posta veya parola hatalı.")
    token = await _oturum_olustur(user["id"])
    _set_cookie(response, token)
    return KullaniciBilgi(id=user["id"], email=user["email"], ad=user["ad"], profil=user["profil"])


@router.post("/cikis")
async def cikis(
    request: Request, response: Response, _ip=Depends(genel_ip_kota),
) -> dict[str, bool]:
    token = request.cookies.get(COOKIE)
    if token:
        await asyncio.to_thread(db.oturum_sil, token)
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/ben", response_model=KullaniciBilgi)
async def ben(request: Request, _ip=Depends(genel_ip_kota)) -> KullaniciBilgi:
    token = request.cookies.get(COOKIE)
    user = await asyncio.to_thread(auth.aktif_kullanici_token, token)
    if not user:
        raise HTTPException(status_code=401, detail="Oturum yok.")
    return KullaniciBilgi(id=user["id"], email=user["email"], ad=user["ad"], profil=user["profil"])

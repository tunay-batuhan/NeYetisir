"""Anonim başvurular — kiralık tarla ilanı + "Çiftçimiz Ol" çiftçi başvurusu.

`POST /api/kiralik-basvuru`: giriş gerektirmez (iletişim form içinde), IP başına
dakikalık spam freni; kayıt `beklemede` durumunda düşer, admin yayınlayınca görünür.
`GET /api/kiralik-tarlalar`: yalnızca `yayinda` ilanları döner (IP rate-limit).
`POST /api/ciftci-basvuru`: anonim çiftçi başvurusu; `beklemede` düşer, admin inceler.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request

from backend import db
from backend.deps import basvuru_ip_kota, veri_ip_kota
from backend.models import (
    CiftciBasvuruIstek,
    EkimYardimIstek,
    KiralamaTalebiIstek,
    KiralikBasvuruIstek,
    KiralikTarlaPublic,
)

router = APIRouter()


@router.post("/kiralik-basvuru")
async def kiralik_basvuru(
    istek: KiralikBasvuruIstek,
    _ip=Depends(basvuru_ip_kota),
) -> dict:
    kayit_id = await asyncio.to_thread(
        db.kiralik_ekle, istek.model_dump(), "basvuru", "beklemede"
    )
    return {"ok": True, "id": kayit_id}


@router.get("/kiralik-tarlalar", response_model=list[KiralikTarlaPublic])
async def kiralik_tarlalar(
    request: Request,
    _ip=Depends(veri_ip_kota),
) -> list[KiralikTarlaPublic]:
    kayitlar = await asyncio.to_thread(db.kiralik_listele, "yayinda")
    return [KiralikTarlaPublic(**k) for k in kayitlar]


@router.post("/ciftci-basvuru")
async def ciftci_basvuru(
    istek: CiftciBasvuruIstek,
    _ip=Depends(basvuru_ip_kota),
) -> dict:
    kayit_id = await asyncio.to_thread(db.ciftci_ekle, istek.model_dump(), "beklemede")
    return {"ok": True, "id": kayit_id}


@router.post("/ekim-yardim-basvuru")
async def ekim_yardim_basvuru(
    istek: EkimYardimIstek,
    _ip=Depends(basvuru_ip_kota),
) -> dict:
    kayit_id = await asyncio.to_thread(db.ekim_yardim_ekle, istek.model_dump(), "beklemede")
    return {"ok": True, "id": kayit_id}


@router.post("/kiralama-talebi")
async def kiralama_talebi(
    istek: KiralamaTalebiIstek,
    _ip=Depends(basvuru_ip_kota),
) -> dict:
    # Yalnızca yayındaki bir ilana başvurulabilir.
    tarla = await asyncio.to_thread(db.kiralik_getir, istek.tarla_id)
    if not tarla or tarla["durum"] != "yayinda":
        raise HTTPException(status_code=404, detail="İlan bulunamadı.")
    kayit_id = await asyncio.to_thread(db.kiralama_talebi_ekle, istek.model_dump(), "beklemede")
    return {"ok": True, "id": kayit_id}

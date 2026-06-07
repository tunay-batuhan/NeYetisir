"""3. aşama: AI rapor endpoint'i.

Body olarak parsel kimliğini (mahalleId/ada/parsel) alır; backend kendi paralel
parsel + hava + toprak'ı toplar, centroid'i shapely ile hesaplar, context'i
oluşturur ve tarla agent'ını invoke eder.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from shapely.geometry import shape

from backend.config import settings
from backend.deps import genel_ip_kota, gerekli_kullanici, kota_uygula, llm_ip_kota
from backend.services import context as context_svc
from backend.services import elevation, mock, report, soilgrids, tkgm, weather

router = APIRouter()


# Frontend dropdown'unda gösterilen + backend'in build etmesine izin verilen
# OpenRouter model id'leri. Varsayılan (.env LLM_MODEL) bu listede olmasa bile
# çalışır; sadece kullanıcı seçimi bu beyaz listeyle sınırlanır.
ALLOWED_MODELS: list[str] = [
    "google/gemini-3.5-flash",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
]


class RaporIstek(BaseModel):
    mahalleId: str = Field(max_length=32)
    ada: str = Field(max_length=32)
    parsel: str = Field(max_length=32)
    model: str | None = None


class SohbetMesaji(BaseModel):
    rol: str  # "user" | "assistant"
    icerik: str = Field(max_length=4000)


class SohbetIstek(BaseModel):
    mahalleId: str = Field(max_length=32)
    ada: str = Field(max_length=32)
    parsel: str = Field(max_length=32)
    rapor: str = Field(max_length=20000)
    gecmis: list[SohbetMesaji] = Field(default_factory=list, max_length=10)
    mesaj: str = Field(max_length=2000)
    model: str | None = None


def _line(obj: dict) -> bytes:
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")


async def _get_agent(request: Request, model_name: str | None) -> tuple[object, str]:
    """Seçilen modele göre cache'den agent döner; yoksa lazy build eder.

    İzinli liste = ALLOWED_MODELS + .env varsayılanı (varsayılan kullanıcı seçimi
    olmasa bile build edilebilir). Boş model → varsayılan.
    """
    state = request.app.state
    if not state.api_key_present:
        raise HTTPException(
            status_code=503,
            detail="OPENROUTER_API_KEY .env'de tanımlı değil.",
        )

    name = (model_name or settings.llm_model).strip()
    if name != settings.llm_model and name not in ALLOWED_MODELS:
        raise HTTPException(status_code=400, detail=f"İzin verilmeyen model: {name}")

    if name in state.agents:
        return state.agents[name], name

    async with state.agent_lock:
        if name not in state.agents:
            try:
                state.agents[name] = report.build_tarla_agent(
                    name,
                    settings.openrouter_api_key,
                )
            except report.ReportError as e:
                raise HTTPException(status_code=503, detail=f"Agent: {e}") from e
        return state.agents[name], name


@router.get("/modeller")
async def modeller(_ip=Depends(genel_ip_kota)):
    return {"varsayilan": settings.llm_model, "modeller": ALLOWED_MODELS}


async def _collect_context(request: Request, mahalleId: str, ada: str, parsel: str) -> dict:
    """Parsel + hava + toprak'ı toplar (cache'ler hit verir), agent context dict döner."""
    client = request.app.state.http

    if settings.mock_mode:
        parsel_sonuc = mock.get_parsel(mahalleId, ada, parsel)
    else:
        try:
            parsel_sonuc = await tkgm.get_parsel(client, mahalleId, ada, parsel)
        except tkgm.TkgmError as e:
            raise HTTPException(status_code=502, detail=f"TKGM: {e}") from e
    if parsel_sonuc is None:
        raise HTTPException(status_code=404, detail="Parsel bulunamadı")

    try:
        c = shape(parsel_sonuc.geometry).centroid
        lat, lon = float(c.y), float(c.x)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Centroid hesaplanamadı: {e}") from e

    if settings.mock_mode:
        hava_sonuc = mock.get_hava(lat, lon)
        toprak_sonuc = mock.get_toprak(lat, lon)
    else:
        local = getattr(request.app.state, "soilgrids_local", None)
        try:
            hava_sonuc, (katmanlar, yukseklik) = await asyncio.gather(
                weather.get_hava(client, lat, lon),
                _toprak_paralel(client, lat, lon, local=local),
            )
        except weather.WeatherError as e:
            raise HTTPException(status_code=502, detail=f"Hava: {e}") from e
        except soilgrids.SoilGridsError as e:
            raise HTTPException(status_code=502, detail=f"SoilGrids: {e}") from e
        except elevation.ElevationError as e:
            raise HTTPException(status_code=502, detail=f"Elevation: {e}") from e
        from backend.models import Koordinat, ToprakOzet
        toprak_sonuc = ToprakOzet(
            konum=Koordinat(lat=lat, lon=lon), yukseklik=yukseklik, katmanlar=katmanlar
        )

    return context_svc.build_agent_context(parsel_sonuc, hava_sonuc, toprak_sonuc)


@router.post("/rapor")
async def rapor(
    request: Request,
    istek: RaporIstek,
    _ip=Depends(llm_ip_kota),  # önce IP katmanı (anonim flood'u da sınırlar), sonra oturum
    user: dict = Depends(gerekli_kullanici),
) -> StreamingResponse:
    await kota_uygula(user["id"], "rapor")
    agent, model_name = await _get_agent(request, istek.model)
    ctx = await _collect_context(request, istek.mahalleId, istek.ada, istek.parsel)

    async def event_iter():
        yield _line({"tip": "baslangic", "model": model_name})
        try:
            async for ev in report.stream_report(agent, ctx):
                yield _line(ev)
            yield _line({"tip": "bitti", "model": model_name})
        except report.ReportError as e:
            yield _line({"tip": "hata", "mesaj": f"Agent: {e}"})

    return StreamingResponse(event_iter(), media_type="application/x-ndjson")


@router.post("/sohbet")
async def sohbet(
    request: Request,
    istek: SohbetIstek,
    _ip=Depends(llm_ip_kota),  # önce IP katmanı (anonim flood'u da sınırlar), sonra oturum
    user: dict = Depends(gerekli_kullanici),
) -> StreamingResponse:
    """Rapor sonrası takip soruları için sohbet endpoint'i.

    Frontend her istekte: orijinal rapor + önceki sohbet turları (`gecmis`) +
    yeni `mesaj`'ı gönderir. Backend cache'den parsel+hava+toprak'ı toparlayıp
    agent'a tam mesaj listesi geçer. Model her istekte değişebilir.
    """
    if not istek.mesaj.strip():
        raise HTTPException(status_code=400, detail="mesaj boş olamaz.")

    await kota_uygula(user["id"], "sohbet")
    agent, model_name = await _get_agent(request, istek.model)
    ctx = await _collect_context(request, istek.mahalleId, istek.ada, istek.parsel)

    gecmis = [m.model_dump() for m in istek.gecmis]

    async def event_iter():
        yield _line({"tip": "baslangic", "model": model_name})
        try:
            async for ev in report.stream_chat(
                agent, ctx, istek.rapor, gecmis, istek.mesaj,
            ):
                yield _line(ev)
            yield _line({"tip": "bitti", "model": model_name})
        except report.ReportError as e:
            yield _line({"tip": "hata", "mesaj": f"Agent: {e}"})

    return StreamingResponse(event_iter(), media_type="application/x-ndjson")


async def _toprak_paralel(client, lat: float, lon: float, *, local=None):
    return await asyncio.gather(
        soilgrids.get_toprak(client, lat, lon, local=local),
        elevation.get_yukseklik(client, lat, lon),
    )

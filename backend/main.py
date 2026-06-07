import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend import auth as auth_lib
from backend import db
from backend.config import settings
from backend.routers import admin, analiz, auth, kiralama, locations, parsel, report
from backend.services.soilgrids_local import LocalSoilGrids, LocalSoilGridsError

logger = logging.getLogger(__name__)

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

USER_AGENT = "Mozilla/5.0 (compatible; ParselDemoBot/1.0)"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Üyelik/oturum için SQLite (stdlib). data/app.db oluşturulur/açılır.
    db.init_db(settings.db_path)
    logger.info("Kullanıcı veritabanı hazır: %s", settings.db_path)

    # Admin hesabını .env'den seed et (idempotent). Parola boşsa panel kapalı.
    if settings.admin_parola:
        mevcut = db.admin_getir_kullanici(settings.admin_kullanici)
        if mevcut is None:
            db.admin_ekle(settings.admin_kullanici, auth_lib.hash_parola(settings.admin_parola))
            logger.info("Admin hesabı oluşturuldu: %s", settings.admin_kullanici)
    else:
        logger.warning("ADMIN_PAROLA tanımsız — admin paneli (/admin.html) kullanılamaz.")

    # Tek async client'la iki host'a (parselsorgu + cbsapi) gidiyoruz.
    app.state.http = httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        timeout=httpx.Timeout(20.0, connect=5.0),
        follow_redirects=True,
    )

    # Local SoilGrids fallback — REST düştüğünde data/soilgrids/*.tif'lerden okuruz.
    # Dosyalar yoksa (henüz indirilmemişse) None bırakırız; soilgrids.get_toprak
    # bu durumda REST hatasını olduğu gibi yükseltir.
    app.state.soilgrids_local = LocalSoilGrids()
    try:
        app.state.soilgrids_local.open()
        logger.info("LocalSoilGrids açıldı: %s", app.state.soilgrids_local.data_dir)
    except LocalSoilGridsError as e:
        logger.warning("LocalSoilGrids fallback yok: %s", e)
        app.state.soilgrids_local = None

    # tarla agent'ları lazy: model adına göre app.state.agents'a cache'lenir.
    # İlk istekte build edilir, sonraki çağrılarda dict'ten çekilir. Frontend
    # /api/modeller'den izinli listeyi alıp varsayılanı veya seçileni gönderir.
    app.state.agents = {}
    app.state.agent_lock = asyncio.Lock()
    app.state.api_key_present = bool(settings.openrouter_api_key)
    if not app.state.api_key_present:
        logger.warning("OPENROUTER_API_KEY tanımsız — /api/rapor ve /api/sohbet 503 döner.")

    try:
        yield
    finally:
        await app.state.http.aclose()
        if app.state.soilgrids_local is not None:
            app.state.soilgrids_local.close()
        db.close()


app = FastAPI(title="TKGM Parsel Demo", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000", "http://127.0.0.1:8000"],
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["*"],
    allow_credentials=True,  # oturum cookie'si (aynı-origin; ileride ayrılırsa güvenli)
)


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


app.include_router(auth.router, prefix="/api", tags=["auth"])
app.include_router(locations.router, prefix="/api", tags=["locations"])
app.include_router(parsel.router, prefix="/api", tags=["parsel"])
app.include_router(analiz.router, prefix="/api", tags=["analiz"])
app.include_router(report.router, prefix="/api", tags=["report"])
app.include_router(kiralama.router, prefix="/api", tags=["kiralama"])
app.include_router(admin.router, prefix="/api", tags=["admin"])

app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

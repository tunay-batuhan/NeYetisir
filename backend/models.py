from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class IdAd(BaseModel):
    id: str
    ad: str
    # GeoJSON Polygon/MultiPolygon — frontend sınır çizgisi + fitBounds için.
    # TKGM tarafında bazı iller için geometri yok → None döner, frontend atlar.
    geometry: dict[str, Any] | None = None


class Koordinat(BaseModel):
    lat: float
    lon: float


class ParselOzellikleri(BaseModel):
    il: str | None = None
    ilce: str | None = None
    mahalle: str | None = None
    ada: str | None = None
    parsel: str | None = None
    yuzolcumu: float | None = Field(default=None, description="m²")
    nitelik: str | None = None
    mevki: str | None = None


class ParselSonuc(BaseModel):
    ozellikler: ParselOzellikleri
    geometry: dict[str, Any] = Field(description="GeoJSON Polygon (WGS84)")
    koordinatlar: list[Koordinat]


# --- 2. aşama: hava + toprak/topografya --------------------------------------


class HavaTahminGunu(BaseModel):
    tarih: str
    sicaklik_min: float
    sicaklik_max: float
    yagis_mm: float
    et0_mm: float | None = None
    ruzgar_max_kmh: float | None = None


class IklimNormaliAyi(BaseModel):
    ay: int
    sicaklik_ort: float
    yagis_top: float


class HavaOzet(BaseModel):
    konum: Koordinat
    tahmin: list[HavaTahminGunu]
    iklim_normali: list[IklimNormaliAyi]


class ToprakKatman(BaseModel):
    derinlik: str
    ph: float | None = None
    kil_pct: float | None = None
    kum_pct: float | None = None
    silt_pct: float | None = None
    organik_karbon_pct: float | None = None
    yogunluk: float | None = None


class Yukseklik(BaseModel):
    rakim_m: float
    egim_derece: float | None = None
    baki_derece: float | None = None
    baki_yon: str | None = None


class ToprakOzet(BaseModel):
    konum: Koordinat
    yukseklik: Yukseklik
    katmanlar: list[ToprakKatman]


# --- Kullanıcı / üyelik ------------------------------------------------------

# Profil slug'ları: kod genelinde tek kaynak (frontend birebir aynı değerleri kullanır).
Profil = Literal["eken", "kiralayan", "kiraci"]


class KayitIstek(BaseModel):
    email: str = Field(..., min_length=3, max_length=120)
    ad: str = Field(..., min_length=1, max_length=80)
    parola: str = Field(..., min_length=6, max_length=200)
    profil: Profil

    @field_validator("email")
    @classmethod
    def _email_normalize(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Geçerli bir e-posta girin.")
        return v


class GirisIstek(BaseModel):
    email: str
    parola: str


class KullaniciBilgi(BaseModel):
    """Response modeli — parola hash'i asla dışarı verilmez."""

    id: int
    email: str
    ad: str
    profil: Profil


# --- Kiralık tarla (başvuru + admin ilan yönetimi) ---------------------------

# Tek kaynak literal'ler; frontend select option'ları birebir aynı değerleri kullanır.
Durum = Literal["beklemede", "yayinda", "reddedildi"]
Egim = Literal["düz", "hafif eğimli", "orta eğimli", "dik"]
SuDurumu = Literal["sulu", "kuru", "kısmen sulu"]


class KiralikBasvuruIstek(BaseModel):
    """Anonim 'tarlamı kiraya ver' formu. Giriş gerektirmez; iletişim form içinde."""

    ad_soyad: str = Field(..., min_length=2, max_length=80)
    email: str = Field(..., min_length=3, max_length=120)
    telefon: str = Field(..., min_length=7, max_length=20)
    il: str | None = Field(default=None, max_length=80)
    ilce: str | None = Field(default=None, max_length=80)
    mahalle: str | None = Field(default=None, max_length=80)
    ada: str = Field(..., min_length=1, max_length=32)
    parsel: str = Field(..., min_length=1, max_length=32)
    alan_m2: float | None = Field(default=None, gt=0, le=1e7)
    egim: Egim | None = None
    su_durumu: SuDurumu | None = None
    aciklama: str | None = Field(default=None, max_length=2000)

    @field_validator("email")
    @classmethod
    def _email_normalize(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Geçerli bir e-posta girin.")
        return v


class AdminTarlaIstek(KiralikBasvuruIstek):
    """Admin'in panelden doğrudan girdiği ilan (varsayılan yayında)."""

    durum: Durum = "yayinda"


class AdminGirisIstek(BaseModel):
    kullanici: str = Field(..., max_length=64)
    parola: str = Field(..., max_length=200)


class AdminBilgi(BaseModel):
    kullanici: str


class KiralikTarlaPublic(BaseModel):
    """Herkese açık ilan yanıtı — yalnızca 'yayinda' kayıtlar listelenir.
    İletişim bilgisi (ad/telefon/email) bilerek dışarı verilmez; ilgilenenler
    'kiralama talebi' formuyla başvurur (admin eşleştirir)."""

    id: int
    il: str | None = None
    ilce: str | None = None
    mahalle: str | None = None
    ada: str
    parsel: str
    alan_m2: float | None = None
    egim: str | None = None
    su_durumu: str | None = None
    aciklama: str | None = None


class KiralikTarlaAdminView(KiralikTarlaPublic):
    """Admin paneli görünümü — sahip iletişimi + durum/kaynak/zaman dahil."""

    ad_soyad: str
    telefon: str
    email: str
    kaynak: str
    durum: str
    created_at: str


# --- Kiralama talebi (kiracı → ilan başvurusu) -------------------------------

# Onay durumu literal'leri (public listesi yok; admin inceler).
KiralamaTalepDurum = Literal["beklemede", "onaylandi", "reddedildi"]


class KiralamaTalebiIstek(BaseModel):
    """Bir kiracının yayındaki bir ilana yaptığı basit başvuru (anonim)."""

    tarla_id: int = Field(..., ge=1)
    ad: str = Field(..., min_length=2, max_length=80)
    soyad: str = Field(..., min_length=2, max_length=80)
    telefon: str = Field(..., min_length=7, max_length=20)
    email: str = Field(..., min_length=3, max_length=120)

    @field_validator("email")
    @classmethod
    def _email_normalize(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Geçerli bir e-posta girin.")
        return v


class KiralamaTalebiAdminView(BaseModel):
    """Admin görünümü — başvuran + başvurulan ilanın konum bilgisi (LEFT JOIN)."""

    id: int
    tarla_id: int
    ad: str
    soyad: str
    telefon: str
    email: str
    durum: str
    created_at: str
    # Başvurulan ilanın bilgisi (ilan silinmişse None).
    il: str | None = None
    ilce: str | None = None
    mahalle: str | None = None
    ada: str | None = None
    parsel: str | None = None


# --- Çiftçi başvurusu ("Çiftçimiz Ol") ---------------------------------------

# Çiftçi başvurusu durum literal'leri (kiralık tarladan ayrı: public listesi yok).
CiftciDurum = Literal["beklemede", "onaylandi", "reddedildi"]


class CiftciBasvuruIstek(BaseModel):
    """Anonim 'Çiftçimiz Ol' formu. Giriş gerektirmez; iletişim form içinde."""

    ad: str = Field(..., min_length=2, max_length=80)
    soyad: str = Field(..., min_length=2, max_length=80)
    sehir: str = Field(..., min_length=2, max_length=80)
    deneyim_yil: int | None = Field(default=None, ge=0, le=100)
    deneyim: str | None = Field(default=None, max_length=2000)
    telefon: str = Field(..., min_length=7, max_length=20)
    email: str = Field(..., min_length=3, max_length=120)

    @field_validator("email")
    @classmethod
    def _email_normalize(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Geçerli bir e-posta girin.")
        return v


class CiftciBasvuruAdminView(BaseModel):
    """Admin paneli görünümü — durum/zaman dahil."""

    id: int
    ad: str
    soyad: str
    sehir: str
    deneyim_yil: int | None = None
    deneyim: str | None = None
    telefon: str
    email: str
    durum: str
    created_at: str


# --- Ekim yardımı ("Tarlama Yardım Al") --------------------------------------

# Durum literal'leri (çiftçi ile aynı küme; public listesi yok, admin inceler).
EkimYardimDurum = Literal["beklemede", "onaylandi", "reddedildi"]


class EkimYardimIstek(BaseModel):
    """Anonim 'Tarlama Yardım Al' formu: tarla sahibi ekim/işleme yardımı ister.
    Parsel alanları opsiyonel (rapordan ön-doldurulabilir ama zorunlu değil)."""

    ad_soyad: str = Field(..., min_length=2, max_length=80)
    telefon: str = Field(..., min_length=7, max_length=20)
    email: str = Field(..., min_length=3, max_length=120)
    il: str | None = Field(default=None, max_length=80)
    ilce: str | None = Field(default=None, max_length=80)
    mahalle: str | None = Field(default=None, max_length=80)
    ada: str | None = Field(default=None, max_length=32)
    parsel: str | None = Field(default=None, max_length=32)
    alan_m2: float | None = Field(default=None, gt=0, le=1e7)
    aciklama: str | None = Field(default=None, max_length=2000)

    @field_validator("email")
    @classmethod
    def _email_normalize(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Geçerli bir e-posta girin.")
        return v


class EkimYardimAdminView(BaseModel):
    """Admin paneli görünümü — iletişim + parsel + durum/zaman dahil."""

    id: int
    ad_soyad: str
    telefon: str
    email: str
    il: str | None = None
    ilce: str | None = None
    mahalle: str | None = None
    ada: str | None = None
    parsel: str | None = None
    alan_m2: float | None = None
    aciklama: str | None = None
    durum: str
    created_at: str

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    port: int = 8000
    # Mock modu: TKGM endpoint'leri doğrulanmadan UI/akış testi için sahte veri döner.
    # .env içinde MOCK_MODE=false yaparak gerçek TKGM proxy moduna geç.
    mock_mode: bool = True

    # TKGM endpoint'leri (resmi olmayan, halka açık). ilce/mahalle/parsel için
    # mahalle/ilçe/ada kimlikleri URL'ye PATH parametresi olarak eklenir.
    il_list_api: str = "https://parselsorgu.tkgm.gov.tr/app/modules/administrativeQuery/data/ilListe.json"
    ilce_list_api: str = "https://cbsapi.tkgm.gov.tr/megsiswebapi.v3.1/api/idariYapi/ilceListe"
    mahalle_list_api: str = "https://cbsapi.tkgm.gov.tr/megsiswebapi.v3.1/api/idariYapi/mahalleListe"
    parsel_api: str = "https://cbsapi.tkgm.gov.tr/megsiswebapi.v3.1/api/parsel"

    # 3. aşama — OpenRouter LLM
    openrouter_api_key: str = ""
    llm_model: str = "deepseek/deepseek-v4-flash"

    # Üyelik/oturum (stdlib sqlite3 + cookie). data/ .gitignore'da.
    db_path: str = "data/app.db"
    oturum_ttl_gun: int = 30

    # Admin panel (kiralık tarla yönetimi). Parola .env'den seed edilir; boşsa
    # admin hesabı oluşturulmaz (panel kullanılamaz). Ayrı cookie/oturum tablosu.
    admin_kullanici: str = "admin"
    admin_parola: str = ""
    admin_oturum_ttl_gun: int = 7

    # LLM endpoint kota/rate-limit (kullanıcı başına; SQLite kullanim_olay tablosu).
    aylik_rapor_kota: int = 3     # aylık rapor sayısı
    aylik_sohbet_kota: int = 100  # aylık sohbet mesajı sayısı
    dakika_limit: int = 6         # 60 sn'deki azami istek (rapor+sohbet ortak burst freni, ÜYE bazlı)
    aylik_kayit_limit: int = 3    # IP başına aylık yeni hesap (sahte hesapla kota sıfırlamayı frenler)

    # IP başına dakikalık limitler (anonim/public uçlar; SQLite ip_istek tablosu).
    # Hepsi caydırıcıdır (X-Forwarded-For sahte olabilir); asıl koruma üye kotasıdır.
    dakika_ip_veri_limit: int = 10    # veri sorgusu (tapu/hava/toprak ortak); bir parsel akışı ~3 istek
    dakika_ip_basvuru_limit: int = 3  # kiralama/çiftçi/ekim-yardım başvurusu (anonim form spam freni)
    dakika_ip_genel_limit: int = 120  # hafif okuma uçları (il/ilçe/mahalle listesi, ben, çıkış, modeller)
    dakika_ip_kimlik_limit: int = 10  # giriş + kayıt denemesi (brute-force / scrypt-burst freni)
    dakika_ip_llm_limit: int = 8      # AI uçları (rapor+sohbet) IP katmanı — üye kotasına EK savunma


settings = Settings()

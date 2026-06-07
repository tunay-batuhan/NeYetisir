"""SQLite kalıcı katmanı (stdlib `sqlite3`) — kullanıcılar + oturumlar.

Proje geri kalanı stateless; yalnızca üyelik/oturum verisi kalıcı tutulur.
Tek bağlantı + modül seviyesi kilit ile korunur; router'lar bu senkron
yardımcıları `asyncio.to_thread` ile çağırır (event loop'u bloklamamak için).
"""

from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

_conn: sqlite3.Connection | None = None
_lock = threading.Lock()


def init_db(db_path: str) -> None:
    """Bağlantıyı aç ve tabloları (idempotent) oluştur. Lifespan'de bir kez çağrılır."""
    global _conn
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    _conn = sqlite3.connect(str(path), check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    with _lock:
        _conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                email       TEXT UNIQUE NOT NULL,
                ad          TEXT NOT NULL,
                parola_hash TEXT NOT NULL,
                profil      TEXT NOT NULL,
                created_at  TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token      TEXT PRIMARY KEY,
                user_id    INTEGER NOT NULL,
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS kullanim_olay (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL,
                tur        TEXT NOT NULL,          -- "rapor" | "sohbet"
                created_at TEXT NOT NULL           -- ISO UTC
            );
            CREATE INDEX IF NOT EXISTS ix_kullanim_user_ts
                ON kullanim_olay(user_id, created_at);
            CREATE TABLE IF NOT EXISTS kayit_olay (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                ip         TEXT NOT NULL,
                created_at TEXT NOT NULL           -- ISO UTC
            );
            CREATE INDEX IF NOT EXISTS ix_kayit_ip_ts
                ON kayit_olay(ip, created_at);
            CREATE TABLE IF NOT EXISTS ip_istek (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                ip         TEXT NOT NULL,
                kategori   TEXT NOT NULL,          -- ör. "veri" | "basvuru"
                created_at TEXT NOT NULL           -- ISO UTC
            );
            CREATE INDEX IF NOT EXISTS ix_ip_istek_ip_kat_ts
                ON ip_istek(ip, kategori, created_at);
            -- Kiralık tarla: hem anonim çiftçi başvurusu hem yayınlanan ilan.
            -- durum alanı ayırır; admin yayınla/reddet ile yönetir.
            CREATE TABLE IF NOT EXISTS kiralik_tarla (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                ad_soyad   TEXT NOT NULL,
                email      TEXT NOT NULL,
                telefon    TEXT NOT NULL,
                il         TEXT,
                ilce       TEXT,
                mahalle    TEXT,
                ada        TEXT NOT NULL,
                parsel     TEXT NOT NULL,
                alan_m2    REAL,
                egim       TEXT,                   -- "düz" | "hafif eğimli" | "orta eğimli" | "dik"
                su_durumu  TEXT,                   -- "sulu" | "kuru" | "kısmen sulu"
                aciklama   TEXT,
                kaynak     TEXT NOT NULL DEFAULT 'basvuru',   -- 'basvuru' | 'admin'
                durum      TEXT NOT NULL DEFAULT 'beklemede', -- 'beklemede' | 'yayinda' | 'reddedildi'
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_kiralik_durum_ts
                ON kiralik_tarla(durum, created_at);
            -- Çiftçi başvurusu ("Çiftçimiz Ol"): anonim form; admin inceler.
            -- Public bir listesi yok; yalnızca admin panelinde görünür.
            CREATE TABLE IF NOT EXISTS ciftci_basvuru (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ad          TEXT NOT NULL,
                soyad       TEXT NOT NULL,
                sehir       TEXT NOT NULL,
                deneyim_yil INTEGER,
                deneyim     TEXT,
                telefon     TEXT NOT NULL,
                email       TEXT NOT NULL,
                durum       TEXT NOT NULL DEFAULT 'beklemede', -- 'beklemede' | 'onaylandi' | 'reddedildi'
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_ciftci_durum_ts
                ON ciftci_basvuru(durum, created_at);
            -- Kiralama talebi: bir kiracının yayındaki bir ilana yaptığı başvuru.
            -- tarla_id → kiralik_tarla(id). Admin inceler; public listesi yok.
            CREATE TABLE IF NOT EXISTS kiralama_talebi (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                tarla_id    INTEGER NOT NULL,
                ad          TEXT NOT NULL,
                soyad       TEXT NOT NULL,
                telefon     TEXT NOT NULL,
                email       TEXT NOT NULL,
                durum       TEXT NOT NULL DEFAULT 'beklemede', -- 'beklemede' | 'onaylandi' | 'reddedildi'
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_kiralama_talebi_durum_ts
                ON kiralama_talebi(durum, created_at);
            -- Ekim yardımı ("Tarlama Yardım Al"): tarla sahibi tarlasını ekmek/işlemek
            -- için yardım ister. Anonim form; admin inceler. Public listesi yok.
            -- Parsel alanları opsiyonel (nav'dan gelen kullanıcıda parsel olmayabilir).
            CREATE TABLE IF NOT EXISTS ekim_yardim (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                ad_soyad   TEXT NOT NULL,
                telefon    TEXT NOT NULL,
                email      TEXT NOT NULL,
                il         TEXT,
                ilce       TEXT,
                mahalle    TEXT,
                ada        TEXT,
                parsel     TEXT,
                alan_m2    REAL,
                aciklama   TEXT,
                durum      TEXT NOT NULL DEFAULT 'beklemede', -- 'beklemede' | 'onaylandi' | 'reddedildi'
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_ekim_yardim_durum_ts
                ON ekim_yardim(durum, created_at);
            -- Admin hesapları + oturumları (kullanıcı sisteminden bağımsız katman).
            CREATE TABLE IF NOT EXISTS admin_users (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                kullanici   TEXT UNIQUE NOT NULL,
                parola_hash TEXT NOT NULL,
                created_at  TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS admin_sessions (
                token      TEXT PRIMARY KEY,
                admin_id   INTEGER NOT NULL,
                expires_at TEXT NOT NULL
            );
            """
        )
        _conn.commit()


def _require_conn() -> sqlite3.Connection:
    if _conn is None:
        raise RuntimeError("db.init_db() çağrılmadı.")
    return _conn


# --- Kullanıcı -------------------------------------------------------------


def kullanici_ekle(email: str, ad: str, parola_hash: str, profil: str) -> int:
    """Yeni kullanıcı ekle, id döndür. E-posta çakışırsa sqlite3.IntegrityError yükselir."""
    conn = _require_conn()
    now = datetime.now(timezone.utc).isoformat()
    with _lock:
        cur = conn.execute(
            "INSERT INTO users (email, ad, parola_hash, profil, created_at) VALUES (?, ?, ?, ?, ?)",
            (email, ad, parola_hash, profil, now),
        )
        conn.commit()
        return int(cur.lastrowid)


def kullanici_getir_email(email: str) -> dict | None:
    conn = _require_conn()
    with _lock:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    return dict(row) if row else None


def kullanici_getir_id(user_id: int) -> dict | None:
    conn = _require_conn()
    with _lock:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return dict(row) if row else None


# --- Oturum ----------------------------------------------------------------


def oturum_ekle(token: str, user_id: int, expires_at: str) -> None:
    conn = _require_conn()
    with _lock:
        conn.execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
            (token, user_id, expires_at),
        )
        conn.commit()


def oturum_getir(token: str) -> dict | None:
    conn = _require_conn()
    with _lock:
        row = conn.execute("SELECT * FROM sessions WHERE token = ?", (token,)).fetchone()
    return dict(row) if row else None


def oturum_sil(token: str) -> None:
    conn = _require_conn()
    with _lock:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()


# --- Kullanım sayacı (LLM endpoint kota/rate-limit) ------------------------


def kullanim_ekle(user_id: int, tur: str) -> None:
    """Bir rapor/sohbet isteğini kayıt altına al (kota sayımı için)."""
    conn = _require_conn()
    now = datetime.now(timezone.utc).isoformat()
    with _lock:
        conn.execute(
            "INSERT INTO kullanim_olay (user_id, tur, created_at) VALUES (?, ?, ?)",
            (user_id, tur, now),
        )
        conn.commit()


def kullanim_say(user_id: int, since_iso: str, tur: str | None = None) -> int:
    """`since_iso`'dan (dahil) bu yana kullanıcının istek sayısı.

    `tur` verilirse yalnızca o tür ("rapor"/"sohbet") sayılır; yoksa hepsi.
    """
    conn = _require_conn()
    sql = "SELECT COUNT(*) FROM kullanim_olay WHERE user_id = ? AND created_at >= ?"
    params: tuple = (user_id, since_iso)
    if tur is not None:
        sql += " AND tur = ?"
        params += (tur,)
    with _lock:
        row = conn.execute(sql, params).fetchone()
    return int(row[0])


# --- Kayıt IP sayacı (sahte hesap spam'ini frenler) ------------------------


def kayit_olay_ekle(ip: str) -> None:
    """Başarılı bir kaydı IP ile kayıt altına al (günlük IP limiti için)."""
    conn = _require_conn()
    now = datetime.now(timezone.utc).isoformat()
    with _lock:
        conn.execute(
            "INSERT INTO kayit_olay (ip, created_at) VALUES (?, ?)",
            (ip, now),
        )
        conn.commit()


def kayit_say(ip: str, since_iso: str) -> int:
    """`since_iso`'dan (dahil) bu yana bu IP'den yapılan kayıt sayısı."""
    conn = _require_conn()
    with _lock:
        row = conn.execute(
            "SELECT COUNT(*) FROM kayit_olay WHERE ip = ? AND created_at >= ?",
            (ip, since_iso),
        ).fetchone()
    return int(row[0])


# --- IP bazlı dakikalık istek sayacı (anonim veri endpoint'leri) -----------


def ip_istek_ekle(ip: str, kategori: str) -> None:
    """Bir IP isteğini kaydet; aynı anda 10 dk'dan eski satırları temizle
    (kısa pencere sayımı için tablo küçük kalır)."""
    conn = _require_conn()
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(minutes=10)).isoformat()
    with _lock:
        conn.execute(
            "INSERT INTO ip_istek (ip, kategori, created_at) VALUES (?, ?, ?)",
            (ip, kategori, now.isoformat()),
        )
        conn.execute("DELETE FROM ip_istek WHERE created_at < ?", (cutoff,))
        conn.commit()


def ip_istek_say(ip: str, kategori: str, since_iso: str) -> int:
    """`since_iso`'dan (dahil) bu yana bu IP+kategori istek sayısı."""
    conn = _require_conn()
    with _lock:
        row = conn.execute(
            "SELECT COUNT(*) FROM ip_istek WHERE ip = ? AND kategori = ? AND created_at >= ?",
            (ip, kategori, since_iso),
        ).fetchone()
    return int(row[0])


# --- Kiralık tarla (başvuru + ilan) ----------------------------------------

# Çiftçi formundan / admin formundan gelen alanlar (id/durum/zaman hariç).
_KIRALIK_ALANLAR = (
    "ad_soyad", "email", "telefon", "il", "ilce", "mahalle",
    "ada", "parsel", "alan_m2", "egim", "su_durumu", "aciklama",
)


def kiralik_ekle(data: dict, kaynak: str, durum: str) -> int:
    """Yeni kiralık tarla kaydı ekle, id döndür. `data` form alanlarını içerir."""
    conn = _require_conn()
    now = datetime.now(timezone.utc).isoformat()
    sutunlar = list(_KIRALIK_ALANLAR) + ["kaynak", "durum", "created_at", "updated_at"]
    degerler = [data.get(a) for a in _KIRALIK_ALANLAR] + [kaynak, durum, now, now]
    yer = ", ".join("?" for _ in sutunlar)
    with _lock:
        cur = conn.execute(
            f"INSERT INTO kiralik_tarla ({', '.join(sutunlar)}) VALUES ({yer})",
            tuple(degerler),
        )
        conn.commit()
        return int(cur.lastrowid)


def kiralik_listele(durum: str | None = None) -> list[dict]:
    """Kiralık tarlaları döndür; `durum` verilirse o duruma filtreler. En yeni önce."""
    conn = _require_conn()
    sql = "SELECT * FROM kiralik_tarla"
    params: tuple = ()
    if durum is not None:
        sql += " WHERE durum = ?"
        params = (durum,)
    sql += " ORDER BY created_at DESC"
    with _lock:
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def kiralik_getir(kayit_id: int) -> dict | None:
    conn = _require_conn()
    with _lock:
        row = conn.execute("SELECT * FROM kiralik_tarla WHERE id = ?", (kayit_id,)).fetchone()
    return dict(row) if row else None


def kiralik_durum_guncelle(kayit_id: int, durum: str) -> bool:
    """Durumu güncelle (yayınla/reddet). Kayıt yoksa False."""
    conn = _require_conn()
    now = datetime.now(timezone.utc).isoformat()
    with _lock:
        cur = conn.execute(
            "UPDATE kiralik_tarla SET durum = ?, updated_at = ? WHERE id = ?",
            (durum, now, kayit_id),
        )
        conn.commit()
        return cur.rowcount > 0


def kiralik_sil(kayit_id: int) -> bool:
    conn = _require_conn()
    with _lock:
        cur = conn.execute("DELETE FROM kiralik_tarla WHERE id = ?", (kayit_id,))
        conn.commit()
        return cur.rowcount > 0


# --- Çiftçi başvurusu ("Çiftçimiz Ol") -------------------------------------

# Başvuru formundan gelen alanlar (id/durum/zaman hariç).
_CIFTCI_ALANLAR = (
    "ad", "soyad", "sehir", "deneyim_yil", "deneyim", "telefon", "email",
)


def ciftci_ekle(data: dict, durum: str) -> int:
    """Yeni çiftçi başvurusu ekle, id döndür. `data` form alanlarını içerir."""
    conn = _require_conn()
    now = datetime.now(timezone.utc).isoformat()
    sutunlar = list(_CIFTCI_ALANLAR) + ["durum", "created_at", "updated_at"]
    degerler = [data.get(a) for a in _CIFTCI_ALANLAR] + [durum, now, now]
    yer = ", ".join("?" for _ in sutunlar)
    with _lock:
        cur = conn.execute(
            f"INSERT INTO ciftci_basvuru ({', '.join(sutunlar)}) VALUES ({yer})",
            tuple(degerler),
        )
        conn.commit()
        return int(cur.lastrowid)


def ciftci_listele(durum: str | None = None) -> list[dict]:
    """Çiftçi başvurularını döndür; `durum` verilirse o duruma filtreler. En yeni önce."""
    conn = _require_conn()
    sql = "SELECT * FROM ciftci_basvuru"
    params: tuple = ()
    if durum is not None:
        sql += " WHERE durum = ?"
        params = (durum,)
    sql += " ORDER BY created_at DESC"
    with _lock:
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def ciftci_getir(kayit_id: int) -> dict | None:
    conn = _require_conn()
    with _lock:
        row = conn.execute("SELECT * FROM ciftci_basvuru WHERE id = ?", (kayit_id,)).fetchone()
    return dict(row) if row else None


def ciftci_durum_guncelle(kayit_id: int, durum: str) -> bool:
    """Durumu güncelle (onayla/reddet). Kayıt yoksa False."""
    conn = _require_conn()
    now = datetime.now(timezone.utc).isoformat()
    with _lock:
        cur = conn.execute(
            "UPDATE ciftci_basvuru SET durum = ?, updated_at = ? WHERE id = ?",
            (durum, now, kayit_id),
        )
        conn.commit()
        return cur.rowcount > 0


def ciftci_sil(kayit_id: int) -> bool:
    conn = _require_conn()
    with _lock:
        cur = conn.execute("DELETE FROM ciftci_basvuru WHERE id = ?", (kayit_id,))
        conn.commit()
        return cur.rowcount > 0


# --- Ekim yardımı ("Tarlama Yardım Al") ------------------------------------

# Başvuru formundan gelen alanlar (id/durum/zaman hariç).
_EKIM_YARDIM_ALANLAR = (
    "ad_soyad", "telefon", "email", "il", "ilce", "mahalle",
    "ada", "parsel", "alan_m2", "aciklama",
)


def ekim_yardim_ekle(data: dict, durum: str) -> int:
    """Yeni ekim yardımı başvurusu ekle, id döndür. `data` form alanlarını içerir."""
    conn = _require_conn()
    now = datetime.now(timezone.utc).isoformat()
    sutunlar = list(_EKIM_YARDIM_ALANLAR) + ["durum", "created_at", "updated_at"]
    degerler = [data.get(a) for a in _EKIM_YARDIM_ALANLAR] + [durum, now, now]
    yer = ", ".join("?" for _ in sutunlar)
    with _lock:
        cur = conn.execute(
            f"INSERT INTO ekim_yardim ({', '.join(sutunlar)}) VALUES ({yer})",
            tuple(degerler),
        )
        conn.commit()
        return int(cur.lastrowid)


def ekim_yardim_listele(durum: str | None = None) -> list[dict]:
    """Ekim yardımı başvurularını döndür; `durum` verilirse filtreler. En yeni önce."""
    conn = _require_conn()
    sql = "SELECT * FROM ekim_yardim"
    params: tuple = ()
    if durum is not None:
        sql += " WHERE durum = ?"
        params = (durum,)
    sql += " ORDER BY created_at DESC"
    with _lock:
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def ekim_yardim_getir(kayit_id: int) -> dict | None:
    conn = _require_conn()
    with _lock:
        row = conn.execute("SELECT * FROM ekim_yardim WHERE id = ?", (kayit_id,)).fetchone()
    return dict(row) if row else None


def ekim_yardim_durum_guncelle(kayit_id: int, durum: str) -> bool:
    """Durumu güncelle (onayla/reddet). Kayıt yoksa False."""
    conn = _require_conn()
    now = datetime.now(timezone.utc).isoformat()
    with _lock:
        cur = conn.execute(
            "UPDATE ekim_yardim SET durum = ?, updated_at = ? WHERE id = ?",
            (durum, now, kayit_id),
        )
        conn.commit()
        return cur.rowcount > 0


def ekim_yardim_sil(kayit_id: int) -> bool:
    conn = _require_conn()
    with _lock:
        cur = conn.execute("DELETE FROM ekim_yardim WHERE id = ?", (kayit_id,))
        conn.commit()
        return cur.rowcount > 0


# --- Kiralama talebi (kiracı → ilan başvurusu) -----------------------------

_KIRALAMA_TALEBI_ALANLAR = ("tarla_id", "ad", "soyad", "telefon", "email")


def kiralama_talebi_ekle(data: dict, durum: str) -> int:
    """Yeni kiralama talebi ekle, id döndür. `data` form alanlarını içerir."""
    conn = _require_conn()
    now = datetime.now(timezone.utc).isoformat()
    sutunlar = list(_KIRALAMA_TALEBI_ALANLAR) + ["durum", "created_at", "updated_at"]
    degerler = [data.get(a) for a in _KIRALAMA_TALEBI_ALANLAR] + [durum, now, now]
    yer = ", ".join("?" for _ in sutunlar)
    with _lock:
        cur = conn.execute(
            f"INSERT INTO kiralama_talebi ({', '.join(sutunlar)}) VALUES ({yer})",
            tuple(degerler),
        )
        conn.commit()
        return int(cur.lastrowid)


def kiralama_talebi_listele(durum: str | None = None) -> list[dict]:
    """Talepleri döndür; her satıra ilgili ilanın konum bilgisini ekler (LEFT JOIN,
    ilan silinmişse None). `durum` verilirse o duruma filtreler. En yeni önce."""
    conn = _require_conn()
    sql = (
        "SELECT t.*, k.il, k.ilce, k.mahalle, k.ada, k.parsel "
        "FROM kiralama_talebi t LEFT JOIN kiralik_tarla k ON k.id = t.tarla_id"
    )
    params: tuple = ()
    if durum is not None:
        sql += " WHERE t.durum = ?"
        params = (durum,)
    sql += " ORDER BY t.created_at DESC"
    with _lock:
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def kiralama_talebi_durum_guncelle(kayit_id: int, durum: str) -> bool:
    """Durumu güncelle (onayla/reddet). Kayıt yoksa False."""
    conn = _require_conn()
    now = datetime.now(timezone.utc).isoformat()
    with _lock:
        cur = conn.execute(
            "UPDATE kiralama_talebi SET durum = ?, updated_at = ? WHERE id = ?",
            (durum, now, kayit_id),
        )
        conn.commit()
        return cur.rowcount > 0


def kiralama_talebi_sil(kayit_id: int) -> bool:
    conn = _require_conn()
    with _lock:
        cur = conn.execute("DELETE FROM kiralama_talebi WHERE id = ?", (kayit_id,))
        conn.commit()
        return cur.rowcount > 0


# --- Admin hesapları + oturumları ------------------------------------------


def admin_getir_kullanici(kullanici: str) -> dict | None:
    conn = _require_conn()
    with _lock:
        row = conn.execute(
            "SELECT * FROM admin_users WHERE kullanici = ?", (kullanici,)
        ).fetchone()
    return dict(row) if row else None


def admin_ekle(kullanici: str, parola_hash: str) -> int:
    conn = _require_conn()
    now = datetime.now(timezone.utc).isoformat()
    with _lock:
        cur = conn.execute(
            "INSERT INTO admin_users (kullanici, parola_hash, created_at) VALUES (?, ?, ?)",
            (kullanici, parola_hash, now),
        )
        conn.commit()
        return int(cur.lastrowid)


def admin_getir_id(admin_id: int) -> dict | None:
    conn = _require_conn()
    with _lock:
        row = conn.execute("SELECT * FROM admin_users WHERE id = ?", (admin_id,)).fetchone()
    return dict(row) if row else None


def admin_oturum_ekle(token: str, admin_id: int, expires_at: str) -> None:
    conn = _require_conn()
    with _lock:
        conn.execute(
            "INSERT INTO admin_sessions (token, admin_id, expires_at) VALUES (?, ?, ?)",
            (token, admin_id, expires_at),
        )
        conn.commit()


def admin_oturum_getir(token: str) -> dict | None:
    conn = _require_conn()
    with _lock:
        row = conn.execute(
            "SELECT * FROM admin_sessions WHERE token = ?", (token,)
        ).fetchone()
    return dict(row) if row else None


def admin_oturum_sil(token: str) -> None:
    conn = _require_conn()
    with _lock:
        conn.execute("DELETE FROM admin_sessions WHERE token = ?", (token,))
        conn.commit()


def close() -> None:
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None

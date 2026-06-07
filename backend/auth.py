"""Kimlik doğrulama primitifleri — yalnızca Python standart kütüphanesi.

3. parti yok: şifre `hashlib.scrypt` (bellek-zorlu) ile salt'lanarak hash'lenir,
oturum token'ı `secrets` ile üretilir, karşılaştırmalar `hmac.compare_digest`
ile sabit-zamanlı yapılır.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timezone

from backend import db

# Geçerli profiller — kayıt doğrulaması ve UI eşlemesi için tek kaynak.
PROFILLER = frozenset({"eken", "kiralayan", "kiraci"})

# scrypt parametreleri (interaktif/önerilen seviye). Bellek ≈ 128*N*r ≈ 16 MiB.
_N = 2**14
_R = 8
_P = 1
_DKLEN = 32


def hash_parola(parola: str) -> str:
    """`salt_hex$hash_hex` formatında saklanabilir hash üretir."""
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(parola.encode("utf-8"), salt=salt, n=_N, r=_R, p=_P, dklen=_DKLEN)
    return f"{salt.hex()}${dk.hex()}"


def dogrula_parola(parola: str, stored: str) -> bool:
    """Saklı hash'i çözüp parolayı sabit-zamanlı karşılaştırır."""
    try:
        salt_hex, hash_hex = stored.split("$", 1)
        salt = bytes.fromhex(salt_hex)
        beklenen = bytes.fromhex(hash_hex)
    except (ValueError, AttributeError):
        return False
    dk = hashlib.scrypt(parola.encode("utf-8"), salt=salt, n=_N, r=_R, p=_P, dklen=len(beklenen))
    return hmac.compare_digest(dk, beklenen)


def yeni_token() -> str:
    """URL-güvenli rastgele oturum token'ı (opak)."""
    return secrets.token_urlsafe(32)


def aktif_kullanici_token(token: str | None) -> dict | None:
    """Token → oturum → kullanıcı. Süresi geçmiş/geçersizse None (ve oturumu temizler).

    Senkron (db erişimi); router'lar `asyncio.to_thread` ile çağırır.
    """
    if not token:
        return None
    oturum = db.oturum_getir(token)
    if not oturum:
        return None
    try:
        exp = datetime.fromisoformat(oturum["expires_at"])
    except (ValueError, KeyError):
        return None
    if exp < datetime.now(timezone.utc):
        db.oturum_sil(token)
        return None
    return db.kullanici_getir_id(oturum["user_id"])


def aktif_admin_token(token: str | None) -> dict | None:
    """Token → admin oturumu → admin. Süresi geçmiş/geçersizse None (oturumu temizler).

    `aktif_kullanici_token` ikizi; ayrı admin_sessions/admin_users tabloları üstünde.
    Senkron; router'lar `asyncio.to_thread` ile çağırır.
    """
    if not token:
        return None
    oturum = db.admin_oturum_getir(token)
    if not oturum:
        return None
    try:
        exp = datetime.fromisoformat(oturum["expires_at"])
    except (ValueError, KeyError):
        return None
    if exp < datetime.now(timezone.utc):
        db.admin_oturum_sil(token)
        return None
    return db.admin_getir_id(oturum["admin_id"])

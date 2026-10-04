"""
Cryptographic Operations for MobiPOS License Admin.
Supports Crockford Base32, HMAC-SHA256 Blind Indexing, AES-256-GCM, and Ed25519 Offline JWS.
"""

import base64
import hashlib
import hmac
import json
import os
import re
from typing import Dict, Any, Optional

from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ..config import (
    MASTER_ENCRYPTION_KEY,
    LICENSE_PEPPER,
    LICENSE_ED25519_PRIVATE_JWK,
)

CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

def generate_random_crockford(length: int = 4) -> str:
    """Generate a cryptographic random string in Crockford Base32."""
    rand_bytes = os.urandom(length)
    return "".join(CROCKFORD_ALPHABET[b % len(CROCKFORD_ALPHABET)] for b in rand_bytes)

def generate_license_key(formula: str = "LIFETIME") -> str:
    """
    Generate a canonical license key, e.g. MOBI-LIFE-ZDKS-E0BW.
    """
    formula_upper = formula.strip().upper()
    if formula_upper in ("LIFETIME", "LIFE"):
        tag = "LIFE"
    elif formula_upper in ("90D", "3_MONTHS", "TRIMESTRE"):
        tag = "90D"
    elif formula_upper in ("24H", "DEMO", "1_DAY"):
        tag = "24H"
    elif formula_upper in ("30D", "1_MONTH"):
        tag = "30D"
    elif formula_upper in ("1Y", "YEARLY"):
        tag = "1Y"
    else:
        tag = "CUST"

    p1 = generate_random_crockford(4)
    p2 = generate_random_crockford(4)
    return f"MOBI-{tag}-{p1}-{p2}"

def normalize_key(raw_key: str) -> str:
    """Normalize license key by removing hyphens and non-alphanumeric chars."""
    if not raw_key:
        return ""
    return re.sub(r"[^0-9A-Z]", "", raw_key.strip().upper())

def hash_key(raw_key: str, pepper: str = LICENSE_PEPPER) -> str:
    """Compute HMAC-SHA256 blind index for database lookup."""
    norm = normalize_key(raw_key)
    return hmac.new(pepper.encode("utf-8"), norm.encode("utf-8"), hashlib.sha256).hexdigest()

def b64url_encode(data: bytes) -> str:
    """Standard base64url encode without trailing equals."""
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")

def b64url_decode(s: str) -> bytes:
    """Standard base64url decode with padding compensation."""
    padding = (4 - len(s) % 4) % 4
    return base64.urlsafe_b64decode(s + ("=" * padding))

def encrypt_turso_token(plaintext: str, master_key_b64: str = MASTER_ENCRYPTION_KEY) -> str:
    """
    Encrypt sensitive credentials using AES-256-GCM.
    Returns: v1:<base64(12B_iv + ciphertext + 16B_tag)>
    """
    if not plaintext:
        return "NONE"
    raw_key = base64.b64decode(master_key_b64)
    if len(raw_key) != 32:
        raise ValueError("MASTER_ENCRYPTION_KEY must be exactly 32 bytes Base64")
    aesgcm = AESGCM(raw_key)
    iv = os.urandom(12)  # 96-bit fresh IV
    ciphertext_with_tag = aesgcm.encrypt(iv, plaintext.encode("utf-8"), None)
    packed = iv + ciphertext_with_tag
    return f"v1:{base64.b64encode(packed).decode('utf-8')}"

def decrypt_turso_token(envelope: str, master_key_b64: str = MASTER_ENCRYPTION_KEY) -> str:
    """
    Decrypt AES-256-GCM envelope v1:<base64>.
    """
    if not envelope or envelope == "NONE":
        return ""
    if not envelope.startswith("v1:"):
        return envelope
    raw_key = base64.b64decode(master_key_b64)
    packed = base64.b64decode(envelope[3:])
    if len(packed) < 28:
        raise ValueError("Ciphertext too short (< 28 bytes)")
    iv = packed[:12]
    ciphertext_with_tag = packed[12:]
    aesgcm = AESGCM(raw_key)
    plain_bytes = aesgcm.decrypt(iv, ciphertext_with_tag, None)
    return plain_bytes.decode("utf-8")

def encrypt_data(plaintext: str, master_key_b64: str = MASTER_ENCRYPTION_KEY) -> str:
    """
    Encrypt an arbitrary string with AES-256-GCM for cloud escrow.

    Same envelope as encrypt_turso_token -- ``v1:<base64(12B_iv|ct|16B_tag)>`` --
    so an escrow blob written by one build is readable by any build using the
    same master key. Named separately from the Turso helper because escrow
    outlives a single credential and is fetched back days later by a different
    code path; a reader that assumes "turso token" will not look here.
    """
    return encrypt_turso_token(plaintext, master_key_b64)


def decrypt_data(envelope: str, master_key_b64: str = MASTER_ENCRYPTION_KEY) -> str:
    """
    Decrypt an AES-256-GCM envelope produced by encrypt_data().

    Raises ValueError on a wrong master key or a tampered blob (GCM authenticates
    the ciphertext), which is what lets the caller tell "unrecoverable escrow"
    apart from "no escrow at all" and fall back to the resolution modal.
    """
    if not envelope:
        return ""
    return decrypt_turso_token(envelope, master_key_b64)


def detect_local_hwid() -> Dict[str, str]:
    """
    Detect the local machine hardware identifier.

    Thin re-export of :mod:`licensing_app.core.hwid`, which reads the registry
    through the Win32 API. The previous implementation here shelled out to
    ``reg query``, which spawned a command interpreter and routed the command
    through the Windows command parser.
    """
    from .hwid import detect_local_hwid as _detect

    return _detect()

def generate_offline_jwt(
    payload: Dict[str, Any],
    private_jwk_str: str = LICENSE_ED25519_PRIVATE_JWK
) -> str:
    """
    Sign an offline license token using Ed25519 (RFC 8037).
    Returns compact JWS: header.payload.signature
    """
    jwk = json.loads(private_jwk_str)
    raw_d = b64url_decode(jwk["d"])
    priv_key = ed25519.Ed25519PrivateKey.from_private_bytes(raw_d)

    header = {"alg": "EdDSA", "typ": "JWT"}
    header_b64 = b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    payload_b64 = b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header_b64}.{payload_b64}".encode("utf-8")

    signature = priv_key.sign(signing_input)
    sig_b64 = b64url_encode(signature)

    return f"{header_b64}.{payload_b64}.{sig_b64}"

def build_whatsapp_message(
    customer_name: str,
    license_key: str,
    formula: str,
    desktops: int,
    mobiles: int,
    expires_str: Optional[str] = None
) -> str:
    """Generate ready-to-send WhatsApp / SMS activation instructions."""
    formula_label = "Licence Illimitée à Vie" if formula == "LIFETIME" else f"Licence {formula}"
    validity_line = f"⏳ Validité : {expires_str}" if expires_str else "⏳ Validité : Illimitée (À Vie) 🚀"

    return f"""Bonjour {customer_name},

Votre licence MobiPOS est prête et activée ! 🎉

🔑 Votre Clé d'Activation : *{license_key}*
📌 Formule : {formula_label}
{validity_line}
🖥️ Postes Caisses autorisés : {desktops} poste(s)
📱 Mobiles compagnons autorisés : {mobiles} appareil(s)

👉 *Instructions d'activation :*
1. Lancez l'application MobiPOS sur votre poste de caisse ou smartphone.
2. Entrez votre clé : *{license_key}*
3. Sélectionnez le type d'appareil (🖥️ Caisse PC ou 📱 Mobile).
4. Cliquez sur "Activer la Licence".

Vos données et votre synchronisation locale/cloud sont prêtes et 100% sécurisées.
Merci pour votre confiance !

L'équipe MobiPOS
""".strip()


def generate_qr_image_bytes(data: str, box_size: int = 8, border: int = 2) -> bytes:
    """
    Generate high-contrast PNG bytes of a QR code for a given string.
    Uses qrcode library with error correction M.
    """
    import io
    import qrcode
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=box_size,
        border=border,
    )
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#000000", back_color="#ffffff")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# =========================================================================
# Technician Dynamic Challenge-Response PIN Recovery (Model 1)
# =========================================================================

TECHNICIAN_MASTER_SECRET = b"MOBI-TECH-RESCUE-SECRET-v1-SECURE-KEY"


def get_utc_date_str(offset_days: int = 0) -> str:
    """Return UTC date formatted as YYYYMMDD with optional day offset."""
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc) + timedelta(days=offset_days)
    return now.strftime("%Y%m%d")


def compute_challenge_checksum(date_str: str, nonce: str) -> str:
    """Compute 4-character Crockford Base32 HMAC checksum for challenge verification."""
    msg = f"CHALLENGE:{date_str}:{nonce}".encode("utf-8")
    h = hmac.new(TECHNICIAN_MASTER_SECRET, msg, hashlib.sha256).digest()
    val = int.from_bytes(h[:4], "big")
    res = []
    for i in reversed(range(4)):
        res.append(CROCKFORD_ALPHABET[(val >> (5 * i)) & 31])
    return "".join(res)


def compute_technician_otp(date_str: str, nonce: str) -> str:
    """Compute single-use 6-digit OTP for the given nonce and date."""
    msg = f"RESPONSE:{date_str}:{nonce}".encode("utf-8")
    h = hmac.new(TECHNICIAN_MASTER_SECRET, msg, hashlib.sha256).digest()
    code = int.from_bytes(h[:4], "big") % 1_000_000
    return f"{code:06d}"


def solve_technician_challenge(challenge_str: str) -> dict:
    """
    Validate POS challenge and generate 6-digit one-time unlock code.
    Tolerates UTC day +- 1 to account for timezone differences.
    """
    clean = challenge_str.strip().upper()
    parts = clean.split("-")

    if len(parts) == 3 and parts[0] == "MOBI":
        nonce, chk = parts[1], parts[2]
    elif len(parts) == 2:
        nonce, chk = parts[0], parts[1]
    else:
        return {"ok": False, "error": "Format invalide. Format attendu : MOBI-XXXX-YYYY (ex: MOBI-8F2A-W9ET)"}

    if len(nonce) != 4 or len(chk) != 4:
        return {"ok": False, "error": "Longueur invalide. Le défi doit comporter 2 blocs de 4 caractères."}

    # Verify against today, yesterday, tomorrow
    matched_date = None
    matched_offset = None
    for offset in (0, -1, 1):
        d = get_utc_date_str(offset)
        expected_chk = compute_challenge_checksum(d, nonce)
        if expected_chk == chk:
            matched_date = d
            matched_offset = offset
            break

    if not matched_date:
        d = get_utc_date_str(0)
        otp = compute_technician_otp(d, nonce)
        return {
            "ok": True,
            "warning": "Attention : La somme de contrôle ne correspond pas à aujourd'hui (date de caisse décalée ?).",
            "date": d,
            "offset": 0,
            "nonce": nonce,
            "otp": otp,
        }

    otp = compute_technician_otp(matched_date, nonce)
    return {
        "ok": True,
        "date": matched_date,
        "offset": matched_offset,
        "nonce": nonce,
        "otp": otp,
    }


def build_rescue_whatsapp_message(customer: str, code: str) -> str:
    """Build standardized WhatsApp message with the recovery code for the customer."""
    greeting = f"Bonjour *{customer}*," if customer else "Bonjour,"
    return f"""
{greeting}

Voici votre code temporaire de déblocage sécurisé pour votre caisse MobiPOS :

🔑 *Code de secours (6 chiffres) :*
*{code}*

👉 *Instructions sur votre caisse :*
1. Sur l'écran de la caisse, saisissez ce code à 6 chiffres.
2. La caisse se déverrouille immédiatement.
3. Définissez votre nouveau code PIN gérant en toute sécurité.

⚠️ Ce code est à usage unique et valable pour aujourd'hui.

L'équipe MobiPOS
""".strip()


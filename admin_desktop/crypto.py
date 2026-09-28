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
import secrets
import subprocess
import time
from typing import Dict, Any, Optional

from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

try:
    from .config import (
        MASTER_ENCRYPTION_KEY,
        LICENSE_PEPPER,
        LICENSE_ED25519_PRIVATE_JWK
    )
except (ImportError, ValueError):
    from config import (
        MASTER_ENCRYPTION_KEY,
        LICENSE_PEPPER,
        LICENSE_ED25519_PRIVATE_JWK
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

def detect_local_hwid() -> Dict[str, str]:
    """
    Detect local machine hardware identifier on Windows.
    Matches the algorithm in scripts/license-admin.mjs and src/licensing/hwid.ts.
    """
    salt = "mobi-pos-license-salt-v1:"
    try:
        guid_output = subprocess.check_output(
            'reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
            shell=True,
            stderr=subprocess.DEVNULL,
            universal_newlines=True
        )
        match = re.search(r"MachineGuid\s+REG_SZ\s+(\S+)", guid_output, re.IGNORECASE)
        guid = match.group(1).strip() if match else "UNKNOWN_WINDOWS_GUID"

        board = "GENERIC_BOARD"
        try:
            board_out = subprocess.check_output(
                'reg query HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS /v BaseBoardProduct',
                shell=True,
                stderr=subprocess.DEVNULL,
                universal_newlines=True
            )
            b_match = re.search(r"BaseBoardProduct\s+REG_SZ\s+(.+)", board_out, re.IGNORECASE)
            if b_match:
                board = b_match.group(1).strip()
        except Exception:
            pass

        raw = f"win:{guid}:{board}"
        h = hashlib.sha256((salt + raw).encode("utf-8")).hexdigest()
        u = h.upper()
        formatted = f"MOBI-{u[0:4]}-{u[4:8]}-{u[8:12]}-{u[12:16]}"
        return {"hash": h, "formatted": formatted, "platform": "windows"}
    except Exception:
        fallback = secrets.token_hex(16)
        return {"hash": fallback, "formatted": f"MOBI-DEV-{fallback[:8].upper()}", "platform": "fallback"}

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

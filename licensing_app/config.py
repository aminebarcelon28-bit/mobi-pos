"""
Secure configuration resolution for "Licensing for MobiPOS".

Resolution order (first hit wins):

1. Process environment (set by a launcher, CI, or operator shell).
2. OS secure vault -- Windows Credential Manager via ``keyring`` when
   available, otherwise DPAPI-protected local file via ``win32crypt``.
3. Nothing: secrets stay unset and the app degrades to a clearly-reported
   reduced-capability mode.

Deliberately absent: bundling ``.env`` files into the distributable. A previous
build shipped the master Ed25519 signing key, the HMAC pepper, and the
encryption key inside the executable's compressed payload, which meant anyone
holding the binary could mint arbitrary licenses. That path is closed.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

APP_NAME = "Licensing for MobiPOS"
APP_VERSION = "3.1.0"
APP_ID = "com.mobipos.licensing"

VAULT_SERVICE = "mobipos-licensing"

#: Secrets the app knows how to source, and whether absence is fatal.
SECRET_NAMES = (
    "LICENSING_ENDPOINT",
    "MASTER_ENCRYPTION_KEY",
    "LICENSE_PEPPER",
    "IP_PEPPER",
    "LICENSE_ED25519_PRIVATE_JWK",
    "ADMIN_TOKEN",
)


def is_frozen() -> bool:
    """True when running from a PyInstaller bundle."""
    return bool(getattr(sys, "frozen", False))


def bundle_dir() -> Path:
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def resource_path(*parts: str) -> Path:
    return bundle_dir().joinpath(*parts)


def data_dir() -> Path:
    """Writable per-user directory for the ledger, vault, and audit trail."""
    if sys.platform == "win32":
        base = Path(os.getenv("APPDATA") or Path.home()) / APP_ID
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / APP_ID
    else:
        base = Path(os.getenv("XDG_DATA_HOME", Path.home() / ".local" / "share")) / APP_ID
    base.mkdir(parents=True, exist_ok=True)
    return base


LEDGER_PATH = data_dir() / "licenses_ledger.json"
AUDIT_LOG_PATH = data_dir() / "licenses_audit.json"
SETTINGS_PATH = data_dir() / "settings.json"
NODE_SECRET_PATH = data_dir() / "node_secret"


# ---------------------------------------------------------------------------
# OS secure vault
# ---------------------------------------------------------------------------
def _keyring():
    try:
        import keyring  # type: ignore

        return keyring
    except Exception:
        return None


def _dpapi():
    try:
        import win32crypt  # type: ignore

        return win32crypt
    except Exception:
        return None


def vault_get(name: str) -> Optional[str]:
    """Read a secret from the OS vault. Returns None when unavailable."""
    keyring = _keyring()
    if keyring is not None:
        try:
            value = keyring.get_password(VAULT_SERVICE, name)
            if value:
                return value
        except Exception:
            pass
    return None


def vault_set(name: str, value: str) -> bool:
    """Persist a secret to the OS vault. Returns True on success."""
    keyring = _keyring()
    if keyring is not None:
        try:
            keyring.set_password(VAULT_SERVICE, name, value)
            return True
        except Exception:
            return False
    return False


def vault_import_file(path: Path, passphrase: str = "") -> tuple[bool, str]:
    """
    Import a JSON secrets document into the OS vault.

    Accepts ``{"MASTER_ENCRYPTION_KEY": "...", ...}``. Values are never
    written to the registry or returned in cleartext in error messages.

    When the document contains the Ed25519 signing key, ``passphrase`` is
    required: the file is treated as an Argon2id-encrypted envelope and must
    decrypt before anything is stored. Importing a signing key without proving
    the passphrase would defeat the point of encrypting it.
    """
    try:
        raw = Path(path).read_bytes()
    except OSError as exc:
        return False, f"Cannot read secrets file: {exc}"

    payload = _decrypt_envelope(raw, passphrase)
    if payload is None:
        return False, "Incorrect passphrase, or the file is not a valid envelope."

    if not isinstance(payload, dict):
        return False, "Secrets file must contain a JSON object."

    stored = 0
    for key, value in payload.items():
        if key in SECRET_NAMES and isinstance(value, str) and value:
            if vault_set(key, value):
                stored += 1
    if not stored:
        return False, "No supported secrets were stored (is keyring available?)."
    return True, f"{stored} secret(s) imported into the OS vault."


#: Argon2id parameters. 64 MiB / 3 passes is the OWASP baseline; raising the
#: cost only matters if the passphrase is weak, but the memory cost is what
#: makes an offline GPU attack expensive.
ARGON2_TIME_COST = 3
ARGON2_MEMORY_COST = 65536  # KiB
ARGON2_PARALLELISM = 4
ARGON2_SALT_BYTES = 16
ARGON2_KEY_BYTES = 32

#: Magic header for an encrypted secrets envelope.
ENVELOPE_MAGIC = b"MOBIV1"


def encrypt_secrets_envelope(
    payload: dict, passphrase: str
) -> bytes:
    """
    Encrypt a secrets document under a passphrase using Argon2id + AES-GCM.

    Layout: MAGIC(6) | salt(16) | nonce(12) | ciphertext+tag
    """
    from argon2.low_level import Type, hash_secret_raw
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if not passphrase:
        raise ValueError("A passphrase is required to encrypt secrets.")

    salt = os.urandom(ARGON2_SALT_BYTES)
    key = hash_secret_raw(
        passphrase.encode("utf-8"),
        salt=salt,
        time_cost=ARGON2_TIME_COST,
        memory_cost=ARGON2_MEMORY_COST,
        parallelism=ARGON2_PARALLELISM,
        hash_len=ARGON2_KEY_BYTES,
        type=Type.ID,  # Argon2id, not Argon2i or Argon2d
    )
    nonce = os.urandom(12)
    plaintext = json.dumps(payload).encode("utf-8")
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, ENVELOPE_MAGIC)
    return ENVELOPE_MAGIC + salt + nonce + ciphertext


def _decrypt_envelope(raw: bytes, passphrase: str = "") -> Optional[dict]:
    """
    Decrypt an encrypted secrets envelope.

    Returns the payload dict, or None if the file is not a valid envelope, the
    passphrase is wrong, or the passphrase is missing. A wrong passphrase is
    indistinguishable from a corrupt file by design: AES-GCM authentication
    fails and no plaintext is produced.
    """
    from argon2.low_level import Type, hash_secret_raw
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    header = len(ENVELOPE_MAGIC) + ARGON2_SALT_BYTES + 12
    if not raw.startswith(ENVELOPE_MAGIC) or len(raw) <= header:
        return None
    if not passphrase:
        return None

    offset = len(ENVELOPE_MAGIC)
    salt = raw[offset:offset + ARGON2_SALT_BYTES]
    offset += ARGON2_SALT_BYTES
    nonce = raw[offset:offset + 12]
    offset += 12
    ciphertext = raw[offset:]

    key = hash_secret_raw(
        passphrase.encode("utf-8"),
        salt=salt,
        time_cost=ARGON2_TIME_COST,
        memory_cost=ARGON2_MEMORY_COST,
        parallelism=ARGON2_PARALLELISM,
        hash_len=ARGON2_KEY_BYTES,
        type=Type.ID,
    )
    try:
        plaintext = AESGCM(key).decrypt(nonce, ciphertext, ENVELOPE_MAGIC)
    except InvalidTag:
        # Wrong passphrase or tampered ciphertext.
        return None
    try:
        return json.loads(plaintext.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None


def is_encrypted_envelope(path: Path) -> bool:
    """True when the file starts with the encrypted-envelope magic header."""
    try:
        with open(path, "rb") as handle:
            return handle.read(len(ENVELOPE_MAGIC)) == ENVELOPE_MAGIC
    except OSError:
        return False


# ---------------------------------------------------------------------------
# Node secret for the audit hash chain
# ---------------------------------------------------------------------------
#: Magic prefix marking a DPAPI-protected blob. A raw secret carries the
#: fallback prefix instead, so the reader can tell which form it is holding
#: rather than assuming DPAPI and silently returning garbage.
_DPAPI_MAGIC = b"MDP1"
_RAW_MAGIC = b"MRAW1"


def _load_node_secret() -> Optional[bytes]:
    """Read a previously stored node secret, if one is present and valid."""
    if not NODE_SECRET_PATH.exists():
        return None
    try:
        blob = NODE_SECRET_PATH.read_bytes()
    except OSError:
        return None

    if blob.startswith(_RAW_MAGIC):
        candidate = blob[len(_RAW_MAGIC):]
        return candidate or None

    if blob.startswith(_DPAPI_MAGIC):
        win32crypt = _dpapi()
        if win32crypt is None:
            return None
        try:
            candidate = win32crypt.CryptUnprotectData(
                blob[len(_DPAPI_MAGIC):], None, None, None, 0
            )[1]
        except Exception:
            return None
        # Guard against a decrypt that returns the wrong length: an unstable
        # secret would silently invalidate the whole chain on the next write.
        return candidate if len(candidate) == 32 else None

    return None


def _store_node_secret(secret: bytes) -> None:
    """Persist the node secret, preferring DPAPI protection on Windows."""
    win32crypt = _dpapi()
    if win32crypt is not None:
        try:
            # Argument order is (data, description, entropy, reserved,
            # prompt_struct, flags) and this returns raw bytes, whereas
            # CryptUnprotectData returns a (description, data) tuple.
            protected = win32crypt.CryptProtectData(secret, None, None, None, None, 0)
            NODE_SECRET_PATH.write_bytes(_DPAPI_MAGIC + protected)
            # Only keep this form if it round-trips; otherwise the next start
            # would read back different bytes and fail verification.
            if _load_node_secret() == secret:
                return
        except Exception:
            pass
    NODE_SECRET_PATH.write_bytes(_RAW_MAGIC + secret)
    try:
        os.chmod(NODE_SECRET_PATH, 0o600)
    except OSError:
        pass


def node_secret() -> bytes:
    """
    Per-installation secret used to HMAC the audit chain.

    Generated once and DPAPI-protected on Windows, so another machine (or a
    copied data directory) cannot forge a valid chain. Must return the same
    bytes for the lifetime of the installation, or every previously written
    record would fail verification.
    """
    env = os.getenv("LICENSING_NODE_SECRET")
    if env:
        return env.encode("utf-8")

    existing = _load_node_secret()
    if existing is not None:
        return existing

    secret = os.urandom(32)
    _store_node_secret(secret)
    return secret


# ---------------------------------------------------------------------------
# Resolved configuration
# ---------------------------------------------------------------------------
def _load_env_file(path: Path) -> None:
    """
    Load a developer-only .env file. Never called in a frozen build, so a
    packaged binary can never carry a plaintext secret with it.
    """
    if is_frozen() or not path.exists():
        return
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val
    except OSError:
        pass


@dataclass(frozen=True)
class Settings:
    """Immutable, fully resolved runtime configuration."""

    endpoint: str = ""
    master_encryption_key: str = ""
    license_pepper: str = ""
    ip_pepper: str = ""
    ed25519_private_jwk: str = ""
    admin_token: str = ""
    secrets: dict = field(default_factory=dict, repr=False)

    @property
    def has_admin_auth(self) -> bool:
        return bool(self.admin_token or self.master_encryption_key)

    @property
    def can_sign_offline(self) -> bool:
        """Only true when an operator deliberately supplied a signing key."""
        return bool(self.ed25519_private_jwk)

    def missing(self) -> list:
        """Required-for-full-functionality secrets that are absent."""
        return [name for name in SECRET_NAMES if name != "LICENSING_ENDPOINT"
                and not self.secrets.get(name)]


def resolve_settings() -> Settings:
    """
    Build the effective Settings from env and the OS vault.

    Vault lookups happen once and are cached on the instance.
    """
    for candidate in (
        resource_path(".env.licensing"),
        Path(__file__).resolve().parent.parent / ".env.licensing",
        Path(__file__).resolve().parent.parent / ".env",
    ):
        _load_env_file(candidate)

    def read(name: str, default: str = "") -> str:
        value = os.getenv(name, "")
        if value:
            return value
        return vault_get(name) or default

    endpoint = read(
        "LICENSING_ENDPOINT",
        "https://mobi-licensing.aminebarcelon28.workers.dev",
    ).rstrip("/")

    resolved = {
        "LICENSING_ENDPOINT": endpoint,
        "MASTER_ENCRYPTION_KEY": read("MASTER_ENCRYPTION_KEY"),
        "LICENSE_PEPPER": read("LICENSE_PEPPER"),
        "IP_PEPPER": read("IP_PEPPER"),
        "LICENSE_ED25519_PRIVATE_JWK": read("LICENSE_ED25519_PRIVATE_JWK"),
        "ADMIN_TOKEN": read("ADMIN_TOKEN"),
    }

    return Settings(
        endpoint=endpoint,
        master_encryption_key=resolved["MASTER_ENCRYPTION_KEY"],
        license_pepper=resolved["LICENSE_PEPPER"],
        ip_pepper=resolved["IP_PEPPER"],
        ed25519_private_jwk=resolved["LICENSE_ED25519_PRIVATE_JWK"],
        admin_token=resolved["ADMIN_TOKEN"],
        secrets=resolved,
    )


SETTINGS = resolve_settings()

# Backwards-compatible module-level accessors for existing call sites.
CLOUD_LICENSING_ENDPOINT = SETTINGS.endpoint
MASTER_ENCRYPTION_KEY = SETTINGS.master_encryption_key
LICENSE_PEPPER = SETTINGS.license_pepper
IP_PEPPER = SETTINGS.ip_pepper
LICENSE_ED25519_PRIVATE_JWK = SETTINGS.ed25519_private_jwk

LEDGER_PATH = data_dir() / "licenses_ledger.json"
AUDIT_LOG_PATH = data_dir() / "licenses_audit.json"


def missing_secrets() -> list:
    return SETTINGS.missing()

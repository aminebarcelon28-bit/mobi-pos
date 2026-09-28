"""
Configuration and Environment Loader for MobiPOS License Admin Desktop.
"""

import os
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).resolve().parent
ROOT_DIR = BASE_DIR.parent
LEDGER_PATH = ROOT_DIR / "licenses_ledger.json"
AUDIT_LOG_PATH = ROOT_DIR / "licenses_audit.json"

def load_env_file(file_path: Path):
    if not file_path.exists():
        return
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, val = line.split("=", 1)
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    if key and key not in os.environ:
                        os.environ[key] = val
    except Exception as e:
        print(f"Warning: Could not read env file {file_path}: {e}")

# Load environment configuration in precedence order
load_env_file(ROOT_DIR / ".env.licensing")
load_env_file(ROOT_DIR / ".env")

# Cloudflare & Licensing Endpoints
CLOUD_LICENSING_ENDPOINT = os.getenv(
    "LICENSING_ENDPOINT",
    "https://mobi-licensing.aminebarcelon28.workers.dev"
).rstrip("/")

# Master Cryptographic Secrets
MASTER_ENCRYPTION_KEY = os.getenv(
    "MASTER_ENCRYPTION_KEY",
    "zuYAeOahzvQXtv+Ib20DWmUQxiPxSkSMY8PgMzV9X28="
)

LICENSE_PEPPER = os.getenv(
    "LICENSE_PEPPER",
    "8151b8bd90b28fd747511025fa6d38625515e57aca46dcb75841383cd0f0bf58"
)

IP_PEPPER = os.getenv(
    "IP_PEPPER",
    "9395b7bbaa6fca32827f78c9aa131db515f5a2fa7ef74f7ead5b79734b0c6537"
)

LICENSE_ED25519_PRIVATE_JWK = os.getenv(
    "LICENSE_ED25519_PRIVATE_JWK",
    '{"key_ops":["sign"],"ext":true,"alg":"Ed25519","crv":"Ed25519","d":"91lezRRFPF_zr4edhnH2NktUaFBjBJoeCHvRpn5cZ4w","x":"Kw8ScZAHScD0IOm0Lx2bSYab-OPHkjdWFDbMR4j6Hdc","kty":"OKP"}'
)

APP_NAME = "MobiPOS License Administrator"
APP_VERSION = "2.0.0"

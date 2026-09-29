# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for "Licensing for MobiPOS".

Produces a single windowed executable (no console) that runs on double-click.

Security rules enforced here:
  * NO .env / .env.licensing / secret files are ever bundled. The master
    Ed25519 signing key, pepper, and encryption key must never ship inside the
    binary. They are resolved at runtime from the OS secure vault (DPAPI) or
    the process environment.
  * Signing operations are delegated to the remote licensing endpoint; the
    client only ever signs when an operator explicitly imports a key file.

Build:
    pyinstaller --noconfirm --clean --distpath licensing_dist \
        --workpath build/licensing licensing.spec
"""

import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

PROJECT_ROOT = Path(SPECPATH).resolve()
APP_NAME = "Licensing for MobiPOS"
DIST_DIR = PROJECT_ROOT / "licensing_dist"

# ---------------------------------------------------------------------------
# Data files: icons and translations ONLY.
#
# A denylist is not enough here -- an allowlist is the only way to guarantee a
# newly added .env file cannot silently become part of the shipped binary.
# Every candidate is additionally asserted to be a known-safe asset.
# ---------------------------------------------------------------------------
ALLOWED_DATA_SUFFIXES = {".ico", ".png", ".svg", ".json", ".qm", ".qrc"}
FORBIDDEN_DATA_PATTERNS = (".env", "secret", "pepper", "key", "jwk", "pem", "pfx", "p12")

datas = []
for candidate in ("assets", "resources", "translations", "licensing_app/assets"):
    root = PROJECT_ROOT / candidate
    if not root.is_dir():
        continue
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        name = path.name.lower()
        if name.startswith(".env") or any(
            token in name for token in FORBIDDEN_DATA_PATTERNS
        ):
            raise SystemExit(
                f"Refusing to bundle sensitive-looking asset: {path}"
            )
        if path.suffix.lower() in ALLOWED_DATA_SUFFIXES:
            datas.append((str(path), str(Path(candidate).name)))


def _assert_no_secrets(entries):
    """Final guard: fail the build if any secret marker reached the bundle."""
    forbidden = ("MASTER_ENCRYPTION_KEY", "LICENSE_PEPPER", "LICENSE_ED25519_PRIVATE_JWK")
    for src, _dest in entries:
        for marker in forbidden:
            if marker in Path(src).name:
                raise SystemExit(f"Secret file staged for bundling: {src}")


_assert_no_secrets(datas)

hiddenimports = (
    collect_submodules("cryptography")
    + collect_submodules("qrcode")
    + ["PIL.Image", "requests", "licensing_app", "keyring", "win32crypt"]
)

a = Analysis(
    [str(PROJECT_ROOT / "run_licensing.py")],
    pathex=[str(PROJECT_ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Trim the binary aggressively; none of these are used by the console.
        "tkinter",
        "PyQt6.QtWebEngineCore",
        "PyQt6.QtWebEngineWidgets",
        "PyQt6.QtQuick",
        "PyQt6.QtQuick3D",
        "PyQt6.QtQml",
        "PyQt6.QtMultimedia",
        "PyQt6.QtMultimediaWidgets",
        "PyQt6.Qt3DCore",
        "PyQt6.Qt3DRender",
        "PyQt6.QtBluetooth",
        "PyQt6.QtNetworkAuth",
        "PyQt6.QtDesigner",
        "PyQt6.QtHelp",
        "PyQt6.QtOpenGL",
        "PyQt6.QtOpenGLWidgets",
        "PyQt6.QtSql",
        "PyQt6.QtTest",
        "PyQt6.QtCharts",
        "PyQt6.QtDataVisualization",
        "PyQt6.QtPdf",
        "PyQt6.QtPdfWidgets",
        "PyQt6.QtPositioning",
        "PyQt6.QtSensors",
        "PyQt6.QtSerialPort",
        "PyQt6.QtWebChannel",
        "PyQt6.QtWebSockets",
        "matplotlib",
        "numpy",
        "pandas",
        "scipy",
        "pytest",
        "_pytest",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name=APP_NAME,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=["Qt6Core.dll", "Qt6Gui.dll", "Qt6Widgets.dll"],
    runtime_tmpdir=None,
    console=False,          # Subsystem 2: no console window on double-click
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
    version=None,
)

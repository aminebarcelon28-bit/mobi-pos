"""
Hardware fingerprinting.

The previous implementation shelled out to ``reg query`` with ``shell=True``
to read MachineGuid and BaseBoardProduct. That spawns ``cmd.exe`` and routes
the command through the Windows command parser, which is both slow (~200 ms
per call) and an injection surface.

This module reads the same values through the registry API via ``ctypes``, with
no process creation. The fallback path is used on non-Windows platforms and
never invokes a shell.
"""

from __future__ import annotations

import ctypes
import hashlib
import platform
import secrets
import sys
from ctypes import wintypes
from typing import Dict, Optional

# Must stay in lockstep with scripts/license-admin.mjs and src/licensing/hwid.ts.
HWID_SALT = "mobi-pos-license-salt-v1:"

# --- Windows registry constants (documented so they are not magic numbers) --
HKEY_LOCAL_MACHINE = wintypes.HKEY(0x80000002)
KEY_READ = wintypes.DWORD(0x20019)
ERROR_SUCCESS = 0

_CRYPTO_GUID_PATH = r"SOFTWARE\Microsoft\Cryptography"
_BASEBOARD_PATH = r"HARDWARE\DESCRIPTION\System\BIOS"

# Values are REG_SZ; 512 bytes is ample and avoids an unbounded read.
_VALUE_BUFFER_BYTES = 512

advapi32 = None
if sys.platform == "win32":
    try:
        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    except (AttributeError, OSError):  # pragma: no cover - non-Windows CI
        advapi32 = None


def _reg_get_value(subkey: str, value_name: str) -> Optional[str]:
    """
    Read a REG_SZ value from HKLM using the registry API directly.

    Returns None on any failure, including a missing value or a non-string
    type. No subprocess is created and no string is passed to a command parser.
    """
    if advapi32 is None:
        return None

    handle = wintypes.HKEY()
    if advapi32.RegOpenKeyExW(
        HKEY_LOCAL_MACHINE,
        ctypes.c_wchar_p(subkey),
        0,
        KEY_READ,
        ctypes.byref(handle),
    ) != ERROR_SUCCESS:
        return None

    try:
        data_type = wintypes.DWORD()
        buffer = ctypes.create_string_buffer(_VALUE_BUFFER_BYTES)
        size = wintypes.DWORD(_VALUE_BUFFER_BYTES)

        status = advapi32.RegQueryValueExW(
            handle,
            ctypes.c_wchar_p(value_name),
            None,
            ctypes.byref(data_type),
            ctypes.byref(buffer),
            ctypes.byref(size),
        )
        if status != ERROR_SUCCESS:
            return None
        if data_type.value != 1:  # REG_SZ
            return None

        # REG_SZ is UTF-16LE; the buffer may be shorter than allocated.
        raw = buffer.raw[: size.value]
        text = raw.decode("utf-16-le", errors="ignore")
        return text.split("\x00", 1)[0] or None
    finally:
        advapi32.RegCloseKey(handle)


def _fingerprint(guid: str, board: str, kind: str) -> Dict[str, str]:
    raw = f"{kind}:{guid}:{board}"
    digest = hashlib.sha256((HWID_SALT + raw).encode("utf-8")).hexdigest()
    upper = digest.upper()
    formatted = f"MOBI-{upper[0:4]}-{upper[4:8]}-{upper[8:12]}-{upper[12:16]}"
    return {"hash": digest, "formatted": formatted, "platform": kind}


def detect_local_hwid() -> Dict[str, str]:
    """
    Detect this machine's hardware identifier.

    Matches the algorithm used by the Node admin script and the Tauri client so
    all three agree on the same value for a given machine.
    """
    if sys.platform == "win32" and advapi32 is not None:
        guid = _reg_get_value(_CRYPTO_GUID_PATH, "MachineGuid")
        board = _reg_get_value(_BASEBOARD_PATH, "BaseBoardProduct")
        if guid:
            return _fingerprint(guid, board or "GENERIC_BOARD", "win")
        return _fingerprint("UNKNOWN_WINDOWS_GUID", board or "GENERIC_BOARD", "win")

    if sys.platform == "darwin":
        # Reading platform.node() avoids spawning `ioreg` / `system_profiler`.
        try:
            node = platform.node() or "UNKNOWN_NODE"
        except Exception:
            node = "UNKNOWN_NODE"
        return _fingerprint(node, "GENERIC_BOARD", "mac")

    try:
        node = platform.node() or "UNKNOWN_NODE"
    except Exception:
        node = "UNKNOWN_NODE"
    return _fingerprint(node, "GENERIC_BOARD", "posix")


def secure_zero(buffer) -> None:
    """
    Best-effort overwrite of a mutable buffer holding key material.

    CPython cannot guarantee erasure of immutable ``bytes``, so callers pass a
    ``bytearray``. This is defence in depth, not a guarantee against a
    process-memory dump.
    """
    if isinstance(buffer, bytearray):
        for index in range(len(buffer)):
            buffer[index] = 0
    elif isinstance(buffer, bytearray.__class__):
        pass


def describe_machine() -> Dict[str, str]:
    """Diagnostics block for the telemetry card."""
    hwid = detect_local_hwid()
    return {
        "hwid": hwid.get("formatted", ""),
        "platform": hwid.get("platform", ""),
        "os": f"{platform.system()} {platform.release()}",
        "python": platform.python_version(),
    }

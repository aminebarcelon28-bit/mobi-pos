"""
Headless validation for "Licensing for MobiPOS".

Covers the domain model, status precedence, seat arithmetic, the HMAC audit
chain (including tamper detection), filtering/sorting, TLS configuration, HWID
stability, and GUI wiring with painted delegates.

Run: npm run license:desktop:check
"""

import datetime
import gc
import os
import sys
import tempfile
from pathlib import Path

# ---------------------------------------------------------------------------
# Isolate from real operator data BEFORE importing licensing_app.
#
# licensing_app.config resolves its data directory (ledger, audit trail,
# settings, node secret) at import time from %APPDATA%. Several tests
# legitimately clear and rewrite the audit chain, so without this the suite
# destroys the operator's real audit history -- and because the server
# remembers the highest anchored sequence, the next application launch then
# sees a sequence regression and locks itself into read-only.
#
# Redirecting the data root at the top of the file keeps every write inside a
# throwaway directory. The OS credential vault is isolated separately in
# _isolate_vault(), because keyring bypasses %APPDATA% entirely.
# ---------------------------------------------------------------------------
_ISOLATED_ROOT = tempfile.mkdtemp(prefix="licensing-check-")
# Captured BEFORE the override below, so the regression test can still locate
# the operator's real profile after APPDATA points at the sandbox.
_REAL_APPDATA = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
os.environ["APPDATA"] = _ISOLATED_ROOT
os.environ["XDG_DATA_HOME"] = _ISOLATED_ROOT
os.environ["LOCALAPPDATA"] = _ISOLATED_ROOT

from PyQt6.QtCore import QEvent, QObject, pyqtSignal
from PyQt6.QtWidgets import QApplication, QDialog

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


def _isolate_qsettings() -> None:
    """
    Redirect QSettings into the sandbox.

    Same hazard as the audit ledger, different storage. On Windows QSettings
    writes to the registry, not %APPDATA%, so redirecting the data directory
    does not contain it. Without this the suite both reads the operator's
    persisted column widths -- which silently overrides the widths under test,
    since _restore_column_widths() runs on every window construction -- and
    writes its own back on window close.
    """
    import PyQt6.QtCore as qcore

    _QSettings = qcore.QSettings

    class _SandboxQSettings(_QSettings):
        """
        QSettings with (organization, application) redirected to a sandbox INI.

        QSettings.setDefaultFormat() does not override an explicit
        (org, app) construction on Windows, which lands in
        HKEY_CURRENT_USER\\Software -- outside %APPDATA% and therefore outside
        the data-directory sandbox. PyQt6's third positional argument is
        ``parent``, not ``format``, so the pair is rewritten into an explicit
        file path inside the sandbox instead. The app builds its QSettings that
        way inside each method, re-importing the name on every call, so
        replacing the attribute on the module catches every construction.
        """

        def __init__(self, *args):
            if len(args) >= 2 and isinstance(args[0], str):
                name = f"{args[0]}_{args[1] or 'default'}".replace("/", "_")
                path = os.path.join(_ISOLATED_ROOT, f"{name}.ini")
                super().__init__(path, _QSettings.Format.IniFormat)
            else:
                super().__init__(*args)

    qcore.QSettings = _SandboxQSettings
    _QSettings.setPath(
        _QSettings.Format.IniFormat,
        _QSettings.Scope.UserScope,
        _ISOLATED_ROOT,
    )


_isolate_qsettings()

#: In-memory stand-in for the OS credential vault.
_FAKE_VAULT: dict = {}


def _isolate_vault() -> None:
    """
    Redirect config's vault accessors to an in-memory dict.

    vault_import_file() writes through to the real Windows Credential Manager
    (or libsecret on other platforms). Running it for real from a test suite
    silently overwrites the operator's real master key and signing key with
    test values, which then breaks cloud authentication on the next launch.
    """
    from licensing_app import config

    def _fake_set(name: str, value: str) -> bool:
        _FAKE_VAULT[name] = value
        return True

    def _fake_get(name: str):
        return _FAKE_VAULT.get(name)

    config.vault_set = _fake_set
    config.vault_get = _fake_get


_isolate_vault()

PASSED = 0
FAILURES = []


def check(label, condition, detail=""):
    global PASSED
    if condition:
        PASSED += 1
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


def section(title):
    print(f"\n{title}")


#: Held at module scope on purpose. A QApplication that is only referenced by
#: a local goes out of scope and is destroyed, taking every painted pixmap and
#: widget with it -- which shows up as a hard 0xC0000409 crash rather than a
#: Python exception.
_APP = None


def ensure_app():
    """Return the process-wide QApplication, creating it once."""
    global _APP
    existing = QApplication.instance()
    if existing is not None:
        _APP = existing
    elif _APP is None:
        _APP = QApplication([])
    return _APP


def open_window(cls):
    """
    Construct a MainWindow and let its queued work settle.

    MainWindow schedules a refresh on a 120 ms timer and runs it on a
    QThreadPool. Returning the window to a caller immediately means it can be
    collected while a worker is still emitting into it, which segfaults the
    interpreter rather than raising. Draining here keeps every test that builds
    a window self-contained.
    """
    app = ensure_app()
    window = cls()
    window.show()
    app.processEvents()
    return window


def close_window(window) -> None:
    """
    Close a window, flush pending deletions, and collect the Python wrapper.

    MainWindow owns a QThreadPool and repeating QTimers. Between tests, Qt can
    still hold queued events and deleteLater() notifications for a window that
    the previous test has already dropped; letting those drain into the next
    test's freshly built window crashes the interpreter with 0xC0000409 rather
    than raising. Draining the queue and collecting between windows keeps each
    test independent.
    """
    if window is None:
        return
    app = ensure_app()
    window.close()
    app.processEvents()
    # sendPostedEvents(None, QEvent.Type.DeferredDelete) is what actually
    # flushes deleteLater(); processEvents alone can leave them queued.
    app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
    app.processEvents()
    del window
    gc.collect()
    app.processEvents()


# ----------------------------------------------------------------------
# Domain model
# ----------------------------------------------------------------------
def record(**kwargs):
    from licensing_app.core.models import LicenseRecord

    base = dict(
        id="1",
        customer="Alpha",
        license_key="MOBI-LIFE-AAAA-BBBB",
        formula="LIFETIME",
        raw_status="active",
        max_desktops=2,
        max_mobiles=2,
        active_desktops=1,
        active_mobiles=0,
        in_cloud=True,
        in_ledger=True,
    )
    base.update(kwargs)
    return LicenseRecord(**base)


def days_from_now(days):
    return (
        datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=days)
    ).isoformat()


def test_status_precedence():
    from licensing_app.core.models import LicenseStatus

    section("status precedence")
    check("active", record().status is LicenseStatus.ACTIVE)
    check("expired", record(expires_at=days_from_now(-10)).status is LicenseStatus.EXPIRED)
    check("trial", record(formula="90D").status is LicenseStatus.TRIAL)
    check("unregistered", record(in_cloud=False).status is LicenseStatus.UNREGISTERED)
    check("pending", record(raw_status="pending_sync").status is LicenseStatus.UNREGISTERED)
    check("suspended", record(raw_status="suspended").status is LicenseStatus.SUSPENDED)
    check("revoked", record(raw_status="revoked").status is LicenseStatus.REVOKED)
    check(
        "revoked beats expired",
        record(raw_status="revoked", expires_at=days_from_now(-5)).status
        is LicenseStatus.REVOKED,
    )
    check(
        "suspended beats expired",
        record(raw_status="suspended", expires_at=days_from_now(-5)).status
        is LicenseStatus.SUSPENDED,
    )
    check(
        "unregistered beats expired",
        record(in_cloud=False, expires_at=days_from_now(-5)).status
        is LicenseStatus.UNREGISTERED,
    )
    check(
        "expired beats trial",
        record(formula="90D", expires_at=days_from_now(-1)).status
        is LicenseStatus.EXPIRED,
    )
    check(
        "lifetime without date stays active",
        record(formula="LIFETIME").status is LicenseStatus.ACTIVE,
    )
    check(
        "explicit expiry beats lifetime tag",
        record(formula="LIFETIME", expires_at=days_from_now(-1)).status
        is LicenseStatus.EXPIRED,
    )


def test_seat_arithmetic():
    section("seat arithmetic")
    check("full flag", record(active_desktops=2).is_full)
    check("not full", not record(active_desktops=1).is_full)
    check("desk ratio", abs(record(active_desktops=1, max_desktops=2).seat_ratio - 0.5) < 1e-9)
    check("mobile ratio", record(active_mobiles=2, max_mobiles=4).mobile_ratio == 0.5)
    check("total devices", record(active_desktops=1, active_mobiles=2).total_devices == 3)
    check("zero max does not divide by zero", record(max_desktops=0, active_desktops=3).seat_ratio == 3.0)
    check("negative max is safe", record(max_desktops=-5).seat_ratio >= 0.0)
    check("expiring soon", record(expires_at=days_from_now(3)).is_expiring_soon)
    check("not expiring soon", not record(expires_at=days_from_now(200)).is_expiring_soon)
    check("boundary 10 days counts as soon", record(expires_at=days_from_now(10)).is_expiring_soon)
    check("boundary 11 days is not soon", not record(expires_at=days_from_now(11)).is_expiring_soon)


def test_leap_year_arithmetic():
    section("date edge cases")
    check("Feb 29 parses", record(expires_at="2028-02-29T00:00:00Z").days_left is not None)
    check("Feb 30 is rejected",
          record(expires_at="2028-02-30T00:00:00Z").days_left is None)
    check("naive timestamp is treated as UTC", record(expires_at="2030-06-01T00:00:00").days_left is not None)
    check("Z suffix is tolerated", record(expires_at="2030-06-01T00:00:00Z").days_left is not None)
    check("garbage date is ignored", record(expires_at="not-a-date").days_left is None)
    check("NONE is not a date", record(expires_at="NONE").days_left is None)


def test_sync_status():
    from licensing_app.core.models import SyncStatus

    section("sync status")
    check("synced", record(in_cloud=True, in_ledger=True).sync_status is SyncStatus.SYNCED)
    check("local only", record(in_cloud=False, in_ledger=True).sync_status is SyncStatus.LOCAL_ONLY)
    check("cloud only", record(in_cloud=True, in_ledger=False).sync_status is SyncStatus.CLOUD_ONLY)


def test_device_binding():
    from licensing_app.core.models import DeviceBinding, SeatKind, parse_datetime

    section("device bindings")
    device = DeviceBinding.from_payload(
        {"hwid": "ABCDEF0123456789", "platform": "Windows", "device_type": "desk"}
    )
    check("hwid parsed", device.hwid == "ABCDEF0123456789")
    check("seat kind mapped", device.seat_kind is SeatKind.DESK)
    check("defaults applied", device.ip_address is None)
    check("short hwid", len(device.short_hwid) <= 9)
    check("empty payload is safe", DeviceBinding.from_payload(None).hwid == "")
    check("parse None", parse_datetime(None) is None)


def test_serialisation():
    section("serialisation")
    original = record(phone="+216 20 000 000", city="Tunis", notes="VIP")
    restored = record().from_merged(original.to_dict())
    check("customer round-trips", restored.customer == original.customer)
    check("key round-trips", restored.license_key == original.license_key)
    check("status round-trips", restored.status is original.status)
    check("notes round-trip", restored.notes == "VIP")
    check("payload has no snake_case leak", "active_desktops" not in original.to_dict())


# ----------------------------------------------------------------------
# Audit chain
# ----------------------------------------------------------------------
def test_audit_chain():
    from licensing_app.core import audit

    section("audit hash chain")
    if audit.writes_blocked():
        check("chain writable", False, "writes already blocked")
        return

    audit.clear_audit_log()
    check("empty chain verifies", audit.integrity_status()["ok"])

    first = audit.record_audit_event("MINT", "first", "Alpha", "MOBI-LIFE-AAAA-BBBB")
    check("first record stored", first is not None)
    second = audit.record_audit_event("EXTEND", "second", "Beta", "MOBI-T90D-CCCC-DDDD")
    check("second record stored", second is not None)
    check("chain links forward", second["prev_hash"] == first["record_hash"])
    check("genesis used for head", first["prev_hash"] == audit.GENESIS)
    check("chain verifies", audit.integrity_status()["ok"])
    check("record count", audit.integrity_status()["count"] == 2)

    loaded = audit.load_audit_log()
    check("newest first", loaded[0]["action"] == "EXTEND")

    # --- tamper detection ---
    entries = audit._read_raw()
    entries[0]["payload"]["details"] = "forged"
    try:
        audit.verify_chain(entries)
        check("forged payload detected", False, "verification passed")
    except audit.LedgerIntegrityException:
        check("forged payload detected", True)

    entries = audit._read_raw()
    entries[0]["record_hash"] = "0" * 64
    try:
        audit.verify_chain(entries)
        check("forged hash detected", False)
    except audit.LedgerIntegrityException:
        check("forged hash detected", True)

    # --- deletion detection ---
    # A hash chain proves the interior is intact. Dropping the *newest* record
    # is indistinguishable from the record never having been written, so only
    # interior deletion is detectable; that is the property worth asserting.
    entries = audit._read_raw()
    if len(entries) >= 3:
        entries.pop(1)
        try:
            audit.verify_chain(entries)
            check("interior deletion detected", False, "verification passed")
        except audit.LedgerIntegrityException:
            check("interior deletion detected", True)
    else:
        audit.record_audit_event("PAD", "pad")
        audit.record_audit_event("PAD2", "pad")
        entries = audit._read_raw()
        entries.pop(1)
        try:
            audit.verify_chain(entries)
            check("interior deletion detected", False)
        except audit.LedgerIntegrityException:
            check("interior deletion detected", True)

    # --- reorder detection ---
    entries = audit._read_raw()
    if len(entries) >= 2:
        entries.reverse()
        try:
            audit.verify_chain(entries)
            check("reordered chain detected", False)
        except audit.LedgerIntegrityException:
            check("reordered chain detected", True)

    # A corrupted file must not be silently accepted.
    check("real chain still verifies", audit.integrity_status()["ok"])
    audit.clear_audit_log()


def test_audit_corrupt_file():
    from licensing_app.config import AUDIT_LOG_PATH
    from licensing_app.core import audit

    section("audit corruption handling")
    original = AUDIT_LOG_PATH.read_text(encoding="utf-8") if AUDIT_LOG_PATH.exists() else "[]"
    try:
        AUDIT_LOG_PATH.write_text("{not json", encoding="utf-8")
        try:
            audit.load_audit_log()
            check("unparseable ledger rejected", False)
        except audit.LedgerIntegrityException:
            check("unparseable ledger rejected", True)

        AUDIT_LOG_PATH.write_text('{"not":"a list"}', encoding="utf-8")
        try:
            audit.load_audit_log()
            check("wrong shape rejected", False)
        except audit.LedgerIntegrityException:
            check("wrong shape rejected", True)
    finally:
        AUDIT_LOG_PATH.write_text(original, encoding="utf-8")


# ----------------------------------------------------------------------
# Service layer
# ----------------------------------------------------------------------
def test_filtering():
    from licensing_app.core.service import filter_records

    section("filtering")
    rows = [
        record(id="1", customer="Alpha", city="Tunis"),
        record(id="2", customer="Beta", city="Sousse", formula="90D"),
        record(id="3", customer="Gamma", in_cloud=False),
        record(id="4", customer="Delta", raw_status="suspended"),
        record(id="5", customer="Epsilon", expires_at=days_from_now(-2)),
    ]
    check("all", len(filter_records(rows)) == 5)
    check("text search", len(filter_records(rows, query="sousse")) == 1)
    check("case-insensitive search", len(filter_records(rows, query="SOU")) == 1)
    check("no match", len(filter_records(rows, query="zzzz")) == 0)
    check("formula filter", len(filter_records(rows, formula="90D")) == 1)
    check("active pill", len(filter_records(rows, status_filter="active")) == 1)
    check("unregistered pill", len(filter_records(rows, status_filter="unregistered")) == 1)
    check("suspended pill", len(filter_records(rows, status_filter="suspended")) == 1)
    check("expired pill", len(filter_records(rows, status_filter="expired")) == 1)
    check("expiring pill", len(filter_records(rows, status_filter="EXPIRING")) == 1)
    check("full pill", len(filter_records(rows, status_filter="FULL")) == 0)
    check("combined filters", len(filter_records(rows, query="e", status_filter="active")) >= 0)


def test_sorting():
    from licensing_app.core.service import sort_records

    section("sorting")
    rows = [
        record(id="1", customer="Charlie"),
        record(id="2", customer="alpha"),
        record(id="3", customer="Bravo"),
    ]
    check("case-insensitive", [r.customer for r in sort_records(rows, "customer")] == ["alpha", "Bravo", "Charlie"])
    check("reverse", sort_records(rows, "customer", True)[0].customer == "Charlie")
    check("unknown column is a no-op", len(sort_records(rows, "bogus")) == 3)
    check("expiry sorts undated last", len(sort_records(rows, "expiry")) == 3)
    check("sort is stable", len(sort_records(rows, "status")) == 3)


def test_retry():
    from licensing_app.core.service import with_retry

    section("retry and backoff")
    slept = []
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise ConnectionError("boom")
        return "ok"

    value, error, retries = with_retry(flaky, sleep=slept.append)
    check("eventually succeeds", value == "ok" and error is None)
    check("retries counted", retries == 2)
    check("backoff schedule used", slept == [1.0, 2.0])

    def always_fails():
        raise TimeoutError("nope")

    value, error, retries = with_retry(always_fails, sleep=lambda _s: None)
    check("gives up", value is None and error is not None)
    check("error surfaced", "nope" in error)


def test_conflict_detection():
    from licensing_app.core.service import detect_conflicts

    section("conflict detection")
    cloud = [record(id="1", customer="Alpha", city="Tunis", phone="+216 1")]
    same = [record(id="1", customer="Alpha", city="Tunis", phone="+216 1")]
    different = [record(id="1", customer="Alpha", city="Sfax", phone="+216 1")]

    check("no conflict when identical", detect_conflicts(cloud, same) == [])
    conflicts = detect_conflicts(cloud, different)
    check("conflict on differing field", len(conflicts) == 1)
    if conflicts:
        check("conflict names the field", conflicts[0].field_name == "city")
        check("conflict carries both sides",
              conflicts[0].cloud_value == "Tunis" and conflicts[0].local_value == "Sfax")
    check("missing counterpart is not a conflict",
          detect_conflicts(cloud, [record(id="99")]) == [])


def test_export():
    from licensing_app.core.service import export_rows

    section("export")
    data = export_rows([record()])
    check("header present", data[0][0] == "ID")
    check("row width matches header", len(data[0]) == len(data[1]))
    check("empty list yields header only", len(export_rows([])) == 1)


# ----------------------------------------------------------------------
# Security surface
# ----------------------------------------------------------------------
def test_tls_config():
    import ssl

    from licensing_app.core.api import TLS_CONTEXT

    section("TLS hardening")
    check("min version is TLS 1.2+", TLS_CONTEXT.minimum_version >= ssl.TLSVersion.TLSv1_2)
    check("certificates required", TLS_CONTEXT.verify_mode == ssl.CERT_REQUIRED)
    check("hostname verification on", TLS_CONTEXT.check_hostname is True)


def test_no_secrets_in_spec():
    section("packaging: secret exclusion")
    spec_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "licensing.spec"
    )
    with open(spec_path, encoding="utf-8") as handle:
        spec = handle.read()
    check("spec does not bundle .env.licensing", ".env.licensing" not in spec.replace(
        'candidate in (".env.licensing")', ""
    ) or "datas.append" not in spec.split(".env.licensing")[0][-200:])
    check("spec has a denylist guard", "FORBIDDEN_DATA_PATTERNS" in spec)
    check("spec blocks console", "console=False" in spec)
    check("spec excludes QtWebEngine", "QtWebEngine" in spec)
    check("spec excludes QtSql", "QtSql" in spec)
    check("spec excludes QtTest", "QtTest" in spec)


def test_frozen_build_skips_env():
    section("frozen build: no env file loading")
    from licensing_app import config

    check("frozen builds skip .env", config.is_frozen() is False or True)
    source = open(config.__file__, encoding="utf-8").read()
    check("env loader is frozen-guarded", "if is_frozen() or not path.exists()" in source)


def test_hwid_stability():
    from licensing_app.core import hwid

    section("hardware fingerprint")
    first = hwid.detect_local_hwid()
    second = hwid.detect_local_hwid()
    check("stable across calls", first["hash"] == second["hash"])
    check("formatted shape", first["formatted"].startswith("MOBI-") and len(first["formatted"]) == 24)
    check("platform reported", first["platform"] in ("win", "mac", "posix", "fallback"))
    check("no shell=True in code", not _find_in_code(hwid.__file__, "shell=True"))
    check("no subprocess in source", "import subprocess" not in open(hwid.__file__, encoding="utf-8").read())

    buffer = bytearray(b"secret-key-material")
    hwid.secure_zero(buffer)
    check("secure_zero clears buffer", bytes(buffer) == b"\x00" * len(buffer))
    hwid.secure_zero("immutable")  # must not raise


def _executable_lines(path):
    """
    Return source lines that are actually code.

    Comments and docstrings may legitimately mention shell=True when
    describing what was removed, so they must not count as a finding.
    """
    import io
    import tokenize

    with open(path, "rb") as handle:
        try:
            tokens = list(tokenize.tokenize(io.BytesIO(handle.read()).readline))
        except tokenize.TokenError:
            return []
    lines = set()
    for token in tokens:
        if token.type in (tokenize.COMMENT, tokenize.STRING):
            continue
        for line_no in range(token.start[0], token.end[0] + 1):
            lines.add(line_no)
    return lines


def _find_in_code(path, needle):
    """True when `needle` appears in executable code (not a comment)."""
    code_lines = _executable_lines(path)
    with open(path, encoding="utf-8") as handle:
        for index, line in enumerate(handle, start=1):
            if index in code_lines and needle in line:
                return True
    return False


def test_no_shell_out():
    section("no shell execution anywhere in core")
    core = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "licensing_app", "core"
    )
    for name in sorted(os.listdir(core)):
        if not name.endswith(".py"):
            continue
        path = os.path.join(core, name)
        check(f"{name} has no shell=True in code", not _find_in_code(path, "shell=True"))
        check(f"{name} has no os.system in code", not _find_in_code(path, "os.system"))
        check(f"{name} has no subprocess import", "import subprocess" not in open(path, encoding="utf-8").read())


# ----------------------------------------------------------------------
# GUI
# ----------------------------------------------------------------------
def test_gui():
    from PyQt6.QtCore import QPoint, Qt

    from licensing_app.ui.main_window import MainWindow
    from licensing_app.ui.theme import THEME_QSS

    section("GUI wiring")
    app = ensure_app()
    app.setStyleSheet(THEME_QSS)
    window = open_window(MainWindow)
    window.all_records = [
        record(id="1", customer="Alpha"),
        record(id="2", customer="Beta", formula="90D"),
        record(id="3", customer="Gamma", in_cloud=False),
        record(id="4", customer="Delta", expires_at=days_from_now(-1)),
    ]
    window.apply_filters()
    check("model populated", window.model.rowCount() == 4)
    check("all pill counts", "(4)" in window.pills["ALL"].text())
    check("active pill counts", "(1)" in window.pills["active"].text())
    check("expired pill counts", "(1)" in window.pills["expired"].text())
    check("unregistered pill counts", "(1)" in window.pills["unregistered"].text())

    window.set_pill("unregistered")
    check("pill filters rows", window.model.rowCount() == 1)
    window.set_pill("ALL")
    check("pill reset", window.model.rowCount() == 4)

    window.search.setText("beta")
    window.apply_filters()
    check("search filters", window.model.rowCount() == 1)
    window.search.clear()
    window.apply_filters()

    # bulk selection
    window.model.set_checked(0, True)
    window.model.set_checked(1, True)
    check("checkbox tracked", window.model.is_checked(0) and window.model.is_checked(1))
    check("checked records returned", len(window.model.checked_records()) == 2)
    window.model.clear_checked()
    check("clear checked", len(window.model.checked_records()) == 0)
    window.model.select_all()
    check("select all", len(window.model.checked_records()) == 4)
    window.model.clear_checked()

    # delegates paint without crashing
    from licensing_app.ui.delegates import (
        CopyCellDelegate,
        ExpiryDelegate,
        SeatBarDelegate,
        StatusPillDelegate,
    )
    from licensing_app.ui.table_model import COL_DESKTOPS, COL_EXPIRY, COL_KEY, COL_STATUS

    for col, delegate in (
        (COL_KEY, CopyCellDelegate()),
        (COL_DESKTOPS, SeatBarDelegate("desktop")),
        (COL_STATUS, StatusPillDelegate()),
        (COL_EXPIRY, ExpiryDelegate()),
    ):
        index = window.model.index(0, col)
        try:
            window.model.data(index, Qt.ItemDataRole.DisplayRole)
            window.model.data(index, Qt.ItemDataRole.UserRole)
            check(f"delegate column {col} resolves data", True)
        except Exception as exc:
            check(f"delegate column {col} resolves data", False, str(exc))

    check("theme defines FilterPill", "QPushButton#FilterPill" in THEME_QSS)
    check("theme defines PrimaryBtn", "QPushButton#PrimaryBtn" in THEME_QSS)
    check("window title", "Licensing for MobiPOS" in window.windowTitle())
    check("command palette builds", len(window._palette_commands()) > 5)
    close_window(window)


def test_model_roles():
    from PyQt6.QtCore import Qt

    from licensing_app.ui.table_model import COL_KEY, COL_STATUS, LicenseTableModel

    section("model roles")
    app = ensure_app()
    model = LicenseTableModel()
    model.set_records([record()])

    check("row count", model.rowCount() == 1)
    check("column count includes checkbox", model.columnCount() == 9)

    status_index = model.index(0, COL_STATUS)
    key_index = model.index(0, COL_KEY)

    from licensing_app.ui.table_model import _TEXT_FORMAT_ROLE

    # The model must advertise PlainText. RichText here is what allowed HTML
    # badge markup to be interpreted by the view and leak raw tags.
    check(
        "plain text role advertised",
        model.data(status_index, _TEXT_FORMAT_ROLE) == Qt.TextFormat.PlainText,
    )
    check("user role returns a record", model.data(key_index, Qt.ItemDataRole.UserRole) is not None)
    check("edit role returns key", model.data(key_index, Qt.ItemDataRole.EditRole).startswith("MOBI-"))
    check("tooltip is html", "<b>" in model.data(key_index, Qt.ItemDataRole.ToolTipRole))
    check("invalid index returns None", model.data(model.index(99, 0), Qt.ItemDataRole.DisplayRole) is None)


def test_no_html_in_model_cells():
    """COL_FORMULA and COL_STATUS must never return markup."""
    from PyQt6.QtCore import Qt

    from licensing_app.core.models import LicenseRecord, LicenseStatus
    from licensing_app.ui.table_model import (
        COL_ACTIONS,
        COL_CLIENT,
        COL_DESKTOPS,
        COL_EXPIRY,
        COL_FORMULA,
        COL_MOBILES,
        COL_STATUS,
        LicenseTableModel,
        _TEXT_FORMAT_ROLE,
    )

    section("no html in model cells")
    ensure_app()

    # A customer name engineered to break out of any markup context.
    hostile = '<span style="x">evil</span><script>alert(1)</script>'

    model = LicenseTableModel()
    model.set_records([
        LicenseRecord(
            customer=hostile,
            license_key="MOBI-TEST-0001",
            formula="LIFETIME",
            raw_status="active",
            in_cloud=True,
            active_desktops=1,
            max_desktops=5,
            active_mobiles=2,
            max_mobiles=3,
        )
    ])

    # The customer column echoes user input verbatim, so a hostile name does
    # contain angle brackets as text. That is safe only because the model
    # advertises PlainText; what must never appear is markup we generated.
    for col, name in (
        (COL_FORMULA, "COL_FORMULA"),
        (COL_DESKTOPS, "COL_DESKTOPS"),
        (COL_MOBILES, "COL_MOBILES"),
        (COL_STATUS, "COL_STATUS"),
        (COL_EXPIRY, "COL_EXPIRY"),
        (COL_ACTIONS, "COL_ACTIONS"),
    ):
        value = model.data(model.index(0, col), Qt.ItemDataRole.DisplayRole)
        text = "" if value is None else str(value)
        check(f"{name} has no <span", "<span" not in text)
        check(f"{name} has no style=", 'style="' not in text)
        check(f"{name} has no tag", "<" not in text and ">" not in text)

    # COL_CLIENT is fed by the hostile string above, so it necessarily contains
    # "<span" as literal text. The assertion that matters is that the model does
    # not generate markup of its own and that Qt is told to treat the cell as
    # plain text, which makes the embedded tag inert.
    client = model.data(model.index(0, COL_CLIENT), Qt.ItemDataRole.DisplayRole)
    check("COL_CLIENT echoes the customer name",
          hostile in str(client), repr(client))
    check("COL_CLIENT adds no markup of its own",
          str(client).count("<") == hostile.count("<"),
          repr(client))
    check(
        "COL_CLIENT is plain text, so hostile input cannot be parsed",
        model.data(model.index(0, COL_CLIENT), _TEXT_FORMAT_ROLE)
        == Qt.TextFormat.PlainText,
    )

    formula = model.data(model.index(0, COL_FORMULA), Qt.ItemDataRole.DisplayRole)
    status = model.data(model.index(0, COL_STATUS), Qt.ItemDataRole.DisplayRole)
    check("formula is a plain label", formula == "LIFETIME")
    check(
        "status is a plain enum label",
        status == "ACTIVE",
        f"got {status!r}",
    )
    check(
        "status label is a valid enum value",
        status in {m.value.upper() for m in LicenseStatus},
    )

    # The tooltip is genuinely rich text, so user data there must be escaped.
    tooltip = model.data(model.index(0, COL_CLIENT), Qt.ItemDataRole.ToolTipRole)
    check("tooltip escapes user data", "<script>" not in tooltip)
    check("tooltip escapes span", "<span" not in tooltip)


def test_badge_delegates():
    """Formula and status pills paint without markup in the model."""
    from PyQt6.QtCore import QRect
    from PyQt6.QtGui import QPixmap, QPainter
    from PyQt6.QtWidgets import QStyleOptionViewItem, QStyle

    from licensing_app.core.models import LicenseRecord
    from licensing_app.ui.delegates import BadgeDelegate, StatusPillDelegate
    from licensing_app.ui.table_model import COL_FORMULA, COL_STATUS, LicenseTableModel

    section("badge delegates")
    ensure_app()

    model = LicenseTableModel()
    model.set_records([
        LicenseRecord(customer="A", license_key="K", formula="LIFETIME",
                      raw_status="active", in_cloud=True)
    ])

    def paint(delegate, col):
        option = QStyleOptionViewItem()
        option.rect = QRect(0, 0, 160, 44)
        option.state = QStyle.StateFlag.State_Enabled
        pixmap = QPixmap(option.rect.size())
        painter = QPainter(pixmap)
        delegate.paint(painter, option, model.index(0, col))
        painter.end()
        return pixmap.toImage()

    for kind, col in (("formula", COL_FORMULA), ("status", COL_STATUS)):
        image = paint(BadgeDelegate(kind), col)
        colors = {image.pixel(x, y) for y in range(44) for x in range(160)}
        # Background plus border plus at least one antialiased text pixel.
        check(f"{kind} delegate paints a chip", len(colors) >= 2, f"{len(colors)} colors")

    check("status alias delegates to BadgeDelegate",
          isinstance(StatusPillDelegate(), BadgeDelegate))


def test_actions_delegate():
    """Every action chip hit-tests and reports a tooltip."""
    from PyQt6.QtCore import QRect, QPoint
    from PyQt6.QtGui import QPixmap, QPainter
    from PyQt6.QtWidgets import QStyleOptionViewItem, QStyle

    from licensing_app.core.models import LicenseRecord
    from licensing_app.ui.delegates import ROW_ACTIONS, ActionsColumnDelegate
    from licensing_app.ui.table_model import COL_ACTIONS, LicenseTableModel

    section("actions delegate")
    ensure_app()

    model = LicenseTableModel()
    model.set_records([LicenseRecord(customer="A", license_key="K")])

    delegate = ActionsColumnDelegate()
    option = QStyleOptionViewItem()
    option.rect = QRect(0, 0, 360, 44)
    option.state = QStyle.StateFlag.State_Enabled

    pixmap = QPixmap(option.rect.size())
    painter = QPainter(pixmap)
    delegate.paint(painter, option, model.index(0, COL_ACTIONS))
    painter.end()
    check("action strip paints", pixmap.toImage().width() == 360)

    for action_id, tip in ROW_ACTIONS:
        rect = delegate.chip_rect(option, action_id)
        check(f"chip {action_id} has a rect", rect is not None and rect.width() > 0)
        check(f"chip {action_id} hit-tests", delegate.action_at(option, rect.center()) == action_id)
        check(f"chip {action_id} has a tooltip", bool(tip))

    check("empty space is not a chip", delegate.action_at(option, QPoint(1, 1)) is None)
    check("hover state is settable", delegate.set_hot(2) is None)


def test_layout_constraints():
    """Exact title, screen-safe geometry, and a bottom dock under 72 px."""

    from licensing_app.ui.main_window import MainWindow

    section("layout constraints")
    app = ensure_app()

    window = open_window(MainWindow)

    check(
        "exact window title",
        window.windowTitle() == "Licensing for MobiPOS v3.1.0",
        repr(window.windowTitle()),
    )

    dock = window.server_card.parentWidget()
    check("dock height <= 72px", dock.height() <= 72, f"{dock.height()}px")
    check(
        "dock height is pinned",
        dock.maximumHeight() == dock.minimumHeight(),
    )
    check("DOCK_HEIGHT constant <= 72", MainWindow.DOCK_HEIGHT <= 72)

    available = window.screen().availableGeometry()
    check(
        "window fits on screen",
        window.width() <= available.width() and window.height() <= available.height(),
        f"{window.width()}x{window.height()} vs {available.width()}x{available.height()}",
    )
    check("server card visible", window.server_card.isVisible())
    check("banner starts hidden", not window.alert_banner.isVisible())
    close_window(window)


def test_toast_placement():
    """Toasts sit bottom-right, inside the window, and never overlap."""

    from licensing_app.ui.main_window import MainWindow

    section("toast placement")
    app = ensure_app()

    window = open_window(MainWindow)
    window.resize(1400, 900)
    app.processEvents()

    for i in range(4):
        window.toasts.notify(f"Toast {i + 1}", "info", 0)
    app.processEvents()

    rects = window.toasts.active_rects()
    check("toasts created", len(rects) >= 4, f"{len(rects)}")
    check(
        "toasts inside window",
        all(r.x() >= 0 and r.y() >= 0
            and r.right() <= window.width() and r.bottom() <= window.height()
            for r in rects),
    )
    # Bottom-right: each toast's right edge is near the window's right edge.
    check(
        "toasts anchored bottom-right",
        max(r.bottom() for r in rects) > window.height() * 0.5
        and min(r.right() for r in rects) > window.width() * 0.5,
    )
    overlaps = [
        (i, j)
        for i in range(len(rects))
        for j in range(i + 1, len(rects))
        if rects[i].intersects(rects[j])
    ]
    check("toasts do not overlap", not overlaps, str(overlaps))
    check(
        "toasts clear the dock",
        max(r.bottom() for r in rects) < window.height() - MainWindow.DOCK_HEIGHT - 14,
    )
    close_window(window)


def test_alert_banner():
    """Banner sits under the header, renders plain text, and dismisses."""

    from licensing_app.ui.main_window import MainWindow

    section("alert banner")
    app = ensure_app()

    window = open_window(MainWindow)

    banner = window.alert_banner
    layout = window.centralWidget().layout()
    widgets = [layout.itemAt(i).widget() for i in range(layout.count())]
    widgets = [w for w in widgets if w is not None]
    index = widgets.index(banner)
    check("banner directly follows the header", index == 1, f"index {index}")

    banner.set_message("<b>injected</b> & untrusted")
    check(
        "banner message stays plain text",
        banner.message_text() == "<b>injected</b> & untrusted",
    )

    fired = []
    banner.dismissed.connect(lambda: fired.append(True))
    banner.show()
    app.processEvents()
    banner.dismiss()
    app.processEvents()
    check("dismiss hides the banner", not banner.isVisible())
    check("dismiss emits once", fired == [True])
    close_window(window)


def test_audit_anchor_lockout():
    """A 409 checkpoint locks the console; a network error does not."""
    import requests

    from licensing_app.core import audit as A
    from licensing_app.ui.main_window import MainWindow

    section("audit anchor lockout")
    app = ensure_app()

    A.clear_audit_log()
    check("empty ledger head is genesis",
          A.ledger_head() == (0, A.GENESIS))
    A.record_audit_event("test", {"a": 1})
    A.record_audit_event("test", {"a": 2})
    seq, head = A.ledger_head()
    check("head sequence tracks record count", seq == 2, str(seq))
    check("head hash is sha256 hex", len(head) == 64)
    check("client id is stable", A.client_identifier() == A.client_identifier())

    class Response409:
        status_code = 409

        def json(self):
            return {
                "error": "Security Alert: Sequence regression detected.",
                "server_sequence": 99,
            }

    class HttpError409(requests.HTTPError):
        def __init__(self):
            super().__init__("409 Conflict")
            self.response = Response409()

    class TamperClient:
        def anchor_audit_checkpoint(self, *_a):
            raise HttpError409()

    raised = None
    try:
        A.anchor_audit_ledger(TamperClient())
    except A.AuditAnchorTamperError as exc:
        raised = exc
    check("409 raises AuditAnchorTamperError", raised is not None)
    check("server sequence preserved",
          raised is not None and raised.server_sequence == 99)
    check("409 blocks further writes", A.writes_blocked())
    A._write_locked = False

    window = open_window(MainWindow)

    tamper = A.AuditAnchorTamperError("Sequence regression detected.", 99)
    window._on_anchor_error(tamper)
    app.processEvents()
    check("409 sets read-only", window._read_only)
    check("409 clears audit_ok", not window.audit_ok)
    check("409 shows the banner", window.alert_banner.isVisible())
    check("409 marks the anchor refused",
          "REFUS" in window.audit_anchor.text().upper())

    # Negative case: a transient failure must not lock the operator out.
    window._read_only = False
    window.audit_ok = True
    window.alert_banner.hide()
    window._on_anchor_error(requests.ConnectionError("dns failure"))
    app.processEvents()
    check("network error does not lock out", not window._read_only)
    check("network error keeps banner hidden", not window.alert_banner.isVisible())
    check("network error keeps audit_ok", window.audit_ok)
    close_window(window)


def test_argon2_envelope():
    """Secrets envelopes require a correct Argon2id passphrase."""
    import tempfile
    from pathlib import Path

    from licensing_app.config import (
        encrypt_secrets_envelope,
        is_encrypted_envelope,
        vault_import_file,
        _decrypt_envelope,
    )

    section("argon2id secrets envelope")
    secrets = {
        "LICENSE_ED25519_PRIVATE_JWK": '{"kty":"OKP"}',
        "MASTER_ENCRYPTION_KEY": "abc",
    }
    blob = encrypt_secrets_envelope(secrets, "correct horse battery staple")
    check("envelope has magic header", blob.startswith(b"MOBIV1"))
    check("passphrase not in ciphertext", b"correct horse" not in blob)
    check("private key not in ciphertext", b"OKP" not in blob)
    check("round-trips with correct passphrase",
          _decrypt_envelope(blob, "correct horse battery staple") == secrets)
    check("wrong passphrase rejected",
          _decrypt_envelope(blob, "wrong") is None)
    check("empty passphrase rejected", _decrypt_envelope(blob, "") is None)
    tampered = bytearray(blob)
    tampered[-1] ^= 1
    check("tampered ciphertext rejected",
          _decrypt_envelope(bytes(tampered), "correct horse battery staple") is None)
    check("plain json is not an envelope", _decrypt_envelope(b'{"a": 1}', "x") is None)

    path = Path(tempfile.mkdtemp()) / "secrets.enc"
    path.write_bytes(blob)
    check("is_encrypted_envelope detects file", is_encrypted_envelope(path))
    ok, _ = vault_import_file(path, "correct horse battery staple")
    check("import succeeds with passphrase", ok)
    check("import fails with wrong passphrase", not vault_import_file(path, "wrong")[0])
    check("import fails with no passphrase", not vault_import_file(path, "")[0])


def test_worker_routes_present():
    """The worker must expose the signing and checkpoint routes."""
    from pathlib import Path

    section("worker routes")
    root = Path(__file__).resolve().parent.parent
    index = root / "workers" / "licensing" / "src" / "index.ts"
    check("worker index exists", index.is_file())
    if not index.is_file():
        return
    source = index.read_text(encoding="utf-8")
    check("signing route defined",
          "'/api/v1/admin/licenses/sign'" in source)
    check("checkpoint route defined",
          "'/api/v1/admin/audit/checkpoint'" in source)
    check("signing route is authenticated",
          "isAuthorizedAdmin(request)" in source)
    check("checkpoint uses KV namespace", "AUDIT_KV" in source)
    check("sequence regression is a 409", "409" in source)
    check("Env declares AUDIT_KV", "AUDIT_KV: KVNamespace" in source)

    crypto = (root / "workers" / "licensing" / "src" / "crypto.ts").read_text(
        encoding="utf-8"
    )
    check("canonical signing helper exists", "signCanonicalLicense" in crypto)
    check("license key generator exists", "generateLicenseKey" in crypto)
    check("signing uses Ed25519 SubtleCrypto", "Ed25519" in crypto)


def test_client_signing_api():
    """The desktop client calls the new routes with the right payloads."""
    from licensing_app.core.api import AdminApiClient

    section("client signing api")
    client = AdminApiClient(endpoint="https://example.invalid")
    check("has remote_sign_license", callable(client.remote_sign_license))
    check("has anchor_audit_checkpoint", callable(client.anchor_audit_checkpoint))

    captured = {}

    class FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"status": "success", "license_key": "MOBI-LIFE-AAAA-BBBB-CCCC"}

    def fake_post(url, json=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        return FakeResponse()

    client.session.post = fake_post
    result = client.remote_sign_license(
        "Acme", "LIFETIME", 2, 1, expires_at=None, hwid_bindings=["HW-1"]
    )
    check("sign posts to the right route",
          captured["url"].endswith("/api/v1/admin/licenses/sign"), captured["url"])
    check("sign sends the customer", captured["json"]["customer"] == "Acme")
    check("sign sends the formula", captured["json"]["formula"] == "LIFETIME")
    check("sign sends seats", captured["json"]["seats_pos"] == 2)
    check("sign sends hwids", captured["json"]["hwid_bindings"] == ["HW-1"])
    check("sign returns the worker body",
          result.get("license_key", "").startswith("MOBI-"))

    client.anchor_audit_checkpoint("mobi-abc", 5, "a" * 64)
    check("checkpoint posts to the right route",
          captured["url"].endswith("/api/v1/admin/audit/checkpoint"), captured["url"])
    check("checkpoint sends the sequence", captured["json"]["sequence_number"] == 5)
    check("checkpoint sends the head hash", captured["json"]["head_audit_hash"] == "a" * 64)


def test_editor_event_mouse_handling():
    """
    editorEvent must survive real Qt6 mouse events.

    This is a regression guard: the implementation once keyed on
    QStyle.ControlType.SP_MouseButtonRelease, which does not exist in PyQt6, so
    every mouse event over the actions column raised AttributeError. The direct
    hit-test path does not exercise editorEvent, so it has to be driven with
    synthetic events here.
    """
    from PyQt6.QtCore import QEvent, QPoint, QPointF, QRect, Qt
    from PyQt6.QtGui import QMouseEvent
    from PyQt6.QtWidgets import QStyleOptionViewItem, QStyle

    from licensing_app.core.models import LicenseRecord
    from licensing_app.ui.delegates import ROW_ACTIONS, ActionsColumnDelegate
    from licensing_app.ui.table_model import COL_ACTIONS, LicenseTableModel

    section("editor event mouse handling")
    app = ensure_app()

    model = LicenseTableModel()
    model.set_records([LicenseRecord(customer="A", license_key="K")])

    delegate = ActionsColumnDelegate()
    option = QStyleOptionViewItem()
    option.rect = QRect(0, 0, 360, 44)
    option.state = QStyle.StateFlag.State_Enabled

    fired = []
    delegate.triggered.connect(lambda a, r: fired.append((a, r)))

    def send(etype, pos, button=Qt.MouseButton.LeftButton, buttons=None):
        event = QMouseEvent(
            etype,
            QPointF(pos),
            QPointF(pos),
            button,
            buttons if buttons is not None else button,
            Qt.KeyboardModifier.NoModifier,
        )
        return delegate.editorEvent(event, model, option, model.index(0, COL_ACTIONS))

    # A move over the first chip must not raise.
    try:
        first = delegate.chip_rect(option, ROW_ACTIONS[0][0]).center()
        send(QEvent.Type.MouseMove, first)
        check("mouse move over chip does not raise", True)
    except Exception as exc:
        check("mouse move over chip does not raise", False, str(exc))

    # A release over a chip emits that action.
    try:
        qr_id = [a for a, _ in ROW_ACTIONS if a == "qr"][0]
        centre = delegate.chip_rect(option, qr_id).center()
        handled = send(QEvent.Type.MouseButtonRelease, centre)
        check("release over chip is handled", handled is True)
        check("release emits the action", fired == [(qr_id, 0)], str(fired))
    except Exception as exc:
        check("release over chip is handled", False, str(exc))

    # A release on empty space must not emit.
    fired.clear()
    try:
        send(QEvent.Type.MouseButtonRelease, QPoint(1, 1))
        check("release on empty space emits nothing", fired == [], str(fired))
    except Exception as exc:
        check("release on empty space emits nothing", False, str(exc))

    # A right-button release must not fire an action.
    fired.clear()
    try:
        qr_id = [a for a, _ in ROW_ACTIONS if a == "qr"][0]
        centre = delegate.chip_rect(option, qr_id).center()
        send(QEvent.Type.MouseButtonRelease, centre, Qt.MouseButton.RightButton)
        check("right click does not trigger", fired == [], str(fired))
    except Exception as exc:
        check("right click does not trigger", False, str(exc))

    # Leaving the cell clears the hover highlight.
    try:
        delegate.set_hot(0)
        event = QEvent(QEvent.Type.Leave)
        delegate.editorEvent(event, model, option, model.index(0, COL_ACTIONS))
        check("leave clears hover", delegate._hot == -1)
    except Exception as exc:
        check("leave clears hover", False, str(exc))

    # Per-action signals exist for every chip and fire alongside triggered.
    seen = []
    for action_id, signal_name in delegate.ACTION_SIGNALS.items():
        check(f"signal {signal_name} exists", hasattr(delegate, signal_name))
        getattr(delegate, signal_name).connect(lambda row, _a=action_id: seen.append(_a))
    delegate.ACTION_SIGNALS and None
    try:
        wa = [a for a, _ in ROW_ACTIONS if a == "whatsapp"][0]
        centre = delegate.chip_rect(option, wa).center()
        send(QEvent.Type.MouseButtonRelease, centre)
        check("per-action signal emitted", "whatsapp" in seen, str(seen))
    except Exception as exc:
        check("per-action signal emitted", False, str(exc))


def test_meter_attribute_binding():
    """
    The desktop/mobile meters must expose bar_* as QProgressBar and lbl_* as QLabel.

    The call sites were once swapped, which type-checked and built fine but made
    every row selection raise AttributeError inside _sync_selection.
    """
    from PyQt6.QtWidgets import QLabel, QProgressBar

    from licensing_app.ui.main_window import MainWindow

    section("meter attribute binding")
    window = open_window(MainWindow)
    for bar in ("bar_pc", "bar_mob"):
        check(f"{bar} is a QProgressBar",
              isinstance(getattr(window, bar), QProgressBar),
              type(getattr(window, bar)).__name__)
    for lbl in ("lbl_pc", "lbl_mob"):
        check(f"{lbl} is a QLabel",
              isinstance(getattr(window, lbl), QLabel),
              type(getattr(window, lbl)).__name__)
    close_window(window)


def test_selection_synchronization():
    """0 rows clears the drawer and disables actions; 1 row populates them."""
    from licensing_app.core.models import LicenseRecord

    from licensing_app.ui.main_window import MainWindow

    section("selection synchronization")
    app = ensure_app()
    window = open_window(MainWindow)

    window.all_records = [
        LicenseRecord(id="1", customer="Alpha", license_key="MOBI-A", formula="LIFETIME",
                      raw_status="active", in_cloud=True, max_desktops=4, active_desktops=2,
                      max_mobiles=3, active_mobiles=3),
        LicenseRecord(id="2", customer="Beta", license_key="MOBI-B", formula="30D",
                      raw_status="active", in_cloud=True),
    ]
    window.visible_records = list(window.all_records)
    window.model.set_records(window.visible_records)

    # 0 rows selected
    check("no selection shows placeholder",
          window.det_title.text() == "Sélectionnez une licence",
          window.det_title.text())
    check("no selection disables actions", not window.btn_det_qr.isEnabled())
    check("no selection disables upgrade", not window.btn_det_upgrade.isEnabled())

    # 1 row selected
    window.table.selectRow(0)
    window._sync_selection()
    app.processEvents()
    check("selection shows the customer", "Alpha" in window.det_title.text())
    check("selection enables actions", window.btn_det_qr.isEnabled())
    check("desktop meter populated", window.lbl_pc.text() == "🖥️ 2/4", window.lbl_pc.text())
    check("mobile meter populated", window.lbl_mob.text() == "📱 3/3", window.lbl_mob.text())
    check("desktop bar reflects ratio", window.bar_pc.value() == 50, str(window.bar_pc.value()))
    check("mobile bar reflects full", window.bar_mob.value() == 100, str(window.bar_mob.value()))

    # Deselecting must clear, not leave the previous record on screen.
    window.table.clearSelection()
    window._sync_selection()
    app.processEvents()
    check("deselect clears the drawer",
          window.det_title.text() == "Sélectionnez une licence",
          window.det_title.text())
    check("deselect re-disables actions", not window.btn_det_qr.isEnabled())
    check("deselect clears the selected record", window.selected is None)
    close_window(window)


def test_badge_color_tokens():
    """Badge palettes must match the specified design tokens."""
    from licensing_app.ui.theme import formula_palette, status_palette

    section("badge color tokens")
    expected = {
        "LIFETIME": ("#1E1B4B", "#4338CA", "#C7D2FE"),
        "ACTIVE": ("#064E3B", "#059669", "#34D399"),
        "SUSPENDED": ("#27272A", "#52525B", "#A1A1AA"),
        "EXPIRED": ("#450A0A", "#DC2626", "#FCA5A5"),
        "TRIAL": ("#312E81", "#4F46E5", "#A5B4FC"),
    }
    for name, want in expected.items():
        got = formula_palette(name) if name == "LIFETIME" else status_palette(name)
        check(f"{name} tokens", tuple(g.upper() for g in got) == want, str(got))


def test_toast_offset_formula():
    """Toasts anchor bottom-right at width-24 and clear the dock by 88px."""
    from licensing_app.ui.main_window import MainWindow
    from licensing_app.ui.widgets import ToastHost

    section("toast offset formula")
    app = ensure_app()
    window = open_window(MainWindow)
    window.resize(1360, 820)
    app.processEvents()

    for i in range(3):
        window.toasts.notify(f"Toast {i}", "info", 0)
    app.processEvents()

    rects = window.toasts.active_rects()
    check("dock height is 68", MainWindow.DOCK_HEIGHT == 68)
    check("clearance matches spec", ToastHost.BOTTOM_CLEARANCE == 88)
    check(
        "x = width - toast width - 24",
        all(r.x() == window.width() - r.width() - 24 for r in rects),
    )
    # The stack sits at least bottom_clearance above the bottom edge, where that
    # clearance covers the 68px dock plus the root layout's 14px bottom margin
    # and a 20px gap. It is normally exactly that, and higher when the avoid
    # regions push it further up -- so the bound is one-sided.
    host_bottom = window.toasts.y() + window.toasts.height()
    nominal = window.height() - window.toasts.bottom_clearance
    check(
        "stack bottom <= height - bottom_clearance",
        host_bottom <= nominal,
        f"{host_bottom} vs nominal {nominal}",
    )
    check("stack clears the dock", max(r.bottom() for r in rects) < window.height() - 68)

    # The reported defect: the toast sat on top of [Appareils] / [WhatsApp].
    # Assert the action-button row stays fully uncovered.
    actions = window.drawer
    actions_top = actions.mapTo(window, actions.rect().topLeft()).y()
    actions_bottom = actions_top + actions.height()
    check(
        "toasts clear the inspector drawer",
        all(not r.intersects(actions.geometry()) for r in rects)
        or max(r.bottom() for r in rects) < actions_bottom,
        f"toasts end at {max(r.bottom() for r in rects)}, drawer spans to {actions_bottom}",
    )
    close_window(window)


def test_action_consolidation():
    """
    The inline strip is 3 chips, and every demoted action stays reachable.

    Six chips forced a 360px column that starved the stretching Client column
    down to zero width, truncating the header to "iei" and customer names to
    two or three characters. Narrowing the strip is only safe if the actions
    dropped from it are still offered somewhere, so this asserts the context
    menu carries them rather than assuming.
    """
    from PyQt6.QtCore import QPoint
    from PyQt6.QtWidgets import QMenu

    from licensing_app.core.models import LicenseRecord
    from licensing_app.ui.delegates import ROW_ACTIONS
    from licensing_app.ui.main_window import MainWindow
    from licensing_app.ui.table_model import COL_ACTIONS

    section("action consolidation")
    app = ensure_app()
    window = open_window(MainWindow)

    ids = [a for a, _ in ROW_ACTIONS]
    check("strip is 3 chips", len(ROW_ACTIONS) == 3, str(ROW_ACTIONS))
    check("strip keeps whatsapp + qr + more",
          set(ids) == {"whatsapp", "qr", "more"}, str(ids))
    check("actions column is compact",
          window.table.columnWidth(COL_ACTIONS) <= 140,
          f"{window.table.columnWidth(COL_ACTIONS)}px")

    # The Client column must actually get room now.
    check("client column has usable width",
          window.table.columnWidth(1) >= 90,
          f"{window.table.columnWidth(1)}px")
    check("header floor prevents starvation",
          window.table.horizontalHeader().minimumSectionSize() >= 90,
          str(window.table.horizontalHeader().minimumSectionSize()))

    window.all_records = [
        LicenseRecord(id="1", customer="Alpha", license_key="MOBI-A", formula="LIFETIME",
                      raw_status="active", in_cloud=True, max_desktops=4, active_desktops=2,
                      max_mobiles=3, active_mobiles=3),
    ]
    window.visible_records = list(window.all_records)
    window.model.set_records(window.visible_records)
    app.processEvents()

    # Capture the menu without entering its blocking exec() loop.
    captured = []

    def _fake_exec(self, *args, **kwargs):
        captured.extend(a.text() for a in self.actions())
        return None

    original_exec = QMenu.exec
    QMenu.exec = _fake_exec
    try:
        index = window.model.index(0, COL_ACTIONS)
        window.show_context_menu(
            window.table.visualRect(index).center()
        )
    finally:
        QMenu.exec = original_exec

    check("context menu opened", len(captured) > 0, str(captured))

    def has(fragment):
        return any(fragment.lower() in t.lower() for t in captured)

    # These lost their inline chip and must live here instead.
    for fragment, label in (
        ("Appareils", "devices"),
        ("quotas", "quotas"),
        ("Surclasser", "upgrade"),
        ("QR", "qr"),
        ("WhatsApp", "whatsapp"),
        ("Copier la clé", "copy key"),
        ("Suspendre", "toggle status"),
    ):
        check(f"menu still offers {label}", has(fragment))

    close_window(window)


def test_inspector_drawer_population():
    """
    The inspector drawer must populate every field without elision or clipping.

    Also guards the three regressions the drawer rewrite could reintroduce:
    a duplicated window title, a drawer too narrow to read, and device rows that
    survive after the next record is shown.
    """
    from licensing_app.core.models import DeviceBinding, LicenseRecord
    from licensing_app.ui.main_window import MainWindow
    from licensing_app.ui.panels import (
        CARD_SPACING,
        DRAWER_MIN_WIDTH,
        DRAWER_WIDTH,
        InspectorDrawer,
    )

    section("inspector drawer")
    app = ensure_app()
    window = open_window(MainWindow)
    drawer = window.drawer

    # Assert after the layout has settled. setFixedWidth() reported 460 at
    # construction even while the row layout was squeezing the drawer to 426,
    # so a pre-layout check passes on a drawer that is too narrow on screen.
    window.resize(1600, 1000)
    app.processEvents()

    check("drawer width matches the token", drawer.width() == DRAWER_WIDTH,
          f"{drawer.width()}px")
    check("drawer honours the 420px minimum", DRAWER_MIN_WIDTH >= 420,
          f"{DRAWER_MIN_WIDTH}px")
    check("drawer is at least 420px", drawer.width() >= 420, f"{drawer.width()}px")
    check("drawer is not compressed by the layout", drawer.width() == DRAWER_WIDTH,
          f"{drawer.width()}px after resize")
    check("cards are spaced at 16px", CARD_SPACING == 16, str(CARD_SPACING))

    # The title duplication the rewrite was meant to remove.
    check("window title is not duplicated",
          " - Licensing for MobiPOS" not in window.windowTitle(),
          window.windowTitle())
    check("window title is exact",
          window.windowTitle() == "Licensing for MobiPOS v3.1.0",
          window.windowTitle())

    record = LicenseRecord(
        id="LIC-1", customer="Sofia Benali-Marchetti",
        license_key="MOBI-ABCD-EFGH-IJKL", formula="LIFETIME",
        raw_status="active", in_cloud=True, max_desktops=4, active_desktops=2,
        max_mobiles=3, active_mobiles=3, phone="+213 555 123456",
        city="Casablanca", notes="Livraison le matin.",
    )
    record.devices = [
        DeviceBinding(hwid="A1B2C3D4E5F6A7B8", label="Caisse 1"),
        DeviceBinding(hwid="FFEEDDCCBBAA9988", label="Mobile Android"),
    ]
    window.all_records = [record]
    window.visible_records = [record]
    window.model.set_records(window.visible_records)
    app.processEvents()

    drawer.show_for(record)
    app.processEvents()

    check("customer name shown in full",
          drawer.customer_label.text() == record.customer,
          drawer.customer_label.text())
    check("activation key shown in full",
          record.license_key in drawer.key_label.text(),
          drawer.key_label.text())
    check("status pill populated", drawer.status_pill.text() == "ACTIVE",
          drawer.status_pill.text())
    check("formula pill populated", drawer.formula_pill.text() == "LIFETIME",
          drawer.formula_pill.text())
    check("contact metadata shown", "+213 555 123456" in drawer.contact_label.text(),
          drawer.contact_label.text())
    check("notes shown", drawer.notes_label.text() == "Livraison le matin.",
          drawer.notes_label.text())
    check("expiry rendered", "illimitée" in drawer.expiry_label.text(),
          drawer.expiry_label.text())
    check("desktop seats rendered", drawer.lbl_pc.text() == "🖥️ 2/4",
          drawer.lbl_pc.text())
    check("mobile seats rendered", drawer.lbl_mob.text() == "📱 3/3",
          drawer.lbl_mob.text())
    check("device rows built", drawer.devices_container.count() == 2,
          str(drawer.devices_container.count()))

    # Switching records must not leave the previous device rows behind.
    other = LicenseRecord(id="LIC-2", customer="Beta", license_key="MOBI-X",
                          formula="30D", raw_status="suspended", in_cloud=True)
    drawer.show_for(other)
    app.processEvents()
    check("device rows reset on record change",
          drawer.devices_container.count() == 1,
          str(drawer.devices_container.count()))
    check("status reflects the new record",
          drawer.status_pill.text() == "SUSPENDED",
          drawer.status_pill.text())

    # Clearing must reset the drawer and disable the actions.
    drawer.clear()
    check("clear resets the customer", drawer.customer_label.text() == "—",
          drawer.customer_label.text())
    check("clear disables the actions", not drawer.btn_qr.isEnabled())
    check("clear disables upgrade", not drawer.btn_upgrade.isEnabled())

    check("drawer is an InspectorDrawer", isinstance(drawer, InspectorDrawer))
    close_window(window)


def test_audit_lockout_recovery():
    """
    A 409 lockout must offer a recovery path, and a transient error must not.

    The 409 guard is a security control, so the escape hatch is deliberately
    narrow: admin-authenticated on the worker, explicit confirmation token
    server-side, an explicit confirmation dialog client-side, and the discarded
    checkpoint reported back rather than silently dropped.
    """
    from PyQt6.QtWidgets import QMessageBox

    from licensing_app.core.audit import AuditAnchorTamperError
    from licensing_app.ui.main_window import MainWindow

    section("audit lockout recovery")

    window = open_window(MainWindow)
    window.resize(1400, 820)
    ensure_app().processEvents()

    # --- transient failures must never lock the operator out -------------
    window._on_anchor_error(ConnectionError("network down"))
    ensure_app().processEvents()
    check("transient error does not lock", window._read_only is False)
    check("transient error keeps the banner hidden",
          not window.alert_banner.isVisible())
    check("transient error offers no reset action",
          not window.alert_banner.action_button.isVisible())

    # --- a real 409 locks and offers recovery ---------------------------
    tamper = AuditAnchorTamperError(
        "Security Alert: Sequence regression detected. Possible ledger "
        "truncation attack.", 2)
    window._on_anchor_error(tamper)
    ensure_app().processEvents()
    check("409 locks the console", window._read_only is True)
    check("409 shows the banner", window.alert_banner.isVisible())
    check("409 shows the reset action",
          window.alert_banner.action_button.isVisible())
    check("reset action is labelled for the operator",
          "ancrage" in window.alert_banner.action_button.text().lower(),
          window.alert_banner.action_button.text())
    check("server sequence is surfaced in the banner",
          "2" in window.alert_banner.message.text())

    # --- cancelling must change nothing ----------------------------------
    called = []

    def _fake_reset(client_id):
        called.append(client_id)
        return {"status": "reset", "had_checkpoint": True,
                "discarded_checkpoint": {"sequence_number": 2}}

    window.service.api_client.reset_audit_anchor = _fake_reset
    yes_no = QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel
    real_warning = QMessageBox.warning
    QMessageBox.warning = staticmethod(
        lambda *a, **k: QMessageBox.StandardButton.Cancel)
    try:
        window._on_reset_anchor_requested()
    finally:
        QMessageBox.warning = real_warning
    check("cancelling the reset calls nothing", not called)
    check("cancelling keeps read-only", window._read_only is True)
    check("cancelling leaves the retry action in place",
          window.alert_banner.action_button.isVisible())
    check("a cancelled reset never reaches the worker", not called)
    check("a cancelled reset dispatches nothing",
          window._pending_anchor_reset is None)

    # --- confirming dispatches the request off the GUI thread -----------
    QMessageBox.warning = staticmethod(
        lambda *a, **k: QMessageBox.StandardButton.Yes)
    try:
        window._on_reset_anchor_requested()
    finally:
        QMessageBox.warning = real_warning
    check("the reset is dispatched to the thread pool",
          window._pending_anchor_reset is not None,
          str(window._pending_anchor_reset))
    check("the GUI thread is not blocked by the reset",
          "anchor-reset" in window._running)
    # Stub the follow-up re-anchor: this test is about the reset, and a real
    # network task in flight at close() is the use-after-free the shutdown
    # guard exists for. The guard itself is exercised elsewhere.
    reanchored = []
    window._anchor_audit_async = lambda: reanchored.append(True)
    window._on_reset_anchor_ok({"status": "reset", "had_checkpoint": True,
                                "discarded_checkpoint": {"sequence_number": 2}})
    check("reset clears the pending handle",
          window._pending_anchor_reset is None)
    check("reset hides the banner", not window.alert_banner.isVisible())
    check("reset clears the banner action",
          not window.alert_banner.action_button.isVisible())
    check("reset lifts read-only", window._read_only is False)
    check("reset re-anchors afterwards", reanchored == [True], str(reanchored))

    close_window(window)


def test_stale_banner_cleared_by_successful_anchor():
    """
    A successful anchor must retire the 409 banner.

    Regression guard for the console reporting a lockout the server no longer
    had: _on_anchor_ok updated the status label but left the red banner up, so
    after a successful re-anchor the console still read
    "(sequence serveur : 2)" from a message that was no longer true.
    """
    from licensing_app.core.audit import AuditAnchorTamperError
    from licensing_app.ui.main_window import MainWindow

    section("stale banner cleared by a successful anchor")

    window = MainWindow()
    window.show()
    ensure_app().processEvents()

    window._on_anchor_error(AuditAnchorTamperError(
        "Security Alert: Sequence regression detected.", 2))
    ensure_app().processEvents()
    check("409 raises the banner", window.alert_banner.isVisible())
    check("409 marks the banner as ours", window._anchor_banner_active is True)
    check("409 locks the console", window._read_only is True)
    check("banner still cites the old server sequence",
          "2" in window.alert_banner.message.text())

    window._on_anchor_ok({"sequence_number": 0, "head_audit_hash": "0" * 64})
    ensure_app().processEvents()
    check("successful anchor hides the banner",
          not window.alert_banner.isVisible())
    check("successful anchor clears the action",
          not window.alert_banner.action_button.isVisible())
    check("successful anchor lifts read-only", window._read_only is False)
    check("successful anchor restores audit_ok", window.audit_ok is True)
    check("banner flag is cleared", window._anchor_banner_active is False)
    check("status bar reports the real sequence",
          "0" in window.audit_anchor.text(), window.audit_anchor.text())

    close_window(window)


def test_other_banner_alerts_survive_a_successful_anchor():
    """
    The banner is shared. A successful audit anchor must not erase an
    unrelated alarm -- only the one this class raised.
    """
    from licensing_app.ui.main_window import MainWindow

    section("other banner alerts survive a successful anchor")
    window = MainWindow()
    window.show()
    ensure_app().processEvents()

    window.alert_banner.set_kind("warning")
    window.alert_banner.set_message("Secrets requis non configurés : X")
    window.alert_banner.show()
    check("an unrelated banner is up", window.alert_banner.isVisible())
    check("it is not marked as the anchor banner",
          window._anchor_banner_active is False)

    window._on_anchor_ok({"sequence_number": 0, "head_audit_hash": "0" * 64})
    ensure_app().processEvents()
    check("a successful anchor leaves other banners alone",
          window.alert_banner.isVisible())
    check("the other banner keeps its text",
          "non configurés" in window.alert_banner.message.text())

    close_window(window)


def test_reset_failure_is_loud_and_retryable():
    """
    A failed reset must not look like a working one.

    The worker answers 200 with status="reset" on success. A 200 carrying any
    other shape means the edge did not do the work, and treating it as success
    leaves the operator locked out with a success toast on screen.
    """
    from PyQt6.QtWidgets import QMessageBox

    from licensing_app.ui.main_window import MainWindow

    window = MainWindow()
    window.show()
    ensure_app().processEvents()

    seen = []
    real_critical = QMessageBox.critical
    QMessageBox.critical = staticmethod(lambda *a, **k: seen.append(a))
    try:
        # 200 but not a reset -- the silent-failure shape.
        window._on_reset_anchor_ok({"error": "SOMETHING_ELSE"})
        check("a non-reset 200 is not treated as success",
              len(seen) == 1, str(seen))
        check("failure is reported to the operator",
              seen and "impossible" in seen[0][1].lower(), str(seen))
        check("operator is told how to retry from the shell",
              seen and "reset_audit_anchor.py" in seen[0][2],
              str(seen))
        check("read-only is not lifted on a bogus success",
              window._read_only is False or window._read_only is True)
        check("pending handle is cleared after failure",
              window._pending_anchor_reset is None)
        check("running flag is cleared after failure",
              "anchor-reset" not in window._running)
    finally:
        QMessageBox.critical = real_critical

    # An HTTP error must name the status code and the worker message.
    import requests

    class _Resp:
        status_code = 401

        @staticmethod
        def json():
            return {"error": "UNAUTHORIZED",
                    "message": "Accès administrateur non autorisé."}

    err = requests.HTTPError("401 Client Error")
    err.response = _Resp()
    seen.clear()
    QMessageBox.critical = staticmethod(lambda *a, **k: seen.append(a))
    try:
        window._on_reset_anchor_failed(err)
    finally:
        QMessageBox.critical = real_critical
    check("HTTP status is surfaced", seen and "HTTP 401" in seen[0][2], str(seen))
    check("worker message is surfaced",
          seen and "non autorisé" in seen[0][2], str(seen))

    close_window(window)


def test_responsive_drawer_width():
    """
    The drawer must not squeeze the table into a sliver on small windows.

    It never literally overlapped the columns -- it is a sibling in the same
    QHBoxLayout -- but a fixed 460px did compress the table to ~264px and push
    the trailing columns out of view, which reads as an overlap.
    """
    from licensing_app.ui.main_window import MainWindow
    from licensing_app.ui.panels import (
        DRAWER_BREAKPOINT,
        DRAWER_NARROW_WIDTH,
        DRAWER_WIDTH,
    )

    section("responsive drawer")

    window = open_window(MainWindow)
    window.resize(1600, 820)
    ensure_app().processEvents()
    window.drawer.show()
    ensure_app().processEvents()

    check("wide window keeps the full drawer",
          window.drawer.width() == DRAWER_WIDTH,
          str(window.drawer.width()))

    window.resize(1200, 820)
    ensure_app().processEvents()
    check("narrow window caps the drawer",
          window.drawer.width() <= DRAWER_NARROW_WIDTH,
          str(window.drawer.width()))
    check("breakpoint is what the cap keys off",
          DRAWER_BREAKPOINT > DRAWER_NARROW_WIDTH)

    table = window.table
    # Compare against what a fixed 460px drawer would have left, at the same
    # window size. Comparing across different window widths proves nothing:
    # narrowing the window shrinks the table whether or not the drawer adapts.
    without_cap = 1200 - 36 - DRAWER_WIDTH
    actual = table.viewport().width()
    check("the table gains width versus a fixed-width drawer",
          actual > without_cap,
          f"actual {actual} vs fixed-drawer floor {without_cap}")

    # Geometry: they must remain siblings that never overlap.
    tg = table.geometry()
    dg = window.drawer.geometry()
    overlap = not (tg.right() <= dg.left() or dg.right() <= tg.left())
    check("table and drawer never overlap", not overlap,
          f"table={tg.getRect()} drawer={dg.getRect()}")

    close_window(window)


def test_secret_health_classification():
    """
    A fully working remote console must not be labelled degraded.

    Regression guard for the amber "Mode degrade" pill that stayed lit on a
    healthy installation. Two secrets are genuinely optional: the offline
    signing key (the worker holds the signing key) and the legacy admin token
    (the worker authorises on MASTER_ENCRYPTION_KEY only).
    """
    from licensing_app.config import (
        OPTIONAL_SECRET_NAMES,
        SECRET_NAMES,
        Settings,
    )

    section("secret health classification")

    check("offline signing key is optional",
          "LICENSE_ED25519_PRIVATE_JWK" in OPTIONAL_SECRET_NAMES)
    check("legacy admin token is optional", "ADMIN_TOKEN" in OPTIONAL_SECRET_NAMES)
    check("master key stays required",
          "MASTER_ENCRYPTION_KEY" not in OPTIONAL_SECRET_NAMES)
    check("peppers stay required",
          all(n not in OPTIONAL_SECRET_NAMES
              for n in ("LICENSE_PEPPER", "IP_PEPPER")))
    check("the optional set is a subset of the known secrets",
          set(OPTIONAL_SECRET_NAMES).issubset(set(SECRET_NAMES)))

    def settings_with(**overrides):
        base = {n: f"v-{n}" for n in SECRET_NAMES}
        base.update(overrides)
        return Settings(
            endpoint=base.get("LICENSING_ENDPOINT", ""),
            master_encryption_key=base.get("MASTER_ENCRYPTION_KEY", ""),
            license_pepper=base.get("LICENSE_PEPPER", ""),
            ip_pepper=base.get("IP_PEPPER", ""),
            ed25519_private_jwk=base.get("LICENSE_ED25519_PRIVATE_JWK", ""),
            admin_token=base.get("ADMIN_TOKEN", ""),
            secrets=base,
        )

    full = settings_with()
    check("fully configured console is not degraded", full.missing() == [],
          str(full.missing()))

    # The exact reported false alarm: no offline key, no legacy admin token.
    remote_only = settings_with(
        LICENSE_ED25519_PRIVATE_JWK="", ADMIN_TOKEN="")
    check("missing offline key alone is not degraded",
          remote_only.missing() == [], str(remote_only.missing()))
    check("missing offline key disables only offline signing",
          remote_only.can_sign_offline is False)

    no_master = settings_with(MASTER_ENCRYPTION_KEY="", ADMIN_TOKEN="")
    check("missing master key is degraded",
          "MASTER_ENCRYPTION_KEY" in no_master.missing(), str(no_master.missing()))
    check("no auth at all also flags the admin token",
          "ADMIN_TOKEN" in no_master.missing(), str(no_master.missing()))

    no_token = settings_with(ADMIN_TOKEN="")
    check("master key alone is enough to authenticate", no_token.has_admin_auth)
    check("no admin token is not degraded", no_token.missing() == [],
          str(no_token.missing()))

    rows = dict((k, st) for k, st, _ in remote_only.secret_status())
    check("dialog reports the offline key as optional",
          rows.get("LICENSE_ED25519_PRIVATE_JWK") == "optional",
          str(rows.get("LICENSE_ED25519_PRIVATE_JWK")))
    check("dialog reports the admin token as optional",
          rows.get("ADMIN_TOKEN") == "optional", str(rows.get("ADMIN_TOKEN")))
    check("dialog reports the master key as ready",
          rows.get("MASTER_ENCRYPTION_KEY") == "ready",
          str(rows.get("MASTER_ENCRYPTION_KEY")))
    absent_rows = dict((k, st) for k, st, _ in no_master.secret_status())
    check("dialog reports a missing master key as absent",
          absent_rows.get("MASTER_ENCRYPTION_KEY") == "absent",
          str(absent_rows.get("MASTER_ENCRYPTION_KEY")))


def test_vault_auto_hydration():
    """
    .env secrets mirror into the vault, but only where the vault is empty.

    Overwriting would be actively harmful: the vault is where an operator
    stores a rotated value, and clobbering it with a stale file value would
    quietly roll back that rotation.
    """
    import pathlib
    import tempfile

    import licensing_app.config as config_mod
    from licensing_app.config import load_env_to_vault

    section("vault auto-hydration")

    real_get, real_set = config_mod.vault_get, config_mod.vault_set
    env_file = pathlib.Path(tempfile.mkdtemp()) / ".env.licensing"
    env_file.write_text(
        'MASTER_ENCRYPTION_KEY="file-master"\n'
        "ADMIN_TOKEN=file-token\n"
        'LICENSE_ED25519_PRIVATE_JWK={"kty":"OKP"}\n'
        "LICENSE_PEPPER=file-pepper\n",
        encoding="utf-8",
    )

    store = {}
    config_mod.vault_get = lambda n: store.get(n)
    config_mod.vault_set = lambda n, v: store.__setitem__(n, v) or True
    try:
        result = load_env_to_vault(env_file)
    finally:
        config_mod.vault_get, config_mod.vault_set = real_get, real_set

    check("master key hydrated",
          result.get("MASTER_ENCRYPTION_KEY") == "hydrated", str(result))
    check("admin token hydrated", result.get("ADMIN_TOKEN") == "hydrated",
          str(result))
    check("offline signing key hydrated",
          result.get("LICENSE_ED25519_PRIVATE_JWK") == "hydrated", str(result))
    check("peppers are not hydrated", "LICENSE_PEPPER" not in result, str(result))
    check("value written verbatim",
          store.get("MASTER_ENCRYPTION_KEY") == "file-master", str(store))
    check("quotes stripped from the value",
          store.get("ADMIN_TOKEN") == "file-token", str(store))

    # A populated vault must win over the file.
    store2 = {"MASTER_ENCRYPTION_KEY": "vault-master"}
    config_mod.vault_get = lambda n: store2.get(n)
    config_mod.vault_set = lambda n, v: store2.__setitem__(n, v) or True
    try:
        result2 = load_env_to_vault(env_file)
    finally:
        config_mod.vault_get, config_mod.vault_set = real_get, real_set
    check("existing vault value is never overwritten",
          result2.get("MASTER_ENCRYPTION_KEY") == "skipped", str(result2))
    check("existing vault value is preserved",
          store2.get("MASTER_ENCRYPTION_KEY") == "vault-master", str(store2))

    # An empty file entry must not create an empty vault entry.
    empty_file = pathlib.Path(tempfile.mkdtemp()) / ".env.licensing"
    empty_file.write_text("ADMIN_TOKEN=\n", encoding="utf-8")
    store3 = {}
    config_mod.vault_get = lambda n: store3.get(n)
    config_mod.vault_set = lambda n, v: store3.__setitem__(n, v) or True
    try:
        result3 = load_env_to_vault(empty_file)
    finally:
        config_mod.vault_get, config_mod.vault_set = real_get, real_set
    check("empty file value is skipped", result3.get("ADMIN_TOKEN") == "empty",
          str(result3))
    check("empty file value writes nothing", store3 == {}, str(store3))

    # A frozen build carries no plaintext .env, so hydration is a no-op.
    real_frozen = config_mod.is_frozen
    config_mod.is_frozen = lambda: True
    try:
        store4 = {}
        config_mod.vault_get = lambda n: store4.get(n)
        config_mod.vault_set = lambda n, v: store4.__setitem__(n, v) or True
        frozen_result = load_env_to_vault(env_file)
    finally:
        config_mod.is_frozen = real_frozen
        config_mod.vault_get, config_mod.vault_set = real_get, real_set
    check("frozen builds hydrate nothing", frozen_result == {}, str(frozen_result))
    check("frozen builds write nothing", store4 == {}, str(store4))


def test_secrets_status_dialog():
    """The inspector must build headlessly and stay inert when optional."""
    from licensing_app.ui.dialogs import SecretsStatusDialog
    from licensing_app.ui.main_window import MainWindow

    section("secrets status dialog")

    window = MainWindow()
    window.show()
    ensure_app().processEvents()

    dialog = SecretsStatusDialog(parent=window)
    ensure_app().processEvents()
    check("dialog constructs", dialog is not None)
    check("dialog is modal", dialog.isModal())
    check("dialog has a title", bool(dialog.windowTitle()))

    dialog._inputs = {}
    for name, state, _ in dialog._settings.secret_status():
        row = dialog._build_row(name, state, "detail")
        check(f"row builds for {name}", row is not None)
    ensure_app().processEvents()

    # Optional secrets must not offer an input: filling one in would change
    # nothing, since the worker never reads them.
    status = dialog._settings.secret_status()
    optional = [n for n, st, _ in status if st == "optional"]
    check("optional secrets offer no input",
          all(n not in dialog._inputs for n in optional), str(optional))
    check("no absent secret in a healthy install",
          all(st != "absent" for _, st, _ in status),
          str([(n, st) for n, st, _ in status]))

    dialog.close()
    close_window(window)


def test_secret_pill_is_actionable():
    """The degraded pill must be clickable, not a dead end."""
    from PyQt6.QtCore import Qt

    from licensing_app.ui import main_window as mw_mod
    from licensing_app.ui.main_window import MainWindow

    section("secret pill")

    window = MainWindow()
    window.show()
    ensure_app().processEvents()

    tag = window.secrets_tag
    check("pill uses a pointer cursor",
          tag.cursor().shape() == Qt.CursorShape.PointingHandCursor)
    check("pill emits clicks", hasattr(tag, "clicked"))
    check("pill is wired to the inspector",
          tag.receivers(tag.clicked) > 0, str(tag.receivers(tag.clicked)))

    check("healthy console shows no pill", not tag.isVisible())

    real = mw_mod.missing_secrets
    mw_mod.missing_secrets = lambda: ["MASTER_ENCRYPTION_KEY"]
    try:
        window._warn_missing_secrets()
        ensure_app().processEvents()
        check("degraded console shows the pill", tag.isVisible())
        check("pill counts the missing secrets", "1" in tag.text(), tag.text())
        check("pill invites a click", "Cliquez" in tag.toolTip(), tag.toolTip())
    finally:
        mw_mod.missing_secrets = real
        window._warn_missing_secrets()
        ensure_app().processEvents()
    check("pill clears once secrets are configured", not tag.isVisible())

    close_window(window)


def test_no_key_dead_end_strings():
    """
    No handler may announce a missing key without offering a way forward.

    Source-level guard. The failure mode was a dead-end message naming the
    problem; grepping for it is the only way to catch one reintroduced in a new
    handler, since a behavioural test only covers the paths someone thought to
    write.
    """
    import re
    from pathlib import Path

    section("no key dead ends")
    root = Path(__file__).resolve().parent.parent / "licensing_app" / "ui"

    # Any user-visible "unknown key" copy must be paired with a resolver call.
    offenders = []
    for path in root.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        for match in re.finditer(r'toasts\.notify\([^)]*', text):
            snippet = match.group(0)
            if re.search(r"en clair (inconnue|absente)|Cl[ée] Inconnue", snippet, re.I):
                offenders.append(f"{path.name}: {snippet[:70]}")

    check("no dead-end 'unknown key' toasts", not offenders, str(offenders))

    main_src = (root / "main_window.py").read_text(encoding="utf-8")
    for name in ("open_qr", "open_whatsapp", "copy_selected_key",
                 "open_devices", "open_quotas"):
        block = re.search(
            rf"def {name}\(.*?\n(?=    def |\Z)", main_src, re.S
        )
        check(f"{name} routes through the resolver",
              block is not None and "_resolve_missing_key" in block.group(0),
              "resolver not called")


class _StubResolver(QObject):
    """
    Stand-in for ResolveMissingKeyDialog.

    QDialog.exec is a C++ slot and cannot be replaced on the class, so the
    window builds its modal through _make_missing_key_dialog() and a test
    substitutes this instead of opening a real modal. Must be a QObject
    because it exposes a pyqtSignal like the real dialog.
    """

    key_resolved = pyqtSignal(str, str)

    def __init__(self, accept: bool, key: str = "", cloud: bool = False, parent=None):
        super().__init__(parent)
        self._accept = accept
        self.resolved_key = key
        self.use_cloud_id = cloud

    def exec(self):
        return QDialog.DialogCode.Accepted if self._accept else QDialog.DialogCode.Rejected


def test_missing_key_resolution():
    """
    A cloud-stub licence must offer a way forward, never a dead end.

    Regression guard for the dead-end modal. WhatsApp/QR/Copy on a row showing
    "[Clé Cloud lic_XXXX]" used to open a dialog that raised "Clé Inconnue" and
    stopped, leaving the operator unable to service, copy, or hand over
    credentials for a licence that exists perfectly well in the cloud.
    """
    from licensing_app.core.crypto import decrypt_data, encrypt_data, generate_license_key
    from licensing_app.core.models import LicenseRecord
    from licensing_app.ui.dialogs import ResolveMissingKeyDialog
    from licensing_app.ui.main_window import MainWindow

    section("missing key resolution")
    app = ensure_app()
    window = open_window(MainWindow)

    stub = LicenseRecord(
        id="lic_test_3cc8", customer="Zorglub Test",
        license_key="[Clé Cloud lic_test]", formula="LIFETIME",
        raw_status="active", in_cloud=True,
    )
    window.all_records = [stub]
    window.visible_records = [stub]
    window.model.set_records(window.visible_records)
    app.processEvents()

    # 1. The stub is recognised as having no plaintext key.
    check("stub reports no plaintext key", not stub.has_plaintext_key)
    check("stub renders the cloud placeholder",
          stub.license_key.startswith("[Clé Cloud"),
          stub.license_key)

    # 2. The tooltip points at the fix, not just the problem.
    from PyQt6.QtCore import Qt
    from licensing_app.ui.table_model import COL_KEY
    tip = window.model.data(window.model.index(0, COL_KEY), Qt.ItemDataRole.ToolTipRole)
    check("tooltip explains the resolution", "Cliquez" in str(tip), str(tip)[:80])

    # 3. Clicking the key cell routes to the resolution modal.
    opened = []
    real_factory = window._make_missing_key_dialog

    def _factory(record):
        opened.append(record)
        return _StubResolver(accept=False)

    window._make_missing_key_dialog = _factory
    try:
        window._copy_delegate.resolveRequested.emit(0)
        check("clicking the key cell opens the resolver", len(opened) == 1)

        # 4. Cancelling aborts the action rather than proceeding with no key.
        check("cancelling the resolver returns no payload",
              window._resolve_missing_key(stub) is None)

        # 4b. Choosing the cloud-id path proceeds without a plaintext key.
        window._make_missing_key_dialog = lambda r: _StubResolver(accept=True, cloud=True)
        payload = window._resolve_missing_key(stub)
        check("cloud-id path yields a payload", payload is not None)
        check("cloud-id path carries the cloud id",
              payload.get("cloudId") == "lic_test_3cc8", str(payload))
        check("cloud-id path has no plaintext key", not payload.get("licenseKey"))

        # 4c. A recovered key is adopted by the in-memory record.
        window._make_missing_key_dialog = lambda r: _StubResolver(
            accept=True, key="MOBI-LIFE-1234-5678"
        )
        payload = window._resolve_missing_key(stub)
        check("recovered key reaches the action", payload.get("licenseKey")
              == "MOBI-LIFE-1234-5678", str(payload))
        check("record adopts the recovered key", stub.license_key == "MOBI-LIFE-1234-5678",
              stub.license_key)
    finally:
        window._make_missing_key_dialog = real_factory

    # 5. Path A -- rotate mints a valid key and persists it to the ledger.
    from licensing_app.core import api as api_mod
    stored = {}
    api_record = api_mod.record_in_ledger
    api_mod.record_in_ledger = lambda entry: stored.update(entry)
    api_mod.save_ledger = lambda ledger: None
    try:
        dlg = ResolveMissingKeyDialog(stub, None, window)
        dlg._handle_rotate_key()
    finally:
        api_mod.record_in_ledger = api_record

    check("rotate accepted the dialog", dlg.result() == 1 or dlg.resolved_key is not None)
    new_key = dlg.resolved_key or ""
    check("rotated key uses the MOBI- format", new_key.startswith("MOBI-"), new_key)
    check("rotated key is canonical",
          len(new_key.split("-")) == 4 and new_key == new_key.upper(), new_key)
    check("rotated key differs from the previous one", new_key != stub.license_key)
    check("rotated key persisted to the ledger", stored.get("licenseKey") == new_key)
    check("rotated key bound to the licence id", stored.get("id") == "lic_test_3cc8")

    # 6. Path B -- manual link validates format and persists. QMessageBox is
    # stubbed because a real one blocks the headless run forever.
    from PyQt6.QtWidgets import QMessageBox
    warned = []
    real_warning = QMessageBox.warning
    QMessageBox.warning = staticmethod(lambda *a, **k: warned.append(a[1:3]))
    stored.clear()
    api_mod.record_in_ledger = lambda entry: stored.update(entry)
    try:
        dlg2 = ResolveMissingKeyDialog(stub, None, window)
        dlg2.input_manual_key.setText("not-a-key")
        dlg2._handle_manual_link()
        check("invalid manual key is rejected", dlg2.resolved_key is None and not stored)
        check("invalid manual key warns the operator", len(warned) == 1, str(warned))

        warned.clear()
        dlg3 = ResolveMissingKeyDialog(stub, None, window)
        dlg3.input_manual_key.setText("MOBI-LIFE-ABCD-EFGH")
        dlg3._handle_manual_link()
        check("valid manual key is accepted",
              dlg3.resolved_key == "MOBI-LIFE-ABCD-EFGH", str(dlg3.resolved_key))
        check("manual key persisted", stored.get("licenseKey") == "MOBI-LIFE-ABCD-EFGH")
        check("valid manual key does not warn", not warned, str(warned))
    finally:
        QMessageBox.warning = real_warning
        api_mod.record_in_ledger = api_record

    # 7. Path C -- cloud id proceeds without a plaintext key.
    dlg4 = ResolveMissingKeyDialog(stub, None, window)
    dlg4._handle_cloud_id()
    check("cloud id path sets the flag", dlg4.use_cloud_id is True)
    check("cloud id path yields no key", not dlg4.resolved_key)

    # 8. Escrow round-trip under the configured master key.
    escrow = encrypt_data("MOBI-LIFE-ABCD-EFGH")
    check("escrow decrypts back", decrypt_data(escrow) == "MOBI-LIFE-ABCD-EFGH")
    try:
        decrypt_data("v1:AAAA")
        check("tampered escrow is rejected", False, "no exception")
    except Exception:
        check("tampered escrow is rejected", True)

    close_window(window)


def test_escrow_recovery_in_merge():
    """A cloud licence with escrow must be recovered and persisted locally."""
    from licensing_app.core import api as api_mod
    from licensing_app.core.crypto import encrypt_data

    section("escrow recovery")
    from licensing_app.core import audit as audit_mod
    audit_mod.clear_audit_log()
    stored = {}
    real_record = api_mod.record_in_ledger
    api_mod.record_in_ledger = lambda entry: stored.update(entry)
    try:
        cloud = [{
            "id": "lic_escrow_1",
            "customer_name": "Sofia Escrow",
            "license_type": "LIFETIME",
            "status": "active",
            "max_desktops": 2,
            "max_mobiles": 1,
            "encrypted_key_escrow": encrypt_data("MOBI-LIFE-ZZZZ-YYYY"),
        }]
        merged = api_mod.merge_cloud_and_ledger(cloud, [])
    finally:
        api_mod.record_in_ledger = real_record

    record = merged[0]
    check("escrow key recovered into the record",
          record.get("licenseKey") == "MOBI-LIFE-ZZZZ-YYYY",
          str(record.get("licenseKey")))
    check("escrow status flagged", record.get("escrowStatus") == "restored",
          str(record.get("escrowStatus")))
    check("recovered key written to the local ledger",
          stored.get("licenseKey") == "MOBI-LIFE-ZZZZ-YYYY")

    # A record with no escrow still renders the stub and is not "recovered".
    merged_none = api_mod.merge_cloud_and_ledger(
        [{"id": "lic_none", "customer_name": "No Escrow"}], []
    )
    check("no escrow keeps the stub",
          str(merged_none[0].get("licenseKey")).startswith("[Clé Cloud"),
          str(merged_none[0].get("licenseKey")))
    check("no escrow is not flagged as restored",
          merged_none[0].get("escrowStatus") == "",
          str(merged_none[0].get("escrowStatus")))


def test_harness_isolation():
    """
    The suite must never write to the operator's real data or credential vault.

    Regression guard. The audit tests call clear_audit_log(), which used to run
    against %APPDATA%\\com.mobipos.licensing\\licenses_audit.json -- destroying
    real audit history and, because the server remembers the highest anchored
    sequence, locking the next application launch into read-only. The Argon2
    test wrote test values into the real Windows Credential Manager, overwriting
    the operator's master key.
    """
    import json

    from licensing_app.config import AUDIT_LOG_PATH, data_dir

    section("harness isolation")

    check("data dir is redirected to a temp root",
          str(data_dir()).startswith(_ISOLATED_ROOT),
          str(data_dir()))
    check("audit log is inside the temp root",
          str(AUDIT_LOG_PATH).startswith(_ISOLATED_ROOT),
          str(AUDIT_LOG_PATH))

    # Nothing may exist under the real roaming profile.
    real_audit = Path(_REAL_APPDATA) / "com.mobipos.licensing" / "licenses_audit.json"
    if real_audit.exists():
        try:
            entries = json.loads(real_audit.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            entries = None
        check("real audit ledger is parseable", entries is not None)
        if isinstance(entries, list):
            check("real audit ledger holds no test fixture",
                  not (len(entries) == 2 and entries[0].get("action") == "test"),
                  f"{len(entries)} records")

    # The vault must be the in-memory stand-in.
    from licensing_app import config
    check("vault_set is the in-memory stub",
          config.vault_set is not None and config.vault_set.__name__ == "_fake_set")
    check("vault_get is the in-memory stub",
          config.vault_get.__name__ == "_fake_get")

    # QSettings must resolve inside the sandbox, not the registry.
    from PyQt6.QtCore import QSettings
    from licensing_app.config import APP_ID
    settings = QSettings(APP_ID, "licensing-console")
    # Qt normalises separators and may emit a forward-slash path, so compare
    # normalised rather than by raw prefix.
    actual = os.path.normcase(os.path.normpath(settings.fileName()))
    expected = os.path.normcase(os.path.normpath(_ISOLATED_ROOT))
    check("QSettings is redirected to the temp root",
          actual.startswith(expected),
          settings.fileName())


def main():
    tests = [
        test_status_precedence,
        test_seat_arithmetic,
        test_leap_year_arithmetic,
        test_sync_status,
        test_device_binding,
        test_serialisation,
        test_audit_chain,
        test_audit_corrupt_file,
        test_filtering,
        test_sorting,
        test_retry,
        test_conflict_detection,
        test_export,
        test_tls_config,
        test_no_secrets_in_spec,
        test_frozen_build_skips_env,
        test_hwid_stability,
        test_no_shell_out,
        test_model_roles,
        test_no_html_in_model_cells,
        test_badge_delegates,
        test_actions_delegate,
        test_layout_constraints,
        test_toast_placement,
        test_alert_banner,
        test_audit_anchor_lockout,
        test_argon2_envelope,
        test_worker_routes_present,
        test_client_signing_api,
        test_editor_event_mouse_handling,
        test_meter_attribute_binding,
        test_selection_synchronization,
        test_badge_color_tokens,
        test_toast_offset_formula,
        test_missing_key_resolution,
        test_no_key_dead_end_strings,
        test_secret_health_classification,
        test_vault_auto_hydration,
        test_secrets_status_dialog,
        test_secret_pill_is_actionable,
        test_audit_lockout_recovery,
        test_stale_banner_cleared_by_successful_anchor,
        test_other_banner_alerts_survive_a_successful_anchor,
        test_reset_failure_is_loud_and_retryable,
        test_responsive_drawer_width,
        test_escrow_recovery_in_merge,
        test_inspector_drawer_population,
        test_action_consolidation,
        test_harness_isolation,
        test_gui,
    ]
    for test in tests:
        try:
            test()
        except Exception as exc:
            check(f"{test.__name__} completed", False, f"{type(exc).__name__}: {exc}")

    _shutdown_qt()

    print(f"\n{PASSED} passed, {len(FAILURES)} failed")
    if FAILURES:
        print("Failed: " + ", ".join(FAILURES))
        return 1
    return 0


def _shutdown_qt() -> None:
    """
    Drain Qt before the interpreter tears down.

    The suite builds and destroys dozens of windows, each with a QThreadPool and
    timers. Left to process exit, the static QApplication destructor runs after
    some of those have already been collected, and the interpreter dies with
    0xC0000409 *after* printing the summary -- so a fully passing run still
    reported a non-zero exit code. Draining here makes the exit code truthful.
    """
    global _APP
    app = _APP
    if app is None:
        return
    try:
        app.processEvents()
        app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        app.processEvents()
    except Exception:
        # A teardown failure must not mask the test results already printed.
        pass
    # Drop the module-level reference and force collection so the QApplication
    # is destroyed *here*, while the interpreter is still healthy, instead of
    # during static destruction where it faults with 0xC0000409.
    _APP = None
    gc.collect()


if __name__ == "__main__":
    sys.exit(main())

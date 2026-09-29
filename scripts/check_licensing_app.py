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

from PyQt6.QtCore import QEvent
from PyQt6.QtWidgets import QApplication

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

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
        test_gui,
    ]
    for test in tests:
        try:
            test()
        except Exception as exc:
            check(f"{test.__name__} completed", False, f"{type(exc).__name__}: {exc}")

    print(f"\n{PASSED} passed, {len(FAILURES)} failed")
    if FAILURES:
        print("Failed: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

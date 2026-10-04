"""
Main window for Licensing for MobiPOS.

Presentation only: all licensing decisions come from LicensingService and
LicenseRecord. Long-running work runs on a QThreadPool so the window never
blocks and the table stays interactive during a full sync.
"""

import csv
import json
import sys
from typing import Optional

from PyQt6.QtCore import QObject, QPoint, QRect, QRunnable, Qt, QThreadPool, QTimer, pyqtSignal
from PyQt6.QtGui import QKeySequence, QShortcut
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QComboBox,
    QDialog,
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMenu,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QSizePolicy,
    QStatusBar,
    QTableView,
    QVBoxLayout,
    QWidget,
)

from ..config import APP_NAME, APP_VERSION, missing_secrets
from ..core.hwid import detect_local_hwid
from ..core.models import LicenseRecord, LicenseStatus
from ..core.service import (
    LicensingService,
    ServiceResult,
    export_rows,
    filter_records,
    sort_records,
    today_stamp,
)
from .dialogs import (
    AuditLogDialog,
    DevicesDialog,
    EditCustomerNotesDialog,
    NewLicenseDialog,
    OfflineTokenDialog,
    QRCodeDialog,
    RenewUpgradeDialog,
    TechnicianPinRescueDialog,
    UpdateQuotasDialog,
    WhatsAppMessageDialog,
)
from .delegates import (
    ActionsColumnDelegate,
    BadgeDelegate,
    CopyCellDelegate,
    ExpiryDelegate,
    SeatBarDelegate,
)
from .panels import (
    BulkActionBar,
    Command,
    CommandPalette,
    InspectorDrawer,
)
from .table_model import (
    COL_ACTIONS,
    COL_CHECK,
    COL_CLIENT,
    COL_DESKTOPS,
    COL_EXPIRY,
    COL_FORMULA,
    COL_KEY,
    COL_MOBILES,
    COL_STATUS,
    LicenseTableModel,
)
from .theme import THEME_QSS
from .widgets import (
    DismissibleAlertBanner,
    KeyField,
    LoadingOverlay,
    MetricCard,
    PillButton,
    ServerStatusCard,
    ToastHost,
)

FORMULA_ALL = "Toutes les formules"
FORMULAS = [FORMULA_ALL, "LIFETIME", "1Y", "90D", "30D", "24H"]

PILL_FILTERS = [
    ("ALL", "⭐ Tous"),
    ("active", "🟢 Actifs"),
    ("trial", "⏳ Essais"),
    ("expired", "🔴 Expirés"),
    ("unregistered", "🟠 Non enregistrés"),
    ("EXPIRING", "⏰ Bientôt expirés"),
    ("FULL", "⚠️ Quota plein"),
]

SORT_COLUMN_BY_INDEX = {
    1: "customer",
    2: "licenseKey",
    3: "formula",
    4: "desktops",
    5: "mobiles",
    6: "status",
    7: "expiry",
}


class _ClickablePill(QLabel):
    """
    A QLabel that reports left clicks.

    The dock status pill is a dead end as plain text: the operator can see that
    something is wrong but cannot act on it. Emitting a signal keeps the
    "what does this do" knowledge in the main window instead of baking a dialog
    into a label.
    """

    clicked = pyqtSignal()

    def __init__(self, text: str = "", parent=None):
        super().__init__(text, parent)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit()
            event.accept()
            return
        super().mousePressEvent(event)


class WorkerSignals(QObject):
    """Signals for a QRunnable executed on the shared thread pool."""

    ok = pyqtSignal(object)
    fail = pyqtSignal(str)
    #: Carries the exception object. Callers that must branch on the error
    #: type (a rejected audit checkpoint vs. a network blip) connect here;
    #: str(exc) on `fail` loses that distinction.
    error = pyqtSignal(object)


class Task(QRunnable):
    """Runs a service call off the UI thread with no subclassing needed."""

    def __init__(self, fn, *args, **kwargs):
        super().__init__()
        self.signals = WorkerSignals()
        self._fn = fn
        self._args = args
        self._kwargs = kwargs
        self.setAutoDelete(True)

    def run(self):
        try:
            self.signals.ok.emit(self._fn(*self._args, **self._kwargs))
        except Exception as exc:
            self.signals.error.emit(exc)
            self.signals.fail.emit(str(exc))


class MainWindow(QMainWindow):
    """Primary application window."""

    #: Hard cap for the bottom dock. Exceeding it steals table height.
    DOCK_HEIGHT = 68

    def __init__(self):
        super().__init__()
        self.service = LicensingService()
        self.pool = QThreadPool()
        self.pool.setMaxThreadCount(4)
        self.all_records: list = []
        self.visible_records: list = []
        self.selected: Optional[LicenseRecord] = None
        self.active_pill = "ALL"
        self._sort_column = -1
        self._sort_reverse = False
        self._running = set()
        self._auto_sync = False
        self._read_only = False
        self._resetting_anchor = False
        self._anchor_banner_active = False
        self._pending_anchor_reset = None
        self._shutting_down = False
        self.audit_ok = True
        self._latency = 0.0
        self._pending = None

        # Must render exactly "Licensing for MobiPOS v3.1.0".
        self.setWindowTitle(f"{APP_NAME} v{APP_VERSION}")
        self._apply_initial_geometry()

        self._build_ui()
        self._build_shortcuts()
        self._build_timers()

        QTimer.singleShot(120, self.refresh)
        self._check_ledger_integrity()
        self._warn_missing_secrets()

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------
    def _apply_initial_geometry(self) -> None:
        """
        Size the window to the available screen, never beyond it.

        A hard-coded 1440x900 plus a 1280x760 minimum overflows a 1366x768
        laptop: the dock and the action column end up off-screen and the user
        cannot scroll to them. The minimum is relaxed to whatever the screen
        can actually show.
        """
        screen = QApplication.primaryScreen()
        available = screen.availableGeometry() if screen else None
        if available is None:
            # No screen reported (headless CI). Use the same caps as the
            # dynamic path so tests exercise the real layout, not a wider one.
            self.setMinimumSize(1024, 600)
            self.resize(1360, 820)
            return

        width = min(1360, int(available.width() * 0.94))
        height = min(820, int(available.height() * 0.88))
        min_w = min(1024, width)
        min_h = min(600, height)

        self.setMinimumSize(min_w, min_h)
        self.resize(width, height)

        # Centre on the screen rather than letting the WM choose, so the window
        # does not open partially off the left edge on multi-monitor setups.
        frame = self.frameGeometry()
        frame.moveCenter(available.center())
        self.move(frame.topLeft())

    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(18, 14, 18, 14)
        root.setSpacing(12)

        self.toasts = ToastHost(self)
        root.addWidget(self._build_header(), 0)

        # Sits directly below the header and starts hidden; the integrity and
        # secret checks raise it when there is something the operator must act
        # on. It does not auto-dismiss, unlike a toast.
        self.alert_banner = DismissibleAlertBanner("", "warning", self)
        self.alert_banner.hide()
        self.alert_banner.action_triggered.connect(self._on_reset_anchor_requested)
        root.addWidget(self.alert_banner, 0)

        root.addLayout(self._build_metrics())
        root.addWidget(self._build_toolbar(), 0)

        self.bulk_bar = BulkActionBar()
        self.bulk_bar.bulkRequested.connect(self.run_bulk_action)
        root.addWidget(self.bulk_bar, 0)

        body = QHBoxLayout()
        body.setContentsMargins(0, 0, 0, 0)
        body.setSpacing(0)
        body.addWidget(self._build_table(), 1)
        self.drawer = InspectorDrawer()
        self.drawer.closed.connect(self._on_drawer_closed)
        self.drawer.upgradeRequested.connect(self._drawer_record_action(self.open_upgrade))
        self.drawer.whatsappRequested.connect(self._drawer_record_action(self.open_whatsapp))
        self.drawer.qrRequested.connect(self._drawer_record_action(self.open_qr))
        self.drawer.quotasRequested.connect(self._drawer_record_action(self.open_quotas))
        self.drawer.devicesRequested.connect(self._drawer_record_action(self.open_devices))
        self.drawer.copyRequested.connect(self.copy_to_clipboard)
        body.addWidget(self.drawer, 0)
        root.addLayout(body, 1)

        self._expose_drawer_widgets()
        self.dock = self._build_dock()
        root.addWidget(self.dock, 0)
        self._reserve_dock_for_toasts()

        self._build_statusbar()
        self.overlay = LoadingOverlay(central, "Synchronisation avec le Cloud...")
        self.overlay.resize(central.size())
        central.installEventFilter(self)

    def _build_header(self):
        card = QFrame()
        card.setObjectName("HeaderCard")
        layout = QHBoxLayout(card)
        layout.setContentsMargins(18, 12, 18, 12)

        titles = QVBoxLayout()
        titles.setSpacing(2)
        title = QLabel(f"🛡️ {APP_NAME}")
        title.setObjectName("AppTitle")
        subtitle = QLabel("Administration des licences clients et des activations")
        subtitle.setObjectName("AppSubtitle")
        titles.addWidget(title)
        titles.addWidget(subtitle)
        layout.addLayout(titles)
        layout.addStretch()

        self.edge_badge = QLabel("⚡ Connexion…")
        self.edge_badge.setStyleSheet(
            "background-color: #1e293b; color: #94a3b8; padding: 6px 14px;"
            " border-radius: 8px; font-weight: 700; font-size: 11px;"
        )
        layout.addWidget(self.edge_badge)

        self.btn_new = self._button("➕ Nouvelle licence", "PrimaryBtn",
                                    "Créer une licence (Ctrl+N)", self.open_new_license)
        self.btn_refresh = self._button("🔄 Actualiser", "",
                                        "Rafraîchir les données (F5)", self.refresh)
        self.btn_autosync = self._button("⏱ Auto-Sync", "",
                                         "Synchronisation automatique (30 s)", self.toggle_auto_sync)
        self.btn_audit = self._button("📜 Journal", "",
                                      "Journal d'audit (Ctrl+L)", self.open_audit)
        self.btn_offline = self._button("🔏 Jeton offline", "",
                                        "Jeton Ed25519 pour machine sans Internet", self.open_offline_token)
        self.btn_rescue = self._button("🔑 Dépannage PIN", "",
                                       "Générer un code de déblocage PIN caisse (Ctrl+P)", self.open_pin_rescue)
        self.btn_csv = self._button("📊 CSV", "", "Exporter en CSV (Ctrl+E)", self.export_csv)
        self.btn_json = self._button("📤 JSON", "", "Sauvegarder en JSON (Ctrl+J)", self.export_json)

        for btn in (self.btn_new, self.btn_refresh, self.btn_autosync, self.btn_audit,
                    self.btn_offline, self.btn_rescue, self.btn_csv, self.btn_json):
            layout.addWidget(btn)

        return card

    def _build_metrics(self):
        layout = QHBoxLayout()
        layout.setSpacing(12)
        self.card_customers = MetricCard("👥 Clients")
        self.card_desktops = MetricCard("🖥️ Caisses")
        self.card_mobiles = MetricCard("📱 Mobiles")
        self.card_health = MetricCard("🛡️ Edge")
        for card in (self.card_customers, self.card_desktops,
                     self.card_mobiles, self.card_health):
            layout.addWidget(card)
        return layout

    def _build_toolbar(self):
        card = QFrame()
        card.setObjectName("ToolbarCard")
        layout = QHBoxLayout(card)
        layout.setContentsMargins(14, 8, 14, 8)
        layout.setSpacing(8)

        self.pills: dict = {}
        for key, text in PILL_FILTERS:
            pill = PillButton(key, f"{text} (0)")
            pill.clicked.connect(lambda _=False, k=key: self.set_pill(k))
            self.pills[key] = pill
            layout.addWidget(pill)

        layout.addSpacing(8)

        self.search = QLineEdit()
        self.search.setPlaceholderText("🔍 Rechercher un client, une ville, un téléphone, une clé…")
        self.search.setClearButtonEnabled(True)
        self.search.textChanged.connect(self._on_search_changed)
        layout.addWidget(self.search, stretch=2)

        layout.addWidget(QLabel("Formule :"))
        self.formula_filter = QComboBox()
        self.formula_filter.addItems(FORMULAS)
        self.formula_filter.currentIndexChanged.connect(self.apply_filters)
        layout.addWidget(self.formula_filter)

        self.count_label = QLabel("0 licence(s)")
        self.count_label.setObjectName("Muted")
        layout.addWidget(self.count_label)

        return card

    def _build_table(self):
        self.model = LicenseTableModel(self)

        self.table = QTableView()
        self.table.setModel(self.model)
        self.table.setAlternatingRowColors(True)
        self.table.setShowGrid(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.table.customContextMenuRequested.connect(self.show_context_menu)
        self.table.doubleClicked.connect(self._on_row_activated)
        self.table.verticalHeader().setVisible(False)
        self.table.verticalHeader().setDefaultSectionSize(44)

        # Painted delegates: no per-cell widgets, so scroll cost is flat
        # regardless of fleet size.
        self._copy_delegate = CopyCellDelegate(self.table)
        self.table.setItemDelegateForColumn(COL_KEY, self._copy_delegate)
        self._copy_delegate.resolveRequested.connect(self._resolve_key_at_row)
        self.table.setItemDelegateForColumn(COL_DESKTOPS, SeatBarDelegate("desktop", self.table))
        self.table.setItemDelegateForColumn(COL_MOBILES, SeatBarDelegate("mobile", self.table))
        self.table.setItemDelegateForColumn(COL_FORMULA, BadgeDelegate("formula", self.table))
        self.table.setItemDelegateForColumn(COL_STATUS, BadgeDelegate("status", self.table))
        self.table.setItemDelegateForColumn(COL_EXPIRY, ExpiryDelegate(self.table))
        self._actions_delegate = ActionsColumnDelegate(self.table)
        self.table.setItemDelegateForColumn(COL_ACTIONS, self._actions_delegate)
        self._actions_delegate.triggered.connect(self._on_row_action)

        header = self.table.horizontalHeader()
        header.setSectionsClickable(True)
        header.sectionClicked.connect(self._on_header_clicked)
        # The Client column absorbs whatever is left over; every other column
        # is fixed. stretchLastSection must stay off or it fights the explicit
        # Stretch mode on COL_CLIENT.
        header.setStretchLastSection(False)
        header.setSectionResizeMode(COL_CLIENT, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(COL_ACTIONS, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(COL_CHECK, QHeaderView.ResizeMode.Fixed)
        # Floor for the stretching column. Without it, fixed columns can consume
        # the entire viewport and Client collapses to zero width -- which is
        # what truncated the header to "iei" and the names to "Cli...".
        # When the fixed columns plus this floor exceed the viewport the table
        # scrolls horizontally rather than hiding the client name.
        header.setMinimumSectionSize(90)
        for col, width in self.DEFAULT_COLUMN_WIDTHS.items():
            self.table.setColumnWidth(col, width)
        self._restore_column_widths()
        return self.table

    #: Default width per fixed column. Also the restore budget: a persisted
    #: width may shrink a column but never grow it past DEFAULT_COLUMN_WIDTHS
    #: (persisted values predate the 3-chip action column, and letting them
    #: restore at face value starves the stretching Client column of the width
    #: that was just freed up).
    DEFAULT_COLUMN_WIDTHS = {
        COL_CHECK: 34,
        COL_KEY: 190,
        COL_FORMULA: 104,
        COL_DESKTOPS: 100,
        COL_MOBILES: 92,
        COL_STATUS: 100,
        COL_EXPIRY: 100,
        COL_ACTIONS: 112,
    }

    def _restore_column_widths(self):
        from PyQt6.QtCore import QSettings

        from ..config import APP_ID

        settings = QSettings(APP_ID, "licensing-console")
        for col, default in self.DEFAULT_COLUMN_WIDTHS.items():
            if col in (COL_CLIENT, COL_ACTIONS):
                continue
            value = settings.value(f"colWidth/{col}")
            if value is None:
                continue
            try:
                width = int(value)
            except (TypeError, ValueError):
                continue
            self.table.setColumnWidth(col, max(60, min(default, width)))

    def _persist_column_widths(self):
        from PyQt6.QtCore import QSettings

        from ..config import APP_ID

        settings = QSettings(APP_ID, "licensing-console")
        for col in (COL_KEY, COL_FORMULA, COL_DESKTOPS, COL_MOBILES, COL_STATUS, COL_EXPIRY):
            settings.setValue(f"colWidth/{col}", self.table.columnWidth(col))
    def _expose_drawer_widgets(self):
        """
        Publish the drawer's meters and title on the window.

        The seat meters used to live in a horizontal strip above the dock. They
        now live in the inspector drawer, but the bar/label pair is still
        addressed as ``window.bar_pc`` / ``window.lbl_pc`` so the regression
        guard that catches a swapped bar/label binding keeps testing a real
        pair rather than being deleted along with the old layout.
        """
        self.det_title = self.drawer.title
        self.bar_pc = self.drawer.bar_pc
        self.lbl_pc = self.drawer.lbl_pc
        self.bar_mob = self.drawer.bar_mob
        self.lbl_mob = self.drawer.lbl_mob
        self.btn_det_qr = self.drawer.btn_qr
        self.btn_det_upgrade = self.drawer.btn_upgrade
        self.btn_det_devices = self.drawer.btn_devices
        self.btn_det_wa = self.drawer.btn_whatsapp
        self.btn_det_quotas = self.drawer.btn_quotas

    def _drawer_record_action(self, handler):
        """
        Adapt a ``fn(record)`` handler to the drawer's ``(license_id)`` signals.

        The drawer only knows the id it was shown for, which may no longer be in
        ``visible_records`` after a refresh, so the id is resolved against the
        full set and falls back to whatever the drawer is currently showing.
        """

        def _dispatch(license_id: str):
            record = self._record_by_id(license_id)
            if record is None:
                self.toasts.notify("Sélectionnez d'abord une licence.", "info", 2500)
                return
            self.selected = record
            handler(record)

        return _dispatch

    def _record_by_id(self, license_id: str):
        if not license_id:
            return None
        for record in list(self.all_records) + list(self.visible_records):
            if license_id in (record.id, record.license_key):
                return record
        current = getattr(self.drawer, "_record", None)
        if current is not None and license_id in (current.id, current.license_key):
            return current
        return current

    def _on_drawer_closed(self):
        self.selected = None
        self._update_selection_badge()

    def _build_statusbar(self):
        self.status = QStatusBar()
        self.setStatusBar(self.status)
        self.status.showMessage("Prêt.")

        self.telemetry = QLabel("")
        self.telemetry.setObjectName("Muted")
        self.telemetry.setStyleSheet("color: #9CA3AF; font-size: 11px; padding: 2px 6px;")
        self.telemetry.setCursor(Qt.CursorShape.PointingHandCursor)
        self.telemetry.setToolTip("Click to copy this machine's HWID")
        self.telemetry.mousePressEvent = lambda _e: self.copy_to_clipboard(
            detect_local_hwid().get("formatted", "")
        )
        self.status.addPermanentWidget(self.telemetry)

    def _build_dock(self):
        """
        Bottom dock: fixed height, server health on the left, audit anchor on
        the right.

        The height is pinned rather than left to the layout. An unconstrained
        dock grows with its content and steals vertical space from the table,
        which is the failure that pushed rows off a 768 px screen.
        """
        dock = QFrame()
        dock.setObjectName("BottomDock")
        dock.setFixedHeight(self.DOCK_HEIGHT)
        dock.setSizePolicy(
            QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed
        )

        layout = QHBoxLayout(dock)
        layout.setContentsMargins(14, 6, 14, 6)
        layout.setSpacing(12)

        self.server_card = ServerStatusCard(self._api_host())
        layout.addWidget(self.server_card, 0)

        self.audit_anchor = QLabel("Audit: non ancré")
        self.audit_anchor.setObjectName("Muted")
        self.audit_anchor.setTextFormat(Qt.TextFormat.PlainText)
        layout.addStretch(1)

        # Centre: selection counter. The dock carries status only -- the
        # per-record actions moved into the inspector drawer.
        self.selection_badge = QLabel("")
        self.selection_badge.setObjectName("WarningPill")
        self.selection_badge.setTextFormat(Qt.TextFormat.PlainText)
        self.selection_badge.setVisible(False)
        layout.addWidget(self.selection_badge, 0)

        # Persistent degraded-mode marker. A missing secret is a standing
        # condition, not an event, so it lives inline in the dock instead of
        # firing a 7-second toast that covered the action buttons and then
        # vanished while the problem was still there.
        #
        # Clickable: the pill is the operator's only route to the secret
        # inspector, so it advertises that with a pointer cursor and a tooltip.
        self.secrets_tag = _ClickablePill("")
        self.secrets_tag.setObjectName("WarningPill")
        self.secrets_tag.setTextFormat(Qt.TextFormat.PlainText)
        self.secrets_tag.setVisible(False)
        self.secrets_tag.clicked.connect(self.open_secrets_dialog)
        layout.addWidget(self.secrets_tag, 0)

        layout.addWidget(self.audit_anchor, 0)

        self.dock_hint = QLabel("F5 actualiser · Ctrl+K commandes · Ctrl+L journal")
        self.dock_hint.setObjectName("Muted")
        self.dock_hint.setTextFormat(Qt.TextFormat.PlainText)
        layout.addWidget(self.dock_hint, 0)

        return dock

    def _reserve_dock_for_toasts(self) -> None:
        """Keep the toast stack clear of the dock and the action-button row."""
        # Covers the 68px dock plus the root layout's 14px bottom margin, so the
        # default placement already clears the dock without depending on the
        # avoid-regions below.
        self.toasts.bottom_clearance = self.DOCK_HEIGHT + 14 + 20

        # Widgets are passed directly rather than wrapped in lambdas: a lambda
        # closing over `self` would keep the window alive through the toast
        # host, and that cycle faults the collector on teardown.
        self.toasts.set_avoid_regions([
            getattr(self, "drawer", None),
            getattr(self, "dock", None),
        ])
        self.toasts.reposition()

    @staticmethod
    def _api_host() -> str:
        """Display host for the dock, without any embedded credentials."""
        from ..config import SETTINGS

        raw = (SETTINGS.endpoint or "").strip()
        if not raw:
            return "non configuré"
        # Strip scheme, path and any userinfo so a credential in the endpoint
        # can never be painted into the UI.
        return raw.split("://", 1)[-1].split("/", 1)[0].split("@")[-1]

    def _build_shortcuts(self):
        for sequence, handler in (
            ("Ctrl+N", self.open_new_license),
            ("Ctrl+R", self.refresh),
            ("F5", self.refresh),
            ("Ctrl+F", lambda: self.search.setFocus()),
            ("Ctrl+K", self.open_palette),
            ("Ctrl+L", self.open_audit),
            ("Ctrl+P", self.open_pin_rescue),
            ("Ctrl+E", self.export_csv),
            ("Ctrl+J", self.export_json),
            ("Ctrl+C", self.copy_selected_key),
            ("Ctrl+A", self.select_all_rows),
        ):
            QShortcut(QKeySequence(sequence), self, handler)

    def _build_timers(self):
        self.search_debounce = QTimer(self)
        self.search_debounce.setSingleShot(True)
        self.search_debounce.setInterval(220)
        self.search_debounce.timeout.connect(self.apply_filters)

        self.sync_timer = QTimer(self)
        self.sync_timer.setInterval(30000)
        self.sync_timer.timeout.connect(self.refresh)

        self.clock = QTimer(self)
        self.clock.setInterval(60000)
        self.clock.timeout.connect(self._tick)
        self.clock.start()

    def _tick(self):
        """Re-evaluate time-derived state so 'days left' never goes stale."""
        self.apply_filters()
        self._update_telemetry()

    def _button(self, text, object_name, tooltip, handler):
        btn = QPushButton(text)
        if object_name:
            btn.setObjectName(object_name)
        btn.setToolTip(tooltip)
        btn.setCursor(Qt.CursorShape.PointingHandCursor)
        btn.clicked.connect(lambda _=False: handler())
        return btn

    def _warn_missing_secrets(self):
        """
        Surface unconfigured secrets as a persistent inline dock tag.

        Deliberately not a toast: the condition persists until the operator
        configures the secret, so a timed toast both obscured the drawer's
        action buttons and disappeared while the problem was unresolved.

        Only genuinely required secrets count. A console whose remote signing
        works has no reason to be told it is degraded because it holds no
        offline signing key or no legacy admin token -- the worker holds the
        signing key and authenticates on MASTER_ENCRYPTION_KEY.
        """
        missing = missing_secrets()
        if not missing:
            self.secrets_tag.setVisible(False)
            self.secrets_tag.setToolTip("")
            return
        self.secrets_tag.setText(
            f"⚠ Mode dégradé · {len(missing)} secret(s) absent(s)"
        )
        self.secrets_tag.setToolTip(
            "Secrets requis non configurés : "
            + ", ".join(missing)
            + ". Cliquez pour ouvrir le detail et les saisir."
        )
        self.secrets_tag.setVisible(True)

    def open_secrets_dialog(self):
        """
        Open the secret inspector, then re-evaluate the dock.

        Settings are re-resolved after a save so the pill reflects the vault as
        it now stands instead of waiting for the next restart.
        """
        from ..config import resolve_settings
        from .dialogs import SecretsStatusDialog

        dialog = SecretsStatusDialog(parent=self)
        dialog.exec()
        try:
            config_mod = __import__(
                "licensing_app.config", fromlist=["SETTINGS"]
            )
            config_mod.SETTINGS = resolve_settings()
        except Exception:  # noqa: BLE001 - never fail the window on a refresh
            pass
        self._warn_missing_secrets()

    # ------------------------------------------------------------------
    # Data flow
    # ------------------------------------------------------------------
    def eventFilter(self, obj, event):
        if event.type() == event.Type.Resize and obj is self.centralWidget():
            self.overlay.resize(self.centralWidget().size())
        return False

    def resizeEvent(self, event):
        super().resizeEvent(event)
        # Re-cap the drawer as the window changes width, then let the table
        # re-negotiate its columns against the new free space.
        if hasattr(self, "drawer") and self.drawer is not None:
            self.drawer.apply_responsive_width(self.width())
            self.table.updateGeometry()

    def refresh(self):
        if "refresh" in self._running:
            return
        self._running.add("refresh")
        self.btn_refresh.setEnabled(False)
        self.overlay.setText("Synchronisation avec le Cloud…")
        self.overlay.show()
        self.status.showMessage("⏳ Synchronisation en cours…")

        task = Task(self.service.refresh)
        task.signals.ok.connect(self._on_result)
        task.signals.fail.connect(self._on_error)
        self._pending = task
        self.pool.start(task)

    def _on_result(self, result: ServiceResult):
        self._running.discard("refresh")
        self.btn_refresh.setEnabled(True)
        self.overlay.hide()
        self.all_records = result.records
        self._latency = result.latency_ms

        if result.healthy:
            self.edge_badge.setText(f"🟢 Edge · {result.latency_ms} ms")
            self.edge_badge.setStyleSheet(
                "background-color: #064e3b; color: #34d399; padding: 6px 14px;"
                " border-radius: 8px; font-weight: 700; font-size: 11px;"
            )
            self.card_health.setValue("Opérationnel", "#34D399")
            retry_note = f" · {result.retries} retry(s)" if result.retries else ""
            self.status.showMessage(
                f"✅ Synchronisé : {len(result.records)} licence(s) · "
                f"latence {result.latency_ms} ms{retry_note}"
            )
        else:
            self.edge_badge.setText("🔴 Hors ligne")
            self.edge_badge.setStyleSheet(
                "background-color: #450a0a; color: #fca5a5; padding: 6px 14px;"
                " border-radius: 8px; font-weight: 700; font-size: 11px;"
            )
            self.card_health.setValue("Local", "#FCA5A5")
            self.status.showMessage("⚠️ Cloud injoignable — données locales affichées.")
            self.toasts.notify(
                f"Cloud injoignable : {result.service_message}. Affichage du registre local.",
                "warning",
                6000,
            )

        self._update_telemetry()
        self.apply_filters()
        self._anchor_audit_async()

    def _anchor_audit_async(self) -> None:
        """
        Push the audit ledger head to the server in the background.

        Anchoring is a security operation, not part of the data refresh, so it
        runs on the pool and never blocks the repaint. A 409 from the worker is
        fatal for the session and is escalated to a blocking banner.
        """
        if not self.service.api_client.endpoint:
            return

        task = Task(self._anchor_audit)
        task.signals.ok.connect(self._on_anchor_ok)
        task.signals.error.connect(self._on_anchor_error)
        self._pending_anchor = task
        self.pool.start(task)

    def _anchor_audit(self):
        from ..core.audit import anchor_audit_ledger

        return anchor_audit_ledger(self.service.api_client)

    def _on_anchor_ok(self, result) -> None:
        if getattr(self, "_shutting_down", False):
            return
        self._pending_anchor = None
        self.audit_anchor.setText(
            f"Audit: {result.get('sequence_number', 0)} entrées · ancré"
        )
        self.audit_anchor.setStyleSheet("color: #34D399; font-weight: 600;")
        self.audit_anchor.setToolTip(
            f"Ancré côté serveur · head {str(result.get('head_audit_hash', ''))[:16]}…"
        )
        # A successful anchor means the server agrees with the local head, so any
        # standing 409 banner is now obsolete. Without this the banner survived a
        # successful re-anchor and kept claiming a regression the server no
        # longer reports -- the console looked locked while being fully synced.
        self._clear_anchor_banner()

    def _clear_anchor_banner(self) -> None:
        """
        Retire the audit-anchor banner only if it is the one we raised.

        The banner is shared with the ledger-integrity and missing-secret
        alerts. Hiding it unconditionally would erase an unrelated alarm the
        operator still has to act on, so the flag decides.
        """
        if not getattr(self, "_anchor_banner_active", False):
            return
        self._anchor_banner_active = False
        self.alert_banner.set_action("")
        self.alert_banner.hide()
        self._read_only = False
        self.audit_ok = True
        self.status.showMessage("Ancrage d'audit rétabli — écritures réactivées.")

    def _on_anchor_error(self, exc: Exception) -> None:
        """
        Handle a failed checkpoint.

        A 409 (AuditAnchorTamperError) means the server saw a lower sequence or
        a different head hash than before, so records were deleted or rewritten
        locally. That is fatal for the session. Anything else -- offline, DNS,
        timeout -- is transient and must not lock the operator out.
        """
        from ..core.audit import AuditAnchorTamperError

        if getattr(self, "_shutting_down", False):
            return

        self._pending_anchor = None

        if not isinstance(exc, AuditAnchorTamperError):
            self.audit_anchor.setText("Audit: ancrage indisponible")
            self.audit_anchor.setStyleSheet("color: #FCD34D; font-weight: 600;")
            self.audit_anchor.setToolTip(str(exc))
            return

        self._read_only = True
        self.audit_ok = False
        detail = str(exc)
        if exc.server_sequence is not None:
            detail = f"{detail} (séquence serveur : {exc.server_sequence})"

        self.audit_anchor.setText("Audit: ANCRAGE REFUSÉ")
        self.audit_anchor.setStyleSheet("color: #FCA5A5; font-weight: 700;")
        self.alert_banner.set_kind("error")
        self.alert_banner.set_message(
            f"SECURITY: le serveur a refusé l'ancrage du journal d'audit — {detail}. "
            "Des entrées ont été supprimées ou réécrites localement. "
            "Les écritures sont désactivées."
        )
        # The banner is the only place the operator learns about this, so it is
        # also the only place the recovery can start. Guarded by a confirmation
        # dialog because a real regression is a security event.
        self.alert_banner.set_action(
            "Réinitialiser l'ancrage Cloud",
            "Effacer le point d'ancrage serveur et repartir de zéro.\n"
            "À n'utiliser que si le journal local a été perdu ou restauré "
            "depuis une sauvegarde.",
        )
        self.alert_banner.show()
        self._anchor_banner_active = True
        self.status.showMessage("⛔ Ancrage d'audit refusé — mode lecture seule.")

    def _on_reset_anchor_requested(self) -> None:
        """
        Operator-confirmed recovery from a false audit lockout.

        A 409 is treated as a security event everywhere else in this class, and
        that is right. This is the one deliberate exception: when the local
        ledger was lost (wiped machine, restored backup, reinstall) the server
        baseline outlives it and no legitimate sequence can ever clear the
        guard, so the console is bricked by a non-attack. The operator has to
        confirm explicitly, and the discarded checkpoint is reported back
        rather than silently dropped.
        """
        from PyQt6.QtWidgets import QMessageBox

        from ..core.audit import client_identifier

        confirm = QMessageBox.warning(
            self,
            "Réinitialiser l'ancrage d'audit",
            "Cette opération efface le point d'ancrage d'audit stocké côté Cloud "
            "et permet au journal local de repartir de zéro.\n\n"
            "À faire uniquement si le journal local a été perdu (machine "
            "réinstallée, sauvegarde restaurée). Si vous suspectez une "
            "altération délibérée, n'utilisez PAS cette option et restaurez "
            "le journal depuis une sauvegarde.\n\n"
            "Continuer ?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Cancel,
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return

        # On the pool, not inline. This is a network call to the edge with a
        # 10s timeout; run synchronously it froze the window solid, which is
        # indistinguishable from the request having hung with no feedback.
        self._resetting_anchor = True
        self._running.add("anchor-reset")
        task = Task(self._reset_anchor_worker)
        task.signals.ok.connect(self._on_reset_anchor_ok)
        task.signals.error.connect(self._on_reset_anchor_failed)
        self._pending_anchor_reset = task
        self.pool.start(task)

    def _reset_anchor_worker(self):
        from ..core.audit import client_identifier

        return self.service.api_client.reset_audit_anchor(client_identifier())

    def _on_reset_anchor_ok(self, result) -> None:
        if getattr(self, "_shutting_down", False):
            return
        self._pending_anchor_reset = None
        self._resetting_anchor = False
        self._running.discard("anchor-reset")

        # The worker reports a cleared anchor as status="reset"; anything else
        # means the edge answered 200 without doing the work. Treating a
        # missing status as success is how a failed reset looks like a working
        # one.
        if result.get("status") != "reset":
            self._on_reset_anchor_failed(
                ValueError(
                    f"réponse inattendue du worker : {result.get('error') or result}"
                )
            )
            return

        self._clear_anchor_banner()
        discarded = result.get("discarded_checkpoint")
        if discarded:
            self.toasts.notify(
                "Ancrage Cloud réinitialisé "
                f"(séquence serveur écartée : {discarded.get('sequence_number')}).",
                "success",
                6000,
            )
        else:
            self.toasts.notify("Ancrage Cloud réinitialisé.", "success", 5000)

        # Re-anchor immediately so the status bar returns to a truthful,
        # server-confirmed state rather than waiting for the next F5.
        self._anchor_audit_async()

    def _on_reset_anchor_failed(self, exc: Exception) -> None:
        """
        Report a failed reset loudly and leave the operator able to retry.

        The action button is deliberately left in place. A toast that fades
        after a few seconds, on a console that is still locked out, reads as
        silence; the operator needs an unmissable message and a live retry.
        """
        from PyQt6.QtWidgets import QMessageBox

        if getattr(self, "_shutting_down", False):
            return

        self._pending_anchor_reset = None
        self._resetting_anchor = False
        self._running.discard("anchor-reset")

        detail = str(exc)
        if isinstance(exc, Exception) and getattr(exc, "response", None) is not None:
            resp = exc.response
            try:
                body = resp.json()
                detail = body.get("message") or body.get("error") or detail
            except Exception:  # noqa: BLE001 - non-JSON error body
                pass
            detail = f"HTTP {resp.status_code} — {detail}"

        QMessageBox.critical(
            self,
            "Réinitialisation de l'ancrage impossible",
            f"La réinitialisation de l'ancrage d'audit a échoué :\n\n{detail}\n\n"
            "La console reste en lecture seule. Vous pouvez réessayer depuis "
            "ce bouton, ou lancer :\n"
            "    python scripts/reset_audit_anchor.py",
        )

    def _on_error(self, message: str):
        self._running.discard("refresh")
        self.btn_refresh.setEnabled(True)
        self.overlay.hide()
        self.all_records = self.service.local_only().records
        self.apply_filters()
        self.toasts.notify(f"Échec de la synchronisation : {message}", "error", 6000)

    def _check_ledger_integrity(self):
        """
        Verify the hash-chained audit ledger at startup.

        On failure the console switches to read-only rather than writing more
        entries over a tampered file.
        """
        from ..core.audit import integrity_status

        status = integrity_status()
        self.audit_ok = bool(status.get("ok"))
        if not self.audit_ok:
            self._read_only = True
            message = (
                f"SECURITY: audit ledger integrity check failed — {status.get('error')}. "
                "Writes are disabled until this is resolved."
            )
            # The banner persists: an operator must acknowledge tampering, so
            # this is not a transient toast.
            self.alert_banner.set_kind("error")
            self.alert_banner.set_message(message)
            self.alert_banner.show()
            self.audit_anchor.setText("Audit: INTÉGRITÉ COMPROMISE")
            self.audit_anchor.setStyleSheet("color: #FCA5A5; font-weight: 700;")
            self.toasts.notify(message, "error", 0)
            self.status.showMessage("⛔ Audit ledger integrity failure — read-only mode.")
        return self.audit_ok

    def _update_telemetry(self):
        """Footer: latency, ledger state, local machine HWID, pending writes."""
        from ..core.audit import integrity_status

        audit = integrity_status()
        hwid = detect_local_hwid().get("formatted", "")
        pending = sum(1 for r in self.all_records if r.sync_status.value != "synced")
        self.telemetry.setText(
            f"Cloud: {self._latency:.0f}ms   ·   "
            f"Ledger: {audit.get('count', 0)} records "
            f"{'OK' if audit.get('ok') else 'TAMPERED'}   ·   "
            f"Pending: {pending}   ·   This machine: {hwid}"
        )

        # Dock mirror of the same state, so the server card and the audit
        # anchor stay in step with the footer text.
        if not audit.get("ok"):
            state = "offline" if not self._latency else "online"
            self.server_card.set_state(
                state, "intégrité ledger compromise"
            )
        elif self._latency <= 0:
            self.server_card.set_state("unknown", "en attente")
        elif self._latency > 1500:
            self.server_card.set_state("slow", f"{self._latency:.0f} ms")
        else:
            self.server_card.set_state("online", f"{self._latency:.0f} ms")

        if not self.audit_ok:
            # _check_ledger_integrity already raised the banner and styled this
            # label red; do not overwrite it with a healthy-looking count.
            return

        self.audit_anchor.setText(f"Audit: {audit.get('count', 0)} entrées · ancré")
        self.audit_anchor.setStyleSheet("color: #34D399; font-weight: 600;")

    def _on_search_changed(self, _text: str):
        self.search_debounce.start()

    def set_pill(self, key: str):
        self.active_pill = key
        for pill_key, pill in self.pills.items():
            pill.setActive(pill_key == key)
        self.apply_filters()

    def apply_filters(self):
        formula = self.formula_filter.currentText()
        self.visible_records = filter_records(
            self.all_records,
            query=self.search.text(),
            formula="" if formula == FORMULA_ALL else formula,
            status_filter=self.active_pill,
        )
        self._render()

    def _render(self):
        records = self.visible_records
        counts = {
            "active": sum(1 for r in records if r.status is LicenseStatus.ACTIVE),
            "trial": sum(1 for r in records if r.status is LicenseStatus.TRIAL),
            "expired": sum(1 for r in records if r.status is LicenseStatus.EXPIRED),
            "unregistered": sum(1 for r in records if r.status is LicenseStatus.UNREGISTERED),
            "EXPIRING": sum(
                1 for r in records
                if r.status is not LicenseStatus.ACTIVE and (r.is_expiring_soon or r.is_expired)
            ),
            "FULL": sum(1 for r in records if r.is_full),
        }
        for key, pill in self.pills.items():
            base = dict(PILL_FILTERS)[key]
            pill.setText(f"{base} ({counts.get(key, len(records))})")

        self.model.set_records(records)
        self.count_label.setText(f"{len(records)} sur {len(self.all_records)} licence(s)")

        self.card_customers.setValue(str(len(self.all_records)))
        self.card_desktops.setValue(
            f"{sum(r.active_desktops for r in self.all_records)} / "
            f"{sum(r.max_desktops for r in self.all_records)}"
        )
        self.card_mobiles.setValue(
            f"{sum(r.active_mobiles for r in self.all_records)} / "
            f"{sum(r.max_mobiles for r in self.all_records)}"
        )

    # ------------------------------------------------------------------
    # Selection
    # ------------------------------------------------------------------
    def _on_row_activated(self, index):
        row = index.row() if hasattr(index, "row") else int(index)
        record = self.model.record_at(row)
        if record:
            # Double-click opens the slide-over inspector rather than a modal
            # dialog, so the list stays visible for comparison.
            self._open_drawer(record)

    def _on_row_action(self, action_id: str, row: int):
        """Route a click on an inline action chip to the matching handler."""
        record = self.model.record_at(row)
        if not record:
            return
        handlers = {
            "qr": lambda: self.open_qr(record),
            "desktops": lambda: self.open_devices(record),
            "whatsapp": lambda: self.open_whatsapp(record),
            "quotas": lambda: self.open_quotas(record),
            "upgrade": lambda: self.open_upgrade(record),
        }
        handler = handlers.get(action_id)
        if handler is not None:
            handler()
            return
        if action_id == "more":
            # The overflow chip opens the same context menu as a right-click, at
            # the cell, so the two paths cannot drift apart.
            cell = self.table.visualRect(self.model.index(row, COL_ACTIONS))
            self.show_context_menu(cell.center())

    def current_record(self):
        indexes = self.table.selectionModel().selectedRows() if self.table.selectionModel() else []
        if not indexes:
            return None
        return self.model.record_at(indexes[0].row())

    def select_all_rows(self):
        self.model.select_all()
        self.bulk_bar.set_count(len(self.model.checked_rows()))

    def _open_drawer(self, record: LicenseRecord):
        self.selected = record
        self._sync_selection()
        self.drawer.show_for(record)

    def _with_selection(self, fn):
        record = self.current_record() or self.selected
        if record is None:
            self.toasts.notify("Sélectionnez d'abord une licence.", "info", 2500)
            return
        fn(record)

    def copy_selected_key(self):
        record = self.current_record() or self.selected
        if record is None:
            return
        payload = self._resolve_missing_key(record)
        if payload is None:
            return
        key = payload.get("licenseKey", "")
        if not key:
            self.toasts.notify(
                "Aucun identifiant à copier : utilisez l'option Cloud ID.",
                "info",
                3000,
            )
            return
        self.copy_to_clipboard(key)

    def copy_to_clipboard(self, text: str):
        if not text:
            self.toasts.notify("Rien à copier.", "info", 2000)
            return
        QApplication.clipboard().setText(text)
        self.toasts.notify(f"Copié : {text}", "success", 2200)

    def _sync_selection(self):
        record = self.current_record()
        if record is None:
            # Deselecting must reset the drawer. Returning early here left the
            # previous customer's details and the enabled buttons on screen,
            # so an action could be fired against a record that was no longer
            # selected.
            self.clear_selection()
            return
        self.selected = record
        self.drawer.show_for(record)
        self._update_selection_badge()

    def _update_selection_badge(self):
        """Centre-of-dock selection counter."""
        selection = self.table.selectionModel()
        count = len(selection.selectedRows()) if selection is not None else 0
        if count == 1:
            text = "1 licence sélectionnée"
        elif count > 1:
            text = f"{count} licences sélectionnées"
        else:
            text = ""
        self.selection_badge.setText(text)
        self.selection_badge.setVisible(bool(text))

    def clear_selection(self):
        self.selected = None
        self.drawer.clear()
        self.drawer.hide()
        self._update_selection_badge()

    # ------------------------------------------------------------------
    # Sorting & menus
    # ------------------------------------------------------------------
    def _on_header_clicked(self, column: int):
        if self._sort_column == column:
            self._sort_reverse = not self._sort_reverse
        else:
            self._sort_column = column
            self._sort_reverse = False
        key = SORT_COLUMN_BY_INDEX.get(column)
        if key:
            self.visible_records = sort_records(
                self.visible_records, key, self._sort_reverse
            )
            self.model.set_records(self.visible_records)

    def show_context_menu(self, pos):
        index = self.table.indexAt(pos)
        if not index.isValid():
            return
        record = self.model.record_at(index.row())
        if record is None:
            return
        self.table.selectRow(index.row())
        self._sync_selection()

        menu = QMenu(self)
        copy_key = menu.addAction("📋 Copier la clé d'activation")
        copy_machine = menu.addAction("🖥️ Copier l'identifiant machine local")
        menu.addSeparator()
        act_qr = menu.addAction("📱 QR code d'activation")
        act_wa = menu.addAction("💬 Envoyer sur WhatsApp")
        act_dev = menu.addAction(f"🖥️ Appareils connectés ({record.total_devices})")
        act_quo = menu.addAction("⚙️ Modifier les quotas")
        act_ren = menu.addAction("⭐ Surclasser / Prolonger")
        act_not = menu.addAction("✏️ Modifier contact & notes")
        menu.addSeparator()
        act_toggle = menu.addAction(
            "⏸️ Suspendre" if record.raw_status == "active" else "▶️ Réactiver"
        )
        act_reset = menu.addAction("🔄 Déconnecter tous les postes")
        act_offline = menu.addAction("🔏 Jeton offline (Ed25519)")
        act_rescue = menu.addAction("🔑 Dépannage PIN client")
        menu.addSeparator()
        act_del = menu.addAction("🗑️ Supprimer du registre local")

        chosen = menu.exec(self.table.viewport().mapToGlobal(pos))
        dispatch = {
            copy_key: lambda: self.copy_to_clipboard(record.license_key),
            copy_machine: lambda: self.copy_to_clipboard(self._local_hwid()),
            act_qr: lambda: self.open_qr(record),
            act_wa: lambda: self.open_whatsapp(record),
            act_dev: lambda: self.open_devices(record),
            act_quo: lambda: self.open_quotas(record),
            act_ren: lambda: self.open_upgrade(record),
            act_not: lambda: self.open_notes(record),
            act_toggle: lambda: self.toggle_status(record),
            act_reset: lambda: self.reset_seats(record),
            act_offline: lambda: self.open_offline_token(record),
            act_rescue: lambda: self.open_pin_rescue(record),
            act_del: lambda: self.delete_license(record),
        }
        handler = dispatch.get(chosen)
        if handler:
            handler()

    @staticmethod
    def _local_hwid() -> str:
        from ..core.crypto import detect_local_hwid

        return detect_local_hwid().get("formatted", "")

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------
    def toggle_auto_sync(self):
        self._auto_sync = not self._auto_sync
        if self._auto_sync:
            self.sync_timer.start()
            self.btn_autosync.setText("⏱ Auto-Sync ON")
            self.toasts.notify("Synchronisation automatique activée (30 s).", "success", 2200)
        else:
            self.sync_timer.stop()
            self.btn_autosync.setText("⏱ Auto-Sync")
            self.toasts.notify("Synchronisation automatique désactivée.", "info", 2200)

    def open_new_license(self):
        dialog = NewLicenseDialog(self.service.api_client, self)
        dialog.license_created.connect(lambda _r: self.refresh())
        dialog.exec()

    def _resolve_key_at_row(self, row: int) -> None:
        """Open the resolution modal for a clicked unresolved key cell."""
        record = self.model.record_at(row)
        if record is None or record.has_plaintext_key:
            return
        self._resolve_missing_key(record)

    def _make_missing_key_dialog(self, record):
        """
        Build the resolution modal.

        Split out so a test can substitute a stub without opening a real modal;
        QDialog.exec is a C++ slot and cannot be monkeypatched on the class.
        """
        from .dialogs import ResolveMissingKeyDialog

        return ResolveMissingKeyDialog(record, self.service.api_client, self)

    def _resolve_missing_key(self, record) -> Optional[dict]:
        """
        Offer the resolution modal when a licence has no plaintext key.

        Returns the payload to continue with, or None when the operator
        cancelled. Before this, WhatsApp/QR/Copy opened a dialog that opened a
        "Clé Inconnue" warning and stopped -- the operator could not service,
        copy, or hand over credentials for a licence that exists perfectly
        well in the cloud.
        """
        if record is None or record.has_plaintext_key:
            return record.to_dict() if record is not None else None

        from .dialogs import ResolveMissingKeyDialog

        dialog = self._make_missing_key_dialog(record)
        dialog.key_resolved.connect(lambda _lid, _k: self.refresh())
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return None

        payload = record.to_dict()
        if dialog.use_cloud_id:
            # Path C: no plaintext key, but the QR can still carry the cloud id
            # the phone validates against.
            payload["licenseKey"] = ""
            payload["cloudId"] = record.id
            return payload

        key = dialog.resolved_key
        if not key:
            return None
        payload["licenseKey"] = key
        # Keep the in-memory record consistent so a follow-up action in the same
        # session does not re-open the modal.
        record.license_key = key
        self.apply_filters()
        return payload

    def open_qr(self, record):
        payload = self._resolve_missing_key(record)
        if payload is None:
            return
        QRCodeDialog(payload, self).exec()

    def open_whatsapp(self, record):
        payload = self._resolve_missing_key(record)
        if payload is None:
            return
        WhatsAppMessageDialog(payload, self).exec()

    def open_notes(self, record):
        dialog = EditCustomerNotesDialog(record.to_dict(), self)
        dialog.metadata_updated.connect(lambda _r: self.refresh())
        dialog.exec()

    def open_upgrade(self, record):
        dialog = RenewUpgradeDialog(record.to_dict(), self.service.api_client, self)
        dialog.license_upgraded.connect(lambda _r: self.refresh())
        dialog.exec()

    def open_quotas(self, record):
        payload = self._resolve_missing_key(record)
        if payload is None:
            return
        dialog = UpdateQuotasDialog(payload, self.service.api_client, self)
        dialog.quotas_updated.connect(lambda _r: self.refresh())
        dialog.exec()

    def open_devices(self, record):
        # Routed through the resolver for the same reason as QR/WhatsApp: the
        # devices dialog needs the plaintext key to call the edge, and used to
        # stop at an empty list with a warning.
        payload = self._resolve_missing_key(record)
        if payload is None:
            return
        dialog = DevicesDialog(payload, self.service.api_client, self)
        dialog.devices_changed.connect(lambda: self.refresh())
        dialog.exec()

    def open_audit(self):
        AuditLogDialog(self).exec()

    def open_offline_token(self, record=None):
        target = record or self.selected
        OfflineTokenDialog(
            default_license=target.to_dict() if target else None, parent=self
        ).exec()

    def open_pin_rescue(self, record=None):
        target = record or self.selected
        customer = target.customer if target else ""
        phone = target.phone if target else ""
        TechnicianPinRescueDialog(customer=customer, phone=phone, parent=self).exec()

    def toggle_status(self, record: LicenseRecord):
        if not record.has_plaintext_key:
            # A toast here was a dead end: it named the problem and offered no
            # way out. Route through the resolver so the operator can actually
            # service the licence.
            self._resolve_missing_key(record)
            return
        new_status = "suspended" if record.raw_status == "active" else "active"
        confirm = QMessageBox.question(
            self,
            "Confirmer",
            f"Passer la licence de {record.customer} à {new_status.upper()} ?",
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return
        self._run_action(
            lambda: self.service.set_status(record.license_key, new_status),
            f"Statut mis à jour : {new_status.upper()}",
        )

    def reset_seats(self, record: LicenseRecord):
        if not record.has_plaintext_key:
            self._resolve_missing_key(record)
            return
        confirm = QMessageBox.question(
            self,
            "Déconnecter les postes",
            f"Déconnecter tous les postes de {record.customer} ? Ils pourront se reconnecter.",
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return

        def task():
            cleared, error = self.service.reset_seats(record.license_key)
            if error:
                return False, error, None
            from ..core.api import record_audit_event

            record_audit_event("RESET_SEATS", f"{cleared} poste(s) libéré(s)",
                               record.customer, record.license_key)
            return True, f"{cleared} poste(s) libéré(s).", None

        self._run_action(task, "Postes déconnectés.")

    def delete_license(self, record: LicenseRecord):
        confirm = QMessageBox.question(
            self,
            "Supprimer du registre",
            f"Supprimer {record.customer} du registre local ?",
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return
        from ..core.api import delete_from_ledger, record_audit_event

        delete_from_ledger(record.id, record.license_key)
        record_audit_event("DELETE_LOCAL", f"Suppression locale de {record.customer}",
                           record.customer, record.license_key)
        self.toasts.notify("Licence supprimée du registre local.", "success")
        self.refresh()

    def _run_action(self, task, success_message: str):
        """Run a service mutation on the thread pool."""
        if self._read_only:
            self.toasts.notify(
                "Read-only: the audit ledger failed verification.", "error", 5000
            )
            return

        def wrapped():
            ok, message, payload = task()
            return ok, message or (success_message if ok else ""), payload

        job = Task(wrapped)
        job.signals.ok.connect(self._on_action_done)
        job.signals.fail.connect(
            lambda exc: self.toasts.notify(f"Erreur : {exc}", "error", 6000)
        )
        self._pending = job
        self.pool.start(job)

    def _on_action_done(self, result):
        ok, message, _payload = result
        self.overlay.hide()
        if ok:
            self.toasts.notify(message or "Opération réussie.", "success")
        else:
            self.toasts.notify(message or "L'opération a échoué.", "error", 6000)
        self.refresh()

    # ------------------------------------------------------------------
    # Bulk operations
    # ------------------------------------------------------------------
    def run_bulk_action(self, action: str, amount: int):
        """
        Apply an operation to every checked row.

        Runs the batch off the UI thread and reports a per-item tally, because
        a partial failure is the normal case when the cloud is flaky.
        """
        records = self.model.checked_records()
        if not records:
            self.toasts.notify("Sélectionnez au moins une licence.", "info", 2500)
            return

        usable = [r for r in records if r.has_plaintext_key]
        skipped = len(records) - len(usable)
        if not usable:
            self.toasts.notify(
                "Aucune licence sélectionnée n'a de clé en clair.", "warning", 5000
            )
            return

        if action == "export":
            self._export_records(usable, f"mobi_selection_{today_stamp()}.csv")
            return

        confirm = QMessageBox.question(
            self,
            "Opération groupée",
            f"Appliquer « {action} » à {len(usable)} licence(s) ?",
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return

        def batch():
            succeeded, failed = 0, []
            for record in usable:
                if action == "seat":
                    ok, error = self.service.update_quotas(
                        record.license_key,
                        record.max_desktops + amount,
                        record.max_mobiles,
                    )
                else:  # days
                    ok, error = self._extend(record, amount)
                if ok:
                    succeeded += 1
                else:
                    failed.append(f"{record.customer}: {error}")
            return {"ok": succeeded, "failed": failed, "skipped": skipped}

        self.overlay.setText(f"Application sur {len(usable)} licence(s)…")
        self.overlay.show()
        job = Task(batch)
        job.signals.ok.connect(self._on_bulk_done)
        job.signals.fail.connect(
            lambda exc: self.toasts.notify(f"Erreur : {exc}", "error", 6000)
        )
        self._pending = job
        self.pool.start(job)

    def _extend(self, record: LicenseRecord, days: int) -> tuple:
        """Push an expiry forward by `days` via the quota/sync endpoint."""
        import datetime

        from ..core.api import record_audit_event
        from ..core.api import AdminApiClient as _Api

        current = record.expires_at
        base = None
        if current and current != "NONE":
            from ..core.models import parse_datetime

            base = parse_datetime(current)
        if base is None:
            base = datetime.datetime.now(datetime.timezone.utc)
        new_expiry = (base + datetime.timedelta(days=days)).isoformat()

        payload = record.to_dict()
        payload["expiresAt"] = new_expiry
        try:
            ok = self.service.api_client.sync_license(payload)
        except Exception as exc:
            return False, str(exc)
        if ok:
            record_audit_event(
                "EXTEND", f"+{days}j -> {new_expiry}", record.customer, record.license_key
            )
        return ok, "" if ok else "server refused the update"

    def _on_bulk_done(self, result):
        self.overlay.hide()
        succeeded = result.get("ok", 0)
        failed = result.get("failed", [])
        skipped = result.get("skipped", 0)
        parts = [f"{succeeded} licence(s) mise(s) à jour"]
        if skipped:
            parts.append(f"{skipped} ignorée(s) sans clé")
        if failed:
            parts.append(f"{len(failed)} en échec")
        self.toasts.notify(" · ".join(parts), "success" if not failed else "warning", 5000)
        if failed:
            self.toasts.notify(f"{failed[0]}", "error", 8000)
        self.model.clear_checked()
        self.bulk_bar.set_count(0)
        self.refresh()

    # ------------------------------------------------------------------
    # Command palette
    # ------------------------------------------------------------------
    def open_palette(self):
        palette = CommandPalette(self._palette_commands(), self)
        palette.exec()

    def _palette_commands(self):
        from ..config import vault_import_file

        commands = [
            Command("New License", self.open_new_license, "create add", "Ctrl+N"),
            Command("Sync Cloud Now", self.refresh, "refresh pull", "F5"),
            Command("Export Selection to CSV", self.export_csv, "download save", "Ctrl+E"),
            Command("Export Ledger to JSON", self.export_json, "backup", "Ctrl+J"),
            Command("Open Audit Log", self.open_audit, "history security", "Ctrl+L"),
            Command("Dépannage PIN Caisse", self.open_pin_rescue, "rescue pin reset unlock gérant", "Ctrl+P"),
            Command("Filter: Expiring this week", lambda: self.set_pill("EXPIRING"), "soon"),
            Command("Filter: Quota full", lambda: self.set_pill("FULL"), "seats"),
            Command("Filter: All licences", lambda: self.set_pill("ALL"), "reset"),
            Command("Toggle Auto-Sync (30s)", self.toggle_auto_sync, "polling"),
            Command("Select all visible", self.select_all_rows, "bulk check"),
            Command("Copy this machine HWID",
                    lambda: self.copy_to_clipboard(detect_local_hwid().get("formatted", "")),
                    "fingerprint id"),
            Command("Verify Audit Ledger Integrity", self._check_ledger_integrity, "tamper security"),
            Command("Clear audit log", self._clear_audit, "wipe history"),
            Command("Import secrets from file…", self._import_secrets, "keyring dpapi vault"),
            Command("Open Office Hours", lambda: None, "meeting schedule"),
        ]
        if not self.service.api_client.token and not self.service.api_client.master_key:
            commands.append(
                Command("Sign in / configure API token", self._import_secrets, "auth")
            )
        return commands

    def _import_secrets(self):
        from PyQt6.QtWidgets import QFileDialog

        from ..config import vault_import_file

        path, _ = QFileDialog.getOpenFileName(
            self, "Import secrets", "", "JSON Files (*.json);;All Files (*)"
        )
        if not path:
            return
        from pathlib import Path

        ok, message = vault_import_file(Path(path))
        self.toasts.notify(message, "success" if ok else "error", 6000)
        if ok:
            self.toasts.notify("Restart the app to apply the new secrets.", "info", 6000)

    def _clear_audit(self):
        from ..core.audit import clear_audit_log

        confirm = QMessageBox.question(
            self, "Clear audit log", "Erase the entire audit history? This cannot be undone."
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return
        ok = clear_audit_log()
        self.toasts.notify(
            "Audit log cleared." if ok else "Could not clear the audit log.",
            "success" if ok else "error",
        )
        self._check_ledger_integrity()


    # ------------------------------------------------------------------
    # Exports
    # ------------------------------------------------------------------
    def export_csv(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "Exporter en CSV", f"mobi_clients_{today_stamp()}.csv",
            "CSV Files (*.csv);;All Files (*)",
        )
        if not path:
            return
        try:
            with open(path, "w", encoding="utf-8-sig", newline="") as handle:
                csv.writer(handle, delimiter=";").writerows(
                    export_rows(self.visible_records)
                )
        except OSError as exc:
            self.toasts.notify(f"Export impossible : {exc}", "error", 6000)
            return
        from ..core.api import record_audit_event

        record_audit_event("EXPORT_CSV", f"Export CSV : {path}")
        self.toasts.notify(f"CSV exporté : {path}", "success", 4000)

    def export_json(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "Exporter en JSON", f"mobi_licenses_{today_stamp()}.json",
            "JSON Files (*.json);;All Files (*)",
        )
        if not path:
            return
        payload = {
            "exportedAt": today_stamp(),
            "licenses": [r.to_dict() for r in self.visible_records],
        }
        try:
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, ensure_ascii=False)
        except OSError as exc:
            self.toasts.notify(f"Export impossible : {exc}", "error", 6000)
            return
        from ..core.api import record_audit_event

        record_audit_event("EXPORT_JSON", f"Export JSON : {path}")
        self.toasts.notify(f"JSON exporté : {path}", "success", 4000)

    def _export_records(self, records, filename: str):
        path, _ = QFileDialog.getSaveFileName(
            self, "Exporter la sélection", filename, "CSV Files (*.csv);;All Files (*)"
        )
        if not path:
            return
        try:
            with open(path, "w", encoding="utf-8-sig", newline="") as handle:
                csv.writer(handle, delimiter=";").writerows(export_rows(records))
        except OSError as exc:
            self.toasts.notify(f"Export impossible : {exc}", "error", 6000)
            return
        self.toasts.notify(f"{len(records)} ligne(s) exportée(s).", "success", 4000)

    # ------------------------------------------------------------------
    def selectionChanged(self, selected, deselected):
        super().selectionChanged(selected, deselected)
        if selected:
            self._sync_selection()

    def closeEvent(self, event):
        """
        Shut down cleanly: stop timers, then drain the worker pool.

        The toast host is detached first. It is a child widget that observes
        the window's resize events and calls mapTo() on the dock and the
        inspector's button row; once the window starts tearing those down,
        those calls run against half-destroyed C++ objects and take the
        process down with 0xC0000409 rather than raising anything Python can
        catch.
        """
        try:
            self.toasts.detach()
        except Exception:
            pass

        # Order matters. A repeating QTimer can enqueue a new Task while the pool
        # is draining, and any Task still running when the window's C++ object is
        # destroyed will emit into freed memory. Both the sync clock and the
        # auto-sync timer must be stopped before waiting, and the wait must not be
        # abandoned while work is outstanding.
        self._persist_column_widths()

        for timer in (
            getattr(self, "clock", None),
            getattr(self, "sync_timer", None),
            getattr(self, "search_debounce", None),
        ):
            if timer is not None:
                timer.stop()

        self._auto_sync = False

        # Cut the queued-signal path before draining. A Task finishing on a pool
        # thread emits with an auto-connection, so the slot invocation is queued
        # to the main thread and delivered *after* this event handler returns --
        # by which point the receiver's C++ object can already be gone, which is
        # a use-after-free (0xC0000409) rather than a catchable Python error.
        # Disconnecting the outstanding tasks makes the late delivery a no-op.
        self._shutting_down = True
        for task in (
            getattr(self, "_pending_anchor", None),
            getattr(self, "_pending_anchor_reset", None),
        ):
            if task is not None:
                try:
                    task.signals.ok.disconnect()
                    task.signals.error.disconnect()
                    task.signals.fail.disconnect()
                except (RuntimeError, TypeError):
                    # Already torn down; nothing left to disconnect.
                    pass

        # clear() drops queued tasks that have not started; waitForDone() then
        # covers the ones already on a thread. Requests carry a 6-15 s timeout,
        # so allow enough time that no worker outlives this object.
        self.pool.clear()
        if not self.pool.waitForDone(15000):
            # A worker is still in flight. Let it finish rather than tear down
            # underneath it; the process is closing either way.
            self.pool.waitForDone()

        super().closeEvent(event)


def main():
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    app.setApplicationVersion(APP_VERSION)
    app.setOrganizationName("MobiPOS")
    app.setStyleSheet(THEME_QSS)
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())

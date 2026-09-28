"""
MobiPOS Professional License Administration Desktop Suite (v2.1 Enterprise)
High-level desktop UI for comprehensive client and license management.
Optimized for High-DPI Windows displays, anti-clipping, live device telemetry,
QR Code generation, contact management, renewal workflows, and security audit trail.
Built with Python 3 and PyQt6.
"""

import csv
import datetime
import json
import os
import re
import sys
from pathlib import Path
from typing import List, Dict, Any, Optional

# 1. Enable High-DPI scaling before Qt initializes
os.environ["QT_AUTO_SCREEN_SCALE_FACTOR"] = "1"
os.environ["QT_ENABLE_HIGHDPI_SCALING"] = "1"

# 2. Ensure both admin_desktop directory and project root are in sys.path
_current_dir = Path(__file__).resolve().parent
_parent_dir = _current_dir.parent
if str(_current_dir) not in sys.path:
    sys.path.insert(0, str(_current_dir))
if str(_parent_dir) not in sys.path:
    sys.path.insert(0, str(_parent_dir))

from PyQt6.QtCore import Qt, QThread, pyqtSignal, QTimer, QPoint
from PyQt6.QtGui import QFont, QColor, QIcon, QShortcut, QKeySequence
from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QGridLayout, QLabel, QPushButton, QLineEdit, QComboBox,
    QTableWidget, QTableWidgetItem, QHeaderView, QFrame,
    QStatusBar, QMessageBox, QFileDialog, QProgressBar, QMenu
)

try:
    from admin_desktop.config import (
        APP_NAME, APP_VERSION, CLOUD_LICENSING_ENDPOINT, LEDGER_PATH,
        MASTER_ENCRYPTION_KEY
    )
    from admin_desktop.crypto import normalize_key
    from admin_desktop.api import (
        AdminApiClient, load_ledger, save_ledger, record_in_ledger,
        merge_cloud_and_ledger, delete_from_ledger, record_audit_event
    )
    from admin_desktop.styles import (
        DARK_THEME_QSS, status_badge, formula_badge, seats_badge
    )
    from admin_desktop.dialogs import (
        NewLicenseDialog, DevicesDialog, UpdateQuotasDialog,
        WhatsAppMessageDialog, OfflineTokenDialog, QRCodeDialog,
        EditCustomerNotesDialog, RenewUpgradeDialog, AuditLogDialog
    )
except (ImportError, ValueError):
    from config import (
        APP_NAME, APP_VERSION, CLOUD_LICENSING_ENDPOINT, LEDGER_PATH,
        MASTER_ENCRYPTION_KEY
    )
    from crypto import normalize_key
    from api import (
        AdminApiClient, load_ledger, save_ledger, record_in_ledger,
        merge_cloud_and_ledger, delete_from_ledger, record_audit_event
    )
    from styles import (
        DARK_THEME_QSS, status_badge, formula_badge, seats_badge
    )
    from dialogs import (
        NewLicenseDialog, DevicesDialog, UpdateQuotasDialog,
        WhatsAppMessageDialog, OfflineTokenDialog, QRCodeDialog,
        EditCustomerNotesDialog, RenewUpgradeDialog, AuditLogDialog
    )


class RefreshWorker(QThread):
    """
    Background worker to ping Cloudflare Worker Edge and fetch licenses.
    Prevents UI freezing on network calls.
    """
    data_loaded = pyqtSignal(list, float, bool, str)
    error_occurred = pyqtSignal(str)

    def __init__(self, api_client: AdminApiClient):
        super().__init__()
        self.api_client = api_client

    def run(self):
        try:
            # 1. Health check
            healthy, latency, service_msg = self.api_client.check_health()

            # 2. Cloud licenses
            cloud_licenses = []
            if healthy:
                try:
                    cloud_licenses = self.api_client.list_cloud_licenses()
                except Exception as e:
                    print(f"Cloud fetch warning: {e}")

            # 3. Local ledger
            local_ledger = load_ledger()

            # 4. Merge
            merged = merge_cloud_and_ledger(cloud_licenses, local_ledger)
            self.data_loaded.emit(merged, latency, healthy, service_msg)
        except Exception as e:
            self.error_occurred.emit(str(e))


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.api_client = AdminApiClient()
        self.all_licenses: List[Dict[str, Any]] = []
        self.filtered_licenses: List[Dict[str, Any]] = []
        self.selected_license: Optional[Dict[str, Any]] = None
        self.active_status_pill: str = "ALL"
        self.auto_sync_enabled: bool = False
        self._sort_reverse: bool = False
        self._last_sort_col: int = -1

        self.setWindowTitle(f"{APP_NAME} v{APP_VERSION} — Enterprise Edition")
        self.setMinimumSize(1260, 800)
        self.resize(1380, 860)

        self.init_ui()
        self.setup_shortcuts()
        self.setup_auto_sync()
        self.refresh_data()

    def init_ui(self):
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        main_layout = QVBoxLayout(central_widget)
        main_layout.setContentsMargins(18, 14, 18, 14)
        main_layout.setSpacing(12)

        # -------------------------------------------------------------
        # 1. Top Header Bar
        # -------------------------------------------------------------
        header_card = QFrame()
        header_card.setObjectName("HeaderCard")
        h_layout = QHBoxLayout(header_card)
        h_layout.setContentsMargins(18, 12, 18, 12)

        # Branding
        title_box = QVBoxLayout()
        title_box.setSpacing(2)
        app_title = QLabel("🛡️ MOBIPOS LICENSING SUITE")
        app_title.setObjectName("AppTitle")
        app_subtitle = QLabel("Console d'Administration & Gestion Mondiale des Licences Clients")
        app_subtitle.setObjectName("AppSubtitle")
        title_box.addWidget(app_title)
        title_box.addWidget(app_subtitle)
        h_layout.addLayout(title_box)

        h_layout.addStretch()

        # Cloud Health Indicator
        self.edge_status_label = QLabel("⚡ Connexion Cloudflare Edge...")
        self.edge_status_label.setStyleSheet(
            "background-color: #1e293b; color: #94a3b8; padding: 6px 14px; "
            "border-radius: 8px; font-weight: 700; font-size: 11px;"
        )
        h_layout.addWidget(self.edge_status_label)

        # Header Action Buttons
        self.btn_new = QPushButton("➕ Nouvelle Licence")
        self.btn_new.setObjectName("PrimaryBtn")
        self.btn_new.setToolTip("Créer une nouvelle licence client (Ctrl+N)")
        self.btn_new.clicked.connect(self.open_new_license_dialog)
        h_layout.addWidget(self.btn_new)

        self.btn_refresh = QPushButton("🔄 Actualiser")
        self.btn_refresh.setToolTip("Actualiser les données Cloud & Local (Ctrl+R / F5)")
        self.btn_refresh.clicked.connect(self.refresh_data)
        h_layout.addWidget(self.btn_refresh)

        self.btn_autosync = QPushButton("⏱️ Auto-Sync (30s)")
        self.btn_autosync.setToolTip("Activer / Désactiver la synchronisation automatique en arrière-plan")
        self.btn_autosync.clicked.connect(self.toggle_auto_sync)
        h_layout.addWidget(self.btn_autosync)

        self.btn_audit = QPushButton("📜 Journal d'Audit")
        self.btn_audit.setToolTip("Consulter l'historique complet des actions administratives (Ctrl+L)")
        self.btn_audit.clicked.connect(self.open_audit_log_dialog)
        h_layout.addWidget(self.btn_audit)

        self.btn_offline = QPushButton("🔏 Jeton Offline")
        self.btn_offline.setToolTip("Générer un jeton Ed25519 pour machine sans Internet")
        self.btn_offline.clicked.connect(self.open_offline_token_dialog)
        h_layout.addWidget(self.btn_offline)

        self.btn_csv = QPushButton("📊 Export CSV")
        self.btn_csv.setToolTip("Exporter le registre en feuille de calcul Excel / CSV (Ctrl+E)")
        self.btn_csv.clicked.connect(self.export_ledger_csv)
        h_layout.addWidget(self.btn_csv)

        self.btn_export = QPushButton("📤 Export JSON")
        self.btn_export.setToolTip("Sauvegarder une copie de sauvegarde JSON (Ctrl+J)")
        self.btn_export.clicked.connect(self.export_ledger_json)
        h_layout.addWidget(self.btn_export)

        main_layout.addWidget(header_card)

        # -------------------------------------------------------------
        # 2. KPI Metric Cards Row
        # -------------------------------------------------------------
        metrics_layout = QHBoxLayout()
        metrics_layout.setSpacing(12)

        self.card_total_cust, self.val_total_cust = self.create_metric_card("👥 Total Clients", "0", "MetricCardTotal")
        metrics_layout.addWidget(self.card_total_cust)

        self.card_desktops, self.val_desktops = self.create_metric_card("🖥️ Caisses PC Actives", "0 / 0", "MetricCardDesktops")
        metrics_layout.addWidget(self.card_desktops)

        self.card_mobiles, self.val_mobiles = self.create_metric_card("📱 Mobiles Actifs", "0 / 0", "MetricCardMobiles")
        metrics_layout.addWidget(self.card_mobiles)

        self.card_health, self.val_health = self.create_metric_card("🛡️ Statut Sécurité Edge", "Opérationnel", "MetricCardHealth")
        metrics_layout.addWidget(self.card_health)

        main_layout.addLayout(metrics_layout)

        # -------------------------------------------------------------
        # 3. Quick Status Filter Pills & Search Toolbar
        # -------------------------------------------------------------
        toolbar_card = QFrame()
        toolbar_card.setObjectName("ToolbarCard")
        tb_layout = QHBoxLayout(toolbar_card)
        tb_layout.setContentsMargins(14, 8, 14, 8)
        tb_layout.setSpacing(10)

        # Status Pills
        self.btn_pill_all = QPushButton("⭐ Tous (0)")
        self.btn_pill_all.setObjectName("FilterPillActive")
        self.btn_pill_all.clicked.connect(lambda: self.set_status_pill("ALL"))
        tb_layout.addWidget(self.btn_pill_all)

        self.btn_pill_active = QPushButton("🟢 Actifs (0)")
        self.btn_pill_active.setObjectName("FilterPill")
        self.btn_pill_active.clicked.connect(lambda: self.set_status_pill("ACTIVE"))
        tb_layout.addWidget(self.btn_pill_active)

        self.btn_pill_full = QPushButton("⚠️ Quota Plein (0)")
        self.btn_pill_full.setObjectName("FilterPill")
        self.btn_pill_full.clicked.connect(lambda: self.set_status_pill("FULL"))
        tb_layout.addWidget(self.btn_pill_full)

        self.btn_pill_trial = QPushButton("⏳ Démos / 90J (0)")
        self.btn_pill_trial.setObjectName("FilterPill")
        self.btn_pill_trial.clicked.connect(lambda: self.set_status_pill("TRIAL"))
        tb_layout.addWidget(self.btn_pill_trial)

        self.btn_pill_susp = QPushButton("⏸️ Suspendus (0)")
        self.btn_pill_susp.setObjectName("FilterPill")
        self.btn_pill_susp.clicked.connect(lambda: self.set_status_pill("SUSPENDED"))
        tb_layout.addWidget(self.btn_pill_susp)

        tb_layout.addSpacing(8)

        # Search box with native clear button
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("🔍 Rechercher par client, téléphone, ville, clé (MOBI-...), notes...")
        self.search_input.setClearButtonEnabled(True)
        self.search_input.textChanged.connect(self.apply_filters)
        tb_layout.addWidget(self.search_input, stretch=2)

        # Formula Filter
        tb_layout.addWidget(QLabel("Formule :"))
        self.formula_filter = QComboBox()
        self.formula_filter.addItems(["Toutes les formules", "LIFETIME", "90D", "24H", "30D", "1Y"])
        self.formula_filter.currentIndexChanged.connect(self.apply_filters)
        tb_layout.addWidget(self.formula_filter)

        # Count label
        self.count_label = QLabel("0 licence(s)")
        self.count_label.setStyleSheet("color: #94a3b8; font-weight: 700; font-size: 12px;")
        tb_layout.addWidget(self.count_label)

        main_layout.addWidget(toolbar_card)

        # -------------------------------------------------------------
        # 4. Central Licenses Table
        # -------------------------------------------------------------
        self.table = QTableWidget()
        self.table.setColumnCount(8)
        self.table.setHorizontalHeaderLabels([
            "Client & Contact",
            "Clé d'Activation",
            "Formule",
            "Caisses PC",
            "Mobiles",
            "Statut",
            "Expiration / Date",
            "Actions Rapides"
        ])

        # Generous default row height to prevent button vertical clipping
        self.table.verticalHeader().setDefaultSectionSize(58)

        # Fixed, generous column widths
        self.table.setColumnWidth(0, 230)  # Client & City/Phone
        self.table.setColumnWidth(1, 260)  # Key + copy
        self.table.setColumnWidth(2, 160)  # Formula badge
        self.table.setColumnWidth(3, 140)  # Caisses PC
        self.table.setColumnWidth(4, 140)  # Mobiles
        self.table.setColumnWidth(5, 110)  # Status badge
        self.table.setColumnWidth(6, 140)  # Expiration / Date
        self.table.horizontalHeader().setSectionResizeMode(7, QHeaderView.ResizeMode.Stretch)

        self.table.verticalHeader().setVisible(False)
        self.table.setAlternatingRowColors(True)
        self.table.cellDoubleClicked.connect(self.on_table_double_clicked)
        self.table.itemSelectionChanged.connect(self.on_selection_changed)

        # Interactive header sorting
        self.table.horizontalHeader().setSectionsClickable(True)
        self.table.horizontalHeader().sectionClicked.connect(self.on_header_clicked)

        # Custom Context Menu on Right Click
        self.table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.table.customContextMenuRequested.connect(self.show_context_menu)

        main_layout.addWidget(self.table, stretch=2)

        # -------------------------------------------------------------
        # 5. Customer Details Inspector Panel
        # -------------------------------------------------------------
        self.details_card = QFrame()
        self.details_card.setObjectName("DetailsCard")
        det_layout = QHBoxLayout(self.details_card)
        det_layout.setContentsMargins(16, 12, 16, 12)
        det_layout.setSpacing(16)

        # Client info
        c_box = QVBoxLayout()
        c_box.setSpacing(3)
        self.det_title = QLabel("Sélectionnez un client pour voir les détails d'utilisation")
        self.det_title.setStyleSheet("font-size: 14px; font-weight: 800; color: #ffffff;")
        self.det_contact = QLabel("Coordonnées : —")
        self.det_contact.setStyleSheet("font-size: 11px; color: #34d399; font-weight: 600;")
        self.det_notes = QLabel("Notes : —")
        self.det_notes.setStyleSheet("font-size: 11px; color: #94a3b8;")
        c_box.addWidget(self.det_title)
        c_box.addWidget(self.det_contact)
        c_box.addWidget(self.det_notes)
        det_layout.addLayout(c_box, stretch=2)

        # Progress PC
        pc_box = QVBoxLayout()
        pc_box.setSpacing(2)
        self.lbl_bar_pc = QLabel("🖥️ Caisses PC : -")
        self.lbl_bar_pc.setStyleSheet("font-size: 11px; font-weight: 700; color: #6ee7b7;")
        self.bar_pc = QProgressBar()
        self.bar_pc.setRange(0, 100)
        self.bar_pc.setValue(0)
        pc_box.addWidget(self.lbl_bar_pc)
        pc_box.addWidget(self.bar_pc)
        det_layout.addLayout(pc_box, stretch=1)

        # Progress Mobile
        mob_box = QVBoxLayout()
        mob_box.setSpacing(2)
        self.lbl_bar_mob = QLabel("📱 Mobiles : -")
        self.lbl_bar_mob.setStyleSheet("font-size: 11px; font-weight: 700; color: #d8b4fe;")
        self.bar_mob = QProgressBar()
        self.bar_mob.setRange(0, 100)
        self.bar_mob.setValue(0)
        self.bar_mob.setStyleSheet("QProgressBar::chunk { background-color: #a855f7; }")
        mob_box.addWidget(self.lbl_bar_mob)
        mob_box.addWidget(self.bar_mob)
        det_layout.addLayout(mob_box, stretch=1)

        # Direct Actions
        act_box = QHBoxLayout()
        act_box.setSpacing(6)

        self.btn_det_qr = QPushButton("📱 QR Code")
        self.btn_det_qr.setEnabled(False)
        self.btn_det_qr.clicked.connect(lambda: self.selected_license and self.open_qr_dialog(self.selected_license))
        act_box.addWidget(self.btn_det_qr)

        self.btn_det_edit = QPushButton("✏️ Contact & Notes")
        self.btn_det_edit.setEnabled(False)
        self.btn_det_edit.clicked.connect(lambda: self.selected_license and self.open_notes_dialog(self.selected_license))
        act_box.addWidget(self.btn_det_edit)

        self.btn_det_upgrade = QPushButton("⭐ Surclasser")
        self.btn_det_upgrade.setObjectName("SecondaryBtn")
        self.btn_det_upgrade.setEnabled(False)
        self.btn_det_upgrade.clicked.connect(lambda: self.selected_license and self.open_upgrade_dialog(self.selected_license))
        act_box.addWidget(self.btn_det_upgrade)

        self.btn_det_devices = QPushButton("🖥️ Appareils")
        self.btn_det_devices.setEnabled(False)
        self.btn_det_devices.clicked.connect(lambda: self.selected_license and self.open_devices_dialog(self.selected_license))
        act_box.addWidget(self.btn_det_devices)

        self.btn_det_wa = QPushButton("💬 WhatsApp")
        self.btn_det_wa.setObjectName("WhatsAppBtn")
        self.btn_det_wa.setEnabled(False)
        self.btn_det_wa.clicked.connect(lambda: self.selected_license and self.open_whatsapp_dialog(self.selected_license))
        act_box.addWidget(self.btn_det_wa)

        det_layout.addLayout(act_box)

        main_layout.addWidget(self.details_card)

        # -------------------------------------------------------------
        # 6. Status Bar
        # -------------------------------------------------------------
        self.status_bar = QStatusBar()
        self.setStatusBar(self.status_bar)
        self.status_bar.showMessage("Prêt. MobiPOS Licensing Suite v2.1 initialisée.")

    def create_metric_card(self, label_text: str, default_value: str, card_id: str = "MetricCard") -> tuple[QFrame, QLabel]:
        card = QFrame()
        card.setObjectName(card_id)
        layout = QVBoxLayout(card)
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(4)

        lbl = QLabel(label_text)
        lbl.setObjectName("MetricLabel")
        val = QLabel(default_value)
        val.setObjectName("MetricValue")

        layout.addWidget(lbl)
        layout.addWidget(val)
        return card, val

    def setup_shortcuts(self):
        QShortcut(QKeySequence("Ctrl+N"), self, self.open_new_license_dialog)
        QShortcut(QKeySequence("Ctrl+R"), self, self.refresh_data)
        QShortcut(QKeySequence("F5"), self, self.refresh_data)
        QShortcut(QKeySequence("Ctrl+F"), self, self.search_input.setFocus)
        QShortcut(QKeySequence("Ctrl+L"), self, self.open_audit_log_dialog)
        QShortcut(QKeySequence("Ctrl+E"), self, self.export_ledger_csv)
        QShortcut(QKeySequence("Ctrl+J"), self, self.export_ledger_json)

    def setup_auto_sync(self):
        self.auto_sync_timer = QTimer(self)
        self.auto_sync_timer.setInterval(30000)  # Every 30 seconds
        self.auto_sync_timer.timeout.connect(self.on_auto_sync_tick)

    def toggle_auto_sync(self):
        self.auto_sync_enabled = not self.auto_sync_enabled
        if self.auto_sync_enabled:
            self.auto_sync_timer.start()
            self.btn_autosync.setText("⏱️ Auto-Sync: ACTIF ✓")
            self.btn_autosync.setStyleSheet("background-color: #064e3b; color: #6ee7b7; border: 1px solid #059669;")
            self.status_bar.showMessage("⏱️ Synchronisation automatique en arrière-plan activée (30s).")
        else:
            self.auto_sync_timer.stop()
            self.btn_autosync.setText("⏱️ Auto-Sync (30s)")
            self.btn_autosync.setStyleSheet("")
            self.status_bar.showMessage("⏱️ Synchronisation automatique désactivée.")

    def on_auto_sync_tick(self):
        if not self.btn_refresh.isEnabled():
            return
        self.refresh_data()

    # -----------------------------------------------------------------
    # Data Refresh & Asynchronous Workers
    # -----------------------------------------------------------------
    def refresh_data(self):
        self.btn_refresh.setEnabled(False)
        self.status_bar.showMessage("⏳ Synchronisation avec Cloudflare Worker et Turso DB...")

        self.worker = RefreshWorker(self.api_client)
        self.worker.data_loaded.connect(self.on_data_loaded)
        self.worker.error_occurred.connect(self.on_worker_error)
        self.worker.start()

    def on_data_loaded(self, licenses: list, latency_ms: float, healthy: bool, service_msg: str):
        self.btn_refresh.setEnabled(True)
        self.all_licenses = licenses

        # Update Edge health indicator
        if healthy:
            self.edge_status_label.setText(f"🟢 Cloudflare Edge ({latency_ms} ms)")
            self.edge_status_label.setStyleSheet(
                "background-color: #064e3b; color: #6ee7b7; padding: 6px 14px; "
                "border-radius: 8px; font-weight: 700; font-size: 11px;"
            )
            self.val_health.setText("100% Opérationnel")
            self.val_health.setStyleSheet("color: #10b981; font-weight: 800;")
        else:
            self.edge_status_label.setText("🔴 Cloud Hors-Ligne")
            self.edge_status_label.setStyleSheet(
                "background-color: #7f1d1d; color: #fca5a5; padding: 6px 14px; "
                "border-radius: 8px; font-weight: 700; font-size: 11px;"
            )
            self.val_health.setText("Hors-Ligne")
            self.val_health.setStyleSheet("color: #ef4444; font-weight: 800;")

        self.apply_filters()
        self.status_bar.showMessage(
            f"✅ Synchronisé avec succès ({len(licenses)} licences). Latence Edge: {latency_ms}ms"
        )

    def on_worker_error(self, err_msg: str):
        self.btn_refresh.setEnabled(True)
        self.status_bar.showMessage(f"⚠️ Erreur de synchronisation: {err_msg}")
        # Fall back to local ledger
        local = load_ledger()
        self.all_licenses = merge_cloud_and_ledger([], local)
        self.apply_filters()

    # -----------------------------------------------------------------
    # Filtering & Rendering
    # -----------------------------------------------------------------
    def set_status_pill(self, mode: str):
        self.active_status_pill = mode
        # Reset pill styles
        self.btn_pill_all.setObjectName("FilterPillActive" if mode == "ALL" else "FilterPill")
        self.btn_pill_active.setObjectName("FilterPillActive" if mode == "ACTIVE" else "FilterPill")
        self.btn_pill_full.setObjectName("FilterPillActive" if mode == "FULL" else "FilterPill")
        self.btn_pill_trial.setObjectName("FilterPillActive" if mode == "TRIAL" else "FilterPill")
        self.btn_pill_susp.setObjectName("FilterPillActive" if mode == "SUSPENDED" else "FilterPill")

        # Re-apply styles
        for btn in (self.btn_pill_all, self.btn_pill_active, self.btn_pill_full, self.btn_pill_trial, self.btn_pill_susp):
            btn.style().unpolish(btn)
            btn.style().polish(btn)

        self.apply_filters()

    def apply_filters(self):
        query = self.search_input.text().strip().lower()
        sel_formula = self.formula_filter.currentText()

        filtered = []
        tot_active_desk = 0
        tot_max_desk = 0
        tot_active_mob = 0
        tot_max_mob = 0

        count_all = len(self.all_licenses)
        count_active = 0
        count_full = 0
        count_trial = 0
        count_susp = 0

        for lic in self.all_licenses:
            cust = lic.get("customer", "").lower()
            key = lic.get("licenseKey", "").lower()
            turso = lic.get("tursoUrl", "").lower()
            phone = lic.get("phone", "").lower()
            city = lic.get("city", "").lower()
            notes = lic.get("notes", "").lower()
            f_type = lic.get("type", "").upper()
            status = lic.get("status", "").lower()

            act_d = lic.get("activeDesktops", 0)
            max_d = lic.get("desktops", 1)
            act_m = lic.get("activeMobiles", 0)
            max_m = lic.get("mobiles", 1)

            tot_active_desk += act_d
            tot_max_desk += max_d
            tot_active_mob += act_m
            tot_max_mob += max_m

            is_full = (act_d >= max_d) or (act_m >= max_m)
            is_trial = f_type in ("24H", "DEMO", "90D", "30D")

            if status == "active":
                count_active += 1
            if status in ("suspended", "revoked"):
                count_susp += 1
            if is_full:
                count_full += 1
            if is_trial:
                count_trial += 1

            # Quick Status Pill Filter
            if self.active_status_pill == "ACTIVE" and status != "active":
                continue
            elif self.active_status_pill == "SUSPENDED" and status not in ("suspended", "revoked"):
                continue
            elif self.active_status_pill == "FULL" and not is_full:
                continue
            elif self.active_status_pill == "TRIAL" and not is_trial:
                continue

            # Text Query filter (matches customer, key, phone, city, notes, turso)
            if query:
                combined_text = f"{cust} {key} {phone} {city} {notes} {turso}"
                if query not in combined_text:
                    continue

            # Formula filter
            if sel_formula != "Toutes les formules" and sel_formula != f_type:
                continue

            filtered.append(lic)

        self.filtered_licenses = filtered

        # Update Pills Count Labels
        self.btn_pill_all.setText(f"⭐ Tous ({count_all})")
        self.btn_pill_active.setText(f"🟢 Actifs ({count_active})")
        self.btn_pill_full.setText(f"⚠️ Quota Plein ({count_full})")
        self.btn_pill_trial.setText(f"⏳ Démos / 90J ({count_trial})")
        self.btn_pill_susp.setText(f"⏸️ Suspendus ({count_susp})")

        # Update KPI Cards
        self.val_total_cust.setText(str(len(self.all_licenses)))
        self.val_desktops.setText(f"{tot_active_desk} / {tot_max_desk}")
        self.val_mobiles.setText(f"{tot_active_mob} / {tot_max_mob}")

        # Update count label
        self.count_label.setText(f"{len(filtered)} sur {len(self.all_licenses)} licence(s)")

        # Render Table
        self.render_table(filtered)

    def render_table(self, licenses: List[Dict[str, Any]]):
        self.table.setRowCount(len(licenses))

        for row, lic in enumerate(licenses):
            # 0. Customer Name & Contact Subtitle
            cust_name = lic.get("customer", "Client Inconnu")
            phone = lic.get("phone", "")
            city = lic.get("city", "")

            cust_widget = QWidget()
            cw_layout = QVBoxLayout(cust_widget)
            cw_layout.setContentsMargins(6, 4, 6, 4)
            cw_layout.setSpacing(2)

            name_lbl = QLabel(f"👤 {cust_name}")
            name_lbl.setFont(QFont("Segoe UI", 10, QFont.Weight.Bold))
            name_lbl.setStyleSheet("color: #f8fafc;")
            cw_layout.addWidget(name_lbl)

            contact_parts = []
            if city:
                contact_parts.append(f"📍 {city}")
            if phone:
                contact_parts.append(f"📞 {phone}")

            if contact_parts:
                sub_lbl = QLabel("  |  ".join(contact_parts))
                sub_lbl.setStyleSheet("font-size: 10px; color: #94a3b8; font-weight: 500;")
                cw_layout.addWidget(sub_lbl)

            self.table.setCellWidget(row, 0, cust_widget)

            # 1. License Key with Copy Button
            key_val = lic.get("licenseKey", "")
            key_widget = QWidget()
            kw_layout = QHBoxLayout(key_widget)
            kw_layout.setContentsMargins(6, 4, 6, 4)
            kw_layout.setSpacing(8)

            key_lbl = QLabel(key_val)
            key_lbl.setFont(QFont("Consolas", 10, QFont.Weight.Bold))
            key_lbl.setStyleSheet("color: #34d399;")
            kw_layout.addWidget(key_lbl)

            if not key_val.startswith("["):
                btn_copy = QPushButton("📋")
                btn_copy.setToolTip("Copier la clé dans le presse-papier")
                btn_copy.setObjectName("TableBtn")
                btn_copy.setFixedWidth(30)
                btn_copy.clicked.connect(lambda _, k=key_val: self.copy_to_clipboard(k))
                kw_layout.addWidget(btn_copy)

            kw_layout.addStretch()
            self.table.setCellWidget(row, 1, key_widget)

            # 2. Formula Badge
            f_type = lic.get("type", "LIFETIME")
            f_item = QLabel(formula_badge(f_type))
            f_item.setAlignment(Qt.AlignmentFlag.AlignCenter)
            self.table.setCellWidget(row, 2, f_item)

            # 3. Desktops Quota Badge
            act_d = lic.get("activeDesktops", 0)
            max_d = lic.get("desktops", 1)
            try:
                d_badge = seats_badge(act_d, max_d, "🖥️")
            except TypeError:
                d_badge = seats_badge(act_d, max_d)
            d_item = QLabel(d_badge)
            d_item.setAlignment(Qt.AlignmentFlag.AlignCenter)
            self.table.setCellWidget(row, 3, d_item)

            # 4. Mobiles Quota Badge
            act_m = lic.get("activeMobiles", 0)
            max_m = lic.get("mobiles", 1)
            try:
                m_badge = seats_badge(act_m, max_m, "📱")
            except TypeError:
                m_badge = seats_badge(act_m, max_m)
            m_item = QLabel(m_badge)
            m_item.setAlignment(Qt.AlignmentFlag.AlignCenter)
            self.table.setCellWidget(row, 4, m_item)

            # 5. Status Badge
            st = lic.get("status", "active")
            st_item = QLabel(status_badge(st))
            st_item.setAlignment(Qt.AlignmentFlag.AlignCenter)
            self.table.setCellWidget(row, 5, st_item)

            # 6. Expiration / Creation Date
            exp_str = lic.get("expiresAt")
            c_date = (lic.get("createdAt") or "")[:10]
            date_widget = QWidget()
            dw_layout = QVBoxLayout(date_widget)
            dw_layout.setContentsMargins(4, 4, 4, 4)
            dw_layout.setSpacing(2)

            if exp_str and exp_str != "NONE":
                try:
                    exp_dt = datetime.datetime.fromisoformat(exp_str.replace("Z", "+00:00"))
                    now_dt = datetime.datetime.now(datetime.timezone.utc)
                    days_left = (exp_dt - now_dt).days
                    if days_left > 10:
                        exp_lbl = QLabel(f"🟢 {days_left}j restants")
                        exp_lbl.setStyleSheet("color: #6ee7b7; font-weight: 700; font-size: 11px;")
                    elif days_left > 0:
                        exp_lbl = QLabel(f"🟡 {days_left}j restants")
                        exp_lbl.setStyleSheet("color: #fde047; font-weight: 700; font-size: 11px;")
                    else:
                        exp_lbl = QLabel("🔴 Expiré")
                        exp_lbl.setStyleSheet("color: #fca5a5; font-weight: 700; font-size: 11px;")
                    dw_layout.addWidget(exp_lbl)
                except Exception:
                    dw_layout.addWidget(QLabel(exp_str[:10]))
            else:
                date_lbl = QLabel(f"📅 {c_date}")
                date_lbl.setStyleSheet("color: #9ca3af; font-size: 11px;")
                dw_layout.addWidget(date_lbl)

            self.table.setCellWidget(row, 6, date_widget)

            # 7. Action Buttons Widget
            actions_widget = QWidget()
            act_layout = QHBoxLayout(actions_widget)
            act_layout.setContentsMargins(4, 4, 4, 4)
            act_layout.setSpacing(5)

            # A. QR Code Button
            btn_qr = QPushButton("📱 QR")
            btn_qr.setObjectName("TableBtn")
            btn_qr.setToolTip("Afficher le QR code d'activation pour mobile")
            btn_qr.setStyleSheet("background-color: #3b0764; color: #e9d5ff; border: 1px solid #7e22ce;")
            btn_qr.clicked.connect(lambda _, l=lic: self.open_qr_dialog(l))
            act_layout.addWidget(btn_qr)

            # B. Devices Inspector
            tot_act = act_d + act_m
            btn_dev = QPushButton(f"🖥️ Postes ({tot_act})")
            btn_dev.setObjectName("TableBtn")
            btn_dev.setStyleSheet("background-color: #0f766e; color: #ccfbf1; border: 1px solid #14b8a6;")
            btn_dev.clicked.connect(lambda _, l=lic: self.open_devices_dialog(l))
            act_layout.addWidget(btn_dev)

            # C. WhatsApp Dispatch
            btn_wa = QPushButton("💬 WhatsApp")
            btn_wa.setObjectName("TableBtn")
            btn_wa.setStyleSheet("background-color: #14532d; color: #86efac; border: 1px solid #166534;")
            btn_wa.clicked.connect(lambda _, l=lic: self.open_whatsapp_dialog(l))
            act_layout.addWidget(btn_wa)

            # D. Quotas Modifier
            btn_quo = QPushButton("⚙️ Quotas")
            btn_quo.setObjectName("TableBtn")
            btn_quo.clicked.connect(lambda _, l=lic: self.open_quotas_dialog(l))
            act_layout.addWidget(btn_quo)

            # E. Upgrade / Renew Button
            btn_ren = QPushButton("⭐ Surclasser")
            btn_ren.setObjectName("TableBtn")
            btn_ren.setStyleSheet("background-color: #1e3a8a; color: #bfdbfe; border: 1px solid #2563eb;")
            btn_ren.setToolTip("Surclasser en LIFETIME ou prolonger de 90 jours")
            btn_ren.clicked.connect(lambda _, l=lic: self.open_upgrade_dialog(l))
            act_layout.addWidget(btn_ren)

            # F. Options Menu Button (...)
            btn_more = QPushButton("•••")
            btn_more.setObjectName("TableBtn")
            btn_more.setFixedWidth(28)
            btn_more.clicked.connect(lambda _, b=btn_more, l=lic: self.open_row_options_menu(b, l))
            act_layout.addWidget(btn_more)

            act_layout.addStretch()
            self.table.setCellWidget(row, 7, actions_widget)

    # -----------------------------------------------------------------
    # Header Sorting & Context Menus
    # -----------------------------------------------------------------
    def on_header_clicked(self, logical_index: int):
        if self._last_sort_col == logical_index:
            self._sort_reverse = not self._sort_reverse
        else:
            self._sort_reverse = False
        self._last_sort_col = logical_index

        def sort_key(lic):
            if logical_index == 0:
                return lic.get("customer", "").lower()
            elif logical_index == 1:
                return lic.get("licenseKey", "").lower()
            elif logical_index == 2:
                return lic.get("type", "").lower()
            elif logical_index == 3:
                return lic.get("activeDesktops", 0) / max(1, lic.get("desktops", 1))
            elif logical_index == 4:
                return lic.get("activeMobiles", 0) / max(1, lic.get("mobiles", 1))
            elif logical_index == 5:
                return lic.get("status", "").lower()
            elif logical_index == 6:
                return lic.get("createdAt", "")
            return 0

        self.filtered_licenses.sort(key=sort_key, reverse=self._sort_reverse)
        self.render_table(self.filtered_licenses)

    def show_context_menu(self, pos: QPoint):
        item = self.table.itemAt(pos)
        widget = self.table.cellWidget(self.table.rowAt(pos.y()), 0)
        row = self.table.rowAt(pos.y())
        if not (0 <= row < len(self.filtered_licenses)):
            return

        lic = self.filtered_licenses[row]
        menu = QMenu(self)

        act_copy = menu.addAction("📋 Copier la Clé d'Activation")
        act_qr = menu.addAction("📱 Voir le QR Code d'Activation Instantanée")
        act_wa = menu.addAction("💬 Envoyer sur WhatsApp Web")
        menu.addSeparator()

        tot = lic.get("activeDesktops", 0) + lic.get("activeMobiles", 0)
        act_dev = menu.addAction(f"🖥️ Inspecter les Postes Connectés ({tot})")
        act_quo = menu.addAction("⚙️ Modifier les Quotas (Caisses / Mobiles)")
        act_ren = menu.addAction("⭐ Surclasser / Prolonger la Licence")
        act_not = menu.addAction("✏️ Modifier Contact & Notes Internes")
        menu.addSeparator()

        is_act = (lic.get("status") == "active")
        act_sus = menu.addAction("⏸️ Suspendre la Licence" if is_act else "▶️ Réactiver la Licence")
        act_rst = menu.addAction("🔄 Déconnecter TOUS les Postes")
        act_off = menu.addAction("🔏 Générer Jeton Hors-Ligne (Ed25519)")
        menu.addSeparator()
        act_del = menu.addAction("🗑️ Supprimer du Registre Local")

        chosen = menu.exec(self.table.viewport().mapToGlobal(pos))
        if chosen == act_copy:
            self.copy_to_clipboard(lic.get("licenseKey", ""))
        elif chosen == act_qr:
            self.open_qr_dialog(lic)
        elif chosen == act_wa:
            self.open_whatsapp_dialog(lic)
        elif chosen == act_dev:
            self.open_devices_dialog(lic)
        elif chosen == act_quo:
            self.open_quotas_dialog(lic)
        elif chosen == act_ren:
            self.open_upgrade_dialog(lic)
        elif chosen == act_not:
            self.open_notes_dialog(lic)
        elif chosen == act_sus:
            self.toggle_license_status(lic)
        elif chosen == act_rst:
            self.quick_reset_seats(lic)
        elif chosen == act_off:
            dlg = OfflineTokenDialog(default_license=lic, parent=self)
            dlg.exec()
        elif chosen == act_del:
            self.delete_license_prompt(lic)

    def open_row_options_menu(self, button: QPushButton, lic: Dict[str, Any]):
        menu = QMenu(self)
        act_not = menu.addAction("✏️ Modifier Contact & Notes")
        is_act = (lic.get("status") == "active")
        act_sus = menu.addAction("⏸️ Suspendre" if is_act else "▶️ Réactiver")
        act_rst = menu.addAction("🔄 Libérer tous les postes")
        act_off = menu.addAction("🔏 Jeton Offline")
        menu.addSeparator()
        act_del = menu.addAction("🗑️ Supprimer du Registre")

        chosen = menu.exec(button.mapToGlobal(QPoint(0, button.height())))
        if chosen == act_not:
            self.open_notes_dialog(lic)
        elif chosen == act_sus:
            self.toggle_license_status(lic)
        elif chosen == act_rst:
            self.quick_reset_seats(lic)
        elif chosen == act_off:
            dlg = OfflineTokenDialog(default_license=lic, parent=self)
            dlg.exec()
        elif chosen == act_del:
            self.delete_license_prompt(lic)

    # -----------------------------------------------------------------
    # Selection & Inspector Panel
    # -----------------------------------------------------------------
    def on_selection_changed(self):
        selected_rows = self.table.selectionModel().selectedRows()
        if not selected_rows:
            return
        row = selected_rows[0].row()
        if 0 <= row < len(self.filtered_licenses):
            lic = self.filtered_licenses[row]
            self.update_details_panel(lic)

    def on_table_double_clicked(self, row: int, col: int):
        if 0 <= row < len(self.filtered_licenses):
            lic = self.filtered_licenses[row]
            self.open_devices_dialog(lic)

    def update_details_panel(self, lic: Dict[str, Any]):
        self.selected_license = lic
        cust = lic.get("customer", "Client")
        key = lic.get("licenseKey", "")
        f_type = lic.get("type", "LIFETIME")
        st = lic.get("status", "active").upper()
        phone = lic.get("phone", "")
        city = lic.get("city", "")
        notes = lic.get("notes", "")

        self.det_title.setText(f"👤 {cust}  —  🔑 {key}  ({f_type})  |  Statut: {st}")
        
        contact_txt = f"📞 Tél: {phone or 'Non renseigné'}   |   📍 Ville: {city or 'Non renseignée'}"
        self.det_contact.setText(contact_txt)

        self.det_notes.setText(f"📝 Notes : {notes or 'Aucune note interne pour ce client.'}")

        act_d = lic.get("activeDesktops", 0)
        max_d = max(1, lic.get("desktops", 1))
        pct_d = int((act_d / max_d) * 100)
        self.lbl_bar_pc.setText(f"🖥️ Caisses PC : {act_d} / {max_d} ({pct_d}% utilisé)")
        self.bar_pc.setValue(pct_d)

        act_m = lic.get("activeMobiles", 0)
        max_m = max(1, lic.get("mobiles", 1))
        pct_m = int((act_m / max_m) * 100)
        self.lbl_bar_mob.setText(f"📱 Mobiles : {act_m} / {max_m} ({pct_m}% utilisé)")
        self.bar_mob.setValue(pct_m)

        self.btn_det_qr.setEnabled(True)
        self.btn_det_edit.setEnabled(True)
        self.btn_det_upgrade.setEnabled(True)
        self.btn_det_devices.setEnabled(True)
        self.btn_det_wa.setEnabled(True)

    # -----------------------------------------------------------------
    # Action Handlers & Dialog Openers
    # -----------------------------------------------------------------
    def copy_to_clipboard(self, text: str):
        QApplication.clipboard().setText(text)
        self.status_bar.showMessage(f"📋 Clé copiée dans le presse-papier : {text}", 4000)

    def open_new_license_dialog(self):
        dlg = NewLicenseDialog(self.api_client, self)
        dlg.license_created.connect(lambda _: self.refresh_data())
        dlg.exec()

    def open_qr_dialog(self, license_data: Dict[str, Any]):
        dlg = QRCodeDialog(license_data, self)
        dlg.exec()

    def open_notes_dialog(self, license_data: Dict[str, Any]):
        dlg = EditCustomerNotesDialog(license_data, self)
        dlg.metadata_updated.connect(lambda _: self.refresh_data())
        dlg.exec()

    def open_upgrade_dialog(self, license_data: Dict[str, Any]):
        dlg = RenewUpgradeDialog(license_data, self.api_client, self)
        dlg.license_upgraded.connect(lambda _: self.refresh_data())
        dlg.exec()

    def open_audit_log_dialog(self):
        dlg = AuditLogDialog(self)
        dlg.exec()

    def open_devices_dialog(self, license_data: Dict[str, Any]):
        dlg = DevicesDialog(license_data, self.api_client, self)
        dlg.devices_changed.connect(self.refresh_data)
        dlg.exec()

    def open_quotas_dialog(self, license_data: Dict[str, Any]):
        dlg = UpdateQuotasDialog(license_data, self.api_client, self)
        dlg.quotas_updated.connect(lambda _: self.refresh_data())
        dlg.exec()

    def open_whatsapp_dialog(self, license_data: Dict[str, Any]):
        dlg = WhatsAppMessageDialog(license_data, self)
        dlg.exec()

    def open_offline_token_dialog(self):
        dlg = OfflineTokenDialog(default_license=self.selected_license, parent=self)
        dlg.exec()

    def toggle_license_status(self, license_data: Dict[str, Any]):
        raw_key = license_data.get("licenseKey", "")
        if not raw_key or raw_key.startswith("["):
            QMessageBox.warning(self, "Action Impossible", "Clé introuvable.")
            return

        current_st = license_data.get("status", "active")
        new_st = "suspended" if current_st == "active" else "active"
        action_name = "suspendre" if new_st == "suspended" else "réactiver"

        confirm = QMessageBox.question(
            self,
            "Confirmer la modification",
            f"Voulez-vous vraiment {action_name} la licence de {license_data.get('customer')} ?\n\n"
            f"Statut cible : {new_st.upper()}",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return

        try:
            success = self.api_client.set_status(raw_key, new_st)
            if success:
                license_data["status"] = new_st
                record_in_ledger(license_data)
                record_audit_event("TOGGLE_STATUS", f"Statut changé en {new_st.upper()}", license_data.get("customer", ""), raw_key)
                self.status_bar.showMessage(f"✅ Statut de {license_data.get('customer')} mis à jour: {new_st.upper()}")
                self.refresh_data()
            else:
                QMessageBox.warning(self, "Attention", "Le serveur n'a pas confirmé le changement.")
        except Exception as e:
            QMessageBox.critical(self, "Erreur", f"Échec de mise à jour du statut : {e}")

    def quick_reset_seats(self, license_data: Dict[str, Any]):
        raw_key = license_data.get("licenseKey", "")
        if not raw_key or raw_key.startswith("["):
            QMessageBox.warning(self, "Action Impossible", "Clé introuvable.")
            return

        confirm = QMessageBox.warning(
            self,
            "Réinitialisation Rapide",
            f"Voulez-vous déconnecter TOUS les postes reliés à {license_data.get('customer')} ?\n\n"
            f"Les caisses et mobiles pourront se reconnecter à neuf.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return

        try:
            cleared = self.api_client.reset_seats(raw_key)
            record_audit_event("RESET_SEATS", f"Réinitialisation de tous les postes ({cleared} libérés)", license_data.get("customer", ""), raw_key)
            QMessageBox.information(self, "Succès", f"✅ {cleared} poste(s) ont été libérés.")
            self.refresh_data()
        except Exception as e:
            QMessageBox.critical(self, "Erreur", f"Échec de la réinitialisation : {e}")

    def delete_license_prompt(self, license_data: Dict[str, Any]):
        cust = license_data.get("customer", "ce client")
        key = license_data.get("licenseKey", "")
        lid = license_data.get("id", "")
        confirm = QMessageBox.warning(
            self,
            "Confirmer la suppression",
            f"Voulez-vous supprimer {cust} du registre local ?\n\n"
            f"Clé : {key}\n\n"
            f"Note : Cette action efface la licence du registre local.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        if confirm == QMessageBox.StandardButton.Yes:
            delete_from_ledger(lid, key)
            record_audit_event("DELETE_LOCAL", f"Suppression du registre local de {cust}", cust, key)
            self.status_bar.showMessage(f"🗑️ Licence {key} supprimée du registre local.")
            self.refresh_data()

    def export_ledger_json(self):
        path, _ = QFileDialog.getSaveFileName(
            self,
            "Exporter le registre des licences (JSON)",
            f"mobi_licenses_backup_{datetime.date.today().isoformat()}.json",
            "JSON Files (*.json);;All Files (*)"
        )
        if path:
            ledger = load_ledger()
            with open(path, "w", encoding="utf-8") as f:
                json.dump(ledger, f, indent=2, ensure_ascii=False)
            record_audit_event("EXPORT_JSON", f"Sauvegarde JSON exportée: {path}")
            QMessageBox.information(self, "Export Réussi", f"Registre sauvegardé sous :\n{path}")

    def export_ledger_csv(self):
        path, _ = QFileDialog.getSaveFileName(
            self,
            "Exporter le registre en feuille de calcul (CSV / Excel)",
            f"mobi_clients_{datetime.date.today().isoformat()}.csv",
            "CSV Files (*.csv);;All Files (*)"
        )
        if path:
            ledger = load_ledger()
            with open(path, "w", encoding="utf-8-sig", newline="") as f:
                writer = csv.writer(f, delimiter=";")
                writer.writerow(["ID", "Client", "Clé de Licence", "Formule", "Caisses Max", "Mobiles Max", "Téléphone", "Ville", "Notes", "Base Turso", "Créée le"])
                for item in ledger:
                    writer.writerow([
                        item.get("id", ""),
                        item.get("customer", ""),
                        item.get("licenseKey", ""),
                        item.get("type", "LIFETIME"),
                        item.get("desktops", 1),
                        item.get("mobiles", 2),
                        item.get("phone", ""),
                        item.get("city", ""),
                        item.get("notes", ""),
                        item.get("tursoUrl", ""),
                        item.get("createdAt", "")
                    ])
            record_audit_event("EXPORT_CSV", f"Registre CSV exporté: {path}")
            QMessageBox.information(self, "Export CSV Réussi", f"Fichier exporté avec succès sous :\n{path}")


def main():
    app = QApplication(sys.argv)
    app.setStyleSheet(DARK_THEME_QSS)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()


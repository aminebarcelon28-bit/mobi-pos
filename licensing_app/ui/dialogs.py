"""
Interactive Dialogs for MobiPOS License Admin Suite (v2.1 Enterprise).
Includes:
1. NewLicenseDialog (License generation with customer contact and internal notes)
2. DevicesDialog (Connected HWID inspector with single device unbind & full reset)
3. UpdateQuotasDialog (Modify desktop / mobile quotas with atomic sync)
4. WhatsAppMessageDialog (Direct chat dispatch with phone normalization)
5. OfflineTokenDialog (Cryptographic Ed25519 air-gapped JWT signer)
6. QRCodeDialog (Interactive QR code generator for instant phone camera activation)
7. EditCustomerNotesDialog (Customer metadata & CRM notes editor)
8. RenewUpgradeDialog (1-click upgrade to LIFETIME or 30/90/365-day extensions)
9. AuditLogDialog (Security & administrative audit trail viewer with CSV export)
"""

import datetime
import json
import os
import re
import time
import urllib.parse
import webbrowser
from typing import Dict, Any, Optional

from PyQt6.QtCore import Qt, pyqtSignal, QThread, QPoint
from PyQt6.QtGui import QIcon, QFont, QColor, QPixmap, QImage
from PyQt6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QGridLayout, QLabel, QLineEdit,
    QPushButton, QComboBox, QSpinBox, QTextEdit, QTableWidget, QTableWidgetItem,
    QHeaderView, QMessageBox, QFrame, QFileDialog, QApplication, QProgressBar,
    QMenu
)

from ..config import MASTER_ENCRYPTION_KEY, LICENSE_PEPPER
from ..core.crypto import (
    generate_license_key, hash_key, encrypt_turso_token,
    detect_local_hwid, generate_offline_jwt, build_whatsapp_message,
    generate_qr_image_bytes, solve_technician_challenge,
    build_rescue_whatsapp_message
)
from ..core.api import (
    AdminApiClient, record_in_ledger, update_customer_metadata,
    delete_from_ledger, record_audit_event, load_audit_log, clear_audit_log
)
from .theme import status_badge, formula_badge, seats_badge


class ResolveMissingKeyDialog(QDialog):
    """
    Actionable modal for a licence that only exists as a cloud stub.

    Replaces the dead-end "Clé Inconnue" warning. When a licence was created on
    another machine, provisioned by API, or the local ledger was wiped, the row
    renders as ``[Clé Cloud lic_XXXX]`` and every action that needs the real key
    used to abort. The operator gets three concrete exits instead:

    A. Rotate -- issue a fresh key for the same customer, quotas and formula,
       persist it locally, and escrow it so the next machine can recover it.
    B. Link -- paste a key the operator already holds (invoice, chat history).
    C. Cloud ID -- proceed with the cloud identifier for a QR / deep link,
       which is what a phone needs to activate when no plaintext key exists.

    On accept, ``resolved_key`` holds the key to continue with, or
    ``use_cloud_id`` is True when the operator chose path C.
    """

    #: Emitted with the licence id after a successful rotate or link.
    key_resolved = pyqtSignal(str, str)

    def __init__(self, license_record, api_client=None, parent=None):
        super().__init__(parent)
        self.record = license_record
        self.api_client = api_client
        self.resolved_key: Optional[str] = None
        self.use_cloud_id = False

        self.setWindowTitle("Résolution de la clé d'activation")
        self.setModal(True)
        self.setMinimumWidth(520)
        self._init_ui()

    # -- construction -----------------------------------------------------
    def _init_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(14)

        title = QLabel(f"Clé locale absente — {self.record.customer}")
        title.setWordWrap(True)
        title.setStyleSheet("font-size: 15px; font-weight: bold; color: #F0F6FC;")
        layout.addWidget(title)

        desc = QLabel(
            "Cette licence provient de la synchronisation Cloud, mais sa clé en clair "
            "n'est pas présente dans ce registre local.\n"
            "Choisissez une action pour continuer :"
        )
        desc.setWordWrap(True)
        desc.setStyleSheet("color: #8B949E; font-size: 12px;")
        layout.addWidget(desc)

        # Path A -- rotate.
        self.btn_rotate = QPushButton("🔄  Générer une nouvelle clé (Recommandé)")
        self.btn_rotate.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_rotate.setMinimumHeight(42)
        self.btn_rotate.setStyleSheet(
            "QPushButton { background-color: #238636; color: #FFFFFF;"
            " font-weight: bold; font-size: 12px; padding: 10px;"
            " border-radius: 6px; border: 1px solid #2EA043; text-align: left; }"
            "QPushButton:hover { background-color: #2EA043; }"
            "QPushButton:disabled { background-color: #21262D; color: #484F58;"
            " border-color: #30363D; }"
        )
        self.btn_rotate.clicked.connect(self._handle_rotate_key)
        layout.addWidget(self.btn_rotate)

        self.rotate_hint = QLabel(
            "La clé est régénérée pour cette licence avec les mêmes quotas et la "
            "même formule, puis chiffrée et depositée en garde-vous côté Cloud."
        )
        self.rotate_hint.setWordWrap(True)
        self.rotate_hint.setStyleSheet("color: #6E7681; font-size: 11px;")
        layout.addWidget(self.rotate_hint)

        # Path B -- manual link.
        manual_label = QLabel("Ou associer manuellement une clé existante :")
        manual_label.setStyleSheet("color: #8B949E; font-size: 11px; font-weight: bold;")
        layout.addWidget(manual_label)

        manual_row = QHBoxLayout()
        manual_row.setSpacing(8)
        self.input_manual_key = QLineEdit()
        self.input_manual_key.setPlaceholderText("MOBI-LIFE-XXXX-XXXX")
        self.input_manual_key.setStyleSheet(
            "QLineEdit { background: #0D1117; color: #58A6FF;"
            " font-family: Consolas, monospace; padding: 6px;"
            " border: 1px solid #30363D; border-radius: 6px; }"
        )
        self.input_manual_key.returnPressed.connect(self._handle_manual_link)
        manual_row.addWidget(self.input_manual_key, 1)

        self.btn_save_manual = QPushButton("Associer")
        self.btn_save_manual.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_save_manual.setStyleSheet(
            "QPushButton { background: #21262D; color: #C9D1D9; font-size: 11px;"
            " font-weight: bold; padding: 6px 12px; border-radius: 6px;"
            " border: 1px solid #30363D; }"
            "QPushButton:hover { background: #30363D; color: #FFFFFF; }"
        )
        self.btn_save_manual.clicked.connect(self._handle_manual_link)
        manual_row.addWidget(self.btn_save_manual)
        layout.addLayout(manual_row)

        # Path C -- cloud id.
        self.btn_cloud_id = QPushButton(
            f"🔗  Utiliser l'identifiant Cloud ({self.record.id[:8] or 'n/a'}) pour le QR"
        )
        self.btn_cloud_id.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_cloud_id.setStyleSheet(
            "QPushButton { background: #21262D; color: #79C0FF; font-size: 12px;"
            " padding: 10px; border-radius: 6px; border: 1px solid #30363D;"
            " text-align: left; }"
            "QPushButton:hover { background: #30363D; color: #FFFFFF; }"
        )
        self.btn_cloud_id.clicked.connect(self._handle_cloud_id)
        layout.addWidget(self.btn_cloud_id)

        self.cloud_hint = QLabel(
            "Utile quand le client n'a jamais reçu de clé : le QR transmettra "
            "l'identifiant Cloud, que le poste peut valider directement."
        )
        self.cloud_hint.setWordWrap(True)
        self.cloud_hint.setStyleSheet("color: #6E7681; font-size: 11px;")
        layout.addWidget(self.cloud_hint)

        layout.addStretch()

        btn_cancel = QPushButton("Annuler")
        btn_cancel.setCursor(Qt.CursorShape.PointingHandCursor)
        btn_cancel.setStyleSheet(
            "QPushButton { background: transparent; color: #8B949E;"
            " border: none; padding: 6px; }"
            "QPushButton:hover { color: #F0F6FC; }"
        )
        btn_cancel.clicked.connect(self.reject)
        layout.addWidget(btn_cancel)

    # -- paths ------------------------------------------------------------
    def _handle_rotate_key(self) -> None:
        """
        Path A: mint a fresh key and persist it against this licence.

        Deliberately does NOT call the edge signing endpoint. That endpoint
        creates a *new* licence row from (customer, formula, seats); calling it
        here would leave two active licences for one customer instead of
        rotating the existing one. Server-side rotation needs a dedicated
        update-key route, which does not exist yet.
        """
        from ..core.crypto import encrypt_data, generate_license_key
        from ..core.api import record_in_ledger

        new_key = generate_license_key(self.record.formula)
        self.resolved_key = new_key
        self.use_cloud_id = False

        entry = {
            "id": self.record.id,
            "customer": self.record.customer,
            "licenseKey": new_key,
            "type": self.record.formula,
            "status": self.record.raw_status,
            "created_at": self.record.created_at,
            "notes": f"Clé régénérée localement le "
                     f"{datetime.datetime.now():%Y-%m-%d %H:%M}.",
        }
        try:
            record_in_ledger(entry)
        except Exception as exc:  # ledger is the whole point of this path
            QMessageBox.critical(
                self,
                "Échec de l'écriture locale",
                f"La nouvelle clé n'a pas pu être enregistrée :\n{exc}",
            )
            return

        self._escrow(new_key)
        self.key_resolved.emit(self.record.id, new_key)
        self.accept()

    def _handle_manual_link(self) -> None:
        """Path B: adopt a key the operator already holds."""
        from ..core.api import record_in_ledger
        from ..core.crypto import normalize_key

        key = self.input_manual_key.text().strip().upper()
        if not key:
            return
        if not key.startswith("MOBI-"):
            QMessageBox.warning(
                self,
                "Format invalide",
                "La clé doit respecter le format MOBI-… (ex. MOBI-LIFE-ABCD-EFGH).",
            )
            return
        if len(normalize_key(key)) < 8:
            QMessageBox.warning(self, "Format invalide", "Cette clé est trop courte.")
            return

        self.resolved_key = key
        self.use_cloud_id = False
        try:
            record_in_ledger({
                "id": self.record.id,
                "customer": self.record.customer,
                "licenseKey": key,
                "type": self.record.formula,
                "status": self.record.raw_status,
                "created_at": self.record.created_at,
            })
        except Exception as exc:
            QMessageBox.critical(
                self,
                "Échec de l'écriture locale",
                f"La clé n'a pas pu être enregistrée :\n{exc}",
            )
            return

        self._escrow(key)
        self.key_resolved.emit(self.record.id, key)
        self.accept()

    def _handle_cloud_id(self) -> None:
        """Path C: continue with the cloud identifier."""
        self.resolved_key = ""
        self.use_cloud_id = True
        self.accept()

    def _escrow(self, key: str) -> None:
        """
        Best-effort escrow upload. Never blocks resolution: the operator has
        already recovered the key locally, and a failed upload only means the
        next machine will need this dialog again.
        """
        if self.api_client is None:
            return
        try:
            from ..core.crypto import encrypt_data
            self.api_client.put_key_escrow(self.record.id, encrypt_data(key))
        except Exception:
            pass


# =========================================================================
# 1. New License Dialog
# =========================================================================

class NewLicenseDialog(QDialog):
    """
    Dialog to issue and configure a new license key, sync it to Cloudflare,
    record customer metadata (phone, city, notes), and generate WhatsApp instructions.
    """
    license_created = pyqtSignal(dict)

    def __init__(self, api_client: AdminApiClient, parent=None):
        super().__init__(parent)
        self.api_client = api_client
        self.setWindowTitle("✨ Nouvelle Licence MobiPOS")
        self.setMinimumSize(720, 780)
        self.resize(760, 820)
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(14)
        layout.setContentsMargins(24, 24, 24, 24)

        # Title Header
        title = QLabel("Créer et Déployer une Nouvelle Licence")
        title.setObjectName("SectionHeader")
        subtitle = QLabel("Générez une clé cryptographique unique et synchronisez-la instantanément sur le serveur mondial.")
        subtitle.setStyleSheet("color: #94a3b8; font-size: 12px;")
        layout.addWidget(title)
        layout.addWidget(subtitle)

        # Form Container
        form_frame = QFrame()
        form_frame.setObjectName("MetricCard")
        form_layout = QGridLayout(form_frame)
        form_layout.setVerticalSpacing(12)
        form_layout.setHorizontalSpacing(14)

        # 1. Customer Name
        lbl_cust = QLabel("👤 Nom du Client / Établissement :")
        lbl_cust.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        form_layout.addWidget(lbl_cust, 0, 0)
        self.cust_input = QLineEdit()
        self.cust_input.setPlaceholderText("Ex: Superette Al-Amine, Pharmacie Centrale...")
        self.cust_input.textChanged.connect(self.update_whatsapp_preview)
        form_layout.addWidget(self.cust_input, 0, 1, 1, 2)

        # 2. Phone (WhatsApp) & City
        lbl_phone = QLabel("📱 Téléphone (WhatsApp) :")
        lbl_phone.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        form_layout.addWidget(lbl_phone, 1, 0)
        self.phone_input = QLineEdit()
        self.phone_input.setPlaceholderText("Ex: +213 555 12 34 56 ou 0555123456")
        form_layout.addWidget(self.phone_input, 1, 1)

        self.city_input = QLineEdit()
        self.city_input.setPlaceholderText("Ville (ex: Alger, Oran, Constantine...)")
        form_layout.addWidget(self.city_input, 1, 2)

        # 3. Formula Type
        lbl_type = QLabel("📌 Formule / Type :")
        lbl_type.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        form_layout.addWidget(lbl_type, 2, 0)
        self.type_combo = QComboBox()
        self.type_combo.addItems([
            "LIFETIME (Illimitée à Vie)",
            "90D (3 Mois / Trimestre)",
            "24H (Démo 24 Heures)",
            "30D (1 Mois)",
            "1Y (Annuel)",
            "CUSTOM (Personnalisée)"
        ])
        self.type_combo.currentIndexChanged.connect(self.on_formula_changed)
        form_layout.addWidget(self.type_combo, 2, 1, 1, 2)

        # 4. Quotas
        lbl_desk = QLabel("🖥️ Postes Caisses (PC Windows) :")
        lbl_desk.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        form_layout.addWidget(lbl_desk, 3, 0)
        self.desktops_spin = QSpinBox()
        self.desktops_spin.setRange(0, 100)
        self.desktops_spin.setValue(1)
        self.desktops_spin.valueChanged.connect(self.update_whatsapp_preview)
        form_layout.addWidget(self.desktops_spin, 3, 1)

        lbl_mob = QLabel("📱 Mobiles Compagnons :")
        lbl_mob.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        form_layout.addWidget(lbl_mob, 4, 0)
        self.mobiles_spin = QSpinBox()
        self.mobiles_spin.setRange(0, 100)
        self.mobiles_spin.setValue(2)
        self.mobiles_spin.valueChanged.connect(self.update_whatsapp_preview)
        form_layout.addWidget(self.mobiles_spin, 4, 1)

        # Presets Buttons Row
        lbl_presets = QLabel("⚡ Profils Recommandés :")
        lbl_presets.setStyleSheet("font-weight: 600; color: #94a3b8; font-size: 11px;")
        form_layout.addWidget(lbl_presets, 5, 0)

        presets_layout = QHBoxLayout()
        presets_layout.setSpacing(6)

        btn_std = QPushButton("🏪 Supérette (1 PC + 2 Mob)")
        btn_std.setObjectName("PresetBtn")
        btn_std.clicked.connect(lambda: self.apply_preset(1, 2))
        presets_layout.addWidget(btn_std)

        btn_hyp = QPushButton("🏢 Hyper (2 PC + 4 Mob)")
        btn_hyp.setObjectName("PresetBtn")
        btn_hyp.clicked.connect(lambda: self.apply_preset(2, 4))
        presets_layout.addWidget(btn_hyp)

        btn_sgl = QPushButton("🏬 Boutique (1 PC Seul)")
        btn_sgl.setObjectName("PresetBtn")
        btn_sgl.clicked.connect(lambda: self.apply_preset(1, 0))
        presets_layout.addWidget(btn_sgl)

        btn_mob = QPushButton("📱 Nomade (0 PC + 3 Mob)")
        btn_mob.setObjectName("PresetBtn")
        btn_mob.clicked.connect(lambda: self.apply_preset(0, 3))
        presets_layout.addWidget(btn_mob)

        form_layout.addLayout(presets_layout, 5, 1, 1, 2)

        # 5. Internal Notes
        lbl_notes = QLabel("📝 Notes Commerciales :")
        lbl_notes.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        form_layout.addWidget(lbl_notes, 6, 0)
        self.notes_input = QLineEdit()
        self.notes_input.setPlaceholderText("Ex: Payé en espèces, matériel POS fourni, contact direct M. Karim...")
        form_layout.addWidget(self.notes_input, 6, 1, 1, 2)

        # 6. Optional Turso BYODB
        lbl_turl = QLabel("☁️ URL Base Turso (Optionnel) :")
        lbl_turl.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        form_layout.addWidget(lbl_turl, 7, 0)
        self.turso_url_input = QLineEdit()
        self.turso_url_input.setPlaceholderText("libsql://client-db.turso.io (laisser vide si géré par le client)")
        form_layout.addWidget(self.turso_url_input, 7, 1, 1, 2)

        lbl_ttok = QLabel("🔑 Jeton Turso (Optionnel) :")
        lbl_ttok.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        form_layout.addWidget(lbl_ttok, 8, 0)
        self.turso_token_input = QLineEdit()
        self.turso_token_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.turso_token_input.setPlaceholderText("Jeton sécurisé Turso du client (chiffré AES-256)")
        form_layout.addWidget(self.turso_token_input, 8, 1, 1, 2)

        # 7. Key Preview & Refresh
        lbl_key = QLabel("🔑 Clé Générée :")
        lbl_key.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        form_layout.addWidget(lbl_key, 9, 0)
        self.key_preview = QLineEdit()
        self.key_preview.setReadOnly(True)
        self.key_preview.setStyleSheet(
            "font-size: 15px; font-weight: 800; color: #10b981; "
            "letter-spacing: 1.2px; font-family: Consolas, monospace; background-color: #090e1a;"
        )
        form_layout.addWidget(self.key_preview, 9, 1)

        self.btn_regen = QPushButton("🔄 Nouveau")
        self.btn_regen.clicked.connect(self.regenerate_key)
        form_layout.addWidget(self.btn_regen, 9, 2)

        layout.addWidget(form_frame)

        # WhatsApp Preview Box
        wa_label = QLabel("💬 Message Client Formaté (WhatsApp / SMS) :")
        wa_label.setStyleSheet("font-weight: 700; color: #94a3b8; font-size: 11px;")
        layout.addWidget(wa_label)

        self.wa_preview = QTextEdit()
        self.wa_preview.setReadOnly(True)
        self.wa_preview.setMaximumHeight(130)
        layout.addWidget(self.wa_preview)

        # Status indicator
        self.status_label = QLabel("")
        self.status_label.setStyleSheet("color: #10b981; font-weight: 700; font-size: 12px;")
        layout.addWidget(self.status_label)

        # Buttons Row
        btn_layout = QHBoxLayout()
        self.btn_copy_wa = QPushButton("📋 Copier WhatsApp")
        self.btn_copy_wa.setObjectName("WhatsAppBtn")
        self.btn_copy_wa.clicked.connect(self.copy_whatsapp)
        btn_layout.addWidget(self.btn_copy_wa)

        btn_layout.addStretch()

        self.btn_cancel = QPushButton("Annuler")
        self.btn_cancel.clicked.connect(self.reject)
        btn_layout.addWidget(self.btn_cancel)

        self.btn_submit = QPushButton("🚀 Créer et Activer sur le Serveur")
        self.btn_submit.setObjectName("PrimaryBtn")
        self.btn_submit.clicked.connect(self.submit_license)
        btn_layout.addWidget(self.btn_submit)

        layout.addLayout(btn_layout)

        # Initial key generation
        self.regenerate_key()

    def apply_preset(self, desktops: int, mobiles: int):
        self.desktops_spin.setValue(desktops)
        self.mobiles_spin.setValue(mobiles)
        self.update_whatsapp_preview()

    def get_selected_formula(self) -> str:
        txt = self.type_combo.currentText()
        if "LIFETIME" in txt:
            return "LIFETIME"
        elif "90D" in txt:
            return "90D"
        elif "24H" in txt:
            return "24H"
        elif "30D" in txt:
            return "30D"
        elif "1Y" in txt:
            return "1Y"
        return "CUSTOM"

    def on_formula_changed(self):
        self.regenerate_key()

    def regenerate_key(self):
        formula = self.get_selected_formula()
        new_key = generate_license_key(formula)
        self.key_preview.setText(new_key)
        self.update_whatsapp_preview()

    def update_whatsapp_preview(self):
        cust = self.cust_input.text().strip() or "Cher Client"
        key = self.key_preview.text().strip()
        formula = self.get_selected_formula()
        desktops = self.desktops_spin.value()
        mobiles = self.mobiles_spin.value()

        expires_str = None
        if formula == "24H":
            expires_str = "24 Heures"
        elif formula == "90D":
            expires_str = "90 Jours (3 Mois)"
        elif formula == "30D":
            expires_str = "30 Jours"
        elif formula == "1Y":
            expires_str = "1 An (365 Jours)"

        msg = build_whatsapp_message(cust, key, formula, desktops, mobiles, expires_str)
        self.wa_preview.setPlainText(msg)

    def copy_whatsapp(self):
        QApplication.clipboard().setText(self.wa_preview.toPlainText())
        self.status_label.setText("✅ Message WhatsApp copié dans le presse-papier !")

    def submit_license(self):
        customer = self.cust_input.text().strip()
        if not customer:
            QMessageBox.warning(self, "Champ requis", "Veuillez renseigner le nom du client ou du magasin.")
            self.cust_input.setFocus()
            return

        formula = self.get_selected_formula()
        key = self.key_preview.text().strip()
        desktops = self.desktops_spin.value()
        mobiles = self.mobiles_spin.value()
        phone = self.phone_input.text().strip()
        city = self.city_input.text().strip()
        notes = self.notes_input.text().strip()
        turso_url = self.turso_url_input.text().strip()
        turso_token = self.turso_token_input.text().strip()

        # Calculate expiration
        now = datetime.datetime.now(datetime.timezone.utc)
        expires_at = None
        if formula == "24H":
            expires_at = (now + datetime.timedelta(days=1)).isoformat()
        elif formula == "90D":
            expires_at = (now + datetime.timedelta(days=90)).isoformat()
        elif formula == "30D":
            expires_at = (now + datetime.timedelta(days=30)).isoformat()
        elif formula == "1Y":
            expires_at = (now + datetime.timedelta(days=365)).isoformat()

        # Encrypt token
        encrypted_turso_token = "NONE"
        if turso_token:
            try:
                encrypted_turso_token = encrypt_turso_token(turso_token)
            except Exception as e:
                QMessageBox.critical(self, "Erreur de chiffrement", f"Échec du chiffrement du token: {e}")
                return

        # Prepare payload
        key_h = hash_key(key)
        lic_id = f"lic_{os.urandom(8).hex()}"
        now_iso = now.isoformat()

        license_record = {
            "id": lic_id,
            "customer": customer,
            "customer_name": customer,
            "licenseKey": key,
            "license_key": key,
            "key_hash": key_h,
            "type": formula,
            "license_type": formula,
            "status": "active",
            "desktops": desktops,
            "max_desktops": desktops,
            "mobiles": mobiles,
            "max_mobiles": mobiles,
            "phone": phone,
            "city": city,
            "notes": notes,
            "tursoUrl": turso_url,
            "turso_url": turso_url,
            "encryptedTursoToken": encrypted_turso_token,
            "encrypted_turso_token": encrypted_turso_token,
            "createdAt": now_iso,
            "created_at": now_iso,
            "expiresAt": expires_at,
            "expires_at": expires_at
        }

        # 1. Save in local ledger & log audit
        record_in_ledger(license_record)
        record_audit_event(
            "CREATE_LICENSE",
            f"Création formule {formula} (PC:{desktops}, Mob:{mobiles}, Ville:{city or '-'}, Tél:{phone or '-'})",
            customer,
            key
        )

        # 2. Push to Cloudflare Worker
        self.btn_submit.setEnabled(False)
        self.status_label.setText("⏳ Déploiement sur Cloudflare Worker Edge...")
        QApplication.processEvents()

        try:
            success = self.api_client.sync_license(license_record)
            if success:
                self.status_label.setText("✅ Licence créée et active sur le Cloud mondial !")
                QMessageBox.information(
                    self,
                    "Succès",
                    f"🎉 La licence pour '{customer}' a été créée avec succès !\n\n"
                    f"Clé : {key}\n"
                    f"Caisses : {desktops} | Mobiles : {mobiles}\n\n"
                    f"Elle est immédiatement active sur le serveur mondial Cloudflare."
                )
                self.license_created.emit(license_record)
                self.accept()
            else:
                QMessageBox.warning(self, "Synchronisation Partielle", "La clé a été enregistrée en local mais la réponse Cloud était inattendue.")
                self.license_created.emit(license_record)
                self.accept()
        except Exception as e:
            QMessageBox.critical(
                self,
                "Erreur de Connexion Cloud",
                f"La licence a été enregistrée dans le registre local, mais l'envoi à Cloudflare a échoué :\n{e}\n\n"
                f"Vous pourrez la synchroniser ultérieurement via le bouton 'Actualiser'."
            )
            self.license_created.emit(license_record)
            self.accept()


# =========================================================================
# 2. Devices Inspector Dialog
# =========================================================================

class DevicesDialog(QDialog):
    """
    Connected Devices Inspector.
    Displays all active HWIDs/machines bound to a customer's license,
    with options to unbind a single device or reset all seats.
    """
    devices_changed = pyqtSignal()

    def __init__(self, license_data: Dict[str, Any], api_client: AdminApiClient, parent=None):
        super().__init__(parent)
        self.license_data = license_data
        self.api_client = api_client
        self.setWindowTitle(f"📱 Appareils Connectés — {license_data.get('customer', 'Client')}")
        self.setMinimumSize(940, 540)
        self.resize(1000, 580)
        self.init_ui()
        self.load_devices()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(14)
        layout.setContentsMargins(22, 22, 22, 22)

        # Header Info Card
        header = QFrame()
        header.setObjectName("MetricCard")
        h_layout = QHBoxLayout(header)
        h_layout.setContentsMargins(14, 12, 14, 12)

        info_v = QVBoxLayout()
        info_v.setSpacing(4)
        cust_label = QLabel(f"👤 {self.license_data.get('customer', 'Client')}")
        cust_label.setStyleSheet("font-size: 17px; font-weight: 800; color: #ffffff;")
        key_label = QLabel(f"🔑 Clé : {self.license_data.get('licenseKey', '')}")
        key_label.setStyleSheet("font-size: 13px; font-weight: 700; color: #10b981; font-family: Consolas, monospace;")
        info_v.addWidget(cust_label)
        info_v.addWidget(key_label)
        h_layout.addLayout(info_v)

        h_layout.addStretch()

        self.quota_summary = QLabel("")
        self.quota_summary.setStyleSheet("font-size: 13px; font-weight: 700; color: #f1f5f9;")
        h_layout.addWidget(self.quota_summary)

        layout.addWidget(header)

        # Devices Table
        self.table = QTableWidget()
        self.table.setColumnCount(7)
        self.table.setHorizontalHeaderLabels([
            "Type", "Nom de l'Appareil", "HWID / Empreinte", "Activé le", "Dernier Ping", "Statut", "Action"
        ])
        self.table.verticalHeader().setDefaultSectionSize(48)
        self.table.setColumnWidth(0, 170)
        self.table.setColumnWidth(1, 170)
        self.table.setColumnWidth(3, 150)
        self.table.setColumnWidth(4, 160)
        self.table.setColumnWidth(5, 90)
        self.table.setColumnWidth(6, 110)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        self.table.verticalHeader().setVisible(False)
        self.table.setAlternatingRowColors(True)
        layout.addWidget(self.table)

        # Footer Buttons
        footer = QHBoxLayout()
        self.btn_reset_all = QPushButton("⚠️ Réinitialiser TOUS les Postes")
        self.btn_reset_all.setObjectName("DangerBtn")
        self.btn_reset_all.clicked.connect(self.reset_all_seats)
        footer.addWidget(self.btn_reset_all)

        footer.addStretch()

        self.btn_refresh = QPushButton("🔄 Actualiser")
        self.btn_refresh.clicked.connect(self.load_devices)
        footer.addWidget(self.btn_refresh)

        btn_close = QPushButton("Fermer")
        btn_close.clicked.connect(self.accept)
        footer.addWidget(btn_close)

        layout.addLayout(footer)

    def load_devices(self):
        raw_key = self.license_data.get("licenseKey", "")
        if not raw_key or raw_key.startswith("["):
            # The main window resolves the key before opening this dialog, so
            # reaching here means it was opened without a key on purpose (the
            # cloud-id path) or by another caller. Render an empty list instead
            # of raising a modal warning on top of this one, which is what made
            # the flow feel like a dead end.
            cloud_id = self.license_data.get("cloudId") or self.license_data.get("id", "")
            self.populate_table([])
            self.btn_refresh.setEnabled(True)
            self.btn_refresh.setToolTip(
                "Aucun appareil à lister : cette licence n'a pas de clé en clair"
                + (f" (identifiant Cloud {cloud_id[:8]})." if cloud_id else ".")
            )
            return

        self.btn_refresh.setEnabled(False)
        QApplication.processEvents()

        try:
            devices = self.api_client.get_devices(raw_key)
            self.populate_table(devices)
        except Exception as e:
            QMessageBox.critical(self, "Erreur Réseau", f"Impossible de récupérer les appareils :\n{e}")
        finally:
            self.btn_refresh.setEnabled(True)

    def populate_table(self, devices: list):
        self.table.setRowCount(len(devices))
        desktops_count = 0
        mobiles_count = 0
        now_ts = datetime.datetime.now(datetime.timezone.utc)

        for row, dev in enumerate(devices):
            dev_type = dev.get("device_type", "desktop")
            if dev_type == "desktop":
                type_lbl = QLabel('<span style="background-color: #064e3b; color: #6ee7b7; border: 1px solid #059669; padding: 4px 10px; border-radius: 6px; font-weight: 700; font-size: 11px;">🖥️ Caisse PC (Windows)</span>')
                desktops_count += 1
            else:
                type_lbl = QLabel('<span style="background-color: #3b0764; color: #d8b4fe; border: 1px solid #7e22ce; padding: 4px 10px; border-radius: 6px; font-weight: 700; font-size: 11px;">📱 Mobile (Android)</span>')
                mobiles_count += 1
            type_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
            self.table.setCellWidget(row, 0, type_lbl)

            name_item = QTableWidgetItem(dev.get("friendly_name") or "Sans nom")
            name_item.setFont(QFont("Segoe UI", 10, QFont.Weight.Bold))
            self.table.setItem(row, 1, name_item)

            hwid = dev.get("device_id") or dev.get("hardware_hash") or "Inconnu"
            hw_widget = QWidget()
            hw_layout = QHBoxLayout(hw_widget)
            hw_layout.setContentsMargins(4, 2, 4, 2)
            hw_layout.setSpacing(6)
            hw_lbl = QLabel(hwid[:30] + ("..." if len(hwid) > 30 else ""))
            hw_lbl.setFont(QFont("Consolas", 9))
            hw_lbl.setStyleSheet("color: #cbd5e1;")
            hw_layout.addWidget(hw_lbl)
            btn_cp = QPushButton("📋")
            btn_cp.setToolTip("Copier HWID")
            btn_cp.setObjectName("TableBtn")
            btn_cp.setFixedWidth(28)
            btn_cp.clicked.connect(lambda _, h=hwid: QApplication.clipboard().setText(h))
            hw_layout.addWidget(btn_cp)
            hw_layout.addStretch()
            self.table.setCellWidget(row, 2, hw_widget)

            # Dates
            act_date = (dev.get("activated_at") or "").replace("T", " ")[:19]
            self.table.setItem(row, 3, QTableWidgetItem(act_date))

            raw_ping = dev.get("last_ping_at") or ""
            ping_text = raw_ping.replace("T", " ")[:19]
            if raw_ping:
                try:
                    p_dt = datetime.datetime.fromisoformat(raw_ping.replace("Z", "+00:00"))
                    diff_sec = (now_ts - p_dt).total_seconds()
                    if diff_sec < 300:
                        ping_text = "🟢 En ligne (à l'instant)"
                    elif diff_sec < 3600:
                        ping_text = f"Il y a {int(diff_sec // 60)} min"
                    elif diff_sec < 86400:
                        ping_text = f"Il y a {int(diff_sec // 3600)} h"
                except Exception:
                    pass
            self.table.setItem(row, 4, QTableWidgetItem(ping_text))

            # Status
            status_item = QTableWidgetItem("🟢 Actif")
            status_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
            self.table.setItem(row, 5, status_item)

            # Action button: Unbind
            btn_unbind = QPushButton("❌ Détacher")
            btn_unbind.setObjectName("TableBtn")
            btn_unbind.setStyleSheet("background-color: #7f1d1d; color: #fca5a5; border: 1px solid #991b1b;")
            dev_id = dev.get("device_id", "")
            btn_unbind.clicked.connect(lambda _, d_id=dev_id: self.unbind_device(d_id))
            self.table.setCellWidget(row, 6, btn_unbind)

        # Update summary text
        max_d = self.license_data.get("desktops", 1)
        max_m = self.license_data.get("mobiles", 2)
        rem_d = max_d - desktops_count
        rem_m = max_m - mobiles_count
        self.quota_summary.setText(
            f"🖥️ Caisses : {desktops_count}/{max_d} ({'Plein' if rem_d <= 0 else f'{rem_d} libre(s)'})   |   "
            f"📱 Mobiles : {mobiles_count}/{max_m} ({'Plein' if rem_m <= 0 else f'{rem_m} libre(s)'})"
        )

    def unbind_device(self, device_id: str):
        confirm = QMessageBox.question(
            self,
            "Confirmer le détachement",
            f"Voulez-vous détacher cet appareil ?\n\nHWID : {device_id}\n\n"
            f"Cela libérera immédiatement une place (poste caisse ou mobile).",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return

        raw_key = self.license_data.get("licenseKey", "")
        try:
            success = self.api_client.unbind_single_device(raw_key, device_id)
            if success:
                record_audit_event("UNBIND_DEVICE", f"Détachement appareil {device_id}", self.license_data.get("customer", ""), raw_key)
                QMessageBox.information(self, "Appareil Détaché", "L'appareil a été délié avec succès.")
                self.load_devices()
                self.devices_changed.emit()
            else:
                QMessageBox.warning(self, "Attention", "L'appareil n'a pas pu être délié.")
        except Exception as e:
            QMessageBox.critical(self, "Erreur", f"Échec du détachement : {e}")

    def reset_all_seats(self):
        confirm = QMessageBox.warning(
            self,
            "⚠️ Confirmation de Réinitialisation Complète",
            "Cette action va déconnecter TOUS les postes de caisse et smartphones connectés à cette licence.\n\n"
            "Le client pourra ensuite activer de nouvelles machines jusqu'à son quota.\n\n"
            "Voulez-vous vraiment continuer ?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return

        raw_key = self.license_data.get("licenseKey", "")
        try:
            cleared = self.api_client.reset_seats(raw_key)
            record_audit_event("RESET_SEATS", f"Réinitialisation de tous les postes ({cleared} libérés)", self.license_data.get("customer", ""), raw_key)
            QMessageBox.information(
                self,
                "Postes Réinitialisés",
                f"✅ {cleared} poste(s) ont été libérés avec succès."
            )
            self.load_devices()
            self.devices_changed.emit()
        except Exception as e:
            QMessageBox.critical(self, "Erreur", f"Échec de la réinitialisation : {e}")


# =========================================================================
# 3. Update Quotas Dialog
# =========================================================================

class UpdateQuotasDialog(QDialog):
    """
    Dialog to modify max_desktops and max_mobiles quotas on Cloudflare.
    """
    quotas_updated = pyqtSignal(dict)

    def __init__(self, license_data: Dict[str, Any], api_client: AdminApiClient, parent=None):
        super().__init__(parent)
        self.license_data = license_data
        self.api_client = api_client
        self.setWindowTitle(f"⚙️ Modifier Quotas — {license_data.get('customer', 'Client')}")
        self.setFixedSize(500, 320)
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(24, 24, 24, 24)

        title = QLabel("Ajuster les Quotas d'Appareils")
        title.setObjectName("SectionHeader")
        subtitle = QLabel("Modifiez le nombre maximal de postes autorisés pour ce client.")
        subtitle.setStyleSheet("color: #94a3b8; font-size: 12px;")
        layout.addWidget(title)
        layout.addWidget(subtitle)

        form_frame = QFrame()
        form_frame.setObjectName("MetricCard")
        grid = QGridLayout(form_frame)
        grid.setVerticalSpacing(12)
        grid.setHorizontalSpacing(14)

        lbl_desk = QLabel("🖥️ Postes Caisses (PC) :")
        lbl_desk.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        grid.addWidget(lbl_desk, 0, 0)
        self.desktops_spin = QSpinBox()
        self.desktops_spin.setRange(0, 100)
        self.desktops_spin.setValue(int(self.license_data.get("desktops", 1)))
        grid.addWidget(self.desktops_spin, 0, 1)

        lbl_mob = QLabel("📱 Mobiles Compagnons :")
        lbl_mob.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        grid.addWidget(lbl_mob, 1, 0)
        self.mobiles_spin = QSpinBox()
        self.mobiles_spin.setRange(0, 100)
        self.mobiles_spin.setValue(int(self.license_data.get("mobiles", 2)))
        grid.addWidget(self.mobiles_spin, 1, 1)

        layout.addWidget(form_frame)

        # Buttons
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()

        btn_cancel = QPushButton("Annuler")
        btn_cancel.clicked.connect(self.reject)
        btn_layout.addWidget(btn_cancel)

        self.btn_save = QPushButton("💾 Enregistrer les Quotas")
        self.btn_save.setObjectName("PrimaryBtn")
        self.btn_save.clicked.connect(self.save_quotas)
        btn_layout.addWidget(self.btn_save)

        layout.addLayout(btn_layout)

    def save_quotas(self):
        new_d = self.desktops_spin.value()
        new_m = self.mobiles_spin.value()
        raw_key = self.license_data.get("licenseKey", "")

        self.btn_save.setEnabled(False)
        QApplication.processEvents()

        try:
            success = self.api_client.update_seats(raw_key, new_d, new_m)
            if success:
                self.license_data["desktops"] = new_d
                self.license_data["mobiles"] = new_m
                record_in_ledger(self.license_data)
                record_audit_event("UPDATE_QUOTAS", f"Quotas modifiés: {new_d} PC, {new_m} Mobiles", self.license_data.get("customer", ""), raw_key)
                QMessageBox.information(self, "Quotas Mis à Jour", "Les nouveaux quotas ont été appliqués avec succès.")
                self.quotas_updated.emit(self.license_data)
                self.accept()
            else:
                QMessageBox.warning(self, "Attention", "Le serveur n'a pas confirmé la mise à jour.")
        except Exception as e:
            QMessageBox.critical(self, "Erreur", f"Échec de la mise à jour des quotas : {e}")
        finally:
            self.btn_save.setEnabled(True)


# =========================================================================
# 4. WhatsApp Message Dialog
# =========================================================================

class WhatsAppMessageDialog(QDialog):
    """
    Dialog to view, copy, or launch WhatsApp Web with prefilled message for a client.
    Automatically routes to the client's direct WhatsApp chat if phone is provided.
    """
    def __init__(self, license_data: Dict[str, Any], parent=None):
        super().__init__(parent)
        self.license_data = license_data
        self.setWindowTitle(f"💬 Message WhatsApp — {license_data.get('customer', 'Client')}")
        self.setMinimumSize(640, 520)
        self.resize(680, 540)
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(14)
        layout.setContentsMargins(22, 22, 22, 22)

        title = QLabel("Message Client Prêt pour Envoi (WhatsApp / SMS)")
        title.setObjectName("SectionHeader")
        layout.addWidget(title)

        # Phone field card
        phone_card = QFrame()
        phone_card.setObjectName("MetricCard")
        p_layout = QHBoxLayout(phone_card)
        p_layout.setContentsMargins(12, 8, 12, 8)
        lbl_p = QLabel("📱 Numéro Téléphone (WhatsApp) :")
        lbl_p.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        p_layout.addWidget(lbl_p)
        self.phone_input = QLineEdit(self.license_data.get("phone", ""))
        self.phone_input.setPlaceholderText("Ex: +213 555 12 34 56 ou 0555123456")
        p_layout.addWidget(self.phone_input)
        layout.addWidget(phone_card)

        cust = self.license_data.get("customer", "Client")
        key = self.license_data.get("licenseKey", "")
        formula = self.license_data.get("type", "LIFETIME")
        desktops = self.license_data.get("desktops", 1)
        mobiles = self.license_data.get("mobiles", 2)
        expires = self.license_data.get("expiresAt")

        text = build_whatsapp_message(cust, key, formula, desktops, mobiles, expires)

        self.editor = QTextEdit()
        self.editor.setPlainText(text)
        layout.addWidget(self.editor)

        # Status
        self.status_label = QLabel("")
        self.status_label.setStyleSheet("color: #10b981; font-weight: 700;")
        layout.addWidget(self.status_label)

        # Buttons
        btn_layout = QHBoxLayout()
        btn_copy = QPushButton("📋 Copier le Message")
        btn_copy.setObjectName("WhatsAppBtn")
        btn_copy.clicked.connect(self.copy_text)
        btn_layout.addWidget(btn_copy)

        btn_web_wa = QPushButton("🌐 Ouvrir WhatsApp Web")
        btn_web_wa.clicked.connect(self.open_whatsapp_web)
        btn_layout.addWidget(btn_web_wa)

        btn_layout.addStretch()

        btn_close = QPushButton("Fermer")
        btn_close.clicked.connect(self.accept)
        btn_layout.addWidget(btn_close)

        layout.addLayout(btn_layout)

    def copy_text(self):
        QApplication.clipboard().setText(self.editor.toPlainText())
        self.status_label.setText("✅ Message copié dans le presse-papier !")

    def open_whatsapp_web(self):
        phone_raw = self.phone_input.text().strip()
        if phone_raw and phone_raw != self.license_data.get("phone"):
            self.license_data["phone"] = phone_raw
            update_customer_metadata(self.license_data.get("licenseKey", ""), phone=phone_raw)

        clean_phone = re.sub(r"[^\d+]", "", phone_raw)
        if clean_phone.startswith("0") and len(clean_phone) == 10:
            clean_phone = "213" + clean_phone[1:]
        elif clean_phone.startswith("+"):
            clean_phone = clean_phone[1:]

        msg = self.editor.toPlainText().strip()
        encoded = urllib.parse.quote(msg)
        if clean_phone:
            url = f"https://web.whatsapp.com/send?phone={clean_phone}&text={encoded}"
        else:
            url = f"https://web.whatsapp.com/send?text={encoded}"

        webbrowser.open(url)
        self.status_label.setText(f"🚀 Ouverture de WhatsApp Web ({clean_phone or 'contact au choix'})...")


# =========================================================================
# 5. Offline Token Signer Dialog
# =========================================================================

class OfflineTokenDialog(QDialog):
    """
    Cryptographic Ed25519 Offline Token Generator.
    Mints signed JWS for client machines without internet.
    """
    def __init__(self, default_license: Optional[Dict[str, Any]] = None, parent=None):
        super().__init__(parent)
        self.default_license = default_license or {}
        self.setWindowTitle("🔏 Générateur de Jeton Hors-Ligne Ed25519")
        self.setMinimumSize(720, 640)
        self.resize(760, 680)
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(14)
        layout.setContentsMargins(24, 24, 24, 24)

        title = QLabel("Signature Cryptographique Offline (Air-Gapped)")
        title.setObjectName("SectionHeader")
        subtitle = QLabel("Générez un certificat JWT inviolable signé avec la clé privée Ed25519 pour une caisse sans Internet.")
        subtitle.setStyleSheet("color: #94a3b8; font-size: 12px;")
        layout.addWidget(title)
        layout.addWidget(subtitle)

        form_frame = QFrame()
        form_frame.setObjectName("MetricCard")
        grid = QGridLayout(form_frame)
        grid.setVerticalSpacing(12)
        grid.setHorizontalSpacing(14)

        # 1. Customer
        lbl_c = QLabel("Client / Établissement :")
        lbl_c.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        grid.addWidget(lbl_c, 0, 0)
        self.cust_input = QLineEdit(self.default_license.get("customer", ""))
        grid.addWidget(self.cust_input, 0, 1, 1, 2)

        # 2. License Key
        lbl_k = QLabel("Clé de Licence :")
        lbl_k.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        grid.addWidget(lbl_k, 1, 0)
        self.key_input = QLineEdit(self.default_license.get("licenseKey", ""))
        grid.addWidget(self.key_input, 1, 1, 1, 2)

        # 3. Hardware ID (HWID)
        lbl_h = QLabel("HWID de la Caisse Cible :")
        lbl_h.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        grid.addWidget(lbl_h, 2, 0)
        self.hwid_input = QLineEdit()
        self.hwid_input.setPlaceholderText("Ex: MOBI-B641-F5E2-1A09-90DE...")
        grid.addWidget(self.hwid_input, 2, 1)

        self.btn_detect_hwid = QPushButton("💻 Détecter ce PC")
        self.btn_detect_hwid.clicked.connect(self.detect_this_machine)
        grid.addWidget(self.btn_detect_hwid, 2, 2)

        # 4. Validity Duration
        lbl_d = QLabel("Durée de Validité Offline :")
        lbl_d.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        grid.addWidget(lbl_d, 3, 0)
        self.dur_combo = QComboBox()
        self.dur_combo.addItems([
            "1 An (365 Jours)",
            "90 Jours (Trimestre)",
            "30 Jours (Mois)",
            "10 Ans (Perpétuel)"
        ])
        grid.addWidget(self.dur_combo, 3, 1, 1, 2)

        layout.addWidget(form_frame)

        # Action: Sign
        self.btn_sign = QPushButton("🔏 Signer le Jeton Ed25519")
        self.btn_sign.setObjectName("PrimaryBtn")
        self.btn_sign.clicked.connect(self.sign_token)
        layout.addWidget(self.btn_sign)

        # Output Box
        lbl_out = QLabel("Jeton Compact JWS Généré :")
        lbl_out.setStyleSheet("font-weight: 700; color: #94a3b8; font-size: 11px;")
        layout.addWidget(lbl_out)
        self.token_output = QTextEdit()
        self.token_output.setReadOnly(True)
        self.token_output.setStyleSheet("font-family: Consolas, monospace; font-size: 11px;")
        layout.addWidget(self.token_output)

        # Footer Buttons
        footer = QHBoxLayout()
        self.btn_copy_token = QPushButton("📋 Copier le Jeton")
        self.btn_copy_token.setEnabled(False)
        self.btn_copy_token.clicked.connect(self.copy_token)
        footer.addWidget(self.btn_copy_token)

        self.btn_save_file = QPushButton("💾 Exporter Fichier (.mobilic)")
        self.btn_save_file.setEnabled(False)
        self.btn_save_file.clicked.connect(self.export_file)
        footer.addWidget(self.btn_save_file)

        footer.addStretch()

        btn_close = QPushButton("Fermer")
        btn_close.clicked.connect(self.accept)
        footer.addWidget(btn_close)

        layout.addLayout(footer)

    def detect_this_machine(self):
        info = detect_local_hwid()
        self.hwid_input.setText(info["formatted"])

    def sign_token(self):
        cust = self.cust_input.text().strip() or "Client MobiPOS"
        key = self.key_input.text().strip()
        hwid = self.hwid_input.text().strip()

        if not key:
            QMessageBox.warning(self, "Clé Requise", "Veuillez renseigner une clé de licence.")
            return
        if not hwid:
            QMessageBox.warning(self, "HWID Requis", "Veuillez spécifier l'identifiant matériel (HWID) de la caisse cible.")
            return

        dur_text = self.dur_combo.currentText()
        days = 365
        if "90 Jours" in dur_text:
            days = 90
        elif "30 Jours" in dur_text:
            days = 30
        elif "10 Ans" in dur_text:
            days = 3650

        now_sec = int(time.time())
        exp_sec = now_sec + (days * 86400)

        claims = {
            "iss": "mobi-pos-licensing-authority",
            "sub": hwid,
            "iat": now_sec,
            "nbf": now_sec - 60,
            "exp": exp_sec,
            "jti": f"off_{os.urandom(8).hex()}",
            "lic_key": key,
            "lic_type": "LIFETIME",
            "device_id": hwid,
            "device_type": "desktop",
            "max_desktops": 1,
            "max_mobiles": 0,
            "grace_days": 14,
            "server_ts": now_sec
        }

        try:
            token = generate_offline_jwt(claims)
            record_audit_event("OFFLINE_TOKEN", f"Jeton signé Ed25519 ({days} jours) pour HWID {hwid}", cust, key)
            self.token_output.setPlainText(token)
            self.btn_copy_token.setEnabled(True)
            self.btn_save_file.setEnabled(True)
            QMessageBox.information(
                self,
                "Jeton Signé avec Succès",
                f"✅ Certificat cryptographique Ed25519 généré !\n\n"
                f"Validité : {days} jours\n"
                f"Lié exclusivement au HWID : {hwid}"
            )
        except Exception as e:
            QMessageBox.critical(self, "Erreur de Signature", f"Échec de génération du jeton : {e}")

    def copy_token(self):
        QApplication.clipboard().setText(self.token_output.toPlainText())
        QMessageBox.information(self, "Copié", "Jeton copié dans le presse-papier !")

    def export_file(self):
        token = self.token_output.toPlainText().strip()
        if not token:
            return
        path, _ = QFileDialog.getSaveFileName(
            self,
            "Enregistrer le certificat de licence",
            f"mobipos_license_{self.key_input.text().strip()}.mobilic",
            "MobiPOS License Files (*.mobilic);;All Files (*)"
        )
        if path:
            with open(path, "w", encoding="utf-8") as f:
                f.write(token)
            QMessageBox.information(self, "Fichier Enregistré", f"Licence enregistrée sous :\n{path}")


# =========================================================================
# 6. QR Code Dialog (Instant Mobile Phone Camera Activation)
# =========================================================================

class QRCodeDialog(QDialog):
    """
    Displays an interactive high-DPI QR Code for instant mobile camera activation.
    Allows copying key, exporting PNG image, and launching WhatsApp.
    """
    def __init__(self, license_data: Dict[str, Any], parent=None):
        super().__init__(parent)
        self.license_data = license_data
        self.setWindowTitle(f"📱 QR Code d'Activation — {license_data.get('customer', 'Client')}")
        self.setFixedSize(540, 680)
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(14)
        layout.setContentsMargins(24, 24, 24, 24)

        cust = self.license_data.get("customer", "Client")
        key = self.license_data.get("licenseKey", "")
        formula = self.license_data.get("type", "LIFETIME")

        title = QLabel("📱 QR Code d'Activation Instantanée")
        title.setObjectName("SectionHeader")
        subtitle = QLabel("Scannez ce QR Code avec la caméra de l'application mobile MobiPOS.")
        subtitle.setStyleSheet("color: #94a3b8; font-size: 12px;")
        layout.addWidget(title)
        layout.addWidget(subtitle)

        # Info Card
        card = QFrame()
        card.setObjectName("MetricCard")
        c_layout = QVBoxLayout(card)
        c_layout.setSpacing(4)
        lbl_c = QLabel(f"👤 {cust}")
        lbl_c.setStyleSheet("font-size: 15px; font-weight: 800; color: #ffffff;")
        lbl_k = QLabel(f"🔑 {key}")
        lbl_k.setStyleSheet("font-size: 14px; font-weight: 700; color: #10b981; font-family: Consolas, monospace;")
        lbl_f = QLabel(f"📌 Formule : {formula}   |   🖥️ Caisses: {self.license_data.get('desktops', 1)}   |   📱 Mobiles: {self.license_data.get('mobiles', 2)}")
        lbl_f.setStyleSheet("font-size: 11px; color: #94a3b8;")
        c_layout.addWidget(lbl_c)
        c_layout.addWidget(lbl_k)
        c_layout.addWidget(lbl_f)
        layout.addWidget(card)

        # QR Code Display Box (White background card for camera contrast)
        qr_frame = QFrame()
        qr_frame.setStyleSheet("background-color: #ffffff; border-radius: 16px; padding: 16px;")
        qr_layout = QVBoxLayout(qr_frame)
        qr_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)

        self.qr_label = QLabel()
        self.qr_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.qr_bytes = generate_qr_image_bytes(key, box_size=8, border=2)
        qimg = QImage.fromData(self.qr_bytes)
        pixmap = QPixmap.fromImage(qimg).scaled(260, 260, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
        self.qr_label.setPixmap(pixmap)
        qr_layout.addWidget(self.qr_label)
        layout.addWidget(qr_frame, alignment=Qt.AlignmentFlag.AlignCenter)

        # Instructions note
        note = QLabel("⚡ Sur le smartphone Android, ouvrez MobiPOS > 'Scanner QR' et visez cet écran.")
        note.setStyleSheet("color: #6ee7b7; font-size: 11px; font-weight: 600;")
        note.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(note)

        # Buttons
        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(8)

        btn_copy = QPushButton("📋 Copier Clé")
        btn_copy.clicked.connect(lambda: (QApplication.clipboard().setText(key), QMessageBox.information(self, "Copié", "Clé copiée !")))
        btn_layout.addWidget(btn_copy)

        btn_save = QPushButton("💾 Sauvegarder Image (.png)")
        btn_save.clicked.connect(self.save_qr_image)
        btn_layout.addWidget(btn_save)

        btn_close = QPushButton("Fermer")
        btn_close.clicked.connect(self.accept)
        btn_layout.addWidget(btn_close)

        layout.addLayout(btn_layout)

    def save_qr_image(self):
        cust = self.license_data.get("customer", "client").replace(" ", "_")
        key = self.license_data.get("licenseKey", "")
        path, _ = QFileDialog.getSaveFileName(
            self,
            "Enregistrer le QR Code",
            f"qrcode_{cust}_{key}.png",
            "Images PNG (*.png)"
        )
        if path:
            with open(path, "wb") as f:
                f.write(self.qr_bytes)
            QMessageBox.information(self, "Image Enregistrée", f"Image du QR code enregistrée sous :\n{path}")


# =========================================================================
# 7. Customer Notes & Metadata Editor
# =========================================================================

class EditCustomerNotesDialog(QDialog):
    """
    Dialog to view and update customer business details:
    Customer Name, Phone number (WhatsApp), City, and internal Notes.
    """
    metadata_updated = pyqtSignal(dict)

    def __init__(self, license_data: Dict[str, Any], parent=None):
        super().__init__(parent)
        self.license_data = license_data
        self.setWindowTitle(f"✏️ Modifier Contact & Notes — {license_data.get('customer', 'Client')}")
        self.setFixedSize(540, 480)
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(14)
        layout.setContentsMargins(24, 24, 24, 24)

        title = QLabel("Détails Client & Notes Commerciales")
        title.setObjectName("SectionHeader")
        subtitle = QLabel("Gérez les coordonnées directes du commerçant et l'historique commercial.")
        subtitle.setStyleSheet("color: #94a3b8; font-size: 12px;")
        layout.addWidget(title)
        layout.addWidget(subtitle)

        card = QFrame()
        card.setObjectName("MetricCard")
        grid = QGridLayout(card)
        grid.setVerticalSpacing(12)
        grid.setHorizontalSpacing(14)

        # Name
        lbl_n = QLabel("👤 Nom / Enseigne :")
        lbl_n.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        grid.addWidget(lbl_n, 0, 0)
        self.name_input = QLineEdit(self.license_data.get("customer", ""))
        grid.addWidget(self.name_input, 0, 1)

        # Phone
        lbl_p = QLabel("📱 Téléphone (WhatsApp) :")
        lbl_p.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        grid.addWidget(lbl_p, 1, 0)
        self.phone_input = QLineEdit(self.license_data.get("phone", ""))
        self.phone_input.setPlaceholderText("Ex: +213 555 12 34 56 ou 0555123456")
        grid.addWidget(self.phone_input, 1, 1)

        # City
        lbl_c = QLabel("📍 Ville / Wilaya :")
        lbl_c.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        grid.addWidget(lbl_c, 2, 0)
        self.city_input = QLineEdit(self.license_data.get("city", ""))
        self.city_input.setPlaceholderText("Ex: Alger, Oran, Constantine...")
        grid.addWidget(self.city_input, 2, 1)

        # Notes
        lbl_not = QLabel("📝 Notes Internes :")
        lbl_not.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        grid.addWidget(lbl_not, 3, 0, Qt.AlignmentFlag.AlignTop)
        self.notes_input = QTextEdit()
        self.notes_input.setPlaceholderText("Ex: Payé en espèces, matériel POS fourni par TechDistrib, contact M. Karim...")
        self.notes_input.setPlainText(self.license_data.get("notes", ""))
        self.notes_input.setMaximumHeight(120)
        grid.addWidget(self.notes_input, 3, 1)

        layout.addWidget(card)

        # Buttons
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()

        btn_cancel = QPushButton("Annuler")
        btn_cancel.clicked.connect(self.reject)
        btn_layout.addWidget(btn_cancel)

        btn_save = QPushButton("💾 Enregistrer les Modifications")
        btn_save.setObjectName("PrimaryBtn")
        btn_save.clicked.connect(self.save_metadata)
        btn_layout.addWidget(btn_save)

        layout.addLayout(btn_layout)

    def save_metadata(self):
        new_name = self.name_input.text().strip() or self.license_data.get("customer", "")
        new_phone = self.phone_input.text().strip()
        new_city = self.city_input.text().strip()
        new_notes = self.notes_input.toPlainText().strip()
        key = self.license_data.get("licenseKey", "")

        update_customer_metadata(key, new_phone, new_city, new_notes, new_name)
        record_audit_event("UPDATE_CONTACT", f"Mise à jour contact: {new_name} ({new_phone}, {new_city})", new_name, key)

        self.license_data["customer"] = new_name
        self.license_data["phone"] = new_phone
        self.license_data["city"] = new_city
        self.license_data["notes"] = new_notes

        QMessageBox.information(self, "Enregistré", "Coordonnées et notes mises à jour avec succès.")
        self.metadata_updated.emit(self.license_data)
        self.accept()


# =========================================================================
# 8. Renew / Upgrade Dialog
# =========================================================================

class RenewUpgradeDialog(QDialog):
    """
    Dialog to upgrade a license formula or extend expiration.
    Allows 1-click upgrade to LIFETIME or adding 30/90/365 days.
    """
    license_upgraded = pyqtSignal(dict)

    def __init__(self, license_data: Dict[str, Any], api_client: AdminApiClient, parent=None):
        super().__init__(parent)
        self.license_data = license_data
        self.api_client = api_client
        self.setWindowTitle(f"⭐ Surclasser / Prolonger — {license_data.get('customer', 'Client')}")
        self.setFixedSize(540, 420)
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(14)
        layout.setContentsMargins(24, 24, 24, 24)

        title = QLabel("Surclassement & Extension de Validité")
        title.setObjectName("SectionHeader")
        subtitle = QLabel("Convertissez une formule temporaire ou démo en licence permanente ou prolongez sa durée.")
        subtitle.setStyleSheet("color: #94a3b8; font-size: 12px;")
        layout.addWidget(title)
        layout.addWidget(subtitle)

        # Current status card
        card = QFrame()
        card.setObjectName("MetricCard")
        c_layout = QVBoxLayout(card)
        c_layout.setSpacing(6)

        cust = self.license_data.get("customer", "Client")
        key = self.license_data.get("licenseKey", "")
        cur_type = self.license_data.get("type", "LIFETIME")
        cur_exp = (self.license_data.get("expiresAt") or "Illimitée (À Vie)")[:19]

        lbl_c = QLabel(f"👤 {cust}   —   🔑 {key}")
        lbl_c.setStyleSheet("font-weight: 700; color: #ffffff;")
        lbl_stat = QLabel(f"Formule Actuelle : {cur_type}   |   Expiration : {cur_exp}")
        lbl_stat.setStyleSheet("color: #94a3b8; font-size: 12px;")
        c_layout.addWidget(lbl_c)
        c_layout.addWidget(lbl_stat)
        layout.addWidget(card)

        # Upgrade action selector
        lbl_act = QLabel("Sélectionnez l'action de surclassement :")
        lbl_act.setStyleSheet("font-weight: 700; color: #cbd5e1;")
        layout.addWidget(lbl_act)

        self.action_combo = QComboBox()
        self.action_combo.addItems([
            "⭐ Surclasser en ILLIMITÉE À VIE (LIFETIME)",
            "📅 Prolonger de 90 Jours (3 Mois)",
            "📅 Prolonger de 30 Jours (1 Mois)",
            "📅 Prolonger de 365 Jours (1 An)",
            "⚡ Réactiver Démo 24 Heures"
        ])
        layout.addWidget(self.action_combo)

        layout.addStretch()

        # Buttons
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()

        btn_cancel = QPushButton("Annuler")
        btn_cancel.clicked.connect(self.reject)
        btn_layout.addWidget(btn_cancel)

        self.btn_apply = QPushButton("🚀 Appliquer et Synchroniser")
        self.btn_apply.setObjectName("PrimaryBtn")
        self.btn_apply.clicked.connect(self.apply_upgrade)
        btn_layout.addWidget(self.btn_apply)

        layout.addLayout(btn_layout)

    def apply_upgrade(self):
        sel = self.action_combo.currentText()
        now = datetime.datetime.now(datetime.timezone.utc)
        cur_exp_str = self.license_data.get("expiresAt")
        base_dt = now
        if cur_exp_str and cur_exp_str != "NONE":
            try:
                parsed = datetime.datetime.fromisoformat(cur_exp_str.replace("Z", "+00:00"))
                if parsed > now:
                    base_dt = parsed
            except Exception:
                pass

        new_type = self.license_data.get("type", "LIFETIME")
        new_exp = None

        if "LIFETIME" in sel:
            new_type = "LIFETIME"
            new_exp = None
        elif "90 Jours" in sel:
            new_type = "90D"
            new_exp = (base_dt + datetime.timedelta(days=90)).isoformat()
        elif "30 Jours" in sel:
            new_type = "30D"
            new_exp = (base_dt + datetime.timedelta(days=30)).isoformat()
        elif "365 Jours" in sel:
            new_type = "1Y"
            new_exp = (base_dt + datetime.timedelta(days=365)).isoformat()
        elif "24 Heures" in sel:
            new_type = "24H"
            new_exp = (now + datetime.timedelta(days=1)).isoformat()

        self.btn_apply.setEnabled(False)
        QApplication.processEvents()

        self.license_data["type"] = new_type
        self.license_data["license_type"] = new_type
        self.license_data["expiresAt"] = new_exp
        self.license_data["expires_at"] = new_exp
        self.license_data["status"] = "active"

        record_in_ledger(self.license_data)
        record_audit_event("UPGRADE_LICENSE", f"Surclassement vers {new_type} (Expiration: {new_exp or 'À Vie'})", self.license_data.get("customer", ""), self.license_data.get("licenseKey", ""))

        # The local ledger is already written, so a cloud failure is a partial
        # success: the upgrade is pending sync, not applied everywhere. Report
        # that honestly instead of writing to stdout, which a --noconsole build
        # discards.
        cloud_error: Optional[str] = None
        try:
            self.api_client.sync_license(self.license_data)
            self.api_client.set_status(self.license_data.get("licenseKey", ""), "active")
        except Exception as e:
            cloud_error = str(e)

        if cloud_error:
            QMessageBox.warning(
                self,
                "Surclassement partiellement appliqué",
                f"⚠️ La licence de {self.license_data.get('customer')} a été mise à jour "
                f"localement et sera synchronisée au prochain passage.\n\n"
                f"Nouvelle formule : {new_type}\n"
                f"Expiration : {new_exp or 'Illimitée (À Vie)'}\n\n"
                f"Le Cloud n'a pas répondu : {cloud_error}"
            )
        else:
            QMessageBox.information(
                self,
                "Surclassement Réussi",
                f"🎉 La licence de {self.license_data.get('customer')} a été mise à jour !\n\n"
                f"Nouvelle formule : {new_type}\n"
                f"Expiration : {new_exp or 'Illimitée (À Vie)'}"
            )
        self.license_upgraded.emit(self.license_data)
        self.accept()


# =========================================================================
# 9. Audit Log Dialog
# =========================================================================

class AuditLogDialog(QDialog):
    """
    Displays complete administrative audit trail of all operations:
    license creation, quota updates, device unbinding, seat resets, and upgrades.
    """
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("📜 Journal d'Audit & Sécurité — MobiPOS Licensing")
        self.setMinimumSize(880, 560)
        self.resize(920, 600)
        self.all_events = []
        self.init_ui()
        self.load_events()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(12)
        layout.setContentsMargins(22, 22, 22, 22)

        title = QLabel("Journal d'Audit des Opérations Administratives")
        title.setObjectName("SectionHeader")
        subtitle = QLabel("Historique infalsifiable de toutes les actions exécutées sur le registre et le serveur Cloudflare.")
        subtitle.setStyleSheet("color: #94a3b8; font-size: 12px;")
        layout.addWidget(title)
        layout.addWidget(subtitle)

        # Search bar
        tb = QHBoxLayout()
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("🔍 Filtrer les événements d'audit (client, clé, action)...")
        self.search_input.textChanged.connect(self.filter_table)
        tb.addWidget(self.search_input, stretch=2)

        btn_refresh = QPushButton("🔄 Actualiser")
        btn_refresh.clicked.connect(self.load_events)
        tb.addWidget(btn_refresh)

        btn_csv = QPushButton("📊 Exporter CSV")
        btn_csv.clicked.connect(self.export_csv)
        tb.addWidget(btn_csv)

        btn_clear = QPushButton("🗑️ Vider")
        btn_clear.setObjectName("DangerBtn")
        btn_clear.clicked.connect(self.clear_events)
        tb.addWidget(btn_clear)

        layout.addLayout(tb)

        # Table
        self.table = QTableWidget()
        self.table.setColumnCount(5)
        self.table.setHorizontalHeaderLabels([
            "Horodatage", "Action", "Client", "Clé de Licence", "Détails"
        ])
        self.table.verticalHeader().setDefaultSectionSize(40)
        self.table.setColumnWidth(0, 160)
        self.table.setColumnWidth(1, 150)
        self.table.setColumnWidth(2, 170)
        self.table.setColumnWidth(3, 200)
        self.table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)
        self.table.verticalHeader().setVisible(False)
        self.table.setAlternatingRowColors(True)
        layout.addWidget(self.table)

        # Footer
        footer = QHBoxLayout()
        self.count_lbl = QLabel("0 événement(s)")
        self.count_lbl.setStyleSheet("color: #94a3b8; font-weight: 700;")
        footer.addWidget(self.count_lbl)
        footer.addStretch()

        btn_close = QPushButton("Fermer")
        btn_close.clicked.connect(self.accept)
        footer.addWidget(btn_close)

        layout.addLayout(footer)

    def load_events(self):
        self.all_events = load_audit_log()
        self.filter_table()

    def filter_table(self):
        q = self.search_input.text().strip().lower()
        filtered = []
        for ev in self.all_events:
            text = f"{ev.get('timestamp','')} {ev.get('action','')} {ev.get('client','')} {ev.get('key','')} {ev.get('details','')}".lower()
            if not q or q in text:
                filtered.append(ev)

        self.table.setRowCount(len(filtered))
        for row, ev in enumerate(filtered):
            self.table.setItem(row, 0, QTableWidgetItem(ev.get("timestamp", "")))

            act = ev.get("action", "")
            act_item = QTableWidgetItem(act)
            act_item.setFont(QFont("Segoe UI", 9, QFont.Weight.Bold))
            if "CREATE" in act:
                act_item.setForeground(QColor("#34d399"))
            elif "UPGRADE" in act:
                act_item.setForeground(QColor("#60a5fa"))
            elif "RESET" in act or "UNBIND" in act:
                act_item.setForeground(QColor("#fca5a5"))
            self.table.setItem(row, 1, act_item)

            self.table.setItem(row, 2, QTableWidgetItem(ev.get("client", "")))

            key_item = QTableWidgetItem(ev.get("key", ""))
            key_item.setFont(QFont("Consolas", 9))
            self.table.setItem(row, 3, key_item)

            self.table.setItem(row, 4, QTableWidgetItem(ev.get("details", "")))

        self.count_lbl.setText(f"{len(filtered)} événement(s) affiché(s)")

    def clear_events(self):
        confirm = QMessageBox.question(
            self,
            "Vider le journal",
            "Voulez-vous vraiment effacer tout l'historique d'audit ?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        if confirm == QMessageBox.StandardButton.Yes:
            clear_audit_log()
            self.load_events()

    def export_csv(self):
        import csv
        path, _ = QFileDialog.getSaveFileName(
            self,
            "Exporter le Journal d'Audit (CSV)",
            f"audit_log_{datetime.date.today().isoformat()}.csv",
            "CSV Files (*.csv)"
        )
        if path:
            with open(path, "w", encoding="utf-8-sig", newline="") as f:
                w = csv.writer(f, delimiter=";")
                w.writerow(["Horodatage", "Action", "Client", "Clé", "Détails"])
                for ev in self.all_events:
                    w.writerow([
                        ev.get("timestamp", ""),
                        ev.get("action", ""),
                        ev.get("client", ""),
                        ev.get("key", ""),
                        ev.get("details", "")
                    ])
            QMessageBox.information(self, "Export Réussi", f"Journal d'audit sauvegardé sous :\n{path}")


# =========================================================================
# 10. Secrets Status Dialog
# =========================================================================

class SecretsStatusDialog(QDialog):
    """
    Inspect and repair the console's secret configuration.

    The dock warning pill used to be a dead end: it named the degraded state
    but gave the operator no way to see which secret was at fault or to supply
    it. This dialog is the way out, and it stays useful even when nothing is
    wrong -- an all-green console can still show where each secret lives.

    A secret is only editable when it is genuinely absent. Secrets that are
    merely optional (offline signing, legacy admin token) are listed as such
    and offer no input, because filling them in would not change any behaviour
    and would invite the operator to add a credential the worker never reads.
    """

    #: Emitted with the key name each time a secret is stored in the vault.
    secret_saved = pyqtSignal(str)

    STATE_COLORS = {
        "ready": "#34d399",
        "optional": "#60a5fa",
        "absent": "#fbbf24",
    }

    STATE_LABELS = {
        "ready": "Configuré",
        "optional": "Optionnel",
        "absent": "Absent",
    }

    def __init__(self, settings=None, parent=None):
        super().__init__(parent)
        self.setWindowTitle("État des secrets")
        self.setModal(True)
        self.setMinimumSize(620, 460)
        self._settings = settings
        self._inputs = {}
        self._init_ui()

    def _init_ui(self) -> None:
        from ..config import resolve_settings

        layout = QVBoxLayout(self)
        layout.setSpacing(12)
        layout.setContentsMargins(22, 22, 22, 22)

        title = QLabel("État des secrets")
        title.setObjectName("SectionHeader")
        layout.addWidget(title)

        subtitle = QLabel(
            "Les secrets requis conditionnent le fonctionnement de la console. "
            "Les secrets optionnels ajoutent des capacités sans être nécessaires."
        )
        subtitle.setWordWrap(True)
        subtitle.setStyleSheet("color: #94a3b8; font-size: 12px;")
        layout.addWidget(subtitle)

        if self._settings is None:
            self._settings = resolve_settings()

        rows = self._settings.secret_status()

        for name, state, detail in rows:
            layout.addLayout(self._build_row(name, state, detail))

        layout.addStretch()

        btn_row = QHBoxLayout()
        btn_row.addStretch()
        btn_close = QPushButton("Fermer")
        btn_close.clicked.connect(self.accept)
        btn_row.addWidget(btn_close)
        layout.addLayout(btn_row)

    def _build_row(self, name: str, state: str, detail: str) -> QHBoxLayout:
        row = QHBoxLayout()
        row.setSpacing(10)

        left = QVBoxLayout()
        key_label = QLabel(name)
        key_label.setStyleSheet("font-family: Consolas, monospace; font-weight: 700;")
        left.addWidget(key_label)

        detail_label = QLabel(detail)
        detail_label.setWordWrap(True)
        detail_label.setStyleSheet("color: #94a3b8; font-size: 11px;")
        left.addWidget(detail_label)
        row.addLayout(left, 1)

        state_label = QLabel(self.STATE_LABELS.get(state, state))
        state_label.setStyleSheet(
            f"color: {self.STATE_COLORS.get(state, '#cbd5e1')}; font-weight: 700;"
        )
        row.addWidget(state_label, 0)

        # Only an absent, required secret is worth an input box.
        if state == "absent":
            editor = QLineEdit()
            editor.setEchoMode(QLineEdit.EchoMode.Password)
            editor.setPlaceholderText("Coller la valeur…")
            editor.setMaximumWidth(210)
            self._inputs[name] = editor
            row.addWidget(editor, 0)

            save = QPushButton("Enregistrer")
            save.setObjectName("PrimaryBtn")
            save.clicked.connect(lambda _=False, k=name: self._save(k))
            row.addWidget(save, 0)

        return row

    def _save(self, name: str) -> None:
        from ..config import vault_set

        editor = self._inputs.get(name)
        if editor is None:
            return
        value = editor.text().strip()
        if not value:
            QMessageBox.warning(
                self,
                "Valeur vide",
                "Saisissez une valeur avant d'enregistrer.",
            )
            return
        if not vault_set(name, value):
            QMessageBox.critical(
                self,
                "Échec de l'écriture",
                f"Impossible d'écrire {name} dans le coffre du système.\n"
                "Vérifiez que le service de gestionnaire d'identifiants est "
                "accessible.",
            )
            return
        editor.clear()
        self.secret_saved.emit(name)
        QMessageBox.information(
            self,
            "Secret enregistré",
            f"{name} a été écrit dans le coffre du système.",
        )
        self.accept()




# =========================================================================
# 10. Technician Dynamic PIN Rescue Dialog (Model 1)
# =========================================================================

class TechnicianPinRescueDialog(QDialog):
    """
    Technician PIN Rescue Dialog (Model 1 Dynamic Challenge-Response).
    Allows the technician/distributor to solve a POS register's challenge code
    and generate a single-use 6-digit unlock OTP for a customer who forgot
    their manager PIN.
    """

    def __init__(
        self,
        customer: str = "",
        phone: str = "",
        challenge: str = "",
        parent=None
    ):
        super().__init__(parent)
        self.customer = customer
        self.phone = phone
        self.initial_challenge = challenge
        self.current_otp: Optional[str] = None

        self.setWindowTitle("🔑 Assistance Technicien — Déblocage Code PIN Caisse")
        self.setMinimumSize(680, 580)
        self.resize(720, 620)
        self.init_ui()

        if self.initial_challenge:
            self.challenge_input.setText(self.initial_challenge)
            self.solve_challenge()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(24, 24, 24, 24)

        # Header
        title = QLabel("🔑 Déblocage PIN Caisse (Assistance Technicien)")
        title.setObjectName("SectionHeader")
        subtitle = QLabel(
            "Générez un code temporaire à 6 chiffres pour déverrouiller une caisse cliente "
            "lorsque le gérant a oublié son code PIN."
        )
        subtitle.setStyleSheet("color: #94a3b8; font-size: 12px;")
        subtitle.setWordWrap(True)
        layout.addWidget(title)
        layout.addWidget(subtitle)

        # Input Card
        form_card = QFrame()
        form_card.setObjectName("MetricCard")
        grid = QGridLayout(form_card)
        grid.setVerticalSpacing(12)
        grid.setHorizontalSpacing(14)

        # 1. Customer Name (Optional)
        lbl_cust = QLabel("Client / Établissement :")
        lbl_cust.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        grid.addWidget(lbl_cust, 0, 0)
        self.cust_input = QLineEdit(self.customer)
        self.cust_input.setPlaceholderText("Ex: Restaurant Le Palmier (facultatif)")
        grid.addWidget(self.cust_input, 0, 1, 1, 2)

        # 2. WhatsApp Phone (Optional)
        lbl_phone = QLabel("Téléphone WhatsApp :")
        lbl_phone.setStyleSheet("font-weight: 600; color: #cbd5e1;")
        grid.addWidget(lbl_phone, 1, 0)
        self.phone_input = QLineEdit(self.phone)
        self.phone_input.setPlaceholderText("Ex: 0555 12 34 56 ou +213555123456")
        grid.addWidget(self.phone_input, 1, 1, 1, 2)

        # 3. Challenge Code
        lbl_code = QLabel("Code Défi de la Caisse :")
        lbl_code.setStyleSheet("font-weight: 600; color: #f59e0b;")
        grid.addWidget(lbl_code, 2, 0)

        self.challenge_input = QLineEdit()
        self.challenge_input.setPlaceholderText("Ex: MOBI-8F2A-W9ET")
        self.challenge_input.setStyleSheet(
            "font-family: Consolas, monospace; font-size: 15px; font-weight: 700; "
            "letter-spacing: 2px; text-transform: uppercase; color: #fbbf24;"
        )
        self.challenge_input.textChanged.connect(self._on_challenge_text_changed)
        self.challenge_input.returnPressed.connect(self.solve_challenge)
        grid.addWidget(self.challenge_input, 2, 1)

        btn_paste = QPushButton("📋 Coller")
        btn_paste.setToolTip("Coller depuis le presse-papier")
        btn_paste.clicked.connect(self.paste_from_clipboard)
        grid.addWidget(btn_paste, 2, 2)

        layout.addWidget(form_card)

        # Solve Action Button
        self.btn_solve = QPushButton("⚡ Calculer le Code de Déblocage (OTP)")
        self.btn_solve.setObjectName("PrimaryBtn")
        self.btn_solve.setFixedHeight(40)
        self.btn_solve.clicked.connect(self.solve_challenge)
        layout.addWidget(self.btn_solve)

        # Result Card
        self.result_card = QFrame()
        self.result_card.setObjectName("MetricCard")
        self.result_card.setStyleSheet(
            "QFrame#MetricCard { background-color: #0b1329; border: 1px solid #1e293b; border-radius: 8px; }"
        )
        res_layout = QVBoxLayout(self.result_card)
        res_layout.setSpacing(10)
        res_layout.setContentsMargins(18, 18, 18, 18)

        lbl_res_title = QLabel("CODE DE DÉVERROUILLAGE UNIQUE :")
        lbl_res_title.setStyleSheet("font-size: 11px; font-weight: 700; color: #94a3b8; letter-spacing: 1.5px;")
        lbl_res_title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        res_layout.addWidget(lbl_res_title)

        self.otp_label = QLabel("— — — — — —")
        self.otp_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.otp_label.setStyleSheet(
            "font-family: Consolas, monospace; font-size: 38px; font-weight: 800; "
            "color: #64748b; letter-spacing: 10px;"
        )
        res_layout.addWidget(self.otp_label)

        self.status_label = QLabel("Entrez le code de défi affiché sur la caisse cliente puis cliquez sur Calculer.")
        self.status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.status_label.setStyleSheet("color: #94a3b8; font-size: 12px;")
        self.status_label.setWordWrap(True)
        res_layout.addWidget(self.status_label)

        # Secondary Action Buttons (Copy / WhatsApp)
        actions_box = QHBoxLayout()
        actions_box.setSpacing(10)

        self.btn_copy_code = QPushButton("📋 Copier le code")
        self.btn_copy_code.setEnabled(False)
        self.btn_copy_code.clicked.connect(self.copy_code)
        actions_box.addWidget(self.btn_copy_code)

        self.btn_copy_msg = QPushButton("📄 Copier message client")
        self.btn_copy_msg.setEnabled(False)
        self.btn_copy_msg.clicked.connect(self.copy_message)
        actions_box.addWidget(self.btn_copy_msg)

        self.btn_wa = QPushButton("💬 Envoyer sur WhatsApp")
        self.btn_wa.setObjectName("WhatsAppBtn")
        self.btn_wa.setEnabled(False)
        self.btn_wa.clicked.connect(self.open_whatsapp)
        actions_box.addWidget(self.btn_wa)

        res_layout.addLayout(actions_box)
        layout.addWidget(self.result_card)

        # Footnote
        footnote = QLabel(
            "ℹ️ Instructions : Transmettez ce code à 6 chiffres au client. Dès sa saisie sur sa caisse,\n"
            "la caisse se déverrouille immédiatement et l'invite à saisir son nouveau code PIN gérant."
        )
        footnote.setStyleSheet("color: #64748b; font-size: 11px; line-height: 1.4;")
        footnote.setWordWrap(True)
        layout.addWidget(footnote)

        # Dialog Bottom
        bottom_box = QHBoxLayout()
        bottom_box.addStretch()
        btn_close = QPushButton("Fermer")
        btn_close.clicked.connect(self.accept)
        bottom_box.addWidget(btn_close)
        layout.addLayout(bottom_box)

    def _on_challenge_text_changed(self, text: str):
        upper = text.upper()
        if upper != text:
            cursor_pos = self.challenge_input.cursorPosition()
            self.challenge_input.setText(upper)
            self.challenge_input.setCursorPosition(cursor_pos)

    def paste_from_clipboard(self):
        text = QApplication.clipboard().text().strip()
        if text:
            self.challenge_input.setText(text)
            self.solve_challenge()

    def solve_challenge(self):
        raw = self.challenge_input.text().strip().upper()
        if not raw:
            QMessageBox.warning(
                self,
                "Code défi manquant",
                "Veuillez saisir le code défi affiché sur la caisse du client (ex: MOBI-8F2A-W9ET)."
            )
            return

        res = solve_technician_challenge(raw)
        if not res.get("ok"):
            self.current_otp = None
            self.otp_label.setText("ERREUR")
            self.otp_label.setStyleSheet(
                "font-family: Consolas, monospace; font-size: 28px; font-weight: 800; "
                "color: #ef4444; letter-spacing: 4px;"
            )
            self.status_label.setText(f"❌ {res.get('error', 'Code défi non valide.')}")
            self.status_label.setStyleSheet("color: #ef4444; font-size: 12px; font-weight: 600;")
            self.btn_copy_code.setEnabled(False)
            self.btn_copy_msg.setEnabled(False)
            self.btn_wa.setEnabled(False)
            return

        otp = res["otp"]
        self.current_otp = otp

        # Format OTP with nice spacing (ex: 137 680)
        formatted_otp = f"{otp[:3]} {otp[3:]}"
        self.otp_label.setText(formatted_otp)
        self.otp_label.setStyleSheet(
            "font-family: Consolas, monospace; font-size: 40px; font-weight: 800; "
            "color: #10b981; letter-spacing: 8px;"
        )

        warning_note = ""
        if res.get("warning"):
            warning_note = f"\n⚠️ {res['warning']}"

        self.status_label.setText(
            f"✅ Code calculé avec succès pour le défi {raw} (Date UTC : {res['date']}).{warning_note}"
        )
        self.status_label.setStyleSheet("color: #10b981; font-size: 12px; font-weight: 600;")

        self.btn_copy_code.setEnabled(True)
        self.btn_copy_msg.setEnabled(True)
        self.btn_wa.setEnabled(True)

        # Audit event
        cust_name = self.cust_input.text().strip() or "Client inconnu"
        record_audit_event(
            "pin_rescue_otp_generated",
            f"PIN recovery OTP generated for challenge {raw} (Client: {cust_name})"
        )

    def copy_code(self):
        if self.current_otp:
            QApplication.clipboard().setText(self.current_otp)
            self.status_label.setText(f"✅ Code {self.current_otp} copié dans le presse-papier !")
            self.status_label.setStyleSheet("color: #38bdf8; font-size: 12px; font-weight: 600;")

    def copy_message(self):
        if not self.current_otp:
            return
        cust_name = self.cust_input.text().strip()
        msg = build_rescue_whatsapp_message(cust_name, self.current_otp)
        QApplication.clipboard().setText(msg)
        self.status_label.setText("✅ Message complet copié dans le presse-papier !")
        self.status_label.setStyleSheet("color: #38bdf8; font-size: 12px; font-weight: 600;")

    def open_whatsapp(self):
        if not self.current_otp:
            return

        cust_name = self.cust_input.text().strip()
        phone_raw = self.phone_input.text().strip()

        clean_phone = re.sub(r"[^\d+]", "", phone_raw)
        if clean_phone.startswith("0") and len(clean_phone) == 10:
            clean_phone = "213" + clean_phone[1:]
        elif clean_phone.startswith("+"):
            clean_phone = clean_phone[1:]

        msg = build_rescue_whatsapp_message(cust_name, self.current_otp)
        encoded = urllib.parse.quote(msg)

        if clean_phone:
            url = f"https://web.whatsapp.com/send?phone={clean_phone}&text={encoded}"
        else:
            url = f"https://web.whatsapp.com/send?text={encoded}"

        try:
            webbrowser.open(url)
            self.status_label.setText("🌐 WhatsApp ouvert avec le message pré-rempli.")
            self.status_label.setStyleSheet("color: #10b981; font-size: 12px;")
        except Exception as e:
            QMessageBox.critical(self, "Erreur WhatsApp", f"Impossible d'ouvrir le navigateur : {e}")

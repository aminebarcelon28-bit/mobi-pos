"""
Command palette (Ctrl+K) and the license inspector drawer.

Both are built from primitives in widgets.py; this module holds the
application-specific wiring only.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

from PyQt6.QtCore import QEvent, Qt, QTimer, pyqtSignal
from PyQt6.QtGui import QKeySequence, QShortcut
from PyQt6.QtWidgets import (
    QDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from ..core.models import DeviceBinding, LicenseRecord


@dataclass(frozen=True)
class Command:
    """A palette entry: a label, optional keywords, and an action."""

    label: str
    handler: Callable[[], None]
    keywords: str = ""
    shortcut: str = ""

    def matches(self, needle: str) -> bool:
        if not needle:
            return True
        haystack = f"{self.label} {self.keywords}".lower()
        return all(token in haystack for token in needle.split())


class CommandPalette(QDialog):
    """Spotlight launcher. Enter runs the highlighted command."""

    def __init__(self, commands: List[Command], parent=None):
        super().__init__(parent)
        self.setWindowTitle("Command Palette")
        self.setModal(True)
        self.resize(620, 460)
        self._commands = commands
        self._filtered: List[Command] = list(commands)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(10)

        self.search = QLineEdit()
        self.search.setPlaceholderText("Type a command, or > to filter actions…")
        self.search.textChanged.connect(self._apply)
        layout.addWidget(self.search)

        self.results = QListWidget()
        self.results.itemActivated.connect(self._activate)
        self.results.itemClicked.connect(self._activate)
        layout.addWidget(self.results, stretch=1)

        hint = QLabel("↑↓ to navigate · Enter to run · Esc to close")
        hint.setObjectName("Muted")
        layout.addWidget(hint)

        self.search.setFocus()

    def _apply(self, text: str) -> None:
        self.results.clear()
        self._filtered = [c for c in self._commands if c.matches(text.strip().lower())]
        for command in self._filtered:
            suffix = f"    [{command.shortcut}]" if command.shortcut else ""
            item = QListWidgetItem(f"{command.label}{suffix}")
            item.setData(Qt.ItemDataRole.UserRole, command)
            self.results.addItem(item)
        if self.results.count():
            self.results.setCurrentRow(0)

    def _activate(self, item: QListWidgetItem) -> None:
        command: Optional[Command] = item.data(Qt.ItemDataRole.UserRole)
        self.accept()
        if command:
            # Deferred so the dialog is fully closed before the action runs.
            QTimer.singleShot(0, command.handler)


#: Inspector design tokens. Kept as module constants because the Qt stylesheet
#: below is assembled from them, and a test asserts the drawer matches them.
DRAWER_BG = "#0D1117"
CARD_BG = "#161B22"
CARD_BORDER = "#30363D"
CARD_HOVER_BORDER = "#484F58"
TEXT_PRIMARY = "#F0F6FC"
TEXT_MUTED = "#8B949E"
ACCENT = "#2F81F7"
SUCCESS = "#238636"
WARNING = "#9E6A03"
DANGER = "#DA3633"

DRAWER_WIDTH = 460
DRAWER_MIN_WIDTH = 420
# Below this window width the drawer is capped so the table keeps enough room
# for its columns instead of being squeezed into a scrollable sliver.
DRAWER_BREAKPOINT = 1400
DRAWER_NARROW_WIDTH = 360
CARD_SPACING = 16
CARD_MARGIN = 20

# Every styled frame carries an object name and is addressed with the #id
# selector. A bare ``QFrame { ... }`` rule matches every descendant frame too,
# so the per-device rows would inherit the card background and border.
_DRAWER_QSS = f"""
QFrame#InspectorDrawer {{
    background-color: {DRAWER_BG};
    border-left: 1px solid {CARD_BORDER};
}}
QFrame#InspectorHeader {{
    background-color: {CARD_BG};
    border-bottom: 1px solid {CARD_BORDER};
}}
QFrame#InspectorFooter {{
    background-color: {CARD_BG};
    border-top: 1px solid {CARD_BORDER};
}}
QFrame#InspectorCard {{
    background-color: {CARD_BG};
    border: 1px solid {CARD_BORDER};
    border-radius: 8px;
}}
QFrame#DeviceRow {{
    background-color: {DRAWER_BG};
    border: 1px solid {CARD_BORDER};
    border-radius: 6px;
}}
QScrollArea {{
    border: none;
    background-color: {DRAWER_BG};
}}
QWidget#InspectorBody {{
    background-color: {DRAWER_BG};
}}
QScrollBar:vertical {{
    border: none;
    background: {DRAWER_BG};
    width: 8px;
    margin: 0;
}}
QScrollBar::handle:vertical {{
    background: {CARD_BORDER};
    min-height: 24px;
    border-radius: 4px;
}}
QScrollBar::handle:vertical:hover {{
    background: {CARD_HOVER_BORDER};
}}
QScrollBar::add-line, QScrollBar::sub-line {{ height: 0; width: 0; }}
"""


class InspectorDrawer(QFrame):
    """
    Slide-over detail panel for a single licence.

    A scrollable card layout rather than a flat stack of labels. The previous
    version had no QScrollArea, so a licence with a long note or many bound
    devices pushed its tail past the bottom of the panel with no way to reach
    it, and the key was set in 11pt against a 360px body.

    Kept as a QFrame rather than a QDockWidget so it can slide in from the
    right edge without fighting the window layout.
    """

    closed = pyqtSignal()
    copyRequested = pyqtSignal(str)
    deviceUnbindRequested = pyqtSignal(str, str)  # (license_key, device_id)
    flushSeatsRequested = pyqtSignal(str)
    upgradeRequested = pyqtSignal(str)   # license_id
    quotasRequested = pyqtSignal(str)    # license_id
    devicesRequested = pyqtSignal(str)   # license_id
    whatsappRequested = pyqtSignal(str)  # license_id
    qrRequested = pyqtSignal(str)        # license_id
    statusToggleRequested = pyqtSignal(str)  # license_id

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("InspectorDrawer")
        self.setStyleSheet(_DRAWER_QSS)
        # Fixed, not merely minimum: a following setMinimumWidth() would
        # replace the 460 floor with 420 and let the layout compress the
        # drawer, which is what reintroduced the cramped ~426px panel.
        # 460 already satisfies the 420px minimum requirement.
        self.setFixedWidth(DRAWER_WIDTH)
        self.hide()
        self._record: Optional[LicenseRecord] = None
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        root.addWidget(self._build_header())
        root.addWidget(self._build_body(), 1)
        root.addWidget(self._build_footer())

        # Start in the empty state so the actions are disabled before any row
        # is ever selected; otherwise a freshly opened console shows live
        # buttons for a record that does not exist.
        self.clear()

    # -- responsive sizing -------------------------------------------------
    def apply_responsive_width(self, window_width: int) -> int:
        """
        Cap the drawer on narrow windows so the table keeps usable width.

        The drawer is a fixed 460px sibling in the same QHBoxLayout as the
        table, so it never literally overlaps the columns. What it did do was
        take 460px regardless of window size, squeezing the table down to
        ~264px on a small window and pushing the last columns (Actions) out of
        view past the viewport. Operators read that as the drawer covering the
        table.
        """
        target = DRAWER_WIDTH if window_width >= DRAWER_BREAKPOINT else DRAWER_NARROW_WIDTH
        # Never let the drawer eat more than ~45% of the window, whatever the
        # breakpoint says.
        cap = max(DRAWER_NARROW_WIDTH, int(window_width * 0.45))
        target = min(target, cap)
        if target != self.width():
            self.setFixedWidth(target)
        return target

    # -- chrome -----------------------------------------------------------
    def _build_header(self) -> QWidget:
        header = QFrame()
        header.setObjectName("InspectorHeader")
        header.setFixedHeight(64)
        row = QHBoxLayout(header)
        row.setContentsMargins(CARD_MARGIN, 0, CARD_MARGIN - 4, 0)
        row.setSpacing(8)

        self.title = QLabel("Sélectionnez une licence")
        self.title.setObjectName("InspectorTitle")
        self.title.setWordWrap(True)
        self.title.setStyleSheet(f"color: {TEXT_PRIMARY}; font-size: 15px; font-weight: 700;")
        row.addWidget(self.title, 1)

        close = QPushButton("✕")
        close.setObjectName("InspectorClose")
        close.setFixedSize(28, 28)
        close.setCursor(Qt.CursorShape.PointingHandCursor)
        close.setToolTip("Fermer le panneau")
        close.setStyleSheet(
            f"QPushButton#InspectorClose {{ background: transparent; color: {TEXT_MUTED};"
            f" border: 1px solid transparent; border-radius: 6px; font-size: 14px; }}"
            f"QPushButton#InspectorClose:hover {{ background: {CARD_BG};"
            f" color: {DANGER}; border: 1px solid {CARD_BORDER}; }}"
        )
        close.clicked.connect(self.close_drawer)
        row.addWidget(close)
        return header

    def _build_body(self) -> QWidget:
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setFrameShape(QFrame.Shape.NoFrame)

        body = QWidget()
        body.setObjectName("InspectorBody")
        self.body_layout = QVBoxLayout(body)
        self.body_layout.setContentsMargins(CARD_MARGIN, CARD_MARGIN, CARD_MARGIN, CARD_MARGIN)
        self.body_layout.setSpacing(CARD_SPACING)

        self._build_identity_card()
        self._build_key_card()
        self._build_seats_card()
        self._build_devices_card()
        self._build_notes_card()

        self.body_layout.addStretch()
        scroll.setWidget(body)
        return scroll

    def _build_footer(self) -> QWidget:
        footer = QFrame()
        footer.setObjectName("InspectorFooter")
        footer.setFixedHeight(72)
        row = QHBoxLayout(footer)
        row.setContentsMargins(CARD_MARGIN - 4, 12, CARD_MARGIN - 4, 12)
        row.setSpacing(8)

        self.btn_upgrade = self._footer_button(
            "⭐ Surclasser", SUCCESS, "#2EA043", "Surclasser ou prolonger la licence"
        )
        self.btn_upgrade.clicked.connect(
            lambda: self._emit_id(self.upgradeRequested)
        )
        row.addWidget(self.btn_upgrade)

        self.btn_whatsapp = self._footer_button(
            "💬 WhatsApp", ACCENT, "#388BFD", "Préparer le message d'activation"
        )
        self.btn_whatsapp.clicked.connect(
            lambda: self._emit_id(self.whatsappRequested)
        )
        row.addWidget(self.btn_whatsapp)

        self.btn_qr = self._footer_button(
            "🔲 QR", CARD_BG, CARD_BORDER, "QR code d'activation"
        )
        self.btn_qr.setStyleSheet(
            f"QPushButton {{ background: {CARD_BG}; color: {TEXT_PRIMARY};"
            f" border: 1px solid {CARD_BORDER}; border-radius: 6px;"
            f" font-size: 12px; font-weight: 600; padding: 8px 10px; }}"
            f"QPushButton:hover {{ border-color: {CARD_HOVER_BORDER}; }}"
            f"QPushButton:disabled {{ color: #484F58; }}"
        )
        self.btn_qr.clicked.connect(lambda: self._emit_id(self.qrRequested))
        row.addWidget(self.btn_qr)
        return footer

    @staticmethod
    def _footer_button(text: str, bg: str, border: str, tip: str) -> QPushButton:
        btn = QPushButton(text)
        btn.setObjectName("InspectorAction")
        btn.setCursor(Qt.CursorShape.PointingHandCursor)
        btn.setToolTip(tip)
        btn.setStyleSheet(
            f"QPushButton {{ background: {bg}; color: #FFFFFF; font-weight: 600;"
            f" font-size: 12px; padding: 8px 10px; border-radius: 6px;"
            f" border: 1px solid {border}; }}"
            f"QPushButton:hover {{ background: {border}; }}"
            f"QPushButton:disabled {{ color: #484F58; }}"
        )
        return btn

    def _emit_id(self, signal) -> None:
        """Route a footer action to the window, keyed by the record id."""
        if self._record is None:
            return
        signal.emit(self._record.id or self._record.license_key)

    # -- cards ------------------------------------------------------------
    @staticmethod
    def _card(title: str) -> tuple:
        card = QFrame()
        card.setObjectName("InspectorCard")
        layout = QVBoxLayout(card)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(10)

        heading = QLabel(title.upper())
        heading.setStyleSheet(
            f"color: {TEXT_MUTED}; font-size: 11px; font-weight: 700; letter-spacing: 0.6px;"
        )
        layout.addWidget(heading)
        return card, layout

    def _build_identity_card(self) -> None:
        card, layout = self._card("Client & état")

        self.customer_label = QLabel("—")
        self.customer_label.setWordWrap(True)
        self.customer_label.setStyleSheet(
            f"color: {TEXT_PRIMARY}; font-size: 18px; font-weight: 700;"
        )
        layout.addWidget(self.customer_label)

        pills = QHBoxLayout()
        pills.setSpacing(8)
        self.status_pill = QLabel("—")
        self.formula_pill = QLabel("—")
        for pill in (self.status_pill, self.formula_pill):
            pill.setAlignment(Qt.AlignmentFlag.AlignCenter)
            pill.setFixedHeight(22)
            pills.addWidget(pill)
        pills.addStretch()
        layout.addLayout(pills)

        self.contact_label = QLabel("Coordonnées : —")
        self.contact_label.setWordWrap(True)
        self.contact_label.setStyleSheet(f"color: {TEXT_MUTED}; font-size: 12px;")
        layout.addWidget(self.contact_label)

        self.body_layout.addWidget(card)

    def _build_key_card(self) -> None:
        card, layout = self._card("Clé de licence")

        key_row = QHBoxLayout()
        key_row.setSpacing(8)
        self.key_label = QLabel("—")
        self.key_label.setFont(self._mono(12))
        self.key_label.setTextInteractionFlags(
            Qt.TextInteractionFlag.TextSelectableByMouse
        )
        self.key_label.setWordWrap(True)
        self.key_label.setStyleSheet(
            f"QLabel {{ background: {DRAWER_BG}; color: #79C0FF; padding: 8px 10px;"
            f" border: 1px solid {CARD_BORDER}; border-radius: 6px; font-size: 12px; }}"
        )
        key_row.addWidget(self.key_label, 1)

        self.copy_btn = QPushButton("📋")
        self.copy_btn.setObjectName("InspectorAction")
        self.copy_btn.setFixedSize(34, 34)
        self.copy_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.copy_btn.setToolTip("Copier la clé d'activation")
        self.copy_btn.setStyleSheet(
            f"QPushButton {{ background: {CARD_BG}; color: {TEXT_PRIMARY};"
            f" border: 1px solid {CARD_BORDER}; border-radius: 6px; }}"
            f"QPushButton:hover {{ border-color: {CARD_HOVER_BORDER}; }}"
        )
        self.copy_btn.clicked.connect(self._copy_key)
        key_row.addWidget(self.copy_btn)
        layout.addLayout(key_row)

        self.expiry_label = QLabel("Expiration : —")
        self.expiry_label.setWordWrap(True)
        self.expiry_label.setStyleSheet(f"color: {TEXT_MUTED}; font-size: 12px;")
        layout.addWidget(self.expiry_label)

        self.body_layout.addWidget(card)

    def _build_seats_card(self) -> None:
        card, layout = self._card("Postes & quotas")

        # The container widget is held explicitly. Calling parentWidget() at
        # the call site returns a temporary wrapper that PyQt garbage-collects,
        # which destroys the C++ widget the layout was just given.
        self.lbl_pc, self.bar_pc, self._box_pc = self._meter("🖥️ Caisses")
        self.lbl_mob, self.bar_mob, self._box_mob = self._meter("📱 Mobiles")
        layout.addWidget(self._box_pc)
        layout.addWidget(self._box_mob)

        quota_row = QHBoxLayout()
        quota_row.setSpacing(8)
        self.btn_quotas = QPushButton("⚙️ Quotas")
        self.btn_quotas.setObjectName("InspectorAction")
        self.btn_quotas.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_quotas.setToolTip("Modifier les quotas de la licence")
        self.btn_quotas.setStyleSheet(
            f"QPushButton {{ background: {CARD_BG}; color: {ACCENT};"
            f" border: 1px solid {CARD_BORDER}; border-radius: 6px;"
            f" font-size: 12px; padding: 6px 10px; }}"
            f"QPushButton:hover {{ border-color: {CARD_HOVER_BORDER}; }}"
        )
        self.btn_quotas.clicked.connect(lambda: self._emit_id(self.quotasRequested))
        quota_row.addWidget(self.btn_quotas)

        self.btn_devices = QPushButton("🖥️ Appareils")
        self.btn_devices.setObjectName("InspectorAction")
        self.btn_devices.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_devices.setToolTip("Inspecter et réinitialiser les postes")
        self.btn_devices.setStyleSheet(
            f"QPushButton {{ background: {CARD_BG}; color: {TEXT_PRIMARY};"
            f" border: 1px solid {CARD_BORDER}; border-radius: 6px;"
            f" font-size: 12px; padding: 6px 10px; }}"
            f"QPushButton:hover {{ border-color: {CARD_HOVER_BORDER}; }}"
        )
        self.btn_devices.clicked.connect(lambda: self._emit_id(self.devicesRequested))
        quota_row.addWidget(self.btn_devices)
        layout.addLayout(quota_row)

        self.body_layout.addWidget(card)

    def _build_devices_card(self) -> None:
        card, layout = self._card("Appareils enregistrés (HWID)")
        self.devices_container = QVBoxLayout()
        self.devices_container.setSpacing(6)
        layout.addLayout(self.devices_container)
        self.body_layout.addWidget(card)

    def _build_notes_card(self) -> None:
        card, layout = self._card("Notes internes")
        self.notes_label = QLabel("Aucune note interne enregistrée.")
        self.notes_label.setWordWrap(True)
        self.notes_label.setStyleSheet(
            f"color: {TEXT_MUTED}; font-size: 12px; font-style: italic;"
        )
        layout.addWidget(self.notes_label)
        self.body_layout.addWidget(card)

    @staticmethod
    def _mono(size: int):
        from PyQt6.QtGui import QFont

        font = QFont()
        font.setFamilies(["JetBrains Mono", "Cascadia Code", "Consolas", "monospace"])
        font.setPointSize(size)
        font.setBold(True)
        return font

    @staticmethod
    def _meter(caption: str) -> tuple:
        """Caption + bar + container, returned as (QLabel, QProgressBar, QWidget)."""
        box = QWidget()
        layout = QVBoxLayout(box)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(4)
        label = QLabel(caption)
        label.setStyleSheet(f"color: {TEXT_PRIMARY}; font-size: 13px; font-weight: 500;")
        bar = QProgressBar()
        bar.setRange(0, 100)
        bar.setTextVisible(False)
        bar.setFixedHeight(6)
        layout.addWidget(label)
        layout.addWidget(bar)
        return label, bar, box

    # -- population -------------------------------------------------------
    def clear(self) -> None:
        """Reset to the empty state without emitting close_requested."""
        self._record = None
        self.title.setText("Sélectionnez une licence")
        self.customer_label.setText("—")
        self.status_pill.setText("—")
        self.formula_pill.setText("—")
        self.contact_label.setText("Coordonnées : —")
        self.key_label.setText("—")
        self.expiry_label.setText("Expiration : —")
        self.notes_label.setText("Aucune note interne enregistrée.")
        self.notes_label.setStyleSheet(
            f"color: {TEXT_MUTED}; font-size: 12px; font-style: italic;"
        )
        self.lbl_pc.setText("🖥️ —")
        self.lbl_mob.setText("📱 —")
        self.bar_pc.setValue(0)
        self.bar_mob.setValue(0)
        self._rebuild_devices([])
        for btn in (self.btn_upgrade, self.btn_whatsapp, self.btn_qr,
                    self.btn_quotas, self.btn_devices, self.copy_btn):
            btn.setEnabled(False)

    def show_for(self, record: LicenseRecord) -> None:
        self._record = record
        self.title.setText(record.customer or "—")
        self.customer_label.setText(record.customer or "—")

        status = getattr(record.status, "value", str(record.status)).upper()
        self.status_pill.setText(status)
        self.formula_pill.setText((record.formula or "").upper())
        # Pill colours are set on the widget, not the stylesheet, because Qt
        # caches the sheet and re-applying it per row is measurably slower.
        self._tint_pill(self.status_pill, record.raw_status)
        self._tint_pill(self.formula_pill, record.formula)

        contact = f"📞 {record.phone or '—'}"
        if record.city:
            contact += f"   |   📍 {record.city}"
        self.contact_label.setText(contact)

        self.key_label.setText(record.license_key or "—")
        self.expiry_label.setText(self._expiry_text(record))
        self.notes_label.setText(record.notes or "Aucune note interne enregistrée.")
        self.notes_label.setStyleSheet(
            f"color: {TEXT_PRIMARY if record.notes else TEXT_MUTED};"
            f" font-size: 12px; font-style: {'normal' if record.notes else 'italic'};"
        )

        for label, bar, used, maximum, glyph in (
            (self.lbl_pc, self.bar_pc, record.active_desktops, record.max_desktops, "🖥️"),
            (self.lbl_mob, self.bar_mob, record.active_mobiles, record.max_mobiles, "📱"),
        ):
            label.setText(f"{glyph} {used}/{maximum}")
            bar.setValue(int(used / max(1, maximum) * 100))

        self._rebuild_devices(record.devices)

        enabled = record.has_plaintext_key
        for btn in (self.btn_upgrade, self.btn_whatsapp, self.btn_qr,
                    self.btn_quotas, self.btn_devices, self.copy_btn):
            btn.setEnabled(True)
        self.copy_btn.setEnabled(enabled)

        self.show()
        self.raise_()

    @staticmethod
    def _tint_pill(label: QLabel, value: str) -> None:
        palette = {
            "active": ("#064E3B", "#34D399", "#059669"),
            "suspended": ("#450A0A", "#FCA5A5", "#DA3633"),
            "expired": ("#450A0A", "#FCA5A5", "#DA3633"),
            "lifetime": ("#1E1B4B", "#C7D2FE", "#4338CA"),
        }
        bg, fg, border = palette.get((value or "").lower(), ("#21262D", "#C9D1D9", CARD_BORDER))
        label.setStyleSheet(
            f"background: {bg}; color: {fg}; border: 1px solid {border};"
            f" border-radius: 6px; padding: 0 8px; font-size: 10px; font-weight: 700;"
        )

    @staticmethod
    def _expiry_text(record: LicenseRecord) -> str:
        if not record.expires_at:
            return "Expiration : illimitée (licence à vie)"
        text = f"Expire le : {record.expires_at[:10]}"
        days = record.days_left
        if days is not None:
            text += f"  ({days} jour{'s' if abs(days) != 1 else ''} restant{'s' if abs(days) != 1 else ''})"
        return text

    def _rebuild_devices(self, devices) -> None:
        # Tear down the previous rows. deleteLater() alone leaves the widgets
        # parented until the next event loop turn, so they stack up when the
        # operator clicks through rows quickly.
        while self.devices_container.count():
            item = self.devices_container.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.setParent(None)
                widget.deleteLater()

        if not devices:
            empty = QLabel("Aucun appareil actif lié à cette licence.")
            empty.setWordWrap(True)
            empty.setStyleSheet(f"color: {TEXT_MUTED}; font-size: 11px; font-style: italic;")
            self.devices_container.addWidget(empty)
            return

        for binding in devices:
            row = QFrame()
            row.setObjectName("DeviceRow")
            col = QVBoxLayout(row)
            col.setContentsMargins(10, 7, 10, 7)
            col.setSpacing(2)

            name = QLabel(f"🖥️ {binding.label or 'Appareil inconnu'}")
            name.setWordWrap(True)
            name.setStyleSheet(f"color: {TEXT_PRIMARY}; font-size: 12px; font-weight: 600;")
            col.addWidget(name)

            hwid = QLabel(f"HWID : {binding.short_hwid}")
            hwid.setFont(self._mono(9))
            hwid.setWordWrap(True)
            hwid.setTextInteractionFlags(
                Qt.TextInteractionFlag.TextSelectableByMouse
            )
            hwid.setStyleSheet(f"color: {TEXT_MUTED}; font-size: 10px;")
            col.addWidget(hwid)

            if binding.last_seen:
                seen = QLabel(f"Vu le {binding.last_seen:%Y-%m-%d %H:%M}")
                seen.setStyleSheet(f"color: {TEXT_MUTED}; font-size: 10px;")
                col.addWidget(seen)

            self.devices_container.addWidget(row)

    def _copy_key(self) -> None:
        if self._record is None:
            return
        key = self._record.license_key or ""
        if not key:
            return
        from PyQt6.QtWidgets import QApplication

        QApplication.clipboard().setText(key)
        self.copyRequested.emit(key)

    def close_drawer(self) -> None:
        self.hide()
        self.closed.emit()


class BulkActionBar(QFrame):
    """Sticky toolbar that appears when one or more rows are checked."""

    countChanged = pyqtSignal(int)
    #: (action, amount) where action is "seat", "days", or "export".
    bulkRequested = pyqtSignal(str, int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("BulkActionBar")
        self.setStyleSheet(
            "#BulkActionBar { background-color: #1E3A8A; border: 1px solid #3B82F6;"
            " border-radius: 10px; }"
        )
        self.hide()

        layout = QHBoxLayout(self)
        layout.setContentsMargins(14, 8, 14, 8)
        layout.setSpacing(8)

        self.label = QLabel("0 selected")
        self.label.setStyleSheet("color: #BFDBFE; font-weight: 700; font-size: 12px;")
        layout.addWidget(self.label)
        layout.addStretch()

        for text, slot, name in (
            ("+1 seat", self.addSeat, "TableBtn"),
            ("+2 seats", lambda: self.addSeat(2), "TableBtn"),
            ("+30 days", lambda: self.addDays(30), "TableBtn"),
            ("+365 days", lambda: self.addDays(365), "TableBtn"),
            ("Export", self.exportSelection, "TableBtn"),
            ("Clear", self.clear, "TableBtn"),
        ):
            button = QPushButton(text)
            button.setObjectName(name)
            button.clicked.connect(slot)
            layout.addWidget(button)

        self._days = 30

    def set_count(self, count: int) -> None:
        self.label.setText(f"{count} selected")
        self.setVisible(count > 0)
        self.countChanged.emit(count)

    def clear(self) -> None:
        self.set_count(0)

    def addSeat(self, amount: int = 1) -> None:
        self.bulkRequested.emit("seat", amount)

    def addDays(self, days: int) -> None:
        self.bulkRequested.emit("days", days)

    def exportSelection(self) -> None:
        self.bulkRequested.emit("export", 0)

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


class InspectorDrawer(QFrame):
    """
    Slide-over detail panel for a single licence.

    Kept as a QFrame rather than a QDockWidget so it can animate in from the
    right edge without fighting the window layout.
    """

    closed = pyqtSignal()
    copyRequested = pyqtSignal(str)
    deviceUnbindRequested = pyqtSignal(str, str)  # (license_key, device_id)
    flushSeatsRequested = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("InspectorDrawer")
        self.setStyleSheet(
            "#InspectorDrawer { background-color: #111827; border-left: 1px solid #374151; }"
        )
        self.setFixedWidth(360)
        self.hide()

        root = QVBoxLayout(self)
        root.setContentsMargins(16, 16, 16, 16)
        root.setSpacing(12)

        header = QHBoxLayout()
        self.title = QLabel("—")
        self.title.setObjectName("DetailTitle")
        self.title.setWordWrap(True)
        header.addWidget(self.title, stretch=1)
        close = QPushButton("✕")
        close.setObjectName("TableBtn")
        close.setFixedWidth(30)
        close.clicked.connect(self.close_drawer)
        header.addWidget(close)
        root.addLayout(header)

        self.subtitle = QLabel("")
        self.subtitle.setObjectName("Muted")
        self.subtitle.setWordWrap(True)
        root.addWidget(self.subtitle)

        self.key_label = QLabel("—")
        self.key_label.setFont(self._mono(11))
        self.key_label.setStyleSheet("color: #34D399;")
        root.addWidget(self.key_label)

        self.copy_btn = QPushButton("📋 Copy key")
        self.copy_btn.setObjectName("TableBtn")
        self.copy_btn.clicked.connect(
            lambda: self.copyRequested.emit(self._record.license_key if self._record else "")
        )
        root.addWidget(self.copy_btn)

        root.addWidget(self._section("Seats"))
        self.seat_desktops = self._meter("🖥️ POS")
        self.seat_mobiles = self._meter("📱 Mobile")
        root.addWidget(self.seat_desktops)
        root.addWidget(self.seat_mobiles)

        root.addWidget(self._section("Bound devices"))
        self.device_list = QLabel("—")
        self.device_list.setWordWrap(True)
        self.device_list.setObjectName("Muted")
        root.addWidget(self.device_list)

        self.flush_btn = QPushButton("🔄 Flush all seats")
        self.flush_btn.setObjectName("DangerBtn")
        self.flush_btn.clicked.connect(
            lambda: self.flushSeatsRequested.emit(self._record.license_key if self._record else "")
        )
        root.addWidget(self.flush_btn)

        root.addStretch()
        self._record: Optional[LicenseRecord] = None

    @staticmethod
    def _mono(size: int):
        from PyQt6.QtGui import QFont

        font = QFont()
        font.setFamilies(["JetBrains Mono", "Cascadia Code", "Consolas", "monospace"])
        font.setPointSize(size)
        font.setBold(True)
        return font

    @staticmethod
    def _section(text: str) -> QLabel:
        label = QLabel(text.upper())
        label.setObjectName("MetricLabel")
        return label

    @staticmethod
    def _meter(caption: str) -> QWidget:
        box = QWidget()
        layout = QVBoxLayout(box)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(2)
        label = QLabel(caption)
        label.setObjectName("Muted")
        bar = QProgressBar()
        bar.setRange(0, 100)
        bar.setTextVisible(False)
        layout.addWidget(label)
        layout.addWidget(bar)
        box.setProperty("bar", bar)
        return box

    def show_for(self, record: LicenseRecord) -> None:
        self._record = record
        self.title.setText(record.customer)
        self.subtitle.setText(
            f"{record.formula} · {record.status.value.upper()}\n"
            f"{record.phone or 'no phone'} · {record.city or 'no city'}\n"
            f"Created {record.created_date or '—'}"
        )
        self.key_label.setText(record.license_key or "—")
        self.copy_btn.setEnabled(record.has_plaintext_key)

        for widget, used, maximum in (
            (self.seat_desktops, record.active_desktops, record.max_desktops),
            (self.seat_mobiles, record.active_mobiles, record.max_mobiles),
        ):
            widget.property("bar").setValue(int(used / max(1, maximum) * 100))

        self.device_list.setText(self._device_summary(record))
        self.flush_btn.setEnabled(record.has_plaintext_key)
        self.show()
        self.raise_()

    def _device_summary(self, record: LicenseRecord) -> str:
        if not record.devices:
            return "No devices bound to this licence."
        lines = [f"• {d.short_hwid}  {d.platform}" for d in record.devices[:6]]
        if len(record.devices) > 6:
            lines.append(f"… and {len(record.devices) - 6} more")
        return "\n".join(lines)

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

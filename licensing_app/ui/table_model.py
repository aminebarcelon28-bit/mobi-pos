"""
Table model for the license grid.

Replaces the previous per-cell QWidget approach: a real Qt model means row
repaints are delegated to the view, sorting and filtering stay in the model,
and no widget churn occurs while scrolling.
"""

from PyQt6.QtCore import QAbstractTableModel, QModelIndex, Qt, pyqtSignal
from PyQt6.QtGui import QColor, QFont

from ..core.models import LicenseRecord
from .theme import expiry_label, formula_label, seats_label, status_label

COL_CHECK, COL_CLIENT, COL_KEY, COL_FORMULA, COL_DESKTOPS, COL_MOBILES, COL_STATUS, COL_EXPIRY, COL_ACTIONS = range(9)

COLUMNS = [
    "",
    "Client",
    "Clé d'Activation",
    "Formule",
    "Caisses PC",
    "Mobiles",
    "Statut",
    "Expiration",
    "Actions",
]

# PyQt6 does not expose Qt::TextFormatRole on Qt.ItemDataRole, but Qt still
# queries it (UserRole + 17) to decide how to interpret DisplayRole. The model
# answers with Qt.PlainText so a stray '<' can never be rendered as markup.
_TEXT_FORMAT_ROLE = getattr(Qt.ItemDataRole, "TextFormatRole", None)
if _TEXT_FORMAT_ROLE is None:
    _TEXT_FORMAT_ROLE = Qt.ItemDataRole.UserRole + 17


class LicenseTableModel(QAbstractTableModel):
    """Exposes LicenseRecord rows to a QTableView."""

    recordActivated = pyqtSignal(int)  # double-click on a row
    copyRequested = pyqtSignal(str)     # one-click copy of a payload
    actionRequested = pyqtSignal(str, int)  # (action, row)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._records: list = []
        self._checked: set = set()
        # Qt keeps raw pointers to objects returned from data(). Building a new
        # QFont/QColor per call lets PyQt collect it mid-paint, so they are
        # created once and reused.
        self._font_key = QFont("Consolas", 10, QFont.Weight.Bold)
        self._font_client = QFont("Segoe UI", 10, QFont.Weight.Bold)
        self._font_default = QFont("Segoe UI", 10)
        self._color_key = QColor("#34d399")
        self._color_key_unknown = QColor("#f59e0b")
        self._color_client = QColor("#f8fafc")
        self._color_default = QColor("#e2e8f0")
        self._align_center = int(Qt.AlignmentFlag.AlignCenter)
        self._align_left = int(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        self._plain_text = Qt.TextFormat.PlainText

    # ------------------------------------------------------------------
    # Qt model interface
    # ------------------------------------------------------------------
    def rowCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else len(self._records)

    def columnCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else len(COLUMNS)

    def headerData(self, section, orientation, role=Qt.ItemDataRole.DisplayRole):
        if role != Qt.ItemDataRole.DisplayRole:
            return None
        if orientation == Qt.Orientation.Horizontal:
            if section == COL_CHECK:
                return ""
            return COLUMNS[section]
        return section + 1

    def flags(self, index):
        base = super().flags(index)
        if not index.isValid():
            return base
        if index.column() == COL_CHECK:
            return base | Qt.ItemFlag.ItemIsUserCheckable
        return base

    def setData(self, index, value, role=Qt.ItemDataRole.EditRole):
        if index.isValid() and index.column() == COL_CHECK and role == Qt.ItemDataRole.CheckStateRole:
            self.set_checked(index.row(), Qt.CheckState(value) == Qt.CheckState.Checked)
            return True
        return super().setData(index, value, role)

    # ------------------------------------------------------------------
    # Checkbox (bulk selection) state
    # ------------------------------------------------------------------
    def set_checked(self, row: int, checked: bool) -> None:
        index = self.index(row, COL_CHECK)
        if not index.isValid():
            return
        if checked:
            self._checked.add(row)
        else:
            self._checked.discard(row)
        self.dataChanged.emit(index, index, [Qt.ItemDataRole.CheckStateRole])

    def toggle_row(self, row: int) -> bool:
        if not (0 <= row < len(self._records)):
            return False
        checked = row not in self._checked
        self.set_checked(row, checked)
        return checked

    def is_checked(self, row: int) -> bool:
        return row in self._checked

    def checked_rows(self) -> list:
        return sorted(self._checked)

    def checked_records(self) -> list:
        return [r for i, r in enumerate(self._records) if i in self._checked]

    def clear_checked(self) -> None:
        self._checked.clear()
        if self._records:
            self.dataChanged.emit(
                self.index(0, COL_CHECK),
                self.index(len(self._records) - 1, COL_CHECK),
                [Qt.ItemDataRole.CheckStateRole],
            )

    def select_all(self) -> None:
        self._checked = set(range(len(self._records)))
        if self._records:
            self.dataChanged.emit(
                self.index(0, COL_CHECK),
                self.index(len(self._records) - 1, COL_CHECK),
                [Qt.ItemDataRole.CheckStateRole],
            )

    def data(self, index, role=Qt.ItemDataRole.DisplayRole):
        if not index.isValid() or not (0 <= index.row() < len(self._records)):
            return None

        record = self._records[index.row()]
        col = index.column()

        if role == Qt.ItemDataRole.CheckStateRole and col == COL_CHECK:
            return (
                Qt.CheckState.Checked
                if index.row() in self._checked
                else Qt.CheckState.Unchecked
            )

        if role == Qt.ItemDataRole.DisplayRole:
            if col == COL_CHECK:
                return None
            return self._display_text(record, col)

        if role == Qt.ItemDataRole.EditRole:
            if col == COL_KEY:
                return record.license_key
            if col == COL_CLIENT:
                return record.customer
            return None

        if role == Qt.ItemDataRole.ToolTipRole:
            return self._tooltip(record)

        if role == Qt.ItemDataRole.TextAlignmentRole:
            if col == COL_CHECK:
                return self._align_center
            if col in (COL_FORMULA, COL_DESKTOPS, COL_MOBILES, COL_STATUS, COL_EXPIRY):
                return self._align_center
            return self._align_left

        if role == Qt.ItemDataRole.FontRole:
            if col == COL_KEY:
                return self._font_key
            if col == COL_CLIENT:
                return self._font_client
            return self._font_default

        if role == Qt.ItemDataRole.ForegroundRole:
            if col == COL_KEY:
                return self._color_key if record.has_plaintext_key else self._color_key_unknown
            if col == COL_CLIENT:
                return self._color_client
            return self._color_default

        if role == _TEXT_FORMAT_ROLE:
            # Every DisplayRole value is plain text, so the view never needs to
            # interpret markup. Explicitly answering keeps a stray '<' in a
            # customer name from being parsed as an HTML tag.
            return self._plain_text

        if role == Qt.ItemDataRole.UserRole:
            return record

        return None

    # ------------------------------------------------------------------
    # Data helpers
    # ------------------------------------------------------------------
    def set_records(self, records: list):
        self.beginResetModel()
        self._records = list(records)
        self.endResetModel()

    def record_at(self, row: int):
        if 0 <= row < len(self._records):
            return self._records[row]
        return None

    def records(self) -> list:
        return list(self._records)

    def is_editable_column(self, col: int) -> bool:
        return col != COL_ACTIONS

    # ------------------------------------------------------------------
    # Formatting
    # ------------------------------------------------------------------
    def _display_text(self, record: LicenseRecord, col: int) -> str:
        """
        Plain-text cell content.

        Every value here is a bare string. Status and formula cells are painted
        as pills by BadgeDelegate; returning HTML markup would leak raw tags
        into the view, because QTableView does not interpret rich text for
        DisplayRole unless TextFormatRole says so.
        """
        if col == COL_CLIENT:
            subtitle = "  |  ".join(
                part for part in (record.city, record.phone) if part
            )
            base = f"👤 {record.customer}"
            return f"{base} — {subtitle}" if subtitle else base

        if col == COL_KEY:
            return record.license_key or "[Clé inconnue]"

        if col == COL_FORMULA:
            return formula_label(record.formula)

        if col == COL_DESKTOPS:
            return seats_label(record.active_desktops, record.max_desktops)

        if col == COL_MOBILES:
            return seats_label(record.active_mobiles, record.max_mobiles)

        if col == COL_STATUS:
            return status_label(record.status)

        if col == COL_EXPIRY:
            return expiry_label(record.days_left)

        if col == COL_ACTIONS:
            return ""

        return ""

    def _tooltip(self, record: LicenseRecord) -> str:
        # Qt renders ToolTipRole as rich text, so every field that originates
        # from user-entered data (customer, city, phone, notes) must be escaped
        # or a crafted name could inject markup into the tooltip.
        def esc(value) -> str:
            return (
                str(value)
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
            )

        lines = [
            f"<b>{esc(record.customer)}</b>",
            f"Clé : {esc(record.license_key or '—')}",
            f"Formule : {esc(record.formula)}",
            f"Statut : {esc(record.status.value)} · Sync: {esc(record.sync_status.value)}",
            f"Postes : {esc(record.active_desktops)}/{esc(record.max_desktops)}"
            f"  •  Mobiles : {esc(record.active_mobiles)}/{esc(record.max_mobiles)}",
        ]
        days = record.days_left
        if days is not None:
            lines.append(f"Expiration : {esc(days)} jour(s) restant(s)")
        if record.city:
            lines.append(f"Ville : {esc(record.city)}")
        if record.phone:
            lines.append(f"Tél : {esc(record.phone)}")
        if record.notes:
            lines.append(f"Notes : {esc(record.notes)}")
        lines.append("Double-clic pour ouvrir le detail · Clic droit pour le menu.")
        return "<br>".join(lines)

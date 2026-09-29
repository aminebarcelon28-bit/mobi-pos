"""
Custom item delegates.

Paints the status pill, the fractional seat bar, and the inline copy affordance
directly onto the view's paint device. This is what keeps the table at 60 FPS:
no QWidget is constructed per cell, so a 5,000-row fleet allocates nothing
while scrolling.
"""

from __future__ import annotations

from PyQt6.QtCore import QEvent, QModelIndex, QRect, QRectF, QSize, Qt, pyqtSignal
from PyQt6.QtGui import QColor, QFont, QFontMetrics, QPainter, QPainterPath, QPen
from PyQt6.QtWidgets import QStyle, QStyledItemDelegate

from ..core.models import LicenseRecord, LicenseStatus
from .theme import formula_label, formula_palette, status_label, status_palette

# --- Design tokens (Linear/Stripe-inspired dark slate) ---------------------
CANVAS = "#0B0F19"
SURFACE_1 = "#111827"
SURFACE_2 = "#1F2937"
BORDER = "#374151"
ACCENT = "#3B82F6"
ACCENT_HOVER = "#2563EB"
TEXT_PRIMARY = "#F9FAFB"
TEXT_MUTED = "#9CA3AF"
MONO = ("JetBrains Mono", "Cascadia Code", "Consolas", "monospace")
SANS = ("Inter", "Segoe UI Variable Display", "Segoe UI", "sans-serif")

STATUS_COLORS = {
    LicenseStatus.ACTIVE: ("#064E3B", "#059669", "#34D399"),
    LicenseStatus.TRIAL: ("#312E81", "#4F46E5", "#A5B4FC"),
    LicenseStatus.EXPIRED: ("#450A0A", "#DC2626", "#FCA5A5"),
    LicenseStatus.UNREGISTERED: ("#362F0D", "#D97706", "#FCD34D"),
    LicenseStatus.SUSPENDED: ("#18181B", "#52525B", "#A1A1AA"),
    LicenseStatus.REVOKED: ("#18181B", "#52525B", "#A1A1AA"),
    LicenseStatus.PENDING_SYNC: ("#362F0D", "#D97706", "#FCD34D"),
}

SEAT_FILLS = ((0.0, "#DC2626"), (0.5, "#D97706"), (1.01, "#059669"))


def _font(family, size=10, bold=False) -> QFont:
    font = QFont()
    font.setFamilies(list(family))
    font.setPointSize(size)
    font.setBold(bold)
    return font


def _seat_fill(ratio: float) -> str:
    for threshold, color in SEAT_FILLS:
        if ratio < threshold:
            return color
    return SEAT_FILLS[-1][1]


def _draw_pill(painter: QPainter, rect: QRect, text: str, bg: str, border: str, fg: str,
               mono: bool = False) -> None:
    """Rounded status chip with a 1px border and centred label."""
    painter.save()
    painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    path = QPainterPath()
    path.addRoundedRect(QRectF(rect), 5.0, 5.0)
    painter.fillPath(path, QColor(bg))
    painter.setPen(QPen(QColor(border), 1.0))
    painter.drawPath(path)
    painter.setPen(QColor(fg))
    painter.setFont(_font(MONO if mono else SANS, 9, bold=True))
    painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, text)
    painter.restore()


class SeatBarDelegate(QStyledItemDelegate):
    """
    Renders fractional seat usage as ``used / max`` plus a proportional bar.

    The bar is what makes quota pressure scannable at a glance; the fill turns
    amber then red as it approaches the cap.
    """

    def __init__(self, kind: str = "desktop", parent=None):
        super().__init__(parent)
        self.kind = kind

    def _metrics(self, record: LicenseRecord) -> tuple:
        if self.kind == "mobile":
            return record.active_mobiles, record.max_mobiles, record.mobile_ratio, "📱"
        return record.active_desktops, record.max_desktops, record.seat_ratio, "🖥️"

    def paint(self, painter: QPainter, option, index: QModelIndex) -> None:
        record: LicenseRecord = index.data(Qt.ItemDataRole.UserRole)
        if record is None:
            super().paint(painter, option, index)
            return

        used, maximum, ratio, icon = self._metrics(record)
        painter.save()
        if option.state & QStyle.StateFlag.State_Selected:
            painter.fillRect(option.rect, QColor("#1E2D4D"))
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)

        text = f"{icon} {used}/{max(maximum, 1)}"
        painter.setPen(QColor(TEXT_PRIMARY))
        painter.setFont(_font(SANS, 9, bold=True))
        text_rect = QRect(option.rect.x() + 6, option.rect.y() + 4,
                          option.rect.width() - 12, 16)
        painter.drawText(text_rect, Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                         text)

        pct = f"{int(ratio * 100)}%"
        painter.setPen(QColor(TEXT_MUTED))
        painter.setFont(_font(MONO, 8))
        pct_rect = QRect(option.rect.x() + 6, option.rect.y() + 4,
                         option.rect.width() - 12, 16)
        painter.drawText(pct_rect, Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
                         pct)

        track = QRectF(option.rect.x() + 6, option.rect.y() + 24,
                       option.rect.width() - 12, 4)
        path = QPainterPath()
        path.addRoundedRect(track, 2.0, 2.0)
        painter.fillPath(path, QColor(SURFACE_2))

        clamped = max(0.0, min(1.0, ratio))
        if clamped > 0:
            fill = QPainterPath()
            fill.addRoundedRect(
                QRectF(track.x(), track.y(), max(track.width() * clamped, 2.0), track.height()),
                2.0, 2.0,
            )
            painter.fillPath(fill, QColor(_seat_fill(ratio)))
        painter.restore()

    def sizeHint(self, option, index: QModelIndex) -> QSize:
        return QSize(130, 40)


class CopyCellDelegate(QStyledItemDelegate):
    """
    License-key cell with a copy affordance that highlights on row hover.

    The button is drawn, not a widget, and only becomes interactive while the
    mouse is actually over the row.
    """

    BUTTON = QSize(26, 22)

    def button_rect(self, cell_rect: QRect) -> QRect:
        """Button geometry, right-aligned and vertically centred in the cell."""
        return QRect(
            cell_rect.right() - self.BUTTON.width() - 6,
            cell_rect.center().y() - self.BUTTON.height() // 2,
            self.BUTTON.width(),
            self.BUTTON.height(),
        )

    def hit_button(self, pos: QRect, cell_rect: QRect) -> bool:
        """True when the pointer is over the copy button of this cell."""
        return self.button_rect(cell_rect).contains(pos)

    def paint(self, painter: QPainter, option, index: QModelIndex) -> None:
        painter.save()
        painter.fillRect(option.rect, QColor(SURFACE_1) if option.state & QStyle.StateFlag.State_Selected else QColor(CANVAS))
        record: LicenseRecord = index.data(Qt.ItemDataRole.UserRole)
        if record is None:
            painter.restore()
            return

        key = record.license_key or "—"
        known = record.has_plaintext_key
        painter.setPen(QColor(TEXT_PRIMARY if known else "#FCD34D"))
        painter.setFont(_font(MONO, 9, bold=known))
        metrics = QFontMetrics(painter.font())
        elided = metrics.elidedText(key, Qt.TextElideMode.ElideRight, option.rect.width() - 50)
        painter.drawText(
            QRect(option.rect.x() + 6, option.rect.y(), option.rect.width() - 46, option.rect.height()),
            Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
            elided,
        )

        if known:
            btn = self.button_rect(option.rect)
            painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
            path = QPainterPath()
            path.addRoundedRect(QRectF(btn), 4.0, 4.0)
            painter.fillPath(path, QColor(SURFACE_2))
            painter.setPen(QPen(QColor(ACCENT), 1.0))
            painter.drawPath(path)
            painter.setPen(QColor(ACCENT))
            painter.setFont(_font(SANS, 9))
            painter.drawText(btn, Qt.AlignmentFlag.AlignCenter, "⧉")
        painter.restore()


class ExpiryDelegate(QStyledItemDelegate):
    """Expiry column: colour-coded by urgency, lifetime shown as infinite."""

    def paint(self, painter: QPainter, option, index: QModelIndex) -> None:
        record: LicenseRecord = index.data(Qt.ItemDataRole.UserRole)
        if record is None:
            super().paint(painter, option, index)
            return
        painter.save()
        if option.state & QStyle.StateFlag.State_Selected:
            painter.fillRect(option.rect, QColor("#1E2D4D"))

        days = record.days_left
        if days is None:
            text, color = "∞ Lifetime", TEXT_MUTED
        elif days < 0:
            text, color = f"Expired {-days}d", "#FCA5A5"
        elif days <= 10:
            text, color = f"{days}d left", "#FCD34D"
        else:
            text, color = f"{days}d left", "#34D399"

        painter.setPen(QColor(color))
        painter.setFont(_font(MONO, 9, bold=True))
        painter.drawText(option.rect, Qt.AlignmentFlag.AlignCenter, text)
        painter.restore()


class BadgeDelegate(QStyledItemDelegate):
    """
    Paints a bordered, rounded pill for the formula and status columns.

    The model returns a bare label string (never HTML) and this delegate draws
    the chip. Keeping markup out of the model means a customer name containing
    '<' can never reach a rich-text renderer.

    ``kind`` selects the palette source: "formula" reads the licence plan,
    "status" reads the effective licence status.
    """

    def __init__(self, kind: str = "status", parent=None):
        super().__init__(parent)
        self.kind = kind

    def _palette(self, record: LicenseRecord) -> tuple:
        if self.kind == "formula":
            return formula_palette(record.formula)
        return status_palette(record.status)

    def _label(self, record: LicenseRecord) -> str:
        if self.kind == "formula":
            return formula_label(record.formula)
        return status_label(record.status)

    def paint(self, painter: QPainter, option, index: QModelIndex) -> None:
        record: LicenseRecord = index.data(Qt.ItemDataRole.UserRole)
        if record is None:
            super().paint(painter, option, index)
            return

        painter.save()
        if option.state & QStyle.StateFlag.State_Selected:
            painter.fillRect(option.rect, QColor("#1E2D4D"))

        bg, border, fg = self._palette(record)
        # Horizontal padding is generous, vertical padding keeps the chip from
        # touching the row separator at any row height.
        rect = option.rect.adjusted(8, 9, -8, -9)
        _draw_pill(painter, rect, self._label(record), bg, border, fg, mono=True)
        painter.restore()

    def sizeHint(self, option, index: QModelIndex) -> QSize:
        return QSize(140, 40)


class StatusPillDelegate(BadgeDelegate):
    """
    Status column, kept as a named alias for BadgeDelegate("status").

    Both render the same pill from the same palette; two independent status
    painters are how the table and the validation harness drifted apart.
    """

    def __init__(self, parent=None):
        super().__init__("status", parent)


# The action chips drawn in the row's trailing column, left to right.
# (action id, tooltip)
ROW_ACTIONS = (
    ("qr", "Générer le QR d'activation"),
    ("desktops", "Gérer les postes"),
    ("whatsapp", "Envoyer par WhatsApp"),
    ("quotas", "Modifier les quotas"),
    ("upgrade", "Surclasser la licence"),
    ("more", "Plus d'actions…"),
)

_ACTION_GLYPHS = ("⧉", "🖥", "✆", "⇅", "★", "⋯")


class ActionsColumnDelegate(QStyledItemDelegate):
    """
    Interactive per-row action strip.

    Each chip hit-tests independently: hovering highlights one chip, clicking
    emits ``triggered(str, int)`` with the action id and the row. Painting stays
    in the view, so no per-cell widgets are created.
    """

    triggered = pyqtSignal(str, int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._hot: int = -1

    # -- geometry ---------------------------------------------------------
    def _chip_rects(self, option) -> list:
        """Chip rectangles for a row, laid out left to right with even gaps."""
        rect = option.rect
        count = len(ROW_ACTIONS)
        if count == 0:
            return []
        gap = 4
        total_gap = gap * (count - 1)
        width = (rect.width() - total_gap) / count
        height = min(26, max(18, rect.height() - 12))
        top = rect.top() + (rect.height() - height) / 2
        out = []
        for i in range(count):
            left = rect.left() + 6 + i * (width + gap)
            out.append(QRect(int(left), int(top), int(width), int(height)))
        return out

    def _chip_at(self, option, point) -> int:
        """Index of the chip under ``point``, or -1."""
        for i, chip in enumerate(self._chip_rects(option)):
            if chip.contains(point):
                return i
        return -1

    def chip_rect(self, option, action_id: str):
        """Rect for a named action, for hit-testing from the view."""
        for i, (aid, _tip) in enumerate(ROW_ACTIONS):
            if aid == action_id:
                return self._chip_rects(option)[i]
        return None

    def action_at(self, option, point):
        """Action id under ``point``, or None."""
        idx = self._chip_at(option, point)
        if idx < 0:
            return None
        return ROW_ACTIONS[idx][0]

    def tooltip_for(self, action_id: str) -> str:
        for aid, tip in ROW_ACTIONS:
            if aid == action_id:
                return tip
        return ""

    # -- painting ---------------------------------------------------------
    def paint(self, painter: QPainter, option, index: QModelIndex) -> None:
        painter.save()
        if option.state & QStyle.StateFlag.State_Selected:
            painter.fillRect(option.rect, QColor("#1E2D4D"))
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)

        rects = self._chip_rects(option)
        for i, (action_id, _tip) in enumerate(ROW_ACTIONS):
            chip = rects[i]
            hot = (i == self._hot)
            path = QPainterPath()
            path.addRoundedRect(QRectF(chip), 4.0, 4.0)
            painter.fillPath(path, QColor(ACCENT_HOVER if hot else SURFACE_2))
            painter.setPen(QPen(QColor(ACCENT if hot else BORDER), 1.0))
            painter.drawPath(path)
            painter.setPen(QColor(TEXT_PRIMARY if hot else TEXT_MUTED))
            painter.setFont(_font(SANS, 10))
            painter.drawText(chip, Qt.AlignmentFlag.AlignCenter, _ACTION_GLYPHS[i])

        painter.restore()

    # -- interaction ------------------------------------------------------
    def set_hot(self, index: int) -> None:
        self._hot = index

    def editorEvent(self, event, model, option, index):
        """Handle click, hover-enter and hover-leave without child widgets."""
        etype = event.type()
        pos = event.position().toPoint() if hasattr(event, "position") else event.pos()

        if etype == QStyle.ControlType.SP_MouseButtonRelease:
            if not (option.state & QStyle.StateFlag.State_Enabled):
                return False
            action_id = self.action_at(option, pos)
            if action_id is None:
                return False
            self.triggered.emit(action_id, index.row())
            return True

        if etype == getattr(QStyle.ControlType, "SP_MouseMove", None):
            new_hot = self._chip_at(option, pos)
            if new_hot != self._hot:
                self._hot = new_hot
                if self.parent() is not None and index.isValid():
                    self.parent().viewport().update()
            return False

        if etype == QEvent.Type.Leave:
            if self._hot != -1:
                self._hot = -1
                if self.parent() is not None:
                    self.parent().viewport().update()
            return False

        return super().editorEvent(event, model, option, index)

    def sizeHint(self, option, index: QModelIndex) -> QSize:
        return QSize(360, 40)

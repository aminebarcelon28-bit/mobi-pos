"""
Reusable presentation widgets: toasts, loading overlay, badge labels, copy
buttons, and metric cards. Kept free of application-specific logic.
"""

from PyQt6.QtCore import (
    QEasingCurve,
    QPoint,
    QPropertyAnimation,
    Qt,
    QTimer,
    pyqtSignal,
)
from PyQt6.QtGui import QColor, QPainter, QPen
from PyQt6.QtWidgets import (
    QFrame,
    QGraphicsOpacityEffect,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from .theme import mono_font


# ----------------------------------------------------------------------
# Toasts
# ----------------------------------------------------------------------
class Toast(QFrame):
    """Non-blocking, auto-dismissing notification."""

    def __init__(self, message: str, kind: str = "info", parent=None, msec: int = 3200):
        super().__init__(parent)
        self.setObjectName(f"Toast{kind.capitalize()}")
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, False)

        palette = {
            "success": ("#064e3b", "#6ee7b7", "✅"),
            "error": ("#7f1d1d", "#fca5a5", "⛔"),
            "warning": ("#713f12", "#fde68a", "⚠️"),
            "info": ("#1e293b", "#e2e8f0", "ℹ️"),
        }
        bg, fg, icon = palette.get(kind, palette["info"])

        self.setStyleSheet(
            f"QFrame#{self.objectName()} {{"
            f" background-color: {bg}; border: 1px solid {fg};"
            f" border-radius: 10px; }}"
        )

        layout = QHBoxLayout(self)
        layout.setContentsMargins(14, 10, 14, 10)
        layout.setSpacing(10)

        glyph = QLabel(icon)
        glyph.setStyleSheet(f"color: {fg}; font-size: 15px;")
        layout.addWidget(glyph)

        self.label = QLabel(message)
        self.label.setWordWrap(True)
        self.label.setStyleSheet(f"color: {fg}; font-size: 12px; font-weight: 600;")
        layout.addWidget(self.label, stretch=1)

        self._effect = QGraphicsOpacityEffect(self)
        self.setGraphicsEffect(self._effect)
        self._fade = QPropertyAnimation(self._effect, b"opacity", self)
        self._fade.setDuration(220)
        self._fade.setStartValue(1.0)
        self._fade.setEndValue(0.0)
        self._fade.finished.connect(self.deleteLater)

        # msec <= 0 means "sticky": the toast stays until dismissed by click.
        # QTimer.singleShot(0, ...) would fire on the next event-loop turn and
        # delete the toast immediately, so the guard is required.
        if msec and msec > 0:
            QTimer.singleShot(msec, self._dismiss)

    def _dismiss(self):
        self._fade.start()

    def mousePressEvent(self, event):
        self._dismiss()
        super().mousePressEvent(event)


class ToastHost(QWidget):
    """
    Stacks toasts in the bottom-right corner of its parent window.

    Bottom-right keeps the stack clear of the header controls and the row
    actions, and it matches where the eye already is after a bulk operation.
    Newest toasts sit at the bottom and older ones are pushed upward, so the
    layout never overlaps them.
    """

    #: Distance kept clear from the window edges, in pixels.
    MARGIN = 24

    def __init__(self, parent: QWidget):
        super().__init__(parent)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self._layout = QVBoxLayout(self)
        self._layout.setContentsMargins(0, 0, 0, 0)
        self._layout.setSpacing(8)
        # Newest toast is inserted directly above this stretch, so the stack
        # grows upward from the bottom edge and items never overlap.
        self._layout.addStretch()
        self._toasts = []
        self._parent = parent
        #: Extra height reserved at the bottom, e.g. for a fixed dock, so a
        #: tall stack never covers persistent controls.
        self.bottom_inset = 0

    def notify(self, message: str, kind: str = "info", msec: int = 3200) -> None:
        toast = Toast(message, kind, self._parent, msec)
        self._layout.insertWidget(self._layout.count() - 1, toast)
        self._toasts.append(toast)
        toast.destroyed.connect(lambda: self._forget(toast))
        self.reposition()
        toast.show()

    def _forget(self, toast):
        if toast in self._toasts:
            self._toasts.remove(toast)

    def active_rects(self) -> list:
        """
        Visible toast rectangles in window coordinates.

        Returns QRect objects positioned relative to the parent window, so
        callers can compare them against the window rect or the dock. A
        QWidget.geometry() is parent-relative and would report every toast at
        the origin.
        """
        host_pos = self.pos()
        return [t.geometry().translated(host_pos) for t in self._toasts if t.isVisible()]

    def reposition(self) -> None:
        """Re-anchor to the bottom-right of the parent, above the dock."""
        self._parent.installEventFilter(self)
        self.adjustSize()
        parent_h = self._parent.height()
        parent_w = self._parent.width()
        # bottom_inset keeps the stack clear of a fixed bottom dock, so a burst
        # of toasts never hides the server-health card.
        self.move(
            max(0, parent_w - self.width() - self.MARGIN),
            max(0, parent_h - self.height() - self.MARGIN - self.bottom_inset),
        )

    def eventFilter(self, obj, event):
        if event.type() == event.Type.Resize:
            self.reposition()
        return False


# ----------------------------------------------------------------------
# Loading
# ----------------------------------------------------------------------
class Spinner(QWidget):
    """Indeterminate arc spinner, repainted on a timer."""

    def __init__(self, diameter: int = 34, thickness: int = 4, parent=None):
        super().__init__(parent)
        self._diameter = diameter
        self._thickness = thickness
        self._angle = 0
        self.setFixedSize(diameter, diameter)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._advance)
        self._timer.start(60)

    def _advance(self):
        self._angle = (self._angle + 30) % 360
        self.update()

    def stop(self):
        self._timer.stop()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.translate(self.width() / 2, self.height() / 2)
        painter.rotate(self._angle)
        pen = QPen(QColor("#10b981"))
        pen.setWidth(self._thickness)
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        painter.setPen(pen)
        rect = self._diameter / 2 - self._thickness
        painter.drawArc(int(-rect), int(-rect), int(rect * 2), int(rect * 2), 0, 270 * 16)


class LoadingOverlay(QFrame):
    """Dims a target widget and shows a spinner while work is in flight."""

    def __init__(self, target: QWidget, text: str = "Synchronisation..."):
        super().__init__(target)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setStyleSheet("background-color: rgba(11, 15, 25, 170);")
        self.hide()

        layout = QVBoxLayout(self)
        layout.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.setSpacing(12)

        self.spinner = Spinner(44, 5, self)
        layout.addWidget(self.spinner, alignment=Qt.AlignmentFlag.AlignCenter)

        self.label = QLabel(text)
        self.label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.label.setStyleSheet("color: #e2e8f0; font-size: 12px; font-weight: 700;")
        layout.addWidget(self.label)

    def setText(self, text: str):
        self.label.setText(text)

    def showEvent(self, event):
        self.raise_()
        super().showEvent(event)


# ----------------------------------------------------------------------
# Small building blocks
# ----------------------------------------------------------------------
class BadgeLabel(QLabel):
    """Centred QLabel that renders an HTML pill."""

    def __init__(self, html: str = "", parent=None):
        super().__init__(html, parent)
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setTextFormat(Qt.TextFormat.RichText)
        self.setTextInteractionFlags(Qt.TextInteractionFlag.NoTextInteraction)


class CopyButton(QPushButton):
    """One-click copy button that confirms the copy inline."""

    def __init__(self, text: str = "📋", tooltip: str = "Copier", parent=None):
        super().__init__(text, parent)
        self._payload = ""
        self.setObjectName("TableBtn")
        self.setFixedWidth(32)
        self.setToolTip(tooltip)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.clicked.connect(self._copy)

    def setPayload(self, text: str, enabled: bool = True):
        self._payload = text or ""
        self.setEnabled(enabled and bool(self._payload))
        self.setText("📋")

    def _copy(self):
        from PyQt6.QtWidgets import QApplication

        if not self._payload:
            return
        QApplication.clipboard().setText(self._payload)
        self.setText("✅")
        QTimer.singleShot(1200, lambda: self.setText("📋"))


class MetricCard(QFrame):
    """KPI tile with a caption and a large value."""

    def __init__(self, caption: str, value: str = "0", parent=None):
        super().__init__(parent)
        self.setObjectName("MetricCard")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(4)

        self.caption = QLabel(caption)
        self.caption.setObjectName("MetricLabel")

        self.value = QLabel(value)
        self.value.setObjectName("MetricValue")

        layout.addWidget(self.caption)
        layout.addWidget(self.value)

    def setValue(self, text: str, color: str = "#ffffff"):
        self.value.setText(text)
        self.value.setStyleSheet(f"color: {color}; font-size: 26px; font-weight: 700;")


class DismissibleAlertBanner(QFrame):
    """
    Persistent inline alert shown directly beneath the header.

    Unlike a toast, this does not auto-dismiss: it marks a condition the
    operator must acknowledge, such as a broken audit chain or missing secrets.
    The operator closes it explicitly.
    """

    dismissed = pyqtSignal()

    KINDS = {
        "info": ("ℹ️", "#1D4ED8", "#BFDBFE"),
        "warning": ("⚠️", "#B45309", "#FDE047"),
        "error": ("⛔", "#DC2626", "#FCA5A5"),
        "success": ("✅", "#047857", "#6EE7B7"),
    }

    def __init__(self, message: str = "", kind: str = "info", parent=None):
        super().__init__(parent)
        self.setObjectName("AlertBanner")
        self._kind = kind

        layout = QHBoxLayout(self)
        layout.setContentsMargins(14, 8, 10, 8)
        layout.setSpacing(10)

        self.icon = QLabel()
        self.icon.setObjectName("AlertIcon")

        self.message = QLabel(message)
        self.message.setObjectName("AlertText")
        # Operator names and server error text are untrusted; never interpret
        # them as markup.
        self.message.setTextFormat(Qt.TextFormat.PlainText)
        self.message.setWordWrap(True)

        self.close_button = QPushButton("✕")
        self.close_button.setObjectName("AlertClose")
        self.close_button.setFixedSize(24, 24)
        self.close_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.close_button.setToolTip("Masquer cette alerte")
        self.close_button.clicked.connect(self.dismiss)

        layout.addWidget(self.icon, 0, Qt.AlignmentFlag.AlignTop)
        layout.addWidget(self.message, 1)
        layout.addWidget(self.close_button, 0, Qt.AlignmentFlag.AlignTop)

        self.set_kind(kind)

    def set_message(self, message: str) -> None:
        self.message.setText(message)

    def set_kind(self, kind: str) -> None:
        self._kind = kind
        glyph, border, fg = self.KINDS.get(kind, self.KINDS["info"])
        self.icon.setText(glyph)
        self.setStyleSheet(
            f"QFrame#AlertBanner {{ background-color: rgba(15, 23, 42, 0.9);"
            f" border: 1px solid {border}; border-left: 3px solid {border};"
            f" border-radius: 8px; }}"
            f" QLabel#AlertText {{ color: {fg}; font-size: 12px; }}"
            f" QLabel#AlertIcon {{ color: {fg}; font-size: 13px; }}"
            f" QPushButton#AlertClose {{ background: transparent; color: {fg};"
            f" border: none; font-size: 12px; }}"
            f" QPushButton#AlertClose:hover {{ background-color: {border};"
            f" border-radius: 4px; }}"
        )

    def dismiss(self) -> None:
        self.hide()
        self.dismissed.emit()

    def message_text(self) -> str:
        return self.message.text()


class ServerStatusCard(QFrame):
    """
    Compact server-health readout for the bottom dock.

    Shows the edge host, reachability and round-trip latency on one line, with a
    status dot that carries the colour so the text itself stays neutral.
    """

    STATES = {
        "unknown": ("⚪", "Connexion…", "#94A3B8"),
        "online": ("🟢", "En ligne", "#34D399"),
        "slow": ("🟡", "Lent", "#FCD34D"),
        "offline": ("🔴", "Hors ligne", "#FCA5A5"),
    }

    def __init__(self, host: str = "", parent=None):
        super().__init__(parent)
        self.setObjectName("ServerStatusCard")

        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 6, 12, 6)
        layout.setSpacing(10)

        self.dot = QLabel("⚪")
        self.dot.setObjectName("ServerStatusDot")

        self.title = QLabel("Serveur")
        self.title.setObjectName("ServerStatusTitle")

        self.host = QLabel(host)
        self.host.setObjectName("Muted")
        self.host.setTextFormat(Qt.TextFormat.PlainText)
        # Elide rather than let a long hostname push the dock wider than 72 px.
        self.host.setMinimumWidth(0)

        self.detail = QLabel("Connexion…")
        self.detail.setObjectName("Muted")

        layout.addWidget(self.dot)
        layout.addWidget(self.title)
        layout.addWidget(self.host, 1)
        layout.addWidget(self.detail, 0)

        self.set_state("unknown", "")

    def set_state(self, state: str, detail: str = "") -> None:
        """state: unknown | online | slow | offline."""
        glyph, label, color = self.STATES.get(state, self.STATES["unknown"])
        self.dot.setText(glyph)
        self.title.setText(label)
        self.title.setStyleSheet(f"color: {color}; font-weight: 700;")
        self.detail.setText(detail)

    def set_host(self, host: str) -> None:
        self.host.setText(host)


class KeyField(QFrame):
    """Read-only monospace field with an inline copy button."""

    def __init__(self, value: str = "", parent=None):
        super().__init__(parent)
        self.setObjectName("KeyField")
        self.setStyleSheet(
            "QFrame#KeyField { background-color: #0d121f; border: 1px solid #1f2937;"
            " border-radius: 8px; }"
        )

        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 8, 8, 8)
        layout.setSpacing(8)

        self.value_label = QLabel(value or "—")
        self.value_label.setFont(mono_font(12))
        self.value_label.setStyleSheet("color: #34d399; background: transparent;")
        self.value_label.setTextInteractionFlags(
            Qt.TextInteractionFlag.TextSelectableByMouse
        )
        layout.addWidget(self.value_label, stretch=1)

        self.copy_button = CopyButton(tooltip="Copier l'identifiant", parent=self)
        layout.addWidget(self.copy_button)

    def setValue(self, value: str):
        self.value_label.setText(value or "—")
        self.copy_button.setPayload(value)


class PillButton(QPushButton):
    """Status filter pill that swaps stylesheet role on activation."""

    def __init__(self, key: str, text: str, parent=None):
        super().__init__(text, parent)
        self.key = key
        self.setObjectName("FilterPill")
        self.setCursor(Qt.CursorShape.PointingHandCursor)

    def setActive(self, active: bool):
        self.setObjectName("FilterPillActive" if active else "FilterPill")
        self.style().unpolish(self)
        self.style().polish(self)

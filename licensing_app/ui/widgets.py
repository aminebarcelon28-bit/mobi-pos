"""
Reusable presentation widgets: toasts, loading overlay, badge labels, copy
buttons, and metric cards. Kept free of application-specific logic.
"""

from PyQt6.QtCore import (
    QEasingCurve,
    QPoint,
    QPropertyAnimation,
    QRect,
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

    #: Horizontal inset from the window's right edge.
    MARGIN = 24

    #: Vertical inset from the window's bottom edge, covering the 68px dock
    #: plus a 20px gap so a toast never sits on the server-health card.
    BOTTOM_CLEARANCE = 88

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
        #: Overridden by the window so the clearance tracks the real dock
        #: height if it is ever resized.
        self.bottom_clearance = self.BOTTOM_CLEARANCE
        #: Callables returning QRect in parent coordinates that the toast stack
        #: must not cover. Supplied as callables rather than rects because the
        #: inspector drawer is shown, hidden, and animated, so its geometry has
        #: to be re-read at every reposition.
        self._avoid = []
        self._last_parent_size = None

    def set_avoid_regions(self, providers) -> None:
        """Register widgets/regions the toast stack must stay clear of."""
        self._avoid = list(providers)

    def detach(self) -> None:
        """
        Stop observing the parent.

        Called before the parent tears down. The filter is installed *on* the
        parent, so it has to be removed from there, and the region providers
        must go because they close over child widgets that are about to be
        destroyed -- reading their geometry after that is undefined behaviour,
        not a catchable Python error.
        """
        try:
            self._parent.removeEventFilter(self)
        except Exception:
            pass
        self._avoid = []

        # Drop the toast list before the parent starts tearing down. Each
        # Toast is connected to ``destroyed`` via a lambda that closes over
        # itself, and letting those run while the parent is being destroyed
        # reaches into half-freed C++ objects -- an access violation that kills
        # the interpreter rather than raising anything catchable.
        for toast in list(self._toasts):
            try:
                toast.destroyed.disconnect()
            except (RuntimeError, TypeError):
                pass
        self._toasts.clear()

    def _avoid_rects(self) -> list:
        """
        Resolve the registered regions to QRects in parent coordinates.

        Entries may be a QWidget (whose geometry is read live, so an animated
        or resized panel stays accurate) or a zero-argument callable returning
        a QRect. Widgets are preferred: a callable supplied by the window has to
        close over the window, which forms a MainWindow -> ToastHost -> lambda
        -> MainWindow cycle and segfaults when the collector finally breaks it.
        """
        out = []
        parent = self._parent
        for item in self._avoid:
            if item is None:
                continue
            try:
                if isinstance(item, QWidget):
                    # A hidden panel keeps reporting its last geometry, which
                    # would push the toast stack up for a drawer the operator
                    # cannot even see.
                    if not item.isVisible():
                        continue
                    size = item.size()
                    if not size.isValid() or size.height() <= 0:
                        continue
                    out.append(QRect(item.mapTo(parent, QPoint(0, 0)), size))
                else:
                    rect = item() if callable(item) else item
                    if rect is not None and rect.isValid():
                        out.append(rect)
            except RuntimeError:
                # Underlying C++ object already destroyed during teardown.
                continue
        return out

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
        """
        Anchor the stack to the bottom-right of the parent window, clear of the
        dock and of any registered region.

        A constant bottom inset is not enough: the inspector drawer is anchored
        to the bottom-right and carries the primary [Appareils] and [WhatsApp]
        buttons, so a stack sized only against the 68px dock lands on top of
        them. The stack is therefore raised above the topmost avoid-region it
        horizontally overlaps, and only falls back to ``bottom_clearance`` when
        nothing is in the way.
        """
        self._parent.installEventFilter(self)
        self.adjustSize()
        parent_w = self._parent.width()
        parent_h = self._parent.height()

        left = max(0, parent_w - self.width() - self.MARGIN)
        top = max(0, parent_h - self.height() - self.bottom_clearance)

        avoid = self._avoid_rects()
        if avoid:
            right = left + self.width()
            host_bottom = top + self.height()

            # Stack above every region it horizontally overlaps and that
            # actually reaches into its vertical span. The smallest such top
            # edge is the binding constraint -- clearing the highest one clears
            # them all. Regions entirely above the stack (e.g. the inspector's
            # button row on a narrow window) are left where the layout put them.
            blockers = [
                rect.top()
                for rect in avoid
                if rect.right() > left
                and rect.left() < right
                and rect.bottom() > top
                and rect.top() < host_bottom
            ]
            if blockers:
                top = max(0, min(blockers) - self.height() - self.MARGIN)

        # Only move when the target actually changed. reposition() runs from
        # the parent's Resize event, and move() on a child can provoke another
        # layout pass; issuing a redundant move on every pass recurses until
        # the interpreter dies with 0xC0000409.
        if self.pos() != QPoint(left, top):
            self.move(left, top)

    def eventFilter(self, obj, event):
        if event.type() == event.Type.Resize:
            size = event.size()
            if (size.width(), size.height()) != self._last_parent_size:
                self._last_parent_size = (size.width(), size.height())
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
    action_triggered = pyqtSignal()

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

        # Optional recovery affordance. An alert that only explains a problem
        # leaves the operator stuck; this lets the banner offer the one action
        # that can actually resolve it.
        self.action_button = QPushButton()
        self.action_button.setObjectName("AlertAction")
        self.action_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.action_button.clicked.connect(self.action_triggered)
        self.action_button.hide()

        layout.addWidget(self.icon, 0, Qt.AlignmentFlag.AlignTop)
        layout.addWidget(self.message, 1)
        layout.addWidget(self.action_button, 0, Qt.AlignmentFlag.AlignTop)
        layout.addWidget(self.close_button, 0, Qt.AlignmentFlag.AlignTop)

        self.set_kind(kind)

    def set_action(self, label: str = "", tooltip: str = "") -> None:
        """Show a recovery button in the banner, or hide it with an empty label."""
        if not label:
            self.action_button.hide()
            return
        self.action_button.setText(label)
        self.action_button.setToolTip(tooltip)
        self.action_button.setVisible(True)

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
            f" QPushButton#AlertAction {{ background: transparent; color: {fg};"
            f" border: 1px solid {border}; border-radius: 5px;"
            f" padding: 3px 10px; font-size: 11px; font-weight: 600; }}"
            f" QPushButton#AlertAction:hover {{ background-color: {border};"
            f" border-radius: 5px; }}"
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

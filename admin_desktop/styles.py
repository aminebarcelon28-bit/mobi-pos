"""
Modern Dark Slate & Emerald Theme Stylesheet for MobiPOS License Admin Suite.
"""

DARK_THEME_QSS = """
/* Global Reset & Base */
QWidget {
    background-color: #0b0f19;
    color: #f3f4f6;
    font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
    font-size: 13px;
    selection-background-color: #10b981;
    selection-color: #ffffff;
}

/* Main Window */
QMainWindow {
    background-color: #0b0f19;
}

/* Containers & Cards */
QFrame#MetricCard {
    background-color: #131b2e;
    border: 1px solid #1f293d;
    border-radius: 10px;
    padding: 12px;
}
QFrame#MetricCard:hover {
    border: 1px solid #374151;
    background-color: #162038;
}

QFrame#HeaderCard {
    background-color: #131b2e;
    border-bottom: 1px solid #1f293d;
    padding: 14px 20px;
}

QFrame#ToolbarCard {
    background-color: #111827;
    border: 1px solid #1f2937;
    border-radius: 8px;
    padding: 8px 14px;
}

/* Headers & Labels */
QLabel#AppTitle {
    font-size: 19px;
    font-weight: 700;
    color: #ffffff;
    letter-spacing: 0.5px;
}
QLabel#AppSubtitle {
    font-size: 11px;
    font-weight: 500;
    color: #9ca3af;
}

QLabel#MetricValue {
    font-size: 26px;
    font-weight: 700;
    color: #ffffff;
}
QLabel#MetricLabel {
    font-size: 12px;
    font-weight: 600;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.8px;
}

QLabel#SectionHeader {
    font-size: 15px;
    font-weight: 700;
    color: #e5e7eb;
}

/* Buttons */
QPushButton {
    background-color: #1f293d;
    color: #f9fafb;
    border: 1px solid #374151;
    border-radius: 6px;
    padding: 7px 14px;
    font-weight: 600;
    min-height: 18px;
}
QPushButton:hover {
    background-color: #28354f;
    border-color: #4b5563;
}
QPushButton:pressed {
    background-color: #0f172a;
}
QPushButton:disabled {
    background-color: #111827;
    color: #4b5563;
    border-color: #1f2937;
}

/* Primary Emerald Button */
QPushButton#PrimaryBtn {
    background-color: #059669;
    color: #ffffff;
    border: 1px solid #10b981;
    font-weight: 700;
    padding: 8px 18px;
}
QPushButton#PrimaryBtn:hover {
    background-color: #10b981;
    border-color: #34d399;
}
QPushButton#PrimaryBtn:pressed {
    background-color: #047857;
}

/* Secondary Action Button */
QPushButton#SecondaryBtn {
    background-color: #2563eb;
    color: #ffffff;
    border: 1px solid #3b82f6;
}
QPushButton#SecondaryBtn:hover {
    background-color: #3b82f6;
    border-color: #60a5fa;
}

/* Danger / Reset Button */
QPushButton#DangerBtn {
    background-color: #991b1b;
    color: #fee2e2;
    border: 1px solid #dc2626;
}
QPushButton#DangerBtn:hover {
    background-color: #dc2626;
    color: #ffffff;
}

/* WhatsApp Emerald Button */
QPushButton#WhatsAppBtn {
    background-color: #15803d;
    color: #ffffff;
    border: 1px solid #22c55e;
}
QPushButton#WhatsAppBtn:hover {
    background-color: #22c55e;
}

/* Small Table Action Buttons */
QPushButton#TableBtn {
    padding: 4px 8px;
    font-size: 11px;
    font-weight: 600;
    border-radius: 4px;
    min-height: 14px;
}

/* Text Inputs & Search */
QLineEdit {
    background-color: #111827;
    border: 1px solid #374151;
    border-radius: 6px;
    padding: 6px 12px;
    color: #f9fafb;
    selection-background-color: #059669;
}
QLineEdit:focus {
    border: 1px solid #10b981;
    background-color: #131b2e;
}

QTextEdit, QPlainTextEdit {
    background-color: #0d121f;
    border: 1px solid #374151;
    border-radius: 6px;
    padding: 8px;
    color: #e2e8f0;
    font-family: "Consolas", "Cascadia Code", "Courier New", monospace;
    font-size: 12px;
}

/* Dropdown ComboBox */
QComboBox {
    background-color: #111827;
    border: 1px solid #374151;
    border-radius: 6px;
    padding: 6px 12px;
    color: #f9fafb;
    min-width: 120px;
}
QComboBox:focus {
    border: 1px solid #10b981;
}
QComboBox::drop-down {
    subcontrol-origin: padding;
    subcontrol-position: top right;
    width: 24px;
    border-left: none;
}
QComboBox QAbstractItemView {
    background-color: #131b2e;
    border: 1px solid #374151;
    selection-background-color: #10b981;
    selection-color: #ffffff;
    color: #f3f4f6;
    padding: 4px;
}

/* SpinBox */
QSpinBox {
    background-color: #111827;
    border: 1px solid #374151;
    border-radius: 6px;
    padding: 6px 10px;
    color: #f9fafb;
}
QSpinBox:focus {
    border: 1px solid #10b981;
}

/* Tables */
QTableWidget {
    background-color: #0f1523;
    alternate-background-color: #131b2e;
    border: 1px solid #1f293d;
    border-radius: 8px;
    gridline-color: #1e293b;
    color: #f3f4f6;
    selection-background-color: #1e2d4d;
    selection-color: #ffffff;
}
QTableWidget::item {
    padding: 6px 10px;
    border-bottom: 1px solid #182235;
}
QTableWidget::item:selected {
    background-color: #1e2d4d;
}

/* Table Header */
QHeaderView::section {
    background-color: #131b2e;
    color: #9ca3af;
    font-weight: 700;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    padding: 9px 10px;
    border: none;
    border-bottom: 2px solid #1f293d;
}

/* Scrollbars */
QScrollBar:vertical {
    border: none;
    background: #0b0f19;
    width: 9px;
    margin: 0px 0px 0px 0px;
}
QScrollBar::handle:vertical {
    background: #374151;
    min-height: 25px;
    border-radius: 4px;
}
QScrollBar::handle:vertical:hover {
    background: #4b5563;
}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
    height: 0px;
}

QScrollBar:horizontal {
    border: none;
    background: #0b0f19;
    height: 9px;
    margin: 0px 0px 0px 0px;
}
QScrollBar::handle:horizontal {
    background: #374151;
    min-width: 25px;
    border-radius: 4px;
}
QScrollBar::handle:horizontal:hover {
    background: #4b5563;
}
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {
    width: 0px;
}

/* Dialogs */
QDialog {
    background-color: #0e1422;
    border: 1px solid #28354f;
    border-radius: 10px;
}

/* Status Bar */
QStatusBar {
    background-color: #0b0f19;
    border-top: 1px solid #1f293d;
    color: #9ca3af;
    font-size: 11px;
    padding: 4px 10px;
}

/* Badges Styles (Helper strings) */
"""

# Badge HTML formatters for table cells
def badge_html(text: str, bg_color: str, fg_color: str = "#ffffff") -> str:
    return (
        f'<span style="background-color: {bg_color}; color: {fg_color}; '
        f'padding: 3px 8px; border-radius: 5px; font-weight: 700; font-size: 11px;">'
        f'{text}</span>'
    )

def status_badge(status: str) -> str:
    s = (status or "").lower()
    if s == "active":
        return badge_html("🟢 ACTIF", "#065f46", "#34d399")
    elif s == "suspended":
        return badge_html("⏸️ SUSPENDU", "#78350f", "#fbbf24")
    elif s == "revoked":
        return badge_html("🚫 RÉVOQUÉ", "#881337", "#f87171")
    elif s == "pending_sync":
        return badge_html("⏳ EN ATTENTE", "#1e3a8a", "#60a5fa")
    return badge_html(s.upper(), "#374151", "#d1d5db")

def formula_badge(formula: str) -> str:
    f = (formula or "").upper()
    if f in ("LIFETIME", "LIFE"):
        return badge_html("✨ À VIE (LIFETIME)", "#064e3b", "#6ee7b7")
    elif f in ("90D", "3_MONTHS"):
        return badge_html("📅 90 JOURS", "#1e3a8a", "#93c5fd")
    elif f in ("24H", "DEMO"):
        return badge_html("⚡ DÉMO 24H", "#713f12", "#fde047")
    return badge_html(f, "#312e81", "#c7d2fe")

def seats_badge(used: int, max_val: int, icon: str = "", *args, **kwargs) -> str:
    prefix = f"{icon} " if icon else ""
    ratio = used / max(1, max_val)
    if ratio >= 1.0:
        # Full capacity
        return badge_html(f"{prefix}{used} / {max_val} (Plein)", "#7f1d1d", "#fca5a5")
    elif ratio > 0.0:
        return badge_html(f"{prefix}{used} / {max_val}", "#065f46", "#6ee7b7")
    else:
        return badge_html(f"{prefix}0 / {max_val} (Dispo)", "#1e293b", "#94a3b8")

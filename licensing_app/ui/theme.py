"""
Theme for Licensing for MobiPOS: stylesheet plus badge rendering helpers.

Badge helpers return HTML fragments so a single QLabel can render a pill
without needing a custom widget per cell.
"""

from PyQt6.QtGui import QColor, QFont

from ..core.models import LicenseStatus

# ----------------------------------------------------------------------
# Palette
# ----------------------------------------------------------------------
BG = "#0B0F19"
SURFACE = "#111827"
SURFACE_ALT = "#1F2937"
BORDER = "#374151"
TEXT = "#F9FAFB"
TEXT_MUTED = "#9CA3AF"
ACCENT = "#3B82F6"

# Status -> (label, background, border, foreground)
STATUS_PALETTE = {
    LicenseStatus.ACTIVE: ("ACTIVE", "#064E3B", "#059669", "#34D399"),
    LicenseStatus.TRIAL: ("TRIAL", "#312E81", "#4F46E5", "#A5B4FC"),
    LicenseStatus.EXPIRED: ("EXPIRED", "#450A0A", "#DC2626", "#FCA5A5"),
    LicenseStatus.UNREGISTERED: ("UNREGISTERED", "#362F0D", "#D97706", "#FCD34D"),
    LicenseStatus.SUSPENDED: ("SUSPENDED", "#27272A", "#52525B", "#A1A1AA"),
    LicenseStatus.REVOKED: ("REVOKED", "#18181B", "#52525B", "#A1A1AA"),
    LicenseStatus.PENDING_SYNC: ("PENDING", "#362F0D", "#D97706", "#FCD34D"),
}

STATUS_ICON = {
    LicenseStatus.ACTIVE: "🟢",
    LicenseStatus.TRIAL: "⏳",
    LicenseStatus.EXPIRED: "🔴",
    LicenseStatus.UNREGISTERED: "🟠",
    LicenseStatus.SUSPENDED: "⏸️",
    LicenseStatus.REVOKED: "🚫",
    LicenseStatus.PENDING_SYNC: "⏳",
}


def status_badge(status) -> str:
    """Render a status pill. Accepts a LicenseStatus or a raw string."""
    if not isinstance(status, LicenseStatus):
        status = _coerce_status(status)
    label, bg, border, fg = STATUS_PALETTE[status]
    return _pill(f"{STATUS_ICON[status]} {label}", bg, fg, border)


def _coerce_status(raw: str) -> LicenseStatus:
    value = (raw or "").strip().lower()
    for member in LicenseStatus:
        if member.value == value:
            return member
    return LicenseStatus.ACTIVE


def formula_badge(formula: str) -> str:
    f = (formula or "").upper()
    if f in ("LIFETIME", "LIFE"):
        return _pill("✨ LIFETIME", "#064e3b", "#6ee7b7")
    if f in ("90D", "3_MONTHS"):
        return _pill("📅 90 JOURS", "#1e3a8a", "#93c5fd")
    if f in ("24H", "DEMO", "1_DAY"):
        return _pill("⚡ DÉMO 24H", "#713f12", "#fde047")
    if f in ("30D", "1_MONTH"):
        return _pill("📅 30 JOURS", "#1e3a8a", "#93c5fd")
    if f in ("1Y", "YEARLY"):
        return _pill("🗓️ 1 AN", "#312e81", "#c7d2fe")
    return _pill(f or "—", "#312e81", "#c7d2fe")


def seats_badge(used: int, max_val: int, icon: str = "") -> str:
    prefix = f"{icon} " if icon else ""
    ratio = used / max(1, max_val)
    if ratio >= 1.0:
        return _pill(f"{prefix}{used}/{max_val} PLEIN", "#7f1d1d", "#fca5a5")
    if used > 0:
        return _pill(f"{prefix}{used}/{max_val}", "#065f46", "#6ee7b7")
    return _pill(f"{prefix}0/{max_val}", "#1e293b", "#94a3b8")


def expiry_badge(days_left) -> str:
    """Render days remaining, or a lifetime marker when undated."""
    if days_left is None:
        return _pill("♾ ILLIMITÉ", "#1e293b", "#94a3b8")
    if days_left < 0:
        return _pill(f"🔴 EXPIRÉ (-{abs(days_left)}j)", "#7f1d1d", "#fca5a5")
    if days_left <= 10:
        return _pill(f"🟡 {days_left}j", "#713f12", "#fde047")
    return _pill(f"🟢 {days_left}j", "#065f46", "#6ee7b7")


def _pill(text: str, bg: str, fg: str, border: str = "") -> str:
    border_css = f"border:1px solid {border};" if border else ""
    return (
        f'<span style="background-color:{bg}; color:{fg}; {border_css}'
        f"padding:3px 9px; border-radius:5px; font-weight:700; font-size:11px;\">"
        f"{_escape(text)}</span>"
    )


# ---------------------------------------------------------------------------
# Plain-text labels
#
# The *_badge() helpers above emit HTML for QLabel, where Qt renders rich text
# properly. A QTableView model must not return markup: the view paints
# DisplayRole verbatim, so the tags would appear as literal text. These
# functions return the bare label; BadgeDelegate draws the pill itself using
# the matching *_palette() colors.
# ---------------------------------------------------------------------------


def status_label(status) -> str:
    """Bare status label, e.g. 'ACTIVE'. No markup."""
    if not isinstance(status, LicenseStatus):
        status = _coerce_status(status)
    label, _bg, _border, _fg = STATUS_PALETTE[status]
    return label


def status_palette(status) -> tuple:
    """(background, border, foreground) for a status pill."""
    if not isinstance(status, LicenseStatus):
        status = _coerce_status(status)
    _label, bg, border, fg = STATUS_PALETTE[status]
    return bg, border, fg


_FORMULA_LABELS = {
    "LIFETIME": ("LIFETIME", "#1E1B4B", "#4338CA", "#C7D2FE"),
    "LIFE": ("LIFETIME", "#1E1B4B", "#4338CA", "#C7D2FE"),
    "90D": ("90 JOURS", "#1E3A8A", "#1D4ED8", "#93C5FD"),
    "3_MONTHS": ("90 JOURS", "#1E3A8A", "#1D4ED8", "#93C5FD"),
    "TRIAL_90D": ("90 JOURS", "#1E3A8A", "#1D4ED8", "#93C5FD"),
    "24H": ("DÉMO 24H", "#713F12", "#B45309", "#FDE047"),
    "DEMO": ("DÉMO 24H", "#713F12", "#B45309", "#FDE047"),
    "1_DAY": ("DÉMO 24H", "#713F12", "#B45309", "#FDE047"),
    "30D": ("30 JOURS", "#1E3A8A", "#1D4ED8", "#93C5FD"),
    "1_MONTH": ("30 JOURS", "#1E3A8A", "#1D4ED8", "#93C5FD"),
    "TRIAL_30D": ("30 JOURS", "#1E3A8A", "#1D4ED8", "#93C5FD"),
    "1Y": ("1 AN", "#312E81", "#4338CA", "#C7D2FE"),
    "YEARLY": ("1 AN", "#312E81", "#4338CA", "#C7D2FE"),
    "ANNUAL": ("1 AN", "#312E81", "#4338CA", "#C7D2FE"),
}

_FORMULA_FALLBACK = ("—", "#312E81", "#4338CA", "#C7D2FE")


def _formula_entry(formula: str) -> tuple:
    return _FORMULA_LABELS.get((formula or "").upper(), _FORMULA_FALLBACK)


def formula_label(formula: str) -> str:
    """Bare formula label. No markup."""
    return _formula_entry(formula)[0]


def formula_palette(formula: str) -> tuple:
    """(background, border, foreground) for a formula pill."""
    _label, bg, border, fg = _formula_entry(formula)
    return bg, border, fg


def seats_label(used: int, max_val: int) -> str:
    """Bare seat count, e.g. '3/5'."""
    return f"{used}/{max(1, max_val)}"


def expiry_label(days_left) -> str:
    """Bare expiry label, or 'ILLIMITÉ' when undated. No markup."""
    if days_left is None:
        return "ILLIMITÉ"
    if days_left < 0:
        return f"EXPIRÉ (-{abs(days_left)}j)"
    return f"{days_left}j"


def expiry_palette(days_left) -> tuple:
    """(background, border, foreground) for an expiry pill."""
    if days_left is None:
        return "#1E293B", "#334155", "#94A3B8"
    if days_left < 0:
        return "#7F1D1D", "#DC2626", "#FCA5A5"
    if days_left <= 10:
        return "#713F12", "#B45309", "#FDE047"
    return "#065F46", "#047857", "#6EE7B7"



def _escape(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def placeholder_swatch(color: str) -> QColor:
    return QColor(color)


def mono_font(size: int = 10) -> QFont:
    return QFont("Consolas", size, QFont.Weight.Bold)


def ui_font(size: int = 10, bold: bool = False) -> QFont:
    return QFont("Segoe UI", size, QFont.Weight.Bold if bold else QFont.Weight.Normal)


# ----------------------------------------------------------------------
# Stylesheet
# ----------------------------------------------------------------------
THEME_QSS = """
QWidget {
    background-color: #0b0f19;
    color: #f3f4f6;
    font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
    font-size: 13px;
    selection-background-color: #10b981;
    selection-color: #ffffff;
}
QMainWindow { background-color: #0b0f19; }

QFrame#HeaderCard {
    background-color: #131b2e;
    border: 1px solid #1f293d;
    border-radius: 12px;
}
QFrame#MetricCard {
    background-color: #131b2e;
    border: 1px solid #1f293d;
    border-radius: 12px;
}
QFrame#MetricCard:hover { border: 1px solid #374151; }
QFrame#ToolbarCard {
    background-color: #111827;
    border: 1px solid #1f2937;
    border-radius: 10px;
}
QFrame#DetailsCard {
    background-color: #131b2e;
    border: 1px solid #1f293d;
    border-radius: 12px;
}

QLabel#AppTitle { font-size: 19px; font-weight: 700; color: #ffffff; }
QLabel#AppSubtitle { font-size: 11px; color: #9ca3af; }
QLabel#MetricValue { font-size: 26px; font-weight: 700; color: #ffffff; }
QLabel#MetricLabel {
    font-size: 11px; font-weight: 700; color: #9ca3af; letter-spacing: 0.8px;
}
QLabel#SectionHeader { font-size: 15px; font-weight: 700; color: #e5e7eb; }
QLabel#Muted { color: #94a3b8; font-size: 11px; }
/* Standing degraded-mode marker (e.g. unconfigured secrets). Amber on a dark
   pill so it reads as a persistent condition, not a transient toast. */
QLabel#WarningPill {
    color: #fcd34d;
    background: rgba(245, 158, 11, 0.14);
    border: 1px solid rgba(245, 158, 11, 0.45);
    border-radius: 9px;
    padding: 2px 10px;
    font-size: 11px;
    font-weight: 600;
}
QLabel#DetailTitle { font-size: 14px; font-weight: 800; color: #ffffff; }

QPushButton {
    background-color: #1f293d;
    color: #f9fafb;
    border: 1px solid #374151;
    border-radius: 6px;
    padding: 7px 14px;
    font-weight: 600;
    min-height: 18px;
}
QPushButton:hover { background-color: #28354f; border-color: #4b5563; }
QPushButton:pressed { background-color: #0f172a; }
QPushButton:disabled { background-color: #111827; color: #4b5563; border-color: #1f2937; }

QPushButton#PrimaryBtn {
    background-color: #059669; color: #ffffff;
    border: 1px solid #10b981; font-weight: 700; padding: 8px 18px;
}
QPushButton#PrimaryBtn:hover { background-color: #10b981; border-color: #34d399; }
QPushButton#PrimaryBtn:pressed { background-color: #047857; }
QPushButton#PrimaryBtn:disabled { background-color: #065f46; color: #6ee7b7; }

QPushButton#SecondaryBtn {
    background-color: #2563eb; color: #ffffff; border: 1px solid #3b82f6;
}
QPushButton#SecondaryBtn:hover { background-color: #3b82f6; border-color: #60a5fa; }

QPushButton#DangerBtn { background-color: #991b1b; color: #fee2e2; border: 1px solid #dc2626; }
QPushButton#DangerBtn:hover { background-color: #dc2626; color: #ffffff; }

QPushButton#WhatsAppBtn { background-color: #15803d; color: #ffffff; border: 1px solid #22c55e; }
QPushButton#WhatsAppBtn:hover { background-color: #22c55e; }

QPushButton#TableBtn {
    padding: 4px 8px; font-size: 11px; font-weight: 600;
    border-radius: 4px; min-height: 14px;
}

QPushButton#FilterPill {
    background-color: #0f172a;
    color: #94a3b8;
    border: 1px solid #1f2937;
    border-radius: 14px;
    padding: 5px 14px;
    font-size: 11px;
    font-weight: 700;
}
QPushButton#FilterPill:hover { color: #e2e8f0; border-color: #334155; }
QPushButton#FilterPillActive {
    background-color: #064e3b;
    color: #6ee7b7;
    border: 1px solid #059669;
    border-radius: 14px;
    padding: 5px 14px;
    font-size: 11px;
    font-weight: 700;
}

QLineEdit {
    background-color: #111827;
    border: 1px solid #374151;
    border-radius: 6px;
    padding: 6px 12px;
    color: #f9fafb;
}
QLineEdit:focus { border: 1px solid #10b981; background-color: #131b2e; }

QTextEdit, QPlainTextEdit {
    background-color: #0d121f;
    border: 1px solid #374151;
    border-radius: 6px;
    padding: 8px;
    color: #e2e8f0;
    font-family: "Consolas", "Cascadia Code", "Courier New", monospace;
    font-size: 12px;
}

QComboBox {
    background-color: #111827;
    border: 1px solid #374151;
    border-radius: 6px;
    padding: 6px 12px;
    color: #f9fafb;
    min-width: 120px;
}
QComboBox:focus { border: 1px solid #10b981; }
QComboBox::drop-down { subcontrol-origin: padding; subcontrol-position: top right; width: 24px; border-left: none; }
QComboBox QAbstractItemView {
    background-color: #131b2e;
    border: 1px solid #374151;
    selection-background-color: #10b981;
    selection-color: #ffffff;
    color: #f3f4f6;
    padding: 4px;
}

QSpinBox {
    background-color: #111827;
    border: 1px solid #374151;
    border-radius: 6px;
    padding: 6px 10px;
    color: #f9fafb;
}
QSpinBox:focus { border: 1px solid #10b981; }

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
QTableWidget::item { padding: 6px 10px; border-bottom: 1px solid #182235; }
QTableWidget::item:selected { background-color: #1e2d4d; }

QHeaderView::section {
    background-color: #131b2e;
    color: #9ca3af;
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 0.6px;
    padding: 9px 10px;
    border: none;
    border-bottom: 2px solid #1f293d;
}

QScrollBar:vertical { border: none; background: #0b0f19; width: 9px; }
QScrollBar::handle:vertical { background: #374151; min-height: 25px; border-radius: 4px; }
QScrollBar::handle:vertical:hover { background: #4b5563; }
QScrollBar:horizontal { border: none; background: #0b0f19; height: 9px; }
QScrollBar::handle:horizontal { background: #374151; min-width: 25px; border-radius: 4px; }
QScrollBar::handle:horizontal:hover { background: #4b5563; }
QScrollBar::add-line, QScrollBar::sub-line { width: 0px; height: 0px; }
QScrollBar::add-page, QScrollBar::sub-page { background: none; }

QDialog { background-color: #0e1422; border: 1px solid #28354f; border-radius: 10px; }

QStatusBar {
    background-color: #0b0f19;
    border-top: 1px solid #1f293d;
    color: #9ca3af;
    font-size: 11px;
    padding: 4px 10px;
}

QProgressBar {
    background-color: #0f172a;
    border: 1px solid #1f2937;
    border-radius: 6px;
    text-align: center;
    color: #e2e8f0;
    font-size: 11px;
    font-weight: 700;
    height: 16px;
}
QProgressBar::chunk { background-color: #10b981; border-radius: 5px; }
"""

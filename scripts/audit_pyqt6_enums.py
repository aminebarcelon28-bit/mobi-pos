"""
Repository-wide PyQt6 enum audit.

PyQt6 is a binding over Qt6, which renamed or removed a large part of the Qt5
enum surface. The dangerous cases are attribute accesses that only fail at
runtime, on the first mouse move or repaint, long after the code ships -- an
AttributeError raised inside editorEvent() is a crash, not a traceback a test
catches.

Two kinds of check run here:

1. AST-based: full attribute chains such as ``QStyle.ControlType`` are resolved
   from the parsed tree, so a match in a comment or a string literal cannot
   trigger a failure, and a real access cannot hide behind a line break.
2. Call-based: removed Qt5 helpers (``QRegExp``, ``QApplication.desktop``) and
   the Qt5 ``pos()`` accessor on QMouseEvent are matched as calls.

Exit code 0 means clean, 1 means at least one defect.
"""

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCAN_ROOT = ROOT / "licensing_app"

#: Attribute chains that do not exist in PyQt6. Each is the dotted path Qt5
#: used and Qt6 dropped or moved.
FORBIDDEN_ATTRS = {
    "QStyle.ControlType": "Qt5 shape; Qt6 uses ControlType via QStyle.ControlType only on some builds and never SP_* members",
    "QStyle.SP_MouseButtonRelease": "mouse events are QEvent.Type, not QStyle SP_* constants",
    "QStyle.SP_MouseMove": "mouse events are QEvent.Type, not QStyle SP_* constants",
    "QStyle.SP_MouseButtonPress": "mouse events are QEvent.Type, not QStyle SP_* constants",
    "Qt.ItemDataRole.TextFormatRole": "not exposed by PyQt6; use Qt.ItemDataRole.UserRole + 17",
    "QFontMetrics.width": "removed in Qt6; use horizontalAdvance()",
    "QMouseEvent.pos": "removed in Qt6; use event.position()",
    "QApplication.desktop": "removed; use QApplication.primaryScreen()",
    "QRegExp": "Qt5 class removed; use QRegularExpression",
}

#: Bare call names that are Qt5-only.
FORBIDDEN_CALLS = {
    "QRegExp",
}


def _attr_chain(node: ast.AST) -> str:
    """Render an Attribute/Name chain back to dotted text."""
    parts = []
    current = node
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        parts.append(current.id)
    return ".".join(reversed(parts))


def scan_file(path: Path) -> list:
    """Return a list of (line, column, message) defects for one file."""
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
    except (OSError, SyntaxError) as exc:
        return [(0, 0, f"could not parse: {exc}")]

    defects = []

    for node in ast.walk(tree):
        # QStyle.ControlType.SP_MouseButtonRelease and friends. The longest
        # matching prefix is reported so a nested chain is not double-counted
        # once as itself and again as its parent attribute.
        if isinstance(node, ast.Attribute):
            chain = _attr_chain(node)
            best = None
            for banned, reason in FORBIDDEN_ATTRS.items():
                if chain == banned or chain.startswith(banned + "."):
                    if best is None or len(banned) > len(best[0]):
                        best = (banned, reason)
            if best is not None:
                defects.append(
                    (node.lineno, node.col_offset, f"{chain!r} -- {best[1]}")
                )

        # QRegExp(...) and friends.
        if isinstance(node, ast.Call):
            name = _attr_chain(node.func)
            if name in FORBIDDEN_CALLS:
                defects.append(
                    (node.lineno, node.col_offset, f"{name}() -- Qt5 API removed in Qt6")
                )

        # event.pos().x() / event.pos().y(): QMouseEvent.pos() was removed in
        # Qt6 in favour of position(). Matched as a chain rather than banning
        # pos() outright, because QWidget.pos() is a valid Qt6 method.
        if (
            isinstance(node, ast.Attribute)
            and node.attr in ("x", "y")
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Attribute)
            and node.value.func.attr == "pos"
            and not node.value.args
        ):
            defects.append(
                (
                    node.lineno,
                    node.col_offset,
                    f".pos().{node.attr}() -- QMouseEvent.pos() was removed in Qt6; "
                    "use event.position().toPoint()",
                )
            )

    # Stable de-duplication: one report per (line, column).
    seen = set()
    unique = []
    for line, col, message in defects:
        key = (line, col)
        if key in seen:
            continue
        seen.add(key)
        unique.append((line, col, message))
    return unique


def scan_files() -> int:
    if not SCAN_ROOT.is_dir():
        print(f"[FAIL] Scan root not found: {SCAN_ROOT}")
        return 1

    files = sorted(SCAN_ROOT.rglob("*.py"))
    total = 0

    for path in files:
        for line, col, message in scan_file(path):
            rel = path.relative_to(ROOT.parent)
            print(f"[FAIL] {rel}:{line}:{col} {message}")
            total += 1

    if total:
        print(f"\n[FAIL] PyQt6 enum audit found {total} defect(s).")
        return 1

    print(
        f"[PASS] Repository-wide PyQt6 enum audit clean: 0 defects "
        f"across {len(files)} file(s)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(scan_files())

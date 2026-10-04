"""
Licensing for MobiPOS - application entry point.

Run from source:  python -m licensing_app.app
Frozen build:      dist/Licensing for MobiPOS/Licensing for MobiPOS.exe
"""

import sys


def main() -> int:
    # High-DPI must be configured before QApplication exists.
    from PyQt6.QtCore import Qt
    from PyQt6.QtWidgets import QApplication

    QApplication.setHighDpiScaleFactorRoundingPolicy(
        Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
    )

    from .config import APP_NAME, APP_VERSION, load_env_to_vault
    from .ui.theme import THEME_QSS
    from .ui.main_window import MainWindow

    # Mirror any developer .env secrets into the OS vault before the settings
    # are read, so a developer who configured .env.licensing does not also have
    # to call vault_set() by hand. Never overwrites an existing vault value.
    try:
        load_env_to_vault()
    except Exception:  # noqa: BLE001 - hydration must never block startup
        pass

    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    app.setApplicationDisplayName(APP_NAME)
    app.setApplicationVersion(APP_VERSION)
    app.setOrganizationName("MobiPOS")
    app.setStyleSheet(THEME_QSS)

    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())

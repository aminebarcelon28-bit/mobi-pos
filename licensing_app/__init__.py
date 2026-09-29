"""
Licensing for MobiPOS - standalone desktop application.

Layering:
    config    environment, paths, app identity
    core      licensing domain logic (no Qt imports)
    ui        PyQt6 presentation layer
    app.py    entry point
"""

from .config import APP_NAME, APP_VERSION

__all__ = ["APP_NAME", "APP_VERSION"]

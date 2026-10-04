"""
Deprecated entry point.

The application lives in the ``licensing_app`` package. This module remains so
existing launchers (run_admin.bat, older shortcuts) keep working, but it
emits a DeprecationWarning and will be removed in a future release.
"""

import sys
import warnings

warnings.warn(
    "admin_desktop is deprecated; import licensing_app.app instead.",
    DeprecationWarning,
    stacklevel=2,
)

from licensing_app.app import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())

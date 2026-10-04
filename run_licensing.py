"""
Launcher for the frozen build.

PyInstaller executes the entry script as a top-level module, so relative
imports inside the package are unavailable. This shim uses absolute imports
and is the script referenced by licensing.spec.

Running it directly also works:  python run_licensing.py
"""

import multiprocessing
import sys

from licensing_app.app import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    sys.exit(main())

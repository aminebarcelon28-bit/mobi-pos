"""Live counter smoke test via OS cursor (PyAutoGUI) for mobi-pos Tauri app.

Usage:
  python scripts/smoke_test_gui.py --stage <name> [--dry]

Stages run ONE interaction batch each and save screenshots to
artifacts/smoke/ for review. Steps that commit money are marked LIVE and
only run with --live (default is dry reconfirmation of anchors).

Safety: FAILSAFE=True (top-left corner aborts), PAUSE=0.5.
Hands off mouse/keyboard while running.
"""
import argparse
import os
import sys
import time

import pyautogui

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.5

SHOT = os.path.join("artifacts", "smoke")
os.makedirs(SHOT, exist_ok=True)

WIN_TITLE_PART = "MOBI ACCESSORIES"


def log(msg: str) -> None:
    print(f"[smoke] {msg}", flush=True)


def focus_window() -> None:
    import pygetwindow as gw
    wins = [w for w in gw.getAllWindows() if WIN_TITLE_PART in w.title]
    if not wins:
        raise RuntimeError("mobi-pos window not found")
    w = wins[0]
    w.activate()
    time.sleep(0.6)
    return w


def shot(name: str):
    from PIL import ImageGrab
    p = os.path.join(SHOT, name)
    ImageGrab.grab().save(p)
    log(f"screenshot -> {p}")
    return p


def click(x: int, y: int, label: str = "") -> None:
    log(f"CLICK ({x},{y}) {label}")
    pyautogui.click(x, y)
    time.sleep(1.0)


def type_text(text: str, label: str = "") -> None:
    log(f"TYPE {label or text!r}")
    pyautogui.typewrite(text, interval=0.04)
    time.sleep(0.4)


def press(key: str) -> None:
    log(f"PRESS {key}")
    pyautogui.press(key)
    time.sleep(0.8)


def stage_close_modals() -> None:
    focus_window()
    press("escape")
    time.sleep(0.5)
    press("escape")
    shot("s0_closed.png")


def stage_search(phone_query: str) -> None:
    """Focus catalog search, type query, screenshot results."""
    focus_window()
    # Search bar top-left of catalog pane.
    click(265, 112, "catalog search")
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.2)
    type_text(phone_query, "search query")
    time.sleep(1.2)
    shot("s1_search.png")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True,
                    choices=["close", "search", "tradein_cta"])
    ap.add_argument("--q", default="")
    args = ap.parse_args()
    if args.stage == "close":
        stage_close_modals()
    elif args.stage == "search":
        stage_search(args.q)
    elif args.stage == "tradein_cta":
        focus_window()
        click(200, 157, "Trade-In CTA")
        time.sleep(1.2)
        shot("sX_tradein.png")
    log("STAGE DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())

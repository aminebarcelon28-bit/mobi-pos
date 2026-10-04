"""Single-session live smoke driver for mobi-pos via tauri-driver.

Usage: python scripts/smoke_live.py --stage <unlock|dom|shift> [--pin 202020]

One driver session per process run (each session spawns an app instance).
Stages are idempotent recon-first: every action screenshots afterwards.
"""
import argparse
import sys
import time

sys.path.insert(0, "scripts")
from tauri_wd import WD


def stage_unlock(wd, pin):
    time.sleep(5)
    wd.screenshot("artifacts/smoke/live_lock.png")
    boxes = wd.finds("input")
    print(f"[live] inputs on lock screen: {len(boxes)}")
    if boxes:
        wd.click(boxes[0])
        time.sleep(0.4)
        wd.keys(boxes[0], pin)
        time.sleep(0.8)
    wd.screenshot("artifacts/smoke/live_pin_typed.png")
    # find a Valider/confirm button
    btns = wd.finds("button")
    print(f"[live] buttons: {len(btns)}")
    for b in btns:
        try:
            t = " ".join(str(wd.el_text(b)).split())
        except Exception:
            continue
        if t:
            print(f"  | {t[:80]}")
        if "valid" in t.lower() or "ok" in t.lower() or "connect" in t.lower():
            print(f"[live] clicking candidate: {t[:60]}")
            wd.click(b)
            time.sleep(1.5)
            break
    time.sleep(2)
    wd.screenshot("artifacts/smoke/live_unlocked.png")


def stage_dom(wd):
    print("=== BUTTONS ===")
    for t in wd.texts_of("button", 100):
        s = " ".join(str(t).split())
        if s:
            print(f"  | {s[:90]}")
    print("=== INPUTS (placeholder/type) ===")
    try:
        import requests
        base = wd.base
        for eid in [wd.find("input")] if True else []:
            pass
    except Exception as e:  # noqa: BLE001
        print("input probe:", e)
    wd.screenshot("artifacts/smoke/live_dom.png")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True, choices=["unlock", "dom"])
    ap.add_argument("--pin", default="202020")
    args = ap.parse_args()
    wd = WD.start()
    try:
        if args.stage == "unlock":
            stage_unlock(wd, args.pin)
        elif args.stage == "dom":
            stage_dom(wd)
    finally:
        wd.quit()
    print("STAGE DONE")


if __name__ == "__main__":
    main()

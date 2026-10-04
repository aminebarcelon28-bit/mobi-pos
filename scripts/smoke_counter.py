"""Single-session live counter smoke driver (tauri-driver + WebView2).

Usage: python scripts/smoke_counter.py --stage <shift|s1a|dump> [--float 15000]

Every stage opens its own driver session (fresh app instance on the SAME
mobi_pos.db). Stages are idempotent recon-first: screenshot + DOM dump
before any committing click. Committing stages print DB row counts.
"""
import argparse
import sys
import time

sys.path.insert(0, "scripts")
from tauri_wd import WD

ART = "artifacts/smoke"


def btn_by_text(wd, needle):
    needle = needle.lower()
    for eid in wd.finds("button"):
        try:
            t = " ".join(str(wd.el_text(eid)).split())
        except Exception:
            continue
        if needle in t.lower():
            return eid, t
    return None, None


def dump_controls(wd, tag):
    print(f"--- {tag} buttons ---")
    for t in wd.texts_of("button", 120):
        s = " ".join(str(t).split())
        if s:
            print(f"  | {s[:90]}")
    print(f"--- {tag} inputs ---")
    for eid in wd.finds("input"):
        print(f"  type={wd.attr(eid, 'type')} ph={wd.attr(eid, 'placeholder')} val={wd.attr(eid, 'value')}")


def stage_shift(wd, opening_float):
    time.sleep(7)
    wd.screenshot(f"{ART}/live_boot.png")
    eid, label = btn_by_text(wd, "ouvrir caisse")
    if not eid:
        print("NO OUVRIR CAISSE — dumping controls")
        dump_controls(wd, "boot")
        return False
    print("found:", label)
    wd.jsclick(eid)
    time.sleep(1.5)
    # Direct-amount mode for an exact float.
    eid2, _ = btn_by_text(wd, "montant direct")
    if eid2:
        wd.jsclick(eid2)
        time.sleep(0.8)
    wd.screenshot(f"{ART}/live_shift_modal.png")
    # Direct float input: placeholder contains '20 000'.
    target = None
    for ieid in wd.finds("input"):
        ph = str(wd.attr(ieid, "placeholder") or "")
        tp = str(wd.attr(ieid, "type") or "")
        if tp == "number" and "20" in ph:
            target = ieid
            break
    if not target:
        print("FLOAT INPUT NOT FOUND")
        return False
    wd.clear_type(target, str(opening_float))
    time.sleep(0.5)
    wd.screenshot(f"{ART}/live_shift_filled.png")
    eid3, label3 = btn_by_text(wd, "valider & ouvrir")
    print("submit:", label3)
    if eid3:
        wd.jsclick(eid3)
        time.sleep(2.5)
    wd.screenshot(f"{ART}/live_shift_done.png")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True, choices=["shift"])
    ap.add_argument("--float", type=int, default=15000)
    args = ap.parse_args()
    wd = WD.start()
    try:
        if args.stage == "shift":
            ok = stage_shift(wd, args.float)
            print("SHIFT RESULT:", ok)
    finally:
        wd.quit()
    print("STAGE DONE")


if __name__ == "__main__":
    main()

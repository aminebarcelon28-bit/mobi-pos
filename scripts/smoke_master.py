"""Master single-session runner: unlock -> wait catalog -> open shift 15000.

Usage: python scripts/smoke_master.py [--float 15000]
Prints state markers; screenshots each phase. NO money movement.
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


def unlock(wd, pin="202020"):
    time.sleep(6)
    for eid in wd.finds("input"):
        if (wd.attr(eid, "type") or "") == "password":
            try:
                wd.click(eid)
            except Exception:
                pass
            wd.keys(eid, pin)
            time.sleep(1.0)
            break
    eid, label = btn_by_text(wd, "valid")
    if eid:
        try:
            wd.click(eid)
        except Exception:
            wd.jsclick(eid)
        time.sleep(2.5)
    wd.screenshot(f"{ART}/m_unlocked.png")


def wait_catalog(wd, timeout=60):
    """Poll the 'Tous les produits N' pill until N > 0."""
    import re
    t0 = time.time()
    while time.time() - t0 < timeout:
        for t in wd.texts_of("button", 30) + wd.texts_of("span", 60):
            s = " ".join(str(t).split())
            m = re.search(r"[Tt]ous les produits\s+(\d+)", s)
            if m and int(m.group(1)) > 0:
                print(f"[master] catalog loaded: {m.group(1)} products")
                return True
        time.sleep(2)
    print("[master] catalog still empty after timeout")
    return False


def open_shift(wd, opening_float):
    eid, label = btn_by_text(wd, "ouvrir caisse")
    if not eid:
        print("[master] no Ouvrir Caisse (shift already open?)")
        return "already?"
    wd.jsclick(eid)
    time.sleep(1.5)
    eid2, _ = btn_by_text(wd, "montant direct")
    if eid2:
        wd.jsclick(eid2)
        time.sleep(0.8)
    target = None
    for ieid in wd.finds("input"):
        ph = str(wd.attr(ieid, "placeholder") or "")
        if (wd.attr(ieid, "type") or "") == "number" and "20" in ph:
            target = ieid
            break
    if not target:
        print("[master] float input missing")
        return False
    wd.clear_type(target, str(opening_float))
    time.sleep(0.6)
    wd.screenshot(f"{ART}/m_shift_filled.png")
    eid3, _ = btn_by_text(wd, "valider & ouvrir")
    if eid3:
        wd.jsclick(eid3)
        time.sleep(3)
    wd.screenshot(f"{ART}/m_shift_done.png")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--float", type=int, default=15000)
    args = ap.parse_args()
    wd = WD.start()
    try:
        unlock(wd)
        ok = wait_catalog(wd)
        wd.screenshot(f"{ART}/m_catalog.png")
        if ok:
            print("SHIFT:", open_shift(wd, args.float))
    finally:
        wd.quit()
    print("MASTER DONE")


if __name__ == "__main__":
    main()

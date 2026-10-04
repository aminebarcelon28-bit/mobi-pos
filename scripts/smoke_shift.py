"""Stage: open shift with 15000 float via real DOM. Single session."""
import sys
import time
sys.path.insert(0, "scripts")
from tauri_wd import WD


def find_button(wd, needle):
    needle = needle.lower()
    for eid in wd.finds("button"):
        try:
            t = " ".join(str(wd.el_text(eid)).split())
        except Exception:
            continue
        if needle in t.lower():
            return eid, t
    return None, None


def main():
    wd = WD.start()
    try:
        time.sleep(7)
        wd.screenshot("artifacts/smoke/live_boot.png")
        eid, label = find_button(wd, "ouvrir caisse")
        print("SHIFT BTN:", label)
        if not eid:
            print("NO OUVRIR CAISSE BUTTON — dumping buttons")
            for t in wd.texts_of("button", 100):
                s = " ".join(str(t).split())
                if s:
                    print("  |", s[:80])
            return
        wd.jsclick(eid)
        time.sleep(1.5)
        wd.screenshot("artifacts/smoke/live_shift_modal.png")
        print("--- modal inputs ---")
        for ieid in wd.finds("input"):
            print("INPUT type=", wd.attr(ieid, "type"), "placeholder=", wd.attr(ieid, "placeholder"))
        print("--- modal buttons ---")
        for t in wd.texts_of("button", 40):
            s = " ".join(str(t).split())
            if s:
                print("  |", s[:80])
    finally:
        wd.quit()
    print("SHIFT STAGE DONE")


if __name__ == "__main__":
    main()

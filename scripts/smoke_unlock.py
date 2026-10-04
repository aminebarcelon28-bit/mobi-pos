"""Stage: unlock via hidden PIN input + Valider. Single session, stays open? No - reports state."""
import sys
import time
sys.path.insert(0, "scripts")
from tauri_wd import WD


def main():
    wd = WD.start()
    try:
        time.sleep(7)
        wd.screenshot("artifacts/smoke/live_lock2.png")
        pwds = [e for e in wd.finds("input")]
        target = None
        for e in pwds:
            if (wd.attr(e, "type") or "") == "password":
                target = e
                break
        print("PWD INPUT:", bool(target))
        if target:
            try:
                wd.click(target)
            except Exception as ex:  # noqa: BLE001
                print("click refused (expected on overlay input):", str(ex)[:100])
            wd.keys(target, "202020")
            time.sleep(1.0)
        wd.screenshot("artifacts/smoke/live_pin_typed.png")
        for eid in wd.finds("button"):
            try:
                t = " ".join(str(wd.el_text(eid)).split())
            except Exception:
                continue
            if "valid" in t.lower():
                print("CLICK:", t[:60])
                try:
                    wd.click(eid)
                except Exception:
                    wd.jsclick(eid)
                time.sleep(1.5)
                break
        time.sleep(2)
        wd.screenshot("artifacts/smoke/live_after_unlock.png")
    finally:
        wd.quit()
    print("UNLOCK STAGE DONE")


if __name__ == "__main__":
    main()

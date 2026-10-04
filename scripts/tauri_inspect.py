"""Inspect lock-screen controls (one session)."""
import sys, time
sys.path.insert(0, "scripts")
from tauri_wd import WD

wd = WD.start()
try:
    time.sleep(5)
    for eid in wd.finds("input"):
        print("INPUT tag=", wd.tag(eid), "type=", wd.attr(eid, "type"),
              "placeholder=", wd.attr(eid, "placeholder"), "id=", wd.attr(eid, "id"),
              "class=", str(wd.attr(eid, "class"))[:80])
    print("--- buttons ---")
    for b in wd.finds("button")[:20]:
        try:
            print("BTN:", " ".join(str(wd.el_text(b)).split())[:70])
        except Exception as e:  # noqa: BLE001
            print("BTN-ERR", str(e)[:80])
finally:
    wd.quit()
print("INSPECT DONE")

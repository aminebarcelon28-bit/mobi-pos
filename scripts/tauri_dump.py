"""Dump inputs + buttons of current app screen."""
import sys, time
sys.path.insert(0, "scripts")
from tauri_wd import WD

wd = WD.start()
time.sleep(4)
for css in ["input", "button"]:
    print(f"=== {css} ===")
    for t in wd.texts_of(css, 60):
        s = " ".join(str(t).split())
        if s:
            print(f"  | {s[:100]}")
wd.screenshot("artifacts/smoke/wd_dump.png")
# keep session open: print session id for reuse is not supported; quit
wd.quit()
print("DUMP DONE")

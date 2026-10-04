"""Probe: launch app via driver, dump title + buttons, screenshot."""
import sys, time
sys.path.insert(0, "scripts")
from tauri_wd import WD

wd = WD.start()
print("TITLE:", wd.title())
time.sleep(6)  # boot + hydration
wd.screenshot("artifacts/smoke/wd_boot.png")
btns = wd.texts_of("button", 80)
print(f"=== BUTTONS ({len(btns)}) ===")
for b in btns[:80]:
    t = " ".join(str(b).split())
    if t:
        print(f"  | {t[:90]}")
wd.quit()
print("PROBE DONE")

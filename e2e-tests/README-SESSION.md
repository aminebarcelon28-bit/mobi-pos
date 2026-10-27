# Session helper — one way in, both platforms

`lib/session.mjs` is the **only** place that knows how to get the app from a
cold start to an authenticated, usable till. Do not re-implement setup/login in
a spec.

## Credentials

| Field | Value | Notes |
|---|---|---|
| Manager name | `E2E Gerant` | Owner types `20` by hand; the harness uses this longer name. |
| Manager PIN | `202020` | 6 digits. Override with `POS_E2E_PIN`. |
| PIN rule | 6–8 digits (current source) | `src/App.tsx:511` "PIN gérant (6 chiffres minimum)", `maxLength={8}`. |
| PIN rule (older APK) | **4 digits** | The emulator APK predates the 6-digit rule and shows "PIN GÉRANT (4 CHIFFRES)". The helper reads the on-screen label and picks a PIN of the accepted length. |

Owner shorthand `"20, 20, 20"` = name `20`, PIN `202020`. The **PIN matches**;
only the **name** differs (`E2E Gerant` vs `20`). A 4-digit PIN such as `1234`
is rejected by the current build — that is what silently broke the Batch 26
Android attempt (`mobile/tmp-rebuild3.mjs` typed `1234`).

## Desktop

```js
import { ensureDesktopSession, resetDesktopSession } from '../lib/session.mjs';

await ensureDesktopSession();      // setup gate OR lock gate -> dashboard
await resetDesktopSession();       // wipe sandbox; next call exercises setup
```

`ensureDesktopSession()` delegates to `unlockIfNeeded()` in `lib/pos.ts`:
detects `setup` | `lock` | `dashboard`, fills name + PIN + confirm on setup,
then enters the PIN on the lock screen. Reset = wipe the sandbox
(`POS_E2E_WIPE=1` or `resetDesktopSession()`).

## Android

```js
import { ensureMobileSession, dismissMobileOverlays } from '../lib/session.mjs';

await ensureMobileSession();   // adb root + full-state restore + overlays dismissed
```

Three things are required and all three are now in the helper:

1. **`adb root`** — the restore rewrites `/data/data/<pkg>/` (app_webview,
   shared_prefs, files, DB). As the shell user every write is *Permission
   denied*; without root the restore silently leaves the old state.
2. **Full-state restore** (`resetApp()` → `restoreState()` from
   `mobile/fixtures/mobile-state.tar.gz`). The manager PIN is **not in SQLite**
   (there is no `managers` table), so a DB-only restore (`pushBaseline`) leaves
   the app at the first-run setup gate.
3. **Overlay dismissal** — after a restore a runtime *camera permission*
   dialog covers the *"Synchronisation Mobile"* pairing wizard. Deny the
   permission, close the wizard, repeat until the till is visible.

If the snapshot is ever missing, `mobileFirstRunSetup()` completes the wizard
from scratch (reading the on-screen digit rule), and `mobileLogin()` unlocks
from the lock screen.

**Device baseline used for every mobile proof** (`emulator-5554`, AVD
`MobiLite`, Android 16, release APK 1.6.8): `Africa/Lagos`, `auto_time=1`,
`auto_time_zone=1`. Experiments that move the clock (e.g. TIM-09) must restore
the zone with `adb shell cmd alarm set-timezone Africa/Lagos` and re-pull the
DB they pushed.

## Resetting to a clean state

| Target | Command |
|---|---|
| Desktop | `POS_E2E_WIPE=1` when running wdio, or `resetDesktopSession()` |
| Android | `ensureMobileSession()` (re-restores the snapshot), or `adb shell pm clear com.mobi.pos` for a true first-run |

## Known limitation (report, do not paper over)

The emulator APK is an **older build** than the repo source: it asks for a
**4-digit** manager PIN, while current source requires **6**. Any mobile
verdict derived from it describes that old build, not HEAD. Rebuild and
reinstall the APK before trusting mobile results.

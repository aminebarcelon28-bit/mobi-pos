# Mobile on-device verification protocol (Phase 4.5 WP6b — UNVERIFIED)

Status: **UNVERIFIED**. No Android/iOS CI exists; the per-OS clock bodies
(`clocks.rs`: Android `CLOCK_BOOTTIME`, iOS `mach_continuous_time`;
`boot_id` from `/proc/sys/kernel/random/boot_id` / `kern.boottime`) and the
file-vault keystore fallback are compiled per-cfg and covered only by
`ManualClock` unit tests on desktop. Run this protocol on-device before
claiming mobile trust.

General setup (both platforms): install the release-signed mobile build on a
test device with a provisioned merchant license; complete first-boot (manager
PIN ≥ 6 digits, one cashier); run one sale + one cash refund so the audit
chain, outbox, and snapshot paths all have content. Keep the device OFFLINE
except where a step says otherwise.

## M1. Monotonic clock across sleep (Android + iOS)

1. Note the wall time shown in-app (drawer/header) and record a sale.
2. Sleep the device 5 minutes (power button, not power-off).
3. Wake, record a second sale.
4. EXPECTED: no clock advisory, no new session forced, both sales keep
   chronological order in the register. (`CLOCK_BOOTTIME` /
   `mach_continuous_time` both advance across sleep; a regression would mean
   the wrong clock got compiled in.)
5. OPTIONAL deeper check: enable airplane mode, set wall time BACK 1 hour
   manually, restart the app.
   EXPECTED: kernel does NOT follow wall back — advisory/clock quarantine
   per policy (`CLOCK_RESET_REQUIRED` only via anchor comparison, never a
   silent follow). Restore automatic time afterwards and re-anchor per the
   time runbook once the endpoint exists (until then: quarantine persists —
   EXPECTED while the endpoint is BLOCKED).

## M2. Reboot / boot-session identity

1. With sales on the device, power OFF fully, wait 30 s, power ON.
2. EXPECTED: clean boot, license state preserved (OPERATIONAL), audit chain
   verifies (`audit_verify` → intact), no TAMPER_SUSPECTED. (`boot_id`
   change + monotonic reset is the EXPECTED reboot signature — it must force
   a new session, never a quarantine.)
3. EXPECTED (file vault): no "keystore degraded" flag beyond the documented
   mobile-weak warning; PIN login works with the same PINs (lockout state
   survived in the vault file).

## M3. Lockout persistence + PIN gates on device

1. Enter a wrong cashier PIN 5 times.
   EXPECTED: 60 s lock with countdown; killing + restarting the app does NOT
   clear it (vault-backed, unlike the web localStorage echo).
2. After expiry, log in with the correct legacy PIN (if the install
   predates rotation).
   EXPECTED: forced-rotation form (no dismiss) before unlock; new PIN
   4 digits (cashier) / 6–8 (manager); unlock completes; old PIN rejected
   afterwards.
3. EXPECTED: at no point is a hash, PIN, or candidate visible in `adb
   logcat` / Xcode console beyond fixed reason strings (same bar as the
   desktop log boundary).

## M4. Low-storage emergency export

1. Fill device storage to < 50 MB free (large video file).
2. Run emergency export (manager PIN).
   EXPECTED: typed `StorageExhausted` BEFORE any output is created (preflight
   first — Phase 3 item 5); no partial staging dir left behind; the failure
   is audit-recorded best-effort.
3. Free 1 GB, re-run export.
   EXPECTED: success; manifest `chain_status` present and MAC-covered;
   export refuses to open while the terminal is REVOKED (deny), and proceeds
   with `integrity_state: tamper/clock` while TAMPER_SUSPECTED /
   CLOCK_RESET_REQUIRED (no unlock, no state change).

## M5. File-vault integrity (mobile-weak, stated)

1. With the app closed, delete the vault file (`.trust_keystore.vault` in
   the app data dir) on a LICENSED device, reopen.
   EXPECTED: fail closed — missing store with prior state quarantines
   (TAMPER_SUSPECTED path), never a silent fresh provision. (Desktop
   OS-keyring equivalent is covered by unit tests; this step proves the
   mobile fallback behaves the same.)
2. Corrupt (do not delete) the vault file (truncate to 0 bytes), reopen.
   EXPECTED: backend-unavailable quarantine, never "fresh install".

## Sign-off

Record per step: device model + OS version, app build id, EXPECTED vs
OBSERVED, log excerpts for any deviation. Any deviation in M1/M2/M5 is a
ship-blocker (trust-clock or keystore integrity); M3/M4 deviations are
ship-blockers for the PIN/export planes respectively. Until signed off,
mobile stays UNVERIFIED and desktop-only trust claims stand.

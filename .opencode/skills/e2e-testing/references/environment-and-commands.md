# Environment and commands

Everything here was executed on the machine below. If a command is not here, it was not
verified - say so instead of inventing one.

## Machine baseline

| Item | Value |
|---|---|
| CPU / RAM | AMD Ryzen 5 8500G, 12 cores, 15.1 GiB |
| OS | Windows 10.0.26300 (win32) |
| Node | v24.18.0 |
| WebdriverIO | 9.32.0 (`npx wdio --version`) |
| tauri-driver | `%USERPROFILE%\.cargo\bin\tauri-driver.exe` |
| msedgedriver | auto-downloaded by `@wdio/tauri-service` (`autoDownloadEdgeDriver: true`) |
| E2E binary | `target-e2e/debug/mobi-pos.exe` (~43 MB) |
| Sandbox | `%TEMP%\opencode\pos-wdio-sandbox` |

The suite is **local only**. Neither `.github/workflows/five-target-ci.yml` nor
`release.yml` mentions `e2e`, `wdio` or `tauri-driver`. There is no CI E2E job to read, and
no CI-only behaviour to reconcile. Do not claim "CI will catch it".

## Sandbox topology (why isolation works)

`e2e-tests/wdio.conf.ts` applies these **at import time, in every process** (launcher and
worker) before the driver or the app can spawn:

| Env var | Value |
|---|---|
| `USERPROFILE` | `{sandbox}\home` |
| `APPDATA` | `{sandbox}\home\AppData\Roaming` |
| `LOCALAPPDATA` | `{sandbox}\home\AppData\Local` |
| `XDG_DATA_HOME` | `{sandbox}\data` |
| `XDG_CONFIG_HOME` | `{sandbox}\config` |
| `POS_WDIO_SANDBOX` | the sandbox root (override) |

`USERPROFILE` is the redirect that actually works. Setting `APPDATA` alone does not move the
DB, because the app resolves its data dir through the Windows known-folder API, which expands
`%USERPROFILE%`. This was established empirically, not from docs.

Resulting paths:

```
DB      {sandbox}\home\AppData\Roaming\com.mobi.pos.e2e\mobi_pos.db
WebView {sandbox}\home\AppData\Local\com.mobi.pos.e2e\EBWebView
Logs    {sandbox}\... (app logs), e2e-tests\test-logs\ (WDIO), e2e-tests\results\ (NDJSON, PNG)
```

Two isolation layers: the directory redirect **and** the e2e identifier `com.mobi.pos.e2e`
(`src-tauri/tauri.e2e.conf.json`). The DB filename stays `mobi_pos.db` - the sql plugin
confines `load` to that exact name; isolation lives in the dir, never the filename. A
different filename is rejected and the app boots degraded.

## Build

```powershell
npm run build:e2e          # node scripts/build-e2e.mjs
```

Runs `tauri build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json`
with `CARGO_TARGET_DIR=<root>/target-e2e`, so `target/debug` is never touched. The `e2e`
feature adds `e2e_*` IPC, the embedded WebDriver server and a cloud seal
(`get_cloud_credentials -> None`, set/delete denied), and enables `withGlobalTauri` so specs
can call `window.__TAURI_INTERNALS__.invoke`.

Release-flavored build for perf work: `$env:POS_E2E_PROFILE='release'; npm run build:e2e`.
That binary lands in `target-e2e/release/`; point `WDIO_E2E_BINARY` at it or leave the
default (debug) alone.

## Commands

| Purpose | Command |
|---|---|
| Kill orphans | `npm run e2e:clean` |
| Build e2e flavor | `npm run build:e2e` |
| Full suite | `npx wdio run e2e-tests/wdio.conf.ts` |
| One spec, clean room | `$env:POS_E2E_WIPE=1; npx wdio run e2e-tests/wdio.conf.ts --spec e2e-tests/specs/<f>.e2e.ts` |
| One spec, keep state | `npx wdio run e2e-tests/wdio.conf.ts --spec e2e-tests/specs/<f>.e2e.ts` |
| Smoke only | `--spec e2e-tests/specs/00-harness-smoke.e2e.ts` |
| Read the live DB | `node e2e-tests/tools/sql.mjs "SELECT ..."` / `--tables` |
| Rebuild the coverage dashboard (batch only) | `node e2e-tests/tools/coverage.mjs --batch <tag>` - rewrites `COVERAGE.md` from `CASE_INDEX.csv` (single verdict source) and refuses without `--batch`. For checks use `scripts/reconcile.mjs`. |
| Deterministic module check | `node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types e2e-tests/tools/<name>.mts` |
| Sync gateway loopback proof | `npm run test:sync-e2e` |
| Rebuild a canonical batch log | `node e2e-tests/tools/build-27b-log.mjs` (one per batch) |
| Preflight (desktop) | `node .opencode/skills/e2e-testing/scripts/preflight.mjs` |
| Preflight (mobile) | `node .opencode/skills/e2e-testing/scripts/preflight.mjs --mobile` |
| Risk map for a change | `node .../scripts/risk-map.mjs` (or `--files a.ts,b.ts`) |
| Run specs + sidecar | `node .../scripts/run.mjs --spec <f> --wipe --tag <name>` |
| Extract verdicts | `node .../scripts/verdicts.mjs --run e2e-tests/results/runs/<stamp>-<tag>.json` |
| Delta vs the baseline | `node .../scripts/delta.mjs --results <verdicts.json> --scope spec=<f>` |
| Lint the spec/index contract | `node .../scripts/lint-specs.mjs` |
| Prove a fix (red before, 3/3 green) | `node .../scripts/prove-fix.mjs --case <ID> --spec <f>` |
| Evidence bundle | `node .../scripts/collect-evidence.mjs [--run <sidecar>]` |
| PII scan before sharing a bundle | `node .../scripts/scan-pii.mjs [--path <dir>]` |
| Reconcile verdicts | `node .../scripts/reconcile.mjs` (add `--close` for the evidence bar) |
| Self-test the scripts | `node .../scripts/selftest.mjs` (`--filter`, `--verbose`) |

The script-to-gate table is in `SKILL.md`; this table is the command line for each.

`npm run test:e2e` now points at the maintained config (`wdio run e2e-tests/wdio.conf.ts`); the
legacy root `wdio.conf.ts` and the `test:hello` / `test:smoke` / `test:money:e2e` scripts were
deleted on 2026-10-27 so no session can run the old harness by accident. Prefer the `npx` form
above when you want one spec.

## Run artifacts

Every run produces these. Read them in this order; the first one that answers the question ends
the investigation.

| Artifact | Path | What it answers |
|---|---|---|
| WDIO log | `e2e-tests/test-logs/<spec>-0-0.log` (`outputDir` at `wdio.conf.ts:259`) | what the app and the driver logged at the moment of failure |
| Run log | `e2e-tests/results/runs/<stamp>-<tag>.log` | the same stream as `run.mjs` saw it, including the build step |
| Per-test NDJSON | `e2e-tests/results/events.ndjson` (`wdio.conf.ts:346`) | last state per test, duration, error message |
| Screenshots | `e2e-tests/results/*.png` | dialog/overlay state when a click "did nothing" |
| Run sidecar | `e2e-tests/results/runs/<stamp>-<tag>.json` | specs, git SHA, exit code, summed counts, `caseVerdicts` |
| Evidence bundle | `e2e-tests/results/evidence/<stamp>/report.md` | failures + the last 40 log lines before each |
| Invariant events | `e2e-tests/results/invariant-events.ndjson` | violations from `lib/invariants.ts`, once each |

No video and no WebDriver trace recording is configured. If these cannot answer the question, add
a `console.log` with the case ID and re-run - do not infer the cause from a screenshot.

`collect-evidence.mjs` prints `NO TESTS EXECUTED` when the exit code is non-zero and no test body
ran: that is infrastructure, never a case verdict. `scan-pii.mjs` masks what it finds (phone
numbers, non-loopback IPs, PIN/password hashes, `device_id` values and bare UUIDs) and must exit 0
before a bundle is attached to a report or shared.

## `.gitignore` split (proposed, not applied)

Today's rules ignore `e2e-tests/results/`, `test-logs/`, `logs/`, `TEST_EVIDENCE/` and `long/`,
plus **every** `e2e-tests/**/*.png` and `e2e-tests/**/*.ndjson` (`.gitignore:102-114`). Two of
those are too wide and one is too narrow:

| Rule today | Problem | Proposed |
|---|---|---|
| `e2e-tests/logs/` ignored | the canonical per-batch verdict logs (`VERDICT=` lines) live there and are reviewable evidence, not output | track `e2e-tests/logs/*.md`, ignore `e2e-tests/logs/tmp*` |
| `e2e-tests/**/*.png` | hides a committed diagram or fixture image anywhere in the tree | `e2e-tests/results/**/*.png` |
| `e2e-tests/**/*.ndjson` | hides a fixture a spec might need | `e2e-tests/results/**/*.ndjson` |
| `e2e-tests/results/`, `test-logs/`, `TEST_EVIDENCE/`, `long/` | correct - pure run output | unchanged |

Specs, `CASE_INDEX.csv`, `COVERAGE.md`, `FAIL-CLUSTERS.csv`, `fixtures/`, `tools/`, `lib/`,
`mobile/*.mjs` and `wdio.conf.ts` are source and stay tracked (155 files today). The change needs
an owner sign-off because it would newly track files that were previously ignored - do not apply it
unilaterally.

## Environment variables

| Var | Effect |
|---|---|
| `POS_E2E_WIPE=1` | delete the e2e data dir + WebView dir before the run. App must be stopped. |
| `POS_WDIO_SANDBOX` | sandbox root override (used to run two isolated sandboxes side by side) |
| `WDIO_E2E_BINARY` | alternative binary path (relative to repo root) |
| `WDIO_TAURI_DRIVER` | alternative tauri-driver path |
| `WDIO_MOCHA_TIMEOUT` | per-test timeout, default `300000` ms. Scale specs need more. |
| `WDIO_LOG_LEVEL` | WDIO log level, default `info` |
| `POS_E2E_PIN` | overrides the manager fixture PIN |
| `POS_DB` | DB path for `tools/sql.mjs` |
| `POS_E2E_PROFILE=release` | release-flavored e2e build |
| `ALLOW_TEST_KEY=1` | permits the fixed test seeds in the loopback gateway verifier - test only, never a default |
| `ADB` | adb path for the mobile harness (default `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`) |

## Credentials and test accounts

The fixture manager account is created by `e2e-tests/lib/session.mjs` (`E2E Gerant`). Its PIN
is read from `POS_E2E_PIN`, defaulting to the value hard-coded in that file. The UI requires
**6-8 digits** for a manager (`maxLength={8}`); a 4-digit PIN makes setup fail silently,
which is exactly what broke the first Android attempt. Cashiers use a 4-digit minimum.

Do not copy PINs, tokens or merchant credentials into specs, logs or this skill. Reference
the env var or the helper.

## Timeouts that matter

| Setting | Value | Consequence |
|---|---|---|
| `mochaOpts.timeout` | 300000 (5 min) | a synchronous 1M-row seed or recompute will blow it |
| `waitforTimeout` | 20000 | implicit element waits |
| `connectionRetryTimeout` / `Count` | 180000 / 2 | session creation |
| service `startTimeout` | 180000 | WebView2 cold start can exceed 60 s; the first `/session` POST otherwise fails with `DevToolsActivePort` |
| `commandTimeout` | 120000 | long IPC calls |

## Mobile / Android

`e2e-tests/mobile/` drives the real APK over adb (package `com.mobi.pos`, activity
`.MainActivity`), screenshots + OCR via `mobile/ocr-boxes.ps1`. `adb root` is required to read
`/data/data/com.mobi.pos/mobi_pos.db`. Baseline DB snapshot:
`mobile/fixtures/mobile-baseline.db`; state tarball `mobile/fixtures/mobile-state.tar.gz`.

**Preflight before any mobile verdict:**

```powershell
node .opencode/skills/e2e-testing/scripts/preflight.mjs --mobile
```

It hard-fails when `adb` is missing, no device/emulator is attached, or the APK is missing or older
than the sources it was built from; it soft-fails when `emulator` is not on `PATH` or no AVD is
installed (only matters if you need to start one). It also reads the APK's `versionName` and
compares it with `tauri.conf.json` / `package.json`: a version mismatch means the mobile verdict
describes a different build. A missing APK is a blocker, not a warning - mobile cannot be reported
as tested without one.

Known limits, all verified:
- The installed baseline APK is 1.6.8 and accepts a **4-digit** PIN while current source
  requires 6. Mobile verdicts produced against that APK describe the old build - re-check
  before quoting them.
- The AVD `MobiLite` (x86_64, Android 16, 1080x2424, 2 GB) currently exits with code 4 on
  launch. Mobile cases that need it are BLOCKED, not FAIL.
- Camera / BT printer / OTG cases need physical hardware. BLOCKED.

## Startup troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `e2e binary not found: ...target-e2e\debug\mobi-pos.exe` | never built, or built to `target/debug` | `npm run build:e2e` |
| `mobi-pos.exe is already running - refusing to start over it` | orphan from a crashed run | `npm run e2e:clean` |
| `DevToolsActivePort` on the first session | WebView2 cold start | re-run; `startTimeout` is already 180 s |
| Live DB never appears | app booted degraded (wrong DB filename, bad overlay) | check `test-logs/manifest.json`, then the first 80 log lines |
| `SQLITE_BUSY` from Node seeding | app holds the WAL | `lib/db.ts` sets `busy_timeout=10000`; keep Node writes short and in `tx()` |
| Clicks "do nothing" | a modal/overlay is up | `listDialogs()`, then `closeDialogs()`; screenshot in `results/*.png` |
| Element found but `isDisplayed()` false | mobile/desktop twin in document order | `shown()` / `shownX()`, not `$()` |
| `__name is not defined` in `execute` | esbuild `keepNames` leaked into a serialized callback | shims are re-installed by `installPageShims` / `clearWebMirrors`; never hand-write a compiled callback |
| Arabic text mangled in a log | PowerShell console encoding | capture buffers in Node and write UTF-8; never `echo` non-ASCII through PowerShell |

## Ports

There are none to configure. `tauri-driver` starts msedgedriver on an ephemeral port and the
app embeds its own WebDriver server. If something is stuck on a port, it is a leftover
process, not a config: `npm run e2e:clean`.

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
| Reconcile verdicts | `node .opencode/skills/e2e-testing/scripts/reconcile.mjs` |

`npm run test:e2e` now points at the maintained config (`wdio run e2e-tests/wdio.conf.ts`); the
legacy root `wdio.conf.ts` and the `test:hello` / `test:smoke` / `test:money:e2e` scripts were
deleted on 2026-10-27 so no session can run the old harness by accident. Prefer the `npx` form
above when you want one spec.

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

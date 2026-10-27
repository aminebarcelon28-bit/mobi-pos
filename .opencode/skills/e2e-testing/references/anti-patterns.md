# Anti-patterns, dead ends and time-wasters

Each row is something that actually cost time on this project. The "do instead" column is the
substitute that worked.

## Harness and tooling

| Anti-pattern | What happened | Do instead |
|---|---|---|
| Piping non-ASCII through PowerShell | Arabic and French strings arrived as `U?U?U?` in logs; verdicts were read off corrupted text | capture the buffer in Node and `fs.writeFileSync(..., 'utf8')`; never `echo` non-ASCII through PowerShell |
| `node -e "..."` with nested quotes | PowerShell rewrote the quotes, the script ran with the wrong regex, silently | write the script to `%TEMP%\opencode\<name>.mjs` and run it |
| Treating `npx tsc --noEmit -p e2e-tests/tsconfig.json` as a gate | fails on a pre-existing `TS5107 moduleResolution=node10`, unrelated to any change | ignore it; the real gate is a green run |
| Skipping preflight because the binary "looks fresh" | a binary that does not embed HEAD makes every green run a lie; mtime alone missed it | `preflight.mjs` hard-fails on sha/freshness, and `wdio.conf.ts` runs it at **import time** (a `SevereServiceError` from `onPrepare` is swallowed by `@wdio/cli` — the run continues) |
| Setting only `APPDATA` to sandbox the app | the DB still opened in the real profile | `USERPROFILE` is the redirect that works; the config already does it |
| Force-killing the app first | a force-kill landing mid-VACUUM tore freelist pages; the snapshot had to be quarantined | graceful close, wait 15 s, then force (`scripts/e2e-clean.mjs`) |
| Running two specs at once | one SQLite file, `maxInstances: 1`; the second run fights the first for the WAL | serialise, or use a second `POS_WDIO_SANDBOX` |
| Committing `e2e-tests/` | hundreds of MB of logs, screenshots and sandbox residue | it stays untracked unless the owner asks |
| Re-running a red test until it goes green | the failure was real and shipped | triage, classify, then fix |

## Assertions and evidence

| Anti-pattern | What happened | Do instead |
|---|---|---|
| PASS because nothing threw | four FAILs in batch 26 had "click did not throw" as their only evidence; unactionable | assert the state: row, bytes, computed total |
| `parseFloat` / `Number` on display money | rounding drift and separator bugs became invisible | `displayedToMinor()` + `BigInt` |
| Re-implementing app logic inside the test | an encoder bug and its mirror-image decoder cancel out; the test passes | execute the shipped module and decode with an **independent** table (see `27b-lbl-checks.mts`) |
| Asserting a screenshot | the dialog looked right while the totals were blank | error trap + state assertion |
| Reading the first match with `$()` | a hidden mobile twin was returned; clicks landed nowhere | `shown()` / `shownX()` |
| `waitForDisplayed()` then `getText()` on a virtualized list | the node was re-created between the two calls | poll the parsed value inside `waitUntil` |
| Only checking one of two outputs | export vs headline drifted for months | assert output A == output B |
| `browser.pause()` / `sleep` | hid the race instead of fixing it; made runs slow | `waitUntil` on state, with a `timeoutMsg` |
| `retries: 1` to "stabilise" | a genuine double-commit race was masked for two batches | retries stay 0; repeat-run to classify |

## Verdicts and bookkeeping

| Anti-pattern | What happened | Do instead |
|---|---|---|
| Faking a BLOCKED case with a stub | a hardware case "passed" against a stub and proved nothing | BLOCKED, with the missing device named |
| N/A for a missing variant of an existing feature | gift receipt / deposit slip were mis-filed as N/A | N/A = capability absent entirely; FAIL = variant missing where the capability exists |
| Counting cases from the brief | the brief said 69 SCL cases; the catalog had 89 | count from `fixtures/cases.json` |
| Hand-editing `COVERAGE.md` numbers | the dashboard stopped matching the index | never edit by hand; `scripts/reconcile.mjs` reads `CASE_INDEX.csv` (the source of truth) and prints the diff |
| Running `coverage.mjs` as a routine check | it rewrites `COVERAGE.md`; outside a batch it just re-stamps whatever verdicts exist | it now refuses without `--batch <tag>`, reads `CASE_INDEX.csv`, and deletes nothing; use `reconcile.mjs` for checks |
| Editing a canonical `logs/part0-*.log` verdict | evidence no longer reproducible | re-run the case, rebuild the log with `build-27X-log.mjs` |
| Treating "a spec exists" as "the case is covered" | `coverage.mjs` counts only `it('[ID] ...')`; probe specs were inflating the picture | check the ID is in the dashboard, and that the run produced a verdict |
| Batch-wide reclassification without re-running | verdicts changed to fit a narrative | reclassify only with a fresh observation, and record the reason |

## Environment assumptions

| Anti-pattern | What happened | Do instead |
|---|---|---|
| Typing a 4-digit manager PIN | setup silently never completed (batch 26 Android attempt) | 6-8 digits for managers; assert the gate advanced |
| Retrying the `MobiLite` AVD | exits code 4 every time | BLOCKED until a real device or a fixed AVD |
| Quoting mobile verdicts from the installed APK | the baseline APK is 1.6.8 (4-digit PIN); current source is 6-digit | re-run against a current build before quoting |
| Assuming a small dev DB represents production | `SELECT *` with no `LIMIT` was fine at 1k rows and fatal at 1M | measure at a fixed, documented fixture size |
| Expecting the harness to intercept IPC bytes | `__TAURI_INTERNALS__.invoke` is non-writable; `armInvokeCounter` reports `wrap-failed` | prove the builder and the call path separately, and say which |
| Reaching for the real cloud / merchant token | the `e2e` feature seals credentials (`get_cloud_credentials -> None`) | use the loopback verifier (`npm run test:sync-e2e`) |
| One giant `browser.execute` loop | WebDriver script-timeout storm under chunked stress | chunk the work with an explicit budget (`cb65393`) |

## Retired

Kept for the record; do not act on these unless the symptom reappears.

| Item | Why retired |
|---|---|
| Probing the "hidden twin" problem with `browser.$$(...)[0]` | replaced by `shown()` in `lib/pos.ts` |
| `node-fetch`-based gateway calls in specs | the loopback gateway uses `node:http`, zero deps |
| Manual `adb pull` of the mobile DB | `mobile/lib/adb.mjs` `pullDb()` does it |

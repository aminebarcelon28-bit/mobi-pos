# Triage playbook

## The first sixty seconds

1. Which gate failed? If the smoke spec never passed, stop - this is ENVIRONMENT, not a feature.
2. Open `e2e-tests/results/runs/<stamp>-<tag>.json` for the exit code and counts.
3. Open `e2e-tests/test-logs/<spec>-0-0.log`, go to the **last** `ERROR` / `✖` block, read
   backwards 40 lines. The app's own log lines are interleaved with the assertion.
4. Query the state the assertion was about:
   `node e2e-tests/tools/sql.mjs "SELECT * FROM transactions ORDER BY rowid DESC LIMIT 3"`.
5. Only then classify. Write the class down before editing anything.

The order matters because the two most expensive mistakes here were (a) fixing the app for a
test bug and (b) fixing the test for an app bug.

## Signature -> cause -> first command

| Signature in the log | Likely cause | First command |
|---|---|---|
| `e2e binary not found: ...target-e2e\debug\mobi-pos.exe` | never built, or built to `target/debug` | `npm run build:e2e` |
| `mobi-pos.exe is already running` | orphan from a crashed run | `npm run e2e:clean` |
| `DevToolsActivePort` on first `/session` | WebView2 cold start, or a wedged driver | re-run once; then `npm run e2e:clean` |
| `live DB never appeared at ...` | app booted degraded (wrong DB filename / overlay) | `cat e2e-tests/test-logs/manifest.json`, then first 80 log lines |
| `Tauri IPC bridge never appeared` | page not loaded yet, or `withGlobalTauri` missing (non-e2e binary) | check `e2e_build_info` in the smoke spec |
| `no displayed element for [data-testid="..."]` | hidden twin, overlay covering it, or the element genuinely absent | `listDialogs()`, screenshot in `results/*.png`, grep the testid in `src/` |
| `Cannot parse money text: "..."` | new format (symbol, spacing, Arabic digits) not handled | add the variant to `displayedToMinor`, then re-run |
| `__name is not defined` | esbuild `keepNames` leaked into a serialized callback | use `installPageShims` / `clearWebMirrors`; never hand-build the callback |
| `SQLITE_BUSY` | app holds the WAL during a long Node write | wrap in `tx()`, keep it short, `busy_timeout` is 10 s |
| `script timeout` | one giant in-page loop | chunk the work with an explicit budget (see `cb65393`) |
| `element click intercepted` | modal/overlay | `closeDialogs()`, then retry once |
| `stale element reference` | list re-rendered between find and click | re-query inside `waitUntil`, do not cache handles |
| `invoke wrap-failed` | `__TAURI_INTERNALS__.invoke` is non-writable in this build | you cannot count IPC calls this way; use the return value or the DB |
| `SYSTEM_CLOCK_REGRESSION` | wall clock behind the monotonic anchor | expected fail-closed behaviour, not a test bug |
| `DEVICE_IDENTITY_SPOOFED` | client-supplied `device_id` mismatched the native identity | correct behaviour; assert the typed code |
| `SUPERVISOR_AUTH_EXPIRED` / `..._FUTURE_DATED` | supervisor token older than 120 s, or future-dated past 30 s | expected; fix the fixture's timestamps |
| `TOO_LARGE` | export above 200 001 rows | intentional cap; assert the code, do not raise it |
| `integrity_check` not `ok` | torn write, usually a force-kill mid-vacuum | quarantine the sandbox, re-run on a wiped one, report the incident |
| test green but the feature is broken | assertion too low on the ladder, or a stale mirror | re-assert on the SQLite row / captured bytes; seed + `clearWebMirrors()` |
| `HARNESS_SCAN_DOUBLE_DISPATCH` (cart exactly 2x, two identical scan events) | **fixed 2026-10-27**; the throw is terminal, never retried. Read the counts in the message: **1 dispatch + 2 events = app bug** (the app handled one scan twice — a money bug: double line, double charge; file it, do not dedupe it in the test). **2 dispatches = harness** (the driver sent the code twice; fix `scanCode()`, never weaken the assertion). | `scanCode()` waits on `pos:barcode-scanned`, falls back only on zero events, and throws with both counts |

## Per-class playbook

### APP BUG

Confirm three things before writing it up: the row/bytes are actually wrong, the input was
valid, and the wrong value is reproducible from a clean sandbox. Then:
`sql.mjs` the row -> grep the writer -> `file:line` -> verdict FAIL with the raw observation
quoted. If you cannot produce a `file:line`, say SOURCE unknown; do not guess a module.

### TEST BUG

Usual suspects, in order: assertion encodes the display string instead of the value; `$()`
picked a hidden twin; the wait polled a value that legitimately lags; the fixture violated a
constraint the app correctly rejects; the test asserted a facet the case never claimed. Fix
the test, re-run 3x, and note in the report that the verdict changed because the test was
wrong - not the app.

### ENVIRONMENT

The smoke spec is the discriminator. If `[HARNESS-01..07]` pass, the environment is fine and
your failure is real. If they fail, do not debug the feature: check binary freshness, orphan
processes, sandbox path, driver path, then rebuild. A degraded boot (wrong DB filename) looks
exactly like a feature bug from the outside.

### FLAKY

Reproduce first: `repeat-run.mjs --times 3` with `--wipe`. If it is 1-2 of 3, treat as APP BUG
(race) until the log proves otherwise. Common real causes here: a wait on a value that is
written asynchronously after the click; a shared fixture mutated by the previous test; a
virtualized list re-rendering under the cursor; a `Date.now()` boundary in the fixture.
Never fix flakiness with `retries`.

### BAD DATA

Symptom: the app refuses an input the spec considered valid. Check the seed row against the
schema and the domain rule (negative stock, zero price, decimal qty, duplicate barcode). If the
app is right, the fixture is wrong - fix the fixture and say so.

### BLOCKED

Precondition absent: no label printer, no second terminal, no gateway, no 1M-row budget, no
72 h wall clock, no low-end device. Name the missing item in the verdict, keep the case text
intact, and do not substitute a weaker assertion.

## Isolation techniques that paid off

| Technique | When |
|---|---|
| `it.only` on the failing case, one spec file | the spec has 40 cases and you need a 20 s loop |
| Copy the sandbox DB before the run, diff after | the failure is "something changed that should not have" |
| `git stash` the app change, re-run the same spec | proves the regression test actually fails pre-fix |
| Run the deterministic half under Node instead of the WebView | the logic is pure and the WebView is slow/noisy (`tools/*.mts` pattern) |
| Boot on a copy of an upgraded-shape DB | migration cases; a fresh DB hides them |
| `POS_WDIO_SANDBOX=<other dir>` | two sandboxes side by side, e.g. before/after a migration |

## What to read, fastest first

| Question | Artifact |
|---|---|
| Did the harness even start? | `test-logs/manifest.json` + first 80 log lines |
| Which assertion failed and with what values? | the `✖` block in `test-logs/<spec>-0-0.log` |
| What did the app log at that moment? | same log, backend/frontend lines around the failure |
| What was the state? | `sql.mjs`, or the seed/fixture file |
| Was it already broken before my change? | `git stash` + re-run, or the same case in `results/events.ndjson` |
| Is it flaky? | `repeat-run.mjs --times 3` |

## Do not

- Do not re-run a failing test hoping it passes. That is how a real bug ships.
- Do not add `retries`, `browser.pause`, or a longer timeout as a first response.
- Do not delete or edit `results/events.ndjson` to make the dashboard look right.
- Do not hand-edit a canonical `logs/part0-27X.log` verdict; re-run the case.
- Do not claim a PASS from a screenshot.
- Do not trust a verdict produced against the old Android APK (1.6.8) for current source.

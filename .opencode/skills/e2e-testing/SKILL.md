---
name: e2e-testing
description: "Mandatory FIRST step for any feature, bug fix, refactor, migration, dependency bump, or test work in MobiPOS - and for anything that smells like QA: writing, running, debugging or reviewing E2E tests, a test that fails or flakes, edge cases, regressions, coverage, verification, 'does this still work?', 'prove it', or shipping a change. Load it before touching code, before running build:e2e/wdio, and before claiming anything is done. It carries the sandbox topology, the exact commands, the selector/wait/money conventions, the bug catalog, the edge-case matrix and the triage table that this repo paid for across 20+ batches of real E2E runs, plus the find -> fix -> re-test loop that makes a green run mean something."
---

# E2E testing (MobiPOS) - operating procedure

This skill is the first thing loaded before any change to this repo. It exists because the same
class of defect kept being found late, by hand, and then re-found in the next batch: money that
rounds differently in two places, receipts whose printed bytes disagree with the screen, mirrors
that go stale after an out-of-band write, a query that is fine at 1k rows and fatal at 1M. It
assumes the real Tauri app driven by WebdriverIO through an external `tauri-driver`, a disposable
SQLite sandbox, and a Node-side oracle reading the same database out-of-band. Every rule traces to
a batch log, a commit, or a `file:line` in this repo.

Two jobs, one procedure: **find the bugs a change introduces** (Gates 1-5) and **prove the fix is a
fix** (Gates 6-7). A green suite after an edit is not evidence of either.

## 0. Non-negotiables

| # | Rule | Why (real cost) |
|---|---|---|
| 1 | Run only against the sandbox. `e2e-tests/wdio.conf.ts` redirects `USERPROFILE`/`APPDATA`/`LOCALAPPDATA` into `%TEMP%\opencode\pos-wdio-sandbox` and the e2e flavor opens `com.mobi.pos.e2e`, never `com.mobi.pos`. A wipe is allowed only when the target's leaf directory is exactly `com.mobi.pos.e2e` and it sits at `<sandbox>/home/AppData/{Roaming,Local}/...` (segment check, not a string prefix). | `POS_E2E_WIPE=1` deletes data dirs. The real till DB lives in the prod identifier. |
| 2 | `POS_E2E_WIPE=1` only with the app stopped. The config throws if `mobi-pos.exe` is running. | A running app holds the DB and the WebView dir; the wipe half-fails and the run starts on mixed state. |
| 3 | The binary under test is `target-e2e/debug/mobi-pos.exe`, built by `npm run build:e2e`. Never `target/debug`. `preflight.mjs` hard-fails unless the binary embeds HEAD (or a commit with no app-source change since) plus the e2e identifier, and `wdio.conf.ts` runs that same check at **import time** - a hook cannot stop a run (`@wdio/cli` logs and swallows `onPrepare` errors). | `target/debug` is the dev flavor: no `e2e` feature, no `e2e_*` IPC, no cloud seal, prod identifier. A stale binary makes green runs lie. |
| 4 | Seed and reset out-of-band with `e2e-tests/lib/db.ts` + `lib/seed.ts` (better-sqlite3 on the live WAL file), then wipe WebView mirrors and reload. `e2e_*` IPC is opportunistic, never the source of truth. | Mirrors are a cache. A seed that only touches the mirror passes the test and loses the data on next boot. |
| 5 | Assert on state: a SQLite row, a captured byte stream, a computed total. "No exception thrown" is not a PASS. | Batch 26 shipped 4 FAILs whose only evidence was "the click did not throw"; they were unactionable. |
| 6 | Money is integer minor units (`BigInt`) parsed from fr-DZ display. Never `parseFloat`, never `Number(text)`. | `1/234/567 DA` (P1-73) and the stacked-discount refund drift (CRT-05) both come from float/format round-trips. |
| 7 | Triage before fixing. Every failure gets a class from the Gate 5 table before a line of app code changes. | Fixing the test to match the bug is the single most expensive mistake in this repo's history. |
| 8 | Never print PASS for a case whose precondition does not exist. Use N/A (absent from the product) or BLOCKED (executable in principle, dependency missing: 1M-in-WebView fixture, gateway, second terminal, device) and name the missing thing. REMAIN means "executable today, not yet run" and must be 0 at batch close. | The N/A and BLOCKED rows exist precisely because faking them was refused; a REMAIN bucket that never empties hides the work. |
| 9 | Never weaken an assertion, a threshold, a gate or an exit code to get green - not by editing the spec, not by widening a tolerance, not by adding `retries`. A failing case is information. | Every "temporarily relaxed" assertion in this repo's history is still relaxed, and still hiding the bug it was relaxed for. |
| 10 | Never hand-edit a verdict number in `CASE_INDEX.csv` or `COVERAGE.md`. Verdicts come from `verdicts.mjs` (a run) and the dashboard is re-derived by `reconcile.mjs`. | Hand-typed numbers drift from the run that produced them, and then the dashboard is fiction. |

## One pipeline, no other way

```
run.mjs  ->  verdicts.mjs  ->  delta.mjs  ->  reconcile.mjs
executes     extracts          compares       accounts
```

- `run.mjs` writes a sidecar with `passing/failing/skipped` **summed across every spec line** plus `caseVerdicts` (id -> verdict) for the cases that reported in its window.
- `verdicts.mjs` turns events + `VERDICT=<ID> <VERDICT>` lines into a verdict map; `--write-index --run <sidecar>` stamps `verdict_run` + `verdict_sha` on the row it moves.
- `delta.mjs` compares a verdict map against `CASE_INDEX.csv`; it **rejects** a run sidecar or a raw `events.ndjson` with exit 2 - extract first.
- `reconcile.mjs` proves the dashboard equals the CSV; `--close` proves each verdict carries the evidence it claims.

## Quick start (first minute)

Run from the repo root, PowerShell:

```powershell
npm run e2e:clean
node .opencode/skills/e2e-testing/scripts/preflight.mjs
node .opencode/skills/e2e-testing/scripts/run.mjs --spec e2e-tests/specs/00-harness-smoke.e2e.ts --wipe --tag smoke
node .opencode/skills/e2e-testing/scripts/verdicts.mjs --run e2e-tests/results/runs/<stamp>-smoke.json
node e2e-tests/tools/sql.mjs --tables
```

Bash/zsh: the same commands; `run.mjs` sets `POS_E2E_WIPE=1` for the child when you pass `--wipe`.
`npm run build:e2e` is mandatory whenever `preflight.mjs` fails provenance; `npm run e2e:clean`
kills orphaned `mobi-pos.exe` / `msedgedriver.exe` / `tauri-driver.exe`.

`node e2e-tests/tools/coverage.mjs` is a **batch-report generator, not a check**: it rewrites
`COVERAGE.md`, reads verdicts from `CASE_INDEX.csv` (the single source of truth), and refuses to
run without `--batch <tag>`. Use `reconcile.mjs` for the dashboard check.

## The gates

Each gate has one exit criterion. Do not enter the next gate with the previous one open.

### Gate 0 - Context and environment

| Step | Command / action |
|---|---|
| Read binding decisions | `AGENTS.md` (storage topology, trust rules, accessibility locator rules). These override anything here that looks contradictory. |
| Know the tree | `git status --short`, `git log --oneline -5`. `e2e-tests/` is tracked; its `results/` and `test-logs/` are not. |
| Kill orphans | `npm run e2e:clean` |
| Preflight (desktop) | `node .opencode/skills/e2e-testing/scripts/preflight.mjs` - binary provenance (must embed HEAD + `com.mobi.pos.e2e`) and freshness (including `Cargo.lock`), driver path, orphan processes, sandbox, node/wdio versions. |
| Preflight (mobile) | `node .opencode/skills/e2e-testing/scripts/preflight.mjs --mobile` - adb present, a device/emulator attached, an AVD listed, and an APK newer than the sources whose `versionName` equals `tauri.conf.json`/`package.json`. A missing APK is a blocker, not a warning. |
| Smoke | `node .opencode/skills/e2e-testing/scripts/run.mjs --spec e2e-tests/specs/00-harness-smoke.e2e.ts --wipe --tag smoke` |

**Exit:** the smoke sidecar carries today's `gitSha` and 7/7 passing. `[HARNESS-07]` is **not** a
tolerated flake: the 2026-10-27 forensics proved the harness double-sent (a synthetic fallback fired
1.2 s after the real burst had decoded; 2 dispatches -> 2 events -> `246800`, one dispatch -> one
event -> `123400` in 6/6 control runs). `lib/pos.ts scanCode()` waits on `pos:barcode-scanned` and
throws `HARNESS_SCAN_DOUBLE_DISPATCH` naming **both** `dispatches` and `events`: `dispatches=2` is
a harness bug, `dispatches=1` is an app money bug. Any HARNESS failure means the harness is broken.

### Gate 1 - Risk brief + risk map

`node .opencode/skills/e2e-testing/scripts/risk-map.mjs` reads the changed app files from git (or
`--files a.ts,b.ts`) and resolves them through `e2e-tests/fixtures/feature-map.json` to features,
domains, cases and the specs that must run. A changed app file that maps to nothing prints
`UNMAPPED` and **exits 1**: a new domain prefix in `CASE_INDEX.csv` plus a feature entry is required
before testing continues, otherwise "the suite is green" says nothing about that file.

Then write the five-line brief (`templates/risk-brief.md`): what changed, domains touched, blast
radius, the riskiest flow, the invariant that would break silently. Minimum specs by domain:

| Change touches | Domains | Minimum specs |
|---|---|---|
| checkout, cart totals, discounts, tax | MNY / CRT / PAY | `10-mny-money`, `11-mny-money-part2`, `71-crt-cart`, `20-pay-payments` |
| refunds, voids, returns | REF / MNY | `30`..`34-ref-refunds`, `10-mny-money` |
| `src-tauri/src/lib.rs`, migrations, schema | DAT / SYN | `20/21/22-dat-data-integrity*`, `00-harness-smoke`, plus a boot on an upgraded-shape DB |
| sync, outbox, `syncDrainWorker`, gateway | SYN | `24-syn-sync`, `npm run test:sync-e2e` |
| receipts, ESC/POS, labels | RCP / LBL | `26-rcp-tim`, `27b-lbl-hw`, node byte harness `tools/27b-lbl-checks.mts` |
| reports, exports, dashboards | RPT | `27d-rpt-checks.mts` + the RPT spec |
| auth, PIN, roles, lockout | SEC / IDN | `50-sec-authorization`, `51-sec-hardening`, `60-idn-identity` |
| shifts, drawer, Z | SHF / DRW | `40-shf-shifts`, `65/66-drw-drawer-*` |
| scale, lists > 10k rows | SCL / PRF | the `23-scl-*` specs and `27e-prf-checks.mts`; measure, do not eyeball |

**Exit:** `risk-map.mjs` exits 0 and the brief names one riskiest flow and one invariant ("stock
decrements exactly once", "export cell equals headline total", "outbox stays contiguous").

### Gate 2 - Test plan (derive the edges, do not invent them)

One row per case, before any code:

| Case ID | Risk (why this one) | Precondition | Pass condition (written before measuring) | Spec file |
|---|---|---|---|---|

Five derivation passes, in this order (recipes in `references/feature-discovery.md`):

| Pass | Derives |
|---|---|
| Input boundaries | empty, 1 char, max length, unicode/emoji, Arabic-Indic digits (`٠١٢٣٤٥٦٧٨٩`), `٫`, FR grouping (`12.500,50`), 3+ decimals, negatives, bidi text. The parsers already normalize some of it (`src/utils/money.ts:97-118`, `src/utils/phoneUtils.ts:25-28`) - a change near them must prove the rest still holds. |
| States x actions | for every state (empty, loaded, modal, locked, offline, mid-sync): the legal action, the illegal action, and the interrupted action (kill, lock, clock jump, network drop) with the expected state afterwards. |
| Invariants | conservation (`collected == committed == stored`), idempotency (same refund twice), two-outputs-equal (receipt bytes vs screen, export cell vs headline). |
| Interactions | the feature against discounts, refunds, shifts, outbox, receipts, reports, AR/FR, mobile. |
| Seeded random walk | `lib/rng.ts` (`makeRng(seed)`) + `lib/invariants.ts` (`assertInvariants`) replay a long mixed session; a violation logs `(seed, step)` so it is reproducible. No walk spec exists yet - writing one is Gate 2 work, and until it exists say so rather than claiming walk coverage. |

Rules: minimum happy path + 2 edges from `references/edge-case-matrix.md` + 1 negative. New case
IDs are registered in `e2e-tests/CASE_INDEX.csv` (id, domain, priority, title, `verdict=REMAIN`,
`spec`) before the first run. Preconditions needing a device, a second terminal, a gateway or a
1M-row fixture are BLOCKED up front with the missing item named. Thresholds are written before
measuring: `PRF-05` was only decidable because "boot < 2 s at 1M customers" was on paper first.

**Exit:** every planned case has an ID, a spec file, and a pass condition a stranger could
evaluate.

### Gate 3 - Write or extend tests

Follow `references/conventions-and-templates.md`. The load-bearing items:

1. `it('[DOMAIN-NN] ...')` - the id regex is `\[[A-Z][A-Z0-9]{1,3}-\d{2,3}\]` (2-3 digit
   suffixes, 1-4 letter domains). A title built from a variable (`it(id, ...)`, the
   `harness('LBL-11', ...)` pattern) is fine only if the id is in the file as code.
2. `data-testid` via `tid('...')`; use `shown()`/`shownX()` because mobile and desktop twins share
   testids and document order is not display order.
3. Wait on state (`waitUntil` over a SQLite count or a cart total), never `sleep`.
4. Money: `cartTotalMinor()` / `displayedToMinor()`, compare as `BigInt`.
5. Seed with `seedProducts` / `seedCustomers` / `seedShift`, then `clearWebMirrors()` and reload.
6. `installErrorTrap()` in `before`, `expectNoUiErrors()` in `after` - an unhandled rejection
   during the flow is a finding even when assertions pass.
7. Every case logs its raw observation with `console.log('[DOMAIN-NN] ...')`, and states its
   verdict in a `VERDICT=<ID> <VERDICT>` line when the verdict is not the mocha outcome (e.g. a
   PASS-PARTIAL).

**Exit:** `node .opencode/skills/e2e-testing/scripts/lint-specs.mjs` exits 0. It proves every
`it()` title carries an id, every id in spec code exists in `CASE_INDEX.csv`, and every active row
is anchored by a spec that mentions it or by a BLOCKED/N/A reason. Baselines live in
`references/lint-exemptions.json` (each with a reason) and are printed as debt; `--strict` ignores
the baseline and must stay red only while that debt exists.

### Gate 4 - Run, extract, delta

1. smoke (Gate 0), 2. the new spec, 3. adjacent specs from the Gate 1 table and the risk map,
4. full suite only when shared code changed (`lib/`, `src/services/`, `src/db/`, `src-tauri/`),
5. delta against the baseline.

```powershell
node .opencode/skills/e2e-testing/scripts/run.mjs --spec e2e-tests/specs/<file>.e2e.ts --wipe --tag <name>
node .opencode/skills/e2e-testing/scripts/verdicts.mjs --run e2e-tests/results/runs/<stamp>-<name>.json
node .opencode/skills/e2e-testing/scripts/delta.mjs --results <verdicts.json> --scope spec=<file>
```

`delta.mjs` prints **regressions / fixes / coverage loss / unchanged / not-run**. Exit 0 means no
regression, no coverage loss (PASS -> BLOCKED/N/A/REMAIN or PASS -> PASS-PARTIAL needs
`--allow-loss <id>` with a reason), and every in-scope baseline case executed (`--scope`). Exit 1
is a verdict problem; exit 2 is bad input or a crash and is never a verdict. A FAIL -> PASS is
flagged as a **suspect fix** when the spec file is also dirty (`--allow-spec-change` to accept).

Artifacts, in reading order (paths in `references/environment-and-commands.md`): the WDIO log,
`results/events.ndjson`, the screenshots, the run sidecar, the evidence bundle. `collect-evidence.mjs`
prints `NO TESTS EXECUTED` when the exit code is non-zero and nothing ran - infrastructure, never a
case verdict. `scan-pii.mjs` must be clean before a bundle leaves the machine (it masks what it
finds). No video or trace recording is configured: if these artifacts cannot answer the question,
add a `console.log` with the case ID and re-run; do not guess.

**Exit:** every run has a sidecar with specs + SHA + duration, no failure is unclassified, and
`delta.mjs` reports zero regressions and zero coverage loss.

### Gate 5 - Triage (never fix before classifying)

| Class | Tell | First check |
|---|---|---|
| APP BUG | state is wrong or missing after a successful flow | read the row: `node e2e-tests/tools/sql.mjs "SELECT ... FROM ..."` |
| TEST BUG | assertion encodes the wrong expectation, or reads a hidden twin | re-read the pass condition; check `isDisplayed()` |
| ENVIRONMENT | harness never came up, DB never appeared, driver died | `preflight.mjs`, first 80 lines of the log, `NO TESTS EXECUTED` in the bundle |
| FLAKY | same spec, same seed, different result | `repeat-run.mjs --times 3` |
| BAD DATA | fixture violates a constraint the app legitimately rejects | inspect the seed row, compare with `lib/seed.ts` |
| BLOCKED | precondition absent (device, gateway, 1M-in-WebView, wall clock) | name it in the verdict; do not weaken the case |

Then write the verdict with its evidence class: DB row, BYTES (captured stream), RUNTIME
(error/tap counts), SOURCE (`file:line`), UI (visible text only - allowed only when the case is
about text). After 27e the split was DB 57 / BYTES 29 / RUNTIME 20 / SOURCE 33 / UI 1. A FAIL with
UI-only evidence is almost always a test bug.

**Exit:** each failure has a class, an artifact or `file:line`, and a verdict.

### Gate 6 - Find -> fix -> re-test (one loop, three attempts, then stop)

For each finding, in order:

1. **Triage** it (Gate 5) and check it against `references/bug-catalog.md` - including the
   **sibling search** column: the same defect usually exists in the sibling code path (cash vs
   card, desktop vs mobile, sale vs refund, screen vs print).
2. **Fix** it inside the authority table below (money arithmetic, migrations/schema, sync protocol,
   auth/PIN and anything that rewrites stored data are **ASK FIRST**).
3. **Rebuild**: `npm run build:e2e` - a stale binary invalidates every later run.
4. **Regression case** in the owning spec, asserting the observation that was wrong.
5. **Adjacent specs** from the Gate 1 table and the risk map, then `delta.mjs --scope spec=<file>`.
6. **Sibling sweep**: apply the catalog's sibling-search recipe and add a case, or record why the
   sibling is provably unaffected.

**Three attempts maximum per finding.** After the third failed attempt: stop, keep the case red, and
report what was tried, what each attempt changed, and the new evidence. Do not loop silently and do
not "fix" the assertion. Existing assertions are **read-only** unless the finding was triaged TEST
BUG with a fresh observation (a re-read log line, a screenshot, a DB row) proving the assertion
itself is wrong - and then the report records it as an assertion change.

**Exit:** every finding is either fixed with a regression case, or reported as open with its
attempt count. No finding is closed by a green run that does not contain its regression case.

### Gate 7 - Prove the fix, then break it on purpose

```powershell
node .opencode/skills/e2e-testing/scripts/prove-fix.mjs --case <ID> --spec e2e-tests/specs/<f>.e2e.ts
node .opencode/skills/e2e-testing/scripts/prove-fix.mjs --case <ID> --spec <f> --finding   # same verdict twice
node .opencode/skills/e2e-testing/scripts/prove-fix.mjs --case <ID> --spec <f> --dry-run    # plan only
```

Fix mode stashes **only the app paths** (`git stash push -- src src-tauri/src ...`; never
`-u`/`--include-untracked`, never `git clean`), builds the pre-fix tree, requires the case to be
**RED** there, restores, rebuilds, and requires **3/3 GREEN**. Finding mode runs the case twice and
exits 0 only when the verdict is the same both times - a verdict that changes is a flake to fix
before triage.

**Mutation check (mandatory for a new feature):** break the feature on purpose (invert the
condition, return the old value, skip the write), rebuild, confirm the new tests go red, then
revert. A new test that stays green under a deliberate break is not testing the feature - fix the
test, not the mutation. Record the mutation and the red result in the report.

**Exit:** red-before/green-after recorded with the SHA, 3/3 green, and the mutation check red as
expected. If a step was impossible (no pre-fix commit, app cannot be rebuilt here), the report says
which step and why - never "assumed proven".

### Gate 8 - Report

Use `templates/bug-report.md` for findings and this verdict vocabulary everywhere:

| Verdict | Means | Evidence bar |
|---|---|---|
| PASS | the asserted facet is correct | state/bytes quoted |
| PASS-PARTIAL | some facets asserted, others not | the unasserted facet is named |
| FAIL | asserted behaviour is wrong or missing | raw observation quoted, plus `file:line` or `SOURCE unknown` |
| N/A | the precondition does not exist in the product | grep/probe count = 0 |
| BLOCKED | executable in principle, but a dependency is missing | the missing dependency named in the CSV `evidence` column |
| REMAIN | executable **today** with the existing harness, not yet run | reason it was not queued |

`REMAIN` is a queue, not a parking lot: it must be 0 at batch close.

Dashboard arithmetic is printed by `reconcile.mjs` - **never copy the numbers into this file**
(they were wrong here twice). `node .../reconcile.mjs` must exit 0 after any index change; it fails
on any row it cannot place, on a FAIL row with no root-cause cluster in `FAIL-CLUSTERS.csv`, and on
a missing `verdict_run`/`verdict_sha` column. `--close` additionally enforces the evidence bar
above, and `--prev <csv>` requires a run reference on every verdict that moved. On today's corpus
`--close` is red: a real evidence debt, paid by enriching rows - never by loosening the rule.

**Report the delta, not the wall of numbers.** Regressions, fixes, coverage loss, not-run. Never
re-quote the full dashboard as if it were new information.

**A feature is E2E-done when** all of these hold - not when the suite is green:
- the happy path is asserted on state, not on the absence of an exception;
- two edges from the matrix (one negative) plus the derived edges of Gate 2, and a clean error trap;
- the new tests go red under the Gate 7 mutation check, and `prove-fix.mjs` shows red-before /
  3-of-3 green-after (or the report says why not);
- every new case has a `[DOMAIN-NN]` ID, a verdict, and an evidence class in the index, and facets
  the harness cannot reach are PARTIAL/BLOCKED, never dropped silently;
- `lint-specs.mjs`, `delta.mjs` and `reconcile.mjs` all exit 0.

**Exit:** covered / found / not-covered-and-why are written, and the dashboard reconciles.

### Gate 9 - Learn

- New bug -> one row in `references/bug-catalog.md` (symptom, class, detected by, fix, regression, **sibling search** recipe); new dead end -> `references/anti-patterns.md`; new edge that bit you -> `references/edge-case-matrix.md`.
- Prune anything not observed in two consecutive batches; the references are not an archive. Add one row to `references/changelog.md`.

**Exit:** a reference file changed, or an explicit "nothing new" in the report.

## Retry allow-list (the only exception)

A re-run is allowed **only** when the run died before any test body executed: the sidecar shows
0 passing / 0 failing, and `collect-evidence.mjs` prints `NO TESTS EXECUTED`. The log must carry
one of these infrastructure signatures: `DevToolsActivePort` on the first `/session` POST,
`session not created`, `ECONNREFUSED 127.0.0.1:<port>` while creating the session, `tauri-driver`
exited / not found, WebView2 crash before the first `it()`.

Then: **one** re-run, and one log line `RETRY=<signature> run=<sidecar> reason=<signature>`.
A second occurrence means fix the harness. Nothing else is ever retried: not an assertion, not a
timeout inside a test body, not a `HARNESS_*` failure, and never with `retries` in the config
(`retries: 0` is deliberate). The previous "3 clean runs then continue" wording is withdrawn - it
was unenforceable and was used on assertion failures.

## Fix authority

**ASK FIRST** (report, do not change): money arithmetic or rounding; migrations, schema, column
types; sync protocol, outbox ordering, gateway contract; auth, PIN, lockout, roles; anything that
rewrites stored data. **Auto-fix**: UI crash / unhandled rejection, validator parity, TEST BUG with
a fresh observation, cosmetic, a missing `await` or a wrong selector. The full table is in
`references/conventions-and-templates.md`.

## Decision tables

**Is it flaky, or is it broken?** `repeat-run.mjs --times 3` compares **per-case** outcomes: STABLE,
FLAKY (the differing cases are listed), DETERMINISTIC (the same cases failed every run),
UNCLASSIFIABLE (a run produced no verdicts - fix the harness first). A spec is never called a
deterministic failure from its exit code alone.

**N/A vs FAIL.** The Gate 8 table defines all six verdicts; the pair that gets argued is N/A (the
product has no such capability at all) vs FAIL (the capability exists, so the missing variant is a
gap).

**1M rows is BLOCKED in the WebView, measured Node-side.** Seeding 1M rows through the UI/IPC blows
the 300 s mocha timeout and the WebView heap, so no WebView case may claim 1M coverage.
`tools/27e-prf-checks.mts:233` seeds 1M Node-side and times the verbatim boot query
(`customerAdapter.ts:221-224`) - a lower bound (no IPC serialisation) that must be labelled as one.
100k is the practical ceiling for a WebView case.

**Severity** (P0..P3) and the **assertion ladder**: `references/conventions-and-templates.md`.

## Scripts

All Node, zero dependencies, each starts with a usage header (`--help` on the main ones).

| Script | Does | Gate |
|---|---|---|
| `preflight.mjs` | binary provenance/freshness, driver, orphans, sandbox; `--mobile` for adb/AVD/APK | 0 |
| `risk-map.mjs` | changed app files -> features -> domains -> specs; `UNMAPPED` exits 1 | 1 |
| `run.mjs` | run specs, tee the log, write the sidecar (summed counts + `caseVerdicts`) | 4 |
| `verdicts.mjs` | events + `VERDICT=` lines -> verdict map; `--write-index --run` stamps provenance; `--migrate` | 4 |
| `delta.mjs` | verdict map vs `CASE_INDEX.csv`: regressions, fixes, coverage loss, not-run | 4 |
| `repeat-run.mjs` | per-case flake check across runs (`--from-sidecars` to analyse existing runs) | 5 |
| `collect-evidence.mjs` | evidence bundle + `NO TESTS EXECUTED` + 40 log lines before each failure | 5 |
| `scan-pii.mjs` | phones, IPs, PIN hashes, device ids in evidence/fixtures (masked output) | 5 |
| `prove-fix.mjs` | red-before / 3-of-3-green-after; `--finding` for same-verdict-twice; `--dry-run` | 7 |
| `lint-specs.mjs` | spec/index contract + ratchet (`--strict` ignores the baseline) | 3 |
| `reconcile.mjs` | dashboard == CSV, FAIL clusters, `--close` evidence bar, `--prev` provenance | 8 |
| `reset-sandbox.mjs` | wipe the sandbox data + WebView dirs | 0 |
| `selftest.mjs` | fixture-only tests for every script above (`--filter`, `--verbose`) | any |

`selftest.mjs` is the gate on the scripts themselves: it builds throwaway repos under
`%TEMP%\opencode\selftest\` and asserts the exit-code contracts (0/1/2) of `delta`, `verdicts`,
`reconcile`, `lint-specs`, `repeat-run`, `run`, `collect-evidence`, `scan-pii`, `risk-map`,
`prove-fix` and `preflight`. If you change a script's contract, the failing self-test comes first.

## Reference index

| File | Read this when |
|---|---|
| `references/environment-and-commands.md` | the exact command, env var, path, sandbox layout, `.gitignore` rules, or a "why won't it start" answer |
| `references/conventions-and-templates.md` | writing or reviewing a spec, choosing a selector, deciding what to mock |
| `references/feature-discovery.md` | Gate 2: deriving edges, states, invariants, interactions, random walks |
| `references/bug-catalog.md` | triaging a failure, or checking whether the symptom (and its siblings) has been seen |
| `references/edge-case-matrix.md` | Gate 2: the edges that actually bite this product |
| `references/triage-playbook.md` | a run failed and you need signature -> cause -> command |
| `references/anti-patterns.md` | before inventing a helper, a wait, a fixture, or a shell one-liner |
| `references/worked-examples.md` | three end-to-end stories (export drift, 1M boot, refund crash) |
| `references/changelog.md` | the full history of this skill, one row per change with its evidence |
| `references/lint-exemptions.json` | the baselined spec/index debt that `lint-specs.mjs` prints; each entry carries a reason |

Templates: `templates/spec-skeleton.e2e.ts`, `templates/bug-report.md`, `templates/risk-brief.md`.

## Self-update protocol

1. Update only from evidence produced by a run you did: a log line, a `file:line`, a commit.
2. One fact per row; if a row needs three sentences of context it belongs in a reference.
3. Keep SKILL.md under 400 lines (hard cap 500); move detail out and leave a one-line pointer.
4. Retire a row after two batches without an observation (move it to the owning reference's
   "retired" list, do not delete the knowledge).
5. Never add a rule that cannot be checked by a command, a table lookup, or a `file:line`.
6. After editing a script: `selftest.mjs` must pass and `lint-specs.mjs` + `reconcile.mjs` exit 0.

## Changelog

The full history is `references/changelog.md`. Append there, not here.

| Date | Change | Evidence |
|---|---|---|
| 2026-10-28 | Doc pass: three worked examples, sibling-search column, artifact table + `.gitignore` split proposal, mobile preflight, severity/evidence/fix-authority tables, 1M corrected in the matrix; `reconcile --close` dependency regex fixed | `selftest.mjs` 69/69; `reconcile --close` now red only on 248 FAIL + 10 PASS-PARTIAL (real debt) |

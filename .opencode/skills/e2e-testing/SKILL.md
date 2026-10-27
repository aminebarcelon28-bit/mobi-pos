---
name: e2e-testing
description: "Mandatory FIRST step for any feature, bug fix, refactor, migration, dependency bump, or test work in MobiPOS - and for anything that smells like QA: writing, running, debugging or reviewing E2E tests, a test that fails or flakes, edge cases, regressions, coverage, verification, 'does this still work?', 'prove it', or shipping a change. Load it before touching code, before running build:e2e/wdio, and before claiming anything is done. It carries the sandbox topology, the exact commands, the selector/wait/money conventions, the bug catalog, the edge-case matrix and the triage table that this repo paid for across 20+ batches of real E2E runs."
---

# E2E testing (MobiPOS) - operating procedure

This skill is the first thing loaded before any change to this repo. It exists because
the same class of defect kept being found late, by hand, and then re-found in the next
batch: money that rounds differently in two places, receipts whose printed bytes disagree
with the screen, mirrors that go stale after an out-of-band write, a query that is fine at
1k rows and fatal at 1M. The procedure below is the shortest path that has actually caught
those. It assumes the real Tauri app driven by WebdriverIO through an external
`tauri-driver`, a disposable SQLite sandbox, and a Node-side oracle that reads the same
database out-of-band. Nothing here is generic advice; every rule traces to a batch log,
a commit, or a `file:line` in this repo.

## 0. Non-negotiables

| # | Rule | Why (real cost) |
|---|---|---|
| 1 | Run only against the sandbox. `e2e-tests/wdio.conf.ts` redirects `USERPROFILE`/`APPDATA`/`LOCALAPPDATA` into `%TEMP%\opencode\pos-wdio-sandbox` and the e2e flavor opens `com.mobi.pos.e2e`, never `com.mobi.pos`. A wipe is only allowed when the target's leaf directory is exactly `com.mobi.pos.e2e` and it sits at `<sandbox>/home/AppData/{Roaming,Local}/...` (segment check, not a string prefix). | `POS_E2E_WIPE=1` deletes data dirs. The real till DB lives in the prod identifier. |
| 2 | `POS_E2E_WIPE=1` only with the app stopped. The config throws if `mobi-pos.exe` is running. | A running app holds the DB and the WebView dir; the wipe half-fails and the run starts on mixed state. |
| 3 | The binary under test is `target-e2e/debug/mobi-pos.exe`, built by `npm run build:e2e`. Never `target/debug`. `preflight.mjs` hard-fails unless the binary embeds HEAD (or a commit with no app-source change since) plus the e2e identifier, and `wdio.conf.ts` runs that same check at **import time** — a hook cannot stop a run (`@wdio/cli` logs and swallows `onPrepare` errors). | `target/debug` is the dev flavor: no `e2e` feature, no `e2e_*` IPC, no cloud seal, prod identifier. A stale binary makes green runs lie. |
| 4 | Seed and reset out-of-band with `e2e-tests/lib/db.ts` + `lib/seed.ts` (better-sqlite3 on the live WAL file), then wipe WebView mirrors and reload. `e2e_*` IPC is opportunistic, never the source of truth. | Mirrors are a cache. A seed that only touches the mirror passes the test and loses the data on next boot. |
| 5 | Assert on state: a SQLite row, a captured byte stream, a computed total. "No exception thrown" is not a PASS. | Batch 26 shipped 4 FAILs whose only evidence was "the click did not throw"; they were unactionable. |
| 6 | Money is integer minor units (`BigInt`) parsed from fr-DZ display. Never `parseFloat`, never `Number(text)`. | `1/234/567 DA` (P1-73) and the stacked-discount refund drift (CRT-05) both come from float/format round-trips. |
| 7 | Triage before fixing. Every failure gets a class from the table in Gate 5 before a line of app code changes. | Fixing the test to match the bug is the single most expensive mistake in this repo's history. |
| 8 | Never print PASS for a case whose precondition does not exist. Use N/A (absent from the product) or BLOCKED (executable in principle, dependency missing: 10M fixture, gateway, second terminal, device) and name the missing thing. REMAIN means "executable today, not yet run" and must be 0 at batch close. | 117 N/A and 117 BLOCKED cases exist precisely because faking them was refused; a REMAIN bucket that never empties hides the work. |

## Quick start (first minute)

Run from the repo root, PowerShell:

```powershell
npm run e2e:clean
node .opencode/skills/e2e-testing/scripts/preflight.mjs
$env:POS_E2E_WIPE=1; npx wdio run e2e-tests/wdio.conf.ts --spec e2e-tests/specs/00-harness-smoke.e2e.ts
node e2e-tests/tools/sql.mjs --tables
node .opencode/skills/e2e-testing/scripts/collect-evidence.mjs
node .opencode/skills/e2e-testing/scripts/reconcile.mjs
```

Bash/zsh equivalent: `POS_E2E_WIPE=1 npx wdio run e2e-tests/wdio.conf.ts --spec <spec>`.
`npm run build:e2e` is mandatory whenever `preflight.mjs` fails provenance (it now hard-fails
when the binary does not embed HEAD, or when a source file is newer than the binary).
`npm run e2e:clean` kills orphaned `mobi-pos.exe` / `msedgedriver.exe` / `tauri-driver.exe`.

`node e2e-tests/tools/coverage.mjs` is a **batch-report generator, not a check**: it rewrites
`COVERAGE.md`, reads verdicts from `CASE_INDEX.csv` (the single source of truth), and refuses
to run without `--batch <tag>`. The retired `fixtures/{fail,na,blocked}-cases.json` buckets are
gone; anything that still reads them re-emits old numbers. Use `reconcile.mjs` for the
dashboard check.

## The gates

Each gate has one exit criterion. Do not enter the next gate with the previous one open.

### Gate 0 - Context and environment

| Step | Command / action |
|---|---|
| Read binding decisions | `AGENTS.md` (storage topology, trust rules, accessibility locator rules). These override anything here that looks contradictory. |
| Know the tree | `git status --short`, `git log --oneline -5`. `e2e-tests/` is untracked in this repo; do not commit it unless asked. |
| Kill orphans | `npm run e2e:clean` |
| Preflight | `node .opencode/skills/e2e-testing/scripts/preflight.mjs` - binary provenance (must embed HEAD + `com.mobi.pos.e2e`) and freshness, driver path, orphan processes, sandbox, node/wdio versions. |
| Smoke | `$env:POS_E2E_WIPE=1; npx wdio run e2e-tests/wdio.conf.ts --spec e2e-tests/specs/00-harness-smoke.e2e.ts` |

**Exit:** `e2e-tests/test-logs/manifest.json` carries today's `gitSha` and the smoke is 7/7.
`[HARNESS-07]` is **not** a tolerated flake any more: the 2026-10-27 forensics proved the
harness double-sent (a synthetic fallback fired 1.2 s after the real burst had already
decoded; 2 dispatches → 2 events → `246800`, one dispatch → one event → `123400` in 6/6
control runs). `lib/pos.ts scanCode()` now waits on `pos:barcode-scanned` and throws
`HARNESS_SCAN_DOUBLE_DISPATCH` if one scan produces two events. Any HARNESS failure means the
harness is broken — stop and fix it, never retry past it.

**Retry-and-log exception (review date 2026-12-31):** only when the failure is *not*
reproducible after 3 clean runs, record one line in the run log (`spec`, `test`, `signature`,
`3/3 clean re-runs`), and continue. This exists for genuine infrastructure flakes (driver
startup, WebView crash), never for an assertion you could weaken. The review date is written
here on purpose: if this exception is still being used after 2026-12-31, delete it and fix the
cause.

**Hard exclusion:** the exception never applies to a `HARNESS_*` failure. A harness bug is
fixed at the source, never retried, never logged-and-continued — and `HARNESS_SCAN_DOUBLE_DISPATCH`
in particular is terminal: read its dispatch/event counts (they name the culprit) and fix that.

### Gate 1 - Risk brief (five lines, written down)

Name what changed, which domains it touches, the blast radius, and the invariant that would
break silently. Use this table; it is derived from the domain specs that exist.

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
| scale, lists > 10k rows | SCL / PRF | the `23-scl-*` specs; measure, do not eyeball |

**Exit:** the brief names one riskiest flow and one invariant ("stock decrements exactly
once", "export cell equals headline total", "outbox stays contiguous").

### Gate 2 - Test plan

One row per case, before any code:

| Case ID | Risk (why this one) | Precondition | Pass condition (written before measuring) | Spec file |
|---|---|---|---|---|

Rules:
- Minimum per change: happy path + 2 edges from `references/edge-case-matrix.md` + 1 negative.
- New case IDs are registered in `e2e-tests/CASE_INDEX.csv` (id, domain, priority, title,
  `verdict=REMAIN`, `spec`) before the first run, so the dashboard can account for them.
- Preconditions that need a device, a second terminal or >1M rows are BLOCKED up front, with
  the missing item named. Do not discover it at run time.
- Thresholds are written before measuring. `PRF-05` was only decidable because "boot < 2 s at
  1M customers" was on paper first; afterwards any number looks acceptable.

**Exit:** every planned case has an ID, a spec file, and a pass condition that a stranger
could evaluate.

### Gate 3 - Write or extend tests

Follow `references/conventions-and-templates.md`. The load-bearing items:

1. `it('[DOMAIN-NN] ...')` - the coverage tool's regex is `\[([A-Z]{3}-\d{2})\]`; any other
   title shape is invisible to the dashboard.
2. `data-testid` via `tid('...')`; use `shown()`/`shownX()` because mobile and desktop twins
   share testids and document order is not display order.
3. Wait on state (`waitUntil` over a SQLite count or a cart total), never `sleep`.
4. Money: `cartTotalMinor()` / `displayedToMinor()`, compare as `BigInt`.
5. Seed with `seedProducts` / `seedCustomers` / `seedShift`, then `clearWebMirrors()` and reload.
6. `installErrorTrap()` in `before`, `expectNoUiErrors()` in `after` - an unhandled rejection
   during the flow is a finding even when assertions pass.
7. Every case logs its raw observation with `console.log('[DOMAIN-NN] ...')` so the canonical
   log can be rebuilt without re-running.

**Exit:** the new spec is green twice consecutively and its `it()` title matches the coverage
regex `\[[A-Z]{3}-\d{2}\]` (grep the spec for `it('[`). Do not run `coverage.mjs` to check
this - it rewrites `COVERAGE.md` from stale buckets.

### Gate 4 - Run in order

1. smoke (Gate 0), 2. the new spec, 3. adjacent specs from the Gate 1 table, 4. full suite
only when shared code changed (`lib/`, `src/services/`, `src/db/`, `src-tauri/`).

```powershell
node .opencode/skills/e2e-testing/scripts/run.mjs --spec e2e-tests/specs/<file>.e2e.ts --wipe --tag <name>
```

Artifacts, in the order you should read them:

| Artifact | Path | What it answers |
|---|---|---|
| WDIO log (backend + frontend + assertions) | `e2e-tests/test-logs/<spec>-0-0.log` | what the app logged at the moment of failure |
| Per-test NDJSON | `e2e-tests/results/events.ndjson` | last state per test, duration, error message |
| Screenshots | `e2e-tests/results/*.png` | dialog/overlay state when a click "did nothing" |
| Run sidecar | `e2e-tests/results/runs/<stamp>-<tag>.json` | spec, git SHA, exit code, pass/fail counts |

No video or WebDriver trace recording is configured in this harness. The four artifacts above
are the whole evidence set - if they do not answer the question, add a `console.log` with the
case ID and re-run; do not guess.

**Exit:** every run has a sidecar with spec + SHA + duration, and no failure is left
unclassified.

### Gate 5 - Triage (never fix before classifying)

| Class | Tell | First check |
|---|---|---|
| APP BUG | state is wrong or missing after a successful flow | read the row: `node e2e-tests/tools/sql.mjs "SELECT ... FROM ..."` |
| TEST BUG | assertion encodes the wrong expectation, or reads a hidden twin | re-read the pass condition; check `isDisplayed()` |
| ENVIRONMENT | harness never came up, DB never appeared, driver died | `preflight.mjs`, `test-logs/manifest.json`, first 80 lines of the log |
| FLAKY | same spec, same seed, different result | `repeat-run.mjs --times 3` |
| BAD DATA | fixture violates a constraint the app legitimately rejects | inspect the seed row, compare with `lib/seed.ts` |
| BLOCKED | precondition absent (device, gateway, 1M rows, wall clock) | name it in the verdict; do not weaken the case |

Then write the verdict with its evidence class: DB row, BYTES (captured stream), RUNTIME
(error/tap counts), SOURCE (`file:line`), UI (visible text only - allowed only when the case
is about text). After 27e the split was DB 57 / BYTES 29 / RUNTIME 20 / SOURCE 33 / UI 1.
A FAIL with UI-only evidence is almost always a test bug.

**Exit:** each failure has a class, an artifact or `file:line`, and a verdict.

### Gate 6 - Fix, then prove it

- Add the regression case to the owning spec. If it cannot be reproduced on the fixed tree,
  say so explicitly in the report instead of shipping a test that cannot fail.
- Repeat-run three times, wipe between runs:

```powershell
node .opencode/skills/e2e-testing/scripts/repeat-run.mjs --spec e2e-tests/specs/<file>.e2e.ts --times 3
```

**Exit:** 3/3 green, error trap empty, and the new case fails on the pre-fix commit (or the
report states why that check was impossible).

### Gate 7 - Report

Use `templates/bug-report.md` for findings and this verdict vocabulary everywhere:

| Verdict | Means | Evidence bar |
|---|---|---|
| PASS | the asserted facet is correct | state/bytes quoted |
| PASS-PARTIAL | some facets asserted, others not | the unasserted facet is named |
| FAIL | asserted behaviour is wrong or missing | raw observation quoted, plus `file:line` when known |
| N/A | the precondition does not exist in the product | grep/probe count = 0 |
| BLOCKED | executable in principle, but a dependency is missing (10M fixture, gateway, second terminal, device) | the missing dependency named in the CSV `evidence` column |
| REMAIN | executable **today** with the existing harness, not yet run | reason it was not queued |

`REMAIN` is a queue, not a parking lot: it must be 0 at batch close. Anything that needs a
dependency this environment lacks is BLOCKED with that dependency named.

Dashboard invariants (current baseline, after the 27c SCL relabel):
`687 = 178 PASS + 24 PASS-PARTIAL + 251 FAIL + 117 N/A + 0 REMAIN + 117 BLOCKED`.
`CASE_INDEX.csv` has 697 data rows = 687 active + 10 owner-retired (`retired=1`, outside the
687 and reported separately). `node .opencode/skills/e2e-testing/scripts/reconcile.mjs` prints
the arithmetic, fails on any row it cannot place, and must exit 0 after any index change.

**A feature is E2E-done when** all of these hold - not when the suite is green:
- the happy path is asserted on state, not on the absence of an exception;
- two edges from the matrix, at least one of them negative;
- the error trap is clean for the whole run;
- 3/3 stable under `repeat-run.mjs`;
- every new case has a `[DOMAIN-NN]` ID, a verdict, and an evidence class in the index;
- facets the harness cannot reach are recorded as PARTIAL/BLOCKED, never dropped silently.

**Exit:** covered / found / not-covered-and-why are all written, and the dashboard reconciles.

### Gate 8 - Learn

- New bug -> one row in `references/bug-catalog.md` (symptom, class, detection, fix, regression).
- New dead end -> one row in `references/anti-patterns.md`.
- New edge case that bit you -> one row in `references/edge-case-matrix.md`.
- Prune anything not observed in two consecutive batches; the references are not an archive.
- Add one line to the changelog at the bottom of this file.

**Exit:** a reference file changed, or an explicit "nothing new" in the report.

## Light path (low-risk changes)

Low risk = copy/text change, a new pure helper with unit tests, a style-only component edit,
a docs change. Gates 1, 2, 6, 8 may be compressed to one paragraph each.

Never skipped, at any risk level: **Gate 0** (environment up), the **smoke spec**, and
**Gate 5** (triage before fixing). Those three are what turn a 10-minute change into a
two-day investigation when skipped.

## Decision tables

**Is it flaky, or is it broken?** Run the spec 3x with `--wipe` between runs.
3/3 pass -> flake, fix the wait or the fixture, never `retries`. 1-2 of 3 -> race in the app
or in the seed; treat as APP BUG until the log proves otherwise. 0/3 -> deterministic failure,
triage normally. `retries: 0` is set in `wdio.conf.ts` on purpose.

**N/A vs FAIL vs BLOCKED vs REMAIN.** N/A = the product has no such capability at all (no A4 invoice
component anywhere). FAIL = the broader capability exists, so the missing variant is a gap
(refunds exist, so a gift-receipt variant is a FAIL). BLOCKED = executable in principle but the
harness cannot reach it (no label printer, no second terminal, no 1M-row fixture, no gateway) —
name the dependency. REMAIN = executable today, not yet run; it must be 0 at batch close.

**Severity.** P0 data/financial loss or no recovery path. P1 the feature runs but produces a
wrong result. P2 missing/incomplete but what runs is correct. P3 cosmetic or only reachable
with artificial extremes (a 67-character product name).

**Assertion ladder** - prefer the highest rung that the case allows:
captured bytes > SQLite row > IPC return value > rendered DOM state > visible text.

## Reference index

| File | Read this when |
|---|---|
| `references/environment-and-commands.md` | you need the exact command, env var, path, port, sandbox layout, or a "why won't it start" answer |
| `references/conventions-and-templates.md` | you are writing or reviewing a spec, choosing a selector, or deciding what to mock |
| `references/bug-catalog.md` | you are triaging a failure, or want to know whether this symptom has been seen before |
| `references/edge-case-matrix.md` | you are planning Gate 2 and need the edges that actually bite this product |
| `references/triage-playbook.md` | a run failed and you need the signature -> cause -> command mapping |
| `references/anti-patterns.md` | before you invent a helper, a wait, a fixture, or a shell one-liner |

Templates: `templates/spec-skeleton.e2e.ts`, `templates/bug-report.md`, `templates/risk-brief.md`.
Scripts: `scripts/preflight.mjs`, `run.mjs`, `collect-evidence.mjs`, `repeat-run.mjs`,
`reset-sandbox.mjs`, `reconcile.mjs` (all Node, zero dependencies; each starts with a usage
header, and `run.mjs --help` prints its own).

## Worked example 1 - report export disagreed with its own headline (RPT, batch 27d)

Risk brief: "export writer touches money aggregation; blast radius is every exported report;
invariant: the export cell must equal the headline total for the same fixture."

Plan: one case per report, pass condition `export cell == headline` on a fixed 14-row fixture
(net 78 500, cost 54 000, restored 2 000, profit 26 500, basket 7 591), plus the 200 001-row
cap case. Thresholds written before measuring.

Run: `27d-rpt-checks.mts` under Node against the shipped `sheets.ts`, not a re-implementation.
Result: headline said cost 54 000 / profit 26 500 / items 78 500; the exported sheet said
54 200 / 29 300 / 84 500. `RPT-06` PASS-PARTIAL, the rest FAIL with both numbers quoted.

Triage: APP BUG, evidence class DB + SOURCE. Root cause `sheets.ts:151-161` recomputes from
line rows while the headline reads the ledger. Regression: assert cell == headline on the same
fixture, so the two paths can never drift again.

The lesson that became Gate 2: "compare the two outputs against each other" is a pass condition;
"the export runs without error" is not.

## Worked example 2 - catalog boot at 1M customers (PRF-05, batch 27e)

Risk brief: "customer list adapter changed; invariant: boot stays interactive at 1M rows."

Plan: pass condition `boot < 2 s and no full-table materialisation`, fixture 1 000 000
customers, measured through the real boot path.

Run: `tools/27e-prf-checks.mts` seeded 1M rows, then timed the exact boot query.
Result: SQL 3 747 ms + mapping 899 ms = 4 646 ms lower bound, 194 MiB payload,
+858 MiB heap / +870 MiB RSS. FAIL.

Triage: APP BUG, evidence class RUNTIME + SOURCE. Root cause `customerAdapter.ts:221-224`
`ORDER BY name ASC` with no index on `name` (`lib.rs:1023-1025` indexes phone, barcode,
loyalty_card only), awaited in `createUISlice.ts:1990-2023`. The fix is an index or a paged
query, not a spinner.

The lesson that became Gate 2's threshold rule: without the pre-written 2 s, a 4.6 s boot
looks like "a bit slow" and ships.

## Worked example 3 - live refund crashed on a cleanup (commit a651768)

Symptom: opening the refund dialog on a sale with a wallet leg threw `ReferenceError` in the
console; the dialog rendered but the totals were blank.

Detection: `installErrorTrap()` + `expectNoUiErrors('refund open')` in the REF spec, not a
visual check. Class RUNTIME. Fix `a651768` restored the symbol removed by a TypeScript
cleanup. Regression: the REF spec asserts both no UI errors and a non-zero refund total, so a
silent render failure cannot pass as "dialog visible".

The lesson that became Gate 3 item 6: an error trap is cheaper than a screenshot.

## Self-update protocol

1. Update only from evidence produced by a run you did: a log line, a `file:line`, a commit.
   No speculative rows.
2. One fact per row. If a row needs three sentences of context, it belongs in a reference,
   not in SKILL.md.
3. Keep SKILL.md under 400 lines (hard cap 500). When it grows, move detail into a reference
   and leave a one-line pointer.
4. Retire a row after two batches without an observation. Move it to the "retired" list at the
   bottom of the owning reference instead of deleting the knowledge.
5. Never add a rule that cannot be checked by a command, a table lookup, or a `file:line`.
6. Re-run `scripts/preflight.mjs` and `scripts/reconcile.mjs` after editing scripts; both must
   exit 0.

## Changelog

| Date | Change | Evidence |
|---|---|---|
| 2026-10-27 | Initial skill: gates 0-8, 6 references, 6 scripts, 3 templates | batches 26-27e, `wdio.conf.ts`, `lib/*`, 140 FAIL rows |
| 2026-10-27 | HARNESS-07 root-caused as a harness double-send; `scanCode()` waits on the scan event and throws on 2 events; Gate 0 tolerance removed (retry-and-log with review date 2026-12-31) | probe v4: 2 dispatches/1.25 s → 2 events/`246800` 6/6; 1 dispatch → 1 event/`123400` 12/12 |
| 2026-10-27 | `CASE_INDEX.csv` is the only verdict source; `coverage.mjs` is batch-only (`--batch <tag>`) and the stale `fixtures/{fail,na,blocked}-cases.json` buckets are deleted; `reconcile.mjs` fails on unplaced rows and proves 697 = 687 + 10 | `coverage.mjs --batch`, `reconcile.mjs` exit 0, dashboard `178/24/251/117/0/117` |
| 2026-10-27 | 45 SCL REMAIN rows relabelled BLOCKED with the missing dependency; preflight hard-fails on binary sha/freshness; wipe guards require the exact `com.mobi.pos.e2e` leaf | `CASE_INDEX.csv` 697 rows, `preflight.mjs` negative tests, `guard-test.mjs` 8/8 |
| 2026-10-27 | Provenance moved to `wdio.conf.ts` **import time**: `@wdio/cli`'s `runLauncherHook` logs and swallows `onPrepare` errors (verified — a blocked preflight still ran the suite), so `preflight.mjs --provenance` now runs while the config loads. A binary built at an earlier commit is accepted only when `git diff` proves no app source changed in between. The wipe guard validates the same way and delegates its rule to `_lib.e2eDataDirProblem`. | fake-binary run aborts with exit 1 and no spec starts; docs-only commit `e635bda` passes preflight; a commit that touched `src/` still hard-fails |

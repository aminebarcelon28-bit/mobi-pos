---
name: feature-e2e
description: "Use whenever a NEW feature, screen, native command or data path lands in MobiPOS and needs E2E coverage created rather than repaired - 'test this new feature', 'add e2e coverage for X', 'write a spec for what I just built', 'the new endpoint/command needs tests', 'turn these acceptance criteria into tests'. Reads the change, writes a risk brief, allocates real CASE_INDEX ids, writes a runnable WebdriverIO spec against e2e-tests/lib, runs it on a clean sandbox, and records the verdicts (+ cluster rows for any FAIL) so COVERAGE.md and the reconcile gate stay true. Complement to the e2e-testing skill, which fixes and verifies the existing corpus; this one grows it."
---

# feature-e2e - plan, spec, run and record a new feature

The `e2e-testing` skill answers "did we break something that already worked". This one
answers the other question: "this feature is new, what proves it works, and where does that
proof live". It reuses the same harness (`e2e-tests/`), the same seeds, the same invariant
hooks and the same verdict source (`CASE_INDEX.csv`) - it does not invent a second lane.

A feature is done here when five things exist: a written risk brief, a case set with real
ids, a spec that runs, a clean run whose failures are classified, and index rows that make
`reconcile.mjs` and `case-index.mjs check` exit 0.

## 0. Non-negotiables

1. **Every case has one oracle that is not the screen it is testing.** The database, the
   native IPC result, or the receipt bytes. A test that only re-reads the UI it just drove
   is not evidence.
2. **Money, stock, trust and lockout are P0.** A new P0 path with no DB assertion is not
   allowed to reach PASS.
3. **Fail closed.** If the feature's own error path can fall through to a success path
   (sequential fallbacks, `??` on a `0`, "retry with defaults"), that is a case, and the
   expected verdict is a typed refusal.
4. **Ids are allocated, never invented.** `case-index.mjs next <DOMAIN> <n>`.
5. **`CASE_INDEX.csv` is the only verdict source.** Not the log, not the dashboard.
6. **No silent overrides.** If a case needs an override to look green, the override is
   evidence and belongs in the report (see `PAY-22` precedent).
7. **Never rewrite history or push to make a gate pass.** Report instead (repo `AGENTS.md`).

## Quick start (first five minutes)

```powershell
# what changed, and what surface does it touch
git log --oneline -5; git diff --stat HEAD~1
# what the corpus already covers for this keyword
node .opencode/skills/feature-e2e/scripts/case-index.mjs check
Select-String -Path e2e-tests/CASE_INDEX.csv -Pattern "<keyword>"
# ids for the new cases
node .opencode/skills/feature-e2e/scripts/case-index.mjs next <DOMAIN> 5
```

Then run phases 0-6 in order. Do not skip phase 1: the risk brief is what decides how many
cases are enough.

## Phase 0 - Read the change

Collect, before writing anything:

- **The intent.** The issue, PR description, or the owner's words. If none exists, write
  3-6 behavioural clauses ("given X, when Y, then Z") and confirm them with the owner
  *before* writing tests - one question, options, no guessing.
- **The code path**, as `file:line`: the UI component, the service/adapter, and (if it
  writes money or trust) the native command in `src-tauri/`. `e2e-tests/fixtures/feature-map.json`
  already maps feature phrases to `file:line` anchors; start there, then verify against HEAD.
- **The existing coverage.** Grep `CASE_INDEX.csv` titles and the `specs/` for the feature's
  nouns. Cases that already exist get *extended*, not duplicated - the corpus counts every
  active row, so a duplicate inflates `Catalog cases` and hides a gap.
- **The surface mix.** One feature can need desk DOM, mobile shell and IPC cases; see
  `references/harness-map.md` for which helper and which oracle each surface gets.

**Exit:** you can name the code path, the surface(s), and the overlapping existing cases.

## Phase 1 - Risk brief (written down, no placeholders)

Copy `.opencode/skills/e2e-testing/templates/risk-brief.md` to
`%TEMP%\opencode\<feature>-plan.md` (never into the repo unless the owner asks), fill its
five gates, and add the two lines only a *new* feature needs:

```
Reachable:   <roles/screens that can trigger it; behind a PIN or step-up?>
If wrong:    <the concrete harm: drawer mismatch, negative stock, replay double-charge>
```

The template's own lines still apply: `Changed`, `Touches` (money / refunds / data / sync /
print / reports / auth / shifts / catalog / scale), `Blast radius`, `Riskiest flow`,
`Invariant that would break silently`.

If `Touches` is non-empty, the feature needs at least one invariant-level case (G-01/G-04/
G-09/G-15 class) in addition to its UI cases. If `Blast radius` names a shared helper, the
full suite becomes mandatory after the spec passes (phase 4, step 4).

**Exit:** the brief is filled with no placeholder left, each line traceable to a `file:line`
or a case id.

## Phase 2 - Case set (the plan)

Write one row per case, in a table, with these columns:

| Column | Rule |
|---|---|
| `id` | from `case-index.mjs next <DOMAIN> <n>` |
| `priority` | P0 money/stock/trust/lockout - P1 user-visible and recoverable - P2 labels/layout |
| `surface` | `desk` \| `mobile` \| `data` (native/IPC/SQLite) |
| `given/when/then` | the behaviour, in the feature's own vocabulary |
| `oracle` | the exact table+column, IPC code, or receipt field that decides pass/fail |
| `assertion` | `db` \| `dom` \| `ipc-code` \| `bytes` |
| `existing?` | `new` or the id being extended |

Rules that keep the set honest:

- **4-12 cases per feature.** More than that usually means the feature is several features;
  split it and say so.
- **One negative case minimum**: the refusal path (missing PIN, revoked license, zero stock,
  expired voucher). Refusals are where the fallbacks hide.
- **One boundary case** if a number is involved: 0, 0.01, the rounding edge, the maximum.
- **One idempotency case** if the path can be replayed (double-click, re-send, offline retry).
- **The oracle must be writable today.** If the table does not exist yet, the case is
  `BLOCKED` with the missing dependency in `evidence` - not a guess.
- **Conditional P0**: put the condition in `conditional_p0` (e.g. `discount > 0`).

**Exit:** the table, with every `oracle` cell naming a real table/column or IPC symbol.

## Phase 3 - Write the spec

Start from `assets/spec-template.e2e.ts`. It carries the head every working spec in this
repo has: imports, seeding in `before()`, `captureInvariantBaseline`, `afterEach` cleanup +
`assertInvariants`, `after` `finalizeInvariants`. (`e2e-testing/templates/spec-skeleton.e2e.ts`
is the older variant without the invariant hooks - fine to read, not to start from.)

- **File name:** `e2e-tests/specs/NN-<dom>-<feature>.e2e.ts`, `<dom>` lower-case matching the
  domain prefix, `NN` the next free number in that theme's decade (`70-` CRM, `75-` LOY,
  `80-` TIN, `82-` INV, `84-` REP, `86-` WAR; a brand-new theme starts a new decade, probes
  stay in `9x-`). One spec per feature; do not append to an unrelated batch file.
- **Locators:** `getByRole('<role>', { name: /<visibleText>/i })` only. Per `AGENTS.md`
  (WCAG 2.5.3) an `aria-label` must *begin with* the visible text - never a synonym or an
  expansion. State-dependent visible text needs a state-aware label. Glyph-only controls
  (`⌫ ‹ › ✕`) keep a descriptive `aria-label` with the glyph `aria-hidden="true"`.
  `tid()` returns a `[data-testid]` selector - use it for the elements the accessibility tree
  genuinely cannot name (icon grids, canvas), never as an escape hatch from the label rule.
- **Wait on the effect, never on the clock.** `browser.waitUntil` against a DB row, a
  `data-*` attribute, or a count. No `sleep()`; no assertion immediately after a click.
- **Read ground truth through `lib/db.ts`** (`one`/`all`/`scalar`/`count`), and let
  `waitForSchemaSettled()` gate the first read after seeding.
- **Money is integer minor units**, compared exactly. Parse displayed text only when the
  case is *about* display (then assert both the DOM string and the stored integer).
- **Native/IPC cases** go through `lib/invoke.ts` and assert the **code**, not the message:
  `nativeCodeOf(res)` equals `SUPERVISOR_AUTH_EXPIRED`, not a French sentence.
- **Cleanup in `afterEach`** (close dialogs, clear cart, clear PIN mirror) so one red case
  does not cascade into ten.
- **Do not install the scan spy twice.** `scanCode()` already arms it; a spec-local
  `installScanSpy()` produced two scan events per code and looked like a double-dispatch
  app bug for weeks. Use `ensureScanSpy()` if you must touch it.
- **Never probe a field by a placeholder string you invented.** The trade-in probe searched
  for `Nadir` in a placeholder and "failed" three specs; the app never had that string.
  Assert the field by role/label, then by value.

**Exit:** `npx tsc --noEmit -p e2e-tests/tsconfig.json` reports the same error count as
before your change (baseline on 2026-10-27: 114 errors in 28 files - pre-existing). A new
error in *your* spec is yours to fix.

## Phase 4 - Run it

```powershell
node .opencode/skills/e2e-testing/scripts/preflight.mjs
node .opencode/skills/e2e-testing/scripts/run.mjs --spec e2e-tests/specs/NN-<dom>-<feature>.e2e.ts --build --wipe --tag feat-<dom>
```

Order, and why:

1. **preflight** - certifies the e2e binary embeds HEAD and is not older than the app source.
   `APP_PATHS` is narrow: editing specs, docs or `.opencode/` does *not* force a rebuild;
   editing `src/`, `src-tauri/` or `lib/` does.
2. **`--build --wipe`** - the smoke spec's `openShiftUi` is unconditional, so the sandbox must
   be clean (`%TEMP%\opencode\pos-wdio-sandbox`). A leftover DB makes a correct spec fail.
3. **the new spec alone**, then **re-run a single red case once** to separate flake from defect.
4. **adjacent specs** from the phase-1 blast radius, then the **full suite** only when shared
   code changed (`e2e-tests/lib/`, `src/services/`, `src/db/`, `src-tauri/`).
5. **delta** against the existing verdict source:

```powershell
node .opencode/skills/e2e-testing/scripts/delta.mjs --results e2e-tests/results/runs/<stamp>-feat-<dom>.json
```

`delta.mjs` exits non-zero only on a **regression** (a PASS/PASS-PARTIAL that is now FAIL).
Fixes and unchanged cases never fail the gate. New ids are not in the baseline yet, so they
show up as not-run - that is expected before phase 5.

**Reading a failure:** the four artifacts are the whole evidence set - WDIO log
(`e2e-tests/test-logs/<spec>-0-0.log`), `e2e-tests/results/events.ndjson`, screenshots, and
the run sidecar in `e2e-tests/results/runs/`. In PowerShell-captured output the suite's
`✓/✖` glyphs arrive mangled - match the numbered failure list or `Error in "…[ID]…"` lines
instead. When the artifacts do not answer it, add a `console.log` with the case id and re-run;
do not guess.

**Exit:** a sidecar with the git SHA, one verdict per new case backed by an artifact, zero
unclassified failures, zero regressions.

## Phase 5 - Record it

The verdicts only become real when the index says so. `case-index.mjs` appends (never
re-serialises the 697 existing rows) and derives the dashboard counts for you.

```powershell
# 1. write the rows to %TEMP%\opencode\new-cases.json (field contract: references/case-index.md)
# 2. dry run: prints the allocated ids + the dashboard deltas - read them
node .opencode/skills/feature-e2e/scripts/case-index.mjs add %TEMP%\opencode\new-cases.json
# 3. append + sync the dashboard
node .opencode/skills/feature-e2e/scripts/case-index.mjs add %TEMP%\opencode\new-cases.json --write
# 4. parity + id hygiene
node .opencode/skills/feature-e2e/scripts/case-index.mjs check
# 5. FAIL rows need a cluster, or the gate refuses
node .opencode/skills/e2e-testing/scripts/reconcile.mjs
```

- **Any new FAIL needs exactly one row** in `e2e-tests/FAIL-CLUSTERS.csv`:
  `case_id,cluster_id,cluster_key,class,evidence,money,priority,catalog`. `class` is
  `app` \| `test` \| `harness` \| `env` - classify before you fix (e2e-testing Gate 5).
  A cluster already in the file wins over a new one; reuse the `cluster_id`.
- **Do not hand-edit the dashboard.** `add --write` updates the counter rows; hand edits are
  how `COVERAGE.md` and the CSV drifted apart in the first place.
- **PASS-PARTIAL is honest, not a failure.** Use it when the case's facets are only partly
  observable and list the unasserted facet in `evidence`.

**Exit:** `case-index.mjs check` prints `ok`, `reconcile.mjs` exits 0, the new FAIL rows each
map to a cluster, and the changed files are exactly: the spec, `CASE_INDEX.csv`,
`COVERAGE.md`, and `FAIL-CLUSTERS.csv`/`.md` when a FAIL was found.

## Phase 6 - Report

Report, in this order, and never collapse a FAIL into prose:

1. **Verdict table** - id, title, verdict, oracle, one-line evidence per row.
2. **What the feature does not do** - the gaps the cases exposed (missing refusal, stale
   mirror, unasserted facet). This is the most valuable output of the whole skill.
3. **Gate output** - `check`, `reconcile`, `delta`, and the `tsc` error count before/after.
4. **Files touched**, with `file:line` for every claim about behaviour.
5. **What was not run and why** (BLOCKED with the dependency named).

Do not commit or push unless the owner asks. When asked, commit the spec and the index rows
together - a spec whose cases are missing from `CASE_INDEX.csv` is invisible to every gate.

## Anti-patterns (each one cost a batch)

| Anti-pattern | What it looked like | Rule |
|---|---|---|
| Text-only assertion | spec asserts the price string it just typed | assert the stored integer too, or the case is `PASS-PARTIAL` |
| Placeholder probe | `byPlaceholder('Nadir')` "failed" 3 specs | locate by role/label, assert by value |
| Double-dispatch harness bug | 2 scan events per code from a spec-local spy | `scanCode()` arms the spy; use `ensureScanSpy()` |
| Invariant hook attribution | afterEach invariant failure landed on the last `it()` | treat hook-only failures as residual; document, never override silently |
| Stale fixture | seed set the legacy debt column, UI read the new one | seed both, assert the column the query actually reads |
| `??` on a zero | `current_debt ?? payload` preferred a stale `0` | assert the value the user sees against `customer_debts` |
| Override to green | an `OVERRIDE = { 'PAY-22': 'PASS' }` with no note; the landed one is the correct form - it carries the reason | every override states its justification next to it, and the report repeats it |

## Decision tables

**Which verdict?**

| Situation | Verdict |
|---|---|
| Every assertion passed against the oracle | `PASS` |
| The flow passed; some facet was unobservable in the harness | `PASS-PARTIAL` (list the facet) |
| The oracle disagrees with the UI, or a typed refusal never came | `FAIL` (+ cluster row) |
| The surface does not exist in the harness at all (no mobile lane, no receipt bytes) | `N/A` (say what is absent) |
| Writable today, not yet executed | `REMAIN` |
| Blocked on a dependency (missing table, missing device, ungated crate) | `BLOCKED` (name the dependency) |

**Which surface, which oracle?** See `references/harness-map.md` - it maps each surface to
the helper that drives it and the layer that decides the verdict.

## Reference index

| File | What it answers |
|---|---|
| `references/harness-map.md` | surface -> helper -> oracle, with the real paths |
| `references/plan-and-cases.md` | how to write the risk brief and the case table, with a worked example |
| `references/case-index.md` | the `cases.json` field contract and what `next`/`add`/`check` each guarantee |
| `assets/spec-template.e2e.ts` | the skeleton the spec starts from (invariant hooks included) |
| `scripts/case-index.mjs` | `next` / `add` / `check` |
| `.opencode/skills/e2e-testing/SKILL.md` | the fix-and-verify gates this skill hands off to |
| `.opencode/skills/e2e-testing/templates/risk-brief.md` | the brief phase 1 fills in (do not fork it) |
| `.opencode/skills/e2e-testing/references/bug-catalog.md` | the defect families your new cases should probe |
| `e2e-tests/lib/` | `pos`, `seed`, `invariants`, `invoke`, `db`, `env`, `sav`, `campaign` |

## Self-update protocol

1. When a spec in this harness teaches you something that is not in here, add it to
   **Anti-patterns** with the case id or `file:line` that proved it.
2. When `e2e-tests/lib/` gains a helper that changes the surface table, update
   `references/harness-map.md` in the same change.
3. Never add a rule that cannot be checked by a command, a table lookup, or a `file:line`.
4. After editing `scripts/case-index.mjs`, re-run the fixture round-trip and `check` against
   the real corpus; both must exit 0.

## Changelog

| Date | Change | Evidence |
|---|---|---|
| 2026-10-28 | Initial skill: phases 0-6, 3 references, 1 template, `case-index.mjs` (next/add/check) | `e2e-tests/` 46 specs, 697 index rows, `reconcile.mjs`, `delta.mjs`, batches 26-27e |

# Failure triage — 2026-11-06 (post rc-12, rc-13 flip line)

Method: `scripts/triage-failures.cjs` parses the tag-run log
(`tagrun-382c1bf`, 43 specs, 336 cases), the five process-isolated scale runs, and
the committed baseline (`results/baseline/c01-stage-a/COVERAGE.md`, 672 rows) and
classifies every failing case id against its baseline verdict. No case is deleted or
skipped by this report; it is the input list for the fix order.

## Counts (must reconcile)

| Group | Count | Source |
|---|---|---|
| Tag-run failures, attributable to a case id | **79** | `Error in "…[ID]…"` lines |
| Tag-run failures, hook/unattributed | **15** | 94 run-level failures − 79 attributable |
| **Tag-run total** | **94** | sidecar `failing` |
| Scale specs (process-isolated) | **9** | wal 1, customers 3, ledger-probe 1, ledger 1, db 3 |
| **Grand total** | **103** | matches the open set |

## Classification of the 79 attributable failures

| Class | Count | Meaning |
|---|---|---|
| `real-gap` | **68** | baseline says FAIL — the case measures a product gap that still exists |
| `baseline-PASS now failing` | **10** | **must be checked first**: either a real regression or a flaky/ordering effect |
| `BLOCKED` in baseline | 1 | baseline verdict is a blocked resource, not a bug |

By prefix, the 68 real gaps: DAT 28 · RCP 11 · SCL 9 · LOY 7 · TIM 3 · SYN 3 · CRM 2
· REF 2 · PAY 1 · TIN 1 · WAR 1.

## The 10 baseline-PASS cases failing now (priority 1)

| Case | Baseline | Notes to verify |
|---|---|---|
| `CRM-04` | PASS | customer path — check ordering/fixture, not the lane |
| `INV-01` | PASS | inventory invariant — possible seed interaction |
| `MNY-25` | PASS | money/debt cache — **treat as money path, verify before any fix** |
| `PAY-21` | PASS | payments |
| `REF-35` | PASS | refunds |
| `REF-41` | PASS | refunds |
| `REF-60` | PASS | refunds |
| `REP-03` | PASS | repairs |
| `SEC-05` | PASS | authorization |
| `TIM-03` | PASS-PARTIAL | timers/receipts |

These fail in **normal mode too** (the tag-run was read-only, but the same failures
are recorded in the normal-mode baseline runs), so they are not caused by the flip.
The first action is to re-run each alone on a clean sandbox: a case that passes
alone is ordering/flakiness, not a regression.

## Unattributed 15

Failures raised inside `before`/`after` hooks carry no case id in the log. They are
counted but not classified yet; each needs a spec-level entry (which hook, which
stage) before it can be fixed. Tracked as the second triage pass.

## Scale specs (9 failing, 0 refusals)

Measured process-isolated, one process per spec, all at 0 refused writes:

| Spec | Cases | Passing | Failing |
|---|---|---|---|
| `23-scl-scale-wal` | 1 | 0 | 1 (its documented `progressbar` FAIL) |
| `23-scl-scale-customers` | 5 | 2 | 3 |
| `23-scl-scale-ledger-probe` | 1 | 0 | 1 |
| `23-scl-scale-ledger` | 1 | 0 | 1 |
| `23-scl-scale-db` | 4 | 1 | 3 |

## Next, in order

1. Re-run the 10 baseline-PASS cases alone; split into real regressions vs flaky, and
   fix only the real ones (money path first: `MNY-25`, then `REF-*`).
2. Second triage pass on the 15 hook failures.
3. Then the 68 recorded gaps, money/refund first.
4. E-0208 runner (process-isolated scale orchestration) merged into the harness.

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

## Task 1 verdicts — the ten, isolated (one run each, clean sandbox, exact case grep)

Method: `run.mjs --spec <spec> --grep "\[<ID>\]" --wipe`, one process per case, so
cross-spec state cannot leak. Result:

| Case | Spec | Isolated | Verdict |
|---|---|---|---|
| `MNY-25` | 11-mny-money-part2 | **0/1 (fails)** | **real failure — money path, see below** |
| `TIM-03` | 26-rcp-tim | **0/1 (fails)** | **real failure — stale spec parser, see below** |
| `REF-35` | 33-ref-refunds-part4 | 1/1 | ordering/seed pollution |
| `REF-41` | 33-ref-refunds-part4 | 1/1 | ordering/seed pollution |
| `REF-60` | 33-ref-refunds-part4 | 1/1 | ordering/seed pollution |
| `PAY-21` | 20-pay-payments | 1/1 | ordering/seed pollution |
| `SEC-05` | 50-sec-authorization | 1/1 | ordering/seed pollution |
| `CRM-04` | 70-crm-customers | 1/1 | ordering/seed pollution |
| `INV-01` | 82-inv-inventory | 1/1 | ordering/seed pollution |
| `REP-03` | 84-rep-repair | 1/1 | ordering/seed pollution |

**8 of 10 are ordering defects, not regressions.** They pass alone and fail in the
chained sweep, which makes the sweep's own isolation the bug: a case whose result
depends on what ran before it is a harness defect and must be fixed as one (seeded
fixtures, no reliance on prior specs' leftover rows), never retried until green.

### `TIM-03` — stale spec parser (evidence)

The receipt row is correct: the app printed `Date: 31/12/2026 23:59:30` and the
row's `dayKey` is `2026-12-31`, but the case's extractor returned `"?"` for all
three boundaries:

```
actual=["?","?","?"]   expected=["20261231","20270101","20280229"]
```

So the assertion is comparing an unparsed token, not a wrong date. Class: **stale
spec** — repair the extractor so it reads the printed `DD/MM/YYYY` format and still
asserts the three boundary dates (the assertion itself is not weakened).

### `MNY-25` — real, and on the money path (STOPPED as required)

The case exercises Kredy instalment plans (`Σ entries == total`, remainder to the
earliest, early payoff fills FIFO and closes the plan). It fails in isolation, so it
is a real gap, not ordering. Because the fix would touch the debt-plan money lane,
the standing rule ("if a fix risks the money path, STOP and report first") applies:
the root cause is characterised but **not** patched.

Observed context from the isolated run:

```
[MNY-25] entry: reload=true shell=mobile demo=true kredyTab=true
[MNY-25] debtor card (col=0, ledger=1000): "...Ooredoo 1000 DA  Plafond 100000 DA  recouvrer  Score 40 ..."
```

The plan header/entries are created through the native `save_debt_plan` lane; the
suspicion is the mobile Kredy surface reading the plan back before the header lands
(the lane writes entries + header in one transaction, so a read-after-write through
the renderer should see both). Needs the assertion diff and the plan rows to confirm.

## Reconciled state after task 1

| Bucket | Count |
|---|---|
| baseline-PASS now failing | 10 |
| — ordering/seed pollution (fix the harness) | 8 |
| — real, spec-side (`TIM-03`) | 1 |
| — real, money path (`MNY-25`, stopped for report) | 1 |
| remaining real gaps (baseline FAIL) | 68 |
| baseline BLOCKED | 1 |
| hook/unattributed | 15 |
| scale specs | 9 |

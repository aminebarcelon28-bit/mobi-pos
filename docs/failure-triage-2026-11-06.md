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

## MNY-25 — root cause (rows first)

### Assertion diff

The isolated run fails at `11-mny-money-part2.e2e.ts:1130`:

```
Error: boot heal did not repair customers.current_debt from the ledger
  at e2e-tests/specs/11-mny-money-part2.e2e.ts:1130:5
```

The preceding assertion passed: the debtor card rendered `… Ooredoo 1000 DA …`
(payload/ledger path), and the failing one is the poll
`colDebt() === 1000` on the `customers.current_debt` **column**.

### Fixture shape (verified in the spec)

```
seedCustomerFull: currentDebtDa 1000, currentDebtColumnDa 0, debtLimitDa 100000
seedCustomerDebts: one DEBT_ACQUIRED 1000, balanceAfter 1000, deleted = 0
then: run('UPDATE customers SET current_debt = 0 WHERE id = ?')
then: browser.refresh()            // page reload, NOT a process restart
```

So the fixture is legal: the ledger row really is `deleted = 0`, which is the only
predicate the native repair needs.

### Native repair SQL (correct, and not the defect)

`src-tauri/src/boot_maintenance.rs:56-79` runs, inside the startup transaction:

```sql
UPDATE customers SET current_debt = (SELECT COALESCE(SUM(CASE WHEN d.type='DEBT_ACQUIRED'
  THEN d.amount WHEN d.type='PAYMENT_SETTLED' THEN -d.amount ELSE 0 END),0)
  FROM customer_debts d WHERE d.customer_id = customers.id AND d.deleted = 0)
WHERE EXISTS (SELECT 1 FROM customer_debts d WHERE d.customer_id = customers.id AND d.deleted = 0)
  AND COALESCE(current_debt,-1) <> (<same sum>)
```

That statement satisfies the case's requirement; it is not wrong.

### Root cause — a behaviour-timing conflict, not a write defect

The repair is part of **native startup** (`run_at_startup`). `browser.refresh()`
reloads the WebView; the Tauri backend — and therefore boot maintenance — does not
run again. Before the SEC-01 migration series the renderer performed an equivalent
heal on every page load, so a reload re-repaired the column; that renderer write is
gone (it is exactly the kind of write the flip retired), and the native replacement
runs once per process.

Therefore the case measures `repair-on-page-reload`, while the shipped design now
provides `repair-on-process-start`. The card is right, the ledger is right, the
column is stale **because nothing repaired it on this reload**.

### Why this is a STOP under the MNY-25 guard

The frozen assertions are untouched, no schema is involved, and the ledger/plan data
is correct — but making the case pass requires **changing when the cache repair
happens** (add a page-load repair), which is a behaviour change on a money-adjacent
surface. The ruling's guard is explicit: "no semantics change — if the root cause
demands one, STOP with a plan, don't patch".

### Plan (awaiting go-ahead, two options)

**Option A (recommended, no semantics change to money math):** expose the existing
startup statement as a native command (`repair_customer_debt_cache`) and call it
from the renderer's boot hydration path. The repair stays a single native UPDATE on
the same table with the same predicate; only *when* it runs changes (per page load,
restoring the pre-migration behaviour). Pinning: the existing boot-maintenance Rust
tests plus an end-to-end check that the command repairs a stale column and is a
no-op when it already agrees.

**Option B (no product change):** re-point the fixture at a real app restart instead
of `browser.refresh()`, so the case measures the shipped boot behaviour. This
changes the test, not the app — and must be argued as "the case's stated subject is
the boot heal, which the app still performs", not as a weakening of the assertion.

Both keep `Σ entries === total`, the remainder-to-earliest rule, the FIFO payoff and
the no-fee model exactly as asserted.

## Task 2 — MNY-25 fixed (Option A, native repair-on-reload) — E-0217

Ruling executed: the startup statement was lifted byte-for-byte into
`boot_maintenance::REPAIR_DEBT_CACHE_SQL` and exposed as the native command
`repair_customer_debt_cache` (registry 118 → 119, capability
`OperationalWrites`). The renderer calls it exactly once per boot hydration
(`createUISlice.initDatabase`, after shift adoption). No new SQL, no schema
change, no message-path change; only WHEN the same UPDATE runs.

Evidence:

| Check | Result |
|---|---|
| `cargo test --lib customer_lane` | 9 passed (stale repaired once, consistent cache no write, tombstoned debts ignored, two-connection convergence: exactly one caller reports a change) |
| `cargo test --lib boot_maintenance` | 13 passed (the startup call site uses the same const) |
| MNY-25 isolated | 3/3 GREEN (`mny25-iso-1..3`), column repaired after `browser.refresh()` |
| MNY-25 chained (full spec 11) | 6/6 GREEN (`mny25-chained-1`) |
| Money battery (10/20/30/31/32/33/34/71) | 118/121, MNY-25 GREEN; failures are the known gaps (PAY-11) and ordering cases (REF-14, REF-36 — both pass alone) |
| sql-boundary | 301 ≤ 301 (the command adds no SQL text) |
| `cargo`, `tsc`, `lint` | green, 0 errors |

Red-before is the run already on record at `79c294c`
(`2026-11-06T00-59-16-210Z-iso10-MNY-25.log`: `boot heal did not repair
customers.current_debt from the ledger` at `11-mny-money-part2.e2e.ts:1130`);
the only delta to the green runs is the restored boot-hydration call plus its
native command. `prove-fix.mjs` could not be used: it aborts because
`src-tauri/Cargo.lock` is not tracked in this repo (`git stash push` pathspec
fails before any build) — recorded here rather than silently skipped.

## Task 2 — TIM-03 fixed (stale extractor) — E-0218

The app was right all along: `Date: 31/12/2026 23:59:30`, dayKey
`2026-12-31`. The case read a date token out of the receipt NUMBER
(`/-(\d{8})-/`), which the current numbering scheme
(`PREFIX-SERIES-SEQ6`, e.g. `REC-M0YF-000001`) does not carry. The extractor
now reads the printed `Date:` line through `receiptDayFromPrintedLine`
(`e2e-tests/lib/receiptDate.ts`), day-first per the product's fr-DZ format.
The three expected values are untouched.

Pins (`e2e-tests/lib/receiptDate.test.mts`, 8/8): `20261231`, the
`20270101` rollover, `20280229`, the day-first control (never
`20263112`), padding, and the absent-date fallback. Registered in
`test:oracle`.

Run: TIM-03 isolated 3/3 GREEN (`tim03-iso-1..3`), verdict PASS-PARTIAL as at
baseline (the week-start setting genuinely does not exist).

## Task 3 — harness isolation, first evidence (in progress)

A chained probe of the eight ordering suspects plus their neighbours
(`order-probe-1`: specs 20, 31, 33, 50, 70, 82, 84 in one process) reproduced
the class:

| Case/hook | Symptom | First diagnosis |
|---|---|---|
| REF-36, REF-14 | `[data-testid="refund-search"] still not displayed after 10000ms`; both pass alone | `refundSearch` takes `$(tid('refund-search'))` — the FIRST DOM twin. The modal renders a mobile card list and a desktop table with the same testid and one is `display:none`; after an earlier case leaves the shell in the other mode the first twin is the hidden one. The other helpers already filter by computed visibility. |
| INV-01, REP-03 (and their `before all` hooks) | `INV boot unlock failed` / `SAV boot unlock failed` | the lock screen is up and the admin PIN no longer unlocks it after the SEC spec ran lockout cases — durable lockout state leaking across specs. |
| SEC-05 | `expected 105, received 0` (audit-chain tamper audit rows) | audit entry count differs after earlier specs; needs the same seeded-fixture treatment before it can be called real. |
| CRM-03 / CRM-06 | `expect(...).toBe(...)` failures | under triage; both pass alone. |
| PAY-11 | `expect(received).toBe(expected)` | known real gap (staged-credit leak cluster C04). |

Counts reconcile: the 15 unattributed hook failures are this same cross-spec
residue (lock screen/PIN lockout, modal twins), not separate defects.

Next: fix `refundSearch` to bind the visible twin, give the lockout-using spec a
residue cleanup so later specs unlock, then re-run the probe three times.

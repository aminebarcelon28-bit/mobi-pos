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

## Task 3 — harness isolation: what the probes proved (E-0219)

Three probes, each a clean wipe, one process per spec, ordered like the sweep:

| Probe | Specs (order) | Result |
|---|---|---|
| `order-probe-1` | 20, 31, 33, 50, 70, 82, 84 | 56/61; REF-36 `refund-search` timeout, SEC-05 `linksVerified 0/105`, CRM-03/06, PAY-11; INV-01 + REP-03 died in `before all` ("boot unlock failed") |
| `ref-twin-fix-1` | 31, 33 | **33/33 GREEN** — REF-14/35/36/41/60 all pass chained (2 more runs queued) |
| `hook-probe-1` | 70, 82, 84 | 23/45: with CRM first, INV-03/06/12/13/17 and 14 REP cases fail; with SEC first, INV/REP fail at boot instead |

### Fixed: the refund-search twin (REF-14/35/36/41/60)

`refundSearch` bound `$(tid('refund-search'))`, the FIRST DOM match. The modal
renders a mobile card list and a desktop table with the same testid, one
`display:none`; after an earlier case leaves the shell in the other mode the
first match is the hidden twin and `waitForDisplayed` times out. The helper now
binds the displayed twin (and logs when it had to skip a hidden one), matching
what `refundDialogVisible`, `forceCloseRefund` and `selectRefundTicket` already
did. Verified: 31 + 33 chained, 33/33 green, where 31 previously failed 1/15 and
the battery failed 2.

### Fixed: lock-screen PIN entry focus (the `before all` hook class)

The hook error was `login-submit ... not clickable` followed by
`INV/SAV boot unlock failed`: `unlockIfNeeded` focused the pad and used
`browser.keys`, which lands wherever focus is after a long chained spec, so the
controlled PIN input stayed empty and the submit never enabled. The helper now
proves the digits reached the input and falls back to the native setter (the
same discipline as `refundSearch`), failing loud with the digit count instead of
a 20 s timeout. Typing cannot escalate the native lockout; only a submit can.

### Still open — the real isolation defect

The probes show the specs are not independent: with 70 first, five INV cases and
fourteen REP cases fail; with 50 first, INV/REP fail to unlock; SEC-05's audit
walk verifies 0 of 105 links after earlier specs reset the DB (the native chain
anchor is process-global and outlives a data reset, which the spec's own
"fresh-container contract" comment acknowledges). This is not one helper bug but
the fixture model: each spec seeds what it needs only sometimes and otherwise
relies on residue. The fix is per-spec ownership of fixtures and a reset that
also re-anchors the native audit chain — a 48-spec change, queued, not faked.

## Task 4 — census re-run, re-attribution, and the STOP call (E-0221)

The census is the same container as the rc-12 tag-run: 43 spec files (the five
`23-scl-scale-*` files stay process-isolated, E-0208, out of scope here), one
wiped sandbox, chained in filename order.

| Sweep | Specs | Cases | Red total | Case-level | Hooks |
|---|---|---|---|---|---|
| tag-run (rc-12, `382c1bf`) | 43 | 336 | 94 | 79 | 15 |
| census-43 (`f256598` tree, `14-11-34Z-census-43`) | 43 | 335 | 107 | 85 | 22 |
| ⇒ after the two harness regressions below | 43 | 335 | ≈101 | ≈79 | ≈22 |

### Re-attribution of the 15 hooks

The hook bucket was not "15 unknown failures"; it was hiding case rows. The
clearest case: `60-idn-identity` died in its `before all` in the tag-run
(`script timeout`, one hook), so IDN-01…22 never reported. With the sanctioned
reset in place the spec executes and reports **17 case-level FAILs**, every one
a baseline-FAIL row (`IDN-01` rejected only the name string on the document;
transactions carry no identity columns). One hook became seventeen accounted
rows — the accounting is better, the count is higher.

The other hooks are named now, not unknown:

- `login-submit` "did not become interactable" / `login-pin-pad`: WDIO's
  clickable middleware never settles on the lock screen after a chained
  predecessor (5–6 occurrences). The helper now JS-clicks the displayed,
  enabled submit and fails loud when none is clickable, which collapsed the
  IDN and (partly) INV boot hooks.
- `SAV boot unlock failed` / `INV boot unlock failed`: the residual subset of
  the same class, still present on 82/84 after 50 (`hook-collapse-2`).
- three `no boot screen mounted`, one `27a` screenshot ENOENT (temp dir), one
  drawer click intercepted: environment/interaction, each now carries its spec.

### Two harness regressions this census found (fixed)

1. `__name is not defined` in injected page scripts: the first unlock patch
   used a named inner arrow inside `browser.execute`; the TS transform emits
   `__name(...)` and the page context has no such helper. Six MNY cases failed
   in the census. Fixed by removing every named closure from the injected body
   (MNY 6/6 green in `regress-check-1`).
2. `resetData()` ran before the session existed, so `audit_reanchor` /
   `repair_customer_debt_cache` (OperationalWrites) were refused for specs whose
   `before` starts locked. The helper now completes setup / unlocks **first**,
   then wipes, then re-anchors ("post-reset == post-boot").

### REF-51 measured (no budget bump)

Three isolated runs on this tree: **84 s, 80 s, 59 s** (median 80 s), against the
300 s mocha budget — the tag-run failure was the shared 300 s wall only because
31+33 were chained in one process. The REF-87 600 s precedent is **not** used:
no cap change, no weakening. The third run flaked on `selectCustomer`
(customers dialog never opened), which is the interaction class above, not a
timeout.

### STOP — chained variance did not collapse

Per the standing rule, this is a stop-and-write-up, not another loop:

- `50 → 60`: IDN now runs (17 baseline-FAIL rows) — hook collapsed. ✅
- `50 → 82/84`: `INV/SAV boot unlock failed` persists after the submit fix
  (`hook-collapse-2`: 32 cases, 15 pass, 17 IDN baseline FAILs, 2 spec hooks).
- `census-43`: 34 spec files red; the residue is the renderer interaction layer
  (lock-screen/shift controls not interactable after a chained predecessor), not
  the DB and not the audit chain. The audit class is fixed: SEC-05 is green
  isolated **and** chained, and every reset is logged with the retired head.

The honest position: the reset/session model is now correct (one helper, wipe +
re-anchor + debt repair, session restored first), the audit-chain class is
closed, IDN's hidden failures are accounted, and the remaining chained variance
is concentrated in one harness interaction class that needs its own pass (WDIO
clickable middleware on the lock screen / shift controls). No tag, no rc-13.

## Task 5 — B1/B2 closed with visual evidence; the licence latch is a STOP sub-item (E-0222/E-0223)

### Visual evidence first

Every failing case and every failing hook now writes
`results/artifacts/<stamp>/<spec>/<case-id>[.before-all|.after-all]{.png,.full.png,.html,.json,.log}`:
viewport PNG, full-page PNG (window grown to document height — no CDP bridge in
this session, so the JSON records any clamp), DOM, console tap, error, and
element diagnostics (the element named in the error, `elementFromPoint` at its
centre, visible overlays/controls). Masking runs before writing and
`scan-pii.mjs` reports **clean** for every stamp (552 text files re-masked for
the pre-mask captures).

### B1 — the pad was not clickable because the lock screen shows the PROFILE GRID

The screenshot
`2026-11-06T16-58-14-663Z/82-inv-inventory/INV-01.png` shows the real state:
the lock screen lists every profile (E2E Gerant / SEC A / SEC B / IDN A …) and
the PIN pad is not the interactable surface; WDIO refused `login-pin-pad`
("did not become interactable") because the grid covers the pad's centre.
Fix: `unlockIfNeeded` focuses `login-pin-input` in page context (the pad's
own onClick does exactly this) and keeps the digit-count proof + native-setter
fallback; the submit is JS-clicked on the displayed, enabled twin. Result:
`50 → 82 → 84` x3 → 31 passing / 23 failing with an **identical** case set each
run and **zero boot-unlock hooks** (the 20 INV/REP rows are baseline FAILs).

### B2 — customer picker

`selectCustomer` now clicks the displayed `clients-button` in page context,
waits up to 5 s for the dialog, retries 3x after closing stale dialogs, then
falls back to a displayed WebDriver click, and finally throws with the visible
controls/dialogs instead of a bare 20 s timeout. REF-51 isolated **3/3**
(73.2 s / 72.9 s / 74.8 s) — no budget bump.

### STOP sub-item — licence clock latch after the clock spec

Sweep A (43 specs) ran only 190 of 335 cases: from `27a-scl-batch` onward every
spec booted to the **licence gate**:

- screenshot `2026-11-06T17-44-32-985Z/unknown/before-hook-…SCL-27….png`:
  "Accès Temporairement Suspendu — Horloge appareil incohérente avec les ventes
  enregistrées — vérification requise", status **SUSPENDUE**.
- cause: `26-rcp-tim` deliberately writes sales under fake clocks
  (31/12/2026, 01/01/2027, 29/02/2028, +5 min mid-sale). The native licence
  clock guard compares the wall clock with those recorded sale times and
  latches suspended — **fail-closed product behaviour, not a harness bug**.
  `TIM-07` alone does not latch it (27a ran 25/25 straight after); the latch
  needs the clock spec's future-dated sales.
- why not patched: recovery needs a supervisor-signed time re-anchor
  (`trust_reanchor_time`) the harness cannot mint, and the guard must not be
  weakened. The plan is (a) a supervisor-signed re-anchor fixture for the clock
  spec, or (b) keep the clock spec out of the shared process — which is what is
  done here, exactly like the `23-scl-scale-*` isolation: `26-rcp-tim` runs as
  its own process, its cases stay in the census, and the chained suite is
  measured without a licence latch that has nothing to do with the code under
  test.

## Task 6 — two chained sweeps on the final tree: 2-row variance → STOP (E-0226)

Same container both times: 42 spec files (the five `23-scl-scale-*` stay
process-isolated, and `26-rcp-tim` runs as its own process per the licence-latch
STOP above), one wipe, filename order, `retries: 0`.

| Run | Cases | Passing | Red total | Case-level FAIL | Hooks |
|---|---|---|---|---|---|
| tag-run rc-12 (43 specs) | 336 | — | 94 | 79 | 15 |
| census-43 (43 specs, pre-fix) | 335 | 258 | 107 | 85 | 22 |
| sweep B (42, pre-race-guard) | 436 | 336 | 127 | 130 | ~10 |
| **sweep E (42, final)** | **471** | **373** | **131** | **133** | **10** |
| **sweep F (42, final)** | **464** | **367** | **130** | **133** | **11** |

### Variance: two rows, not zero — STOP

`E ∩ F` is 131 of 133; the difference is exactly:

- **only in E**: `IDN-13`, `REF-36` — both **pass isolated** (IDN-13 2m18s,
  REF-36 57s), so ordering.
- **only in F**: `CRT-15`, `SEC-07` — SEC-07 **passes isolated** (30s);
  `CRT-15` **fails isolated** and its cause is now named: `addSku`'s
  page-context JS-click fallback fires while the **payment dialog is open**
  ("native tile click intercepted … open dialogs: [Encaissement et règlement]"),
  and a page-context `element.click()` ignores hit-testing, so the tile behind
  the modal is clicked and the cart grows. That is a harness defect (the same
  page-click-bypasses-the-overlay class as B1/B2), not a product gap.

Per the standing rule this is a **STOP-and-write-up, not a retry**: chained
variance is 2 rows, the failure set is not identical across the two runs, so the
line is not green and no tag is cut. The queued fix is narrow: `addSku` must
refuse the JS-click fallback while a blocking dialog is visible and re-check the
dialog after the click.

### Census (sweep F, `scripts/triage-failures.cjs <log>`)

```
failing cases: 120   real-gap: 107   REGRESSION?: 9   BLOCKED: 1   N/A: 3
real gaps by prefix: CRM 2, DAT 28, IDN 14, INV 4, LOY 7, PAY 1, RCP 1,
                     REF 4, REP 16, SCL 9, SYN 3, TIM 1, TIN 6, WAR 14
```

The 9 baseline-PASS rows failing in the chained run are CRM-04, CRT-15,
IDN-12, IDN-15, IDN-16, LOY-13, PAY-21, REF-35, SEC-07. Directly measured:
REF-35/IDN-13/REF-36/SEC-07 pass isolated; CRT-15 fails isolated (cause above).
The rest were already in B1's 3x-stable INV/REP chains or the earlier ordering
set and need their own isolated confirmation.

### Hooks, each named (F)

`INV-17 after-all` and `REP-16/G-26 after-all` are invariant checks firing on
their own failing case; `PROBE-4` and `WAR-28` after-all are the same G-26
invariant in the probe/warranty specs; `PAY-21` after-all is the PAY batch-2
invariant set (G-32/G-34/G-20); `CRM-04` after-all is G-23. The two
`DRW` before-all "script timeout" hooks are the 300 s budget on a chained
drawer spec, and `HARNESS smoke` saw one `SqliteError` at reset (the wipe
racing the app's WAL write) plus one scan-double-dispatch after-all. Each has a
screenshot under `results/artifacts/<stamp>/<spec>/`.

### Bookkeeping gap found

`verdicts.mjs --write-index` **refuses** this sweep: the log carries
`ROBE-06..09`, ids that are not in `CASE_INDEX.csv`. The writer refusing is
correct (no hand-typed verdicts), so CASE_INDEX/COVERAGE are untouched and that
id family needs a ruling before the census can be stamped.

## Fix pass — corrected arithmetic and the page-click guard (E-0227..E-0231)

### The census number is 134, not 120 and not 133

`scripts/triage-failures.cjs` now treats a case's own declaration as
authoritative and only counts real failure lines:

- 4 census rows were **verdict=PASS false positives** (`CRM-04`, `PAY-21`,
  `REF-35`, `REF-67`): the old regex matched the word `FAILED` inside console
  payloads (`PERSISTENCE_FAILED`, "refused fail-closed").
- `DAT-70` is **BLOCKED** (no previous-version installer); its helper throws, so
  it is a resource gap, not a failure.
- 19 rows were **missed entirely** because they only emit
  `VERDICT=<ID> FAIL` (`DAT-34`, `HW-01`, `I18-01/03/09`, `SCL-02/03/04/06/10/23/27/31/57/62/71/74/76/88`).
- `REP-16` is a **real failure**: its body assertion fails; the passing case in
  the same file is `[REP-16/G-26]`, which the unanchored id regex used to
  cross-match. Anchoring the regex (`\[([A-Z][A-Z0-9]{1,3}-\d{2,3})\]`) fixed both
  this and the `ROBE-06..09` artefact from `[PROBE-06..09]`.

So: **134 = 115 case-level + 19 VERDICT-only**, and the six old extras resolve
to 4 PASS + 1 BLOCKED + REP-16 staying red.

### Page-click guard (CRT-15)

`pos.ts:clickTile` used to log the open dialog and then fire `el.click()`
anyway; `Element.click()` bypasses hit-testing, so a product tile behind the
payment dialog was added to the cart. The fallback now asks
`clickGuardDecision` (pure, unit-tested) against a probe of the displayed twin,
`document.elementFromPoint` at its centre and the visible dialogs, and throws a
typed `ClickRefusedError` naming the dialog. CRT-15 was RED before
(`crt15-before`) and GREEN 3/3 after, e.g.:

```
[addSku:tile] refused: refuse BLOCKED_BY_DIALOG via pay-dialog
  (centre is covered by dialog pay-dialog, target product-tile is behind it)
[CRT-15] addedBehindModal=false lines=1
```

The same helper routes `clearCart` (sequential, refuses behind a modal),
`sav.ts` (boot unlock, repair modal open/close, history tab, intake open, save,
inspector open/close/lookup) and the spec-local lock clicks in
50/51/60/65/66/70/71/75/80/82. `guard-chain-1` exposed one false refusal — a
lock-screen profile card above a lingering pay dialog — which is now an
explicit unit case: a real element at the click point wins over the dialog list.

### Fixed in this pass

| Case | Root cause | Evidence |
|---|---|---|
| CRT-15 | page-context fallback clicked through the pay dialog | E-0228 |
| INV-12 | baseline row asserted the importer was absent; it ships (`InventoryManagerModal.tsx:464-472`) | E-0229 |
| DAT-28 | `PRAGMA quick_check` ran on the read-only WebView pool; FTS5 validation needs a temp write | E-0230 |
| RCP-06 | `printReceipt` discarded `directPrintReceipt()`/`printViaWindowsSpooler()`'s boolean, so a failed reprint toasted success | E-0231 |

### Still open (grind), with the first measured cause

- `PAY-11`: the final walk-in sale leaves the pay dialog open and the G-32/G-34
  invariant fires (`current_debt=500 != payload=100000` for `PAY-CUST-L`) — a
  staged-credit/debt-cache defect on the money path; needs its own change with
  the ledger snapshot before/after.
- `DRW-01..27`: these cases did not execute in sweep F (both drawer specs died
  in before-all on the 300 s budget), so they are newly visible product gaps:
  `DRW-01` shows `name=true float=false sessionId=false openTime=true
  drawerId=false` on the mobile drawer view.
- `IDN-14/15/16/18/20/22`: middleware "did not become interactable" / script
  timeouts remain for those six; the lock clicks they depend on are now guarded,
  so the next isolated pass can rule each one.
- The remaining DAT/WAR/REP/SCL/TIN/LOY/SYN rows are the backlog enumerated in
  the sweep-F census; DAT-40/48/82 stay STOP-PLAN (raw Node SQL probes).

## Full sweeps G / H / I — arithmetic and the stability stop (E-0235, E-0236)

| Sweep | Cases | Pass | Fail (runner) | Case FAILs | Refusals |
|---|---|---|---|---|---|
| G | 460 | 371 | 132 | 136 | 0 |
| H | 460 | 372 | 130 | 135 | 0 |
| I | 460 | 378 | 124 | **129** | 0 |

`G ∩ H` is not the whole set: `CRT-09/13/22` failed only in G (native
`checkout-button`/`cart-clear` clicks intercepted by a toast) and
`REF-36/65` only in H (`stale element reference`; `refund search input is not
displayed`). That is a 5-row variance, so per the rule this is a stop, not a
retry.

`I ⊆ H` exactly: nothing new failed, and six rows flipped green —
`PAY-11` (staging cleared on cancel + the debt fixture now has its ledger row),
`SEC-11/12/16` (the off-viewport guard rule) and `REF-36/65` (interaction
races). The fixed rows are now PASS in `CASE_INDEX.csv`/`COVERAGE.md`
(`CRT-15`, `INV-12`, `RCP-06`, `PAY-11`, `SEC-07`), dashboard FAIL 203 → 198,
reconcile 0/687.

Remaining red set (129): DAT 29, IDN 19, REP 16, SCL 23, WAR 14, LOY 8, TIN 6,
INV 4, SYN 3, CRM 2, HW 1, I18 3, TIM 1. `DAT-28` stays red on its second
assertion: no startup/daily `quick_check` exists in the TS app or native boot
maintenance (only export-time `integrity_check`), so silent corruption is not
scheduled — a real product gap, not a lane defect.

Next stability work is interaction hardening, not product: bind
`checkout-button`/`cart-clear` through the guarded page click, and make
`refundSearch` wait for its input to mount before failing. Then two clean
sweeps.

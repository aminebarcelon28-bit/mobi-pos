# Human actions — c01-rc6 work

## STATUS 2026-11-03 — HAR-001/007/008/009 closed in-tree

- **HAR-001 → CLOSED:** D1 = B′ applied (unwrap 2996/2998, cap 54→56, clamp matrix). Money gate
  **65/65**, cash terms **32/32**.
- **HAR-007 → CLOSED:** zero-tax re-pinned and converted to content anchors (full `src-tauri/src`
  scope). **23/23**; new-line-fails / moved-line-passes / edited-line-fails controls proven.
- **HAR-008 → CLOSED:** SHF-05 backdated two days; 48-slot sweep proves clock independence;
  `40-shf` **12/12**.
- **HAR-009 → CLOSED:** REF-19 (native-setter PIN entry), REF-17 (OS-keyring lockout blob cap →
  prune+bound; failing-then-passing Rust test), refund-value checker (debt-relief lane; negative
  control proven), 60–75 boot-marker wait (DRW-24 interceptor named), CRM-02 unique-per-run
  fixtures. Spec 30 **12/12 with 0 money violations**.
- **OD-001 → CLOSED by owner:** `c01-rc-5` is superseded by `c01-rc-6`; no waiver, tag untouched.
- **D2/D3:** closed as decided (state-based wait; design tokens not a criterion).
- Remaining owner-only items: HAR-002 (printer), HAR-003 (merchant gateway), HAR-004 (SYN-02
  numbering rule).

## HAR-001 — money-boundary gate: 58 vs 54 (owner decision) — corrected 2026-11-02

- **What:** `node scripts/check-money-boundary.mjs` is **64/65**, failing on
  `src/store/slices/createOrderSlice.ts: 58 <= 54`.
- **Corrected provenance (verified, replaces the earlier attribution):** the four extra hits did
  **not** arrive with `8c1fcf4` — the file already had 58 there. They arrived with **`177e6b1`**
  (REF-66 Avoir leg, 2026-11-01 08:26): `54 -> 58`, and no later commit changed the count.
  `177e6b1` is an ancestor of `c01-rc-5`; the script, registry and slice are byte-identical at
  `c01-rc-5` and `HEAD`. **The CI-blocking money gate is therefore also red at the existing
  candidate.**
- **Exact four lines (177e6b1):** `reliefPlanned`, `voucherPlanned`, `cashPlanned`, and the
  `Math.round(netRefund)` term of `uncoveredCredit` (`createOrderSlice.ts:2996-3001`).
- **Unit analysis:** `RefundFundingSplit` returns **DA floats** (`fromMinor` divides centimes by
  100). `voucherShare` and `netRefund` are such floats, so their `Math.round` is a semantic
  integer-DA conversion, not a redundant wrapper. `relief` (`reliefAmt`) and `cashOut`
  (`clampCashRefund`) are already integers, so those two wrappers are redundant — but removing
  only them leaves **56 > 54**, and removing all four would let fractional DA reach the native
  `i64` balance gate (`refund.rs` pre-COMMIT conservation) — a behavior change, not an
  equivalence.
- **Decision needed:** which of these is authorized?
  - **(B, recommended) reconcile the registry 54 → 58**, with a comment naming `177e6b1` and
    stating the four hits are integer-DA boundary conversions of a float-DA split type; then a
    separate Stage E task unifies refund money on minor units. Rationale: the code is already in
    `c01-rc-5`; the cap is stale, not the code new.
  - **(A) Stage E refactor** of `RefundFundingSplit` + this slice to minor units, with
    fractional-cent boundary tests: larger, changes money-path code, needs its own brief.
  - **(C) waive the gate** for `c01-rc-6` (and state the disposition of `c01-rc-5`, which shares
    the same failure).
- **Time:** B ≈ 1 min + CI run; A ≈ 1–2 days with tests; C = decision only.
- **Unblocks on approval:** the money gate and its CI jobs. It does **not** by itself make
  `c01-rc-6` ready — the 50-sec reproducibility blocker (HAR-006) must also be cleared.

## OD-001 (open item) — standing of the already-tagged `c01-rc-5`

- **Fact:** `c01-rc-5` (`51c9c70`) carries the **same** red `check-money-boundary` (58 vs 54;
  177e6b1 is an ancestor) and a red zero-tax gate (6 sqlPluginAdapter whitelist entries were
  already stale at that tree). The money gate is a blocking CI job in `five-target-ci.yml`.
- **Question (not answered by this task):** does `c01-rc-5` stand as-is (retroactive waiver),
  is it superseded by `c01-rc-6` once green, or should it be withdrawn? Tags must not be moved
  or deleted without explicit authorization.
- **No action taken.**

## HAR-007 — re-pin the zero-tax whitelist after line shifts (needs authorization)

- **What:** `node scripts/test_zero_tax.mjs` is **21/23**: the line-pinned whitelist is stale.
- **Provenance:** six `src/db/sqlPluginAdapter.ts` entries were already stale at `c01-rc-5`
  (pinned 2417/2419/4000/4001/4013/4014; actual tokens 2420/2422/4003/4004/4016/4017).
  Five `src-tauri/src/lib.rs` entries went stale **because of R1**: the guards added at
  `lib.rs:391` (+3) and `lib.rs:831` (+6) shift every later line by +9 (pinned
  1048/1622/1626/1636/1640; actual 1057/1631/1635/1645/1649).
- **Exact change (11 line numbers, no content change, no new allowances):**
  sqlPluginAdapter +3 on the six entries; lib.rs +9 on the five entries.
- **Why it needs authorization:** it is an allowlist adjustment, which the directive reserves.
  It is bookkeeping repair, not a relaxation: the same 72 tokens remain whitelisted.
- **Alternative:** leave the gate red (it blocks `npm test` → CI just like the money gate).

## HAR-005 — design-token ratchet — DECIDED (D3): not a release criterion

- Recorded owner decision (2026-11-03): **not** a release criterion for `c01-rc-6`; record as
  inherited debt; **no baseline refresh**. No further action on this candidate.
- Kept here for traceability: 39 files (24 over baseline, 15 newer than the 2026-10-16
  baseline), debt identical at `c01-rc-5` and HEAD (5975 items, zero per-file deltas).

## HAR-006 — authorize the E2E unlock-wait fix and a 3× re-run (verification blocker)

- **What:** `50-sec` is not reproducible: 4/10 twice and 0/1 when SEC-01 runs alone, on product
  code identical to the reported 10/10 run. `repeat-run.mjs --from-sidecars` classifies it
  **FLAKY** (SEC-01/02/03/04/06/09: PASS → FAIL → FAIL). `40-shf` is 11/12 (SHF-13 fails at
  `resetDrawerForTest` → "RECONCILIATION step never appeared").
- **Measured root cause:** native `pin_verify` on this host takes **3089–3210 ms** (5 samples;
  OS keyring + Argon2id). `unlockViaProfile` gives the overlay only **2500 ms**
  (`50-sec-authorization.e2e.ts:3191`), then looks for `login-submit` — which a cashier pad never
  renders — and throws. The unlock itself succeeds: audit row
  `AUD-1793635115685-611ff7a4` ("Session ouverte par SEC A (cashier)") and
  `cashier_users` shows `usr-sec1 role=cashier` with a v2 PIN.
- **Prepared change (not applied — needs authorization):** in the `unlockViaProfile` twin helpers
  (50-sec, 40-shf, 51-sec):
  1. when `login-submit` is absent, do **not** throw — the pad auto-submitted; fall through to the
     existing 20 s overlay wait;
  2. widen the first `cleared()` probe from 2500 ms to 15000 ms.
  No assertion, seed, or product code changes; no retries added (the repo's own rule: wait on
  state, not time).
- **Then:** 3 consecutive clean runs of 50-sec + 40-shf (repeat-run must say STABLE), and only
  then can the security/shift suites be counted for disposition.
- **Decision needed:** authorize this test-harness change and the re-runs (yes/no). It is outside
  the two static-gate blockers this directive scopes, which is why it is not applied.
- **Note:** the 3.1 s unlock latency is also a product-performance observation for low-end
  hardware; it does not weaken any security guarantee (the verdict and principal are correct).

## HAR-008 — SHF-05 is wall-clock dependent (diagnosed; needs authorization)

- **Symptom:** `40-shf` = 11/12 in three consecutive runs; the failing case is **SHF-05**, at
  `40-shf-shifts.e2e.ts:3545`, `expect((closedMs - openedMs) / 3600000).toBeGreaterThan(8)`.
- **Cause:** the test backdates the open to **yesterday 23:50 local** (`Date.now() - 24h` then
  `setHours(23,50)`). It only has an >8 h span when the suite runs after ~07:50 local. The three
  runs at ~01:15 local saw a 1.43 h span. The earlier 13:28 run passed; SHF-13 (the case that
  failed before the harness fix) is green in all three runs and passes standalone/trio.
- **Not a product defect:** the shift really does span midnight; only the harness premise assumes
  a time of day. No product assertion is implicated.
- **Proposed change (not applied — needs authorization):** backdate by **two** days
  (`Date.now() - 2*24*3600*1000`, keep `setHours(23,50)`), so the span is ~25 h at every hour;
  the `> 8` assertion and the case intent (crossing midnight) stay untouched. Alternative: run
  this suite only in the 08:00–23:59 window (operationally brittle).
- **Why it needs authorization:** it edits a test's setup. It is a premise fix, not an assertion
  change.

## HAR-009 — owner-requested suite runs: five PASS→FAIL deltas, all test-side

The twelve suites (30–34, 51, 60, 65, 66, 70, 71, 75) ran on binary `7ac204d`. `delta.mjs`
found **no regressions** in 31/32/33/34/71 and **two improvements** in 75 (LOY-04 FAIL→PASS,
LOY-06 PARTIAL→PASS). The only PASS→FAIL deltas and their isolated re-runs:

| Case | Full suite | Isolated | Classification |
|---|---|---|---|
| REF-19 (30) | `refund-pin` field never mounted | **PASS** | order-dependent state leakage (flake) |
| IDN-12 (60) | mobile shell accepted the old PIN | **PASS** | order-dependent (mobile-shell state from earlier cases) |
| DRW-08 (65) | `shift-open-dialog` never appeared | **PASS** | order-dependent (UI state) |
| DRW-24 (66) | reconciliation step never appeared / click intercepted | **FAIL** | `element click intercepted` on `shift-blind-input` — overlay/actionability race |
| CRM-02 (70) | expected 0555000000, got 0550123456 | **FAIL** | test-authoring bug: fixture types `+213 550 12 34 56`/`00213 550 12 34 56` but asserts `0555000000`; also trips **G-23** (duplicate phone), so it cannot pass as written |

- **No product regression attributable to R1** was found in these suites. The three order-dependent
  cases and the two deterministic test-side cases are evidence-infrastructure work, not rc-6
  product changes.
- **Unproven baselines:** `CASE_INDEX` marks IDN-12, DRW-08, DRW-24 and CRM-02 PASS **without a
  `verdict_run`**. They were never stamped by a run; the new failures are real measurements against
  an unproven baseline, which is why no verdict was written.
- **51:** SEC-18/19/20 fail by design (catalogued P2 gaps; the index already says FAIL). SEC-13/17
  are N/A via explicit VERDICT lines (the event stream also contains PASS — a tooling conflict,
  reported by `verdicts.mjs`).
- **60/65/66/75:** the remaining failures are already-FAIL catalogue rows or N/A→FAIL catalogue
  mismatches (the specs execute cases the index marks N/A).
- **Recommended (needs authorization):** (a) fix CRM-02's fixture/expectation and reconcile it with
  G-23; (b) add a clear-toasts/wait-for-actionability step before `shift-blind-input` in DRW-24;
  (c) isolate or reset the mobile-shell state in IDN-12; (d) make the REF-19/DRW-08 modals wait on
  state. None is product code.

## HAR-002 — physical ESC/POS printer session (R4)

- **What:** a 58 mm and an 80 mm printer (one genuine Epson or best-documented equivalent, one
  common budget clone).
- **Why:** 4 cases are hardware-only (RCP-19/24, TIM-09/10) and the paper leg of 8 MIXED cases
  (codepage, raster, width, cut, kick) cannot be proven from bytes.
- **Steps:** run `agent/triage/26-rcp.md` §hardware kit (self-test receipts, rubric, photo
  naming), then feed results through `verdicts.mjs --write-index`.
- **Time:** ~2 h for the full matrix.
- **Unblocks:** RCP-01/02/10/11/12/19/21/22/24 + TIM-09/10 and the 3 partials' paper leg.

## HAR-003 — merchant gateway + enrolled device keys (R3, Tier B)

- **What:** a real merchant sync gateway endpoint, with each terminal's Ed25519 pubkey enrolled.
- **Why:** 10 of the 17 blocked 24-syn cases need a second peer; the signed lane is proven only
  against the loopback verifier today.
- **Steps:** deploy `proxy/gateway.mjs` behind the merchant origin (or the real backend), enroll
  device pubkeys, set `sync.gateway_url` + per-device sync credentials.
- **Time:** ~1 day including credential provisioning.
- **Unblocks:** SYN-05/06/07/11/19/21/22/23/28/29 (and turns the 6 PASS-SIM candidates into
  headline-eligible runs).

## HAR-004 — fiscal numbering decision for SYN-02

- **What:** confirm the fiscal rule for receipt/invoice/ticket numbering across terminals
  (merchant-scoped sequence vs device-prefixed sequence) before the R2 fix.
- **Why:** both are defensible; the choice changes the migration and the printed number format.
- **Time:** a decision, then ~half a day to implement + migrate.
- **Detail (2026-11-03):** recommended **device series** (`PREFIX-<series>-<YYYYMMDD>-<seq>`,
  printed with a legend) because a single merchant counter cannot allocate offline; option B
  (online block reservation) converges to it; option C (keep timestamp+random + unique index) has
  no fiscal continuity. Full analysis: `agent/dossiers/D-SYN-numbering-ordering.md`.
  On approval: migration + per-device series + unique index + two-instance offline-uniqueness case.

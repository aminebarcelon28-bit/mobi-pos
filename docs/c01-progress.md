# C01 — progress (Stage B4)

Updated at every phase boundary. Ordered backlog, P0 before P1 before P2.

## Status at the end of this session

| Phase | Priority | Item | Status |
|---|---|---|---|
| 0a | P0 | hygiene, gates, this file | **DELIVERED** |
| 0b | P0 | binary provenance table | **DELIVERED** (see below; corrects B3) |
| 0c | P0 | dashboard: PASS / PASS-PARTIAL / FLAKY split | **DELIVERED** |
| 1a | P0 | fractional cash + invariant (vii) | **DELIVERED** (red→green, 1 mutation kill) |
| 1b | P0 | funding format in minor units + `unit` | **DELIVERED** (roundtrip, legacy reader) |
| 1c | P0 | B-2 reachability | **NOT DELIVERED** — time ran out at the 1d gate |
| 1d | P0 | B-1 walk-in trade restore | **DELIVERED as measurement** (see below) |
| 1e | P0 | under-refund sub-buckets | **NOT DELIVERED** |
| 1f | P0 | mixed-fleet rollback | **NOT DELIVERED** |
| 2a | P0 | store-level harness | **NOT DELIVERED** |
| 2b | P0 | H4 controllable-delay proof | **NOT DELIVERED** |
| 2c | P0 | D4 failure injection (P0, deferred twice) | **NOT DELIVERED** |
| 2d | P0 | H3-b interleaving | **NOT DELIVERED** |
| 2e | P0 | D4 RFC update | **NOT DELIVERED** (B3 text stands) |
| 5 | P0 | verification on the final binary | **NOT DELIVERED** |
| 3a-f | P1 | C90 | **NOT DELIVERED** |
| 4a | P1 | REF-92 store-level | **NOT DELIVERED** |
| 4b | P2 | REF-92 E2E | **NOT DELIVERED** |
| 6 | P2 | reviewer pack update | **NOT DELIVERED** |

Blocker for every NOT DELIVERED row after 1d: the batch reached its time budget at the 1d gate.
No phase was started and left half-applied; the tree is committed and the gates are green.

## Provenance finding (Phase 0b) — corrects B3 §10

`git diff --stat 97fc1d8 9d40d7d -- src src-tauri` → **`src/utils/receiptMath.ts` changed (17+/2-)**.
The B2 runs on `97fc1d8` are **stale** for the final code; B3 §10 should not have cited them.
`git diff --stat 9d40d7d HEAD -- src src-tauri` → empty (working binary matches HEAD app source).

## Phase 1a — fractional cash

- Invariant (vii): split -> real `clampCashRefund` -> the slice's `Math.round` must conserve
  (drawer + wallet + voucher + digital + debt == row total).
- Red before: cash-only thirds lost 0.33/0.33/0.34; mixed thirds drifted ±0.33.
- Implemented in `receiptMath.ts` only (Q-i): cash-only tickets round the REFUND to a cumulative
  whole-dinar target (333+333+334=1000); mixed tickets round only the CASH lane and push the
  sub-dinar remainder into a non-cash lane **with headroom** (so a lane already at its original
  amount is never pushed past it). A fractional ORIGINAL cash lane is reported as
  `anomalies:['fractional-original-cash']`.
- Green: cash-only thirds/sevenths, mixed thirds; mutation "raw fractional cash" killed by (vii).
- Invariant (v) refined to the Q-i reality: at most two lanes may deviate by ≤1 DA and their signed
  deviations must cancel; everything else within 1 minor.

## Phase 1b — funding format (Q-vi)

- No tag contains the funding commit (`git tag --contains c9118c4` -> empty; latest release v1.7.0
  predates it), so the format changed **in place**, version stays 1, with `unit:'minor'`.
- Writer: `fundingPayloadOf(split, basis)`; reader `refundLaneTotalsOf` accepts `unit:'minor'`,
  accepts a DA-valued object (flag `funding-unit-legacy`), never throws on malformed input.
- Roundtrip assertion over 4 fixtures × 6 gross values, every lane.

## Phase 1d — B-1 walk-in (stop-condition check)

- `tradeValueUnclaimed` (`createOrderSlice.ts:2295-2296`) sets `tradeRestoredValue = 0` and
  `valueReversed = netRefund` (trade excluded), with a warning + audit line. **Pre-existing**
  (present in a9fa0ad), not introduced by B-1.
- Measured walk-in (cash 700 + Reprise 300, no customer): **old and new are identical**
  (net 700, cash 700). B-1 changes nothing for walk-ins -> the stop condition's premise
  ("B-1 trade restore dropped for walk-ins") is **KILLED** by measurement.
- Open policy question: an anonymous trade-in refund neither pays the trade value nor can restore
  it (no wallet). Both versions behave this way; it is not a C01 regression.

# D1 — the four `177e6b1` money-boundary hits (line-level, equivalence analysis)

Scope: `src/store/slices/createOrderSlice.ts` at `7ac204d`. Cap: 54, actual 58. The four hits were
added by `177e6b1` (REF-66 Avoir leg, 2026-11-01 08:26; per-commit counts: 72ad644 54 → 9ad6446
57 → 2de4971 54 → 30d01a2 55 → f05b56e 54 → **177e6b1 58**).

## The four lines

| # | Line | Expression | Operand, unit, and upstream rounding | Redundant? |
|---|---|---|---|---|
| 1 | 2996 | `reliefPlanned = Math.max(0, Math.round(Number(debtReliefForNative?.relief ?? 0) \|\| 0))` | `relief` ← `reliefAmt` (2967) = `max(0, min(round(debtShare), round(currentDebt)))` — **integer DA**, already clamped ≥ 0 | **yes** |
| 2 | 2997 | `voucherPlanned = Math.max(0, Math.round(Number(funding.voucherShare ?? 0) \|\| 0))` | `voucherShare` ← `fromMinor(v)` = `v/100` — **DA float**, can be `x.45` (e.g. 250.55) | **no** |
| 3 | 2998 | `cashPlanned = Math.max(0, Math.round(Number(cashOut) \|\| 0))` | `cashOut` (2400) = `clamped.cashOut` or `0`; `clampCashRefund` rounds `want`/`cap` — **integer DA ≥ 0** | **yes** |
| 4 | 3001 | `Math.round(netRefund) - reliefPlanned - voucherPlanned - cashPlanned - walletLegForNative` | `netRefund` ← `fromMinor(thisNetM)` — **DA float** | **no** |

`walletLegForNative` is itself `walletAddBase + tradeRestoreNow`, and `walletAddBase` includes
`funding.avoirShare`/`funding.cashShare` (DA floats), so the uncovered-credit expression is already
unit-mixed; the value is rounded again at the native boundary (`walletCredit: Math.round(...)`,
line 3048).

## Equivalence check — the two removable wrappers

Executed model (`e2e-tests/results/d1_wrapper_equivalence.mts`, gitignored) imports the real
`computeRefundFundingSplit` and `clampCashRefund` and compares
`max(0, round(Number(v)||0))` with `max(0, Number(v)||0)`:

| Scenario | reliefPlanned | cashPlanned |
|---|---|---|
| fractional cent, 100.05 cash | identical (0) | identical (100) |
| fractional cent mixed 250.55 (150.55 cash + 100 avoir) | identical (0) | identical (151) |
| repeated qty 1-of-3 at 99.99 | identical (0) | identical (100) |
| line-to-total 2-of-3 (300 → 200) | identical (0) | identical (200) |
| debt relief, share 123.45 / debt 500 | identical (123) | identical (0) |
| undefined / zero ticket | identical (0) | identical (0) |

12/12 identical. Direct probes: identical for `-1`, `-0.01`, `-123.45`, `NaN`, `Infinity`,
`undefined`, `null`; the only differing input is a finite non-integer (`12.5` → 13 vs 12.5), which
cannot reach either wrapper because both operands are rounded upstream.

**Counter-check (why 2 and 4 must stay):** in the 250.55 mixed scenario `Math.round(netRefund)`
is `251` while raw `netRefund` is `250.55`; removing it puts fractional DA into
`uncoveredCredit`/`walletLegForNative` and, if a caller bypasses the boundary rounding, into the
native `i64` balance gate (`refund.rs` pre-COMMIT conservation), which fails closed.

## Verdict for B′ (remove 2, cap 56)

- **Identical output today** across fractional-cent, negative, repeated-quantity and
  line-to-total cases, because both removed rounds sit on values an upstream function already
  rounds and clamps.
- **Residual risk:** the integer invariant is by construction, not by type. B′ should ship with
  (i) a case in `scripts/test_cash_terms.mjs` asserting `clampCashRefund` returns integers for
  fractional `cashShare`/`cashTenderedNet`, and (ii) the existing fractional-price credit/debt
  refund E2E cases (REF-34/REF-65) re-run as the line-level check.
- **Cost:** two one-line edits + the test, and a registry edit (54 → 56) — still an owner
  authorization, exactly like B (54 → 58).
- **B (58)** remains the zero-code-change option; **B′ (56)** is behavior-identical today and
  reduces the debt ratchet by two.

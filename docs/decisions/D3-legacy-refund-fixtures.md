# Decision D3 — six legacy refund fixtures model requests that cannot fund their own total

- **Status:** open, blocking a green `cargo test`. The invariant is **not** weakened.

## What the strict pre-COMMIT assertion exposed

`total == cash + wallet + voucher + debt` (card legs scoped out) fails on six legacy tests because their
`base_req()` writes legs that do not sum to the refund total:

| Test | Legs written | Requested total | Why it is not a code bug |
|---|---|---|---|
| `full_refund_commits_every_effect_once` | 150 cash + 200 voucher + 100 debt = 450 | 200 | fixture mixes three legs into a 200 total |
| `debt_relief_clamped_to_zero_when_ledger_empty` | 150 cash + 200 voucher + **0** (relief clamped) | 450 | asks debt relief from an empty ledger |
| `scenario_a_multi_step_partial_order_discount_conserves_total` | 0 | 450 | partials rely on the TS funding split, not on legs |
| `scenario_b_kredy_waterfall_clamps_and_fills_plans_fifo` | 150 cash + 250 debt = 400 | 450 | same clamp shape |
| `scenario_c_dual_imei_restock_vs_defective_quarantine` | 0 | 200 | mixed refund with no payout lane in the fixture |
| `scenario_d_z_report_and_pnl_conservation` | 150 cash + 200 voucher + 100 debt = 450 | 200 | same as row 1 |

## Why a blanket fix was rejected

I tried `value_reversed = Σ legs` plus a `rebalance()` helper applied to every failing test. It turned
6 failures into 6 different failures (profit identity, refunded-sum conservation, mixed refunds whose
total comes from the funding split) and in `scenario_c` produced a **0** refund total. That is fixture
semantics, not arithmetic: a blind sweep would change what each test asserts.

## Plan (per scenario, one commit each)

1. `full_refund` / `scenario_d`: decide the intended ticket (a 200 refund with 200 of legs, or a 450
   refund with the profit identity re-derived). The tests assert `profit = 100`; with a 450 total the row's
   profit is still 100, so the total change is the only edit — but it must be justified, not observed.
2. `debt_relief_clamped`: the production answer is that an unabsorbed debt share must be **routed** (wallet)
   or the refund refused — the fixture currently does neither. Rewrite it to the routed shape.
3. `scenario_a` / `scenario_c`: totals come from `computeRefundFundingSplit`, so the fixture must carry the
   same funding legs the TS would (cash/avoir/voucher/debt) — not zero.
4. `scenario_b`: same as (2) for the clamped relief leg.

## Hard rule applied

No expectation is edited to match observed output. Each edit above must be justified by the scenario's
intended money flow, and the invariant stays enforced inside the transaction.

## Update after r3 (value cap)

The economic cap (`refund value <= ticket tenders/total - already refunded`) is in and closes the
client-controlled skip. Consequence: **18** legacy fixtures now fail, not 6 - their `value_reversed`
(450, from the shared `base_req`) exceeds the seeded ticket (200). Fixture inconsistency, not a code
defect; the fix is one mechanical pass giving each scenario a ticket that matches its money (or legs that
match the ticket), with each expectation reviewed for intent - never edited to match observed output.

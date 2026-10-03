# Plan 1b-ii Stage B — EXPAND (C-5.1, documents only, for approval)

Status: PLAN ONLY. Currency precondition SATISFIED (DZD, exponent 2, confirmed).
After 1b-i lands, Stage B proceeds per v4 §7 with Stage C as its STOP.
Separate diff from 1b-i. PD-15 deltas are owner sign-off items, never absorbed.

## B1. New columns per table (all INTEGER, NOT NULL, DEFAULT 0, CHECK >= 0)

Money → `*_minor` (santeem). Quantity → `*_milli` (1/1000 unit). Counter
columns per PD-6 marked [CTR].

- `products`: `price_minor`, `wholesale_price_minor`, `cost_price_minor`.
  `stock` stays INTEGER (whole units — truth is the ledger; note PD-8
  conversion only where fractional stock is proven to exist, else keep units
  and document).
- `customers`: `store_credit_minor`, `total_spent_minor`.
- `transactions`: `subtotal_minor`, `discount_total_minor`, `total_minor`,
  `cost_total_minor`, `profit_minor`, `profit_margin_minor` (ratio — see B3),
  `cash_tendered_minor`, `change_due_minor`, `ledger_cogs_total_minor`.
  (`tax` already dropped by 1b-i.)
- `transaction_items`: `quantity_milli`, `applied_price_minor`,
  `discount_minor`, `cost_price_minor`, `unit_price_charged_minor`,
  `unit_cost_at_sale_minor`, `discount_amount_minor`, `line_profit_minor`.
- `stock_batches`: `quantity_remaining_milli`, `unit_cost_minor`,
  `shadow_qty_milli`, [CTR] `qty_depleted_milli`, [CTR] `cost_allocated_minor`.
- `sale_batch_allocations`: `qty_consumed_milli` (PD-7, replaces INTEGER
  whole-unit `qty_consumed`), `unit_cost_at_sale_minor` (PD-7).
- `credit_vouchers`: `initial_amount_minor`, `remaining_amount_minor`.
- `customer_debts`: `amount_minor`, `balance_after_minor`.
- `store_expenses`: `amount_minor`.
- `cash_drops`: `amount_minor`.
- `repair_orders`: `labor_cost_minor`, `parts_cost_minor`,
  `total_cost_minor`, `deposit_amount_minor`.
- `trade_ins`: `buyback_value_minor`, `resale_margin_percent_minor` (ratio —
  see B3), `resale_price_minor`.
- `product_bundles`: `bundle_price_minor`.
- `scan_audit_log`: `grand_total_minor`, `delta_minor`.
- JSON-only money (converted in place during backfill, Stage C): PO line
  items (`suggestedQty/receivedQty/unitCost/actualUnitCost/totalCost`,
  `actualTotalAmount` — `src/types/pos.ts:580-632`); `SaleTransaction`
  credits (`voucherCreditApplied/tradeInDeduction/tradeInSoulte/
  tradeInRestored/cashDisbursed/debtAdded` — `pos.ts:489-541`);
  `CashSession` aggregates (`cashSales/manualDeposits/expenses/savDeposits/
  savSettled/dailyNetProfit/totalSalesRevenue/totalProfits` —
  `pos.ts:1559-1572`); loyalty economics (`minSpend/multiplier`,
  `threshold/reward`, `creditValueDzd` — `pos.ts:153-277`).

Ratios/percents (B3 — NOT minor units, documented separately):
`profit_margin`, `resale_margin_percent`, cart/loyalty percents stay
unit-free ratios; converted to exact integer basis points ONLY where
arithmetic needs them (decision at expand review, listed in the diff).

## B2. Integer-island audit — verdict table (SB-2)

| Island | Current unit (verified) | Verdict |
|---|---|---|
| `p_products.price_cents`, `p_transactions.total_cents`, `p_transaction_items.qty/unit_cents` | Minor units already (written `Math.round(x*100)`, `sqlPluginAdapter.ts:1771-1781`) | KEEP, no rename (document equivalence to `*_minor`) |
| `inventory_ledger.delta` INTEGER | Whole-unit qty (`delta:-qty`, `createOrderSlice.ts:943-968`) | REPLACE-path: add `delta_milli` (= ×1000 exact); SB-1: fractional movements REQUIRE milli — a ledger that cannot hold 0.5 units cannot record fractional sales (PD-2) |
| `cash_sessions` / `cash_movements` INTEGER (`opening_float`, `expected_cash`, `actual_cash`, `discrepancy`, `amount`) | Whole dinars | REPLACE-path: add `*_minor` (= ×100 exact) |
| `loyalty_ledger.points/balance_after`, `customers.loyalty_points` | Points, not money | UNTOUCHED — cited so nobody "migrates" them |
| Loyalty points→credit math (`convertPointsToCredit`, `loyaltyEngine.ts`) | Integer-exact (50 pts × 10 = 500) | KEEP values; file enters the Stage E lint set |

## B3. CHECKs and guards

`CHECK (col >= 0)` on every new money/qty column where negativity is a bug
(all of B1 except signed P&L intermediates, which are derived, not stored).
`NOT NULL DEFAULT 0`. Counters additionally assert
`cost_allocated_minor <= qty_depleted_milli * unit_cost_minor` at the app
layer (Test C invariant I3 covers it).

## B4. Unordered-reader fixes (F06 — part of expand diff)

- `src/store/slices/createCatalogSlice.ts:186` — add
  `ORDER BY received_at ASC, batch_id ASC`.
- `src/sync/repairResync.ts:124` — add same ordering.
- Determinism proof: Test C + Test F run against both orders and assert
  identical allocation (I5).

## B5. Remote + sync (expand side)

Remote v14 (or next free): mirror every B1 column + CHECKs in
`remoteSchema.ts` + `turso/remote-schema.sql`. Payload version bump per
PD-20/21 (MIN_SUPPORTED/ KNOWN_MAX bump again). Dual-write begins in
Stage D, not here — expand is ADDITIVE and non-breaking: old readers ignore
new columns, new readers fall back to REAL columns until Stage E.

## B7. Gate-decision preconditions SB-1..SB-5 (folded in, planning approved)

- SB-1 (`delta` milli): closed in B2 table — `delta_milli` is REQUIRED, not
  optional; fractional sales cannot be ledgered without it.
- SB-2 (island table): B2 above is the table (unit + verdict per island).
- SB-3 (unit-conversion ratios): enumerated — NO carton↔unit product ratio
  exists in code. `pack_size` is an OCR-extracted informational field
  (`intelligentScanEngine.ts:236-253`, unwired to pricing); loyalty
  "conversion" entries are points→credit ledger event types, integer-exact.
  Nothing to integer-scale; if a pack ratio ever lands, it enters the lint
  scope by rule. `intelligentScanEngine.ts:238` `parseInt(packMatch)` is
  digit-string parsing (exact) — cited, not flagged.
- SB-4 (Dexie mirror PD-3): `database.ts` stores (v3–v9, max `version(9)`)
  are INDEX-ONLY (`transactions: 'id, receiptNumber, createdAt'`, same shape
  all versions) — Dexie stores full JS objects, so there is no column to
  redefine and NO Dexie version bump for the value migration. The mirrored
  money/qty FIELDS inside those objects convert with their SQLite twins at
  Stage D dual-write: `SaleTransaction` totals (`subtotal/discountTotal/
  total/costTotal/profit/...`), `Product` prices, `stockBatches`
  (`quantityRemaining/unitCost` + PD-6 counters), `customerDebts`,
  `storeExpenses`, `cashSessions`, `creditVouchers`, `tradeIns` amounts —
  integers (`*_minor`/`*_milli`) or JSON strings per PD-3, never JS floats.
  Mirror writers (`mirrorStockBatchesToDexie` et al.) copy the new columns;
  the C5 grep proof extends to `new Number(` float revivals in mirror code.
- SB-5 (sequencing): EXPAND EXECUTES ONLY AFTER 1b-i LANDS — one schema
  migration in flight at a time. Remote takes v14 (next free after 1b-i's
  v13). PD-20 constants (`MIN_SUPPORTED_REMOTE_VERSION`, `KNOWN_MAX`) bump
  at their single location as part of the expand diff, not earlier.

## B6. Verification of expand (before Stage C backfill)

`tsc`, `oxlint`, `cargo test`, boundary gate (registry UNCHANGED — expand
adds no Math.* to money paths; backfill scripts live outside the registry
set and use Money ops), Test J green, plus a schema assertion script:
every B1 column exists with the exact type/default/CHECK on local + remote
DDL. STOP → Stage C (backfill + reconciliation + rollback rehearsal).

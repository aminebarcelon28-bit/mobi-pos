# Smart Import Historical Destinations Design

## Goal

Complete Smart Import destination support without treating quarantined records
as imported. Historical files must create reviewable history in the correct
business area while remaining inert: imports do not replay operational cash,
stock, debt collection, repair, messaging, or purchase effects.

## Current architecture findings

- The native parser and staging layer are in `src-tauri/src/import`; the native
  commit uses a SQLite transaction, while the WebView refreshes adapters and
  store projections after commit.
- Repair orders live in `repair_orders`. Manual writes use
  `operationsAdapter.saveRepairOrder`, which mirrors to Dexie and sends generic
  sync. The command-ticket screen derives active work from the repair store and
  regards delivered/cancelled rows as archived, but there is no import-origin
  distinction.
- Trade-ins live in `trade_ins`. Manual persistence uses
  `operationsAdapter.saveTradeIn`; operational intake/conversion in the UI/store
  may also create inventory, IMEI, ledger, and wallet state.
- Purchase orders live in `purchase_orders` and use procurement-store workflows
  and `savePurchaseOrder`; there is no independent imported receipt-history
  lane.
- Customer debt ledger rows are written by `customerAdapter.saveCustomerDebt`
  and operational payment/checkout paths. Smart Import already has a separate
  native opening-balance snapshot contract.
- Manual purchase receiving is implemented by
  `createProcurementSlice.validateAndReceivePO`: it mutates product quantities,
  creates FIFO batches and RECEIVE ledger entries, writes ownership events,
  updates the purchase order, and may then record cash/expense settlement.
  Historical receipt import must not call that whole operational workflow.
- Generic synchronization maps repair orders, purchase orders, trade-ins, and
  customer debts to SQLite and Dexie projections and supports tombstones.
- Native import commits are transactional, but directly calling the existing
  TypeScript adapters from the Rust import path is not possible without
  reintroducing non-atomic mirror and sync side effects. Each touched manual
  adapter and import commit must call the same extracted domain persistence
  operation. Where atomic native batching is required, move the shared
  operation behind a typed native command and route both manual writes and
  import batches through that implementation; do not maintain parallel raw-SQL
  semantics for imports.
- The parser already supports Windows-1256/1252 decoding and script scoring.
  Detection metadata is not currently exposed as a user override workflow.
- The current destination matrix intentionally quarantines repair and trade-in
  files instead of importing them into a dedicated history area.

## Design principles

1. **One lane per vertical slice.** Each slice includes detection, mapping,
   validation, preview, one-transaction commit, real projection/UI read-back,
   batch undo, negative tests, and E2E verification.
2. **Shared domain operation, one transaction.** Import and manual-entry
   adapters must call the same typed domain persistence operation. If the
   current operation is WebView-only, move it behind a typed native command and
   route both callers through that command. The command accepts an explicit
   `operational` or `import_history` mode; the history mode suppresses
   operational effects while persisting the same validated domain shape.
   Never call an operational action whose contract includes payment, stock,
   notification, or workflow side effects from history mode.
3. **Provenance is explicit.** Every imported domain row carries `source='import'`,
   `import_batch_id`, a stable source identity, and an immutable source snapshot
   sufficient to explain the imported values. Schema migrations backfill
   existing rows to their legacy/manual source; migration tests start with
   populated legacy databases.
4. **History is inert by default.** Imported repair, trade-in, receipt, and debt
   records cannot enter operational side-effect paths. Imported records remain
   visible in the appropriate history UI and are excluded from active queues,
   cash/Z totals, notification dispatch, stock changes, FIFO layers, and
   collection/payment workflows unless a lane explicitly defines a reviewed
   conversion action.
5. **Replay and undo are first-class.** Each lane defines a natural key and
   unique constraint. Reimporting the same source payload is a no-op; the same
   natural key with a materially different payload is a conflict for review.
   Undo accepts a batch ID, tombstones/deletes only rows owned by that batch,
   updates sync/projections transactionally, and refuses to undo records that
   have since entered an operational conversion.
6. **Quarantine is not success.** Results distinguish imported, updated,
   quarantined, rejected, and replayed/no-op rows. Each quarantined row has a
   stable reason. Any database failure rolls back all committed rows in that
   batch.
7. **Fail closed on ambiguity.** Wrong-destination files receive a clear
   rejection. Invalid IMEIs, unknown statuses, unresolved supplier identities,
   reconciliation differences, and conflicting natural keys are never
   silently repaired or written.

## Delivery sequence

### Slice 1 — Cross-lane data-integrity edges

- Add/verify Windows-1256 candidate scoring for BOM-less, invalid-UTF-8 text;
  expose detected encoding in preview and allow an explicit supported-encoding
  override.
- Normalize Arabic-Indic digits and Arabic decimal/thousands separators in
  numeric fields while preserving source text for audit.
- Preserve phone numbers, SKUs, barcodes, and ticket numbers as text through
  CSV, XLSX, and DBF. Reject scientific-notation values in IMEI/barcode
  identity fields with the exact explanation:
  “Excel converted this to scientific notation; re-export the column as text.”
- Verify DB read-back and no-write behavior for rejected identity rows.

### Slice 2 — Repair history

- Add a dedicated repair-history destination and map ticket number, customer,
  phone, device, IMEI/serial, issue, status, costs, paid amount, dates, and
  warranty days.
- Normalize status synonyms into the supported received / in progress / ready /
  delivered / cancelled domain states; quarantine unknown values.
- Match customers by normalized phone and create a missing customer within the
  same transaction. A repair IMEI may link to an existing device, but import
  cannot reassign its product or change its warranty/status.
- Store source status separately when required so a historical status cannot
  trigger a current repair workflow. Imported rows are visibly marked as
  history and excluded from operational transitions, cash, messaging, and
  notifications.
- Natural key: normalized ticket number within the source namespace. Exact
  replay is a no-op; conflicting ticket payloads are review conflicts.
- Provide batch undo and read-back in the repair screen’s historical view.

### Slice 3 — Trade-in history and reviewed conversion

- Import to a dedicated history destination with `pending_review` state only;
  do not invoke operational trade-in intake, wallet, inventory, or payout.
- Preserve source identity and customer/device details; reject identifier
  collisions that cannot be reconciled.
- Add a separate user-reviewed conversion command. It validates confirmed
  IMEI/serial, uniqueness, condition, and cost basis, then atomically creates
  the inventory product, IMEI row, FIFO layer, and ledger entry using the
  existing inventory domain rules.
- Persist the one-way trade-in-to-product link. A second conversion attempt is
  rejected, including concurrent/replayed attempts.
- Natural key: source record ID where available; otherwise normalized
  identifier + customer + source date. History import and conversion have
  separate idempotency keys and undo constraints.

### Slice 4 — Supplier receipt history

- Parse receipt headers and lines into a distinct imported-receipt history
  destination. Default mode is history-only and never changes stock.
- Require an explicit opt-in and acknowledgement before stock-affecting mode;
  that mode uses the same extracted receiving primitive as manual receipt, but
  explicitly excludes purchase settlement, cash/expense, and payable effects.
  The complete batch is atomic.
- Resolve supplier by conservative normalized name/phone; unresolved or
  ambiguous suppliers are quarantined.
- Reconcile line totals with the header total; discrepancies are preview
  warnings that block commit until resolved or explicitly acknowledged by the
  destination contract. Preserve freight-incomplete status rather than
  assuming zero.
- Natural key: supplier + normalized invoice number + line identity. Replays
  are no-ops; changed invoice payloads conflict.

### Slice 5 — Itemized debt history

- Keep itemized historical debt entries separate from opening-balance
  snapshots. Map date, charge/payment, amount, reference, and optional stated
  balance.
- Recompute running balance in source order and compare against the existing
  verified snapshot or supplied balance. A mismatch blocks the batch and shows
  the calculated/source difference.
- Imported entries do not create cash movement, wallet credit, sales,
  collections, or a second opening balance.
- Natural key: customer + source transaction/reference + normalized date and
  amount; exact replay is a no-op.

## Schema, sync, and UI contracts

- Each schema change is versioned in both native migrations and TypeScript
  schema healing. Migration tests apply it to a populated pre-change database,
  verify legacy-row backfill, then verify imported writes and batch undo.
- Generic sync includes provenance, import batch linkage, stable source
  identity, and tombstone/delete behavior. Imported history must not be
  converted into an operational outbox event merely by hydration.
- Read-back uses the actual domain adapter/projection and the target UI screen,
  not only a direct SQLite probe. Store refresh occurs after commit and undo.
- Import result summaries separate imported, updated, replayed, quarantined,
  and rejected totals per destination.
- All tests run against the isolated Tauri E2E database and executable. The
  production/debug app and production database are out of scope.

## Verification gates

For each slice: native focused tests, migration-on-populated-database test,
TypeScript typecheck, isolated E2E build, Playwright end-to-end UI/read-back and
side-effect assertions, mid-batch failure rollback, idempotent replay, batch
undo, and `git diff --check`. Each lane also gets a 2,500-row responsiveness
case only where high-volume rows are meaningful; document any lane-specific
reason the case is not applicable. Stop the isolated E2E app after validation.

## Scope and non-goals

- This design does not treat quarantine as an import path.
- It does not replay historical cash, debt collection, purchase settlement,
  repair actions, wallet credit, or trade-in payouts.
- Trade-in conversion is the only defined route from imported history into
  inventory and requires explicit review.
- No lane is described as supported until its native transaction, migration,
  idempotency, undo, side-effect invariants, and UI E2E all pass.

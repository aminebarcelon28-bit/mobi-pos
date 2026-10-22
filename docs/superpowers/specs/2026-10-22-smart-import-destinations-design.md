# Smart Import Destination Contracts

**Status:** User-approved design direction; written spec awaiting user review
**Date:** 2026-10-22
**Scope:** Destination adapters and historical-record safety for Smart Import
**Baseline:** [Smart Import & Easy Migration design](./2026-10-22-smart-import-design.md)

## Goal

Extend Smart Import from product and customer migration into a shared, native
import pipeline with destination-specific contracts for customer debt,
suppliers, supplier receipts, serialized devices and warranty, repairs, and
trade-ins. Every imported row must land in the correct domain and must not
silently replay operational financial or inventory side effects.

This is a design document only. No production data is modified by preview.
Implementation begins only after the user reviews this written spec and
approves an implementation plan.

## Current architecture and findings

The authoritative local store is plain SQLite. The native Rust import
pipeline parses bytes, stages rows in `import_staging.db`, and commits to the
live SQLite database. The existing baseline design retains native parsing,
read-only preview, explicit commit, transaction rollback on database errors,
read-back verification, and UI refresh.

Relevant current-state findings:

- `EntityType` currently recognizes products, opening stock, and customers as
  import targets; suppliers, customer debts, active repairs, serialized IMEIs,
  and trade-ins are reject/defer classes. An explicit supplier path exists,
  but it updates `vendor_directory` and `vendor_aliases` rather than a
  first-class supplier table.
- Product opening quantity is written as an absolute stock snapshot on
  updates. Positive deltas create FIFO stock batches and ledger entries;
  negative deltas consume FIFO layers. The current path uses zero as the batch
  cost when source cost is unknown, which can misstate COGS.
- Customer identity lookup uses exact phone and normalized email queries with
  `LIMIT 1`; those fields are indexed but not unique. Customer updates may
  overwrite the full JSON payload, and the existing customer commit can set
  `current_debt` and append an opening debt row from a profile import.
- `customer_debts` has no constrained origin column. The customer debt
  hydrator reads a fixed column list, so an origin stored only in arbitrary
  JSON would not be reliable for downstream accounting filters.
- Trade-in rows round-trip through their JSON payload. Z-report and shift
  close cash calculations currently count non-wallet trade-ins without an
  imported-origin filter.
- Repair rows round-trip through their JSON payload. SAV deposit calculation
  currently reads repair deposits; the repair dashboard primarily uses status
  and has no distinct imported-history lane.
- `imei_records.imei` is the primary key and `product_id` is required.
  Product import currently upserts this row and may replace its product link.
  The generic `saveIMEIRecord` path can update sale and warranty fields; it is
  not a safe import conflict policy. Migration v127 adds `imei_records.status`,
  while the inspected TypeScript hydration projection does not read or write
  that column; schema and adapter parity is a prerequisite for the serialized
  import lane.
- The normal purchase-receive workflow writes inventory batches, ledger
  entries, supplier price history, and can also record expenses, cash/bank
  payments, supplier debt, and freight. It must not be replayed for historical
  receipt files.

Implementation references include
[commit.rs](../../../src-tauri/src/import/commit.rs),
[map.rs](../../../src-tauri/src/import/map.rs),
[customerAdapter.ts](../../../src/db/adapters/customerAdapter.ts),
[operationsAdapter.ts](../../../src/db/adapters/operationsAdapter.ts),
[createProcurementSlice.ts](../../../src/store/slices/createProcurementSlice.ts),
[zReportSnapshot.ts](../../../src/utils/zReportSnapshot.ts),
[ShiftCloseModal.tsx](../../../src/components/modals/ShiftCloseModal.tsx), and
[createRepairSlice.ts](../../../src/store/slices/createRepairSlice.ts).

## Shared pipeline contract

The pipeline remains:

`file bytes -> native parser -> destination-specific mapping/staging -> read-only identity checks -> user review -> native transactional commit -> read-back verification -> store refresh`

### Destination selection

- Each import batch has one explicit destination adapter. A file is never
  silently split across products, debts, repairs, trade-ins, or other
  destinations.
- If rows or columns indicate multiple entity types, the preview asks the user
  to split the source or choose a supported destination. Ambiguous rows are
  quarantined; they are not guessed into products or customers.
- Supported file extensions are `.xlsx`, `.xls`, `.csv`, `.tsv`, `.txt`,
  `.vcf`, `.json`, `.jsonl`, `.sql`, and `.dbf`. Parser-format coverage is
  separate from destination support: unsupported combinations fail clearly
  rather than being coerced into a different entity type.
- SQL input is data-only. The native parser may extract recognized
  `INSERT ... VALUES` payloads; it never executes user-provided SQL.

### Preview, commit, and recovery

- Preview is read-only against live operational data. It displays target
  destination, row identity, normalized values, warnings, conflicts, and
  expected side effects before commit.
- The user explicitly confirms the destination and commit. Invalid rows are
  quarantined with row-level reasons; unrelated valid rows or receipt groups
  may proceed according to the destination rules below.
- All accepted rows for a commit execute in a native SQLite transaction.
  Any database failure rolls back the whole commit; the staging record remains
  available for retry or export.
- The importer rechecks identities and stock/debt projections inside the
  commit transaction, reads back committed identities, then refreshes the
  relevant stores and active search indexes. A failed read-back or refresh
  cannot be reported as success.
- The completion summary reports parsed, inserted, updated, no-op, skipped,
  quarantined, and failed counts separately. It includes row- or
  group-level reasons.
- Import provenance and destination origin are persisted in a schema field,
  dedicated history row, or round-tripped payload that the relevant adapter
  actually hydrates. A JSON-only marker is not sufficient where the adapter
  discards it.
- Event adapters use a durable source-identity crosswalk keyed by destination,
  source namespace, and source record ID, storing the target ID and canonical
  payload hash. Same key and hash is a no-op; same key with a different hash
  is a conflict. When the source has no stable record ID, use file hash,
  worksheet, and row for exact-file retry only, and warn that changed-file
  overlap requires review. Crosswalk and target writes share the same native
  transaction. Natural-key destinations retain their own uniqueness and
  conflict rules.
- User-facing guidance appears before commit. In particular, the UI explains
  the difference between a stock snapshot and a receipt, profile data and
  debt, trade-in history and inventory, and archived repairs and active SAV.

## Destination contracts

### Products and opening stock

- Product identity uses normalized barcode and SKU. If both resolve to
  different products, the row is quarantined. Title is not an automatic merge
  key when a stable identifier is available.
- Product catalog fields are patched from supplied values; omitted fields are
  not silently reset.
- A quantity in Opening Stock is the absolute on-hand snapshot, never an
  additive receipt. Preview shows current quantity, target quantity, delta,
  and the FIFO layers affected. Commit rechecks the live quantity and the
  invariant that active stock batches reconcile to `products.stock`.
- A positive stock delta requires an explicit, valid unit cost. If cost is
  absent or invalid, the complete row is quarantined until the user supplies
  a cost or removes the stock quantity. A catalog-only product may still be
  imported with zero stock. The importer never turns unknown cost into a
  zero-cost stock batch.
- A negative delta consumes available FIFO layers and records an adjustment;
  it is not a sale, supplier return, cash movement, or receipt. A mismatch
  between stock batches and the product projection blocks the affected
  snapshot rather than guessing.
- Re-importing an identical snapshot creates no additional stock. Purchase
  receipts use the separate receipt destination below.

### Customer profiles and identity

- Match on a supplied stable source customer ID only after recording it in
  the durable source-identity crosswalk; otherwise use a uniquely matching
  normalized Algerian phone number and/or normalized email.
- If phone and email resolve to different customers, or either identity key
  matches multiple live rows, quarantine the row. Do not use an arbitrary
  `LIMIT 1` match.
- Names alone are not a safe merge key. A row without a stable identity can
  be created only after an explicit duplicate-risk confirmation; exact replay
  of the same source file/row remains idempotent.
- Updates patch only the profile fields explicitly supplied. They preserve
  loyalty points and ledger, store credit, lifetime spend, debt, consent,
  card/barcode identity, and other omitted fields.
- Debt columns are not applied by the profile adapter. They route to the
  explicit debt destination or are quarantined with an instruction to select
  that destination.
- Missing source profile values never erase existing values.

### Customer debts

Debt imports have two separately validated modes; the preview requires an
explicit mode selection.

**Opening-balance snapshot**

- A source amount is the desired outstanding balance, not an amount to add.
- Before writing, compare the source value with the ledger-derived balance and
  the customer cache. If the ledger and cache disagree, block that customer
  for reconciliation.
- For a zero/empty ledger, create the supported opening acquisition entry.
  A matching, adequately covered snapshot is a no-op. A mismatch or ambiguous
  prior coverage is blocked for explicit reconciliation; it is never silently
  added, replaced, or backdated.
- If no source date exists, use actual import capture time and display a
  warning; never fabricate an earlier transaction date.

**Itemized history**

- Preserve supported source event types, dates, event amounts, kind, payment
  method, notes, and source identity. Do not reconstruct missing allocations
  or rewrite ledger events.
- Accept only `DEBT_ACQUIRED` and `PAYMENT_SETTLED`; preserve supported kinds
  `ACHAT`, `VERSEMENT`, and `CORRECTION` (empty kind only for legacy source
  rows). Invalid type/kind combinations are quarantined.
- Preserve event timestamps. If a source timestamp is missing, use actual
  import capture time with a visible warning rather than backdating; if that
  prevents reliable per-acquisition aging, block the customer group for
  reconciliation.
- A stable source event ID is the primary idempotency key. Same identity and
  same payload is a retry no-op; same identity with different payload is a
  conflict. Without stable IDs, only an exact file-hash/row retry is
  automatically idempotent; overlap across changed files requires review.
- Validate customer groups independently. Invalid or ambiguous groups are
  quarantined while unrelated valid groups may commit.
- If source allocations are absent where they are required to preserve
  per-acquisition aging for dated debts, block that customer group for
  explicit allocation/reconciliation; never invent FIFO allocations.
- Compare a source closing balance only when the file supplies sufficient
  coverage and a valid opening baseline.
- The authoritative balance remains
  `max(0, sum(DEBT_ACQUIRED.amount) - sum(PAYMENT_SETTLED.amount))`.
  `balance_after` is only a projection. Negative balances/store credit are
  not debts.

**Financial isolation and origin**

- Persist `origin` as a constrained native column with values
  `operational` and `imported_history`; existing rows default to
  `operational`. Unknown values fail closed in cash aggregation.
- Imported debt events may update the customer's debt balance. Their payment
  method and amount are historical evidence only: they never create cash
  movements, shift/Z cash, store credit, wallet/loyalty changes, sales
  receipts, or unrelated accounting rows.
- Customer debt views label imported settlements as imported history and
  distinguish them from cash received operationally.
- Add the origin field to the typed model, native write/read paths, adapter
  hydration, Dexie mirror, and sync payload. Do not rely on unknown JSON
  properties.

### Supplier directory

- Supplier imports populate contact-directory records only. They do not
  create purchase orders, receipt history, stock, payables, expenses, or cash
  movements.
- The current supplier key is the display name. Match conservatively on a
  normalized name; do not merge suppliers by phone alone or rewrite names
  referenced by existing purchase orders, RMAs, or disputes.
- SQLite `app_settings/vendor_directory` is authoritative for import writes.
  Hydrate it into the live vendor store and its existing local persistence
  mirror; a localStorage-only write is not a successful native import.
- Merge only supplied, non-conflicting contact values. A same-name row with
  conflicting non-empty phone, email, or address is held for user review;
  omitted or blank input never clears stored contact details.
- Persist the directory and refresh the live vendor store used by procurement,
  replenishment, and supplier communications.
- A contact-only supplier row does not create product aliases in
  `vendor_aliases`; supplier-to-product alias data must be supplied and
  reviewed as a distinct mapping.
- Preview instruction: “Supplier contacts only; this import does not record a
  purchase or receive stock.”

### Historical supplier receipts

- Receipt files use a separate, explicit destination; a quantity column alone
  never changes a snapshot into a receipt.
- A receipt group requires a supplier identity, stable invoice/receipt
  reference, product resolved uniquely by internal ID, barcode, or SKU,
  positive whole-unit received quantity, and explicit non-negative DZD unit
  cost. Receipt date is preserved when supplied; otherwise actual import time
  is used with a visible warning.
- A source line ID is preferred. Otherwise use the source invoice identity
  plus sheet and row as the stable line identity. A same-identity/same-payload
  replay is a no-op; changed payload under that identity is a conflict, not an
  overwrite. Missing invoice/receipt identity is quarantined rather than
  treated as safe cross-file deduplication.
- Every line in one receipt group must validate before that group is accepted.
  A bad or ambiguous line quarantines that receipt group; other independent
  receipt groups may remain eligible. A SQLite error still rolls back all
  accepted groups in the same commit.
- Use a native import-specific transaction to persist a distinct imported
  receipt-history record; append the corresponding stock batch,
  `inventory_ledger` RECEIVE delta, and supplier price-history evidence; and
  update `products.stock` in the same transaction. Existing product
  cost-reference behavior remains first-known-only; receipt unit cost belongs
  to the batch and price-history row.
- Source cash/bank payments, supplier debt, and expense data are stored only
  as inert historical receipt evidence. They do not write operational
  expenses, cash movements, payables, or supplier balances. The normal PO
  receive workflow is not called.
- Freight is never inferred. If provided, preserve and allocate it with an
  explicit method. If absent, show that landed cost is incomplete and require
  the user to acknowledge the omission; reports must not present the result as
  a complete landed cost.
- Receipt history is visible in a separate historical procurement lane and
  is not an editable/open purchase order.

### Serialized products, IMEI, and warranty

- A serialized IMEI/serial is a device-level registry record and must resolve
  to exactly one product already present or imported in the same approved
  batch. A standalone identifier without an unambiguous product link is
  quarantined.
- Normalize with the shared device-ID codec. A 15-digit IMEI must pass the
  shared Luhn intake gate; non-15-digit serial identifiers remain supported.
- Product stock and device identifiers must reconcile. A serialized unit
  needs one distinct identifier; a row with aggregate stock and too few
  identifiers is quarantined rather than inventing missing identifiers.
- Existing IMEI is never overwritten to force a match. Exact same
  identifier/product and identical immutable fields is a no-op. Conflicting
  product link, sale link, state, or warranty anchor requires review. A
  duplicate identifier in trade-in history may be a separate legitimate
  acquisition event; the IMEI registry key and trade-in event identity are
  not conflated.
- New inventory identifiers default to `in_stock` only when the source
  represents available inventory; preserve an explicit supported `defective`
  state. A sold source record must link to a real matching MobiPOS sale
  transaction; because sales migration is not a destination in this scope,
  an unlinked sold row is quarantined and no sale is fabricated.
- Preserve supplied warranty expiry and term. Do not recompute or overwrite
  an existing point-in-time sale warranty anchor. A supplied term without an
  expiry remains a term only; no expiry is invented. Product catalog warranty
  is distinct from per-device warranty.
- Fix TypeScript/native `imei_records.status` hydration parity before enabling
  this adapter. Do not use the generic IMEI upsert for import conflict
  resolution.

### Trade-in history and explicit inventory conversion

- Import trade-ins as append-only historical acquisition events. Persist a
  constrained imported-history marker in the round-tripped payload and a
  stable source event identity where available.
- Do not deduplicate trade-in events by IMEI alone: the same unit may
  legitimately be traded in again. Same source identity/same payload is a
  no-op; changed payload under the same source identity is a conflict.
- Preserve source customer and settlement details as history. Do not create
  a product, IMEI registry record, stock batch, inventory movement, cash
  payout, wallet credit, sales transaction, or receipt during history import.
- Exclude imported-history trade-ins from cash-out and shift/Z totals while
  retaining them in customer and device-origin history. Preserve source event
  dates; missing dates use import time with a warning. Ambiguous repeated
  identifier histories are visibly flagged.
- To sell a traded-in device, require a separate explicit, audited
  “Convert to inventory” action. It must use a dedicated native command,
  validate/canonicalize the identifier, check the blocked-device list and
  existing registry conflicts, capture the missing product/inventory details,
  and atomically create the product/IMEI/stock records. It must not replay the
  historical payout or wallet credit. A blocked identifier cannot be
  bypassed by import or conversion; any permitted exception must use the
  existing native manager-authorization policy. The normal trade-in checkout
  workflow is not called.
- Preview instruction: “Trade-in history is not sellable stock. Review and
  explicitly convert a device before it can be sold.”

### Repair archive

- All imported repair dossiers, including records that contain complete v2
  evidence, enter a read-only imported-history lane. Preserve source status
  separately from operational repair status.
- An imported record never becomes an active SAV ticket. Continuing work
  requires a new native v2 intake with current legal evidence and a link to
  the archive record.
- Import never calls repair workflows that create/refund deposits, move cash,
  consume or restore parts, close technician timers, stamp commissions,
  create warranty claims, or append IMEI ownership events.
- Preserve source deposit amounts and payment details as historical evidence
  only. Exclude imported repair deposits from operational cash/Z-report
  aggregation. Imported history must not appear in active queues as work in
  progress.
- Resolve customer/device links only when unique. Preserve unverified source
  identifiers as historical text with a warning; do not create registry or
  trust events from them.
- Preview instruction: “Imported repair history is not an active repair. Use
  a new SAV intake to begin or continue work.”

## Transaction, audit, and UI requirements

- All destination writes are native and transactionally bounded. Protected
  tables are never written through generic WebView SQL.
- No import adapter calls a normal checkout, refund, repair, or trade-in
  workflow as a shortcut.
- Persist destination-specific origin and source identity through SQLite,
  hydration, Dexie mirrors where used, sync payloads, and reports.
- After commit, refresh relevant products, customers/debts, suppliers,
  receipt history, IMEI records, repairs, and trade-ins in the live store.
  Rebuild active catalog/POS search indexes without a page reload.
- If synchronization or hydration fails, report the failure; do not show a
  success result while the active UI is stale.
- Audit evidence records the import batch, destination, source file hash,
  source row/sheet, operator, timestamp, row decision, and reason. Do not log
  credentials or expose sensitive customer information unnecessarily.

## Adversarial E2E acceptance

Run against the isolated native Tauri E2E database and real WebView UI. Every
scenario opens Smart Import through “Lancer l'Import Intelligent”, uploads a
fixture, reviews the preview, explicitly commits when appropriate, and checks
both SQLite and live UI without reloading.

### Parser and format matrix

Exercise `.xlsx` with multiple sheets and offset headers; genuine `.xls`;
CSV, TSV, and delimited TXT; vCard 2.1/3.0/4.0 with folded and
quoted-printable lines; JSON and JSONL; SQL with hostile non-INSERT statements;
and DBF. Exercise UTF-8 BOM, Windows-1252, Windows-1256, UTF-16, French and
Arabic text, leading-zero identifiers, scientific notation, malformed files,
oversized input, mixed delimiters, empty files, and repeated headers.

Each format must have a deterministic parser test. Each supported destination
must have at least one native UI-to-database E2E. A format/destination
combination that is not supported must prove clean rejection with no writes.

### Destination acceptance cases

1. Product catalog and opening snapshot: barcode/SKU conflict; duplicate
   identities; missing cost on positive stock; repeated identical snapshot;
   FIFO decrease; immediate catalog/POS search and stock display.
2. Customer profiles: phone/email normalization; shared and conflicting
   identifiers; name-only review; patch preserves loyalty, wallet, debt,
   spend, and consent; no page reload.
3. Customer debts: opening snapshot and itemized history; same-ID retry and
   changed-payload conflict; ledger/cache mismatch; allocation gaps; all
   supported payment methods. Assert no cash, shift/Z, wallet, store-credit,
   loyalty, sales receipt, or unrelated transaction changes.
4. Supplier contacts: normalized-name replay, conflicting contact review,
   live procurement directory refresh, and no PO/stock/payment writes.
5. Supplier receipts: stable invoice/line retry, changed-payload conflict,
   missing product/cost quarantine, group atomicity, stock batch/ledger and
   price-history verification. Assert no operational cash, expense, or
   payable change; confirm the UI labels incomplete freight.
6. IMEI/warranty: valid and invalid Luhn IMEIs, canonicalized serials,
   multiple units/identifier mismatch, product-link ambiguity, duplicate and
   conflict cases, exact warranty preservation, and sale-link requirements.
7. Trade-ins: repeated legitimate IMEI events with distinct source IDs,
   source-ID conflict, historical customer/device visibility, cash/Z/wallet
   invariance, and explicit conversion checks (blocked identifier, duplicate,
   conversion retry, stock created once, no payout/credit replay).
8. Repairs: legacy and complete v2 source rows remain in the read-only
   archive; missing/ambiguous fields are explained; deposit, cash, stock,
   technician, commission, warranty-claim, and IMEI-event counts do not
   change.
9. High-volume product import: at least 2,500 rows, exact database/UI counts,
   first/middle/last searches, no unhandled page errors, and a 30-second
   commit target.

All tests assert exact parsed/inserted/updated/no-op/skipped/quarantined counts,
row-level reasons, persisted origin after rehydration, and no unintended
cross-destination records. Use read-only database probes for assertions; do
not bypass the UI for writes.

## Phased implementation sequence

1. Shared foundation and existing product/opening-stock/customer flows;
   remove debt side effects from the profile adapter and implement the
   approved debt snapshot/itemized contracts.
2. Supplier directory and distinct historical supplier receipt adapter.
3. Serialized product/IMEI/warranty contracts and trade-in history with
   explicit inventory conversion.
4. Read-only repair archive and safe linkage to a separately created native
   v2 repair intake.
5. Complete the format/destination E2E matrix, run targeted native tests,
   typecheck, and the full isolated Playwright suite.

Each phase must preserve the owner-set SQLite, native-write, and fail-closed
policies. A phase is not complete until its database and UI tests pass and its
origin/side-effect invariants are verified.

## Out of scope

- Arbitrary SQL execution, DDL migration, or importing executable scripts.
- Importing sales, refunds, voids, cash sessions, or operational payment
  events.
- Replaying historical supplier settlements, customer cash receipts, repair
  deposits, or trade-in payouts into the live till.
- Converting every imported repair or trade-in automatically into active
  operational work or inventory.
- Fuzzy identity matching by name, amount, date, or IMEI alone.
- Implicit currency conversion or fabricated source dates, allocations,
  warranties, sale transactions, or device identifiers.

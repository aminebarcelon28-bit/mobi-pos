# Smart Import Destination Contracts — Implementation Plan

**Status:** User-approved; implementation in progress
**Design:** [Smart Import Destination Contracts](../specs/2026-10-22-smart-import-destinations-design.md)
**Baseline design:** [Smart Import & Easy Migration](../specs/2026-10-22-smart-import-design.md)

## Execution rules

- Preserve all existing dirty worktree changes. Never reset, clean, or revert
  files outside the current task.
- Keep local SQLite authoritative. All destination writes and protected
  accounting operations remain native and transactionally bounded.
- Implement one destination increment at a time. Add focused parser/native
  tests before UI E2E for each increment.
- Preview remains read-only. Do not use production data for E2E; reset only
  the isolated E2E database.
- Do not report a destination as complete until its SQLite read-back, UI
  hydration, side-effect invariants, and adversarial tests pass.

## Phase 0 — Establish a trustworthy baseline

1. Inspect the current worktree and feature-specific staged/unstaged changes.
   Keep unrelated user changes untouched.
2. Re-run the current native Smart Import suite and establish whether the
   XLSX mapping mismatch recorded in an older checkpoint still reproduces;
   a later summary reported the expanded suite green, so use the current run
   rather than either historical status as authority.
3. If the mapping mismatch reproduces, capture the native inspection payload
   and compare Rust mapping enums, IPC serialization, and UI select values.
   Fix only the confirmed root cause and add a focused regression test for
   the exact French headers and resulting mapping values.
4. Complete any unfinished E2E fixture helpers only if the current suite
   actually lacks them.
5. Run focused parser/mapping tests, TypeScript typecheck, isolated E2E build,
   and the current full Smart Import suite.

**Exit gate:** Existing product/customer flows are green in the isolated
native app, and the baseline test results are recorded. Do not broaden parser
or destination behavior while this gate is red.

## Phase 1 — Shared identity, customer profiles, and debt safety

1. Add the native source-identity crosswalk with destination, source namespace,
   source record ID, target ID, payload hash, source file hash, sheet/row,
   and creation timestamp. Enforce unique identity and same-identity payload
   conflict behavior inside the target write transaction.
2. Make customer profile imports patch only supplied profile fields. Preserve
   loyalty, store credit, spend, consent, debt, and omitted JSON payload
   fields. Remove debt-event creation and cached-debt mutation from the
   profile adapter.
3. Make phone/email identity resolution enumerate all matches. Quarantine
   ambiguous keys and phone/email mismatches; do not select an arbitrary
   `LIMIT 1` row. Preserve exact replay idempotency for no-key rows only
   within the same source file/sheet/row.
4. Add the constrained customer-debt `origin` column and carry it through
   native commit/read-back, typed models, hydration, Dexie, and sync payload.
   Existing rows default to `operational`; imported rows use
   `imported_history`.
5. Implement separate snapshot and itemized debt adapters:
   - snapshot is desired balance, ledger/cache parity checked before commit;
   - itemized events accept only supported types/kinds and preserve stable
     source identity;
   - missing/ambiguous allocations block aging-dependent groups;
   - retry is a no-op and changed payload under the same source ID conflicts.
6. Audit every cash/report/customer debt consumer. Imported settlements update
   debt balances only; they must not update cash, shifts/Z, store credit,
   loyalty, sales receipts, or unrelated financial rows. Label imported
   settlements distinctly in customer history.
7. Add database read-back and post-commit hydration assertions.

**Tests:** Snapshot match/mismatch, ledger/cache divergence, exact retry,
changed source payload, conflicting identities, duplicate source rows,
allocation gaps, all supported payment methods, and cash/wallet invariance.

## Phase 2 — Supplier directory, stock snapshots, and receipt history

1. Make SQLite `app_settings/vendor_directory` the authoritative supplier
   import write. Refresh the live vendor directory and its existing
   persistence mirror after commit. Do not synthesize product aliases from
   contact rows.
2. Implement normalized-name supplier matching with field-level patching.
   Conflicting non-empty same-name contact data is review/quarantine; blank
   input never clears existing fields.
3. Harden opening-stock snapshots:
   - show current/target/delta and FIFO impact in preview;
   - recheck stock and batch parity inside the transaction;
   - require unit cost for positive stock deltas;
   - quarantine a row whose increase has unknown/invalid cost;
   - verify repeated snapshots do not add stock.
4. Add an imported receipt-history header/line lane with stable invoice and
   line identity. Require supplier, product match, positive whole quantity,
   and explicit DZD unit cost. Keep source settlement details inert.
5. Add a native receipt-import transaction that persists receipt history,
   stock batches, RECEIVE ledger entries, supplier price history, and the
   `products.stock` projection atomically. Reuse neither the operational PO
   receive workflow nor its cash/expense/payable effects.
6. Treat absent freight as incomplete, not inferred zero. Display the
   acknowledgement in preview and preserve the incomplete-cost indicator in
   history/reporting.
7. Implement receipt-group quarantine and retry/conflict handling; one bad
   line blocks its invoice group, while a database error rolls back all groups
   in the commit.
8. Add a separate historical procurement UI lane and refresh it immediately
   after commit.

**Tests:** Contact idempotency/conflicts, supplier directory hydration,
snapshot increases/decreases/retries, unknown-cost rows, receipt group
atomicity, stable invoice/line replay, changed-payload conflict, no product
match, and no cash/expense/payable mutation.

## Phase 3 — Serialized inventory, IMEI/warranty, and trade-ins

1. Reconcile `imei_records.status` schema and TypeScript/native read/write
   projections. Extend the typed model and tests for supported
   `in_stock`/`defective` states.
2. Add import-specific IMEI validation and conflict handling using the shared
   canonical device-ID codec and intake validator. Require one unambiguous
   product link; reject invalid 15-digit Luhn values; allow canonical serials.
3. Replace the import's overwrite-on-conflict behavior with explicit
   no-op/conflict rules. A different product, sale link, status, or immutable
   warranty anchor is never silently replaced.
4. Preserve exact per-device warranty expiry and term. Do not invent sale
   links or recalculate existing anchors. Reconcile product stock with
   imported device identifiers before commit.
5. Implement trade-in history insertion with imported-origin and source
   identity. Keep it independent from inventory, IMEI registry, cash, wallet,
   and sales data. Exclude imported history from Z/shift cash totals while
   retaining customer/device-origin visibility.
6. Add the explicit native “Convert to inventory” action for a reviewed
   trade-in. It checks the identifier blocklist and registry conflicts,
   applies existing manager-authorization policy without bypasses, and
   creates product/IMEI/stock records atomically without replaying the old
   payout or wallet credit.

**Tests:** Valid/invalid IMEI, serial normalization, multiple identifiers,
stock/cardinality mismatch, same-device no-op, conflicting product/status/
warranty, sold row without real transaction, warranty immutability,
trade-in repeated-device history, source-ID conflict, cash/Z/wallet
invariance, and conversion retry/blocklist behavior.

## Phase 4 — Read-only repair archive

1. Add imported-history provenance and preserve the source repair status
   separately from operational status.
2. Add archive-specific mapping and validation for legacy and complete v2
   dossiers. Resolve customer/device links only when unique; retain
   unverified identifiers as historical text with a warning.
3. Add a dedicated archive lane that cannot enter active SAV queues. Provide
   an explicit route to start a new native v2 intake linked to the archive.
4. Exclude imported repair deposits from cash/Z aggregation. Do not call
   repair, stock, technician, commission, warranty, or device-trust workflows.

**Tests:** Legacy/complete-v2 archive readback, incomplete source quarantine,
ambiguous links, active queue exclusion, and invariant counts for deposits,
cash, inventory, timers, commissions, claims, and IMEI events.

## Phase 5 — Complete the format/destination E2E matrix

1. Maintain one fixture per supported parser format: XLSX, XLS, CSV, TSV,
   delimited TXT, vCard, JSON, JSONL, SQL, and DBF.
2. Add edge fixtures for offset/multiple-sheet headers, UTF-8 BOM,
   Windows-1252/1256, UTF-16, French/Arabic, leading zeroes, scientific
   notation, currencies, malformed input, repeated headers, and hostile SQL
   statements.
3. For every destination, execute at least one real Smart Import UI workflow,
   native commit, SQLite read-only assertion, and immediate UI/search
   assertion. Unsupported format/destination pairs must prove no writes.
4. Add and verify the pre-commit guidance for profile versus debt, supplier
   contact versus receipt, snapshot versus receipt, trade-in history versus
   sellable inventory, and repair archive versus active SAV.
5. Exercise 2,500+ product rows, first/middle/last search, responsiveness,
   exact counts, and a 30-second commit target.
6. Run the complete native Playwright suite, focused Rust import tests,
   TypeScript typecheck, and `git diff --check`. Report any unsupported
   combination explicitly; do not claim untested cases are covered.

## Global completion criteria

- Every accepted format has a deterministic parser test.
- Every enabled destination passes native DB and no-reload UI E2E.
- No import can replay cash, wallet, debt collection, repair, refund,
  trade-in payout, or purchase-settlement effects outside its approved
  contract.
- Origin and source identity survive restart/hydration and produce correct
  operational report totals.
- Quarantine reasons and completion metrics are exact and visible.
- Full tests pass against the isolated E2E database; no production/debug app
  or production database is touched.

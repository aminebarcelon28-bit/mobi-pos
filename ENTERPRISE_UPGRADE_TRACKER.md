# ENTERPRISE UPGRADE TRACKER — Mobi-POS

**Baseline:** `ENTERPRISE_POS_BENCHMARK_AND_UPGRADE_REPORT.md` (2026-10-16)
**Branch:** `remediation/a3-causal-version`
**DB user_version at baseline:** 117 (`EXPECTED_MAX_DB_USER_VERSION`, `src-tauri/src/lib.rs:294`)
**Frozen rules:** Migration v1 byte-identical (`test:migration-v1-pin`); zero-tax invariant (`check-zero-tax`, `check-money-boundary` stay green); new tables/columns/indexes land in append-only migrations **≥ 118** with `EXPECTED_MAX_DB_USER_VERSION` bumped in lockstep.
**User files preserved (do not stage/revert):** `scripts/test_barcode_decoder.mjs` (working-tree delete), `src/components/mobile/MobileCameraScanner.tsx` (unstaged edits — additive merge only in UPGRADE-12).

## Verification gate (run after EVERY upgrade, before commit)

| Gate | Command |
|---|---|
| TypeScript | `npx tsc --noEmit` |
| Lint | `npx oxlint --quiet` |
| Rust | `cargo test --manifest-path src-tauri/Cargo.toml --lib` |
| Full suite | `npm run test:all` |

Fix any failure or boundary pin immediately → mark `[x]` → atomic commit `feat(upgrade-XX): ...` → next upgrade.

---

## Sprint A — Performance & Data Model Scalability

- [x] **UPGRADE-01 — Windowed Boot Hydration & Lazy Lanes** (M)
  - Keyset-paginated windowed state `{ items, cursor, hasMore, loadMore() }`, `LIMIT 200`, `(created_at DESC, id DESC) WHERE deleted = 0`.
  - Audit / expenses / shifts / valuation → bounded on-demand lanes.
  - Safety: `ShiftCloseModal`, `buildZSnapshot`, `ReportsModal`, `RefundModal`, `transactionRepository.ts:38-41`, IMEI search (`createUISlice.ts:1564-1578`) query SQLite directly by shift/date/receipt/IMEI index.
  - **Landed:** boot/pull hydrate `transactions` via keyset window + `loadMoreTransactions` (id-dedupe); `allShifts` windowed (200) with exact `getShiftStats()` counts for Z-numbering; `storeExpenses` boot window (300) + on-demand full/range reads; `inventoryValuation` dropped from boot lanes (still set on shift open/close).
  - **Safety consumers now SQLite-direct:** shift close + interim Z (complete shift-window txns + range expenses + exact counts), mid-shift X (`printXReport`), ReportsModal (`reportTxns` range read, honest tab count, on-open expense/shift refresh), RefundModal (direct receipt/id lookup on scan + typed search fallback + load-more wiring), barcode scanner hook, `transactionRepository.findByReceipt` (idx_transactions_receipt), IMEI inspector (dossier resolver merged with direct `findTransactionsByImei` + certificate invoice direct read), SAV intake warranty resolver (same merge), CustomersModal (full-history open read), mobile Management/LiveActivity (range reads), diagnostics + DB maintenance honest counts via `getTransactionsCount()`.
  - **Audit lane:** verified already bounded (`LIMIT 300`, `operationsAdapter.ts:410`) — unchanged.
  - **Residuals (accepted):** RefundModal prior-refund preview stays store-scoped by documented design; submit re-verifies against durable rows (slice unions Dexie full mirror). Repair-intake lookup direct-merge landed (see above). Web preview falls back to Dexie readers (no SQLite).
  - No migration: all needed indexes pre-existed (118 reserved for UPGRADE-02). Zero-tax pin moved `createOrderSlice.ts:480 → :483` (3-line window-field insert, comment preserved).
- [x] **UPGRADE-02 — SQLite Engine & Payload Hygiene Pack** (M)
  - `tune(conn)` helper on every per-invoke connection (`synchronous=NORMAL`, `cache_size=-16000`, `temp_store=MEMORY`).
  - One-shot de-double-encode `json_payload`; stop `products.json_payload` rewrite in stock heal.
  - New migration ≥ 118: `repair_orders(created_at DESC)`, `purchase_orders(created_at DESC)`, `trade_ins(created_at DESC)`, `imei_records(received_at DESC)` indexes.
  - 90-day `event_log` compaction/prune (synced rows only).
  - **Landed:** `db.rs::tune()` (synchronous NORMAL, 16 MiB cache, MEMORY temp, desktop-only 256 MiB mmap) called from all five per-invoke opens (`initialize_database`, `commands.rs`, `checkout.rs`, `refund.rs`, `sync_outbox.rs`); migration **v118** (4 ORDER BY indexes) with `EXPECTED_MAX_DB_USER_VERSION` 117→118; both stock-side `products.json_payload` rewrites removed (stock heal + post-sale stub refresh — the stock column is the query truth).
  - **De-double-encode:** latched one-shot boot heal (`healDoubleEncodedJsonPayloads`, flag `schema.heal.json_dedouble.done`) instead of in-migration SQL — a malformed legacy payload must never abort a migration; rowid-paged 500/page over 14 dual-store tables; envelope unwrap = row fields win over the nested copy; table-level failure skips the latch (retries next boot).
  - **event_log prune:** `pruneStaleEventLog` deletes only rows with a positive sync marker (`synced_to_cloud = 1`) older than 90 days. FAIL CLOSED — the production v100 shape has no sync column, so its rows are left untouched rather than guessed about.
  - **Audit (decision):** bundled SQLite = 3.45.0 (`libsqlite3-sys 0.28.0` / rusqlite 0.31) < 3.51.3 → bump deferred (crosses 6 rusqlite minors: API migration + dependency approval; WAL-reset window needs crash-during-reset). Tracked as open. `transactions.tax` already dropped by v108 (v1 must keep the pre-drop shape for the frozen pin; plugin migrator is transactional) — verified-existing. WebView plugin pool pragmas remain sqlx defaults by design (patched plugin rejects pragma setters from JS).
  - **Deferred (documented):** "json_payload holds non-scalars only" rule — a coordinated reader migration across 14 tables; the one-shot pass removes the corruption surface meanwhile.
- [x] **UPGRADE-03 — Activate sqlite-vec Semantic Matching** (M–L)
  - `index_product` wired on product save + PO receive; `vec_products` populated.
  - `checkout_suggest_accessories(seedProductId, k)` + non-intrusive UI suggestions.
  - **Landed (native):** `vec_index_product` (upsert; empty name = delete), `checkout_suggest_accessories` (k clamped 1–8, seed self-exclusion, advisory 0.9 distance cut, re-joins live non-deleted products), `vec_reindex_catalog` (latched rebuild, flag `vec_index.backfill.v1` in `app_settings`, keyset-batched 500/page, `force` re-run after bulk imports). All three registered in `COMMAND_REGISTRY` (index writes = `OperationalWrites` → fail-closed while locked; suggestions = `ReadOperationalData`) + `ALL_COMMAND_FNS_IN_TESTS` + both `generate_handler![]` blocks.
  - **Population:** `saveProduct` fires `vec_index_product` (title‖brand‖compat), `deleteProduct` fires removal, `bulkSaveProducts` forces one idempotent rebuild, `getAllProducts` boot fires the latched backfill once per session — all fire-and-forget: the advisory projection never blocks or fails a catalog write. PO receive indexes touched products after `tx.commit()` in `commit_batch_inner` (best-effort, logged, never fails a committed receipt).
  - **UI:** `useSemanticSuggestions` hook (250 ms debounce, seq-guarded, stock>0) + `AccessorySuggestions` chip strip in `MobileCheckoutTab`; desktop `CartPanel` merges the semantic lane into the existing suggested-products drawer (deduped, header falls back to `Suggérés` without a model). Tap-to-add only — nothing ever auto-applies; chip failures surface a toast.
  - **Audit (decision):** no migration — `vec_products` is lazily created by native `ensure_po_recon_tables` (plugin v106 stays plain-table-only; sqlx cannot load vec0). Default build keeps deterministic token-hash embeddings (`po-embed` OFF): exact/token neighbors only; enabling `po-embed` upgrades recall with no further wiring.
  - **Residuals (accepted):** vec rows for deleted products linger until the next rebuild (filtered at query time); a lost latch only re-runs the idempotent rebuild; suggestions are advisory-only (operator tap is the sole commit path, routing through normal `addToCart` rules).

## Sprint B — GSM / SAV / Wholesale Revenue Multipliers

- [ ] **UPGRADE-04 — Customer Price Books + Tier-Switch PIN Guard + Volume-Break Nudges** (M)
- [ ] **UPGRADE-05 — Technician Roster, Assignment, Time-on-Job & Commissions** (M)
- [ ] **UPGRADE-06 — True SAV Economics: FIFO Cost-Basis Roll-Up + Supplier RMA Loop + Warranty/Redo Claims** (M)
- [ ] **UPGRADE-07 — Freight Landed-Cost Allocation + Supplier Price History** (M)
- [ ] **UPGRADE-08 — Device Trust Pack: Trade-In Rubric + Blocked-IMEI Screen + IMEI Ownership Ledger** (S–M)

## Sprint C — Anti-Theft EBR, Kredy Intelligence & Mobile Power Tools

- [ ] **UPGRADE-09 — Cashier Exception Intelligence (EBR-lite, Compute-on-Read)** (M)
- [ ] **UPGRADE-10 — Scheduled ABC Micro-Stocktakes + 100% Drawer-Pulse Audit Coverage** (M)
- [ ] **UPGRADE-11 — Kredy Collection & Risk Engine (aging/PTP/scoring + `docs/kredy-defects.md`)** (M–L)
- [ ] **UPGRADE-12 — Mobile Floor Power Tools (Camera Stocktake + Cart Handoff + SAV Photo Kinds)** (M)

---

## Progress log

| Upgrade | Status | Commit | tsc | oxlint | cargo | test:all | Notes |
|---|---|---|---|---|---|---|---|
| 01 | done | feat(upgrade-01) | ✓ | ✓ | ✓ | ✓ | 200-row keyset window + on-demand lanes; money-critical reads SQLite-direct by index; zero-tax pin :480→:483; no migration (indexes pre-existing) |
| 02 | done | feat(upgrade-02) | ✓ | ✓ | ✓ | ✓ | `tune()` on 5 per-invoke opens; migration v118 (4 ORDER BY indexes, max version 118); latched payload de-double-encode boot heal (14 tables); stock-heal JSON rewrites removed; event_log 90-day prune fail-closed on missing sync marker; SQLite 3.45.0 bump deferred |
| 03 | done | feat(upgrade-03) | ✓ | ✓ | ✓ | ✓ | `vec_index_product` / `vec_reindex_catalog` (latched `vec_index.backfill.v1`) / `checkout_suggest_accessories` + registry+handler wiring; save/delete/bulk/PO-receive population hooks; mobile chip strip + desktop drawer merge, tap-to-add only; cargo 293/293, zero-tax & boundary pins untouched (no migration) |
| 04 | pending | — | — | — | — | — | |
| 05 | pending | — | — | — | — | — | |
| 06 | pending | — | — | — | — | — | |
| 07 | pending | — | — | — | — | — | |
| 08 | pending | — | — | — | — | — | |
| 09 | pending | — | — | — | — | — | |
| 10 | pending | — | — | — | — | — | |
| 11 | pending | — | — | — | — | — | |
| 12 | pending | — | — | — | — | — | |

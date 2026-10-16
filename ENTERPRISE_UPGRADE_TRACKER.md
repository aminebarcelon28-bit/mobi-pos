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

- [ ] **UPGRADE-01 — Windowed Boot Hydration & Lazy Lanes** (M)
  - Keyset-paginated windowed state `{ items, cursor, hasMore, loadMore() }`, `LIMIT 200`, `(created_at DESC, id DESC) WHERE deleted = 0`.
  - Audit / expenses / shifts / valuation → bounded on-demand lanes.
  - Safety: `ShiftCloseModal`, `buildZSnapshot`, `ReportsModal`, `RefundModal`, `transactionRepository.ts:38-41`, IMEI search (`createUISlice.ts:1564-1578`) query SQLite directly by shift/date/receipt/IMEI index.
- [ ] **UPGRADE-02 — SQLite Engine & Payload Hygiene Pack** (M)
  - `tune(conn)` helper on every per-invoke connection (`synchronous=NORMAL`, `cache_size=-16000`, `temp_store=MEMORY`).
  - One-shot de-double-encode `json_payload`; stop `products.json_payload` rewrite in stock heal.
  - New migration ≥ 118: `repair_orders(created_at DESC)`, `purchase_orders(created_at DESC)`, `trade_ins(created_at DESC)`, `imei_records(received_at DESC)` indexes.
  - 90-day `event_log` compaction/prune (synced rows only).
- [ ] **UPGRADE-03 — Activate sqlite-vec Semantic Matching** (M–L)
  - `index_product` wired on product save + PO receive; `vec_products` populated.
  - `checkout_suggest_accessories(seedProductId, k)` + non-intrusive UI suggestions.

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
| 01 | pending | — | — | — | — | — | |
| 02 | pending | — | — | — | — | — | |
| 03 | pending | — | — | — | — | — | |
| 04 | pending | — | — | — | — | — | |
| 05 | pending | — | — | — | — | — | |
| 06 | pending | — | — | — | — | — | |
| 07 | pending | — | — | — | — | — | |
| 08 | pending | — | — | — | — | — | |
| 09 | pending | — | — | — | — | — | |
| 10 | pending | — | — | — | — | — | |
| 11 | pending | — | — | — | — | — | |
| 12 | pending | — | — | — | — | — | |

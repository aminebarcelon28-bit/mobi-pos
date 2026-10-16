# ENTERPRISE POS BENCHMARK & UPGRADE REPORT — Mobi‑POS

**Date:** 2026‑10‑16 · **Baseline:** post‑Sprint 5 · **Mode:** read‑only swarm (5 parallel sub‑agents: web research + codebase forensics) · **Invariant:** strict zero‑tax, Net DZD (FIFO COGS / cashflow / supplier AP / Kredy / shrinkage only — no VAT/TVA anywhere)

**Evidence rule:** every repo claim cites `path:line` (spot‑verified by the orchestrator); every industry claim cites a source URL. Where a sub‑agent's web‑search tool failed, direct page fetches were used and marked.

---

## 1. Executive Competitive Benchmark Matrix

Legend: **Ahead** = Mobi‑POS at/above leaders · **At par** = comparable · **Behind** = leader gap.

| # | Capability | Mobi‑POS (Current) | GSM tools (RepairDesk / CellSmart / RepairShopr) | Enterprise retail (Lightspeed / Square) |
|---|---|---|---|---|
| 1 | Offline‑first operation | **Ahead** — full offline sale/refund/void on native engines + outbox sync (`checkout.rs:1‑22`) | Behind — cloud‑first; offline mode historically on roadmaps | Behind — cloud‑first POS; sync requires connectivity |
| 2 | Atomic money path (FIFO COGS) | **Ahead** — single native `BEGIN IMMEDIATE`, oversell vs ledger, frozen `sale_batch_allocations`, materialized `ledger_cogs_total` (`checkout.rs:9‑22`, `lib.rs:1525‑1565`) | At par — server‑side, not locally verifiable | At par — mature COGS (Odoo FIFO), but cloud‑executed |
| 3 | Tamper‑evident audit & identity | **Ahead (unique)** — HMAC‑keyed audit chain + head MAC + verify (`audit_append.rs:10‑11,605,738`), Ed25519 per‑device identity, signed refunds w/ 120 s supervisor freshness (`refund.rs:480,2128`) | Behind — standard logs | Behind — standard logs / EBR, no cryptographic chain |
| 4 | IMEI serialized lifecycle | **Partial** — dossier + frozen snapshot, Luhn gate, warranties; no blacklist screen, void erases sale link (`transactionAdapter.ts:239,485`) | **Ahead** — IMEI checker, serialized tracking, refurb/trade‑in flows (repairdesk.co; cellsmartpos.com/imei2) | Behind — generic serialization, not device‑trade oriented |
| 5 | Repair workshop (SAV) depth | **Partial** — append‑only status history, native anchored photos, true FIFO parts; no tech assignment writers/commissions, multi‑device tickets, subcontractor lane, bench/delivery photos (`pos.ts:1178` dead; `sav_attachments.rs:1`) | **Ahead** — workflow enforcement, mandatory steps, skip/violation highlighting, multi‑device tickets, pre/post photos, commission+payroll (blog.repairdesk.co Aug‑2025; cell repair page) | Missing — not core |
| 6 | Trade‑in + warranty/RMA recovery | **Partial** — disciplined buyback (Luhn, dup‑warn, FIFO minting `createUISlice.ts:829‑864`); grading rubric dead code, `defective_returns` write‑only (zero readers), no redo/claim tracking | **Ahead** — grading standards, refurb tickets, RMA reports, serialized valuation (repairdesk.co; servicecentral.com RepairQ) | Behind — voucher/trade rarely modeled |
| 7 | High‑velocity checkout | **Ahead** — wedge scanner w/ burst guard + in‑memory index, zero DB roundtrip per scan, full F‑key suite, <5 ms native commit (`useBarcodeScanner.ts:149‑153,233‑246`; `useKeyboardHotkeys.ts:81‑220`) | Partial — decent, cloud‑dependent | At par — mature hotkeys/quick keys (Lightspeed shortcut KBs) |
| 8 | B2B / semi‑wholesale pricing | **Partial** — 3 tiers incl. demi‑gros + per‑product volume ladders (`pricingEngine.ts:17‑62,93‑141`); no customer price books; tier switch one‑click ungated (`CartPanel.tsx:1064‑1082`) | Behind — limited | **Ahead** — Price Books / B2B catalogs (x‑series-support; shopify B2B quantity pricing) |
| 9 | Inventory intelligence | **Partial** — strict FIFO, JIT reorder, receipt‑time velocity; no catalog ABC, dead‑stock alerts, landed cost, cycle‑count cadence, supplier price history | Partial — RMA/low‑stock/valuation | **Ahead** — ABC/cycle‑count guidance, Odoo landed costs, Lightspeed freight distribution in margins |
| 10 | Loss prevention | **Capture: Ahead / Analytics: Behind** — HMAC audit chain, PIN‑gated no‑sale + logged removals, blind closeout; zero EBR rate layer/thresholds/approver analytics | Behind — basic reports | Partial–**Ahead** — Toast exception reports (voids by server/approver), Agilence‑class EBR |
| 11 | Kredy debt intelligence | **Partial** — ledger‑first integrity, ceiling enforced both platforms; no aging buckets, due dates, installments, scoring, dunning; known defect doc (`docs/kredy-defects.md`) | Partial — reminders via SMS/email | Partial — AR aging standard; per‑transaction scoring is BNPL‑external |
| 12 | Mobile companion | **Ahead** — true peer terminal: cash/credit/CIB/BaridiMob/chèque + WhatsApp receipt (`MobileCheckoutTab.tsx:456‑733`); missing camera stocktake, SAV intake | Behind — thin companions | At par — Square handhelds; Shopify POS Go hardware discontinued but mobile selling supported |

**Where Mobi‑POS wins today**

- Offline integrity no GSM‑tier competitor matches: atomic sales/refunds/exports with no network dependency (`checkout.rs`, `refund.rs`).
- A cryptographic trust stack (hash‑chained audit + device identity + signed refunds) that is **unique in this class**.
- Zero‑tax DZD precision: integer cash math, threshold‑gated blind closeout (`shiftAdapter.ts:805‑826`); no fiscal engine anywhere.
- Cashier capture completeness: PIN‑gated no‑sale on desktop+mobile (`Header.tsx:220‑244`), every cart‑removal vector logged (`CartPanel.tsx:1370‑1377`), race‑safe voucher lifecycle (`voucherAdapter.ts:201‑269`) — better than Toast, whose key‑opened drawers are untracked.
- Mobile is a production terminal, not a viewer — beyond the “companion” category.

**Where competitors lead**

- Repair workflow enforcement + technician economics (assignment, timers, commissions, pre/post photos, multi‑device tickets) — RepairDesk/CellSmart.
- Customer‑specific B2B price books — Lightspeed.
- Inventory science: ABC cycle counting, landed costs, supplier price history, freight distribution into margins — Odoo/Lightspeed.
- Exception‑based‑reporting analytics maturity (rates, thresholds, approver views) — Toast/Agilence‑class.
- Automated customer notifications (auto SMS/WhatsApp status) — CellSmart/RepairDesk/SmartRepairDesk.

---

## 2. Deep Data Model & Architecture Optimization Blueprint

### 2.1 Boot hydration & RAM (confirmed unbounded — the #1 scaling risk)

- Wave‑2 boot loads **14 lanes in parallel into Zustand RAM**: `createUISlice.ts:1795‑1828` (`getAllTransactions`, `getAllAuditLogs`, `getAllShifts`, `getInventoryValuation`, all IMEI, all debts/expenses/POs/trade‑ins…), then `set()` at `:1811‑1828`. Verified.
- The worst lane is the **entire transaction history via Dexie `toArray()`**: `transactionAdapter.ts:134‑144`. Products/customers/IMEI/audit are **unbounded SQLite reads**: `productAdapter.ts:119‑141`, `customerAdapter.ts:217‑256`, `operationsAdapter.ts:326‑341` (IMEI, verified), `:449‑452` (comment: “the unbounded read used by the boot/hydrate paths”, verified), `shiftAdapter.ts:975‑1001` (all shifts + full valuation recompute).
- Every sync pull **re‑hydrates ~16 lanes wholesale** (`createUISlice.ts:1861‑1895`) and the targeted variant falls back to `getAllTransactions()` (`:1993‑2001`).
- O(N) per‑action scans over RAM: receipt lookup (`transactionRepository.ts:38‑41`), IMEI search (`createUISlice.ts:1564‑1578`), refund list (`RefundModal.tsx:131‑157`), shift close (`ShiftCloseModal.tsx:135,145`), Excel export (`src/utils/excel/sheets.ts:258,347`).
- **Target design (UPGRADE‑01):** windowed store `{items, cursor, hasMore, loadMore()}`; keyset SQL `WHERE deleted=0 AND (created_at<?c OR (created_at=?c AND id<?id)) ORDER BY created_at DESC, id DESC LIMIT 200` + partial index; lazy lanes for audit/expenses/valuation/shifts (existing bounded reader at `operationsAdapter.ts:410`; valuation view `lib.rs:1116‑1121`); receipt/IMEI lookups via existing indexes (`lib.rs:1041`, `1338`). Target: constant boot RAM at 100 k tx / 20 k SKUs.

### 2.2 `json_payload` dual storage + double‑encoding

- 13+ tables dual‑store relational columns **plus** a full JSON copy: `products` `lib.rs:1008`, `customers` `:1020`, `transactions` `:1039`, `transaction_items` `:1048`, `repair_orders` `:1058`, `purchase_orders` `:1066`, `trade_ins` `:1074`, `product_bundles` `:1095`, `cash_sessions` `:1104`, `cash_movements` `:1111`, `customer_debts` `:1126`, `store_expenses` `:1135`; plus `defective_returns`/`vendor_disputes`/`held_orders` (`sqlPluginAdapter.ts:518,567,5516‑5524`) and `app_settings.value_json` (`:1098`).
- **Double‑encoding artifacts are patched at runtime**: `parsed.json_payload` is itself a JSON string (`sqlPluginAdapter.ts:664‑668,1386‑1390`) and the stock heal rewrites `products.json_payload` on every reconcile (`:721‑734`).
- **Fix (UPGRADE‑02):** one‑shot de‑encode pass; canonical rule = `json_payload` holds non‑scalar fields only (sync envelope + frozen snapshots); stop JSON rewrites in stock heal; keep JSON as the wire format, columns as the query truth.

### 2.3 Indexes, PRAGMAs, engine hygiene

- Index coverage is good for hot sales paths (`lib.rs:1041‑1044`) but **missing for actual ORDER BYs**: `repair_orders`/`purchase_orders`/`trade_ins` by `created_at DESC` (`operationsAdapter.ts:117,191,267`) and `imei_records.received_at DESC` (`:331`) have no supporting index.
- Per‑invoke native connections set WAL + busy_timeout but **not `synchronous`/`cache_size`/`mmap`** (`commands.rs:49‑53`, `checkout.rs:242‑245`, `refund.rs:428‑431`, `sync_outbox.rs:350‑353` vs baseline `db.rs:114‑117`) — in WAL mode, unspecified `synchronous` defaults to FULL per connection.
- **Bundled SQLite vintage check:** WAL‑reset corruption bug affects ≤ 3.51.2, fixed in 3.51.3 (`sqlite.org/wal.html` §11); `rusqlite 0.31 bundled` (`Cargo.toml:52`) needs version audit + upgrade decision.
- Inert legacy wart: `transactions.tax REAL DEFAULT 0` (`lib.rs:1034`, verified) — dead column; drop in the next maintenance migration to align DDL with the zero‑tax invariant (no tax logic exists).
- `event_log` has no local prune/compaction (`eventInterceptor.ts:54‑96`; `eventSyncEngine.ts:45‑50`) → 90‑day rollup + prune plan.

### 2.4 sqlite‑vec / `resolver.rs` — wired but never fed

- The dependency, extension registration, `vec0` table and 3‑tier resolver all exist (`Cargo.toml:53`; `db.rs:21‑30,61‑65,68‑74`; `resolver.rs:1‑15,123‑253,318‑429`; commands `lib.rs:2026‑2029`), deliberately native‑only (sqlx can't load vec0 — `db.rs:69‑74`).
- **But `index_product` has zero production callers** (only a test at `resolver.rs:497`) → Tier‑2 semantic matching returns empty in production. Activation plan = UPGRADE‑03.

### 2.5 Sync & scale (already strong — protect it)

- Pull is keyset‑paginated (`SyncManager.ts:2311,2316`), payload hygiene is bounded (64 KB budget, blob strip, money keys protected — `payloadHygiene.ts:20‑50,68‑134`; push gate `SyncManager.ts:1416`), outbox rows are deleted on sync (`sqlPluginAdapter.ts:2738,2756‑2779`) with stale‑inflight watchdog (`outboxFlusher.ts:27‑69`). Remaining bloat is **local** (Dexie mirror + `event_log`), not wire.
- Dexie is a **third copy** (SQLite + IndexedDB + RAM); after UPGRADE‑01, windows read SQLite and Dexie demotes to web‑preview mirror.

---

## 3. Domain‑by‑Domain Strength & Gap Analysis (Sub‑Agents 1–5)

### 3.1 GSM / IMEI / Repair Workshop (SAV)

**Already enterprise‑grade:** write‑boundary v2 intake validation (`createRepairSlice.ts:53‑97,328‑337`); append‑only status history (`pos.ts:967‑995`); strict STORE vs REPAIR warranty tiers on an immutable anchor (`pos.ts:838‑868`; `warrantyResolver.ts:466‑563`); frozen IMEI dossier (`pos.ts:1165‑1176`); SHA‑256‑anchored photo evidence, native‑only, refuses locked terminals (`sav_attachments.rs:1‑16,82‑138`); FIFO parts consumption with batch‑level `unitCost` + restore on reversal (`createRepairSlice.ts:110‑281`); Luhn‑gated trade‑in buy‑in with FIFO batch minting (`TradeInBuybackModal.tsx:241‑327`).

**Lacking (verified):** `assignedTechnicianId` is a dead field — zero writers, no technician directory (`pos.ts:1178`; `receiptViewModel.ts:218‑219`; `FEATURE_GAP_AND_ROUTE_MATRIX.md:123`); zero commission code; SAV profit is fiction (`costTotal: partsCost` at `RepairWorkOrderModal.tsx:699‑762`; settlement at `costPrice:0` `savSettlement.ts:37`); `defective_returns` has a single writer (customer refunds — `createOrderSlice.ts:2995‑3021`) and **zero readers**; no warranty‑claim/redo tracking; notifications manual + unlogged (`repairNotificationEngine.ts:25‑101`); trade‑in rubric `PreOwnedInspectionChecklist` is dead code (`pos.ts:1332‑1343`); no blocked‑IMEI screening; void erases the device's sale link (`transactionAdapter.ts:239,485`); one device per ticket; intake‑only photos.

**High‑ROI upgrades:** UPGRADE‑05 (technicians), UPGRADE‑06 (true COGS + RMA + claims), UPGRADE‑08 (device trust).

### 3.2 High‑Velocity Checkout, B2B & Inventory Models

**Already enterprise‑grade:** native single‑hop atomic checkout (`checkout.rs:9‑22`; `lib.rs:2027‑2031`; barrier `sqlPluginAdapter.ts:1197‑1208`); strict FIFO with frozen allocations (`lib.rs:1455‑1482,1525‑1548`); oversell against ledger (`checkout.rs:15‑17`); wedge scanner with burst guard, multiplier syntax, AIM strip, in‑memory index, **no DB roundtrip per scan** (`useBarcodeScanner.ts:149‑153,174‑184,233‑246`); full F‑key suite (`useKeyboardHotkeys.ts:81‑220`); 3‑tier pricing incl. demi‑gros + volume ladders with editor (`pricingEngine.ts:17‑62,93‑141`; `ProductEditorModal.tsx:1301‑1355`); PIN‑gated price override with audit (`CartPanel.tsx:366‑398`); OCR PO recon with invoice invariant (`gate.rs:44,69‑73,166‑167`); PO receiving with IMEI gate + FIFO minting (`createProcurementSlice.ts:379‑465,583‑624`); held sales with TTL/revalidation/durable table (`createCartSlice.ts:537‑624`; `lib.rs:1774‑1795`).

**Lacking (verified):** tier switch is one click, ungated, unlogged (`CartPanel.tsx:1064‑1082` → `createUISlice.ts:256‑281`); no customer price books; volume ladders live only in `json_payload` (no SQL reporting — `lib.rs:1001‑1009`); freight validated but **never allocated into batch cost** (`gate.rs:166‑167`; `commands.rs:218‑221`; `createProcurementSlice.ts:610‑624`); no supplier price history; ABC exists only receipt‑scoped (`stockVelocityEngine.ts:48‑57`); no dead‑stock alerts; counting is all‑or‑nothing (`InventoryManagerModal.tsx:300,1147`); logged TS fallback exists on checkout (`sqlPluginAdapter.ts:1210‑1221` — not silent, but an owner decision against the AGENTS “no fallbacks on money paths” posture); checkout trusts client‑computed prices (`checkout.rs:44‑59`) — fine under the accepted WebView residual, but keep in view for price books.

**High‑ROI upgrades:** UPGRADE‑04 (price books + guard + nudges), UPGRADE‑07 (landed cost + price history).

### 3.3 Anti‑Theft, Loss Prevention & Cashier Accountability

**Already enterprise‑grade (verified):** HMAC keyed audit chain with head MAC + absence honesty (`audit_append.rs:10‑11,605,738,1362`); no unchained fallback (`createUISlice.ts:484‑515`); refund anti‑replay (`refund.rs:12,545`; trigger `sqlPluginAdapter.ts:195‑197`); supervisor freshness + device binding (`refund.rs:480,212,1322`); no‑sale = PIN + audit on desktop & mobile (`Header.tsx:220‑244`, verified; `ManagementTab.tsx:120‑144`); all six cart‑removal vectors logged (`CartPanel.tsx:1370‑1377`, verified); void PIN + reason; blind closeout with mandatory note + ≥1 000 DZD manager PIN (`shiftAdapter.ts:805‑826`, verified); voucher race‑safety + idempotent credit‑back (`voucherAdapter.ts:201‑269,313‑359`); stocktake ADJUST books at cost (`createCatalogSlice.ts:534‑570`); denial‑burst intel (`auditIntel.ts:1402‑1437`).

**Lacking:** no EBR layer at all (zero `riskScore|anomalyScore|EBR` hits): no per‑cashier rates, no threshold flags, no approver analytics, no void‑reason frequency, variance and exceptions never joined, no cashier risk view; stocktake not ABC‑scheduled; no‑sale counting absent; attribution by display‑name strings, not stable IDs (`createUISlice.ts:433,460`); settings test drawer pulse unlogged (`HardwareSettingsTab.tsx:110‑121`).

**High‑ROI upgrades:** UPGRADE‑09 (exception intelligence, compute‑on‑read — zero new writable tables), UPGRADE‑10 (micro‑stocktakes + pulse coverage).

### 3.4 Data Models, SQLite/Rust Performance & Sync

**Already enterprise‑grade:** per‑command lock discipline (`commands.rs:44‑56`); verified baseline PRAGMAs (`db.rs:114‑117`); monthly maintenance off the boot path (`lib.rs:882‑894`; `App.tsx:1032‑1044`); mostly complete index set (`lib.rs:1010‑1014,1041‑1044,1180‑1185`; partial FIFO index `sqlPluginAdapter.ts:244`); outbox discipline + signed drain (`syncDrainWorker.ts:51`); payload hygiene; keyset pull; write mutex/busy retry/schema heal (`writeMutex.ts:24‑33`; `busyRetry.ts:44‑157`); virtualization already landed where it matters (`CustomersModal.tsx:2`, `InventoryManagerModal.tsx:2`, `RefundModal.tsx:117‑121`).

**Lacking:** everything in §2.1–2.4 (boot hydration, O(N) fan‑out, dual/double JSON, index gaps, per‑invoke PRAGMA omissions, vec unpopulated, Dexie triple storage, unbounded `event_log`).

**High‑ROI upgrades:** UPGRADE‑01/02/03.

### 3.5 Customer Retention, Kredy Debt & Mobile Companion

**Already enterprise‑grade:** ledger‑first payment pipeline with clamp/change‑due and drawer deposit (`createCustomerSlice.ts:366‑593`); balance reconciled from ledger (`sqlPluginAdapter.ts:2628‑2667`); credit ceiling enforced desktop+mobile (`createOrderSlice.ts:554‑563`; `MobileCheckoutTab.tsx:570‑587`); overpayment protection; rich loyalty engine (`loyaltyEngine.ts:60‑116`); mobile completes cash/credit/CIB/BaridiMob/chèque + WhatsApp receipt (`MobileCheckoutTab.tsx:456‑733`, verified); Kredy mobile workflow + statements (`KredyTab.tsx:193‑313`); stocktake ADJUST audit (`sqlPluginAdapter.ts:5433,5448`).

**Lacking (verified):** no aging buckets — mobile “aging” is mislabeled days‑since‑activity (`KredyTab.tsx:139‑164`, verified); no due dates/PTP/installments in schema (`pos.ts:384‑396`, verified); WhatsApp is deep‑link‑only and silent‑fails (defect I4), with no log/opt‑in (`debtNotificationEngine.ts:67‑75`, verified; `docs/kredy-defects.md`); no dunning automation; no reliability scoring; dual credit‑gate drift (`createCustomerSlice.ts:22‑24`); loyalty QR cosmetic + hardcoded value ×10 (`LoyaltyCardModal.tsx:228,250`); no mobile camera stocktake mode.

**High‑ROI upgrades:** UPGRADE‑11 (Kredy engine), UPGRADE‑12 (mobile floor tools).

---

## 4. Top 12 Ranked Enterprise Upgrades (The Implementation Menu)

Order = recommended build sequence; tiers group scope. Each item: **Value → Files/Tables → Schema/Model → Effort**.

### Tier A — Performance & Data Model Scalability

**UPGRADE‑01 — Windowed Boot Hydration & Lazy Lanes** · Effort **M**

- **Value:** boot time and RAM stay flat at 100 k+ transactions / 20 k+ SKUs; kills O(all) re‑hydration on every pull.
- **Files/tables:** `createUISlice.ts:1795‑1828,1861‑1895,1993‑2001`; `transactionAdapter.ts:134‑144`; `productAdapter.ts:119‑141`; `customerAdapter.ts:217‑256`; `operationsAdapter.ts:326‑341,410,449‑452`; `shiftAdapter.ts:975‑1001`; consumers `RefundModal.tsx:131‑157`, `ShiftCloseModal.tsx:135,145`, `transactionRepository.ts:38‑41`, `sheets.ts:258,347`.
- **Schema/model:** store `{historyWindow, cursor, hasMore, loadMore()}`; keyset SQL + `CREATE INDEX idx_txn_hist ON transactions(created_at DESC) WHERE deleted=0;`; audit/expenses/valuation/shifts become on‑demand lanes (existing bounded reader `operationsAdapter.ts:410`); receipt lookup via `idx_transactions_receipt`.
- **Effort:** M.

**UPGRADE‑02 — SQLite Engine & Payload Hygiene Pack** · Effort **M**

- **Value:** smaller rows, fewer fsyncs, correct SQL sorts at 100 k rows; removes double‑encoding corruption surface; caps local log growth.
- **Files/tables:** the 13+ dual‑store tables (§2.2); double‑encode sites `sqlPluginAdapter.ts:664‑668,721‑734,1386‑1390`; PRAGMA sites `db.rs:114‑117`, `commands.rs:49‑53`, `checkout.rs:242‑245`, `refund.rs:428‑431`, `sync_outbox.rs:350‑353`; `eventInterceptor.ts:54‑96`.
- **Schema/model:** `tune(conn)` helper (`synchronous=NORMAL`, `cache_size=-16000`, `temp_store=MEMORY`, desktop‑only `mmap`); one‑shot de‑double‑encode migration; JSON‑holds‑non‑scalars‑only rule; stock heal stops JSON rewrites; new indexes (`repair_orders`/`purchase_orders`/`trade_ins` created_at DESC; `imei_records` received_at DESC); `event_log` 90‑day rollup+prune; drop inert `transactions.tax` column (`lib.rs:1034`); audit bundled SQLite ≥ 3.51.3 (`Cargo.toml:52`).
- **Effort:** M (aggregate of small independent changes).

**UPGRADE‑03 — Activate sqlite‑vec Semantic Matching** · Effort **M–L**

- **Value:** `resolver.rs` Tier‑2 becomes live: accessory suggestions at checkout, PO line recall for recon.
- **Files/tables:** `resolver.rs:94,489‑514`; `db.rs:61‑65,68‑74`; `Cargo.toml:53`; registration `lib.rs:2026‑2029`; PO commit `commands.rs:157‑170`.
- **Schema/model:** populate `vec_products` natively on product save + PO receive (`index_product(title‖brand‖compat)`); new native `checkout_suggest_accessories(seedProductId, k)`; suggestions‑only, never auto‑apply.
- **Effort:** M–L.

### Tier B — GSM / SAV / Wholesale Revenue Multipliers

**UPGRADE‑04 — Customer Price Books + Tier‑Switch Guard + Volume‑Break Nudges** · Effort **M**

- **Value:** contract pricing for gros/demi‑gros customers; closes the one‑click wholesale leak; existing ladders start nudging instead of hiding.
- **Files/tables:** `pricingEngine.ts:51‑62,119‑125`; `CartPanel.tsx:1064‑1082` (+ PIN pattern `:366‑398`); `createUISlice.ts:256‑281`; `createCartSlice.ts:207,618‑624`; `ProductEditorModal.tsx:1301‑1355`; `MobileCheckoutTab.tsx:847‑853`.
- **Schema/model:** `price_books(id,name,customer_id NULL,valid_from,valid_to,priority,status)` + `price_book_items(book_id,product_id,unit_price,min_qty)`; gate tier switch on manager PIN + `logSecurityAction('Changement Tarif')`; `getNextVolumeTier()` chip; optionally promote `semi_wholesale_price`/`volume_discounts` to SQL columns.
- **Effort:** M.

**UPGRADE‑05 — Technician Roster, Assignment, Time‑on‑Job & Commissions** · Effort **M**

- **Value:** labor accountability + per‑tech productivity + payroll/commission basis (industry parity: RepairDesk/CellSmart commission modules).
- **Files/tables:** `pos.ts:1178` (dead field); `createRepairSlice.ts`; `RepairWorkOrderModal.tsx:1037`; `receiptViewModel.ts:218‑219`; `savTicketBuilder.ts:120‑121`.
- **Schema/model:** `technicians(id,name,active,role)`; `technician_time_log(id,repair_id,technician_id,kind,started_at,ended_at)`; wire `assigned_technician_id` writers + statusHistory on reassignment; `commission_rules` evaluated on settled repairs.
- **Effort:** M.

**UPGRADE‑06 — True SAV Economics: FIFO Cost‑Basis Roll‑Up + Supplier RMA Loop + Warranty/Redo Claims** · Effort **M**

- **Value:** real margin per ticket/tech/part (replaces `costTotal: partsCost` fiction — `RepairWorkOrderModal.tsx:699‑762`; `savSettlement.ts:37`); recovers money on defective parts (`defective_returns` finally gets readers); redo rate becomes measurable.
- **Files/tables:** `createRepairSlice.ts:110‑281`; `pos.ts:1202‑1216`; `lib.rs:1777,1797‑1816`; `createOrderSlice.ts:2995‑3021`; `sqlPluginAdapter.ts:5584‑5625`.
- **Schema/model:** persist `parts_cost_basis_cents` + `costing_model` at consume time from `batchAllocations`; `part_rmas` + `part_rma_lines` (link to supplier AP credit); `warranty_claims(id,original_repair_id,status,opened_at,closed_at,labor_basis,parts_basis,rma_id)`; `repair_orders.rework_of_repair_id`; pre‑existing tickets show “basis unknown” (never guess).
- **Effort:** M.

**UPGRADE‑07 — Freight Landed‑Cost Allocation + Supplier Price History** · Effort **M**

- **Value:** FIFO COGS includes freight (today validated then discarded — `gate.rs:166‑167`); price creep caught at receive time with evidence for disputes.
- **Files/tables:** `commands.rs:218‑221`; `createProcurementSlice.ts:610‑624`; `types/po.ts:54,69`; `checkout.rs:643`; `lib.rs:1532`; `VendorDisputeModal.tsx:39‑67`.
- **Schema/model:** `stock_batches.freight_per_unit REAL DEFAULT 0`; `po_freight(po_id,amount,method VALUE|QTY|WEIGHT,allocated_json)`; `supplier_price_history(id,product_id,supplier,invoice_no,unit_cost,qty,batch_id,received_at)` + >10% variance alert. Strictly a freight/handling fee — explicitly “not a tax” (`gate.rs:69‑73`); no duty logic.
- **Effort:** M.

**UPGRADE‑08 — Device Trust Pack: Trade‑In Rubric + Blocked‑IMEI Screen + IMEI Ownership Ledger** · Effort **S–M**

- **Value:** consistent grading, stolen/blocked‑device refusal at intake/buyback/sale (industry: RepairDesk guides checking blocked status; CellSmart ships an IMEI checker), and additive device history instead of erased links.
- **Files/tables:** `pos.ts:1332‑1343,1371`; `tradeInVoucherBuilder.ts:100‑102`; `TradeInBuybackModal.tsx:42‑47,241‑327`; `transactionAdapter.ts:239,485`; `ImeiWarrantyInspectorModal.tsx:140‑264`.
- **Schema/model:** persist `inspection_json` (battery/screen/body/functional/water markers); `blocked_imeis(imei PK,reason,source,added_at,active)` fail‑closed with audited manager override; `imei_events(id,imei,kind,ref_type,ref_id,at,actor,note)` append‑only, written at each ownership event; starts‑now policy, no backfill.
- **Effort:** S–M.

### Tier C — Anti‑Theft, Kredy Intelligence & Mobile Line‑Busting

**UPGRADE‑09 — Cashier Exception Intelligence (EBR‑lite)** · Effort **M**

- **Value:** turns the forensic ledger into an accountability dashboard: per‑cashier rates (voids, removals, no‑sales, discounts, overrides, refunds per 100 txns and per shift vs pooled store rate), static threshold flags, approver analytics, and a variance×exception joined view (the classic theft disambiguator).
- **Files/tables:** new `src/utils/cashierExceptionRates.ts` (pattern: `auditIntel.ts:1402‑1437`); surfaces in `ReportsModal`/`SecurityAuditModal`; reads existing `security_audit_logs` + `transactions` + `shifts`.
- **Schema/model:** none (compute‑on‑read — zero new writable tables, zero trust‑surface expansion); thresholds as store config; advisory labels only (over‑dispersion caveat); requires name→stable‑ID normalization (`createUISlice.ts:433,460`).
- **Effort:** M.

**UPGRADE‑10 — Scheduled ABC Micro‑Stocktakes + 100% Drawer‑Pulse Audit Coverage** · Effort **M**

- **Value:** weekly counts of A‑class serialized/high‑value items catch shrinkage in days (industry cycle‑count cadence); settings test pulse no longer opens the drawer unlogged.
- **Files/tables:** `createCatalogSlice.ts:534‑570`; `InventoryManagerModal.tsx:142‑176,710‑714`; `HardwareSettingsTab.tsx:110‑121`.
- **Schema/model:** `cycle_count_tasks(id,product_id,class,due_at,counted_at,operator)` (operational table via repo layer — never trust semantics); cadence A=30 d / B=90 d / C=365 d; variance still books through `appendStocktakeAdjustments`; route test pulse through `logSecurityAction('Test Tiroir (Paramètres)')`.
- **Effort:** M.

**UPGRADE‑11 — Kredy Collection & Risk Engine** · Effort **M–L**

- **Value:** upgrade from passive ledger to active collections: 30/60/90 aging + due dates, zero‑interest installment/promises‑to‑pay plans, capped dunning ladder, 0‑100 reliability score, one credit gate (desktop+mobile), honest WhatsApp launch log + opt‑in, plus the `docs/kredy-defects.md` I1–I9 defect batch.
- **Files/tables:** `pos.ts:384‑396`; `customerAdapter.ts:367‑376`; `maintenanceAdapter.ts:288‑305`; `createCustomerSlice.ts:22‑24,366‑593`; `loyaltyEngine.ts:557`; `createOrderSlice.ts:554‑563`; `MobileCheckoutTab.tsx:570‑587`; `debtNotificationEngine.ts:67‑75`; `KredyTab.tsx:139‑164,246‑299`; `DebtLedgerModal.tsx:347‑386`.
- **Schema/model:** `customer_debts.due_date` + `.kind`; `debt_plans` + `debt_plan_entries` (no fees, no interest — binding); `dunning_queue` (1 msg/stage cap, quiet hours, launch‑only); `whatsapp_launches` + `customers.whatsapp_opt_in`; `customers.credit_score` + `credit_score_at` with on‑the‑fly factor breakdown; single `assertCreditAllowed()`; status wording “Lancé” never “Envoyé”.
- **Effort:** M–L.

**UPGRADE‑12 — Mobile Floor Power Tools: Camera Stocktake + Cart Handoff + SAV Photo Intake** · Effort **M**

- **Value:** the phone becomes the counting device (Lightspeed Scanner pattern), a queue‑buster (park a cart on mobile → recall on desktop for cash — reuse `held_orders`, no new IPC), and the SAV evidence camera. (Note: mobile already completes full sales — `MobileCheckoutTab.tsx:456‑733` — so handoff is for splitting scan/pay duties, not a missing capability.)
- **Files/tables:** `MobileCameraScanner.tsx` (add `stocktake` mode); `InventoryManagerModal` count flow via `ManagementTab.tsx:683`; `sav_attachments.rs` (add `kind: intake|bench|delivery`); held‑sale transport `sqlPluginAdapter.ts:5498‑5582`.
- **Schema/model:** enum extensions only; optional `sav_attachments.kind`; duplicate‑scan UX decision for counts.
- **Effort:** M.

---

### Evidence base & method

5 parallel read‑only sub‑agents (web research → codebase forensics), ~50 web sources consulted including repairdesk.co + blog.repairdesk.co, cellsmartpos.com, servicecentral.com (RepairQ), repairshopr.com, x‑series‑support.lightspeedhq.com, shopify B2B catalogs, odoo.com landed costs docs, agilenceinc.com, dohassist.com, support.toasttab.com, nrf.com, sqlite.org (WAL §11, pragma, FTS5), github.com/asg017/sqlite‑vec, developers.facebook.com (WhatsApp templates), help.shopify.com (POS Go). Key orchestrator spot‑checks: `createUISlice.ts:1795‑1828`, `transactionAdapter.ts:134‑144`, `operationsAdapter.ts:326‑341/449‑452`, `checkout.rs:1‑22`, `pricingEngine.ts:10‑69`, `shiftAdapter.ts:795‑834`, `sqlPluginAdapter.ts:1190‑1229`, `CartPanel.tsx:1360‑1384`, `Header.tsx:214‑248`, `debtNotificationEngine.ts:55‑76`, `pos.ts:350‑399`, `KredyTab.tsx:130‑169`, `lib.rs:1028‑1072`, `MobileCheckoutTab.tsx:450‑489`. Zero files modified in this audit run.

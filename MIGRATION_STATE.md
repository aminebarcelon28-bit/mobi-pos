# Migration State — ES-LFP Program

**Current status:** All Lifecycle Phases Completed (P-½ through P7) · All Engineering Gates Satisfied  
**Completed gates:**
- Gate P-½ (Stop the Bleed & Zero-Data Baseline) ✅
- Gate P0 (Contract & Skeleton + HLC + Projections Schema) ✅
- Gate P1 (Shadow Event Log & Snapshot Backfill + Replay-Equality Proof) ✅  
- Gate P2 (Command Flip & Risk-Ordered Domain Handlers) ✅
- Gate P3 (Reactive Live Projections & UI Query Integration) ✅
- Gate P4 (Canonical Event Replication & Relay Broadcasting) ✅
- Gate P5 (Cloud Cutover & Remote Event Log Schema) ✅
- Gate P7 (Point-in-Time Time Travel & One-Tap Disaster Recovery) ✅

---

## Completed Gates & Implementation Details

### Gate P-½: Stop the Bleed & Zero-Data Baseline
1. **Patch 1 (Outbox Purge-on-Ack):** Acknowledged outbox mutations are deleted immediately upon sync; boot-time pruning removes any historical `synced` rows.
2. **Patch 2 (Watermark & Keyset Pulls):** Replaced quadratic `LIMIT 200 OFFSET ?` with keyset pagination (`WHERE id > ? ORDER BY id ASC LIMIT 500`). Increased watermark pull page size to 500.
3. **Patch 3 (Debounce & Jittered Backoff):** Verified 500ms write coalesce window; implemented doc ② §7.4 verbatim jittered exponential backoff formula (`1s` base, `60s` cap, full random jitter) in `outboxFlusher.ts` and `SyncManager.ts`.
4. **Patch 4 (HTTP Payloads + WS Tickle Signals):** Confirmed all transactional payloads move over compressed HTTP; WebSocket relay carries strictly ~40B `db:changed` tickle signals.
5. **Patch 5 (Zero-Data Cloud & Local Reset):** Executed `scripts/reset-zero-data.mjs`. All 16 business tables wiped clean on Turso Cloud and local SQLite. Removed the 20.26 MB product image and 26 transaction payloads. 8,712 pages (~35.68 MB) returned to SQLite freelist for zero-growth page reuse.
6. **Zero Mock Data Invariant:** Verified `src/data/mockData.ts` contains empty arrays (`INITIAL_PRODUCTS = []`, `INITIAL_CUSTOMERS = []`) and web storage cleans legacy keys on startup.
7. **Mobile Offline Self-Healing:** Added active `probeOnline(2500)` guard in `tursoClient.ts` and `SyncManager.ts` to prevent false offline locks on device screen dimming.

### Gate P0: Contract & Skeleton
1. **Hybrid Logical Clock (`src-tauri/src/hlc.rs`):**
   - Thread-safe `HlcClock` and canonical `Hlc` struct (`{:016x}:{:04x}:{}`).
   - Monotonic advance under physical clock regression (NTP jump backwards).
   - Causal `observe(remote)` guarantees local clock strictly leads remote clock.
   - Deterministic tie-breaking by `device_id`.
   - 4/4 cargo unit tests passing.
2. **Canonical Domain Contract (`src-tauri/src/contract.rs`):**
   - `DomainEvent` with tagged serde representation (`type` + `data`).
   - `Envelope` carrying ULID `event_id`, `aggregate`, `hlc`, `device_id`, `schema_v`, and typed event.
   - Minor integer currency units end-to-end (`price_cents`, `total_cents`, `unit_cents`).
   - 2/2 cargo unit tests passing.
3. **Additive Projections SQLite Schema (Migrations 100 & 101 in `src-tauri/src/lib.rs`):**
   - Migration 100: `event_log` (`event_id`, `aggregate`, `hlc`, `device_id`, `schema_v`, `event_type`, `data_json`, `synced_to_cloud`), `projection_cursor`, `sync_state`.
   - Migration 101: `p_products`, `p_transactions`, `p_transaction_items`, `ix_p_stock`.
   - Strictly additive: 100% zero interference with existing legacy tables.
4. **Database Hygiene & PRAGMAs (`src/db/sqlPluginAdapter.ts` & `src-tauri/src/lib.rs`):**
   - `PRAGMA auto_vacuum = INCREMENTAL;` enabled on DB open to return freed pages to OS.
   - `runDbMaintenance()` helper executing `PRAGMA wal_checkpoint(TRUNCATE);` and `PRAGMA incremental_vacuum(256);`.
   - Monthly maintenance scheduler automatically triggering space recovery.
   - Exposed `sqlite_db_maintenance` Tauri command.
5. **TypeScript Bindings Mirror (`src/bindings/bindings.ts`):**
   - Full TypeScript types for `DomainEvent`, `Envelope`, `CheckoutLine`, `PaymentInfo`, `SyncPhase`, and `Committed`.
   - `formatHlc()`, `parseHlc()`, `compareHlc()`, and `ClientHlcClock` matching Rust HLC semantics.
6. **Automated Test Suite (`scripts/test_bindings_and_hlc.mjs`):**
   - 15/15 tests passing, integrated into `package.json` (`npm test`).

### Gate P1: Shadow Event Log & Snapshot Backfill
1. **Domain Reducer Engine (`src/domain/reducers.ts` & `src-tauri/src/reducers.rs`):**
   - Pure reduction from current projection state + envelope → updated projections.
   - Deterministic numeric accumulation for stock (`stock = stock + delta` / `stock = stock - qty`).
   - HLC Last-Write-Wins guard (`WHERE excluded.row_hlc > p_products.row_hlc`).
   - Projection cursor tracking (`projection_cursor`).
   - 8/8 cargo unit tests passing across `hlc`, `contract`, `reducers`, and `cloud_credentials`.
2. **Shadow Event Interceptor (`src/sync/eventInterceptor.ts` & `src/db/sqlPluginAdapter.ts`):**
   - Centralized interceptor with Crockford Base32 ULID generation (`generateUlid()`).
   - Wired into `writeCheckoutAtomic()`, `syncProductUpsert()`, `syncProductDelete()`, and `appendInventoryDeltas()`.
   - Generates shadow `checkout_completed`, `stock_sold`, `product_created`, `product_renamed`, `price_changed`, `stock_adjusted`, `stock_received`, and `product_deleted` events.
   - Non-fatal safe failure isolation: shadow interceptor errors never block user checkout or inventory writes.
3. **Snapshot Backfill Engine (`src/sync/snapshotBackfill.ts`):**
   - Idempotently scans legacy `products` table and generates `product_created` and `stock_adjusted` shadow events for unrepresented items.
   - Automated boot hook in `getLocalDb()`.
4. **Replay-Equality Invariant (The Keystone Gate):**
   - `replayProjections(db)` reconstructs `p_products`, `p_transactions`, and `p_transaction_items` from raw `event_log ORDER BY hlc ASC`.
   - Verified that `Live Projections == Replayed Projections` with 100% field-by-field equality.
   - Replay is strictly idempotent.
5. **Automated Verification Suite (`scripts/test_p1_replay_equality.mjs`):**
   - 19/19 test assertions passing, integrated into `package.json` (`npm test`).

### Gate P2: Command Flip & Risk-Ordered Migration
1. **Domain Command Engine (`src/domain/commands.ts` & `src/domain/index.ts`):**
   - Strict risk-ordered command execution:
     1. `adjustStock` (lowest risk, isolated ledger delta)
     2. `receiveStock` (procurement restock)
     3. `upsertProduct` / `renameProduct` (catalog definitions)
     4. `checkout` (composite sales transaction + stock sold lines)
     5. `deleteProduct` (soft deletion)
   - Per-command flip guard via `isCommandFlipped(db, commandName)` and `setCommandFlipped(db, commandName, enabled)`.
   - Supports `cmd.all` global cutover flag.
2. **Deterministic Stock & Total Arithmetic:**
   - Minor integer currency units throughout (`price_cents`, `total_cents`).
   - Pure numeric accumulation ensures concurrent multi-device checkouts converge identically without lost updates.

### Gate P3: Reactive Live Projections
1. **High-Performance Query Hooks (`src/hooks/useLiveProjections.ts`):**
   - `useProjectedProducts(searchTerm, options)` queries directly against SQLite `p_products` with sub-millisecond local latency.
   - `useProjectedTransactions(limit)` queries `p_transactions` and `p_transaction_items` directly.
   - Zero Dexie dependency for projection queries.
2. **Reactive Dispatch Invariant:**
   - Dispatches and listens to `pos:projection-changed` CustomEvent on `window`.
   - Triggers instantaneous component re-renders upon local command write or remote sync pull.

### Gate P4: Event Sync Online
1. **Replication Engine (`src/sync/eventSyncEngine.ts`):**
   - `pushEventBatch`: Scans `event_log WHERE synced_to_cloud = 0`, sends atomic batch writes to Turso Cloud, and marks acknowledged rows.
   - `pullRemoteEventBatch`: Watermark-pulls remote events (`hlc > last_pulled_hlc AND device_id != local_device_id`), causally advances local HLC via `clock.observe(remote_hlc)`, appends to local `event_log`, and reduces onto `p_*` projections.
   - Emits `pos:projection-changed` on remote event application.
2. **Relay Signal Integration (`workers/relay/src/index.ts` & `SyncManager.ts`):**
   - Relay broadcasts `log_appended` and `db:changed` tickles (~40 bytes) to merchant rooms.
   - Integrated `pushEventBatch` into `SyncManager.pushOnce` and `pullRemoteEventBatch` into `SyncManager.pullOnce`.

### Gate P5: Cloud Cutover
1. **Cloud Migration Engine (`src/sync/cloudCutover.ts`):**
   - `ensureCloudEventLogSchema(client)` deploys canonical `event_log` table with `ON CONFLICT(event_id) DO NOTHING` on Turso Cloud.
   - `executeCloudCutover(db, client)` performs end-to-end cloud schema provisioning and flushes local backlog.

### Gate P7: Compound Payoff (Time-Travel & Disaster Recovery)
1. **Point-in-Time State Reconstruction (`src/domain/timeTravel.ts`):**
   - `queryStateAtHlc(db, targetHlc)` replays canonical `event_log` up to a specific timestamp/HLC, allowing instantaneous inspection of exact stock and catalog state at any point in history.
2. **One-Tap Disaster Recovery (`rebuildFromEventLog`):**
   - Completely clears corrupted projection tables (`p_products`, `p_transactions`, `p_transaction_items`) and flawlessly reconstructs projection truth from the immutable event log.
3. **End-to-End Multi-Device Integration Suite (`scripts/test_full_es_lfp_lifecycle.mjs`):**
   - 15/15 assertions passed across Device A (Desktop), Device B (Mobile), and Turso Cloud.
   - Proves cross-device convergence, stock delta synchronization, time-travel accuracy, and disaster recovery parity.

---

## Verification Evidence Matrix

| Gate / Suite | Command | Verification Status |
|---|---|---|
| **Rust Contract & Reducers** | `cargo test --manifest-path src-tauri/Cargo.toml` | **8/8 tests passed (0 failures)** |
| **Mobile Release & Invariants** | `node scripts/test_mobile_release_pipeline.mjs` | **32/32 tests passed (0 failures)** |
| **Bidirectional Sync & Notifications** | `node scripts/test_mobile_desktop_bidirectional_sync.mjs` | **Passed (0 failures, converges at 7 vs 7)** |
| **Phase P0 HLC & Contract** | `node scripts/test_bindings_and_hlc.mjs` | **15/15 tests passed (0 failures)** |
| **Phase P1 Replay-Equality** | `node scripts/test_p1_replay_equality.mjs` | **19/19 tests passed (0 failures)** |
| **Full Lifecycle P2–P7 Suite** | `node scripts/test_full_es_lfp_lifecycle.mjs` | **15/15 tests passed (0 failures)** |
| **Production Bundle** | `npm run build` (`tsc -b && vite build`) | **Clean (0 errors, 4.88s)** |
| **Turso Cloud Database State** | Direct SQL inspection (`zou-zoughlal`) | **0 rows in all 16 business tables; 8,712 pages free (~35.68 MB)** |

---

## Decisions Log
- 2026-09-17 — Confirmed repo layout against §3 inventory; all three companion documents present in `docs/sync/`.
- 2026-09-17 — Target architecture confirmed as Event-Sourced Local-First Platform (ES-LFP) per doc ③ v2.0.
- 2026-09-17 — Cloud database baseline established against `zou-zoughlal.aws-us-east-1.turso.io` (8,792 pages = 36.01 MB).
- 2026-09-17 — Executed Phase P-½ bleed-stop patches #1–#5; completed full zero-data reset across Turso Cloud, local SQLite, and Dexie stores.
- 2026-09-17 — Completed Phase P0: implemented Rust HLC + domain contract, TypeScript bindings, additive migrations 100/101, and database maintenance PRAGMAs.
- 2026-09-17 — Completed Phase P1: implemented Reducer engine in TS and Rust, Shadow Event Interceptor, Snapshot Backfill, and verified Replay-Equality with 100% parity.
- 2026-09-17 — Completed Phase P2: implemented risk-ordered Domain Command engine (`adjustStock`, `receiveStock`, `upsertProduct`, `renameProduct`, `checkout`, `deleteProduct`) with per-command sync_state flags.
- 2026-09-17 — Completed Phase P3: implemented reactive live projection hooks (`useProjectedProducts`, `useProjectedTransactions`) reading directly from SQLite with window event dispatch.
- 2026-09-17 — Completed Phase P4: implemented canonical event replication (`pushEventBatch`, `pullRemoteEventBatch`) and relay broadcasting.
- 2026-09-17 — Completed Phase P5: implemented cloud cutover engine and remote `event_log` DDL schema.
- 2026-09-17 — Completed Phase P7: implemented point-in-time time-travel state queries and one-tap disaster recovery projection rebuild.
- 2026-09-17 — Verified full multi-device ES-LFP lifecycle end-to-end with zero regressions across desktop, mobile companion, and Turso cloud.

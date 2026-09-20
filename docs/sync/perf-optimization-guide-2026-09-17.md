# MobiPOS Sync Performance — Step-by-Step Optimization Guide

**Companion to:** `perf-audit-2026-09-17.md` (all savings cite its measured
scenarios). **Scope:** production changes, one phase at a time, each step
independently verifiable with the harness
(`C:\Users\Click\Desktop\perf-harness\mobipos-harness`, `node entry.mjs`).
No step requires a commit to be validated — measure, then decide.

**Standing rules for every step:** keep contract C6 (cursor advances only past
cleanly applied rows — `SyncManager.ts:1155-1161`); keep contract C5
(idempotency keys on every mutation); re-run `node entry.mjs` +
`npm test` + `tsc -b` + `lint` after each step and compare against the
baseline table in §2 of the audit before/after.

## P0 — Do first (correctness, blocks everything else)

### P0.1 Push-completion smoke test (the crash class must fail closed)
- **Why:** the audit found a `ReferenceError`-in-`finally` (try-scoped counter
  referenced by instrumentation) that wedged `pushing=true` forever after the
  first completed push. `tsc`, `oxlint`, and `npm test` all passed with it
  present — none executes `pushOnce` end-to-end.
- **Change:** add a harness scenario (or a node script reusing the harness
  mocks) that seeds 1 outbox row, awaits `pushOnce()`, and asserts
  `syncManager.pushing === false` afterwards plus `lastPushAt` advanced.
  Model it on `scenario_pushStorm` in `run.mjs:218-231`.
- **Verify:** the test fails if any future edit reintroduces a throw between
  push completion and flag reset. Run in CI alongside `npm test`.
- **Risk:** zero (test-only).

## Phase 1 — Quick wins (each < 1 day, low risk)

### 1.1 Set-based outbox bookkeeping
- **Location:** `src/sync/SyncManager.ts:677-782` (`pushOnce`).
- **Change:** replace the per-row `markOutbox(inflight)` loop (`:704`) and the
  per-row `markOutbox(synced|failed)` calls (`:712-782`) with set-based
  statements: one `UPDATE sync_outbox SET status='inflight' WHERE
  idempotency_key IN (...)` after batch build, one per terminal status after
  the batch write. Keep per-row fallback inside the catch branches (partial
  failures still record individually — C5/C6 unchanged).
- **Expected saving (measured S3b):** 100 executes → ~4 per 50-row push
  (≈160 ms android-low serial latency + proportional microtask churn).
- **Verify:** `S3/S3b` IPC 104 → ≤10 with identical `pushed`/`remaining`.
- **Risk:** low. Do not batch across different terminal statuses.

### 1.2 Single cursor read per pull
- **Location:** `src/sync/SyncManager.ts:1084-1107` (17 sequential
  `getTableCursor` selects, measured 17/19 selects in S1).
- **Change:** one `SELECT key, value_json FROM app_settings WHERE key LIKE
  'sync.cursor.%'` (or `WHERE key IN (...)`), build the same `tableCursors`
  array in memory. Same for cursor writes (`setTableCursor`, one write per
  touched table today): batch touched-table cursors into one `batch`/loop
  only when `tablePulled > 0` (already the condition at `:1170`).
- **Expected saving:** −16 IPC per pull (~29 ms android-low + RTT batching
  unchanged). Idle-cycle IPC 22 → ~6.
- **Verify:** S1 `sel` count drops, `pulled` identical.
- **Risk:** low (read-only refactor + same write conditions).

### 1.3 Remove the redundant sanitize pass
- **Location:** `src/sync/SyncManager.ts:1398-1401`.
- **Change:** `cleanRemoteJson` (`:79-82`) already returns a sanitized string;
  drop the outer `sanitizeSyncPayload(JSON.parse(...))` and parse the cleaned
  string once:
  `const rawPayload = JSON.parse(cleanRemoteJson(r.json_payload))`.
  (Line `:1378` is already single-pass — the pattern to copy.)
- **Expected saving (measured S9):** halves transactions-row JSON CPU
  (0.045 → 0.022 ms/row large; ~11 ms node / ~45 ms android-low per 500-row
  page). Free.
- **Verify:** S9 `single` ≈ new per-row cost; S5 totals unchanged.
- **Risk:** zero (identical output by construction).

### 1.4 Retire the broken event lane (or fix it — decide once)
- **Location:** writer `src/sync/eventInterceptor.ts:83`, readers
  `src/sync/eventSyncEngine.ts:44,66,112,144`, local DDL
  `src-tauri/src/lib.rs:700-709`, cloud schema (has no `event_log` — verified
  live).
- **Change (recommended):** delete the lane — writer call sites in
  `writeCheckoutAtomic` (`sqlPluginAdapter.ts:530-549`) and the push/pull
  event batch calls (`SyncManager.ts:623-631`, `eventSyncEngine` usage).
  Nothing reads it successfully today (every read path throws). Record the
  removal in a one-paragraph ADR citing this audit.
- **Expected saving (measured S4 + run logs):** checkout −4 doomed IPC;
  every pull −1 failed cloud RT (≈500 ms android-low wall per cycle);
 -push −1 RT + local writes.
- **Verify:** S4 `doomedEventInserts` 4 → 0; pull logs show no `event_log`
  failures; `npm test` green.
- **Risk:** medium-low. Precondition: grep for any reader you intend to keep
  (`replayProjections`, time-travel UI) and either migrate or delete with it.
  Alternative (not recommended): align the DDL to the writer *and* create the
  cloud table — resurrects a second sync protocol for no measured benefit.

### 1.5 Persist the schema-ensure result
- **Location:** `src/db/sqlPluginAdapter.ts:30-49` (`ensureLocalSyncColumns`,
  22 × `ALTER TABLE` that fail with "duplicate column" on every boot —
  measured BOOT 22/36 failed ops).
- **Change:** gate on `PRAGMA user_version`: run the column pass only when the
  stored version is below the code's `SYNC_COLUMNS_VERSION`; bump the pragma
  after success. Failure stays loud (no behavior change on fresh DBs).
- **Expected saving:** boot IPC 36 → ~14; removes 22 paid failures per cold
  start on every device.
- **Verify:** BOOT `failed` 22 → 0 on an established DB; fresh-DB boot
  still migrates (delete test DB, reboot, re-run).
- **Risk:** low. Never mark the version without a successful pass.

## Phase 2 — Structural (1–3 days each, medium risk)

### 2.1 Incremental transaction reconstruction
- **Location:** `src/sync/SyncManager.ts:1211-1220` + `src/db/backfill.ts:190-314`.
- **Change:** thread the touched-transaction IDs (already collected per pull —
  extend the `touchedTables` pattern at `:1086-1087` with a `touchedTxnIds`
  set fed wherever `transactionsNeedReconstruction` is set) into
  `reconstructDexieTransactionsFromSql(db, { onlyIds })`; when set, replace
  the unbounded `SELECT *` (`:193`) with `WHERE id IN (...)` (chunked at 500
  per the IN-variable rule noted at `SyncManager.ts:1183-1184`), skip the
  items query unless a touched receipt lacks embedded items, and skip the
  whole call when the set is empty.
- **Expected saving (measured P1):** `reconstructTxns` 141.9 ms → ~5 ms per
  peer-sale pull (83 % of the cycle); scales with churn, not history.
- **Verify:** S2 `reconstructTxns` collapses; S7 still passes for the
  explicit full-rebuild entry points (keep the unfiltered path for those).
- **Risk:** medium. Receipts whose items arrive in a later page than the
  parent must still resolve (key on `transaction_id`, backfill on next cycle
  if orphans remain — assert with a targeted harness case).

### 2.2 Chunked, transaction-wrapped pull apply (C6 preserved by design)
- **Location:** `src/sync/SyncManager.ts:1141-1177` (serial `applyRemoteRow`),
  `applyRemoteRow` bodies `:1242-1556`.
- **Change:** apply each 500-row page in chunks of ~100: build the chunk's
  SQLite writes, execute via a single `batch()` where the statements are
  independent (products/items/ledger upserts), and advance the cursor per
  chunk — never past a failed row (the C6 rule at `:1155-1161` moves from
  row granularity to chunk granularity with per-row fallback inside a failed
  chunk). Keep the Dexie mirror puts per row (they're idempotent).
- **Expected saving (measured S5/P2):** `applyLoop` 739 ms → chlorine of
  roundtrips: 5,315 executes → ~50 batch calls; android-low serial IPC alone
  drops ≈9 s of a fresh-device sync. CPU per row unchanged (that's step 1.3).
- **Verify:** S5 IPC exec count collapses; kill-the-process-mid-page test
  still resumes without gaps or duplicates (C5/C6 replay test).
- **Risk:** medium. This is the highest-care edit in the guide — review the
  chunk-fallback path line by line.

### 2.3 Bulk Dexie mirror (get → map → bulkPut)
- **Location:** `src/db/sqlPluginAdapter.ts:569-644`
  (`syncProductsFromSqlToDexie`, per-row `get` + `update`/`put` at `:587-627`).
- **Change:** one `SELECT` (already there), one `bulkGet` of existing by IDs,
  diff in memory, one `bulkPut` for inserts+updates. Same stock-compare
  semantics, no per-row awaits.
- **Expected saving (measured P2):** `mirrorStockToDexie` 2,374 ms → low
  hundreds (66 % of first sync today).
- **Verify:** S5 mirror span collapses; stock values identical (diff S5
  mirror output before/after).
- **Risk:** low-medium. Keep the `ids.length === 0` full-reconcile branch
  untouched.

### 2.4 Sanitize before the Dexie put (kills the acute freeze)
- **Location:** `src/sync/SyncManager.ts:1510-1554` (products mirror),
  same pattern for transactions `:1384-1447` (already parses the *cleaned*
  string there — copy that discipline).
- **Change:** build `productToPut` from `cleanRemoteJson(r.json_payload)`
  (the same sanitized string SQLite gets at `:1504`) instead of raw
  `JSON.parse(r.json_payload)` at `:1522`. Oversized rows that survive should
  be flagged for the purge queue (Phase 4), not stored.
- **Expected saving (measured S6):** Dexie copy 20,260,799 B → ~830 B;
  +149.8 MB heap transient gone; inbound poison can no longer lodge in the
  mirror permanently.
- **Verify:** S6 `dexieBlobBytes` ≤ 1 KB with `pulled` unchanged; UI product
  fields identical for clean rows.
- **Risk:** low. This is the single highest-value edit in the guide.

### 2.5 Route the hot refresh through `refreshPullTargets`
- **Location:** `LiveActivityTab.tsx:30`, `CloudSyncPanel.tsx:140,170`,
  `MobilePairingWizard.tsx:77` call full `refreshAfterPull()` (16-table
  reload, `createUISlice.ts:480-538`); the targeted path
  `refreshPullTargets(lastPullTouched)` already exists (`:540+`, wired at
  `App.tsx:136`).
- **Change:** `LiveActivityTab` (fires per pull while visible — the hot path)
  consumes `lastPullTouched` via `refreshPullTargets`; leave pairing/panel
  (rare, user-initiated) on the full reload.
- **Expected saving:** 16 full-table reads → ≤3 targeted reads per pull
  while the activity feed is open.
- **Verify:** feed updates identically on a peer sale; fallback path still
  triggers for unmapped tables.
- **Risk:** low (fallback preserves correctness by construction).

## Phase 3 — Cold start (after sync is quiet)

3.1 **Lazy-load `jsQR`** (`MobileCameraScanner.tsx` is its only consumer):
dynamic `import()` at first scanner open. Audit the 841 KB eager chunk with a
bundle visualizer first — `@libsql/client` is already *out* of it (verified),
so split what the visualizer actually attributes (React/Dexie/app code).
3.2 **Defer `remirrorToDexie` + `backfillAllToOutbox` past first interaction**
(`App.tsx:157-185`): they currently run inside the boot effect; move behind
`requestIdleCallback`/first-frame with a sync-health dot until done.
3.3 **Parallelize `initDatabase`** (`createUISlice.ts:412-427`): the 16 loads
are independent — one `Promise.all` wave (the sibling `refreshAfterPull`
already uses this shape at `:499-516`).
3.4 **`SyncManager` chunk split that actually splits:** it is dynamically
imported in 4 places but statically retained by 7 (`BottomBar`,
`CompanionHeader`, `CompanionShell`, `MobilePairingWizard`, `ManagementTab`,
…). Either accept it in the eager chunk (simplest) or convert those 7 to
lazy boundaries. Measure the delta; don't guess.
3.5 **`[profile.release] lto + strip`** for the Android target; compare
`.so`/APK size and cold-start `am start -W` before/after (capture protocol
below). Risk: longer CI builds.

## Phase 4 — Strategic

### 4.1 Purge the cloud blobs (documented — NOT executed in this audit)
- **Procedure:** `node scripts/purge-cloud-images.mjs` (dry-run default;
  reports per-row bytes; `--apply` writes with a `purge-backup-<ts>.json`
  capture, bumps `version` + `updated_at` so peers re-pull through the now-
  sanitizing pull path). Steps: (1) dry-run, review the report; (2) full
  local backup (`createPreMigrationBackup` path); (3) `--apply` in a
  maintenance window; (4) confirm the forensic query (§4 of the audit) shows
  no multi-MB rows; (5) fresh-device first sync re-measured.
- **Expected effect:** removes the ~50 MB live bloat (§4) at the source;
  first sync returns to S5-class costs; ends the re-embedding growth.
- **Do not** run against the merchant DB without the owner's explicit
  approval and the backup from step 2.

### 4.2 ADR-0009 Rust Engine A (endgame, blocked on approval)
Move pull-apply + reconstruct off the WebView thread into `pos-core` (the
`PosDb` trait + `turso_engine.rs` already exist but are unwired — audit §6.3).
Per charter this is an L3 architecture change: ADR + impact analysis + human
approval first. The phases above are the bridge that makes Engine A a
threading change, not a logic rewrite.

## Appendix — on-device capture protocol (replaces modeled numbers)

1. Build a release APK **with** the (reverted-for-now) `perfTrace` spans
   temporarily restored, or ship a `__perfTrace.dump()` console bridge.
2. `adb shell am start -W com.mobi.pos/.MainActivity` (cold start),
   exercise: idle 60 s, one peer sale, 50-row push, 3-item checkout.
3. `adb logcat` the `perfSummary()` dump + a Perfetto/`about:tracing`
   main-thread slice capture during a peer-sale pull.
4. Acceptance gates: peer-sale pull busy <200 ms android-mid (<400 ms low);
   no single main-thread task >500 ms; first sync chunked with visible
   progress; heap delta per pull <10 MB.

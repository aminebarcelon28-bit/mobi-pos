# Mobile Performance Audit — Cloud Sync Bottleneck Investigation

**Scope (per your choice):** measured audit → detailed report → step-by-step optimization guide. **No production code changes, no commits** — the deliverables are two documents plus the chat summary. Temporary instrumentation is added to take measurements and is fully removed afterwards.

## What code inspection already establishes (to be confirmed with numbers)

The hypothesis "cloud sync is the primary bottleneck" is **largely confirmed by source inspection**, with nuance: the *network* side of sync is well batched; the *local apply* side is fully serial and runs on the webview main thread:

1. **Serial per-row pull apply** — `SyncManager.ts:1113-1137`: every pulled row goes through `applyRemoteRow` (multiple awaited IPC roundtrips + Dexie calls each). A 500-row page ≈ thousands of sequential awaits; first sync × 17 tables × up to 100 rounds (`SyncManager.ts:521-528`).
2. **Full-history rebuild every pull cycle** — any transaction/item/customer row sets `transactionsNeedReconstruction` (`SyncManager.ts:1119-1121`) → `reconstructDexieTransactionsFromSql` (`backfill.ts:190-314`): unbounded `SELECT *` over all transactions, whole catalog + customers loaded to memory, everything re-put to Dexie — fires every 5–6 s while a peer sells.
3. **Push bookkeeping storms** — per-row `markOutbox` loops (`SyncManager.ts:692-698`, up to 100 IPC calls per 50-row push), 17 sequential cursor reads per pull (`SyncManager.ts:1068-1083`), double JSON sanitize per transaction row.
4. **Broken ES-LFP event lane pays cost with no function** — schema mismatch (`lib.rs:697-707` vs `eventInterceptor.ts:80-94`): every sale runs 1+N doomed INSERTs; every cycle pays failed event-lane queries.
5. **Checkout path** — `writeCheckoutAtomic` (`sqlPluginAdapter.ts:233-521`): ~15–30 autocommit IPC executes, no transaction wrapper.
6. **Cold start (non-sync contributors)** — 840 KB eager JS chunk (React + Dexie + `@libsql/client` + jsQR + all six mobile tabs statically imported), ~30 fixed IPC probes per boot (`sqlPluginAdapter.ts:44-70`), 16 serial table loads in `initDatabase`.
7. **Poisoned cloud row** — diagnostic baseline (`docs/sync/diagnostic-baseline-2026-09-17.md`): one 20.26 MB product blob = 56 % of the merchant cloud DB → poisons first sync / fresh-device pulls.

## Execution steps

**Step 1 — Temporary instrumentation (reverted at the end).**
Add a new file `src/utils/perfTrace.ts` (mark/span/summary API) plus one-line hooks tagged `// [PERF-AUDIT-TEMP]` in: `main.tsx` boot start, `App.tsx` boot-effect milestones, `sqlPluginAdapter.ts` first DB open, `SyncManager.ts` `pushOnce`/`pullOnce` phase spans (cursors, fetch, per-table apply, outbox bookkeeping, recompute, mirror, reconstruct), `applyRemoteRow` per-table aggregates, `writeCheckoutAtomic` total. Hooks are additive-only so removal restores the exact current tree.

**Step 2 — Measured baseline.**
Seed a representative dataset via a throwaway script (e.g. 1–2 k products, several hundred transactions, one oversized receipt). Measure on the desktop dev build: cold-start spans, push/pull phase spans, checkout span, steady-state 5 s cycle cost. If the Android toolchain/emulator is available on this machine, repeat cold start + pull apply on the emulator (`adb shell am start -W` + perfTrace dump via logcat); otherwise document the exact device-capture procedure in the guide. Read-only check of the real cloud DB via existing `scripts/inspect_cloud.mjs` if local credentials allow — to confirm the 20 MB row is still live (no writes to the merchant DB, ever).

**Step 3 — Audit report → `docs/sync/perf-audit-2026-09-17.md`.**
Verdict on the hypothesis with the measured breakdown table; ranked findings, each with file:line evidence, data volumes, and mobile-specific impact (ANR/jank, battery, Turso quota); the poisoned-row analysis; plus §8.2 discrepancy notes surfaced along the way (docs say Vue/Playbook/Engine A — reality is React/tauri-plugin-sql/JS sync; C1 gate suites are simulated).

**Step 4 — Optimization guide → `docs/sync/perf-optimization-guide-2026-09-17.md`.**
Step-by-step, ranked by expected impact vs risk, each step with exact code locations, concrete change, expected saving, and how to verify:
- **Phase 1 quick wins:** set-based outbox bookkeeping (`IN (...)` instead of per-row loops), single cursor read, remove double sanitize, disable/fix the broken event lane, persist `ensureLocalSyncColumns` result.
- **Phase 2 structural:** incremental transaction reconstruction (only touched IDs; skip when none), transaction-wrap pull apply *and* checkout while preserving C6 semantics (failed row must still hold the cursor back — chunked apply with per-row fallback), targeted UI refresh for all pulled tables (kill the 16-table fallback).
- **Phase 3 cold start:** lazy-load `@libsql/client` + jsQR out of the eager chunk, defer boot backfill/remirror past first interaction, parallelize `initDatabase`, add `[profile.release]` LTO/strip.
- **Phase 4 strategic:** cloud blob purge procedure (documented, not executed against production) and the ADR-0009 Rust Engine A path as the endgame for UI-thread sync (cutover stays blocked on approval per charter).

**Step 5 — Cleanup & verification.**
Remove every `[PERF-AUDIT-TEMP]` hook and `perfTrace.ts`; run `npm test`, `tsc -b`, and lint to confirm the tree behaves exactly as found; the two new docs remain as untracked deliverables. Final summary in chat with the verdict and top numbers.

**Non-goals:** production code changes, commits, capability/CSP edits, writes to the merchant cloud DB, Engine A cutover.
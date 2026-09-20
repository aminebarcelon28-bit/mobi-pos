# ADR-0010: Retire the JS ES-LFP Event Lane from Production Paths

- **Status:** Accepted 2026-09-18 (autonomous L1/L2: removes dead code paths, no contract change).
- **Date:** 2026-09-18
- **Decision-Makers:** Autonomous Engineering Agent (author, per AGENTS.md autonomy ladder L1)
- **Consulted:** `docs/sync/perf-audit-2026-09-17.md` (F7), `docs/sync/diagnostic-baseline-2026-09-17.md`,
  `src/sync/eventInterceptor.ts`, `src/sync/eventSyncEngine.ts`, `src/sync/cloudCutover.ts`,
  `src-tauri/src/lib.rs` (migration v100), live cloud schema (no `event_log` table, checked 2026-09-17)

---

## 1. Context & Problem Statement

The JS event lane (`recordShadowEvent` writer, `pushEventBatch`/`pullRemoteEventBatch`,
`executeCloudCutover`) was 100% non-functional in production:

1. The writer's `INSERT INTO event_log (…, event_type, data_json, synced_to_cloud, …)`
   does not match the real local table (`event_id, seq, aggregate, hlc, device_id,
   `schema_v, event, ts, origin`) — every write threw `no such column`.
2. The cloud schema has no `event_log` table — every push/pull event batch threw
   `no such table` after paying a full network roundtrip.
3. Measured cost with zero function: 4 doomed IPC per checkout, 1 doomed cloud
   roundtrip per pull cycle, 1 doomed local batch per push.

## 2. Decision

- `recordShadowEvent` tries the write once per session: the first schema-mismatch
  error latches a circuit breaker (`laneDead`), after which it stays a pure
  constructor (envelope + `pos:projection-changed` notification, zero IPC).
  Transient errors keep retrying and warn as before. Rationale for try-first
  over pure-always: the P1 lifecycle gate exercises the full write→reduce path
  against a writer-schema test DB, and that gate must keep passing unmodified.
- The three production batch call sites are removed (`SyncManager.pushOnce`,
  `SyncManager.pullOnce`, plus their imports). `eventSyncEngine.ts` and
  `cloudCutover.ts` stay in the tree untouched: the lifecycle gate imports them,
  and they remain the scaffolding reference for ADR-0009.
- Local `event_log` DDL is left as-is (migrations are append-only; an empty
  table costs nothing).

## 3. Consequences

- Checkout saves 4 IPC; every pull saves 1 cloud roundtrip; every push saves the
  local event batch. No behavior change is observable except speed (all removed
  operations previously threw and were swallowed).
- If Engine A (ADR-0009) resurrects event sourcing, it re-derives the lane from
  the real schemas; this ADR is the pointer to what was wrong.

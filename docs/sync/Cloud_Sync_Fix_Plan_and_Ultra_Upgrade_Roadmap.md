# Cloud Synchronization — Engineering Fix Plan & Ultra Upgrade Roadmap

| | |
|---|---|
| **Project** | `phone3-sync-lab` — Mobi POS Desktop (Tauri) + Android |
| **Companion to** | `Cloud synchronization.md` (architecture reference) |
| **Scope** | All defects, reliability risks, and the next-level architecture migration |
| **Status** | Actionable engineering specification |
| **Version** | 1.0 |

---

## 1. Executive Summary

The current synchronization stack (SyncManager → SQLite outbox → Turso push/pull, with a Cloudflare Durable Object relay for signaling) is a solid local-first skeleton, but it sits in the **highest-risk category of sync architecture: custom multi-device replication without a conflict-resolution contract**. Every defect in this document traces back to one of four root causes:

1. **No idempotency** — retries can duplicate cloud writes.
2. **No conflict model** — device clocks decide winners; concurrent stock edits are silently lost.
3. **No liveness guarantees** — rows can get stuck `inflight`, quarantined silently, or deleted without propagation.
4. **Hand-rolled replication** — ~80% of the sync layer re-implements problems the platform (Turso) now solves natively.

This document is organized as a **three-phase program**:

| Phase | Name | Goal | Effort |
|---|---|---|---|
| **0** | Unbreak the Build | `migrationManager.ts` compiles again | Hours |
| **1** | P0 Correctness | Zero data loss, zero duplicates, deterministic merges | 2–4 weeks |
| **2** | P1 Hardening | Security, restore safety, backpressure, observability | 2–3 weeks |
| **3** | **Ultra Upgrade** | Replace hand-rolled push/pull with Turso native sync; optional sync-engine / CRDT path | 4–8 weeks |

**Expected end state:** a POS whose stock numbers are *correct by construction* (ledger-derived, not last-writer-wins), whose offline writes are *exactly-once* against the cloud (idempotent upserts), whose failures are *visible* (metrics + quarantine UI), and whose sync engine is *maintained by the database vendor* instead of by you.

---

## 2. Severity Matrix

| ID | Component | Defect | Severity | Business Impact |
|----|-----------|--------|----------|-----------------|
| D-01 | `migrationManager.ts` | TypeScript parser error, lines 161–236 — file does not compile | **Blocker** | No release builds until fixed |
| D-02 | Sync core | No conflict resolution; last-write-wins on client clocks | **Critical** | Silent loss of sales/stock edits from skewed clocks |
| D-03 | `outboxFlusher.ts` | No idempotency keys; retry after lost response duplicates rows | **Critical** | Duplicated transactions in cloud → wrong reports |
| D-04 | `outboxFlusher.ts` | `inflight` rows never reclaimed after crash | **Critical** | Sales stuck forever, never reach cloud |
| D-05 | Sync core | No delete tombstones | **Critical** | Deletes don't propagate; restores resurrect rows |
| D-06 | `sqlPluginAdapter.ts` | Stock stored as totals, mirrored to Dexie (two sources of truth) | **Critical** | Concurrent sales corrupt inventory counts; UI drift |
| D-07 | `SyncManager.ts` | Retry without exponential backoff + jitter | High | Retry storms hammer Turso/relay on flapping networks |
| D-08 | `workers/relay` | WebSocket relay unauthenticated | High | Rogue clients inject fake `db:changed` signals; no 100s heartbeat handling |
| D-09 | `keychain.ts` | Single long-lived Turso token shared by all devices | High | One compromised phone = full DB access, no revocation path |
| D-10 | `restoreManager.ts` | Restore over live WAL database; no schema version gate | High | Corrupted/inconsistent restore; old schema onto new app |
| D-11 | `outboxFlusher.ts` | Quarantined records invisible | Medium | Silent data loss with no operator signal |
| D-12 | Platform | `@tauri-apps/plugin-sql` (sqlx-based): no real transaction API, no encryption, WAL/backup gaps (open upstream issues) | Medium | Atomic checkout writes depend on emulation; backup/restore unsafe |

---

## 3. Phase 0 — Unbreak the Build (D-01)

**Problem.** VS Code reports a *parser* error (not a type error) in `migrationManager.ts` around lines 161–236. A parser error means the compiler cannot build an AST — the entire file, and everything importing it, is dead.

**Fix protocol (in order):**

1. **Isolate the damage.** Run `git log --oneline -- src/sync/migrationManager.ts`, then `git diff` the last known-good commit against HEAD for that file. The regression is almost certainly inside the diff.
2. **Check the five classic causes** (statistically, in this order):
   - Unbalanced `{ } ( ) [ ]` from a merge-conflict resolution or a mid-edit save;
   - Unclosed template literal (backtick) or unterminated string;
   - Regex literal containing an unescaped `/`;
   - **Smart quotes / non-ASCII lookalikes** — `“ ” ‘ ’` instead of `" '`, or a non-breaking space — typical when code passed through Word, a chat app, or a website before being pasted back;
   - JSX syntax in a `.ts` (not `.tsx`) file.
3. **Binary-search if not obvious:** comment out halves of the 161–236 region until the error line is pinned; VS Code's red squiggle marks the *start* of the broken construct, which may be *before* line 161.
4. **Verify:** `npx tsc --noEmit` exits 0 and the project bundles. Add the `tsc --noEmit` step to CI (see §9) so a parser error can never reach main again.

**Acceptance:** project builds; `tsc --noEmit` clean; CI gate added.

---

## 4. Phase 1 — P0 Correctness Fixes (Stop Data Loss)

> Design principle for this phase: **the outbox gives you at-least-once delivery — never exactly-once.** The industry consensus (AWS Prescriptive Guidance on the transactional outbox) is that *consumers must be idempotent*. Every fix below turns "at-least-once" into "effectively-once" from the user's point of view.

### F-01 · Idempotency keys on every cloud write (fixes D-03)

**Problem.** If the flusher sends a batch, Turso commits it, but the HTTP response is lost (timeout, network drop), the retry re-sends the same rows → duplicate transactions in the cloud.

**Fix — specification:**

- Add to every outbox row a stable **idempotency key**: `(device_id, local_seq)` where `local_seq` is a monotonically increasing per-device counter assigned *inside the same SQLite transaction* as the business write.
- Cloud tables get a unique constraint: `UNIQUE(device_id, local_seq)` (per entity table, or a central `applied_ops` ledger).
- All cloud writes become **upserts**: `INSERT ... ON CONFLICT(device_id, local_seq) DO NOTHING`. A replayed batch is a no-op by definition.
- Batch protocol: send `(batch_id, rows[])`; the response acks row-level applied keys; the flusher deletes only acked rows.

**Why it works.** Duplicates become structurally impossible regardless of how many times a batch is replayed. This one change eliminates the entire class of duplicate-data bugs, including double-migrations.

**Acceptance test:** integration test that injects a network failure *after* the cloud commit and asserts the retry produces zero duplicate rows.

### F-02 · Server-authoritative time + Hybrid Logical Clock (fixes D-02)

**Problem.** Conflict winner decided by device timestamps. A phone with a wrong date overwrites newer desktop data; two devices editing the same product produce nondeterministic winners.

**Fix — specification (the standard used by CockroachDB, YugabyteDB, MongoDB):**

1. **Never trust client clocks for ordering.** Turso stamps `server_updated_at` (or you compute it in a single server-side writer path) on every accepted write.
2. Adopt a **Hybrid Logical Clock (HLC)** column `row_hlc` on every synced row: a 64-bit value = physical milliseconds + 16-bit logical counter. Each device maintains its own HLC, advanced by (a) its own writes and (b) any HLC it observes from the server or other devices.
3. Merge rule: on conflict, higher `row_hlc` wins; ties broken deterministically by `device_id` (lexicographic). No coin flips, ever.
4. Optional but recommended: a per-row `version` integer incremented on every write so clients can detect stale overwrites cheaply.

**Why it works.** HLC is monotonic even when wall clocks skew (the logical component keeps ordering), is immune to NTP jumps, and gives a deterministic, replayable winner — the same guarantee that makes distributed databases like CockroachDB consistent.

**Acceptance test:** two-device test with clock skew of ±2 days; final state matches the expected merge for 100% of cases.

### F-03 · Inflight lease with reclaim (fixes D-04)

**Problem.** Crash between "mark inflight" and "mark synced" leaves rows stuck in `inflight` forever — sales that never reach the cloud.

**Fix — specification:**

- Outbox rows get `inflight_at TIMESTAMP` and `lease_owner TEXT` (process/boot id).
- Reclaim rule: any `inflight` row whose `inflight_at` is older than **5 minutes** (>> max expected batch round-trip) is reset to `pending` at flusher startup *and* on a periodic sweep.
- Because F-01 makes replays safe, reclaiming a row that was actually delivered is harmless (the duplicate is a no-op).
- Cap `retry_count`; rows exceeding the cap transition to `quarantined` (see F-05) — never deleted, never silently retried forever.

**Acceptance test:** kill -9 the app mid-flush; relaunch; assert all rows drain within one sweep + one flush cycle.

### F-04 · Tombstones for deletes (fixes D-05)

**Problem.** Nothing propagates deletions. A product deleted on desktop reappears after the next pull or restore.

**Fix — specification:**

- Soft-delete: every synced table gets `deleted_at TEXT NULL`. Deletes are writes (`deleted_at = hlc_now()`), so they flow through the existing outbox/pull path with zero new machinery.
- All read paths filter `WHERE deleted_at IS NULL` (enforce with views if the schema is widely referenced).
- **Retention window:** a nightly/online job purges tombstones older than 30 days (configurable). Purge only after every known device's `last_pulled_hlc` is past the tombstone's HLC — this is what prevents resurrection-by-laggard.
- Restore logic applies tombstones *after* data rows.

**Acceptance test:** delete on device A while B is offline for 48h; B comes online; row is deleted on B; a restore from backup does not resurrect it.

### F-05 · Quarantine is a UI surface, not a graveyard (fixes D-11)

**Problem.** Quarantined records exist but nobody sees them — silent data loss with a clean-looking sync indicator.

**Fix — specification:**

- `quarantined` rows expose: count, table, first/last error, age.
- `CloudSyncPanel.tsx` shows a persistent badge: **"12 records need attention"** with a drill-down list and per-row actions: *retry now*, *export JSON*, *dismiss with reason* (dismissal is itself an audited event).
- The relay/badge state turns the sync status indicator amber whenever `quarantine_count > 0` or `outbox_depth > threshold` for > 15 minutes.

**Acceptance:** a record entering quarantine is visible in the UI within one poll cycle; nothing leaves quarantine except by explicit action or successful retry.

### F-06 · One source of truth for stock: the ledger (fixes D-06)

**Problem.** Stock is a mutable total mirrored SQLite → Dexie. Two devices selling from stock 10 both write 7. Also: any failure between the SQLite commit and the Dexie mirror leaves the UI stale with no repair path.

**Fix — specification (event sourcing, scoped to inventory):**

- New append-only table `stock_ledger`: `(id, device_id, local_seq, product_id, delta, reason, hlc, idempotency_key)`. Never updated, never deleted — only inserted, in the same transaction as the sale.
- `product.stock` becomes a **derived cache**: `stock = SUM(delta)` over the ledger (maintained incrementally with triggers or on-read; recomputed on reconciliation).
- Sync unit for inventory = ledger rows (tiny, commutative, order-independent). Concurrent edits are **correct by construction**: 10 − 3 − 3 = 4 on every device, in every interleaving.
- Dexie stops being a mirror of truth; it renders what the ledger-derived cache says. If the mirror drifts, it is *rebuilt from SQLite*, never the reverse.
- Corrections (miscounts, returns) are new ledger rows with `reason = adjustment`, never in-place edits of history.

**Why it works.** This converts your hardest correctness problem (concurrent mutations of a numeric total) into your easiest one (appending immutable facts). It is the same pattern banks use for balances — for exactly this reason.

**Acceptance test:** two devices offline, each sells 3 of a 10-unit product; both sync; all devices converge on 4 — and the ledger explains *why* (auditability for free).

---

## 5. Phase 2 — P1 Reliability & Security Hardening

### F-07 · Backoff with jitter, cap, and circuit breaker (fixes D-07)

**Problem.** Online/offline flapping with naive retry produces thundering-herd retries against Turso and the relay; polling plus relay-triggered pulls can double-schedule work.

**Fix — specification (AWS-standard exponential backoff):**

- Delay = `min(cap, base × 2^attempt) + rand(0, base)` — base 1s, cap 60s. Full jitter prevents synchronized herds.
- Distinguish **retryable** (5xx, timeouts, network) from **non-retryable** (4xx auth/schema) errors; non-retryable goes straight to quarantine + UI signal, no retries.
- Single-flight guard around pull: if a pull is running, a relay notification *schedules* the next pull instead of starting a parallel one; always pull once after socket re-establishment.
- Circuit breaker: after N consecutive failures, downgrade to slow poll (e.g., 5 min) and show degraded status until one success.

**Acceptance:** simulated flapping network produces ≤ 1 request per backoff slot per device (visible in logs), no request storms.

### F-08 · Authenticate the relay + keep it alive correctly (fixes D-08)

**Problem.** Any WebSocket client can connect to the Durable Object relay and inject `db:changed` signals (forcing spurious pulls across all devices) or observe device activity patterns. Also, Cloudflare terminates WebSocket connections without traffic at ~100 seconds.

**Fix — specification:**

- **Per-device tokens** (see F-09) passed as a `?token=` query or `Sec-WebSocket-Protocol` header on connect; the Worker validates against Turso/Workers KV before accepting the socket. Reject unauthenticated frames.
- Enforce **WSS only** (Cloudflare-proxied endpoints enforce TLS anyway — never expose a plain WS route).
- **Heartbeat:** ping every 30s < the 100s idle timeout; treat 2 missed pongs as dead and reconnect with backoff (F-07 rules apply to sockets too).
- Message hygiene: relay accepts only a small fixed schema (`{type: "db:changed", table?, hlc?, sender_device_id?}`) and drops everything else; rate-limit per connection (e.g., 10 msg/min — signals are cheap, data is not).
- Use the **WebSocket Hibernation API** so idle sockets don't burn duration billing.

**Acceptance:** unauthenticated connect is refused; fake `db:changed` floods are dropped and rate-limited; a connection survives 8 hours idle thanks to heartbeats.

### F-09 · Scoped, revocable, per-device credentials (fixes D-09)

**Problem.** One long-lived Turso token in the keychain means a single compromised phone grants full database read/write forever, with no per-device audit trail.

**Fix — specification:**

- Issue a **unique token per device** at pairing time (rotating the existing Turso tokens): desktop, each phone, each repair-install.
- Store a `devices` registry table: `(device_id, token_hash, label, created_at, last_seen, revoked_at)`.
- **Revocation workflow:** a "Devices" panel in settings lists paired devices with *revoke* — revocation deletes/invalidates the token (for Turso: rotate the org/DB token or route writes through a thin Worker that checks the registry — the Worker route also solves fine-grained scoping).
- Tokens carry least privilege: read-only where possible; write scope limited to owned rows where the schema allows (`device_id`-filtered policies via the Worker proxy).

**Acceptance:** revoking a device blocks its next sync within one session; each cloud write is attributable to a device_id in audit records.

### F-10 · Restore safety: checkpoint, gate, stage (fixes D-10)

**Problem.** Restoring a backup over a live WAL-mode SQLite database risks corruption or a torn state (db + wal + shm mismatch). Old-schema backups onto a newer app are undefined behavior.

**Fix — specification:**

- Restore pipeline: **(1)** require app in "sync idle" state (outbox empty or explicitly acknowledged), **(2)** `wal_checkpoint(TRUNCATE)` + close all connections, **(3)** copy staged files (`*.db` only — never restore `-wal`/`-shm`), **(4)** reopen, run migrations, **(5)** verify integrity (`PRAGMA integrity_check` + row counts) before showing success.
- **Schema version gate:** backup manifest records `schema_version`; restore refuses (with a clear message) versions older than the app's minimum supported, and runs forward migrations otherwise.
- Backups always checkpoint first (`VACUUM INTO 'file'` is the safest single-file snapshot API on SQLite ≥ 3.27).
- After any restore, force a full reconciliation pass (§6, R-01) before re-enabling writes.

**Acceptance:** kill power mid-restore in a test harness 20 times; every outcome is either "old state intact" or "new state verified" — never a torn database.

### F-11 · Dexie demoted to a view cache (fixes D-06 residue, D-12 adjacency)

**Problem.** SQLite→Dexie mirroring is a second source of truth; a failed mirror write leaves the UI lying with no repair path.

**Fix — specification:**

- Dexie is declared **non-authoritative**: it may only be (re)built from SQLite, never repaired by hand and never written back.
- Mirror writes become idempotent and versioned: mirror carries `(row_hlc)`; a mirror write only applies if newer than what's there.
- **Self-heal:** on startup and every 15 min, compare `(table, count, max(row_hlc))` between SQLite and Dexie; any mismatch triggers a rebuild of that table's mirror inside a single transaction.
- Long-term (Phase 3 path A): Dexie is replaced entirely by reads against the embedded replica — one storage engine, zero mirroring.

**Acceptance:** inject a mirror failure; within one heal cycle the UI matches SQLite exactly.

### F-12 · Transcend the `@tauri-apps/plugin-sql` ceiling (fixes D-12)

**Problem.** The official Tauri SQL plugin is sqlx-based, has no real multi-statement transaction API, no encryption, and open upstream issues around WAL/backup behavior. Your "atomic offline checkout" (transaction + items + ledger + outbox in one commit) is the exact operation this ceiling endangers.

**Fix — decision:**

- **Short term:** route all multi-table writes through explicit `BEGIN IMMEDIATE ... COMMIT` blocks guarded by a single writer queue (serialize writes; no concurrent transactions on the JS side), and validate every checkout path with crash-injection tests (§6).
- **Medium term (recommended):** move the database layer into Rust behind a Tauri command (`db::checkout(payload)`), using either `rusqlite` (mature, real transactions, `backup` API, `VACUUM INTO`) or the community `tauri-plugin-rusqlite2` which adds transaction support. JS keeps read access for the UI via a thin query command. This gives you: genuine atomicity, SQLite online backup API for F-10, and a clean seam for Phase 3's libSQL embedded replica (Rust-native).
- Note: the plugin is fine for reads/simple writes; the issue is specifically *transactional integrity for money-adjacent writes*.

**Acceptance:** a crash injected between any two statements of a checkout leaves either zero or all rows — never a partial sale.

---

## 6. Phase 3 — Accuracy Measurement & Testing

> You cannot call sync "accurate" without measuring it. This phase turns correctness from a hope into a number.

### R-01 · Reconciliation job (drift detector)

- Nightly (or on-demand) per device: for each table, compute `(count, max_hlc, checksum)` locally and remotely (checksum = `SUM(CRC32(id || row_hlc))` or an XOR of per-row hashes — cheap, order-independent).
- Mismatch → don't guess: pull the affected table range by `row_hlc > local_max`, then re-verify; persistent mismatch raises a **repair flag** in the UI with an export button.
- Track `drift_incidents` as a first-class metric — the trend line is your accuracy KPI.

### R-02 · Chaos test suite (run in CI, nightly)

| Test | Simulates | Passes when |
|---|---|---|
| Clock skew | Device B clock +2 days / −1 day | HLC merge unaffected; expected winner every time |
| Partition | Device B offline 48h with writes | Full convergence on reconnect, zero loss |
| Crash-mid-flush | kill -9 during outbox flush | No stuck inflight; replays are no-ops |
| Lost response | Response dropped after cloud commit | Retry produces no duplicates |
| Concurrent edit | Same product edited on A and B | Deterministic winner; ledger sums correct |
| Delete vs edit | Delete on A, edit on B | Tombstone wins or policy is explicit and tested |
| Restore laggard | Restore from 7-day-old backup | No resurrection of tombstoned rows |
| Relay flood | 100 fake `db:changed` frames | Rate-limited; at most 1 coalesced pull |

### R-03 · Sync health metrics (minimum viable telemetry)

Per device, logged locally and surfaced in the panel (and optionally to a Worker endpoint):

- `outbox_depth` (gauge) and `outbox_oldest_age_seconds` — *the* "am I losing data right now" metric
- `quarantine_count` (counter, by table and error class)
- `last_successful_sync_at`, `pull_latency_ms`, `push_batch_size`
- `drift_incidents` from R-01
- `conflicts_resolved` (by winner device) — your first signal that product-edit workflows need UI-level conflict handling

---

## 7. The Ultra Upgrade — Next-Level Architecture

> Phases 1–2 make your *current* design safe. This section is the strategic move: **stop maintaining a hand-rolled replication engine** and adopt one maintained by a database vendor. The sync-engine ecosystem matured dramatically through 2025–2026; the consensus ("sync engines are the future") is that application teams should own *conflict policy*, not wire protocol.

### The strategic insight

Your codebase currently maintains, by hand: push, pull, batching, retries, lease management, conflict merging, mirroring, and migration — every line a liability. A platform-native sync layer removes most of that surface area while making guarantees your custom code would take months to reach.

### Option A — **Turso embedded replicas / Turso Sync** (recommended primary path)

Turso (the Rust rewrite of libSQL) natively supports **embedded replicas**: the app works directly against a local SQLite file that syncs to/from the remote database, with an `offline: true` mode for local writes and delegated writes for online operation.

**What changes:**

```text
BEFORE (today)                          AFTER (Path A)
----------------------------------      ----------------------------------
SQLite (tauri-plugin-sql)               libSQL embedded replica (local file)
  + sync_outbox table                     + offline writes supported natively
  + outboxFlusher.ts        [DELETE]      + sync handled by libSQL engine
  + custom push/pull logic  [DELETE]
  + custom batching/retry   [SIMPLIFY]    + backoff handled by client lib
  + Dexie mirror            [DELETE]      + single engine, no mirror
Turso via custom REST/HDBC calls         Turso via libsql client (Rust/JS)
Relay: still useful for "pull now"       Relay: still useful (signal only)
```

**Why this is the right first move for you specifically:**

- You are *already on Turso* — this is an upgrade *within* your platform, not a migration to a new backend.
- Local-first offline writes are the core of your POS; embedded replicas are built for exactly this.
- The DB layer move to Rust (F-12) is the same seam libSQL needs — the two efforts compound.
- Deletes propagate through the replica protocol; your tombstone machinery (F-04) becomes defense-in-depth instead of load-bearing.

**Known caveats to engineer around (from current field reports):**

- Multi-writer offline semantics need your HLC/ledger discipline for *numeric* fields (replica sync moves rows; it does not sum concurrent deltas — your `stock_ledger` from F-06 remains essential).
- Verify single-file durability semantics on Android (sandboxed storage + WAL) with the chaos suite before cutover.
- Design the cutover so the outbox remains available as a fallback for one release (§8).

### Option B — Dedicated local-first sync engine

If you ever outgrow Turso or want Postgres-class tooling:

| Engine | Model | Strengths | Watch-outs |
|---|---|---|---|
| **PowerSync** | Sync rules engine over Postgres/MongoDB/MySQL → client SQLite | Production-proven, fine-grained sync rules, good RN/desktop support | Runs a sync service; new infra to operate |
| **ElectricSQL (current gen)** | Postgres → client sync via shapes/subsets | Real-time, well-scoped partial replication | Legacy active-active product retired — don't build on the old one |
| **Zero** | Sync engine + reactive queries | Modern DX, typed schema | Younger ecosystem |
| **Evolu** | Local-first CRDT SQLite | Strong ownership model, E2E-friendly | Smaller community |
| **Triplit** | Full-stack sync DB | Batteries included | More opinionated stack |

**Verdict for Mobi POS:** none of these beat Option A *for your current stack* (they'd add infrastructure to operate). Revisit only if you migrate the backend to Postgres or need row-level sync rules Turso can't express.

### Option C — CRDT layer (cr-sqlite style, column-level CRDTs)

Column-level CRDTs merge *different fields* of the same row edited on different devices — strictly better UX than row-level LWW. This is the technology to adopt **when** product editing becomes truly multi-master (several staff editing catalog fields concurrently). Until then it adds cognitive weight without payoff. The HLC + ledger design in Phase 1 is deliberately CRDT-compatible: `row_hlc` and append-only ledgers upgrade cleanly.

### Decision framework

```text
Stay on Turso?  ──yes──> Option A (embedded replicas). Done.
      │
      no
      ├── Postgres backend planned?  ──> PowerSync (Option B)
      └── Heavy multi-master field editing? ──> Add CRDT layer (Option C)
```

### Target architecture (end state)

```text
App (Tauri desktop / Android)
 ├─ UI (React + Dexie-free reads via query layer)
 ├─ Domain commands (checkout, adjust stock, edit catalog)
 │    └─ every write = ledger row + entity upsert in ONE local transaction
 ├─ libSQL embedded replica  ← local SQLite file, offline-writable
 │    └─ engine handles: sync, retries, backoff, propagation
 ├─ Sync Supervisor (thin): status, reconciliation R-01, quarantine UI
 └─ Relay client (thin): authenticated "pull now" nudges only

Cloud
 ├─ Turso primary (ledger + entities + tombstones)
 ├─ Workers relay (Durable Object, auth'd, rate-limited)
 └─ Optional Worker: token registry, telemetry sink, quota
```

**What gets deleted at the end of Path A:** `outboxFlusher.ts`, push/pull logic in `SyncManager.ts`, the Dexie mirroring layer, custom batching/retry code — thousands of lines of the riskiest code you own, replaced by an engine maintained by the database vendor.

---

## 8. Zero-Downtime Migration Plan

Every step is reversible before the flag flip; no step depends on a "big bang".

| Step | Action | Rollback |
|---|---|---|
| M1 | Land Phase 0–2 fixes on the current engine (schema additions are all additive: `row_hlc`, `local_seq`, `deleted_at`, ledger table) | N/A — pure improvement |
| M2 | Backfill: populate `row_hlc`/`local_seq` for existing local and cloud rows (server-side batch job + client-side on first run) | Additive columns; ignore if abandoned |
| M3 | Dual-run in shadow mode: libSQL replica syncs alongside the legacy engine; reconciliation R-01 compares both paths for 2+ weeks in staging and dogfood installs | Disable shadow sync flag |
| M4 | Cutover reads: UI reads from replica; writes still via legacy outbox | Flip read flag back |
| M5 | Cutover writes: commands commit via libSQL offline mode; outbox kept warm as fallback but idle | Flip write flag back (outbox still intact) |
| M6 | Decommission: delete outbox flusher, push/pull, Dexie mirror after 2 clean release cycles of R-01 metrics | Git revert is possible for one release |
| M7 | Harden for scale: per-device tokens fully enforced, telemetry dashboard, chaos suite in CI as a release gate | — |

**Gate criteria between each step:** zero drift incidents in R-01 for 7 consecutive days on dogfood devices, and the chaos suite (R-02) green.

---

## 9. Professional Engineering Polish

The practices that separate a professional product from a well-debugged hobby project:

1. **CI as a release gate:** `tsc --noEmit` (kills D-01-class regressions), lint, unit tests, and the chaos suite (R-02) run on every PR; releases require green main.
2. **Schema migrations as code:** versioned, forward-only migration files applied by `migrationManager.ts` (renamed responsibility: migrations only, no upload logic); every migration ships with a tested rollback-or-compensation note.
3. **Structured logging:** one JSON log schema (`ts, level, device_id, event, table, hlc, duration_ms, err`); sync decisions (merge winners, quarantine, drift) are always logged with the rows involved.
4. **Feature flags for sync behavior:** `use_replica_reads`, `use_replica_writes`, `shadow_sync` — every migration step in §8 is behind a flag, decoupling deploy from release.
5. **Release discipline:** staged rollout (dogfood → 5% → 100%) with a kill-switch back to the legacy path for one full release cycle.
6. **Runbook:** one page per failure mode — stuck outbox, drift detected, relay down, Turso incident, compromised device — with the exact SQL/commands to run. Professional teams are judged by their worst day.
7. **Security posture:** per-device tokens (F-09), relay auth (F-08), no PII through the relay (already true — keep it that way), and a documented device-revocation procedure.

---

## 10. Definition of Done

The program is complete when **all** of the following hold:

- [ ] D-01: `tsc --noEmit` green in CI on every commit
- [ ] F-01: replaying any batch N times produces identical cloud state
- [ ] F-02: ±2-day clock skew changes nothing in merge outcomes
- [ ] F-03: kill -9 mid-flush drains fully after restart
- [ ] F-04: deletes propagate; restores do not resurrect
- [ ] F-05: quarantine is visible in-app within one poll cycle
- [ ] F-06: concurrent sales converge on the arithmetic sum, always
- [ ] F-07/F-08/F-09: no retry storms; relay refuses unauthenticated clients; devices revocable
- [ ] F-10: crash-injected restores never tear the database
- [ ] R-01/R-02/R-03: drift dashboard live; chaos suite green in CI; KPIs trending
- [ ] §8 M1–M6: legacy sync engine deleted; replica-only architecture with 2 clean release cycles
- [ ] §9: flags, runbook, staged rollout in place

### References (research basis)

- Turso — embedded replicas & offline mode documentation; "Turso Sync" announcement (turso.tech, docs.turso.tech)
- AWS Prescriptive Guidance — *Transactional Outbox Pattern* (at-least-once + consumer idempotency)
- Kulkarni et al. — *Logical Physical Clocks (HLC)*; HLC usage in CockroachDB / YugabyteDB / MongoDB
- Cloudflare docs — Durable Objects WebSockets, Hibernation API, 100s idle timeout, WSS enforcement
- tauri-apps/plugins-workspace — SQL plugin (sqlx) transaction/encryption/WAL issue tracker; community `tauri-plugin-rusqlite2`
- PowerSync — *ElectricSQL vs PowerSync*; electric.ax — *Alternatives*; awesome-local-first ecosystem index; "Sync Engines Are the Future" (Hacker News, 2025)


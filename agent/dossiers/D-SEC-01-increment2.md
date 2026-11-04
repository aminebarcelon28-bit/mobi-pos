# D-SEC-01 increment 2 — renderer read-only pool: what landed, what blocks the flip

**Date:** 2026-11-04 · **ADR:** ADR-005 · **Evidence:** E-0188, E-0189

## What the instrumented boot named

`POS_SQL_QUERY_ONLY=1` (the patched SQL plugin sets `PRAGMA query_only = 1` on the
WebView pool and logs every refused statement under a debug build) produced, on a
fresh sandbox:

| # | Statement | Owner |
|---|---|---|
| 1 | `DELETE FROM sync_outbox WHERE status = 'synced'` | boot cleanup |
| 2 | `UPDATE sync_outbox SET status='pending' WHERE status='inflight'` | crash rescue |
| 3 | `UPDATE customers SET current_debt = (…)` | debt-cache reconcile |
| 4 | `UPDATE cash_sessions … AUTO_CLOSED_DUPLICATE_LIVE_SHIFT` | shift adoption |
| 5 | `CREATE UNIQUE INDEX uq_one_live_shift_per_device` | shift adoption |
| 6 | `INSERT INTO app_settings … schema.heal.v113.done` | schema heal latch |
| 7 | `ALTER TABLE … ADD COLUMN …` (8 statements) | schema heal |

(6) and (7) already fail as "duplicate column" on a current DB; under a read-only
pool they fail as `SQLITE_READONLY` instead — same no-op, different message.

## Landed: boot maintenance is native

`src-tauri/src/boot_maintenance.rs`:

- `apply_boot_maintenance(&mut Connection)` — one transaction, **fixed literals**,
  idempotent: outbox purge + inflight reset, debt-cache reconcile, duplicate-live
  shift count, and the unique index when the table is clean. Returns counts.
- `close_duplicate_live_shifts(conn, device_id, keep_id, now)` — the adoption
  UPDATE + index once clean.
- Runs at startup (`run_at_startup`, in `lib.rs` `.setup()`, before the WebView)
  and sets an atomic flag; `boot_maintenance_applied` (public probe) reports it so
  the renderer knows to skip its SQL.
- Commands `boot_maintenance` (public: fixed literals, no renderer SQL, same class
  as the existing `sqlite_db_maintenance`) and `finalize_shift_adoption`
  (`OperationalWrites`).
- 5 Rust tests: purge/reset, exact debt reconcile (untouched when no ledger rows),
  index refused while duplicates exist, losers closed → index created → second
  call a no-op, and full idempotency.

Renderer side: `sqlPluginAdapter` reads the flag (falling back to invoking the
command), then skips exactly those statements; `customerAdapter`,
`SyncManager` and `shiftBootAdoption` do the same, each keeping its SQL as an
explicit fallback (web preview / older binary).

**The schema heal still runs in the renderer.** An earlier draft skipped it when
the native pass succeeded; that was reverted before commit because the native pass
does **not** create TS-owned tables/columns — skipping it would strand an upgraded
DB. The correct statement is: four maintenance writes moved, the heal did not.

## Measured blocker: a real suite refuses 205 statements

Running `50-sec-authorization` (10 cases) with `POS_SQL_QUERY_ONLY=1` produced
**205 refused statements** (saved at `tests/results/sql-readonly-surface.txt`),
all from boot/settings/sync, not from the test flow:

- **Schema heal** — ~120 DDL/DML statements (tables, indexes, `ALTER TABLE`, data
  backfills, v103/v113/json-dedouble latches). This is the largest class.
- **Settings/session** — `INSERT OR REPLACE INTO app_settings` for
  `sync.device_id`, `sync.*` flags, maintenance month.
- **Sync** — outbox rescue, parked movements (`UPDATE … attempts + 1`),
  requeue of `customers.sync_status='pending'`.
- **Maintenance** — `PRAGMA incremental_vacuum(256)`.

Consequence: flipping the default today bricks the first boot. The plugin switch
therefore stays **off unless `POS_SQL_QUERY_ONLY=1`** is set, and the flip travels
with the write migration (ADR-005 steps 2–4). The boundary gate keeps the debt
visible and ratcheted at 318 renderer statements (report + ratchet in CI).

## Fail-closed rules (2026-11-04, E-0191)

The substring tolerance ("duplicate column" / "has no column named") was the same
weakness that produced the half-schema failure. Replaced by construction:

- **Exact per-statement tolerance.** The generator replays every statement against a
  healed reference DB and records the ONLY error each statement may produce, keyed
  by a stable hash of the statement text (`TOLERANCES`: 55 × `DuplicateColumn` on
  the reference schema). Any other error aborts the migration.
- **Golden manifest post-condition.** `schema_manifest()` canonicalises
  `sqlite_master` + `table_xinfo` + `index_xinfo` (virtual tables excluded because
  the heal does not manage them). The manifest is compared **inside** the
  transaction; a mismatch rolls back, sets the failure state and never sets the flag.
- **One transaction + integrity.** `BEGIN IMMEDIATE` → statements → `integrity_check`
  → `pragma_foreign_key_check` → manifest → `COMMIT`. `foreign_keys` is switched
  outside the transaction (no statement needs it ON). No statement forbids a
  transaction.
- **Pre-migration backup.** Online backup (rusqlite `Backup`), SHA-256 recorded,
  reopened and `integrity_check`-verified, last 3 kept. Tested restore reads the
  data back.
- **Recovery screen, never a silent fallback.** `schema_heal_status()` (public,
  memory-only) drives `SchemaRecoveryScreen`; `main.tsx` mounts it instead of the
  POS when a migration failed. Measured: injecting an extra table made the manifest
  mismatch, the transaction rolled back, the screen rendered
  ("Migration de la base interrompue"), and `schema_heal_status` reported
  `{applied:false, failed:true}`.
- **Drift gate.** `npm run gate:schema-heal` recomputes the SHA-256 of the TS heal
  region and fails when it differs from the generated header; it also rejects
  placeholders/paths/capture markers in the generated statements and requires the
  capture hook to be `#[cfg(debug_assertions)]` with a release no-op.

## Controls (measured, E-0191)

| Control | Result |
|---|---|
| managed boot, `POS_SQL_QUERY_ONLY=1` | **0** refused writes |
| managed boot + injected 5 s heal delay | **0** refused writes |
| crash at statement 40 (abort) | session dies; next boot converges, `applied=true`, **0** refused writes, backups stay at 3 |
| schema mismatch (extra table) | rollback + recovery screen; removing the table lets the next boot converge |

Rust tests (10 in `boot_maintenance`): unexpected error rolls back the whole
migration; tolerance is exact and per-statement; manifest mismatch rolls back and
never sets the flag; crash midway converges with no data loss; backup verifies,
prunes to 3 and restores.

## Remaining (next)

1. **Equivalence** native vs renderer heal on rc-5/rc-6 legacy DBs + fresh + current
   (normalized schema and row hashes), plus proof the 10 backfills are set-based.
2. **Barrier** (plugin `load` awaits native completion) and **base-schema port**
   (v1..current under the same ledger) so fresh installs reach 0.
3. Then flip, full-suite runtime-refusal gate, money-path latency.

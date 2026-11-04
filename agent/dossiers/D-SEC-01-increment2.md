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

## Next, in order

1. Move the schema heal behind a native migration runner (the 120 statements
   become a versioned native migration, not renderer SQL).
2. Move settings/session writes (`sync.device_id`, flags) to native commands.
3. Re-run the 205-statement probe until it reports **0**, then flip the plugin
   default.
4. Money paths last: checkout/refund with before/after latency, budget
   ≤ 10 % p95 regression (baseline measured: checkout 230–750 ms, read lane
   0.4 ms p50).

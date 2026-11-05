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
| crash at statement 1, 60 and 124 (abort) | session dies each time; every next boot converges, `applied=true`, **0** refused writes |
| crash at statement 40 (earlier run) | same, backups stay at 3 |
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
## Equivalence gate (2026-11-04, E-0192)

`npm run gate:schema-equiv` compares the native migration against a faithful
simulation of the renderer heal on five committed fixtures (gzipped):
`rc5`, `rc6`, `rc5-double`, `rc6-double`, `current`. For each it compares the
canonical schema manifest and every table's row count + order-independent row
hash (clock columns masked, JSON columns canonicalised).

```
[schema-equiv] PASS current    schema equal (…6c28c50cb2) data diffs 0
[schema-equiv] PASS rc5-double schema equal (…6c28c50cb2) data diffs 0
[schema-equiv] PASS rc5        schema equal (…6c28c50cb2) data diffs 0
[schema-equiv] PASS rc6-double schema equal (…6c28c50cb2) data diffs 0
[schema-equiv] PASS rc6        schema equal (…6c28c50cb2) data diffs 0
SCHEMA EQUIVALENCE: 5/5 fixture(s) identical
```

**Row-driven backfills were the real gap.** The capture came from a near-empty DB,
so it never exercised `healDoubleEncodedJsonPayloads` (parses each row's JSON and
rewrites it) or `pruneStaleEventLog`. Both are now ported to Rust
(`unwrap_double_encoded`, `dedouble_json_payloads`, `prune_stale_event_log`) and run
inside the migration transaction, with row fixtures proving the rewrite (nested
`json_payload` unwrapped, outer keys preserved, latch written after the pass) and
the prune's fail-closed rule (only `synced_to_cloud = 1` and older than 90 days).

Two ordering/ownership defects surfaced and are fixed:

1. the `json_dedouble` latch was captured as a *statement* and therefore ran
   before the backfill, skipping it — excluded from the statement list, written by
   the backfill itself;
2. legacy DBs lack native-owned objects (`audit_chain`, SEC-18 attribution
   columns). The migration now ensures them first (`ensure_audit_schema`); without
   that, rc-5/rc-6 heals failed the manifest post-condition (fail-closed, as
   designed).

## Native base-schema port + barrier (2026-11-04, E-0194)

- **Base schema is native.** `native_migrate` replays the plugin's `v1..v129`
  migrations against the live DB in `.setup()`, ordered by version (sqlx's order,
  not source order), and records the sqlx ledger rows (`version`, SHA-384
  `checksum`, success) in `_sqlx_migrations`. An installed migration whose
  checksum no longer matches aborts startup.
- **Barrier, not a poll.** After migrate + heal the core writes
  `schema_ready.json`; the patched plugin's `load()` waits for it (state-based,
  100 ms steps, 30 s budget) and treats `status:"failed"` as a hard error. The
  renderer can no longer reach a half-migrated database.
- **Ledger catch-up.** Legacy ledgers stop at v112 while the heal already created
  later objects, so non-idempotent migrations hit duplicates/missing columns.
  Those migrations are rolled back, recorded as applied, and **retried after a
  column prep** so table rebuilds still run; completeness is proven by the golden
  manifest, not by trusting the ledger.
- **Fresh install** now creates the DB natively (v1 + all migrations + heal)
  before the window: startup reports `migrations applied 36, tolerated 2, retry
  [113,114], last 129` and the heal reports the golden manifest hash. The renderer
  heal is skipped.
- **Manifest is semantic for tables.** Rebuilt tables legitimately change their
  stored CREATE text; tables are compared by columns + foreign keys + unique
  constraints, while indexes/triggers keep their SQL text. Comma spacing is
  canonicalised so formatting cannot fail a migration.

**Remaining on the fresh path: 13 renderer writes** — `sync.device_id` upserts,
sync-flag upserts, the maintenance month + `incremental_vacuum`, and an orphan
`sale_batch_allocations` cleanup. They are the next migration slice; until they
have native lanes, the fresh install still needs a writable pool (spec 92 under
`POS_SQL_QUERY_ONLY=1` fails setup, 13 refusals), while the **managed path is at
0 refusals** and the normal fresh path passes.

## Settings/maintenance lanes (2026-11-04, E-0195)

Twelve of the thirteen remaining fresh-install writes now have native lanes
(`src/settings_lane.rs`, all `OperationalWrites`):

| Lane | Covers |
|---|---|
| `ensure_device_id` | `sync.device_id` read/mint/upsert |
| `set_sync_setting` | `sync.*` upserts (allowlisted namespace, 64 KB cap) |
| `set_app_setting` | the Dexie-mirror settings write; **sensitive keys refused by name** (pin/token/secret/credential/licence/mac/key/password/hash/salt) |
| `idle_maintenance` | WAL checkpoint + `incremental_vacuum(256)` |
| `purge_orphan_allocations` | the `alloc-*-item-*` boot cleanup |

Measured on a fresh install under `POS_SQL_QUERY_ONLY=1`: **13 → 1 refusal**.
The last one is `INSERT INTO cash_sessions …` — the shift-open business write,
which has no native command yet. Opening a cash session is fiscal state, so it
needs its own failing→passing test and refund-suite re-runs (money rules), not a
quiet port.

Until that lane exists the fresh path cannot be 0 and the plugin default stays
opt-in; the JS heal call and the capture hook stay until the fresh probe reaches
0, per the ruling.

## Fiscal shift-open lane (2026-11-04, E-0196)

**Failing first.** The lane was written with the session insert only, and the
parity test asserted the outbox row and the entity key. `cargo test --lib
shift_lane` failed all three tests (`QueryReturnedNoRows`, `left: 0, right: 1`),
which is the recorded gap; the parity was then added and the same three passed.

`src-tauri/src/shift_lane.rs` — one native transaction (`OperationalWrites`):

| Step | Detail |
|---|---|
| device identity | resolved from `app_settings.sync.device_id`, minted if absent; the request struct has **no** device field |
| double-open | refused by the same query the renderer used, with a typed `SHIFT_ALREADY_OPEN` |
| session | `cash_sessions` insert, fixed literal |
| entity key | `entity_keys` row (UUID) in the same transaction |
| outbox | `sync_outbox` UPSERT with the bumped version; `deviceId`/`version` are rewritten natively so the payload cannot spoof either |

The renderer skips its SQL insert **and** its `fireSync` when the native lane runs
(the native transaction already wrote the outbox), and falls back to SQL only on a
non-Tauri host. Money-rule suites re-run: **40-shf 12/12, 30-ref 12/12,
34-ref 17/17**, and spec 50 10/10 / spec 92 1/1.

**Fresh-install probe (real wipe, `POS_SQL_QUERY_ONLY=1`): 0 refused renderer
writes**, shift `OPEN`:

```
[0-0] SHIFTPROBE {"id":"SHIFT-1793806239950-1-Z0Z6","status":"OPEN"}
--- refusals ---
NONE
```

That 0 was reached after removing the last renderer write paths on boot **and**
fixing four defects the probe exposed:

1. **Capture pollution** — the capture log had been appended to by a spec run, and
   the "all captured DDL" rule pulled `CREATE/DROP TABLE sec2_control` into the
   generated migration (259 statements). The generator now accepts DDL only when
   its target is a golden-manifest object → 221 statements, no probe names.
2. **Lazy native tables** — `device_identity` is in the golden manifest but was
   only created on first use, so a fresh install failed the post-condition. It is
   now ensured before the heal (`ensure_native_schema`).
3. **Manifest ownership** — `time_anchor`/`import_*` are created by other native
   lanes and are now allowed by exact name; vector tables (`vec_*`) are excluded
   on both sides because better-sqlite3 (generator) cannot load `vec0` while the
   Rust side can, which made the two manifests disagree.
4. **Stale-state probes** — `npm run e2e:clean` does not wipe the app database; a
   probe without `POS_E2E_WIPE=1` measured a leftover live shift and reported a
   false `SHIFT_ALREADY_OPEN`. Probes now wipe explicitly.

**Hook deleted.** `record_captured_sql` and its call are gone from the patched
plugin; the renderer heal is no longer called on Tauri at all (an unapplied native
heal is a fail-closed stop, never a second writer). `schema_heal_sql.rs` is the
frozen list. `npm run gate:capture-release -- --build` builds the plugin in
release and proves the artifact carries no capture marker (9 rlibs checked).

**Still blocking the default flip:** the money write paths. `beginImmediate` is
still called from the renderer for checkout (`writeCheckoutAtomic`), void,
refund, restitution, FIFO reconcile, repair COGS, inventory deltas and sync order;
a read-only pool would refuse those. They are the next lanes, in that order, and
the plugin default stays opt-in until a full e2e run under the flag is clean.

## Money-path refusals, measured (2026-11-04, E-0198/E-0199)

Two things happened here: the floor was restored honestly, and the biggest
runtime refusal class was removed.

**Floor restored to 318.** The extra static entry was a real renderer write
(`shiftAdapter.setShiftCashier`), so it got a native lane instead of a raised
baseline: `set_shift_cashier` updates the session row, the entity key and the
outbox in one transaction (two Rust tests: hand-over keeps outbox in step;
unknown shift writes nothing). The renderer SQL is gone, so the scan is back to
**318** — the rc-10 floor, not 319.

**Generic sync enqueue is native.** `fireSync` funnels every lane through
`enqueueGenericSync`, which used to do four renderer writes (entity key insert,
version bump, outbox upsert, ALTER probe). Measured in one refund spec under
`POS_SQL_QUERY_ONLY=1`: **94 × 4** of those. `src-tauri/src/sync_lane.rs` now
does it in one transaction (`enqueue_sync_upsert` / `enqueue_sync_delete`):
entity name checked against the same closed set as the TS union, payload bounded
to 64 KiB and required to be a JSON object, version injected natively; four Rust
tests (monotonic clock, tombstone, unknown entity writes nothing, oversize
rejected before any write).

**Measured, same spec, same machine** (`30-ref-refunds` under the flag):

| State | Refused renderer writes |
|---|---|
| before the enqueue lane | **438** |
| after | **133** |

What the remaining 133 are (verbatim from the violation log):

```
x71 UPDATE customers SET sync_status = 'synced' WHERE id = $1 AND version …
x22 INSERT INTO customers (…)
x20 UPDATE customers SET json_payload = CASE WHEN json_valid(…) …
x15 BEGIN IMMEDIATE;
x2  INSERT INTO customers (…)
x2  INSERT INTO store_expenses (…)
x1  INSERT INTO products (…)
```

That is the ordered work list for the flip:

1. **customer mirror** (`customerAdapter.saveCustomer` + the post-refund loyalty
   mirror + the pull lane's `sync_status='synced'` stamp) — 115 of the 133;
2. **void** (`db:void`) — no native lane exists at all;
3. **store_expenses** insert;
4. the remaining **`BEGIN IMMEDIATE`** call sites (restitute / FIFO / inventory /
   sync order) and the test-seed product insert.

Spec 10 (checkout) under the flag is already **green 14/14** with 12 refusals
(11 `BEGIN IMMEDIATE` probes + 1 seed insert), i.e. the checkout kernel itself is
native and does not write through the pool.

Normal-mode regression checks: `30-ref-refunds` **12/12**, `40-shf-shifts`
**12/12** after the cashier lane. `24-syn-sync` shows 3 failing cases
(SYN-04/26/27), which the baseline COVERAGE already records as FAIL — those are
unimplemented conflict/HLC/encryption features, not regressions.

## Customer mirror lanes + money budget (2026-11-04, E-0199)

**Native customer writes.** Two contracts moved to `src-tauri/src/customer_lane.rs`:

| Command | Replaces | Contract kept |
|---|---|---|
| `upsert_customer` | `saveCustomer`'s INSERT … ON CONFLICT | optimistic `WHERE customers.version = base` guard when guarded; `current_debt` COALESCEd so a caller without it cannot wipe the ledger cache; `created_at` preserved |
| `mark_customer_synced` | the pull/requeue stamp | version **and** status guard (`version = ? AND sync_status='pending'`), so a row that changed underneath stays pending |

Three Rust tests: guarded upsert (stale attempt changes 0 rows), missing `current_debt` preserves the cache, and the synced stamp is version/status guarded. The renderer keeps its SQL only for non-Tauri hosts.

**Measured, `30-ref-refunds` under `POS_SQL_QUERY_ONLY=1`:**

| State | Refused renderer writes |
|---|---|
| after the sync-enqueue lane | 133 |
| after the customer lanes | **29** |

The 29 that remain are now one coherent surface — the **void/refund mirror**:

```
x12 BEGIN IMMEDIATE;                              ← db:void / db:refund transaction
x12 UPDATE customers SET json_payload = CASE …    ← refund loyalty json_patch
x2  INSERT INTO customers (… 'stub-cust-' …)      ← refund parent stub
x2  INSERT INTO store_expenses (…)
x1  INSERT INTO products (…)                      ← test seed
```

Under the flag the refund spec now reaches those paths in 5 cases (previously the
customer failures aborted earlier in 2), i.e. the read-only run is *deeper*, not
worse: normal mode stays **12/12**, and `10-mny-money` **14/14**.

**Money-path budget (first measurement).** `e2e-tests/results/latency-probe.e2e.ts`
runs N real checkouts through the UI and prints p50/p95. n=10, same machine:

| Mode | p50 | p95 |
|---|---|---|
| normal | 1121 ms | 1499 ms |
| `POS_SQL_QUERY_ONLY=1` | 1117 ms | **1537 ms** |

p95 regression = **+2.5 %**, inside the ≤ 10 % budget. (n=10 is the probe's default
smoke size; the final number for the tag will use n ≥ 200 per the ruling.)

## Void/refund mirror lane (2026-11-04, E-0200)

The last renderer writes on the refund path moved native, and `30-ref-refunds` is
now **green under `POS_SQL_QUERY_ONLY=1`** (12/12) with **1** refused write left
(down from 29).

**New commands** (`src-tauri/src/void_refund_lane.rs`, 12 pinning tests):

| Command | Replaces | Contract pinned |
|---|---|---|
| `apply_customer_loyalty_mirror` | the refund loyalty `json_patch` + ledger appends | patch + ledger commit or roll back together; ledger idempotent per entry id; legacy non-array ledger refused, payload untouched |
| `void_sale_mirror` | `db:void`'s renderer `BEGIN IMMEDIATE` | status flip + IMEI releases + events + loyalty + money delta in one transaction; a failing loyalty bundle rolls the status flip and IMEI release back; a second void is `ALREADY_VOIDED` with no double ledger append |
| `refund_sale_mirror` | `db:refund`'s renderer `BEGIN IMMEDIATE` | `ORIGINAL_VOIDED` refuses before any write; releases are idempotent; one ownership event per (kind, order, imei) |
| `upsert_store_expense` | `saveStoreExpense` | idempotent upsert, version bumped |
| `upsert_customer_debt` | the debt stub + debt row | stub is idempotent and never clobbers a live parent; the debt row is version-guarded |
| `refresh_customer_debt_cache` | `reconcileCustomerDebtFromLedger` column refresh | changed rows only, never bumps `version` (derived cache) |

**Measured, same spec:**

| State | Refused renderer writes | Spec |
|---|---|---|
| before this lane | 29 | RED 8/12 |
| after void/refund mirror + expense + loyalty | 15 | RED 8/12 |
| after customer-debt lane | 20 | **GREEN 12/12** |
| after debt-cache lane + FIFO preflight | **1** | **GREEN 12/12** |

Normal mode stays green: `30-ref-refunds` 12/12, `10-mny-money` 14/14,
`40-shf-shifts` 12/12.

**The one refusal left** is `syncProductUpsertBulk`'s products upsert
(`INSERT INTO products (… 24 columns …) ON CONFLICT … version=excluded.version`, SQL
shown in the violation log). It is a complete lane, not a one-liner: the same
function conditionally writes a manual `inventory_ledger` ADJUST row, recomputes
`products.stock` from the ledger, and inserts an opening `stock_batches` row.
Porting only the upsert would leave the companions refusing under a read-only
pool, so it is named rather than half-migrated.

**FIFO reconcile.** The 15 `/* fifo:reconcile */ BEGIN IMMEDIATE` refusals were a
no-op transaction: no unresolved `SHADOW` batch existed, so the 360-line COGS
algorithm opened a write transaction for nothing. It now preflights the count
(read-only) and returns 0 when there is no work. **The reconcile writes themselves
are still renderer-side**: with a real unresolved shadow the lane must be ported
natively before the pool can be flipped for shadow-bearing data. That is a named
flip residual, not a silent skip.

**Latency, n=200** (same machine, warmup inside the probe):

| Mode | p50 | p95 | min | max |
|---|---|---|---|---|
| normal | 1097 ms | 1132 ms | 1056 ms | 1539 ms |
| `POS_SQL_QUERY_ONLY=1` | 1096 ms | 1133 ms | 1059 ms | 1528 ms |

p95 regression **+0.09 %**, far inside the ≤ 10 % budget.

## Product mirror + shift close (2026-11-05, E-0201)

**Refund spec under the flag: 0 refusals.** `30-ref-refunds` is green (12/12) with an
empty refusal log. The last refusal (the product upsert) is gone.

**`upsert_product`** (`src-tauri/src/product_lane.rs`, 4 tests): one transaction for
the product row, the conditional `inventory_ledger` ADJUST, the stock recompute,
the opening `stock_batches` row and all sync envelopes. The renderer keeps the
reads (existing key/version, ledger sum, batch count) so the stock decision is
unchanged. The lane writes the bumped `version` explicitly; the old SQL referenced
`excluded.version` without inserting a version column, so the clock reset to the
default on every catalog edit.

**`close_shift`** (`shift_lane.rs`, 2 tests): status CLOSED + closed_at +
expected/actual/discrepancy + note + payload + envelope in one transaction; an
unknown session is `SHIFT_NOT_OPEN` with no writes. `40-shf-shifts` normal stays
**12/12**; under the flag it went from 1/12 to **10/12** and its refusals from 11
to 3.

**Wide flag sweep (measured):**

| Spec | Normal | Flag | Refusals |
|---|---|---|---|
| 30-ref-refunds | 12/12 | **12/12** | **0** |
| 10-mny-money | 14/14 | **14/14** | **0** |
| 50-sec-authorization | 10/10 | **10/10** | **0** |
| 40-shf-shifts | 12/12 | 10/12 | 3 |
| 92-sql-readonly-app | 1/1 | RED | 5 |
| 24-syn-sync (normal) | 27/30 | — | same 3 pre-existing (SYN-04/26/27) |

The remaining flag refusals are now a precise list:

```
x1 INSERT INTO held_orders (…)          ← hold order (shift spec)
x1 UPDATE held_orders SET deleted=1 …   ← held-order removal
x1 INSERT INTO cash_movements (…)       ← manual drawer movement
x5 spec-92 controls                     ← the spec's own writable-pool probes
```

The spec-92 five are its **controls** (create/insert/drop `sec2_control`, bulk
seed/cleanup of products) — they exist to prove the database is writable through
the pool. After the flip the writable path is native, so those controls must be
re-pointed at a native command (e.g. `upsert_store_expense`) rather than deleted.

## Held orders + drawer movements (2026-11-05, E-0202)

Two more lanes, and the remaining measurable refusals in the shift spec are gone.

| Command | Replaces | Contract |
|---|---|---|
| `save_held_order` | the held-sale upsert | version bumped on update, revived from tombstone |
| `delete_held_order` | tombstone | same statement, no live predicate (repeat delete bumps) |
| `claim_held_order` | `HELD_ORDER_CLAIM_SQL` | **single-claim CAS**: two recalls → 1 then 0 |
| `release_held_order` | release | only a claimed row resurrects |
| `log_cash_movement` | movement insert + parking fallback | guarded by an OPEN session; when it does not land the movement is parked in the same transaction |

**Measured:**

| Spec | Normal | Flag | Refusals |
|---|---|---|---|
| `40-shf-shifts` | **12/12** | **12/12** | **0** (was 10/12, 3) |
| `92-sql-readonly-app` | 1/1 | **1/1** | **0** (was RED, 5) |

Spec 92's writable controls now prove writability through the **native** lane
(`upsert_store_expense` write + pool read-back) instead of writing through the
pool under test, and its 2 100-row cap seed runs out-of-band (host
better-sqlite3) — a harness concern, not an app write. The control was not
deleted: it still proves the database is writable, just through the path that
remains writable after the flip.

Static boundary: **315** (down from 317; held-order SQL removed, movement SQL kept
only as the non-Tauri fallback). The heal drift gate was regenerated through its
generator after a line shift; only `SOURCE_SHA256` changed (statements and
manifest byte-identical), and the equivalence gate is unaffected.

## Inventory deltas + small lanes (2026-11-05, E-0203)

The first full-suite flag sweep (154 cases, 949 s) produced the exact residual
inventory: **30 refusals**, split into ~11 real app lanes and ~19 harness probes
(the DAT/INVARIANT specs deliberately write through the pool to test SQLite
behaviour). This increment removes three of the app lanes:

| Lane | Replaces | Tests |
|---|---|---|
| `append_inventory_deltas` | `appendInventoryDeltasInner` (labelled BEGIN + per-product ledger/stock/outbox writes) | 2: ledger + stock recompute + both envelopes; duplicate id is a no-op |
| `tombstone_customer` | `deleteCustomer`'s UPDATE | 1: version bump, repeatable, missing id writes nothing |
| `ensure_product_stub` | `ensureProductParents`' INSERT OR IGNORE | 1: idempotent, never overwrites |

The delta lane keeps the shadow events in TS after the commit (best-effort, as
before); the stock value is the ledger's signed sum (the ledger is the truth), and
the product envelope is the committed row snapshot.

**Measured after the lanes:** `30-ref-refunds` and `40-shf-shifts` are 12/12 in
**both** modes with **0 refusals**; cargo 519; sql-boundary **314** (down from 315).

Remaining from the sweep: `credit_vouchers` update ×2, `trade_ins`, `imei_records`,
`imei_events`, the ~19 harness probes (temp tables, `no_such_table` SELECT,
ROLLBACK, literal `DAT-DEL-P` delete, plain BEGINs), and the FIFO reconcile writes.

Operational note: the volume hit **0 bytes free** mid-sweep (the Rust target tree
was 49.4 GB). `cargo clean` removed only regenerable build output (114 083 files,
49.4 GiB), restoring 39.3 GB; no source or user data was touched, and the next
build is consequently a full rebuild.

## Trade-in floor restored + receiving lanes (2026-11-05, E-0204)

**A floor row had fallen and it was not the lanes.** `80-tin-tradein` was 10/21 with
eleven failures where the committed baseline records six (`TIN-01/04/06/08/14/17`).
Root cause found by probe, not by guess: the modal's customer-name input is
`required` (`TradeInBuybackModal.tsx:664-672`) and its placeholder became
`Ex: Salma Hadj`, while the spec filled it by matching `/Nadir Hadj/i`. The field
was never filled, so HTML5 validation silently blocked every submit — no toast, no
write, `trade_ins` unchanged. `TIN-02/03/07/11` (baseline PASS) and `TIN-10`
(baseline N/A) fell as collateral.

Fix is a locator repair, not a weaker test: the pattern now tracks the current
placeholder (`/Hadj/i`), every assertion is untouched. Measured after:

| Run | Result | Failing cases |
|---|---|---|
| `80-tin` normal | **15/21** | `TIN-01, 04, 06, 08, 14, 17` |
| baseline COVERAGE FAIL set | — | `TIN-01, 04, 06, 08, 14, 17` |

Exact match: no extra row falls, and `TIN-10` now passes where the baseline
recorded N/A.

**Receiving lanes** (`src-tauri/src/receiving_lane.rs`, 4 tests):

| Command | Replaces | Contract |
|---|---|---|
| `insert_stock_batch` | `insertStockBatch` (row + envelope) | one transaction; the envelope carries the committed version; a caller-supplied key makes a retry converge on one envelope (the old lane always minted a fresh key) |
| `insert_supplier_price_rows` | `insertSupplierPriceRows` | one transaction, idempotent by row id; a retried receipt appends nothing twice |

**Refusals measured, same specs:**

| Spec | Before | After |
|---|---|---|
| `82-inv-inventory` flag | 5 (`supplier_price_history` ×2, `stock_batches` ×2, `event_log` ×1) | **3** (`purchase_orders` ×2, `event_log` ×1) |
| `80-tin-tradein` flag | 10 (`stock_batches` ×9, `event_log` ×1) | **10** (`products` singular ×9, `event_log` ×1) |

The trade-in batch refusals are gone; the singular `syncProductUpsert` (a different
function from the bulk lane ported in E-0201) is the new exposure, because the flag
now reaches further into the flow.

**Static boundary 308** (down from 314): the voucher, trade-in, IMEI and
supplier-price SQL left the renderer.

**Named remainder (measured, not guessed):** the shadow-event interceptor
(`event_log` + the `p_*` projections, `src/sync/eventInterceptor.ts` +
`src/domain/reducers.ts`, 10 event types) is still renderer-side and is called from
the product upsert; the singular `syncProductUpsert`; `purchase_orders`; and the
FIFO reconcile algorithm.

## Shadow events + product mirror are native (2026-11-05, E-0205)

**Five specs now run at 0 refused writes in BOTH modes.** This increment closed the
last structural piece — the shadow-event interceptor — and the singular product
mirror that calls it.

| Command / change | Replaces | Tests |
|---|---|---|
| `record_shadow_event` | `recordShadowEvent` in `eventInterceptor.ts`: `event_log` append + the nine-case `p_*` reducer + `projection_cursor` | 5: create/stock reduce, LWW staleness, checkout header+lines idempotent, failed projection rolls the event back, unknown type logged not guessed |
| `save_purchase_order` | `savePurchaseOrder` upsert | 1: version bumped on conflict, one row |
| `syncProductUpsert` → existing `upsert_product` | the *singular* product write (distinct from the bulk lane in E-0201) | covered by the existing 4 product-lane tests |

**Deliberate difference, recorded in ADR-005:** the shadow lane runs log + reduce +
cursor in ONE transaction, so a failed projection cannot leave half-applied shadow
state. The renderer ran them as separate statements and could. On a schema the
lane cannot support, the command fails and TypeScript latches exactly as before.

**Measured (same machine, same specs):**

| Spec | Normal | Flag |
|---|---|---|
| `80-tin-tradein` | **15/21, 0 refusals** | **15/21, 0 refusals** (was 14/21 with 10) |
| `82-inv-inventory` | **12/17, 0 refusals** | **12/17, 0 refusals** (was 12/17 with 3) |
| `30-ref-refunds` | 12/12, 0 | 12/12, 0 |
| `10-mny-money` | 14/14, 0 | 14/14, 0 |
| `40-shf-shifts` | 12/12, 0 | 12/12, 0 |

`TIN-10` returning to PASS under the flag is the direct proof that the product
refusal (not the spec) was its cause.

**Static boundary 307** (down from 308); registry 106; cargo 533.

**Remaining from the last full sweep:** the DAT/INVARIANT harness probes (~19 raw
writes whose subject is SQLite behaviour) and the FIFO reconcile algorithm. No app
lane is left in the measured inventory for the specs exercised so far; the full
48-spec sweep is what confirms that across every spec.

## First-half flag sweep: only probes refused (2026-11-05, E-0206)

The full 48-spec sweep was attempted twice. Run 4 got through specs 00–23 before the
sandbox WebView died (`23-scl-scale-wal` "before all" hook: *no boot screen mounted*,
preceded by `Timed out receiving message from renderer: 300.000`), so it is a
partial measurement, not a full one. The refusal log up to that point is the useful
part:

```
total = 21
x6  BEGIN IMMEDIATE                                            ← probe
x3  ROLLBACK                                                   ← probe
x3  CREATE TEMP TABLE IF NOT EXISTS scl79_strict_app … STRICT   ← probe
x3  SELECT * FROM dat59_no_such_table                           ← probe
x3  UPDATE products SET deleted = 1 WHERE id = 'DAT-DEL-P'      ← probe
x3  INSERT INTO inventory_ledger (…)                            ← harness seed
```

Every one is a harness write, not an app lane:

* the temp table, `no_such_table`, `DAT-DEL-P` and `ROLLBACK` statements are the
  DAT/INVARIANT negative controls whose **subject is SQLite behaviour** — they must
  move to host-side writable connections (the same treatment spec 92 got);
* the `inventory_ledger` rows come from `e2e-tests/lib/seed.ts` and
  `e2e-tests/lib/campaign.ts`, i.e. harness seeding through the pool;
* the six bare `BEGIN IMMEDIATE` are spec-level transaction probes.

So across the first 24 specs **no application lane refused a write** under
`POS_SQL_QUERY_ONLY=1`. The remaining work is the harness-probe migration, not more
native commands.

**Open blocker:** the sweep is not full-suite green because the renderer died in the
scale-WAL spec around the 38-minute mark. That needs triage (scale batch + read-only
pool, or sandbox memory) before the "full suite at 0" claim and any tag.

## Probe writes migrated; scale-fixture instability (2026-11-05, E-0207)

**Attribution first.** Each probe-bearing spec was run alone under the flag with a
fresh violation log, which turned the 21 aggregate refusals into an exact map:

| Spec | Refusals | Statement | Nature |
|---|---|---|---|
| `20-dat-data-integrity-part1` | 6 | `UPDATE products … DAT-DEL-P` ×3, `INSERT INTO inventory_ledger` ×3 | harness write through the pool |
| `22-dat-data-integrity-part3` | 12 | `BEGIN IMMEDIATE` ×6, `ROLLBACK` ×3, `SELECT * FROM dat59_no_such_table` ×3 | DAT-59 pool-hygiene probe |
| `23-scl-rcp-tim-i18` | 3 | `CREATE TEMP TABLE … STRICT` ×3 | SCL-79 app-engine diagnostic (asserts nothing) |
| `01-invariant-negative-controls`, `21-dat-data-integrity-part2` | 0 | — | already host-side |

**Migrated, assertions intact:**

* `20-dat`: DAT-05's orphan insert moved to the host connection (which also opens
  with `foreign_keys=ON` on the same file, so the constraint under test is
  identical) and DAT-19's soft-deletes moved to `run()`. DAT-05 now logs both
  `pluginForeignKeys` and `hostForeignKeys`.
* `22-dat`: DAT-59 measured **the wrong layer** after the flip — transactions live
  natively now, so the case now injects five failing native calls and then proves
  the native connection is not left in a transaction by performing a real native
  write (`upsert_store_expense`) and reading it back. `leaked` is
  `!write.ok || probeRows !== 1`, i.e. stricter than the old boolean.
* `23-scl-rcp-tim-i18`: the two app-side DDL calls assert nothing (they are
  diagnostics) and cannot run against a read-only pool; they are now reported as
  skipped with the reason, while the STRICT/RETURNING/trigram contract stays
  asserted on the host connection.

**Measured after migration (both modes):**

| Spec | Normal | Flag |
|---|---|---|
| `20-dat` | 22/29, 0 refusals | **22/29, 0 refusals** (was 21/29 with 6) |
| `22-dat` | 23/29, 0 refusals | **23/29, 0 refusals** (was 22/29 with 12) |
| `23-scl-rcp-tim-i18` | 6/17, 0 refusals | **6/17, 0 refusals** (was 6/17 with 3) |

**Scale-fixture instability (the real blocker, triaged twice).**
`23-scl-scale-wal` run alone is identical in both modes — 1 000 000 rows, 92 MB
WAL, boot 1 100 ms, **0 refusals** — and fails only its documented `progressbar`
assertion (its baseline verdict is FAIL). But chained in the full sweep, the run
dies right after `23-scl-scale-db` seeds **10 000 043** ledger rows: the next spec's
boot gate times out (`no boot screen mounted`, after `Timed out receiving message
from renderer: 300.000`). Reproduced in two consecutive full runs (dying at specs
`23-scl-scale-wal` and `23-scl-scale-ledger`). The full run reached spec 13 with
**0 refusals** before the death.

That is a data-scale/boot-cost problem in the sandbox, identical with and without
the flag, not a boundary refusal. It needs its own triage (boot maintenance cost
against a 10M-row ledger) before a single-process 48-spec run can be green; the
suite has to be measured as batches until then.

## Boot triage: the fixture, not boot (2026-11-05, E-0208)

**The scale death is not boot cost.** Measured directly at the fixture size
(`e2e-tests/results/boot-scale-probe.e2e.ts`, 10 000 000 ledger rows for one product):

```
3M rows  : seed 23 518 ms      boot 1 123 ms
10M rows : seed 253 941 ms     boot 2 141 ms
           host SUM(product)   8 729 ms
           host COUNT(*)       9 633 ms
           negative-stock scan   687 ms
```

Boot is 2.1 s with ten million rows. What takes four minutes is the **host seed**
(10M inserts maintaining three indexes). At the default 300 s mocha timeout the
scale spec times out mid-fixture, wdio tears the session down, and every later
spec's `unlockIfNeeded` reports *no boot screen mounted*. The repo already
documents the knob for this (`WDIO_MOCHA_TIMEOUT`, "opt in per run" in
`wdio.conf.ts`), and the runs above used it.

**Full-suite attempts (all under `POS_SQL_QUERY_ONLY=1`):**

| Attempt | Reached | Refusals at death |
|---|---|---|
| #4 (default timeout) | spec 23 | 0 |
| #5 (default timeout) | spec 14 | 0 |
| #6 (900 s timeout) | spec 14 | 0 |

All three die the same way: after `23-scl-scale-db`/−`ledger` seed ten million
rows, the app session is gone and every subsequent spec fails its boot gate. That
is a harness/session limit at this fixture size on this box, reproducible
regardless of the flag.

**The residual app lanes, measured on everything else.** Running the 43 non-scale
specs in one process under the flag gives the exact remaining list:

```
SUITE45 refusals=11
x4  INSERT INTO repair_orders (…)                        ← repair lane
x2  /* db:restitute */ BEGIN IMMEDIATE                   ← restitution transaction
x2  /* sync:order */ BEGIN IMMEDIATE                     ← order status flip transaction
x1  INSERT INTO stock_batches (…)                         ← restitution REFUND batch
x1  UPDATE stock_batches SET quantity_remaining = …       ← restitution restock
x1  INSERT INTO debt_plan_entries (…)                     ← installment plan
```

The earlier batch C (specs 24–48 minus scale) measured **0 refusals**, so the
remainder is entirely these four lanes: `repair_orders`, `db:restitute`,
`sync:order`, `debt_plan_entries`.

## Three more lanes: order status, repairs, kredy (2026-11-05, E-0209)

The 43-spec run named 11 refusals; three of those lanes are now native and the
refunds/repair specs confirm it.

| Command | Replaces | Tests |
|---|---|---|
| `sync_order_status` | `enqueueOrderSync` (status flip + version bump + order envelope in a renderer `BEGIN IMMEDIATE`) | 4: flip stamps row and envelope with the bumped clock; second VOIDED is `ALREADY_VOIDED` with no extra row; missing row enqueues a `legacy-` key; a spoofed payload version/key is overwritten |
| `save_repair_order` | `saveRepairOrder` upsert | 1: version bumped, costs kept, one row |
| `save_debt_plan` / `pay_debt_plan_entries` / `close_debt_plan` | kredy plan create, payment fill, close claim | 4: entries+header commit together and a retry converges; a failed header rolls the entries back (no orphan schedule); `paid_at` only when settled; close is a single claim |

**Measured (both modes):**

| Spec | Normal | Flag |
|---|---|---|
| `31-ref-refunds-part2` | 15/15, 0 refusals | **15/15, 2 refusals** (`db:restitute` BEGIN + its batch update) |
| `32-ref-refunds-part3` | 15/15, 0 | **15/15, 0 refusals** |
| `84-rep-repair` | 9/24, 0 | 9/24, 16 refusals (`technician_time_log` ×9, `db:restitute` ×3 + batches ×3, `warranty_claims` ×1) |

Two things worth recording:

* `sync_order_status` was allowlisted but initially **not** in the invoke handler.
  The ad-hoc parity diff caught it before the run; without the handler the renderer
  would have fallen back to SQL and the refusals would have stayed. `check-handler-parity`
  now reports 111 production commands.
* `84-rep-repair` is 9/24 in **both** modes, so its 15 failures are not flag-induced;
  but the flag run exposed three more write lanes that the 43-spec sweep never
  reached (it stopped earlier): `technician_time_log`, `warranty_claims`, and the
  restitute transaction. The measured inventory therefore grows with coverage — the
  honest reading is that "0 refusals" must be re-measured per spec before the tag.

**Gates:** money 65/0 · zero-tax 23/0 · cash-terms 32/0 · tsc 0 · lint 0 · selftest OK ·
reconcile 687 · cargo 542/542 · registry 111 · sql-boundary **306** (down from 307) ·
drift OK · secrets/licences clean.

## Restitute + repair-side lanes (2026-11-05, E-0210)

**Restitution is native.** `restitute_stock_batches` mirrors the renderer's
transaction statement-for-statement: live batch → `quantity_remaining + qty`,
`version + 1`, guarded by the version it read (one re-read on a lost race, then a
retryable `RESTITUTE_VERSION_CONFLICT`); shadow marker / tombstoned / missing batch
→ mint a `REFUND` batch at the allocation's unit cost with a seed-derived id, so a
retry converges instead of minting twins. Five row-level goldens pin the COGS
effects:

| Test | Asserted row effect |
|---|---|
| restore onto the original batch | qty 2→3, **unit_cost stays 700** even though the caller passed 999, version 3→4, envelope carries version 4 |
| shadow marker | phantom row stays 0; REFUND batch carries the **allocation's** 700, not the marker's 10 |
| tombstoned batch | row is not resurrected; REFUND batch minted instead |
| same seed twice | one batch, one envelope |
| envelope write fails | the whole restock rolls back (qty unchanged) |

**Repair-side lanes** (`repair_lane.rs`, 2 tests): `start_time_log` /
`close_open_time_logs` (a second close reports 0 and cannot rewrite the first end
time) and `open_warranty_claim` / `close_warranty_claim` (one claim per redo, close
is a claim on `status='open'` so the parts basis cannot be absorbed twice).

**Measured (both modes):**

| Spec | Normal | Flag |
|---|---|---|
| `31-ref-refunds-part2` | 15/15, **0** | 15/15, **0** (was 2) |
| `32-ref-refunds-part3` | 15/15, **0** | 15/15, **0** |
| `84-rep-repair` | 9/24, **0** | 9/24, **0** (was 16) |

`84` is 9/24 in **both** modes, so its failures are not flag-induced.

**Two process notes.** (1) A generator script failed on backticks inside a JS
template after the handler list had already been edited, producing a binary that
referenced commands that did not exist — caught by `cargo test`, fixed by moving the
lanes into their own module. (2) A line-range splice deleted the read function
`listWarrantyClaims`; `tsc` caught the now-unused mapper and it was restored. Reads
stay renderer-side by design, so a delete like that is a functional loss, not a
boundary win.

**Gates:** money 65/0 · zero-tax 23/0 · cash-terms 32/0 · tsc 0 · lint 0 · selftest OK ·
reconcile 687 · cargo 549/549 · registry 116 · sql-boundary **303** (from 306) ·
drift OK · secrets/licences clean.

## 43-spec flag sweep completes: 3 refusals (2026-11-05, E-0211)

For the first time the non-scale suite **finished** under
`POS_SQL_QUERY_ONLY=1` (the three earlier attempts died at the 10M fixture):

```
duration 6013.6s   passing 271   failing 94   skipped 0   cases 335
SWEEP43 refusals=3
```

Down from 11 in the previous 43-spec run. The three are one coherent surface —
**product deletion**:

| # | Statement (verbatim prefix) | Writer |
|---|---|---|
| 1 | `UPDATE products SET deleted=1, version=version+1, updated_at=$1, sync_status='pending' WHERE id=$2` | `sqlPluginAdapter.ts:4116` (`syncProductDelete`) |
| 2 | `INSERT INTO sync_outbox (…) VALUES ($1,'product',$2,'DELETE',…)` | `sqlPluginAdapter.ts:4121` (same lane's tombstone envelope) |
| 3 | `UPDATE stock_batches SET deleted = 1, version = version + 1, updated_at = $1, sync_status = 'pending' WHERE product_id = $2 AND deleted = 0` | `createCatalogSlice.ts:231` (batch tombstone on product delete) |

So the remaining renderer writes on this suite are exactly one lane:
**delete a product** → tombstone the product, tombstone its live batches, enqueue the
product DELETE and per-batch UPSERT envelopes, and record the `product_deleted`
shadow event — all of which belong in one native transaction
(`delete_product`), the same shape as the other lanes.

The 94 failing cases are the suite's normal baseline set (335 cases here; the
committed baseline records hundreds of FAIL/N/A rows); the metric this run exists to
prove is the refusal count, which is now 3.

**Note on run cost:** the suite takes ~100 minutes with the raised mocha timeout on
this box, and the 10M-fixture specs still cannot share a process (documented in
E-0208: 10M boot 2 141 ms vs 254 s host seed).

## Product delete is native (2026-11-05, E-0212)

The three refusals left by the 43-spec sweep were one lane: deleting a product. It is
now `delete_product` (`src-tauri/src/delete_lane.rs`, 5 tests), one transaction:

1. read the product (key, version) **before** the tombstone;
2. tombstone it with `version + 1` (H18b: the pull guard is
   `excluded.version >= row`, so a stale same-version echo must lose);
3. enqueue the product `DELETE` with the **full snapshot** at the bumped clock;
4. tombstone every live `stock_batches` row of the product, then enqueue one
   UPSERT per batch at its committed version (`sb-<batch>-tombstone`, so a retry
   converges);
5. record the `product_deleted` shadow event after the commit (best-effort,
   exactly like the renderer did).

The `createCatalogSlice` batch block now calls the same command instead of doing its
own UPDATE + per-batch envelopes.

**Device probe (real app, invoke → host read-back):**

```
first  : OK {"productChanged":true,"productVersion":5,"batchesTombstoned":2,"idempotencyKey":"pk-DEL-P"}
second : OK {"productChanged":true,"productVersion":6,"batchesTombstoned":0,"idempotencyKey":"pk-DEL-P"}
product: deleted=1 version=5
batches: DEL-B1 deleted=1 v3 · DEL-B2 deleted=1 v6
envelopes: product/pk-DEL-P/DELETE · sb-DEL-B1-tombstone/UPSERT · sb-DEL-B2-tombstone/UPSERT
envCount 3 -> envCountAfter 3   (a second delete converges, it does not multiply)
```

**Gates:** money 65/0 · zero-tax 23/0 · cash-terms 32/0 · tsc 0 · lint 0 · selftest OK ·
reconcile 687 · cargo **554**/554 · registry **117** · sql-boundary **301** (from 303) ·
drift OK · secrets/licences clean.

## 43-spec flag sweep: ZERO refusals (2026-11-05, E-0213)

The non-scale suite, re-run after the `delete_product` lane:

```
duration 5978.0s   passing 250   failing 105   skipped 0   cases 325
SWEEP43 refusals=0
```

**Zero refused renderer writes.** Progression on this suite: 30 → 11 → 3 → **0**
(the 30 was the pre-lane run, 11 after the first batch of lanes, 3 after the
refund/repair/kredy set, 0 after `delete_product`).

Honest caveats about this run, because they matter for the tag:

* **The suite is still RED overall** — 105 failing cases. Those are the baseline's
  own FAIL/N/A set plus the specs that die on this box; this run proves the
  *boundary* metric, not a green suite.
* **Case count moved** (325 here vs 335 in the previous run, 105 vs 94 failures):
  the app session was killed by the 300 s renderer watchdog twice mid-run
  (`Timed out receiving message from renderer` at 17:37Z), so a few specs lost
  cases to teardown. That variance is environment-driven, not boundary-driven, but
  it means a *case-for-case* comparison across runs is not apples-to-apples.
* The three 10M-fixture specs remain excluded by name (measured: 10M boot 2 141 ms
  vs 254 s host seed, E-0208).

## FIFO reconcile is native (2026-11-05, E-0214)

The last renderer money algorithm. `reconcile_shadow_batches`
(`src-tauri/src/fifo_reconcile_lane.rs`, 5 goldens) mirrors
`reconcileShadowBatches` statement-for-statement:

| Step | Rule preserved |
|---|---|
| coverage pre-check | a shadow is only touched when live batches **fully** cover it; a partial cover leaves the marker open and the batches untouched |
| guarded depletion | `quantity_remaining >= want AND deleted = 0`, oldest-first (`received_at, batch_id`), one envelope per depletion |
| cost basis | `newUnit = round((oldUnit*qty − shadowUnit*shadowQty + takenCost) / qty)` |
| line | `line_profit = (charged − newUnit)*qty − discount` (sign flips for a return), `fifo_allocations` swap, envelope |
| order | `cost_total += (newUnit − oldUnit)*qty`, `profit = total − cost`, margin one decimal, envelope |
| marker | `deleted = 1, shadow_resolved = 1`, version bumped, `sb-<id>-resolved` envelope |
| ledger | allocation rows swapped to the real batches, then `ledger_cogs_total = Σ(qty*unit_cost)` materialised |

**Row-level goldens:**

| Test | Asserted rows |
|---|---|
| phantom replaced | line `unit_cost_at_sale` 900→**700**, `line_profit` 300→**900**; order `cost_total` 2700→**2100**, profit **900**, margin **30.0**, `ledger_cogs_total` **2100**; batch 3→**0** (v2); marker resolved+tombstoned (v2); allocation rows = [B1, 3, 700] |
| partial cover | 2 units cannot cover 3 → reconciled **0**, batch still **2**, marker open, `cost_total` untouched **2700** |
| second run | reconciled **0**, `cost_total` stays **2100** (no drift) |
| two batches | takes B1×1 @600 then B2×2 @800, `newUnit` **733** (`2200/3`), `cost_total = 2700 + (733−900)*3` |
| failing envelope | whole reconcile rolls back (cost 2700, marker open) |

**One parity quirk, preserved deliberately and pinned:** the materialisation step
sets `ledger_cogs_total` and the payload's `version` but not the row's `version`
column, so the order row keeps the reconcile's bump (4) while the payload says 5 —
exactly what the renderer did.

**Measured:** `10-mny-money` 14/14 and `30-ref-refunds` 12/12, **0 refusals in both
modes** (the reconcile runs on the receipt/checkout path, so this is the regression
check for the change).

**Gates:** money 65/0 · zero-tax 23/0 · cash-terms 32/0 · tsc 0 · lint 0 · selftest OK ·
reconcile 687 · cargo **559**/559 · registry **118** · sql-boundary **301** · drift OK ·
secrets/licences clean.

## Latency at n=200 on the current tree (2026-11-05, E-0215)

Re-measured on `ce6afb1` (after ~25 lanes, including the FIFO reconcile), same
machine, warm-up inside the probe:

| Mode | p50 | p95 | min | max |
|---|---|---|---|---|
| normal | 1092 ms | 1124 ms | 1042 ms | 1545 ms |
| `POS_SQL_QUERY_ONLY=1` | 1092 ms | **1125 ms** | 1047 ms | 1523 ms |

p95 regression **+0.09 %**, against a budget of ≤ 10 %. The earlier table
(1097/1132 vs 1096/1133 at `41caeea`) is superseded; the numbers barely moved across
~25 lane migrations, which is the expected shape — the lanes replace a handful of
renderer statements per operation with one native transaction.

## Next, in order

1. Re-run the 43-spec flag sweep on `ce6afb1` (the zero-refusal run was on `0a80b92`;
   the FIFO lane landed after it). ~100 minutes.
2. Clean-worktree gate battery on the tagged commit; tag.

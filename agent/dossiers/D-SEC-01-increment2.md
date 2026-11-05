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

## Next, in order

1. `record_shadow_event` native lane (event_log insert + projection switch) — the
   last structural piece, because the product path calls it.
2. Route `syncProductUpsert` to the existing `upsert_product` command.
3. `purchase_orders` lane; then the 48-spec sweep; then FIFO; clean floor; tag.

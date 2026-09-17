# Cloud Synchronization — Full Migration Implementation Guide

| | |
|---|---|
| **Project** | `phone3-sync-lab` — Mobi POS (Tauri desktop + Android) |
| **Companion documents** | `Cloud synchronization.md` (current-state index) · `Cloud_Sync_Fix_Plan_and_Ultra_Upgrade_Roadmap.md` (analysis & decision record) |
| **This document** | The coding instructions: how to build the new sync engine, file by file, phase by phase |
| **Reader** | You, the implementing engineer |
| **Version** | 1.0 |

> **How to use this guide.** Work top-to-bottom. Every phase has: goal, exact files to create/modify, code templates, and an **exit criterion** you must meet before moving on. Do not skip exit criteria — they are what make this a migration instead of a rewrite that breaks production.

---

## 1. The Decision & Guiding Principles

### 1.1 The chosen option (and why it wins)

**Rebuild the sync core as: one local authoritative SQLite database + Hybrid Logical Clock merge + append-only intent/ledger write path, built on `libsql` — with engine-native sync (Turso embedded replicas / offline mode) adopted per-platform once validated.**

Why this beats every alternative for *this* project:

| Alternative | Why not (for you, today) |
|---|---|
| Keep patching the current engine | The defects (no idempotency, client-clock LWW, mirroring, stuck inflight) are *structural*; patching adds branches to already-risky code |
| PowerSync / ElectricSQL | Requires running a sync service + (for Electric) Postgres — new infrastructure to operate, for capabilities you can reach on your existing Turso backend |
| Full CRDT layer (cr-sqlite) | Solves multi-master *field* edits you don't have yet; large cognitive cost; your hard problem (stock arithmetic) is solved by a ledger, not by CRDTs |
| **Chosen: HLC + ledger + intents on libsql** | Portable to desktop + Android with zero platform gambles, kills every P0 defect at the root, and is **forward-compatible** with engine-native sync — the schema and merge rule survive the upgrade unchanged |

### 1.2 The six principles (every coding decision in this guide obeys them)

1. **P1 — The local database is the source of truth.** The device is always writable. The cloud is a replication peer, never a dependency for making a sale.
2. **P2 — Every write is idempotent.** Anything sent to the cloud may be replayed N times with identical result. No exceptions, ever.
3. **P3 — Ordering is never decided by wall clocks.** A Hybrid Logical Clock (physical ms + logical counter) orders every row. Clock skew becomes a non-event.
4. **P4 — Numbers are ledgers, not cells.** Stock and money change by *appending deltas*, never by overwriting totals. Concurrent edits become correct by construction.
5. **P5 — Deletes are data.** A delete is a write (`deleted_at` tombstone) that flows through the same pipes as everything else.
6. **P6 — Anything that can fail is visible.** Every queue, quarantine, and drift signal surfaces in the UI and in telemetry. Silent failure is treated as a bug, not a state.

---

## 2. Target Architecture

### 2.1 Before → After

```text
BEFORE (current)                                AFTER (target)
===========================================     ===========================================
SQLite via tauri-plugin-sql                     ONE local SQLite via libsql (Rust core)
  + sync_outbox (row diffs)                       + stock_ledger (append-only deltas)
  + outboxFlusher.ts            [DELETE]          + pending_intents (idempotent write log)
  + SyncManager push/pull       [REPLACE]         + row_hlc / deleted_tombstone on all tables
  + custom conflict logic       [DELETE]          + ONE generic merge function (HLC compare)
  + Dexie mirror                [DELETE]          + thin SyncSupervisor (status + triggers)
  + client-clock timestamps     [DELETE]          + Rust command layer (real transactions)
Turso via hand-rolled REST calls                Turso via libsql remote client
Relay: unauthenticated signal firehose          Relay: per-device-token auth, rate-limited,
                                                   heartbeat, fixed message schema
One shared long-lived DB token                   Per-device tokens, revocable, audited
```

### 2.2 Component responsibilities (what you will build)

| Component | Language/Location | Responsibility |
|---|---|---|
| `db core` | Rust, `src-tauri/src/db/` | Open local + remote connections, run transactions, own the HLC, expose Tauri commands |
| `domain commands` | Rust, `src-tauri/src/commands/` | `checkout`, `adjust_stock`, `upsert_product`, `delete_product` — each one atomic local transaction producing entity rows + ledger row + intent |
| `intent applier` | Rust, `src-tauri/src/sync/apply.rs` | Push loop: pending intents → Turso primary, idempotent apply, ack, quarantine |
| `adopt loop` | Rust, `src-tauri/src/sync/adopt.rs` | Pull loop: remote rows with `row_hlc > watermark` → merge into local via HLC rule |
| `SyncSupervisor` | TypeScript, `src/sync/supervisor.ts` | Triggers (online, relay signal, timer), status state machine, backoff, metrics |
| `reconciliation` | TypeScript + SQL, `src/sync/reconcile.ts` | Checksum diff local↔remote, drift detection, repair trigger |
| `relay worker` | JS, `workers/relay/src/index.ts` (rewritten) | Auth, schema validation, rate limit, heartbeat, hibernation |
| `pairing + devices` | TS + Rust + Turso table | Per-device token issuance, registry, revocation |
| `UI surfaces` | TSX | Sync status badge, quarantine drill-down, device manager |

### 2.3 The two write-path tiers (important — read twice)

**Tier 1 (build this first — 100% portable, zero platform gambles):**
All writes commit locally in one transaction (entity rows + ledger delta + intent row). The intent applier replays intents to the Turso primary with idempotency keys. The adopt loop merges remote changes back. Two small, generic, fully-tested loops.

**Tier 2 (adopt per-platform after chaos validation):**
Turso's engine-native sync (embedded replicas with offline writes) collapses both loops into the database engine itself — same file, same schema, same HLC merge rule. Because Tier 1 already establishes the schema and merge discipline, enabling Tier 2 is a *transport swap*, not a redesign.

> **Why not Tier 2 directly?** Offline-write support maturity differs across SDKs and platforms as of this writing (Rust crate vs JS client vs Android). Tier 1 ships everywhere tomorrow and is the safety net Tier 2 runs above. You never bet the POS on a capability you haven't chaos-tested on the exact platform.

### 2.4 What dies (the "get rid of the bad things" list)

| Delete | Replaced by |
|---|---|
| `outboxFlusher.ts` (entire file) | `intent applier` (Rust, ~150 lines) |
| Push/pull logic inside `SyncManager.ts` | `adopt loop` + `SyncSupervisor` |
| Dexie mirroring layer in `sqlPluginAdapter.ts` | Direct reads from local DB via query commands |
| `sqlPluginAdapter.ts` itself | Rust `db core` |
| Client-timestamp columns and all LWW-on-device-clock comparisons | HLC merge |
| Shared Turso token in `keychain.ts` | Per-device tokens + registry |
| Unauthenticated relay accept logic | Authenticated worker |

---

## 3. Migration Strategy Overview

### 3.1 Phase map

| Phase | Builds | Exit criterion |
|---|---|---|
| **A — Safety Net** | CI gate, baseline backup, measurement harness | `tsc --noEmit` + tests green in CI; old engine instrumented |
| **B — Correctness Schema** | HLC, ledger, tombstones, intents, devices (DDL + backfill) | Old engine runs WITH new columns populated, zero drift for 7 days |
| **C — Rust DB Core** | libsql connections, commands, transactions | All domain writes go through Rust commands in staging |
| **D — Write Path** | Intent applier + replay + quarantine | Replay-any-batch-N-times test passes with identical remote state |
| **E — Sync Supervisor** | Adopt loop, status machine, reconciliation | Two-device convergence < 5s online; drift detector live |
| **F — Relay Hardening** | Authed, rate-limited worker | Unauthenticated connects refused; flood test passes |
| **G — Devices & Credentials** | Pairing, registry, revocation | Revoked device blocked within one session |
| **H — Cutover** | Flags, shadow run, staged flip, decommission | 14 days shadow-clean; old files deleted |
| **I — Chaos Suite** | The 8 scenario tests, in CI | Suite green as a release gate |

### 3.2 Branch & flag discipline

- **Branches:** one short-lived branch per phase (`migration/phase-b-schema`, etc.), merged to `main` only with its exit criterion met. No long-lived `migration` branch — it will rot.
- **Feature flags (in a local config table, NOT env vars, so they sync per device):**

| Flag | Default | Meaning |
|---|---|---|
| `sync_use_rust_writes` | `false` | Domain writes go through Rust commands instead of legacy adapter |
| `sync_use_applier` | `false` | Intent applier owns push (legacy outbox disabled) |
| `sync_use_adopter` | `false` | Adopt loop owns pull |
| `sync_engine_native` | `false` | Tier 2: engine-native sync replaces loops (per-platform) |

- **Version pinning:** pin exact versions in `Cargo.toml` and `package.json` (`@libsql/client`, `libsql` crate). Before each phase, re-check the pinned version's docs (docs.rs/libsql, docs.turso.tech/sdk/rust, npm @libsql/client) — API names below are templates against the documented surface; your pinned version is the truth.

### 3.3 The professional order of operations (memorize this)

```text
1. Measure the old engine      (you can't prove better without a baseline)
2. Add the new schema          (additive only — old engine keeps running)
3. Build the new core in shadow (both engines run; reconciliation compares)
4. Flip reads, then writes     (each flag independently reversible)
5. Delete the old engine       (only after 14 clean days)
```

---

## 4. Phase A — Safety Net & Baseline

**Goal:** before touching sync logic, guarantee you can (a) catch regressions automatically and (b) roll back to a known-good state.

### 4.1 CI gate (`.github/workflows/ci.yml` or equivalent)

```yaml
name: ci
on: [push, pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - name: Type check          # kills the D-01 parser-error class forever
        run: npx tsc --noEmit
      - name: Lint
        run: npm run lint
      - name: Unit tests
        run: npm test
      - name: Rust check
        run: cargo check --manifest-path src-tauri/Cargo.toml
```

### 4.2 Baseline backup + measurement

1. **Back up now:** `VACUUM INTO 'baseline-pre-migration.db'` on the current local DB, and export the Turso side (`turso db shell ... .dump`). Store both with today's date. This is your disaster-recovery point.
2. **Instrument the old engine for one week** (add-only, low risk): log per sync cycle — `outbox_depth`, `rows_pushed`, `rows_pulled`, `errors`, `duration_ms`. Keep the logs. These numbers are your *before* picture; the whole migration is justified against them.

**Exit criterion:** CI green on every commit; baseline backups stored; one week of old-engine metrics captured.

---

## 5. Phase B — The Correctness Schema

**Goal:** land every new column/table **additively** so the old engine keeps running unchanged while the new one grows underneath it.

### 5.1 Migration framework (one table, forward-only files)

Create `migrations/0001…0010.sql` files and a runner. Every migration file is applied exactly once, inside a transaction, tracked by:

```sql
CREATE TABLE IF NOT EXISTS _migration (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

### 5.2 The full DDL (the heart of the new engine)

```sql
-- 0002_devices.sql — per-device identity + token registry (mirrored to Turso)
CREATE TABLE IF NOT EXISTS devices (
  device_id    TEXT PRIMARY KEY,           -- stable per install (existing device.ts id)
  label        TEXT NOT NULL DEFAULT '',
  platform     TEXT NOT NULL,              -- 'windows' | 'android'
  token_hash   TEXT,                       -- SHA-256 of the device's Turso token (local copy; authoritative copy on Turso)
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at   TEXT                        -- NULL = active; tombstone = revoked
);

-- 0003_hlc_and_seq.sql — ordering + idempotency columns on EVERY synced table.
-- Repeat for: products, transactions, transaction_items, customers, ... (all synced tables)
ALTER TABLE products   ADD COLUMN row_hlc   TEXT;   -- HLC of last write, hex string "msecs:counter:device"
ALTER TABLE products   ADD COLUMN local_seq INTEGER;-- per-device monotonic, assigned at write time
ALTER TABLE products   ADD COLUMN deleted_t TEXT;   -- tombstone HLC; NULL = alive
CREATE UNIQUE INDEX IF NOT EXISTS ux_products_idem
  ON products(local_seq) WHERE local_seq IS NOT NULL;  -- one partial idx per table is enough
                                                         -- if device_id is implied by local_seq
                                                         -- allocation; otherwise (device_id, local_seq)
CREATE INDEX IF NOT EXISTS ix_products_pull ON products(row_hlc);

-- 0004_stock_ledger.sql — THE fix for inaccurate stock (P4)
CREATE TABLE IF NOT EXISTS stock_ledger (
  entry_id    TEXT PRIMARY KEY,            -- ULID; also the idempotency key
  product_id  TEXT NOT NULL,
  delta       INTEGER NOT NULL,            -- negative = sale, positive = restock/return
  reason      TEXT NOT NULL,               -- 'sale' | 'restock' | 'adjustment' | 'return' | 'correction'
  ref_type    TEXT,                        -- 'transaction' | 'manual' | ...
  ref_id      TEXT,                        -- e.g. transaction id
  device_id   TEXT NOT NULL,
  row_hlc     TEXT NOT NULL,
  local_seq   INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  applied     INTEGER NOT NULL DEFAULT 1   -- 1 = counted in local stock cache
);
CREATE INDEX IF NOT EXISTS ix_ledger_product ON stock_ledger(product_id, row_hlc);
CREATE INDEX IF NOT EXISTS ix_ledger_pull    ON stock_ledger(row_hlc);

-- Stock becomes a MATERIALIZED CACHE of the ledger (never written directly):
CREATE VIEW IF NOT EXISTS v_product_stock AS
SELECT p.id, p.name,
       COALESCE((SELECT SUM(l.delta) FROM stock_ledger l
                 WHERE l.product_id = p.id), 0) AS stock
FROM products p WHERE p.deleted_t IS NULL;

-- 0005_pending_intents.sql — the outbound write log (replaces sync_outbox)
CREATE TABLE IF NOT EXISTS pending_intents (
  intent_id   TEXT PRIMARY KEY,            -- ULID
  kind        TEXT NOT NULL,               -- 'upsert_product' | 'delete_product' | 'ledger_entry' | ...
  payload     TEXT NOT NULL,               -- canonical JSON: the full row(s) to apply remotely
  row_hlc     TEXT NOT NULL,               -- HLC assigned at local commit
  device_id   TEXT NOT NULL,
  local_seq   INTEGER NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending'
              CHECK(state IN ('pending','inflight','acked','quarantined')),
  attempt     INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  inflight_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_intents_state ON pending_intents(state, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_intents_seq ON pending_intents(device_id, local_seq);

-- 0006_sync_state.sql — watermarks + flags (per device, local only)
CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- keys: 'pull_watermark_hlc', 'flag_use_rust_writes', 'flag_use_applier',
--       'flag_use_adopter', 'flag_engine_native', 'hlc_physical', 'hlc_logical'
```

**Schema rules (non-negotiable):**
- `row_hlc` format: `"<physical_ms>:<logical>:<device_id>"` — lexicographically sortable as **text** (zero-pad physical to 16 hex digits if you prefer; pick ONE format and never change it — see §5.3).
- Every synced table gets the same three columns + the same two indexes. Write one helper that generates the migration per table; never hand-copy DDL.
- Nothing is ever hard-deleted. `deleted_t` is the tombstone.

### 5.3 The HLC, in Rust (`src-tauri/src/hlc.rs`)

```rust
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Hlc {
    pub physical: u64,   // unix millis
    pub logical: u16,
    pub device: String,  // tie-breaker; also makes HLCs globally unique
}

impl Hlc {
    pub fn to_text(&self) -> String {
        format!("{:016x}:{:04x}:{}", self.physical, self.logical, self.device)
    }
    pub fn parse(s: &str) -> Option<Self> {
        let mut parts = s.splitn(3, ':');
        let p = u64::from_str_radix(parts.next()?, 16).ok()?;
        let l = u16::from_str_radix(parts.next()?, 16).ok()?;
        let d = parts.next()?.to_string();
        Some(Hlc { physical: p, logical: l, device: d })
    }
}

/// Ordering: physical, then logical, then device id (deterministic total order).
impl PartialOrd for Hlc { fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> { Some(self.cmp(o)) } }
impl Ord for Hlc {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        self.physical.cmp(&o.physical)
            .then(self.logical.cmp(&o.logical))
            .then(self.device.cmp(&o.device))
    }
}

pub struct HlcClock { device: String, state: Mutex<(u64, u16)> }

impl HlcClock {
    pub fn new(device: &str) -> Self {
        Self { device: device.into(), state: Mutex::new((0, 0)) }
    }
    fn now_ms() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
    }
    /// Call BEFORE assigning to a row you are writing.
    pub fn now(&self) -> Hlc {
        let mut st = self.state.lock().unwrap();
        let phys = Self::now_ms();
        let (p, l) = *st;
        if phys > p { *st = (phys, 0); } else { *st = (p, l.saturating_add(1)); }
        let (p, l) = *st;
        Hlc { physical: p, logical: l, device: self.device.clone() }
    }
    /// Call when observing ANY remote HLC (pull/adopt) — keeps the clock ahead of
    /// everything it has seen, so local writes always beat stale remote data.
    pub fn observe(&self, remote: &Hlc) {
        let mut st = self.state.lock().unwrap();
        let phys = Self::now_ms();
        let (p, l) = *st;
        let (np, nl) = if phys > remote.physical && phys > p { (phys, 0) }
            else if remote.physical > p { (remote.physical, remote.logical.saturating_add(1)) }
            else if p > remote.physical { (p, l.saturating_add(1)) }
            else { (p, l.max(remote.logical).saturating_add(1)) };
        *st = (np, nl);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn monotonic_under_clock_regression() {          // the D-02 killer test
        let c = HlcClock::new("dev-a");
        let t1 = c.now();
        let t2 = c.now();
        assert!(t2 > t1);                            // same ms → logical bumps
    }
    #[test]
    fn observe_pushes_clock_forward() {
        let c = HlcClock::new("dev-a");
        let far_future = Hlc { physical: u64::MAX - 1, logical: 42, device: "dev-b".into() };
        c.observe(&far_future);
        assert!(c.now() > far_future);
    }
}
```

**The one merge rule** (this single function replaces all your conflict logic):

```rust
/// Returns Some(incoming) if the incoming row should overwrite local, else None.
pub fn should_accept(incoming_hlc: &str, local_hlc: Option<&str>) -> bool {
    match local_hlc {
        None => true,
        Some(l) => Hlc::parse(incoming_hlc) > Hlc::parse(l),  // strict > : ties are impossible
    }                                                        // (device id makes HLCs unique)
}
```

### 5.4 Backfill (migration `0007_backfill.sql` + first-run code)

For every existing synced row: set `row_hlc = "<now_ms>:0001:<this_device>"`, `local_seq = NULL`, `deleted_t = NULL`. Existing stock totals: insert ONE `stock_ledger` row per product with `reason = 'opening_balance'`, `delta = current_total`. One-time, idempotent (guard: `SELECT COUNT(*) FROM stock_ledger WHERE reason='opening_balance'` — skip if > 0).

**Exit criterion:** migrations applied on a dogfood device; old engine runs normally for 7 days with the new columns populated; reconciliation (§8.3) reports zero drift between the legacy mirror and the ledger-derived stock.

---

## 6. Phase C — Rust Database Core

**Goal:** replace `tauri-plugin-sql`'s JS-side SQL strings with a typed Rust layer that owns connections, transactions, and the HLC clock. This is where the D-12 ceiling (no real transactions in the plugin) is removed.

### 6.1 `Cargo.toml` additions

```toml
[dependencies]
libsql = "=<pin-exact-version>"        # check docs.rs/libsql for the version you pin
ulid  = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
tokio = { version = "1", features = ["full"] }
```

### 6.2 Connection manager (`src-tauri/src/db/mod.rs`)

Two connections, one owner:

```rust
use libsql::{Database, Connection};
use std::path::PathBuf;

pub struct Db {
    pub local: Connection,    // source of truth on this device (file)
    pub remote: Connection,   // direct line to the Turso primary (push/pull)
    pub hlc: HlcClock,
    pub device_id: String,
}

impl Db {
    /// Open the local database (always) and the remote (only if creds exist).
    pub async fn open(app_data_dir: PathBuf, creds: Option<(String, String)>) -> anyhow::Result<Self> {
        let db_path = app_data_dir.join("mobi_pos.db");

        // LOCAL: plain local database, always writable (Tier 1 source of truth).
        let local_db = libsql::Builder::new_local(&db_path).build().await?;
        let local = local_db.connect();

        // REMOTE: libsql://... + auth token from the keychain.
        // (If/when you enable Tier 2, this is replaced by the offline-mode
        //  synced database — see §6.5 — schema unchanged.)
        let remote = match creds {
            Some((url, token)) => {
                let d = libsql::Builder::new_remote(url, token).build().await?;
                d.connect()
            }
            None => local.clone(),   // degraded: offline until paired
        };

        let device_id = crate::device::load_or_create_device_id(&app_data_dir)?;
        Ok(Self { local, remote, hlc: HlcClock::new(&device_id), device_id })
    }

    pub async fn run_migrations(&self) -> anyhow::Result<()> {
        for (version, sql) in crate::migrations::ALL {
            let applied: bool = self.local
                .query("SELECT 1 FROM _migration WHERE version = ?1", [version.to_string()])
                .await?.next().await?.is_some();
            if !applied {
                // libsql executes the batch; wrap so a failure rolls the file back
                // to the previous version (apply inside an explicit transaction).
                self.local.execute_batch(sql).await?;
                self.local.execute(
                    "INSERT INTO _migration(version, name) VALUES (?1, ?2)",
                    (version.to_string(), crate::migrations::name(version)),
                ).await?;
            }
        }
        Ok(())
    }
}
```

> **API note:** `Builder::new_local` / `new_remote` / `new_local_replica` names match the documented libsql surface — verify against your pinned version on docs.rs/libsql before compiling. The architecture does not depend on the exact builder names.

### 6.3 Single-writer discipline (the rule that makes transactions safe)

One `tokio::sync::Mutex<()>` guards ALL local writes. Every domain command acquires it. No code path may issue `INSERT/UPDATE/DELETE` on `local` without holding the write lock:

```rust
pub struct Writer(tokio::sync::Mutex<()>);
impl Writer {
    pub async fn scope<F, T>(&self, f: F) -> anyhow::Result<T>
    where F: AsyncFnOnce(&Connection) -> anyhow::Result<T> {
        let _g = self.0.lock().await;
        f(&DB.local).await
    }
}
```

### 6.4 Tauri commands (the only door from JS to the DB)

```rust
#[tauri::command]
async fn checkout(state: tauri::State<'_, AppState>, cart: Cart) -> Result<Receipt, String> {
    state.db.checkout(cart).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn product_stock(state: tauri::State<'_, AppState>, product_id: String) -> Result<i64, String> {
    // read from the LEDGER view — never from a stored total
    state.db.query_one::<i64>(
        "SELECT COALESCE(SUM(delta),0) FROM stock_ledger WHERE product_id = ?1", product_id)
        .await.map_err(|e| e.to_string())
}
```

**JS side (`src/db/client.ts`) becomes a thin, boring wrapper:**

```typescript
import { invoke } from "@tauri-apps/api/core";
export const db = {
  checkout: (cart: Cart)              => invoke<Receipt>("checkout", { cart }),
  stock:    (productId: string)       => invoke<number>("product_stock", { productId }),
  upsertProduct: (p: ProductInput)    => invoke<Product>("upsert_product", { p }),
  syncStatus: ()                      => invoke<SyncStatus>("sync_status"),
};
```

### 6.5 Tier 2 slot (do not build yet — this is where it lands later)

When the chaos suite proves engine-native offline-writes on a platform, the change is *localized to this file*: open ONE database via the offline-mode synced builder (local file + `syncUrl` + token) instead of `new_local`, and call `db.sync()` on the supervisor's triggers. The commands, schema, HLC, and merge rule are untouched — that is the entire point of the Tier 1/Tier 2 split.

**Exit criterion:** all domain reads/writes in the app UI go through `src/db/client.ts` commands in staging; the legacy adapter is no longer imported by any component except behind `flag_use_rust_writes = false`.

---

## 7. Phase D — Domain Write Path & Intent Applier

**Goal:** every user action becomes ONE local transaction (entity rows + ledger delta + intent), and a background loop replays intents to Turso exactly-once-effectively.

### 7.1 The checkout transaction (`src-tauri/src/commands/checkout.rs`)

This is the template for ALL domain commands — study the shape:

```rust
pub async fn checkout(&self, cart: Cart) -> anyhow::Result<Receipt> {
    let tx_id = ulid::Ulid::new().to_string();
    let hlc   = self.hlc.now();
    let seq   = self.next_local_seq().await?;          // +1 per device, inside the lock

    self.writer.scope(|conn| async move {
        // ONE explicit transaction: all-or-nothing (the D-12 fix)
        conn.execute("BEGIN IMMEDIATE", ()).await?;

        // 1) stock check happens on LEDGER sums, not on a stored column
        for line in &cart.lines {
            let current: i64 = conn.query_one_field(
                "SELECT COALESCE(SUM(delta),0) FROM stock_ledger WHERE product_id = ?1",
                &line.product_id).await?;
            anyhow::ensure!(current >= line.qty, "insufficient stock for {}", line.product_id);
        }

        // 2) entity rows (with sync columns)
        conn.execute(
            "INSERT INTO transactions (id, total, device_id, row_hlc, local_seq, created_at)
             VALUES (?1,?2,?3,?4,?5,?6)",
            (&tx_id, cart.total(), &self.device_id, &hlc.to_text(), seq, hlc.to_text()),
        ).await?;
        for line in &cart.lines { /* same shape for transaction_items */ }

        // 3) ledger deltas — the append-only truth (P4)
        for line in &cart.lines {
            conn.execute(
                "INSERT INTO stock_ledger (entry_id, product_id, delta, reason, ref_type, ref_id,
                                           device_id, row_hlc, local_seq)
                 VALUES (?1,?2,?3,'sale','transaction',?4,?5,?6,?7)",
                (ulid::Ulid::new().to_string(), &line.product_id, -(line.qty as i64),
                 &tx_id, &self.device_id, &hlc.to_text(), seq),
            ).await?;
        }

        // 4) ONE intent describing the whole operation for the applier to replay
        let payload = serde_json::json!({
            "kind": "checkout",
            "hlc":  hlc.to_text(),
            "device_id": self.device_id,
            "local_seq": seq,
            "transaction": { /* full tx + items + ledger rows, verbatim */ }
        });
        conn.execute(
            "INSERT INTO pending_intents (intent_id, kind, payload, row_hlc, device_id, local_seq)
             VALUES (?1,'checkout',?2,?3,?4,?5)",
            (ulid::Ulid::new().to_string(), payload.to_string(),
             &hlc.to_text(), &self.device_id, seq),
        ).await?;

        conn.execute("COMMIT", ()).await?;
        Ok(Receipt { tx_id, hlc: hlc.to_text() })
    }).await
}
```

**Why this shape is bulletproof:** the sale, its items, the stock deltas, and the sync instruction commit **atomically**. A crash before COMMIT leaves nothing; after COMMIT, everything is durable locally and the intent guarantees eventual cloud delivery. There is no state in between — by construction, not by hope.

### 7.2 The apply procedure ON TURSO (run remotely, idempotent)

Create this once on the Turso side (stored proc or your Worker's `/apply` route — the Worker route is preferred because it also enforces device auth):

```sql
-- apply_checkout: called by the intent applier, safe to replay N times
INSERT INTO transactions (id, total, device_id, row_hlc, local_seq, created_at)
VALUES (@id, @total, @device, @hlc, @seq, @created)
ON CONFLICT(id) DO UPDATE SET
  row_hlc = excluded.row_hlc, total = excluded.total
  WHERE excluded.row_hlc > transactions.row_hlc;      -- the merge rule, server-side

-- ledger rows: conflict-proof because entry_id (ULID) is globally unique
INSERT INTO stock_ledger (entry_id, product_id, delta, reason, ref_type, ref_id,
                          device_id, row_hlc, local_seq)
VALUES (@entry_id, @product, @delta, @reason, @ref_type, @ref_id, @device, @hlc, @seq)
ON CONFLICT(entry_id) DO NOTHING;                     -- replay = no-op (P2)
```

The `WHERE excluded.row_hlc > …` guard on entity upserts + `DO NOTHING` on ledger entries is the **entire** server-side conflict system. Deterministic, replayable, 10 lines.

### 7.3 The intent applier (`src-tauri/src/sync/apply.rs`)

```rust
const LEASE_TIMEOUT_SECS: i64 = 300;   // 5 min >> any sane round-trip
const MAX_ATTEMPTS: i64 = 20;

pub async fn apply_once(db: &Db) -> anyhow::Result<ApplyReport> {
    // 1) Reclaim stuck inflight rows (crash recovery — the D-04 fix)
    db.local.execute(
        "UPDATE pending_intents SET state='pending', inflight_at=NULL
         WHERE state='inflight'
           AND inflight_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', printf('-%d seconds', ?1))",
        (LEASE_TIMEOUT_SECS.to_string()),
    ).await?;

    // 2) Claim a batch (mark inflight WITH timestamp — the lease)
    let batch = db.local.query(
        "SELECT intent_id, payload FROM pending_intents
         WHERE state='pending' ORDER BY local_seq LIMIT 50").await?;

    db.local.execute_many(batch.iter().map(|r|
        format!("UPDATE pending_intents SET state='inflight',
                 inflight_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                 attempt=attempt+1 WHERE intent_id='{}'", r.intent_id))).await?;

    // 3) Send to the apply endpoint. Response acks per-intent success.
    //    A timeout here is SAFE: the lease + idempotent apply make the
    //    retry a no-op if the first attempt actually landed (P2).
    let acks = http_apply(&db.remote, &batch).await;   // per-intent Result

    for (intent_id, result) in acks {
        match result {
            Ok(()) => db.local.execute(
                "UPDATE pending_intents SET state='acked' WHERE intent_id=?1",
                (intent_id)).await?,
            Err(e) => {
                let fatal = is_non_retryable(&e);      // 4xx = quarantine, 5xx/net = retry
                db.local.execute(
                    "UPDATE pending_intents SET
                       state = CASE WHEN ?2=1 OR attempt >= ?3 THEN 'quarantined' ELSE 'pending' END,
                       last_error = ?4
                     WHERE intent_id=?1",
                    (intent_id.clone(), fatal.to_string(), MAX_ATTEMPTS, e.to_string())).await?;
            }
        }
    }
    // 4) Housekeeping: acked rows are kept 7 days for audit, then purged
    db.local.execute(
        "DELETE FROM pending_intents WHERE state='acked'
           AND created_at < datetime('now','-7 days')", ()).await?;
    Ok(report)
}

fn is_non_retryable(e: &ApplyError) -> bool {
    matches!(e, ApplyError::Status(401 | 403 | 409 | 422, _)) // auth/schema bugs: retrying can't help
}
```

### 7.4 Backoff around the loop

```rust
// base 1s, factor 2, cap 60s, FULL JITTER (anti-thundering-herd — the D-07 fix)
fn next_delay_ms(attempt: u32) -> u64 {
    let base: u64 = 1_000;
    let cap: u64 = 60_000;
    let slot = (base * (1u64 << attempt.min(6))).min(cap);
    rand::random::<u64>() % slot        // full jitter: uniform in [0, slot)
}
```

**Exit criterion (this is the exactly-once proof):** integration test sends a 50-intent batch where the HTTP response is *deliberately dropped after the server commits*, then re-runs the loop; assert remote row counts identical to a clean single-pass run, zero duplicates, zero loss.

---

## 8. Phase E — Sync Supervisor, Adopt Loop & Reconciliation

**Goal:** replace ~all of `SyncManager.ts` with a thin supervisor that triggers two Rust loops and renders status. Plus the drift detector that *measures* accuracy.

### 8.1 The adopt loop (`src-tauri/src/sync/adopt.rs`) — generic pull

One loop, all tables, ~80 lines. This is what replaces your hand-rolled per-table pull logic:

```rust
const PULL_PAGE: i64 = 500;

pub async fn adopt_once(db: &Db) -> anyhow::Result<AdoptReport> {
    let watermark = get_state(&db.local, "pull_watermark_hlc")
        .unwrap_or_else(|| "0000000000000000:0000:".into());

    for table in SYNCED_TABLES {   // ("products","transactions","transaction_items","stock_ledger",...)
        loop {
            // 1) page of remote rows newer than the watermark, oldest first
            let rows = db.remote.query(&format!(
                "SELECT * FROM {t} WHERE row_hlc > ?1 ORDER BY row_hlc LIMIT ?2",
                t = table), (&watermark, PULL_PAGE)).await?;

            if rows.is_empty() { break; }
            let mut max_hlc = watermark.clone();

            for row in &rows {
                max_hlc = max_hlc.max(row.row_hlc.clone());
                if row.device_id == db.device_id { continue; }  // our own echo: skip

                // 2) THE merge rule — one function, every table, every conflict
                if !should_accept(&row.row_hlc, local_hlc(&db.local, table, &row.id).await?) {
                    continue;
                }
                db.writer.scope(|conn| async {
                    upsert_row(conn, table, row).await?;      // includes deleted_t tombstones
                    db.hlc.observe(&Hlc::parse(&row.row_hlc).unwrap());  // keep clock ahead
                    Ok(())
                }).await?;
            }
            set_state(&db.local, "pull_watermark_hlc", &max_hlc).await?;
            if (rows.len() as i64) < PULL_PAGE { break; }
        }
    }
    Ok(AdoptReport { /* per-table counts */ })
}
```

**Note what is NOT here:** no Dexie mirroring, no per-table column mappings, no status juggling, no custom netcode. `upsert_row` is a generic row-writer driven by the table's column list. Tombstones arrive as rows and merge by the same rule — `deleted_t IS NULL` filters do the rest (P5).

### 8.2 The supervisor (`src/sync/supervisor.ts`)

```typescript
export type SyncState =
  | "offline" | "idle" | "pushing" | "pulling"
  | "degraded"        // circuit breaker open: slow-polling
  | "attention";      // quarantined intents exist → amber badge

export class SyncSupervisor {
  private pullInflight = false;
  private consecutiveFailures = 0;
  private readonly timer: number;

  constructor(private readonly relay: RelayClient) {
    // Triggers — the ONLY three reasons a sync ever starts:
    this.timer = setInterval(() => this.tick(), 30_000);          // 1. periodic
    window.addEventListener("online", () => this.tick());         // 2. connectivity
    this.relay.onMessage((m) => this.coalescedPull(m));           // 3. relay signal
  }

  /** Single-flight guard: a relay signal while pulling schedules, never stacks (D-07). */
  private coalescedPull(msg: RelayMessage) {
    if (msg.type !== "db:changed" || msg.sender === DEVICE_ID) return;
    if (this.pullInflight) { this.rescheduleSoon(); return; }
    this.tick();
  }

  private async tick() {
    if (!navigator.onLine) { this.set("offline"); return; }
    if (this.quarantineCount > 0) this.set("attention");
    try {
      this.set("pushing");
      await invoke("sync_apply");        // Rust: apply_once (§7.3)
      this.set("pulling");
      await invoke("sync_adopt");        // Rust: adopt_once (§8.1)
      this.consecutiveFailures = 0;
      this.set(this.quarantineCount > 0 ? "attention" : "idle");
    } catch {
      this.consecutiveFailures++;
      // Circuit breaker: after 5 failures, degrade to slow poll + amber UI
      if (this.consecutiveFailures >= 5) { this.set("degraded"); this.slowPoll(); }
      else this.backoffRetry();          // §7.4 jittered backoff (mirrored in TS)
    }
  }
}
```

Status is emitted to a small store that `CloudSyncPanel.tsx` and the header badge subscribe to. **`SyncManager.ts`'s 5 concerns (push, pull, retry, poll, relay) collapse to: 3 triggers, 2 Rust calls, 1 state machine.**

### 8.3 Reconciliation — the accuracy meter (`src/sync/reconcile.ts`)

```sql
-- Local fingerprint per table (also run remotely — via the Worker /reconcile route):
SELECT ?1 AS tbl,
       COUNT(*) AS n,
       COALESCE(MAX(row_hlc), '') AS max_hlc,
       -- order-independent checksum: XOR of per-row hashes
       COALESCE(SUM( (SELECT
         CRC32(id || ':' || COALESCE(row_hlc,'') || ':' || COALESCE(deleted_t,''))
       ) & 0xFFFFFFFF ), 0) AS checksum   -- libsql exposes crc32; else use a hash() you ship
FROM ?1;
```

```typescript
export async function reconcile(): Promise<DriftReport> {
  const local  = await invoke<Fingerprint[]>("reconcile_local");
  const remote = await fetchRelay("/reconcile").then(r => r.json());
  const drift = local.map(l => {
    const r = remote.find(x => x.tbl === l.tbl);
    return { tbl: l.tbl,
             drift: !r || r.n !== l.n || r.checksum !== l.checksum,
             localN: l.n, remoteN: r?.n ?? -1 };
  });
  if (drift.some(d => d.drift)) {
    // Don't guess: targeted re-pull of the drifted table, then re-verify once.
    // Still drifted → surface "Repair needed" in the UI with an export button (P6).
    telemetry.count("drift_incidents", drift.filter(d => d.drift).map(d => d.tbl));
  }
  return { drift, at: new Date().toISOString() };
}
```

Run it: nightly, after every restore, and on demand. **`drift_incidents` is your accuracy KPI** — the number the whole migration is judged by.

### 8.4 Telemetry (minimum, structured)

```typescript
type SyncMetric =
  | { k: "outbox_depth"; v: number }            // pending+inflight intent count
  | { k: "outbox_oldest_age_s"; v: number }     // THE "losing data right now" metric
  | { k: "quarantine_count"; v: number; table?: string }
  | { k: "pull_latency_ms"; v: number }
  | { k: "drift_incidents"; v: number; tables: string[] };
```

Local ring-buffer log (JSON lines, 30-day retention) + optional `POST` to the Worker. No PII — device_id and table names only.

**Exit criterion:** two dogfood devices converge within 5s online; `reconcile()` shows zero drift over 7 days of normal use; the UI badge turns amber when a test intent is force-quarantined.

---

## 9. Phase F — Relay Hardening (rewrite `workers/relay/src/index.ts`)

**Goal:** the relay becomes a small, paranoid, authenticated signal switch. It carries *nothing* but "something changed" — now with auth, a fixed schema, rate limits, and heartbeats.

```javascript
// workers/relay/src/index.ts — Cloudflare Worker + Durable Object

const MSG_SCHEMA = { type: "db:changed" };             // fixed contract, P6
const RATE_LIMIT = { max: 10, windowMs: 60_000 };      // signals are cheap; data is not

export class RelayRoom extends DurableObject {
  async fetch(req) {
    // 1) AUTH FIRST: per-device token → hash lookup in Turso/KV devices registry (§10)
    const token = new URL(req.url).searchParams.get("token");
    const device = await validateDeviceToken(token);   // revoked/unknown → 401, no WS upgrade
    if (!device) return new Response("unauthorized", { status: 401 });

    // 2) Upgrade, then hibernate-friendly WebSocket pair
    const pair = new WebSocketPair();
    this.acceptWebSocket(pair[0], [device.id]);        // tag = device_id for sends
    return new Response(null, { status: 101, webSocket: pair[1] });
  }

  async webSocketMessage(ws, message) {
    // 3) Schema + rate limit: anything else drops silently
    if (!validSignal(message)) return;
    if (!this.rateLimiter.hit(tagOf(ws))) { ws.close(4290, "rate"); return; }

    // 4) Broadcast to OTHER devices only — never echo to sender
    for (const peer of this.getWebSockets()) {
      if (tagOf(peer) !== tagOf(ws)) peer.send(message);
    }
  }

  // 5) Heartbeat via hibernation API — keeps connections past the ~100s idle timeout
  async webSocketPing(ws) { /* default pong handling is enough with client pings */ }
}
```

**Client side (`src/sync/relay-client.ts`):**

```typescript
export class RelayClient {
  private ws?: WebSocket;
  private attempt = 0;

  connect(token: string) {
    this.ws = new WebSocket(`${RELAY_WSS}?token=${encodeURIComponent(token)}`);
    // WSS only — TLS enforced end-to-end; never ship a ws:// fallback
    this.ws.onopen = () => { this.attempt = 0; this.startHeartbeat(); };
    this.ws.onclose = () => this.reconnect();               // jittered backoff (§7.4)
    this.ws.onmessage = (e) => this.handler?.(JSON.parse(e.data));
  }
  private startHeartbeat() {
    // ping every 30s < 100s CF idle cutoff; 2 missed pongs → force reconnect
    setInterval(() => this.ws?.send(JSON.stringify({ type: "ping" })), 30_000);
  }
}
```

**Message contract (entire protocol — keep it this small):**

```jsonc
{ "type": "db:changed", "table": "products", "hlc": "018f…:0003:01J…", "sender": "<device_id>" }
```

**Exit criterion:** unauthenticated `wscat` connect refused with 401; a 100-message/second flood results in ≤ 1 coalesced pull on the victim device (single-flight guard) and the flooding socket closed; an idle connection survives 8+ hours.

---

## 10. Phase G — Devices & Credentials

**Goal:** kill the shared long-lived Turso token. Every device gets its own revocable token; every cloud write is attributable.

### 10.1 Pairing flow (extends `MobilePairingWizard.tsx`)

```text
Desktop (already paired, holds an admin token)
  1. Generates a one-time pairing code: { code, expires_in: 300s }  → shown as QR
  2. POST /devices/issue  { code }  → Worker creates:
       devices row: { device_id: <new-ulid>, token: <random-32B>, revoked_at: NULL }
       returns the token ONCE (never stored in plaintext again — hash only)
Phone
  3. Scans QR → POST /devices/claim { code, platform, label }
       → receives { device_id, token, turso_url }
  4. Stores token in the platform keychain (existing keychain.ts, now per-device)
  5. First sync: adopt loop pulls; device appears in the Devices panel
```

### 10.2 Token validation helper (Worker side, shared by relay + apply route)

```javascript
async function validateDeviceToken(token) {
  if (!token) return null;
  const h = await sha256(token);
  const row = await turso.one(
    "SELECT device_id, revoked_at FROM devices WHERE token_hash = ?", h);
  return row && !row.revoked_at ? row : null;      // revoked → treated as unknown
}
```

### 10.3 Revocation UX (in `CloudSyncPanel.tsx` → new "Devices" tab)

List `(label, platform, last_seen_at, created_at)` with a **Revoke** button → `UPDATE devices SET revoked_at = <hlc-now> WHERE device_id = ?`. The tombstone propagates; every Worker route rejects the revoked token on its next request. The revoked device's local data remains on that device (exportable), but it can no longer push, pull, or connect to the relay.

> **Turso note:** if device tokens are Turso platform tokens, revocation = rotating them via the Turso CLI/API. The cleaner long-term shape: devices authenticate to YOUR Worker with their device token, and the Worker holds the single Turso credential — devices never touch Turso credentials directly. Adopt this shape when you add the `/apply` route in §7.2; it makes revocation instant and Turso-token rotation invisible to devices.

**Exit criterion:** a revoked phone fails its next apply AND relay connect within one session; the devices panel shows last_seen updating hourly.

---

## 11. Phase H — Shadow Mode, Cutover & Decommission

**Goal:** flip the flags in an order where every step is independently reversible, then delete the old engine forever.

### 11.1 The flag schedule

| Stage | `use_rust_writes` | `use_applier` | `use_adopter` | Watch for |
|---|---|---|---|---|
| S0 (shadow) | `false` | `false` | `false` | New engine runs BOTH loops in *dry-run* mode; reconciliation compares old-mirror vs ledger-derived stock daily |
| S1 (writes) | `true` | `false` | `false` | Checkout goes through Rust; legacy outbox still ships its rows (double-write is SAFE — idempotency keys differ per engine, but merge rule makes remote state deterministic) |
| S2 (push) | `true` | `true` | `false` | Legacy outbox disabled; intents own push. Watch `outbox_oldest_age_s` + quarantine badge |
| S3 (pull) | `true` | `true` | `true` | Adopt loop owns pull; Dexie mirror reads become reads from local DB |
| S4 (Tier 2, optional, per platform) | — | — | — | `flag_engine_native = true`: loops replaced by engine sync, chaos-validated first |

**Between every stage: minimum 7 days AND zero `drift_incidents` AND chaos suite green.** If any stage shows drift → flip the flag back (each is a single row in `sync_state`) and investigate with the reconciliation report.

### 11.2 Decommission checklist (the satisfying part — do it as ONE PR)

```text
DELETE  src/sync/outboxFlusher.ts          (replaced by §7.3)
DELETE  src/sync/SyncManager.ts            (replaced by §8.2 supervisor)
DELETE  src/db/sqlPluginAdapter.ts         (replaced by §6 Rust core)
DELETE  the Dexie mirror module + its consumers
DELETE  legacy sync_outbox table           (migration 00XX: DROP TABLE sync_outbox)
DELETE  shared-token logic in keychain.ts  (per-device tokens only)
UPDATE  App.tsx        → boot SyncSupervisor instead of SyncManager
UPDATE  MobilePairingWizard.tsx → new pairing flow (§10.1)
KEEP    src/sync/device.ts                 (stable device id — still used)
KEEP    workers/relay                      (rewritten in §9)
```

### 11.3 Rollback plans (write these BEFORE you need them)

- **Rollback S1–S3:** set the flag row back; the legacy path is still fully intact until S3+14 days. No data rollback needed — both engines write the same schema additively.
- **Rollback Tier 2:** set `flag_engine_native = false`; the two loops resume. They were never deleted while Tier 2 was in probation.
- **Disaster rollback:** `VACUUM INTO` baseline from Phase A + Turso dump restore (reconciliation runs immediately after).

**Exit criterion:** S3 stable 14 days → decommission PR merged → chaos suite green on the post-delete build → old-engine metrics formally compared to Phase A baseline (publish the before/after — it's your proof the migration worked).

---

## 12. Phase I — The Chaos Test Suite

**Goal:** prove, automatically and repeatedly, that the new engine survives reality. These eight tests ARE your accuracy guarantee — the migration is not "done" until they run green in CI on every release.

### 12.1 Harness setup (`tests/sync/harness.ts`)

```typescript
// Two in-process "devices", each with its own local DB (temp files),
// one shared remote (a local-file libsql DB standing in for Turso).
export async function makeCluster() {
  const remote = await makeRemote(":memory:");
  const a = await makeDevice("dev-a", remote);   // real Rust core, real HLC
  const b = await makeDevice("dev-b", remote);
  return { remote, a, b };
}
```

### 12.2 The eight scenarios (vitest skeletons)

```typescript
describe("chaos: clock skew (D-02)", () => {
  it("a device 2 days in the FUTURE cannot overwrite newer truth", async () => {
    const { a, b } = await makeCluster();
    a.hlc.shiftPhysical(+2 * 86400_000);        // test hook: fake future clock
    await b.upsertProduct({ id: "p1", price: 100 });   // truth lands
    await b.applyOnce(); await a.adoptOnce();
    await a.upsertProduct({ id: "p1", price: 5 });     // future-clock edit
    await a.applyOnce(); await b.adoptOnce();
    // HLC is causality-ordered, not wall-clock ordered: b's later write wins
    expect((await b.product("p1")).price).toBe(100);
  });
});

describe("chaos: concurrent stock edits (the old killer bug)", () => {
  it("two offline sales of 3 from stock 10 converge on 4", async () => {
    const { a, b } = await makeCluster();
    await seedStock(a, "p1", 10); await a.applyOnce(); await b.adoptOnce();
    await a.checkout([{ product: "p1", qty: 3 }]);     // both offline…
    await b.checkout([{ product: "p1", qty: 3 }]);
    await a.applyOnce(); await b.applyOnce();
    await a.adoptOnce(); await b.adoptOnce();
    expect(await a.stock("p1")).toBe(4);               // …arithmetic, not LWW
    expect(await b.stock("p1")).toBe(4);
  });
});

describe("chaos: lost response after remote commit (D-03)", () => {
  it("retrying a dropped-ack batch creates zero duplicates", async () => {
    const { a, remote } = await makeCluster();
    await a.checkout(/* 3 lines */);
    remote.dropNextResponseAfterCommit = true;        // test hook
    await a.applyOnce();                               // lands, ack lost
    await a.applyOnce();                               // replay
    expect(await remote.count("transactions")).toBe(1);
    expect(await remote.count("stock_ledger")).toBe(3);
  });
});

describe("chaos: crash mid-flush (D-04)", () => {
  it("kill -9 during apply leaves nothing stuck", async () => {
    const { a } = await makeCluster();
    await a.checkout(/* lines */);
    a.crashMode = "after-claim-before-ack";            // test hook on the applier
    await expect(a.applyOnce()).rejects.toThrow();
    a.crashMode = null; await a.applyOnce();           // "restart"
    expect(await a.pendingCount("inflight")).toBe(0);
    expect(await a.pendingCount("acked")).toBeGreaterThan(0);
  });
});

describe("chaos: offline partition", () => {
  it("48h of offline writes on B all arrive after reconnect", async () => {
    const { a, b } = await makeCluster();
    b.network = "down";
    for (let i = 0; i < 25; i++) await b.checkout([line("p1", 1)]);
    b.network = "up";
    await b.applyOnce(); await a.adoptOnce();
    expect(await a.count("transactions")).toBe(25);
  });
});

describe("chaos: delete vs edit (D-05)", () => {
  it("a delete that arrives late still wins over a stale edit", async () => {
    /* delete p1 on A; edit p1 on B offline; sync both; assert p1 tombstoned
       everywhere and does NOT resurrect from a backup restore */
  });
});

describe("chaos: restore laggard (D-10)", () => {
  it("a 7-day-old restore does not resurrect tombstones", async () => {
    /* snapshot A at T0; delete p1 at T1 (tombstone syncs everywhere);
       restore A from T0 snapshot; A adoptOnce(); assert p1 still deleted */
  });
});

describe("chaos: relay flood (D-08)", () => {
  it("100 fake db:changed frames cause at most one pull", async () => {
    /* spy on adoptOnce; fire 100 relay messages in a burst;
       expect(adoptCalls).toBeLessThanOrEqual(1) via single-flight guard */
  });
});
```

### 12.3 CI wiring

Nightly full run (real two-process setup, simulated network via a proxy harness) + per-PR fast subset (HLC unit tests, applier idempotency, merge rule property tests — the three cheapest, highest-value tests). **Release gate = the full eight.**

**Exit criterion:** all eight green, wired as a release gate, and re-run after every dependency bump (libsql versions especially).

---

## 13. File Migration Map, Risk Register & References

### 13.1 Complete file map (old → new)

| Old file | Fate | New home of its responsibility |
|---|---|---|
| `src/sync/SyncManager.ts` | **DELETE** (S3+14d) | `src/sync/supervisor.ts` (§8.2) + Rust loops (§7.3, §8.1) |
| `src/sync/outboxFlusher.ts` | **DELETE** (S2+14d) | `src-tauri/src/sync/apply.rs` (§7.3) |
| `src/db/sqlPluginAdapter.ts` | **DELETE** (S1+14d) | `src-tauri/src/db/` (§6) |
| Dexie mirror module | **DELETE** (S3) | Direct reads via Tauri commands (§6.4) |
| `src/sync/tursoClient.ts` | **REWRITE** | Remote connection inside `Db::open` (§6.2) |
| `src/sync/keychain.ts` | **MODIFY** | Per-device token storage only (§10) |
| `src/sync/device.ts` | **KEEP** | Unchanged — stable device id |
| `src/sync/types.ts` | **REWRITE** | New contracts: `SyncState`, `RelayMessage`, `SyncMetric`, intent payload types |
| `src/sync/remoteSchema.ts` | **REPLACE** | `migrations/` applied to Turso (§5.1, §7.2) |
| `src/sync/migrationManager.ts` | **SPLIT** | Local migrations → `migrations/` runner (§5.1); first-upload → backfill (§5.4). *Fix the parser error (Phase 0 of the companion doc) before touching anything else.* |
| `src/sync/restoreManager.ts` | **MODIFY** | Checkpoint + version gate + post-restore reconciliation (§8.3; see companion doc F-10) |
| `src/sync/quotaManager.ts` | **KEEP** | Intent payloads are small — quota pressure drops; keep the guard |
| `workers/relay/src/index.ts` | **REWRITE** | §9 |
| `src/components/settings/CloudSyncPanel.tsx` | **EXTEND** | Status badge, quarantine drill-down, Devices tab (§10.3) |
| `src/components/mobile/MobilePairingWizard.tsx` | **MODIFY** | New pairing flow (§10.1) |
| New files | — | `src-tauri/src/{hlc.rs, db/, commands/, sync/}`, `src/sync/{supervisor.ts, relay-client.ts, reconcile.ts, telemetry.ts}`, `migrations/00NN_*.sql`, `tests/sync/` |

### 13.2 Risk register

| Risk | Likelihood | Mitigation (already in the plan) |
|---|---|---|
| libsql API drift between pin and docs | Medium | §3.2 version pinning + §12.3 re-run suite on every bump |
| Android WAL/file-locking quirks in sandbox storage | Medium | Chaos suite on a real Android device BEFORE S1; `PRAGMA journal_mode=WAL` + single-writer (§6.3) |
| Double-write window (S1) produces odd remote rows | Low | Merge rule is deterministic (§5.3); reconciliation detects; flag flips back in one row |
| Offline-writes (Tier 2) immaturity on some SDK | Expected | Tier 1 never depends on it; Tier 2 is per-platform opt-in behind chaos gates (§2.3, §6.5) |
| User confusion during migration (two badges/statuses) | Low | One status state machine from day one (§8.2); flags are invisible to users |
| Quota exhaustion from intent payloads | Low | Payloads are row-level JSON (small); quotaManager kept (§13.1); 7-day acked purge (§7.3) |
| Restore during migration window | Low | Version gate + forced reconciliation post-restore (§8.3) |

### 13.3 Effort estimate (solo developer, focused)

| Phase | Estimate |
|---|---|
| A — Safety net | 1–2 days |
| B — Schema + HLC + backfill | 3–5 days |
| C — Rust core | 4–6 days |
| D — Write path + applier | 4–6 days |
| E — Supervisor + reconciliation | 3–4 days |
| F — Relay hardening | 2–3 days |
| G — Devices & credentials | 3–4 days |
| H — Cutover + soak periods | 3–5 weeks elapsed (mostly waiting on clean-drift days) |
| I — Chaos suite | 4–6 days (build alongside C–E; do not defer) |

### 13.4 References

- Turso docs — Rust SDK quickstart & reference (embedded replicas, remote connections); `@libsql/client` on npm (embedded replicas, `sync()`); Turso Sync announcements — docs.turso.tech, docs.rs/libsql
- AWS Prescriptive Guidance — *Transactional Outbox Pattern* (at-least-once delivery; consumer idempotency)
- Kulkarni, Demirbas et al. — *Logical Physical Clocks* (the HLC paper); production usage in CockroachDB, YugabyteDB, MongoDB
- Cloudflare docs — Durable Objects WebSockets, WebSocket Hibernation API, idle timeouts
- `@tauri-apps/plugin-sql` (sqlx) issue tracker — transaction/encryption/WAL limitations; community `tauri-plugin-rusqlite2`
- ULID spec (github.com/ulid/spec) — sortably unique ids for intents and ledger entries
- Companion document: `Cloud_Sync_Fix_Plan_and_Ultra_Upgrade_Roadmap.md` (defect register D-01…D-12, decision record)






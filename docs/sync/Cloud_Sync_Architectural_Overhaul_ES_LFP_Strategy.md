# The Architectural Overhaul — Event-Sourced Local-First Platform

## The End-to-End Migration Strategy for Mobi POS

| | |
|---|---|
| **Project** | `phone3-sync-lab` — Mobi POS (Tauri desktop + **Android + iOS**, Turso, Cloudflare) |
| **Document set** | ① `Cloud_Sync_Fix_Plan_and_Ultra_Upgrade_Roadmap.md` (defect register D-01…D-12) · ② `Cloud_Sync_Full_Migration_Implementation_Guide.md` (Tier 1/2 plan) · ③ **this document** (the superior architecture that supersedes ②'​s engine design) |
| **Nature** | High-impact architectural overhaul — complete end-to-end migration strategy |
| **Version** | 2.0 |

> **v2.0 changelog** (responds to production telemetry: *36 MB of cloud consumed on day one*; and widened scope: the platform now ships on **Desktop, Android and iOS**):
> - **§13** — the platform verdict: the "SQLite → SQL" question answered, with a five-way decision matrix (direct client-server SQL, Turso embedded replicas, PowerSync, Electric 1.0, ES-LFP).
> - **§14** — forensics: exactly where the 36 MB/day went, and the 30-minute diagnostic that proves it on your database.
> - **§15–§16** — the **5 GB / 18-month budget** and the **wire-protocol bytes contract** (encoding, batching, HTTP+WS split, echo suppression, purge-on-ack, SyncBudgetGovernor).
> - **§17** — cross-platform engineering for Android + iOS (Rust core portability, lifecycle-driven sync, metered-network awareness, device rebuild).
> - **§18** — storage hygiene (auto_vacuum, VACUUM on Turso, cloud log archival to R2) and **row-read discipline** against Turso's usage metering.
> - **§19–§21** — monitoring, budget tests (B-01…B-05), the consolidated ultra-deep migration program (including the week-0.5 bleed-stop on the *current* engine), and the 5 GB survival proof.
> - **§8.4 corrected** — the v1.0 "quota impact ≈ neutral" claim was wrong *as a statement about your budget*: ES-LFP is a 10–40× reduction against the leaking engine, and v2.0 makes it enforced, not assumed.

---

## 1. Executive Summary — The Superior Approach

### 1.1 The one inversion that changes everything

Both your current system and the Tier 1/2 plan in document ② share one hidden assumption: **devices replicate state**. Rows are the sync unit, so every device must decide *which row version wins*, so you need conflict rules, merge logic, reconciliation, and drift repair — forever.

The superior approach deletes that assumption:

> **Stop replicating state. Replicate the log.**
> The app becomes an **event-sourced local-first platform (ES-LFP)**: every business action is an immutable event in a local append-only log; every table the UI reads is a disposable projection rebuilt from that log; "sync" collapses into *log replication* — appending events that commute, so there is nothing to conflict.

```text
CURRENT + TIER 1/2:                        ES-LFP (this document):
state is primary                           events are primary
  rows get pushed/pulled                     events get appended, locally & remotely
  conflicts must be resolved                 events commute — nothing to resolve
  tables are precious                        projections are disposable caches
  drift needs clever repair                  drift is impossible-by-ordering;
  sync engine = biggest risk asset           rebuild = replay the log
  audit trail = extra feature                audit trail = the data model itself
```

### 1.2 What you gain (and never give back)

1. **Correctness becomes structural.** Two devices selling from stock 10 isn't a "conflict to resolve" — it's two `StockSold` events, and the projection sums them. Convergence is arithmetic, not policy.
2. **Every device is recoverable by definition.** Corrupted projection? Delete it, replay the log. New phone? Replay the log. Seven-day-old restore? Replay forward. There is no repair code because *replay is the repair*.
3. **Total auditability for free.** Every stock change, price edit, and deletion is a permanent, attributable, timestamped (HLC-ordered) fact. For a POS, this is also your compliance and shrinkage-investigation story.
4. **Time travel.** "What did we believe at 14:32 last Tuesday?" is a query, not a forensics project.
5. **The sync engine shrinks ~10×.** No per-table push/pull, no column mappings, no conflict branches. The entire sync layer becomes: *append events to the cloud log; pull events you haven't seen; apply through the same reducers you already tested.*
6. **Reporting decouples.** Turso maintains its own read models from the same event stream — your reports stop touching the transactional path entirely.

### 1.3 The honest cost

ES-LFP is *more upfront discipline*, not more upfront code: reducers must be deterministic, events must be versioned, the log must be compacted. This document specifies all three. The payoff curve crosses Tier 1/2 at roughly the point where your chaos suite goes green — and then keeps climbing for the life of the product.

---

## 2. Why This Is Superior

### 2.1 Three-way capability comparison

| Capability | Current system | Tier 1/2 (doc ②) | **ES-LFP (this doc)** |
|---|---|---|---|
| Concurrent stock edits | Wrong (LWW overwrites) | Correct (ledger for stock only) | Correct for **every** entity (events commute) |
| Concurrent edits to same product, different fields | Nondeterministic winner | Row-level winner (one edit lost) | Both survive (reducer/HLC per field; cr-sqlite option) |
| Deletes | Don't propagate | Tombstone columns | Tombstone **events** — propagate, replay-safe |
| Duplicate cloud writes | Duplicates possible | Idempotency keys prevent | Event IDs make duplication a non-concept |
| Crash mid-sync | Rows stuck inflight | Lease + reclaim | Replay from watermark; nothing stuck |
| Device recovery | Full DB copy, fragile | Backup + reconcile | **Replay the log** (also validates integrity) |
| Drift repair | None | Checksum + targeted re-pull | Replay from any watermark (self-healing) |
| Audit trail | Partial, separate | Ledger for stock | **Every** mutation, every entity, forever |
| Answer "state at time T" | Impossible | Impossible | Projection replay to watermark |
| Sync code surface | ~Thousands of lines | ~600–800 lines | **~200 lines** (append + pull + apply) |
| Testability of business rules | UI-level integration | Command-level | **Reducer-level** (pure functions, instant) |

### 2.2 What gets *eliminated* (not fixed)

| Defect class (from doc ①) | Fate under ES-LFP |
|---|---|
| D-02 conflict resolution | **Eliminated** — events commute; reducers are deterministic |
| D-03 duplicate writes | **Eliminated** — `(event_id)` uniqueness; appends are idempotent by construction |
| D-04 stuck inflight | **Eliminated** — pull position is a watermark, not row states |
| D-05 delete propagation | **Eliminated** — deletes are events |
| D-06 two sources of truth (Dexie mirror) | **Eliminated** — projections are derived, disposable, rebuildable |
| D-11 silent quarantine | **Transformed** — unsynced events are visible log tail; age is a metric |
| D-01 parser error, D-07 storms, D-08 relay auth, D-09 tokens, D-10 restore safety | Carried over from docs ①② — unchanged, still required (§8, §9) |

### 2.3 Why not a commercial sync engine instead?

PowerSync / Electric / Zero remain excellent *state-replication* engines — they would still leave you owning conflict policy and would add infrastructure to operate. ES-LFP is strictly more powerful for a POS domain (audit + recovery + time travel) while using only components you already run: SQLite/libSQL, Turso, Cloudflare. cr-sqlite remains available as an *optional* merge accelerator (§6.4) — the architecture does not depend on it.

---

## 3. The Target Platform — Five Layers

```text
┌───────────────────────────────────────────────────────────────────────┐
│  UI (React) — screens are LIVE QUERIES over projections                │
│    useLiveQuery(sql, params) → rows that update themselves             │
├───────────────────────────────────────────────────────────────────────┤
│  L4  REACTIVE QUERY LAYER                                              │
│    query cache + invalidation on "db:committed" events (typed)         │
├───────────────────────────────────────────────────────────────────────┤
│  L1  TYPE-SAFE CONTRACT CORE (tauri-specta)                            │
│    Rust commands + event types  ──codegen──▶  TS types                 │
│    zero hand-written IPC types, zero drift between layers              │
├───────────────────────────────────────────────────────────────────────┤
│  L2  EVENT-SOURCED DOMAIN CORE (Rust)                                  │
│    commands → validate → append EVENT(S) → run REDUCERS                │
│    reducers update PROJECTIONS in the same transaction                 │
├───────────────────────────────────────────────────────────────────────┤
│  L3  STORAGE: event log (truth) + projections (cache)                  │
│    append-only, HLC-ordered, ULID-keyed · snapshots & compaction       │
│    optional cr-sqlite CRDT merges for multi-editor catalog fields      │
├───────────────────────────────────────────────────────────────────────┤
│  SYNC (the whole engine):                                              │
│    push = append local events to cloud log (idempotent)                │
│    pull = fetch events > watermark → run through THE SAME reducers     │
├───────────────────────────────────────────────────────────────────────┤
│  L5  CLOUD & EDGE                                                      │
│    Turso: canonical event log + reporting read models                  │
│    Worker: /append · /events · /reconcile · device tokens · telemetry  │
│    DO relay: authenticated "log appended" signals only                 │
└───────────────────────────────────────────────────────────────────────┘
```

### 3.1 Responsibility contract per layer

| Layer | Owns | Is forbidden from |
|---|---|---|
| UI | rendering, interaction | knowing when data changed, refreshing, syncing |
| L4 query layer | caching, invalidation, subscriptions | business logic, SQL beyond declared queries |
| L1 contract | types, command/event signatures | runtime logic |
| L2 domain core | validation, event creation, reducers, projections | network I/O (except via the sync module) |
| L3 storage | durability, ordering, compaction | deciding business outcomes |
| Sync | log transport, watermark, retry/backoff | interpreting events |
| L5 cloud/edge | canonical log, read models, auth, quotas | being required for a sale |

### 3.2 The day-to-day developer experience after the overhaul

```text
New feature = 3 artifacts, 0 sync code:
  1. event type(s)         (Rust enum variant, versioned)
  2. reducer(s)            (pure fn: (state, event) -> state)
  3. projection table(s)   (DDL + query in useLiveQuery)
Sync, offline, recovery, audit, conflicts: inherited automatically.
```

That asymmetry — features cost nothing in sync terms — is the compounding return of this architecture and the reason it is the end-state rather than another waypoint.

---

## 4. L1 — Type-Safe Contract Core

**Goal:** one source of truth for every type that crosses the Rust↔TS boundary. Hand-written interface duplication is where migrations rot; we delete the possibility.

### 4.1 Tooling: `tauri-specta` v2 (commands **and** events typed)

```toml
# src-tauri/Cargo.toml
[dependencies]
specta        = "=2.0.0-rc.20"        # pin; keep specta & tauri-specta versions in lockstep
tauri-specta  = { version = "=2.0.0-rc.21", features = ["derive", "typescript"] }
serde = { version = "1", features = ["derive"] }
```

### 4.2 The canonical types (`src-tauri/src/contract.rs`)

Every IPC type in the entire app lives here — and nowhere else:

```rust
use serde::{Deserialize, Serialize};
use specta::Type;

// ── Domain events (L2) ─────────────────────────────────────────────
#[derive(Serialize, Deserialize, Type, Clone, Debug)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum DomainEvent {
    ProductCreated   { id: String, name: String, price_cents: i64, sku: Option<String> },
    ProductRenamed   { id: String, new_name: String },
    PriceChanged     { id: String, old_cents: i64, new_cents: i64 },
    StockSold        { product_id: String, qty: i64, transaction_id: String },
    StockReceived    { product_id: String, qty: i64, supplier: Option<String> },
    StockAdjusted    { product_id: String, delta: i64, reason: String },
    ProductDeleted   { id: String },
    CheckoutCompleted {
        transaction_id: String,
        lines: Vec<CheckoutLine>,
        total_cents: i64,
        payment: PaymentInfo,
    },
    DevicePaired     { device_id: String, label: String, platform: String },
    DeviceRevoked    { device_id: String },
}

#[derive(Serialize, Deserialize, Type, Clone, Debug)]
pub struct CheckoutLine { pub product_id: String, pub qty: i64, pub unit_cents: i64 }

// ── Envelope: the ONLY thing that ever syncs ───────────────────────
#[derive(Serialize, Deserialize, Type, Clone, Debug)]
pub struct Envelope {
    pub event_id:   String,   // ULID — globally unique, sortably time-ordered
    pub aggregate:  String,   // "product:<id>" | "tx:<id>" | "device:<id>" ...
    pub hlc:        String,   // hybrid logical clock text (doc ② §5.3 — reused verbatim)
    pub device_id:  String,
    pub schema_v:   u16,      // event schema version (§10.1)
    pub event:      DomainEvent,
}

// ── Commit notification (L4 invalidation source) ───────────────────
#[derive(Serialize, Deserialize, Type, Clone, Debug)]
pub struct Committed { pub tables: Vec<String> }   // which projections changed

// ── Sync status (UI badge) ─────────────────────────────────────────
#[derive(Serialize, Deserialize, Type, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SyncPhase { Offline, Idle, Pushing, Pulling, Degraded, Attention }
```

### 4.3 Commands + codegen wiring (`src-tauri/src/lib.rs`)

```rust
use tauri_specta::{collect_commands, collect_events, Builder};

pub fn run() {
    let builder = Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::checkout,
            commands::upsert_product,
            commands::rename_product,
            commands::receive_stock,
            commands::adjust_stock,
            commands::delete_product,
            queries::product_list,
            queries::product_stock,
            queries::transaction_history,
            sync::push_now, sync::pull_now, sync::status,
            admin::replay_projection, admin::sync_diagnostics,
        ])
        .events(collect_events![Committed, SyncPhaseChanged]);

    #[cfg(debug_assertions)]
    builder.export(
        specta_typescript::Typescript::default(),
        "../src/bindings/bindings.ts",   // generated: types + typed emit/listen helpers
    );

    tauri::Builder::default()
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| { builder.mount_events(app.handle()); Ok(()) })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Rules of the contract core:**
- `src/bindings/bindings.ts` is **generated, committed, and never hand-edited**. A CI check regenerates and diffs — a mismatch fails the build (this is the permanent, structural cure for D-01-class rot).
- No `any`, no hand-written DTOs anywhere in `src/`. Lint rule: `no-restricted-imports` banning manual `invoke<...>` casts outside one sanctioned module.
- Adding a feature = adding an enum variant + command here; the type error cascade guides the rest.

---

## 5. L2 — Event-Sourced Domain Core (Rust)

**Goal:** the entire business behavior of the POS as pure, replayable functions. This is the layer that makes everything downstream trivial.

### 5.1 The event store (truth) — DDL

```sql
-- migration 0100_event_store.sql
CREATE TABLE IF NOT EXISTS event_log (
    event_id    TEXT PRIMARY KEY,          -- ULID; appends are idempotent BY KEY
    seq         INTEGER,                   -- local arrival order (per device; not global)
    aggregate   TEXT NOT NULL,             -- routing key for reducers
    hlc         TEXT NOT NULL,             -- global logical order (doc ② §5.3 format)
    device_id   TEXT NOT NULL,
    schema_v    INTEGER NOT NULL DEFAULT 1,
    event       TEXT NOT NULL,             -- JSON of DomainEvent (serde-tagged)
    ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    origin      TEXT NOT NULL DEFAULT 'local'   -- 'local' | 'remote:<device>'
);
CREATE INDEX IF NOT EXISTS ix_log_hlc      ON event_log(hlc);          -- pull cursor
CREATE INDEX IF NOT EXISTS ix_log_agg      ON event_log(aggregate, hlc);
CREATE INDEX IF NOT EXISTS ix_log_unsynced ON event_log(origin) WHERE origin = 'local';

-- Projection bookkeeping: where each projection has replayed to
CREATE TABLE IF NOT EXISTS projection_cursor (
    projection  TEXT PRIMARY KEY,          -- e.g. 'products', 'v_product_stock'
    last_hlc    TEXT NOT NULL
);

-- Sync watermark (per remote peer — here: the one Turso log)
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: 'pull_watermark_hlc', 'pushed_watermark_hlc'
```

**Why `event_id PRIMARY KEY` is the whole idempotency story:** any append — local replay, retry, re-pull after a lost response — hits the same key. `INSERT OR IGNORE`. Duplicates become structurally impossible across the *entire* system, not per-table (D-03 eliminated everywhere at once).

### 5.2 Projections (disposable caches) — DDL

```sql
-- migration 0101_core_projections.sql
-- These tables are REBUILDABLE AT ANY TIME from event_log. Never backed up,
-- never synced, never precious. UI reads ONLY these.
CREATE TABLE IF NOT EXISTS p_products (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL,
    sku TEXT, stock INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    row_hlc TEXT NOT NULL                  -- last event that touched this row
);
CREATE TABLE IF NOT EXISTS p_transactions (
    id TEXT PRIMARY KEY, total_cents INTEGER NOT NULL,
    ts TEXT NOT NULL, row_hlc TEXT NOT NULL, device_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS p_transaction_items (
    tx_id TEXT NOT NULL, product_id TEXT NOT NULL, qty INTEGER NOT NULL,
    unit_cents INTEGER NOT NULL, PRIMARY KEY (tx_id, product_id)
);
CREATE INDEX IF NOT EXISTS ix_p_stock ON p_products(deleted, stock);
```

### 5.3 The reducer registry (`src-tauri/src/domain/reducers.rs`)

A reducer is a **pure function from current projection state + event → new projection state**. No I/O, no clocks, no randomness. This is what makes replay equal to live and makes convergence provable:

```rust
pub enum Apply { Sql(&'static str, Vec<Value>), None }

pub fn reduce(e: &Envelope, tx: &Tx) -> anyhow::Result<()> {
    // Ordering guard: apply in HLC order within an aggregate; skip already-seen
    if tx.seen(&e.event_id) { return Ok(()); }                  // idempotency (again, free)

    match &e.event {
        DomainEvent::ProductCreated { id, name, price_cents, sku } => tx.exec(
            "INSERT INTO p_products (id, name, price_cents, sku, stock, row_hlc)
             VALUES (?1,?2,?3,?4,0,?5)
             ON CONFLICT(id) DO UPDATE SET name=?2, price_cents=?3, sku=?4, row_hlc=?5
                                       WHERE excluded.row_hlc > p_products.row_hlc",
            (id, name, price_cents, sku, &e.hlc)),

        DomainEvent::PriceChanged { id, new_cents, .. } => tx.exec(
            "UPDATE p_products SET price_cents=?2, row_hlc=?3
             WHERE id=?1 AND ?3 > row_hlc AND deleted=0",
            (id, new_cents, &e.hlc)),

        // THE pattern for numeric state: events accumulate; projection sums.
        DomainEvent::StockSold { product_id, qty, .. }
        | DomainEvent::StockReceived { product_id, qty, .. }
        | DomainEvent::StockAdjusted { product_id, qty, .. } => {
            let sign: i64 = match &e.event {                 // resolve per variant
                DomainEvent::StockSold { .. } => -qty,
                _ => *qty,
            };
            tx.exec(
                "UPDATE p_products SET stock = stock + ?2, row_hlc=?3
                 WHERE id=?1 AND deleted=0",
                (product_id, sign, &e.hlc))
        }

        DomainEvent::CheckoutCompleted { transaction_id, lines, total_cents, .. } => {
            tx.exec("INSERT OR REPLACE INTO p_transactions
                     (id, total_cents, ts, row_hlc, device_id) VALUES (?1,?2,?3,?4,?5)",
                    (transaction_id, total_cents, &e.ts, &e.hlc, &e.device_id))?;
            for l in lines {
                tx.exec("INSERT OR REPLACE INTO p_transaction_items
                         (tx_id, product_id, qty, unit_cents) VALUES (?1,?2,?3,?4)",
                        (transaction_id, &l.product_id, l.qty, l.unit_cents))?;
            }
            Ok(())
        }

        DomainEvent::ProductDeleted { id } => tx.exec(
            "UPDATE p_products SET deleted=1, row_hlc=?2 WHERE id=?1 AND ?2 > row_hlc",
            (id, &e.hlc)),

        DomainEvent::DevicePaired { .. } | DomainEvent::DeviceRevoked { .. } =>
            tx.exec("INSERT OR REPLACE INTO device_state /* … */", ()),  // §8
    }
}
```

**Determinism rules (testable, enforced by CI — see §10.2):**
1. Reducers read/write only the `tx` they are given.
2. The only clock is `e.hlc` (already decided at append time).
3. Numeric state changes only via accumulate-pattern updates (`stock = stock + ?`), never via absolute writes.
4. Field-level last-write-wins uses the `WHERE ?hlc > row_hlc` guard — the merge rule from doc ②, now expressed *inside* the reducer SQL.

### 5.4 A command: the full lifecycle (`src-tauri/src/commands/checkout.rs`)

```rust
#[tauri::command]
#[specta::specta]
pub async fn checkout(state: State<'_, App>, cart: Vec<CheckoutLine>) -> Result<Receipt, String> {
    state.core.transact(|tx| {
        // 1) VALIDATE against projections (fast, local, always available)
        for l in &cart {
            let stock: i64 = tx.one("SELECT stock FROM p_products WHERE id=?1 AND deleted=0", &l.product_id)?;
            ensure!(stock >= l.qty, "insufficient stock for {}", l.product_id);
        }

        // 2) DECIDE: which events does this action produce? (pure, unit-testable)
        let tx_id = ulid::Ulid::new().to_string();
        let total: i64 = cart.iter().map(|l| l.qty * l.unit_cents).sum();
        let events = vec![
            DomainEvent::CheckoutCompleted { transaction_id: tx_id.clone(), lines: cart.clone(), total_cents: total, payment: /* … */ },
        ];  // + one StockSold per line — or model stock inside CheckoutCompleted's reducer;
            // one envelope per event keeps aggregates routable (chosen: one per line)

        // 3) APPEND + REDUCE in ONE transaction (atomicity lives here — D-12 dead)
        for ev in events {
            let env = state.envelope("tx", ev);              // ULID + HLC + device stamping
            tx.append_event(&env)?;                          // INSERT OR IGNORE INTO event_log
            reduce(&env, tx)?;                               // projection update, same tx
        }
        tx.touch(&["p_products", "p_transactions", "p_transaction_items"]); // L4 hint
        Ok(Receipt { transaction_id: tx_id })
    }).await.map_err(|e: anyhow::Error| e.to_string())
}
```

**Read the shape again — it is the whole architecture in 30 lines:** validate → decide events → append+reduce atomically. Offline is this same function. Online is this same function. Another device's data arriving is this same function with `origin = remote`. There is exactly **one** write path in the entire product.

### 5.5 Remote event application (the pull path)

```rust
pub async fn apply_remote(core: &Core, envelopes: &[Envelope]) -> anyhow::Result<Applied> {
    core.transact(|tx| {
        let mut applied = 0;
        for e in envelopes.iter().filter(|e| e.device_id != core.device_id) {
            if tx.seen(&e.event_id) { continue; }           // idempotent by key
            tx.append_event(e)?;                            // origin = remote
            reduce(e, tx)?;                                 // SAME reducers as local
            core.hlc.observe(&e.hlc);                       // clock stays ahead
            applied += 1;
        }
        tx.touch(&touched_tables(envelopes));
        Ok(applied)
    }).await
}
```

Local writes and remote adoption are **one code path**. Your chaos tests test one thing instead of two interactions.

---

## 6. L3 — Merge-Native Storage Strategy

### 6.1 Why events make merging trivial

State replication must answer *"which version of the row is right?"* — a question with no universally correct answer. Log replication only ever answers *"have I applied this event?"* — a set-membership question with an obvious answer (`event_id`). Events **commute**: applying `StockSold(p1,3)` then `StockSold(p1,3)` from another device in either order yields stock 4 from 10. The only ordering that matters is *within an aggregate field with last-write-wins semantics* (name, price), and there the HLC guard inside the reducer SQL decides — deterministically, on every device, because HLC comparison is a total order.

### 6.2 Application order and the replay guarantee

- **Live path:** events are reduced in the same transaction they're appended in — local and remote alike (§5.4, §5.5).
- **Replay path (rebuild):** `SELECT … FROM event_log ORDER BY hlc` → same reducers. Because reducers only ever *add* deltas or *HLC-guard* field writes, replay converges to the identical projection regardless of insert order. This is the property CI enforces with the **replay-equality test** (§10.2): after every reducer change, rebuild-from-log must equal live projection, byte for byte, on randomized event streams.
- **Torn/partial application is impossible:** each replay batch is one transaction; a crash rewinds to the last `projection_cursor`.

### 6.3 Snapshots & compaction (keeping the log lean forever)

An unbounded event log is the classic event-sourcing objection. Policy:

| Concern | Mechanism |
|---|---|
| Log growth | **Snapshot events**: periodic `ProjectionSnapshot` events (per aggregate) containing the full projected row; replay may then start at the latest snapshot + subsequent events |
| Ancient detail | **Compaction rule**: after N days (default 180) and full log replication to Turso, local devices may *truncate* their local tail below the oldest snapshot — the cloud log is the durable archive |
| Reporting | Turso read models (§8.2) mean analytics never replay on devices |
| POS specifics | `StockSold`-type events are tiny (~120 bytes); 1,000 sales/day ≈ 130 MB/decade uncompressed — snapshots make even that irrelevant |

```sql
-- snapshot event: just another envelope, so it syncs and replays identically
DomainEvent::ProjectionSnapshot { projection: "p_products", rows_json: "…" }
```

### 6.4 Optional module: cr-sqlite for multi-editor catalogs

If your roadmap includes *several staff editing product fields concurrently while offline*, add **cr-sqlite** (vlcn-io) — a loadable extension for SQLite/libSQL providing column-level CRDT merge. Integration point is precisely bounded:

- Apply it **only to projection tables** (never the event log) as an *alternative* merge path for `p_products` field updates.
- The event log remains the truth; cr-sqlite merely accelerates convergence for one table family.
- Everything else in this document is unaffected — that isolation is deliberate, so the module can be added or dropped without re-architecture.

**Recommendation:** ship ES-LFP without it first (your POS has few true concurrent-edit scenarios); add cr-sqlite only when a real workflow demands field-level concurrent edits.

---

## 7. L4 — Reactive Query Layer

**Goal:** delete every line of "refresh after sync" code in the app. Screens become live queries; data changes *arrive* on screen because the query layer noticed the commit — not because some manager remembered to call reload.

### 7.1 The invalidation protocol (commit → notify → re-query)

```text
Rust transact() commits
  → emits typed event Committed { tables }        (tauri-specta, §4.3)
    → React QueryLayer hears it
      → invalidates cached queries touching those tables
        → re-runs them via typed query commands
          → subscribed components re-render
```

Local checkout, remote pull, background replay — all flow through the same `Committed` event. The UI cannot tell (and must not care) *why* data changed.

### 7.2 `useLiveQuery` (`src/live-query/useLiveQuery.ts`)

```typescript
import { useQueryClient } from "@tanstack/react-query";
import { listen, Committed, commands } from "../bindings/bindings";

// One provider, mounted once:
export function LiveQueryProvider({ children }: PropsWithChildren) {
  const qc = useQueryClient();
  useEffect(() => void listen("Committed", (e) => {
    const tables = new Set(e.payload.tables);
    // Invalidation map: query key → tables it reads. Generated alongside
    // bindings.ts from the query registry (one line per query).
    for (const [key, reads] of QUERY_TABLES)
      if (reads.some((t) => tables.has(t))) qc.invalidateQueries({ queryKey: key });
  }), [qc]);
  return <>{children}</>;
}

// In any component — this is the ENTIRE data access story:
export function ProductGrid() {
  const { data: products } = useQuery({
    queryKey: ["product_list"],
    queryFn: () => commands.productList(),      // typed, generated
  });
  // renders products; updates itself after ANY commit, local or remote
}
```

### 7.3 What this deletes

| Legacy mechanism | Fate |
|---|---|
| Dexie + the entire SQLite→Dexie mirror | **Deleted** (D-06 gone for good) |
| Manual `refresh()` calls after sync | **Deleted** |
| "Why is the UI stale?" bugs as a category | **Deleted** |
| Query-layer cache staleness | Bounded by one commit → one invalidation |

**Exit test:** with the app open on two screens, sell an item on the phone; the desktop grid updates with no user action and no sync-status coupling. That demo is the layer's acceptance criterion.

---

## 8. L5 — Cloud & Edge

### 8.1 The canonical event log on Turso

The cloud holds exactly **one** durable thing: the same `event_log` schema (§5.1), plus the `devices` registry. No entity tables, no per-table sync state — the cloud is the *archive and fan-out point* of the log, which also makes it your disaster-recovery-of-last-resort and your reporting source.

```sql
-- Turso-side, applied once (migration tooling from doc ② §5.1 reused):
CREATE TABLE IF NOT EXISTS event_log ( /* identical to §5.1 */ );
CREATE TABLE IF NOT EXISTS devices  ( /* doc ② §10 registry */ );
```

### 8.2 Worker routes (extends the hardened relay from doc ② §9)

| Route | Purpose | Idempotency |
|---|---|---|
| `POST /append` | Device pushes envelopes | `INSERT OR IGNORE` on `event_id`; response returns the cloud's current `max(hlc)` |
| `GET /events?since=<hlc>&limit=500` | Device pulls envelopes in HLC order | Read-only; watermark client-side |
| `GET /reconcile` | Fingerprint of cloud log tail (count + max hlc + checksum) | Read-only |
| `POST /telemetry` | Sync metrics sink (§10.3) | Append-only |
| WS `/relay` | "log appended" signals to other devices | Auth + rate-limit (doc ② §9 verbatim) |
| `POST /readmodel/rebuild` | (Admin) rebuilds Turso read models from the log | Replays through the same reducer SQL compiled to WASM |

**Read models for reporting:** a Worker cron (or Durable Object alarm) replays new events into Turso tables like `r_daily_sales`, `r_stock_by_product` — using the *same* reducer SQL you test in CI. Reports never touch devices, and devices never run report queries.

### 8.3 Security posture (carried forward, unchanged in intent)

- Per-device tokens, pairing flow, revocation — doc ② §10 applies verbatim; `DevicePaired`/`DeviceRevoked` are now *events* in the log, so the audit trail of who joined/left is permanent.
- Worker holds the Turso credential; devices hold only their device token (the cleanest shape flagged in doc ② §10.3).
- Relay carries signals only — still zero PII on the edge.

### 8.4 Quota & cost profile — **corrected in v2.0**

> **v1.0 said** "net quota impact ≈ neutral." That was a statement about *payload shape* (N row-diffs vs N+1 events) and it is wrong as a statement about *your budget*. Your production telemetry — **36 MB of cloud consumed on the first day of use** — is not a payload-shape problem; it is a **leaking engine** problem (retained outbox payloads, duplicate re-inserts from non-idempotent retries, full-table pulls, freelist growth — forensics in §14). Against that engine, ES-LFP plus the v2.0 bytes contract (§15–§16) is a **10–40× reduction**, and it is *enforced* by the SyncBudgetGovernor and the budget tests B-01…B-05 (§19.4), not assumed. `quotaManager.ts` survives as the client-side gauge, generalized into the governor (§16.6).

The structural reasons the event log is the *cheapest possible* shape for your quotas:

1. **Pulls are O(new events)** — a watermark query over an indexed `hlc` never re-reads history; today's full-table pulls re-read *everything, every cycle*.
2. **Appends are idempotent** (`event_id` primary key, `INSERT OR IGNORE`) — a retried batch inserts nothing twice, so retries cost *bandwidth*, never *storage*. Today every retry can duplicate rows permanently.
3. **One envelope per business action** (§16.1) — a 30-line checkout is ~700 bytes *once*, not 30 row-diffs with full column payloads.
4. **The log compacts** — devices truncate behind snapshots (§6.3) and the cloud archives to R2 (§18.2), so storage *plateaus* instead of growing forever.

---

## 9. The End-to-End Migration Strategy

**Doctrine:** the **strangler pattern at the command boundary**. The legacy engine keeps running while ES-LFP grows beside it; every phase ships to production independently useful; every phase is reversible until the final decommission. You never freeze development, and you never big-bang.

```text
            ┌────────────────────────────────────────────────┐
 legacy UI →│ legacy adapters → legacy tables → legacy sync  │  keeps working
            └────────────────────────────────────────────────┘
 new UI    →│ L4 queries → L2 commands → event_log → new sync │  grows beside it
            └────────────────────────────────────────────────┘
   P0  P1  P2  P3  P4  P5  P6  P7   ← each phase flips ONE seam
```

### P0 — Contract & Skeleton (week 1)

**Build:**
1. `tauri-specta` wiring (§4.3), `bindings.ts` generated + CI diff gate.
2. Rust `Core` skeleton: `transact()`, single-writer mutex, HLC clock (reused from doc ② §5.3 — identical algorithm).
3. Migrations 0100/0101 (event log + projections) applied **additively** to the existing DB file. Legacy tables untouched.
4. CI gate from doc ② §4.1 (tsc + cargo + tests) — mandatory before anything else.

**Gate:** build green; legacy app runs with the new tables present, zero behavior change.
**Rollback:** trivial — new tables are inert.

### P1 — Shadow Event Log (weeks 2–3)

**Build:** a legacy-write **interceptor**: after each legacy checkout/adjust (post-commit hook in the old adapters), derive the equivalent `DomainEvent` envelopes and append+reduce them through the new core. The event log fills with real production-shaped events; projections update; **the UI does not read them yet**.

**Build (concurrently):** the **snapshot backfill** — for every existing legacy row, one `ProductSnapshot`-style envelope (schema_v tagged), so the event log describes the *entire* current state, not just post-migration changes.

**Gate:** 7 days of dogfood where `replay_projection('p_products')` == live legacy `products` table, compared nightly by a verification job (counts + checksums). This is the **replay-equality property proven on real data before anything depends on it.**
**Rollback:** stop intercepting; event log freezes harmlessly.

### P2 — Command Flip (weeks 3–5)

**Build:** port each domain command (checkout, stock ops, product CRUD) to the §5.4 shape, one per PR, each behind a per-command flag in `sync_state`. UI calls the same screen components; only the invoked command changes.

**Sequence (risk-ordered):** `adjust_stock` → `receive_stock` → `upsert_product`/`rename` → `checkout` → `delete_product`.
**Gate per command:** 3 days dogfood + chaos-suite cases for that command green + projection-vs-legacy diff clean.
**Rollback per command:** flag row back; legacy adapter still intact.

### P3 — Reactive UI (weeks 5–7)

**Build:** `LiveQueryProvider` + query registry (§7); screen-by-screen, swap data access from legacy adapters/Dexie to typed live queries over projections. Delete each screen's manual refresh handlers as you go.

**Gate:** the two-screen demo test (§7.3) passes for every migrated screen; Dexie imports shrink to zero on migrated screens.
**Rollback:** per-screen revert (screens are independent).

### P4 — Event Sync Online (weeks 7–9)

**Build:**
1. Worker routes `/append`, `/events`, `/reconcile` (§8.2) with per-device auth.
2. Rust sync module: push loop (`SELECT … WHERE origin='local' AND hlc > pushed_watermark` → `POST /append`), pull loop (`GET /events?since=pull_watermark` → `apply_remote` §5.5), jittered backoff + circuit breaker (doc ② §7.4 reused verbatim).
3. Relay emits `log_appended` on `/append` success; supervisor coalesces (doc ② §8.2 single-flight guard reused).

**Dual-run window:** legacy push/pull and event sync run **in parallel** for 14 days. The legacy engine remains the UI's visible truth; event sync is verified by the same fingerprint reconciliation (doc ② §8.3, now comparing cloud log vs local log).
**Gate:** 14 days, zero reconciliation drift, `outbox_oldest_age_s`-equivalent (unsynced event age) < 60s at p95, chaos suite §10.2 green.
**Rollback:** disable event sync loops; legacy engine never stopped during this phase.

### P5 — Cloud Cutover & Read Models (weeks 9–11)

**Build:** Turso becomes the canonical log (it already receives events from P4; now the *legacy* cloud tables stop being written). Reporting queries move to Turso read models built by the Worker cron replay (§8.2). `CloudSyncPanel.tsx` gains: sync phase badge (from `SyncPhaseChanged` events), unsynced-event-age meter, devices tab.

**Gate:** first month-end report generated *purely* from read models matches the legacy report to the cent.
**Rollback:** read models are additive; legacy cloud tables are still intact.

### P6 — Decommission (weeks 11–13, after 14 clean days at P5)

The deletion PR (each line anticipated since doc ①):

```text
DELETE  src/sync/SyncManager.ts, outboxFlusher.ts        → replaced by sync module (~200 lines)
DELETE  src/db/sqlPluginAdapter.ts + Dexie mirror        → replaced by L2/L4
DELETE  legacy entity tables (products, transactions, …) → migration 02XX: after final export
DELETE  legacy cloud entity tables on Turso              → after read-model parity sign-off
DELETE  legacy outbox/quarantine UI code                 → replaced by event-tail meter
KEEP    keychain.ts (per-device), device.ts, quotaManager.ts, relay Worker (P4-hardened)
```

**Gate:** one full release cycle on ES-LFP alone; chaos suite as release gate; before/after metrics published against the Phase-A baseline from doc ②.
**Rollback:** one release window only — git revert + restored legacy table export. After that window, the event log is the only truth (which is the point).

### P7 — Compound Payoff (continuous)

With the legacy gone, the capabilities that justified the overhaul come online incrementally, each independently shippable: audit workbench UI over `event_log`; point-in-time queries (replay to HLC); one-tap device rebuild from cloud log; `ProjectionSnapshot` compaction; optional cr-sqlite module (§6.4); Turso read-model expansions (forecasting, shrinkage analytics) without touching devices.

### 9.1 Phase dependency graph

```text
P0 ─ P1 ─ P2 ─ P3 ─ P4 ─ P5 ─ P6 ─ P7
      │    │         │
      │    │         └─ chaos suite cases per phase, growing into the full suite
      │    └─ per-command flags (independent rollback)
      └─ replay-equality proof (the keystone gate of the whole migration)
```

### 9.2 The three keystone invariants (checked at EVERY phase gate)

1. **Replay equality:** projections rebuilt from log == live projections (on real data).
2. **Idempotent application:** any envelope batch applied twice → identical state.
3. **Convergence:** two devices + cloud reach identical projections under any interleaving the chaos suite generates.

If all three hold, the system is correct by construction; everything else is performance and UX.

---

## 10. Schema Evolution & Operational Maturity

### 10.1 Event versioning (the discipline that keeps the log immortal)

- Every envelope carries `schema_v`. **Events are never edited after release** — evolution = new variant.
- **Upcasting:** reducers translate old versions on read (`fn upcast(v1_event) -> CurrentEvent`). A v1 event from 2026 still reduces correctly in 2031.
- Projections may be freely dropped and rebuilt (`replay_projection` admin command) whenever you change reducer logic — the log forgives everything except itself.
- Renaming/retiring events: keep the variant, mark `#[deprecated]`, stop emitting it, reducer stays forever (it's 5 lines).

### 10.2 The extended chaos suite (extends doc ② §12)

| New test | Asserts |
|---|---|
| **Replay equality (property test)** | For 1,000 randomized event streams: live-reduced == replayed-from-log, byte-identical projections |
| **Duplicate delivery** | Same 500-envelope batch applied 3× → state unchanged after first |
| **Interleaving convergence** | 2 devices + cloud, random push/pull/crash schedule → all converge to identical projections |
| **Clock-skew field edits** | Future-clock device edits price; loses only to causally-later writes (HLC, doc ② §5.3 test reused) |
| **Compaction correctness** | Truncate below snapshot → replay from snapshot == replay from genesis |
| **Upcast fidelity** | v1 events reduce identically pre/post schema change |
| **Read-model parity** | Worker replay of N events == device projections for the same window |

Plus the original eight from doc ② §12 where still applicable (relay flood, partition, restore-laggard…).

### 10.3 KPIs (the overhaul's scoreboard)

| KPI | Target | Instrument |
|---|---|---|
| `unsynced_event_age_s` p95 | < 60s online; bounded offline | push loop gauge |
| `drift_incidents` | 0 (post-P4) | `/reconcile` fingerprint compare |
| `replay_equality_failures` | 0 ever | CI property test |
| convergence time (2 devices) | < 5s online | chaos suite timing |
| sync code surface | ~200 lines vs legacy ~thousands | `tokei`/cloc diff, published |
| recovery time (new device) | minutes: pull + replay | device-rebuild drill, quarterly |

### 10.4 Operations runbook additions

- **"Projection looks wrong"** → `replay_projection` — 30 seconds, zero risk, log is truth.
- **"Device acting strangely"** → revoke token (doc ② §10) — the log shows its full history.
- **"Need yesterday's stock view"** → replay to HLC watermark — by query, not by panic.
- **Turso incident** → devices sell offline (that's the architecture); relays queue; on recovery, watermarks resume.

---

## 11. Effort, Risks & Reversibility

### 11.1 Honest cost comparison

| | Tier 1/2 (doc ②) | **ES-LFP (this doc)** |
|---|---|---|
| Build effort | 4–6 weeks active | 8–10 weeks active (P0–P6), spread over ~13 weeks |
| Elapsed with soak gates | ~3–5 weeks | ~13 weeks |
| Discipline required | Medium | High (determinism, versioning) |
| Sync code at end | ~600–800 lines | ~200 lines |
| New capabilities | Accuracy, durability | Accuracy, durability **+ audit + time travel + self-repair + reporting decoupling** |
| When it's the wrong choice | — | If you must ship correctness fixes *this month*, run doc ② Phases A–D first; ES-LFP absorbs them (§12) |

### 11.2 Risk register

| Risk | Sev | Mitigation (built into the plan) |
|---|---|---|
| Reducer non-determinism sneaks in (wall clock, RNG) | High | Determinism rules §5.3 + CI property test §10.2 (replay equality fails loudly) |
| Event schema sprawl | Medium | `schema_v` + upcasting discipline §10.1; events stay small; deprecation policy |
| Log grows unbounded on low-storage devices | Medium | Snapshot + compaction §6.3; cloud is the archive; KPI on log size |
| Specta/tauri-specta RC-version churn | Medium | Version pinning (doc ② §3.2) + bindings CI diff gate makes churn visible & deliberate |
| Solo-dev bandwidth during 13-week arc | Medium | Every phase ships standalone value; phases P2/P3 are per-command/per-screen — pausable anytime |
| Interceptor (P1) double-counts with legacy writes | Medium | Interceptor is derive-only (post-commit), envelopes carry distinct origin; replay-equality gate would catch any double count |
| Turso becomes canonical point of failure | Low | Devices are fully functional offline by design (P1's core guarantee); cloud return = watermark resume |
| Over-engineering temptation (cr-sqlite, CRDTs) | Low | §6.4 keeps it optional and isolated; ship without first |

### 11.3 One-way doors (identified, not stumbled into)

Only three decisions in this strategy are expensive to reverse — everything else is a flag flip:

1. **P6 deletion of legacy tables/cloud tables** (mitigated by: final export + one-release revert window).
2. **The event schema itself** (mitigated by: versioning discipline — the log is designed to outlive every projection).
3. **Compaction below the oldest snapshot** (mitigated by: cloud retains full history; only devices truncate).

Knowing your one-way doors *before* you walk through them is what separates an overhaul from an escapade.

---

## 12. Supersession Map & References

### 12.1 How the three documents relate

| Document | Status after this strategy | Still authoritative for |
|---|---|---|
| ① Fix Plan & Roadmap | Active — defect register & rationale | D-01…D-12 definitions, severity, business justification, D-01 parser-error fix protocol |
| ② Tier 1/2 Implementation Guide | **Superseded as engine design; harvested as component library** | HLC clock impl (§5.3), CI gate (§4.1), migration runner (§5.1), backoff (§7.4), relay hardening (§9), device tokens/pairing/revocation (§10), chaos suite core eight (§12), rollback discipline |
| ③ **This strategy** | **The target architecture & migration program** | Everything else |

**Absorption rule:** where ② and ③ specify the same component (auth, backoff, HLC, CI, chaos testing), the ③ architecture uses the ② implementation unchanged. Nothing you build from ② is wasted; the event log simply replaces ②'s *row-replication core* (intents, applier merge SQL, adopt loop, Dexie handling) with something structurally simpler.

**If you have already started ②:** its Phase A–B deliverables (CI, HLC, schema discipline) are exactly ③'s P0–P1 prerequisites. Continue into ③ at P1; skip nothing.

### 12.2 Decision summary (the whole document in six lines)

```text
1. The app becomes an event log with projections, not a database with a sync feature.
2. Events commute; conflicts, duplicates, and stuck rows stop existing as concepts.
3. Projections are disposable; replay is the only repair tool you will ever need.
4. The UI is live queries; nothing anywhere calls refresh().
5. The cloud is the log's archive and fan-out; devices never need it to sell.
6. Migrate by strangling the command boundary, one reversible phase at a time.
```

### 12.3 References

- Fowler, *Event Sourcing* (martinfowler.com, 2005) — the canonical pattern
- Microsoft Azure Architecture Center, *Event Sourcing Pattern* (2026 revision) — projections, consistency, rebuild
- microservices.io, *Event sourcing* — aggregate boundaries and event-carried state transfer
- vlcn-io/cr-sqlite (github.com/vlcn-io/cr-sqlite) — CRDT extension for SQLite/libSQL; optional §6.4 module
- specta-rs/tauri-specta v2 — fully typed Tauri commands **and events** (github.com/specta-rs/tauri-specta)
- TanStack Query + local-first live-query invalidation patterns (tanstack.com; powersync.com *Local-First State Management with SQLite*)
- Kulkarni, Demirbas et al., *Logical Physical Clocks* — HLC (used verbatim from doc ②)
- Turso/libSQL documentation — docs.turso.tech, docs.rs/libsql (log storage, embedded replicas if a Tier-2 transport is later desired for the *log itself*)
- AWS Prescriptive Guidance, *Transactional Outbox Pattern* — why at-least-once + idempotent keys; ES-LFP is the same insight taken to its structural conclusion
- Ink & Switch, *Local-first Software* — the principles this platform realizes

---

## 13. v2.0 Verdict — "Should I Move From SQLite to SQL?"

You asked whether going "from SQLite to SQL" would buy better cloud synchronization. This section answers it definitively, because the answer shapes every other decision in v2.0.

### 13.1 The category error, stated kindly

**SQLite already *is* SQL.** It is a full relational database engine — transactions, foreign keys, triggers, views, window functions, CTEs, a rich SQL dialect, and a JSON function set. When people say "move from SQLite to SQL," they almost always mean one specific thing: **a client-server SQL database** (PostgreSQL or MySQL running on a host), where the app connects over the network and the *device holds no database*.

So the real question is not "which database engine?" — it is **"where does the device's data live, and what replicates it?"** Your pain is not caused by SQLite; it is caused by the **sync fabric wrapped around it**: full-table pulls every cycle, outbox payloads retained forever, retries that duplicate rows. Swap the engine and keep the fabric, and the 36 MB/day follows you to PostgreSQL faithfully — plus new problems you don't have today.

### 13.2 What "device → remote client-server SQL" would actually cost a POS

For a point-of-sale system, four of these are disqualifying on their own:

| # | Consequence | Why it's fatal for Mobi POS |
|---|---|---|
| 1 | **Offline becomes impossible or fake** | A register must complete sales when the router is down — this is the non-negotiable POS requirement. Client-server means every query needs the network. You'd immediately start building an offline write queue… which is an outbox, which is what you already have, minus the local read speed. |
| 2 | **Latency moves from µs to 50–300 ms per query** | Today a product lookup is a local index seek. Over mobile data, every keystroke-driven search, cart render, and price check pays a network round trip. POS UIs feel this instantly. |
| 3 | **Database credentials ship inside every device** | Each phone/tablet becomes an internet-exposed database client. Revoking a stolen device means rotating *the database's* credentials for everyone. Your current per-device token design (doc ② §10) is strictly safer. |
| 4 | **Mobile OS background restrictions kill persistent connections** | iOS suspends sockets within seconds of backgrounding; Android Doze defers them. A connection-oriented device database fights the platform all day. |
| 5 | Per-query cost follows you | Any hosted SQL still meters you per query/row/connection — the same billing sensitivity as today, with none of the offline guarantees. |

The industry agrees on this unanimously. Every serious offline-first stack — Turso, PowerSync, Electric, AWS Amplify, Firebase — puts **an embedded database on the device** (almost always SQLite) and syncs *deltas* to a server. The direction of travel is *toward* SQLite on device, never away from it.

### 13.3 The five-way decision matrix

What are the actual candidate platforms, evaluated against *your* constraints ($0-ish budget, 5 GB cloud that must last 18 months, Tauri on Desktop + Android + iOS, offline-first POS)?

| Criterion | Direct client-server SQL (Postgres/Neon) | Turso embedded replicas | PowerSync | Electric 1.0 (GA Mar 2025) | **ES-LFP (this doc)** |
|---|---|---|---|---|---|
| Offline **writes** | ✗ (rebuild an outbox) | ✗ (writes need connectivity; you queue them yourself) | ✓ (SQLite client + async sync) | ✓ reads; writes via your own API | ✓ **by construction** (the log *is* local) |
| Device read latency | 50–300 ms | µs (local file) | µs | µs (WASM SQLite / local) | µs (libsql local file) |
| Bytes on the wire | Very high (every UI query) | Page/frame-level deltas — amplified for scattered small writes vs row-level events | Row-level deltas | Shape-based partial replication | **Event deltas, batched, compressed — the floor** |
| Infra cost / month | Postgres host ~$5–19 (free tiers too small/ephemeral for POS) | $0 (free tier) | Service: cloud $ per MAU, or self-host (server + Postgres ≈ $5+/mo) | Electric service + Postgres you host | **$0 — your existing Turso + Cloudflare** |
| Audit trail / time travel / self-repair | ✗ | ✗ (syncs state, not history) | ✗ | ✗ | ✓ **the log is the archive** |
| What happens to your current code | Delete and rewrite everything | Replaces fabric only; offline queue still yours to build | Replaces fabric; forces a Postgres migration | Replaces fabric; forces a Postgres migration | **Strangler migration — app ships every week** |
| Tauri Desktop + Android + iOS | Poor fit | ✓ via Rust core (the same libsql crate Turso's own mobile SDKs use) | ✓ (web/RN SDKs; Tauri WebView works) | Web-first; mobile via your hosted service | ✓ **Rust core compiles per target (§17)** |
| 5 GB / 18-month budget story | Worst (all queries, all the time) | Good on wire; storage = full DB replicas | Good | Good | **Best — plateau via compaction + R2 archival (§18.2)** |

**Read of the matrix:**

- **Direct client-server SQL is the only option that is strictly worse than what you have.** It deletes offline, adds latency, and multiplies cost — to solve a problem (the fabric) it doesn't even touch.
- **Turso embedded replicas** are a genuinely good product and the natural *future transport* for the log itself (already noted in §12.3). But they sync *database state*: they give you no audit trail, offline writes still require a queue you must build (i.e., the hardest part of ES-LFP), and frame-level sync amplifies bytes for write-scattered POS workloads. Use them later, if ever, *under* the event log — not instead of it.
- **PowerSync and Electric** are the strongest commercial fabrics, and if you were starting from zero with a budget, PowerSync would be a serious contender. Both force a Postgres backend + a sync service you pay for or host, and both replicate *state*, giving up the audit/time-travel/self-repair properties that are half the point of the overhaul. On a $0 budget with a working Turso + Cloudflare account, they solve a problem you won't have after this migration.

### 13.4 The verdict

> **Keep SQLite — as libsql — as the device store on every platform. Keep Turso + Cloudflare — at $0. Replace the fabric with event-log replication.**
>
> You already own the best database engine for the device side; what's broken is the road, not the car. The "SQL upgrade" that actually pays is upgrading the *protocol* to ES-LFP — which is precisely the overhaul this document specifies.

When would you revisit? Two triggers, both additive and both already provisioned for: (a) multi-editor real-time catalog collaboration → the cr-sqlite module (§6.4); (b) engine-managed transport for the log → Turso embedded replicas carrying `event_log` (§12.3). Neither changes today's decision.

---

## 14. Forensics — Where the 36 MB/Day Went

One day of use consumed 36 MB of your cloud. That number is not mysterious — it is the *predictable output* of the current engine's design. This section identifies which meter is burning, ranks the leaks, and gives you the 30-minute diagnostic that proves it on your own database before you change a line of code.

### 14.1 First, identify which meter is burning (30-minute diagnostic)

Your Turso free plan meters **three separate things** (verified 2026):

| Meter | Free allowance | Where you see it |
|---|---|---|
| **Storage** | 5 GB total (your "5 GB") | Turso dashboard → database → size (MB) |
| **Row reads** | 500 M / month | Turso dashboard → Usage tab |
| **Row writes** | 10 M / month | Turso dashboard → Usage tab |

(Plus Cloudflare Workers: 100 k requests/day on the free plan — check the Workers metrics page too.)

**"36 MB in a day" is almost certainly the storage meter**, because that's the one displayed in MB. But the *usage* meters may be burning silently alongside it — Turso bills a row read for **every row a query scans, including rows it filters out**, and a `WHERE` without a matching index is a full scan. A 10,000-row table scanned once a minute costs ~14 M row reads/day — 2.9% of your *monthly* cap, every day, growing as your tables grow. This is the exact trap documented in Turso's own billing guidance and in public post-mortems ("hunting down 1.3 billion row reads").

Run this against the cloud database (any client — `turso db shell` or the Worker):

```sql
-- 1. How big is it, and how much is waste?
PRAGMA page_size;          -- e.g. 4096
PRAGMA page_count;         -- total allocated pages
PRAGMA freelist_count;     -- allocated-but-free pages (bloat from UPDATEs/DELETEs)

-- 2. Which tables own the bytes? (dbstat virtual table)
SELECT name,
       SUM(pgsize)/1024.0      AS kb_total,
       SUM(pgsize)*1.0/(SELECT SUM(pgsize) FROM dbstat) AS share
FROM dbstat
GROUP BY name
ORDER BY kb_total DESC
LIMIT 15;

-- 3. If dbstat is unavailable on your plan, approximate per table:
--    SELECT COUNT(*) AS rows, AVG(LENGTH(payload_json)) AS avg_bytes FROM <table>;
```

**How to read the result:**

- `freelist_count * page_size` > ~10% of the file → **leak #5** (no `auto_vacuum`; the file never shrinks — §14.2).
- The biggest table is your **outbox / sync queue / inflight / quarantine** → **leak #1 and #2** (retained payloads + retry duplicates).
- The Usage tab shows row reads in the millions per day → **leaks #3 and #4** (full-table pulls and unindexed filters).

### 14.2 The seven leaks, ranked

| # | Leak | Meter it hits | Mechanism | Est. share of your 36 MB/day |
|---|---|---|---|---|
| 1 | **Retained outbox payloads** | Storage | Every write stores a full-row JSON payload in the outbox; rows are *never deleted after ack*. Each business write permanently costs its payload size + row overhead, forever. | ~50–70% |
| 2 | **Non-idempotent retries** | Storage + reads | Every failed flush re-sends the batch, and the server re-INSERTs it (no natural key). One flaky afternoon duplicates whole batches permanently. | ~15–25% |
| 3 | **Periodic full-table pulls** | Row reads + bandwidth | `SELECT *` (or unbounded `SELECT … WHERE updated > boot`) on every sync cycle. Cost grows with table size, not with change size — the definition of an anti-delta. | usage meter dominant |
| 4 | **Unindexed filtered queries** | Row reads | A `WHERE` without a matching index scans every row, and Turso bills every scanned row. Reconciliation checks over full tables are the classic silent killer. | usage meter |
| 5 | **UPDATE-heavy bookkeeping without `auto_vacuum`** | Storage | `inflight`/`last_sync`/status rows rewritten every cycle leave free pages the file never returns. The file ratchets upward with every sync, even when net data is unchanged. | ~5–10% |
| 6 | **Uncompressed WebSocket JSON** | Bandwidth (device data) | Cloudflare Workers **never negotiate `permessage-deflate`** (verified 2025) — every WS data frame pays 100% of verbose-JSON key overhead on the wire, both directions. | bandwidth |
| 7 | **Dexie mirror consistency reads** | Row reads | The mirror's need to verify itself against the cloud generates extra pulls that a single source of truth never would. | usage meter, minor |

### 14.3 The arithmetic that reproduces your number

A single busy day for one store — say 400 receipts averaging 8 lines — produces roughly: 400 checkout writes + 3,200 line writes + 400 payment writes + ~100 stock/product edits ≈ **4,100 business writes**. Now run them through the leaking engine:

```text
4,100 writes × ~350 B full-row JSON payload (outbox row, kept forever)   ≈  1.4 MB
+ 1 retry episode duplicating a third of the day's batches              ≈  0.5 MB
+ sync/status/inflight row rewrites × cycles (freelist ratchet)         ≈  0.2 MB
+ SQLite row/index/overflow-page overhead (~2.5× payload)               ≈  3.5–5 MB
+ the same data mirrored again through quarantine/logs on bad cycles    ≈  0.5–1 MB
                                                                        ---------
                                                       day-one storage   ≈  6–8 MB

…then the *second* effect dominates: every sync cycle ALSO re-pulls
recent/changed/full tables to "make sure", and each cycle's payloads and
bookkeeping keep accumulating. At ~1 cycle/minute over a 10-hour trading
day, retained pull-side bookkeeping + duplicated verification data
comfortably closes the gap to                                   ≈  36 MB/day
```

The exact split doesn't matter — the diagnostic in §14.1 will give you the real percentages in half an hour. What matters is the *shape*: **every leak is a function of the fabric, not of SQLite, and every one of them is deleted by design in ES-LFP** (§14.4).

### 14.4 Why ES-LFP is also the *efficiency* answer

Each v2.0 property kills a leak structurally — no tuning, no vigilance:

| Leak (§14.2) | ES-LFP property that deletes it |
|---|---|
| 1. Retained outbox payloads | There is no outbox — the local `event_log` *is* the queue, and it truncates behind snapshots (§6.3). Purge-on-ack invariant (§16.4). |
| 2. Non-idempotent retries | `event_id` primary key + `INSERT OR IGNORE` (§8.2). A retry can never add a byte of storage. |
| 3. Full-table pulls | Watermark pulls: `WHERE hlc > :since ORDER BY hlc LIMIT 500` over an index — reads scale with *new events*, never with history (§16.3). |
| 4. Unindexed scans | One index to rule them (`idx_event_hlc`), plus the CI `EXPLAIN QUERY PLAN` gate that fails any Worker query that `SCAN`s a large table (§18.3). |
| 5. Freelist ratchet | `auto_vacuum = INCREMENTAL` at creation + periodic `incremental_vacuum` / `VACUUM` (Turso supports `VACUUM` since v0.6.0 — verified) (§18.1–18.2). |
| 6. Uncompressed WS JSON | Data moves over HTTPS (edge-compressed); WS carries only ~40-byte tickle signals (§16.3). |
| 7. Dexie mirror reads | The mirror is deleted at P6; one source of truth, zero verification reads. |

The same inversion that deletes conflicts (§1.1) also deletes the leaks: **a log of small, idempotent, watermark-addressed facts is the cheapest thing that can be replicated.**

---

## 15. The Budget — Making 5 GB Last 18+ Months

Your requirement: **5 GB of cloud must last at least 12, ideally 18 months.** This section turns that wish into an engineered budget with margins, and §16–§19 make it enforced.

### 15.1 The constraint, quantified

```text
5,120 MB / 545 days (18 months) = 9.4 MB/day  ← absolute ceiling, zero margin
Design target: ≤ 2 MB/day cloud storage growth ← 4.7× safety margin
Hard governor ceiling: 5 MB/day                ← trips investigation, never exceeded
```

The same exercise for the *other* two Turso meters (so the budget is complete):

| Meter | Free cap | Design target | Margin at target |
|---|---|---|---|
| Storage growth | 5 GB total | ≤ 2 MB/day (≈ 60 MB/mo) | ~42× at 18 months |
| Row reads | 500 M/mo | ≤ 50 k/day (≈ 1.5 M/mo) | ~333× |
| Row writes | 10 M/mo | ≤ 30 k/day (≈ 0.9 M/mo) | ~11× |
| Cloudflare requests | 100 k/day | ≤ 15 k/day | ~6× |
| Device data plan (per device) | — | ≤ 2 MB/day | your operators will notice nothing |

### 15.2 The event-byte model (where the 2 MB/day comes from)

Design rule **R1 (one envelope per business action):** a 30-line checkout is **one** `CheckoutCompleted` envelope carrying its items array — not 31 row-level events. This is the single most important byte decision in the whole protocol, and it is made once, in the event schema, not tuned later.

A *heavy* single-store day (2,000 receipts, 6 items average, plus receiving and catalog work):

| Producer | Envelopes/day | Avg bytes | Raw/day |
|---|---|---|---|
| `CheckoutCompleted` (aggregate: items, payment, totals) | 2,000 | ~700 B | 1.37 MB |
| `StockReceived` / `StockAdjusted` | 60 | ~280 B | 17 KB |
| `ProductUpserted` / price & catalog edits | 80 | ~250 B | 20 KB |
| `CashDrawerOpened`, `ShiftClosed`, housekeeping | 40 | ~180 B | 7 KB |
| Device telemetry (1 `SyncDayReported`/device, §19.1) | 4 | ~400 B | 1.6 KB |
| **Total raw JSON** | **~2,184** | | **~1.42 MB/day** |

Cloud storage = log + `idx_event_hlc` + read models + telemetry. With SQLite row/index overhead (~2–2.5× on compact JSON) plus read models (~150–300 MB steady state):

| Scenario | Receipts/day | Raw/day | Cloud storage/day | 18-month projection (no archival) | With 90-day R2 archival (§18.2) |
|---|---|---|---|---|---|
| Quiet | 200 | ~0.15 MB | ~0.4 MB | ~210 MB | plateau ~80 MB |
| Typical | 800 | ~0.6 MB | ~1.5 MB | ~800 MB | plateau ~180 MB |
| **Heavy** | **2,000** | **~1.4 MB** | **~3.5 MB** | **~1.9 GB** | **plateau ~400 MB** |
| Catastrophic (4,000) | 4,000 | ~2.8 MB | ~7 MB | ~3.8 GB (still fits) | plateau ~750 MB |

Two conclusions fall out of the table:

1. **Even the no-archival heavy case fits inside 5 GB with a ~2.6× margin.** The archival lever exists so you never have to think about it again — Turso storage *plateaus* at the 90-day window (~400 MB at heavy load) while R2 (10 GB free, **zero egress fees** — verified) holds the compressed full history: 18 months of heavy-store events compresses to roughly 250–400 MB of gzipped NDJSON, ~4% of R2's free tier.
2. The **usage** meters barely register: 2,200 appends + read-model updates ≈ 15–25 k row writes/day ≈ 0.75 M/mo (7.5% of the write cap); watermark pulls + O(1) reconciliation ≈ 30–50 k row reads/day (≈ 3% of the read cap).

### 15.3 Budget enforcement ladder

```text
Level 0  telemetry only      — SyncDayReported events flow daily; review weekly (§19.1)
Level 1  amber at 60%        — any meter past 60% of its monthly budget by day 20
                              → panel badge + daily digest event
Level 2  red at 80%          → governor clamps cadence (§16.6) + cloud archive job
                              runs early (§18.2) instead of on schedule
Level 3  hard ceiling        — daily storage growth > 5 MB two days running
                              → this is a bug by definition; §14.1 diagnostic is the
                                first response, chaos/budget tests the prevention
```

The budget is not a promise you make; it is an invariant the system reports on, tests for (B-01…B-05, §19.4), and defends mechanically.

---

## 16. Wire-Protocol Discipline — the Bytes Contract

The budget holds only if every byte that crosses the network follows six rules. They are cheap to implement (all of them live in the ~200 lines of sync code that replace `SyncManager.ts` + `outboxFlusher.ts`) and each maps to a leak it prevents.

### 16.1 R1 — Compact envelope encoding

Keep human-readable JSON, but ship envelopes as **positional arrays** with a versioned field map, not as objects with repeated keys:

```jsonc
// verbose object form — 271 bytes on the wire, per envelope, every key repeated
{"schema_v":1,"event_id":"01J8ZK3Q9VX7M2","hlc":"1726563201123:3:dev-04","type":"StockAdjusted","origin":"dev-04","payload":{"sku":"MUG-001","delta":-2,"reason":"sale"}}

// positional array form — 118 bytes (−56%); brotli on the batch gets another ~80–85%
[1,"01J8ZK3Q9VX7M2","1726563201123:3:dev-04","StockAdjusted","dev-04",{"sku":"MUG-001","delta":-2,"reason":"sale"}]
```

The field map is `[schema_v, event_id, hlc, type, origin_device, payload]`, pinned by `schema_v` — the same versioning discipline as §10.1. Do **not** reach for protobuf/MessagePack yet: JSON arrays + edge compression already land within ~10–15% of binary formats for this payload shape, and you keep debuggability. Revisit only if B-01 shows the wire budget breaking (measure first — that's what the budget tests are for).

### 16.2 R2 — Batched push, one round trip

- Business writes append envelopes to the local `event_log` and mark them `unpushed` — **no network on the write path, ever** (this is why checkout latency can't feel the cloud).
- The push loop coalesces: **5-second quiet window** after the last local append, or 50 pending envelopes, whichever first → one `POST /append` with up to 500 envelopes.
- The Worker applies them in **one libsql `batch()`** (single HTTP round trip Turso-side, single transaction): `INSERT OR IGNORE` per envelope + one `log_stats` counter update + tickle fan-out to other devices.
- Response: `{ ack_hlc, accepted, duplicates }` — duplicates are *normal* (at-least-once delivery), never an error, never new storage.

### 16.3 R3 — The HTTP+WS split (data vs. signals)

Verified platform facts that force this design: **Cloudflare Workers never negotiate `permessage-deflate`**, so WS frames are uncompressed forever; but Cloudflare's edge **auto-compresses HTTP responses** (gzip/brotli per `Accept-Encoding`) for JSON. Therefore:

| Channel | Carries | Why |
|---|---|---|
| `GET /events?since=<hlc>&limit=500` (HTTPS) | **All pull data** | Edge-compressed; cacheable; retryable; idempotent |
| `POST /append` (HTTPS) | **All push data** | Same, plus batch transaction server-side |
| `WS /relay` | **Tickle signals only**: `{"t":1,"h":"<max_hlc>"}` (~40 B) | The only thing WS is uniquely good for: waking devices in ~100 ms without polling. Data here would pay 100% JSON overhead, uncompressed, both directions. |

Pull shape — note the echo suppression (your own events come back to you never; you already have them):

```sql
-- Worker → Turso, served via GET /events
SELECT schema_v, event_id, hlc, type, origin_device, payload
FROM event_log
WHERE hlc > :since AND origin_device != :device_id   -- echo suppression
ORDER BY hlc ASC
LIMIT 500;                                            -- paginated; client follows with the new watermark
-- backed by: CREATE INDEX idx_event_hlc ON event_log(hlc);
-- rows READ ≈ rows DELIVERED — the metering invariant (§18.3)
```

Pull triggers: on tickle (debounced 2 s), on app foreground (§17.2), on reconnect, and an idle safety poll every 120 s. **No full pulls exist anywhere in the protocol** — the only unbounded pull is a brand-new device rebuilding itself (§17.4), which is snapshot-bootstrapped precisely so it isn't.

### 16.4 R4 — Purge-on-ack (the anti-leak invariant)

After `/append` returns, the pushed envelopes are marked `pushed` locally; the local log truncates behind the oldest snapshot per §6.3 (devices keep history only as long as compaction policy allows). The cloud stores each event **exactly once** — there is no per-device queue, no per-device state, no retained payload anywhere in the server. If a table named like `outbox`, `queue`, or `pending` ever appears in a Turso `dbstat` top-15 list again, §14.1 has found you a bug.

### 16.5 R5 — Cadence policy (the schedule is the budget)

| App state | Push | Pull | WS |
|---|---|---|---|
| Foreground, user active | 5 s coalesce window | on tickle (2 s debounce) + every 60 s | connected |
| Foreground, idle ≥ 10 min | flush pending, then on accumulation only | every 120 s | connected |
| Backgrounded / hidden (mobile) | **flush now**, then silent | silent | closed cleanly |
| Offline | queue locally (unbounded, it's just the log) | — | closed |
| Reconnect | immediate flush + watermark pull, jittered 1→60 s backoff during outages | | |

The mobile rows are not pessimizations — they are how §17.3 makes iOS and Android happy, and they are also why an idle-but-open register costs ~40 KB/hour instead of megabytes.

### 16.6 R6 — The SyncBudgetGovernor

The client-side enforcement of §15. `quotaManager.ts` generalizes into this:

```rust
/// src-tauri/src/sync/governor.rs — sketch (full loop shape reuses doc ② §7.4 backoff)
pub struct SyncBudgetGovernor {
    daily_byte_budget: u64,        // default 5 MB (covers §15 heavy day with headroom)
    floor_byte_budget: u64,        // 1 MB — never go below: POS must still sync
    spent_today: AtomicU64,        // counted at the socket: request+response bodies
    day: AtomicU8,                 // rolls at local midnight
}

impl SyncBudgetGovernor {
    /// Called before any network call. Returns the cadence multiplier.
    pub fn admit(&self, planned_bytes: u64) -> Cadence {
        let remaining = self.daily_byte_budget.saturating_sub(self.spent_today());
        match remaining {
            r if r > self.daily_byte_budget / 2        => Cadence::Normal,
            r if r > self.floor_byte_budget             => Cadence::Relaxed,  // idle poll 120s→600s, skip safety polls
            r if r > 0 && planned_bytes < r             => Cadence::Critical, // flush pushes only (they're the business data)
            _                                          => Cadence::OfflineUntilMidnight,
        }
        // INVARIANT: business writes are NEVER blocked — only network timing changes.
        // The governor throttles the road, never the register.
    }
}
```

Daily, each device emits `SyncDayReported` (bytes in/out, envelopes, governor state — §19.1) *through the same budget*, so monitoring itself is bounded to kilobytes.

---

## 17. Cross-Platform Reality — Desktop, Android, and iOS

You are not building a desktop app with phone companions; you are building **one platform that compiles for three targets**. The v1.0 architecture already made the decision that makes this cheap: the domain core — event store, reducers, HLC clock, push/pull loops, governor — lives in **Rust** (§5), and the UI is shared TypeScript. Tauri 2 has had stable mobile support since 2.0 (October 2024). Nothing about ES-LFP is desktop-shaped: an append-only log with an HLC watermark is exactly what a phone wants — tiny writes, rare syncs, no sockets held hostage.

### 17.1 What runs where (the portability map)

```text
┌────────────────────────────────────────────────────────────────────┐
│  Shared TypeScript UI (React) — screens, live queries (L4)         │
├────────────────────────────────────────────────────────────────────┤
│  tauri-specta bindings — same typed commands/events on all targets │
├────────────────────────────────────────────────────────────────────┤
│  Rust core (L2/L3): event_log · reducers · HLC · sync loops ·      │
│  governor — ONE codebase, three compile targets                    │
├────────────────────────────────────────────────────────────────────┤
│  libsql local file        libsql local file      libsql local file │
│  (SQLite on Win/mac/      (SQLite via Android   (SQLite via iOS    │
│   Linux app_data_dir)      app data dir)         App Support)      │
└────────────────────────────────────────────────────────────────────┘
     Desktop                        Android               iOS
```

| Concern | Desktop (Win/mac/Linux) | Android | iOS |
|---|---|---|---|
| DB file home | `app_data_dir()/mobipos.db` | internal storage (app-private) — same API | `Application Support/` — same API |
| Device token | OS keychain (`keyring` crate / stronghold plugin) | Android Keystore | iOS Keychain |
| Sync loop host | Rust tokio task | Rust tokio task (same code) | Rust tokio task (same code) |
| Build entry | `tauri build` | `tauri android build` (NDK toolchain wired by the CLI) | `tauri ios build` (Xcode ≥ 15, signing) |
| Store distribution | installer / updater | Play Store or sideload APK | App Store (TestFlight for dogfood) |
| Background execution | generous | Doze-restricted | aggressively suspended (~30 s after backgrounding) |
| Metered network | rare | common (cellular) | common (cellular) |

Two implementation notes worth pinning: the `libsql` crate compiles cleanly for `aarch64-linux-android` and `aarch64-apple-ios` (it is the engine under Turso's own mobile SDKs, and `tauri-plugin-sql` already proves the C-SQLite-on-mobile path); and the WS connection exists **only while the app is foreground** on mobile — which the cadence policy (§16.5) already mandates.

### 17.2 Mobile lifecycle IS the sync scheduler

The single most important mobile rule: **never rely on timers or sockets surviving backgrounding.** iOS suspends the app within seconds; Android Doze defers everything. The cadence policy inverts the design — the OS lifecycle events *drive* sync:

```typescript
// src/sync/lifecycle.ts — the entire mobile scheduling story, ~30 lines
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

// Tauri emits window focus/blur; on mobile these map to
// applicationDidBecomeActive / didReceiveMemoryWarning-adjacent transitions
await listen('tauri://focus', () => invoke('sync_flush_now'));      // pull + push immediately
await listen('tauri://blur',  () => invoke('sync_flush_now'));      // LAST CHANCE before suspension
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') invoke('sync_flush_now');
});
// Rationale: a flush is one small POST (≤500 envelopes, §16.2) that completes
// in well under a second — designed to finish inside the OS's grace window.
```

Consequences of this design, all of them good:

- **Backgrounded app costs exactly zero bytes and zero battery** — no heartbeat, no radio wakeups, no killed-socket reconnect storms. (Compare: today's always-on WS + polling fights the OS all day.)
- **Foreground latency stays low** — focus triggers a watermark pull, so the register is fresh the moment the cashier picks it up.
- **The offline-first guarantee is untouched** — a suspended app that missed a flush simply flushes on next focus; the local log was never at risk.

If you later *want* background sync (e.g., overnight reconciliation), that is a small, isolated native add-on — `BGTaskScheduler` on iOS, `WorkManager` on Android — calling the same `sync_flush_now` core. It is explicitly **out of scope for v1**: a POS is foreground-active during trading hours, and the architecture makes background sync a nicety rather than a need.

### 17.3 Metered-network awareness

Large transfers — realistically only the device rebuild (§17.4) and the P1 snapshot backfill — ask before consuming cellular data:

```typescript
const conn = (navigator as any).connection;
const metered = conn?.type === 'cellular' || conn?.saveData === true;
if (transferEstimateBytes > 5_000_000 && metered) {
  await ui.confirm(`Rebuild needs ~${MB} over mobile data. Continue?`);
}
// The governor (§16.6) already caps everything else; this is a courtesy gate
// for the one genuinely large transfer a device ever makes.
```

### 17.4 Device rebuild — the 5 GB-friendly disaster story

A new or wiped device must never replay history from event zero (that would scale with *time*, the exact anti-delta this document exists to kill). Bootstrap instead:

```text
1. POST /pair            → device token (doc ② §10 flow, unchanged)
2. GET /bootstrap        → latest ProjectionSnapshot (gzip'd SQLite, tens of MB
                           even after years) + snapshot_hlc watermark
3. restore snapshot into local projections; set pull watermark = snapshot_hlc
4. GET /events?since=snapshot_hlc → the (small) tail; apply through apply_remote
5. device is live. Total bytes: bounded by state size, not by history length.
```

The same path is the disaster-recovery drill for §10.3's KPI ("recovery time: minutes"), and the archive job (§18.2) is built to keep it valid forever — snapshots are *never* archived away, only pre-snapshot events are.

### 17.5 The physical-device test matrix (chaos suite, mobile rows)

| Test | Device | Asserts |
|---|---|---|
| Airplane-mode mid-checkout | iPhone + Android | sale completes locally; flushes on reconnect; no dupes |
| Kill app mid-flush | iPhone + Android | partial batch re-sent; `INSERT OR IGNORE` absorbs it; state converges |
| Backgrounded 30 min → foreground | iPhone + Android | immediate pull on focus; UI current within ~2 s |
| Rebuild over 3G throttle | Android | snapshot bootstrap completes; courtesy gate shown (§17.3) |
| Clock skew +30 min (dev menu) | either | HLC absorbs skew; no watermark regression |
| Two phones + desktop, crossfire | all three | convergence per chaos suite; tickle latency < 5 s p95 |

These six rows run against the *same* Rust core that the desktop chaos suite (§10.2) already covers — the phone cases only add lifecycle and network-hostility, because the domain logic was never platform-specific to begin with.

---

## 18. Storage Hygiene & Turso Usage Discipline

The 5 GB must survive *storage* growth and the free tier must survive *usage* metering. Both are operations disciplines with a one-time setup and a monthly touch.

### 18.1 Device-side hygiene (set once, in the core)

```rust
// src-tauri/src/db.rs — applied at database creation, before any table exists
const PRAGMAS: &[&str] = &[
    "PRAGMA journal_mode = WAL;",          // crash-safe, concurrent reads
    "PRAGMA synchronous = NORMAL;",        // the standard WAL sweet spot
    "PRAGMA page_size = 4096;",            // must be set before schema
    "PRAGMA auto_vacuum = INCREMENTAL;",   // deletes can return pages to the OS
    "PRAGMA foreign_keys = ON;",
];
```

Why `auto_vacuum = INCREMENTAL` matters here: without it, SQLite *never* returns free pages to the file system — every delete/update cycle ratchets the file upward forever (leak #5 in §14.2, which is part of how your 36 MB/day happened). With incremental autovacuum, the monthly maintenance command reclaims space in bounded chunks:

```rust
// Maintenance command — exposed as `invoke('db_maintenance')`, run monthly
// (or on app start on the 1st of the month; takes < 2 s at POS scale)
pub fn monthly_maintenance(db: &Db) -> Result<()> {
    db.execute("PRAGMA wal_checkpoint(TRUNCATE);", ())?;   // shrink the WAL too
    db.execute("PRAGMA incremental_vacuum(256);", ())?;    // return up to 256 pages
    Ok(())
}
```

Device storage is bounded by design anyway — the local log truncates behind the oldest snapshot (§6.3) — so a device holds roughly `snapshot + tail + projections`, i.e., tens of MB, independent of store age. The pragmas are belt-and-braces so *nothing* on a device grows without bound.

### 18.2 Cloud-side hygiene (Turso)

**The plateau lever — cloud log archival to R2.** Turso keeps a rolling window; R2 keeps history; the budget in §15.2 assumed this job exists:

```text
Worker cron (monthly, or on-demand at budget Level 2):
 1. SELECT the events with hlc <= (oldest_snapshot_hlc - grace)   ← never
    archive anything a device rebuild might still need (§17.4:
    bootstrap = snapshot + tail, so pre-snapshot events are safe)
 2. stream them to R2 as NDJSON, gzip level 9
    (r2://mobipos-archive/2026-09/events-<hlc-range>.ndjson.gz)
 3. delete the range from Turso event_log           ← the plateau
 4. update log_stats counters; append an `ArchiveCompleted` event
    (the archive itself is now part of the audit trail)
 5. quarterly: VACUUM the Turso DB (supported since Turso v0.6.0)
    to return the freed pages to the file
```

The arithmetic that makes this safe forever: the 90-day window at *heavy* load is ~400 MB on Turso; 18 months of history compresses to ~250–400 MB in R2 (free tier: 10 GB, **zero egress** — verified). Turso's storage meter stops being a function of time and becomes a function of the window constant.

**Everything else on the cloud side is already lean by construction:**

- Telemetry (`/telemetry`, `SyncDayReported`) — 90-day TTL, deleted by the same cron.
- Read models (`r_*` tables) — rebuilt from the log; their size tracks *current state*, not history.
- No outbox, no per-device queues, no retained payloads — structurally impossible (§16.4).

### 18.3 Row-read discipline (the 500 M/month cap)

Turso bills every row *scanned* — including rows filtered out — so discipline means making every query's scanned-rows ≈ returned-rows. Five rules, enforced where possible by CI rather than by memory:

1. **One index serves the pull path**: `CREATE INDEX idx_event_hlc ON event_log(hlc);`. Create it at initial migration (on an empty/small table — index creation on a populated table itself scans every row, a one-time but real billing event Turso documents explicitly).
2. **Reconciliation is O(1), never O(N)**: maintain `log_stats(total_events, max_hlc, archived_through)` with an incremental `UPDATE … SET total_events = total_events + :k` inside the append batch. `/reconcile` then returns the fingerprint by *reading one row* — a `COUNT(*)` over the log would scan the whole index every call, the exact silent killer §14.2 leak #4 describes.
3. **`EXPLAIN QUERY PLAN` is a CI gate**: a unit test runs every Worker SQL statement against a seeded database and fails the build if the plan says `SCAN event_log` (or `SCAN` on any table expected to exceed 10 k rows). `SEARCH … USING INDEX idx_event_hlc` is the only acceptable shape for pull queries.
4. **Keep the planner informed**: run `ANALYZE` after the P1 snapshot backfill and after any bulk operation, so `sqlite_stat1` reflects reality.
5. **One round trip per batch**: appends go through libsql `batch()` — 500 envelopes cost one HTTP request Turso-side, not 500.

### 18.4 What doesn't change

Security posture (§8.3), the chaos suite (§10.2), and the KPI framework (§10.3) carry forward untouched; §19 extends the KPI table with the budget meters rather than replacing it.

---

## 19. Monitoring, Alerts & Budget Tests

A budget that isn't measured is a wish. The measurement system is — fittingly — built from the platform's own primitives: events.

### 19.1 The usage ledger (as events, of course)

Each device appends one `SyncDayReported` envelope per day (its ~400 bytes are inside the §15.2 model):

```jsonc
[1, "01J8…", "1726646400000:0:dev-04", "SyncDayReported", "dev-04", {
  "bytes_out": 184320, "bytes_in": 962560,        // counted at the socket, per §16.6
  "pushed": 214, "pulled": 1893,                   // envelopes
  "governor": "Normal",                            // Normal | Relaxed | Critical
  "app_version": "2.4.1", "platform": "ios"
}]
```

A Worker read model folds these into `r_usage_daily(device, day, bytes_out, bytes_in, envelopes, …)`, which makes **the monthly budget statement a single SQL query** — run it on the 1st of the month, read it in the admin panel:

```sql
SELECT day,
       SUM(bytes_out + bytes_in) / 1048576.0 AS wire_mb,
       SUM(envelopes)              AS envelopes,
       COUNT(DISTINCT device)      AS devices
FROM r_usage_daily WHERE day >= date('now', 'start of month')
GROUP BY day ORDER BY day;
```

Cloud-side meters (storage MB, row reads/writes) are read from the Turso dashboard during the same 5-minute review — §14.1's pragmas/bookmarks make that a 60-second check.

### 19.2 KPI additions (extends §10.3 — same table, new rows)

| KPI | Target | Instrument |
|---|---|---|
| `cloud_storage_growth_mb/day` | ≤ 2 (design), 5 (hard) | Turso dashboard + monthly statement |
| `row_reads/day` (cloud) | ≤ 50 k | Turso Usage tab |
| `wire_bytes/device/day` | ≤ 2 MB p95 | `SyncDayReported` |
| `governor_degradation_days/month` | 0 (any non-Normal day is investigated) | `SyncDayReported` |
| `archive_job_lag_days` | ≤ 40 (monthly job) | `ArchiveCompleted` events |

### 19.3 Alerts (free-tier friendly)

A daily Worker cron evaluates yesterday's ledger and the ladder from §15.3: **60%** of any monthly meter by day 20 → amber event + panel badge; **80%** → red event + governor clamp + early archive run. Delivery is a `BudgetAmber`/`BudgetRed` *event* into the log — the admin panel and a daily digest screen render it; no email infrastructure required, though a 10-line resend/notify.me hook can be added later if wanted.

### 19.4 Budget tests B-01…B-05 (extend the chaos suite §10.2)

These are the tests that make §15 a contract rather than a forecast. Each runs in CI against the device emulator + a Turso-identical local libsql instance (so CI itself burns zero quota):

| Test | Scenario | Asserts |
|---|---|---|
| **B-01 Busy day** | Fast-forward one heavy day: 2,000 checkouts + 140 misc events; one device online throughout | wire bytes < 5 MB · cloud storage Δ < 5 MB · row reads < 100 k · zero full-table scans in query log |
| **B-02 Idle online** | App foreground-idle 8 h, tickles only | wire bytes < 2 MB *including* safety polls · row reads < 5 k |
| **B-03 Retry storm** | Force 20 consecutive 5xx on `/append`, then recovery | zero duplicate `event_id` in cloud · retransmitted bytes ≤ 2× one batch · storage Δ = exactly the batch's |
| **B-04 Governor** | Set daily budget to 1 MB, replay B-01's traffic | cadence degrades Normal→Relaxed→Critical in order · business writes never blocked · `SyncDayReported` reflects actuals ±5% |
| **B-05 Archive round-trip** | Run archive job on a seeded 6-month log; rebuild a fresh device from snapshot+tail | device state ≡ reference device (replay equality, §9.2-1) · Turso-side event count == window size · R2 object count and bytes logged |

B-01 and B-03 are the regression tests for the exact failure you just lived through: **if anyone ever reintroduces a full pull, a retained queue, or a non-idempotent write path, the budget tests fail the build the same day, not the day your cloud runs out.**

---

## 20. The Consolidated Program — Ultra-Deep Migration, Best Result

v1.0's phases P0–P7 (§9) remain the backbone. v2.0 adds one **pre-phase** — because your cloud is bleeding *now*, and no 13-week program is an acceptable answer to an active leak — and weaves the three platforms and the budget workstream through every phase.

### 20.1 P-½ (week 0.5) — Stop the bleed on the CURRENT engine

Five changes, each 1–3 hours, each independently reversible, each deployable to today's production app **this week**. None of them is throwaway: every one is literally the final shape of the ES-LFP loop it foreshadows.

| # | Change | Files | Leak killed (§14.2) | Expected effect |
|---|---|---|---|---|
| 1 | **Purge the outbox on ack** — after a confirmed flush, `DELETE` acked rows (keep 7-day TTL copy in a `_recent` table for debugging if you must) | `outboxFlusher.ts` | #1 | storage growth drops by its largest term same-day |
| 2 | **Watermark the pulls** — add `last_pulled_seq` per table, `WHERE seq > :watermark ORDER BY seq LIMIT 500`, `CREATE INDEX` on `(seq)` for the 3 hottest tables; delete every full-table `SELECT` | `SyncManager.ts` | #3, #4 | row reads fall from O(table) to O(changes) per cycle |
| 3 | **Debounce + backoff the flush** — 5 s coalesce window; jittered exponential backoff 1→60 s on failure (doc ② §7.4 verbatim) | `outboxFlusher.ts` | #2 (frequency), #6 | retry storms stop multiplying |
| 4 | **Move data to HTTP, keep WS for signals** — payloads over `POST/GET` (edge-compressed); WS carries only "something changed" flags | relay Worker + `SyncManager.ts` | #6 | wire bytes −60–80% |
| 5 | **One-time cloud cleanup** — delete the outbox backlog and any duplicate rows you can identify, then `VACUUM` (supported since Turso v0.6.0) | maintenance script | #1, #2, #5 | reclaims most of the already-burned MB |

**Verification:** run the §14.1 diagnostic before and after; the target is **< 5 MB/day** within the week (from 36). You will not hit the §15 design target with these patches alone — that requires the idempotency and single-source-of-truth properties only ES-LFP gives you — but you will stop the emergency and buy the 13 weeks comfortably: at 5 MB/day, 5 GB lasts ~2.8 years even before the real migration lands.

### 20.2 P0–P7 with mobile and budget woven in (deltas to §9 only)

| Phase | v2.0 additions (everything else per §9) |
|---|---|
| **P0** Contract & skeleton | CI gains `tauri android build` and `tauri ios build` targets (compile-only; device tests come later). `PRAGMAS` from §18.1 land in the Db manager from day one. |
| **P1** Shadow event log | Interceptor derives events on **all three platforms** (the adapters are shared TS). Snapshot backfill batched per §16.2 discipline. Run the §14.1 diagnostic weekly — the event log must never appear as a new top-15 table beyond its modeled size. |
| **P2** Command flip | No changes. (Commands are platform-blind — that was the point of the Rust core.) |
| **P3** Reactive UI | Migrate screens in this order: desktop register → Android register → iOS register → back-office. Physical-device pass on each platform as its screens land. |
| **P4** Event sync online | Dual-run now includes **both physical phones + desktop**, and the B-01…B-04 budget tests enter the release gate on day one of the dual-run. Governor defaults from §16.6. |
| **P5** Cloud cutover | The monthly budget statement (§19.1) goes live; first archive cycle can wait until month 4 — but the job ships now and runs in dry-run mode. |
| **P6** Decommission | Dexie deletion happens on **all platforms**; P-½ patches deleted with the legacy engine (their work is done); §14.1 diagnostic bookmarks kept forever. |
| **P7** Compound payoff | Budget panel (§19) + audit workbench + device-rebuild drill — the drill now uses §17.4's snapshot bootstrap. |

**Timeline impact:** P-½ adds half a week; mobile testing adds 1–2 device-days per phase, absorbed by the existing soak windows. **Total: ~13.5–14 weeks**, with the cloud-burn emergency resolved in week 0.5 — not week 14.

### 20.3 The one-page program view

```text
WEEK 0.5   P-½  bleed-stop: purge, watermark, debounce, HTTP-data, vacuum   → <5 MB/day
WEEK 1     P0   contracts + skeleton + CI (3 platforms)
WEEKS 2-3  P1   shadow log + snapshot backfill + replay-equality gate      ← keystone
WEEKS 3-5  P2   command flip (risk-ordered, per-command flags)
WEEKS 5-7  P3   reactive UI (desktop → Android → iOS)
WEEKS 7-9  P4   event sync online, dual-run, B-01..B-04 in the gate
WEEKS 9-11 P5   cloud cutover + read models + budget statement live
WEEK 11-13 P6   decommission (one-release revert window)
CONTINUOUS P7   audit, time travel, rebuild drills, budget panel
```

---

## 21. Acceptance — The 5 GB Survival Proof

### 21.1 The proof, in one table

Consolidating §15.2 and §15.3 — this is the number you asked for, with the margins made explicit:

| | Quiet store | Typical store | Heavy store | 2× Heavy |
|---|---|---|---|---|
| Receipts/day | 200 | 800 | 2,000 | 4,000 |
| Events/day | ~240 | ~900 | ~2,180 | ~4,300 |
| Wire bytes/device/day | ~0.3 MB | ~0.8 MB | ~1.6 MB | ~3 MB |
| Cloud storage/day | ~0.4 MB | ~1.5 MB | ~3.5 MB | ~7 MB |
| Row reads/month | <0.3 M | ~0.8 M | ~1.5 M | ~3 M (of 500 M) |
| Row writes/month | <0.2 M | ~0.5 M | ~0.9 M | ~1.8 M (of 10 M) |
| **18-month storage, no archival** | ~210 MB | ~800 MB | **~1.9 GB** | ~3.8 GB |
| **Steady state with 90-day archival (§18.2)** | ~80 MB | ~180 MB | **~400 MB** | ~750 MB |

**Verdict:**

- Your requirement — 5 GB lasting 12–18 months — is met with **2.6× margin in the no-archival heavy case**, and with **~12× margin** once the archival job runs (month 4 onward, after which Turso storage *plateaus* permanently).
- The usage meters (row reads/writes — the ones that actually hard-stop a free plan) run at **3–9% of their monthly caps** at heavy load.
- The 36 MB/day baseline is a **7–90× reduction** depending on store volume — and, unlike today, every number in the table is *measured daily* (§19.1) and *regression-tested* (§19.4).

### 21.2 Sign-off checklist (the definition of done for v2.0)

- [ ] P-½ deployed; §14.1 diagnostic shows < 5 MB/day for 7 consecutive days
- [ ] B-01…B-05 green in CI, wired into the release gate at P4
- [ ] 30 consecutive days post-P5 within §15.1 design targets (2 MB/day, 50 k reads/day)
- [ ] First monthly budget statement reviewed (§19.1); governor has never entered Critical on a normal day
- [ ] One archive cycle executed; Turso storage demonstrably plateaued; R2 object restorable (B-05)
- [ ] Device-rebuild drill executed on a physical iPhone, Android phone, and desktop — each under 10 minutes, snapshot-bootstrapped
- [ ] The three keystone invariants (§9.2) still hold — because none of this efficiency work was allowed to touch them

### 21.3 Closing position

The question that opened v2.0 was "is there a better option?" The answer turned out to be the same architecture the correctness argument already chose — **event-sourced local-first, on SQLite, on all three platforms, at $0 infrastructure** — with the bytes discipline that the 36 MB/day incident demanded welded in as first-class law (R1–R6), budgeted (§15), measured (§19), and tested (B-01…B-05).

Five gigabytes was never the real constraint. The leaking engine was. The engine is replaced in week 0.5 and retired in week 13; everything between is the platform you keep.





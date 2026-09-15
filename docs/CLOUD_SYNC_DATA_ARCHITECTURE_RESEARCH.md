# MobiPOS Data Architecture & Cloud Synchronization Research
**Author:** Antigravity Autonomous Systems Architecture Group  
**Target Platform:** One Tauri v2 + Vue 3 Codebase across Desktop (Windows, macOS, Linux) and Mobile (Android, iOS)  
**Database Spine:** Local SQLite (WAL mode) + Remote Turso (LibSQL HTTP API) + Cloudflare Durable Objects Signal Relay  
**Document Status:** Master Architecture Reference & Operational Playbook  

---

## 1. Executive Summary & Topology

MobiPOS is an offline-first point-of-sale and business management platform designed for mobile electronics retailers, repair shops, and accessory merchants. It enables uninterrupted operations on desktop terminals while providing real-time store monitoring and auxiliary sales capabilities on mobile devices (Android & iOS).

The architecture adheres to three core distributed principles:
1. **The register keeps selling offline:** 100% of checkout, receipt generation, inventory decrement, and customer balance updates complete in milliseconds locally, completely independent of network connectivity.
2. **Local SQLite is the source of truth for the device; Turso Cloud is the source of truth for the merchant enterprise:** The user interface never writes directly to the cloud. All writes commit to a local SQLite database in Write-Ahead Logging (WAL) mode and are atomically staged in a local transactional outbox.
3. **Every mutation carries a globally unique idempotency key:** Retries across unreliable cellular connections (e.g., 3G/4G, captive portals) guarantee zero duplicate charges and zero double-counted stock deductions.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           LOCAL DEVICE TILL / PHONE                         │
│                                                                             │
│  ┌──────────────────────┐              ┌─────────────────────────────────┐  │
│  │    Vue 3 UI Layer    │              │       Local SQLite Database     │  │
│  │  (Reactive Pinia &   │──writeOps───▶│         (WAL Mode, Pragma)      │  │
│  │    TanStack Cache)   │              │                                 │  │
│  └──────────┬───────────┘              │  ┌───────────────────────────┐  │  │
│             ▲                          │  │  Domain Tables (Relational│  │  │
│             │                          │  │    + Document Lane)       │  │  │
│             │ (db:changed)             │  └─────────────┬─────────────┘  │  │
│             │                          │                │ (atomic tx)    │  │
│             │                          │  ┌─────────────▼─────────────┐  │  │
│  ┌──────────┴───────────┐              │  │        sync_outbox        │  │  │
│  │   SyncManager.ts     │              │  │   (Transactional Outbox)  │  │  │
│  │  - Outbox Flusher    │◀──pollPending┤  └─────────────┬─────────────┘  │  │
│  │  - Incremental Pull  │              └────────────────┼────────────────┘  │
│  └──────────┬───────────┘                               │                   │
└─────────────┼───────────────────────────────────────────┼───────────────────┘
              │ (1. wss:// "when" signal)                 │ (2. https:// "what" batch)
              ▼                                           ▼
┌───────────────────────────┐               ┌───────────────────────────┐
│   Cloudflare Relay DO     │               │   Turso Cloud (LibSQL)    │
│  /room/{merchant_id}      │               │  Dedicated Merchant DB    │
│                           │               │                           │
│  Broadcasts epoch signal  │               │  - Parent-ordered Upserts │
│  to all connected peers   │               │  - Monotonic Version OCC  │
│  (Desktop POS + Mobiles)  │               │  - Append-Only Ledgers    │
└───────────────────────────┘               └───────────────────────────┘
```

---

## 2. MobiPOS Domain Data Architecture

The data layer in MobiPOS uses a **Hybrid Relational + Document-Lane Pattern**. High-throughput query entities with tight integrity requirements exist as relational tables, while domain entities that require high flexibility across client versions live in document-lane tables containing structured envelope columns alongside a compressed `data_json` payload.

### 2.1 Entity Catalog & Storage Mode

| Entity Name | Storage Pattern | Local Table | Remote Turso Table | Primary Key | Key Invariants |
|---|---|---|---|---|---|
| **Products** | Relational Columnar | `products` | `products` | ULID / String | Barcode indexed; `stock` is a cached view; serialized flag controls IMEI prompt |
| **Transactions / Orders** | Relational Columnar | `transactions` | `transactions` | ULID / String | Unique `receipt_number`; immutable once `COMPLETED` or `VOIDED` |
| **Transaction Items** | Relational Columnar | `transaction_items` | `transaction_items` | ULID / String | Foreign key to `transactions(id)` with `ON DELETE CASCADE` |
| **Inventory Ledger** | Append-Only Delta | `inventory_ledger` | `inventory_ledger` | ULID / String | Delta integer; immutable audit trail of every stock change |
| **Customers** | Document-Lane | `customers` | `customers` | ULID / String | Phone number indexed; balance & loyalty points tracking |
| **IMEI / Serial Records** | Document-Lane + Fallback | `imei_records` | `imei_records` | IMEI String | State machine: `in_stock` $\to$ `sold` $\to$ `returned` $\to$ `defective` |
| **Repair Orders (SAV)** | Document-Lane | `repair_orders` | `repair_orders` | Ticket ULID | Status: `reçu` $\to$ `en diagnostic` $\to$ `en attente` $\to$ `réparé` $\to$ `livré` |
| **Purchase Orders** | Document-Lane | `purchase_orders` | `purchase_orders` | PO-ULID | Supplier link; items received increment ledger via `RECEIVE` |
| **Trade-In Buybacks** | Document-Lane | `trade_ins` | `trade_ins` | ULID | Device inspection grade; credit issued to customer wallet or cash paid |
| **Customer Debts (Kredy)** | Document-Lane | `customer_debts` | `customer_debts` | ULID | Credit ledger: debt created $\to$ partial repayment $\to$ settlement |
| **Cash Sessions & Shifts** | Document-Lane | `cash_sessions` | `cash_sessions` | ULID | Cashier float opening, expected cash, actual physical count, variance |
| **Cash Movements / Drops**| Document-Lane | `cash_movements` / `cash_drops` | `cash_movements` / `cash_drops` | ULID | Safe drops, cash injections, mid-shift payouts |
| **Store Expenses** | Document-Lane | `store_expenses` | `store_expenses` | ULID | Shop utility bills, rent, lunch expenses; deducted from net cash drawer |
| **Security Audit Logs** | Document-Lane | `security_audit_logs` | `security_audit_logs` | ULID | Security events: price overrides, cash drawer pops, manager voids |
| **Product Bundles** | Document-Lane | `product_bundles` | `product_bundles` | ULID | Virtual bundles (e.g. Phone + Screen Guard + Case) |
| **App Settings** | Key-Value / Doc-Lane | `app_settings` | `app_settings` | Setting Key | Store name, currency format, receipt layout, tax configurations |

---

### 2.2 Deep Dive: The Document-Lane Schema

The Document-Lane pattern provides schema resilience across multi-platform releases:
```sql
CREATE TABLE IF NOT EXISTS repair_orders (
  id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL DEFAULT '{}',
  device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_repair_orders_updated ON repair_orders(updated_at, id);
```

**Key Architectural Strengths:**
1. **Schema Immunity:** If mobile v1.7 introduces a new field (e.g., `device_passcode` or `technician_notes`) in `data_json`, desktop v1.6 can sync, store, and replicate this record without throwing `SQLITE_ERROR: table has no column named...`.
2. **Deterministic Query Envelope:** The columns `id`, `device_id`, `version`, `updated_at`, and `deleted` exist outside JSON, allowing high-performance SQL index scans (`WHERE updated_at > ? AND deleted = 0`) without parsing JSON strings in SQLite or Turso.
3. **Soft Deletions:** Deleting an entity sets `deleted = 1` and bumps `version` and `updated_at`. This tombstone replicates to all peer devices, ensuring that an entity deleted on the desktop is reliably removed on all phones.

---

### 2.3 Deep Dive: The Append-Only Inventory Ledger

In MobiPOS, product stock is **never updated directly with an absolute value** (`UPDATE products SET stock = 5`). Direct assignment in distributed systems causes catastrophic silent overwrites when two devices sell offline simultaneously.

Instead, MobiPOS uses a pure **CRDT-inspired Delta Ledger**:
```sql
CREATE TABLE IF NOT EXISTS inventory_ledger (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL, -- 'SALE', 'VOID', 'REFUND', 'RECEIVE', 'ADJUST', 'SEED'
  ref_type TEXT,        -- 'transaction', 'repair', 'purchase_order', 'manual'
  ref_id TEXT,
  device_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
```

- **Stock Calculation:** Local and remote stock is computed via:
  $$\text{Effective Stock} = \sum \text{delta}$$
- **Products Cache:** `products.stock` is a materialized cache updated locally by triggers or adapter code for instant UI rendering.
- **Commutative Convergence:** Because addition is commutative ($a + b = b + a$), ledger entries sync in any order across devices without corrupting total inventory.

---

### 2.4 Financial Accuracy & Money Representations

Point-of-sale systems must maintain zero-drift financial integrity.
1. **Integer Minor Units:** All monetary values in core calculations are treated as integer minor units (Algerian Centimes, where 1 DZD = 100 Centimes).
2. **Float Precision Traps:** In JavaScript and standard SQLite `REAL`, floating-point arithmetic introduces IEEE-754 precision errors (e.g. `0.1 + 0.2 = 0.30000000000000004`). In a store doing 10,000 transactions a month, floating-point drift can result in end-of-day cash variances of several hundred dinars.
3. **Dual Representation Strategy in MobiPOS:**
   - In SQLite/Turso tables: Columns like `subtotal`, `total`, `cost_total` are preserved as numeric numbers for SQL reporting, while `data_json` and `json_payload` preserve exact precision integer strings.
   - Rust Core (`crates/pos-core`): Financial math is executed with `rust_decimal` or signed 64-bit integers (`i64`), compiled into all platforms.

---

## 3. Turso Cloud Synchronization Engine

Turso is a distributed database powered by LibSQL (an open-source fork of SQLite). MobiPOS uses Turso to maintain a cloud replica for each merchant store.

### 3.1 Tenancy & Security Model
- **Dedicated Database per Merchant:** Each merchant has a completely isolated database (e.g., `libsql://mobipos-store-xyz.turso.io`). 
- **Zero Cross-Tenant Leakage:** No shared tenant tables with `tenant_id` WHERE clauses. A security flaw or rogue query can never access another merchant's transactions or customer ledger.
- **Encrypted Transport & JWT Auth:** All communication occurs over TLS 1.3 via HTTP/2 or WebSockets using short- or long-lived JWT bearer tokens.

### 3.2 Secure Credential Storage Matrix
Credentials (Turso URL and Auth Token) are sensitive. If compromised, an attacker could read or alter sales records.

| Platform | Primary Security Vault | Fallback Mechanism | Invariants |
|---|---|---|---|
| **Windows** | Windows Credential Manager (DPAPI) via Rust `keyring` crate | Encrypted local vault file in `app_data_dir()` | Never in plaintext registry or unencrypted `.json` |
| **macOS** | Apple Keychain Services | Encrypted file in Application Support | Redacted from all debug logs (`[REDACTED]`) |
| **Linux** | Secret Service API (Freedesktop Secret Service) | Local vault file with restricted permissions (`0600`) | Protected from standard user read |
| **Android** | Android Keystore + `EncryptedSharedPreferences` / App Data Dir | Private app sandboxed directory (`Context.MODE_PRIVATE`) | Survives app updates; deleted on uninstall |
| **iOS** | iOS Keychain (`kSecClassGenericPassword`) | Sandboxed Documents Directory | Excluded from iCloud backup (`isExcludedFromBackup`) |

---

### 3.3 The Transactional Outbox Pattern (`sync_outbox`)

The fundamental law of offline-first POS is: **Never make a network call inside a user checkout transaction.**

When a cashier taps "Validate Sale":
1. A local SQLite transaction begins: `BEGIN IMMEDIATE;`
2. Rows are inserted into `transactions`, `transaction_items`, and `inventory_ledger`.
3. An outbox mutation record is enqueued into `sync_outbox` in the **exact same SQLite transaction**:
   ```sql
   INSERT INTO sync_outbox (
     idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count, next_retry_at, last_error
   ) VALUES ($1, 'order', $2, 'UPSERT', $3, 'pending', 0, NULL, NULL)
   ON CONFLICT(idempotency_key) DO UPDATE SET
     payload_json=excluded.payload_json,
     updated_at=excluded.updated_at,
     status='pending',
     retry_count=0,
     next_retry_at=NULL,
     last_error=NULL;
   ```
4. The SQLite transaction commits: `COMMIT;`
5. The receipt prints immediately. Total elapsed time: `< 15 ms`.

#### Outbox State Machine & Lifecycle
```
                 ┌──────────────┐
                 │   PENDING    │◀─────────────────────────┐
                 └──────┬───────┘                          │
                        │ (Outbox flusher acquires batch)  │
                        ▼                                  │
                 ┌──────────────┐                          │ (App boot recovery:
                 │   INFLIGHT   │                          │  reset inflight to pending)
                 └──────┬───────┘                          │
                        │                                  │
           ┌────────────┴────────────┐                     │
           │ HTTP Batch Success      │ HTTP Network Error  │
           ▼                         ▼                     │
    ┌─────────────┐           ┌──────────────┐             │
    │   SYNCED    │           │    FAILED    │─────────────┘
    │  (Deleted   │           │ (Exponential │ (After backoff timer expires)
    │   from DB)  │           │   Backoff)   │
    └─────────────┘           └──────────────┘
```

1. **Pending:** Mutation saved locally, waiting to be sent to Turso.
2. **Inflight:** Flusher picked up the record and transmitted the HTTP payload.
3. **Synced:** Turso confirmed write with HTTP 200 OK. The record is permanently deleted from `sync_outbox` to keep the table lean.
4. **Failed:** Network timed out or server returned a retryable error (5xx, 429). The flusher calculates exponential backoff with full jitter:
   $$\text{Backoff} = \min(300000, 1000 \times 2^{\min(\text{retry}, 8)} + \text{rand}(0, 500)) \text{ ms}$$
5. **Boot Recovery:** If the computer loses power or the OS kills the process while rows are `inflight`, the next app startup immediately executes:
   ```sql
   UPDATE sync_outbox SET status = 'pending' WHERE status = 'inflight';
   ```
   This guarantees **zero silent mutation loss**.

---

### 3.4 Push Protocol & Dependency Ordering

Relational constraints on Turso (`REFERENCES products(id)`, `REFERENCES transactions(id)`) require mutations to be written in **strict topological order**. If an order item is pushed before its parent product exists on Turso, foreign key constraints will reject the write.

MobiPOS implements strict **Topological Dependency Ranking**:

| Rank | Entity Type | Rationale |
|---|---|---|
| **Rank 0 (Root Nodes)** | `product`, `customer`, `setting`, `bundle` | Independent entities with no parent foreign keys |
| **Rank 1 (Parent Documents)**| `order`, `repair_order`, `purchase_order`, `trade_in`, `cash_session` | Depends on customers/cashiers existing |
| **Rank 2 (Leaf / Audits)** | `order_item`, `ledger`, `imei`, `cash_movement`, `cash_drop`, `store_expense`, `audit_log` | Depends on orders/products/sessions existing |

When flushing:
1. Mutations are fetched: `SELECT * FROM sync_outbox WHERE status = 'pending' ORDER BY rowid ASC LIMIT 100`.
2. Items are sorted in memory by `rankEntity(a) - rankEntity(b)`.
3. The batch is sent to Turso using LibSQL batch execution: `client.batch(statements, 'write')`.
4. If a batch write fails due to an isolated constraint violation, the engine automatically falls back to sequential single-statement execution, quarantining only the failing record while letting valid records push successfully.

---

### 3.5 Pull Protocol & Remote Ingestion

The pull engine operates continuously to ingest changes made by other registers or the owner's mobile device:
1. **Incremental Cursor Scanning:** Each table maintains an `updated_at` cursor in local storage (`last_sync_timestamp`).
2. **Query:**
   ```sql
   SELECT * FROM remote_table WHERE updated_at > ? ORDER BY updated_at ASC LIMIT 250;
   ```
3. **Local Upsert with Echo Suppression:**
   When writing pulled rows into local SQLite, MobiPOS sets `sync_status = 'synced'` and **does not insert into `sync_outbox`**. This prevents an infinite sync echo loop where device A pushes to cloud, device B pulls from cloud, and device B re-pushes the same record back to cloud.
4. **Optimistic Concurrency Guard (OCC):**
   ```sql
   INSERT INTO table (id, ..., version, updated_at) VALUES (...)
   ON CONFLICT(id) DO UPDATE SET
     ...
     version = excluded.version,
     updated_at = excluded.updated_at
   WHERE excluded.version >= table.version;
   ```
   If a local record has a higher version than the incoming remote record, the local write is preserved.

---

## 4. Real-Time Signaling & Cross-Device Convergence (Contract C1)

Contract C1 mandates: **A sale made on the desktop POS must appear on the owner's phone in $\le 1.5$ seconds p95.**

### 4.1 Separation of "When" vs "What"

Querying Turso every 500 milliseconds across cellular connections consumes prohibitive battery power and exhausts Turso read quotas. MobiPOS decouples signaling from data transfer:
- **"When" (Signaling Channel):** Carried over lightweight WebSockets connected to a Cloudflare Worker backed by Durable Objects (`/merchant-room/{merchant_id}`). Payload size: $\approx 60 \text{ bytes}$.
- **"What" (Data Channel):** Carried over LibSQL HTTPS protocol directly between the device and Turso.

```
Desktop POS                        Cloudflare DO Relay                        Mobile Phone
    │                                       │                                       │
    │──1. Push sale batch to Turso ────────────────────────────────────────────────▶│ (Turso Cloud)
    │   (HTTP 200 OK)                       │                                       │
    │                                       │                                       │
    │──2. Send signal: {type: 'db:changed', epoch: 42} ─────────────────────────────▶│
    │                                       │──3. Broadcast signal to room ────────▶│
    │                                       │                                       │──4. Receive signal
    │                                       │                                       │──5. Immediate pullOnce()
    │                                       │                                       │◀── (Fetches delta)
    │                                       │                                       │──6. UI updates live
    │                                       │                                       │     (Total: ≤ 450ms)
```

### 4.2 Durable Object Architecture (`workers/relay/`)

The Cloudflare Worker manages merchant rooms using the **Durable Objects WebSocket Hibernation API**:
- **Zero Cost Idle:** When no messages are passing through the socket, the Durable Object hibernates in memory, incurring zero CPU cost while keeping the TCP socket open at Cloudflare's edge.
- **Room Isolation:** Each merchant is assigned an isolated Durable Object room based on their hashed Turso database hostname. Store A cannot eavesdrop on Store B.
- **Heartbeat Ping/Pong:** Every 30 seconds, the client sends a `ping` frame; the relay replies with `pong`. If no reply is received within 10 seconds, the socket enters reconnect mode.
- **Epoch Guard:** Every broadcast increments a room-wide monotonic integer `epoch`. If a device reconnects after being offline, it compares its local epoch with the server's epoch. If there is a discrepancy $> 1$, it executes a full catch-up pull.

### 4.3 Resilience & Adaptive Polling Fallback

If a mobile device is connected to a restrictive network that blocks WebSockets (e.g., certain cellular carriers, airport Wi-Fi, corporate firewalls):
1. The WebSocket connection fails or times out.
2. The `SyncManager` detects relay disconnect and seamlessly activates **Adaptive Polling Fallback**:
   - Mobile active screen: Polls Turso every 6 seconds.
   - Desktop register: Polls Turso every 3 seconds.
3. When the network unblocks, WebSocket reconnects with exponential backoff and jitter, immediately stepping down the polling rate to conserve bandwidth.

---

## 5. Exhaustive Edge-Case Compendium & Mitigations

Distributed offline-first databases face subtle failure modes. Below is the comprehensive compendium of edge cases and their architectural solutions in MobiPOS.

---

### 5.1 Edge Case 1: Clock Skew Across Multi-Device Environments

#### Scenario
A tablet register has its manual clock set to 2 hours behind real time (e.g., 14:00 instead of 16:00) due to dead CMOS battery or manual user alteration. A cashier at the main terminal (16:05) updates a customer's credit limit. Five minutes later (14:10 on tablet time), the tablet cashier edits the customer's phone number.

#### Danger in Naive Systems
If the system uses standard Last-Write-Wins based on timestamps (`WHERE excluded.updated_at > table.updated_at`), the main terminal's update (16:05) will permanently overwrite the tablet's newer edit (14:10) because `16:05 > 14:10`.

#### MobiPOS Mitigation
1. **Monotonic Version Counters:** Every mutation increments the entity's integer `version`:
   $$\text{version}_{\text{new}} = \text{version}_{\text{current}} + 1$$
2. **OCC Guard:** Upserts enforce:
   ```sql
   WHERE excluded.version >= table.version
   ```
   The tablet's edit advances version $v \to v+1$. Because $v+1 > v$, the edit succeeds regardless of wall-clock skew.
3. **UTC Invariant:** All generated timestamps strictly use ISO 8601 UTC with milliseconds: `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. Local offsets are formatted only at the presentation layer.

---

### 5.2 Edge Case 2: Concurrent Offline Checkout & Inventory Depletion

#### Scenario
A store has 1 unit remaining of an expensive smartphone (SKU: `IPHONE-15-128`). The store experiences an internet blackout.
- Cashier A (Terminal 1) sells the last phone offline at 10:00:00.
- Cashier B (Mobile Phone) sells the same phone offline to another customer at 10:00:05.
- Both devices show the sale as successful to their respective customers.
- At 10:05:00, the internet reconnects, and both devices sync to Turso.

#### Danger in Naive Systems
1. If the database enforces `CHECK (stock >= 0)`, the second transaction fails to sync to the cloud, creating a rejected sale that was already tendered to a customer with printed receipt.
2. If the database uses absolute stock overwrites (`SET stock = 0`), the second sale disappears from stock accounting.

#### MobiPOS Mitigation
1. **Financial Checkout Invariant:** The point-of-sale **must never reject an already-completed financial transaction**. Money was collected; the transaction is immutable.
2. **Ledger Delta Application:**
   - Terminal 1 pushes delta: `-1` (id: `ledg-001`, stock drops $1 \to 0$).
   - Terminal 2 pushes delta: `-1` (id: `ledg-002`, stock drops $0 \to -1$).
3. **Negative Stock Reconciliation:** Total stock converges to `-1`.
4. **Stock Variance Alert:** The inventory system flags SKU `IPHONE-15-128` with a **Critical Inventory Variance Alert** (`Negative Stock Detected: -1 unit`). The store manager is notified to verify physical stock, initiate a vendor backorder, or process a customer return/swap.

---

### 5.3 Edge Case 3: Network Drop Mid-Commit & Idempotent Replays

#### Scenario
The client sends an HTTP batch containing an order of 25,000 DZD to Turso. Turso receives the request, writes the records to disk, and commits the transaction. However, before Turso can transmit the `200 OK` response back over cellular radio, the connection drops. The client's TCP connection aborts with `ECONNABORTED` / `FetchError`.

#### Danger in Naive Systems
The client assumes the write failed and puts the transaction back in `sync_outbox`. When connectivity restores, the client resends the order. Without idempotency, a second sale is recorded, customer loyalty points are awarded twice, and inventory is deducted twice.

#### MobiPOS Mitigation
1. **Globally Unique Idempotency Keys:** Every order, item, and ledger delta generates a unique ULID idempotency key before entering `sync_outbox`:
   - Example: `tx-01J7K8M9...`
2. **Turso Unique Constraint:**
   ```sql
   CREATE TABLE transactions (
     ...
     idempotency_key TEXT NOT NULL UNIQUE
   );
   ```
3. **Idempotent Upsert Handling:**
   ```sql
   INSERT INTO transactions (...) VALUES (...)
   ON CONFLICT(idempotency_key) DO UPDATE SET
     version = MAX(transactions.version, excluded.version),
     updated_at = excluded.updated_at;
   ```
   When the retried HTTP batch arrives, Turso matches the existing `idempotency_key` and performs a no-op update rather than creating a duplicate row.
4. **Outbox Deletion:** The client receives `200 OK` on retry and safely removes the entry from `sync_outbox`. Duplicate charges = **ZERO (Contract C5)**.

---

### 5.4 Edge Case 4: Mobile Background Execution Throttling (Android Doze / iOS Suspend)

#### Scenario
A store owner opens the MobiPOS companion app on iPhone or Android, checks sales, and locks the phone or switches to another app. The mobile operating system places the webview and JavaScript engine into deep sleep / hibernation after 30–60 seconds.

#### Danger in Naive Systems
1. The WebSocket connection closes or enters a "half-open" state where the OS drops TCP packets without notifying the client.
2. When the owner unlocks the phone 3 hours later, the app displays stale numbers from 3 hours ago, deceiving the owner into thinking no sales occurred.

#### MobiPOS Mitigation
1. **Lifecycle Event Hooks:**
   The `SyncManager` binds to browser/webview visibility events:
   ```typescript
   document.addEventListener('visibilitychange', () => {
     if (document.visibilityState === 'visible') {
       this.kick(); // Immediate push/pull cycle
     }
   });
   ```
2. **Reconnection on Focus:**
   The instant the app returns to the foreground:
   - It verifies WebSocket liveness with an immediate heartbeat ping. If dead, it instantly re-establishes the socket.
   - It kicks an immediate `pullOnce()` to fetch all mutations that occurred while the phone was asleep.
3. **Staleness Badge Indicator:**
   If last sync timestamp $> 60 \text{ seconds}$, the UI displays an amber status badge: `"Synchronisation en cours..."`, preventing the owner from reading stale sales data as current.

---

### 5.5 Edge Case 5: Large Binary Blobs & Image Payload Explosions

#### Scenario
A cashier takes photos of physical damage on a phone brought in for repair (SAV). Each camera photo is 4–8 MB JPEG. The photo is stored inside the repair ticket record.

#### Danger in Naive Systems
If the base64 image data is embedded inside `data_json` or pushed to Turso LibSQL:
- An HTTP batch with three photos reaches 25 MB, exceeding LibSQL HTTP request size limits and causing `413 Payload Too Large`.
- The outbox flusher retries indefinitely, blocking all other sales and inventory updates behind it (Head-of-Line Blocking).
- Database size explodes, exhausting Turso storage quotas.

#### MobiPOS Mitigation
1. **Automatic Image Stripping in Sync Pipeline:**
   In `src/sync/SyncManager.ts` (`toRemoteUpsert`):
   ```typescript
   const payload = { ...row.payload };
   if ('imageUrl' in payload) delete payload.imageUrl;
   if ('image_url' in payload) delete payload.image_url;
   if ('photos' in payload) delete payload.photos;
   ```
2. **Local Storage Only:** Full image bytes are saved strictly on the local device filesystem (`app_data_dir()/receipts` or `app_data_dir()/sav_photos`).
3. **Dedicated Object Storage for Cloud Attachments:** When cloud photo sharing is enabled, binary files are uploaded directly to Cloudflare R2 / S3 via pre-signed URLs, storing only the resulting lightweight URL (`https://cdn.mobipos.app/img/...`) in the database.

---

### 5.6 Edge Case 6: Poison-Pill Outbox Records & Head-of-Line Blocking

#### Scenario
Due to a software bug or corrupted local database state, a single outbox record contains an invalid payload that causes a non-retryable SQL error on Turso (e.g., `CHECK constraint failed` or `Data type mismatch`).

#### Danger in Naive Systems
If the flusher stops at the first error, the poisoned record stays at the front of the queue (`rowid 101`). Every sync attempt fails, and subsequent valid sales (rows 102, 103, 104) are never uploaded to the cloud.

#### MobiPOS Mitigation
1. **Retry Ceiling & Dead-Letter Quarantine:**
   Each outbox row tracks `retry_count`.
   - When `retry_count >= 10`: The flusher marks the row as `status = 'failed'` and sets `next_retry_at = NULL`.
   - The flusher logs the event to `sync_audit_logs` with the full error message and payload.
   - The queue advances to the next record, completely eliminating Head-of-Line Blocking.
2. **Manager Outbox Inspector:** The settings panel contains an Outbox Inspection tool allowing the administrator to inspect, retry, or purge quarantined records.

---

### 5.7 Edge Case 7: Schema Drift & Client Version Skew

#### Scenario
The store operates three terminals:
- Main Terminal: Updated to MobiPOS `v1.7.0` (introduces new column `supplier_tax_id` on purchase orders).
- Backup Laptop: Running MobiPOS `v1.6.2`.
- Mobile Phone: Running MobiPOS `v1.6.5`.

#### Danger in Naive Systems
If v1.7.0 runs a migration that drops or renames columns, older clients crash on boot or throw syntax errors during pull.

#### MobiPOS Mitigation
1. **Additive-Only Migrations:** The schema engineering rule strictly forbids `ALTER TABLE ... DROP COLUMN` or changing column data types.
2. **Document-Lane JSON Elasticity:** Any new attributes introduced in newer software versions reside inside `data_json`. Older clients ignore unknown keys inside JSON; newer clients read them.
3. **Safe Remote Column Ensuring:** Before pushing to Turso, `ensureRemoteSchemaColumns()` queries `PRAGMA table_info` on the remote database and issues non-destructive `ALTER TABLE ... ADD COLUMN` statements dynamically if a required column is missing.

---

### 5.8 Edge Case 8: Cash Register Drawer & Shift Reconciliation Races

#### Scenario
Cashier 1 opens shift at 08:00 with 10,000 DZD float. At 14:00, Cashier 1 performs a Cash Drop of 50,000 DZD to the store safe. The network is down. At 14:02, the manager logs in on the mobile app and reviews the cash session.

#### Danger in Naive Systems
If the mobile app assumes local cash state is final, the manager sees 60,000 DZD expected cash instead of 10,000 DZD, suspecting a cash discrepancy.

#### MobiPOS Mitigation
1. **Session-Bound Idempotent Movements:** Every cash drop, payout, and addition is an immutable row in `cash_movements` linked to `cash_session_id`.
2. **Pending Sync Badge on Shifts:** The mobile companion explicitly displays:
   `"Session #12: 3 mouvements locaux en attente de synchronisation sur la caisse principale"`.
3. **Reconciliation Invariant:** Closing a cash shift computes the final discrepancy only after all session outbox records have confirmed receipt on Turso (`pending_outbox_count == 0`).

---

## 6. Verification, Testing & Benchmarking Protocols

To ensure compliance with the six engineering contracts (C1 to C6), the following automated verification suites are established:

### 6.1 Contract C1: Two-Device Latency Benchmark (`scripts/test_sync_contract_c1.mjs`)
- **Setup:** Two simulated headless client instances (Terminal A and Phone B) connected to the same Turso test database and Cloudflare DO relay.
- **Execution:** Terminal A writes a sale of 3 items with payment. Terminal A records timestamp $T_0$. Phone B listens for WebSocket `db:changed`, pulls from Turso, and records timestamp $T_1$.
- **Pass Threshold:** $T_1 - T_0 \le 1500 \text{ ms}$ across 100 consecutive iterations (p95).

### 6.2 Contract C2: Airplane-Mode Chaos Suite
- **Setup:** Network interface is disabled via OS script during an active checkout sequence.
- **Verification:**
  1. Checkout completes in $< 50 \text{ ms}$ with printed receipt.
  2. Local SQLite shows transaction with `sync_status = 'pending'`.
  3. `sync_outbox` contains the order, order_items, and ledger records.
  4. Network interface is re-enabled.
  5. Flusher drains the queue within 3 seconds. Remote Turso contains identical transaction and stock levels.

### 6.3 Contract C5 & C6: Power-Cut Replay & Recovery Simulation
- **Setup:** A worker process inserts 50 orders while randomly executing `process.kill(pid, 'SIGKILL')` midway through outbox flushing.
- **Verification:**
  1. Database restarts and runs SQLite WAL recovery automatically.
  2. `UPDATE sync_outbox SET status='pending' WHERE status='inflight'` recovers orphaned inflight records.
  3. All 50 transactions exist on Turso without duplicates.
  4. Discrepancy count = 0.

---

## 7. Operational Guidelines for Future Development

When modifying or extending data models and sync code in MobiPOS, every engineer or agent **MUST** follow these rules:

1. **Never write raw SQL in the UI Layer:** All SQL queries must live inside `src/db/` or `crates/pos-core`. The Vue components interact strictly through typed repository interfaces.
2. **Always enclose mutations and outbox entries in the same transaction:**
   ```typescript
   await db.execute('BEGIN IMMEDIATE TRANSACTION');
   try {
     await db.execute('INSERT INTO ...');
     await db.execute('INSERT INTO sync_outbox ...');
     await db.execute('COMMIT');
   } catch (err) {
     await db.execute('ROLLBACK');
     throw err;
   }
   ```
3. **Never store binary image data in SQLite or Turso:** Photos and document scans belong on disk or Cloudflare R2.
4. **Never assign absolute stock:** Always use `inventory_ledger` deltas (`+N` or `-N`).
5. **Preserve the `last_error` and `error` column compatibility** in `sync_outbox` to prevent migration crashes on older app installations.

---
*Document permanently committed to repository version control under `docs/CLOUD_SYNC_DATA_ARCHITECTURE_RESEARCH.md`.*

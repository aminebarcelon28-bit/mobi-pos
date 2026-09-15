# Tauri v2 POS — Engineering Standards & Development Patterns

> The complete rulebook for building a production Tauri v2 point-of-sale desktop app: React + TypeScript frontend, Rust backend, SQLite offline-first data layer, Supabase cloud sync (Postgres + Realtime + Auth + Storage), a Next.js storefront whose sales flow into the POS, and GitHub Actions pipelines that build, sign, and auto-update the app on Windows, macOS, and Linux.

**Version:** 1.0 (researched against Tauri 2.9.x, September 2026)
**Convention:** `MUST` = non-negotiable. `SHOULD` = strong default; deviating requires a stated reason. `MAY` = discretionary.
**Companion document:** this file extends the repo-wide `DEVELOPMENT_STANDARDS.md` (clean code, security, testing, review process). Where the two overlap, the stricter rule wins; where this file is Tauri-specific, this file wins.

---

## Table of Contents

- [0. The System: Architecture & Stack Decisions](#0-the-system-architecture--stack-decisions)
- [1. Project Scaffolding & Repository Layout](#1-project-scaffolding--repository-layout)
- [2. Frontend Standards (React + TypeScript)](#2-frontend-standards-react--typescript)
- [3. Tauri Frontend Integration Rules](#3-tauri-frontend-integration-rules)
- [4. Rust Backend Standards](#4-rust-backend-standards)
- [5. Tauri v2 Security: Capabilities, Permissions, CSP](#5-tauri-v2-security-capabilities-permissions-csp)
- [6. Local Data Layer: SQLite](#6-local-data-layer-sqlite)
- [7. Networking, Auth & Secrets](#7-networking-auth--secrets)
- [8. Cloud Storage](#8-cloud-storage)
- [9. The Website → POS Sales Pipeline](#9-the-website--pos-sales-pipeline)
- [10. Auto-Update & Release Management](#10-auto-update--release-management)
- [11. GitHub & CI/CD Pipelines](#11-github--cicd-pipelines)
- [12. Testing](#12-testing)
- [13. Performance](#13-performance)
- [14. Observability](#14-observability)
- [Appendix A: Cheat Sheet](#appendix-a-cheat-sheet)
- [Appendix B: Data Contracts](#appendix-b-data-contracts)
- [Appendix C: Repo Bootstrap Checklist](#appendix-c-repo-bootstrap-checklist)

---

## 0. The System: Architecture & Stack Decisions

### 0.1 What We Are Building

A retail POS desktop application built on **Tauri v2** (Rust core, webview UI — no Electron tax), paired with an online storefront. Sales made on the website appear in the POS in real time; sales made at the counter sync back up when the register is online. The register keeps selling through internet outages. One codebase ships to Windows, macOS, and Linux, updates itself, and talks to one cloud backend that both surfaces share.

### 0.2 The Stack (Decision Record)

| Layer | Choice | Why This One |
|---|---|---|
| Desktop shell | **Tauri 2.9.x** (Rust) | ~10 MB bundles vs Electron's ~100 MB; native performance; first-class updater, SQL, HTTP plugins; mature as of 2026 |
| Frontend | **React 19 + TypeScript (strict) + Vite** | Largest Tauri ecosystem, official `create-tauri-app` template, hiring pool, component libraries |
| Local database | **SQLite** via `tauri-plugin-sql` | Offline-first is a POS *requirement*, not a feature; SQLite is the proven answer; plugin ships migrations |
| Cloud backend | **Supabase** (Postgres + Auth + Realtime + Storage + Edge Functions) | One backend serves both surfaces; realtime `postgres_changes` pushes website orders to the POS over websockets; RLS secures multi-tenant data; no server to operate |
| Storefront | **Next.js** (separate app in the same repo) | Writes orders to the same Postgres; shares types via a `shared/` package |
| State / data-fetch | **TanStack Query** + **Zustand** (light client state only) | Query owns server state, caching, retries; Zustand owns UI state; never blur the two |
| Styling | **Tailwind CSS** | Speed, consistency, zero runtime cost — matters in a kiosk-style app |
| CI/CD | **GitHub Actions** + **tauri-action** | Official path: matrix builds, signing, draft releases, updater manifests |
| Auto-update | **tauri-plugin-updater** + signed `latest.json` | Supported on Windows/macOS/Linux (not mobile — desktop is our target) |

**Drift rule:** this table is a decision record, not a law of physics. Revisit at the quarterly review (per `DEVELOPMENT_STANDARDS.md` Appendix C). What MUST NOT drift silently: one frontend framework, one database, one cloud backend. Two of any of those means two of everything downstream.

### 0.3 System Map

```
┌─────────────────────────┐         ┌──────────────────────────────┐
│  POS DESKTOP (Tauri v2) │         │  WEBSITE (Next.js storefront) │
│                         │         │                              │
│  React UI (webview)     │         │  Product catalog / cart /    │
│    │  invoke() / events │         │  checkout                    │
│  Rust core (commands)   │         │    │                         │
│    │                    │         │    │ Supabase JS client       │
│  SQLite (source of      │         │    ▼                         │
│   truth for the till)   │         │  Auth (customer session)     │
│    │                    │         └──────────┬───────────────────┘
│    │ Supabase JS        │                    │ insert orders (RLS-guarded)
│    │ + realtime channel │                    ▼
└────────┬────────────────┘   ┌────────────────────────────────────┐
         │                    │           SUPABASE (cloud)          │
         │  ┌────────────────▶│  Postgres: products, orders,        │
         │  │                 │  order_items, stores, users          │
         │  │  realtime:      │  Realtime: postgres_changes →        │
         │  │  new orders     │  "orders" channel broadcasts INSERTs │
         │  └─────────────────│  Auth: staff accounts, JWT           │
         │                    │  Edge Functions: payment webhooks,   │
         │  outbox upload     │  order enrichment, receipt emails    │
         └────────────────────│  Storage: product images, receipts   │
                              └────────────────────────────────────┘
         ▲
         │ signed updates + latest.json
   GitHub Releases (tauri-action matrix builds)
```

The four flows that everything else in this document serves:

1. **Website → POS (realtime):** customer checks out → Next.js inserts an `orders` row (authed by RLS-safe path or an Edge Function) → Realtime `postgres_changes` fires → the POS's subscribed channel receives the INSERT → Rust inserts it into local SQLite → the open orders view updates live.
2. **POS → cloud (outbox):** cashier rings a sale → written to SQLite inside a transaction together with an `outbox` row → a background sync worker uploads it with an idempotency key when connectivity allows → cloud upserts by key → duplicates are structurally impossible.
3. **Catalog → both surfaces:** product/price changes in Postgres flow down to the POS (pull-on-start + realtime ping) and out to the website from the same tables. One price, everywhere, always.
4. **Updates → POS:** tag pushed → GitHub Actions builds + signs per platform → release + `latest.json` published → running POS checks the updater endpoint, verifies the signature, self-updates.

### 0.4 Non-Negotiables (the five sentences of this document)

1. **The till keeps selling offline.** Every sale path works with the network down; sync is a background concern, never a checkout gate.
2. **SQLite is the source of truth for the terminal; Postgres is the source of truth for the business.** Never let the UI write to both.
3. **Every sync payload carries an idempotency key.** Retries are guaranteed to happen; duplicates are a choice.
4. **Least privilege in the capabilities file, secrets in the OS keychain, validation at every boundary.** (§5, §7)
5. **If it isn't in CI, it doesn't exist.** Builds, tests, migrations, releases — all machine-enforced (§11).

---

## 1. Project Scaffolding & Repository Layout

### 1.1 Bootstrap

```bash
# One-time, from the official scaffolder — template: react-ts
pnpm create tauri-app@latest pos-app --template react-ts
cd pos-app && pnpm install

# Plugins this app standardizes on (add as needed per §5–§8, not wholesale)
pnpm add @tauri-apps/api @tauri-apps/plugin-sql @tauri-apps/plugin-http @tauri-apps/plugin-store @tauri-apps/plugin-log @tauri-apps/plugin-updater @tauri-apps/plugin-dialog @tauri-apps/plugin-opener
cargo add tauri-plugin-sql --features sqlite tauri-plugin-http tauri-plugin-store tauri-plugin-log tauri-plugin-updater
```

**Rules:**

- **pnpm**, not npm/yarn — workspaces + strict resolution; commit the lockfile (supply-chain rule from `DEVELOPMENT_STANDARDS.md` §5.5).
- `create-tauri-app` output is a *starting point*, not an architecture. It ships a flat `src/` that works for demos and collapses under a real feature set — restructure per §1.2 in the first week, not after the first year.
- Rust toolchain: **one pinned stable** via `rust-toolchain.toml`, enforced identically in CI (§11). Local drift between Rust versions is the #1 source of "works on my machine, fails in Actions."
- TypeScript: `strict: true`, `noUncheckedIndexedAccess: true` (POS code indexes arrays constantly; off-by-one at a register is a pricing bug).

### 1.2 Repository Layout (pnpm workspace — POS + storefront, one repo)

```
pos-platform/                       # pnpm workspace root
├── apps/
│   ├── pos/                        # the Tauri desktop app
│   │   ├── src/                    # React frontend (feature-sliced)
│   │   │   ├── app/                #   providers, router, window bootstrap
│   │   │   ├── features/
│   │   │   │   ├── checkout/       #   cart, payment, receipt
│   │   │   │   ├── orders/         #   open orders, website-orders feed
│   │   │   │   ├── catalog/        #   products, categories, search
│   │   │   │   ├── sync/           #   sync status UI, outbox inspector
│   │   │   │   └── settings/
│   │   │   ├── shared/             #   ui/ (design system), lib/ (ipc, query client), types/
│   │   │   └── main.tsx
│   │   ├── src-tauri/
│   │   │   ├── src/
│   │   │   │   ├── commands/       #   one file per domain (orders.rs, catalog.rs, sync.rs)
│   │   │   │   ├── db/             #   SQLite pool, migrations, repositories
│   │   │   │   ├── sync/           #   outbox worker, cloud client
│   │   │   │   ├── state.rs        #   AppState composition
│   │   │   │   ├── error.rs        #   PosError → serialized IPC errors
│   │   │   │   └── lib.rs
│   │   │   ├── capabilities/       #   permissions per window (§5)
│   │   │   ├── migrations/         #   SQL files, numbered (§6)
│   │   │   ├── tauri.conf.json
│   │   │   └── Cargo.toml
│   │   ├── package.json
│   │   └── vite.config.ts
│   └── storefront/                 # Next.js website (separate next build)
│       ├── app/
│       ├── lib/                    #   supabase clients, checkout logic
│       └── package.json
├── packages/
│   └── shared/                     # types + zod schemas for BOTH surfaces
│       ├── src/
│       │   ├── order.ts            #   Order, OrderItem, OrderStatus
│       │   ├── product.ts
│       │   └── events.ts           #   sync event names, channel names
│       └── package.json
├── supabase/
│   ├── migrations/                 # cloud schema + RLS policies (§9)
│   └── functions/                  # Edge Functions (webhooks etc.)
├── .github/workflows/              # ci.yml, release.yml (§11)
├── pnpm-workspace.yaml
└── package.json                    # root scripts: dev, build, test, lint
```

**Why feature-sliced, not `components/services/utils` buckets:** the checkout flow's UI, hooks, IPC calls, and tests change together — colocate them (clean-code rule §1.3 of the parent standards). `shared/` inside the app is for genuinely cross-feature code; if a "shared" module is used by one feature, it's misfiled.

**Why the storefront lives in the same repo:** the website and POS agree on `Order` via `packages/shared`, and a change to the order contract fails CI for both surfaces at once (§9.6). Two repos means the contract drifts silently until a customer's order vanishes between the website and the till.

### 1.3 tauri.conf.json — Baseline Discipline

```jsonc
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "AcmePOS",
  "version": "1.4.2",
  "identifier": "com.acme.pos",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "pnpm dev",
    "beforeBuildCommand": "pnpm build"
  },
  "app": {
    "windows": [{
      "label": "main",
      "title": "AcmePOS",
      "width": 1280, "height": 800,
      "resizable": true
    }],
    "security": { "csp": null }   // §5.3 — replaced with a real policy; null is a defect
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "createUpdaterArtifacts": true
  },
  "plugins": { "updater": { "pubkey": "<from §10 keygen>" } }
}
```

**Rules:**

- `identifier` is permanent the moment you ship — it keys updater artifacts, deep links, and OS certificate identities. Choose `com.<company>.<app>` once, in writing, before the first release.
- `version` MUST live here (the single source) and be bumped by the release workflow (§11), not hand-edited per platform.
- Every field in this file is load-bearing config, not boilerplate: the diff that "just tweaks tauri.conf.json" has broken release pipelines, updater endpoints, and CSP in that exact order of frequency.

---

## 2. Frontend Standards (React + TypeScript)

### 2.1 The Layering That Matters

```
React components  →  hooks (feature logic)  →  lib/ipc (typed invoke)  →  Rust commands  →  SQLite/cloud
        UI state: Zustand      Server/local-DB state: TanStack Query (queryKey owns caching)
```

- **Components render state and dispatch intents.** A component that formats money, computes tax, and hand-writes SQL strings is three components and a service wearing one file (parent standards §3.1 — unchanged, but webviews make it worse because "just one more useState" is invisible until the register lags).
- **TanStack Query owns everything that isn't UI state.** Orders, catalog, sync status — all through `useQuery`/`useMutation`. Hand-rolled `useEffect` fetching with `useState` loading flags is the #1 frontend pattern this codebase forbids; it re-implements cache, retry, and invalidation badly, per screen.
- **Zustand owns only ephemeral UI state** (active modal, focused register tab, help overlay open). If a Zustand store holds a copy of an order, there are now two sources of truth for that order, and one of them is wrong during sync.

### 2.2 Money, Quantities, Time — the POS Data Rules

```typescript
// ❌ Don't: floats for money — 0.1 + 0.2 !== 0.3, and the difference lands in someone's drawer count
const total: number = items.reduce((sum, item) => sum + item.price * item.qty, 0);

// ✅ Do: minor units (cents/kobo/pesos) as integers end-to-end; format only at the display edge
import { formatMoney } from '@/shared/lib/money';

const totalMinor: number = items.reduce(
  (sum, item) => sum + item.unitPriceMinor * item.quantity, 0
);
<span>{formatMoney(totalMinor, locale, currency)}</span>;
```

- **Money is integer minor units everywhere** — SQLite column, JSON payload, React state, Postgres `integer`. One `formatMoney()` at the render boundary. A float anywhere in the chain is a rounding bug at the till.
- **Quantities are integers × a fixed scale** (e.g., weighable goods in grams). The scale is in the product record, not inferred from the number's shape.
- **Timestamps are UTC ISO-8601 strings** in storage and transport; converted to store-local time only for display and printed receipts. A register in Lagos and a server in Dublin reconciling a Z-report is a timezone bug factory otherwise.
- **The money/quantity/time types are defined once in `packages/shared`** and imported by POS, storefront, and Edge Functions. Any surface re-declaring `Order` locally is a contract break waiting for a customer.

### 2.3 TanStack Query Conventions

```typescript
// lib/queryKeys.ts — hierarchical, invalidatable by prefix
export const queryKeys = {
  orders: {
    all: ['orders'] as const,
    open: () => [...queryKeys.orders.all, 'open'] as const,
    detail: (id: string) => [...queryKeys.orders.all, 'detail', id] as const,
  },
  catalog: {
    all: ['catalog'] as const,
    product: (sku: string) => [...queryKeys.catalog.all, 'product', sku] as const,
  },
  sync: {
    status: ['sync', 'status'] as const,
  },
};

// features/orders/hooks.ts
export function useOpenOrders() {
  return useQuery({
    queryKey: queryKeys.orders.open(),
    queryFn: () => listOpenOrders(),          // typed IPC call (§3)
    staleTime: 30_000,                        // local DB read: cheap, stable
  });
}
```

- **Query keys are hierarchical and centralized** — `invalidateQueries({ queryKey: queryKeys.orders.all })` after every order mutation, and the whole surface re-fetches coherently.
- `staleTime` is mandatory on every query — defaults differ wildly between local-SQLite reads (long) and cloud reads (short). A query without an explicit `staleTime` is unpriced; price it.
- Mutations invalidate by **prefix**, never by hammering `invalidateQueries()` with no key (refetch-everything theater).
- Mutations that touch the outbox (§9.5) MUST await the SQLite write, not the eventual upload — the UI confirms "saved to the register," and the sync badge owns "sent to cloud."

### 2.4 POS UX Patterns (a register, not a website)

- **Keyboard-first checkout:** every step of the sale is reachable without the mouse — barcode scan field auto-focused, F-keys for payment methods, Enter to advance. Mouse-only POS flows halve throughput at rush hour. Bind keys in one `useHotkeys` map per screen, documented in the screen's header comment.
- **The cart list is virtualized** (`@tanstack/react-virtual`) the moment line items can exceed ~50. A 500-line order freezing the webview is a self-inflicted outage.
- **Every destructive action (void line, void sale, refund) asks twice** — once with a confirm, once by requiring an operator PIN for supervisor-level voids. The PIN check is a Rust command against staff roles (§4), never a client-side constant.
- **Offline is a first-class UI state, not an error toast.** A persistent, calm sync badge (`synced 12:42` / `3 pending — offline`) beats modals interrupting a sale.
- **Touch targets ≥ 44px** on any screen flagged for tablet deployment; `resizable: false` + fixed portrait layout for dedicated terminal builds.
- **Never `alert()`/`confirm()`** — they block the webview's event loop and look alien; use the app's own modal system. (Also they can't show the PIN pad.)

### 2.5 Styling & Theming

- Tailwind, one `tailwind.config` in the app, **design tokens as CSS variables** (`--color-surface`, `--color-danger`) so a kiosk build can swap a high-contrast theme without a rebuild.
- Dark-mode is the default for long shifts (registers run all day); light mode for receipt-preview mirrors. Respect `prefers-color-scheme` as the initial value.
- Component library: headless (Radix-class) + Tailwind styling — you're building a POS design system, not adopting someone's website chrome. Do not pull in a heavyweight material/bootstrap bundle; it fights the webview and the kiosk theme both.

---

## 3. Tauri Frontend Integration Rules

The webview is a privileged guest inside a Rust host. These rules keep the guest from wandering where it shouldn't.

### 3.1 The Typed IPC Boundary

All `invoke()` calls go through one typed wrapper module. **A component calling `invoke('...')` directly is a review-blocker** — same reasoning as the parent standards' boundary rule (§3.2 there): the IPC layer is a system boundary, and boundaries get schemas and one authoritative representation.

```typescript
// shared/lib/ipc.ts — the ONLY module allowed to import @tauri-apps/api/core
import { invoke as rawInvoke } from '@tauri-apps/api/core';
import type { Order, OrderDraft, SyncStatus } from '@shared/types';

export async function invokeTyped<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return rawInvoke<T>(cmd, args);   // one choke point for logging/error-shaping later
}

// shared/lib/api.ts — every command has a typed signature here; features import these, never invoke
export const api = {
  orders: {
    listOpen: (): Promise<Order[]> => invokeTyped('orders_list_open'),
    create: (draft: OrderDraft): Promise<Order> => invokeTyped('orders_create', { draft }),
    voidLine: (orderId: string, lineId: string, pin: string): Promise<Order> =>
      invokeTyped('orders_void_line', { orderId, lineId, pin }),
  },
  sync: {
    status: (): Promise<SyncStatus> => invokeTyped('sync_status'),
    retryNow: (): Promise<SyncStatus> => invokeTyped('sync_retry_now'),
  },
} as const;
```

**Rules:**

- Command names are `domain_verb_noun`, snake_case on the Rust side, mirrored exactly in `api.ts` — the file pair is reviewed together.
- Every command's args and return type are declared in TypeScript **and** validated by zod at development time via contract tests (§12) — TS types describe shape; they don't enforce the Rust side keeping its promises.
- IPC payloads are **small**: a command returns the order, not the order plus its 40 line items plus the customer's purchase history. Wide payloads serialize through JSON twice (Rust → JSON → JS parse) and the GC pause lands mid-checkout.
- A command call without error handling at the hook level (TanStack Query's `onError`, or the mutation's failure branch) is unfinished — Rust errors arrive as rejected promises with the serialized shape from §4.3, and the UI must have a plan for them.

### 3.2 Events (Rust → UI push)

```typescript
// Rust side: app.emit_to("main", "sync://status", payload)?;   — namespaced, single window
import { listen } from '@tauri-apps/api/event';

// ✅ Do: subscribe in the owning hook, unsubscribe in teardown (leak rule §2.2 parent standards)
export function useSyncStatus(): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  useEffect(() => {
    const unlisten = listen<SyncStatus>('sync://status', (event) => setStatus(event.payload));
    return () => { void unlisten.then((fn) => fn()); };   // MUST unlisten
  }, []);
  return status;
}
```

- **Event names are namespaced constants** (`sync://status`, `orders://created`) defined in `packages/shared/events.ts` — the string `"ordersCreated"` typed ad hoc in two files is a desync bug.
- Every `listen()` **MUST** have its matching `unlisten` in effect teardown; event-listener leaks in a 10-hour shift are the desktop version of the classic web leak, and they compound (parent standards §2.2).
- Events are for **push notifications of change**, not for data transfer — the payload is an ID or a slim summary, and the client re-reads through Query. Shipping whole entities in events creates a second, racy cache next to TanStack's.
- Prefer Rust → UI direction for events; UI → Rust goes through `invoke` (it's a request, not a broadcast).

### 3.3 Webview Realities

- **No `window.confirm`/`alert`** (§2.4) and **no direct `fetch` to Supabase from components** — cloud calls go through the typed API layer with tokens from the Rust-managed session (§7).
- **Multi-window:** each window gets its own capability file (§5) and its own QueryClient (windows don't share JS state — discover this in design, not in the bug tracker). The default POS is one window plus optional pop-out receipt/payment windows with `label`ed capabilities.
- Webview differences are real (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux): feature-test at startup for the handful of things that differ (fonts rendering, `Date` parsing edge cases), and never build a flow that depends on a single engine's quirk.
- **Do not enable devtools in release builds** (`app.windows[].devtools` stays default-off; debug builds only). A devtools-enabled release build at a kiosk is an open shell on a machine that can charge cards.

---

## 4. Rust Backend Standards

The Rust side is the app's spine: it owns SQLite, the sync worker, secrets, and every rule the business actually enforces (totals, tax, void permissions). The React side is a rendering of what Rust says is true.

### 4.1 Command Design

```rust
// commands/orders.rs
use crate::{db::repositories::orders::OrderRepository, error::PosError, state::AppState};

#[tauri::command]
pub async fn orders_create(
    state: tauri::State<'_, AppState>,
    draft: OrderDraft,           // serde-deserialized + validated (§4.4)
) -> Result<Order, PosError> {
    let order = state.orders.create(draft)?;   // repo: totals + tax computed in SQL/Rust, NEVER trusted from UI
    state.outbox.enqueue_order(&order)?;       // same conceptual transaction path (§9.5)
    Ok(order)
}
```

- **One command, one job** — same single-responsibility rule as TS functions. `orders_create_and_sync_and_print` is three commands and an orchestrator.
- **Commands are thin:** validate → call repository/service → emit events. Business logic lives in `db/repositories` and `sync/`, where it's unit-testable without a window.
- **All command functions are `async`** and every `.await` inside touches real I/O (SQLite, network). CPU-heavy work (report aggregation over a year of sales) gets `spawn_blocking` — blocking the async runtime stalls *every* in-flight command, which stalls the register.
- `tauri::State` gives shared access to `AppState` (DB pool, sync worker, config); construct it once in `lib.rs`, inject repositories — the dependency-injection rule from the parent standards, verbatim.

### 4.2 State

```rust
// state.rs — composed once at startup, mockable in tests
pub struct AppState {
    pub db: DbPool,                    // sqlx/rusqlite connection pool (§6)
    pub orders: OrderRepository,
    pub catalog: CatalogRepository,
    pub outbox: OutboxHandle,          // channel to the sync worker task (§9)
    pub session: SessionStore,         // staff login state (§7)
}

impl AppState {
    pub fn new(db: DbPool, outbox: OutboxHandle, session: SessionStore) -> Self {
        Self { orders: OrderRepository::new(db.clone()), catalog: CatalogRepository::new(db.clone()), db, outbox, session }
    }
}
```

- **State is composed, not scattered** — one `AppState`, constructed in `lib.rs::run()`, replaced wholesale by a test double in unit tests. Mutexes scattered across commands are global variables with extra steps.
- **Interior mutability is chosen deliberately:** `RwLock` for read-mostly config, channels (`mpsc`) for the outbox, and the SQL pool handles its own concurrency. A `Mutex<Vec<Order>>` in state is almost always a missing database table.
- **Never hold a lock across an `.await`** that can hang (network). Deadlocking the UI thread's command path is how a cloud outage becomes a frozen till — the exact failure offline-first exists to prevent.

### 4.3 Errors

```rust
// error.rs — thiserror::Error derives Display + From; serialized to a string the TS side can branch on
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum PosError {
    #[error("order not found: {order_id}")]
    OrderNotFound { order_id: String },

    #[error("pin rejected for operator {operator_id}")]
    PinRejected { operator_id: String },

    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("sync backend error: {0}")]
    SyncBackend(String),
}

// Tauri serializes the error via Display into the rejected promise — the TS side matches on message
impl Serialize for PosError { /* serialize Display string + machine code */ }
```

- **Typed error enum, `thiserror`, `#[from]` conversions** — the parent standards' typed-errors rule, with the Tauri twist that the string crosses IPC into a rejected promise. Define the pairing (Rust variant ↔ TS discriminated union) in `packages/shared` and test it (§12).
- `unwrap()`/`expect()` are **forbidden outside tests and startup** (where failure = don't start the app). A panic in a command aborts that IPC call; a panic in a worker task can take the sync loop down silently.
- **Operational vs programmer errors** (parent §3.3): `OrderNotFound` is a `Result` variant; a corrupted SQLite schema is a startup abort with a loud log. Never `Result<String, String>` — stringly-typed errors make the TS side parse prose.

### 4.4 Validation at the IPC Boundary

- `OrderDraft` deserialization is **serde-strict** (unknown fields rejected, all fields required where they're required) — the mass-assignment rule from the parent standards applies to IPC arguments exactly as it applies to HTTP bodies. The webview is an untrusted serializer away from being external input (CSP helps; don't rely on it).
- **Money never arrives from the UI pre-computed.** The draft carries line items and quantities; `calculate_totals` runs in Rust/SQL. Any design where the client sends `total` is a void-waiting-to-happen.
- Validate, then **trust inward** — downstream repository code doesn't re-check that `quantity > 0`; the boundary did (parent §3.2, unchanged).
- Zod schemas in `packages/shared` are mirrored by serde types in Rust; the contract test (§12.4) round-trips a fixture through both and fails CI on drift.

---

## 5. Tauri v2 Security: Capabilities, Permissions, CSP

Tauri v2 replaced the v1 allowlist with a finer-grained model: **capabilities** (files in `src-tauri/capabilities/`) map sets of **permissions** to windows by their labels. Nothing is granted implicitly. This is the desktop version of least-privilege access control, and it's only as good as the discipline around the files.

### 5.1 Capabilities Discipline

```jsonc
// src-tauri/capabilities/main.json — the main register window
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "main-capability",
  "windows": ["main"],
  "permissions": [
    "core:default",                        // baseline window/event access — audited each release
    "sql:allow-load",                      // SQLite: only what the app itself needs
    "sql:allow-execute",
    "sql:allow-select",
    "sql:allow-close",
    "http:default"
  ]
}
// src-tauri/capabilities/receipt.json — a pop-out receipt window, if you build one
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "receipt-capability",
  "windows": ["receipt"],
  "permissions": [
    "core:default"
    // no SQL, no HTTP — this window renders what it's given. That's the point.
  ]
}
```

**Rules:**

- **One capability file per window label, reviewed in every PR that touches it.** The permissions diff is the security diff (parent §5.7 — treat it with the same review alarm as a credential).
- **Never grant a wildcard** (`sql:default` when you need three operations, `http:default` when one host will do). v2's permission names are granular precisely so the capability file can be the answer to "what can this window do?" — read it aloud in review; if a sentence needs "and also whatever," it's wrong.
- Scoped permissions exist for a reason: HTTP access is constrained further by the plugin's **allow-list of URLs in the capability/permissions config** (scope entries) — the register's webview can talk to Supabase and nothing else. An unconstrained `http` permission is an exfiltration channel if the webview is ever compromised (XSS in the webview + open HTTP = database leaves the building).
- `remote` domains in capability scopes and `app.security` config get the same scrutiny as CORS origins would on a web API: exact hostnames, no `https://*` shapes.
- **Third-party plugins** (non-official crates) are new dependencies: the parent standards' §5.5 supply-chain review applies — who maintains it, what does it touch, is it worth being in the trust chain of a payments-adjacent app?

### 5.2 The Threat Model for a POS Webview

Assets: cardholder-adjacent data, order/price integrity, staff credentials, the business's reputation. Actors: customers at a kiosk-ish screen, staff with varying roles, anonymous network attackers, compromised npm/JS supply chain. Entry points: IPC from the webview, barcode-scanner input (it's a keyboard that types attacker-controlled strings if a malicious QR/barcode is shown to the register — treat scanned input as untrusted input, length-capped and validated), file imports (catalog CSV), the network path to Supabase, and the updater path (mitigated by §10 signatures).

The distinctive Tauri-specific rules that fall out of this model:

- **Rust validates everything the webview sends** (§4.4). The webview runs arbitrary JS from your bundle — which is arbitrary JS from your `node_modules` — and a compromised dependency chain must not be able to write prices by invoking commands with convenient shapes.
- **Scanned barcodes are untrusted input:** cap length, validate charset (product codes have strict grammars — EAN-13 is digits, GTIN has a check digit), and reject anything that looks like it's probing for a command path. Never `eval`-adjacent-process scanner input; never pass it to a shell.
- **The register's webview loads local assets only** — no remote iframes, no remote scripts, ever. Dynamic content (product images from the web) flows through `<img>` with a CSP that pins image sources (§5.3), not through HTML injection.

### 5.3 CSP — Always Set, Always Tight

```jsonc
// tauri.conf.json → app.security.csp  (the `"csp": null` default is a defect to fix in week one)
{
  "csp": "default-src 'self'; img-src 'self' https://<project>.supabase.co data:; style-src 'self' 'unsafe-inline'; connect-src ipc: http://ipc.localhost https://<project>.supabase.co; font-src 'self'"
}
```

- `default-src 'self'` — local bundle only. `connect-src` pins the two things allowed to be talked to: Tauri's IPC and the Supabase project host. `img-src` adds the storage CDN for product images.
- `'unsafe-inline'` for styles only if the Tailwind pipeline actually requires it; never for scripts — inline script execution in a webview that can invoke commands is the whole game.
- Every relaxation of this string is a security review event with a written reason (parent Appendix C). "The dev server needed it" is what environment-specific config in dev-only builds is for; the shipped CSP stays locked.
- Add `upgrade-insecure-requests` and refuse plain-HTTP `connect-src` entries — the register talks to the internet over TLS or not at all (parent §5.6).

### 5.4 Update & Installer Security

- Updates are signature-verified by `tauri-plugin-updater` (§10) — the pubkey lives in `tauri.conf.json`, the private key never leaves the CI secret store. A register that auto-updates from an unsigned manifest is a remote-code-execution slot with a logo.
- Installer-level signing (Windows Authenticode / macOS notarization) is a release-gate (§11), not a nice-to-have: unsigned installers train staff to click through OS warnings, which is the actual attack being enabled.

---

## 6. Local Data Layer: SQLite

### 6.1 Architecture

- **SQLite via `tauri-plugin-sql`** (sqlx under the hood): JS-side `Database` API for migrations + queries from Rust. Register a pool at startup against `sqlite:pos.db` in the app-data directory; run migrations before the first window shows.
- **All writes go through Rust repositories** (§4). The frontend reads via SQL plugin `select()` only for static-ish data; the moment a read needs a join across three tables or business filtering, it becomes a Rust command returning a typed projection. Rule of thumb: **JS `select` for lookups, Rust for anything with an invariant.**
- `PRAGMA journal_mode=WAL` + `PRAGMA foreign_keys=ON` at pool init. WAL keeps reads unblocked during writes (the register stays responsive mid-sync); foreign keys enforced locally mirror the cloud schema's integrity.
- One file, in `app_data_dir()`, backed up on a schedule (§6.5). Never in `DocumentDir`, never user-browsable by default, never named something a cashier would "clean up."

### 6.2 Migrations

```
src-tauri/migrations/
├── 0001_init.sql            # products, categories, staff, roles
├── 0002_orders.sql          # orders, order_items, outbox
├── 0003_receipts.sql
└── 0004_indexes.sql
```

```rust
// Migrations are declared in Rust (tauri-plugin-sql) and run at startup, in order, exactly once.
// They are append-only: a shipped migration file is NEVER edited — you write a new one.
```

- **Append-only, numbered, forward-only.** Editing a migration that has shipped to registers is the local-database version of rewriting git history — some tills applied v1, some applied your "fixed" v1, and now there are two schemas calling themselves 0002. The fix for a bad migration is a new migration (parent §8.6 expand–contract, miniaturized).
- **Every migration ships in the same release as the code that needs it**, and old code must tolerate the new schema (additive columns only until the next release drops the old path) — the same expand–contract discipline as the cloud schema (§9.7), one release earlier.
- Migrations run in a transaction where SQLite allows it (most DDL doesn't) — keep each file small enough that a failure mid-file is obvious and re-runnable.
- **CI runs the full migration chain on a fresh database every build** (§12) — a migration that only works on the developer's existing `pos.db` is the classic local-data defect.

### 6.3 The POS Schema (core tables)

```sql
-- 0002_orders.sql (excerpt — full contract in Appendix B)
CREATE TABLE orders (
    id            TEXT PRIMARY KEY,           -- ULID, generated in Rust
    source        TEXT NOT NULL CHECK (source IN ('pos','website')),
    status        TEXT NOT NULL CHECK (status IN ('open','paid','voided','refunded','synced')),
    total_minor   INTEGER NOT NULL,           -- computed by Rust/SQL, never the client
    currency      TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,     -- §9.4: the anti-duplicate spine
    operator_id   TEXT REFERENCES staff(id),
    created_at    TEXT NOT NULL,              -- UTC ISO-8601
    cloud_row     INTEGER,                    -- cloud's bigint PK after first sync; NULL until then
);
CREATE INDEX idx_orders_status_created ON orders(status, created_at DESC);
CREATE INDEX idx_orders_idem ON orders(idempotency_key);

CREATE TABLE outbox (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id       TEXT NOT NULL REFERENCES orders(id),
    idempotency_key TEXT NOT NULL UNIQUE,
    payload        TEXT NOT NULL,             -- the exact JSON to upload
    attempts       INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,                     -- NULL = due now; backoff writes future timestamps
    created_at     TEXT NOT NULL
);
CREATE INDEX idx_outbox_due ON outbox(next_attempt_at);
```

- **IDs are ULIDs generated in Rust** — sortable, collision-free offline, and identical whether the order was born at the till or (via a different prefix) on the website. UUIDv4 sorts randomly; Z-reports and sync cursors both want time-ordered IDs.
- **`idempotency_key` is UNIQUE at the storage layer**, not just checked by code — the database is the last line of defense against double-charging, and it's the only one that can't be bypassed by a bug in the upload loop (parent §9.4).
- **Money columns are INTEGER** (§2.2); timestamps are TEXT UTC; enums are CHECK-constrained — SQLite will accept any string in an unconstrained TEXT column, and a typo'd `'paidd'` status is a stuck order.
- Index what the screens query: `(status, created_at)` for the open-orders list; `(next_attempt_at)` for the outbox scan; SKU on products for scanner-speed lookup. An index is added when a query plan shows a scan on a hot path, not speculatively (parent §2.1).

### 6.4 Transactions — Where Money Integrity Lives

```rust
// db/repositories/orders.rs — sale + outbox row commit atomically, or not at all
pub fn create_with_outbox(&self, draft: OrderDraft) -> Result<Order, PosError> {
    let conn = self.pool.conn()?;
    let tx = conn.transaction()?;
    let order = insert_order(&tx, &draft)?;          // computes totals in SQL
    insert_outbox_row(&tx, &order)?;                 // the "intent to sync" is part of the sale
    tx.commit()?;
    Ok(order)
}
```

- **The sale and its outbox row commit in the same transaction.** A sale committed without an outbox row is a sale the cloud will never hear about — invisible revenue, discovered during reconciliation, i.e., too late. This pairing is the single most important invariant in the entire app.
- Refunds, voids, and status transitions are single-statement `UPDATE ... WHERE status = <expected>` — optimistic state machine transitions. The rowcount tells you if you raced another operator; a racy void on a shared order is a drawer that doesn't balance.
- No multi-statement write sequence outside a transaction. Ever. SQLite makes this cheap; not using it is pure downside.

### 6.5 Durability & Backup

- SQLite in WAL mode with default synchronous settings is durable for POS purposes; the unit of loss tolerance is "a sale scanned in the last second" — state your tolerance, don't discover it.
- **Local backup:** a rotating copy of `pos.db` (plus WAL checkpoint) to `app_data_dir()/backups/` on a daily timer and on clean shutdown — registers get reimaged, disks die, and "restore from the register" beats "reconstruct from the website + card processor statements."
- **The cloud is not the backup for today's offline sales** — the outbox is pending by definition; the local backup is the only place an unsynced sale exists. Two copies of unsynced truth, always.

---

## 7. Networking, Auth & Secrets

### 7.1 HTTP from the App

- **All cloud traffic goes through Rust** (`tauri-plugin-http` / reqwest under it), not webview `fetch`. Reasons, in order of force: (1) tokens and signing live in Rust memory, not in a webview-readable JS variable; (2) the scope allow-list in the capability file actually constrains Rust-side HTTP; (3) retries/backoff are one Rust worker's concern, not twelve components' concern.
- **Every request has a timeout** (default 15 s; payment calls per processor spec) — a hung request in the sync worker with no timeout is a stalled outbox (parent §2.5, verbatim).
- **Retries with exponential backoff + jitter** live in the sync worker, on idempotent operations only (§9.4). A retry anywhere else in the app is a code smell — either it belongs in the outbox or it's duplicating the outbox badly.
- TLS-only; the Supabase project URL and anon key are the *only* cloud constants in the codebase, injected via `tauri-plugin-store` config at first run or bundled (they're public-by-design values; treat them as config, not secrets — §7.3 draws the actual secret line).

### 7.2 Supabase Auth — Staff Sessions

- **Staff log into the POS with Supabase Auth** (email+password or magic link; whatever the org standardizes). The Rust side runs the session: it obtains the JWT, keeps the refresh token in the OS keychain (§7.3), refreshes on schedule, and passes the access token to Postgres/Realtime/Storage calls.
- The **JWT's claims drive authorization** on the cloud side via RLS (§9.3): `store_id`, `role` claims decide what the register can read/write. The POS UI's role checks (PIN pad for voids) are UX; RLS is the boundary — the same deny-by-default split as the parent standards' §5.3, applied to a database.
- **Token refresh happens in Rust at startup and on 401**, never "when a component notices." One owner for the session lifecycle; every feature gets a valid token or a typed `SessionExpired` error that routes to the login screen.
- Customer accounts on the storefront use a separate auth flow (Supabase Auth on the web) — staff and customers never share a role universe; the RLS policies name both explicitly (§9.3).

### 7.3 Secrets Handling

| Value | Where It Lives | Never Where |
|---|---|---|
| Supabase anon/publishable key | Bundled config (public by design, RLS-scoped) | Treated as a secret |
| Staff refresh token | **OS keychain** — Windows Credential Manager / macOS Keychain / libsecret via the `keyring` crate | `tauri-plugin-store` JSON, SQLite, localStorage |
| Service-role key | **Nowhere in the app.** Server-side only (Edge Functions). | Any desktop bundle, ever |
| Updater private key | GitHub Actions secret store (§10–§11) | The repo, a laptop, a Slack message |
| Payment processor keys | Processor's SDK/hardware path; secrets stay processor-side | The POS database |

- The service-role key in a desktop app is the classic Supabase foot-gun: it bypasses RLS entirely, and any register can be extracted from. If a desktop flow seems to need it, what it actually needs is an **Edge Function** running server-side with the service role (§9.2).
- The `keyring` crate (not a Tauri plugin — a plain Rust dependency) is the standard OS-keychain access; wrap it once in `secrets.rs` so the storage location is one `#[cfg]`-per-platform decision, tested per platform in CI.
- CI/CD secrets follow the parent standards' §5.4 verbatim: never in the repo, never in logs, rotation without a deploy. The updater key pair additionally MUST be backed up somewhere safe (password manager + offline copy) — losing it means every installed updater stops being able to verify releases, which is an emergency migration (§10.4).

---

## 8. Cloud Storage

### 8.1 What Goes Where

| Asset | Storage | Access Pattern |
|---|---|---|
| Product images | Supabase Storage bucket `product-images` | Public read (or signed URLs); uploaded by back-office staff / admin web |
| Receipts PDFs | bucket `receipts` | Private; RLS-gated per `store_id`+customer; POS uploads after sync |
| End-of-day exports (CSV/ZIP) | bucket `exports` | Private, write-only from an Edge Function; download via signed URL |
| Catalog CSV imports | not stored — streamed through the Edge Function into Postgres | — |

- **Postgres is the catalog of record; Storage is the blob shelf.** A product row holds its image's Storage `path` — the DB row is what the POS caches locally; images are fetched on demand, cached to the app-data cache dir with a TTL by ETag.
- **Buckets are private by default; public buckets need a written reason** (product images MAY be public-read if the storefront serves the same images — that's the usual case and the acceptable one; anything customer-identifying is never public).

### 8.2 Uploads from the POS (receipts, exports)

```typescript
// Rust-side flow (via tauri-plugin-http with the staff session):
// 1. POST the upload with Authorization: Bearer <staff JWT>
// 2. Storage RLS checks: auth.uid() role can insert into receipts/ for their store_id
// 3. The upload path is <store_id>/<order_id>.pdf — path construction IS the access model
```

- **Paths are structured and store-scoped:** `{store_id}/{order_id}/...` — RLS policies key off the first segment; a flat `receipts/` namespace can't be secured per-store without heroics.
- Uploads are part of the **outbox flow** (§9.5): a receipt upload that fails is retried by the same worker with the same backoff — never by a bespoke retry loop in the receipt component.
- **Size caps enforced at both ends:** the Rust command refuses to package a >10 MB blob without an explicit override, and bucket policies cap it server-side. A runaway export filling a bucket is a cloud bill, not just a bug.

### 8.3 Signed URLs & the Website

- The storefront reads product images through the public bucket URL (or Supabase's image transformation CDN); the POS does the same through CSP-pinned `img-src` (§5.3).
- **Private assets (receipts for a logged-in customer) use short-lived signed URLs minted by an Edge Function** after RLS passes — never long-lived tokens, never the service role in the browser.
- Signed-URL TTLs are minutes, not days: a link that lands in a customer's email for "download your receipt" is 15 minutes of validity, because that's what the use-case is.

---

## 9. The Website → POS Sales Pipeline

This is the section the whole document serves. The website sells; the till knows. The till sells; the business knows. Neither surface trusts the other's arithmetic, and the internet being down is a Tuesday, not an event.

### 9.1 Cloud Schema & RLS — the Shared Truth

```sql
-- supabase/migrations/0002_orders.sql (excerpt — full contract in Appendix B)
CREATE TABLE orders (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- cloud PK
    client_id       text NOT NULL UNIQUE,        -- ULID from POS or storefront (§6.3)
    idempotency_key text NOT NULL UNIQUE,        -- §9.4
    store_id        uuid NOT NULL REFERENCES stores(id),
    source          text NOT NULL CHECK (source IN ('pos','website')),
    status          text NOT NULL,
    total_minor     integer NOT NULL,
    currency        text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Staff (POS, via JWT with store_id claim): read own store, insert pos-source orders
CREATE POLICY orders_staff_read ON orders FOR SELECT
    USING (store_id = (auth.jwt() -> 'app_metadata' ->> 'store_id')::uuid);
CREATE POLICY orders_staff_insert ON orders FOR INSERT
    WITH CHECK (source = 'pos' AND store_id = auth.jwt() -> 'app_metadata' ->> 'store_id'::text::uuid);

-- Customers never read orders directly — receipt access goes through an Edge Function (§9.2)
```

- **RLS is the only authorization boundary on the cloud.** Every table has it enabled and a default-deny before any policy exists — an RLS-less table in a Supabase project is a public table with extra steps (parent §5.3's server-side rule, database edition).
- **`client_id` + `idempotency_key` UNIQUE** — the cloud can absorb any upload any number of times and stay correct (§9.4).
- **Totals are recomputed server-side** (Edge Function or a Postgres trigger + generated columns / a `recalculate_order()` function): the website's cart math and the POS's are both *suggestions* the server verifies against catalog prices. The one place prices are authoritative is the `products` table — everything else derives.
- Realtime publication: `orders` (and `products`) are added to the `supabase_realtime` publication — **a table not in the publication silently never broadcasts**, which is the #1 "realtime doesn't work" ticket (verified in research; see §9.6's caveat list).

### 9.2 Order Intake from the Website

Two acceptable paths, pick per sensitivity — both end in the same `orders` row:

1. **Direct insert (RLS-guarded):** Next.js inserts the order server-side with the customer's session. Simple, works for plain orders. The storefront MUST NOT compute `total_minor` as authoritative — the DB trigger recomputes and can reject.
2. **Edge Function (`create-order`):** the storefront calls a function with cart + customer context; the function (service-role, server-side only) validates against catalog, applies promotions, creates the order, triggers the receipt email, and returns the order. This is the default for this codebase — money-touching logic lives server-side, in one place, testable with the catalog in the same transaction snapshot.

Either way: **the insert is what makes the order real.** No queue in front of Postgres, no "pending" row in a separate system that later "becomes" an order — the order is born in Postgres, and everything downstream (POS, fulfillment, email) reacts to it.

### 9.3 Realtime: Website Orders Appear at the Till

```typescript
// Rust-side sync worker (supabase-js runs in Rust via the JS runtime is NOT a thing —
// realtime subscription lives in the FRONTEND via @supabase/supabase-js, token supplied by Rust)
// features/orders/realtime.ts — the ONE module allowed to create channels
import { createClient, RealtimeChannel } from '@supabase/supabase-js';
import { SYNC_EVENTS } from '@shared/events';

export function subscribeToOrders(storeId: string, onInsert: (order: Order) => void): () => void {
  const channel = supabase
    .channel(`orders:${storeId}`)
    .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'orders', filter: `store_id=eq.${storeId}` },
        (change) => {
            // Payload is slim: the change row. Persist through IPC, don't trust-and-render.
            void invokeTyped('sync_incoming_order', { order: change.new })
                .then(() => onInsert(toOrder(change.new)));
        })
    .subscribe((status) => {
        // 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED' — surfaced to the sync badge (§2.4)
        void invokeTyped('sync_channel_status', { status });
    });

  return () => { void supabase.removeChannel(channel); };   // MUST be called on teardown (§3.2)
}
```

**Rules:**

- **Realtime is an accelerator, not a source of truth.** The channel makes orders arrive in ~seconds instead of at the next poll — but the sync worker ALSO runs a periodic pull (`orders?created_at=gt.<last_cursor>`) that catches anything the channel missed (reconnects, missed events, the laptop asleep at open). A POS that only works when websockets are green is online-only with extra steps.
- **Incoming orders persist through Rust first** (`sync_incoming_order` command): validated (serde-strict, §4.4), priced against the *local* catalog for display, inserted into SQLite with `source='website'`, then the UI is notified via event. The webview's copy of a realtime payload is a rendering hint, never the record.
- **Channel filters are store-scoped and the subscription is RLS-checked server-side** — Realtime validates the JWT's RLS policies on subscribe. Test this: a staff token for store A must receive zero events for store B, and that's a test, not an assumption (§12.5).
- **Reconnects are owned by supabase-js but *monitored* by you:** the channel-status callback feeds the sync badge; `CHANNEL_ERROR` for more than a minute flips the UI to degraded mode and leans on the poll.
- **The known RLS/JWT caveat (from research, verified):** realtime subscriptions can silently miss events when RLS + JWT auth interact badly (token expiry mid-subscription is the classic trigger). The defense is exactly the belt-and-suspenders above: poll as backup, cursor-based, always.

### 9.4 Idempotency — the Rule That Makes Retries Safe

- **Every order gets exactly one idempotency key, at creation, on the client** (`ulid()` of the sale event — same value as `client_id` for simple orders). It is UNIQUE in local SQLite (§6.3), UNIQUE in Postgres (§9.1), and travels in every upload attempt.
- **Cloud-side upsert:** `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` — then select the row back. The response says "created" or "already existed," and both are success. The worker can crash, retry, double-fire, and the business still sees one order.
- **This mirrors the parent standards' §9.4 rule** (idempotency keys on mutations) with the POS-specific twist that the *client* is the one generating keys, because the client is the one that must survive offline. Server-generated IDs after the fact don't deduplicate retries; client-generated keys do.
- Refunds and status transitions carry their own keys (`order_id:transition:new_state`) — the same mechanics, one level up.

### 9.5 POS → Cloud: the Outbox Worker

```rust
// sync/worker.rs — the loop, simplified to its invariant-bearing bones
pub async fn run(&self) -> Loop {
    loop {
        let due: Vec<OutboxRow> = self.db.outbox_due_now(50)?;    // indexed scan (§6.3)
        for row in due {
            match self.cloud.upsert_order(&row.payload, &row.idempotency_key).await {
                Ok(ack) => { self.db.outbox_mark_synced(row.id, ack.cloud_row)?; }
                Err(e) => { self.db.outbox_backoff(row.id)?; }    // attempts+1, next_attempt_at = now + 2^attempts ± jitter
            }
        }
        self.emit_status().ok();                                   // sync://status → the badge (§3.2)
        tokio::select! {
            _ = self.wake_rx.recv() => {}                          // new sale arrived: loop immediately
            _ = tokio::time::sleep(Duration::from_secs(30)) => {}  // else poll the table
        }
    }
}
```

- **The outbox pattern (verified against current offline-first practice):** writes and their sync-intent commit together (§6.4); a single worker drains the queue with backoff; every payload is idempotent (§9.4). This is the whole architecture, and its virtue is that every part is boring.
- **Backoff is per-row with jitter**, capped (e.g., max 10 min): one poisoned payload must not starve the queue behind it, and the jitter keeps fifty registers from DDoS-ing the cloud in a synchronized wave after an outage.
- **Poison-pill handling:** after N attempts (say 10), the row is flagged `stuck`, the sync badge turns amber with a count, and a supervisor action offers export-for-support. Silent forever-retry is how a stuck sale gets discovered at month-end reconciliation.
- **Ordering within an order's lifecycle:** statuses upload in sequence (paid → refunded) by keying on `created_at` and draining FIFO per `order_id`; cross-order interleaving is fine because orders are independent.
- **Clock skew:** the local `created_at` is the truth for local ordering; the cloud records its own `server_created_at` on insert. Never order cloud rows by client clocks — that's what cursors on server timestamps are for (parent §9.3's cursor rules, applied here).

### 9.6 Conflict Policy (decided in advance, not during an incident)

| Conflict | Resolution | Rationale |
|---|---|---|
| Same order, POS + cloud edits (e.g., refund at till vs. cancellation on website) | **Status machine, cloud wins on true conflicts**: both transitions valid? apply both in time order. Mutually exclusive (refund vs. cancel)? cloud's earlier `updated_at` wins, loser surfaces a "needs attention" card at the till | Money states have a defined lattice; arbitrary last-write-wins on money is how refunds vanish |
| Catalog price changed while a cart is open | Local cart keeps scanned price; next scan uses new price; banner on the till | A quoted price at the register is a commitment; mid-cart silent repricing is a customer-visible breach |
| Product deleted/hidden while website shows it | Website 404s/`is_active=false` on next load; POS local cache keeps it sellable until catalog sync marks inactive | The till must keep selling what's physically on the shelf; the website must stop selling what can't be fulfilled |
| Duplicate upload (retry storm) | Absorbed by idempotency (§9.4) — non-event by construction | The entire point |

The meta-rule: **write the conflict policy next to the schema, before the feature ships.** A conflict resolution decided in the moment is always "last write wins," and last-write-wins on money is a reconciliation incident (parent §9.6's spirit, POS-ized).

### 9.7 Cloud Schema Migrations

- Supabase migrations live in `supabase/migrations/`, applied via the Supabase CLI in CI on merge to `main`, **expand–contract only** (parent §8.6): add column → dual-write → backfill → switch readers → drop old, across releases.
- RLS policy changes are migrations like any other — and a PR that changes an RLS policy MUST show its attack-surface reasoning in the description (which actor gains/loses what), because an RLS edit is a security boundary edit (§5 parent standards).
- The POS app is *eventually* old: the release train means register v1.4 talks to cloud v1.6 for a while. Cloud changes are **additive for at least one POS release cycle** (new optional fields, new endpoints) — the same backward-compat window the parent standards demand of any public API (§8.5, §9.2 there), because the cloud's API consumers include installed desktop apps you cannot force-upgrade.

### 9.8 The Storefront Side (Next.js Checkout)

The website is a *producer* of orders, never a second POS. Its rules are the parent standards' web rules plus these:

```typescript
// apps/storefront/app/api/checkout/route.ts — server route, NOT a client-side fetch to Supabase
import { createOrder } from '@/lib/orders';

export async function POST(request: Request) {
  const cart = await CartSchema.parse(await request.json());     // zod at the boundary (§3.2 parent)
  const result = await createOrder(cart);                        // → Edge Function create-order (§9.2 path 2)
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 422 });
  }
  // Idempotency: the client sends an Idempotency-Key header generated when the cart froze
  // (cart last modified), so a payment-processor retry can't double-order. Mirror of §9.4.
  return Response.json({ orderId: result.order.clientId });
}
```

- **Checkout logic runs server-side** (route handler → Edge Function). Prices, taxes, and promotions are computed against the live catalog, not the cart's client-side math — the website's cart totals are UI hints until the server confirms.
- **The storefront sends the same `Order` contract** (`packages/shared`) the POS consumes — one schema, three runtimes (web, Edge Function, desktop), all validated by the same contract tests (§12.4).
- **The storefront never writes to the POS's domain tables beyond its own inserts** — `source='website'` is enforced by RLS (§9.1's `WITH CHECK`), so even a compromised storefront session can't forge counter sales.
- Payment webhooks (processor → Edge Function) update order status with the same idempotency discipline (§9.4) — a retried Stripe/Paystack webhook is a retry storm by another name, and the same key discipline absorbs it.
- Website order lifecycle ends at `paid` + fulfillment; till-side actions (refund, void) are staff operations on the POS or back office — the website can *request*, RLS decides who *may*.

### 9.9 Hardware & Peripherals (Rust owns the metal)

| Device | Integration | Rule |
|---|---|---|
| Barcode scanner | Keyboard-wedge (default mode): fires into the focused scan field | Untrusted input discipline (§5.2): length cap, charset/check-digit validation; one global scan handler routes to the active screen |
| Receipt printer | Rust: raw ESC/POS bytes over USB/serial (`serialport`-class crate), or OS print dialog for HTML receipts | Crate choice goes through the dependency review (§5.5); printing NEVER blocks the sale — receipt failure is a "reprint" button, not a failed checkout |
| Cash drawer | Kicks via the printer's ESC/POS drawer command, or USB HID | Drawer open events are logged (`drawer_opened`, with operator) — audits pair them against voids and refunds |
| Payment terminal | Processor SDK/hardware integration in Rust, or processor-hosted flow | Secrets stay processor-side (§7.3); terminal state machine mirrors order status transitions |

- **Peripheral failures are degraded modes, not sale blockers:** scanner dies → manual SKU entry stays on screen; printer jams → sale completes, receipt queues for reprint. The only hardware whose failure blocks a sale is the payment terminal itself (and cash exists).
- Every peripheral interaction is logged with the operator and order context (§14) — the drawer/void/refund correlation is what loss-prevention reviews run on.

---

## 10. Auto-Update & Release Management

`tauri-plugin-updater` supports Windows, macOS, and Linux (verified — mobile is excluded, which is fine: this is a desktop register). The updater checks an endpoint serving a signed manifest (`latest.json`), verifies the artifact signature against the public key baked into the app, and swaps the binary. The security of the entire fleet therefore reduces to one private key and one manifest file.

### 10.1 Key Generation & Storage

```bash
# One-time. The private key's password should live in the password manager.
pnpm tauri signer generate -w ~/.tauri/acme-pos.key
# → prints the PUBLIC key → paste into tauri.conf.json plugins.updater.pubkey
# → private key + password go to GitHub secrets (§11): TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

- **The public key goes in `tauri.conf.json` (committed). The private key and its password go ONLY to GitHub Actions secrets** (§7.3's table — this is the highest-stakes secret in the project).
- **Back the private key up offline** (password manager + printed copy in a safe). Lose it and every deployed register can no longer verify any future release — recovery means shipping a new app identifier and manually reinstalling the fleet, which is the "emergency migration" nobody wants to run.
- Rotate only via a coordinated release train: new key pair → release that carries BOTH pubkeys (updater accepts old for one cycle) → next release drops the old. Same expand–contract discipline as schema, because it *is* a schema — the fleet's trust schema.

### 10.2 The Update Manifest (`latest.json`)

```jsonc
// Served at https://updates.acme.dev/pos/latest.json (static hosting / GitHub Pages / CDN)
{
  "version": "1.5.0",
  "notes": "Website-order feed: realtime + poll fallback. Fixes receipt VAT line.",
  "pub_date": "2026-09-12T00:00:00Z",
  "platforms": {
    "windows-x86_64": { "signature": "<minisign sig from the .sig artifact>", "url": "https://.../AcmePOS_1.5.0_x64-setup.exe" },
    "darwin-aarch64": { "signature": "...", "url": "https://.../AcmePOS_aarch64.app.tar.gz" },
    "darwin-x86_64":  { "signature": "...", "url": "https://.../AcmePOS_x64.app.tar.gz" },
    "linux-x86_64":   { "signature": "...", "url": "https://.../AcmePOS_1.5.0_amd64.AppImage" }
  }
}
```

- Generated by the release workflow from the artifacts tauri-action uploads (§11.3) — **never hand-edited**. A hand-edited manifest with a stale URL bricks every register's update path at once.
- Platform keys are exact (`darwin-aarch64` ≠ `darwin-x86_64`); the `.sig` files the bundler emits next to each artifact carry the signatures — the manifest just references them.
- The manifest URL is an `https://` constant in the Rust updater config; treat its hosting (static site, CDN) as production infrastructure: it is the one URL the entire fleet depends on at every startup.

### 10.3 Update UX at the Register

- **Check at startup + every few hours; download in background; install on next restart** with a non-blocking "Update ready — restart when convenient" toast. An update that interrupts a checkout in progress is a self-inflicted incident, so the install step NEVER auto-runs while a sale is open (the Rust updater gate checks "no active sale" before applying).
- Failed verification = hard failure + log + badge — never a fallback to "install anyway." Signature failure means either compromise or misconfiguration, and both want loud humans.
- Registers that haven't checked in for >7 days (phantom fleet) show up in the ops dashboard (§14) — an unupdatable register is a security liability with a cash drawer attached.

---

## 11. GitHub & CI/CD Pipelines

### 11.1 Git Conventions

Inherited from the parent standards §8 wholesale: **trunk-based**, short-lived branches, Conventional Commits (`feat:`, `fix:` — the release notes and version bumps are generated from them), `main` always deployable, revert-first on breakage. The POS-specific additions:

- **Version bumps are automated** (changesets or release-please reading conventional commits) — a human editing `tauri.conf.json`'s version field by hand WILL eventually desync it from the tag, and the updater compares those two values to decide "is there an update."
- **Tags are `v*`** and only created by the release workflow (or a maintainer through it) — a stray `v1.5.0` tag triggers a full signed multi-platform release (below), which is not a thing to do by accident on a Friday.

### 11.2 PR Pipeline (`.github/workflows/ci.yml`)

```yaml
name: ci
on:
  pull_request:
  push: { branches: [main] }

jobs:
  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint && pnpm typecheck          # ESLint + tsc --noEmit, blocking
      - run: pnpm test                             # vitest (unit + IPC contract tests, §12)
      - run: pnpm --filter storefront build        # storefront compiles

  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable        # matches rust-toolchain.toml (§1.1)
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: apps/pos/src-tauri }
      - run: cargo fmt --check
      - run: cargo clippy -- -D warnings           # warnings are errors (§10.2 parent)
      - run: cargo test --manifest-path apps/pos/src-tauri/Cargo.toml
      - name: migration chain on fresh DB          # §6.2 — every build
        run: cargo test --manifest-path apps/pos/src-tauri/Cargo.toml migrations_

  supabase:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm dlx supabase db lint             # schema + RLS sanity in CI
      # db push runs on merge to main, not on PRs (§9.7)
```

Blocking on: lint, typecheck, clippy `-D warnings`, unit + contract tests, fresh-DB migration chain, storefront build. This is the parent standards' §6.8 gate table, instantiated. The full matrix build does NOT run per-PR (it's ~30 min × 3 OSes); a debug `cargo check` + webview build catches the overwhelmingly common breakage cheaply.

### 11.3 Release Pipeline (`.github/workflows/release.yml`)

```yaml
name: release
on:
  push: { tags: ['v*'] }

permissions:
  contents: write          # create the draft release + upload artifacts

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { platform: macos-latest,  args: '--target aarch64-apple-darwin' }
          - { platform: macos-latest,  args: '--target x86_64-apple-darwin' }
          - { platform: windows-latest, args: '' }
          - { platform: ubuntu-22.04,  args: '' }   # oldest supported glibc = widest Linux compat
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: apps/pos/src-tauri }
      - run: pnpm install --frozen-lockfile

      - uses: tauri-apps/tauri-action@v0
        env:
          # Updater signing (§10): private key NEVER in the repo
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          # macOS signing + notarization (§5.4)
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          # Windows signing (Azure Trusted Signing / cert per org choice)
          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
          AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
          AZURE_CODE_SIGNING_NAME: ${{ secrets.AZURE_CODE_SIGNING_NAME }}
          AZURE_CERTIFICATE_PROFILE_NAME: ${{ secrets.AZURE_CERTIFICATE_PROFILE_NAME }}
        with:
          projectPath: apps/pos
          tagName: v__VERSION__                       # read from tauri.conf.json
          releaseName: 'AcmePOS v__VERSION__'
          releaseDraft: true                          # human publishes after smoke-check
          releaseBody: 'See the assets to download this version and install.'
          args: ${{ matrix.args }}

  manifest:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: generate + publish latest.json           # §10.2 — from release assets, never by hand
        run: pnpm scripts:update-manifest --release-tag ${GITHUB_REF_NAME} --out updates/latest.json
      - name: deploy manifest
        run: pnpm scripts:deploy-updates              # to the static host / CDN backing §10.2's URL
```

**Rules:**

- **tauri-action is the official path** (verified against docs) — it builds per-platform bundles, signs them, generates updater `.sig` files, creates a **draft** GitHub release, and attaches artifacts. Hand-rolling this is a part-time job you didn't ask for.
- **Draft-then-publish:** a human smoke-installs the Windows and macOS artifacts (or the QA checklist's first three items) before hitting publish. The publish step is what flips `latest.json` live, and it is the last point at which a bad release is cheap.
- **macOS: sign + notarize every build** (the `APPLE_*` env set above) — an unnotarized build triggers Gatekeeper warnings, which trains staff to right-click-open anything, which defeats Gatekeeper for everything. Windows: Azure Trusted Signing is the 2026-cheap default (~$10/month class, integrated with the bundler); EV/OV certs are the enterprise alternative.
- Linux builds on the **oldest supported Ubuntu** in the matrix — building on `ubuntu-latest` silently raises your glibc floor and drops distros you didn't know you had.
- Secrets inventory for this workflow (GitHub → Settings → Secrets → Actions): updater key + password, Apple certificate/password/signing identity/notarization account + team, Azure tenant/client/profile set. All from §7.3's table; none in the repo; rotation documented in the runbook (§14).
- The manifest job runs **after** a human flips the draft to published (or on schedule post-publish, depending on hosting) — the fleet updates when you say so, not when the matrix's slowest runner finishes.

### 11.4 What CI Does NOT Do

- No deploy of the Supabase schema on tags — schema deploys happen on merge to `main` via `supabase db push` (§9.7), so the cloud is always ≥ the app release train.
- No force-push, no history rewrite (parent §8) — the release tag history *is* the fleet's audit trail of what shipped when.
- No "skip CI" on release tags: `[skip ci]` on `v1.5.0` means no build, no manifest, and every register stuck on 1.4 until someone notices the fleet dashboard.

---

## 12. Testing

The parent standards' pyramid (§6 there) applies; this section is its Tauri instantiation. What's different here: the IPC seam and the sync engine are the two places Tauri POS bugs actually live, so they get the contract-test treatment.

### 12.1 What Gets Tested, in Priority Order

1. **Money math** — `calculate_totals`, tax rules, discount stacking, refund proration: pure functions in Rust, exhaustively unit-tested, including the zero/negative/max cases. This is tier 1 of everything.
2. **IPC contracts** (§12.4) — every command's payload shape, both directions, both languages.
3. **SQLite repositories & migrations** — against a real temp-database file, fresh chain every run (§6.2).
4. **Sync engine** — outbox drain, backoff, idempotent re-delivery, conflict rules (§9.6): simulated clock + fake cloud.
5. **UI behavior** — checkout flow via mocked api layer; component trees that render what the badge says.

### 12.2 Rust Tests

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totals_include_line_discounts_and_round_half_up() {
        let draft = order_fixture()
            .with_line(sku("A"), qty(3), unit_price_minor(1_999), line_discount_minor(0))
            .build();
        assert_eq!(calculate_total_minor(&draft), 5_997);
    }

    #[test]
    fn outbox_and_order_commit_together_or_not_at_all() {
        let db = test_db();                        // fresh file, migrations run
        let repo = OrderRepository::new(db.clone());
        let result = repo.create_with_outbox(order_fixture().build());
        result.expect("clean insert succeeds");
        assert_eq!(db.count("outbox"), 1);

        // force a failure mid-transaction (unique-violation on a duplicate idempotency key)
        let dup = repo.create_with_outbox(order_fixture().same_idempotency_key().build());
        assert!(dup.is_err());
        assert_eq!(db.count("orders"), 1, "no partial state leaked");   // THE invariant (§6.4)
    }
}
```

- Repositories take the pool by construction (§4.2), so tests spin a temp SQLite file — never the developer's live `pos.db`. A test suite that reads/writes the real register database is a data-loss incident scripted in YAML.
- **Backoff and retry tests use a mocked clock** (`tokio::time::pause` or an injected `Clock` trait): real sleeps in tests are slow, flaky, and don't test the timing logic anyway.
- `cargo test` runs on every PR (§11.2), clippy `-D warnings` blocks, and the migration chain test re-runs the full `migrations/` directory against a fresh database.

### 12.3 Frontend Tests (vitest)

- **The api layer is mocked at its boundary** (`vi.mock('shared/lib/api')`) — component tests exercise render + interaction logic, not IPC. Testing components through real `invoke()` is an integration test wearing a unit test's clothes, and it inherits every flake of the real pipeline.
- One behavior per test, sentence-names, AAA structure — parent §6.3 verbatim.
- **Money formatting tests are locale-tables**, not vibes: `(1_234_567, 'en-NG') → '₦12,345.67'` style fixtures, because the display edge is the only place formatting happens (§2.2) and the one place it can break.

### 12.4 The IPC Contract Test (the one that catches the real bugs)

```typescript
// packages/shared/contracts/orders.test.ts
// Round-trips a canonical Order fixture through: zod schema ←→ JSON ←→ Rust serde shape.
// Fails when Rust's serde struct drifts from the TS type — the silent desync class (§3.1, §4.3).
import { OrderSchema } from '../src/order';
import { orderFixture } from './fixtures';

test('order fixture satisfies the contract schema', () => {
  expect(() => OrderSchema.parse(orderFixture())).not.toThrow();
});

test('rust-side serialized order parses via the shared schema', () => {
  // golden JSON produced by `cargo test -- --nocapture  print_order_golden` in CI (§11.2 rust job)
  const golden = JSON.parse(fs.readFileSync('__goldens__/order.json', 'utf8'));
  expect(() => OrderSchema.parse(golden)).not.toThrow();
});
```

- The Rust job emits a **golden JSON fixture** (a small `#[test]` that prints a serialized `Order`); the frontend job parses it against the zod schema. Drift between the serde struct and the TS type — added field here, renamed field there — fails CI on the PR that caused it, for both surfaces at once. This is the parent standards' §9.6 contract discipline, pointed at IPC.

### 12.5 E2E (a chosen few)

- **WebdriverIO/Playwright against a debug build** (not per-PR; nightly + pre-release, per parent §6.8): checkout happy path, offline sale → reconnect → synced, website-order → till-appears (against a local Supabase stack via `supabase start`).
- **The RLS isolation test** (§9.3): staff token for store A receives nothing for store B — an E2E assert, not a hope.
- **The offline test is non-negotiable:** kill the network interface mid-sale (the harness can), complete the sale, restore, assert the cloud row exists exactly once. This one test is the app's entire reason for its architecture; it runs on every release.

---

## 13. Performance

- **Bundle discipline:** the webview payload is a POS kiosk, not a marketing site — keep the frontend bundle lean (route-split admin/reports screens; checkout screen eager, everything else lazy). Track it: a size budget in CI (`size-limit` class) fails the PR that adds a charting library to the sale screen.
- **SQLite on the hot path:** every scanner keystroke does an indexed SKU lookup — the `products(sku)` index is the difference between 1 ms and a visible stutter at 40k SKUs. EXPLAIN QUERY PLAN in review whenever a new query lands on a hot path (parent §2.1's call-out rule).
- **IPC payload size** (§3.1): return projections, not object graphs. The orders list screen wants 6 fields × 50 rows, not 50 full orders with items and customer objects.
- **Virtualize the lists that can grow** (§2.4) — open orders during a rush, product grid at 40k SKUs, the outbox inspector after an outage.
- **Rust hot loops stay off the main thread** — receipt rendering and Z-report aggregation over a year of rows go to `spawn_blocking` (§4.1), and the webview stays at 60fps while they run.
- **Image pipeline:** product images arrive sized by the storage CDN's transform endpoint; the app caches to disk keyed by ETag, capped (LRU, ~200 MB) — an unbounded image cache is the parent standards' §2.2 leak with a retail theme.

---

## 14. Observability

- **`tauri-plugin-log`** to rotating files in `app_data_dir()/logs/` (impl-detail-free names, INFO = business events per the parent §7.1 semantics: `sale_completed`, `sync_drained`, `update_installed`). **No secrets, no card numbers, no customer PII in logs** — parent §5.6/§7.1 verbatim, doubly binding at a till.
- The log file is the first thing the "Export diagnostics" supervisor action bundles (with the stuck-outbox export, §9.5) — support tickets that arrive with logs are solvable; tickets that arrive as descriptions are archaeology.
- **Sync telemetry is a dashboard, not a feeling:** per-register events (last successful sync, pending outbox count, updater version + last check) posted to a lightweight ops endpoint or visible in the cloud's `registers` table. The fleet dashboard answers "which tills are dark, stale, or stuck" without anyone driving to a store (§10.3's phantom-fleet rule depends on this existing).
- **Crash reporting** (sentry-class) with release + register metadata attached; crashes in the sync worker are paged-adjacent — a register that silently stops syncing looks identical to a slow Tuesday until reconciliation.
- **No metrics cardinals from unbounded values** (parent §7.2): register ID is bounded-ish (fine); order ID is not (log it instead).

---

## Appendix A: Cheat Sheet

| Area | Do | Don't |
|---|---|---|
| Stack | React 19 + TS strict, Rust commands, SQLite, Supabase | A second frontend framework, a second database, "temporary" direct writes |
| Money | Integer minor units end-to-end; format once at render | Floats anywhere in the chain; client-computed totals |
| State | Query owns server/DB state; Zustand owns UI state only | Duplicated order state in a JS store |
| IPC | One typed `api.ts`; small payloads; errors handled at the hook | `invoke()` from components; whole object graphs over IPC |
| Events | Namespaced constants; always `unlisten`; IDs not entities | String literals inline; leaked listeners across a 10-hour shift |
| Rust | Thin commands; repositories own logic; typed errors; async everywhere | `unwrap()` in prod; `Mutex<Vec<_>>` state; blocking the runtime |
| Security | Per-window capabilities; tight CSP; scanner input validated | Wildcard permissions; `"csp": null`; trusting webview payloads |
| SQLite | WAL; migrations append-only; sale+outbox in one transaction | Editing shipped migrations; writes outside transactions |
| Secrets | Keychain (tokens), CI secrets (signing keys), service-role server-side only | Service-role in the app; refresh tokens in a JSON store |
| Sync | Idempotency keys on everything; outbox + backoff + poll fallback; conflict policy written down | Bare-POST retries; realtime-only architecture; last-write-wins on money |
| Storage | Store-scoped paths; private buckets + short-lived signed URLs | Flat public buckets; long-lived tokens |
| Releases | tauri-action matrix; draft → smoke → publish; manifest generated, never hand-edited | Hand-bumped versions; hand-edited `latest.json`; skip-CI tags |
| Testing | Contract tests for IPC; offline E2E; RLS isolation test | Tests against the live dev DB; real sleeps; mocked-out invariants |
| Updates | Background download, restart-time install, never during a sale | Auto-install mid-checkout; silent signature failures |

---

## Appendix B: Data Contracts

### B.1 Order (shared, versioned in `packages/shared/src/order.ts`)

```typescript
export const OrderSource = z.enum(['pos', 'website']);
export const OrderStatus = z.enum(['open', 'paid', 'voided', 'refunded', 'synced']);

export const OrderItem = z.object({
  sku: z.string().regex(/^[A-Z0-9-]{2,32}$/),
  name: z.string().max(120),              // denormalized snapshot at sale time
  quantity: z.number().int().positive(),
  unitPriceMinor: z.number().int().nonnegative(),   // snapshot — catalog may move on
  lineDiscountMinor: z.number().int().nonnegative().default(0),
});

export const Order = z.object({
  clientId: z.string().ulid(),            // §6.3 ULID
  idempotencyKey: z.string().min(10),
  source: OrderSource,
  status: OrderStatus,
  storeId: z.string().uuid(),
  operatorId: z.string().nullable(),      // null for website orders
  items: z.array(OrderItem).min(1),
  totalMinor: z.number().int(),           // computed server/Rust-side (§4.4)
  currency: z.string().length(3),
  createdAt: z.string().datetime(),       // UTC ISO-8601
});
```

### B.2 Sync Events & Channels (`packages/shared/src/events.ts`)

```typescript
export const EVENTS = {
  syncStatus: 'sync://status',            // payload: { online, pending, stuck, lastSyncedAt }
  orderCreated: 'orders://created',       // payload: { orderId }  — ID, not the entity (§3.2)
  updateReady: 'app://update-ready',
} as const;

export const CHANNELS = {
  orders: (storeId: string) => `orders:${storeId}`,   // realtime, store-filtered (§9.3)
} as const;
```

### B.3 Cloud Tables (Postgres — see §9.1; full DDL in `supabase/migrations/`)

`stores`, `staff` (auth-linked, `store_id` + `role` in app_metadata), `products` (`store_id`, `sku`, prices, `is_active`, Storage `image_path`), `orders`, `order_items` (price snapshots), `order_events` (append-only audit: every status transition with actor + timestamps — the reconciliation source of truth), `registers` (fleet telemetry, §14). Every table: RLS enabled, default-deny, policies per §9.1's pattern.

---

## Appendix C: Repo Bootstrap Checklist

The order matters — each step unblocks the next:

1. ☐ `pnpm create tauri-app` (react-ts), restructure to §1.2's layout, workspace + `packages/shared`
2. ☐ `rust-toolchain.toml`, TS `strict` + `noUncheckedIndexedAccess`, ESLint + Prettier + clippy config
3. ☐ `tauri.conf.json`: real `identifier`, real CSP (§5.3), updater pubkey placeholder → real after step 9
4. ☐ Capabilities: `main.json` with the §5.1 minimal set — review it like credentials
5. ☐ SQLite: plugin registered, WAL + FK pragmas, migrations 0001–0002 (§6.3), chain test in CI
6. ☐ Supabase project: `supabase init`, migrations + RLS (§9.1), realtime publication for `orders`/`products`
7. ☐ Auth: staff JWT flow in Rust, refresh token → keychain (§7.2–7.3); `keyring` crate wired
8. ☐ CI: `ci.yml` per §11.2 — lint/type/clippy/test/migration-chain blocking on PRs
9. ☐ Updater: key pair generated, pubkey committed, private key + password → GitHub secrets (§10.1)
10. ☐ Release: `release.yml` per §11.3, draft-release smoke checklist written, manifest hosting stood up
11. ☐ The offline E2E test (§12.5) — green on a debug build before the first real release
12. ☐ First `v0.1.0` tag → draft → smoke → publish → watch one test register update itself

Then, and only then, open the store.

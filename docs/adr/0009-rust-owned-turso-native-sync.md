# ADR-0009: Rust-Owned Turso Native Sync (Engine A) as the Sole Synced-Table Engine

- **Status:** Proposed (L3 — blocked on human approval per AGENTS.md §4.1; do NOT implement before approval)
- **Date:** 2026-09-17
- **Decision-Makers:** Merchant owner (approver), Autonomous Engineering Agent (author)
- **Consulted:** `AGENTS.md` (§1–§2 Rule ZERO, §5.7 radar), `docs/adr/0001-turso-sync-engine.md`,
  `docs/adr/0003-offline-outbox-replay.md`, `docs/adr/0007-bidirectional-sync-repair.md`,
  `docs/adr/0008-server-authoritative-sync.md`, `docs/sync/diagnostic-baseline-2026-09-17.md`,
  `CODEBASE_DOSSIER.md`, `src/sync/SyncManager.ts`, `src/db/sqlPluginAdapter.ts`

---

## 1. Context & Problem Statement

The September 2026 freeze/crash investigation (multi-agent audit, 2026-09-17) proved the
current sync transport is architecturally misplaced, not just buggy:

1. **All sync runs in the webview on the UI thread.** `src/sync/` (outbox drain, `@libsql/client`
   batch upserts, cursor/HLC pulls, JSON parse of multi-MB rows) executes as JS on the single
   webview thread. No sanctioned Tauri pattern does DB-wire-protocol from webview JS
   (Tauri plugin index, checked 2026-09-17); the sanctioned paths are the Rust HTTP/WebSocket
   plugins or `invoke()` to Rust commands.
2. **Measured 36 MB day-one bloat** (`docs/sync/diagnostic-baseline-2026-09-17.md`): one product
   row carried 20,260,360 bytes of base64 in `json_payload`; 26 receipts embedding it added
   14.6 MB. Every 5 s pull page, push batch, boot scan and 16-table UI reload re-parsed those
   bytes on the main thread → ANR (Android Go) / jetsam (iOS WKWebView).
3. **Horizon 0 (merged to `main` as `cfab95d`, all gates green) fixed the bytes, not the
   thread.** Payload hygiene (`src/sync/payloadHygiene.ts`, 25-assertion suite), targeted
   post-pull refresh, network-only socket reset, and crash capture remove the freeze
   multiplier — but sync I/O, retry, and conflict logic still live in JS behind
   `tauri-plugin-sql` + `@libsql/client`, both on the charter §2 standing-rejection list for
   synced tables. Any future payload-shape regression re-freezes the till UI.

Contracts at stake: C1 (≤ 1.5 s p95), C2 (offline checkout), C3 (cold start), C5 (idempotency),
C6 (zero silent loss).

---

## 2. Considered Options

### Option A — `turso` Rust crate native sync behind the `PosDb` trait (PROPOSED)

- **API (primary sources, checked 2026-09-17):** `turso = { features = ["sync"] }`;
  `turso::sync::Builder::new_remote(path).with_remote_url().with_auth_token().bootstrap_if_empty().build()`;
  then `db.push()`, `db.pull() -> bool`, `db.checkpoint()`, `db.stats()`
  (sources: `docs.turso.tech/sync/usage`, `docs.turso.tech/sdk/rust/reference`,
  `docs.rs/crate/turso` — stable `0.7.2` (2026-07-30), pre `0.8.0-pre.11` (2026-09-11)).
  Conflict model is **last-push-wins over logical CDC**; offline-first writes are first-class
  (`bootstrap_if_empty(false)` → serve local reads immediately, push on connectivity).
- **Pros:** all SQL + sync moves into `crates/pos-core` (zero `tauri::*` imports, headless
  `cargo test`); webview talks only via the `platform/` `invoke()` seam; pure-Rust engine, no C
  toolchain (unlike the `libsql` crate `replication` feature); `stats()` exposes
  `main_wal_size`/`network_*_bytes`/`revision` for the sync-health UI; WAL preserved until
  `push()` (no silent local loss); `checkpoint()` bounds disk. Money invariants stay
  app-level (ULID keys, idempotency columns, append-only ledger — insert-only tables make LWW
  acceptable: no concurrent cell edits exist to lose).
- **Cons:** LWW has no per-field merge (mitigated: money tables are insert-only by schema law);
  migration of the live JS outbox/transport is a multi-week, five-target effort; Turso sync
  surface is young (Rule ZERO: re-verify API at implementation start).

### Option B — Keep the hardened JS sync indefinitely (status quo + Horizon 0)

- **Pros:** zero migration risk; all gates green today; C1 mock-suite p95 67.6 ms.
- **Cons:** charter violations (`tauri-plugin-sql`, `@libsql/client` on synced tables) become
  permanent; every future sync-adjacent feature ships on the UI thread; no `cargo test`
  coverage of money movement; WKWebView CORS/thread limits remain a latent freeze vector.

### Option C — PowerSync (Postgres + sync service) — DEFERRED

- Server-authoritative checkpoints + mandated idempotent upload queue fit POS well, but it
  **replaces Turso Cloud** as business source-of-truth and doubles infra/ops.
- Re-evaluate only on the named trigger: Engine A proves unable to hit C1 ≤ 1.5 s p95 on
  real devices, or per-field inventory merge becomes a must-have the backend team will own.

### Explicitly rejected (no re-litigation)

`libsql` embedded replicas for synced tables (cloud-primary writes gate checkout on
connectivity — violates C2); ElectricSQL (read-path only; money write path stays DIY);
cr-sqlite/CRDT auto-merge for money tables (merge can manufacture ledger states no cashier
authorized); Evolu (no Rust core, no server-authoritative money path). Full scorecards in
the 2026-09-17 research report.

---

## 3. Decision (PROPOSED — approval requested)

Adopt **Option A**: the `turso` Rust crate (`--features sync`) becomes the sole engine for
synced tables, behind the existing `PosDb` trait in `crates/pos-core`. The JS outbox drain,
`@libsql/client` cloud writes, and cursor/HLC pull loop are retired in phases; the
Cloudflare Worker + Durable Object room per merchant stays as **signal-only**
(`{ merchant_id, epoch }`), data moves exclusively via `pull()`.

**Measurements carried into this decision (all run, none assumed):**
- Forensic baseline: 34.34 MiB cloud DB, 56% one product blob + 43% embedding receipts
  (`docs/sync/diagnostic-baseline-2026-09-17.md`).
- Horizon 0 hygiene suite: 25/25 pass, incl. 20 MB row → 0.2 KB with money fields intact
  (`npm run test:hygiene`).
- Contract suites green on `main`: C1 mock p95 67.6 ms / relay-kill converge 17 s; C2/C5/C6
  chaos green; bidirectional converge green.
- **Missing before cutover (must be measured, not argued):** real-device C1 two-device suite,
  Android-low cold start vs the 3.0 s floor, and Turso API re-verification per Rule ZERO.

---

## 4. Consequences & Migration Plan (execute only after approval)

1. **Spike (1 slice):** `turso` crate behind `PosDb` compiles for all five targets incl.
   `aarch64-linux-android` + `aarch64-apple-ios`; push/pull/checkpoint round-trip on
   emulators. Abort criteria: any target fails to link → stop, escalate.
2. **Dual-write shadow (behind flag):** Rust engine mirrors the JS outbox drain; nightly
   parity job diffs cloud state. No traffic switch until 7 green nights.
3. **Cutover (staged rollout):** desktop first, mobile second; relay stays signal-only;
   `db:changed` invalidation driven by `pull() -> bool`; boot serves local reads with
   `bootstrap_if_empty(false)` + WAL/outbox recovery before queries resolve.
4. **Retire:** remove `@libsql/client` cloud writes + `tauri-plugin-sql` from synced tables
   (local scratch only); payload-hygiene invariant moves into `pos-core` as a unit-tested
   Rust gate (the TS module remains for the transition).
5. **Gates blocking the tag:** two-device C1 suite, airplane-mode chaos, idempotent-replay,
   cold-start budgets per device class, five-target CI matrix.
6. **Rollback:** feature-flag revert to JS transport within one release; cloud schema is
   unchanged (same tables/columns/keys), so rollback is client-only.

- **Positive:** sync leaves the UI thread permanently; money logic becomes headlessly tested
  Rust; charter §2 violations closed; C1–C6 enforced by engine guarantees + schema law.
- **Negative / cost:** weeks of five-target migration; Turso API youth demands Rule-ZERO
  re-verification; LWW requires the insert-only ledger discipline to hold (CI-enforced).

**Decision queue for the approver:** (1) approve Option A implementation; (2) approve the
legacy-blob cloud purge runbook (`scripts/purge-cloud-images.mjs --apply`, dry-run default);
(3) defer both and hold on hardened JS sync (Option B).


````markdown
# STRICT CODE QUALITY MANDATE
## Tauri v2 (Rust) + libSQL Embedded Replica (Turso Sync) + SQLite WAL + TypeScript Frontend

**Version:** 1.0
**Applies to:** all code this agent produces or modifies in this project.
**Stack of record:** Tauri v2 desktop app · Rust backend in `src-tauri/` · libSQL embedded
replica synced with Turso (remote system of record) · SQLite in WAL mode · TypeScript frontend.

---

## HOW THIS DOCUMENT IS ENFORCED

- Every rule has a stable ID (e.g., **R3.5**, **S2.4**). Reference these IDs exactly when
  self-reporting, reviewing, or discussing violations — never paraphrase a rule.
- Rules are prioritized by severity: **BLOCKER > CRITICAL > MAJOR > MINOR** (Section 13).
- These rules **override convenience**. If a rule conflicts with "just making it work
  quickly," follow the rule.
- Only the user may waive a rule. Every waiver must be **explicitly disclosed** in the
  delivery (Section 12). An undisclosed deviation is treated as a failed delivery.
- Before every delivery, the agent MUST complete the Self-Audit (Section 11) and follow the
  Response Format (Section 12).

**Core truth to internalize:** code is read 10x more often than it is written. Every
decision must optimize for the future reader. In this stack, the future reader's hardest
problems will be **locks held across `.await`**, **transaction boundaries**, **sync
conflicts**, and **migrations under replication** — the rules below exist to make those
problems impossible to introduce by accident.

---

## SECTION 0 — GENERAL CONDUCT (R0)

- **R0.1** Read before you write. Examine existing code, structure, and conventions in the
  project before producing anything. Match the existing style unless it violates this mandate.
- **R0.2** When requirements are ambiguous, ASK clarifying questions before writing
  significant code. Never invent requirements.
- **R0.3** Never invent APIs, libraries, crate functions, or Tauri commands that you cannot
  verify exist in the project's pinned dependencies. If the exact `libsql` crate API is
  uncertain for the pinned version, verify or state the uncertainty explicitly.
- **R0.4** Never deliver placeholder/scaffold code (`// implement later`, empty stubs,
  `todo!`, `unimplemented!`) unless the user explicitly requests scaffolding.
- **R0.5** If you cannot fully implement something, say so explicitly and deliver a working,
  honest partial implementation with clearly stated boundaries. Never fake completeness.
- **R0.6** If a required design decision is missing (e.g., a conflict strategy for a new
  synced table — see S3.2), STOP and ask the user rather than silently choosing one.

---

## SECTION 1 — ARCHITECTURE & PROJECT STRUCTURE (R1)

- **R1.1** Follow this canonical layout (adapt names, keep the layering):

```
src-tauri/src/
  main.rs            — entry only (calls app_lib::run())
  lib.rs             — builder, state registration, command registration,
                       startup order (S2.2), shutdown hooks (S2.3)
  error.rs           — AppError (thiserror + Serialize) + error mapping
  state.rs           — AppState construction
  commands/          — #[tauri::command] handlers. THIN. No SQL, no business logic.
  services/          — business logic (pure, testable, no tauri:: types)
  db/
    connection.rs    — THE one replica/connection builder + PRAGMA init +
                       documented writer & token-loading policy
    sync.rs          — the ONE sync worker (S2.4), SyncStatus, backoff
    migrations.rs    — migration runner
    migrations/      — versioned .sql files (V<n>__<snake_description>.sql)
    repos/           — ALL SQL lives here. Typed functions per table/aggregate.
  models/            — serde DTOs crossing IPC; domain structs (no serde) in services
src/ (frontend)
  api/               — ALL invoke() wrappers + TS types mirroring Rust DTOs
  components/ etc.   — presentation only
```

- **R1.2** `main.rs` stays minimal; app logic lives in `lib.rs::run()` (Tauri v2 pattern,
  keeps the backend testable).
- **R1.3** Layering is absolute and one-directional:
  `commands → services → repos → libSQL`. Repos never import commands/services; services
  never import `tauri::*`. No circular dependencies, ever.
- **R1.4** All SQL lives in `db/repos/`. SQL strings in commands or services are a
  CRITICAL violation.
- **R1.5** No `utils.rs` / `helpers.rs` dumping ground. Every module name states a specific
  responsibility. One concept = one name, project-wide (do not mix `fetch`/`get`/`load`
  for the same operation).
- **R1.6** Separation of concerns: every file and module has exactly ONE reason to change.
  If you can only describe a file's purpose using the word "and," split it.
- **R1.7** File limits: Rust ≤ 400 lines, TS ≤ 300 lines (excluding tests). Split by
  responsibility when exceeded.
- **R1.8** Frontend types mirror Rust DTOs; **Rust is the single source of truth**. Prefer
  `tauri-specta` generated bindings; if manual, every TS type carries a comment naming its
  Rust source file. Type drift is a bug.
- **R1.9** All I/O (network, filesystem, database, clock, sync) lives at the boundary in
  dedicated modules; core business logic in `services/` stays pure and testable without I/O.

---

## SECTION 2 — RUST BACKEND & COMMANDS (R2)

- **R2.1** `cargo fmt` clean; `cargo clippy -- -D warnings` clean. Zero unjustified allows.
  Any `#[allow(...)]`, `#[cfg_attr]` suppression, or lint ignore requires an inline
  justification comment naming what it silences and why it is safe.
- **R2.2** `.unwrap()`, `.expect()`, `panic!`, `todo!`, `unreachable!()` are FORBIDDEN in
  `src-tauri/src` outside tests. All fallible paths return `Result`. Column reads of
  nullable values map to `Option<T>` — never unwrap a column read.
- **R2.3** Every command returns `Result<T, AppError>`. `AppError` derives
  `thiserror::Error` + `Serialize` (pattern in Appendix A). Never leak raw `libsql::Error`
  strings (which may contain SQL or the database URL) to the frontend: map them with
  context, log full details via `tracing`, send a sanitized message plus a stable
  machine-readable code.
- **R2.4** Commands are thin: validate input → call service → map error. ≤ 40 lines.
  GOTCHA (tauri requirement): async commands taking `State<'_, _>` MUST return `Result` —
  never fight this; structure all commands accordingly.
- **R2.5** Commands touching the DB are `async fn` (libSQL is async). Heavy CPU work
  (parsing, hashing, image processing) goes through `tokio::task::spawn_blocking`. Never
  block the async runtime or the main thread.
- **R2.6** State via `Builder::manage(AppState {...})` + `State<'_, AppState>` injection.
  No `static mut`, no global singletons, no `lazy_static`/`OnceLock` DB connection or
  Database handle globals.
- **R2.7** Lock discipline (BLOCKER-grade):
  - A `std`/`parking_lot` Mutex/RwLock guard must NEVER be alive across an `.await`.
  - If a lock must be held across `.await`, use `tokio::sync::Mutex` and document why.
  - Keep every critical section minimal.
- **R2.8** Logging: `tracing` crate, structured, leveled; file output with rotation in
  production. NEVER log secrets, Turso auth tokens, or PII.
- **R2.9** Domain logic must be testable WITHOUT a Tauri `AppHandle` — put it in services.
  If a function needs `AppHandle` to be testable, it is designed wrong.

---

## SECTION 3 — DATA LAYER: libSQL + SQLite WAL (R3)

- **R3.1** ONE database access layer: the `libsql` crate, pinned, with `bundled` feature
  for local builds. Never mix `rusqlite`, `tauri-plugin-sql`, or raw FFI in the same
  codebase.
- **R3.2** The embedded replica and every connection are created ONLY through the
  centralized builder in `db/connection.rs`. Per-connection PRAGMAs are applied there
  (they reset on each new connection):

```sql
PRAGMA journal_mode = WAL;      -- replicas force WAL; verify returned mode == 'wal', error if not
PRAGMA synchronous = NORMAL;    -- correct pairing with WAL
PRAGMA busy_timeout = 5000;     -- MANDATORY. Value = named constant (BUSY_TIMEOUT_MS).
PRAGMA foreign_keys = ON;       -- per-connection; forgetting it disables FKs silently
```

  If the crate manages an internal connection pool, verify every pooled connection
  receives `busy_timeout` and `foreign_keys = ON`.
- **R3.3** `synchronous = OFF` is FORBIDDEN (corruption risk on power loss).
  `EXTRA_CHECKS` in debug builds is encouraged.
- **R3.4** Writer policy (documented in `db/connection.rs`): SQLite WAL = many concurrent
  readers + ONE writer at a time. With sync enabled, local writes ALSO contend with
  sync-applied frames. Therefore: writes are serialized (e.g., a `tokio::sync::Mutex`
  guarding write transactions), write transactions are kept SHORT, and ad-hoc connections
  created inside command handlers are FORBIDDEN.
- **R3.5** Transaction rules (BLOCKER-grade):
  - Every multi-statement write MUST be inside an explicit transaction
    (`conn.transaction().await?` … `tx.commit().await?`).
  - A transaction MUST contain only DB statements. NO `.await` on IPC, events, network,
    filesystem, sleeps, or long computation inside an open transaction.
  - On any error, roll back (propagate with `?` before commit). Never commit partial work.
  - Keep transactions as short as possible — long write transactions block all other
    writers AND starve the sync worker (S2.4).
- **R3.6** Read transactions/cursors are closed promptly. Long-lived readers hold back
  WAL growth.
- **R3.7** ALL queries use bound parameters (`params![...]`). String concatenation,
  `format!`-built, or interpolated SQL is a BLOCKER. Dynamic identifiers (table, column,
  ORDER BY expressions) from user input are allowed ONLY through a hardcoded allowlist
  mapping — unknown value → typed error.
- **R3.8** Bulk inserts: one transaction for the whole batch; chunk statements so total
  bound parameters stay well under SQLite's limit (safe default: ≤ 500 rows/statement,
  `INSERT_CHUNK_SIZE` constant). Never insert N rows as N separate transactions.
- **R3.9** Row mapping is explicit and typed. Column access by name preferred for queries
  with joins; by index acceptable with a comment. `SELECT *` is forbidden — always list
  explicit columns.
- **R3.10** Never store large blobs in rows (rule of thumb: > 1 MB, threshold documented
  in the repo module) — store a file path reference.
- **R3.11** Map `libsql::Error` at the repo boundary into domain errors with context
  (which operation, which IDs). `SQLITE_BUSY` after busy_timeout maps to a distinct
  "database is busy, retry" `AppError` variant the UI can handle specifically.
- **R3.12** WAL lifecycle under replication (BLOCKER-grade):
  - The local WAL is managed by libsql as the **replication substrate**. Do NOT manually
    run `wal_checkpoint` or `VACUUM` on the replica unless verified compatible with the
    pinned libsql version — do not fight the substrate.
  - Shutdown (`RunEvent::ExitRequested`/`Exit`): bounded final `sync()` (S2.3), then close.
  - Backups: the **remote Turso DB is authoritative** — primary backups happen Turso-side
    (`turso db shell <db> .dump` / platform backups). A local copy of `db + -wal + -shm`
    (with the app closed) is a valid local snapshot only. Copying the `.db` file alone is
    a BLOCKER (data loss — committed data may still be in the `-wal`).
  - The replica must live on a local filesystem — WAL requires shared memory; network
    drives are unsupported. If config allows custom DB paths, validate and warn.

---

## SECTION 4 — TURSO EMBEDDED REPLICA SYNC (S) — HIGHEST PRIORITY

### S1 — Topology & Truth Model

- **S1.1** Document the sync topology in `db/connection.rs` (set in CONFIG):
  (a) single user, multiple devices ↔ ONE Turso database, or
  (b) multi-user, database-per-user via Turso Platform + ephemeral tokens.
  The local replica = read cache + offline write buffer. The remote Turso DB = system of record.
- **S1.2** Durability model, stated in the sync module's doc comment: a write is
  **LOCAL-DURABLE** after commit (WAL) and **CLOUD-DURABLE** only after a successful
  `sync()`. The UI must never claim "saved to cloud" before sync completes. UI language
  distinguishes Local-only vs Synced.
- **S1.3** Every table is potentially multi-writer (devices act as independent writers),
  even in topology (a). No table is exempt from the cross-device rules (S3).
- **S1.4** Attached databases (`ATTACH`) are local-only and do NOT replicate. Never put
  synced data in an attached DB.

### S2 — Sync Lifecycle & Execution

- **S2.1** Replica creation ONLY via the centralized builder in `db/connection.rs`:
  `libsql::Builder::new_remote_replica(url, db_path).with_auth_token(token)` — verify the
  exact API against the pinned crate version. No other code path constructs a `Database`.
- **S2.2** Startup order is FIXED and documented in `lib.rs`:
  build replica → `sync()` (pull, with timeout) → run migrations (Section 5) → serve commands.
- **S2.3** Shutdown: best-effort final `sync()` with a bounded timeout (default 5 s,
  `SHUTDOWN_SYNC_TIMEOUT`) to push pending writes, then close connections.
- **S2.4** BLOCKER: exactly ONE sync worker (a dedicated tokio task) owns `db.sync()`.
  All triggers (interval, debounce, focus, manual, shutdown) submit requests to it via an
  mpsc channel. Concurrent `sync()` calls from multiple code paths are FORBIDDEN.
  `sync()` is NEVER called inside an open transaction — pulled frames are applied as local
  writes, so sync competes for SQLite's single writer (reinforces R3.5).
- **S2.5** Sync policy — named constants, values in CONFIG: periodic interval
  (default 30–60 s), debounce after local write (2–5 s), sync on window focus
  (Tauri event → thin `request_sync` command → worker), manual sync command. Every sync
  attempt has a timeout (default 10 s) and typed errors.
- **S2.6** Offline is a first-class STATE, not an error: network failure →
  `SyncStatus::Offline`, retry with capped exponential backoff + jitter (1 s → 30 s).
  Local reads/writes continue unaffected. NEVER block user actions on network availability.
- **S2.7** Sync status reaches the frontend via a typed Tauri v2 `Channel<SyncStatus>`:
  `idle | syncing | synced { at } | offline | error { code } | conflict`. One final state
  event per attempt — no event spam. The frontend renders a persistent sync indicator
  ("All changes saved locally" / "Synced 12:03").

### S3 — IDs, Multi-Device Writes & Conflicts

- **S3.1** BLOCKER: synced tables MUST NOT rely on auto-assigned rowid / AUTOINCREMENT
  primary keys — offline devices WILL mint colliding IDs. PKs are app-generated in Rust:
  UUIDv7 (time-ordered, `uuid` crate, v7 feature) or ULID. `INTEGER PRIMARY KEY`
  autoincrement is allowed ONLY on tables that never sync.
- **S3.2** Every row writable from multiple devices needs a DOCUMENTED conflict story in
  its repo module (e.g., whole-row LWW by `updated_at` with UUIDv7 tiebreak; append-only
  events; field-level merge). If you cannot state the story, the feature is not sync-safe —
  STOP and escalate to the user (R0.6).
- **S3.3** Never use wall-clock time for correctness. Device clocks skew arbitrarily.
  Timestamps are metadata/display and LWW tiebreak ONLY. Ordering guarantees come from
  UUIDv7 IDs or explicit sequence logic — never timestamps alone.
- **S3.4** BLOCKER: a failed push is never silently dropped (silent data loss). Push
  failure (remote advanced / conflict) → pull → then either replay the pending operation
  (requires S3.5 modeling) or surface a typed conflict to the UI for user resolution.
  Dropped writes = failed delivery.
- **S3.5** Prefer append-only immutable rows (event/log + derived state) over in-place row
  mutation. In-place UPDATE of the same row from two devices is the highest-conflict
  pattern in frame replication — avoid it by design.
- **S3.6** Deletes on synced tables are SOFT (tombstone: `deleted_at`), not `DELETE`,
  unless the user approves hard deletes. Hard delete + offline insert = resurrection
  anomalies. Tombstones get a documented purge policy (CONFIG).

### S4 — Auth & Secrets (Turso Tokens)

- **S4.1** BLOCKER: Turso auth tokens NEVER in source, NEVER in the frontend bundle, NEVER
  in logs, NEVER in Tauri capabilities/config, NEVER serialized into errors or events.
  Dev: env vars (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`) from a gitignored `.env`.
  Production desktop: OS keyring (`keyring` crate) — token stored once (login flow or
  user paste), read at startup into `AppState` memory only.
- **S4.2** Topology (b) only: tokens are EPHEMERAL JWTs minted by YOUR backend via the
  Turso Platform API (create-db-per-user + issue token) over HTTPS. The desktop app never
  holds a long-lived platform token. The refresh flow is explicit, tested, failure-mapped.
- **S4.3** libsql/Hrana error strings can echo the database URL — sanitize before crossing
  IPC. Remote failures map to a stable `SyncErrorCode`; full detail goes to `tracing`.
- **S4.4** A documented revocation plan exists (how a leaked token is invalidated via the
  Turso dashboard/API).

### S5 — Migrations Under Sync (extends Section 5)

- **S5.1** Schema changes replicate to every client, including clients running OLD code.
  Therefore migrations are **EXPAND-CONTRACT ONLY**: release N adds (nullable columns, new
  tables, new indexes); clients backfill lazily; drop/rename happens only in release N+1
  once all clients are updated. A destructive migration shipped while old clients exist is
  a data-loss BLOCKER.
- **S5.2** The migration channel is chosen in CONFIG and used exclusively:
  (a) LOCAL (default): each client applies migrations to its replica at startup,
      pre-serve; migrations are idempotent AND deterministic so concurrent clients converge; OR
  (b) REMOTE-FIRST: CI/turso CLI applies migrations to the primary; fresh replicas receive
      schema via initial sync; the local runner only verifies, never mutates.
- **S5.3** The migration runner and the sync worker are strictly separate; migrations
  never run inside the sync worker. The migration-tracking table (`_migrations` /
  `user_version`) is itself synced — a client seeing a FUTURE migration version must
  refuse to write and prompt for an app update.

---

## SECTION 5 — SCHEMA & MIGRATIONS (R4)

- **R4.1** Migrations are versioned, forward-only files (`V<n>__<snake_description>.sql`),
  run at startup AFTER the initial sync (S2.2 order) and BEFORE any command is served,
  each inside a transaction (SQLite DDL is transactional), tracked via `PRAGMA user_version`
  or a `_migrations` table (pick in CONFIG). Startup aborts with a clear error on failure.
- **R4.2** An applied migration is IMMUTABLE. Never edit a migration that has shipped —
  write a new one. Editing applied migrations is a BLOCKER.
- **R4.3** Destructive changes (DROP, rename, type change) require a documented
  data-preservation step (backup or copy-forward migration) in the same delivery, AND must
  respect expand-contract (S5.1).
- **R4.4** Schema conventions (project-wide, consistent):
  - snake_case identifiers; singular table names (`user`, `order_item`).
  - Synced tables: UUIDv7 TEXT primary keys (S3.1). Never-synced tables may use
    `id INTEGER PRIMARY KEY`.
  - Timestamps: `created_at`/`updated_at` INTEGER NOT NULL (unix epoch ms) via a single
    shared helper — one convention, everywhere (set in CONFIG).
  - Every FK declares explicit `ON DELETE` behavior. Every FK column gets an index.
  - Synced tables carry `deleted_at` (tombstone, nullable) per S3.6.
  - `updated_at` maintained EITHER by trigger OR in repos — pick one, document it.
  - Constraints live in the DATABASE (NOT NULL, UNIQUE, CHECK), not only in app code —
    the DB is the last line of defense.
- **R4.5** Every additional index has a one-line justification comment naming the query it
  serves. No speculative indexes.

---

## SECTION 6 — TAURI v2 SECURITY & IPC (R5)

- **R5.1** Capabilities (`src-tauri/capabilities/*.json`): least privilege. Every listed
  permission is individually justified in a comment or docs. Wildcard/dangerous permissions
  (`shell:allow-execute`, broad `fs`/`http` scopes) require explicit user approval.
- **R5.2** The frontend is UNTRUSTED (a compromised webview must not be able to damage the
  system). Therefore: the frontend NEVER sends SQL, table names, column names, file paths,
  sort expressions, or sync parameters. It sends intent (`filter`, `page`) and Rust
  resolves it. (This is why R1.4 puts all SQL in Rust.)
- **R5.3** All command inputs are validated at the boundary: type, range, length, format.
  Invalid input → typed `AppError` variant — never a panic, never a raw error blob.
- **R5.4** CSP is set and strict in `tauri.conf.json` (`default-src 'self'` baseline, no
  `unsafe-eval`, inline scripts minimized). `csp: null` allowed only in dev.
- **R5.5** Events: names follow `domain:action` kebab-case (e.g., `sync:state-changed`).
  Payloads are minimal typed structs — no secrets, no PII, no internal errors, no DB URL.
  Streaming/progress uses Tauri v2 `Channel<T>` (including `Channel<SyncStatus>`), not
  repeated events. A frontend "request sync" is a thin command that notifies the worker —
  the frontend NEVER triggers sync logic itself or learns the DB URL/token.
- **R5.6** Pin `tauri` and all plugin versions; note in the delivery when versions are
  outdated enough to matter. If the updater plugin is used, signatures are mandatory.
- **R5.7** Filesystem plugin (if used) is scoped to the app data dir only.
- **R5.8** General security: no secrets in source/test fixtures; no dynamic code execution
  on untrusted input (`eval`, `exec`, `new Function`); safe file handling with path
  traversal guards; never log secrets, tokens, or PII.

---

## SECTION 7 — FRONTEND TYPESCRIPT (R6)

- **R6.1** `tsconfig` strict. `any` is forbidden; `unknown` + type narrowing is the
  pattern. No non-null assertions (`!`) without inline justification.
- **R6.2** ALL `invoke()` calls go through typed wrappers in `src/api/`. Scattered
  `invoke('cmd_name')` in components is a MAJOR violation.
- **R6.3** Errors from commands are mapped by their machine-readable code into a typed
  `ApiError` in ONE central place; the UI branches on the type, never on string matching.
- **R6.4** Every async UI operation renders loading / error / success states — AND the
  sync state (S1.2, S2.7). No fire-and-forget. Destructive UI actions ("delete everywhere")
  require sync-aware confirmation, since effects propagate to other devices only after sync.
- **R6.5** No business logic duplicated from Rust — Rust is the authority. The frontend
  presents; it does not decide.
- **R6.6** No `console.log` in delivered code (a debug-level logger utility is allowed).
  No secrets/tokens in frontend code ever.

---

## SECTION 8 — TESTING (R7)

- **R7.1** Every feature and bugfix ships with tests, Rust-first. No exceptions without
  explicit user waiver.
- **R7.2** Integration DB tests use a REAL file database in a unique temp dir per test,
  with the REAL init path from `db/connection.rs` (so PRAGMAs and WAL are actually tested)
  and migrations applied from scratch. Assert `journal_mode` is `wal`. In-memory-only DB
  tests are additional, never a replacement.
- **R7.3** Required DB coverage per repo function: happy path, empty result, constraint
  violation (FK/UNIQUE/NOT NULL), NULL handling, and boundary pagination values.
- **R7.4** Concurrency test: N parallel write tasks against the real DB verifying
  busy_timeout behavior and zero corruption.
- **R7.5** Migration test: fresh DB applies all migrations in order; version tracking ends
  at max; smoke SELECT on every table succeeds.
- **R7.6** Sync tests (all MANDATORY — see S6 categories):
  - **Round trip:** TWO replicas (two temp dirs) against one test Turso DB (dedicated CI
    database or local `turso dev`/sqld). Write on A → sync A → sync B → assert B reads it.
  - **Conflict:** write on A AND B while both offline → sync both → assert the documented
    conflict story (S3.2) holds: no corruption, no lost rows, conflicts surfaced or
    converged exactly as designed.
  - **Offline:** unreachable URL → local writes succeed → `Offline` state → reconnect →
    next sync pushes everything → zero loss.
  - **ID collision (regression guard for S3.1):** both replicas insert N rows offline →
    after both syncs, zero duplicate PKs, zero lost rows.
  - **Migration skew:** replica at schema Vn + remote at Vn+1 (old-client simulation) →
    old client's smoke queries still pass on the expanded schema.
  - **Shutdown flush:** write → trigger exit path → assert the final bounded sync pushed
    the write to the remote.
- **R7.7** Command/service logic is tested through services (no `AppHandle` needed, per
  R2.9). Frontend: pure-logic unit tests + api layer mocked.
- **R7.8** Tests are deterministic: unique temp dirs, no real network outside sync tests,
  no real timers, no order dependence, no shared mutable fixtures.
- **R7.9** Bugfix protocol: (1) write a failing test reproducing the bug, (2) fix the code,
  (3) keep the test as a permanent regression guard.
- **R7.10** Test names describe behavior (`it("returns 404 when the user does not exist")`),
  never `test1`/`testUser`. Follow Arrange–Act–Assert; test through the PUBLIC interface
  only, never implementation details.

---

## SECTION 9 — GENERAL QUALITY (R8)

- **R8.1** Naming:
  - Rust: `snake_case` fns/vars, `PascalCase` types, `SCREAMING_SNAKE_CASE` consts.
  - TS: `camelCase` fns/vars, `PascalCase` types/components.
  - Names reveal intent instantly; if a name needs a comment, rename it.
  - Booleans are predicates (`is_active`, `has_access`, `can_retry`). Functions are verbs
    (`load_user_by_id`). Classes/modules/types are nouns (`OrderRepository`, `SyncWorker`).
  - FORBIDDEN names: single letters (except `i/j/k` in tight loops), `data`, `temp`,
    `info`, `value2`, `thing`, `stuff`, `obj`, `res`, `foo`, `bar`, `baz`, and vague
    suffixes like `Manager`/`Handler`/`Processor` unless genuinely accurate.
  - No encodings in names (`strName`, `m_value`) unless the ecosystem requires it.
- **R8.2** No magic numbers or strings. PRAGMA values, timeouts, chunk sizes, sync
  intervals, backoff caps, blob thresholds are named constants WITH units
  (`BUSY_TIMEOUT_MS`, `INSERT_CHUNK_SIZE`, `SYNC_INTERVAL_SECS`). Environment-specific
  values (URLs, keys, flags) are externalized to configuration — zero hardcoded
  environment values.
- **R8.3** Comments explain WHY, never WHAT — code needing a WHAT-comment must be
  rewritten. Public Rust items carry doc comments (purpose, args, errors, side effects).
  Every module has a top doc comment stating its single responsibility. Non-obvious
  algorithms cite their source. Commented-out code is forbidden — delete it; version
  control remembers. No TODO/FIXME without a ticket reference: `// TODO(TICKET-123): ...`.
- **R8.4** No dead code, no unused imports/variables/functions, no debug `println!` or
  `console.log` left in delivered code.
- **R8.5** Dependencies: pinned via lockfiles, minimal features, every addition justified
  in the delivery (problem, alternatives considered, license, maintenance status). Don't
  add a package for one tiny function — implement it or centralize internally. Check the
  project for an existing solution first.
- **R8.6** Version control: Conventional Commits (`feat(db): ...`, `fix(sync): ...`,
  `refactor(cmd): ...`) — imperative, lowercase, ≤ 72 chars, no trailing period. Atomic
  commits: one logical change; the codebase builds and passes tests at EVERY commit.
  Never mix refactoring and behavior changes in the same commit. Never commit: secrets,
  `target/`, `dist/`, `.db`/`-wal`/`-shm` files, logs, build artifacts (gitignore them).
- **R8.7** Performance: correctness and clarity FIRST. Optimize only with measured
  evidence, documented in a comment naming the measurement. No accidental O(n²) — correct
  data structures for lookups. Never load unbounded data into memory — paginate or stream.
- **R8.8** Refactoring legacy code: clean what you touch (scoped Boy Scout Rule); do NOT
  silently reformat entire files (diff noise hides real changes). Before changing legacy
  behavior, add characterization tests capturing CURRENT behavior, then change the code
  keeping them green.

---

## SECTION 10 — ABSOLUTE PROHIBITIONS (BLOCKERS — ANY ONE = FAILED DELIVERY)

**Data & SQL:**
- SQL built via string concatenation, `format!`, or interpolation.
- Any SQL, table name, column name, file path, or sort expression accepted from the frontend.
- Missing `busy_timeout`, or missing per-connection `foreign_keys = ON`.
- `synchronous = OFF`.
- Multi-statement write without an explicit transaction.
- Non-DB `.await` (IPC/network/fs/sleep) inside an open transaction.
- A non-async Mutex/RwLock guard alive across `.await`.
- Backing up the DB by copying only the `.db` file (without `-wal`).

**Sync (Turso):**
- Turso token in source, bundle, frontend, logs, or IPC payloads.
- Autoincrement/rowid PK on any synced table.
- `sync()` called concurrently from multiple paths, or inside any open transaction.
- Silent drop of a failed push (data loss).
- Destructive migration shipped while old client versions may exist (violates expand-contract).
- UI claiming cloud-saved before a successful sync.
- Manually running `wal_checkpoint`/`VACUUM` on the replica without verified compatibility
  with the pinned libsql version.
- Sync without a timeout; retry loops without backoff/jitter/cap.

**Rust & TS:**
- `.unwrap()`/`.expect()`/`panic!`/`todo!` in production Rust paths.
- `any` in TS, or untyped/raw `invoke()` outside the api layer.
- Unjustified clippy/lint suppressions (`#[allow]`, `@ts-ignore`, `eslint-disable`,
  `type: ignore`) — allowed ONLY with an inline justification.
- Commented-out code or dead code.
- Global mutable state; DB connections or Database handles as globals.
- Debug `println!`/`console.log` left in delivered code.
- Sleep-based "fixes" for race conditions.
- Workarounds without a comment naming the root cause and why the workaround is safe.
- Functions with hidden side effects their name doesn't announce.

**Security:**
- Secrets, API keys, or credentials in source, comments, test fixtures, or logs.
- Wildcard capabilities/permissions without explicit user approval.
- `eval`/dynamic code execution on untrusted input.

---

## SECTION 11 — MANDATORY SELF-AUDIT (before every delivery)

Silently verify EVERY item. If any fails, FIX IT before responding.

**Build & hygiene:**
- □ Compiles; clippy `-D warnings` clean; `cargo fmt` applied; TS strict-clean.
- □ No unwrap/expect/panic/todo in production paths; zero unjustified suppressions.
- □ No dead code, no commented-out code, no debug statements, no TODOs without tickets.
- □ Naming per R8.1; no forbidden names; files within limits (R1.7).

**Data layer:**
- □ Connection/replica init centralized; all PRAGMAs applied per connection; WAL verified.
- □ Writer policy documented; no ad-hoc connections; lock rules (R2.7) satisfied.
- □ Every multi-statement write transactional; no foreign awaits inside transactions.
- □ All queries parameterized; any dynamic identifier allowlisted.
- □ No manual checkpoint/VACUUM on the replica; backup logic WAL-safe.

**Sync:**
- □ Sync worker is the sole `sync()` caller; no sync inside transactions.
- □ Startup order (S2.2) and bounded final-sync-on-exit (S2.3) present.
- □ No autoincrement PKs on synced tables; UUIDv7 generation centralized.
- □ Conflict story documented per multi-writer table (S3.2) — or escalated to user.
- □ Token from keyring/env only; absent from bundle, logs, IPC.
- □ Failed-push handling implemented (no silent drops); offline state handled with backoff.
- □ UI distinguishes local-durable vs cloud-durable; sync indicator wired via Channel.

**Schema & migrations:**
- □ Migrations forward-only; none edited; destructive ones documented + expand-contract
  respected; no destructive migration while old clients may exist.
- □ Migration runner separate from sync worker; future-version client refuses to write.

**IPC & frontend:**
- □ Commands thin, async, `Result<T, AppError>`; errors serialized, sanitized, logged
  with context; frontend maps by machine-readable code.
- □ Frontend: strict types, centralized api layer, typed error mapping, no raw invoke,
  async + sync states rendered.
- □ Capabilities minimal; CSP strict; no secrets anywhere.

**Testing:**
- □ Tests per Section 8, including real-WAL-file integration tests and the six mandatory
  sync categories (R7.6) — or the user explicitly waived them, and you said so.

**Final:**
- □ ZERO items from Section 10.

---

## SECTION 12 — REQUIRED RESPONSE FORMAT

Every code delivery MUST include, in this order:

1. **Summary** — what was built/changed and why (2–5 bullets).
2. **Code** — organized by file, with FULL file paths as headers.
3. **Rationale** — file-by-file notes for every non-obvious decision. For ANY code
   performing writes: explicitly state the transaction boundary and every lock held
   (and whether across `.await`).
4. **Schema/Migrations** — files added/changed; confirmation that none already applied
   were edited; expand-contract compliance noted.
5. **Sync Design Note** — for any delivery touching the data model or write paths:
   which tables are multi-writer, per-table conflict story, ID strategy, and affected
   sync states.
6. **Testing** — what is covered, what is intentionally not covered, and why.
7. **Risks & Assumptions** — explicitly listed.
8. **Deviations** — any rule deviated from and the reason. Undisclosed deviations are
   treated as failures.
9. **Verdict** — final line: `Self-audit: PASS` (plus caveats if any).

---

## SECTION 13 — ISSUE SEVERITY MODEL

Use this scale for self-review, code review, and discussing violations:

- **BLOCKER** — security flaws (token leakage, SQL injection), data loss (silent push drop,
  bad backup, destructive migration with old clients), incorrect behavior, broken build,
  any Section 10 item.
- **CRITICAL** — architecture violations (SQL outside repos, layering breaks),
  missing error handling, untestable code, lock-across-await risks, missing mandatory tests.
- **MAJOR** — bad naming, duplication, missing docs on public APIs, missing tests on key
  paths, raw invoke outside the api layer, untyped error handling.
- **MINOR** — style polish, comment quality, minor performance.

**Delivery standard:** zero BLOCKER, zero CRITICAL. Every MAJOR fixed or justified in
writing. MINOR issues may be listed for later.

---

## APPENDIX A — CANONICAL PATTERNS (follow exactly unless the user overrides)

```rust
// src-tauri/src/error.rs
#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(tag = "code", content = "message", rename_all = "snake_case")]
pub enum AppError {
    #[error("user {0} not found")]
    UserNotFound(String),                    // UUIDv7 ids are strings
    #[error("invalid email: {0}")]
    InvalidEmail(String),
    #[error("database busy, please retry")]
    DatabaseBusy,
    #[error("sync conflict, review changes")]
    SyncConflict,
    #[error("internal error")]               // sanitized; full details go to tracing
    Internal,
}
```

```rust
// src-tauri/src/db/repos/ — transaction pattern (R3.5)
pub async fn transfer_credits(conn: &Connection, from: &str, to: &str, amount: i64)
    -> Result<(), AppError> {
    let tx = conn.transaction().await?;
    tx.execute(
        "UPDATE user SET credits = credits - ?1 WHERE id = ?2",
        params![amount, from],
    ).await?;
    tx.execute(
        "UPDATE user SET credits = credits + ?1 WHERE id = ?2",
        params![amount, to],
    ).await?;
    tx.commit().await?;   // any `?` above aborts — no partial commit ever happens
    Ok(())
}
```

```rust
// src-tauri/src/commands/ — thin command pattern (R2.4)
#[tauri::command]
async fn create_user(state: State<'_, AppState>, payload: CreateUserPayload)
    -> Result<UserDto, AppError> {
    let input = payload.validate()?;               // boundary validation
    state.services.users.create(input).await       // thin delegation
}
```

```typescript
// src/api/users.ts — typed frontend wrapper (R6.2)
export async function createUser(payload: CreateUserPayload): Promise<User> {
  return invoke<User>("create_user", { payload });
}
```

---

## APPENDIX B — TURSO SYNC PATTERNS

```rust
// src-tauri/src/db/connection.rs — replica construction (S2.1, S4.1)
// VERIFY exact Builder API against the pinned libsql crate version.
pub async fn open_replica(cfg: &DbConfig) -> Result<Database, AppError> {
    let token = load_auth_token(cfg)?;   // env (dev) | keyring (prod) — never source
    let db = libsql::Builder::new_remote_replica(cfg.url.clone(), cfg.path.clone())
        .with_auth_token(token)
        .build()
        .await
        .map_err(|e| map_db_init_error(e))?;   // sanitize URL from the message (S4.3)
    Ok(db)
}
```

```rust
// src-tauri/src/db/sync.rs — the ONE sync worker (S2.4)
pub enum SyncTrigger { Interval, DebouncedWrite, Focus, Manual, Shutdown }

#[derive(Clone, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SyncStatus {
    Idle,
    Syncing,
    Synced { at_unix_ms: i64 },
    Offline,
    Error { code: SyncErrorCode },   // stable machine-readable code
    Conflict,                        // needs S3.4 resolution path
}

pub async fn run_sync_worker(
    db: Database,
    status: Channel<SyncStatus>,
    mut requests: mpsc::Receiver<SyncTrigger>,
) {
    let mut tick = tokio::time::interval(SYNC_INTERVAL);
    loop {
        let trigger = tokio::select! {
            _ = tick.tick() => SyncTrigger::Interval,
            Some(t) = requests.recv() => t,
        };
        if matches!(trigger, SyncTrigger::Shutdown) {
            let _ = bounded_sync(&db, SHUTDOWN_SYNC_TIMEOUT).await;  // S2.3
            break;
        }
        status.send(SyncStatus::Syncing).ok();
        match bounded_sync(&db, SYNC_TIMEOUT).await {
            Ok(at) => { status.send(SyncStatus::Synced { at_unix_ms: at }).ok(); }
            Err(e) => { status.send(classify_sync_error(e)).ok(); } // Offline/Error/Conflict
        }
    }
}
```

```rust
// src-tauri/src/db/repos/ — synced-table insert (S3.1, S3.3)
pub async fn insert_note(conn: &Connection, payload: NewNote) -> Result<Note, AppError> {
    let id = Uuid::now_v7();          // app-generated, collision-free across devices
    let now = unix_ms_now();
    conn.execute(
        "INSERT INTO note (id, body, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?3, NULL)",
        params![id, payload.body, now],
    ).await?;
    Ok(Note { id, body: payload.body, created_at: now, updated_at: now })
}
```

```rust
// src-tauri/src/commands/sync.rs — thin trigger command (R5.5)
#[tauri::command]
async fn request_sync(state: State<'_, AppState>) -> Result<(), AppError> {
    state.services.sync.request().await   // notifies the worker; never syncs inline
}
```

---

## APPENDIX C — INVARIANTS CHEAT SHEET (the "why" behind the rules)

Read this until it is instinct; the rules follow from these facts:

1. **WAL = many readers + ONE writer at a time.** Writers queue; `busy_timeout` decides
   whether they wait or fail. (→ R3.4, R3.5)
2. **A local commit is not cloud-durable.** Durability arrives only via a successful
   `sync()`. (→ S1.2, S3.4)
3. **Pulled frames are applied as local writes.** Sync competes for the single writer —
   hence no sync inside transactions and short write transactions. (→ S2.4, R3.5)
4. **Offline devices mint independent writes.** Auto-assigned rowids WILL collide;
   device clocks WILL disagree. (→ S3.1, S3.3)
5. **Frame replication does not auto-merge concurrent writes to the same row.**
   (→ S3.2, S3.5)
6. **Schema replicates to old clients too.** (→ S5.1 expand-contract)
7. **A lock held across `.await` can deadlock the whole backend.** (→ R2.7)
8. **The webview is untrusted territory.** Everything it sends is input, never instruction.
   (→ R5.2)
9. **A Turso auth token is a full-database credential.** (→ S4.1)
10. **Code is read 10x more often than written.** (→ everything)

---

## PROJECT CONFIGURATION (FILL IN BEFORE FIRST USE)

- Frontend framework:        [React / Vue / Svelte / vanilla — FILL IN]
- Sync topology:             [single-user/multi-device ↔ one DB | multi-user, DB-per-user via Turso Platform — FILL IN]
- libSQL mode:               embedded replica + Turso sync   [SET]
- Turso URL/token source:    env vars (dev) + OS keyring (prod)   [confirm]
- Migration channel:         [local idempotent (default) | remote-first via CI — FILL IN]
- Migration tracking:        [PRAGMA user_version | _migrations table — FILL IN]
- Timestamp convention:      [unix epoch ms INTEGER (default) | TEXT ISO-8601 — FILL IN]
- ID strategy:               UUIDv7 (`uuid` crate, v7 feature)   [confirm]
- Sync interval:             [60 s — adjust]
- Sync debounce after write: [3 s — adjust]
- Sync attempt timeout:      [10 s — adjust]
- Shutdown sync timeout:     [5 s — adjust]
- Offline backoff:           1 s → 30 s cap, jittered   [adjust]
- busy_timeout:              [5000 ms — adjust]
- Bulk insert chunk size:    [500 rows/statement — adjust]
- Blob threshold:            [1 MB — adjust]
- Tombstone purge policy:    [e.g., purge > 30 days, single designated client — FILL IN]
- Type bindings:             [tauri-specta generated | manual mirror — FILL IN]
- Coverage target (changed code): [≥ 80% lines & branches — adjust]
- Test Turso instance:       [dedicated CI database | local turso dev / sqld — FILL IN]
````

**Notes on deploying this file:**

- **Fill in the CONFIG block first** — several rules branch on those values (topology determines whether S4.2 is mandatory; migration channel changes R4.1/S5.2 behavior).
- **Placement:** put it where your agent reads it on every session — `AGENTS.md` at the repo root works for most modern agents, or `CLAUDE.md` / `.cursorrules` / system prompt depending on your tool.
- **Keep it in version control** and treat edits to it like code changes — when you grant a waiver in a review, consider updating the rule or the CONFIG so the mandate stays the single source of truth.
- The exact `libsql` Builder API names shift between crate versions; the appendix patterns are intentionally marked "verify against pinned version" — the rules themselves are version-independent.

Want me to also generate the compliant starter skeleton (`error.rs`, `db/connection.rs` with token loading, `db/sync.rs` worker, migration runner, and `lib.rs` wiring) so the agent has a fully rule-compliant foundation from the first commit?
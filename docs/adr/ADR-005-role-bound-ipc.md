# ADR-005 — Role-bound IPC and the data-plane gateway (SEC-01)

- **Status:** proposed, staged (design accepted; increment 1 partly landed)
- **Date:** 2026-11-03
- **Case:** SEC-01 (enterprise-grade role-bound IPC)
- **Related:** ADR-001 (native session principal), `docs/webview-sql-residual.md`

## Context and threat model

The renderer is a WebView running merchant data, operator input and imported
documents (supplier OCR, catalogue imports, CSV). The fiscal record is a plain
SQLite file (`mobi_pos.db`, WAL) written by `rusqlite` in the core and by the
`tauri-plugin-sql` pool from the WebView. Trust tables (audit log, licence, PIN
keys) are native-write-only.

Assets: the fiscal ledger (sales, refunds, drawer, shifts), the audit chain, PIN
envelopes and licence state, and customer PII.

Adversaries (each already observed or reachable):

1. **Compromised renderer** — XSS or a malicious imported document executes in
   the WebView. It holds whatever the IPC layer exposes: today a writable SQL
   handle through `tauri-plugin-sql` outside command authorisation.
2. **Cashier at the keyboard** — an operator trying to refund more than their
   role allows, or to hide a drawer movement.
3. **Local attacker with disk access** — reads or edits the DB directly
   (bounded by ADR-003's deployment requirement, not by IPC).
4. **Malicious or faulty peer terminal** — replays, reorders or forges sync rows
   (addressed by the signed-lane work and the gateway, not by IPC).

The property SEC-01 asks for: **every privileged operation is authorised against
the authenticated principal's role, in native code, and the renderer has no
ambient authority to bypass it.**

## What exists today (verified in-tree)

- `trust_core/ipc_authorizer.rs::authorize_and_execute(command, Capability, op)`
  runs **CHECK LICENCE → DERIVE CAPABILITY → AUTHORIZE COMMAND → EXECUTE** while
  holding the kernel read guard, and logs denials. Commands must be registered;
  an unregistered command is denied (`deny_unregistered`).
- `trust_core/capability_policy.rs` defines the capability set
  (`OperationalWrites`, `ReadOperationalData`, `EmergencyExport`,
  `LicenseManagement`, `Sync`, `HardwareOperations`) and a **(state × capability)
  grant matrix** driven by the licence/trust state.
- Money paths (`refund_sale_atomic`, `void`, shift close) are native commands
  with in-transaction conservation checks, idempotency keys and per-device
  signatures.
- Tauri v2 capabilities scope which windows may call which commands; the
  workspace-patched SQL plugin confines `load` to the exact DB filename.

**Gap that SEC-01 names:** the capability matrix is keyed on **licence/trust
state**, not on the **principal's role**. A cashier and a manager reach the same
`OperationalWrites` grant; the distinction is enforced in TypeScript (UI gates)
and by per-command arguments (manager PIN for refunds), not by the authorizer.
And the WebView still holds a writable DB handle, so any renderer compromise can
write operational tables without passing the authorizer at all (the open residual
in `docs/webview-sql-residual.md`).

## Options

### A — Role dimension in the native authorizer (increment 1)

Extend `Capability` checks with the **session principal's role** (cashier,
manager, admin) and a per-command role requirement, e.g.
`refund_sale_atomic → ManagerOrSupervisor`, `shift_close → ManagerOnVariance`,
`catalogue_write → Manager`. The principal is the native session (ADR-001), not a
renderer-supplied string: the WebView can ask, it cannot assert.

- **Pros:** small, incremental, testable; closes the "cashier calls the command
  directly from a devtools console" path for every registered command; no schema
  change.
- **Cons:** does not by itself stop a compromised renderer from writing through
  the SQL pool. It narrows the *command* surface, not the *file* surface.

### B — Read-only SQL + native writes (increment 2)

Make the WebView's SQL handle **read-only** (SQLite `query_only` / a separate
read pool) and route every write through native commands. Reads stay fast and
the UI keeps its query flexibility.

- **Pros:** removes ambient write authority from the renderer, which is the
  largest single exposure; keeps read performance and the existing query layer.
- **Cons:** a large migration (every `INSERT/UPDATE/DELETE` in
  `sqlPluginAdapter.ts` and the Dexie mirror path must move behind commands);
  needs a compatibility window and per-write tests.

### C — Data-plane gateway (target state)

A separate local process (or an in-core actor) owns the DB; the WebView speaks a
narrow request/response protocol (method + parameters + session token). Nothing
else can open the file.

- **Pros:** the strongest boundary: no SQL, no file handle, one authorisation
  choke point that can also enforce rate limits, field-level policy and audit.
- **Cons:** a real subsystem (protocol, framing, lifecycle, crash recovery,
  upgrade path), plus it must preserve offline-first behaviour and the current
  performance envelope.

### D — Bolt guards onto the TS layer

- **Rejected.** A renderer-side check is advisory under threat model 1; it cannot
  be the boundary the merchant relies on.

## Decision

Adopt **A → B → C** in that order, each behind tests, with C as the declared end
state. Rationale: A is cheap, closes the role gap the case names, and is
independently verifiable; B removes the ambient authority that makes A
insufficient on its own; C is the only design that makes "the renderer has no
data-plane authority" true by construction, but it is a subsystem, not a patch.

**No unsafe shortcut is taken now:** the SQL handle stays as it is until B lands,
and the residual file states that plainly. Shipping C first would be a rewrite
without the intermediate proof; shipping D would be theatre.

## Increment 1 (A) — design and tests

1. `SessionPrincipal { user_id, role, boot_id, verified_at }` already exists for
   PIN verify; expose the role to the authorizer through the kernel state.
2. `capability_policy::required_role(command)` table, mirroring
   `required_capability`; `authorize_and_execute` denies with a typed
   `RoleDenied { command, role, state_code }` and logs to the audit funnel.
3. Tests (Rust): a cashier session calling `refund_sale_atomic` is denied before
   any write; a manager session passes; a missing principal denies (fail closed);
   the denial is audited once.
4. Negative control: flipping the role table entry to `Any` must make the cashier
   test fail — proving the test measures the gate, not the plumbing.

## Increment 2 (B) — status: mechanism proven, switch waits on the write migration

**Landed (E-0176):** `src-tauri/src/sql_boundary.rs` proves, against the real
SQLite engine, that

- `PRAGMA query_only = 1` refuses `INSERT`/`UPDATE`/`DELETE` with
  `SQLITE_READONLY` while `SELECT` keeps working;
- a second normal connection — the native lane (rusqlite commands) — still writes
  the same rows and the read-only handle observes them;
- the **negative control**: the same `INSERT` succeeds without the pragma, so the
  refusal is the pragma and not a schema artefact;
- read cost: 200 SELECTs on each connection measured
  `normal=0.0047 ms`, `query_only=0.0348 ms` per query (~30 µs absolute; the
  relative gap is planner noise at this size, far below a frame). The numbers are
  printed by the test for the evidence line.

**Measured blocker (why the switch is not on in the app yet):** the renderer's own
pool is used **during boot** (settings, mirrors, session). A trial with
`PRAGMA query_only=1` applied at plugin connect made the app never reach the
lock screen (`setup did not yield lock/dashboard`, spec probe retained in
E-0176's log). Turning the boundary on therefore has to travel **with** the write
migration, not before it — the staged approach:

1. (this increment) engine-level proof + telemetry (above);
2. migrate the boot-critical writes to native commands (settings, session, mirror
   seed), each behind its own test;
3. then enable the read-only pool by default, with the boot smoke test as the
   gate that would have caught the trial failure;
4. finally move checkout/refund writes, measuring the money-path latency before
   and after (the two lanes that must not regress).

Increment 3 (C) — the data-plane gateway — is unchanged: it removes the pool
entirely, so it subsumes steps 3–4 of B.

## Increment 3 (C) — design sketch

- Protocol: length-prefixed JSON over a local socket (or an in-core channel in a
  first step), one request = one authorised operation, session token bound to the
  boot id, idempotency keys preserved.
- Kill criteria to revisit: p95 request latency on the checkout/refund lanes must
  stay within the measured rc-6 envelope; offline behaviour unchanged.

## Migration and residual

- Roles come from the roster already synced per device; a legacy row without a
  role is treated as **cashier** (least privilege) until an admin sets it.
- The WebView SQL residual is unchanged by A and stays documented; B is the
  increment that closes it.

## Sources

- Tauri v2 security model: commands are the only privileged surface, capabilities
  scope which window may call which command, scopes constrain arguments —
  https://v2.tauri.app/security and https://v2.tauri.app/security/permissions
- Tauri v2 capability reference —
  https://v2.tauri.app/reference/acl/capability
- OWASP ASVS v4, V4 (access control) and V1.4 (trust boundaries): every request
  is authorised server-side/natively against the authenticated principal, never
  by the client —
  https://owasp.org/www-project-application-security-verification-standard/
- SQLite `PRAGMA query_only` —
  https://www.sqlite.org/pragma.html#pragma_query_only
- PA-DSS/SSF-style separation of duties for refunds and drawer variance is the
  merchant practice this repo already implements with manager PINs; SEC-01 moves
  the check to the native boundary.

### Gate and current status (2026-11-04)

- **Gate:** 318 renderer write statements, ratchet in CI; baseline may only shrink.
- **Landed:** native `boot_maintenance` (outbox purge/reset, debt cache, live-shift
  index) and the **native schema heal** (128 fixed statements captured from the
  renderer's own function, replayed at startup; `bump_parked_attempts` too).
- **Measured:** 205 refused statements → **0 on the managed boot path**; a fresh
  install still needs the renderer heal (~140), because the plugin's v1 base schema
  is created there. Creating the DB natively first was tried and reverted: the heal
  ran before the base tables and left a half-schema DB.
- **Next:** port the v1 base schema to native startup, re-probe the fresh path to 0,
  flip the plugin default, then money paths with the ≤10 % p95 budget.

### Failed attempts (recorded, kept for the trail)

1. **Tolerating message substrings** ("has no column named") let the skip flag turn
   on for a half-schema DB — the imei_records.status incident. Replaced by an exact
   per-statement tolerance map + golden manifest.
2. **Creating the DB natively before the plugin's base migration** made the heal run
   before the base tables existed; it "passed" by tolerating missing tables and left
   a broken schema. Reverted; fresh installs still use the renderer heal.
3. **Polling the heal flag for 3 s** to ride out the startup race delayed the
   renderer heal past seeding, with the same half-schema failure. Reverted to a
   single read; the real fix is a load() barrier, still open.
4. **Capturing the json_dedouble latch as a statement** ran it before the backfill
   and skipped the row rewrite; equivalence caught it (data diff on customers).
   The latch is now written by the backfill after processing.
5. **Assuming the heal alone reaches the golden schema on legacy DBs** failed for
   native-owned objects (audit_chain, attribution columns); the migration now
   ensures them first.

6. **Replaying the plugin migrations in source order** failed on a fresh DB
   (v113 before the migration that supplies its columns). sqlx sorts by version;
   the native runner now does the same.
7. **Trusting the legacy ledger** (stops at v112) skipped table rebuilds whose
   columns the heal adds. Fixed with a prep pass (heal ADD COLUMNs) + retry of the
   skipped migrations, with the golden manifest as the completeness proof.
8. **Copying golden `CREATE TABLE` text** into the completion set hit FTS shadow
   tables and triggers (reserved names). Those are excluded; tables are compared
   semantically (columns/FKs/uniques) because a legitimate rebuild changes the
   stored text.

### Settings lanes (2026-11-04)

The fresh-install refusal count fell 13 → 1 after moving the device-identity write,
`sync.*` upserts, the generic non-sensitive settings mirror, idle maintenance
(checkpoint + incremental vacuum) and the orphan-allocation cleanup to native
commands. `set_app_setting` explicitly refuses sensitive keys by name. The one
remaining write is the shift-open insert (`cash_sessions`), a fiscal business
write that needs its own tests and refund-suite re-runs before it can have a lane.

9. **A capture log is not a clean input.** It was appended to by a later spec run,
   and the "include all captured DDL" rule pulled a test's `sec2_control` table
   into the migration. DDL is now accepted only when its target is a golden object.
10. **Lazy native tables are not optional in the post-condition.** `device_identity`
   is in the golden manifest but was created on first use; a fresh install failed
   the migration. Native-owned tables are ensured before the heal.
11. **Two different SQLite builds saw two different schemas.** The JS generator
   (no `vec0`) treated the vector table as a NULL-sql object; Rust (with `vec0`)
   excluded it. Vector objects are excluded on both sides.
12. **`npm run e2e:clean` does not wipe the app database.** A probe without
   `POS_E2E_WIPE=1` reported `SHIFT_ALREADY_OPEN` from a leftover shift; the
   first "shift UI fails under query_only" conclusion was measurement error.

13. **The static baseline moved 318 -> 319 without a new writer.** The extra
    entry is `shiftAdapter.ts` `UPDATE cash_sessions SET cashier_name …`, which
    existed before the change (previously at line 979) but sat outside the
    scanner's detected window; the edit shifted it into range. Proof:
    `git show HEAD~1:src/db/adapters/shiftAdapter.ts | Select-String 'SET cashier_name'`.
    The count is an honest inventory, not a relaxed limit; no new renderer write
    was introduced (the boot-path renderer heal call and the capture hook were
    removed in the same change).

### Generic sync enqueue is native (2026-11-04)

`enqueueGenericSync`/`enqueueGenericDelete` were the largest renderer write
class once boot and shift moved native (94 × 4 statements in one refund spec).
They now run as `enqueue_sync_upsert`/`enqueue_sync_delete` in one transaction:
the entity name is validated against the same closed set as the TS `GenericEntity`
union, the payload is bounded at 64 KiB and must be a JSON object, and the version
is injected natively. The renderer keeps its SQL only as a non-Tauri fallback, so
the static boundary stays at the 318 floor while the runtime surface shrinks
(438 → 133 refusals on `30-ref-refunds`). `set_shift_cashier` was migrated in the
same change, which is what restored the static count to 318 after the scanner
started reaching a previously uncounted pre-existing UPDATE.

### Customer writes are native (2026-11-04)

The customer upsert (`saveCustomer`) and the pull/requeue `sync_status='synced'`
stamp moved to `customer_lane.rs`. The optimistic guard, the `current_debt`
COALESCE and the version+status stamp guard are preserved exactly, and three Rust
tests pin them. Refund-spec refusals under a read-only pool fell 133 → 29; the
remainder is the void/refund mirror (one `BEGIN IMMEDIATE` transaction plus the
loyalty `json_patch`, parent stub and ledger appends), which is the next lane.
Money-path p95 under the flag is +2.5 % (1499 → 1537 ms at n=10), inside budget.

### Void/refund mirror is native (2026-11-04)

`db:void` and `db:refund` no longer open a renderer transaction. Six commands
carry their SQLite effects with fixed literals and one Rust `BEGIN IMMEDIATE`
each: `void_sale_mirror`, `refund_sale_mirror`, `apply_customer_loyalty_mirror`,
`upsert_store_expense`, `upsert_customer_debt`, `refresh_customer_debt_cache`.
The money semantics are pinned by tests: the loyalty bundle and the void status
flip roll back together; a failing bundle leaves the DB byte-identical; a second
void is refused with no double ledger append; the debt stub never clobbers a live
parent; the debt-cache refresh never bumps `version`.

Measured: refund-spec refusals 29 → 1, and the spec is green under the read-only
flag. The remaining refusal is the product upsert (with its conditional ledger
adjust / opening batch), which stays named. `fifo:reconcile` now preflights for
unresolved SHADOW batches and no longer opens an empty transaction; its write
algorithm remains renderer-side and must be ported before flipping for
shadow-bearing data. Money p95 at n=200: +0.09 % under the flag.

### Product mirror and shift close are native (2026-11-05)

`upsert_product` owns the product row, the conditional ledger ADJUST, the stock
recompute, the opening batch and their envelopes in one transaction; the renderer
keeps only the reads that decide the stock. `close_shift` owns the fiscal close
totals and the envelope together. With these, `30-ref-refunds` and `10-mny-money`
run green under `POS_SQL_QUERY_ONLY=1` with **zero** refused writes, and
`50-sec-authorization` likewise. `40-shf-shifts` is at 10/12 with three named
renderer writes left (`held_orders` insert/delete, `cash_movements` insert), and
spec 92's five are its own writable-pool controls that must move to a native
command now that the native lanes are the writable path.

### Held orders and drawer movements are native (2026-11-05)

`save_held_order`, `delete_held_order`, `claim_held_order`, `release_held_order`
and `log_cash_movement` carry the last renderer writes the shift spec reached.
The single-claim CAS is pinned by a test (two recalls → 1 then 0, release is the
inverse); the movement insert keeps the OPEN-session guard and parks in the same
transaction when it does not land. `40-shf-shifts` and `92-sql-readonly-app` are
green under the flag with **zero** refusals. Spec 92's controls now write through
the native lane and its cap seed runs out-of-band, so the spec still proves the
database is writable without writing through the pool that the flip makes
read-only.

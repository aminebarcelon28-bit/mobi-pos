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

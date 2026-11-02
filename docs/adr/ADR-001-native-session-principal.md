# ADR-001 — Native session principal + deny-by-default command policy (R1 / SEC-01)

- **Status:** accepted
- **Date:** 2026-11-02
- **Baseline:** `c01-rc-5` (`51c9c70`); implemented on `c01-rc6-work`
- **Evidence:** E-0151 (implementation + mutation check + 50-sec 10/10), E-0149 (baseline)

## Context

Native commands were authorized by **license state** (`capability_policy.rs`), not by
the operator. Any renderer script holding the IPC handle could call a manager-grade
command — database backup, snapshot decrypt, snapshot prune, peer PIN minting —
regardless of who was logged in. SEC-01 proved it: a cashier session produced
`create_database_backup` ok=`true` and `pin_set(peer)` ok=`true`.

Tauri v2 capabilities gate *windows and IPC surface*, not *people*. They cannot
express "manager only while the manager is signed in". The documented exit is
role-bound IPC plus a data-plane gateway; the gateway is not built. SEC-01's
assertion, however, is satisfiable below the gateway: the kernel can hold the
identity that native login just proved.

## Decision

1. **A native, memory-only session principal** (`trust_core/session_principal.rs`):
   `{user_id, role, verified_at_ms}`. It is created **only** by a successful
   `pin_verify` (role resolved from the roster row natively — `admin` aliases
   manager). No command accepts a role or identity claim, so the renderer cannot
   elevate itself by argument. It is dropped by the new `session_lock` command
   (invoked when the UI locks) and by process exit. A 10-minute TTL
   (`PRINCIPAL_TTL_MS`) bounds staleness if the lock never reaches the kernel.
2. **One policy table, deny-by-default** (`PRIVILEGED_COMMANDS`):
   | command | policy |
   |---|---|
   | `create_database_backup` | manager only |
   | `decrypt_snapshot_for_recovery` | manager only |
   | `prune_snapshots` | manager only |
   | `pin_set` | own credential, or manager |
   A command absent from the table is denied (`AUTHZ_ROLE_REQUIRED:no-policy`).
3. **First-run bootstrap is the single exception.** `pin_set` may create the owner
   credential while the terminal has **no manager credential yet**
   (`authorize_pin_set`). This is safe because trust/credential tables are
   native-write-only, and it can only *create*: re-keying an existing manager already
   required the supervisor PIN (`pin.rs` B4 boundary). `authorize_pin_set` refuses any
   command other than `pin_set`, so it cannot become a bypass.
4. **Composition, not replacement.** The license/capability gate still runs first
   (`authorize_and_execute`); the role guard runs inside it. Privileged commands that
   already take a fresh manager PIN (`prune_snapshots`,
   `decrypt_snapshot_for_recovery`) keep that PIN flow; the PIN now also creates the
   principal, and the role guard makes the coupling explicit rather than implied.
5. **The lock screen verifies natively on every path.** The bare PIN pad (no profile
   selected) previously fell through to the renderer-local `unlockScreen`; under
   Tauri it now verifies `userId: 'manager'` through `pin_verify`, so a Tauri session
   can never exist without a native principal.

## Rejected alternatives

- **Tauri capabilities/permissions only** — they are static per window; they cannot
  distinguish cashier from manager inside one window. Kept as the outer boundary.
- **Role passed from the renderer** — a modified renderer forges it; rejected on
  principle (Tauri v2: command implementations own fine-grained access; ASVS 5.0
  access-control chapter: enforcement on the trusted layer).
- **Session token minted in JS and echoed on each call** — same forgery problem, plus
  replay surface; the kernel-owned slot is strictly smaller.
- **Gateway-only enforcement (status quo)** — leaves SEC-01 FAIL indefinitely; the
  gateway remains the *data-plane* exit (ADR-002 scope), not a prerequisite for
  role binding at the IPC layer.
- **Deny `pin_set` entirely without a session** — breaks first-run setup; bootstrap
  above is the narrowest exception that keeps the product usable.

## Consequences

- Cashier sessions can no longer back up, decrypt, prune, or mint peer PINs — SEC-01
  PASS (E-0151).
- Suites that call privileged commands must hold the right session. Setup code may
  authenticate as manager first (allowed: setup, not weakening); SEC-01's assertion
  is untouched.
- A UI lock now clears native privileges immediately; a crash or an unhandled lock
  leaves at most a 10-minute window, and the process exit clears it.
- Residual (documented, unchanged): a modified WebView still holds a writable SQL
  handle (`docs/webview-sql-residual.md`). Role binding raises the bar for IPC
  commands; the data-plane gateway is still required for prevention-backed
  guarantees.
- New privileged commands must be registered in `PRIVILEGED_COMMANDS` **and** wired
  to `authorize(...)`; two source-coverage tests fail otherwise (mutation-proven,
  E-0151).

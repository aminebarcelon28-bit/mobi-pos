# D-R1 — Binding native authorization to the operator's role (SEC-01)

**Date:** 2026-11-02 · **Baseline:** `c01-rc-5` (`51c9c70`) · **Outcome:** IPC-layer fix,
SEC-01 PASS (E-0151). Gateway remains the data-plane exit (ADR-002 scope).

## Question

Can SEC-01 ("a cashier session attempts manager-only actions by UI and by direct IPC")
be satisfied at the IPC layer, or does it require the unbuilt data-plane gateway?

## What the assertion actually is

Reading `e2e-tests/specs/50-sec-authorization.e2e.ts` (SEC-01): as a cashier, after a
real lock-screen unlock, `create_database_backup` and `pin_set(peer)` must be refused;
`escalated = backup.ok || peer.ok` must be `false`. It does **not** assert that the
gateway exists. → satisfiable at IPC if the kernel knows who logged in.

## Evidence

| # | Source | Tier | Finding |
|---|---|---|---|
| 1 | Tauri v2 security docs (trust boundaries, capabilities, permissions, runtime authority) — <https://v2.tauri.app/security/>, page last updated 2026-07-22, accessed 2026-11-02 | T1 | Capabilities restrict *command access per window*; "the individual command implementations enforce the optional fine-grained access levels". No notion of a person or role → role binding must live in the command/kernel layer. |
| 2 | OWASP ASVS 5.0.0 (published 2025-05-30), <https://owasp.org/www-project-application-security-verification-standard/>, accessed 2026-11-02 | T1 | Access control is a verification requirement on the trusted layer, never on UI hiding. Note: v5.0.0 renumbered requirements; the previously cited "4.2.1" identifier does not survive the v5 renumbering, so cite v5 by chapter/section. |
| 3 | PCI DSS v4.0.1 Req. 7 (restrict access by business need-to-know, role-based) — `unverified-offline` (not opened this session) | T1 (unverified) | Role-based access is a requirement; the enforcement point is the application. Corroborates #2; decision does not rest on it alone. |
| 4 | NIST SP 800-162 (ABAC) / ANSI RBAC model | T1 | A subject attribute (role) bound at authentication time is the canonical input; the decision point holds the subject, not the caller's claim. |
| 5 | Repo: `trust_core/capability_policy.rs`, `ipc_authorizer.rs` | T1 (source) | Authorization today = license state + capability table. No principal, no role. |
| 6 | Repo: `pin.rs` `pin_verify` | T1 (source) | Already resolves `is_manager` natively from the roster row — the role is trustworthy *at that moment*, and is discarded. |

## Options considered

1. **Native session principal + policy table (chosen).** `pin_verify` writes
   `{user_id, role}` into a kernel-owned slot; privileged commands consult it.
   Pros: smallest change; role resolved natively; renderer cannot forge. Cons: memory
   state tied to the process (bounded by TTL + explicit `session_lock`).
2. **Capabilities only.** Rejected: cannot separate cashier from manager in one window.
3. **Renderer-supplied role / signed token.** Rejected: forgeable by the threat model
   the test simulates (direct IPC from a modified renderer).
4. **Wait for the data-plane gateway.** Rejected as the *only* move: leaves a known
   P1 open when the kernel can close it. The gateway stays the residual for
   prevention-backed guarantees (SQL-write path).

## Decision

Option 1, with a deny-by-default policy table; first-run bootstrap narrowly allows
creating the owner credential when no manager credential exists. Details, rejected
alternatives, consequences: `docs/adr/ADR-001-native-session-principal.md`.

## Verification

- 9 new Rust tests (role matrix, TTL, bootstrap, `session_lock`, two source-coverage
  tests). Mutation check: deleting the `create_database_backup` guard fails
  `every_privileged_command_is_wired_to_its_policy` (recorded E-0151).
- `cargo test --lib` 452/452 (443 baseline + 9).
- 50-sec: 9/10 → **10/10** (E-0151), same assertion, no test edits.

## Residual (unchanged by this work)

- WebView SQL write path (`docs/webview-sql-residual.md`) — detection-backed, not
  prevention-backed, until the data-plane gateway.
- A principal can outlive a UI lock by at most `PRINCIPAL_TTL_MS` if the lock command
  is never delivered (process crash or a modified renderer that suppresses
  `session_lock`); process exit clears it.

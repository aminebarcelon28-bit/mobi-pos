//! Phase 1 — native trust kernel (directive Part B) + Phase 2 trusted time.
//!
//! # Threat model (B.1)
//! In scope: malicious or modified JavaScript in the webview calling IPC
//! commands directly; replayed or forged IPC payloads, including
//! client-supplied license fields; tampered or malformed persisted license
//! state; direct invocation of privileged commands while the UI shows a lock
//! screen.
//!
//! Out of scope (documented, not attempted): attacker with root/debugger
//! access or a patched binary; crash/WAL recovery (Phase 3).
//!
//! # Storage topology (read this before touching Phase 2/3 data code)
//! The local store is **plain SQLite**, not libSQL:
//! - `mobi_pos.db` (WAL mode) is opened by `rusqlite` (short-lived native
//!   handles) and by `tauri-plugin-sql` (sqlx pool, `sqlite:mobi_pos.db`).
//! - Turso is a **remote sync transport only**: `@libsql/client` is used
//!   exclusively as a remote Hrana client (`libsql://`/`https://`) by the
//!   TypeScript `SyncManager` (outbox push + pull lanes). There is no `libsql`
//!   Rust crate, no embedded replica, no replica `sync()` semantics to
//!   preserve. `scripts/` uses `file:` opens for dev/test tooling only.
//! - `rules.md` §§S1–S5 and Appendix B describe a libSQL-replica
//!   architecture with NO implementation behind it: treat as STALE, do not
//!   implement or reference it. (`AGENTS.md`, cited by `rules.md`, is absent
//!   from the repo; work proceeds without it.)
//! - Emergency export reads the local SQLite authority and must not disturb
//!   outbox/cursor replication state.
//!
//! # Layout
//! - [`license_state`] — coarse [`LicenseState`](license_state::LicenseState).
//! - [`capability_policy`] — the single-source-of-truth state x capability
//!   matrix. Capabilities derive only from native policy; no `licensed`
//!   boolean crosses IPC.
//! - [`trusted_time`] — trait plus a fail-closed stub ONLY (kept for the
//!   seam; the engine lives in [`time_engine`]).
//! - [`secure_storage`] — authenticated persisted snapshots, v2 (B.4
//!   hardened: MAC + keystore counter, heal-forward dual write).
//! - [`license_token`] — native Ed25519 license-token verification (+
//!   domain-separated variant for time assertions).
//! - [`time_config`] — advisory-only time knobs with shipped defaults.
//! - [`clocks`] — exact sleep-inclusive OS clocks behind a testable trait
//!   (`std::time::Instant` banned); fakes for tests.
//! - [`session`] — boot-session continuity verdict (boot id + uptime +
//!   ΔM/ΔW consistency).
//! - [`time_engine`] — trusted-time decision + time kernel singleton.
//! - [`reanchor`] — nonce-bound authenticated re-anchor commands.
//! - [`ipc_authorizer`] — registry (deny by default), `authorize_and_execute`
//!   (TOCTOU-safe), typed errors, `get_gate_state`, denial audit log.

pub mod capability_policy;
pub mod audit_append;
pub mod clocks;
pub mod export_snapshot;
pub mod ipc_authorizer;
pub mod license_state;
pub mod license_token;
pub mod pin;
pub mod reanchor;
pub mod secure_storage;
pub mod session;
pub mod time_config;
pub mod time_engine;
pub mod trusted_time;

pub use capability_policy::{authorize as authorize_capability, Capability, PolicyDecision};
pub use ipc_authorizer::{
    authorize_and_execute, get_gate_state, global_kernel, require_capability, AuthCtx, GateState,
    TrustError,
};
pub use license_state::LicenseState;

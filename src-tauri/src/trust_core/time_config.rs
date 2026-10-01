//! Phase 2 — trusted-time configuration (condition: advisory-only time).
//!
//! Every knob below is advisory EXCEPT where the decision engine maps an
//! integrity/rollback verdict to quarantine. In particular **no staleness or
//! elapsed-time value denies a capability**: quarantine transitions come
//! exclusively from rollback/tamper/integrity detection (counter or
//! `server_seq` regression, MAC failure, unknown variant, missing keyring
//! with prior state). Staleness only produces advisory messages surfaced via
//! `get_gate_state`.
//!
//! All values are owner-confirmable; the defaults below are the shipped
//! sane values. They mirror the pre-existing TypeScript policy where one
//! exists (`clockGuard` 5-minute skew, 7-day grace window).

/// Wall-vs-expected skew absorbed silently (NTP wobble, DST presentation).
/// Mirrors `LicenseClockGuard::SKEW_TOLERANCE_MS`.
pub const SKEW_TOLERANCE_MS: u64 = 5 * 60 * 1000;

/// Wall ahead of the trusted anchor by more than this requests revalidation
/// (advisory only — capabilities intact, anchor not advanced).
pub const WARN_AHEAD_MS: u64 = 24 * 60 * 60 * 1000;

/// Server-time staleness producing an advisory revalidation message only.
pub const STALENESS_ADVISORY_MS: u64 = 14 * 24 * 60 * 60 * 1000;

/// Maximum offline window before an advisory revalidation prompt. Never
/// blocks normal offline selling; mirrors the 7-day licensing grace window.
pub const OFFLINE_REVALIDATE_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// Session-continuity tolerance for |Δmonotonic − Δwall|. Deliberately loose:
/// NTP steps must not force new sessions, while reboots always mismatch by
/// orders of magnitude. Never raises an alarm by itself — a mismatch only
/// forces a new session (the safe direction); rollback verdicts remain a
/// separate anchor-comparison layer.
pub const SESSION_CONTINUITY_TOLERANCE_MS: u64 = 60 * 60 * 1000;

/// Earliest plausible wall time (deployment policy, owner-confirmable).
/// A wall clock earlier than this is an RTC-reset signature. Comparisons are
/// UTC instants, so DST/local representation can never trigger it.
pub const MIN_PLAUSIBLE_UTC_MS: u64 = 1_577_836_800_000; // 2020-01-01T00:00:00Z

/// Re-anchor challenge lifetime (anti-replay hygiene, not trust).
pub const REANCHOR_CHALLENGE_TTL_MS: u64 = 5 * 60 * 1000;

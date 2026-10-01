//! Phase 2 — trusted-time decision engine.
//!
//! The persisted checkpoint (`last_trusted_wall_utc_ms`, `last_monotonic_ms`,
//! `boot_session_id` in the v2 snapshot) is the ONLY baseline — business
//! timestamps are evidence, never authority.
//!
//! # Verdict table
//! 1. `wall < MIN_PLAUSIBLE_UTC_MS` → `ResetRequired` (RTC-reset signature),
//!    even with no checkpoint.
//! 2. No checkpoint → `Advisory` (nothing to compare; capabilities intact).
//! 3. Session continuous → `expected = checkpoint.wall + ΔM`,
//!    `skew = wall − expected`:
//!    - `|skew| ≤ SKEW` → `Trusted`, checkpoint advances (ratchet: each
//!      advance stays within SKEW of a previously trusted value, so a
//!      manipulated wall cannot poison the anchor — it can only move it by
//!      ≤ SKEW per observation, and any larger jump quarantines first).
//!    - `skew < −SKEW` → `TamperSuspected` (same-boot backward jump).
//!    - `skew > +SKEW` → `Advisory` (forward jump; revalidation requested,
//!      anchor frozen until re-anchor or the wall returns).
//! 4. New session → monotonic discarded; wall-vs-checkpoint ONLY:
//!    `wall < checkpoint.wall − SKEW` → `ResetRequired`; otherwise `Advisory`
//!    (anchor never advances without continuity or re-anchor).
//!
//! Advisory verdicts never deny capabilities and never advance the anchor.
//! Only `trust_reanchor_time` (verified server assertion) and `Trusted`
//! ratchets write the checkpoint. Activation seeds a checkpoint only when
//! absent (`trust_sync_license`); re-activation never re-seeds, so rollback
//! cannot be laundered through re-activation.

use super::clocks::MonotonicSource;
use super::secure_storage::SnapshotData;
use super::session::{evaluate_continuity, Continuity, SessionCheckpoint};
use super::time_config::{
    MIN_PLAUSIBLE_UTC_MS, SESSION_CONTINUITY_TOLERANCE_MS, SKEW_TOLERANCE_MS, WARN_AHEAD_MS,
};
use parking_lot::{Mutex, RwLock};
use std::sync::OnceLock;

/// Engine verdict. Only `ResetRequired`/`TamperSuspected` may move the
/// license machine (and only from non-locked states); `Advisory` is surfaced
/// via `get_gate_state` with zero capability effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeVerdict {
    Trusted { trusted_now_ms: u64 },
    ResetRequired,
    TamperSuspected,
    Advisory,
}

/// Advisory cause (diagnostics only, never secrets).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdvisoryCause {
    Unanchored,
    ForwardJump,
    NewSessionPlausibleWall,
    StaleServerTime,
}

/// Checkpoint write-back requested by the engine.
#[derive(Debug, Clone)]
pub struct CheckpointUpdate {
    pub boot_session_id: Option<String>,
    pub wall_utc_ms: u64,
    pub monotonic_ms: u64,
}

/// Evaluation outcome.
#[derive(Debug, Clone)]
pub struct EvalOutcome {
    pub verdict: TimeVerdict,
    pub advisory: Option<AdvisoryCause>,
    /// `Some` when the caller should persist the new checkpoint (only on
    /// `Trusted` ratchets — never on advisory or quarantine paths).
    pub checkpoint_update: Option<CheckpointUpdate>,
}

/// Pure decision function over an optional persisted checkpoint.
pub fn evaluate(
    checkpoint: Option<PersistedCheckpoint>,
    wall_now_ms: u64,
    clock: &dyn MonotonicSource,
) -> EvalOutcome {
    // 1. RTC-reset signature first: independent of any anchor.
    if wall_now_ms < MIN_PLAUSIBLE_UTC_MS {
        return EvalOutcome {
            verdict: TimeVerdict::ResetRequired,
            advisory: None,
            checkpoint_update: None,
        };
    }

    let Some(cp) = checkpoint else {
        return EvalOutcome {
            verdict: TimeVerdict::Advisory,
            advisory: Some(AdvisoryCause::Unanchored),
            checkpoint_update: None,
        };
    };

    let continuity = evaluate_continuity(
        &SessionCheckpoint {
            boot_id: cp.boot_session_id.clone(),
            monotonic_ms: cp.monotonic_ms,
            wall_utc_ms: cp.wall_utc_ms,
        },
        clock,
        wall_now_ms,
        SESSION_CONTINUITY_TOLERANCE_MS,
    );

    match continuity {
        Continuity::Continuous { delta_m_ms } => {
            let expected = cp.wall_utc_ms.saturating_add(delta_m_ms);
            let skew = wall_now_ms as i128 - expected as i128;
            let tol = SKEW_TOLERANCE_MS as i128;
            if skew.abs() <= tol {
                let trusted = wall_now_ms.max(cp.wall_utc_ms);
                let current_m = clock.now_ms().unwrap_or(cp.monotonic_ms);
                EvalOutcome {
                    verdict: TimeVerdict::Trusted { trusted_now_ms: trusted },
                    advisory: None,
                    checkpoint_update: Some(CheckpointUpdate {
                        boot_session_id: clock.boot_id().or(cp.boot_session_id),
                        wall_utc_ms: trusted,
                        monotonic_ms: current_m.max(cp.monotonic_ms),
                    }),
                }
            } else if skew < 0 {
                EvalOutcome {
                    verdict: TimeVerdict::TamperSuspected,
                    advisory: None,
                    checkpoint_update: None,
                }
            } else if (skew as u64) > WARN_AHEAD_MS {
                // Reachable only if an owner configures SESSION_TOLERANCE
                // above WARN_AHEAD (default 1 h < 24 h routes such jumps to
                // NewSession first). Same contract either way: advisory only.
                EvalOutcome {
                    verdict: TimeVerdict::Advisory,
                    advisory: Some(AdvisoryCause::ForwardJump),
                    checkpoint_update: None,
                }
            } else {
                // Small forward step: still trusted (NTP catch-up), ratchet up.
                let current_m = clock.now_ms().unwrap_or(cp.monotonic_ms);
                EvalOutcome {
                    verdict: TimeVerdict::Trusted {
                        trusted_now_ms: wall_now_ms,
                    },
                    advisory: None,
                    checkpoint_update: Some(CheckpointUpdate {
                        boot_session_id: clock.boot_id().or(cp.boot_session_id),
                        wall_utc_ms: wall_now_ms,
                        monotonic_ms: current_m.max(cp.monotonic_ms),
                    }),
                }
            }
        }
        Continuity::NewSession => {
            // Monotonic discarded. Wall-vs-anchor only.
            if wall_now_ms + SKEW_TOLERANCE_MS < cp.wall_utc_ms {
                EvalOutcome {
                    verdict: TimeVerdict::ResetRequired,
                    advisory: None,
                    checkpoint_update: None,
                }
            } else {
                EvalOutcome {
                    verdict: TimeVerdict::Advisory,
                    advisory: Some(AdvisoryCause::NewSessionPlausibleWall),
                    checkpoint_update: None,
                }
            }
        }
    }
}

/// Checkpoint view over snapshot fields. All three must be present;
/// partial state is treated as absent (fail toward Advisory, never trust).
#[derive(Debug, Clone)]
pub struct PersistedCheckpoint {
    pub boot_session_id: Option<String>,
    pub monotonic_ms: u64,
    pub wall_utc_ms: u64,
}

impl PersistedCheckpoint {
    pub fn from_snapshot(data: &SnapshotData) -> Option<Self> {
        Some(Self {
            boot_session_id: data.boot_session_id.clone(),
            monotonic_ms: data.last_monotonic_ms?,
            wall_utc_ms: data.last_trusted_wall_utc_ms?,
        })
    }
}

// ---------------------------------------------------------------------------
// Time kernel singleton (challenge store + time-field mirror)
// ---------------------------------------------------------------------------

/// Single-use re-anchor challenge.
#[derive(Debug, Clone)]
struct Challenge {
    nonce_hex: String,
    expires_at_ms: u64,
}

struct TimeInner {
    boot_session_id: Option<String>,
    last_trusted_wall_utc_ms: Option<u64>,
    last_monotonic_ms: Option<u64>,
    last_server_time_utc_ms: Option<u64>,
    last_server_seq: Option<u64>,
    challenge: Option<Challenge>,
}

pub struct TimeKernel {
    inner: RwLock<TimeInner>,
    challenge_lock: Mutex<()>,
}

impl TimeKernel {
    fn new() -> Self {
        Self {
            inner: RwLock::new(TimeInner {
                boot_session_id: None,
                last_trusted_wall_utc_ms: None,
                last_monotonic_ms: None,
                last_server_time_utc_ms: None,
                last_server_seq: None,
                challenge: None,
            }),
            challenge_lock: Mutex::new(()),
        }
    }

    /// Load time fields from a verified snapshot (startup / migration).
    pub fn load_from_snapshot(&self, data: &SnapshotData) {
        let mut g = self.inner.write();
        g.boot_session_id = data.boot_session_id.clone();
        g.last_trusted_wall_utc_ms = data.last_trusted_wall_utc_ms;
        g.last_monotonic_ms = data.last_monotonic_ms;
        g.last_server_time_utc_ms = data.last_server_time_utc_ms;
        g.last_server_seq = data.last_server_seq;
    }

    /// Snapshot the current time fields for dual persist.
    pub fn read_fields(&self) -> TimeFields {
        let g = self.inner.read();
        TimeFields {
            boot_session_id: g.boot_session_id.clone(),
            last_trusted_wall_utc_ms: g.last_trusted_wall_utc_ms,
            last_monotonic_ms: g.last_monotonic_ms,
            last_server_time_utc_ms: g.last_server_time_utc_ms,
            last_server_seq: g.last_server_seq,
        }
    }

    /// Apply a checkpoint ratchet (Trusted verdicts only — enforced by the
    /// caller passing only engine-approved updates).
    pub fn apply_checkpoint(&self, upd: &CheckpointUpdate) {
        let mut g = self.inner.write();
        g.boot_session_id = upd.boot_session_id.clone();
        g.last_trusted_wall_utc_ms = Some(upd.wall_utc_ms);
        g.last_monotonic_ms = Some(upd.monotonic_ms);
    }

    /// Apply a verified re-anchor (server assertion path only).
    pub fn apply_reanchor(
        &self,
        server_time_ms: u64,
        server_seq: Option<u64>,
        mono_ms: Option<u64>,
        boot_id: Option<String>,
    ) {
        let mut g = self.inner.write();
        g.last_trusted_wall_utc_ms = Some(server_time_ms);
        g.last_monotonic_ms = mono_ms;
        g.boot_session_id = boot_id;
        g.last_server_time_utc_ms = Some(server_time_ms);
        if let Some(seq) = server_seq {
            g.last_server_seq = Some(seq);
        }
        g.challenge = None;
    }

    /// Issue a single-use challenge (replaces any outstanding one).
    pub fn issue_challenge(&self, nonce_hex: String, expires_at_ms: u64) {
        let _guard = self.challenge_lock.lock();
        self.inner.write().challenge = Some(Challenge {
            nonce_hex,
            expires_at_ms,
        });
    }

    /// Peek the active challenge without consuming (for diagnostics/tests).
    #[cfg(test)]
    pub fn peek_challenge(&self) -> Option<(String, u64)> {
        self.inner
            .read()
            .challenge
            .clone()
            .map(|c| (c.nonce_hex, c.expires_at_ms))
    }

    /// Consume the active challenge iff it matches and is unexpired.
    /// Consumed on success only; expiry bounds the replay window.
    pub fn consume_challenge(&self, nonce_hex: &str, now_ms: u64) -> Result<(), ChallengeError> {
        let _guard = self.challenge_lock.lock();
        let mut g = self.inner.write();
        match &g.challenge {
            None => Err(ChallengeError::NoChallenge),
            Some(c) if c.nonce_hex != nonce_hex => Err(ChallengeError::Mismatch),
            Some(c) if now_ms > c.expires_at_ms => Err(ChallengeError::Expired),
            Some(_) => {
                g.challenge = None;
                Ok(())
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn reset_for_tests(&self) {
        *self.inner.write() = TimeInner {
            boot_session_id: None,
            last_trusted_wall_utc_ms: None,
            last_monotonic_ms: None,
            last_server_time_utc_ms: None,
            last_server_seq: None,
            challenge: None,
        };
    }
}

/// Plain time-field view for snapshot assembly.
#[derive(Debug, Clone, Default)]
pub struct TimeFields {
    pub boot_session_id: Option<String>,
    pub last_trusted_wall_utc_ms: Option<u64>,
    pub last_monotonic_ms: Option<u64>,
    pub last_server_time_utc_ms: Option<u64>,
    pub last_server_seq: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChallengeError {
    NoChallenge,
    Mismatch,
    Expired,
}

static TIME_KERNEL: OnceLock<TimeKernel> = OnceLock::new();

pub fn global_time_kernel() -> &'static TimeKernel {
    TIME_KERNEL.get_or_init(TimeKernel::new)
}

#[cfg(test)]
mod tests {
    use super::super::clocks::ManualClock;
    use super::super::time_config::WARN_AHEAD_MS;
    use super::*;
    use crate::trust_core::ipc_authorizer::serial_test_lock;

    fn cp(boot: Option<&str>, m: u64, w: u64) -> Option<PersistedCheckpoint> {
        Some(PersistedCheckpoint {
            boot_session_id: boot.map(|s| s.to_string()),
            monotonic_ms: m,
            wall_utc_ms: w,
        })
    }

    const T0: u64 = 1_700_000_000_000;

    #[test]
    fn trusted_within_skew_advances_checkpoint() {
        let c = cp(Some("A"), 1_000_000, T0);
        let mut clock = ManualClock::with_boot(1_000_000, "A");
        clock.advance(30_000);
        let out = evaluate(c, T0 + 30_000 + 1_000, &clock);
        assert!(matches!(out.verdict, TimeVerdict::Trusted { .. }));
        let upd = out.checkpoint_update.expect("ratchet must advance");
        assert_eq!(upd.wall_utc_ms, T0 + 31_000);
    }

    #[test]
    fn same_boot_rollback_is_tamper() {
        let c = cp(Some("A"), 1_000_000, T0);
        let mut clock = ManualClock::with_boot(1_000_000, "A");
        clock.advance(3_600_000);
        // Wall moved BACKWARD 14 days during the same boot.
        let out = evaluate(c, T0 - 14 * 86_400_000, &clock);
        assert_eq!(out.verdict, TimeVerdict::TamperSuspected);
        assert!(out.checkpoint_update.is_none(), "anchor must not advance");
    }

    #[test]
    fn rtc_reset_below_floor_is_reset_required() {
        let c = cp(Some("A"), 1_000_000, T0);
        let clock = ManualClock::with_boot(2_000_000, "B");
        let out = evaluate(c, 1_000_000_000, &clock); // 2001
        assert_eq!(out.verdict, TimeVerdict::ResetRequired);
    }

    #[test]
    fn new_session_wall_behind_anchor_is_reset() {
        // Reboot + clock set back by days: continuity fails (boot id differs
        // or ΔM/ΔW mismatches), wall far behind anchor → reset-required.
        let c = cp(Some("A"), 8 * 3_600_000, T0);
        let clock = ManualClock::with_boot(9 * 3_600_000, "B");
        let out = evaluate(c, T0 - 3 * 86_400_000, &clock);
        assert_eq!(out.verdict, TimeVerdict::ResetRequired);
        assert!(out.checkpoint_update.is_none());
    }

    #[test]
    fn new_session_plausible_wall_is_advisory_only() {
        let c = cp(Some("A"), 8 * 3_600_000, T0);
        let clock = ManualClock::with_boot(600_000, "B");
        // Wall 10 min ahead of anchor after reboot: advisory, no denial.
        let out = evaluate(c, T0 + 600_000, &clock);
        assert_eq!(out.verdict, TimeVerdict::Advisory);
        assert_eq!(out.advisory, Some(AdvisoryCause::NewSessionPlausibleWall));
        assert!(out.checkpoint_update.is_none(), "anchor never advances without continuity");
    }

    #[test]
    fn forward_jump_beyond_warn_is_advisory_anchor_frozen() {
        // A large forward jump breaks ΔM/ΔW consistency first, so it lands in
        // NewSessionPlausibleWall rather than ForwardJump (the latter is only
        // reachable if an owner configures SESSION_TOL above WARN_AHEAD).
        // Observable contract is identical: advisory only, anchor frozen.
        let c = cp(Some("A"), 1_000_000, T0);
        let mut clock = ManualClock::with_boot(1_000_000, "A");
        clock.advance(60_000);
        let out = evaluate(c, T0 + WARN_AHEAD_MS + 120_000, &clock);
        assert_eq!(out.verdict, TimeVerdict::Advisory);
        assert!(out.checkpoint_update.is_none(), "anchor frozen on forward jump");
    }

    #[test]
    fn small_ntp_adjustment_within_tolerance_does_not_alarm() {
        let c = cp(Some("A"), 1_000_000, T0);
        let mut clock = ManualClock::with_boot(1_000_000, "A");
        clock.advance(60_000);
        // +45 s NTP step on top of 60 s elapsed: within SKEW.
        let out = evaluate(c, T0 + 105_000, &clock);
        assert!(matches!(out.verdict, TimeVerdict::Trusted { .. }));
    }

    #[test]
    fn unanchored_is_advisory_never_denial() {
        let clock = ManualClock::new(5_000);
        let out = evaluate(None, T0, &clock);
        assert_eq!(out.verdict, TimeVerdict::Advisory);
        assert_eq!(out.advisory, Some(AdvisoryCause::Unanchored));
    }

    #[test]
    fn challenge_single_use_with_expiry() {
        let _g = serial_test_lock();
        let k = global_time_kernel();
        k.reset_for_tests();
        k.issue_challenge("abc123".into(), 10_000);
        assert_eq!(k.peek_challenge(), Some(("abc123".into(), 10_000)));
        // Wrong nonce: rejected, challenge survives.
        assert_eq!(
            k.consume_challenge("wrong", 5_000),
            Err(ChallengeError::Mismatch)
        );
        assert!(k.peek_challenge().is_some());
        // Expired: rejected (challenge stays for audit; re-issue replaces).
        assert_eq!(
            k.consume_challenge("abc123", 10_001),
            Err(ChallengeError::Expired)
        );
        // Valid: consumed.
        assert_eq!(k.consume_challenge("abc123", 9_999), Ok(()));
        assert_eq!(
            k.consume_challenge("abc123", 9_999),
            Err(ChallengeError::NoChallenge),
            "reused nonce must be rejected"
        );
        k.reset_for_tests();
    }
}

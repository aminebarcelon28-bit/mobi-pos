//! Phase 2 — boot-session continuity verdict.
//!
//! Continuity requires positive proof from up to three signals:
//!
//! 1. **Boot id match** where the OS provides one cheaply (Linux/Android
//!    `boot_id`, Apple `kern.boottime`). Both present and different ⇒ new
//!    session, unconditionally.
//! 2. **Uptime non-regression**: current monotonic < persisted monotonic ⇒
//!    the monotonic source restarted ⇒ new session. (Alone this has a hole:
//!    off-for-days, reboot, run long enough to exceed the saved uptime reads
//!    as continuous — hence signal 3.)
//! 3. **ΔM/ΔW consistency**: |Δmonotonic − Δwall| ≤
//!    `SESSION_CONTINUITY_TOLERANCE_MS` (default 1 h — deliberately loose so
//!    NTP steps never force new sessions, while reboots mismatch by orders
//!    of magnitude). Mismatch ⇒ new session.
//!
//! Any failure ⇒ **new session** (the safe direction). A mismatch never
//! raises an alarm by itself; rollback verdicts remain a separate
//! anchor-comparison layer in `time_engine`, so a same-boot wall attack that
//! passes continuity (small rollback within tolerance) still quarantines on
//! the anchor check.
//!
//! When continuity fails, cross-session monotonic subtraction is refused and
//! the engine falls back to wall-vs-anchor comparison only.

use super::clocks::MonotonicSource;

/// Persisted observation from the previous session/checkpoint.
#[derive(Debug, Clone)]
pub struct SessionCheckpoint {
    pub boot_id: Option<String>,
    pub monotonic_ms: u64,
    pub wall_utc_ms: u64,
}

/// Continuity outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Continuity {
    /// Same boot proven: monotonic subtraction is permitted.
    Continuous { delta_m_ms: u64 },
    /// New (or unprovable) session: monotonic subtraction refused.
    NewSession,
}

/// Evaluate continuity between a persisted checkpoint and current readings.
///
/// `current_wall_utc_ms` is the caller's wall clock (untrusted input here —
/// it is only used for the consistency cross-check, never as an anchor).
/// `tolerance_ms` defaults to `SESSION_CONTINUITY_TOLERANCE_MS`.
pub fn evaluate_continuity(
    checkpoint: &SessionCheckpoint,
    clock: &dyn MonotonicSource,
    current_wall_utc_ms: u64,
    tolerance_ms: u64,
) -> Continuity {
    // Signal 1: boot-id mismatch is definitive.
    if let (Some(saved), Some(current)) = (checkpoint.boot_id.as_deref(), clock.boot_id()) {
        if saved != current {
            return Continuity::NewSession;
        }
    }

    let current_m = match clock.now_ms() {
        Some(m) => m,
        None => return Continuity::NewSession,
    };

    // Signal 2: monotonic regression means the source restarted.
    if current_m < checkpoint.monotonic_ms {
        return Continuity::NewSession;
    }
    let delta_m = current_m - checkpoint.monotonic_ms;

    // Signal 3: ΔM/ΔW consistency cross-check closes the off-for-days hole:
    // a reboot followed by a long uptime can pass signal 2 while the wall
    // advanced by days. Unsigned comparison via saturating arithmetic.
    let delta_w = current_wall_utc_ms.saturating_sub(checkpoint.wall_utc_ms);
    let gap = delta_m.saturating_sub(delta_w).max(delta_w.saturating_sub(delta_m));
    if gap > tolerance_ms {
        return Continuity::NewSession;
    }

    Continuity::Continuous { delta_m_ms: delta_m }
}

#[cfg(test)]
mod tests {
    use super::super::clocks::ManualClock;
    use super::super::time_config::SESSION_CONTINUITY_TOLERANCE_MS;
    use super::*;

    fn checkpoint(boot: Option<&'static str>, m: u64, w: u64) -> SessionCheckpoint {
        SessionCheckpoint {
            boot_id: boot.map(|s| s.to_string()),
            monotonic_ms: m,
            wall_utc_ms: w,
        }
    }

    #[test]
    fn same_boot_is_continuous() {
        let cp = checkpoint(Some("A"), 8 * 3_600_000, 1_700_000_000_000);
        let mut clock = ManualClock::with_boot(8 * 3_600_000, "A");
        clock.advance(60_000);
        let r = evaluate_continuity(&cp, &clock, 1_700_000_000_000 + 60_000, SESSION_CONTINUITY_TOLERANCE_MS);
        assert!(matches!(r, Continuity::Continuous { .. }));
    }

    #[test]
    fn boot_id_change_forces_new_session() {
        let cp = checkpoint(Some("A"), 1_000, 1_000);
        let clock = ManualClock::with_boot(2_000, "B");
        let r = evaluate_continuity(&cp, &clock, 2_000, SESSION_CONTINUITY_TOLERANCE_MS);
        assert_eq!(r, Continuity::NewSession);
    }

    #[test]
    fn monotonic_regression_forces_new_session() {
        let cp = checkpoint(None, 8 * 3_600_000, 1_000);
        let clock = ManualClock::new(600_000); // rebooted 10 min ago
        let r = evaluate_continuity(&cp, &clock, 2_000, SESSION_CONTINUITY_TOLERANCE_MS);
        assert_eq!(r, Continuity::NewSession);
    }

    #[test]
    fn off_for_days_then_long_uptime_is_detected() {
        // The hole: saved mono 8 h, machine off for days, rebooted, ran 9 h
        // before the next check. Uptime alone (9 h > 8 h) reads continuous.
        let cp = checkpoint(None, 8 * 3_600_000, 1_700_000_000_000);
        let clock = ManualClock::new(9 * 3_600_000);
        let wall = 1_700_000_000_000 + 3 * 86_400_000 + 3_600_000; // ~3 days later
        let r = evaluate_continuity(&cp, &clock, wall, SESSION_CONTINUITY_TOLERANCE_MS);
        assert_eq!(r, Continuity::NewSession, "ΔM/ΔW cross-check must catch the reboot");
    }

    #[test]
    fn small_ntp_step_does_not_force_new_session() {
        let cp = checkpoint(None, 3_600_000, 1_700_000_000_000);
        let mut clock = ManualClock::new(3_600_000);
        clock.advance(60_000);
        // Wall stepped +45 s (NTP): |60 s − 105 s| < 1 h tolerance.
        let r = evaluate_continuity(
            &cp,
            &clock,
            1_700_000_000_000 + 105_000,
            SESSION_CONTINUITY_TOLERANCE_MS,
        );
        assert!(matches!(r, Continuity::Continuous { .. }));
    }

    #[test]
    fn unavailable_clock_forces_new_session() {
        struct Dead;
        impl MonotonicSource for Dead {
            fn now_ms(&self) -> Option<u64> {
                None
            }
            fn source_name(&self) -> &'static str {
                "test:dead"
            }
        }
        let cp = checkpoint(None, 1_000, 1_000);
        let r = evaluate_continuity(&cp, &Dead, 2_000, SESSION_CONTINUITY_TOLERANCE_MS);
        assert_eq!(r, Continuity::NewSession);
    }
}

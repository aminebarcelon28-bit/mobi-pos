//! Phase 1 — state x capability matrix (B.3).
//!
//! This table is the SINGLE source of truth for policy and tests.
//! Capabilities derive only from native policy; no `licensed` boolean or
//! `isDegraded` flag crosses IPC.
//!
//! Owner-confirmation items (marked `*` in the directive): cells where the
//! default below is a judgment call are flagged via
//! [`PolicyDecision::owner_confirmation_required`]. The assumed defaults are:
//! - `EXPIRED + ReadOperationalData` = granted (merchant can still read books
//!   to close out while expired).
//! - `GRACE_EXCEEDED / SUSPENDED + ReadOperationalData` = denied (grace
//!   exceeded and suspension hide operational data; activation/export remain).
//! - `EXPIRED / GRACE_EXCEEDED / SUSPENDED / CLOCK_RESET_REQUIRED +
//!   EmergencyExport` = granted (statutory retention must not depend on a
//!   paid/active license).
//! - `REVOKED / CORRUPTED + EmergencyExport` = DENIED (strictest reading:
//!   a revoked or integrity-failed terminal must be re-activated or repaired
//!   before any data leaves it; owner may relax to granted).
//! - `TAMPER_SUSPECTED + EmergencyExport` = GRANTED with a MAC-covered
//!   `"tamper"` flag (owner-directed change, Phase 3.1 Q2 — was denied).
//!   Clock integrity still feeds Phase 2; the export changes no state,
//!   unlocks nothing, and is verifier-flagged as recovery-only.
//!
//! All assumptions are reported in the Phase 1 final report (H).

use super::license_state::LicenseState;
use serde::{Deserialize, Serialize};

/// Privileged capabilities. Every Tauri command that mutates state, moves
/// money/data, touches hardware, syncs, or exports must map to exactly one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Capability {
    OperationalWrites,
    ReadOperationalData,
    EmergencyExport,
    LicenseManagement,
    Sync,
    HardwareOperations,
}

/// Policy outcome for one (state, capability) pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyDecision {
    pub granted: bool,
    /// True when the default for this cell is a judgment call the owner must
    /// confirm (directive `*` cells).
    pub owner_confirmation_required: bool,
}

const DENY: PolicyDecision = PolicyDecision {
    granted: false,
    owner_confirmation_required: false,
};
const ALLOW: PolicyDecision = PolicyDecision {
    granted: true,
    owner_confirmation_required: false,
};
/// Granted, but the owner must confirm this default (directive `*`).
const ALLOW_OWNER: PolicyDecision = PolicyDecision {
    granted: true,
    owner_confirmation_required: true,
};
/// Denied, but the owner must confirm this default (directive `*`).
const DENY_OWNER: PolicyDecision = PolicyDecision {
    granted: false,
    owner_confirmation_required: true,
};

/// The single source of truth. Exhaustive over all known states; the
/// `#[non_exhaustive]` enum forces a compile error (not silent permission)
/// if a variant is added without updating this table.
pub fn authorize(state: &LicenseState, capability: Capability) -> PolicyDecision {
    match state {
        LicenseState::Unknown => DENY,
        LicenseState::Unactivated => match capability {
            Capability::LicenseManagement => ALLOW,
            _ => DENY,
        },
        LicenseState::Operational => ALLOW,
        LicenseState::Expired => match capability {
            Capability::ReadOperationalData => ALLOW_OWNER,
            Capability::EmergencyExport => ALLOW,
            Capability::LicenseManagement => ALLOW,
            _ => DENY,
        },
        LicenseState::GraceExceeded => match capability {
            Capability::ReadOperationalData => DENY_OWNER,
            Capability::EmergencyExport => ALLOW,
            Capability::LicenseManagement => ALLOW,
            _ => DENY,
        },
        LicenseState::Suspended => match capability {
            Capability::ReadOperationalData => DENY_OWNER,
            Capability::EmergencyExport => ALLOW_OWNER,
            Capability::LicenseManagement => ALLOW,
            _ => DENY,
        },
        LicenseState::Revoked => match capability {
            Capability::EmergencyExport => DENY_OWNER,
            Capability::LicenseManagement => ALLOW,
            _ => DENY,
        },
        LicenseState::Corrupted => match capability {
            Capability::EmergencyExport => DENY_OWNER,
            Capability::LicenseManagement => ALLOW,
            _ => DENY,
        },
        LicenseState::ClockResetRequired => match capability {
            Capability::EmergencyExport => ALLOW_OWNER,
            Capability::LicenseManagement => ALLOW,
            _ => DENY,
        },
        LicenseState::TamperSuspected => match capability {
            // Owner-directed (Phase 3.1 Q2): quarantine no longer blocks
            // emergency export. The export is read-only, changes no state,
            // unlocks nothing, and carries a MAC-covered "tamper" flag, so
            // a merchant with a wrong clock is never locked out of their
            // own data. REVOKED stays denied.
            Capability::EmergencyExport => ALLOW_OWNER,
            Capability::LicenseManagement => ALLOW,
            _ => DENY,
        },
    }
}

/// Every state, for exhaustive tests.
pub const ALL_STATES: [LicenseState; 10] = [
    LicenseState::Unknown,
    LicenseState::Unactivated,
    LicenseState::Operational,
    LicenseState::Expired,
    LicenseState::GraceExceeded,
    LicenseState::Suspended,
    LicenseState::Revoked,
    LicenseState::Corrupted,
    LicenseState::ClockResetRequired,
    LicenseState::TamperSuspected,
];

/// Every capability, for exhaustive tests.
pub const ALL_CAPABILITIES: [Capability; 6] = [
    Capability::OperationalWrites,
    Capability::ReadOperationalData,
    Capability::EmergencyExport,
    Capability::LicenseManagement,
    Capability::Sync,
    Capability::HardwareOperations,
];

#[cfg(test)]
mod tests {
    use super::*;

    /// The matrix as specified in B.3, encoded as (granted) expectations.
    /// Any change here is a policy change and must be owner-confirmed.
    fn expected(state: &LicenseState, cap: Capability) -> bool {
        match state {
            LicenseState::Unknown => false,
            LicenseState::Unactivated => cap == Capability::LicenseManagement,
            LicenseState::Operational => true,
            LicenseState::Expired => matches!(
                cap,
                Capability::ReadOperationalData
                    | Capability::EmergencyExport
                    | Capability::LicenseManagement
            ),
            LicenseState::GraceExceeded => matches!(
                cap,
                Capability::EmergencyExport | Capability::LicenseManagement
            ),
            LicenseState::Suspended => matches!(
                cap,
                Capability::EmergencyExport | Capability::LicenseManagement
            ),
            LicenseState::Revoked => cap == Capability::LicenseManagement,
            LicenseState::Corrupted => cap == Capability::LicenseManagement,
            LicenseState::ClockResetRequired => matches!(
                cap,
                Capability::EmergencyExport | Capability::LicenseManagement
            ),
            LicenseState::TamperSuspected => cap == Capability::LicenseManagement
                || cap == Capability::EmergencyExport,
        }
    }

    #[test]
    fn exhaustive_matrix_matches_spec() {
        for state in ALL_STATES {
            for cap in ALL_CAPABILITIES {
                let got = authorize(&state, cap);
                assert_eq!(
                    got.granted,
                    expected(&state, cap),
                    "matrix divergence at {:?} + {:?}",
                    state,
                    cap
                );
            }
        }
    }

    #[test]
    fn directive_spot_checks() {
        use Capability as C;
        use LicenseState as S;
        assert!(authorize(&S::Operational, C::OperationalWrites).granted);
        assert!(!authorize(&S::Expired, C::OperationalWrites).granted);
        assert!(authorize(&S::Expired, C::EmergencyExport).granted);
        assert!(!authorize(&S::Revoked, C::OperationalWrites).granted);
        for cap in ALL_CAPABILITIES {
            assert!(
                !authorize(&S::Unknown, cap).granted,
                "UNKNOWN must deny {cap:?}"
            );
        }
        assert!(authorize(&S::Unactivated, C::LicenseManagement).granted);
        for cap in ALL_CAPABILITIES {
            if cap != C::LicenseManagement {
                assert!(
                    !authorize(&S::Unactivated, cap).granted,
                    "UNACTIVATED must deny {cap:?}"
                );
            }
        }
        // EmergencyExport is independent of OPERATIONAL.
        assert!(authorize(&S::Expired, C::EmergencyExport).granted);
        assert!(authorize(&S::ClockResetRequired, C::EmergencyExport).granted);
    }

    #[test]
    fn owner_confirmation_flags_cover_star_cells() {
        use Capability as C;
        use LicenseState as S;
        // Granted-with-asterisk cells.
        assert!(authorize(&S::Expired, C::ReadOperationalData).owner_confirmation_required);
        assert!(authorize(&S::Suspended, C::EmergencyExport).owner_confirmation_required);
        assert!(authorize(&S::ClockResetRequired, C::EmergencyExport).owner_confirmation_required);
        // Denied-with-asterisk cells.
        assert!(authorize(&S::GraceExceeded, C::ReadOperationalData).owner_confirmation_required);
        assert!(authorize(&S::Revoked, C::EmergencyExport).owner_confirmation_required);
        assert!(authorize(&S::Corrupted, C::EmergencyExport).owner_confirmation_required);
        // Non-asterisk cells are not flagged.
        assert!(!authorize(&S::Operational, C::OperationalWrites).owner_confirmation_required);
        assert!(!authorize(&S::Unknown, C::OperationalWrites).owner_confirmation_required);
    }

    #[test]
    fn no_state_grants_sync_or_hardware_except_operational() {
        for state in ALL_STATES {
            if state == LicenseState::Operational {
                continue;
            }
            assert!(!authorize(&state, Capability::Sync).granted, "{state:?}");
            assert!(!authorize(&state, Capability::HardwareOperations).granted, "{state:?}");
        }
    }
}

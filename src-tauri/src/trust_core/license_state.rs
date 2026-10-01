//! Phase 1 — coarse license states (B.3).
//!
//! `UNKNOWN` is transient: the kernel must resolve it to a concrete state at
//! startup, and any failure to resolve becomes `CORRUPTED`. `UNKNOWN` denies
//! every capability, including `LicenseManagement`.
//!
//! `UNACTIVATED` is the fresh-install state (no license ever stored). It
//! grants `LicenseManagement` only, so a new terminal can activate without
//! contradicting the deny-by-default rule for `UNKNOWN` (gap G-02).
//!
//! Decoding is strict: malformed state, missing state, truncated data, and
//! unrecognized variants all resolve fail-closed to `CORRUPTED` — never to
//! `OPERATIONAL` or any state granting more than `CORRUPTED`.

use serde::{Deserialize, Serialize};

/// Coarse license state. Marked `#[non_exhaustive]` so a future variant added
/// by a newer build cannot be silently treated as a known permissive state by
/// older matching code: downstream crates must include a wildcard arm, and
/// this crate's policy match is exhaustive (compiler-forced updates).
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LicenseState {
    /// Transient boot state. Denies everything, including LicenseManagement.
    Unknown,
    /// Fresh install: no license stored yet. LicenseManagement only.
    Unactivated,
    Operational,
    Expired,
    GraceExceeded,
    Suspended,
    Revoked,
    Corrupted,
    ClockResetRequired,
    TamperSuspected,
}

/// The default is deliberately the deny-all transient state. There is no
/// permissive default.
impl Default for LicenseState {
    fn default() -> Self {
        LicenseState::Unknown
    }
}

impl LicenseState {
    /// Canonical wire/persistence code (SCREAMING_SNAKE_CASE).
    pub fn as_code(&self) -> &'static str {
        match self {
            LicenseState::Unknown => "UNKNOWN",
            LicenseState::Unactivated => "UNACTIVATED",
            LicenseState::Operational => "OPERATIONAL",
            LicenseState::Expired => "EXPIRED",
            LicenseState::GraceExceeded => "GRACE_EXCEEDED",
            LicenseState::Suspended => "SUSPENDED",
            LicenseState::Revoked => "REVOKED",
            LicenseState::Corrupted => "CORRUPTED",
            LicenseState::ClockResetRequired => "CLOCK_RESET_REQUIRED",
            LicenseState::TamperSuspected => "TAMPER_SUSPECTED",
        }
    }

    /// Strict decode. Unknown values return `None`; callers must map `None`
    /// to `CORRUPTED`, never to a permissive state.
    pub fn from_code(code: &str) -> Option<Self> {
        match code.trim().to_uppercase().as_str() {
            "UNKNOWN" => Some(LicenseState::Unknown),
            "UNACTIVATED" => Some(LicenseState::Unactivated),
            "OPERATIONAL" => Some(LicenseState::Operational),
            "EXPIRED" => Some(LicenseState::Expired),
            "GRACE_EXCEEDED" => Some(LicenseState::GraceExceeded),
            "SUSPENDED" => Some(LicenseState::Suspended),
            "REVOKED" => Some(LicenseState::Revoked),
            "CORRUPTED" => Some(LicenseState::Corrupted),
            "CLOCK_RESET_REQUIRED" => Some(LicenseState::ClockResetRequired),
            "TAMPER_SUSPECTED" => Some(LicenseState::TamperSuspected),
            _ => None,
        }
    }

    /// Fail-closed coercion for any untrusted input (persisted snapshots,
    /// IPC payloads, future variants): unrecognized values become
    /// `CORRUPTED`, which grants only `LicenseManagement`.
    pub fn coerce_from_untrusted(code: &str) -> Self {
        Self::from_code(code).unwrap_or(LicenseState::Corrupted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_codes_roundtrip() {
        let states = [
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
        for s in states {
            assert_eq!(LicenseState::from_code(s.as_code()), Some(s));
        }
    }

    #[test]
    fn unknown_codes_resolve_to_corrupted_never_operational() {
        // Surrounding whitespace and case are tolerated by design (covers TS
        // upper/lower variance); everything else must fail closed.
        assert_eq!(
            LicenseState::from_code("OPERATIONAL "),
            Some(LicenseState::Operational)
        );
        assert_eq!(
            LicenseState::from_code("operational"),
            Some(LicenseState::Operational)
        );
        for bad in [
            "",
            "ACTIVE",
            "LICENSED",
            "GRACE",
            "UNKNOWN_FUTURE_V2",
            "OPERATIONAL\0",
            "null",
            "undefined",
            "1337",
            "OPERATIONALX",
            "XOPERATIONAL",
        ] {
            assert_eq!(LicenseState::from_code(bad), None, "must not decode: {bad:?}");
            let coerced = LicenseState::coerce_from_untrusted(bad);
            assert_eq!(coerced, LicenseState::Corrupted);
            assert_ne!(coerced, LicenseState::Operational);
        }
    }

    #[test]
    fn serde_rejects_unknown_variants() {
        let err = serde_json::from_str::<LicenseState>("\"SUPER_ADMIN\"").unwrap_err();
        assert!(err.is_data(), "unknown variant must be a data error: {err}");
        // Known variant still deserializes (SCREAMING codes match as_code()).
        let ok: LicenseState = serde_json::from_str("\"EXPIRED\"").unwrap();
        assert_eq!(ok, LicenseState::Expired);
        assert_eq!(ok.as_code(), "EXPIRED");
    }

    #[test]
    fn default_is_deny_all_unknown() {
        assert_eq!(LicenseState::default(), LicenseState::Unknown);
    }
}

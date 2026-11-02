//! Native session principal (R1 / SEC-01).
//!
//! The renderer holds the IPC handle for every command; a privileged command is
//! otherwise honoured regardless of who is logged in (capability-by-license
//! state). This module gives the kernel a principal that only native login can
//! create:
//!
//!   * `pin_verify` success -> `set(user_id, role)` (role resolved natively from
//!     the roster row, never from an argument),
//!   * `session_lock`       -> `clear()` (public: dropping privileges is never
//!     an escalation),
//!   * process exit         -> gone (memory only; a restart requires login).
//!
//! Privileged commands call [`authorize`], which looks the command up in
//! [`PRIVILEGED_COMMANDS`] and fails closed with a stable `AUTHZ_*` reason.
//! An unlisted command is denied, so a new privileged command cannot ship
//! unguarded by omission. No command accepts a role or identity claim, so a
//! modified renderer cannot elevate itself by argument.
//!
//! Staleness: a principal ages out after `PRINCIPAL_TTL_MS` (10 min), so a UI
//! lock that never reaches the kernel cannot keep privileges alive forever.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use super::TrustError;

pub const PRINCIPAL_TTL_MS: u64 = 10 * 60 * 1000;

pub const DENY_NO_SESSION: &str = "AUTHZ_ROLE_REQUIRED:no-session";
pub const DENY_ROLE: &str = "AUTHZ_ROLE_REQUIRED:role-denied";
pub const DENY_PEER_TARGET: &str = "AUTHZ_ROLE_REQUIRED:peer-target";
pub const DENY_UNPOLICED: &str = "AUTHZ_ROLE_REQUIRED:no-policy";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Manager,
    Cashier,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Manager => "manager",
            Role::Cashier => "cashier",
        }
    }

    /// The roster's role vocabulary: `admin` aliases the manager.
    pub fn from_roster(role: &str) -> Role {
        match role.trim().to_ascii_lowercase().as_str() {
            "admin" | "manager" | "supervisor" => Role::Manager,
            _ => Role::Cashier,
        }
    }
}

/// What a privileged command requires of the live principal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    /// Manager role, whoever is logged in.
    ManagerOnly,
    /// The caller's own credential, or any manager (peer credentials).
    SelfOrManager,
}

#[derive(Debug, Clone)]
pub struct Principal {
    pub user_id: String,
    pub role: Role,
    pub verified_at_ms: u64,
}

static PRINCIPAL: Mutex<Option<Principal>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn deny(reason: &'static str) -> TrustError {
    TrustError::SecurityPolicyFailure { reason }
}

/// Record the operator that native login just proved.
pub fn set(user_id: &str, role: Role) {
    let mut slot = match PRINCIPAL.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    *slot = Some(Principal {
        user_id: user_id.trim().to_string(),
        role,
        verified_at_ms: now_ms(),
    });
}

pub fn clear() {
    let mut slot = match PRINCIPAL.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    *slot = None;
}

/// The live principal, or `None` when there is no session or it aged out.
pub fn current() -> Option<Principal> {
    let slot = match PRINCIPAL.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    slot.clone()
        .filter(|p| now_ms().saturating_sub(p.verified_at_ms) <= PRINCIPAL_TTL_MS)
}

/// Fail closed unless a live principal holds one of `allowed`.
pub fn require_any(allowed: &[Role]) -> Result<Principal, TrustError> {
    let Some(principal) = current() else {
        return Err(deny(DENY_NO_SESSION));
    };
    if !allowed.contains(&principal.role) {
        return Err(deny(DENY_ROLE));
    }
    Ok(principal)
}

/// `pin_set` may always target the caller's own credential; anything else is a
/// manager action.
pub fn require_self_or_manager(target_user_id: &str) -> Result<Principal, TrustError> {
    let Some(principal) = current() else {
        return Err(deny(DENY_NO_SESSION));
    };
    if principal.role == Role::Manager || principal.user_id == target_user_id.trim() {
        return Ok(principal);
    }
    Err(deny(DENY_PEER_TARGET))
}

/// The privileged command policy table, deny-by-default for anything absent.
///
/// The coverage test below reads the handler sources and proves each entry is
/// wired to `authorize("<command>", …)`, so removing a guard (or adding a
/// privileged command without registering it here) fails the suite.
pub const PRIVILEGED_COMMANDS: &[(&str, Policy)] = &[
    ("create_database_backup", Policy::ManagerOnly),
    ("decrypt_snapshot_for_recovery", Policy::ManagerOnly),
    ("prune_snapshots", Policy::ManagerOnly),
    ("pin_set", Policy::SelfOrManager),
];

/// The policy for `command`, or `None` when it is not privileged.
pub fn policy_for(command: &str) -> Option<Policy> {
    PRIVILEGED_COMMANDS
        .iter()
        .find(|(name, _)| *name == command)
        .map(|(_, policy)| *policy)
}

/// Deny-by-default authorization for a privileged command.
pub fn authorize(command: &str, target_user_id: &str) -> Result<Principal, TrustError> {
    match policy_for(command) {
        Some(Policy::ManagerOnly) => require_any(&[Role::Manager]),
        Some(Policy::SelfOrManager) => require_self_or_manager(target_user_id),
        None => Err(deny(DENY_UNPOLICED)),
    }
}

/// `pin_set` authorization, with the one documented bootstrap exception: on a
/// terminal that has no manager credential yet (first-run setup), the owner
/// credential may be created without a session. That is safe because the
/// credential store is native-write-only, and it can only *create* — re-keying
/// an existing manager already requires the supervisor PIN inside `pin_set`.
///
/// Only `pin_set` is accepted, so this entry point cannot be reused to bypass a
/// manager-only policy for another command.
pub fn authorize_pin_set(
    command: &str,
    target_user_id: &str,
    no_manager_credential_yet: bool,
) -> Result<Option<Principal>, TrustError> {
    if command != "pin_set" {
        return Err(deny(DENY_UNPOLICED));
    }
    match current() {
        Some(p) if p.role == Role::Manager || p.user_id == target_user_id.trim() => Ok(Some(p)),
        Some(_) => Err(deny(DENY_PEER_TARGET)),
        None if no_manager_credential_yet => Ok(None),
        None => Err(deny(DENY_NO_SESSION)),
    }
}

/// Drop the native principal. Called when the UI locks so privileges never
/// outlive the visible session; the TTL in [`current`] is only a backstop.
///
/// Public by design: a renderer can always drop privileges, never raise them.
#[tauri::command]
pub fn session_lock() {
    clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trust_core::ipc_authorizer::serial_test_lock;

    fn reason(err: TrustError) -> String {
        format!("{err:?}")
    }

    #[test]
    fn no_session_denies_every_privileged_command() {
        let _g = serial_test_lock();
        clear();
        for (cmd, _) in PRIVILEGED_COMMANDS {
            let denied = authorize(cmd, "usr-any").is_err();
            assert!(denied, "{cmd} must be denied without a session");
        }
    }

    #[test]
    fn role_matrix_is_exhaustive() {
        let _g = serial_test_lock();
        for (cmd, policy) in PRIVILEGED_COMMANDS {
            // Manager: every command is allowed.
            set("usr-admin", Role::Manager);
            assert!(authorize(cmd, "usr-b").is_ok(), "manager must be allowed: {cmd}");

            // Cashier: manager-only denied; self-service allowed, peer denied.
            set("usr-a", Role::Cashier);
            match policy {
                Policy::ManagerOnly => {
                    let err = authorize(cmd, "usr-a").expect_err(cmd);
                    assert!(reason(err).contains("AUTHZ_ROLE_REQUIRED"));
                }
                Policy::SelfOrManager => {
                    assert!(authorize(cmd, "usr-a").is_ok(), "own target is self-service: {cmd}");
                    let err = authorize(cmd, "usr-b").expect_err(cmd);
                    assert!(reason(err).contains("AUTHZ_ROLE_REQUIRED"));
                }
            }
        }
        clear();
    }

    #[test]
    fn pin_set_bootstrap_only_without_a_manager_credential() {
        let _g = serial_test_lock();
        clear();
        assert!(
            authorize_pin_set("pin_set", "usr-x", true).is_ok(),
            "first-run bootstrap may create the owner credential"
        );
        assert!(
            authorize_pin_set("pin_set", "usr-x", false).is_err(),
            "no session is not allowed once a manager exists"
        );
        assert!(
            authorize_pin_set("create_database_backup", "usr-x", true).is_err(),
            "this entry point is pin_set only"
        );
        set("usr-a", Role::Cashier);
        assert!(authorize_pin_set("pin_set", "usr-a", false).is_ok(), "own PIN");
        assert!(authorize_pin_set("pin_set", "usr-b", false).is_err(), "peer PIN");
        clear();
    }

    #[test]
    fn unlisted_command_is_denied_by_default() {
        let _g = serial_test_lock();
        set("usr-admin", Role::Manager);
        let err = authorize("wipe_everything", "").expect_err("no policy must deny");
        assert!(reason(err).contains("AUTHZ_ROLE_REQUIRED:no-policy"));
        clear();
    }

    #[test]
    fn manager_is_allowed_and_roster_vocabulary_maps() {
        let _g = serial_test_lock();
        set("usr-admin", Role::from_roster("admin"));
        assert!(authorize("create_database_backup", "").is_ok());
        assert!(require_self_or_manager("usr-b").is_ok());
        assert_eq!(Role::from_roster("cashier"), Role::Cashier);
        assert_eq!(Role::from_roster("Admin"), Role::Manager);
        clear();
    }

    #[test]
    fn principal_expires_after_the_ttl() {
        let _g = serial_test_lock();
        set("usr-a", Role::Manager);
        {
            let mut slot = PRINCIPAL.lock().unwrap();
            if let Some(p) = slot.as_mut() {
                p.verified_at_ms = p.verified_at_ms.saturating_sub(PRINCIPAL_TTL_MS + 1);
            }
        }
        assert!(current().is_none(), "an aged principal must not authorise anything");
        assert!(authorize("create_database_backup", "").is_err());
        clear();
    }

    #[test]
    fn session_lock_drops_the_principal() {
        let _g = serial_test_lock();
        set("usr-admin", Role::Manager);
        assert!(authorize("create_database_backup", "").is_ok());
        session_lock();
        assert!(current().is_none());
        assert!(authorize("create_database_backup", "").is_err());
    }

    /// Coverage: every success path of `pin_verify` sets the principal. The
    /// kernel must never mint a verified session in JS only.
    #[test]
    fn pin_verify_has_no_success_path_without_a_principal() {
        let src = include_str!("pin.rs");
        let anchors = src.matches("record_success_for(&*store, &request.user_id)?;").count();
        let wired = src.matches("super::session_principal::set(").count();
        assert_eq!(anchors, 2, "pin_verify should have exactly two success paths");
        assert_eq!(
            wired, anchors,
            "every pin_verify success path must set the native principal"
        );
    }

    /// Coverage: every entry in the policy table is wired in a handler, and in
    /// the handler of that name. Delete a guard (or list a command that no
    /// handler guards) and this fails.
    #[test]
    fn every_privileged_command_is_wired_to_its_policy() {
        let sources = [
            ("pin.rs", include_str!("pin.rs")),
            ("lib.rs", include_str!("../lib.rs")),
            ("snapshot_prune.rs", include_str!("../snapshot_prune.rs")),
        ];
        for (cmd, _) in PRIVILEGED_COMMANDS {
            let sig = format!("fn {cmd}(");
            let call = "session_principal::authorize";
            let cmd_lit = format!("\"{cmd}\"");
            let mut found = false;
            for (_name, src) in sources {
                let Some(i) = src.find(&sig) else { continue };
                let end = (i + 4000).min(src.len());
                let body = &src[i..end];
                if let Some(k) = body.find(call) {
                    // Allow the argument list to wrap across lines.
                    let after = &body[k..(k + 160).min(body.len())];
                    if after.contains(&cmd_lit) {
                        found = true;
                        break;
                    }
                }
            }
            assert!(
                found,
                "{cmd} is listed as privileged but no `fn {cmd}` handler calls {call}…{cmd_lit}…"
            );
        }
    }
}

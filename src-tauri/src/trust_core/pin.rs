//! Phase 4.5 — device-local PIN policy, verification, and lockout.
//!
//! Status: POLICY + LOCKOUT + LEGACY-MIGRATION-DETECTION are implemented and
//! tested. The Argon2id KDF is NOT (no `argon2`/`password-hash` crate in the
//! tree — adding it is a dependency decision, listed with justification in
//! the Phase 4.5 report). Until it lands, `pin_verify`/`pin_set` fail closed
//! with `KdfUnavailable`, EXCEPT legacy SHA-256 verification, which is
//! implemented natively so migration detection and `must_rotate` work today.
//!
//! # Why the legacy hash is weak (stated, not hidden)
//! `v1$salt$SHA256(salt:pin:const-pepper)`: one fast-hash round over a
//! 4–6-digit numeric space with a public pepper. Offline brute force is
//! milliseconds-to-seconds anywhere the value replicates (cloud KV, peers,
//! backups) — which is why PINs left generic sync (device-local since 4.5)
//! and why synced copies must be treated as exposed.
//!
//! # Policy (owner-set)
//! - Manager PIN: minimum 6 ASCII digits. Cashier PIN: minimum 4 ASCII
//!   digits. Digits only, no whitespace tolerance games (trimmed, then
//!   strict).
//! - Per-device PINs. No provisioned shared PIN.
//! - Lockout persisted per user id: 5 fails → 60 s, 10 fails → 15 min,
//!   15+ fails → 60 min. Success resets. Lockout state lives in the
//!   keystore (desktop) / vault file (mobile) — deleting it does not help:
//!   attempts re-accumulate from zero, and the KDF cost (once landed) makes
//!   online guessing uneconomical anyway.
//! - Migration: legacy `v1$` verifies once natively; success returns
//!   `migrated: false, must_rotate: true` for manager hashes (and cashier
//!   legacy hashes). Rotation to Argon2id happens at PIN-change time once
//!   the KDF lands; until then rotation is refused, never downgraded.

use super::ipc_authorizer::TrustError;
use serde::{Deserialize, Serialize};

/// Policy (see module docs).
pub const MANAGER_PIN_MIN_LEN: usize = 6;
pub const CASHIER_PIN_MIN_LEN: usize = 4;
pub const MANAGER_USER_ID: &str = "manager";

/// Lockout ladder: (failed attempts threshold, lock duration ms).
pub const LOCKOUT_LADDER: &[(u32, u64)] = &[(5, 60_000), (10, 900_000), (15, 3_600_000)];

/// Stored-credential format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinFormat {
    /// Legacy `v1$salt$sha256` — verifies natively, must rotate.
    LegacyV1,
    /// Modern `v2$argon2id$...` — requires the pending KDF backend.
    ModernV2,
    Unknown,
}

pub fn detect_format(stored: &str) -> PinFormat {
    let s = stored.trim();
    if s.starts_with("v1$") && s.split('$').count() == 3 {
        PinFormat::LegacyV1
    } else if s.starts_with("v2$") {
        PinFormat::ModernV2
    } else {
        PinFormat::Unknown
    }
}

/// Role-aware PIN policy check. Returns the canonical trimmed PIN.
pub fn validate_pin(pin: &str, is_manager: bool) -> Result<String, TrustError> {
    let clean = pin.trim();
    let min = if is_manager {
        MANAGER_PIN_MIN_LEN
    } else {
        CASHIER_PIN_MIN_LEN
    };
    if clean.len() < min || clean.len() > 32 {
        return Err(TrustError::IPCProtocolError {
            reason: "PIN length invalid",
        });
    }
    if !clean.bytes().all(|b| b.is_ascii_digit()) {
        return Err(TrustError::IPCProtocolError {
            reason: "PIN must be digits only",
        });
    }
    Ok(clean.to_string())
}

/// Legacy SHA-256 verification (migration detection ONLY — never mints).
/// Mirrors `hashPin` in `src/utils/security.ts` exactly:
/// `SHA256("{salt}:{pin}:mobi_pos_salt_v1")`, full-length XOR compare.
pub fn verify_legacy_sha256(pin: &str, stored: &str) -> bool {
    use sha2::{Digest, Sha256};
    let stored = stored.trim();
    if pin.is_empty() || stored.is_empty() {
        return false;
    }
    let mut parts = stored.split('$');
    if parts.next() != Some("v1") {
        return false;
    }
    let (Some(salt), Some(expected), None) =
        (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    if salt.is_empty() || expected.is_empty() {
        return false;
    }
    let mut hasher = Sha256::new();
    hasher.update(format!("{salt}:{}:mobi_pos_salt_v1", pin.trim()).as_bytes());
    let computed: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if computed.len() != expected.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in computed.bytes().zip(expected.bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

// ---------------------------------------------------------------------------
// Persisted lockout
// ---------------------------------------------------------------------------

/// Per-user lockout state (JSON doc keyed by user id).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UserLockout {
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub locked_until_ms: u64,
}

/// Evaluate the ladder: `Some(remaining_ms)` when locked.
pub fn lock_remaining_ms(lock: &UserLockout, now_ms: u64) -> Option<u64> {
    if lock.locked_until_ms > now_ms {
        return Some(lock.locked_until_ms - now_ms);
    }
    None
}

/// Record a failure at `now_ms`, returning the new lock duration (0 = not
/// locked yet). Thresholds are edge-triggered: crossing 5/10/15 locks.
pub fn record_failure(lock: &mut UserLockout, now_ms: u64) -> u64 {
    lock.attempts = lock.attempts.saturating_add(1);
    for (threshold, duration) in LOCKOUT_LADDER.iter().rev() {
        if lock.attempts >= *threshold {
            // Re-lock only when crossing into a tier or when expired.
            let tier_lock = now_ms.saturating_add(*duration);
            if lock.locked_until_ms <= now_ms {
                lock.locked_until_ms = tier_lock;
                return *duration;
            }
            return lock.locked_until_ms - now_ms;
        }
    }
    0
}

/// Success resets attempts and lock.
pub fn record_success(lock: &mut UserLockout) {
    lock.attempts = 0;
    lock.locked_until_ms = 0;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinVerifyRequest {
    pub user_id: String,
    pub pin: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinVerifyResult {
    pub ok: bool,
    pub locked: bool,
    pub locked_remaining_ms: u64,
    /// Stored credential is legacy `v1$`: rotation required (manager) /
    /// recommended. Always true on the legacy path by construction.
    pub must_rotate: bool,
    /// True when the KDF backend is absent (current state): no modern
    /// verification was attempted. Legacy path still evaluates.
    pub kdf_unavailable: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinSetRequest {
    pub user_id: String,
    pub new_pin: String,
}

/// Read the stored credential for a user from the live DB (read-only):
/// `manager` → `app_settings.manager_pin`, else the cashier roster row.
/// Returns `(stored_hash, is_manager)`; missing user is an error, never a
/// default credential.
fn read_stored_credential(
    conn: &rusqlite::Connection,
    user_id: &str,
) -> Result<(String, bool), TrustError> {
    let is_manager = user_id.trim() == MANAGER_USER_ID || user_id.trim().is_empty();
    if is_manager {
        let stored: Option<String> = conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = 'manager_pin' LIMIT 1",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .map_err(|e| TrustError::op_failed(format!("credential read: {e}")))?;
        let stored = stored.unwrap_or_default();
        // app_settings.value_json may hold a JSON string literal.
        let stored = serde_json::from_str::<String>(&stored).unwrap_or(stored);
        if stored.trim().is_empty() {
            return Err(TrustError::SecurityPolicyFailure {
                reason: "no manager credential set",
            });
        }
        return Ok((stored, true));
    }
    let roster: Option<String> = conn
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = 'cashier_users' LIMIT 1",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|e| TrustError::op_failed(format!("credential read: {e}")))?;
    let roster = roster.unwrap_or_default();
    let users: serde_json::Value =
        serde_json::from_str(&roster).unwrap_or(serde_json::Value::Null);
    let found = users.as_array().and_then(|arr| {
        arr.iter().find(|u| {
            u.get("id").and_then(|v| v.as_str()).unwrap_or("") == user_id.trim()
        })
    });
    match found.and_then(|u| u.get("pin")).and_then(|v| v.as_str()) {
        Some(pin) if !pin.trim().is_empty() => Ok((pin.to_string(), false)),
        _ => Err(TrustError::SecurityPolicyFailure {
            reason: "unknown cashier credential",
        }),
    }
}

fn db_path_for(app: &tauri::AppHandle) -> Result<std::path::PathBuf, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("app dir: {e}")))?;
    let p = dir.join("mobi_pos.db");
    if !p.exists() {
        return Err(TrustError::op_failed("live database missing".to_string()));
    }
    Ok(p)
}

fn open_live_ro(path: &std::path::Path) -> Result<rusqlite::Connection, TrustError> {
    use rusqlite::OpenFlags;
    let conn = rusqlite::Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| TrustError::op_failed(format!("credential DB open: {e}")))?;
    conn.execute_batch("PRAGMA query_only = ON;").ok();
    Ok(conn)
}

/// `#[tauri::command]`: verify a PIN natively. Legacy `v1$` verifies via
/// SHA-256 (migration detection); modern `v2$` and unknown formats fail
/// closed with `kdf_unavailable` until the Argon2id backend lands.
/// Lockout is enforced from persisted state before any crypto.
#[tauri::command]
pub fn pin_verify(
    app: tauri::AppHandle,
    request: PinVerifyRequest,
) -> Result<PinVerifyResult, TrustError> {
    super::ipc_authorizer::authorize_and_execute(
        "pin_verify",
        super::Capability::LicenseManagement,
        |_| {
            use tauri::Manager;
            let app_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| TrustError::op_failed(format!("app dir: {e}")))?;
            let (store, _) = super::ipc_authorizer::select_store(&app_dir);
            let now_ms = system_now_ms();
            let locked = check_lockout(&*store, &request.user_id, now_ms);
            if locked.locked {
                return Ok(PinVerifyResult {
                    ok: false,
                    locked: true,
                    locked_remaining_ms: locked.remaining_ms,
                    must_rotate: false,
                    kdf_unavailable: true,
                });
            }
            if request.pin.len() > 64 {
                return Err(TrustError::IPCProtocolError {
                    reason: "PIN oversized",
                });
            }
            let path = db_path_for(&app)?;
            let conn = open_live_ro(&path)?;
            let (stored, is_manager) = read_stored_credential(&conn, &request.user_id)?;
            // Policy validation first (length/charset), so malformed input
            // records a failure without touching crypto.
            let clean = match validate_pin(&request.pin, is_manager) {
                Ok(c) => c,
                Err(_) => {
                    record_failure_for(&*store, &request.user_id, now_ms)?;
                    return Ok(denied());
                }
            };
            match detect_format(&stored) {
                PinFormat::LegacyV1 => {
                    if verify_legacy_sha256(&clean, &stored) {
                        record_success_for(&*store, &request.user_id)?;
                        Ok(PinVerifyResult {
                            ok: true,
                            locked: false,
                            locked_remaining_ms: 0,
                            must_rotate: true,
                            kdf_unavailable: true,
                        })
                    } else {
                        record_failure_for(&*store, &request.user_id, now_ms)?;
                        Ok(denied())
                    }
                }
                PinFormat::ModernV2 | PinFormat::Unknown => {
                    // No verification possible yet: fail closed WITHOUT
                    // recording a failure (nothing was actually tested) and
                    // flag rotation so the caller can route to PIN change.
                    Ok(PinVerifyResult {
                        ok: false,
                        locked: false,
                        locked_remaining_ms: 0,
                        must_rotate: true,
                        kdf_unavailable: true,
                    })
                }
            }
        },
    )
}

/// `#[tauri::command]`: set/rotate a PIN. Refuses until the Argon2id backend
/// lands (minting another fast hash would be a downgrade). Policy validation
/// still runs so callers get typed errors today.
#[tauri::command]
pub fn pin_set(
    _app: tauri::AppHandle,
    request: PinSetRequest,
) -> Result<String, TrustError> {
    super::ipc_authorizer::authorize_and_execute(
        "pin_set",
        super::Capability::LicenseManagement,
        |_| {
            if request.user_id.trim().is_empty() || request.user_id.len() > 64 {
                return Err(TrustError::IPCProtocolError {
                    reason: "user id invalid",
                });
            }
            let is_manager =
                request.user_id.trim() == MANAGER_USER_ID;
            validate_pin(&request.new_pin, is_manager)?;
            Err(TrustError::SecurityPolicyFailure {
                reason: "PIN rotation unavailable: Argon2id backend pending dependency approval",
            })
        },
    )
}

fn denied() -> PinVerifyResult {
    PinVerifyResult {
        ok: false,
        locked: false,
        locked_remaining_ms: 0,
        must_rotate: false,
        kdf_unavailable: true,
    }
}

// ---------------------------------------------------------------------------
// Lockout persistence (keystore/file vault JSON, per user id)
// ---------------------------------------------------------------------------

use std::collections::HashMap;

type LockoutMap = HashMap<String, UserLockout>;

fn load_lockouts(store: &dyn super::secure_storage::KeyStore) -> LockoutMap {
    store
        .load_pin_lockouts()
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_lockouts(
    store: &dyn super::secure_storage::KeyStore,
    map: &LockoutMap,
) -> Result<(), TrustError> {
    let s = serde_json::to_string(map)
        .map_err(|e| TrustError::op_failed(format!("lockout encode: {e}")))?;
    store
        .store_pin_lockouts(&s)
        .map_err(|e| TrustError::op_failed(format!("lockout store: {e:?}")))
}

fn system_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct LockoutQuery {
    locked: bool,
    remaining_ms: u64,
}

/// Check persisted lockout for a user. Store errors fail OPEN toward
/// counting (a fresh in-memory state) but never skip the check itself —
/// callers always consult this before crypto.
fn check_lockout(
    store: &dyn super::secure_storage::KeyStore,
    user_id: &str,
    now_ms: u64,
) -> LockoutQuery {
    let map = load_lockouts(store);
    match map.get(user_id) {
        Some(lock) => match lock_remaining_ms(lock, now_ms) {
            Some(remaining) => LockoutQuery {
                locked: true,
                remaining_ms: remaining,
            },
            None => LockoutQuery {
                locked: false,
                remaining_ms: 0,
            },
        },
        None => LockoutQuery {
            locked: false,
            remaining_ms: 0,
        },
    }
}

fn record_failure_for(
    store: &dyn super::secure_storage::KeyStore,
    user_id: &str,
    now_ms: u64,
) -> Result<(), TrustError> {
    let mut map = load_lockouts(store);
    let lock = map.entry(user_id.to_string()).or_default();
    record_failure(lock, now_ms);
    save_lockouts(store, &map)
}

fn record_success_for(
    store: &dyn super::secure_storage::KeyStore,
    user_id: &str,
) -> Result<(), TrustError> {
    let mut map = load_lockouts(store);
    if let Some(lock) = map.get_mut(user_id) {
        record_success(lock);
        save_lockouts(store, &map)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trust_core::ipc_authorizer::serial_test_lock;

    #[test]
    fn policy_lengths_and_charset() {
        assert!(validate_pin("123456", true).is_ok());
        assert!(validate_pin("12345", true).is_err());
        assert!(validate_pin("1234", false).is_ok());
        assert!(validate_pin("123", false).is_err());
        assert!(validate_pin("12a4", false).is_err());
        assert!(validate_pin("", true).is_err());
        assert!(validate_pin("  123456  ", true).is_ok());
    }

    #[test]
    fn legacy_sha256_vector_and_fail_closed_shapes() {
        // pin=1234 salt=abc → independently computable reference.
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(b"abc:1234:mobi_pos_salt_v1");
        let digest: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        let stored = format!("v1$abc${digest}");
        assert!(verify_legacy_sha256("1234", &stored));
        assert!(!verify_legacy_sha256("1235", &stored));
        assert!(!verify_legacy_sha256("", &stored));
        assert!(!verify_legacy_sha256("1234", ""));
        assert!(!verify_legacy_sha256("1234", "1234"));
        assert!(!verify_legacy_sha256("1234", "v1$abc"));
        assert!(!verify_legacy_sha256("1234", "v2$abc$def"));
        assert_eq!(detect_format(&stored), PinFormat::LegacyV1);
        assert_eq!(detect_format("v2$argon2id$v=19$m=x"), PinFormat::ModernV2);
        assert_eq!(detect_format("plaintext"), PinFormat::Unknown);
    }

    #[test]
    fn lockout_ladder_edges() {
        let mut lock = UserLockout::default();
        // Below threshold: no lock.
        for _ in 0..4 {
            assert_eq!(record_failure(&mut lock, 1_000), 0);
        }
        assert!(lock_remaining_ms(&lock, 2_000).is_none());
        // 5th failure locks 60 s.
        assert_eq!(record_failure(&mut lock, 3_000), 60_000);
        assert_eq!(lock_remaining_ms(&lock, 4_000), Some(59_000));
        assert!(lock_remaining_ms(&lock, 200_000).is_none());
        // Success resets fully.
        record_success(&mut lock);
        assert_eq!((lock.attempts, lock.locked_until_ms), (0, 0));
        // Jump to tier 2 and 3 directly.
        lock.attempts = 9;
        assert_eq!(record_failure(&mut lock, 1_000_000), 900_000);
        lock.attempts = 14;
        lock.locked_until_ms = 0;
        assert_eq!(record_failure(&mut lock, 2_000_000), 3_600_000);
    }

    #[test]
    fn lockout_persists_across_loads() {
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        let _g = serial_test_lock();
        let store = MemKeyStore::new();
        // Five failures persist and lock.
        for _ in 0..5 {
            record_failure_for(&store, "manager", 10_000).unwrap();
        }
        let q = check_lockout(&store, "manager", 11_000);
        assert!(q.locked);
        assert_eq!(q.remaining_ms, 59_000);
        // Success clears durably.
        record_success_for(&store, "manager").unwrap();
        let q = check_lockout(&store, "manager", 12_000);
        assert!(!q.locked);
        // Unknown users are never locked.
        let q = check_lockout(&store, "nobody", 12_000);
        assert!(!q.locked);
    }

    #[test]
    fn lockout_query_shape_smoke() {
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        let _g = serial_test_lock();
        let store = MemKeyStore::new();
        let q = check_lockout(&store, "manager", 99_000);
        assert!(!q.locked);
    }

    #[test]
    fn lockout_survives_restart_via_file_vault() {
        // "Restart" = a fresh store instance over the same vault file. The
        // MemKeyStore test above proves the logic; this proves the DURABILITY
        // the threat model relies on (deleting localStorage must not help —
        // the TS lockout is cosmetic, this one is authoritative).
        use crate::trust_core::secure_storage::FileKeyStore;
        let _g = serial_test_lock();
        let dir = std::env::temp_dir().join(format!(
            "mobi-pin-lockout-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let path = FileKeyStore::default_path(&dir);
        {
            let store = FileKeyStore::new(path.clone());
            for _ in 0..5 {
                record_failure_for(&store, "manager", 10_000).unwrap();
            }
            assert!(check_lockout(&store, "manager", 11_000).locked);
        }
        // Fresh instance = post-restart process: lock still holds.
        {
            let store2 = FileKeyStore::new(path.clone());
            let q = check_lockout(&store2, "manager", 11_000);
            assert!(q.locked, "lockout must survive process restart");
            assert_eq!(q.remaining_ms, 59_000);
            // And it expires on schedule (no permanent self-DoS).
            assert!(!check_lockout(&store2, "manager", 10_000 + 61_000).locked);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_stored_credential_shapes() {
        let _g = serial_test_lock();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT);",
        )
        .unwrap();
        // Missing everything: typed errors, never a default credential.
        assert!(read_stored_credential(&conn, "manager").is_err());
        assert!(read_stored_credential(&conn, "cashier-1").is_err());
        // Manager stored as a JSON string literal (how the app persists it).
        conn.execute(
            "INSERT INTO app_settings (key, value_json) VALUES ('manager_pin', '\"v1$salt$digest\"')",
            [],
        )
        .unwrap();
        let (stored, is_manager) = read_stored_credential(&conn, "manager").unwrap();
        assert!(is_manager);
        assert_eq!(stored, "v1$salt$digest");
        // Empty user id aliases to manager (lock-screen manager override).
        assert!(read_stored_credential(&conn, "").unwrap().1);
        // Cashier roster parsing; unknown id errors; empty pin errors.
        conn.execute(
            "INSERT INTO app_settings (key, value_json) VALUES ('cashier_users',
             '[{\"id\":\"c1\",\"pin\":\"v1$a$b\"},{\"id\":\"c2\",\"pin\":\"\"}]')",
            [],
        )
        .unwrap();
        let (c1, is_mgr) = read_stored_credential(&conn, "c1").unwrap();
        assert!(!is_mgr);
        assert_eq!(c1, "v1$a$b");
        assert!(read_stored_credential(&conn, "nobody").is_err());
        assert!(read_stored_credential(&conn, "c2").is_err());
    }
}

//! Phase 4.5 — device-local PIN policy, verification, and lockout.
//!
//! Status: POLICY + LOCKOUT + LEGACY-MIGRATION-DETECTION **and the Argon2id
//! KDF** are implemented and tested. Argon2id (owner-approved 2026-10-02,
//! which is the dependency gate this module previously recorded) backs the
//! modern `v2$` format; legacy `v1$` still verifies natively so migration
//! detection and `must_rotate` keep working.
//!
//! # Stored formats
//! - `v1$salt$SHA256(salt:pin:pepper)` — legacy, verifies once, must rotate.
//! - `v2$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>` — modern. The KDF
//!   parameters are stored INSIDE the credential so cost can be raised later
//!   without invalidating existing hashes (verification always uses the
//!   parameters recorded with the hash, never today's defaults).
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
//!   attempts re-accumulate from zero, and the KDF cost makes online
//!   guessing uneconomical.
//! - Migration: legacy `v1$` verifies once natively; success returns
//!   `migrated: false, must_rotate: true` for manager hashes (and cashier
//!   legacy hashes). Rotation mints Argon2id. Migration is NOT silent: a
//!   successful legacy verify never re-hashes in place, because the owner-set
//!   Phase 4.5 decision makes rotation MANDATORY before unlock.

use super::ipc_authorizer::TrustError;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

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
    /// Modern `v2$argon2id$v=19$m=..,t=..,p=..$salt$hash` — Argon2id.
    ModernV2,
    Unknown,
}

/// PHC algorithm identifier for the only modern format we mint.
const ARGON2ID_ID: &str = "argon2id";

/// Argon2id cost (owner-set 2026-10-02). m is in KiB, so this is 64 MiB of
/// memory per hash — the point of the KDF. Parameters are recorded in every
/// stored credential, so raising these later does not break existing hashes.
pub const ARGON2_M_COST_KIB: u32 = 65_536;
pub const ARGON2_T_COST: u32 = 3;
pub const ARGON2_P_COST: u32 = 1;

/// A plaintext PIN that wipes itself.
///
/// Argon2id is memory-hard but the *input* is ordinary heap memory: a `String`
/// copy would survive in the allocator long after the hash is computed, and a
/// swap/core dump could capture it. Every plaintext that reaches the KDF is
/// wrapped in this type so it is zeroized on drop, including on the error
/// paths.
#[derive(zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
pub struct SecretPin(String);

impl SecretPin {
    pub fn new(pin: String) -> Self {
        Self(pin)
    }
    fn as_str(&self) -> &str {
        &self.0
    }
}

/// Strict structural check for a modern credential.
///
/// Deliberately exact rather than a `starts_with("v2$")` prefix test: an
/// unknown or malformed credential must classify as `Unknown` so the verify
/// path fails closed, never as "modern but unverifiable".
fn is_argon2id_credential(s: &str) -> bool {
    let parts: Vec<&str> = s.split('$').collect();
    // v2 | argon2id | v=19 | m=..,t=..,p=.. | salt | hash
    parts.len() == 6
        && parts[0] == "v2"
        && parts[1] == ARGON2ID_ID
        && parts[2].starts_with("v=")
        && parts[3].contains("m=")
        && parts[3].contains("t=")
        && parts[3].contains("p=")
        && !parts[4].is_empty()
        && !parts[5].is_empty()
}

pub fn detect_format(stored: &str) -> PinFormat {
    let s = stored.trim();
    if s.starts_with("v1$") && s.split('$').count() == 3 {
        PinFormat::LegacyV1
    } else if is_argon2id_credential(s) {
        PinFormat::ModernV2
    } else {
        PinFormat::Unknown
    }
}

/// Constant-time string equality. Returns false immediately on a length
/// mismatch (length is not secret), otherwise compares without an early exit.
fn ct_eq_str(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

/// Mint a modern Argon2id credential: `v2$argon2id$v=19$m=..$salt$hash`.
///
/// The only path that mints a PIN hash. Never reached from the legacy verify
/// path — rotation is explicit (see module docs).
pub fn mint_pin_hash(pin: &SecretPin) -> Result<String, TrustError> {
    use argon2::password_hash::{PasswordHasher, SaltString, rand_core::OsRng};
    use argon2::{Algorithm, Argon2, Params, Version};

    let params = Params::new(
        ARGON2_M_COST_KIB,
        ARGON2_T_COST,
        ARGON2_P_COST,
        None::<usize>,
    )
    .map_err(|e| TrustError::op_failed(format!("argon2 params rejected: {e}")))?;
    let hasher = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    // OsRng: a weak salt would let a GPU attacker precompute far more of the
    // 4–6 digit space per hash.
    let salt = SaltString::generate(&mut OsRng);
    let hash = hasher
        .hash_password(pin.as_str().as_bytes(), &salt)
        .map_err(|e| TrustError::op_failed(format!("argon2 hash failed: {e}")))?;
    // `hash_password` yields a leading-`$` PHC string; store it under our own
    // `v2$` namespace so the format is self-describing.
    Ok(format!("v2${}", hash.to_string().trim_start_matches('$')))
}

/// Verify a modern Argon2id credential.
///
/// Uses the KDF parameters recorded in the credential (not today's defaults),
/// so a future cost increase applies to new hashes only. `Argon2::default()`
/// defers entirely to the parsed `PasswordHash` parameters.
///
/// Errors are uniformly `false`: a wrong PIN, a malformed credential, a
/// foreign algorithm, and a corrupt cost parameter are indistinguishable to
/// the caller, so no oracle reveals which.
pub fn verify_argon2id(pin: &SecretPin, stored: &str) -> bool {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    use argon2::Argon2;

    let Some(body) = stored.trim().strip_prefix("v2$") else {
        return false;
    };
    // `PasswordHash::new` parses the PHC grammar, which is `$`-prefixed. Our
    // stored form drops that leading `$` so the credential reads as
    // `v2$argon2id$...`, so it is restored here for the parser.
    let phc = format!("${body}");
    let Ok(parsed) = PasswordHash::new(&phc) else {
        return false;
    };
    // Constant-time algorithm gate: never take a cheap path for a hash we did
    // not mint, even if its parameters look well formed.
    if !ct_eq_str(parsed.algorithm.as_str(), ARGON2ID_ID) {
        return false;
    }
    // `verify_password` is constant-time over the digest comparison.
    Argon2::default()
        .verify_password(pin.as_str().as_bytes(), &parsed)
        .is_ok()
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
    let raw = format!("{salt}:{}:mobi_pos_salt_v1", pin.trim());
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    let computed: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if computed.len() == expected.len() {
        let mut diff = 0u8;
        for (a, b) in computed.bytes().zip(expected.bytes()) {
            diff |= a ^ b;
        }
        if diff == 0 {
            return true;
        }
    }
    // Backward compatibility: verify against legacy sieve-corrupted SHA-256
    // (where prime sieve stopped at 300, setting K[62]=0xb1bf9402 and K[63]=0xb3a680f4).
    verify_sieve_legacy_sha256(&raw, expected)
}

/// Sieve-variant SHA-256 (where K[62]=0xb1bf9402 and K[63]=0xb3a680f4).
/// Exactly mirrors legacy TS `sha256Sync` prior to standard K constants fix.
pub fn verify_sieve_legacy_sha256(raw: &str, expected: &str) -> bool {
    let computed = sieve_sha256_hex(raw.as_bytes());
    if computed.len() != expected.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in computed.bytes().zip(expected.bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn sieve_sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xb1bf9402, 0xb3a680f4,
    ];
    const H0: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0x00);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    let mut h = H0;
    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, w_elem) in w[..16].iter_mut().enumerate() {
            *w_elem = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut h_var = h[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h_var.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            h_var = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(h_var);
    }
    format!(
        "{:08x}{:08x}{:08x}{:08x}{:08x}{:08x}{:08x}{:08x}",
        h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]
    )
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
    /// True only when the KDF backend is genuinely absent (a degraded build).
    /// Argon2id is now always compiled in, so this is false on every path: a
    /// legacy success sets `must_rotate`, and an unknown credential sets
    /// `must_rotate` — neither means "no KDF available".
    pub kdf_unavailable: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinSetRequest {
    pub user_id: String,
    pub new_pin: String,
}

/// Result of a successful rotation.
///
/// Carries NO credential material: the minted hash is written natively and is
/// never serialized to the WebView (trust tables are native-write-only).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinSetResult {
    pub user_id: String,
    /// Always `"v2"` — Argon2id is the only format minted.
    pub format: String,
}

/// Read the stored credential for a user from the live DB (read-only):
/// `manager` → `app_settings.manager_pin`, else the cashier roster row.
/// Returns `(stored_hash, is_manager)`; missing user is an error, never a
/// default credential.
fn read_stored_credential(
    conn: &rusqlite::Connection,
    user_id: &str,
) -> Result<(String, bool), TrustError> {
    let uid = user_id.trim();
    let is_manager = uid.eq_ignore_ascii_case(MANAGER_USER_ID) || uid.is_empty() || uid == "usr-admin";
    if is_manager {
        return read_manager_credential(conn);
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
            u.get("id").and_then(|v| v.as_str()).unwrap_or("") == uid
        })
    });
    if let Some(user_obj) = found {
        if let Some(pin) = user_obj.get("pin").and_then(|v| v.as_str()) {
            if !pin.trim().is_empty() {
                let is_admin = user_obj.get("role").and_then(|v| v.as_str()) == Some("admin");
                return Ok((pin.to_string(), is_admin));
            }
        }
        // Admin profile in roster with empty cashier pin aliases to manager credential
        if user_obj.get("role").and_then(|v| v.as_str()) == Some("admin") {
            return read_manager_credential(conn);
        }
    }
    Err(TrustError::SecurityPolicyFailure {
        reason: "unknown cashier credential",
    })
}

fn read_manager_credential(conn: &rusqlite::Connection) -> Result<(String, bool), TrustError> {
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
    Ok((stored, true))
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

/// Read-write handle used ONLY by `pin_set` (credential rotation). Mirrors
/// `open_live_ro` but omits `query_only`; no other credential path may take
/// it, so a verify can never be talked into writing.
fn open_live_rw(path: &std::path::Path) -> Result<rusqlite::Connection, TrustError> {
    use rusqlite::OpenFlags;
    rusqlite::Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| TrustError::op_failed(format!("credential DB open: {e}")))
}

/// Upsert an `app_settings` row holding a JSON string literal, mirroring how
/// the credential readers unwrap `value_json`.
fn write_app_setting(
    conn: &rusqlite::Connection,
    key: &str,
    value: &str,
) -> Result<(), TrustError> {
    let encoded = serde_json::to_string(value)
        .map_err(|e| TrustError::op_failed(format!("credential encode: {e}")))?;
    conn.execute(
        "INSERT INTO app_settings (key, value_json) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        rusqlite::params![key, encoded],
    )
    .map_err(|e| TrustError::op_failed(format!("credential write: {e}")))?;
    Ok(())
}

/// Persist a minted Argon2id credential natively (never returned to the
/// WebView — trust tables are native-write-only, AGENTS.md rule 5).
///
/// The mint happens BEFORE the transaction opens so the 64 MiB Argon2id
/// allocation never overlaps a live write lock.
fn store_credential(
    conn: &rusqlite::Connection,
    user_id: &str,
    hash: &str,
) -> Result<(), TrustError> {
    let uid = user_id.trim();
    let is_manager = uid.eq_ignore_ascii_case(MANAGER_USER_ID) || uid.is_empty() || uid == "usr-admin";
    if is_manager {
        return write_app_setting(conn, "manager_pin", hash);
    }

    let roster: Option<String> = conn
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = 'cashier_users' LIMIT 1",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|e| TrustError::op_failed(format!("credential read: {e}")))?;
    let roster = roster.unwrap_or_default();
    let mut users: serde_json::Value =
        serde_json::from_str(&roster).map_err(|_| TrustError::SecurityPolicyFailure {
            reason: "cashier roster unreadable",
        })?;
    let arr = users.as_array_mut().ok_or_else(|| TrustError::SecurityPolicyFailure {
        reason: "cashier roster malformed",
    })?;
    // An admin profile in the roster aliases the manager credential; refuse to
    // silently create a shadow credential for it.
    let target = arr
        .iter_mut()
        .find(|u| u.get("id").and_then(|v| v.as_str()).unwrap_or("") == uid)
        .ok_or_else(|| TrustError::SecurityPolicyFailure {
            reason: "unknown cashier credential",
        })?;
    if target.get("role").and_then(|v| v.as_str()) == Some("admin") {
        return write_app_setting(conn, "manager_pin", hash);
    }
    target["pin"] = serde_json::Value::String(hash.to_string());
    let encoded = serde_json::to_string(&users)
        .map_err(|e| TrustError::op_failed(format!("credential encode: {e}")))?;
    write_app_setting(conn, "cashier_users", &encoded)
}

/// `#[tauri::command]`: set/rotate a PIN to Argon2id.
///
/// Mints natively and WRITES the credential natively; the hash is never
/// returned to the WebView, so no caller can persist it somewhere untrusted.
/// Policy validation runs first so an invalid PIN is rejected before any KDF
/// cost is paid.
#[tauri::command]
pub fn pin_set(
    app: tauri::AppHandle,
    request: PinSetRequest,
) -> Result<PinSetResult, TrustError> {
    super::ipc_authorizer::authorize_and_execute(
        "pin_set",
        super::Capability::LicenseManagement,
        |_| {
            if request.user_id.trim().is_empty() || request.user_id.len() > 64 {
                return Err(TrustError::IPCProtocolError {
                    reason: "user id invalid",
                });
            }
            if request.new_pin.len() > 64 {
                return Err(TrustError::IPCProtocolError {
                    reason: "PIN oversized",
                });
            }
            let is_manager = request.user_id.trim() == MANAGER_USER_ID;
            let clean = validate_pin(&request.new_pin, is_manager)?;
            let secret = SecretPin::new(clean);
            // Mint before opening the DB: the 64 MiB KDF must not run while a
            // write lock is held.
            let hash = mint_pin_hash(&secret)?;
            let path = db_path_for(&app)?;
            let mut conn = open_live_rw(&path)?;
            let tx = conn
                .transaction()
                .map_err(|e| TrustError::op_failed(format!("credential txn: {e}")))?;
            store_credential(&tx, &request.user_id, &hash)?;
            tx.commit()
                .map_err(|e| TrustError::op_failed(format!("credential commit: {e}")))?;
            Ok(PinSetResult {
                user_id: request.user_id.trim().to_string(),
                format: "v2".to_string(),
            })
        },
    )
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
                    // Lockout is a pre-crypto gate, so no KDF ran — but the
                    // backend is present, so this is not a degraded install.
                    kdf_unavailable: false,
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
            let format = detect_format(&stored);
            // Policy validation first (length/charset), so malformed input
            // records a failure without touching crypto.
            // On legacy format, allow minimum 4 digits during verification so
            // existing 4-digit legacy manager credentials can authenticate once
            // before the mandatory rotation to 6+ digits.
            let min_len = if format == PinFormat::LegacyV1 {
                CASHIER_PIN_MIN_LEN
            } else if is_manager {
                MANAGER_PIN_MIN_LEN
            } else {
                CASHIER_PIN_MIN_LEN
            };
            let clean = request.pin.trim();
            if clean.len() < min_len || clean.len() > 32 || !clean.bytes().all(|b| b.is_ascii_digit()) {
                record_failure_for(&*store, &request.user_id, now_ms)?;
                return Ok(denied());
            }
            match detect_format(&stored) {
                PinFormat::LegacyV1 => {
                    if verify_legacy_sha256(&clean, &stored) {
                        record_success_for(&*store, &request.user_id)?;
                        let is_device_local = stored
                            .split('$')
                            .nth(1)
                            .map(|salt| salt.starts_with("local_"))
                            .unwrap_or(false);
                        Ok(PinVerifyResult {
                            ok: true,
                            locked: false,
                            locked_remaining_ms: 0,
                            must_rotate: !is_device_local,
                            // Legacy verified via SHA-256, so no modern KDF
                            // ran — but that is a migration outcome, not a
                            // missing backend.
                            kdf_unavailable: false,
                        })
                    } else {
                        record_failure_for(&*store, &request.user_id, now_ms)?;
                        Ok(denied())
                    }
                }
                PinFormat::ModernV2 => {
                    // Plaintext is wrapped so it is wiped on every exit path,
                    // including the failure path below.
                    let secret = SecretPin::new(clean.to_string());
                    if verify_argon2id(&secret, &stored) {
                        record_success_for(&*store, &request.user_id)?;
                        Ok(PinVerifyResult {
                            ok: true,
                            locked: false,
                            locked_remaining_ms: 0,
                            // A modern hash needs no rotation.
                            must_rotate: false,
                            kdf_unavailable: false,
                        })
                    } else {
                        // The PIN really was tested against the stored hash, so
                        // this attempt counts against the lockout ladder.
                        record_failure_for(&*store, &request.user_id, now_ms)?;
                        Ok(denied())
                    }
                }
                PinFormat::Unknown => {
                    // Fail closed WITHOUT recording a failure: nothing was
                    // actually tested, so burning a lockout slot would let a
                    // corrupt/unknown credential lock a real cashier out.
                    Ok(PinVerifyResult {
                        ok: false,
                        locked: false,
                        locked_remaining_ms: 0,
                        must_rotate: true,
                        kdf_unavailable: false,
                    })
                }
            }
        },
    )
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinLockoutQuery {
    pub user_id: String,
}

/// Read-only lockout query shape (F3): remaining time only, no PIN input,
/// no state change. Unknown users answer identically to known-unlocked ones
/// (`locked: false, remaining 0`) so the response never enumerates users.
/// Callers already learn the same remaining time from any `Locked`
/// `pin_verify` response — this getter adds no new information, only a
/// polling path that does not burn attempts (e.g. tech-recovery countdown).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinLockoutStatus {
    pub locked: bool,
    pub remaining_ms: u64,
}

/// `#[tauri::command]`: strictly read-only remaining-lockout query. Loads
/// the persisted lockout map and evaluates it — never records, never resets,
/// never verifies. Unknown `user_id` answers zeros (no enumeration).
#[tauri::command]
pub fn pin_lockout_remaining(
    app: tauri::AppHandle,
    request: PinLockoutQuery,
) -> Result<PinLockoutStatus, TrustError> {
    super::ipc_authorizer::authorize_and_execute(
        "pin_lockout_remaining",
        super::Capability::LicenseManagement,
        |_| {
            use tauri::Manager;
            let app_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| TrustError::op_failed(format!("app dir: {e}")))?;
            let (store, _) = super::ipc_authorizer::select_store(&app_dir);
            let now_ms = system_now_ms();
            let q = check_lockout(&*store, request.user_id.trim(), now_ms);
            Ok(PinLockoutStatus {
                locked: q.locked,
                remaining_ms: q.remaining_ms,
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
        kdf_unavailable: false,
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
    let mut modified = false;
    if let Some(lock) = map.get_mut(user_id) {
        record_success(lock);
        modified = true;
    }
    // Single-PIN contract: manager and usr-admin share credential identity
    let alias = if user_id == "manager" {
        Some("usr-admin")
    } else if user_id == "usr-admin" {
        Some("manager")
    } else {
        None
    };
    if let Some(alias_id) = alias {
        if let Some(lock) = map.get_mut(alias_id) {
            record_success(lock);
            modified = true;
        }
    }
    if modified {
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
        // Sieve-corrupted legacy vector (from early JS implementation)
        let sieve_stored = "v1$local_iNVyvGaBPze3$fe4269b3a0701d6baaab608ffd92faac5325beba3989c44f94ac9d79fb7db5f9";
        assert!(verify_legacy_sha256("303030", sieve_stored));
        assert!(!verify_legacy_sha256("303031", sieve_stored));
        assert!(!verify_legacy_sha256("", &stored));
        assert!(!verify_legacy_sha256("1234", ""));
        assert!(!verify_legacy_sha256("1234", "1234"));
        assert!(!verify_legacy_sha256("1234", "v1$abc"));
        assert!(!verify_legacy_sha256("1234", "v2$abc$def"));
        assert_eq!(detect_format(&stored), PinFormat::LegacyV1);
        // A truncated/malformed v2 credential is Unknown, not ModernV2: the
        // verify path must fail closed rather than treat it as unverifiable.
        assert_eq!(detect_format("v2$argon2id$v=19$m=x"), PinFormat::Unknown);
        assert_eq!(
            detect_format("v2$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA"),
            PinFormat::ModernV2
        );
        assert_eq!(
            detect_format("v2$argon2i$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA"),
            PinFormat::Unknown,
            "a non-argon2id algorithm must not classify as modern"
        );
        assert_eq!(detect_format("v2$argon2id$v=19$m=x$c2FsdA$aGFzaA"), PinFormat::Unknown);
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
    fn lockout_remaining_query_is_read_only_and_non_enumerating() {
        // F3: the getter evaluates persisted state and changes nothing.
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        let _g = serial_test_lock();
        let store = MemKeyStore::new();
        // Unknown user: zeros, indistinguishable from known-unlocked.
        let q = check_lockout(&store, "nobody", 99_000);
        assert!(!q.locked);
        assert_eq!(q.remaining_ms, 0);
        // Locked user: remaining time, and querying twice changes nothing
        // (no escalation, no extension, no reset).
        for _ in 0..5 {
            record_failure_for(&store, "manager", 10_000).unwrap();
        }
        let a = check_lockout(&store, "manager", 11_000);
        assert!(a.locked);
        assert_eq!(a.remaining_ms, 59_000);
        let b = check_lockout(&store, "manager", 11_000);
        assert_eq!((b.locked, b.remaining_ms), (a.locked, a.remaining_ms));
        // Known-unlocked answers exactly like unknown (no enumeration).
        record_success_for(&store, "manager").unwrap();
        let c = check_lockout(&store, "manager", 12_000);
        let d = check_lockout(&store, "nobody", 12_000);
        assert_eq!((c.locked, c.remaining_ms), (d.locked, d.remaining_ms));
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
    fn manager_gate_rejects_cashier_pin_and_burns_manager_lockout() {
        // FT-01 real-kernel proof: the journal gate always verifies with
        // `userId == "manager"`, so a cashier's own PIN is compared against
        // the MANAGER credential and rejected (unless byte-identical), and
        // each failure burns the NATIVE persisted lockout for "manager" —
        // never a JS-side counter.
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        use sha2::{Digest, Sha256};
        fn v1(pin: &str, salt: &str) -> String {
            let mut h = Sha256::new();
            h.update(format!("{salt}:{pin}:mobi_pos_salt_v1").as_bytes());
            let d: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
            format!("v1${salt}${d}")
        }
        let _g = serial_test_lock();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT);",
        )
        .unwrap();
        let manager_stored = v1("123456", "msalt");
        let cashier_stored = v1("654321", "csalt");
        conn.execute(
            "INSERT INTO app_settings (key, value_json) VALUES ('manager_pin', ?1)",
            [format!("\"{manager_stored}\"")],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value_json) VALUES ('cashier_users', ?1)",
            [format!("[{{\"id\":\"c1\",\"pin\":\"{cashier_stored}\"}}]")],
        )
        .unwrap();
        // Gate routing: userId 'manager' resolves to the manager credential.
        let (routed, is_mgr) = read_stored_credential(&conn, "manager").unwrap();
        assert!(is_mgr);
        assert_eq!(routed, manager_stored);
        // Cashier PIN does NOT verify against the manager credential...
        assert!(!verify_legacy_sha256("654321", &routed));
        // ...while the manager PIN does (non-vacuous: both hashes are live).
        assert!(verify_legacy_sha256("123456", &routed));
        let (c1stored, c1mgr) = read_stored_credential(&conn, "c1").unwrap();
        assert!(!c1mgr);
        assert!(verify_legacy_sha256("654321", &c1stored));
        // pin_verify records failures via record_failure_for(store, user_id)
        // with the gate's user_id 'manager' — the lockout below is the same
        // persisted keystore state pin_verify checks first.
        let store = MemKeyStore::new();
        for _ in 0..5 {
            record_failure_for(&store, "manager", 10_000).unwrap();
        }
        assert!(check_lockout(&store, "manager", 11_000).locked);
        // Per-profile isolation: the cashier profile is unaffected.
        assert!(!check_lockout(&store, "c1", 11_000).locked);
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
        // usr-admin aliases to manager.
        assert_eq!(read_stored_credential(&conn, "usr-admin").unwrap().0, "v1$salt$digest");
        // Cashier roster parsing; unknown id errors; empty pin errors.
        conn.execute(
            "INSERT INTO app_settings (key, value_json) VALUES ('cashier_users',
             '[{\"id\":\"c1\",\"pin\":\"v1$a$b\"},{\"id\":\"c2\",\"pin\":\"\"},{\"id\":\"c3\",\"role\":\"admin\",\"pin\":\"\"}]')",
            [],
        )
        .unwrap();
        let (c1, is_mgr) = read_stored_credential(&conn, "c1").unwrap();
        assert!(!is_mgr);
        assert_eq!(c1, "v1$a$b");
        assert!(read_stored_credential(&conn, "nobody").is_err());
        assert!(read_stored_credential(&conn, "c2").is_err());
// Admin with empty pin aliases to manager_pin.
      assert_eq!(read_stored_credential(&conn, "c3").unwrap().0, "v1$salt$digest");
      }

    // ---- Argon2id (Phase 4a) -------------------------------------------
    //
    // These run the real 64 MiB / t=3 KDF, so they are the slowest tests in
    // the crate by design: proving the credential actually verifies is worth
    // more than shaving seconds off `cargo test`. Each mint costs ~64 MiB, so
    // they share one credential where independence is not the point.

    /// Build a SecretPin the way production does, then hand it to the KDF.
    fn secret(pin: &str) -> SecretPin {
        SecretPin::new(pin.to_string())
    }

    #[test]
    fn argon2id_round_trips_and_rejects_wrong_pin() {
        let mint = secret("789012");
        let stored = mint_pin_hash(&mint).expect("mint");

        assert_eq!(detect_format(&stored), PinFormat::ModernV2);
        // Parameters are recorded in the credential so cost can be raised later.
        assert!(stored.contains(&format!("m={ARGON2_M_COST_KIB}")));
        assert!(stored.contains(&format!("t={ARGON2_T_COST}")));
        assert!(stored.contains(&format!("p={ARGON2_P_COST}")));

        assert!(verify_argon2id(&secret("789012"), &stored), "correct PIN must verify");
        assert!(!verify_argon2id(&secret("789013"), &stored), "wrong PIN must not verify");
        // Prefix of the right PIN must not pass.
        assert!(!verify_argon2id(&secret("78901"), &stored));
    }

    #[test]
    fn argon2id_mints_are_salted_so_identical_pins_differ() {
        let a = mint_pin_hash(&secret("1212")).unwrap();
        let b = mint_pin_hash(&secret("1212")).unwrap();
        assert_ne!(a, b, "two mints of the same PIN must not be byte-identical");
        // Both still verify — a differing salt must not break verification.
        assert!(verify_argon2id(&secret("1212"), &a));
        assert!(verify_argon2id(&secret("1212"), &b));
    }

    #[test]
    fn argon2id_verification_fails_closed_on_malformed_input() {
        let stored = mint_pin_hash(&secret("3434")).unwrap();
        // Every one of these is a uniform `false`: no oracle may distinguish
        // "wrong PIN" from "corrupt credential" from "wrong algorithm".
        for bad in [
            String::new(),
            "not-a-hash".to_string(),
            "v1$salt$digest".to_string(),
            "v2$$c2FsdA$aGFzaA".to_string(),
            "v2$argon2i$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA".to_string(),
            // Truncated hash body.
            stored.split('$').take(5).collect::<Vec<_>>().join("$"),
        ] {
            assert!(
                !verify_argon2id(&secret("3434"), &bad),
                "malformed credential must fail closed: {bad}"
            );
        }
    }

    #[test]
    fn argon2id_honours_stored_params_not_todays_defaults() {
        // A credential minted at a deliberately cheap cost must still verify
        // after the app raises its defaults — otherwise a cost increase would
        // lock every existing cashier out.
        use argon2::password_hash::{PasswordHasher, SaltString, rand_core::OsRng};
        use argon2::{Algorithm, Argon2, Params, Version};
        let weak = Params::new(8, 1, 1, None::<usize>).unwrap();
        let hasher = Argon2::new(Algorithm::Argon2id, Version::V0x13, weak);
        let raw = hasher
            .hash_password(b"1212", &SaltString::generate(&mut OsRng))
            .unwrap()
            .to_string();
        let stored = format!("v2${}", raw.trim_start_matches('$'));

        assert_eq!(detect_format(&stored), PinFormat::ModernV2);
        assert!(
            verify_argon2id(&secret("1212"), &stored),
            "verification must use the parameters recorded with the hash"
        );
        assert!(!verify_argon2id(&secret("9999"), &stored));
    }

    #[test]
    fn legacy_and_modern_credentials_are_not_cross_verifiable() {
        let modern = mint_pin_hash(&secret("1212")).unwrap();
        // A modern hash must never satisfy the legacy comparator, and a legacy
        // digest must never satisfy the modern one.
        assert!(!verify_legacy_sha256("1212", &modern));
        assert!(!verify_argon2id(&secret("1212"), "v1$abc$def"));
    }
  }

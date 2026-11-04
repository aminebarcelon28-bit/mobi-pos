//! Phase TIER-B — native per-device cryptographic identity.
//!
//! Closes the `local_device_id` IPC trust residual: the WebView asserted a
//! device id string and native code believed it. Now each terminal owns an
//! Ed25519 keypair whose seed NEVER leaves native memory (and never crosses
//! IPC — only the id + public key are exposed). Native commands derive the
//! device id from this keystore and sign sync mutations at commit time, so
//! the backend can prove which physical terminal authorized a payout.
//!
//! Identity ADOPTION (not derivation): the canonical id is the existing
//! `sync.device_id` authorship value already stamped on every row this
//! device wrote. Deriving a fresh `dev_<hash>` id would orphan all existing
//! authorship (affinity, tiebreaks, claims) — the keypair is instead
//! ENROLLED against the adopted id, one row per id, old rows kept forever
//! so historic signatures stay verifiable.
//!
//! At rest (mirrors the PIN-pepper pattern in `pin.rs`):
//! - wrapping key: 32 random bytes in the OS keyring (desktop,
//!   `mobi-pos-device`/`wrap-key-v1`) or the device vault file (mobile,
//!   same accepted weakness as the trust vault). Never in the DB, never
//!   synced, never logged.
//! - seed: ChaCha20-Poly1305 sealed (random 12-byte nonce per enrollment,
//!   stored `nonce||ciphertext`) in the isolated `device_identity` table.
//!   Core ledger tables are untouched.
//!
//! In memory: only the 32-byte seed is retained, inside
//! `zeroize::Zeroizing` (signing keys are constructed per call —
//! microseconds — so no expanded key material lingers). Corrupt-but-present
//! material fails closed and NEVER re-provisions over itself (same rule as
//! the pepper: undecodable present value = corruption, transient).
//!
//! Concurrency: no shared mutable state — every command opens its own
//! connection and enrollment converges via `INSERT OR IGNORE` + re-read, so
//! simultaneous invokes cannot corrupt or fork the keystore.

use super::ipc_authorizer::TrustError;
use ed25519_dalek::{Signer, Verifier};
use rusqlite::{params, Connection};
use serde::Serialize;
use zeroize::Zeroizing;

const WRAP_SERVICE: &str = "mobi-pos-device";
const WRAP_ACCOUNT: &str = "wrap-key-v1";
#[allow(dead_code)] // live on mobile cfg; desktop uses the OS keyring path above
const WRAP_VAULT_FILE: &str = ".device_wrap.vault";

/// Supervisor authorization freshness window: approvals older than this are
/// replayed/stale evidence, not live authorization.
pub const SUPERVISOR_AUTH_MAX_AGE_MS: i64 = 120_000;
/// Forward-dated approvals beyond this tolerance are not fast supervisors —
/// they are forged or clock-skewed evidence. Distinct code from anchor-level
/// rollback (`SYSTEM_CLOCK_REGRESSION`): this is about the APPROVAL, not the
/// host clock (which the anchor judges separately against its high-water).
pub const SUPERVISOR_AUTH_FUTURE_TOLERANCE_MS: i64 = 30_000;

/// Public credentials: the ONLY identity material that may cross IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCredentialsDto {
    pub device_id: String,
    pub public_key_hex: String,
}

/// Native device identity: id + public key + zeroized seed. The seed never
/// leaves this struct; nothing here is `Serialize`.
pub struct DeviceIdentity {
    device_id: String,
    public_key_hex: String,
    seed: Zeroizing<[u8; 32]>,
}

impl DeviceIdentity {
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn public_credentials(&self) -> DeviceCredentialsDto {
        DeviceCredentialsDto {
            device_id: self.device_id.clone(),
            public_key_hex: self.public_key_hex.clone(),
        }
    }

    /// Sign an arbitrary message (Ed25519, hex signature). The signing key
    /// is expanded per call from the zeroized seed and dropped on return.
    pub fn sign_payload(&self, message: &[u8]) -> Result<String, TrustError> {
        let signing = ed25519_dalek::SigningKey::from_bytes(&self.seed);
        Ok(hex_encode(&signing.sign(message).to_bytes()))
    }
}

/// Verify a hex signature against a hex public key (backend parity + tests).
pub fn verify_signature(
    public_key_hex: &str,
    message: &[u8],
    signature_hex: &str,
) -> Result<(), TrustError> {
    use ed25519_dalek::{Signature, VerifyingKey};
    let pk = hex_decode(public_key_hex).map_err(|_| {
        TrustError::op_failed("DEVICE_SIGNATURE_FAILED:bad public key".to_string())
    })?;
    let sig = hex_decode(signature_hex).map_err(|_| {
        TrustError::op_failed("DEVICE_SIGNATURE_FAILED:bad signature".to_string())
    })?;
    if pk.len() != ed25519_dalek::PUBLIC_KEY_LENGTH || sig.len() != ed25519_dalek::SIGNATURE_LENGTH {
        return Err(TrustError::op_failed(
            "DEVICE_SIGNATURE_FAILED:bad key/signature length".to_string(),
        ));
    }
    let mut pk_bytes = [0u8; ed25519_dalek::PUBLIC_KEY_LENGTH];
    pk_bytes.copy_from_slice(&pk);
    let mut sig_bytes = [0u8; ed25519_dalek::SIGNATURE_LENGTH];
    sig_bytes.copy_from_slice(&sig);
    let key = VerifyingKey::from_bytes(&pk_bytes)
        .map_err(|_| TrustError::op_failed("DEVICE_SIGNATURE_FAILED:bad public key".to_string()))?;
    let signature = Signature::from_bytes(&sig_bytes);
    key.verify(message, &signature).map_err(|_| {
        TrustError::op_failed("DEVICE_SIGNATURE_FAILED:verify".to_string())
    })
}

/// Deterministic refund envelope v3: positional `|`-joined bytes, integers
/// as decimal, no JSON, no floats — the exact bytes the backend re-verifies.
/// `seq_no` is the per-device monotonic outbox counter (kills replay +
/// reordering at the gateway); `verified_ms` is the supervisor approval
/// instant, or 0 when no supervisor block rode the refund.
pub fn refund_envelope(
    ticket_id: &str,
    refund_id: &str,
    net_dzd: i64,
    device_id: &str,
    seq_no: i64,
    verified_ms: i64,
) -> Vec<u8> {
    format!("{ticket_id}|{refund_id}|{net_dzd}|{device_id}|{seq_no}|{verified_ms}").into_bytes()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(s: &str) -> Result<Vec<u8>, ()> {
    let s = s.trim();
    if !s.len().is_multiple_of(2) {
        return Err(());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| ()))
        .collect()
}

// ---------------------------------------------------------------------------
// Wrap key (follows the PIN-pepper load/store discipline)
// ---------------------------------------------------------------------------

enum WrapLoad {
    Present(Zeroizing<[u8; 32]>),
    Absent,
    Unavailable(TrustError),
}

fn decode_wrap(s: &str) -> Result<Zeroizing<[u8; 32]>, TrustError> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let raw = URL_SAFE_NO_PAD.decode(s.trim()).map_err(|_| {
        TrustError::op_failed("DEVICE_NOT_INITIALIZED:keystore_corrupt".to_string())
    })?;
    if raw.len() != 32 {
        return Err(TrustError::op_failed(
            "DEVICE_NOT_INITIALIZED:keystore_corrupt".to_string(),
        ));
    }
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(&raw);
    Ok(out)
}

#[cfg_attr(
    not(any(target_os = "android", target_os = "ios")),
    allow(unused_variables)
)]
fn load_wrap_key(app_data_dir: &std::path::Path) -> WrapLoad {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        match keyring::Entry::new(WRAP_SERVICE, WRAP_ACCOUNT) {
            Ok(entry) => match entry.get_password() {
                Ok(secret) => match decode_wrap(&secret) {
                    Ok(k) => WrapLoad::Present(k),
                    Err(e) => WrapLoad::Unavailable(e),
                },
                Err(keyring::Error::NoEntry) => WrapLoad::Absent,
                Err(e) => WrapLoad::Unavailable(TrustError::op_failed(format!(
                    "DEVICE_NOT_INITIALIZED:keystore_unavailable:{e}"
                ))),
            },
            Err(e) => WrapLoad::Unavailable(TrustError::op_failed(format!(
                "DEVICE_NOT_INITIALIZED:keystore_unavailable:{e}"
            ))),
        }
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        match std::fs::read_to_string(app_data_dir.join(WRAP_VAULT_FILE)) {
            Ok(secret) => match decode_wrap(&secret) {
                Ok(k) => WrapLoad::Present(k),
                Err(e) => WrapLoad::Unavailable(e),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => WrapLoad::Absent,
            Err(e) => WrapLoad::Unavailable(TrustError::op_failed(format!(
                "DEVICE_NOT_INITIALIZED:vault_unreadable:{e}"
            ))),
        }
    }
}

#[cfg_attr(
    not(any(target_os = "android", target_os = "ios")),
    allow(unused_variables)
)]
fn store_wrap_key(app_data_dir: &std::path::Path, key: &[u8; 32]) -> Result<(), TrustError> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let encoded = URL_SAFE_NO_PAD.encode(key);
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let entry = keyring::Entry::new(WRAP_SERVICE, WRAP_ACCOUNT).map_err(|e| {
            TrustError::op_failed(format!("DEVICE_NOT_INITIALIZED:keystore_store:{e}"))
        })?;
        entry.set_password(&encoded).map_err(|e| {
            TrustError::op_failed(format!("DEVICE_NOT_INITIALIZED:keystore_store:{e}"))
        })?;
        Ok(())
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        std::fs::write(app_data_dir.join(WRAP_VAULT_FILE), &encoded).map_err(|e| {
            TrustError::op_failed(format!("DEVICE_NOT_INITIALIZED:vault_store:{e}"))
        })?;
        Ok(())
    }
}

fn random_32() -> Result<[u8; 32], TrustError> {
    let mut out = [0u8; 32];
    getrandom::fill(&mut out)
        .map_err(|e| TrustError::op_failed(format!("DEVICE_NOT_INITIALIZED:entropy:{e}")))?;
    Ok(out)
}

fn seal_seed(wrap: &[u8; 32], seed: &[u8; 32]) -> Result<Vec<u8>, TrustError> {
    use chacha20poly1305::{aead::{Aead, KeyInit}, ChaCha20Poly1305, Nonce};
    let nonce_bytes = random_32()?;
    let cipher = ChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(wrap));
    let nonce = Nonce::from_slice(&nonce_bytes[..12]);
    let ct = cipher
        .encrypt(nonce, seed.as_slice())
        .map_err(|e| TrustError::op_failed(format!("DEVICE_NOT_INITIALIZED:seal:{e}")))?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&nonce_bytes[..12]);
    out.extend_from_slice(&ct);
    Ok(out)
}

fn open_seed(wrap: &[u8; 32], blob: &[u8]) -> Result<Zeroizing<[u8; 32]>, TrustError> {
    use chacha20poly1305::{aead::{Aead, KeyInit}, ChaCha20Poly1305, Nonce};
    let corrupt = || TrustError::op_failed("DEVICE_NOT_INITIALIZED:keystore_corrupt".to_string());
    if blob.len() != 12 + 32 + 16 {
        return Err(corrupt());
    }
    let cipher = ChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(wrap));
    let pt = cipher
        .decrypt(Nonce::from_slice(&blob[..12]), &blob[12..])
        .map_err(|_| corrupt())?;
    if pt.len() != 32 {
        return Err(corrupt());
    }
    let mut seed = Zeroizing::new([0u8; 32]);
    seed.copy_from_slice(&pt);
    Ok(seed)
}

// ---------------------------------------------------------------------------
// Enrollment + loading (isolated table; core ledger untouched)
// ---------------------------------------------------------------------------

const IDENTITY_DDL: &str = "
CREATE TABLE IF NOT EXISTS device_identity (
    device_id TEXT PRIMARY KEY,
    public_key_hex TEXT NOT NULL,
    private_key_enc BLOB NOT NULL,
    enrolled_at TEXT NOT NULL,
    status TEXT NOT NULL,
    last_outbox_seq INTEGER NOT NULL DEFAULT 0
);";

/// Ensure the native-owned identity table exists. Called before the schema
/// migration so its golden-manifest post-condition can see every native table
/// the manifest lists (a fresh install starts empty).
pub fn ensure_schema(conn: &Connection) -> Result<(), TrustError> {
    conn.execute_batch(IDENTITY_DDL)
        .map_err(|e| TrustError::op_failed(format!("device identity table: {e}")))?;
    ensure_seq_column(conn)
}

/// Idempotent sequence-counter column for pre-DDL rows (fresh CREATEs carry
/// it; upgraded rows gain it here — duplicate-tolerant by probe, since bare
/// ALTER fails when the column exists).
fn ensure_seq_column(conn: &Connection) -> Result<(), TrustError> {
    // Probe-then-ALTER still races concurrent first-use enrollments (both
    // probe absent, both ALTER, one loses) — so a lost race on the exact
    // "duplicate column" error converges instead of failing: re-probe, and
    // only real errors propagate.
    let missing = || -> bool {
        conn.prepare("SELECT name FROM pragma_table_info('device_identity') WHERE name = 'last_outbox_seq'")
            .and_then(|mut s| {
                let mut rows = s.query([])?;
                Ok(rows.next()?.is_none())
            })
            .unwrap_or(false)
    };
    if missing() {
        match conn.execute(
            "ALTER TABLE device_identity ADD COLUMN last_outbox_seq INTEGER NOT NULL DEFAULT 0",
            [],
        ) {
            Ok(_) => {}
            Err(e) if format!("{e}").contains("duplicate column name") => {}
            Err(e) => {
                return Err(TrustError::op_failed(format!(
                    "DEVICE_NOT_INITIALIZED:seqcol:{e}"
                )))
            }
        }
    }
    Ok(())
}

/// Adopted authorship id (`sync.device_id`): absent means this database has
/// never booted through the TS layer, so no row could name it — fail closed.
/// Shared with the outbox drain (signed rows are dispatched per adopted id).
pub(crate) fn adopted_device_id(conn: &Connection) -> Result<String, TrustError> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = 'sync.device_id'",
            [],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    let id = raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v.as_str().map(str::to_string))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    id.ok_or_else(|| {
        TrustError::op_failed("DEVICE_NOT_INITIALIZED:keystore_empty".to_string())
    })
}

/// Load (or enroll) this terminal's identity. Concurrent invokes converge:
/// `INSERT OR IGNORE` + re-read means exactly one keypair wins per id.
pub fn ensure_loaded(
    conn: &Connection,
    app_data_dir: &std::path::Path,
) -> Result<DeviceIdentity, TrustError> {
    conn.execute_batch(IDENTITY_DDL)
        .map_err(|e| TrustError::op_failed(format!("DEVICE_NOT_INITIALIZED:ddl:{e}")))?;
    let device_id = adopted_device_id(conn)?;
    // Enroll: fresh seed, sealed under the wrap key.
    let wrap = match load_wrap_key(app_data_dir) {
        WrapLoad::Present(k) => k,
        WrapLoad::Absent => {
            let fresh = random_32()?;
            store_wrap_key(app_data_dir, &fresh)?;
            match load_wrap_key(app_data_dir) {
                WrapLoad::Present(k) => k,
                WrapLoad::Absent => {
                    return Err(TrustError::op_failed(
                        "DEVICE_NOT_INITIALIZED:keystore_store".to_string(),
                    ))
                }
                WrapLoad::Unavailable(e) => return Err(e),
            }
        }
        WrapLoad::Unavailable(e) => return Err(e),
    };
    ensure_enrolled(conn, &device_id, &wrap)
}

/// Enroll-or-load for an explicit id under an explicit wrap key. The command
/// path always goes through [`ensure_loaded`] (wrap from the OS keyring /
/// vault); tests pass an injected wrap so they never touch real keychains.
pub fn ensure_enrolled(
    conn: &Connection,
    device_id: &str,
    wrap: &Zeroizing<[u8; 32]>,
) -> Result<DeviceIdentity, TrustError> {
    conn.execute_batch(IDENTITY_DDL)
        .map_err(|e| TrustError::op_failed(format!("DEVICE_NOT_INITIALIZED:ddl:{e}")))?;
    ensure_seq_column(conn)?;
    if let Some(identity) = load_row(conn, device_id, wrap)? {
        return Ok(identity);
    }
    let seed_bytes = random_32()?;
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed_bytes);
    let public_key_hex = hex_encode(&signing.verifying_key().to_bytes());
    let sealed = seal_seed(wrap, &seed_bytes)?;
    let now = super::audit_append::chrono_iso8601_utc();
    // Lost race = another invoke enrolled first: re-read, never overwrite.
    conn.execute(
        "INSERT OR IGNORE INTO device_identity (device_id, public_key_hex, private_key_enc, enrolled_at, status) \
         VALUES (?1, ?2, ?3, ?4, 'active')",
        params![device_id, public_key_hex, sealed, now],
    )
    .map_err(|e| TrustError::op_failed(format!("DEVICE_NOT_INITIALIZED:enroll:{e}")))?;
    load_row(conn, device_id, wrap)?.ok_or_else(|| {
        TrustError::op_failed("DEVICE_NOT_INITIALIZED:enroll_read".to_string())
    })
}

fn load_row(
    conn: &Connection,
    device_id: &str,
    wrap: &Zeroizing<[u8; 32]>,
) -> Result<Option<DeviceIdentity>, TrustError> {
    let row: Option<(String, Vec<u8>)> = conn
        .query_row(
            "SELECT public_key_hex, private_key_enc FROM device_identity WHERE device_id = ?1",
            [device_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(TrustError::op_failed(format!("DEVICE_NOT_INITIALIZED:read:{other}"))),
        })?;
    let Some((public_key_hex, sealed)) = row else {
        return Ok(None);
    };
    let seed = open_seed(wrap, &sealed)?;
    // Integrity tripwire: the sealed seed must reproduce the stored pubkey —
    // a swapped row (or wrong wrap key) fails here, never silently.
    let check = ed25519_dalek::SigningKey::from_bytes(&seed);
    if hex_encode(&check.verifying_key().to_bytes()) != public_key_hex.to_lowercase() {
        return Err(TrustError::op_failed(
            "DEVICE_NOT_INITIALIZED:keystore_corrupt".to_string(),
        ));
    }
    Ok(Some(DeviceIdentity {
        device_id: device_id.to_string(),
        public_key_hex: public_key_hex.to_lowercase(),
        seed,
    }))
}

// ---------------------------------------------------------------------------
// ISO-8601 UTC millis parsing (no chrono dep): strict
// `YYYY-MM-DDTHH:MM:SS[.fff]Z` → epoch ms. Rejects anything else —
// supervisor freshness must never rest on a guessed timestamp.
// ---------------------------------------------------------------------------

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Strict `now` provider is injectable so tests prove the boundaries without
/// sleeping or touching the clock.
pub fn parse_iso_utc_ms(s: &str) -> Result<i64, TrustError> {
    let bad = || TrustError::op_failed("SUPERVISOR_PIN_REQUIRED:bad_timestamp".to_string());
    let s = s.trim();
    if !s.ends_with('Z') || s.len() < 20 {
        return Err(bad());
    }
    let num = |a: usize, b: usize| {
        s.get(a..b)
            .and_then(|t| t.parse::<i64>().ok())
            .ok_or_else(bad)
    };
    if s.as_bytes()[4] != b'-' || s.as_bytes()[7] != b'-' || s.as_bytes()[10] != b'T'
        || s.as_bytes()[13] != b':' || s.as_bytes()[16] != b':'
    {
        return Err(bad());
    }
    let (y, mo, d, h, mi, sec) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return Err(bad());
    }
    let mut ms = 0i64;
    let mut rest = &s[19..s.len() - 1];
    if let Some(frac) = rest.strip_prefix('.') {
        if frac.is_empty() || frac.len() > 3 || !frac.bytes().all(|b| b.is_ascii_digit()) {
            return Err(bad());
        }
        let scale = [100, 10, 1][frac.len() - 1];
        ms = frac.parse::<i64>().map_err(|_| bad())? * scale;
        rest = "";
    }
    if !rest.is_empty() {
        return Err(bad());
    }
    Ok((days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec) * 1000 + ms)
}

/// Supervisor freshness verdict against an injected `now_ms` (tests) — the
/// command passes the real clock. Stale → EXPIRED; future past tolerance →
/// clock regression (fail closed both directions; a backwards jump only ever
/// makes approvals look OLDER, i.e. safely rejected).
pub fn check_supervisor_freshness(verified_at: &str, now_ms: i64) -> Result<(), TrustError> {
    let seen = parse_iso_utc_ms(verified_at).map_err(|_| {
        TrustError::op_failed("SUPERVISOR_PIN_REQUIRED:bad_timestamp".to_string())
    })?;
    if seen - now_ms > SUPERVISOR_AUTH_FUTURE_TOLERANCE_MS {
        return Err(TrustError::op_failed(format!(
            "SUPERVISOR_AUTH_FUTURE_DATED:verified_{verified_at}_now_{now_ms}"
        )));
    }
    if now_ms - seen > SUPERVISOR_AUTH_MAX_AGE_MS {
        return Err(TrustError::op_failed(format!(
            "SUPERVISOR_AUTH_EXPIRED:verified_at_{verified_at}_current_ms_{now_ms}"
        )));
    }
    Ok(())
}

/// Real-clock wrapper for command use.
pub fn check_supervisor_freshness_now(verified_at: &str) -> Result<(), TrustError> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .map_err(|_| TrustError::op_failed("SUPERVISOR_PIN_REQUIRED:clock".to_string()))?;
    check_supervisor_freshness(verified_at, now_ms)
}

/// `#[tauri::command]`: public device credentials for the boot handshake.
/// Returns ONLY the id + public key — the seed never crosses IPC (nothing
/// here serializes it; the struct cannot even express it).
#[tauri::command]
pub fn get_device_identity_info(
    app: tauri::AppHandle,
) -> Result<DeviceCredentialsDto, super::ipc_authorizer::TrustError> {
    super::ipc_authorizer::authorize_and_execute(
        "get_device_identity_info",
        super::Capability::OperationalWrites,
        |_| {
            use tauri::Manager;
            let app_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| super::ipc_authorizer::TrustError::op_failed(format!("app dir: {e}")))?;
            let path = crate::e2e::live_db_path(&app_dir);
            let conn = rusqlite::Connection::open(&path).map_err(|e| {
                super::ipc_authorizer::TrustError::op_failed(format!("identity open: {e}"))
            })?;
            conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| {
                super::ipc_authorizer::TrustError::op_failed(format!("identity wal: {e}"))
            })?;
            conn.busy_timeout(std::time::Duration::from_millis(5000))
                .map_err(|e| {
                    super::ipc_authorizer::TrustError::op_failed(format!(
                        "identity busy_timeout: {e}"
                    ))
                })?;
            Ok(ensure_loaded(&conn, &app_dir)?.public_credentials())
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_identity_generation_and_determinism() {
        // Memory-shape proof: a fixed seed always derives the same pubkey,
        // signatures verify, and tampered bytes do not.
        let seed = [7u8; 32];
        let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
        let pk_hex = hex_encode(&signing.verifying_key().to_bytes());
        assert_eq!(pk_hex.len(), 64);
        let signing2 = ed25519_dalek::SigningKey::from_bytes(&seed);
        assert_eq!(hex_encode(&signing2.verifying_key().to_bytes()), pk_hex);
        let msg = b"TKT-1|REF-ABC|150|dev-x|2026-01-02T00:00:00.000Z";
        let sig = hex_encode(&signing.sign(msg).to_bytes());
        assert!(verify_signature(&pk_hex, msg, &sig).is_ok());
        let mut bad = msg.to_vec();
        bad[0] ^= 1;
        assert!(verify_signature(&pk_hex, &bad, &sig).is_err());
    }

    #[test]
    fn iso_parser_accepts_canonical_rejects_garbage() {
        assert_eq!(parse_iso_utc_ms("1970-01-01T00:00:00.000Z").unwrap(), 0);
        assert_eq!(parse_iso_utc_ms("1970-01-01T00:00:01Z").unwrap(), 1000);
        assert_eq!(parse_iso_utc_ms("2026-01-02T00:01:00.5Z").unwrap(), 1767312060500);
        for bad in ["", "yesterday", "2026-13-01T00:00:00Z", "2026-01-02 00:00:00", "2026-01-02T00:00:00", "2026-01-02T00:00:00.1234Z", "2026-01-02T00:00:00.Z"] {
            assert!(parse_iso_utc_ms(bad).is_err(), "{bad} must reject");
        }
    }

    #[test]
    fn supervisor_freshness_boundaries() {
        let now = 1_767_312_600_000i64; // 2026-01-02T00:10:00.000Z
        assert!(check_supervisor_freshness("2026-01-02T00:09:00.000Z", now).is_ok());
        assert!(check_supervisor_freshness("2026-01-02T00:10:00.000Z", now).is_ok());
        let stale = check_supervisor_freshness("2026-01-02T00:07:59.000Z", now).expect_err("stale");
        assert!(format!("{stale:?}").contains("SUPERVISOR_AUTH_EXPIRED"));
        // 45 s ahead: forged-or-skewed, distinct from anchor rollback.
        let future = check_supervisor_freshness("2026-01-02T00:10:45.000Z", now).expect_err("future");
        assert!(format!("{future:?}").contains("SUPERVISOR_AUTH_FUTURE_DATED"));
        // Exact boundaries still authorize (fail-closed only past them).
        assert!(check_supervisor_freshness("2026-01-02T00:08:00.000Z", now).is_ok());
        assert!(check_supervisor_freshness("2026-01-02T00:10:30.000Z", now).is_ok());
    }

    #[test]
    fn seal_open_roundtrip_and_tamper() {
        let wrap = [3u8; 32];
        let seed = [9u8; 32];
        let blob = seal_seed(&wrap, &seed).unwrap();
        assert_eq!(blob.len(), 12 + 32 + 16);
        let back = open_seed(&wrap, &blob).unwrap();
        assert_eq!(&back[..], &seed[..]);
        let mut bad = blob.clone();
        bad[20] ^= 1;
        assert!(open_seed(&wrap, &bad).is_err());
        assert!(open_seed(&[4u8; 32], &blob).is_err());
        assert!(open_seed(&wrap, &blob[..10]).is_err());
    }
}

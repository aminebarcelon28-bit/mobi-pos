//! Phase 2 — authenticated persisted trust snapshot, v2 (B.4 hardened).
//!
//! # Layout
//! One snapshot file carries license state, generation, rollback counter,
//! and trusted-time fields, bound by a single MAC. A platform keystore holds
//! a copy of the MAC key and of the counter (the "second place").
//!
//! # Crash-safe write order (no false tamper on power loss)
//! `persist_trust_snapshot` writes the snapshot file FIRST — temp file,
//! `sync_all` (fsync), atomic rename — with counter N+1, and only then
//! updates the keystore counter to N+1. A crash between the two writes
//! leaves file(N+1) vs keystore(N): on load this is ACCEPTED and the
//! keystore is healed forward. Only file(N) vs keystore(M>N) is rollback.
//! A torn write is impossible: rename is atomic, so readers see the old
//! consistent file or the new one, never a mix. (Directory fsync is
//! best-effort on Unix and skipped on Windows; an NTFS rename loss falls
//! back to the old consistent file — the safe direction.)
//!
//! # Load rules (fail closed)
//! - No file + no keystore counter → `FreshInstall` (genuine first boot).
//! - File present + keystore counter missing/unreadable → `QuarantineTamper`
//!   (never a silent fresh counter — an attacker or reinstall wiping one
//!   store does not reset rollback protection).
//! - No file + keystore counter present → `QuarantineTamper` (deletion).
//! - v1 file + any keyring counter → `QuarantineTamper(DowngradeV1)`: once v2
//!   exists there is no downgrade path. v1 + no counter → legacy-MAC verify
//!   → one-time `MigratedV1` (re-sealed to v2 immediately).
//! - v2 MAC failure / malformed / unknown code or version → `Corrupt`.
//! - v2 counter < keystore counter → `QuarantineTamper(CounterRollback)`.
//! - v2 counter > keystore counter → accepted, keystore healed forward.
//!
//! # MAC key homes — Amendment A1 (stated, not hidden)
//! - Desktop release: 32 B random generated at first persist, stored in the
//!   OS keyring (`mobi-pos-trust/mac-key-v2`). The `MOBI_LICENSE_MAC_KEY`
//!   environment override exists ONLY under `cfg(debug_assertions)` — release
//!   binaries contain no env-read path at all (proven by release-profile
//!   test). No compiled fallback key in release.
//! - Legacy v1 files were MAC'd with the Phase 1 compiled fallback. Release
//!   keeps `LEGACY_V1_FALLBACK_KEY` SOLELY to verify a v1 snapshot during
//!   one-time migration; it can never seal anything, and post-v2 v1 files
//!   are rejected before any MAC check.
//! - Fresh desktop install with an unreadable keyring (no Secret Service,
//!   profile reset): file-backed provisional key + loud stderr warning,
//!   reported as degraded. Rationale: no prior state exists, so nothing can
//!   be rolled back; a provisional key still binds future snapshots against
//!   single-file tamper. Non-fresh + unreadable keyring → quarantine.
//! - Mobile: no Keystore/Keychain bridge exists in this codebase (the
//!   `keyring` crate has no Android/iOS backend), so mobile uses a second
//!   vault file (`FileKeyStore`). Same-FS storage does NOT split security
//!   domains — mobile rollback resistance is best-effort (`server_seq`
//!   monotonicity + in-process high-water) and is a flagged residual until a
//!   Keystore/Keychain bridge lands (out of scope).
//!
//! # Fresh-install entitlement (no free grace)
//! A wiped machine resolves `FreshInstall` → kernel `UNACTIVATED`. Activation
//! mints no entitlement: `trust_sync_license` maps a signature-verified token
//! to OPERATIONAL/EXPIRED strictly from token `exp`/binding. Wiping state
//! cannot extend or renew anything (covered by test).

use super::license_state::LicenseState;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const SNAPSHOT_VERSION_V2: u32 = 2;
const SNAPSHOT_FILE_NAME: &str = ".license_state.vault";
const LEGACY_V1_VERSION: u32 = 1;

/// Legacy Phase 1 fallback key. Migration-verification ONLY: it can confirm
/// a pre-v2 snapshot exactly once, never seal new state, and never bypass
/// the downgrade rule.
const LEGACY_V1_FALLBACK_KEY: &str = "mobi-pos-phase1-dev-mac-key-NOT-FOR-PRODUCTION";

pub fn snapshot_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(SNAPSHOT_FILE_NAME)
}

// ---------------------------------------------------------------------------
// Key/counter store seam
// ---------------------------------------------------------------------------

/// Keystore failures. `NotFound` (absent entry) is distinct from
/// `Unavailable` (backend error) — only genuine absence on a fresh machine
/// may provision; anything else fails closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    NotFound,
    Unavailable(String),
}

/// Second place for the MAC key and rollback counter. Desktop production =
/// OS keyring; mobile = second vault file (weak, documented); tests = memory.
pub trait KeyStore: Send + Sync {
    fn load_mac_key(&self) -> Result<Option<Vec<u8>>, StoreError>;
    fn store_mac_key(&self, key: &[u8]) -> Result<(), StoreError>;
    fn load_counter(&self) -> Result<Option<u64>, StoreError>;
    fn store_counter(&self, counter: u64) -> Result<(), StoreError>;
    /// Audit-chain head (Phase 4.5): truncation detection anchor.
    fn load_audit_head(&self) -> Result<Option<AuditHead>, StoreError>;
    fn store_audit_head(&self, head: &AuditHead) -> Result<(), StoreError>;
    /// PIN lockout map (Phase 4.5): JSON object user_id -> UserLockout.
    /// Absent entry means no lockout history (fresh), never an error.
    fn load_pin_lockouts(&self) -> Result<Option<String>, StoreError>;
    fn store_pin_lockouts(&self, json: &str) -> Result<(), StoreError>;
    /// Human-readable backend name for diagnostics (never key material).
    fn backend_name(&self) -> &'static str;
}

/// Audit-chain head: sequence (= chain-row count), terminal hash, and a MAC
/// binding both (forged heads fail closed).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AuditHead {
    pub seq: u64,
    pub hash: String,
    pub mac: String,
}

/// Desktop OS-keyring backend (`mobi-pos-trust` service).
///
/// # Test isolation — why this guard exists
///
/// `OsKeyStore` reaches the REAL Windows Credential Manager, which is
/// per-user, persistent, and shared with every other process running as this
/// Windows account. A test that constructed it would read or — worse —
/// overwrite production trust material (`mac-key-v2`, `counter-v2`,
/// `audit-head-v1`), and doing so is irreversible from the test's point of
/// view: the kernel would then see a missing key with a prior snapshot on
/// disk, which is reported as TAMPER_SUSPECTED by design.
///
/// Therefore every call into the platform backend is gated. Under
/// `cfg(test)` this panics with an explicit message rather than touching the
/// real keyring; unit tests use `MemKeyStore` or `FileKeyStore` against a
/// temp dir instead. `MOBI_ALLOW_OS_KEYSTORE_IN_TESTS=1` is deliberately NOT
/// honoured — there is no escape hatch, because an escape hatch is exactly
/// how production trust material gets destroyed by a test run.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub struct OsKeyStore;

/// Compile-time test isolation gate for the real OS keyring.
#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
fn assert_not_in_unit_tests(operation: &str) {
    panic!(
        "trust_core: unit test attempted {operation} on the REAL OS keyring \
         (service 'mobi-pos-trust'). This is production trust material and \
         must never be touched by `cargo test`. Use MemKeyStore, or \
         FileKeyStore::new(<temp dir>), in tests."
    );
}

/// Production no-op counterpart of the test gate.
#[cfg(not(all(test, not(any(target_os = "android", target_os = "ios")))))]
fn assert_not_in_unit_tests(_operation: &str) {}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl KeyStore for OsKeyStore {
    fn load_mac_key(&self) -> Result<Option<Vec<u8>>, StoreError> {
        assert_not_in_unit_tests("load_mac_key");
        let entry = keyring::Entry::new("mobi-pos-trust", "mac-key-v2")
            .map_err(|e| StoreError::Unavailable(format!("keyring entry: {e}")))?;
        match entry.get_password() {
            Ok(s) => {
                if s.trim().is_empty() {
                    return Ok(None);
                }
                URL_SAFE_NO_PAD
                    .decode(s.trim())
                    .map(Some)
                    .map_err(|e| StoreError::Unavailable(format!("key decode: {e}")))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(StoreError::Unavailable(format!("keyring read: {e}"))),
        }
    }

    fn store_mac_key(&self, key: &[u8]) -> Result<(), StoreError> {
        assert_not_in_unit_tests("store_mac_key");
        let entry = keyring::Entry::new("mobi-pos-trust", "mac-key-v2")
            .map_err(|e| StoreError::Unavailable(format!("keyring entry: {e}")))?;
        entry
            .set_password(&URL_SAFE_NO_PAD.encode(key))
            .map_err(|e| StoreError::Unavailable(format!("keyring write: {e}")))
    }

    fn load_counter(&self) -> Result<Option<u64>, StoreError> {
        assert_not_in_unit_tests("load_counter");
        let entry = keyring::Entry::new("mobi-pos-trust", "counter-v2")
            .map_err(|e| StoreError::Unavailable(format!("keyring entry: {e}")))?;
        match entry.get_password() {
            Ok(s) => s
                .trim()
                .parse::<u64>()
                .map(Some)
                .map_err(|_| StoreError::Unavailable("counter corrupt".into())),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(StoreError::Unavailable(format!("keyring read: {e}"))),
        }
    }

    fn store_counter(&self, counter: u64) -> Result<(), StoreError> {
        assert_not_in_unit_tests("store_counter");
        let entry = keyring::Entry::new("mobi-pos-trust", "counter-v2")
            .map_err(|e| StoreError::Unavailable(format!("keyring entry: {e}")))?;
        entry
            .set_password(&counter.to_string())
            .map_err(|e| StoreError::Unavailable(format!("keyring write: {e}")))
    }

    fn load_audit_head(&self) -> Result<Option<AuditHead>, StoreError> {
        assert_not_in_unit_tests("load_audit_head");
        let entry = keyring::Entry::new("mobi-pos-trust", "audit-head-v1")
            .map_err(|e| StoreError::Unavailable(format!("keyring entry: {e}")))?;
        match entry.get_password() {
            Ok(s) => serde_json::from_str(s.trim()).map(Some).map_err(|_| {
                StoreError::Unavailable("audit head corrupt".into())
            }),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(StoreError::Unavailable(format!("keyring read: {e}"))),
        }
    }

    fn store_audit_head(&self, head: &AuditHead) -> Result<(), StoreError> {
        assert_not_in_unit_tests("store_audit_head");
        let entry = keyring::Entry::new("mobi-pos-trust", "audit-head-v1")
            .map_err(|e| StoreError::Unavailable(format!("keyring entry: {e}")))?;
        // Monotonicity: a readable head never moves backwards (DB rollback
        // under a live keystore). Equal-seq re-advance is allowed (append
        // races converge on the same terminal). An unreadable (corrupt) head
        // may be replaced — the corrupt bytes verify against nothing — while
        // verify keeps reporting Broken until that re-seal lands.
        if let Ok(Some(prev)) = self.load_audit_head() {
            if head.seq < prev.seq {
                return Err(StoreError::Unavailable(format!(
                    "audit head rollback refused: {} -> {}",
                    prev.seq, head.seq
                )));
            }
        }
        let s = serde_json::to_string(head)
            .map_err(|e| StoreError::Unavailable(format!("audit head encode: {e}")))?;
        entry
            .set_password(&s)
            .map_err(|e| StoreError::Unavailable(format!("keyring write: {e}")))
    }

    fn load_pin_lockouts(&self) -> Result<Option<String>, StoreError> {
        assert_not_in_unit_tests("load_pin_lockouts");
        let entry = keyring::Entry::new("mobi-pos-trust", "pin-lockout-v1")
            .map_err(|e| StoreError::Unavailable(format!("keyring entry: {e}")))?;
        match entry.get_password() {
            Ok(s) if !s.trim().is_empty() => Ok(Some(s)),
            Ok(_) => Ok(None),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(StoreError::Unavailable(format!("keyring read: {e}"))),
        }
    }

    fn store_pin_lockouts(&self, json: &str) -> Result<(), StoreError> {
        assert_not_in_unit_tests("store_pin_lockouts");
        let entry = keyring::Entry::new("mobi-pos-trust", "pin-lockout-v1")
            .map_err(|e| StoreError::Unavailable(format!("keyring entry: {e}")))?;
        entry
            .set_password(json)
            .map_err(|e| StoreError::Unavailable(format!("keyring write: {e}")))
    }

    fn backend_name(&self) -> &'static str {
        "os-keyring"
    }
}

/// File-backed backend: mobile production (weak — same filesystem, flagged)
/// and degraded-desktop fallback. JSON `{mac_key_b64?, counter?}`.
pub struct FileKeyStore {
    path: PathBuf,
}

impl FileKeyStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn default_path(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join(".trust_keystore.vault")
    }

    fn read_doc(&self) -> Result<serde_json::Value, StoreError> {
        match std::fs::read_to_string(&self.path) {
            Ok(raw) => serde_json::from_str(&raw)
                .map_err(|e| StoreError::Unavailable(format!("keystore parse: {e}"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Value::Null),
            Err(e) => Err(StoreError::Unavailable(format!("keystore read: {e}"))),
        }
    }

    fn write_doc(&self, doc: &serde_json::Value) -> Result<(), StoreError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| StoreError::Unavailable(format!("keystore dir: {e}")))?;
        }
        let tmp = self.path.with_extension("vault.tmp");
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp)
                .map_err(|e| StoreError::Unavailable(format!("keystore tmp: {e}")))?;
            f.write_all(doc.to_string().as_bytes())
                .map_err(|e| StoreError::Unavailable(format!("keystore write: {e}")))?;
            // fsync BEFORE rename. Without this the rename can be committed
            // while the payload is still only in the page cache, so a
            // disk-full event or power loss leaves a renamed but truncated /
            // zero-byte keystore — which then reads back as a parse error and
            // is indistinguishable from a missing key. This mirrors
            // `persist_trust_snapshot`'s snapshot write, which already fsyncs.
            f.sync_all()
                .map_err(|e| StoreError::Unavailable(format!("keystore fsync: {e}")))?;
        }
        // Best-effort directory fsync (Unix); ignored where unsupported, as in
        // `persist_trust_snapshot`.
        #[cfg(unix)]
        if let Some(parent) = self.path.parent() {
            if let Ok(d) = std::fs::File::open(parent) {
                let _ = d.sync_all();
            }
        }
        std::fs::rename(&tmp, &self.path)
            .map_err(|e| StoreError::Unavailable(format!("keystore rename: {e}")))?;
        Ok(())
    }
}

impl KeyStore for FileKeyStore {
    fn load_mac_key(&self) -> Result<Option<Vec<u8>>, StoreError> {
        let doc = self.read_doc()?;
        match doc.get("mac_key_b64").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => URL_SAFE_NO_PAD
                .decode(s.trim())
                .map(Some)
                .map_err(|e| StoreError::Unavailable(format!("key decode: {e}"))),
            _ => Ok(None),
        }
    }

    fn store_mac_key(&self, key: &[u8]) -> Result<(), StoreError> {
        let mut doc = self.read_doc()?;
        if !doc.is_object() {
            doc = serde_json::json!({});
        }
        doc["mac_key_b64"] = serde_json::Value::String(URL_SAFE_NO_PAD.encode(key));
        self.write_doc(&doc)
    }

    fn load_counter(&self) -> Result<Option<u64>, StoreError> {
        let doc = self.read_doc()?;
        match doc.get("counter").and_then(|v| v.as_u64()) {
            Some(c) => Ok(Some(c)),
            None if doc.is_null() => Ok(None),
            None => Err(StoreError::Unavailable("counter corrupt".into())),
        }
    }

    fn store_counter(&self, counter: u64) -> Result<(), StoreError> {
        let mut doc = self.read_doc()?;
        if !doc.is_object() {
            doc = serde_json::json!({});
        }
        doc["counter"] = serde_json::Value::from(counter);
        self.write_doc(&doc)
    }

    fn load_audit_head(&self) -> Result<Option<AuditHead>, StoreError> {
        let doc = self.read_doc()?;
        match doc.get("audit_head") {
            Some(v) if !v.is_null() => serde_json::from_value(v.clone())
                .map(Some)
                .map_err(|_| StoreError::Unavailable("audit head corrupt".into())),
            _ if doc.is_null() => Ok(None),
            _ => Ok(None),
        }
    }

    fn store_audit_head(&self, head: &AuditHead) -> Result<(), StoreError> {
        // Monotonicity (same contract as OsKeyStore): refuse backwards
        // moves; allow equal re-advance and replacement of corrupt heads.
        // NOTE: this deliberately re-reads through `load_audit_head`, so a
        // present-but-corrupt head surfaces as Unavailable (not None) and
        // does NOT take the rollback-refusal path — it may be replaced.
        match self.load_audit_head() {
            Ok(Some(prev)) if head.seq < prev.seq => {
                return Err(StoreError::Unavailable(format!(
                    "audit head rollback refused: {} -> {}",
                    prev.seq, head.seq
                )))
            }
            _ => {}
        }
        let mut doc = self.read_doc()?;
        if !doc.is_object() {
            doc = serde_json::json!({});
        }
        doc["audit_head"] = serde_json::to_value(head)
            .map_err(|e| StoreError::Unavailable(format!("audit head encode: {e}")))?;
        self.write_doc(&doc)
    }

    fn load_pin_lockouts(&self) -> Result<Option<String>, StoreError> {
        let doc = self.read_doc()?;
        match doc.get("pin_lockout") {
            Some(v) if !v.is_null() => Ok(Some(v.to_string())),
            _ if doc.is_null() => Ok(None),
            _ => Ok(None),
        }
    }

    fn store_pin_lockouts(&self, json: &str) -> Result<(), StoreError> {
        let mut doc = self.read_doc()?;
        if !doc.is_object() {
            doc = serde_json::json!({});
        }
        doc["pin_lockout"] = serde_json::from_str(json)
            .map_err(|e| StoreError::Unavailable(format!("pin lockout encode: {e}")))?;
        self.write_doc(&doc)
    }

    fn backend_name(&self) -> &'static str {
        "file-vault"
    }
}

// ---------------------------------------------------------------------------
// Snapshot format
// ---------------------------------------------------------------------------

/// Persisted trust data (v2). Time fields are `None` until anchored;
/// `None` serializes explicitly and MACs as empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotData {
    pub state: LicenseState,
    pub generation: u64,
    pub counter: u64,
    pub boot_session_id: Option<String>,
    pub last_trusted_wall_utc_ms: Option<u64>,
    pub last_monotonic_ms: Option<u64>,
    pub last_server_time_utc_ms: Option<u64>,
    pub last_server_seq: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SnapshotFileV2 {
    version: u32,
    state_code: String,
    generation: u64,
    counter: u64,
    #[serde(default)]
    boot_session_id: Option<String>,
    #[serde(default)]
    last_trusted_wall_utc_ms: Option<u64>,
    #[serde(default)]
    last_monotonic_ms: Option<u64>,
    #[serde(default)]
    last_server_time_utc_ms: Option<u64>,
    #[serde(default)]
    last_server_seq: Option<u64>,
    mac_hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SnapshotFileV1 {
    version: u32,
    state_code: String,
    generation: u64,
    counter: u64,
    mac_hex: String,
}

/// Minimal version probe that cannot fail on unknown shapes.
#[derive(Debug, Deserialize)]
struct VersionProbe {
    #[serde(default)]
    version: Option<u32>,
}

fn mac_v2(mac_key: &[u8], f: &SnapshotFileV2) -> String {
    fn opt(n: Option<u64>) -> String {
        n.map(|v| v.to_string()).unwrap_or_default()
    }
    let mut h = Sha256::new();
    h.update(mac_key);
    h.update([0x1F]);
    h.update(f.version.to_be_bytes());
    h.update([0x1F]);
    h.update(f.state_code.as_bytes());
    h.update([0x1F]);
    h.update(f.generation.to_be_bytes());
    h.update([0x1F]);
    h.update(f.counter.to_be_bytes());
    h.update([0x1F]);
    h.update(f.boot_session_id.clone().unwrap_or_default().as_bytes());
    h.update([0x1F]);
    h.update(opt(f.last_trusted_wall_utc_ms).as_bytes());
    h.update([0x1F]);
    h.update(opt(f.last_monotonic_ms).as_bytes());
    h.update([0x1F]);
    h.update(opt(f.last_server_time_utc_ms).as_bytes());
    h.update([0x1F]);
    h.update(opt(f.last_server_seq).as_bytes());
    format!("{:x}", h.finalize())
}

/// Legacy v1 MAC (migration verification only).
fn mac_v1(mac_key: &str, version: u32, state_code: &str, generation: u64, counter: u64) -> String {
    let mut h = Sha256::new();
    h.update(mac_key.as_bytes());
    h.update([0x1F]);
    h.update(version.to_be_bytes());
    h.update([0x1F]);
    h.update(state_code.as_bytes());
    h.update([0x1F]);
    h.update(generation.to_be_bytes());
    h.update([0x1F]);
    h.update(counter.to_be_bytes());
    format!("{:x}", h.finalize())
}

fn mac_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Debug-only env override (Amendment A1). This function does not exist in
/// release builds — there is no env-read path to audit there.
#[cfg(debug_assertions)]
fn debug_env_key() -> Option<Vec<u8>> {
    std::env::var("MOBI_LICENSE_MAC_KEY")
        .ok()
        .filter(|k| !k.trim().is_empty())
        .map(|k| k.into_bytes())
}

fn generate_mac_key() -> Vec<u8> {
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    let mut key = Vec::with_capacity(32);
    key.extend_from_slice(a.as_bytes());
    key.extend_from_slice(b.as_bytes());
    key
}

// ---------------------------------------------------------------------------
// Load / persist
// ---------------------------------------------------------------------------

/// Why the snapshot demands quarantine (recoverable via re-anchor).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TamperReason {
    /// File counter behind the keystore counter: replay of older state.
    CounterRollback,
    /// v1 file presented after a v2 counter exists: no downgrade path.
    DowngradeV1,
    /// File present but keystore key/counter missing or unreadable (or the
    /// reverse: counter without file). Never a silent fresh counter.
    MissingStoreWithState,
}

/// Startup resolution outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadVerdict {
    /// No file and no keystore counter: genuine first boot.
    FreshInstall,
    /// Fully verified v2 snapshot.
    Verified(SnapshotData),
    /// Valid legacy v1 snapshot on a machine with no v2 counter: re-seal to
    /// v2 immediately (one-time migration).
    MigratedV1 { state: LicenseState, generation: u64 },
    /// Recoverable integrity failure: re-anchor, do not silently reset.
    QuarantineTamper(TamperReason),
    /// Unrecoverable by re-anchor: MAC failure, malformed/truncated data,
    /// unknown state code or version.
    Corrupt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PersistError {
    Io(String),
    Store(StoreError),
}

impl std::fmt::Display for PersistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PersistError::Io(e) => write!(f, "snapshot write: {e}"),
            PersistError::Store(StoreError::NotFound) => write!(f, "keystore entry missing"),
            PersistError::Store(StoreError::Unavailable(e)) => write!(f, "keystore: {e}"),
        }
    }
}

/// Crash-safe dual persist: snapshot file FIRST (temp + fsync + atomic
/// rename, counter already N+1 in `data`), keystore counter SECOND. A crash
/// between the two is healed forward on the next load, never a tamper
/// verdict. `mac_key` must be the resolved active key.
pub fn persist_trust_snapshot(
    file_path: &Path,
    store: &dyn KeyStore,
    data: &SnapshotData,
    mac_key: &[u8],
) -> Result<(), PersistError> {
    let mut file = SnapshotFileV2 {
        version: SNAPSHOT_VERSION_V2,
        state_code: data.state.as_code().to_string(),
        generation: data.generation,
        counter: data.counter,
        boot_session_id: data.boot_session_id.clone(),
        last_trusted_wall_utc_ms: data.last_trusted_wall_utc_ms,
        last_monotonic_ms: data.last_monotonic_ms,
        last_server_time_utc_ms: data.last_server_time_utc_ms,
        last_server_seq: data.last_server_seq,
        mac_hex: String::new(),
    };
    file.mac_hex = mac_v2(mac_key, &file);
    let json =
        serde_json::to_string(&file).map_err(|e| PersistError::Io(format!("encode: {e}")))?;

    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| PersistError::Io(format!("mkdir: {e}")))?;
    }
    let tmp = file_path.with_extension("vault.tmp");
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp).map_err(|e| PersistError::Io(format!("tmp: {e}")))?;
        f.write_all(json.as_bytes())
            .map_err(|e| PersistError::Io(format!("write: {e}")))?;
        // fsync BEFORE rename: after a power loss the reader sees the old
        // consistent file or the fully durable new one.
        f.sync_all().map_err(|e| PersistError::Io(format!("fsync: {e}")))?;
    }
    // Best-effort directory fsync (Unix); ignored where unsupported.
    #[cfg(unix)]
    {
        if let Some(parent) = file_path.parent() {
            if let Ok(d) = std::fs::File::open(parent) {
                let _ = d.sync_all();
            }
        }
    }
    std::fs::rename(&tmp, file_path).map_err(|e| PersistError::Io(format!("rename: {e}")))?;

    // Keystore second: crash here heals forward on next load.
    store
        .store_counter(data.counter)
        .map_err(PersistError::Store)?;
    Ok(())
}

/// Heal the keystore counter forward after accepting file(N) > store(M).
pub fn heal_store_counter(store: &dyn KeyStore, counter: u64) -> Result<(), StoreError> {
    store.store_counter(counter)
}

/// Resolve (or, on genuine fresh machines, provision) the active MAC key.
/// - Debug: env override wins when set; else keystore; else generate+store
///   (or compiled fallback when the store itself is unavailable AND no prior
///   state exists — degraded, loudly logged).
/// - Release: keystore only. Missing key with no prior state provisions a
///   fresh key (genuine first boot); missing key WITH prior state is decided
///   by the caller (quarantine), never silently provisioned here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyResolution {
    Active {
        key: Vec<u8>,
        source: &'static str,
    },
    /// No key and no prior state: caller provisions on first persist.
    ProvisionOnFirstPersist,
    /// Prior state exists but no usable key: caller quarantines.
    QuarantineNoKey,
}

/// What a single `KeyStore::load_mac_key` read actually produced.
///
/// Diagnostics ONLY — this never changes the resolution decision, which is
/// still made solely by `Ok(_)` vs `Err(_)` plus `prior_state_exists`. It
/// exists so the "key unavailable" log line can say WHICH of the four
/// distinct failure modes occurred (entry absent, entry present but empty,
/// entry undecodable/corrupt, backend error such as access denied) instead
/// of collapsing all of them into one opaque "key missing" message.
/// Contains no key material.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyReadOutcome {
    /// A non-empty, decodable key was read.
    Present,
    /// Backend answered successfully and the entry is genuinely absent.
    Absent,
    /// Backend returned the entry but the stored value is blank.
    EmptyEntry,
    /// Backend failed: no keyring, access denied, decode failure, truncated
    /// or otherwise corrupt keystore payload. The variant text is carried
    /// from the backend's own error and contains no key material.
    BackendUnavailable,
}

impl KeyReadOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyReadOutcome::Present => "present",
            KeyReadOutcome::Absent => "entry-absent",
            KeyReadOutcome::EmptyEntry => "entry-present-but-empty",
            KeyReadOutcome::BackendUnavailable => "backend-unavailable-or-corrupt",
        }
    }
}

/// Classify a `load_mac_key` read. Pure: safe to unit-test without a
/// keystore, and deliberately total over every input shape.
pub fn key_read_outcome(read: &Result<Option<Vec<u8>>, StoreError>) -> KeyReadOutcome {
    match read {
        Ok(Some(k)) if k.is_empty() => KeyReadOutcome::EmptyEntry,
        Ok(Some(_)) => KeyReadOutcome::Present,
        Ok(None) => KeyReadOutcome::Absent,
        Err(_) => KeyReadOutcome::BackendUnavailable,
    }
}

pub fn resolve_mac_key(
    store: &dyn KeyStore,
    prior_state_exists: bool,
) -> KeyResolution {
    #[cfg(debug_assertions)]
    if let Some(k) = debug_env_key() {
        return KeyResolution::Active {
            key: k,
            source: "env(MOBI_LICENSE_MAC_KEY,debug-only)",
        };
    }
    let read = store.load_mac_key();
    let outcome = key_read_outcome(&read);
    match read {
        Ok(Some(k)) if !k.is_empty() => {
            let backend = store.backend_name();
            let source: &'static str = if backend == "os-keyring" {
                "os-keyring"
            } else {
                "file-vault"
            };
            KeyResolution::Active { key: k, source }
        }
        Ok(_) => {
            // Decision unchanged: absence with history quarantines. Only the
            // log line is new, so an operator can tell a genuinely absent
            // entry from a blank one.
            eprintln!(
                "[trust_core] MAC key unavailable ({}, {}) prior_state_exists={prior_state_exists}",
                outcome.as_str(),
                store.backend_name()
            );
            if prior_state_exists {
                KeyResolution::QuarantineNoKey
            } else {
                KeyResolution::ProvisionOnFirstPersist
            }
        }
        Err(e) => {
            // The backend's own reason (access denied / decode / parse /
            // truncated) is preserved here. It was previously discarded by
            // `Err(_) =>`, which made every backend failure indistinguishable.
            // Decision unchanged: fresh machines may degrade loudly;
            // anything with history quarantines.
            eprintln!(
                "[trust_core] MAC key read failed ({}, {}): {e:?} prior_state_exists={prior_state_exists}",
                outcome.as_str(),
                store.backend_name()
            );
            if prior_state_exists {
                KeyResolution::QuarantineNoKey
            } else {
                eprintln!("[trust_core] keystore unavailable on fresh machine — provisional file-backed key will be used (degraded, flagged)");
                KeyResolution::ProvisionOnFirstPersist
            }
        }
    }
}

/// Generate and store a fresh MAC key (first persist on a fresh machine).
pub fn provision_mac_key(store: &dyn KeyStore) -> Result<Vec<u8>, StoreError> {
    let key = generate_mac_key();
    store.store_mac_key(&key)?;
    Ok(key)
}

/// Full startup resolution: file + keystore → `LoadVerdict`.
/// `active_key` must be the resolved key, or `None` when resolution says
/// quarantine/provision (in which case only FreshInstall-vs-quarantine is
/// decided here; verification is impossible without a key).
pub fn load_trust_snapshot(
    file_path: &Path,
    store: &dyn KeyStore,
    active_key: Option<&[u8]>,
) -> LoadVerdict {
    let raw = match std::fs::read_to_string(file_path) {
        Ok(r) => Some(r),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return LoadVerdict::Corrupt,
    };
    let store_counter = match store.load_counter() {
        Ok(c) => c,
        Err(StoreError::NotFound) => None,
        Err(_) => {
            // Unreadable keystore with any history is not freshness.
            return LoadVerdict::QuarantineTamper(TamperReason::MissingStoreWithState);
        }
    };

    let Some(raw) = raw else {
        // No file: a surviving counter means deletion, not freshness.
        if store_counter.is_some() {
            return LoadVerdict::QuarantineTamper(TamperReason::MissingStoreWithState);
        }
        return LoadVerdict::FreshInstall;
    };

    // Downgrade gate BEFORE any MAC work: a v1 file on a machine that
    // already holds a v2 counter is rejected outright.
    let version = serde_json::from_str::<VersionProbe>(&raw)
        .ok()
        .and_then(|p| p.version);
    if version == Some(LEGACY_V1_VERSION) {
        if store_counter.is_some() {
            return LoadVerdict::QuarantineTamper(TamperReason::DowngradeV1);
        }
        return verify_v1_for_migration(&raw);
    }
    if version != Some(SNAPSHOT_VERSION_V2) {
        return LoadVerdict::Corrupt;
    }

    let Some(key) = active_key else {
        // v2 file present but no usable key: missing-store-with-state.
        return LoadVerdict::QuarantineTamper(TamperReason::MissingStoreWithState);
    };

    let file: SnapshotFileV2 = match serde_json::from_str(&raw) {
        Ok(f) => f,
        Err(_) => return LoadVerdict::Corrupt,
    };
    if !mac_eq(&mac_v2(key, &file), &file.mac_hex) {
        return LoadVerdict::Corrupt;
    }
    let state = match LicenseState::from_code(&file.state_code) {
        Some(s) => s,
        None => return LoadVerdict::Corrupt,
    };

    match store_counter {
        Some(known) if file.counter < known => {
            LoadVerdict::QuarantineTamper(TamperReason::CounterRollback)
        }
        Some(known) if file.counter > known => {
            // Crash between the two writes: accept and heal forward.
            if heal_store_counter(store, file.counter).is_err() {
                return LoadVerdict::QuarantineTamper(TamperReason::MissingStoreWithState);
            }
            LoadVerdict::Verified(SnapshotData::from(file, state))
        }
        _ => LoadVerdict::Verified(SnapshotData::from(file, state)),
    }
}

impl SnapshotData {
    fn from(file: SnapshotFileV2, state: LicenseState) -> Self {
        Self {
            state,
            generation: file.generation,
            counter: file.counter,
            boot_session_id: file.boot_session_id,
            last_trusted_wall_utc_ms: file.last_trusted_wall_utc_ms,
            last_monotonic_ms: file.last_monotonic_ms,
            last_server_time_utc_ms: file.last_server_time_utc_ms,
            last_server_seq: file.last_server_seq,
        }
    }
}

/// One-time v1 migration verification (legacy MAC only, never for sealing).
fn verify_v1_for_migration(raw: &str) -> LoadVerdict {
    let file: SnapshotFileV1 = match serde_json::from_str(raw) {
        Ok(f) => f,
        Err(_) => return LoadVerdict::Corrupt,
    };
    if file.version != LEGACY_V1_VERSION {
        return LoadVerdict::Corrupt;
    }
    // Candidate keys: debug env first (dev machines), then the legacy
    // compiled fallback (the only key Phase 1 release builds ever used).
    #[cfg(debug_assertions)]
    let mut candidates: Vec<String> = debug_env_key()
        .map(|k| vec![String::from_utf8_lossy(&k).into_owned()])
        .unwrap_or_default();
    #[cfg(not(debug_assertions))]
    let mut candidates: Vec<String> = Vec::new();
    candidates.push(LEGACY_V1_FALLBACK_KEY.to_string());

    let ok = candidates
        .iter()
        .any(|k| mac_eq(&mac_v1(k, file.version, &file.state_code, file.generation, file.counter), &file.mac_hex));
    if !ok {
        return LoadVerdict::Corrupt;
    }
    match LicenseState::from_code(&file.state_code) {
        Some(state) => LoadVerdict::MigratedV1 {
            state,
            generation: file.generation,
        },
        None => LoadVerdict::Corrupt,
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Hermetic in-memory keystore for unit tests.
    pub struct MemKeyStore {
        inner: Mutex<HashMap<String, String>>,
        pub fail_all: Mutex<bool>,
    }

    impl MemKeyStore {
        pub fn new() -> Self {
            Self {
                inner: Mutex::new(HashMap::new()),
                fail_all: Mutex::new(false),
            }
        }

        /// Test-only seam: write a head WITHOUT the monotonicity refusal, to
        /// simulate a head restored from a newer machine image onto an older
        /// DB (production backends never offer this path).
        #[cfg(test)]
        pub fn store_audit_head_raw_for_tests(&self, head: &AuditHead) -> Result<(), StoreError> {
            let s = serde_json::to_string(head)
                .map_err(|e| StoreError::Unavailable(format!("audit head encode: {e}")))?;
            self.inner.lock().unwrap().insert("audit_head".into(), s);
            Ok(())
        }
    }

    impl KeyStore for MemKeyStore {
        fn load_mac_key(&self) -> Result<Option<Vec<u8>>, StoreError> {
            if *self.fail_all.lock().unwrap() {
                return Err(StoreError::Unavailable("injected".into()));
            }
            match self.inner.lock().unwrap().get("mac") {
                Some(s) => URL_SAFE_NO_PAD
                    .decode(s)
                    .map(Some)
                    .map_err(|e| StoreError::Unavailable(format!("decode: {e}"))),
                None => Ok(None),
            }
        }

        fn store_mac_key(&self, key: &[u8]) -> Result<(), StoreError> {
            if *self.fail_all.lock().unwrap() {
                return Err(StoreError::Unavailable("injected".into()));
            }
            self.inner
                .lock()
                .unwrap()
                .insert("mac".into(), URL_SAFE_NO_PAD.encode(key));
            Ok(())
        }

        fn load_counter(&self) -> Result<Option<u64>, StoreError> {
            if *self.fail_all.lock().unwrap() {
                return Err(StoreError::Unavailable("injected".into()));
            }
            match self.inner.lock().unwrap().get("counter") {
                Some(s) => s
                    .parse::<u64>()
                    .map(Some)
                    .map_err(|_| StoreError::Unavailable("counter corrupt".into())),
                None => Ok(None),
            }
        }

        fn store_counter(&self, counter: u64) -> Result<(), StoreError> {
            if *self.fail_all.lock().unwrap() {
                return Err(StoreError::Unavailable("injected".into()));
            }
            self.inner
                .lock()
                .unwrap()
                .insert("counter".into(), counter.to_string());
            Ok(())
        }

        fn load_audit_head(&self) -> Result<Option<AuditHead>, StoreError> {
            if *self.fail_all.lock().unwrap() {
                return Err(StoreError::Unavailable("injected".into()));
            }
            match self.inner.lock().unwrap().get("audit_head") {
                Some(s) => serde_json::from_str(s)
                    .map(Some)
                    .map_err(|_| StoreError::Unavailable("audit head corrupt".into())),
                None => Ok(None),
            }
        }

        fn store_audit_head(&self, head: &AuditHead) -> Result<(), StoreError> {
            if *self.fail_all.lock().unwrap() {
                return Err(StoreError::Unavailable("injected".into()));
            }
            // Same monotonicity contract as the production backends.
            if let Ok(Some(prev)) = self.load_audit_head() {
                if head.seq < prev.seq {
                    return Err(StoreError::Unavailable(format!(
                        "audit head rollback refused: {} -> {}",
                        prev.seq, head.seq
                    )));
                }
            }
            let s = serde_json::to_string(head)
                .map_err(|e| StoreError::Unavailable(format!("audit head encode: {e}")))?;
            self.inner.lock().unwrap().insert("audit_head".into(), s);
            Ok(())
        }

        fn load_pin_lockouts(&self) -> Result<Option<String>, StoreError> {
            if *self.fail_all.lock().unwrap() {
                return Err(StoreError::Unavailable("injected".into()));
            }
            Ok(self.inner.lock().unwrap().get("pin_lockout").cloned())
        }

        fn store_pin_lockouts(&self, json: &str) -> Result<(), StoreError> {
            if *self.fail_all.lock().unwrap() {
                return Err(StoreError::Unavailable("injected".into()));
            }
            self.inner
                .lock()
                .unwrap()
                .insert("pin_lockout".into(), json.to_string());
            Ok(())
        }

        fn backend_name(&self) -> &'static str {
            "mem-test"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::MemKeyStore;
    use super::*;
    use crate::trust_core::ipc_authorizer::serial_test_lock;

    fn tmp_path(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut p = std::env::temp_dir();
        p.push(format!("mobi-trust-v2-{tag}-{nanos}"));
        p.push(SNAPSHOT_FILE_NAME);
        p
    }

    fn sample_data(counter: u64) -> SnapshotData {
        SnapshotData {
            state: LicenseState::Operational,
            generation: 7,
            counter,
            boot_session_id: Some("boot-1".into()),
            last_trusted_wall_utc_ms: Some(1_700_000_000_000),
            last_monotonic_ms: Some(99_000),
            last_server_time_utc_ms: Some(1_700_000_000_000),
            last_server_seq: Some(42),
        }
    }

    #[test]
    fn roundtrip_v2_with_fsync() {
        let _g = serial_test_lock();
        let store = MemKeyStore::new();
        let key = provision_mac_key(&store).unwrap();
        let path = tmp_path("roundtrip");
        persist_trust_snapshot(&path, &store, &sample_data(3), &key).unwrap();
        match load_trust_snapshot(&path, &store, Some(&key)) {
            LoadVerdict::Verified(d) => {
                assert_eq!(d, sample_data(3));
            }
            other => panic!("expected Verified, got {other:?}"),
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_file_and_store_is_fresh_install() {
        let _g = serial_test_lock();
        let store = MemKeyStore::new();
        let path = tmp_path("missing");
        assert_eq!(
            load_trust_snapshot(&path, &store, Some(b"any-key")),
            LoadVerdict::FreshInstall
        );
    }

    #[test]
    fn missing_file_with_counter_is_deletion_not_fresh() {
        let _g = serial_test_lock();
        let store = MemKeyStore::new();
        store.store_counter(5).unwrap();
        let path = tmp_path("deleted");
        assert_eq!(
            load_trust_snapshot(&path, &store, Some(b"any-key")),
            LoadVerdict::QuarantineTamper(TamperReason::MissingStoreWithState)
        );
    }

    #[test]
    fn tampered_file_is_corrupt_never_permissive() {
        let _g = serial_test_lock();
        let store = MemKeyStore::new();
        let key = provision_mac_key(&store).unwrap();
        let path = tmp_path("tamper");
        persist_trust_snapshot(&path, &store, &sample_data(2), &key).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap().replace("OPERATIONAL", "EXPIRED");
        std::fs::write(&path, raw).unwrap();
        assert_eq!(
            load_trust_snapshot(&path, &store, Some(&key)),
            LoadVerdict::Corrupt
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn counter_rollback_is_quarantine() {
        let _g = serial_test_lock();
        let store = MemKeyStore::new();
        let key = provision_mac_key(&store).unwrap();
        let path = tmp_path("rollback");
        persist_trust_snapshot(&path, &store, &sample_data(9), &key).unwrap();
        // Attacker restores an older valid snapshot (counter 3, valid MAC).
        persist_trust_snapshot(&path, &store, &sample_data(3), &key).unwrap();
        // …but the keystore still holds 9: downgrade the file only.
        store.store_counter(9).unwrap();
        persist_trust_snapshot(&path, &store, &sample_data(3), &key).unwrap();
        // File now counter 3, store counter 9 → rollback.
        store.store_counter(9).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v["counter"] = serde_json::Value::from(3u64);
        // Re-MAC at 3 with the real key (strongest attacker: valid old file).
        let mut f: SnapshotFileV2 = serde_json::from_value(v.clone()).unwrap();
        f.mac_hex = mac_v2(&key, &f);
        std::fs::write(&path, serde_json::to_string(&f).unwrap()).unwrap();
        assert_eq!(
            load_trust_snapshot(&path, &store, Some(&key)),
            LoadVerdict::QuarantineTamper(TamperReason::CounterRollback)
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn crash_between_writes_heals_forward_no_tamper() {
        let _g = serial_test_lock();
        let store = MemKeyStore::new();
        let key = provision_mac_key(&store).unwrap();
        let path = tmp_path("crash");
        // Steady state N=4 in both stores.
        persist_trust_snapshot(&path, &store, &sample_data(4), &key).unwrap();
        // Simulated crash: file advanced to N+1=5, keystore still 4.
        let d5 = sample_data(5);
        // ( replicate persist's file half only )
        let mut file = SnapshotFileV2 {
            version: SNAPSHOT_VERSION_V2,
            state_code: d5.state.as_code().to_string(),
            generation: d5.generation,
            counter: d5.counter,
            boot_session_id: d5.boot_session_id.clone(),
            last_trusted_wall_utc_ms: d5.last_trusted_wall_utc_ms,
            last_monotonic_ms: d5.last_monotonic_ms,
            last_server_time_utc_ms: d5.last_server_time_utc_ms,
            last_server_seq: d5.last_server_seq,
            mac_hex: String::new(),
        };
        file.mac_hex = mac_v2(&key, &file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string(&file).unwrap()).unwrap();
        // Load must ACCEPT and heal the keystore to 5.
        match load_trust_snapshot(&path, &store, Some(&key)) {
            LoadVerdict::Verified(d) => assert_eq!(d.counter, 5),
            other => panic!("crash state must heal, got {other:?}"),
        }
        assert_eq!(store.load_counter().unwrap(), Some(5));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn v1_after_v2_counter_is_downgrade_rejected() {
        let _g = serial_test_lock();
        let store = MemKeyStore::new();
        store.store_counter(2).unwrap(); // v2 era already reached
        let path = tmp_path("downgrade");
        // Forge a MAC-valid v1 file with the legacy key (strongest attacker).
        let v1 = serde_json::json!({
            "version": 1u32,
            "state_code": "OPERATIONAL",
            "generation": 1u64,
            "counter": 1u64,
            "mac_hex": mac_v1(LEGACY_V1_FALLBACK_KEY, 1, "OPERATIONAL", 1, 1),
        });
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, v1.to_string()).unwrap();
        assert_eq!(
            load_trust_snapshot(&path, &store, Some(b"any-key")),
            LoadVerdict::QuarantineTamper(TamperReason::DowngradeV1)
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn v1_without_counter_migrates_once() {
        let _g = serial_test_lock();
        let store = MemKeyStore::new(); // no v2 counter anywhere
        let path = tmp_path("migrate");
        let v1 = serde_json::json!({
            "version": 1u32,
            "state_code": "EXPIRED",
            "generation": 4u64,
            "counter": 4u64,
            "mac_hex": mac_v1(LEGACY_V1_FALLBACK_KEY, 1, "EXPIRED", 4, 4),
        });
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, v1.to_string()).unwrap();
        assert_eq!(
            load_trust_snapshot(&path, &store, Some(b"any-key")),
            LoadVerdict::MigratedV1 {
                state: LicenseState::Expired,
                generation: 4
            }
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn unknown_state_and_version_are_corrupt() {
        let _g = serial_test_lock();
        let store = MemKeyStore::new();
        let key = provision_mac_key(&store).unwrap();
        let path = tmp_path("unknownver");
        let raw = serde_json::json!({
            "version": 99u32, "state_code": "OPERATIONAL", "generation": 1u64,
            "counter": 1u64, "mac_hex": "00",
        });
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, raw.to_string()).unwrap();
        assert_eq!(
            load_trust_snapshot(&path, &store, Some(&key)),
            LoadVerdict::Corrupt
        );
        let _ = std::fs::remove_file(&path);
    }

    /// Amendment A1 proof, split by profile so each run proves its own
    /// behavior (a single combined test would pass in both profiles without
    /// proving which branch executed):
    /// - dev (`cargo test`): env override honored, visibly sourced.
    /// - release (`cargo test --release`, debug_assertions OFF): env ignored.
    #[test]
    #[cfg(debug_assertions)]
    fn debug_profile_honors_env_override() {
        let _g = serial_test_lock();
        std::env::set_var("MOBI_LICENSE_MAC_KEY", "attacker-supplied-key");
        let store = MemKeyStore::new();
        let verdict = resolve_mac_key(&store, false);
        std::env::remove_var("MOBI_LICENSE_MAC_KEY");
        match verdict {
            KeyResolution::Active { source, .. } => {
                assert_eq!(source, "env(MOBI_LICENSE_MAC_KEY,debug-only)")
            }
            other => panic!("debug must honor env override, got {other:?}"),
        }
    }

    #[test]
    #[cfg(not(debug_assertions))]
    fn release_profile_ignores_env_override() {
        let _g = serial_test_lock();
        std::env::set_var("MOBI_LICENSE_MAC_KEY", "attacker-supplied-key");
        let store = MemKeyStore::new();
        let verdict = resolve_mac_key(&store, false);
        std::env::remove_var("MOBI_LICENSE_MAC_KEY");
        match verdict {
            KeyResolution::Active { source, .. } => assert_ne!(
                source, "env(MOBI_LICENSE_MAC_KEY,debug-only)",
                "RELEASE MUST IGNORE THE ENV OVERRIDE"
            ),
            // Provision/quarantine without env influence is equally proof.
            KeyResolution::ProvisionOnFirstPersist => {}
            KeyResolution::QuarantineNoKey => {}
        }
    }

    #[test]
    fn unreadable_store_with_history_quarantines() {
        let _g = serial_test_lock();
        let store = MemKeyStore::new();
        *store.fail_all.lock().unwrap() = true;
        let path = tmp_path("brokenstore");
        // Even without a file, a broken store is not freshness.
        let v = load_trust_snapshot(&path, &store, None);
        assert_eq!(
            v,
            LoadVerdict::QuarantineTamper(TamperReason::MissingStoreWithState)
        );
    }

    // --- diagnostics defect: the four "key unavailable" modes were collapsed
    // into one opaque message because `Err(_)` discarded the backend reason.

    #[test]
    fn key_read_outcome_distinguishes_every_failure_mode() {
        let _g = serial_test_lock();
        assert_eq!(
            key_read_outcome(&Ok(Some(vec![1u8, 2, 3]))),
            KeyReadOutcome::Present
        );
        assert_eq!(
            key_read_outcome(&Ok(None)),
            KeyReadOutcome::Absent,
            "a genuinely absent entry must not read as corrupt"
        );
        assert_eq!(
            key_read_outcome(&Ok(Some(Vec::new()))),
            KeyReadOutcome::EmptyEntry,
            "an entry present with a blank payload is its own mode"
        );
        for backend_err in [
            "key decode: InvalidByte",
            "keyring read: access denied",
            "counter corrupt",
            "keystore parse: expected value",
            "keystore read: The system cannot find the file",
        ] {
            assert_eq!(
                key_read_outcome(&Err(StoreError::Unavailable(backend_err.into()))),
                KeyReadOutcome::BackendUnavailable,
                "backend error {backend_err:?} must classify as unavailable"
            );
        }
        assert_eq!(
            key_read_outcome(&Err(StoreError::NotFound)),
            KeyReadOutcome::BackendUnavailable
        );
    }

    #[test]
    fn unavailable_key_never_provisions_when_prior_state_exists() {
        let _g = serial_test_lock();
        // Regression guard on the decision the log line must NOT influence:
        // every unavailable mode with prior state stays QuarantineNoKey.
        let store = MemKeyStore::new();
        assert_eq!(
            resolve_mac_key(&store, true),
            KeyResolution::QuarantineNoKey,
            "absent key + prior state must quarantine, never provision"
        );
        *store.fail_all.lock().unwrap() = true;
        assert_eq!(
            resolve_mac_key(&store, true),
            KeyResolution::QuarantineNoKey,
            "unreadable key + prior state must quarantine, never provision"
        );
    }

    // --- atomicity fix: FileKeyStore::write_doc now fsyncs before rename.

    fn tmp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut p = std::env::temp_dir();
        p.push(format!("mobi-keystore-{tag}-{nanos}"));
        p
    }

    #[test]
    fn file_keystore_write_is_atomic_and_leaves_no_tmp_residue() {
        let _g = serial_test_lock();
        let dir = tmp_dir("atomic");
        let path = FileKeyStore::default_path(&dir);
        let store = FileKeyStore::new(path.clone());
        let key = provision_mac_key(&store).unwrap();
        store.store_counter(9).unwrap();

        // Durable payload present under the final name…
        assert!(path.exists(), "keystore must exist after write");
        assert_eq!(store.load_mac_key().unwrap(), Some(key));
        assert_eq!(store.load_counter().unwrap(), Some(9));

        // …and no partially-written temp file left behind for a reader to
        // pick up, which is the failure mode a non-fsync write leaves open
        // after a rename committed ahead of its payload.
        let tmp = path.with_extension("vault.tmp");
        assert!(
            !tmp.exists(),
            "write_doc must not leave {} behind",
            tmp.display()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncated_file_keystore_is_corrupt_not_absent_and_never_provisions() {
        let _g = serial_test_lock();
        let dir = tmp_dir("truncated");
        let path = FileKeyStore::default_path(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Zero-byte keystore: exactly what a rename committed ahead of a
        // non-fsynced payload (ENOSPC / power loss) leaves on disk.
        std::fs::write(&path, b"").unwrap();
        let store = FileKeyStore::new(path.clone());

        // Must surface as a backend failure, never as a silent "absent" —
        // otherwise the operator is told to look for a missing credential
        // entry that is in fact a truncated file.
        let read = store.load_mac_key();
        assert_eq!(
            key_read_outcome(&read),
            KeyReadOutcome::BackendUnavailable,
            "truncated keystore must not read as absent"
        );
        assert!(matches!(read, Err(StoreError::Unavailable(_))));

        // Decision is unchanged and still fails closed.
        assert_eq!(
            resolve_mac_key(&store, true),
            KeyResolution::QuarantineNoKey
        );

        // Also a truncated (non-zero, invalid JSON) payload.
        std::fs::write(&path, b"{\"mac_key_b64\":\"AA\"").unwrap();
        assert_eq!(
            key_read_outcome(&store.load_mac_key()),
            KeyReadOutcome::BackendUnavailable
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_keystore_undecodable_key_is_backend_unavailable() {
        let _g = serial_test_lock();
        let dir = tmp_dir("badb64");
        let path = FileKeyStore::default_path(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Entry present and decodable JSON, but the key payload is not
        // base64url — a decode error, distinct from absence.
        std::fs::write(&path, br#"{"mac_key_b64":"!!!not base64!!!"}"#).unwrap();
        let store = FileKeyStore::new(path);
        let read = store.load_mac_key();
        assert_eq!(
            key_read_outcome(&read),
            KeyReadOutcome::BackendUnavailable
        );
        assert!(matches!(read, Err(StoreError::Unavailable(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_keystore_missing_file_is_the_only_absent_case() {
        let _g = serial_test_lock();
        let dir = tmp_dir("missing");
        let store = FileKeyStore::new(FileKeyStore::default_path(&dir));
        // The one shape that is genuinely "absent": no file at all.
        assert_eq!(key_read_outcome(&store.load_mac_key()), KeyReadOutcome::Absent);
        assert_eq!(store.load_counter().unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- audit-head matrix (Phase 4.5 WP1a): first write, advance,
    // rollback refusal, corrupt/truncated head, missing head. Run against
    // every hermetic backend (Mem + File). OsKeyStore is covered by the
    // isolation gate below (its head methods must panic in unit tests).

    fn sample_head(seq: u64) -> AuditHead {
        AuditHead {
            seq,
            hash: format!("hash-{seq:04}"),
            mac: format!("mac-{seq:04}"),
        }
    }

    /// Full head contract for one backend instance.
    fn exercise_head_contract(store: &dyn KeyStore, tag: &str) {
        // First write: absent -> stored -> round-trips exactly.
        assert_eq!(store.load_audit_head().unwrap(), None, "{tag}: fresh head absent");
        store.store_audit_head(&sample_head(1)).unwrap();
        assert_eq!(
            store.load_audit_head().unwrap(),
            Some(sample_head(1)),
            "{tag}: first write round-trips"
        );
        // Advance: overwrite with a higher seq.
        store.store_audit_head(&sample_head(2)).unwrap();
        assert_eq!(store.load_audit_head().unwrap().unwrap().seq, 2, "{tag}: advance");
        // Equal-seq re-advance allowed (append races converge).
        store.store_audit_head(&sample_head(2)).unwrap();
        assert_eq!(store.load_audit_head().unwrap().unwrap().seq, 2, "{tag}: equal re-advance");
        // Rollback attempt refused, previous head intact.
        let refused = store.store_audit_head(&sample_head(1));
        assert!(
            matches!(refused, Err(StoreError::Unavailable(_))),
            "{tag}: rollback must be refused, got {refused:?}"
        );
        assert_eq!(
            store.load_audit_head().unwrap().unwrap().seq,
            2,
            "{tag}: refused rollback leaves head intact"
        );
    }

    #[test]
    fn mem_keystore_audit_head_contract() {
        let _g = serial_test_lock();
        let store = MemKeyStore::new();
        exercise_head_contract(&store, "mem");
    }

    #[test]
    fn file_keystore_audit_head_contract() {
        let _g = serial_test_lock();
        let dir = tmp_dir("head-contract");
        let store = FileKeyStore::new(FileKeyStore::default_path(&dir));
        exercise_head_contract(&store, "file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_keystore_corrupt_head_is_unavailable_not_absent() {
        let _g = serial_test_lock();
        let dir = tmp_dir("head-corrupt");
        let path = FileKeyStore::default_path(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Valid vault, present-but-garbage head: corrupt, never "absent".
        std::fs::write(&path, br#"{"audit_head":{"seq":"not-a-number"}}"#).unwrap();
        let store = FileKeyStore::new(path.clone());
        assert!(
            matches!(store.load_audit_head(), Err(StoreError::Unavailable(_))),
            "corrupt head must be Unavailable, not None"
        );
        // Replacement of a corrupt head is allowed (it verifies against
        // nothing); the chain verify still reports Broken until re-sealed.
        store.store_audit_head(&sample_head(7)).unwrap();
        assert_eq!(store.load_audit_head().unwrap().unwrap().seq, 7);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_keystore_truncated_vault_head_is_unavailable() {
        let _g = serial_test_lock();
        let dir = tmp_dir("head-trunc");
        let path = FileKeyStore::default_path(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, b"").unwrap();
        let store = FileKeyStore::new(path);
        assert!(matches!(store.load_audit_head(), Err(StoreError::Unavailable(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_keystore_missing_file_head_is_absent() {
        let _g = serial_test_lock();
        let dir = tmp_dir("head-missing");
        let store = FileKeyStore::new(FileKeyStore::default_path(&dir));
        assert_eq!(store.load_audit_head().unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mem_keystore_injected_failure_is_unavailable() {
        let _g = serial_test_lock();
        let store = MemKeyStore::new();
        *store.fail_all.lock().unwrap() = true;
        assert!(matches!(store.load_audit_head(), Err(StoreError::Unavailable(_))));
        assert!(matches!(
            store.store_audit_head(&sample_head(1)),
            Err(StoreError::Unavailable(_))
        ));
    }

    // --- test isolation: a unit test must never reach the real OS keyring.

    /// If the `assert_not_in_unit_tests` gates were ever removed from
    /// `OsKeyStore`, this test would silently start reading production trust
    /// material. It asserts the guard is compiled into the test build.
    /// One gate probe: label plus the call that must panic.
type GateProbe = (&'static str, Box<dyn Fn() -> bool + 'static>);

#[test]
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn os_keystore_is_blocked_in_unit_tests() {
        let _g = serial_test_lock();
        // Each closure panics inside the gate before any keyring call, so the
        // real store is never read or written.
        let cases: Vec<GateProbe> = vec![
            ("load_mac_key", Box::new(|| OsKeyStore.load_mac_key().is_ok())),
            ("store_mac_key", Box::new(|| OsKeyStore.store_mac_key(b"x").is_ok())),
            ("load_counter", Box::new(|| OsKeyStore.load_counter().is_ok())),
            ("store_counter", Box::new(|| OsKeyStore.store_counter(1).is_ok())),
            ("load_audit_head", Box::new(|| OsKeyStore.load_audit_head().is_ok())),
            (
                "store_audit_head",
                Box::new(|| {
                    OsKeyStore
                        .store_audit_head(&AuditHead {
                            seq: 1,
                            hash: "x".into(),
                            mac: "y".into(),
                        })
                        .is_ok()
                }),
            ),
            ("load_pin_lockouts", Box::new(|| OsKeyStore.load_pin_lockouts().is_ok())),
            ("store_pin_lockouts", Box::new(|| OsKeyStore.store_pin_lockouts("{}").is_ok())),
        ];
        for (name, call) in cases {
            let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(call)).is_err();
            assert!(
                panicked,
                "OsKeyStore::{name} reached the real keyring from a unit test"
            );
        }
    }

    /// Documents the cfg split the isolation guard depends on: under
    /// `cfg(test)` the gate is the panicking variant, and that is exactly what
    /// `os_keystore_is_blocked_in_unit_tests` above asserts. The
    /// non-panicking production variant lives behind the complementary cfg in
    /// the non-test build, so no unit test can exercise it — which is the
    /// point: there is exactly one behaviour per profile.
    #[test]
    #[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
    fn gate_fires_in_test_profile_by_design() {
        // Must panic in the test profile. If this ever stops panicking, the
        // isolation guarantee is gone and unit tests can reach production
        // trust material again.
        let panicked =
            std::panic::catch_unwind(|| assert_not_in_unit_tests("self-test")).is_err();
        assert!(
            panicked,
            "assert_not_in_unit_tests must panic under cfg(test)"
        );
    }
}

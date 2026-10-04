//! Phase 4d — file-level snapshot encryption.
//!
//! Snapshots (`*_mobi_pos_backup_*.db`) used to sit next to the live DB as
//! plaintext SQLite files: anyone who can read the app-data dir owns every
//! wiped/restored/migrated sale. They are now sealed with ChaCha20-Poly1305
//! (AEAD — wrong key or tampered byte fails loudly, never silently) under a
//! per-device 256-bit data key that never leaves the OS keyring (desktop) or
//! the device vault file (mobile, same accepted weakness as the trust vault).
//!
//! Format honesty (stated, not hidden):
//! - The `.db` extension is KEPT and filenames are UNCHANGED: prune, list,
//!   and audit `snapshotId` references are filename-based, so renaming would
//!   orphan evidence. Encrypted vs plaintext is told by MAGIC, not by name:
//!   `MPB1` + 12-byte nonce + ciphertext vs `SQLite format 3\0`.
//! - Key loss = data loss: there is no escrow and no recovery backdoor. The
//!   key is provisioned loudly on first use; its absence later fails closed.
//! - Overwrite hygiene: encrypting replaces the file via atomic rename, but
//!   stale plaintext blocks may linger at the disk layer. This protects the
//!   file-access layer (stolen laptop, curious backup tool), NOT disk
//!   forensics — stated so nobody mistakes it for full-disk encryption.
//! - The KDF story (Phase 4a) does not mint this key: machine-generated
//!   random, 256 bits, no password involved — nothing to stretch.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng},
    ChaCha20Poly1305, Nonce,
};
use zeroize::Zeroizing;

use super::trust_core::ipc_authorizer::TrustError;

/// Magic prefix of an encrypted snapshot: `MPB1` + nonce(12) + ciphertext.
pub const SNAP_MAGIC: &[u8; 4] = b"MPB1";
pub const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

/// True when the file starts with the encrypted-snapshot magic. Missing or
/// short files read as plaintext (they predate encryption or are corrupt —
/// callers decide, this only classifies).
pub fn is_encrypted_snapshot(path: &std::path::Path) -> bool {
    use std::io::Read;
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut magic = [0u8; 4];
    if f.read_exact(&mut magic).is_err() {
        return false;
    }
    &magic == SNAP_MAGIC
}

fn encode_key(key: &[u8; KEY_LEN]) -> String {
    URL_SAFE_NO_PAD.encode(key)
}

fn decode_key(s: &str) -> Result<Zeroizing<[u8; KEY_LEN]>, TrustError> {
    let raw = URL_SAFE_NO_PAD
        .decode(s.trim())
        .map_err(|_| TrustError::SecurityPolicyFailure {
            reason: "backup data key undecodable",
        })?;
    if raw.len() != KEY_LEN {
        return Err(TrustError::SecurityPolicyFailure {
            reason: "backup data key wrong length",
        });
    }
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    key.copy_from_slice(&raw);
    Ok(key)
}

fn random_key() -> Zeroizing<[u8; KEY_LEN]> {
    use chacha20poly1305::aead::rand_core::RngCore;
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    OsRng.fill_bytes(&mut *key);
    key
}

/// Per-device backup data key (32 random bytes, never derived, never synced).
/// Provisioned loudly on first use; any later absence/unreadability fails
/// closed — snapshots would otherwise silently fall back to plaintext.
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(unused_variables))]
pub fn backup_data_key(app_data_dir: &std::path::Path) -> Result<Zeroizing<[u8; KEY_LEN]>, TrustError> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let entry = keyring::Entry::new("mobi-pos-backup", "data-key")
            .map_err(|e| TrustError::op_failed(format!("backup keychain entry: {e}")))?;
        match entry.get_password() {
            Ok(secret) => decode_key(&secret),
            Err(keyring::Error::NoEntry) => {
                let key = random_key();
                entry
                    .set_password(&encode_key(&key))
                    .map_err(|e| TrustError::op_failed(format!("backup keychain save: {e}")))?;
                eprintln!("[snapshot-crypto] provisioned fresh backup data key");
                Ok(key)
            }
            Err(e) => Err(TrustError::op_failed(format!("backup keychain read: {e}"))),
        }
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        // Mobile: no portable keyring — same-filesystem vault file, same
        // accepted weakness as the trust file vault (documented, flagged).
        let path = app_data_dir.join(".backup_data_key.vault");
        match std::fs::read_to_string(&path) {
            Ok(secret) => decode_key(&secret),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let key = random_key();
                std::fs::write(&path, encode_key(&key))
                    .map_err(|e| TrustError::op_failed(format!("backup key vault write: {e}")))?;
                eprintln!("[snapshot-crypto] provisioned fresh backup data key (file vault)");
                Ok(key)
            }
            Err(e) => Err(TrustError::op_failed(format!("backup key vault read: {e}"))),
        }
    }
}

fn seal(key: &[u8; KEY_LEN], plaintext: &[u8]) -> (Vec<u8>, Vec<u8>) {
    use chacha20poly1305::aead::rand_core::RngCore;
    let cipher = ChaCha20Poly1305::new_from_slice(key).expect("32-byte key");
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let mut out = Vec::with_capacity(SNAP_MAGIC.len() + NONCE_LEN + plaintext.len() + 16);
    out.extend_from_slice(SNAP_MAGIC);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(
        &cipher
            .encrypt(nonce, plaintext)
            .expect("in-memory seal cannot fail"),
    );
    (nonce_bytes.to_vec(), out)
}

fn open(key: &[u8; KEY_LEN], sealed: &[u8]) -> Result<Vec<u8>, TrustError> {
    if sealed.len() < SNAP_MAGIC.len() + NONCE_LEN || &sealed[..4] != SNAP_MAGIC {
        return Err(TrustError::SecurityPolicyFailure {
            reason: "not an encrypted snapshot",
        });
    }
    let cipher = ChaCha20Poly1305::new_from_slice(key).expect("32-byte key");
    let nonce = Nonce::from_slice(&sealed[4..4 + NONCE_LEN]);
    cipher
        .decrypt(nonce, &sealed[4 + NONCE_LEN..])
        .map_err(|_| TrustError::SecurityPolicyFailure {
            reason: "snapshot authentication failed (wrong key or tampered file)",
        })
}

/// Encrypt a plaintext snapshot file in place (atomic rename over the
/// original): `MPB1` + nonce + ciphertext. Fails closed with the original
/// untouched when the input is already encrypted, unreadable, or the key is
/// unavailable — a half-sealed snapshot must never exist.
pub fn encrypt_file_in_place(
    path: &std::path::Path,
    key: &[u8; KEY_LEN],
) -> Result<u64, TrustError> {
    if is_encrypted_snapshot(path) {
        return Err(TrustError::SecurityPolicyFailure {
            reason: "snapshot already encrypted",
        });
    }
    let plaintext = std::fs::read(path)
        .map_err(|e| TrustError::op_failed(format!("snapshot read: {e}")))?;
    if plaintext.len() < 100 || &plaintext[..16] != b"SQLite format 3\0" {
        return Err(TrustError::SecurityPolicyFailure {
            reason: "refusing to seal a non-SQLite file as a snapshot",
        });
    }
    let (_nonce, sealed) = seal(key, &plaintext);
    let tmp = path.with_extension("db.seal.tmp");
    std::fs::write(&tmp, &sealed).map_err(|e| TrustError::op_failed(format!("seal tmp write: {e}")))?;
    sync_file(&tmp)?;
    std::fs::rename(&tmp, path).map_err(|e| TrustError::op_failed(format!("seal commit: {e}")))?;
    if let Some(dir) = path.parent() {
        sync_dir(dir);
    }
    Ok(sealed.len() as u64)
}

/// Decrypt an encrypted snapshot to `dest` (created exclusively — never
/// overwrite). Used by manual recovery and integrity re-checks; callers own
/// the PIN gate, the audit row, and the temp-file lifecycle.
pub fn decrypt_file_to(
    path: &std::path::Path,
    key: &[u8; KEY_LEN],
    dest: &std::path::Path,
) -> Result<u64, TrustError> {
    let sealed = std::fs::read(path)
        .map_err(|e| TrustError::op_failed(format!("snapshot read: {e}")))?;
    let plaintext = open(key, &sealed)?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(&plaintext).and_then(|_| f.sync_all())
        })
        .map_err(|e| TrustError::op_failed(format!("snapshot decrypt write: {e}")))?;
    Ok(plaintext.len() as u64)
}

fn sync_file(path: &std::path::Path) -> Result<(), TrustError> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| TrustError::op_failed(format!("fsync ({}): {e}", path.display())))?;
    Ok(())
}

fn sync_dir(dir: &std::path::Path) {
    if let Ok(f) = std::fs::File::open(dir) {
        let _ = f.sync_all();
    }
}

/// One-way legacy migration: seal every plaintext `*_mobi_pos_backup_*.db`
/// in the dir, leaving sealed ones untouched. Runs at boot (janitor lane):
/// failures are collected, never thrown — a corrupt legacy file must not
/// brick startup, and the next boot retries it. Filenames are unchanged, so
/// audit `snapshotId` references survive the migration.
pub struct SealMigration {
    pub sealed: usize,
    pub already: usize,
    pub failed: Vec<String>,
}

pub fn seal_legacy_plaintext(
    backups_dir: &std::path::Path,
    key: &[u8; KEY_LEN],
) -> SealMigration {
    let mut out = SealMigration {
        sealed: 0,
        already: 0,
        failed: vec![],
    };
    let entries = match std::fs::read_dir(backups_dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.contains("_mobi_pos_backup_") || !name.ends_with(".db") {
            continue;
        }
        let path = entry.path();
        if is_encrypted_snapshot(&path) {
            out.already += 1;
            continue;
        }
        match encrypt_file_in_place(&path, key) {
            Ok(_) => out.sealed += 1,
            Err(e) => {
                eprintln!("[snapshot-crypto] legacy seal failed for {name}: {e:?}");
                out.failed.push(name);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> Zeroizing<[u8; KEY_LEN]> {
        Zeroizing::new([7u8; KEY_LEN])
    }

    fn sqlite_like(n: usize) -> Vec<u8> {
        let mut v = b"SQLite format 3\0".to_vec();
        v.extend(std::iter::repeat(0xAB).take(n));
        v
    }

    #[test]
    fn round_trip_preserves_bytes_and_detects_magic() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("snaptest-{}-a.db", uuid::Uuid::new_v4().as_simple()));
        let body = sqlite_like(4096);
        std::fs::write(&path, &body).unwrap();
        assert!(!is_encrypted_snapshot(&path));
        let sealed_len = encrypt_file_in_place(&path, &test_key()).unwrap();
        assert!(sealed_len > body.len() as u64);
        assert!(is_encrypted_snapshot(&path));
        // Second seal refuses (no double-wrap).
        assert!(encrypt_file_in_place(&path, &test_key()).is_err());
        let dest = dir.join(format!("snaptest-{}-b.db", uuid::Uuid::new_v4().as_simple()));
        decrypt_file_to(&path, &test_key(), &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert!(!is_encrypted_snapshot(&dest));
        std::fs::remove_file(&path).ok();
        std::fs::remove_file(&dest).ok();
    }

    #[test]
    fn wrong_key_and_tamper_fail_loudly() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("snaptest-{}-c.db", uuid::Uuid::new_v4().as_simple()));
        std::fs::write(&path, sqlite_like(512)).unwrap();
        encrypt_file_in_place(&path, &test_key()).unwrap();
        let other = Zeroizing::new([9u8; KEY_LEN]);
        let dest = dir.join(format!("snaptest-{}-d.db", uuid::Uuid::new_v4().as_simple()));
        assert!(decrypt_file_to(&path, &other, &dest).is_err());
        // Flip a ciphertext byte: authentication must fail, not "decrypt wrong".
        let mut bytes = std::fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        std::fs::write(&path, &bytes).unwrap();
        assert!(decrypt_file_to(&path, &test_key(), &dest).is_err());
        assert!(!dest.exists(), "failed decrypt must leave no output file");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn refuses_non_sqlite_and_missing() {        let dir = std::env::temp_dir();
        let path = dir.join(format!("snaptest-{}-e.db", uuid::Uuid::new_v4().as_simple()));
        std::fs::write(&path, b"definitely not a database file at all....").unwrap();
        assert!(encrypt_file_in_place(&path, &test_key()).is_err());
        assert!(decrypt_file_to(
            &dir.join("snaptest-no-such-file.db"),
            &test_key(),
            &dir.join("snaptest-no-such-out.db")
        )
        .is_err());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn power_cut_truncated_seal_rejected_cleanly_quarantine_not_crash() {
        // Simulates a kill between seal-tmp commit and completion: valid
        // MPB1 magic + nonce, then TRUNCATED ciphertext. The loader must
        // reject (AEAD/tag check), create no output, and never panic — the
        // operator path is quarantine recovery (decrypt command refuses),
        // not a crash.
        let dir = std::env::temp_dir();
        let tag = uuid::Uuid::new_v4().as_simple().to_string();
        let path = dir.join(format!("snaptest-{tag}-cut.db"));
        std::fs::write(&path, sqlite_like(2048)).unwrap();
        encrypt_file_in_place(&path, &test_key()).unwrap();
        let mut sealed = std::fs::read(&path).unwrap();
        assert!(sealed.len() > 64);
        sealed.truncate(4 + NONCE_LEN + 8); // magic + nonce + fragment
        std::fs::write(&path, &sealed).unwrap();
        // Still classified sealed (magic intact) …
        assert!(is_encrypted_snapshot(&path));
        // … but undecryptable, with zero side effects:
        let dest = dir.join(format!("snaptest-{tag}-cut-out.db"));
        let err = decrypt_file_to(&path, &test_key(), &dest).unwrap_err();
        assert!(
            matches!(err, crate::trust_core::ipc_authorizer::TrustError::SecurityPolicyFailure { .. }),
            "torn seal must fail as authentication failure, got: {err:?}"
        );
        assert!(!dest.exists(), "failed decrypt must leave no output file");
        // Re-seal refuses (already sealed); healing is re-copy + re-seal,
        // never in-place repair of a torn seal.
        assert!(encrypt_file_in_place(&path, &test_key()).is_err());
        std::fs::remove_file(&path).ok();
        // Staging residue never pollutes the register: list/prune match
        // `ends_with(".db")`, and `*.db.seal.tmp` ends with `.tmp`.
        assert!(!"wipe_mobi_pos_backup_1_ab12cd34.db.seal.tmp".ends_with(".db"));
    }

    #[test]
    fn key_encoding_round_trips_and_rejects_garbage() {
        let k = test_key();
        let enc = encode_key(&k);
        let back = decode_key(&enc).unwrap();
        assert_eq!(&*back, &[7u8; KEY_LEN]);
        assert!(decode_key("!!!not-base64!!!").is_err());
        assert!(decode_key(&URL_SAFE_NO_PAD.encode([1u8; 16])).is_err());
    }

    #[test]
    fn legacy_migration_seals_only_plaintext_and_reports() {
        let dir = std::env::temp_dir().join(format!("snaptest-mig-{}", uuid::Uuid::new_v4().as_simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let plain = dir.join("wipe_mobi_pos_backup_1_aaaaaaaa.db");
        std::fs::write(&plain, sqlite_like(512)).unwrap();
        let other = dir.join("notes.txt");
        std::fs::write(&other, b"ignore me").unwrap();
        let key = [3u8; KEY_LEN];
        let first = seal_legacy_plaintext(&dir, &key);
        assert_eq!((first.sealed, first.already), (1, 0));
        assert!(first.failed.is_empty());
        assert!(is_encrypted_snapshot(&plain));
        // Second run: nothing left to do.
        let second = seal_legacy_plaintext(&dir, &key);
        assert_eq!((second.sealed, second.already), (0, 1));
        assert!(second.failed.is_empty());
        // Corrupt legacy file: reported, not fatal, not sealed.
        let bad = dir.join("wipe_mobi_pos_backup_2_bbbbbbbb.db");
        std::fs::write(&bad, b"too short").unwrap();
        let third = seal_legacy_plaintext(&dir, &key);
        assert_eq!(third.failed, vec!["wipe_mobi_pos_backup_2_bbbbbbbb.db".to_string()]);
        assert!(!is_encrypted_snapshot(&bad));
        std::fs::remove_dir_all(&dir).ok();
    }
}

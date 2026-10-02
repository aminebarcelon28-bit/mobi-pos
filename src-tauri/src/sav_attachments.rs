//! SAV intake photo attachments (Phase 5).
//!
//! Decision (owner-locked): photo BYTES never enter SQLite. They land on the
//! local filesystem under `app_data_dir/sav_attachments/`, and only a
//! RELATIVE path plus the SHA-256 of the stored bytes travel to the database.
//! The checksum is the tamper-evidence anchor for restitution disputes: a
//! later edit of the image changes the hash and the mismatch is detectable.
//!
//! Security posture:
//!  • Dedicated native command — never reachable through generic SQL.
//!  • `OperationalWrites` capability: refuses to run in a locked terminal.
//!  • Path traversal is impossible by construction: the client sends only an
//!    ORDER ID and an INDEX, and the filename is built here. Any residual
//!    character is rejected, not sanitized-and-hoped-for.
//!  • Absolute paths are never returned or accepted; the caller receives a
//!    relative path only.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::trust_core::capability_policy::Capability;
use crate::trust_core::ipc_authorizer::{authorize_and_execute, TrustError};

/// Hard ceiling per photo (compressed WebP). Anything larger is a caller bug
/// or an attempt to fill the volume; refuse rather than truncate.
const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;

/// Age gate for the crash-orphan sweep (owner-set 2026-10-02).
///
/// A staged-but-uncommitted intake lives under the `draft_<ts>_<n>.webp`
/// naming and is normally swept by the modal on every close path. This gate
/// exists ONLY for the case that path cannot reach: the process was killed
/// (power cut, force-quit, crash) between staging and commit. 24 h is far
/// longer than any in-progress intake session, so an active ticket — including
/// one recovered after a crash — can never have its photos swept underneath it.
const STALE_DRAFT_MIN_AGE_MS: u64 = 24 * 60 * 60 * 1000;

/// Prefix marking a staged, not-yet-committed intake (`draft_<epoch_ms>_<n>`).
const DRAFT_PREFIX: &str = "draft_";

/// Extract the staging id (the `draft_<ts>` part) from a filename, or `None`
/// if this is not a draft attachment.
///
/// Accepts ONLY names this module could have written: the `draft_` prefix, an
/// all-digit epoch, and a `_<index>.webp` suffix. Anything else is left alone
/// rather than guessed at — a committed ticket's `rep_*` evidence must never
/// be swept by the orphan pass.
fn draft_id_from_filename(name: &str) -> Option<String> {
    let rest = name.strip_prefix(DRAFT_PREFIX)?;
    // Split at the LAST '_' so the id is `draft_<ts>` and the tail is `<n>.webp`.
    let (ts, tail) = rest.rsplit_once('_')?;
    if ts.is_empty() || !ts.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let idx = tail.strip_suffix(".webp")?;
    if idx.is_empty() || !idx.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(format!("{DRAFT_PREFIX}{ts}"))
}

/// Sweep orphaned staged intake photos left by a crash or hard kill.
///
/// Complements (does NOT replace) the modal's close-path sweep: that one runs
/// only while the app lives, so it cannot clean up after a power cut. This
/// runs at startup and deletes `draft_*` attachments whose mtime is older than
/// [`STALE_DRAFT_MIN_AGE_MS`].
///
/// Safety properties, matching `sav_attachment_purge`:
///  • capability-gated (`OperationalWrites`) — refuses in a locked terminal;
///  • enumerates the fixed `attachments_dir` only; the caller supplies no
///    path, so traversal is impossible by construction (this is the reason
///    this is a dedicated command rather than a file-list cleanup API);
///  • unlinks regular files only, never following a symlink out of the dir;
///  • age-gated, so a live or crash-recovered intake is never touched.
/// Fail-soft by design: a cleanup failure must never block boot, so every
/// error is swallowed into a count of removed files.
#[tauri::command]
pub fn sav_attachment_sweep_stale_drafts(app: tauri::AppHandle) -> Result<u32, TrustError> {
    authorize_and_execute(
        "sav_attachment_sweep_stale_drafts",
        Capability::OperationalWrites,
        |_| {
            let dir = attachments_dir(&app)?;
            let Ok(entries) = std::fs::read_dir(&dir) else {
                return Ok(0);
            };
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            // Group by staging id and require EVERY file for an id to be stale
            // before removing any: a partially-staged id is assumed in use.
            let mut ids: std::collections::BTreeMap<String, (bool, Vec<PathBuf>)> =
                std::collections::BTreeMap::new();
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let Some(id) = draft_id_from_filename(&name) else {
                    continue;
                };
                let is_file = entry.file_type().map(|ft| ft.is_file()).unwrap_or(false);
                if !is_file {
                    continue;
                }
                let age_ok = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| {
                        now_ms.saturating_sub(d.as_millis() as u64) >= STALE_DRAFT_MIN_AGE_MS
                    })
                    .unwrap_or(false);
                let slot = ids.entry(id).or_insert((true, Vec::new()));
                slot.0 &= age_ok;
                slot.1.push(entry.path());
            }

            let mut removed = 0u32;
            for (_id, (all_stale, paths)) in ids {
                if !all_stale {
                    continue;
                }
                for path in paths {
                    if std::fs::remove_file(&path).is_ok() {
                        removed += 1;
                    }
                }
            }
            Ok(removed)
        },
    )
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

/// Alphanumeric-only allowlist. A repair order id is generated by the app
/// (`newId('rep')`), so anything outside this set is not one of ours.
fn is_safe_component(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 64
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn attachments_dir(app: &tauri::AppHandle) -> Result<PathBuf, TrustError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("app_data_dir: {e}")))?
        .join("sav_attachments");
    std::fs::create_dir_all(&dir).map_err(|e| TrustError::op_failed(format!("mkdir sav_attachments: {e}")))?;
    Ok(dir)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavAttachmentWriteRequest {
    /// Owner's repair order id (as generated by the app).
    pub order_id: String,
    /// Zero-based position within the ticket.
    pub index: u32,
    /// Base64 (standard alphabet) of the already-compressed image bytes.
    pub data_base64: String,
    /// Fixed extension; only `webp` is accepted today.
    pub extension: String,
}

#[derive(Debug, Serialize)]
pub struct SavAttachmentWriteResult {
    /// Relative path (never absolute) recorded on the repair order.
    pub relative_path: String,
    pub sha256: String,
    pub byte_size: usize,
}

/// Write one intake photo. Returns the relative path + checksum for the DB.
#[tauri::command]
pub fn sav_attachment_write(
    app: tauri::AppHandle,
    request: SavAttachmentWriteRequest,
) -> Result<SavAttachmentWriteResult, TrustError> {
    authorize_and_execute("sav_attachment_write", Capability::OperationalWrites, |_| {
        if !is_safe_component(&request.order_id) {
            return Err(TrustError::IPCProtocolError {
                reason: "invalid order id",
            });
        }
        if !request.extension.eq_ignore_ascii_case("webp") {
            return Err(TrustError::IPCProtocolError {
                reason: "unsupported attachment type",
            });
        }
        let bytes = STANDARD
            .decode(request.data_base64.as_bytes())
            .map_err(|_| TrustError::IPCProtocolError {
                reason: "attachment payload is not valid base64",
            })?;
        if bytes.is_empty() {
            return Err(TrustError::IPCProtocolError {
                reason: "empty attachment",
            });
        }
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(TrustError::StorageExhausted {
                detail: format!("attachment {} bytes exceeds per-file limit", bytes.len()),
            });
        }

        let filename = format!("{}_{}.webp", request.order_id, request.index);
        let path = attachments_dir(&app)?.join(&filename);
        // Build the relative path once and use it for both the write target
        // and the returned evidence row — they can never disagree.
        let relative_path = format!("sav_attachments/{filename}");

        std::fs::write(&path, &bytes).map_err(|e| TrustError::op_failed(format!("write attachment: {e}")))?;

        let digest = hex(&Sha256::digest(&bytes));
        Ok(SavAttachmentWriteResult {
            relative_path,
            sha256: digest,
            byte_size: bytes.len(),
        })
    })
}

#[derive(Debug, Serialize)]
pub struct SavAttachmentReadResult {
    pub sha256: String,
    pub byte_size: usize,
    pub data_base64: String,
}

/// Read one attachment back (display on the work order / dispute review) and
/// re-verify the checksum so a corrupted or swapped file is DETECTED, not
/// silently rendered.
#[tauri::command]
pub fn sav_attachment_read(
    app: tauri::AppHandle,
    relative_path: String,
) -> Result<SavAttachmentReadResult, TrustError> {
    authorize_and_execute("sav_attachment_read", Capability::ReadOperationalData, |_| {
        let rel = relative_path.trim();
        if rel.is_empty() || rel.starts_with('/') || rel.contains('\\') || rel.contains("..") {
            return Err(TrustError::IPCProtocolError {
                reason: "invalid attachment path",
            });
        }
        let name = rel.rsplit('/').next().unwrap_or("");
        if !is_safe_component(name) {
            return Err(TrustError::IPCProtocolError {
                reason: "invalid attachment name",
            });
        }
        let path: PathBuf = attachments_dir(&app)?.join(name);
        let bytes =
            std::fs::read(&path).map_err(|e| TrustError::op_failed(format!("read attachment: {e}")))?;
        let digest = hex(&Sha256::digest(&bytes));
        let byte_size = bytes.len();
        Ok(SavAttachmentReadResult {
            sha256: digest,
            byte_size,
            data_base64: STANDARD.encode(&bytes),
        })
    })
}

/// Remove every attachment belonging to one order (order deleted / cancelled).
#[tauri::command]
pub fn sav_attachment_purge(
    app: tauri::AppHandle,
    order_id: String,
) -> Result<u32, TrustError> {
    authorize_and_execute("sav_attachment_purge", Capability::OperationalWrites, |_| {
        if !is_safe_component(&order_id) {
            return Err(TrustError::IPCProtocolError {
                reason: "invalid order id",
            });
        }
        let dir = attachments_dir(&app)?;
        let prefix = format!("{order_id}_");
        let mut removed = 0u32;
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with(&prefix) {
                    continue;
                }
                let candidate: &Path = &entry.path();
                // Only unlink regular files we own (never follow a symlink out).
                match entry.file_type() {
                    Ok(ft) if ft.is_file() => {
                        if std::fs::remove_file(candidate).is_ok() {
                            removed += 1;
                        }
                    }
                    _ => {}
                }
            }
        }
        Ok(removed)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_id_parsing_accepts_only_names_this_module_wrote() {
        // The shape the modal stages: `draft_<epoch_ms>_<index>.webp`.
        assert_eq!(
            draft_id_from_filename("draft_1712345678901_0.webp").as_deref(),
            Some("draft_1712345678901")
        );
        assert_eq!(
            draft_id_from_filename("draft_1712345678901_12.webp").as_deref(),
            Some("draft_1712345678901")
        );
        // Multi-digit epochs must still split at the LAST underscore.
        assert_eq!(
            draft_id_from_filename("draft_999999999999999_3.webp").as_deref(),
            Some("draft_999999999999999")
        );
    }

    #[test]
    fn draft_id_parsing_never_touches_committed_evidence() {
        // Committed ticket evidence (`rep_*`, `batch-return-*`) must never be
        // classified as a draft, or the orphan sweep could delete a real
        // restitution dispute exhibit.
        for name in [
            "rep_abc123_0.webp",
            "REP-2024-0001_1.webp",
            "batch-return-void-1-400-0_0.webp",
            "draftish_1_0.webp",   // prefix is `draft_` — `draftish` is not
            "draft__0.webp",       // empty epoch
            "draft_abc_0.webp",    // non-digit epoch
            "draft_123_.webp",      // empty index
            "draft_123_x.webp",    // non-digit index
            "draft_123_0.png",     // wrong extension
            "draft_123_0.webp.exe",
            "",
            "..",
        ] {
            assert_eq!(
                draft_id_from_filename(name),
                None,
                "must not be sweepable: {name:?}"
            );
        }
    }

    #[test]
    fn component_allowlist_rejects_traversal_and_separators() {
        assert!(is_safe_component("rep_123abc"));
        assert!(is_safe_component("REP-2024-0001"));
        assert!(!is_safe_component("../etc"));
        assert!(!is_safe_component("a/b"));
        assert!(!is_safe_component("a\\b"));
        assert!(!is_safe_component(""));
        assert!(!is_safe_component(&"x".repeat(65)));
    }

    #[test]
    fn hex_is_lowercase_fixed_width() {
        assert_eq!(hex(&[0x00, 0x0f, 0xff]), "000fff");
    }
}
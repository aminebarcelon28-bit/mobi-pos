//! Scoped, read-only compliance exporter.
//!
//! ARCHITECTURAL ROLE
//! This module is deliberately reachable ONLY from the licensing gate. It is
//! the single sanctioned way to extract financial records from a terminal
//! whose licence is not in `ACTIVE` state, so it is built to the opposite
//! standard from the rest of the app:
//!
//! * It never touches the application lifecycle. It does not import the POS
//!   store, the sync engine, the adapters, or `tauri_plugin_sql`. It opens its
//!   OWN connection with `SQLITE_OPEN_READ_ONLY` and pins `query_only = ON`, so
//!   a write attempt fails inside the SQLite engine, not in JS.
//! * The column allowlists below are the security boundary. `SELECT *` is
//!   forbidden: new columns added by a later migration must never silently
//!   start shipping customer PII, tokens, or secrets into an export file.
//! * Rows are streamed statement-by-statement into a `BufWriter`. Nothing is
//!   ever materialised into a `Vec`, so a multi-gigabyte ledger exports in
//!   constant memory.
//!
//! The ONE write this module performs is the tamper-evident audit row. It uses
//! a SEPARATE read-write connection and a single hardcoded, fully-parameterised
//! INSERT — the export data path itself stays read-only, so a bug in the
//! streaming code still cannot mutate a single record.

use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

use crate::trust_core::{
    audit_append::{chain_status_for_export, verify_audit_chain_full},
    capability_policy::Capability,
    export_snapshot::{
        acquire_snapshot, check_preflight, cleanup_stale_staging, finalize_export_dir, fsync_dir,
        integrity_state_for_license, open_snapshot_ro, staging_paths, try_acquire_export,
        write_manifest, ManifestFileEntry, ManifestInput, ManifestMac, StagingGuard,
    },
    ipc_authorizer::{authorize_and_execute, select_store, TrustError},
    secure_storage::{resolve_mac_key, KeyResolution},
    time_engine::global_time_kernel,
};

// ── Request / response contracts ────────────────────────────────────────────

/// Tables the exporter is permitted to read. Anything not in this enum cannot
/// be requested, so the scope is enforced by the type system rather than by
/// validating a string at runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AllowedTable {
    /// Sales journal header (VAT-bearing).
    SalesJournal,
    /// Sales journal line detail.
    SalesJournalLines,
    /// Shift / Z-report sessions.
    ShiftSessions,
    /// Cash movements inside a session.
    ShiftMovements,
}

impl AllowedTable {
    fn from_key(key: &str) -> Option<Self> {
        match key {
            "sales_journal" => Some(Self::SalesJournal),
            "sales_journal_lines" => Some(Self::SalesJournalLines),
            "shift_sessions" => Some(Self::ShiftSessions),
            "shift_movements" => Some(Self::ShiftMovements),
            _ => None,
        }
    }

    fn file_stem(self) -> &'static str {
        match self {
            Self::SalesJournal => "sales_journal",
            Self::SalesJournalLines => "sales_journal_lines",
            Self::ShiftSessions => "shift_sessions",
            Self::ShiftMovements => "shift_movements",
        }
    }

    /// Hardcoded, explicit column list. NEVER `SELECT *`.
    ///
    /// Deliberately EXCLUDED everywhere:
    /// * `customer_id` / `cashier_name` — links a financial record back to a
    ///   natural person. Retention duties are satisfied by amount, date, tax
    ///   and receipt number alone.
    /// * `json_payload` — an opaque blob that mirrors the full domain object
    ///   and is the most likely place for a future migration to add PII.
    /// * `imei_number` — device identifier, warranty data, not fiscal data.
    /// * any `idempotency_key` / `sync_status` — transport internals.
    fn sql(self) -> &'static str {
        match self {
            Self::SalesJournal => {
                "SELECT receipt_number, created_at, status, subtotal, tax, discount_total, \
                 total, payment_method, cash_tendered, change_due, shift_id, device_id \
                 FROM transactions WHERE deleted = 0 ORDER BY created_at, receipt_number"
            }
            Self::SalesJournalLines => {
                "SELECT i.transaction_id, t.receipt_number, i.product_id, i.quantity, \
                 i.applied_price, i.discount_amount, i.unit_cost_at_sale, i.line_profit, \
                 i.created_at \
                 FROM transaction_items i \
                 JOIN transactions t ON t.id = i.transaction_id \
                 WHERE i.deleted = 0 AND t.deleted = 0 \
                 ORDER BY t.created_at, t.receipt_number, i.id"
            }
            Self::ShiftSessions => {
                "SELECT id, opened_at, closed_at, opening_float, expected_cash, actual_cash, \
                 discrepancy, status, device_id \
                 FROM cash_sessions ORDER BY opened_at, id"
            }
            Self::ShiftMovements => {
                // NOTE: cash_movements has no `device_id` column on the live
                // schema (verified against mobi_pos.db). Referencing it would
                // fail the whole export at runtime.
                "SELECT session_id, type, amount, reason, created_at \
                 FROM cash_movements ORDER BY created_at, id"
            }
        }
    }
}

/// Everything the exporter needs, and nothing it does not.
///
/// Phase 1 (B.7): there is deliberately NO client-supplied license field.
/// The native kernel determines the license state and records its own coarse
/// code in the audit row and result. Any `licenseStatus` key sent by older
/// clients is ignored by serde.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmergencyExportRequest {
    /// Owner / manager PIN, verified inside this module against the stored
    /// hash. Never logged, never returned, never persisted in plaintext.
    pub pin: String,
    /// Subset of allowed tables. Empty means "all allowed tables".
    #[serde(default)]
    pub tables: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedFile {
    pub table: String,
    pub file_name: String,
    pub absolute_path: String,
    pub row_count: u64,
    pub byte_len: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmergencyExportResult {
    pub export_dir: String,
    pub files: Vec<ExportedFile>,
    pub audit_event_id: String,
    pub authorized_admin_id: String,
    pub license_status_at_export: String,
    pub completed_at: String,
    /// Absolute path of the external manifest (`manifest.json`).
    pub manifest_path: String,
    /// Top-level SHA-256 over the per-file hashes (see manifest).
    pub export_sha256: String,
    /// HMAC-SHA256 over the canonical manifest bytes (`None` when no trust
    /// key was available — recorded in the manifest, never faked).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_mac: Option<String>,
    /// Quarantine posture at export: `"clean"`, `"tamper"`, or `"clock"`.
    /// MAC-covered in the manifest; the verifier shows non-clean as flagged.
    pub integrity_state: String,
    /// Set when the DB audit row could not be written. The export still
    /// succeeded; the failure is recorded in the manifest instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit_error: Option<String>,
}

// ── Hashing writer ──────────────────────────────────────────────────────────

/// Wraps the output file so the SHA-256 is computed as bytes stream past.
/// Avoids a second full read of the file just to digest it.
struct HashingWriter<W: Write> {
    inner: W,
    hasher: Sha256,
    written: u64,
}

impl<W: Write> HashingWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            written: 0,
        }
    }

    fn finish(self) -> (Sha256, u64) {
        (self.hasher, self.written)
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        self.written += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

// ── CSV encoding ────────────────────────────────────────────────────────────

/// RFC 4180 field encoding plus spreadsheet-injection neutralisation.
///
/// A compliance CSV is very likely to be opened in Excel, which executes a
/// leading `=`, `+`, `-` or `@` as a formula. Financial columns are numeric
/// here, but the guard is applied unconditionally so a future text column
/// cannot become an injection vector.
fn csv_field(value: &ValueRef<'_>) -> String {
    let raw = match value {
        ValueRef::Null => String::new(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => {
            if f.is_finite() {
                // Fixed 2dp: fiscal ledgers are centime-denominated.
                format!("{:.2}", f)
            } else {
                String::new()
            }
        }
        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        ValueRef::Blob(_) => String::new(),
    };
    // Stage 1/E: strictly numeric values are exempt — a pure number cannot
    // execute as a formula, and prefixing one would corrupt amounts (and
    // coerce "-42" to text). The rule is tight on purpose: optional single
    // leading `-`, ASCII digits, optional single `.fraction`. Anything else
    // starting with a trigger stays guarded ("-1+1", "+7", ".5"); a leading
    // space is text by position, while leading TAB/CR (which trimmers can
    // strip to expose a trigger) are guarded below.
    fn is_plain_number(s: &str) -> bool {
        let b = s.as_bytes();
        if b.is_empty() {
            return false;
        }
        let mut i = 0;
        if b[0] == b'-' {
            i = 1;
            if b.len() < 2 {
                return false;
            }
        }
        let mut digits = 0;
        while i < b.len() && b[i].is_ascii_digit() {
            digits += 1;
            i += 1;
        }
        if digits == 0 {
            return false;
        }
        if i < b.len() {
            if b[i] != b'.' {
                return false;
            }
            i += 1;
            let mut frac = 0;
            while i < b.len() && b[i].is_ascii_digit() {
                frac += 1;
                i += 1;
            }
            if frac == 0 {
                return false;
            }
        }
        i == b.len()
    }
    let guarded = if is_plain_number(&raw) {
        raw
    } else if raw
        .chars()
        .next()
        .map(|c| matches!(c, '=' | '+' | '-' | '@' | '\t' | '\r'))
        .unwrap_or(false)
    {
        format!("'{raw}")
    } else {
        raw
    };
    if guarded.contains(',') || guarded.contains('"') || guarded.contains('\n') || guarded.contains('\r')
    {
        format!("\"{}\"", guarded.replace('"', "\"\""))
    } else {
        guarded
    }
}

fn csv_row(values: &[ValueRef<'_>]) -> String {
    let mut out = String::with_capacity(64);
    for (i, v) in values.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&csv_field(v));
    }
    out.push_str("\r\n");
    out
}

// ── Connection helpers ──────────────────────────────────────────────────────

/// Open a database strictly read-only.
///
/// Production export no longer opens the live DB directly (snapshots carry
/// their own read-only open); retained for the read-only-guarantee test.
#[cfg(test)]
fn open_read_only(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Ouverture en lecture seule impossible: {e}"))?;
    // Belt and braces: survives a future refactor that swaps the open flags.
    conn.execute_batch("PRAGMA query_only = ON;")
        .map_err(|e| format!("PRAGMA query_only impossible: {e}"))?;
    Ok(conn)
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Chemin applicatif introuvable: {e}"))?;
    let p = dir.join("mobi_pos.db");
    if !p.exists() {
        return Err("Base de données locale introuvable — rien à exporter.".into());
    }
    Ok(p)
}

// ── Owner / manager authentication ──────────────────────────────────────────

/// Outcome of verifying the supplied PIN against the stored credential.
struct AuthOutcome {
    admin_id: String,
}

/// Verify the PIN against the stored `v1$salt$digest` manager hash.
///
/// This mirrors `hashPin` in `src/utils/security.ts` exactly
/// (`sha256("{salt}:{pin}:mobi_pos_salt_v1")`). The comparison is
/// constant-time-ish (full-length XOR accumulation) and FAILS CLOSED on every
/// ambiguous input: no stored hash, a malformed hash, or a non-`v1$` value all
/// reject. A legacy plaintext PIN is deliberately NOT accepted.
fn verify_pin(pin: &str, stored: &str) -> bool {
    let stored = stored.trim();
    if stored.is_empty() || pin.is_empty() {
        return false;
    }
    let mut parts = stored.split('$');
    let version = parts.next().unwrap_or("");
    let salt = match parts.next() {
        Some(s) => s,
        None => return false,
    };
    let expected = match parts.next() {
        Some(d) => d,
        None => return false,
    };
    if parts.next().is_some() || version != "v1" || salt.is_empty() || expected.is_empty() {
        return false;
    }
    let mut hasher = Sha256::new();
    hasher.update(format!("{salt}:{}:mobi_pos_salt_v1", pin.trim()).as_bytes());
    let computed = {
        let digest = hasher.finalize();
        digest.iter().map(|b| format!("{b:02x}")).collect::<String>()
    };
    if computed.len() != expected.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in computed.bytes().zip(expected.bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// Read a `app_settings.value_json` cell as a plain string.
///
/// The column holds JSON, and in practice BOTH encodings occur in the wild:
/// a bare `v1$salt$hash` and a JSON *string literal* `"v1$salt$hash"` (the
/// latter is what the current build writes — a raw parse of the stored text
/// yields a value with leading/trailing quotes, which would then fail
/// verification and lock the merchant out of their own records). Try a JSON
/// string decode first, then fall back to the raw text, then to a quoted-strip
/// so all three historical shapes resolve.
fn read_setting_text(raw: Option<String>) -> String {
    let raw = match raw {
        Some(v) => v,
        None => return String::new(),
    };
    if let Ok(decoded) = serde_json::from_str::<String>(&raw) {
        return decoded.trim().to_string();
    }
    let trimmed = raw.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        return trimmed[1..trimmed.len() - 1].to_string();
    }
    trimmed.to_string()
}

/// Read the stored manager hash and verify the supplied PIN.
///
/// The hash is read through the SAME read-only connection used for the export
/// data path, so authentication cannot be satisfied by a writable DB handle.
fn authenticate_owner(conn: &Connection, pin: &str) -> Result<AuthOutcome, String> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = 'manager_pin' LIMIT 1",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|e| format!("Lecture du credential impossible: {e}"))?;

    let stored_hash = read_setting_text(stored);
    if stored_hash.is_empty() {
        return Err(
            "Aucun PIN gérant n'est défini sur ce terminal. L'export d'urgence est refusé."
                .into(),
        );
    }

    if !verify_pin(pin, &stored_hash) {
        return Err("PIN gérant incorrect. Export refusé.".into());
    }

    // Single-PIN contract (createUISlice): the manager IS the primary admin
    // row, so the verified manager is the authorizing admin. The id is read
    // from the roster for the audit trail only.
    let roster_json: Option<String> = conn
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = 'cashier_users' LIMIT 1",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();

    let admin_id = roster_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| {
            v.as_array()?.iter().find_map(|u| {
                if u.get("role").and_then(|r| r.as_str()) == Some("admin") {
                    u.get("id").and_then(|i| i.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            })
        })
        .unwrap_or_else(|| "admin".to_string());

    Ok(AuthOutcome { admin_id })
}

// ── Streaming export ────────────────────────────────────────────────────────

/// Progress sink: receives (table, rows_so_far) every few thousand rows.
/// Kept as a plain callback so the streaming core is unit-testable without a
/// live `AppHandle` (and so a future headless CLI exporter needs no Tauri).
type ProgressFn<'a> = &'a (dyn Fn(&str, u64) + Send + Sync);

/// Stream one table to a CSV file, returning (row_count, sha256, byte_len).
/// `quota` caps total bytes for this file: exhaustion fails with typed
/// `StorageExhausted` (low-disk guard even when preflight raced a filler).
fn stream_table(
    conn: &Connection,
    table: AllowedTable,
    out_path: &Path,
    on_progress: ProgressFn<'_>,
    quota: Option<u64>,
) -> Result<(u64, String, u64), TrustError> {
    use std::io::ErrorKind;
    let map_write_err = |e: std::io::Error, table: AllowedTable| -> TrustError {
        if e.kind() == ErrorKind::StorageFull {
            TrustError::StorageExhausted {
                detail: format!(
                    "Espace insuffisant pendant l'export de {} (quota atteint).",
                    table.file_stem()
                ),
            }
        } else {
            TrustError::op_failed(format!("Écriture CSV impossible: {e}"))
        }
    };

    let file = File::create(out_path)
        .map_err(|e| TrustError::op_failed(format!("Création du fichier impossible ({}): {e}", out_path.display())))?;
    // Quota wrapper sits UNDER the buffer so partial buffer flushes count.
    let counting: Box<dyn Write> = match quota {
        Some(limit) => Box::new(QuotaFile::new(file, limit)),
        None => Box::new(file),
    };
    let mut writer = HashingWriter::new(std::io::BufWriter::with_capacity(256 * 1024, counting));

    let mut stmt = conn
        .prepare(table.sql())
        .map_err(|e| TrustError::op_failed(format!("Préparation de la requête [{}] impossible: {e}", table.file_stem())))?;

    let column_count = stmt.column_count();
    let mut names = Vec::with_capacity(column_count);
    for i in 0..column_count {
        names.push(stmt.column_name(i).unwrap_or("col").to_string());
    }
    writer
        .write_all(names.join(",").as_bytes())
        .and_then(|_| writer.write_all(b"\r\n"))
        .map_err(|e| map_write_err(e, table))?;

    let mut rows = stmt
        .query([])
        .map_err(|e| TrustError::op_failed(format!("Lecture [{}] impossible: {e}", table.file_stem())))?;

    let mut row_count: u64 = 0;
    while let Some(row) = rows
        .next()
        .map_err(|e| TrustError::op_failed(format!("Lecture [{}] interrompue: {e}", table.file_stem())))?
    {
        let values: Vec<ValueRef<'_>> = (0..column_count)
            .map(|i| row.get_ref(i))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| TrustError::op_failed(format!("Décodage de ligne impossible: {e}")))?;
        writer
            .write_all(csv_row(&values).as_bytes())
            .map_err(|e| map_write_err(e, table))?;
        row_count += 1;

        // Coarse progress so the gate UI can show liveness on a long export.
        if row_count.is_multiple_of(5_000) {
            on_progress(table.file_stem(), row_count);
        }
    }

    writer
        .flush()
        .map_err(|e| map_write_err(e, table))?;
    let (hasher, bytes) = writer.finish();
    let digest = hasher.finalize();
    let sha = digest.iter().map(|b| format!("{b:02x}")).collect::<String>();
    Ok((row_count, sha, bytes))
}

/// Write adapter enforcing a byte quota. Exhaustion surfaces as
/// `ErrorKind::StorageFull` so callers map it to typed `StorageExhausted`
/// instead of a generic I/O failure.
struct QuotaFile {
    inner: File,
    remaining: u64,
}

impl QuotaFile {
    fn new(inner: File, quota: u64) -> Self {
        Self {
            inner,
            remaining: quota,
        }
    }
}

impl Write for QuotaFile {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if buf.len() as u64 > self.remaining {
            return Err(std::io::Error::new(
                std::io::ErrorKind::StorageFull,
                "export byte quota exhausted",
            ));
        }
        let n = self.inner.write(buf)?;
        self.remaining -= n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}
// ── Tamper-evident audit (the one sanctioned write) ─────────────────────────

/// Append the `EMERGENCY_DATA_EXPORT` audit row.
///
/// Uses its own read-write connection and one hardcoded, fully parameterised
/// INSERT. `details` is a compact JSON blob so the row is greppable by an
/// auditor and machine-checkable against the exported file's SHA-256.
fn write_audit_event(
    app: &AppHandle,
    admin_id: &str,
    license_status: &str,
    integrity_state: &str,
    manifest_error: Option<&str>,
    files: &[ExportedFile],
) -> Result<String, String> {
    let path = db_path(app)?;
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Ouverture du journal d'audit impossible: {e}"))?;
    // Give the audit insert a moment rather than failing the whole export if
    // a writer momentarily holds the lock — but never silently skip the row.
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!(" busy_timeout impossible: {e}"))?;

    let event_id = format!("AUD-EXP-{}", now_millis());
    let timestamp = now_iso8601();
    let details = serde_json::json!({
        "licenseStatus": license_status,
        "integrityState": integrity_state,
        "authorizedAdminId": admin_id,
        "fileCount": files.len(),
        "files": files.iter().map(|f| serde_json::json!({
            "table": f.table,
            "fileName": f.file_name,
            "rowCount": f.row_count,
            "byteLen": f.byte_len,
            "sha256": f.sha256,
        })).collect::<Vec<_>>(),
    });
    // A manifest failure is recorded on the failure-path audit row (no PII:
    // file names and counts only, same shape as above).
    let details = match manifest_error {
        Some(e) => serde_json::json!({ "manifestError": e, "attempt": details }),
        None => details,
    };

    conn.execute(
        "INSERT OR REPLACE INTO security_audit_logs \
         (id, timestamp, user, action, details, requires_pin, device_id) \
         VALUES (?1, ?2, ?3, 'EMERGENCY_DATA_EXPORT', ?4, 1, ?5)",
        rusqlite::params![
            event_id,
            timestamp,
            admin_id,
            details.to_string(),
            "local-emergency-export"
        ],
    )
    .map_err(|e| format!("Écriture de l'audit impossible: {e}"))?;

    Ok(event_id)
}

// ── Entry point ─────────────────────────────────────────────────────────────

/// Extract the compliance dataset from a locked terminal.
///
/// Phase 3 export pipeline (plain SQLite):
/// authorize → single-export ownership → table allowlist → storage
/// preflight → consistent snapshot (online backup; trio-copy recovery when
/// the live will not open) → PIN auth ON THE SNAPSHOT → stream CSVs into
/// staging with byte quota → external manifest → best-effort audit row →
/// atomic finalize. No step mutates the live DB except the sanctioned,
/// non-blocking audit INSERT; sync_outbox is never touched.
///
/// Order matters: authenticate against the snapshot before streaming, so an
/// unauthorised caller cannot even learn how many records exist.
#[tauri::command]
pub fn emergency_export_ledger(
    app: AppHandle,
    request: EmergencyExportRequest,
) -> Result<EmergencyExportResult, TrustError> {
    authorize_and_execute(
        "emergency_export_ledger",
        Capability::EmergencyExport,
        |ctx| {
            // 0. Resolve requested tables against the allowlist (pure).
            let requested: Vec<AllowedTable> = if request.tables.is_empty() {
                vec![
                    AllowedTable::SalesJournal,
                    AllowedTable::SalesJournalLines,
                    AllowedTable::ShiftSessions,
                    AllowedTable::ShiftMovements,
                ]
            } else {
                let mut out = Vec::new();
                for key in &request.tables {
                    let t = AllowedTable::from_key(key).ok_or(TrustError::IPCProtocolError {
                        reason: "table non autorisée pour l'export",
                    })?;
                    if !out.contains(&t) {
                        out.push(t);
                    }
                }
                out
            };

            // 2. Storage preflight BEFORE creating any output. Returns the
            // streaming byte quota; typed StorageExhausted on shortage.
            // Single-export ownership first (in-process + cross-process):
            // stale-tmp cleanup below is only race-free while holding it.
            let live = db_path(&app)?;
            let base = live
                .parent()
                .ok_or_else(|| TrustError::op_failed("Répertoire de base introuvable.".to_string()))?;
            let exports_root = base.join("emergency_exports");
            std::fs::create_dir_all(&exports_root).map_err(|e| {
                TrustError::op_failed(format!("Création du répertoire d'export impossible: {e}"))
            })?;
            let _ownership = try_acquire_export(&exports_root)?;
            cleanup_stale_staging(&exports_root);
            let mut quota = check_preflight(&exports_root, &live)?;

            // 3. Staging dir (guard removes it unless finalized) + snapshot.
            // The snapshot lives INSIDE staging, so every failure path cleans
            // it up with no extra bookkeeping.
            let export_id = format!("export_{}_{}", now_millis(), short_id());
            let (staging_path, _) = staging_paths(&exports_root, &export_id);
            std::fs::create_dir_all(&staging_path).map_err(|e| {
                TrustError::op_failed(format!("Création du répertoire d'export impossible: {e}"))
            })?;
            let staging = StagingGuard::new(staging_path.clone());
            let snap = acquire_snapshot(&live, staging.path())?;
            let snap_conn = open_snapshot_ro(&snap.path)?;

            // 4. Authentication barrier on the snapshot. Never satisfied by an
            // existing session. A wrong PIN stays a typed auth failure.
            let auth = authenticate_owner(&snap_conn, &request.pin).map_err(|e| {
                if e.to_lowercase().contains("pin") {
                    TrustError::SecurityPolicyFailure {
                        reason: "PIN gérant incorrect. Export refusé.",
                    }
                } else {
                    TrustError::op_failed(e)
                }
            })?;

            // 5. Stream tables with per-file quota drawn from the budget.
            let mut files = Vec::new();
            let emit_progress = |table: &str, rows: u64| {
                let _ = app.emit(
                    "emergency-export-progress",
                    serde_json::json!({ "table": table, "rows": rows }),
                );
            };
            for table in requested {
                let file_name = format!("{}.csv", table.file_stem());
                let out_path = staging.path().join(&file_name);
                let (row_count, sha256, byte_len) =
                    stream_table(&snap_conn, table, &out_path, &emit_progress, Some(quota))?;
                quota = quota.saturating_sub(byte_len);
                files.push(ExportedFile {
                    table: table.file_stem().to_string(),
                    file_name,
                    // Staging path for now; rewritten to final below.
                    absolute_path: out_path.to_string_lossy().into_owned(),
                    row_count,
                    byte_len,
                    sha256,
                });
            }
            // 5b. Chain status over the SAME snapshot the CSVs came from
            // (consistency by construction), before the handle is dropped.
            // Key resolved once here and reused for manifest sealing below.
            let (ck_store, _) = select_store(base);
            let mac_key: Option<Vec<u8>> = match resolve_mac_key(&*ck_store, true) {
                KeyResolution::Active { key, .. } => Some(key),
                KeyResolution::ProvisionOnFirstPersist
                | KeyResolution::QuarantineNoKey => None,
            };
            let chain_status_val =
                verify_audit_chain_full(&snap_conn, &*ck_store, mac_key.as_deref());
            // Phase 4.5 WP1e: a broken chain fails the export (typed
            // ExportManifestFailed — no unverified output), except under the
            // TAMPER_SUSPECTED / CLOCK_RESET_REQUIRED quarantine states where
            // owner decision 2 permits read-only export with MAC-covered
            // evidence. License posture is needed here, so it is resolved
            // before the gate (moved up from step 6; pure mapping).
            let license_status_early = ctx.state_code.clone();
            let chain_status = chain_status_for_export(&chain_status_val, &license_status_early)?;
            drop(snap_conn);
            let _ = std::fs::remove_file(&snap.path);

            // 6. Best-effort audit row FIRST so its outcome lands in the
            // manifest. Failure never blocks the export (Phase 3 item 5).
            // The quarantine posture rides along (owner Q2): a flagged
            // export is still fully audited.
            // (`license_status` resolved early at step 5b for the chain gate.)
            let license_status = license_status_early;
            let integrity_state = integrity_state_for_license(&license_status).to_string();
            let (audit_event_id, audit_error) = match write_audit_event(
                &app,
                &auth.admin_id,
                &license_status,
                &integrity_state,
                None,
                &files,
            ) {
                Ok(id) => (id, None),
                Err(e) => (String::new(), Some(e)),
            };

            // 7. External manifest (authoritative receipt; the DB row is not).
            // Sealed with the trust MAC key when available; absence is
            // recorded in the manifest, never faked.
            let tf = global_time_kernel().read_fields();
            let manifest_entries: Vec<ManifestFileEntry> = files
                .iter()
                .map(|f| ManifestFileEntry {
                    table: f.table.clone(),
                    file_name: f.file_name.clone(),
                    row_count: f.row_count,
                    byte_len: f.byte_len,
                    sha256: f.sha256.clone(),
                })
                .collect();
            let manifest_input = ManifestInput {
                export_id: export_id.clone(),
                license_state: license_status.clone(),
                // Quarantine posture is MAC-covered evidence: it cannot be
                // stripped or downgraded without failing verification.
                integrity_state: integrity_state.clone(),
                // Chain posture likewise MAC-covered (same bytes).
                chain_status: chain_status.clone(),
                files: manifest_entries,
                trusted_wall_utc_ms: tf.last_trusted_wall_utc_ms,
                trusted_server_utc_ms: tf.last_server_time_utc_ms,
                exported_at: now_iso8601(),
                audit_event_id: (!audit_event_id.is_empty()).then(|| audit_event_id.clone()),
                audit_error: audit_error.clone(),
                mac: match mac_key {
                    Some(k) => ManifestMac::Key(k),
                    None => ManifestMac::Unavailable("no-key:export-time".into()),
                },
            };
            let manifest_path = match write_manifest(staging.path(), manifest_input) {
                Ok(p) => p,
                Err(e) => {
                    // Manifest failure fails the export (owner Q3: no
                    // unverified output), but the attempt is still
                    // audit-recorded best-effort with the failure note and
                    // no PII. The staging guard removes the partial output;
                    // the lock guard drops.
                    let detail = e.to_string();
                    let _ = write_audit_event(
                        &app,
                        &auth.admin_id,
                        &license_status,
                        &integrity_state,
                        Some(detail.as_str()),
                        &files,
                    );
                    return Err(e);
                }
            };
            // fsync the staging dir so the manifest + CSV entries are
            // durable before the atomic rename (Unix real; Windows no-op).
            fsync_dir(staging.path())?;
            let (export_sha256, manifest_mac) = {
                let raw = std::fs::read(&manifest_path)
                    .map_err(|e| TrustError::op_failed(format!("manifest re-read: {e}")))?;
                let doc: serde_json::Value = serde_json::from_slice(&raw)
                    .map_err(|e| TrustError::op_failed(format!("manifest parse: {e}")))?;
                (
                    doc.get("export_sha256")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    doc.get("manifest_mac")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                )
            };

            // 8. Atomic finalize: staging → final, then disarm the guard.
            let final_dir = exports_root.join(&export_id);
            finalize_export_dir(staging.path(), &final_dir)?;
            staging.finalized();

            // 9. Rewrite paths to the finalized directory.
            let mut files_final = Vec::with_capacity(files.len());
            for f in files {
                files_final.push(ExportedFile {
                    absolute_path: final_dir
                        .join(&f.file_name)
                        .to_string_lossy()
                        .into_owned(),
                    ..f
                });
            }

            Ok(EmergencyExportResult {
                export_dir: final_dir.to_string_lossy().into_owned(),
                files: files_final,
                audit_event_id,
                authorized_admin_id: auth.admin_id,
                license_status_at_export: license_status,
                completed_at: now_iso8601(),
                manifest_path: final_dir
                    .join("manifest.json")
                    .to_string_lossy()
                    .into_owned(),
                export_sha256,
                manifest_mac,
                integrity_state: integrity_state.clone(),
                audit_error,
            })
        },
    )
}

/// Short random suffix so export ids stay unique even when the wall clock is
/// untrustworthy (TC-30 class): the id never gates recovery, only names it.
fn short_id() -> String {
    uuid::Uuid::new_v4().to_string()[..8].to_string()
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn now_iso8601() -> String {
    // Minimal UTC ISO-8601 without pulling in a date crate.
    let secs = (now_millis() / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_memory() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE transactions (
                id TEXT PRIMARY KEY, receipt_number TEXT, customer_id TEXT,
                subtotal REAL, tax REAL, discount_total REAL, total REAL,
                payment_method TEXT, cash_tendered REAL, change_due REAL,
                status TEXT, created_at TEXT, json_payload TEXT, device_id TEXT,
                shift_id TEXT, deleted INTEGER DEFAULT 0);
             CREATE TABLE transaction_items (
                id TEXT PRIMARY KEY, transaction_id TEXT, product_id TEXT,
                quantity INTEGER, applied_price REAL, discount_amount REAL,
                unit_cost_at_sale REAL, line_profit REAL, created_at TEXT,
                imei_number TEXT, deleted INTEGER DEFAULT 0);
             CREATE TABLE cash_sessions (
                id TEXT PRIMARY KEY, opened_at TEXT, closed_at TEXT,
                opening_float INTEGER, expected_cash INTEGER, actual_cash INTEGER,
                discrepancy INTEGER, status TEXT, device_id TEXT);
             CREATE TABLE cash_movements (
                id TEXT PRIMARY KEY, session_id TEXT, type TEXT, amount INTEGER,
                reason TEXT, created_at TEXT, device_id TEXT);
             CREATE TABLE app_settings (id TEXT PRIMARY KEY, key TEXT, value_json TEXT);
             CREATE TABLE security_audit_logs (
                id TEXT PRIMARY KEY, timestamp TEXT, user TEXT, action TEXT,
                details TEXT, requires_pin INTEGER, device_id TEXT);",
        )
        .unwrap();
        c
    }

    fn seed(conn: &Connection) {
        conn.execute(
            "INSERT INTO transactions VALUES
             ('t1','R-001','CUST-SECRET',100.0,19.0,0.0,119.0,'Espèces',120.0,1.0,
              'COMPLETED','2026-09-01T10:00:00.000Z','{\"customer\":\"Ali\"}','dev1','S1',0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO transaction_items VALUES
             ('i1','t1','p1',2,50.0,0.0,20.0,60.0,'2026-09-01T10:00:00.000Z','IMEI-SECRET',0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO app_settings (id,key,value_json) VALUES
             ('manager_pin','manager_pin','v1$abc$def'),
             ('cashier_users','cashier_users',
              '[{\"id\":\"usr-admin\",\"role\":\"admin\"},{\"id\":\"usr-c\",\"role\":\"cashier\"}]')",
            [],
        )
        .unwrap();
    }

    fn write_csv(conn: &Connection, table: AllowedTable, path: &Path) -> (u64, String) {
        // Progress is a no-op in tests; the emitter wiring is covered by the
        // type signature, not by behaviour that needs a live AppHandle.
        // No quota in legacy-path tests (quota is covered below).
        let noop = |_: &str, _: u64| {};
        stream_table(conn, table, path, &noop, None).unwrap();
        let text = std::fs::read_to_string(path).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(text.as_bytes());
        let digest = hasher.finalize();
        (
            text.lines().count().saturating_sub(1) as u64,
            digest.iter().map(|b| format!("{b:02x}")).collect(),
        )
    }

    #[test]
    fn test_read_only_connection_rejects_writes() {
        let dir = tempdir("ro");
        let db = dir.join("t.db");
        {
            let c = Connection::open(&db).unwrap();
            c.execute_batch(
                "CREATE TABLE t(a);
                 CREATE TABLE app_settings (id TEXT PRIMARY KEY, key TEXT, value_json TEXT);",
            )
            .unwrap();
        }
        let ro = open_read_only(&db).unwrap();
        // INSERT
        let e = ro
            .execute("INSERT INTO t VALUES (1)", [])
            .expect_err("INSERT must be rejected on a read-only handle");
        assert!(
            format!("{e}").to_lowercase().contains("readonly")
                || format!("{e}").to_lowercase().contains("read-only"),
            "expected a read-only error, got: {e}"
        );
        // UPDATE
        assert!(ro.execute("UPDATE t SET a = 2", []).is_err());
        // DELETE
        assert!(ro.execute("DELETE FROM t", []).is_err());
        // DDL
        assert!(ro.execute("CREATE TABLE zz(a)", []).is_err());
        // query_only pragma itself
        assert!(ro.query_row("PRAGMA query_only", [], |r| r.get::<_, i64>(0)).unwrap() == 1);
    }

    #[test]
    fn test_verify_pin_fail_closed() {
        // Correct hash for pin "1234" with salt "abc".
        let mut h = Sha256::new();
        h.update(b"abc:1234:mobi_pos_salt_v1");
        let digest: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        let good = format!("v1$abc${digest}");

        assert!(verify_pin("1234", &good), "valid pin must verify");
        assert!(!verify_pin("1235", &good), "wrong pin must reject");
        assert!(!verify_pin("", &good), "empty pin must reject");
        assert!(!verify_pin("1234", ""), "empty hash must reject");
        // Legacy plaintext is NOT accepted (single-PIN contract: v1$ only).
        assert!(!verify_pin("1234", "1234"));
        // Malformed shapes all reject.
        assert!(!verify_pin("1234", "v1$abc"));
        assert!(!verify_pin("1234", "v2$abc$def"));
        assert!(!verify_pin("1234", "v1$$def"));
        assert!(!verify_pin("1234", &format!("v1$abc${digest}$extra")));
    }

    #[test]
    fn test_auth_rejects_wrong_pin_and_missing_credential() {
        let conn = in_memory();
        seed(&conn);
        let mut h = Sha256::new();
        h.update(b"abc:1234:mobi_pos_salt_v1");
        let digest: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        conn.execute(
            "UPDATE app_settings SET value_json = ?1 WHERE key = 'manager_pin'",
            [format!("v1$abc${digest}")],
        )
        .unwrap();

        assert!(authenticate_owner(&conn, "1234").is_ok());
        assert!(authenticate_owner(&conn, "9999").is_err());

        conn.execute("DELETE FROM app_settings WHERE key = 'manager_pin'", [])
            .unwrap();
        assert!(
            authenticate_owner(&conn, "1234").is_err(),
            "missing credential must fail closed"
        );
    }

    #[test]
    fn test_export_excludes_pii_and_secrets() {
        let conn = in_memory();
        seed(&conn);
        let dir = tempdir("pii");
        let out = dir.join("sales.csv");
        let (rows, _sha) = write_csv(&conn, AllowedTable::SalesJournal, &out);
        let text = std::fs::read_to_string(&out).unwrap();

        assert_eq!(rows, 1);
        assert!(!text.contains("CUST-SECRET"), "customer_id must not be exported");
        assert!(!text.contains("Ali"), "json_payload PII must not be exported");
        assert!(text.contains("R-001") && text.contains("119.00"));

        let out2 = dir.join("lines.csv");
        write_csv(&conn, AllowedTable::SalesJournalLines, &out2);
        let t2 = std::fs::read_to_string(&out2).unwrap();
        assert!(!t2.contains("IMEI-SECRET"), "IMEI must not be exported");
    }

    #[test]
    fn test_csv_escaping_and_injection_guard() {
        let v = ValueRef::Text(b"=cmd|'/c calc'!A1");
        assert!(csv_field(&v).starts_with("'="), "formula must be neutralised");
        let v = ValueRef::Text(b"a,b\"c");
        assert_eq!(csv_field(&v), "\"a,b\"\"c\"");
        let v = ValueRef::Real(f64::NAN);
        assert_eq!(csv_field(&v), "", "NaN must not reach the file");
        let v = ValueRef::Real(19.0);
        assert_eq!(csv_field(&v), "19.00");
        let v = ValueRef::Null;
        assert_eq!(csv_field(&v), "");
    }

    #[test]
    fn test_csv_tab_cr_guarded_numeric_exempt() {
        // Stage 1/E: leading TAB/CR are formula-smuggling triggers (trimmers
        // strip them to expose `=` underneath).
        let v = ValueRef::Text(b"\t=cmd");
        assert!(csv_field(&v).starts_with("'\t"), "leading TAB must be neutralised");
        // Leading CR is both guarded AND RFC-4180-quoted (it contains \r),
        // so the payload survives inside quotes with the guard intact.
        let v = ValueRef::Text(b"\r=cmd");
        let out_cr = csv_field(&v);
        assert!(out_cr.contains("'\r=cmd"), "leading CR must stay neutralised, got {out_cr:?}");
        // Tight numeric exemption: pure numbers cannot execute.
        for plain in ["0", "42", "-42", "3.14", "-0.50", "007"] {
            let v = ValueRef::Text(plain.as_bytes());
            assert_eq!(csv_field(&v), plain, "{plain} is a pure number, must pass through");
        }
        // Abuse boundary: near-numbers that are NOT strictly numeric stay
        // guarded — the exemption cannot be smuggled through. (Empty input
        // yields empty output and never reaches the trigger test.)
        for hostile in ["-1+1", "+7", "- 42", "--5", "1e5+", "0x10", "42 ", " 42", "4.5.6", "-", "+", ".5", "-.5"] {
            let v = ValueRef::Text(hostile.as_bytes());
            let out = csv_field(&v);
            let first = hostile.chars().next().unwrap();
            if matches!(first, '=' | '+' | '-' | '@' | '\t' | '\r') {
                assert!(out.starts_with('\''), "{hostile:?} must be guarded, got {out:?}");
            }
        }
        // "-42" exemption is exact: a trailing payload breaks it.
        let v = ValueRef::Text(b"-42+SUM(A1)");
        assert!(csv_field(&v).starts_with("'-"), "payload after a number must stay guarded");
    }

    #[test]
    fn test_table_allowlist_rejects_unknown() {
        assert!(AllowedTable::from_key("customers").is_none());
        assert!(AllowedTable::from_key("app_settings").is_none());
        assert!(AllowedTable::from_key("products").is_none());
        assert!(AllowedTable::from_key("sales_journal").is_some());
        // No allowlisted statement may read a forbidden column.
        for t in [
            AllowedTable::SalesJournal,
            AllowedTable::SalesJournalLines,
            AllowedTable::ShiftSessions,
            AllowedTable::ShiftMovements,
        ] {
            let sql = t.sql().to_lowercase();
            for banned in [
                "customer_id",
                "cashier_name",
                "json_payload",
                "imei_number",
                "idempotency_key",
            ] {
                assert!(
                    !sql.contains(banned),
                    "{} must not select {banned}",
                    t.file_stem()
                );
            }
            assert!(!sql.contains('*'), "{} must not use SELECT *", t.file_stem());
        }
    }

    #[test]
    fn test_setting_text_handles_all_stored_encodings() {
        // The live build stores the PIN as a JSON string LITERAL. Parsing the
        // raw column text yields quotes and breaks verification — this is the
        // exact defect that made a correct PIN fail on real data.
        assert_eq!(
            read_setting_text(Some("\"v1$abc$def\"".to_string())),
            "v1$abc$def"
        );
        // Bare value (older writes) still works.
        assert_eq!(read_setting_text(Some("v1$abc$def".to_string())), "v1$abc$def");
        // Surrounding whitespace tolerated.
        assert_eq!(
            read_setting_text(Some("  \"v1$abc$def\"  ".to_string())),
            "v1$abc$def"
        );
        // Non-string JSON (object/number) falls back to the raw text rather
        // than panicking.
        assert_eq!(read_setting_text(Some("{\"a\":1}".to_string())), "{\"a\":1}");
        // Absent → empty, which the caller treats as fail-closed.
        assert_eq!(read_setting_text(None), "");
    }

    #[test]
    fn test_auth_accepts_json_encoded_pin_hash() {
        let conn = in_memory();
        seed(&conn);
        let mut h = Sha256::new();
        h.update(b"abc:1234:mobi_pos_salt_v1");
        let digest: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        // Store it JSON-encoded, exactly as the live build does.
        conn.execute(
            "UPDATE app_settings SET value_json = ?1 WHERE key = 'manager_pin'",
            [serde_json::json!(format!("v1$abc${digest}")).to_string()],
        )
        .unwrap();

        let auth = authenticate_owner(&conn, "1234")
            .expect("a correct PIN must verify when stored JSON-encoded");
        assert_eq!(auth.admin_id, "usr-admin", "audit trail records the admin id");
        assert!(authenticate_owner(&conn, "9999").is_err());
    }

    #[test]
    fn test_export_sql_matches_live_schema() {
        // The live `cash_movements` table has NO device_id column. Every
        // allowlisted statement must prepare cleanly against the real column
        // set, or the export fails at runtime on a customer's terminal.
        let conn = in_memory();
        for table in [
            AllowedTable::SalesJournal,
            AllowedTable::SalesJournalLines,
            AllowedTable::ShiftSessions,
            AllowedTable::ShiftMovements,
        ] {
            conn.prepare(table.sql())
                .unwrap_or_else(|e| panic!("{} SQL invalid: {e}", table.file_stem()));
        }
    }

    #[test]
    fn test_iso8601_formatting() {
        let s = now_iso8601();
        assert!(s.ends_with('Z'), "must be UTC: {s}");
        assert_eq!(s.len(), 20, "unexpected shape: {s}");
        assert!(s.starts_with("202"), "unexpected year: {s}");
    }

    #[test]
    fn test_quota_exhaustion_fails_typed_storage_exhausted() {
        use crate::trust_core::ipc_authorizer::TrustError;
        let conn = in_memory();
        seed(&conn);
        let dir = tempdir("quota");
        let out = dir.join("sales.csv");
        let noop = |_: &str, _: u64| {};
        // 10-byte quota cannot even hold the header: deterministic low-disk.
        let err = stream_table(&conn, AllowedTable::SalesJournal, &out, &noop, Some(10))
            .unwrap_err();
        assert!(
            matches!(err, TrustError::StorageExhausted { .. }),
            "quota exhaustion must be typed, got: {err}"
        );
        assert_eq!(err.gate_code(), "NONE", "storage errors are not lock screens");
    }

    #[test]
    fn test_generous_quota_exports_fully() {
        let conn = in_memory();
        seed(&conn);
        let dir = tempdir("quotafull");
        let out = dir.join("sales.csv");
        let noop = |_: &str, _: u64| {};
        let (rows, _sha, bytes) =
            stream_table(&conn, AllowedTable::SalesJournal, &out, &noop, Some(1024 * 1024)).unwrap();
        assert_eq!(rows, 1);
        assert!(bytes > 0);
    }

    fn tempdir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mobi-exp-test-{tag}-{}", now_millis()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}

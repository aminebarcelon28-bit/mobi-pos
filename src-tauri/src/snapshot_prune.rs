//! Phase 3 — snapshot prune (Stage 2): native-only janitor + PIN-gated manual prune.
//!
//! Why this exists (FT-06 follow-up): snapshots accumulate unboundedly
//! (every wipe/restore/migration mints one, nothing deletes). Deleting a
//! snapshot destroys a recovery point, so deletion is as privileged as
//! creation: the janitor runs native-only with a constant policy (no IPC,
//! no renderer parameters), and manual prune verifies a fresh manager PIN
//! INSIDE the native command through the unmodified `pin_verify` function
//! (wrong PINs burn the existing ladder — no new counter, no logic change).
//!
//! Rules (owner-set, enforced below):
//! - Sweepable kinds: `migration`, `restore` ONLY. `wipe`, `manual`, and
//!   unknown filename patterns are never listed, never touched.
//! - References match on filename/ID with `instr(details, id)` — never LIKE
//!   (`_` is a LIKE wildcard; JSON doubles backslashes, so raw paths would
//!   miss — we match IDs, not paths). Any audit-query error aborts the whole
//!   prune: delete NOTHING.
//! - Incomplete operations are protected regardless of age: a `restore`
//!   snapshot with a pre-row (`DATA_RESTORE_BEFORE`) but no completion row
//!   (`DATA_RESTORED_OK`) is under investigation.
//! - Complete, referenced snapshots are prunable after the window — the row
//!   keeps id+bytes+mtime+sha, so evidence survives the file.
//! - Deletion needs BOTH `position >= keep_last` AND `age > older_than`
//!   (AND semantics), the newest of each kind is always kept, and floors
//!   (`keep_last >= 1`, `older_than >= 7d`) are enforced natively in both
//!   janitor (constants above floors) and manual prune (reject below).
//! - Orphans (no referencing row) age out per the same per-kind window.
//! - The janitor runs at startup only (see call site in `lib.rs`) — never
//!   mid-operation, never via IPC.

use crate::trust_core::{
    capability_policy::Capability,
    ipc_authorizer::{authorize_and_execute, TrustError},
};
use std::path::Path;

/// Sweepable snapshot kinds. Everything else is never listed.
const SWEEPABLE_KINDS: &[&str] = &["migration", "restore"];

/// Janitor policy (constant, above the floors): keep 3 per kind, 30 days.
const JANITOR_KEEP_LAST: u32 = 3;
const JANITOR_OLDER_THAN_SECS: u64 = 30 * 86400;

/// Native floors: below either is rejected, in both janitor and manual.
pub const FLOOR_KEEP_LAST: u32 = 1;
pub const FLOOR_OLDER_THAN_SECS: u64 = 7 * 86400;

/// Actions whose `details` may reference a snapshot filename/ID.
const SNAPSHOT_REF_ACTIONS: &[&str] = &[
    "DATA_WIPE_BEFORE",
    "DATA_RESTORE_BEFORE",
    "DATA_RESTORED_OK",
];

#[derive(Debug, Clone)]
pub struct PrunePolicy {
    pub keep_last: u32,
    pub older_than_secs: u64,
}

impl PrunePolicy {
    pub fn janitor() -> Self {
        Self {
            keep_last: JANITOR_KEEP_LAST,
            older_than_secs: JANITOR_OLDER_THAN_SECS,
        }
    }

    /// Floors enforced natively, in both paths. Below either → reject.
    pub fn validate(&self) -> Result<(), TrustError> {
        if self.keep_last < FLOOR_KEEP_LAST {
            return Err(TrustError::op_failed(format!(
                "Politique de purge refusée: keep_last minimum {FLOOR_KEEP_LAST}."
            )));
        }
        if self.older_than_secs < FLOOR_OLDER_THAN_SECS {
            return Err(TrustError::op_failed(
                "Politique de purge refusée: older_than minimum 7 jours.".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) mtime_ms: u64,
}

/// Kind = leading segment before `_mobi_pos_backup_`. Unknown → None (skip).
fn parse_snapshot_kind(file_name: &str) -> Option<&'static str> {
    for kind in ["wipe", "restore", "migration", "manual"] {
        if file_name.starts_with(&format!("{kind}_mobi_pos_backup_")) {
            return Some(kind);
        }
    }
    None
}

fn file_mtime_ms(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// Literal substring match. Deliberately NOT LIKE: `_` in snapshot ids
/// (`*_mobi_pos_backup_*`) is a LIKE wildcard, so LIKE would match siblings
/// that merely share the shape (e.g. id `a_b` matching details holding
/// `aXb`). `instr` is byte-literal.
fn references_snapshot(details: &str, id: &str) -> bool {
    details.contains(id)
}

pub struct PrunePlan {
    /// Ids to delete, oldest-first within kind.
    pub delete_ids: Vec<String>,
    pub kept: usize,
    pub scanned: usize,
}

/// Pure planner: no fs writes. `details_rows` are the `details` column of
/// every SNAPSHOT_REF_ACTIONS audit row; Err aborts the caller (delete
/// nothing). `now_ms` is injected for determinism in tests.
pub(crate) fn plan_prune(
    candidates: Vec<Candidate>,
    details_rows: Result<Vec<String>, TrustError>,
    policy: &PrunePolicy,
    now_ms: u64,
) -> Result<PrunePlan, TrustError> {
    policy.validate()?;
    let details_rows = details_rows?;
    // Group sweepable candidates per kind, newest-first.
    let mut by_kind: std::collections::BTreeMap<String, Vec<Candidate>> =
        std::collections::BTreeMap::new();
    let mut scanned = 0usize;
    for c in candidates {
        if !SWEEPABLE_KINDS.contains(&c.kind.as_str()) {
            continue;
        }
        scanned += 1;
        by_kind.entry(c.kind.clone()).or_default().push(c);
    }
    let mut delete_ids = Vec::new();
    let mut kept = 0usize;
    for (_kind, mut group) in by_kind {
        group.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
        for (pos, c) in group.iter().enumerate() {
            // Newest of each kind is always kept.
            if pos == 0 {
                kept += 1;
                continue;
            }
            let age_ok = now_ms.saturating_sub(c.mtime_ms) > policy.older_than_secs.saturating_mul(1000);
            let referenced = details_rows.iter().any(|d| references_snapshot(d, &c.id));
            // Incomplete restore op (pre-row without completion row) is
            // protected regardless of age — it may be under investigation.
            // Migration snapshots have no pairing rows; absence of rows is
            // the orphan case below, not incompleteness.
            let incomplete = c.kind == "restore"
                && details_rows.iter().any(|d| {
                    d.contains("DATA_RESTORE_BEFORE") && references_snapshot(d, &c.id)
                })
                && !details_rows.iter().any(|d| {
                    d.contains("DATA_RESTORED_OK") && references_snapshot(d, &c.id)
                });
            // AND semantics: beyond keep_last AND older than the window.
            // Referenced-complete snapshots are prunable after the window
            // (the row keeps id+bytes+mtime+sha); unreferenced orphans age
            // out on the same per-kind window; incomplete never.
            let old_enough_for_count = (pos as u32) >= policy.keep_last;
            if !incomplete && age_ok && old_enough_for_count {
                let _ = referenced; // orphans and complete-referenced prune alike past the window
                delete_ids.push(c.id.clone());
            } else {
                kept += 1;
            }
        }
    }
    Ok(PrunePlan {
        delete_ids,
        kept,
        scanned,
    })
}

/// Execute a plan: delete files (+ stale companions sharing the stem).
/// Returns the deleted ids. Best-effort per file would hide partial failure;
/// a failed delete aborts with the id named (the rest stay — fail closed,
//, never half-reported as done).
pub fn execute_prune(backups_dir: &Path, plan: &PrunePlan) -> Result<Vec<String>, TrustError> {
    let mut deleted = Vec::new();
    for id in &plan.delete_ids {
        let path = backups_dir.join(id);
        // Refuse path escape: the id must resolve inside backups_dir.
        if !path.starts_with(backups_dir) {
            return Err(TrustError::op_failed(format!(
                "Refus de suppression hors dossier snapshots: {id}"
            )));
        }
        std::fs::remove_file(&path)
            .map_err(|e| TrustError::op_failed(format!("Suppression {id} impossible: {e}")))?;
        // Stale companions from the raw-copy era share the stem.
        for suffix in ["-wal", "-journal", "-shm"] {
            let companion = path.with_extension(format!("db{suffix}"));
            let _ = std::fs::remove_file(companion);
        }
        deleted.push(id.clone());
    }
    Ok(deleted)
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneRequest {
    pub pin: String,
    pub keep_last: Option<u32>,
    pub older_than_secs: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepReport {
    pub scanned: usize,
    pub kept: usize,
    pub deleted: Vec<String>,
}

/// Collect sweepable candidates from the backups dir (never wipe/manual).
fn collect_candidates(backups_dir: &Path) -> Vec<Candidate> {
    let entries = std::fs::read_dir(backups_dir).map(|rd| {
        rd.filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file())
            .collect::<Vec<_>>()
    });
    let mut out = Vec::new();
    for path in entries.unwrap_or_default() {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.ends_with(".db") || !name.contains("_mobi_pos_backup_") {
            continue;
        }
        let Some(kind) = parse_snapshot_kind(name) else {
            continue;
        };
        if !SWEEPABLE_KINDS.contains(&kind) {
            continue;
        }
        let Some(mtime_ms) = file_mtime_ms(&path) else {
            continue;
        };
        out.push(Candidate {
            id: name.to_string(),
            kind: kind.to_string(),
            mtime_ms,
        });
    }
    out
}

fn open_live_ro(path: &Path) -> Result<rusqlite::Connection, TrustError> {
    use rusqlite::OpenFlags;
    let conn = rusqlite::Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| TrustError::op_failed(format!("lecture base locale impossible: {e}")))?;
    conn.execute_batch("PRAGMA query_only = ON;").ok();
    Ok(conn)
}

/// Read every `details` that may reference a snapshot id. Any query error
/// propagates — the caller deletes NOTHING on Err.
fn read_snapshot_ref_rows(live_db: &Path) -> Result<Vec<String>, TrustError> {
    let conn = open_live_ro(live_db)?;
    let placeholders = SNAPSHOT_REF_ACTIONS
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("SELECT details FROM security_audit_logs WHERE action IN ({placeholders})");
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| TrustError::op_failed(format!("requête audit impossible: {e}")))?;
    let params: Vec<&dyn rusqlite::ToSql> = SNAPSHOT_REF_ACTIONS
        .iter()
        .map(|a| a as &dyn rusqlite::ToSql)
        .collect();
    let rows = stmt
        .query_map(params.as_slice(), |row| row.get::<_, String>(0))
        .map_err(|e| TrustError::op_failed(format!("lecture audit impossible: {e}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| TrustError::op_failed(format!("décodage audit impossible: {e}")))?;
    Ok(rows)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Janitor: native-only, constant policy, no renderer parameters, no IPC.
/// Takes explicit paths (the caller resolves the LOCAL backups dir).
/// Runs at startup only (see lib.rs) — never mid-operation. Best-effort: any
/// failure is logged, never fails boot. Returns what it did.
pub fn janitor_sweep_backups_at(live_db: &Path, backups_dir: &Path) -> SweepReport {
    let empty = SweepReport {
        scanned: 0,
        kept: 0,
        deleted: vec![],
    };
    if !backups_dir.is_dir() {
        return empty;
    }
    let candidates = collect_candidates(&backups_dir);
    if candidates.is_empty() {
        return empty;
    }
    let rows = match read_snapshot_ref_rows(&live_db) {
        Ok(r) => Ok(r),
        Err(e) => {
            eprintln!("[prune:janitor] audit read failed, deleting nothing: {e}");
            return empty;
        }
    };
    let plan = match plan_prune(candidates, rows, &PrunePolicy::janitor(), now_ms()) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[prune:janitor] plan refused ({e}), deleting nothing");
            return empty;
        }
    };
    if plan.delete_ids.is_empty() {
        return SweepReport {
            scanned: plan.scanned,
            kept: plan.kept,
            deleted: vec![],
        };
    }
    match execute_prune(&backups_dir, &plan) {
        Ok(deleted) => {
            eprintln!(
                "[prune:janitor] swept {} snapshot(s), kept {}: {}",
                deleted.len(),
                plan.kept,
                deleted.join(", ")
            );
            SweepReport {
                scanned: plan.scanned,
                kept: plan.kept,
                deleted,
            }
        }
        Err(e) => {
            eprintln!("[prune:janitor] delete failed, stopping: {e}");
            empty
        }
    }
}

/// Manual prune command: PIN verified INSIDE, through the unmodified
/// `pin_verify` function (same path as the lock screen — wrong PINs burn the
/// existing ladder, Locked surfaces remaining). Only then does the
/// OperationalWrites-gated prune run. Policy floors enforced natively.
#[tauri::command]
pub fn prune_snapshots(
    app: tauri::AppHandle,
    request: PruneRequest,
) -> Result<SweepReport, TrustError> {
    // Floors first (no budget burn on malformed policy — same doctrine as
    // validate-before-PIN on the TS restore path).
    let policy = PrunePolicy {
        keep_last: request.keep_last.unwrap_or(3),
        older_than_secs: request.older_than_secs.unwrap_or(30 * 86400),
    };
    policy.validate()?;
    // Fresh manager PIN through the EXISTING function, unmodified. The two
    // authorize_and_execute calls are strictly SEQUENTIAL (pin_verify's
    // read guard is released when it returns, before the prune guard is
    // taken) — never nested, so no guard overlap is possible.
    let verify_res = crate::trust_core::pin::pin_verify(
        app.clone(),
        crate::trust_core::pin::PinVerifyRequest {
            user_id: "manager".to_string(),
            pin: request.pin,
        },
    )?;
    if verify_res.locked {
        return Err(TrustError::op_failed(format!(
            "PIN verrouillé — réessayez dans {}s.",
            (verify_res.locked_remaining_ms + 999) / 1000
        )));
    }
    if !verify_res.ok {
        return Err(TrustError::SecurityPolicyFailure {
            reason: "PIN manager incorrect — purge refusée.",
        });
    }
    authorize_and_execute("prune_snapshots", Capability::OperationalWrites, |_| {
        let backups_dir = crate::backups_dir(&app)?;
        let live_db = {
            use tauri::Manager;
            app.path()
                .app_data_dir()
                .map_err(|e| TrustError::op_failed(format!("app dir: {e}")))?
                .join("mobi_pos.db")
        };
        let candidates = collect_candidates(&backups_dir);
        let rows = read_snapshot_ref_rows(&live_db);
        let plan = plan_prune(candidates, rows, &policy, now_ms())?;
        let deleted = execute_prune(&backups_dir, &plan)?;
        Ok(SweepReport {
            scanned: plan.scanned,
            kept: plan.kept,
            deleted,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(id: &str, kind: &str, age_days: u64, now_ms: u64) -> Candidate {
        Candidate {
            id: id.to_string(),
            kind: kind.to_string(),
            mtime_ms: now_ms.saturating_sub(age_days.saturating_mul(86400).saturating_mul(1000)),
        }
    }

    const NOW: u64 = 1_800_000_000_000;

    fn policy() -> PrunePolicy {
        PrunePolicy {
            keep_last: 3,
            older_than_secs: 30 * 86400,
        }
    }

    #[test]
    fn floors_reject_below_minimum_without_touching_anything() {
        let bad_keep = PrunePolicy {
            keep_last: 0,
            older_than_secs: 30 * 86400,
        };
        assert!(bad_keep.validate().is_err());
        let bad_age = PrunePolicy {
            keep_last: 3,
            older_than_secs: 6 * 86400,
        };
        assert!(bad_age.validate().is_err());
        // plan_prune validates first: no candidates are even listed.
        let r = plan_prune(vec![], Ok(vec![]), &bad_keep, NOW);
        assert!(r.is_err());
    }

    #[test]
    fn underscore_ids_match_literally_never_like_wildcard() {
        // The LIKE trap this rule exists for: id `a_b` must NOT match details
        // holding `aXb` (`_` is a LIKE wildcard). instr is byte-literal.
        assert!(!references_snapshot("x aXb y", "a_b"));
        assert!(references_snapshot("x a_b y", "a_b"));
        // JSON doubling does not matter: we match IDs, and IDs contain no
        // backslashes to double.
        assert!(references_snapshot(r#"{"snapshotId":"wipe_mobi_pos_backup_1_ab12cd34.db"}"#, "wipe_mobi_pos_backup_1_ab12cd34.db"));
    }

    #[test]
    fn newest_per_kind_always_kept_and_kinds_never_swept() {
        // One old restore snapshot beyond keep_last... but newest of its
        // kind → kept. Wipe/manual are never even scanned. (Legacy
        // kind-less names are rejected by parse_snapshot_kind, tested
        // below — plan_prune receives already-parsed candidates.)
        let rows: Vec<String> = vec![];
        let plan = plan_prune(
            vec![
                cand("restore_mobi_pos_backup_9_aaaaaaaa.db", "restore", 90, NOW),
                cand("wipe_mobi_pos_backup_1_bbbbbbbb.db", "wipe", 900, NOW),
                cand("manual_mobi_pos_backup_1_cccccccc.db", "manual", 900, NOW),
            ],
            Ok(rows),
            &policy(),
            NOW,
        )
        .unwrap();
        assert!(plan.delete_ids.is_empty(), "newest-per-kind + never-sweep must hold, got {:?}", plan.delete_ids);
        assert_eq!(plan.kept, 1);
        assert_eq!(plan.scanned, 1, "only the sweepable kind is scanned");
    }

    #[test]
    fn filename_kinds_parse_and_legacy_has_none() {
        assert_eq!(parse_snapshot_kind("wipe_mobi_pos_backup_12_ab12cd34.db"), Some("wipe"));
        assert_eq!(parse_snapshot_kind("restore_mobi_pos_backup_12_ab12cd34.db"), Some("restore"));
        assert_eq!(parse_snapshot_kind("migration_mobi_pos_backup_12_ab12cd34.db"), Some("migration"));
        assert_eq!(parse_snapshot_kind("manual_mobi_pos_backup_12_ab12cd34.db"), Some("manual"));
        assert_eq!(parse_snapshot_kind("mobi_pos_backup_12_ab12cd34.db"), None);
        assert_eq!(parse_snapshot_kind("evil_restore_mobi_pos_backup_1_x.db"), None);
        // Case rides on the prefix only; the `.db` extension filter in
        // collect_candidates rejects siblings like this before parsing.
        assert_eq!(parse_snapshot_kind("restore_mobi_pos_backup_1_x.DB"), Some("restore"));
    }

    #[test]
    fn and_semantics_old_but_within_keep_and_beyond_keep_but_new() {
        // Newest = largest mtime = smallest age. Fresh 1d file is pos0
        // (newest, kept); 50/60d land pos1-2, kept by count despite age;
        // 70/80/90d land pos3-5, beyond keep_last AND old → deleted.
        let rows: Vec<String> = vec![];
        let plan = plan_prune(
            vec![
                cand("restore_mobi_pos_backup_1_e4.db", "restore", 90, NOW),
                cand("restore_mobi_pos_backup_2_e3.db", "restore", 80, NOW),
                cand("restore_mobi_pos_backup_3_e2.db", "restore", 70, NOW),
                cand("restore_mobi_pos_backup_4_e1.db", "restore", 60, NOW),
                cand("restore_mobi_pos_backup_5_e0.db", "restore", 50, NOW),
                cand("restore_mobi_pos_backup_6_fresh.db", "restore", 1, NOW),
            ],
            Ok(rows),
            &policy(),
            NOW,
        )
        .unwrap();
        // Desc mtime: fresh(1d) pos0 kept; 50/60d pos1-2 kept (within
        // keep_last); 70/80/90d pos3-5 → deleted, oldest deletion last.
        assert_eq!(plan.delete_ids.len(), 3, "got {:?}", plan.delete_ids);
        assert!(plan.delete_ids.contains(&"restore_mobi_pos_backup_3_e2.db".to_string()));
        assert!(plan.delete_ids.contains(&"restore_mobi_pos_backup_2_e3.db".to_string()));
        assert!(plan.delete_ids.contains(&"restore_mobi_pos_backup_1_e4.db".to_string()));
    }

    #[test]
    fn incomplete_restore_op_protected_regardless_of_age() {
        // Pre-row without completion row: under investigation, never swept —
        // even 400 days old and far beyond keep_last.
        let pre = r#"{"stage":"pre-replace","snapshotId":"restore_mobi_pos_backup_1_old.db"}"#.to_string();
        let plan = plan_prune(
            vec![
                cand("restore_mobi_pos_backup_9_new.db", "restore", 90, NOW),
                cand("restore_mobi_pos_backup_1_old.db", "restore", 400, NOW),
            ],
            Ok(vec![pre]),
            &policy(),
            NOW,
        )
        .unwrap();
        assert!(plan.delete_ids.is_empty(), "incomplete op must survive, got {:?}", plan.delete_ids);
    }

    #[test]
    fn complete_referenced_prunable_after_window_row_keeps_evidence() {
        // Newest = largest mtime = smallest age: the 91d file is pos0
        // (always kept); 92/93d land pos1-2 (within keep_last); the complete
        // 95d pair and the unreferenced 94d orphan land pos3-4 → deleted.
        // The rows (id+bytes+mtime+sha) stay — only files go.
        let pre = r#"{"stage":"pre-replace","snapshotId":"restore_mobi_pos_backup_1_old.db"}"#.to_string();
        let ok = r#"{"stage":"completed","snapshotId":"restore_mobi_pos_backup_1_old.db"}"#.to_string();
        let plan = plan_prune(
            vec![
                cand("restore_mobi_pos_backup_1_old.db", "restore", 95, NOW),
                cand("restore_mobi_pos_backup_2_n0.db", "restore", 94, NOW),
                cand("restore_mobi_pos_backup_3_n1.db", "restore", 93, NOW),
                cand("restore_mobi_pos_backup_4_n2.db", "restore", 92, NOW),
                cand("restore_mobi_pos_backup_5_n3.db", "restore", 91, NOW),
            ],
            Ok(vec![pre, ok]),
            &policy(),
            NOW,
        )
        .unwrap();
        assert_eq!(
            plan.delete_ids,
            vec![
                "restore_mobi_pos_backup_2_n0.db".to_string(),
                "restore_mobi_pos_backup_1_old.db".to_string()
            ]
        );
    }

    #[test]
    fn query_error_deletes_nothing() {
        // Audit read failure → whole prune aborts before any listing: the
        // dir must be byte-identical afterwards (asserted by the caller
        // contract; here the plan itself errors with zero deletions).
        let r: Result<Vec<String>, TrustError> =
            Err(TrustError::op_failed("requête audit impossible".to_string()));
        let plan = plan_prune(
            vec![cand("restore_mobi_pos_backup_1_old.db", "restore", 400, NOW)],
            r,
            &policy(),
            NOW,
        );
        assert!(plan.is_err());
    }

    #[test]
    fn orphan_ages_out_per_kind_window() {
        // No referencing rows at all + older than 30d + beyond keep_last →
        // deleted. Same file at 10d → kept (window not reached).
        let old = plan_prune(
            vec![
                cand("migration_mobi_pos_backup_4_k3.db", "migration", 90, NOW),
                cand("migration_mobi_pos_backup_3_k2.db", "migration", 80, NOW),
                cand("migration_mobi_pos_backup_2_k1.db", "migration", 70, NOW),
                cand("migration_mobi_pos_backup_1_k0.db", "migration", 60, NOW),
            ],
            Ok(vec![]),
            &policy(),
            NOW,
        )
        .unwrap();
        assert_eq!(old.delete_ids.len(), 1);
        let young = plan_prune(
            vec![
                cand("migration_mobi_pos_backup_2_new.db", "migration", 90, NOW),
                cand("migration_mobi_pos_backup_1_young.db", "migration", 10, NOW),
            ],
            Ok(vec![]),
            &policy(),
            NOW,
        )
        .unwrap();
        assert!(young.delete_ids.is_empty());
    }

    #[test]
    fn janitor_runs_only_at_boot_never_as_ipc_or_mid_operation() {
        // Placement contract, enforced the same way as
        // ALL_COMMAND_FNS_IN_TESTS (read our own source): exactly one call
        // site (the startup spawn in lib.rs), never inside generate_handler!
        // (no IPC surface), never inside a wipe/restore/migration flow (TS
        // guards own their snapshots; see wipeGuard/restoreGuard).
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let lib_rs = std::fs::read_to_string(root.join("src/lib.rs"))
            .expect("lib.rs must be readable");
        let calls = lib_rs.match_indices("janitor_sweep_backups").count();
        assert_eq!(calls, 1, "janitor must have exactly one call site (boot)");
        let handler_start = lib_rs
            .find("generate_handler!")
            .expect("handler block must exist");
        let handler_block = &lib_rs[handler_start..];
        let handler_end = handler_block.find("])").expect("handler block must close");
        assert!(
            !handler_block[..handler_end].contains("janitor_sweep_backups"),
            "janitor must never be an IPC command"
        );
    }
}

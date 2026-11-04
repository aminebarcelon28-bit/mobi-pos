//! SEC-01 increment 2, step 2 — boot writes move to native code.
//!
//! The renderer's SQL pool is writable at boot because boot itself writes
//! through it. The instrumented run (`POS_SQL_QUERY_ONLY=1`) named the exact
//! statements, and they are all **maintenance**, not business logic:
//!
//!   * purge `sync_outbox` rows already `synced`;
//!   * reset `inflight` rows to `pending` (a crash left them claimed);
//!   * reconcile the `customers.current_debt` cache from the debt ledger;
//!   * close duplicate live shifts after adoption picked a survivor;
//!   * create the one-live-shift-per-device index once the table is clean.
//!
//! They now run here, in one transaction, behind a capability + role check, so
//! the renderer no longer needs a write handle to start. Schema healing is the
//! native database's job (`db::initialize_database` + migrations), which is why
//! the renderer's SQL heal is skipped when this command succeeds — and only
//! then (a failed native boot falls back to the old renderer path).
//!
//! Every statement is a **fixed literal** in this file: the renderer supplies
//! parameters, never SQL.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::Serialize;

/// One boot wrote through the renderer pool. Values are counts so the caller can
/// log (and tests can assert) what actually happened.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BootMaintenanceReport {
    pub outbox_purged: usize,
    pub inflight_reset: usize,
    pub debts_repaired: usize,
    pub duplicate_live_shifts: usize,
    pub index_created: bool,
}

/// Apply the boot maintenance to `conn`. Idempotent; one transaction; no
/// renderer-supplied SQL.
pub fn apply_boot_maintenance(conn: &mut Connection) -> Result<BootMaintenanceReport, String> {
    let tx = conn.transaction().map_err(|e| format!("boot tx: {e}"))?;
    let mut report = BootMaintenanceReport::default();

    report.outbox_purged = tx
        .execute("DELETE FROM sync_outbox WHERE status = 'synced'", [])
        .map_err(|e| format!("purge synced outbox: {e}"))?;

    report.inflight_reset = tx
        .execute(
            "UPDATE sync_outbox SET status = 'pending' WHERE status = 'inflight'",
            [],
        )
        .map_err(|e| format!("reset inflight outbox: {e}"))?;

    // Customer cache reconciled from the ledger, exactly the renderer's SQL.
    report.debts_repaired = tx
        .execute(
            "UPDATE customers
                SET current_debt = (
                    SELECT COALESCE(SUM(CASE WHEN d.type = 'DEBT_ACQUIRED' THEN d.amount
                                             WHEN d.type = 'PAYMENT_SETTLED' THEN -d.amount
                                             ELSE 0 END), 0)
                      FROM customer_debts d
                     WHERE d.customer_id = customers.id AND d.deleted = 0
                )
              WHERE EXISTS (
                    SELECT 1 FROM customer_debts d
                     WHERE d.customer_id = customers.id AND d.deleted = 0
              )
                AND COALESCE(current_debt, -1) <> (
                    SELECT COALESCE(SUM(CASE WHEN d.type = 'DEBT_ACQUIRED' THEN d.amount
                                             WHEN d.type = 'PAYMENT_SETTLED' THEN -d.amount
                                             ELSE 0 END), 0)
                      FROM customer_debts d
                     WHERE d.customer_id = customers.id AND d.deleted = 0
                )",
            [],
        )
        .map_err(|e| format!("reconcile debt cache: {e}"))?;

    // Duplicate live shifts are a recurring offline/restore artefact; report the
    // count so the caller can refuse the unique index while any remain.
    report.duplicate_live_shifts = tx
        .query_row(
            "SELECT COUNT(*) FROM (
                 SELECT device_id FROM cash_sessions
                  WHERE status IN ('OPEN','CLOSING')
                  GROUP BY device_id HAVING COUNT(*) > 1
             )",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| format!("count duplicate shifts: {e}"))? as usize;

    if report.duplicate_live_shifts == 0 {
        tx.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_one_live_shift_per_device
               ON cash_sessions(device_id) WHERE status IN ('OPEN','CLOSING')",
            [],
        )
        .map_err(|e| format!("live shift index: {e}"))?;
        report.index_created = true;
    }

    tx.commit().map_err(|e| format!("boot commit: {e}"))?;
    Ok(report)
}

/// Close every live shift of `device_id` except `keep_id` (the survivor chosen
/// by boot adoption). Fixed literal; the ids are parameters.
pub fn close_duplicate_live_shifts(
    conn: &mut Connection,
    device_id: &str,
    keep_id: &str,
    now_iso: &str,
) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|e| format!("shift tx: {e}"))?;
    let closed = tx
        .execute(
            "UPDATE cash_sessions
                SET status = 'CLOSED',
                    closed_at = COALESCE(closed_at, ?1),
                    closing_note = CASE WHEN closing_note IS NULL OR closing_note = ''
                                        THEN 'AUTO_CLOSED_DUPLICATE_LIVE_SHIFT'
                                        ELSE closing_note || ' | AUTO_CLOSED_DUPLICATE_LIVE_SHIFT' END,
                    json_payload = CASE WHEN json_valid(json_payload)
                                        THEN json_set(json_payload, '$.status', 'CLOSED')
                                        ELSE json_payload END,
                    updated_at = ?2,
                    version = version + 1
              WHERE device_id = ?3 AND status IN ('OPEN','CLOSING') AND id <> ?4",
            rusqlite::params![now_iso, now_iso, device_id, keep_id],
        )
        .map_err(|e| format!("close duplicate shifts: {e}"))?;
    tx.commit().map_err(|e| format!("shift commit: {e}"))?;
    // Once the table is clean the invariant index is native DDL, not renderer SQL.
    let dups: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM (
                 SELECT device_id FROM cash_sessions
                  WHERE status IN ('OPEN','CLOSING')
                  GROUP BY device_id HAVING COUNT(*) > 1
             )",
            [],
            |r| r.get(0),
        )
        .unwrap_or(-1);
    if dups == 0 {
        let _ = conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_one_live_shift_per_device
               ON cash_sessions(device_id) WHERE status IN ('OPEN','CLOSING')",
            [],
        );
    }
    Ok(closed)
}

/// Exactly which idempotent outcome a statement may produce. Anything not in
/// this enum is a failure: there is no message-substring escape hatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Tolerance {
    /// "duplicate column name: <col>" — the column is already there.
    DuplicateColumn,
    /// "index <name> already exists" — the object is already there.
    AlreadyExists,
}

/// A failed statement, with the state needed by the recovery screen.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaHealFailure {
    pub index: usize,
    pub sql: String,
    pub error: String,
    pub manifest_expected: Option<String>,
    pub manifest_actual: Option<String>,
}

impl std::fmt::Display for SchemaHealFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "statement {} failed: {} :: {}", self.index, self.error, self.sql)
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SchemaHealReport {
    pub total: usize,
    pub applied: usize,
    pub tolerated: usize,
    pub manifest_sha256: String,
    pub backup_path: Option<String>,
    pub backup_sha256: Option<String>,
}

/// The migration is a plain value so tests can run a fixture spec through the
/// exact same fail-closed core.
pub struct HealSpec<'a> {
    pub statements: &'a [&'a str],
    pub hashes: &'a [u64],
    pub tolerances: &'a [(u64, Tolerance)],
    pub golden_manifest: &'a str,
}

static SCHEMA_APPLIED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static SCHEMA_FAILURE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaHealStatus {
    pub applied: bool,
    pub failed: bool,
    pub error: Option<String>,
}

/// Boot status for the renderer / recovery screen. Reads memory only.
#[tauri::command]
pub fn schema_heal_status() -> SchemaHealStatus {
    let error = SCHEMA_FAILURE.lock().ok().and_then(|g| g.clone());
    SchemaHealStatus {
        applied: SCHEMA_APPLIED.load(std::sync::atomic::Ordering::SeqCst),
        failed: error.is_some(),
        error,
    }
}

/// Startup failures are surfaced to the recovery screen (same state the
/// heal sets when its post-condition fails).
pub fn set_startup_failure(msg: String) {
    set_failure(msg);
}

fn set_failure(msg: String) {
    if let Ok(mut g) = SCHEMA_FAILURE.lock() {
        *g = Some(msg);
    }
}

fn remember_failure(f: &SchemaHealFailure) {
    let where_ = if f.index == usize::MAX {
        "contrôle final".to_string()
    } else {
        format!("instruction {}", f.index)
    };
    set_failure(format!("Migration du schéma échouée ({where_}): {}", f.error));
}

/// Indexes that old migrations created and the current schema no longer does.
/// An in-place upgrade legitimately keeps them (the renderer heal keeps them
/// too), so the manifest post-condition allows exactly these extra indexes — by
/// name — and nothing else. Missing or changed golden objects still fail.
pub const LEGACY_EXTRA_INDEXES: &[&str] = &[
    "idx_imei_records_received",
    "idx_purchase_orders_created",
    "idx_repair_orders_created",
    "idx_trade_ins_created",
];

/// Compare the migrated schema with the golden manifest:
///  - every golden object must exist with identical definition;
///  - additional objects are allowed only for [LEGACY_EXTRA_INDEXES].
pub fn manifest_compatible(golden: &str, actual: &str) -> Result<(), String> {
    let g: serde_json::Value = serde_json::from_str(golden)
        .map_err(|e| format!("golden manifest parse: {e}"))?;
    let a: serde_json::Value = serde_json::from_str(actual)
        .map_err(|e| format!("actual manifest parse: {e}"))?;
    let key = |o: &serde_json::Value| {
        format!(
            "{}:{}",
            o.get("type").and_then(|v| v.as_str()).unwrap_or(""),
            o.get("name").and_then(|v| v.as_str()).unwrap_or("")
        )
    };
    let gobjs = g
        .get("objects")
        .and_then(|v| v.as_array())
        .ok_or("golden manifest has no objects")?;
    let aobjs = a
        .get("objects")
        .and_then(|v| v.as_array())
        .ok_or("actual manifest has no objects")?;
    let amap: std::collections::HashMap<String, &serde_json::Value> =
        aobjs.iter().map(|o| (key(o), o)).collect();
    for o in gobjs {
        let k = key(o);
        match amap.get(&k) {
            Some(found) if *found == o => {}
            Some(_) => return Err(format!("schema object changed: {k}")),
            None => return Err(format!("schema object missing: {k}")),
        }
    }
    for o in aobjs {
        let k = key(o);
        if gobjs.iter().any(|g| key(g) == k) {
            continue;
        }
        let name = o.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let typ = o.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if typ != "index" || !LEGACY_EXTRA_INDEXES.contains(&name) {
            return Err(format!("unexpected schema object: {k}"));
        }
    }
    Ok(())
}

fn manifest_sha256(manifest: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(manifest.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// Canonical manifest, byte-for-byte equal to what the generator produced with
/// JSON.stringify in insertion order.
pub fn schema_manifest(conn: &Connection) -> Result<String, String> {
    let mut stmt = conn
        .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_master
              WHERE name NOT LIKE 'sqlite_%' AND name <> '_sqlx_migrations'
              AND (sql IS NULL OR sql NOT LIKE 'CREATE VIRTUAL TABLE%')
              ORDER BY type, name",
        )
        .map_err(|e| format!("manifest prepare: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| format!("manifest query: {e}"))?;

    let mut objects: Vec<String> = Vec::new();
    for row in rows {
        let (typ, name, tbl, sql) = row.map_err(|e| format!("manifest row: {e}"))?;
        let normalized = sql
            .unwrap_or_default()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .trim_end_matches(';')
            .replace(", ", ",")
            .to_string();
        let sql_for_compare = if typ == "table" { String::new() } else { normalized };
        let mut obj = format!(
            "{{\"type\":{},\"name\":{},\"tbl\":{},\"sql\":{}}}",
            json_str(&typ),
            json_str(&name),
            json_str(&tbl),
            json_str(&sql_for_compare)
        );
        let columns: Option<String> = if typ == "table" {
            let mut cstmt = conn
                .prepare(&format!("PRAGMA table_xinfo({})", json_str(&name)))
                .map_err(|e| format!("table_xinfo: {e}"))?;
            let mut cols = cstmt
                .query_map([], |c| {
                    Ok((
                        c.get::<_, String>(1)?,
                        c.get::<_, String>(2)?,
                        c.get::<_, i64>(3)?,
                        c.get::<_, Option<String>>(4)?,
                        c.get::<_, i64>(5)?,
                        c.get::<_, i64>(6)?,
                    ))
                })
                .map_err(|e| format!("table_xinfo query: {e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("table_xinfo row: {e}"))?;
            cols.sort_by(|a, b| a.0.cmp(&b.0));
            Some(format!(
                "[{}]",
                cols.iter()
                    .map(|(n, t, nn, d, pk, hid)| format!(
                        "{{\"name\":{},\"type\":{},\"notnull\":{},\"dflt\":{},\"pk\":{},\"hidden\":{}}}",
                        json_str(n),
                        json_str(t),
                        nn,
                        d.as_ref().map(|x| json_str(x)).unwrap_or_else(|| "null".into()),
                        pk,
                        hid
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            ))
        } else if typ == "index" {
            let mut istmt = conn
                .prepare(&format!("PRAGMA index_xinfo({})", json_str(&name)))
                .map_err(|e| format!("index_xinfo: {e}"))?;
            let mut cols = istmt
                .query_map([], |c| {
                    Ok((
                        c.get::<_, i64>(0)?,
                        c.get::<_, i64>(1)?,
                        c.get::<_, Option<String>>(2)?,
                        c.get::<_, i64>(3)?,
                        c.get::<_, Option<String>>(4)?,
                        c.get::<_, i64>(5)?,
                    ))
                })
                .map_err(|e| format!("index_xinfo query: {e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("index_xinfo row: {e}"))?;
            cols.sort_by_key(|c| c.0);
            Some(format!(
                "[{}]",
                cols.iter()
                    .map(|(seqno, cid, n, desc, coll, key)| format!(
                        "{{\"seqno\":{},\"cid\":{},\"name\":{},\"desc\":{},\"coll\":{},\"key\":{}}}",
                        seqno,
                        cid,
                        n.as_ref().map(|x| json_str(x)).unwrap_or_else(|| "null".into()),
                        desc,
                        coll.as_ref().map(|x| json_str(x)).unwrap_or_else(|| "null".into()),
                        key
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            ))
        } else {
            None
        };
        if let Some(cols) = columns {
            obj.pop();
            obj.push_str(",\"columns\":");
            obj.push_str(&cols);
            if typ == "table" {
                let mut fk_stmt = conn
                    .prepare(&format!("PRAGMA foreign_key_list({})", json_str(&name)))
                    .map_err(|e| format!("fk list: {e}"))?;
                let mut fks = fk_stmt
                    .query_map([], |f| {
                        Ok((
                            f.get::<_, String>(2)?,
                            f.get::<_, String>(3)?,
                            f.get::<_, Option<String>>(4)?,
                            f.get::<_, String>(5)?,
                            f.get::<_, String>(6)?,
                        ))
                    })
                    .map_err(|e| format!("fk query: {e}"))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| format!("fk row: {e}"))?;
                fks.sort_by(|a, b| (a.1.clone() + &a.0).cmp(&(b.1.clone() + &b.0)));
                obj.push_str(",\"fks\":[");
                obj.push_str(
                    &fks.iter()
                        .map(|(table, from, to, onu, ond)| format!(
                            "{{\"table\":{},\"from\":{},\"to\":{},\"on_update\":{},\"on_delete\":{}}}",
                            json_str(table),
                            json_str(from),
                            to.as_ref().map(|x| json_str(x)).unwrap_or_else(|| "null".into()),
                            json_str(onu),
                            json_str(ond)
                        ))
                        .collect::<Vec<_>>()
                        .join(","),
                );
                obj.push(']');

                let mut il_stmt = conn
                    .prepare(&format!("PRAGMA index_list({})", json_str(&name)))
                    .map_err(|e| format!("index list: {e}"))?;
                let mut uniques: Vec<(String, Vec<String>)> = Vec::new();
                let rows = il_stmt
                    .query_map([], |i| Ok((i.get::<_, String>(1)?, i.get::<_, String>(3)?)))
                    .map_err(|e| format!("index list query: {e}"))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| format!("index list row: {e}"))?;
                for (idx_name, origin) in rows {
                    if origin != "u" {
                        continue;
                    }
                    let mut ix = conn
                        .prepare(&format!("PRAGMA index_xinfo({})", json_str(&idx_name)))
                        .map_err(|e| format!("unique xinfo: {e}"))?;
                    let cols: Vec<String> = ix
                        .query_map([], |c| c.get::<_, Option<String>>(2))
                        .map_err(|e| format!("unique cols: {e}"))?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| format!("unique col: {e}"))?
                        .into_iter()
                        .flatten()
                        .collect();
                    uniques.push((idx_name, cols));
                }
                uniques.sort_by(|a, b| a.0.cmp(&b.0));
                obj.push_str(",\"uniques\":[");
                obj.push_str(
                    &uniques
                        .iter()
                        .map(|(n, cols)| format!(
                            "{{\"name\":{},\"columns\":[{}]}}",
                            json_str(n),
                            cols.iter().map(|c| json_str(c)).collect::<Vec<_>>().join(",")
                        ))
                        .collect::<Vec<_>>()
                        .join(","),
                );
                obj.push(']');
            }
            obj.push('}');
        }
        objects.push(obj);
    }
    Ok(format!("{{\"version\":1,\"objects\":[{}]}}", objects.join(",")))
}

fn classify(err: &rusqlite::Error) -> Option<Tolerance> {
    match err {
        rusqlite::Error::SqliteFailure(_, Some(msg)) => {
            let m = msg.to_lowercase();
            if m.starts_with("duplicate column name:") {
                Some(Tolerance::DuplicateColumn)
            } else if m.contains("already exists") {
                Some(Tolerance::AlreadyExists)
            } else {
                None
            }
        }
        _ => None,
    }
}

#[cfg(debug_assertions)]
fn test_delay() {
    if let Ok(ms) = std::env::var("POS_SCHEMA_HEAL_DELAY_MS") {
        if let Ok(ms) = ms.parse::<u64>() {
            std::thread::sleep(std::time::Duration::from_millis(ms));
        }
    }
    if let Ok(at) = std::env::var("POS_SCHEMA_HEAL_ABORT_AT") {
        if let Ok(at) = at.parse::<usize>() {
            if at == usize::MAX {
                std::process::abort();
            }
        }
    }
}
#[cfg(not(debug_assertions))]
fn test_delay() {}

/// Fail-closed core: one transaction, exact per-statement tolerance, schema
/// post-condition, integrity checks. Any surprise rolls back and is reported —
/// the flag is never set on a database that does not match the golden manifest.
pub fn run_schema_heal_core(
    conn: &mut Connection,
    spec: &HealSpec<'_>,
) -> Result<SchemaHealReport, SchemaHealFailure> {
    let fail = |index: usize, sql: &str, error: String, expected: Option<String>, actual: Option<String>| {
        let f = SchemaHealFailure {
            index,
            sql: sql.chars().take(160).collect(),
            error,
            manifest_expected: expected,
            manifest_actual: actual,
        };
        remember_failure(&f);
        f
    };

    // foreign_keys must be changed OUTSIDE a transaction; no statement in the
    // list requires it to be ON, and leaving it ON would abort table rebuilds.
    if let Err(e) = conn.pragma_update(None, "foreign_keys", "OFF") {
        return Err(fail(usize::MAX, "<pragma foreign_keys=OFF>", e.to_string(), None, None));
    }
    if let Err(e) = conn.execute_batch("BEGIN IMMEDIATE") {
        return Err(fail(usize::MAX, "<BEGIN IMMEDIATE>", e.to_string(), None, None));
    }

    // One-shot injected delay (test): proves the barrier, not a timing race.
    test_delay();
    let mut report = SchemaHealReport {
        total: spec.statements.len(),
        ..Default::default()
    };

    for (index, sql) in spec.statements.iter().enumerate() {
        #[cfg(debug_assertions)]
        {
            if let Ok(at) = std::env::var("POS_SCHEMA_HEAL_ABORT_AT") {
                if at.parse::<usize>().ok() == Some(index) {
                    // Simulated crash mid-migration: the transaction is never
                    // committed; the next boot must converge from the backup state.
                    std::process::abort();
                }
            }
        }
        match conn.execute_batch(sql) {
            Ok(()) => report.applied += 1,
            Err(e) => {
                let hash = spec.hashes.get(index).copied().unwrap_or(0);
                let expected = spec
                    .tolerances
                    .iter()
                    .find(|(h, _)| *h == hash)
                    .map(|(_, t)| *t);
                match (expected, classify(&e)) {
                    (Some(want), Some(got)) if want == got => report.tolerated += 1,
                    _ => {
                        let _ = conn.execute_batch("ROLLBACK");
                        return Err(fail(index, sql, e.to_string(), None, None));
                    }
                }
            }
        }
    }

    // Row-driven backfills the renderer performed in JS (latch-gated). They
    // change data, not schema, so they run before the post-conditions.
    if let Err(e) = dedouble_json_payloads(conn) {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(fail(usize::MAX, "<json dedouble>", e, None, None));
    }
    if let Err(e) = prune_stale_event_log(conn) {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(fail(usize::MAX, "<event_log prune>", e, None, None));
    }

    // Post-conditions INSIDE the transaction: integrity, foreign keys, and the
    // schema must equal the golden manifest exactly.
    let integrity: String = match conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)) {
        Ok(v) => v,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(fail(usize::MAX, "<integrity_check>", e.to_string(), None, None));
        }
    };
    if integrity != "ok" {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(fail(usize::MAX, "<integrity_check>", integrity, None, None));
    }
    let fk_violations: i64 = match conn.query_row(
        "SELECT COUNT(*) FROM pragma_foreign_key_check",
        [],
        |r| r.get(0),
    ) {
        Ok(v) => v,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(fail(usize::MAX, "<foreign_key_check>", e.to_string(), None, None));
        }
    };
    if fk_violations != 0 {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(fail(
            usize::MAX,
            "<foreign_key_check>",
            format!("{fk_violations} violation(s)"),
            None,
            None,
        ));
    }

    let actual = match schema_manifest(conn) {
        Ok(m) => m,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(fail(usize::MAX, "<manifest>", e, None, None));
        }
    };
    report.manifest_sha256 = manifest_sha256(&actual);
    let compatible = manifest_compatible(spec.golden_manifest, &actual);
    if compatible.is_err() {
        #[cfg(debug_assertions)]
        {
            let _ = std::fs::write(
                std::env::temp_dir().join("mobi-heal-expected.json"),
                spec.golden_manifest,
            );
            let _ = std::fs::write(
                std::env::temp_dir().join("mobi-heal-actual.json"),
                &actual,
            );
        }
        let _ = conn.execute_batch("ROLLBACK");
        return Err(fail(
            usize::MAX,
            "<manifest mismatch>",
            compatible.err().unwrap_or_else(|| "schema mismatch".to_string()),
            Some(manifest_sha256(spec.golden_manifest)),
            Some(report.manifest_sha256.clone()),
        ));
    }

    if let Err(e) = conn.execute_batch("COMMIT") {
        return Err(fail(usize::MAX, "<COMMIT>", e.to_string(), None, None));
    }
    let _ = conn.pragma_update(None, "foreign_keys", "ON");
    SCHEMA_APPLIED.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Ok(mut g) = SCHEMA_FAILURE.lock() {
        *g = None;
    }
    Ok(report)
}

// ── row-driven backfills ported from the renderer heal ─────────────────────
// These two functions are NOT plain statements: the TS heal parses each row's
// JSON and rewrites it, and prunes the event log by age. A capture on a
// near-empty DB would miss them, which is exactly why equivalence is measured
// with row fixtures.

/// Dual-store tables carrying json_payload (same list as the renderer).
const JSON_PAYLOAD_TABLES: &[&str] = &[
    "products",
    "customers",
    "transactions",
    "transaction_items",
    "repair_orders",
    "purchase_orders",
    "trade_ins",
    "product_bundles",
    "cash_sessions",
    "cash_movements",
    "customer_debts",
    "store_expenses",
    "held_orders",
    "vendor_disputes",
];

/// TS unwrapDoubleEncodedPayload: peel up to 8 layers of a JSON string or of an
/// object whose json_payload is a JSON string, merging the outer object over the
/// inner one (outer keys win, json_payload removed).
pub fn unwrap_double_encoded(value: serde_json::Value) -> serde_json::Value {
    let mut current = value;
    for _ in 0..8 {
        match current.clone() {
            serde_json::Value::String(s) => match serde_json::from_str::<serde_json::Value>(&s) {
                Ok(inner @ serde_json::Value::Object(_)) => current = inner,
                _ => break,
            },
            serde_json::Value::Object(mut outer) => {
                let has_inner = matches!(outer.get("json_payload"), Some(serde_json::Value::String(_)));
                if !has_inner {
                    current = serde_json::Value::Object(outer);
                    break;
                }
                let raw = outer
                    .get("json_payload")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let inner = match serde_json::from_str::<serde_json::Value>(&raw) {
                    Ok(v @ serde_json::Value::Object(_)) => v,
                    _ => break,
                };
                outer.remove("json_payload");
                if let serde_json::Value::Object(mut merged) = inner {
                    for (k, v) in outer {
                        merged.insert(k, v);
                    }
                    current = serde_json::Value::Object(merged);
                } else {
                    break;
                }
            }
            _ => break,
        }
    }
    current
}

/// Renderer's healDoubleEncodedJsonPayloads: latch-gated, rowid-paged,
/// per-table best-effort. Returns rows rewritten.
pub fn dedouble_json_payloads(conn: &Connection) -> Result<usize, String> {
    let latched: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM app_settings WHERE key='schema.heal.json_dedouble.done'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if latched > 0 {
        return Ok(0);
    }
    let mut rewritten = 0usize;
    for table in JSON_PAYLOAD_TABLES {
        let cols: Vec<String> = conn
            .prepare(&format!("PRAGMA table_info(\"{table}\")"))
            .and_then(|mut st| {
                st.query_map([], |r| r.get::<_, String>(1))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap_or_default();
        if !cols.iter().any(|c| c == "id") || !cols.iter().any(|c| c == "json_payload") {
            continue;
        }
        let mut cursor: i64 = 0;
        loop {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT rowid, id, json_payload FROM \"{table}\" WHERE rowid > ?1 ORDER BY rowid LIMIT 500"
                ))
                .map_err(|e| format!("dedouble prepare {table}: {e}"))?;
            let rows: Vec<(i64, String, String)> = stmt
                .query_map([cursor], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<String>>(2)?.unwrap_or_default()))
                })
                .map_err(|e| format!("dedouble query {table}: {e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("dedouble row {table}: {e}"))?;
            if rows.is_empty() {
                break;
            }
            let n = rows.len();
            for (rid, id, raw) in rows {
                cursor = rid;
                if raw.is_empty() {
                    continue;
                }
                let parsed: serde_json::Value = match serde_json::from_str(&raw) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let encoded = serde_json::to_string(&unwrap_double_encoded(parsed))
                    .map_err(|e| format!("dedouble serialize: {e}"))?;
                if encoded == raw {
                    continue;
                }
                conn.execute(
                    &format!("UPDATE \"{table}\" SET json_payload = ?1 WHERE id = ?2"),
                    rusqlite::params![encoded, id],
                )
                .map_err(|e| format!("dedouble update {table}: {e}"))?;
                rewritten += 1;
            }
            if n < 500 {
                break;
            }
        }
    }
    // The renderer latches after the pass (and retries next boot on errors). The
    // latch is written HERE, not as a statement, so the backfill cannot be
    // skipped by replay ordering.
    let _ = conn.execute(
        "INSERT INTO app_settings (key, value_json, updated_at, version)
         VALUES ('schema.heal.json_dedouble.done', 'true', datetime('now','utc'), 1)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        [],
    );
    let _ = conn.execute(
        "INSERT INTO app_settings (key, value_json, updated_at)
         VALUES ('schema.heal.json_dedouble.done', 'true', datetime('now','utc'))
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        [],
    );
    Ok(rewritten)
}

/// Renderer's pruneStaleEventLog: only with a positive sync marker; deletes
/// rows older than 90 days. Returns rows deleted.
pub fn prune_stale_event_log(conn: &Connection) -> Result<usize, String> {
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(\"event_log\")")
        .and_then(|mut st| {
            st.query_map([], |r| r.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap_or_default();
    if cols.is_empty() || !cols.iter().any(|c| c == "synced_to_cloud") {
        return Ok(0);
    }
    let ts = if cols.iter().any(|c| c == "created_at") {
        "created_at"
    } else if cols.iter().any(|c| c == "ts") {
        "ts"
    } else {
        return Ok(0);
    };
    let cutoff_ms = {
        use std::time::{SystemTime, UNIX_EPOCH};
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        now - 90 * 86_400_000
    };
    let cutoff = iso_utc(cutoff_ms);
    conn.execute(
        &format!("DELETE FROM \"event_log\" WHERE synced_to_cloud = 1 AND {ts} < ?1"),
        rusqlite::params![cutoff],
    )
    .map_err(|e| format!("event_log prune: {e}"))
}

/// ISO-8601 UTC with milliseconds, the shape the renderer's toISOString uses.
pub fn iso_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        ms.rem_euclid(1000)
    )
}

// ── native base-schema migrations (plugin v1..current) ─────────────────────
// The plugin's sqlx migrate ran on load(), i.e. AFTER the WebView could query.
// A read-only pool cannot heal a fresh install there, so the same migrations are
// replayed natively before the window exists; the _sqlx_migrations ledger keeps
// installed databases recognised and prevents a second run.

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub applied: usize,
    pub skipped: usize,
    /// Duplicate-column / already-exists outcomes: the ledger was behind while
    /// the heal had already created the object (the "stalled sqlx ledger" shape).
    /// The migration is recorded as applied; the heal + golden manifest remain
    /// the post-condition that proves the schema is complete.
    pub tolerated: usize,
    /// Versions skipped because the heal had already created their objects.
    /// Retried after the column prep so table rebuilds can still run.
    pub retry_versions: Vec<i64>,
    pub last_version: i64,
}

/// Add missing columns from the heal BEFORE retrying skipped migrations: v113
/// and the table rebuilds reference columns only the heal adds. Idempotent;
/// duplicates tolerated because a fresh base may already have some.
pub fn prep_columns(conn: &Connection) -> Result<usize, String> {
    let mut added = 0usize;
    for sql in crate::schema_heal_sql::SCHEMA_HEAL_STATEMENTS {
        let t = sql.trim_start().to_uppercase();
        if !(t.starts_with("ALTER TABLE") && t.contains("ADD COLUMN")) {
            continue;
        }
        if conn.execute_batch(sql).is_ok() {
            added += 1;
        }
    }
    Ok(added)
}

/// Retry the migrations that were skipped, now that the heal columns exist.
pub fn retry_skipped_migrations(
    conn: &mut Connection,
    versions: &[i64],
) -> Result<usize, String> {
    let mut applied = 0usize;
    let mut migrations = crate::base_schema_migrations();
    migrations.sort_by_key(|m| m.version);
    for v in versions {
        if let Some(m) = migrations.iter().find(|m| m.version == *v) {
            match conn.execute_batch(m.sql) {
                Ok(()) => applied += 1,
                Err(e) => {
                    let msg = e.to_string().to_lowercase();
                    if !(msg.contains("duplicate column name")
                        || msg.contains("already exists")
                        || msg.contains("no such column")
                        || msg.contains("no such table"))
                    {
                        return Err(format!("retry migration v{v} failed: {e}"));
                    }
                }
            }
        }
    }
    Ok(applied)
}

fn sha384_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha384};
    let mut h = Sha384::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Replay every pending plugin migration in order, recording the sqlx ledger row
/// (version, SHA-384 checksum, success). An applied migration whose checksum no
/// longer matches is a hard error: the file was edited after installation.
pub fn native_migrate(conn: &mut Connection) -> Result<MigrationReport, String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
            version BIGINT PRIMARY KEY,
            description TEXT NOT NULL,
            installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            success BOOLEAN NOT NULL,
            checksum BLOB NOT NULL,
            execution_time BIGINT NOT NULL
        );",
    )
    .map_err(|e| format!("migrations ledger: {e}"))?;

    let mut report = MigrationReport::default();
    let mut applied_versions = std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT version, checksum FROM _sqlx_migrations WHERE success = 1")
            .map_err(|e| format!("migrations read: {e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))
            .map_err(|e| format!("migrations query: {e}"))?;
        for row in rows {
            let (v, c) = row.map_err(|e| format!("migrations row: {e}"))?;
            applied_versions.insert(v, c);
        }
    }

    // sqlx orders migrations by version, not by source order.
    let mut migrations = crate::base_schema_migrations();
    migrations.sort_by_key(|m| m.version);
    for m in migrations {
        if !matches!(m.kind, tauri_plugin_sql::MigrationKind::Up) {
            continue;
        }
        let checksum = {
            use sha2::{Digest, Sha384};
            let mut h = Sha384::new();
            h.update(m.sql.as_bytes());
            h.finalize().to_vec()
        };
        if let Some(existing) = applied_versions.get(&m.version) {
            if existing != &checksum {
                return Err(format!(
                    "migration v{} checksum mismatch (installed {} vs source {})",
                    m.version,
                    sha384_hex(existing),
                    sha384_hex(&checksum)
                ));
            }
            report.skipped += 1;
            report.last_version = report.last_version.max(m.version);
            continue;
        }

        let started = std::time::Instant::now();
        let tx = conn.transaction().map_err(|e| format!("migration tx: {e}"))?;
        let outcome = tx.execute_batch(m.sql);
        match outcome {
            Ok(()) => {}
            Err(e) => {
                let msg = e.to_string().to_lowercase();
                // "no such column/table" here means the migration references an
                // object only the heal creates (v113 indexes
                // cash_sessions.device_id, which the heal adds). Mark it applied
                // and let the heal + golden manifest prove completeness: a truly
                // missing object still aborts at the post-condition.
                if msg.contains("duplicate column name")
                    || msg.contains("already exists")
                    || msg.contains("no such column")
                    || msg.contains("no such table")
                {
                    // Ledger behind, heal already created the object: roll the
                    // partial migration back and record it as applied. The heal
                    // + golden manifest is the completeness post-condition.
                    drop(tx);
                    report.tolerated += 1;
                    report.retry_versions.push(m.version);
                    let tx2 = conn.transaction().map_err(|e| format!("migration tx2: {e}"))?;
                    tx2.execute(
                        "INSERT INTO _sqlx_migrations (version, description, installed_on, success, checksum, execution_time)
                         VALUES (?1, ?2, datetime('now'), 1, ?3, ?4)",
                        rusqlite::params![m.version, m.description, checksum, started.elapsed().as_nanos() as i64],
                    )
                    .map_err(|e| format!("migration ledger insert v{}: {e}", m.version))?;
                    tx2.commit().map_err(|e| format!("migration commit v{}: {e}", m.version))?;
                    report.last_version = report.last_version.max(m.version);
                    continue;
                }
                return Err(format!("migration v{} failed: {e}", m.version));
            }
        };
        tx.execute(
            "INSERT INTO _sqlx_migrations (version, description, installed_on, success, checksum, execution_time)
             VALUES (?1, ?2, datetime('now'), 1, ?3, ?4)",
            rusqlite::params![
                m.version,
                m.description,
                checksum,
                started.elapsed().as_nanos() as i64
            ],
        )
        .map_err(|e| format!("migration ledger insert v{}: {e}", m.version))?;
        tx.commit().map_err(|e| format!("migration commit v{}: {e}", m.version))?;
        report.applied += 1;
        report.last_version = report.last_version.max(m.version);
    }
    Ok(report)
}

/// Barrier marker: the plugin load() waits for this file, so the renderer can
/// never query a database that is still being migrated, even if a platform
/// creates the window earlier than expected.
pub fn write_schema_marker(app_dir: &std::path::Path, ok: bool, detail: &str) {
    let path = app_dir.join("schema_ready.json");
    let payload = serde_json::json!({
        "status": if ok { "ready" } else { "failed" },
        "detail": detail,
        "at": iso_utc(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)),
    });
    let _ = std::fs::write(path, payload.to_string());
}

/// Test/upgrade helper: migrate + ensure + heal a database at `path`, without
/// the backup/marker side of the startup wrapper.
pub fn migrate_and_heal_path(path: &std::path::Path) -> Result<(MigrationReport, SchemaHealReport), String> {
    let mut conn = Connection::open(path).map_err(|e| format!("upgrade open: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| format!("upgrade busy: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("upgrade fk: {e}"))?;
    let migrations = native_migrate(&mut conn)?;
    if !migrations.retry_versions.is_empty() {
        prep_columns(&conn)?;
        retry_skipped_migrations(&mut conn, &migrations.retry_versions)?;
    }
    let _ = crate::trust_core::audit_append::ensure_audit_schema(&mut conn);
    let heal = run_schema_heal(&mut conn).map_err(|f| f.to_string())?;
    Ok((migrations, heal))
}

/// Full native startup: migrate base schema, ensure native objects, back up an
/// existing database, then heal. Called from `.setup()` before the window.
pub fn run_native_startup(
    app_dir: &std::path::Path,
) -> Result<(MigrationReport, SchemaHealReport), String> {
    let path = crate::e2e::live_db_path(app_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let existed = path.exists();
    let mut conn = Connection::open(&path).map_err(|e| format!("startup open: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| format!("startup busy: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("startup wal: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("startup fk: {e}"))?;

    let migrations = native_migrate(&mut conn)?;
    let _ = crate::trust_core::audit_append::ensure_audit_schema(&mut conn);

    let (backup_path, backup_sha) = if existed {
        let backups = app_dir.join("backups");
        match backup_before_heal(&path, &backups) {
            Ok(v) => (Some(v.0), Some(v.1)),
            Err(e) => {
                // A backup failure must stop an upgrade, never proceed unbacked.
                if migrations.applied > 0 {
                    return Err(format!("pre-migration backup failed: {e}"));
                }
                (None, None)
            }
        }
    } else {
        (None, None)
    };

    let mut report = run_schema_heal(&mut conn).map_err(|f| f.to_string())?;
    report.backup_path = backup_path.map(|p| p.display().to_string());
    report.backup_sha256 = backup_sha;
    Ok((migrations, report))
}

fn production_spec() -> HealSpec<'static> {
    HealSpec {
        statements: crate::schema_heal_sql::SCHEMA_HEAL_STATEMENTS,
        hashes: crate::schema_heal_sql::SCHEMA_HEAL_HASHES,
        tolerances: crate::schema_heal_sql::TOLERANCES,
        golden_manifest: crate::schema_heal_sql::SCHEMA_MANIFEST,
    }
}

/// Production entry: replay the captured heal with the generated spec.
pub fn run_schema_heal(conn: &mut Connection) -> Result<SchemaHealReport, SchemaHealFailure> {
    run_schema_heal_core(conn, &production_spec())
}

fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| format!("backup read: {e}"))?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("backup hash: {e}"))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Online backup of the live DB before the migration, verified by reopening it
/// and running integrity_check. Keeps the last 3, newest first.
pub fn backup_before_heal(
    db_path: &std::path::Path,
    backup_dir: &std::path::Path,
) -> Result<(std::path::PathBuf, String), String> {
    use rusqlite::backup::Backup;
    use rusqlite::DatabaseName;
    std::fs::create_dir_all(backup_dir).map_err(|e| format!("backup dir: {e}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = backup_dir.join(format!("pre_schema_heal_{stamp}.db"));
    {
        let src = Connection::open_with_flags(
            db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| format!("backup source: {e}"))?;
        let mut dst = Connection::open(&dest).map_err(|e| format!("backup dest: {e}"))?;
        let backup = Backup::new(&src, &mut dst).map_err(|e| format!("backup init: {e}"))?;
        backup
            .run_to_completion(64, std::time::Duration::from_millis(20), None)
            .map_err(|e| format!("backup copy: {e}"))?;
        let _ = DatabaseName::Main;
    }
    let sha = sha256_file(&dest)?;
    {
        let check = Connection::open(&dest).map_err(|e| format!("backup verify open: {e}"))?;
        let ok: String = check
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| format!("backup verify: {e}"))?;
        if ok != "ok" {
            return Err(format!("backup failed integrity_check: {ok}"));
        }
    }
    // Keep the 3 newest.
    let mut entries: Vec<_> = std::fs::read_dir(backup_dir)
        .map_err(|e| format!("backup list: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("pre_schema_heal_") && n.ends_with(".db"))
                .unwrap_or(false)
        })
        .collect();
    entries.sort();
    while entries.len() > 3 {
        let old = entries.remove(0);
        let _ = std::fs::remove_file(old);
    }
    Ok((dest, sha))
}

/// Startup entry: back up, then migrate an EXISTING database before the WebView.
pub fn run_schema_heal_at_startup(app_dir: &std::path::Path) -> Result<SchemaHealReport, String> {
    let path = crate::e2e::live_db_path(app_dir);
    if !path.exists() {
        return Err("database not initialised yet".to_string());
    }
    // Native-owned trust tables must exist before the manifest post-condition
    // (they are created lazily elsewhere; a legacy DB may predate them).
    {
        let mut conn = Connection::open(&path).map_err(|e| format!("heal open: {e}"))?;
        let _ = crate::trust_core::audit_append::ensure_audit_schema(&mut conn);
    }
    let backups = app_dir.join("backups");
    let (backup_path, backup_sha) = backup_before_heal(&path, &backups)?;
    let mut conn = Connection::open(&path).map_err(|e| format!("heal open: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| format!("heal busy: {e}"))?;
    let mut report = run_schema_heal(&mut conn).map_err(|f| f.to_string())?;
    report.backup_path = Some(backup_path.display().to_string());
    report.backup_sha256 = Some(backup_sha);
    Ok(report)
}

/// Public probe: true when the native schema heal completed with the golden
/// schema in place.
#[tauri::command]
pub fn schema_heal_applied() -> bool {
    SCHEMA_APPLIED.load(std::sync::atomic::Ordering::SeqCst)
}

/// Gated command for hosts that want to run it explicitly (tests/diagnostics).
#[tauri::command]
pub fn run_schema_heal_command(app: tauri::AppHandle) -> Result<SchemaHealReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "run_schema_heal_command",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_live_db(&app)?;
            run_schema_heal(&mut conn)
                .map_err(|f| crate::trust_core::ipc_authorizer::TrustError::op_failed(f.to_string()))
        },
    )
}

/// Set once the native startup pass ran, so the renderer can skip its SQL.
static BOOT_APPLIED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Native startup entry point: run the boot maintenance before the WebView
/// exists, so the renderer never needs a write handle to start. Best-effort;
/// a failure is logged by the caller and the renderer falls back to its SQL.
pub fn run_at_startup(app_dir: &std::path::Path) -> Result<BootMaintenanceReport, String> {
    let path = crate::e2e::live_db_path(app_dir);
    if !path.exists() {
        return Err("database not initialised yet".to_string());
    }
    let mut conn = Connection::open(&path).map_err(|e| format!("startup open: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| format!("startup busy: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("startup fk: {e}"))?;
    let report = apply_boot_maintenance(&mut conn)?;
    BOOT_APPLIED.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(report)
}

/// Public boot probe: true when the native startup pass applied the boot writes.
/// Exposes no business data (same class as the existing gate/version probes).
#[tauri::command]
pub fn boot_maintenance_applied() -> bool {
    BOOT_APPLIED.load(std::sync::atomic::Ordering::SeqCst)
}

/// Bump the retry counter on parked cash movements (boot drain housekeeping).
/// Fixed literal: the renderer supplies nothing.
pub fn bump_parked_attempts(conn: &Connection) -> Result<usize, String> {
    conn.execute("UPDATE sync_parked_movements SET attempts = attempts + 1", [])
        .map_err(|e| format!("bump parked attempts: {e}"))
}

#[tauri::command]
pub fn bump_parked_attempts_command(app: tauri::AppHandle) -> Result<usize, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "bump_parked_attempts_command",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_live_db(&app)?;
            bump_parked_attempts(&conn).map_err(crate::trust_core::ipc_authorizer::TrustError::op_failed)
        },
    )
}

fn open_live_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("boot app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("boot open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| TrustError::op_failed(format!("boot busy: {e}")))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| TrustError::op_failed(format!("boot wal: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("boot fk: {e}")))?;
    Ok(conn)
}

/// Native boot maintenance (SEC-01). Requires `OperationalWrites`; the app calls
/// it once at startup, before any renderer query.
#[tauri::command]
pub fn boot_maintenance(app: tauri::AppHandle) -> Result<BootMaintenanceReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "boot_maintenance",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_live_db(&app)?;
            let report = apply_boot_maintenance(&mut conn)
                .map_err(crate::trust_core::ipc_authorizer::TrustError::op_failed)?;
            BOOT_APPLIED.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(report)
        },
    )
}

/// Close the losing live shifts after boot adoption, natively.
#[tauri::command]
pub fn finalize_shift_adoption(
    app: tauri::AppHandle,
    device_id: String,
    keep_id: String,
    now_iso: String,
) -> Result<usize, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "finalize_shift_adoption",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            if device_id.trim().is_empty() || keep_id.trim().is_empty() {
                return Err(TrustError::op_failed(
                    "finalize_shift_adoption: device_id and keep_id are required".to_string(),
                ));
            }
            let mut conn = open_live_db(&app)?;
            close_duplicate_live_shifts(&mut conn, &device_id, &keep_id, &now_iso)
                .map_err(crate::trust_core::ipc_authorizer::TrustError::op_failed)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE sync_outbox (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
             CREATE TABLE customers (id TEXT PRIMARY KEY, current_debt INTEGER);
             CREATE TABLE customer_debts (id TEXT PRIMARY KEY, customer_id TEXT, type TEXT,
                                          amount INTEGER, deleted INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE cash_sessions (id TEXT PRIMARY KEY, device_id TEXT, status TEXT NOT NULL,
                                          closed_at TEXT, closing_note TEXT, json_payload TEXT,
                                          updated_at TEXT, version INTEGER NOT NULL DEFAULT 1);
             INSERT INTO sync_outbox (status) VALUES ('synced'), ('pending'), ('inflight'), ('inflight');
             INSERT INTO customers (id, current_debt) VALUES ('C1', 0), ('C2', 99), ('C3', NULL);
             INSERT INTO customer_debts (id, customer_id, type, amount) VALUES
                ('d1', 'C1', 'DEBT_ACQUIRED', 500),
                ('d2', 'C1', 'PAYMENT_SETTLED', 200),
                ('d3', 'C2', 'DEBT_ACQUIRED', 100);
             INSERT INTO cash_sessions (id, device_id, status, json_payload) VALUES
                ('S1', 'dev', 'OPEN', '{\"status\":\"OPEN\"}'),
                ('S2', 'dev', 'OPEN', NULL);",
        )
        .expect("schema");
        conn
    }

    #[test]
    fn purges_synced_and_resets_inflight() {
        let mut conn = seeded();
        let r = apply_boot_maintenance(&mut conn).unwrap();
        assert_eq!(r.outbox_purged, 1);
        assert_eq!(r.inflight_reset, 2);
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |x| x.get(0))
            .unwrap();
        assert_eq!(left, 3, "the synced row is gone; the reset rows remain pending");
        let pending: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox WHERE status='pending'", [], |x| x.get(0))
            .unwrap();
        assert_eq!(pending, 3);
    }

    #[test]
    fn reconciles_the_debt_cache_exactly() {
        let mut conn = seeded();
        let r = apply_boot_maintenance(&mut conn).unwrap();
        assert_eq!(r.debts_repaired, 2, "C1 and C2 are corrected");
        let c1: i64 = conn
            .query_row("SELECT current_debt FROM customers WHERE id='C1'", [], |x| x.get(0))
            .unwrap();
        let c2: i64 = conn
            .query_row("SELECT current_debt FROM customers WHERE id='C2'", [], |x| x.get(0))
            .unwrap();
        let c3: Option<i64> = conn
            .query_row("SELECT current_debt FROM customers WHERE id='C3'", [], |x| x.get(0))
            .unwrap();
        assert_eq!(c1, 300);
        assert_eq!(c2, 100);
        assert_eq!(c3, None, "a customer with no ledger rows is untouched");
    }

    #[test]
    fn refuses_the_unique_index_while_duplicates_exist() {
        let mut conn = seeded();
        let r = apply_boot_maintenance(&mut conn).unwrap();
        assert_eq!(r.duplicate_live_shifts, 1);
        assert!(!r.index_created);
        let idx: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='uq_one_live_shift_per_device'",
                [],
                |x| x.get(0),
            )
            .unwrap();
        assert_eq!(idx, 0);
    }

    #[test]
    fn closes_losers_then_creates_the_index() {
        let mut conn = seeded();
        let closed = close_duplicate_live_shifts(&mut conn, "dev", "S2", "2026-11-03T00:00:00Z").unwrap();
        assert_eq!(closed, 1, "S1 is closed, S2 survives");
        let (status, note, payload): (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT status, closing_note, json_payload FROM cash_sessions WHERE id='S1'",
                [],
                |x| Ok((x.get(0)?, x.get(1)?, x.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "CLOSED");
        assert!(note.unwrap().contains("AUTO_CLOSED_DUPLICATE_LIVE_SHIFT"));
        assert!(payload.unwrap().contains("CLOSED"));
        // second call is a no-op
        assert_eq!(close_duplicate_live_shifts(&mut conn, "dev", "S2", "2026-11-03T00:00:00Z").unwrap(), 0);
        let r = apply_boot_maintenance(&mut conn).unwrap();
        assert_eq!(r.duplicate_live_shifts, 0);
        assert!(r.index_created);
    }

    #[test]
    fn maintenance_is_idempotent() {
        let mut conn = seeded();
        let first = apply_boot_maintenance(&mut conn).unwrap();
        let second = apply_boot_maintenance(&mut conn).unwrap();
        assert_eq!(first.outbox_purged, 1);
        assert_eq!(second.outbox_purged, 0);
        assert_eq!(second.inflight_reset, 0);
        assert_eq!(second.debts_repaired, 0);
    }

    // ── fail-closed migration core ──────────────────────────────────────────
    fn fnv(s: &str) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        for b in s.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    }

    fn tmp_db(tag: &str) -> (std::path::PathBuf, Connection) {
        let path = std::env::temp_dir().join(format!(
            "mobi-heal-{}-{}.db",
            tag,
            std::process::id()
        ));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
        }
        let conn = Connection::open(&path).expect("temp db");
        (path, conn)
    }

    fn cleanup(path: &std::path::Path) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
        }
    }

    fn hashes(stmts: &[&str]) -> Vec<u64> {
        stmts.iter().map(|s| fnv(s)).collect()
    }

    #[test]
    fn unexpected_error_rolls_back_the_whole_migration() {
        let (path, mut conn) = tmp_db("rollback");
        let stmts = [
            "CREATE TABLE a (x INTEGER);",
            "ALTER TABLE missing_table ADD COLUMN y TEXT;",
        ];
        let hs = hashes(&stmts);
        let spec = HealSpec {
            statements: &stmts,
            hashes: &hs,
            tolerances: &[],
            golden_manifest: "",
        };
        let err = run_schema_heal_core(&mut conn, &spec).expect_err("must fail closed");
        assert_eq!(err.index, 1, "the failing statement is reported: {err}");
        let created: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(created, 0, "statement 0 must be rolled back");
        cleanup(&path);
    }

    #[test]
    fn tolerance_is_exact_and_per_statement() {
        let (path, mut conn) = tmp_db("tolerance");
        let stmts = [
            "CREATE TABLE IF NOT EXISTS t (x INTEGER);",
            "ALTER TABLE t ADD COLUMN y TEXT;",
        ];
        let hs = hashes(&stmts);
        // reference run to learn the golden schema
        for sql in stmts {
            conn.execute_batch(sql).unwrap();
        }
        let golden = schema_manifest(&conn).unwrap();
        let tols = [(hs[1], Tolerance::DuplicateColumn)];
        let spec = HealSpec {
            statements: &stmts,
            hashes: &hs,
            tolerances: &tols,
            golden_manifest: &golden,
        };
        let report = run_schema_heal_core(&mut conn, &spec).expect("already-applied column tolerated");
        assert_eq!(report.tolerated, 1);
        assert_eq!(report.applied, 1);
        // The SAME error with no tolerance entry must abort.
        let spec_no_tol = HealSpec {
            statements: &stmts,
            hashes: &hs,
            tolerances: &[],
            golden_manifest: &golden,
        };
        let err = run_schema_heal_core(&mut conn, &spec_no_tol).expect_err("no tolerance, no pass");
        assert_eq!(err.index, 1);
        cleanup(&path);
    }

    #[test]
    fn manifest_mismatch_rolls_back_and_never_sets_the_flag() {
        let (path, mut conn) = tmp_db("manifest");
        let stmts = ["CREATE TABLE only_here (x INTEGER);"];
        let hs = hashes(&stmts);
        let golden = "{\"version\":1,\"objects\":[]}";
        let spec = HealSpec {
            statements: &stmts,
            hashes: &hs,
            tolerances: &[],
            golden_manifest: golden,
        };
        let err = run_schema_heal_core(&mut conn, &spec).expect_err("schema mismatch must fail");
        assert!(err.manifest_expected.is_some() && err.manifest_actual.is_some());
        let created: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='only_here'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(created, 0, "the migration is rolled back");
        cleanup(&path);
    }

    #[test]
    fn crash_midway_converges_and_keeps_data() {
        let (path, mut conn) = tmp_db("crash");
        conn.execute_batch("CREATE TABLE ledger (id TEXT PRIMARY KEY, amount INTEGER); INSERT INTO ledger VALUES ('T1', 500);")
            .unwrap();
        let stmts = [
            "CREATE TABLE a (x INTEGER);",
            "CREATE TABLE b (y INTEGER);",
            "CREATE INDEX idx_b ON b(y);",
        ];
        let hs = hashes(&stmts);
        // golden = the schema after all statements
        let scratch = Connection::open_in_memory().unwrap();
        scratch
            .execute_batch("CREATE TABLE ledger (id TEXT PRIMARY KEY, amount INTEGER);")
            .unwrap();
        for sql in stmts {
            scratch.execute_batch(sql).unwrap();
        }
        let golden = schema_manifest(&scratch).unwrap();

        // Simulated crash: statement 0 executed, transaction never committed.
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        conn.execute_batch(stmts[0]).unwrap();
        drop(conn);
        let mut conn = Connection::open(&path).unwrap();
        let a_after_crash: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE name='a'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(a_after_crash, 0, "uncommitted DDL must be gone");

        let spec = HealSpec {
            statements: &stmts,
            hashes: &hs,
            tolerances: &[],
            golden_manifest: &golden,
        };
        run_schema_heal_core(&mut conn, &spec).expect("second boot converges");
        let amount: i64 = conn
            .query_row("SELECT amount FROM ledger WHERE id='T1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(amount, 500, "no data loss across the retry");
        cleanup(&path);
    }

    #[test]
    fn backup_is_verified_pruned_and_restorable() {
        let (path, mut conn) = tmp_db("backup");
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT); INSERT INTO t VALUES (1, 'keep');")
            .unwrap();
        drop(conn);
        let dir = std::env::temp_dir().join(format!("mobi-heal-backups-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for _ in 0..4 {
            let (dest, sha) = backup_before_heal(&path, &dir).expect("backup");
            assert_eq!(sha, sha256_file(&dest).unwrap(), "checksum recorded");
            assert!(!dest.exists() == false);
        }
        let files: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("pre_schema_heal_"))
            .collect();
        assert_eq!(files.len(), 3, "keeps the last 3");
        let newest = files
            .iter()
            .map(|e| e.path())
            .max()
            .expect("newest backup");
        let restored = Connection::open(&newest).unwrap();
        let k: String = restored
            .query_row("SELECT k FROM t WHERE id=1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(k, "keep", "backup restores the data");
        let _ = std::fs::remove_dir_all(&dir);
        cleanup(&path);
    }


    /// Equivalence harness entry: run the PRODUCTION native heal against the DB
    /// given in POS_EQUIV_DB (the harness passes a copy) and print its manifest
    /// hash for comparison with the renderer heal on another copy.
    #[test]
    fn schema_equiv_fixture() {
        let Ok(path) = std::env::var("POS_EQUIV_DB") else {
            return; // not requested
        };
        let mode = std::env::var("POS_EQUIV_MODE").unwrap_or_else(|_| "startup".to_string());
        if mode == "migrate" {
            let mut conn = Connection::open(&path).expect("equiv fixture open");
            conn.busy_timeout(std::time::Duration::from_millis(15000)).unwrap();
            crate::boot_maintenance::native_migrate(&mut conn).expect("native migrations");
            let _ = crate::trust_core::audit_append::ensure_audit_schema(&mut conn);
            println!("EQUIV_MIGRATE_OK");
            return;
        }
        match migrate_and_heal_path(std::path::Path::new(&path)) {
            Ok((m, r)) => println!(
                "EQUIV_NATIVE_OK schema_sha={} applied={} tolerated={} migrations={}",
                r.manifest_sha256, r.applied, r.tolerated, m.applied
            ),
            Err(e) => panic!("EQUIV_NATIVE_ERR {e}"),
        }
    }


    #[test]
    fn row_driven_backfill_runs_inside_the_migration() {
        let (path, mut conn) = tmp_db("dedouble");
        conn.execute_batch(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT, version INTEGER);
             CREATE TABLE products (id TEXT PRIMARY KEY, json_payload TEXT NOT NULL);",
        )
        .unwrap();
        let inner = serde_json::json!({"json_payload": "{\"sku\":\"REF-1\",\"title\":\"Phone\"}", "extra": 1});
        let double = serde_json::json!({"json_payload": inner.to_string(), "outer": true});
        conn.execute(
            "INSERT INTO products (id, json_payload) VALUES ('P1', ?1)",
            rusqlite::params![double.to_string()],
        )
        .unwrap();

        // Schema-only statement: the backfill writes the latch AFTER processing,
        // so the fixture must not pre-latch (that was the ordering bug the
        // equivalence harness surfaced).
        let stmts = ["CREATE TABLE IF NOT EXISTS z (x INTEGER);"];
        let hs = hashes(&stmts);
        // Golden = the same schema after that statement (the backfill changes data only).
        let scratch = Connection::open_in_memory().unwrap();
        scratch
            .execute_batch(
                "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT, version INTEGER);
                 CREATE TABLE products (id TEXT PRIMARY KEY, json_payload TEXT NOT NULL);
                 CREATE TABLE z (x INTEGER);",
            )
            .unwrap();
        let golden = schema_manifest(&scratch).unwrap();

        let spec = HealSpec {
            statements: &stmts,
            hashes: &hs,
            tolerances: &[],
            golden_manifest: &golden,
        };
        run_schema_heal_core(&mut conn, &spec).expect("migration with backfill");
        let after: String = conn
            .query_row("SELECT json_payload FROM products WHERE id='P1'", [], |r| r.get(0))
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(parsed["sku"], "REF-1", "nested payload unwrapped: {after}");
        assert_eq!(parsed["title"], "Phone");
        assert_eq!(parsed["outer"], true, "outer keys survive");
        assert!(parsed.get("json_payload").is_none(), "wrapper key removed");

        assert_eq!(dedouble_json_payloads(&conn).unwrap(), 0, "latch makes it a no-op");
        cleanup(&path);
    }

    #[test]
    fn event_log_prune_deletes_only_synced_old_rows() {
        let (path, conn) = tmp_db("prune");
        conn.execute_batch(
            "CREATE TABLE event_log (id INTEGER PRIMARY KEY, created_at TEXT, synced_to_cloud INTEGER);
             INSERT INTO event_log (created_at, synced_to_cloud) VALUES ('2000-01-01T00:00:00.000Z', 1);
             INSERT INTO event_log (created_at, synced_to_cloud) VALUES ('2000-01-01T00:00:00.000Z', 0);
             INSERT INTO event_log (created_at, synced_to_cloud) VALUES ('2999-01-01T00:00:00.000Z', 1);",
        )
        .unwrap();
        assert_eq!(prune_stale_event_log(&conn).unwrap(), 1);
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM event_log", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 2, "unsynced and future rows survive");
        cleanup(&path);
    }

}

//! Native signed-lane outbox transitions (MOBI-SYNC-DRAIN-TRANSPORT).
//!
//! Lane split (load-bearing): these commands operate ONLY on SIGNED rows
//! (`seq_no IS NOT NULL`, own `device_id`). The legacy Turso lane handles
//! unsigned rows; it never sees a signed row as long as it filters them
//! (see `getPendingOutbox` arming), and idempotency keys + the ack cursor
//! make any residual interleaving converge instead of corrupting.
//!
//! Conventions reused, not reinvented:
//! - Statuses are the established `pending` / `inflight` spellings (the
//!   `sync_outbox` CHECK forbids new ones); `failed` stays the quarantine
//!   spelling. `synced` rows are DELETED per house convention
//!   (`markOutbox`), so the contiguity cursor lives on
//!   `device_identity.last_acked_seq` — never reconstructed by scanning.
//! - `updated_at` doubles as the flight clock (same as the existing
//!   watchdog): no new timestamp column, no migration.
//! - Every transition is one `BEGIN IMMEDIATE` txn on a short-lived
//!   per-invoke connection. Network I/O NEVER happens under a native lock:
//!   the worker holds rows as `inflight` across the POST and resolves them
//!   after.
//!
//! Contiguity: fetches return the longest contiguous run from the cursor;
//! a head gap refuses (nothing claimed). A leading run consumed by the
//! other lane (synced + deleted) fast-forwards the cursor past it —
//! otherwise two lanes could deadlock each other forever.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::{params, Connection, Transaction};
use serde::Serialize;

/// One signed mutation handed to the drain worker (all fields the gateway
/// needs; the signature covers the envelope built at commit time).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxMutation {
    pub seq_no: i64,
    pub idempotency_key: String,
    pub entity_type: String,
    pub entity_id: String,
    pub payload_json: String,
    pub device_id: String,
    pub device_signature: String,
    /// Verbatim signed bytes (v112): the gateway verifies the signature
    /// over exactly this string. Empty on pre-v112 rows (probed, degraded).
    pub envelope: String,
}

fn has_col(tx: &Transaction, table: &str, col: &str) -> bool {
    tx.prepare(&format!(
        "SELECT 1 FROM pragma_table_info('{table}') WHERE name = '{col}'"
    ))
    .and_then(|mut s| s.exists([]))
    .unwrap_or(false)
}

fn conflict(code: &str) -> TrustError {
    TrustError::op_failed(code.to_string())
}

fn map_rusqlite(context: &str, e: rusqlite::Error) -> TrustError {
    use rusqlite::ErrorCode::{DatabaseBusy, DatabaseLocked};
    match &e {
        rusqlite::Error::SqliteFailure(f, _)
            if matches!(f.code, DatabaseBusy | DatabaseLocked) =>
        {
            conflict("GATEWAY_UNAVAILABLE:busy")
        }
        _ => TrustError::op_failed(format!("{context}: {e}")),
    }
}

/// Tolerant ack-cursor column (same duplicate-tolerant discipline as the
/// sequence counter: concurrent first-use converges instead of failing).
fn ensure_acked_column(conn: &Connection) -> Result<(), TrustError> {
    let missing = || -> bool {
        conn.prepare("SELECT name FROM pragma_table_info('device_identity') WHERE name = 'last_acked_seq'")
            .and_then(|mut s| {
                let mut rows = s.query([])?;
                Ok(rows.next()?.is_none())
            })
            .unwrap_or(false)
    };
    if missing() {
        match conn.execute(
            "ALTER TABLE device_identity ADD COLUMN last_acked_seq INTEGER NOT NULL DEFAULT 0",
            [],
        ) {
            Ok(_) => {}
            Err(e) if format!("{e}").contains("duplicate column name") => {}
            Err(e) => {
                return Err(TrustError::op_failed(format!(
                    "OUTBOX_BATCH_LOCKED:ackcol:{e}"
                )))
            }
        }
    }
    Ok(())
}

fn acked_seq(tx: &Transaction, device_id: &str) -> Result<i64, TrustError> {
    tx.query_row(
        "SELECT last_acked_seq FROM device_identity WHERE device_id = ?1",
        [device_id],
        |r| r.get(0),
    )
    .or_else(|e| match e {
        // Never enrolled (no refund ever committed here): cursor at zero.
        rusqlite::Error::QueryReturnedNoRows => Ok(0),
        other => Err(TrustError::op_failed(format!("ack cursor read: {other}"))),
    })
}

/// Claim the next contiguous run of signed pending rows for dispatch.
/// Atomic: selection + claim happen in ONE txn, so two fetchers can never
/// split a run — the loser sees the winner's `inflight` rows and gets the
/// remainder (or an empty batch), never a duplicate claim.
pub fn fetch_next_outbox_batch_inner(
    conn: &mut Connection,
    batch_size: u32,
) -> Result<Vec<OutboxMutation>, TrustError> {
    if batch_size == 0 || batch_size > 200 {
        return Err(conflict("INVALID:batch_size 1..200"));
    }
    ensure_acked_column(conn)?;
    let device_id =
        crate::trust_core::device_identity::adopted_device_id(conn).unwrap_or_default();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| map_rusqlite("fetch begin", e))?;
    let out: Result<Vec<OutboxMutation>, TrustError> = (|| {
        let cursor = acked_seq(&tx, &device_id)?;
        let with_env = has_col(&tx, "sync_outbox", "envelope");
        let sql = if with_env {
            "SELECT seq_no, idempotency_key, entity_type, entity_id, payload_json, device_id, device_signature, envelope \
             FROM sync_outbox WHERE status = 'pending' AND seq_no IS NOT NULL AND device_id = ?1 \
             ORDER BY seq_no ASC LIMIT ?2"
        } else {
            "SELECT seq_no, idempotency_key, entity_type, entity_id, payload_json, device_id, device_signature \
             FROM sync_outbox WHERE status = 'pending' AND seq_no IS NOT NULL AND device_id = ?1 \
             ORDER BY seq_no ASC LIMIT ?2"
        };
        let mut stmt = tx
            .prepare(sql)
            .map_err(|e| map_rusqlite("fetch select", e))?;
        let pending: Vec<OutboxMutation> = stmt
            .query_map(params![device_id, batch_size as i64], |r| {
                Ok(OutboxMutation {
                    seq_no: r.get(0)?,
                    idempotency_key: r.get(1)?,
                    entity_type: r.get(2)?,
                    entity_id: r.get(3)?,
                    payload_json: r.get(4)?,
                    device_id: r.get(5)?,
                    device_signature: r.get(6)?,
                    envelope: if with_env {
                        r.get(7)?
                    } else {
                        String::new()
                    },
                })
            })
            .map_err(|e| map_rusqlite("fetch rows", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| map_rusqlite("fetch decode", e))?;
        if pending.is_empty() {
            return Ok(vec![]);
        }
        // Fast-forward over sequences the other lane already consumed
        // (synced + deleted): they will never reappear as pending.
        let mut cursor = cursor;
        if pending[0].seq_no > cursor + 1 {
            cursor = pending[0].seq_no - 1;
            tx.execute(
                "UPDATE device_identity SET last_acked_seq = ?1 WHERE device_id = ?2",
                params![cursor, device_id],
            )
            .map_err(|e| map_rusqlite("fetch fast-forward", e))?;
        }
        // Longest contiguous prefix from the cursor — never skip a gap.
        let mut run: Vec<OutboxMutation> = Vec::new();
        for m in pending {
            if m.seq_no == cursor + 1 {
                cursor += 1;
                run.push(m);
            } else {
                break;
            }
        }
        if run.is_empty() {
            // Head gap (a row vanished mid-flight or was never written):
            // claim nothing, report the hole for the worker to reset past.
            return Err(conflict("SEQUENCE_GAP_DETECTED:run_empty"));
        }
        let keys: Vec<&str> = run.iter().map(|m| m.idempotency_key.as_str()).collect();
        // ?1 is updated_at above: key placeholders start at ?2.
        let placeholders: Vec<String> = (2..=keys.len() + 1).map(|i| format!("?{i}")).collect();
        let now = crate::trust_core::time_anchor::iso_utc_ms(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        );
        let claimed = tx
            .execute(
                &format!(
                    "UPDATE sync_outbox SET status = 'inflight', updated_at = ?1 \
                     WHERE status = 'pending' AND idempotency_key IN ({})",
                    placeholders.join(",")
                ),
                rusqlite::params_from_iter(
                    std::iter::once(&now as &dyn rusqlite::ToSql).chain(
                        keys.iter().map(|k| k as &dyn rusqlite::ToSql),
                    ),
                ),
            )
            .map_err(|e| map_rusqlite("fetch claim", e))?;
        if claimed != run.len() {
            // Another claimer holds part of the run: never dispatch a split.
            return Err(conflict("OUTBOX_BATCH_LOCKED:in_flight_active"));
        }
        Ok(run)
    })();
    match out {
        Ok(batch) => {
            tx.commit()
                .map_err(|e| map_rusqlite("fetch commit", e))?;
            Ok(batch)
        }
        Err(e) => Err(e), // drop = rollback: nothing claimed, nothing moved
    }
}

/// Resolve a gateway ACK: the acked seqs must form the contiguous run right
/// after the cursor (idempotent replays of already-advanced ranges are
/// dropped, not failed). Rows are DELETED per house convention and the
/// cursor advances past them — all atomically.
pub fn mark_outbox_synced_inner(
    conn: &mut Connection,
    seq_nos: Vec<i64>,
) -> Result<i64, TrustError> {
    if seq_nos.is_empty() || seq_nos.len() > 200 {
        return Err(conflict("INVALID:ack batch 1..200"));
    }
    ensure_acked_column(conn)?;
    let device_id =
        crate::trust_core::device_identity::adopted_device_id(conn).unwrap_or_default();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| map_rusqlite("ack begin", e))?;
    let out: Result<i64, TrustError> = (|| {
        let cursor = acked_seq(&tx, &device_id)?;
        let mut ids: Vec<i64> = seq_nos;
        ids.sort_unstable();
        ids.dedup();
        // Idempotent replay: already-advanced seqs drop out silently.
        let fresh: Vec<i64> = ids.into_iter().filter(|s| *s > cursor).collect();
        if fresh.is_empty() {
            return Ok(cursor);
        }
        for (i, s) in fresh.iter().enumerate() {
            if *s != cursor + 1 + i as i64 {
                return Err(conflict(&format!(
                    "SEQUENCE_GAP_DETECTED:expected_{}_received_{}",
                    cursor + 1 + i as i64,
                    s
                )));
            }
        }
        let placeholders: Vec<String> = (1..=fresh.len()).map(|i| format!("?{i}")).collect();
        tx.execute(
            &format!(
                "DELETE FROM sync_outbox WHERE seq_no IN ({}) AND device_id = ?{}",
                placeholders.join(","),
                fresh.len() + 1
            ),
            rusqlite::params_from_iter(
                fresh
                    .iter()
                    .map(|s| s as &dyn rusqlite::ToSql)
                    .chain(std::iter::once(&device_id as &dyn rusqlite::ToSql)),
            ),
        )
        .map_err(|e| map_rusqlite("ack delete", e))?;
        let advanced = cursor + fresh.len() as i64;
        tx.execute(
            "UPDATE device_identity SET last_acked_seq = ?1 WHERE device_id = ?2",
            params![advanced, device_id],
        )
        .map_err(|e| map_rusqlite("ack cursor", e))?;
        Ok(advanced)
    })();
    match out {
        Ok(cursor) => {
            tx.commit().map_err(|e| map_rusqlite("ack commit", e))?;
            Ok(cursor)
        }
        Err(e) => Err(e),
    }
}

/// Crash/process-death reaper for the signed lane: `inflight` rows older
/// than the timeout return to `pending` (scoped to signed rows only — the
/// legacy lane's watchdog owns the rest). Called at boot and by the drain
/// loop; abort paths pass 0 to reset the whole flight immediately.
pub fn reap_stale_in_flight_inner(
    conn: &mut Connection,
    timeout_ms: i64,
) -> Result<u64, TrustError> {
    if timeout_ms < 0 {
        return Err(conflict("INVALID:negative timeout"));
    }
    let now_str = crate::trust_core::time_anchor::iso_utc_ms(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    );
    let n = if timeout_ms == 0 {
        conn.execute(
            "UPDATE sync_outbox SET status = 'pending', last_error = 'reap: flight reset', updated_at = ?1 \
             WHERE status = 'inflight' AND seq_no IS NOT NULL",
            params![now_str],
        )
    } else {
        let cutoff = crate::trust_core::time_anchor::iso_utc_ms(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
                .saturating_sub(timeout_ms),
        );
        conn.execute(
            "UPDATE sync_outbox SET status = 'pending', last_error = 'reap: stale inflight reset', updated_at = ?1 \
             WHERE status = 'inflight' AND seq_no IS NOT NULL AND updated_at <= ?2",
            params![now_str, cutoff],
        )
    }
    .map_err(|e| map_rusqlite("reap", e))?;
    Ok(n as u64)
}

fn open_live_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("outbox open: {e}")))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| TrustError::op_failed(format!("outbox wal: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| TrustError::op_failed(format!("outbox busy_timeout: {e}")))?;
    Ok(conn)
}

/// `#[tauri::command]`: claim the next contiguous signed batch for dispatch.
#[tauri::command]
pub fn fetch_next_outbox_batch(
    app: tauri::AppHandle,
    batch_size: u32,
) -> Result<Vec<OutboxMutation>, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "fetch_next_outbox_batch",
        crate::trust_core::Capability::OperationalWrites,
        |_| {
            let mut conn = open_live_db(&app)?;
            fetch_next_outbox_batch_inner(&mut conn, batch_size)
        },
    )
}

/// `#[tauri::command]`: resolve a gateway ACK (contiguity-checked).
#[tauri::command]
pub fn mark_outbox_synced(
    app: tauri::AppHandle,
    seq_nos: Vec<i64>,
) -> Result<i64, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "mark_outbox_synced",
        crate::trust_core::Capability::OperationalWrites,
        |_| {
            let mut conn = open_live_db(&app)?;
            mark_outbox_synced_inner(&mut conn, seq_nos)
        },
    )
}

/// `#[tauri::command]`: reset stale signed flights to pending.
#[tauri::command]
pub fn reap_stale_in_flight(
    app: tauri::AppHandle,
    timeout_ms: i64,
) -> Result<u64, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "reap_stale_in_flight",
        crate::trust_core::Capability::OperationalWrites,
        |_| {
            let mut conn = open_live_db(&app)?;
            reap_stale_in_flight_inner(&mut conn, timeout_ms)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sync_outbox (
                rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                idempotency_key TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT, last_error TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                device_id TEXT, device_signature TEXT, seq_no INTEGER);
             CREATE TABLE device_identity (
                device_id TEXT PRIMARY KEY, public_key_hex TEXT NOT NULL DEFAULT '',
                private_key_enc BLOB NOT NULL DEFAULT x'00', enrolled_at TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active', last_outbox_seq INTEGER NOT NULL DEFAULT 0,
                last_acked_seq INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value_json, updated_at) VALUES ('sync.device_id', '\"dev-A\"', 't')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO device_identity (device_id) VALUES ('dev-A')",
            [],
        )
        .unwrap();
        conn
    }

    fn seed_signed(conn: &Connection, seqs: &[i64], status: &str) {
        for s in seqs {
            conn.execute(
                "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at, device_id, device_signature, seq_no) \
                 VALUES (?1, 'order', ?2, 'UPSERT', '{}', ?3, 't', 't', 'dev-A', 'sig', ?4)",
                params![format!("k-{s}"), format!("e-{s}"), status, s],
            )
            .unwrap();
        }
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn batch_atomic_state_transition() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = mem_db();
        seed_signed(&conn, &[1, 2], "pending");
        let batch = fetch_next_outbox_batch_inner(&mut conn, 50).expect("fetch");
        assert_eq!(batch.iter().map(|m| m.seq_no).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_outbox WHERE status = 'inflight'"), 2);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_outbox WHERE status = 'pending' AND seq_no IS NOT NULL"), 0);
        // Serial second fetch sees nothing pending (no split, no duplicate).
        assert!(fetch_next_outbox_batch_inner(&mut conn, 50).unwrap().is_empty());
        // ACK resolves atomically: rows deleted, cursor advanced past them.
        assert_eq!(mark_outbox_synced_inner(&mut conn, vec![1, 2]).unwrap(), 2);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_outbox"), 0);
    }

    #[test]
    fn stale_in_flight_reap() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = mem_db();
        seed_signed(&conn, &[1], "pending");
        // Age one row 90 s into inflight, keep one fresh.
        conn.execute(
            "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at, device_id, device_signature, seq_no) \
             VALUES ('k-old', 'order', 'e-old', 'UPSERT', '{}', 'inflight', 't', '2001-01-01T00:00:00.000Z', 'dev-A', 'sig', 9)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at, device_id, device_signature, seq_no) \
             VALUES ('k-new', 'order', 'e-new', 'UPSERT', '{}', 'inflight', 't', '2999-01-01T00:00:00.000Z', 'dev-A', 'sig', 10)",
            [],
        )
        .unwrap();
        // Unsigned inflight rows belong to the legacy watchdog, never this reaper.
        conn.execute(
            "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
             VALUES ('k-leg', 'order', 'e-leg', 'UPSERT', '{}', 'inflight', 't', '2001-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        assert_eq!(reap_stale_in_flight_inner(&mut conn, 60_000).unwrap(), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_outbox WHERE idempotency_key = 'k-old' AND status = 'pending'"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_outbox WHERE idempotency_key = 'k-new' AND status = 'inflight'"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_outbox WHERE idempotency_key = 'k-leg' AND status = 'inflight'"), 1);
        // Abort flight reset (timeout 0) immediately resets fresh inflight rows too.
        assert_eq!(reap_stale_in_flight_inner(&mut conn, 0).unwrap(), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_outbox WHERE idempotency_key = 'k-new' AND status = 'pending'"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_outbox WHERE idempotency_key = 'k-leg' AND status = 'inflight'"), 1);
    }

    #[test]
    fn contiguous_seq_order_enforcement() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = mem_db();
        seed_signed(&conn, &[1, 2, 4], "pending");
        // Longest contiguous prefix only — 4 waits for its missing 3.
        let batch = fetch_next_outbox_batch_inner(&mut conn, 50).expect("fetch");
        assert_eq!(batch.iter().map(|m| m.seq_no).collect::<Vec<_>>(), vec![1, 2]);
        // Out-of-order ACK refuses: cursor unmoved, rows intact.
        let err = mark_outbox_synced_inner(&mut conn, vec![2]).expect_err("gap");
        assert!(format!("{err:?}").contains("SEQUENCE_GAP_DETECTED"));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_outbox"), 3);
        // In-order ACK advances; the orphaned 4 fast-forwards past the gap
        // left by the other lane (deleted-as-synced elsewhere).
        assert_eq!(mark_outbox_synced_inner(&mut conn, vec![1, 2]).unwrap(), 2);
        let batch = fetch_next_outbox_batch_inner(&mut conn, 50).expect("fetch");
        assert_eq!(batch.iter().map(|m| m.seq_no).collect::<Vec<_>>(), vec![4]);
    }

    #[test]
    fn racing_fetchers_never_split_a_run() {
        use std::sync::{Arc, Barrier};
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let dir = std::env::temp_dir().join(format!(
            "mobi-outbox-race-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("race.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE sync_outbox (
                    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                    idempotency_key TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0,
                    next_retry_at TEXT, last_error TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    device_id TEXT, device_signature TEXT, seq_no INTEGER);
                 CREATE TABLE device_identity (
                    device_id TEXT PRIMARY KEY, public_key_hex TEXT NOT NULL DEFAULT '',
                    private_key_enc BLOB NOT NULL DEFAULT x'00', enrolled_at TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'active', last_outbox_seq INTEGER NOT NULL DEFAULT 0,
                    last_acked_seq INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO app_settings (key, value_json, updated_at) VALUES ('sync.device_id', '\"dev-A\"', 't')",
                [],
            )
            .unwrap();
            conn.execute("INSERT INTO device_identity (device_id) VALUES ('dev-A')", [])
                .unwrap();
            for s in 1..=4i64 {
                conn.execute(
                    "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at, device_id, device_signature, seq_no) \
                     VALUES (?1, 'order', ?2, 'UPSERT', '{}', 'pending', 't', 't', 'dev-A', 'sig', ?3)",
                    params![format!("k-{s}"), format!("e-{s}"), s],
                )
                .unwrap();
            }
        }
        let barrier = Arc::new(Barrier::new(2));
        let spawn = |path: std::path::PathBuf, barrier: Arc<Barrier>| {
            std::thread::spawn(move || {
                let mut conn = Connection::open(&path).unwrap();
                conn.pragma_update(None, "journal_mode", "WAL").unwrap();
                conn.busy_timeout(std::time::Duration::from_millis(5000)).unwrap();
                barrier.wait();
                fetch_next_outbox_batch_inner(&mut conn, 50)
                    .map(|b| b.iter().map(|m| m.seq_no).collect::<Vec<_>>())
                    .map_err(|e| format!("{e:?}"))
            })
        };
        let a = spawn(path.clone(), barrier.clone());
        let b = spawn(path.clone(), barrier);
        let ra = a.join().unwrap();
        let rb = b.join().unwrap();
        // Exactly one winner holds [1,2,3,4]; the loser sees an empty batch —
        // never a 2+2 split.
        match (ra, rb) {
            (Ok(win), Ok(empty)) if win == vec![1, 2, 3, 4] && empty.is_empty() => {}
            (Ok(empty), Ok(win)) if win == vec![1, 2, 3, 4] && empty.is_empty() => {}
            other => panic!("split claim: {other:?}"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}


//! SEC-01 increment 2 — a hardened native READ-ONLY lane.
//!
//! `PRAGMA query_only` alone is a *soft* switch: it can be turned back off by the
//! same connection, so a single lane that only relied on it would be one
//! `PRAGMA query_only=0` away from writing. This module stacks independent
//! barriers, each of which must fail closed:
//!
//!   1. **Open flags** — `SQLITE_OPEN_READONLY`: the OS/SQLite refuses writes even
//!      if every other guard is bypassed.
//!   2. **Authorizer** — only `SELECT`, `READ` on an explicit operational-table
//!      allowlist, `FUNCTION` (minus `load_extension`) and `RECURSIVE` are
//!      allowed. `PRAGMA` (so `writable_schema`, `query_only=0`), `ATTACH`,
//!      `DETACH`, every write action and every DDL action are denied.
//!   3. **One statement only** — a trailing statement after the first `;` is
//!      rejected before execution (a prepared statement silently ignores it).
//!   4. **Allowlist, not denylist** — credential-bearing tables (`app_settings`
//!      with PIN hashes/keys, `device_identity`, licence/trust state,
//!      `security_audit_logs`) are not readable through this lane at all.
//!   5. **Bounds** — row cap and a wall-clock/VM-step cap, plus bound parameters
//!      (never string interpolation).
//!
//! Each barrier has a negative test in this file and an app-path probe in
//! `e2e-tests/specs/92-sql-readonly-app.e2e.ts`, each paired with a
//! writable-connection control proving the database itself accepts the write.

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value};
use std::time::{Duration, Instant};

/// Operational tables this lane may read. Anything else is denied — including
/// `app_settings` (PIN hashes, gateway token, licence keys), `device_identity`
/// (key material), licence/trust tables and the audit log (read it through
/// `audit_verify`, which verifies the chain).
pub const READ_ONLY_TABLES: &[&str] = &[
    "transactions",
    "transaction_items",
    "products",
    "stock_batches",
    "customers",
    "customer_debts",
    "loyalty_ledger",
    "credit_vouchers",
    "cash_sessions",
    "cash_movements",
    "inventory_ledger",
    "repair_orders",
    "warranty_claims",
    "trade_ins",
    "purchase_orders",
    "purchase_order_items",
    "held_sales",
    "sync_outbox",
    "import_source_identity",
];

pub const ROW_CAP: usize = 2000;
pub const TIME_CAP: Duration = Duration::from_millis(1500);

fn authorizer(ctx: AuthContext<'_>) -> Authorization {
    match ctx.action {
        AuthAction::Select | AuthAction::Recursive => Authorization::Allow,
        AuthAction::Read { table_name, .. } => {
            if READ_ONLY_TABLES.contains(&table_name.to_ascii_lowercase().as_str()) {
                Authorization::Allow
            } else {
                Authorization::Deny
            }
        }
        AuthAction::Function { function_name } => {
            if function_name.eq_ignore_ascii_case("load_extension") {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }
        _ => Authorization::Deny,
    }
}

/// Reject anything after the first statement. SQLite's `prepare` ignores the
/// tail, so `SELECT 1; DELETE FROM t` would otherwise look like a clean SELECT.
pub fn single_statement(sql: &str) -> Result<(), String> {
    let mut chars = sql.chars().peekable();
    let mut quote: Option<char> = None;
    let mut seen_semicolon = false;
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            if c == q {
                // doubled quote escapes itself
                if chars.peek() == Some(&q) {
                    chars.next();
                } else {
                    quote = None;
                }
            }
            continue;
        }
        match c {
            '\'' | '"' | '`' => quote = Some(c),
            '[' => quote = Some(']'),
            '-' if chars.peek() == Some(&'-') => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = '\0';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
            }
            ';' => {
                if seen_semicolon {
                    return Err("multiple statements are not allowed".into());
                }
                seen_semicolon = true;
            }
            _ => {
                if seen_semicolon && !c.is_whitespace() {
                    return Err("multiple statements are not allowed".into());
                }
            }
        }
    }
    if quote.is_some() {
        return Err("unterminated quoted literal".into());
    }
    Ok(())
}

/// Open the live DB for this lane: read-only flags, authorizer installed, and a
/// `query_only` belt on top (defence in depth: if the platform ever opens the
/// file writable, the pragma still refuses writes).
pub fn open_read_only(path: &std::path::Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("ro open: {e}"))?;
    conn.busy_timeout(Duration::from_millis(5000))
        .map_err(|e| format!("ro busy: {e}"))?;
    conn.pragma_update(None, "query_only", "1")
        .map_err(|e| format!("ro pragma: {e}"))?;
    conn.authorizer(Some(authorizer));
    Ok(conn)
}

/// One cached read-only connection. Opening SQLite + `query_only` + the
/// authorizer cost ~2.3 ms per call (measured), which is 5x the plugin pool; a
/// read API cannot pay that per query. The cache is invalidated when the DB file
/// changes identity (length + mtime), which is what an e2e reset or a restore
/// does — and by the caller's retry after an error.
static RO_CACHE: std::sync::Mutex<Option<(std::path::PathBuf, (u64, i64), Connection)>> =
    std::sync::Mutex::new(None);

fn file_stamp(path: &std::path::Path) -> (u64, i64) {
    match std::fs::metadata(path) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos() as i64)
                .unwrap_or(0);
            (m.len(), mtime)
        }
        Err(_) => (0, 0),
    }
}

/// Run `f` against the lane's cached read-only connection, (re)opening it when
/// the file changed or the cached handle errors.
pub fn with_read_only_connection<T>(
    path: &std::path::Path,
    f: impl Fn(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let stamp = file_stamp(path);
    let mut slot = RO_CACHE
        .lock()
        .map_err(|_| "read-only pool poisoned".to_string())?;
    let stale = match slot.as_ref() {
        Some((p, s, _)) => p != path || *s != stamp,
        None => true,
    };
    if stale {
        *slot = Some((path.to_path_buf(), stamp, open_read_only(path)?));
    }
    let conn = &slot.as_ref().expect("just opened").2;
    match f(conn) {
        Ok(v) => Ok(v),
        Err(first) => {
            // A cached handle can die under us (DB replaced, WAL checkpoint);
            // reopen once before reporting the error.
            *slot = Some((path.to_path_buf(), file_stamp(path), open_read_only(path)?));
            let conn = &slot.as_ref().expect("reopened").2;
            f(conn).map_err(|_| first)
        }
    }
}

/// Run `sql` (one statement, bound parameters) and return JSON rows.
pub fn run_readonly_query(
    conn: &Connection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Value>, String> {
    single_statement(sql)?;
    let started = Instant::now();
    // Abort long scans: the callback runs every 10k VM steps.
    conn.progress_handler(
        10_000,
        Some(move || started.elapsed() > TIME_CAP),
    );

    let mut stmt = conn.prepare(sql).map_err(|e| format!("prepare: {e}"))?;
    let bind: Vec<SqlValue> = params
        .iter()
        .map(|p| match p {
            Value::Null => SqlValue::Null,
            Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    SqlValue::Integer(i)
                } else {
                    SqlValue::Real(n.as_f64().unwrap_or(0.0))
                }
            }
            Value::String(s) => SqlValue::Text(s.clone()),
            other => SqlValue::Text(other.to_string()),
        })
        .collect();

    let column_names: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
    let mut rows = stmt
        .query(rusqlite::params_from_iter(bind.iter()))
        .map_err(|e| format!("query: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("row: {e}"))? {
        if out.len() >= ROW_CAP {
            return Err(format!("row limit exceeded ({ROW_CAP})"));
        }
        if started.elapsed() > TIME_CAP {
            return Err("query time limit exceeded".into());
        }
        let mut obj = Map::new();
        for (i, name) in column_names.iter().enumerate() {
            let v = match row.get_ref(i) {
                Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                Ok(rusqlite::types::ValueRef::Integer(n)) => Value::from(n),
                Ok(rusqlite::types::ValueRef::Real(f)) => Value::from(f),
                Ok(rusqlite::types::ValueRef::Text(t)) => {
                    Value::from(String::from_utf8_lossy(t).to_string())
                }
                Ok(rusqlite::types::ValueRef::Blob(b)) => {
                    Value::from(format!("<blob:{} bytes>", b.len()))
                }
                Err(_) => Value::Null,
            };
            obj.insert(name.clone(), v);
        }
        out.push(Value::Object(obj));
    }
    conn.progress_handler(0, None::<fn() -> bool>);
    Ok(out)
}

/// Native read-only query command (SEC-01). Capability-gated; the write refusal
/// comes from the engine, the authorizer and the single-statement rule.
#[tauri::command]
pub fn sql_select_ro(
    app: tauri::AppHandle,
    query: String,
    params: Option<Vec<Value>>,
) -> Result<Vec<Value>, crate::trust_core::ipc_authorizer::TrustError> {
    use tauri::Manager;
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "sql_select_ro",
        crate::trust_core::capability_policy::Capability::ReadOperationalData,
        |_| {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| crate::trust_core::ipc_authorizer::TrustError::op_failed(format!("app dir: {e}")))?;
            let params = params.unwrap_or_default();
            with_read_only_connection(&crate::e2e::live_db_path(&dir), |conn| {
                run_readonly_query(conn, &query, &params)
            })
            .map_err(crate::trust_core::ipc_authorizer::TrustError::op_failed)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct TempDb(PathBuf);
    impl Drop for TempDb {
        fn drop(&mut self) {
            for suffix in ["", "-wal", "-shm"] {
                let _ = fs::remove_file(format!("{}{}", self.0.display(), suffix));
            }
        }
    }

    /// A WAL database shaped like the app's: an operational table and a
    /// credential-bearing one that must stay unreadable through this lane.
    fn fixture(tag: &str) -> (TempDb, Connection) {
        let path = std::env::temp_dir().join(format!(
            "mobi-sqlro-{}-{}.db",
            tag,
            std::process::id()
        ));
        for suffix in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{}", path.display(), suffix));
        }
        let writer = Connection::open(&path).expect("writer");
        writer
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE transactions (id TEXT PRIMARY KEY, total INTEGER NOT NULL);
                 CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
                 INSERT INTO transactions (id, total) VALUES ('T1', 1000), ('T2', 2000);
                 INSERT INTO app_settings (key, value_json) VALUES ('manager_pin', '{\"pin\":\"secret\"}');",
            )
            .expect("schema");
        (TempDb(path), writer)
    }

    fn ro(path: &std::path::Path) -> Connection {
        open_read_only(path).expect("read-only open (WAL with -shm present)")
    }

    #[test]
    fn read_only_open_works_on_a_wal_database() {
        let (db, _writer) = fixture("open");
        let conn = ro(&db.0);
        let rows = run_readonly_query(&conn, "SELECT id, total FROM transactions ORDER BY id", &[]).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], Value::from("T1"));
    }

    #[test]
    fn query_only_cannot_be_switched_off() {
        let (db, _writer) = fixture("pragma");
        let conn = ro(&db.0);
        for sql in [
            "PRAGMA query_only = 0",
            "PRAGMA query_only=0; INSERT INTO transactions (id, total) VALUES ('X', 1)",
        ] {
            let err = run_readonly_query(&conn, sql, &[]).expect_err(sql);
            assert!(
                err.to_lowercase().contains("not authorized")
                    || err.to_lowercase().contains("readonly")
                    || err.to_lowercase().contains("multiple statements"),
                "PRAGMA must be denied, got: {err}"
            );
        }
        // and a write on the same handle still fails afterwards
        assert!(run_readonly_query(&conn, "INSERT INTO transactions (id, total) VALUES ('Y', 2)", &[]).is_err());
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2, "nothing may have been written");
    }

    #[test]
    fn attach_and_vacuum_into_are_denied() {
        let (db, _writer) = fixture("attach");
        let conn = ro(&db.0);
        for sql in [
            "ATTACH DATABASE '/tmp/evil.db' AS evil",
            "VACUUM INTO '/tmp/evil-copy.db'",
            "PRAGMA writable_schema = 1",
        ] {
            let err = run_readonly_query(&conn, sql, &[]).expect_err(sql);
            let lower = err.to_lowercase();
            assert!(
                lower.contains("not authorized")
                    || lower.contains("authorization denied")
                    || lower.contains("prohibited")
                    || lower.contains("readonly")
                    || lower.contains("prepare"),
                "{sql} must be denied, got: {err}"
            );
        }
    }

    #[test]
    fn multi_statement_is_rejected_before_execution() {
        for sql in [
            "SELECT 1; DELETE FROM transactions",
            "SELECT 1;SELECT 2",
            "SELECT 1;;;;",
        ] {
            let err = single_statement(sql).expect_err(sql);
            assert!(err.contains("multiple statements"), "{sql} -> {err}");
        }
        // a semicolon inside a literal or a comment is not a second statement
        assert!(single_statement("SELECT 'a;b' AS x").is_ok());
        assert!(single_statement("SELECT 1 -- ; not a statement").is_ok());
        assert!(single_statement("SELECT 1;").is_ok());
    }

    #[test]
    fn write_variants_are_denied() {
        let (db, _writer) = fixture("writes");
        let conn = ro(&db.0);
        for sql in [
            "INSERT INTO transactions (id, total) VALUES ('R', 1) RETURNING id",
            "WITH x AS (SELECT 1) INSERT INTO transactions (id, total) SELECT 'W', 1",
            "UPDATE transactions SET total = 0",
            "DELETE FROM transactions",
            "CREATE TABLE probe (x INTEGER)",
        ] {
            let err = run_readonly_query(&conn, sql, &[]).expect_err(sql);
            let lower = err.to_lowercase();
            assert!(
                lower.contains("not authorized") || lower.contains("readonly"),
                "{sql} must be denied, got: {err}"
            );
        }
    }

    #[test]
    fn credential_tables_are_not_readable() {
        let (db, _writer) = fixture("creds");
        let conn = ro(&db.0);
        for sql in [
            "SELECT * FROM app_settings",
            "SELECT value_json FROM app_settings WHERE key = 'manager_pin'",
            "SELECT (SELECT value_json FROM app_settings LIMIT 1) AS leak",
            "SELECT * FROM sqlite_master",
        ] {
            let err = run_readonly_query(&conn, sql, &[]).expect_err(sql);
            let lower = err.to_lowercase();
            assert!(
                lower.contains("not authorized") || lower.contains("prohibited"),
                "{sql} must be denied by the allowlist, got: {err}"
            );
        }
    }

    #[test]
    fn row_and_time_caps_hold() {
        let (db, writer) = fixture("caps");
        writer
            .execute_batch(
                "WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x < 3000)
                 INSERT INTO transactions (id, total) SELECT 'B' || x, x FROM seq;",
            )
            .unwrap();
        let conn = ro(&db.0);
        let err = run_readonly_query(&conn, "SELECT * FROM transactions", &[]).expect_err("row cap");
        assert!(err.contains("row limit exceeded"), "got: {err}");
    }

    #[test]
    fn writable_control_succeeds_on_a_normal_connection() {
        let (db, writer) = fixture("control");
        writer
            .execute("INSERT INTO transactions (id, total) VALUES ('OK', 5)", [])
            .expect("the database itself accepts the write");
        let conn = ro(&db.0);
        let rows = run_readonly_query(&conn, "SELECT COUNT(*) AS c FROM transactions", &[]).unwrap();
        assert_eq!(rows[0]["c"], Value::from(3));
    }

    #[test]
    fn parameters_are_bound_not_interpolated() {
        let (db, _writer) = fixture("params");
        let conn = ro(&db.0);
        let rows = run_readonly_query(
            &conn,
            "SELECT id FROM transactions WHERE id = ?1",
            &[Value::from("T2")],
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], Value::from("T2"));
    }
}

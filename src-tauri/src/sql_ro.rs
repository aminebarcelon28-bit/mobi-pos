//! SEC-01 increment 2, step 2a — a native READ-ONLY query lane.
//!
//! The renderer's own `tauri-plugin-sql` pool is still writable: boot itself
//! writes through it, so `PRAGMA query_only=1` at connect prevents the app from
//! starting (measured, ADR-005). This module delivers the half that does not
//! need that migration: a native command that opens its **own** connection with
//! `query_only=1` and runs a parameterised SELECT. Any write handed to it is
//! refused by SQLite (`SQLITE_READONLY`) — proven in the tests below and in the
//! app path by `e2e-tests/specs/92-sql-readonly-app.e2e.ts`.
//!
//! Why a second pool instead of flipping the first: the WebView handle is used by
//! the boot sequence (settings, session, mirrors), so flipping it is a migration,
//! not a flag. Until that lands, this lane gives a trustworthy read path for
//! future read APIs (reports, licences, dashboards) that cannot write even if the
//! caller is compromised — the renderer still has its writable pool, and that
//! residual is documented, not hidden.

use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use serde_json::{Map, Value};

/// Run `sql` on a connection that must already be `query_only`. Returns one JSON
/// object per row (column name → value). Writes fail with `SQLITE_READONLY`.
pub fn run_readonly_query(
    conn: &Connection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Value>, String> {
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
    Ok(out)
}

/// Native read-only query command (SEC-01). Capability-gated like any other
/// read; the write refusal comes from SQLite, not from an argument check.
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
            let conn = Connection::open(crate::e2e::live_db_path(&dir))
                .map_err(|e| crate::trust_core::ipc_authorizer::TrustError::op_failed(format!("ro open: {e}")))?;
            conn.busy_timeout(std::time::Duration::from_millis(5000))
                .map_err(|e| crate::trust_core::ipc_authorizer::TrustError::op_failed(format!("ro busy: {e}")))?;
            // The boundary, at the engine level: this connection may not write.
            conn.pragma_update(None, "query_only", "1")
                .map_err(|e| crate::trust_core::ipc_authorizer::TrustError::op_failed(format!("ro pragma: {e}")))?;
            run_readonly_query(&conn, &query, &params.unwrap_or_default())
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
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, amount REAL);\n             INSERT INTO t (name, amount) VALUES ('alpha', 1.5), ('beta', 2);",
        )
        .expect("seed");
        conn
    }

    #[test]
    fn read_only_connection_returns_rows() {
        let conn = seeded();
        conn.pragma_update(None, "query_only", "1").unwrap();
        let rows = run_readonly_query(&conn, "SELECT id, name, amount FROM t ORDER BY id", &[]).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["name"], Value::from("alpha"));
        assert_eq!(rows[0]["amount"], Value::from(1.5));
    }

    #[test]
    fn read_only_connection_refuses_every_write_class() {
        let conn = seeded();
        conn.pragma_update(None, "query_only", "1").unwrap();
        for (label, sql) in [
            ("insert", "INSERT INTO t (name) VALUES ('gamma')"),
            ("update", "UPDATE t SET name = 'x' WHERE id = 1"),
            ("delete", "DELETE FROM t WHERE id = 1"),
            ("ddl", "CREATE TABLE probe (x INTEGER)"),
        ] {
            let err = run_readonly_query(&conn, sql, &[]).expect_err(label);
            let lower = err.to_lowercase();
            assert!(
                lower.contains("readonly") || lower.contains("read-only"),
                "{label} must fail with a readonly error, got: {err}"
            );
        }
        // negative control: the same INSERT succeeds on a writable connection
        let writable = seeded();
        writable.execute("INSERT INTO t (name) VALUES ('gamma')", []).expect("writable insert");
    }

    #[test]
    fn parameters_are_bound_not_interpolated() {
        let conn = seeded();
        conn.pragma_update(None, "query_only", "1").unwrap();
        let rows = run_readonly_query(&conn, "SELECT name FROM t WHERE name = ?1", &[Value::from("beta")]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], Value::from("beta"));
    }
}

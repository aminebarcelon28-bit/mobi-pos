// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

#[cfg(feature = "sqlite")]
use std::fs::create_dir_all;

use indexmap::IndexMap;
use serde_json::Value as JsonValue;
#[cfg(any(feature = "sqlite", feature = "mysql", feature = "postgres"))]
use sqlx::{migrate::MigrateDatabase, Column, Executor, Pool, Row};
#[cfg(any(feature = "sqlite", feature = "mysql", feature = "postgres"))]
use tauri::Manager;
use tauri::{AppHandle, Runtime};

#[cfg(feature = "mysql")]
use sqlx::MySql;
#[cfg(feature = "postgres")]
use sqlx::Postgres;
#[cfg(feature = "sqlite")]
use sqlx::Sqlite;

use crate::LastInsertId;

use sqlx::sqlite::SqlitePoolOptions;

pub enum DbPool {
    #[cfg(feature = "sqlite")]
    Sqlite(Pool<Sqlite>),
    #[cfg(feature = "mysql")]
    MySql(Pool<MySql>),
    #[cfg(feature = "postgres")]
    Postgres(Pool<Postgres>),
    #[cfg(not(any(feature = "sqlite", feature = "mysql", feature = "postgres")))]
    None,
}

// public methods
/* impl DbPool {
    /// Get the inner Sqlite Pool. Returns None for MySql and Postgres pools.
    #[cfg(feature = "sqlite")]
    pub fn sqlite(&self) -> Option<&Pool<Sqlite>> {
        match self {
            DbPool::Sqlite(pool) => Some(pool),
            _ => None,
        }
    }

    /// Get the inner MySql Pool. Returns None for Sqlite and Postgres pools.
    #[cfg(feature = "mysql")]
    pub fn mysql(&self) -> Option<&Pool<MySql>> {
        match self {
            DbPool::MySql(pool) => Some(pool),
            _ => None,
        }
    }

    /// Get the inner Postgres Pool. Returns None for MySql and Sqlite pools.
    #[cfg(feature = "postgres")]
    pub fn postgres(&self) -> Option<&Pool<Postgres>> {
        match self {
            DbPool::Postgres(pool) => Some(pool),
            _ => None,
        }
    }
} */

// private methods
impl DbPool {
    pub(crate) async fn connect<R: Runtime>(
        conn_url: &str,
        _app: &AppHandle<R>,
    ) -> Result<Self, crate::Error> {
        match conn_url
            .split_once(':')
            .ok_or_else(|| crate::Error::InvalidDbUrl(conn_url.to_string()))?
            .0
        {
            #[cfg(feature = "sqlite")]
            "sqlite" => {
                // 4.4: confine load to exactly mobi_pos.db before mapping.
                validate_db_name(conn_url.split_once(':').ok_or_else(|| {
                    crate::Error::InvalidDbUrl(conn_url.to_string())
                })?.1)?;
                let app_path = _app
                    .path()
                    .app_data_dir()
                    .expect("No App config path was found!");

                create_dir_all(&app_path).expect("Couldn't create app config dir");

                let conn_url = &path_mapper(app_path, conn_url);

                if !Sqlite::database_exists(conn_url).await.unwrap_or(false) {
                    Sqlite::create_database(conn_url).await?;
                }
                Ok(Self::Sqlite(SqlitePoolOptions::new().max_connections(1).connect(conn_url).await?))
            }
            #[cfg(feature = "mysql")]
            "mysql" => {
                if !MySql::database_exists(conn_url).await.unwrap_or(false) {
                    MySql::create_database(conn_url).await?;
                }
                Ok(Self::MySql(Pool::connect(conn_url).await?))
            }
            #[cfg(feature = "postgres")]
            "postgres" => {
                if !Postgres::database_exists(conn_url).await.unwrap_or(false) {
                    Postgres::create_database(conn_url).await?;
                }
                Ok(Self::Postgres(Pool::connect(conn_url).await?))
            }
            #[cfg(not(any(feature = "sqlite", feature = "postgres", feature = "mysql")))]
            _ => Err(crate::Error::InvalidDbUrl(format!(
                "{conn_url} - No database driver enabled!"
            ))),
            #[cfg(any(feature = "sqlite", feature = "postgres", feature = "mysql"))]
            _ => Err(crate::Error::InvalidDbUrl(conn_url.to_string())),
        }
    }

    pub(crate) async fn migrate(
        &self,
        _migrator: &sqlx::migrate::Migrator,
    ) -> Result<(), crate::Error> {
        match self {
            #[cfg(feature = "sqlite")]
            DbPool::Sqlite(pool) => _migrator.run(pool).await?,
            #[cfg(feature = "mysql")]
            DbPool::MySql(pool) => _migrator.run(pool).await?,
            #[cfg(feature = "postgres")]
            DbPool::Postgres(pool) => _migrator.run(pool).await?,
            #[cfg(not(any(feature = "sqlite", feature = "mysql", feature = "postgres")))]
            DbPool::None => (),
        }
        Ok(())
    }

    pub(crate) async fn close(&self) {
        match self {
            #[cfg(feature = "sqlite")]
            DbPool::Sqlite(pool) => pool.close().await,
            #[cfg(feature = "mysql")]
            DbPool::MySql(pool) => pool.close().await,
            #[cfg(feature = "postgres")]
            DbPool::Postgres(pool) => pool.close().await,
            #[cfg(not(any(feature = "sqlite", feature = "mysql", feature = "postgres")))]
            DbPool::None => (),
        }
    }

    pub(crate) async fn execute(
        &self,
        _query: String,
        _values: Vec<JsonValue>,
    ) -> Result<(u64, LastInsertId), crate::Error> {
        Ok(match self {
            #[cfg(feature = "sqlite")]
            DbPool::Sqlite(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    // 4.4: integers bind exact (i64); unrepresentable errors.
                    match bind_json_value(&value)? {
                        BoundValue::Null => query = query.bind(None::<JsonValue>),
                        BoundValue::Str(s) => query = query.bind(s),
                        BoundValue::I64(i) => query = query.bind(i),
                        BoundValue::F64(f) => query = query.bind(f),
                        BoundValue::Json(j) => query = query.bind(j),
                    }
                }
                let result = pool.execute(query).await?;
                (
                    result.rows_affected(),
                    LastInsertId::Sqlite(result.last_insert_rowid()),
                )
            }
            #[cfg(feature = "mysql")]
            DbPool::MySql(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    match bind_json_value(&value)? {
                        BoundValue::Null => query = query.bind(None::<JsonValue>),
                        BoundValue::Str(s) => query = query.bind(s),
                        BoundValue::I64(i) => query = query.bind(i),
                        BoundValue::F64(f) => query = query.bind(f),
                        BoundValue::Json(j) => query = query.bind(j),
                    }
                }
                let result = pool.execute(query).await?;
                (
                    result.rows_affected(),
                    LastInsertId::MySql(result.last_insert_id()),
                )
            }
            #[cfg(feature = "postgres")]
            DbPool::Postgres(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    match bind_json_value(&value)? {
                        BoundValue::Null => query = query.bind(None::<JsonValue>),
                        BoundValue::Str(s) => query = query.bind(s),
                        BoundValue::I64(i) => query = query.bind(i),
                        BoundValue::F64(f) => query = query.bind(f),
                        BoundValue::Json(j) => query = query.bind(j),
                    }
                }
                let result = pool.execute(query).await?;
                (result.rows_affected(), LastInsertId::Postgres(()))
            }
            #[cfg(not(any(feature = "sqlite", feature = "mysql", feature = "postgres")))]
            DbPool::None => (0, LastInsertId::None),
        })
    }

    pub(crate) async fn select(
        &self,
        _query: String,
        _values: Vec<JsonValue>,
    ) -> Result<Vec<IndexMap<String, JsonValue>>, crate::Error> {
        // 4.4 interim stopgap (NOT a security boundary): reject obviously
        // non-read statements before touching the pool.
        validate_read_query(&_query)?;
        Ok(match self {
            #[cfg(feature = "sqlite")]
            DbPool::Sqlite(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    match bind_json_value(&value)? {
                        BoundValue::Null => query = query.bind(None::<JsonValue>),
                        BoundValue::Str(s) => query = query.bind(s),
                        BoundValue::I64(i) => query = query.bind(i),
                        BoundValue::F64(f) => query = query.bind(f),
                        BoundValue::Json(j) => query = query.bind(j),
                    }
                }
                let rows = pool.fetch_all(query).await?;
                let mut values = Vec::new();
                for row in rows {
                    let mut value = IndexMap::default();
                    for (i, column) in row.columns().iter().enumerate() {
                        let v = row.try_get_raw(i)?;

                        let v = crate::decode::sqlite::to_json(v)?;

                        value.insert(column.name().to_string(), v);
                    }

                    values.push(value);
                }
                values
            }
            #[cfg(feature = "mysql")]
            DbPool::MySql(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    match bind_json_value(&value)? {
                        BoundValue::Null => query = query.bind(None::<JsonValue>),
                        BoundValue::Str(s) => query = query.bind(s),
                        BoundValue::I64(i) => query = query.bind(i),
                        BoundValue::F64(f) => query = query.bind(f),
                        BoundValue::Json(j) => query = query.bind(j),
                    }
                }
                let rows = pool.fetch_all(query).await?;
                let mut values = Vec::new();
                for row in rows {
                    let mut value = IndexMap::default();
                    for (i, column) in row.columns().iter().enumerate() {
                        let v = row.try_get_raw(i)?;

                        let v = crate::decode::mysql::to_json(v)?;

                        value.insert(column.name().to_string(), v);
                    }

                    values.push(value);
                }
                values
            }
            #[cfg(feature = "postgres")]
            DbPool::Postgres(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    match bind_json_value(&value)? {
                        BoundValue::Null => query = query.bind(None::<JsonValue>),
                        BoundValue::Str(s) => query = query.bind(s),
                        BoundValue::I64(i) => query = query.bind(i),
                        BoundValue::F64(f) => query = query.bind(f),
                        BoundValue::Json(j) => query = query.bind(j),
                    }
                }
                let rows = pool.fetch_all(query).await?;
                let mut values = Vec::new();
                for row in rows {
                    let mut value = IndexMap::default();
                    for (i, column) in row.columns().iter().enumerate() {
                        let v = row.try_get_raw(i)?;

                        let v = crate::decode::postgres::to_json(v)?;

                        value.insert(column.name().to_string(), v);
                    }

                    values.push(value);
                }
                values
            }
            #[cfg(not(any(feature = "sqlite", feature = "mysql", feature = "postgres")))]
            DbPool::None => Vec::new(),
        })
    }
}

/// 4.4 interim hardening (STOPGAP — not a security boundary; the gateway is).
/// `load` is confined to exactly `mobi_pos.db`: absolute paths would replace
/// the app dir entirely under `PathBuf::push`, and `..` segments traverse
/// out of it. The single in-app caller uses the literal `sqlite:mobi_pos.db`
/// (`sqlPluginAdapter.ts:409`), so exact-name matching breaks nothing legit.
fn validate_db_name(raw: &str) -> Result<(), crate::Error> {
    use std::path::{Component, Path};
    if raw != "mobi_pos.db" {
        return Err(crate::Error::InvalidDbUrl(format!(
            "confined to mobi_pos.db, got: {raw}"
        )));
    }
    // Belt-and-braces (unreachable while the equality above holds): no
    // absolute paths, no parent-dir segments, no separators at all.
    let p = Path::new(raw);
    if p.is_absolute()
        || p.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
        || raw.contains(['/', '\\'])
    {
        return Err(crate::Error::InvalidDbUrl(format!(
            "confined to mobi_pos.db, got: {raw}"
        )));
    }
    Ok(())
}

/// Bound value with integer fidelity: integer-valued JSON numbers bind as
/// i64 (exact for version clocks, rowids, minor-unit money); other finite
/// numbers bind as f64; non-finite values are an error instead of a silent 0
/// (the old `unwrap_or_default()`). Unreachable via JSON today (no NaN/Inf
/// literals) — defense in depth for constructed values.
enum BoundValue {
    Null,
    Str(String),
    I64(i64),
    F64(f64),
    Json(JsonValue),
}

fn bind_json_value(value: &JsonValue) -> Result<BoundValue, crate::Error> {
    if value.is_null() {
        Ok(BoundValue::Null)
    } else if value.is_string() {
        Ok(BoundValue::Str(
            value.as_str().unwrap_or_default().to_owned(),
        ))
    } else if let Some(number) = value.as_number() {
        if let Some(i) = number.as_i64() {
            Ok(BoundValue::I64(i))
        } else if let Some(f) = number.as_f64() {
            if f.is_finite() {
                Ok(BoundValue::F64(f))
            } else {
                Err(crate::Error::UnsupportedDatatype(format!(
                    "non-finite number: {number}"
                )))
            }
        } else {
            Err(crate::Error::UnsupportedDatatype(format!(
                "unrepresentable number: {number}"
            )))
        }
    } else {
        Ok(BoundValue::Json(value.clone()))
    }
}

/// 4.4 interim stopgap (NOT a security boundary): reject obviously non-read
/// statements from `select`. Audited JS call sites (Phase 4.4/4.5) are all
/// plain SELECT or bare read-only PRAGMAs — this gate breaks none of them.
/// `WITH` is deliberately excluded: `WITH x AS (...) DELETE ...` reads as a
/// read while smuggling a write, and no call site uses CTEs.
/// PRAGMA is an allow-list of exact read-only names (a deny-list cannot
/// cover side-effecting forms like `wal_checkpoint(TRUNCATE)` or
/// `incremental_vacuum(N)`), and — Phase 4.5 hardening — of exact SHAPES:
/// bare names only, except the table/index getters that take an object name.
/// `PRAGMA journal_mode WAL`, `PRAGMA user_version(5)` and friends are setter
/// forms (space- or paren-separated values) that the name-only check used to
/// accept; the audited select() call sites never set pragmas (setters go
/// through execute()), so shape-strictness breaks nothing legit.
fn validate_read_query(query: &str) -> Result<(), crate::Error> {
    fn reject(q: &str) -> Result<(), crate::Error> {
        Err(crate::Error::RejectedStatement(format!(
            "only SELECT/VALUES/EXPLAIN/bare read-only PRAGMA via select, got: {}",
            q.chars().take(48).collect::<String>()
        )))
    }
    // Strip leading whitespace, parens, and -- / /* */ comments.
    let mut rest = query.trim_start_matches(|c: char| c.is_whitespace() || c == '(');
    loop {
        rest = rest.trim_start();
        if let Some(s) = rest.strip_prefix("--") {
            rest = match s.find('\n') {
                Some(i) => &s[i + 1..],
                None => return reject(query),
            };
        } else if let Some(s) = rest.strip_prefix("/*") {
            rest = match s.find("*/") {
                Some(i) => &s[i + 2..],
                None => return reject(query),
            };
        } else {
            break;
        }
    }
    // Reject interior `;` outside quoted spans (quote-aware incl. '' escape).
    // A trailing `;` run is allowed; anything else stacked behind a first
    // statement is multi-statement smuggling.
    let trimmed_end = rest.trim_end_matches(|c: char| c == ';' || c.is_whitespace());
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = trimmed_end.chars();
    while let Some(c) = chars.next() {
        if in_single {
            if c == '\'' {
                // '' is an escaped quote — stay inside the string.
                if chars.clone().next() == Some('\'') {
                    chars.next();
                } else {
                    in_single = false;
                }
            }
        } else if in_double {
            if c == '"' {
                in_double = false;
            }
        } else if c == '\'' {
            in_single = true;
        } else if c == '"' {
            in_double = true;
        } else if c == ';' {
            return reject(query);
        }
    }
    let first = rest
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_start_matches('(')
        .to_ascii_uppercase();
    match first.as_str() {
        "SELECT" | "VALUES" | "EXPLAIN" => Ok(()),
        "PRAGMA" => {
            // Exact-name allow-list of side-effect-free PRAGMAs. Anything
            // with `=` assigns (and therefore writes); anything unlisted is
            // denied on doubt. Audited users: page_count, page_size,
            // journal_mode (bare), synchronous, foreign_keys, integrity_check,
            // foreign_key_check.
            let lower = rest.to_ascii_lowercase();
            let core = lower.trim_end_matches(|c: char| c == ';' || c.is_whitespace());
            if core.contains('=') {
                return reject(query);
            }
            const READ_PRAGMAS: &[&str] = &[
                "page_count",
                "page_size",
                "journal_mode",
                "synchronous",
                "foreign_keys",
                "integrity_check",
                "quick_check",
                "foreign_key_check",
                "table_info",
                "table_xinfo",
                "index_list",
                "index_info",
                "database_list",
                "schema_version",
                "freelist_count",
                "compile_options",
                "data_version",
                "user_version",
                "application_id",
            ];
            let after = core
                .strip_prefix("pragma")
                .unwrap_or("")
                .trim_start_matches(|c: char| c.is_whitespace() || c == '(');
            // Pragma name ends at whitespace, '(' or end; the tail decides the
            // shape (see below).
            let name: String = after
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if !READ_PRAGMAS.contains(&name.as_str()) {
                return reject(query);
            }
            // Shape strictness (Phase 4.5): a bare name reads; anything else
            // is a setter/value form in disguise. Only the table/index
            // getters take a parenthesized object name — every other listed
            // pragma with trailing tokens is rejected.
            let tail = after[name.len()..].trim_start();
            if tail.is_empty() {
                Ok(())
            } else if tail.starts_with('(')
                && matches!(
                    name.as_str(),
                    "table_info" | "table_xinfo" | "index_list" | "index_info"
                )
            {
                Ok(())
            } else {
                reject(query)
            }
        }
        _ => reject(query),
    }
}

#[cfg(feature = "sqlite")]
/// Maps the user supplied DB connection string to a connection string
/// with a fully qualified file path to the App's designed "app_path"
fn path_mapper(mut app_path: std::path::PathBuf, connection_string: &str) -> String {
    app_path.push(
        connection_string
            .split_once(':')
            .expect("Couldn't parse the connection string for DB!")
            .1,
    );

    format!(
        "sqlite:{}",
        app_path
            .to_str()
            .expect("Problem creating fully qualified path to Database file!")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn load_confined_to_exact_db_name() {
        assert!(validate_db_name("mobi_pos.db").is_ok());
        for bad in [
            "/abs/path/evil.db",
            "C:\\Windows\\evil.db",
            "../escape.db",
            "subdir/mobi_pos.db",
            "mobi_pos.db ",
            " mobi_pos.db",
            "other.db",
            "",
            "mobi_pos.db-wal",
            "mobi_pos.db\x00",
        ] {
            assert!(
                validate_db_name(bad).is_err(),
                "must reject load target: {bad:?}"
            );
        }
    }

    #[test]
    fn integers_bind_exact_i64() {        assert!(matches!(
            bind_json_value(&json!(7)),
            Ok(BoundValue::I64(7))
        ));
        assert!(matches!(
            bind_json_value(&json!(-3)),
            Ok(BoundValue::I64(-3))
        ));
        // i64::MAX survives exactly (was f64-rounded before).
        assert!(matches!(
            bind_json_value(&serde_json::Value::from(9223372036854775807i64)),
            Ok(BoundValue::I64(9223372036854775807))
        ));
        // i64::MIN is the symmetric edge (version-clock underflow guard).
        assert!(matches!(
            bind_json_value(&serde_json::Value::from(-9223372036854775808i64)),
            Ok(BoundValue::I64(i64::MIN))
        ));
        // u64 within i64 range still binds exact (as_i64 succeeds).
        assert!(matches!(
            bind_json_value(&serde_json::Value::from(9223372036854775807u64)),
            Ok(BoundValue::I64(9223372036854775807))
        ));
        // Wire semantics: JSON has no int/float distinction — `7` arrives as
        // an integer literal and binds I64, never F64(7.0).
        assert!(matches!(
            bind_json_value(&serde_json::from_str::<serde_json::Value>("7").unwrap()),
            Ok(BoundValue::I64(7))
        ));
        // Constructed 7.0 (Rust-side only — unreachable over JSON, where it
        // would serialize as `7`) binds F64; documented, not widened.
        assert!(matches!(
            bind_json_value(&serde_json::Value::from(7.0f64)),
            Ok(BoundValue::F64(_))
        ));
        assert!(matches!(
            bind_json_value(&json!(19.5)),
            Ok(BoundValue::F64(_))
        ));
        assert!(matches!(
            bind_json_value(&json!("s")),
            Ok(BoundValue::Str(_))
        ));
        assert!(matches!(bind_json_value(&json!(null)), Ok(BoundValue::Null)));
    }

    #[test]
    fn binding_range_guard_edges() {
        use serde_json::Value as V;
        // 1e20: integer-valued but beyond i64 → finite f64 approximation
        // (documented precision caveat, same as before — never silent 0).
        assert!(matches!(
            bind_json_value(&V::from(1e20f64)),
            Ok(BoundValue::F64(_))
        ));
        // u64::MAX: as_i64 fails → finite f64 fallback.
        assert!(matches!(
            bind_json_value(&V::from(18446744073709551615u64)),
            Ok(BoundValue::F64(_))
        ));
        // -0.0 stays F64 (serde keeps floats out of as_i64): SQLite treats
        // -0.0 == 0.0 in comparisons, so no lookup semantic changes.
        assert!(matches!(
            bind_json_value(&V::from(-0.0f64)),
            Ok(BoundValue::F64(_))
        ));
        // NaN/Infinity are NOT constructible through serde_json
        // (Value::from(f64::NAN) yields Null), so the non-finite error arm
        // is defense-in-depth for constructed values only — stated, and the
        // arm is covered by code inspection, not execution.
        // TEXT-affinity note: numeric 5 now binds I64(5) where it bound
        // F64(5.0) before; SQLite stores '5' not '5.0' in TEXT columns.
        // Phase 4.5 audit found no money-flow site binding a raw JS number
        // into a TEXT column (ids/keys/statuses are String()-wrapped at every
        // write site audited) — see report.
    }

    #[test]
    fn select_gate_allows_reads_rejects_writes() {
        for ok in [
            "SELECT * FROM t",
            "select a, b from t where x = ?",
            "SeLeCt 1",
            "  (SELECT 1);  ",
            "(VALUES (1))",
            "EXPLAIN QUERY PLAN SELECT * FROM t",
            "PRAGMA journal_mode;",
            "PRAGMA integrity_check",
            "PRAGMA table_info(products)",
            "PRAGMA quick_check",
            "PRAGMA user_version",
            "PRAGMA table_info ;",
            "pragma PAGE_COUNT",
            "SELECT * FROM t WHERE note = 'a;b''c'",
            "SELECT \"a;b\" FROM t",
            "-- comment\nSELECT 1",
            "/* x */ SELECT 1",
        ] {
            assert!(validate_read_query(ok).is_ok(), "must allow: {ok:?}");
        }
        for bad in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET a = 1",
            "DELETE FROM t",
            "DROP TABLE t",
            "ALTER TABLE t ADD COLUMN x",
            "CREATE TABLE t(a)",
            "REPLACE INTO t VALUES (1)",
            "BEGIN IMMEDIATE",
            "COMMIT",
            "ROLLBACK",
            "SAVEPOINT s",
            "VACUUM",
            "WITH c AS (SELECT 1) SELECT * FROM c",
            "WITH x AS (SELECT 1) DELETE FROM t",
            "SELECT 1; DELETE FROM t",
            "SELECT 1;DELETE FROM t;",
            "PRAGMA journal_mode=WAL",
            "PRAGMA foreign_keys = ON",
            "PRAGMA synchronous=NORMAL",
            // Phase 4.5 setter-shape smuggling (space- and paren-separated
            // values on listed names — all rejected; setters go through
            // execute(), never select()).
            "PRAGMA journal_mode WAL",
            "PRAGMA journal_mode(WAL)",
            "PRAGMA journal_mode ( WAL )",
            "PRAGMA user_version(5)",
            "PRAGMA user_version 5",
            "PRAGMA application_id(123)",
            "PRAGMA synchronous(FULL)",
            "PRAGMA foreign_keys(ON)",
            "PRAGMA page_size(4096)",
            "PRAGMA schema_version(99)",
            "PRAGMA integrity_check(10)",
            "With x AS (SELECT 1) SELECT * FROM x",
            "SELECT 1; -- trailing comment",
            "SELECT 1;DELETE FROM t;",
            "PRAGMA wal_checkpoint(TRUNCATE)",
            "PRAGMA incremental_vacuum",
            "PRAGMA incremental_vacuum(5)",
            "PRAGMA optimize",
            "PRAGMA some_future_pragma",
            "-- sneaky\nDELETE FROM t",
            "/* x */ DROP TABLE t",
            "",
            "TABLE t",
        ] {
            assert!(validate_read_query(bad).is_err(), "must reject: {bad:?}");
        }
    }
}

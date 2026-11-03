//! SEC-01 increment 2 — the read-only renderer boundary (engine-level proof).
//!
//! ADR-005 increment 2 makes the WebView's SQL pool read-only so the renderer
//! cannot write the fiscal DB outside native commands. This module proves the
//! *mechanism* against the real SQLite engine and records the measured blocker
//! that keeps the switch off in the app today:
//!
//!   - `PRAGMA query_only = 1` on a connection refuses INSERT/UPDATE/DELETE with
//!     `SQLITE_READONLY` while SELECT keeps working;
//!   - a second, normal connection (the native lane: rusqlite commands) still
//!     writes the same rows — the boundary is the renderer's handle, not the DB;
//!   - enabling the pragma on the **plugin pool at connect** prevents the app
//!     from booting, because boot itself writes through that pool (measured:
//!     the UI never reaches the lock screen). The switch therefore ships only
//!     together with the write migration, and the negative control below shows
//!     that the same INSERT succeeds without the pragma.
//!
//! The module is compiled for tests only; it exposes no IPC and no behaviour.

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use std::time::Instant;

    fn fresh_db(tag: &str) -> (std::path::PathBuf, Connection, Connection) {
        let path = std::env::temp_dir().join(format!(
            "mobi-sec2-{}-{}.db",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let native = Connection::open(&path).expect("native connection");
        native
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE probe (id INTEGER PRIMARY KEY, k TEXT NOT NULL UNIQUE);",
            )
            .expect("schema");
        let renderer = Connection::open(&path).expect("renderer connection");
        renderer
            .execute_batch("PRAGMA query_only = 1;")
            .expect("query_only");
        (path, native, renderer)
    }

    fn cleanup(path: &std::path::Path) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
        }
    }

    #[test]
    fn read_only_pool_refuses_writes_while_the_native_lane_writes() {
        let (path, native, renderer) = fresh_db("boundary");

        // 1. reads work through the read-only handle
        let n: i64 = renderer
            .query_row("SELECT COUNT(*) FROM probe", [], |r| r.get(0))
            .expect("SELECT must work on a read-only pool");
        assert_eq!(n, 0);

        // 2. every write class is refused by the engine, not by app code
        for (label, sql) in [
            ("INSERT", "INSERT INTO probe (k) VALUES ('a')"),
            ("UPDATE", "UPDATE probe SET k = 'b' WHERE k = 'a'"),
            ("DELETE", "DELETE FROM probe WHERE k = 'a'"),
        ] {
            let err = renderer.execute_batch(sql).expect_err(label);
            let msg = format!("{err:?}");
            assert!(
                msg.to_lowercase().contains("readonly") || msg.to_lowercase().contains("read-only"),
                "{label} must fail with SQLITE_READONLY, got: {msg}"
            );
        }

        // 3. the native lane (rusqlite, its own connection) still writes
        native
            .execute("INSERT INTO probe (k) VALUES ('from-native')", [])
            .expect("native write must land");
        let seen: i64 = renderer
            .query_row("SELECT COUNT(*) FROM probe", [], |r| r.get(0))
            .expect("read after native write");
        assert_eq!(seen, 1, "the read-only pool observes the native write");

        // 4. negative control: the SAME write succeeds without the pragma, so
        //    the refusal above is the pragma, not a schema/constraint artefact.
        let plain = Connection::open(&path).expect("plain connection");
        plain
            .execute("INSERT INTO probe (k) VALUES ('from-plain')", [])
            .expect("without query_only the same INSERT must succeed");

        cleanup(&path);
    }

    #[test]
    fn read_only_pool_has_no_measurable_read_penalty() {
        let (path, native, renderer) = fresh_db("latency");
        native
            .execute_batch("CREATE TABLE bench (x INTEGER); INSERT INTO bench (x) VALUES (1), (2), (3);")
            .expect("bench rows");

        let sample = |conn: &Connection| -> f64 {
            let mut total = 0.0_f64;
            for _ in 0..200 {
                let t0 = Instant::now();
                let _: i64 = conn.query_row("SELECT COUNT(*) FROM bench", [], |r| r.get(0)).unwrap();
                total += t0.elapsed().as_secs_f64() * 1000.0;
            }
            total / 200.0
        };
        let plain_ms = sample(&native);
        let readonly_ms = sample(&renderer);
        println!(
            "SEC2 LATENCY select_ms normal={plain_ms:.4} query_only={readonly_ms:.4} (200 iterations each)"
        );

        // Not a micro-benchmark gate: this only guards against a pathological
        // regression (an order of magnitude). The numbers are printed for the
        // evidence line.
        assert!(
            readonly_ms < plain_ms * 10.0 + 1.0,
            "read-only reads became pathological: normal={plain_ms:.4} query_only={readonly_ms:.4}"
        );

        cleanup(&path);
    }
}

//! Engine A spike (ADR-0009, migration-plan step 1 — APPROVED FOR SPIKE ONLY).
//!
//! Proves, behind the `turso-sync` cargo feature (off by default):
//!  1. the `turso` crate (stable 0.7.2, `--features sync`) compiles and runs
//!     local CRUD through the exact API copied from the primary source
//!     (`docs.rs/crate/turso` 0.7.2 page, re-verified 2026-09-17):
//!     `turso::Builder::{new_local}`, `turso::sync::Builder::{new_remote,
//!     with_remote_url, with_auth_token, bootstrap_if_empty, build}`,
//!     `db.push()`, `db.pull() -> bool`, `db.checkpoint()`, `db.stats()`;
//!  2. the payload-hygiene invariant (no BLOB bytes on the wire) is enforceable
//!     as a pure Rust gate, mirroring `src/sync/payloadHygiene.ts`;
//!  3. idempotent product upserts (`ON CONFLICT`) behave.
//!
//! Explicitly OUT of scope for the spike: `PosDb`-trait binding, dual-write
//! shadow, traffic cutover, and JS-transport retirement (ADR-0009 steps 2+,
//! each needing separate sign-off). Tables use the `spike_` prefix so this
//! module can never collide with the real schema.
//!
//! Target-matrix abort criterion (ADR-0009): any of the five targets failing
//! to `cargo check` this feature stops the migration and escalates.

#[cfg(feature = "turso-sync")]
pub mod engine {
    use crate::error::PosError;

    /// Spike-local product projection (subset of [`crate::models::Product`]).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct SpikeProduct {
        pub id: String,
        pub title: String,
        pub price: i64,
        pub stock: i64,
    }

    /// Byte budget mirrored from `src/sync/payloadHygiene.ts`
    /// (`MAX_SYNC_PAYLOAD_BYTES`). Payloads carrying more than this MANY bytes
    /// of media/blob content must never reach `push()`.
    pub const SPIKE_MAX_PAYLOAD_BYTES: usize = 64 * 1024;

    const BLOB_MARKERS: [&str; 3] = ["data:image/", "data:application/", "data:video/"];

    /// Pure Rust hygiene gate: `true` when `payload_json` is small enough OR
    /// carries no blob markers. Money/relational content always passes; only
    /// oversized blob-bearing payloads are rejected (caller quarantines them,
    /// never silently drops — Contract C6).
    pub fn payload_within_budget(payload_json: &str) -> bool {
        if payload_json.len() <= SPIKE_MAX_PAYLOAD_BYTES {
            return true;
        }
        !BLOB_MARKERS.iter().any(|m| payload_json.contains(m))
    }

    /// Minimal spike schema. Versioning/ledger/outbox columns arrive with the
    /// real migration (step 2); the point here is engine behavior, not schema.
    pub const SPIKE_DDL: &str = r#"
        CREATE TABLE IF NOT EXISTS spike_products (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            price INTEGER NOT NULL,
            stock INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS spike_outbox (
            idempotency_key TEXT PRIMARY KEY,
            entity_id TEXT NOT NULL,
            payload_json TEXT NOT NULL
        );
    "#;

    fn map_err(context: &'static str, err: turso::Error) -> PosError {
        PosError::Sync(format!("{context}: {err}"))
    }

    /// Local engine handle (file path or `:memory:`).
    pub struct TursoEngine {
        db: turso::Database,
    }

    impl TursoEngine {
        /// Open a LOCAL database. No network involved — safe on every target,
        /// including airplane mode (Contract C2 shape).
        pub async fn open_local(path: &str) -> Result<Self, PosError> {
            let db = turso::Builder::new_local(path)
                .build()
                .await
                .map_err(|e| map_err("open_local", e))?;
            Ok(Self { db })
        }

        pub fn connect(
            &self,
        ) -> Result<turso::Connection, PosError> {
            self.db.connect().map_err(|e| map_err("connect", e))
        }

        pub async fn migrate_minimal(
            &self,
        ) -> Result<(), PosError> {
            let conn = self.connect()?;
            for stmt in SPIKE_DDL.split(';').map(str::trim).filter(|s| !s.is_empty()) {
                conn.execute(stmt, ())
                    .await
                    .map_err(|e| map_err("migrate_minimal", e))?;
            }
            Ok(())
        }

        /// Idempotent upsert: replays converge (`ON CONFLICT DO UPDATE`),
        /// mirroring the JS outbox `ON CONFLICT` discipline (Contract C5).
        pub async fn upsert_product(
            &self,
            product: &SpikeProduct,
        ) -> Result<(), PosError> {
            let conn = self.connect()?;
            conn.execute(
                "INSERT INTO spike_products (id, title, price, stock) VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(id) DO UPDATE SET title=excluded.title, price=excluded.price, stock=excluded.stock",
                (
                    product.id.clone(),
                    product.title.clone(),
                    product.price,
                    product.stock,
                ),
            )
            .await
            .map_err(|e| map_err("upsert_product", e))?;
            Ok(())
        }

        pub async fn get_product(
            &self,
            id: &str,
        ) -> Result<Option<SpikeProduct>, PosError> {
            let conn = self.connect()?;
            let mut rows = conn
                .query(
                    "SELECT id, title, price, stock FROM spike_products WHERE id = ?1",
                    (id.to_string(),),
                )
                .await
                .map_err(|e| map_err("get_product/query", e))?;
            let Some(row) = rows
                .next()
                .await
                .map_err(|e| map_err("get_product/next", e))?
            else {
                return Ok(None);
            };
            let text = |idx: usize| -> Result<String, PosError> {
                row.get_value(idx)
                    .map_err(|e| map_err("get_product/col", e))?
                    .as_text()
                    .cloned()
                    .ok_or_else(|| PosError::Database(format!("spike_products text col {idx} is not text")))
            };
            let int = |idx: usize| -> Result<i64, PosError> {
                row.get_value(idx)
                    .map_err(|e| map_err("get_product/col", e))?
                    .as_integer()
                    .copied()
                    .ok_or_else(|| PosError::Database(format!("spike_products int col {idx} is not integer")))
            };
            Ok(Some(SpikeProduct {
                id: text(0)?,
                title: text(1)?,
                price: int(2)?,
                stock: int(3)?,
            }))
        }

        /// Enqueue an idempotent outbox row, enforcing the hygiene gate first.
        /// Oversized blob payloads are REJECTED (caller quarantines) — never
        /// truncated, never silently dropped (Contracts C5/C6).
        pub async fn enqueue_spike_outbox(
            &self,
            idempotency_key: &str,
            entity_id: &str,
            payload_json: &str,
        ) -> Result<(), PosError> {
            if !payload_within_budget(payload_json) {
                return Err(PosError::Sync(format!(
                    "hygiene gate: {}B blob payload refused for {entity_id}",
                    payload_json.len()
                )));
            }
            let conn = self.connect()?;
            conn.execute(
                "INSERT INTO spike_outbox (idempotency_key, entity_id, payload_json) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(idempotency_key) DO NOTHING",
                (
                    idempotency_key.to_string(),
                    entity_id.to_string(),
                    payload_json.to_string(),
                ),
            )
            .await
            .map_err(|e| map_err("enqueue_spike_outbox", e))?;
            Ok(())
        }
    }

    /// Remote (synced) database handle. Construction performs NO I/O by
    /// itself beyond what `build()` does; `push()`/`pull()` move the bytes.
    pub async fn open_remote(
        local_path: &str,
        remote_url: &str,
        auth_token: &str,
        bootstrap_if_empty: bool,
    ) -> Result<turso::sync::Database, PosError> {
        turso::sync::Builder::new_remote(local_path)
            .with_remote_url(remote_url.to_string())
            .with_auth_token(auth_token.to_string())
            .bootstrap_if_empty(bootstrap_if_empty)
            .build()
            .await
            .map_err(|e| map_err("open_remote", e))
    }

    /// Push local CDC frames to Turso Cloud. Call off the UI thread.
    pub async fn push_remote(db: &turso::sync::Database) -> Result<(), PosError> {
        db.push().await.map_err(|e| map_err("push", e))
    }

    /// Pull remote frames; returns `true` when changes were applied
    /// (drives `db:changed` invalidation, never blind full refresh).
    pub async fn pull_remote(db: &turso::sync::Database) -> Result<bool, PosError> {
        db.pull().await.map_err(|e| map_err("pull", e))
    }

    /// Force a WAL checkpoint to bound local disk growth.
    pub async fn checkpoint_remote(db: &turso::sync::Database) -> Result<(), PosError> {
        db.checkpoint()
            .await
            .map_err(|e| map_err("checkpoint", e))
    }

    /// Byte-level sync telemetry for the health UI (`db:changed` + badges).
    /// Tuple: (network_received_bytes, network_sent_bytes, main_wal_size),
    /// in each field's native width as reported by `turso` 0.7.2.
    pub async fn remote_stats(
        db: &turso::sync::Database,
    ) -> Result<(usize, usize, u64), PosError> {
        let stats = db.stats().await.map_err(|e| map_err("stats", e))?;
        Ok((
            stats.network_received_bytes,
            stats.network_sent_bytes,
            stats.main_wal_size,
        ))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn sample() -> SpikeProduct {
            SpikeProduct {
                id: "prod-spike-1".to_string(),
                title: "Coque Anker".to_string(),
                price: 1500,
                stock: 42,
            }
        }

        #[tokio::test]
        async fn local_crud_round_trip() {
            let engine = TursoEngine::open_local(":memory:")
                .await
                .expect("open :memory:");
            engine.migrate_minimal().await.expect("migrate");
            assert_eq!(engine.get_product("nope").await.expect("get missing"), None);
            engine.upsert_product(&sample()).await.expect("upsert");
            assert_eq!(
                engine.get_product("prod-spike-1").await.expect("get"),
                Some(sample())
            );
        }

        #[tokio::test]
        async fn upsert_replay_converges() {
            let engine = TursoEngine::open_local(":memory:")
                .await
                .expect("open :memory:");
            engine.migrate_minimal().await.expect("migrate");
            engine.upsert_product(&sample()).await.expect("upsert 1");
            let mut v2 = sample();
            v2.stock = 40;
            v2.price = 1600;
            engine.upsert_product(&v2).await.expect("upsert replay");
            assert_eq!(
                engine.get_product("prod-spike-1").await.expect("get"),
                Some(v2)
            );
        }

        #[tokio::test]
        async fn outbox_dedupes_on_idempotency_key() {
            let engine = TursoEngine::open_local(":memory:")
                .await
                .expect("open :memory:");
            engine.migrate_minimal().await.expect("migrate");
            engine
                .enqueue_spike_outbox("key-1", "prod-spike-1", r#"{"stock":42}"#)
                .await
                .expect("enqueue 1");
            // Replay with the SAME key must not duplicate (C5).
            engine
                .enqueue_spike_outbox("key-1", "prod-spike-1", r#"{"stock":41}"#)
                .await
                .expect("enqueue replay");
            let conn = engine.connect().expect("connect");
            let mut rows = conn
                .query("SELECT COUNT(*) FROM spike_outbox", ())
                .await
                .expect("count");
            let row = rows.next().await.expect("next").expect("row");
            assert_eq!(row.get_value(0).expect("col").as_integer(), Some(&1));
        }

        #[test]
        fn hygiene_gate_blocks_blob_bloat() {
            assert!(payload_within_budget(r#"{"id":"p1","stock":3}"#));
            // 20 MB base64 analogue (forensic shape): refused.
            let mut big = String::from(r#"{"id":"p1","image":"data:image/jpeg;base64,"#);
            big.push_str(&"A".repeat(20_260_360));
            big.push_str(r#""}"#);
            assert!(!payload_within_budget(&big));
            // Large but blob-free content passes (money over budget beats silence).
            let mut notes = String::from(r#"{"id":"p1","notes":""#);
            notes.push_str(&"note ok. ".repeat(20_000));
            notes.push_str(r#""}"#);
            assert!(payload_within_budget(&notes));
        }

        #[tokio::test]
        async fn enqueue_refuses_blob_payload() {
            let engine = TursoEngine::open_local(":memory:")
                .await
                .expect("open :memory:");
            engine.migrate_minimal().await.expect("migrate");
            let mut big = String::from(r#"{"image":"data:image/jpeg;base64,"#);
            big.push_str(&"A".repeat(70_000));
            big.push_str("}");
            let err = engine
                .enqueue_spike_outbox("key-blob", "p1", &big)
                .await
                .expect_err("blob must be refused");
            assert!(matches!(err, PosError::Sync(_)));
        }

        /// Live round-trip against Turso Cloud. IGNORED by default — runs only
        /// with real device-scoped credentials:
        /// `TURSO_TEST_URL` + `TURSO_TEST_TOKEN` (+ optional `TURSO_TEST_PATH`).
        /// Never runs in CI without secrets; never touches merchant data
        /// (writes only `spike_*` tables).
        #[tokio::test]
        #[ignore]
        async fn remote_push_pull_round_trip() {
            let (url, token) = match (
                std::env::var("TURSO_TEST_URL"),
                std::env::var("TURSO_TEST_TOKEN"),
            ) {
                (Ok(u), Ok(t)) => (u, t),
                _ => {
                    eprintln!("skipped: set TURSO_TEST_URL + TURSO_TEST_TOKEN to run");
                    return;
                }
            };
            let path = std::env::var("TURSO_TEST_PATH")
                .unwrap_or_else(|_| format!("{}spike-test.db", std::env::temp_dir().display()));
            let db = open_remote(&path, &url, &token, true)
                .await
                .expect("open_remote");
            push_remote(&db).await.expect("push");
            let _changed: bool = pull_remote(&db).await.expect("pull");
            checkpoint_remote(&db).await.expect("checkpoint");
            let (rx, tx, wal) = remote_stats(&db).await.expect("stats");
            eprintln!("remote stats: rx={rx}B tx={tx}B wal={wal}B");
        }
    }
}

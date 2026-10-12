//! Phase TIER-B+ — durable monotonic time anchor for money-path commits.
//!
//! The supervisor freshness window and outbox sequencing must not rest on
//! mutable host wall time: a cashier rolling the OS clock back could
//! resurrect an expired authorization or forge audit trails. This module is
//! the single money-path clock:
//!
//! - Durable high-water mark (`time_anchor` table, id=1 row): every commit
//!   advances it; a wall clock read behind it (past tolerance) hard-faults
//!   instead of blessing the rollback. First boot adopts the wall (nothing
//!   to compare); an RTC-reset wall (`< MIN_PLAUSIBLE_UTC_MS`) faults even
//!   then.
//! - In-process monotonicity via [`MonotonicSource`] (sleep-inclusive OS
//!   tickers — `std::time::Instant` is BANNED for trusted time, see
//!   `clocks.rs`). Returned time is derived as
//!   `high_water + (mono_now − high_water_mono)`, floored at the high-water:
//!   non-decreasing across calls, restarts, and small wall wobbles.
//! - Forward jumps are ratcheted, never blessed: the high-water advances at
//!   most `FORWARD_RATCHET_MS` per observation past the derived time
//!   (mirrors the `time_engine` discipline), while the returned instant
//!   stays monotonic-derived.
//! - Server ingestion reuses the `reanchor` key discipline (placeholder
//!   refuses in release; no second key, no bypass) under a distinct
//!   `SERVERTIME_V1` envelope prefix so the two protocols cannot
//!   cross-verify. Without a challenge binding, anti-replay comes from
//!   expiry + strictly-increasing server observations — a weaker path than
//!   `trust_reanchor_time`, documented as skew calibration, never
//!   quarantine exit.
//!
//! All comparisons are integral epoch milliseconds. The table is
//! native-owned (`CREATE TABLE IF NOT EXISTS` inline, like `audit_chain`):
//! no migration version, no TS writer, no core-ledger churn.

use super::clocks::MonotonicSource;
use super::ipc_authorizer::TrustError;
use super::time_config::MIN_PLAUSIBLE_UTC_MS;
use rusqlite::Transaction;

/// Wall behind the high-water by more than this hard-faults (rollback).
pub const REGRESSION_TOLERANCE_MS: i64 = 60_000;
/// Forward blessing cap per observation (ratchet, never a jump).
pub const FORWARD_RATCHET_MS: i64 = 60_000;

const ANCHOR_DDL: &str = "
CREATE TABLE IF NOT EXISTS time_anchor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    high_water_ms INTEGER NOT NULL,
    high_water_mono_ms INTEGER NOT NULL,
    last_server_ms INTEGER NOT NULL DEFAULT 0,
    last_server_nonce TEXT NOT NULL DEFAULT '',
    skew_ms INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);";

fn system_wall_ms() -> Result<i64, TrustError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .map_err(|_| {
            TrustError::op_failed("SYSTEM_CLOCK_REGRESSION:wall_before_epoch".to_string())
        })
}

/// Millisecond ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS.mmmZ`) from epoch millis.
/// Inverse of `device_identity::parse_iso_utc_ms` (same shape, millis kept).
pub fn iso_utc_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil_from_days (Howard Hinnant), mirrored from audit_append.
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
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

/// Money-path now: monotonic-derived, high-water floored, ratchet-advanced —
/// all inside the caller's transaction (read + advance are atomic with the
/// commit they timestamp).
pub fn anchor_now_ms(
    tx: &Transaction,
    clock: &dyn MonotonicSource,
) -> Result<i64, TrustError> {
    tx.execute_batch(ANCHOR_DDL)
        .map_err(|e| TrustError::op_failed(format!("anchor ddl: {e}")))?;
    let mono = clock.now_ms().ok_or_else(|| {
        TrustError::op_failed("SYSTEM_CLOCK_REGRESSION:monotonic_unavailable".to_string())
    })?;
    let mono_i = i64::try_from(mono).map_err(|_| {
        TrustError::op_failed("SYSTEM_CLOCK_REGRESSION:monotonic_unavailable".to_string())
    })?;
    let wall = system_wall_ms()?;
    if (wall as u64) < MIN_PLAUSIBLE_UTC_MS {
        return Err(TrustError::op_failed(
            "SYSTEM_CLOCK_REGRESSION:rtc_reset".to_string(),
        ));
    }
    let row: Option<(i64, i64)> = tx
        .query_row(
            "SELECT high_water_ms, high_water_mono_ms FROM time_anchor WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(TrustError::op_failed(format!("anchor read: {other}"))),
        })?;
    let Some((hw, hw_mono)) = row else {
        // First boot: adopt the (plausible, checked above) wall.
        tx.execute(
            "INSERT INTO time_anchor (id, high_water_ms, high_water_mono_ms, updated_at) \
             VALUES (1, ?1, ?2, ?3)",
            rusqlite::params![wall, mono_i, iso_utc_ms(wall)],
        )
        .map_err(|e| TrustError::op_failed(format!("anchor init: {e}")))?;
        return Ok(wall);
    };
    // Backward wall past tolerance = rollback. Fail closed, advance nothing.
    if wall + REGRESSION_TOLERANCE_MS < hw {
        return Err(TrustError::op_failed(format!(
            "SYSTEM_CLOCK_REGRESSION:last_seen_{hw}_attempted_{wall}"
        )));
    }
    let expected = hw.saturating_add(mono_i.saturating_sub(hw_mono));
    let now = expected.max(hw);
    // Ratchet: bless at most FORWARD_RATCHET_MS past the derived instant.
    let capped_wall = wall.min(now.saturating_add(FORWARD_RATCHET_MS));
    let new_hw = now.max(capped_wall);
    tx.execute(
        "UPDATE time_anchor SET high_water_ms = ?1, high_water_mono_ms = ?2, updated_at = ?3 WHERE id = 1",
        rusqlite::params![new_hw, mono_i, iso_utc_ms(new_hw)],
    )
    .map_err(|e| TrustError::op_failed(format!("anchor advance: {e}")))?;
    Ok(now)
}

/// Current durable high-water (diagnostics; `None` before first anchor).
pub fn current_high_water(conn: &rusqlite::Connection) -> Option<i64> {
    conn.query_row("SELECT high_water_ms FROM time_anchor WHERE id = 1", [], |r| {
        r.get(0)
    })
    .ok()
}

// ---------------------------------------------------------------------------
// Signed server-time ingestion (skew calibration path)
// ---------------------------------------------------------------------------

/// Distinct envelope prefix: `SERVERTIME_V1` assertions can never verify as
/// `REANCHOR_V1` (or license tokens) even under a shared key.
pub const SERVERTIME_PREFIX: &str = "SERVERTIME_V1";

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerTimeIngest {
    pub server_time_ms: i64,
    pub skew_ms: i64,
}

/// Ingest a gateway-signed time observation: verify → expiry → strictly
/// increasing → advance high-water + record skew. Replay of an old token
/// cannot move the anchor (monotonic server observations); a forged token
/// fails the signature. Uses the SAME production-key resolution as
/// re-anchor (placeholder refuses in release) — one key policy, no fork.
pub fn ingest_server_time(
    tx: &Transaction,
    clock: &dyn MonotonicSource,
    assertion: &str,
    wall_now_ms: u64,
) -> Result<ServerTimeIngest, TrustError> {
    tx.execute_batch(ANCHOR_DDL)
        .map_err(|e| TrustError::op_failed(format!("anchor ddl: {e}")))?;
    // Same production-key resolution as re-anchor (placeholder refuses in
    // release): one key policy, distinct envelope prefix. All verification
    // failures normalize onto the gateway wire code with the specific cause
    // preserved after the colon (one taxonomy for this command's callers).
    let pubkey = super::reanchor::active_time_pubkey_b64url().map_err(|_| {
        TrustError::op_failed("GATEWAY_TIME_SIGNATURE_INVALID:no_time_key".to_string())
    })?;
    let payload = super::reanchor::verify_time_assertion_with_prefix(
        assertion,
        SERVERTIME_PREFIX,
        &pubkey,
        wall_now_ms,
    )
    .map_err(|e| {
        let s = format!("{e:?}");
        let cause = if s.contains("signature invalid") || s.contains("invalid time key") {
            "bad_sig"
        } else if s.contains("expired") {
            "expired"
        } else if s.contains("implausible") {
            "implausible"
        } else {
            "malformed"
        };
        TrustError::op_failed(format!("GATEWAY_TIME_SIGNATURE_INVALID:{cause}"))
    })?;
    let server_ms = i64::try_from(payload.server_time_ms).map_err(|_| {
        TrustError::op_failed("GATEWAY_TIME_SIGNATURE_INVALID:bad_time".to_string())
    })?;
    let (last_server, last_nonce): (i64, String) = tx
        .query_row(
            "SELECT last_server_ms, last_server_nonce FROM time_anchor WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok((0i64, String::new())),
            other => Err(TrustError::op_failed(format!("anchor read: {other}"))),
        })?;
    // Anti-replay: server observations must strictly advance; an exact
    // duplicate (captured token replayed) dies here even inside expiry.
    if server_ms <= last_server
        || (server_ms == last_server && payload.nonce == last_nonce)
    {
        return Err(TrustError::op_failed(
            "GATEWAY_TIME_SIGNATURE_INVALID:stale_or_replayed".to_string(),
        ));
    }
    if server_ms == last_server {
        return Err(TrustError::op_failed(
            "GATEWAY_TIME_SIGNATURE_INVALID:stale_or_replayed".to_string(),
        ));
    }
    let mono = clock.now_ms().ok_or_else(|| {
        TrustError::op_failed("SYSTEM_CLOCK_REGRESSION:monotonic_unavailable".to_string())
    })?;
    let mono_i = i64::try_from(mono).map_err(|_| {
        TrustError::op_failed("SYSTEM_CLOCK_REGRESSION:monotonic_unavailable".to_string())
    })?;
    let (hw, hw_mono): (i64, i64) = tx
        .query_row(
            "SELECT high_water_ms, high_water_mono_ms FROM time_anchor WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok((server_ms, mono_i)),
            other => Err(TrustError::op_failed(format!("anchor read: {other}"))),
        })?;
    let expected = hw.saturating_add(mono_i.saturating_sub(hw_mono));
    let skew = server_ms.saturating_sub(expected);
    let new_hw = hw.max(server_ms);
    let now_iso = iso_utc_ms(server_ms.max(expected));
    // Server time is trusted forward: adopt it (it passed signature +
    // expiry + plausibility inside verification).
    tx.execute(
        "INSERT INTO time_anchor (id, high_water_ms, high_water_mono_ms, last_server_ms, last_server_nonce, skew_ms, updated_at) \
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(id) DO UPDATE SET high_water_ms = excluded.high_water_ms, \
         high_water_mono_ms = excluded.high_water_mono_ms, last_server_ms = excluded.last_server_ms, \
         last_server_nonce = excluded.last_server_nonce, skew_ms = excluded.skew_ms, updated_at = excluded.updated_at",
        rusqlite::params![new_hw, mono_i, server_ms, payload.nonce, skew, now_iso],
    )
    .map_err(|e| TrustError::op_failed(format!("anchor ingest: {e}")))?;
    Ok(ServerTimeIngest {
        server_time_ms: server_ms,
        skew_ms: skew,
    })
}

/// `#[tauri::command]`: ingest gateway-signed time (LicenseManagement — the
/// skew-calibration plane, same as re-anchor; quarantined terminals stay
/// able to observe server time). Size-capped like `trust_reanchor_time`.
#[tauri::command]
pub fn ingest_signed_server_time(
    app: tauri::AppHandle,
    assertion: String,
) -> Result<ServerTimeIngest, TrustError> {
    super::ipc_authorizer::authorize_and_execute(
        "ingest_signed_server_time",
        super::Capability::LicenseManagement,
        |_| {
            use tauri::Manager;
            if assertion.len() > 8 * 1024 {
                return Err(TrustError::IPCProtocolError {
                    reason: "time assertion oversized",
                });
            }
            let app_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| TrustError::op_failed(format!("app dir: {e}")))?;
            let mut conn = rusqlite::Connection::open(crate::e2e::live_db_path(&app_dir))
                .map_err(|e| TrustError::op_failed(format!("ingest open: {e}")))?;
            conn.pragma_update(None, "journal_mode", "WAL")
                .map_err(|e| TrustError::op_failed(format!("ingest wal: {e}")))?;
            conn.busy_timeout(std::time::Duration::from_millis(5000))
                .map_err(|e| TrustError::op_failed(format!("ingest busy_timeout: {e}")))?;
            let wall_now = system_wall_ms().unwrap_or(0) as u64;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|e| TrustError::op_failed(format!("ingest begin: {e}")))?;
            let out = ingest_server_time(
                &tx,
                &super::clocks::production_monotonic(),
                assertion.trim(),
                wall_now,
            )?;
            tx.commit()
                .map_err(|e| TrustError::op_failed(format!("ingest commit: {e}")))?;
            Ok(out)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::super::clocks::ManualClock;
    use super::*;

    /// Debug-only mint (mirrors `reanchor` test discipline: the production
    /// key is a placeholder that refuses, so positive-path ingestion is
    /// provable only where the test key exists).
    #[cfg(debug_assertions)]
    fn mint_servertime(
        server_time_ms: u64,
        expires_at_ms: u64,
        nonce: &str,
        seed: &[u8; 32],
    ) -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        use ed25519_dalek::{Signer, SigningKey};
        let sk = SigningKey::from_bytes(seed);
        let payload = serde_json::json!({
            "nonce": nonce,
            "server_time_ms": server_time_ms,
            "expires_at_ms": expires_at_ms,
        });
        let payload_b64 = URL_SAFE_NO_PAD.encode(payload.to_string());
        let envelope = format!("{SERVERTIME_PREFIX}.{payload_b64}");
        let mut signed = Vec::new();
        signed.extend_from_slice(super::super::reanchor::TIME_ASSERTION_DOMAIN);
        signed.push(b'.');
        signed.extend_from_slice(envelope.as_bytes());
        let sig_b64 = URL_SAFE_NO_PAD.encode(sk.sign(&signed).to_bytes());
        format!("{envelope}.{sig_b64}")
    }

    #[cfg(debug_assertions)]
    fn wall_now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap()
    }

    #[cfg(debug_assertions)]
    #[test]
    fn signed_server_time_ingestion() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let clock = ManualClock::new(1_000_000);
        let now = wall_now();
        // Valid: 50 s ahead of the wall, expires in 5 min.
        let a = mint_servertime(now + 50_000, now + 300_000, "n1", &[9u8; 32]);
        let tx = mem_tx(&conn);
        let out = ingest_server_time(&tx, &clock, &a, now).expect("valid ingest");
        assert_eq!(out.server_time_ms, now as i64 + 50_000);
        tx.commit().unwrap();
        let (hw, last, skew): (i64, i64, i64) = conn
            .query_row(
                "SELECT high_water_ms, last_server_ms, skew_ms FROM time_anchor WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert!(hw >= now as i64 + 50_000, "high-water adopted server time");
        assert_eq!(last, now as i64 + 50_000);
        assert_eq!(skew, out.skew_ms);
        // Exact replay (captured token again): strictly-increasing rule dies.
        let tx = mem_tx(&conn);
        let err = ingest_server_time(&tx, &clock, &a, now).expect_err("replay");
        assert!(format!("{err:?}").contains("stale_or_replayed"), "got: {err:?}");
        drop(tx);
        // Older server time after a newer one: same rule, different token.
        let older = mint_servertime(now + 10_000, now + 300_000, "n2", &[9u8; 32]);
        let tx = mem_tx(&conn);
        assert!(ingest_server_time(&tx, &clock, &older, now).is_err());
        drop(tx);
        // Forged signature: bad_sig, nothing persisted.
        let mut parts: Vec<&str> = a.split('.').collect();
        parts[2] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let forged = parts.join(".");
        let tx = mem_tx(&conn);
        let err = ingest_server_time(&tx, &clock, &forged, now).expect_err("forged");
        assert!(format!("{err:?}").contains("bad_sig"), "got: {err:?}");
        drop(tx);
        // Expired token: rejected on expiry, not the signature.
        let stale = mint_servertime(now + 50_000, now.saturating_sub(1_000), "n3", &[9u8; 32]);
        let tx = mem_tx(&conn);
        let err = ingest_server_time(&tx, &clock, &stale, now).expect_err("expired");
        assert!(format!("{err:?}").contains("expired"), "got: {err:?}");
        drop(tx);
        // Anchor untouched by every refusal.
        assert_eq!(current_high_water(&conn), Some(hw));
    }

    fn mem_tx(conn: &rusqlite::Connection) -> rusqlite::Transaction<'_> {
        // Helper opening an immediate txn on a test connection.
        conn.unchecked_transaction().unwrap()
    }

    #[test]
    fn first_boot_adopts_plausible_wall() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let tx = mem_tx(&conn);
        let clock = ManualClock::new(5_000);
        let now = anchor_now_ms(&tx, &clock).unwrap();
        let wall = system_wall_ms().unwrap();
        assert!((now - wall).abs() < 5_000, "adopts wall, got {now} vs {wall}");
        tx.commit().unwrap();
        assert_eq!(current_high_water(&conn), Some(now));
    }

    #[test]
    fn monotonic_derivation_and_ratchet() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let mut clock = ManualClock::new(1_000);
        let t0 = {
            let tx = mem_tx(&conn);
            let t = anchor_now_ms(&tx, &clock).unwrap();
            tx.commit().unwrap();
            t
        };
        // Same mono tick: identical instant (floored, never backwards).
        {
            let tx = mem_tx(&conn);
            assert_eq!(anchor_now_ms(&tx, &clock).unwrap(), t0);
            tx.commit().unwrap();
        }
        // Mono advances 10 s: derived instant advances with it.
        clock.advance(10_000);
        let t1 = {
            let tx = mem_tx(&conn);
            let t = anchor_now_ms(&tx, &clock).unwrap();
            tx.commit().unwrap();
            t
        };
        assert_eq!(t1, t0 + 10_000);
    }

    #[test]
    fn rollback_behind_high_water_hard_faults() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        // Plant a high-water far above any wall this test can observe.
        let hw = system_wall_ms().unwrap() + 3_600_000;
        conn.execute_batch(ANCHOR_DDL).unwrap();
        conn.execute(
            "INSERT INTO time_anchor (id, high_water_ms, high_water_mono_ms, updated_at) VALUES (1, ?1, 0, 't')",
            [hw],
        )
        .unwrap();
        let clock = ManualClock::new(1_000);
        let tx = mem_tx(&conn);
        let err = anchor_now_ms(&tx, &clock).expect_err("must fault");
        let msg = format!("{err:?}");
        assert!(msg.contains("SYSTEM_CLOCK_REGRESSION"), "got: {msg}");
        assert!(msg.contains(&hw.to_string()), "got: {msg}");
        // Nothing advanced: the planted mark is untouched.
        drop(tx);
        assert_eq!(current_high_water(&conn), Some(hw));
    }

    #[test]
    fn iso_formatter_roundtrips_parser() {
        use super::super::device_identity::parse_iso_utc_ms;
        for ms in [0i64, 1_000, 1_767_312_060_500, 1_767_312_060_001, 4_102_444_800_000] {
            let s = iso_utc_ms(ms);
            assert_eq!(parse_iso_utc_ms(&s).unwrap(), ms, "{s}");
        }
        assert_eq!(iso_utc_ms(0), "1970-01-01T00:00:00.000Z");
    }
}

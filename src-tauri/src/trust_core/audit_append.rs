//! Phase 4.4 — native append-only audit with hash chain.
//!
//! The single funnel for all JS audit writes (`logSecurityAction`, ~30 call
//! sites): instead of a direct `INSERT INTO security_audit_logs` through the
//! WebView SQL plugin, the WebView calls `audit_append` and native code
//! performs the write. At the gateway layer the WebView will lose write
//! access to this table entirely; this command is the Tier A path that
//! survives that removal.
//!
//! Chain: `entry_hash = HMAC(audit-subkey, prev_hash || canonical(entry))`
//! with `audit-subkey = HMAC(master, "MOBI-AUDIT-V1")` (same sub-key pattern
//! as the manifest MAC — one master, one label, one purpose). Links live in
//! a companion `audit_chain` table (no schema change to existing installs:
//! `CREATE TABLE IF NOT EXISTS`), so legacy rows act as genesis boundaries
//! (`LEGACY-BOUNDARY:<id>`). No trust key available → the row is still
//! written (audit must not block primary actions) but chained as
//! `NO-KEY`, recorded in the receipt.
//!
//! Truncation defense (Phase 4.5): the chain head `{seq, hash, mac}` lives in
//! the native keystore (seq = chain-row count). Deleting the newest rows and
//! links leaves a shorter valid chain — the head comparison catches it.
//! Head MAC = `HMAC(audit-subkey, seq || hash)`.
//!
//! Capability: OperationalWrites. Audit writes describe operational activity;
//! granting them under LicenseManagement would let locked terminals spam the
//! log. Locked-state audit needs (export attempts, denials) already have
//! dedicated native paths (emergency export audit, kernel denial log).

use super::export_snapshot::{domain_subkey, hmac_sha256_raw, mac_eq};
use super::export_snapshot::{resolve_manifest_mac_key, ManifestMac};
use super::ipc_authorizer::TrustError;
use super::secure_storage::{AuditHead, KeyStore};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Size caps: audit is telemetry, not a blob store. Oversized payloads are
/// rejected (typed), never truncated (truncation would rewrite meaning).
pub const MAX_ACTION_LEN: usize = 128;
pub const MAX_DETAILS_LEN: usize = 8192;
pub const MAX_USER_LEN: usize = 64;

/// Chain domain label (see module docs).
pub const AUDIT_SUBKEY_LABEL: &[u8] = b"MOBI-AUDIT-V1";
const GENESIS_HASH: &str = "MOBI-AUDIT-GENESIS-V1";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditAppendRequest {
    pub action: String,
    pub details: String,
    pub user: Option<String>,
    pub requires_pin: Option<bool>,
    pub device_id: Option<String>,
    pub ip_address: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditAppendReceipt {
    pub event_id: String,
    /// Hex chain hash, or `None` when no trust key was available (row still
    /// written; receipt says so — never faked).
    pub entry_hash: Option<String>,
}

fn validate(req: &AuditAppendRequest) -> Result<(), TrustError> {
    let action = req.action.trim();
    if action.is_empty() || action.len() > MAX_ACTION_LEN {
        return Err(TrustError::IPCProtocolError {
            reason: "audit action must be 1..128 chars",
        });
    }
    if req.details.len() > MAX_DETAILS_LEN {
        return Err(TrustError::IPCProtocolError {
            reason: "audit details exceed 8 KiB",
        });
    }
    if req.user.as_deref().unwrap_or("").len() > MAX_USER_LEN {
        return Err(TrustError::IPCProtocolError {
            reason: "audit user exceeds 64 chars",
        });
    }
    Ok(())
}

fn canonical_bytes(
    event_id: &str,
    timestamp: &str,
    user: &str,
    action: &str,
    details: &str,
    requires_pin: bool,
    device_id: &str,
) -> Vec<u8> {
    format!(
        "{event_id}\n{timestamp}\n{user}\n{action}\n{details}\n{requires_pin}\n{device_id}"
    )
    .into_bytes()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Columns actually present in this install's `security_audit_logs`
/// (schema drifted across versions: `version`/`ip_address` optional).
fn table_columns(conn: &Connection) -> Result<std::collections::HashSet<String>, TrustError> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(security_audit_logs);")
        .map_err(|e| TrustError::op_failed(format!("audit table probe: {e}")))?;
    let cols = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| TrustError::op_failed(format!("audit table probe: {e}")))?
        .collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(|e| TrustError::op_failed(format!("audit table probe: {e}")))?;
    Ok(cols)
}

/// Head of the chain: last `audit_chain.entry_hash`, else a legacy boundary
/// derived from the newest legacy row, else genesis.
fn chain_head(conn: &Connection) -> Result<String, TrustError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS audit_chain (
            event_id TEXT PRIMARY KEY,
            prev_hash TEXT NOT NULL,
            entry_hash TEXT NOT NULL
        );",
    )
    .map_err(|e| TrustError::op_failed(format!("audit chain table: {e}")))?;
    let head: Option<String> = conn
        .query_row(
            "SELECT entry_hash FROM audit_chain ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    if let Some(h) = head {
        return Ok(h);
    }
    let legacy: Option<String> = conn
        .query_row(
            "SELECT id FROM security_audit_logs ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    Ok(match legacy {
        Some(id) => format!("LEGACY-BOUNDARY:{id}"),
        None => GENESIS_HASH.to_string(),
    })
}

/// Append one audit row + chain link in a single native transaction.
/// `mac_key`: `Some` seals the link; `None` writes the row unchained
/// (receipt says so). Never throws for missing keys — audit is telemetry.
pub fn append_audit_event(
    conn: &mut Connection,
    mac_key: Option<&[u8]>,
    req: &AuditAppendRequest,
    event_id: &str,
    timestamp: &str,
) -> Result<AuditAppendReceipt, TrustError> {
    validate(req)?;
    let user = req.user.clone().unwrap_or_else(|| "unknown".into());
    let device_id = req.device_id.clone().unwrap_or_default();
    let requires_pin = req.requires_pin.unwrap_or(false);

    let tx = conn
        .transaction()
        .map_err(|e| TrustError::op_failed(format!("audit txn: {e}")))?;
    {
        let cols = table_columns(&tx)?;
        for required in ["id", "timestamp", "user", "action", "details"] {
            if !cols.contains(required) {
                return Err(TrustError::op_failed(format!(
                    "audit table missing column: {required}"
                )));
            }
        }
        // Build INSERT over the intersection of known-writable columns.
        let mut names: Vec<&str> = vec!["id", "timestamp", "user", "action", "details"];
        let mut values: Vec<String> = vec![
            event_id.to_string(),
            timestamp.to_string(),
            user.clone(),
            req.action.trim().to_string(),
            req.details.clone(),
        ];
        if cols.contains("requires_pin") {
            names.push("requires_pin");
            values.push(if requires_pin { "1".into() } else { "0".into() });
        }
        if cols.contains("device_id") {
            names.push("device_id");
            values.push(device_id.clone());
        }
        if cols.contains("ip_address") {
            names.push("ip_address");
            values.push(req.ip_address.clone().unwrap_or_default());
        }
        if cols.contains("version") {
            names.push("version");
            values.push("1".into());
        }
        let placeholders = names.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "INSERT INTO security_audit_logs ({}) VALUES ({})",
            names.join(","),
            placeholders
        );
        // Head BEFORE the insert: otherwise the just-written row masquerades
        // as a pre-chain legacy row (LEGACY-BOUNDARY:self).
        let prev = chain_head(&tx)?;
        {
            let mut stmt = tx
                .prepare(&sql)
                .map_err(|e| TrustError::op_failed(format!("audit insert prepare: {e}")))?;
            let params: Vec<&dyn rusqlite::ToSql> =
                values.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
            stmt.execute(params.as_slice())
                .map_err(|e| TrustError::op_failed(format!("audit insert: {e}")))?;
        }

        // Canonical pin flag mirrors what is actually stored: installs
        // whose table lacks requires_pin/device_id columns verify with the
        // same defaults (see verify_audit_chain), so minimal schemas can
        // never false-alarm.
        let pin_stored = cols.contains("requires_pin") && requires_pin;
        let dev_stored = if cols.contains("device_id") {
            device_id.clone()
        } else {
            String::new()
        };
        let entry_hash = mac_key.map(|k| {
            hex(&hmac_sha256_raw(
                &domain_subkey(k, AUDIT_SUBKEY_LABEL),
                &[
                    prev.as_bytes(),
                    &canonical_bytes(
                        event_id,
                        timestamp,
                        &user,
                        req.action.trim(),
                        &req.details,
                        pin_stored,
                        &dev_stored,
                    ),
                ]
                .concat(),
            ))
        });
        tx.execute(
            "INSERT OR REPLACE INTO audit_chain (event_id, prev_hash, entry_hash) VALUES (?1, ?2, ?3)",
            rusqlite::params![
                event_id,
                prev,
                entry_hash.clone().unwrap_or_else(|| "NO-KEY".into())
            ],
        )
        .map_err(|e| TrustError::op_failed(format!("audit chain insert: {e}")))?;
        tx.commit()
            .map_err(|e| TrustError::op_failed(format!("audit commit: {e}")))?;
        Ok(AuditAppendReceipt {
            event_id: event_id.to_string(),
            entry_hash,
        })
    }
}

/// Verify the full chain: every link recomputed and compared, in rowid
/// order. Legacy boundaries reset the expectation (pre-chain rows are not
/// verifiable — reported, not failed). Column-tolerant like append:
/// installs missing `requires_pin`/`device_id` verify with the same
/// defaults. Returns verified link count.
pub fn verify_audit_chain(
    conn: &Connection,
    mac_key: &[u8],
) -> Result<usize, TrustError> {
    // Discover optional columns first: minimal-schema installs lack them
    // and a static SELECT would fail with "no such column".
    let cols = table_columns(conn).unwrap_or_default();
    let pin_sel = if cols.contains("requires_pin") {
        "l.requires_pin"
    } else {
        "0"
    };
    let dev_sel = if cols.contains("device_id") {
        "l.device_id"
    } else {
        "''"
    };
    let sql = format!(
        "SELECT c.event_id, c.prev_hash, c.entry_hash, l.timestamp, l.user,
                l.action, l.details, {pin_sel}, {dev_sel}
         FROM audit_chain c LEFT JOIN security_audit_logs l ON l.id = c.event_id
         ORDER BY c.rowid"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| TrustError::op_failed(format!("audit chain read: {e}")))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        })
        .map_err(|e| TrustError::op_failed(format!("audit chain read: {e}")))?;
    let sub = domain_subkey(mac_key, AUDIT_SUBKEY_LABEL);
    let mut expected_prev: Option<String> = None;
    let mut verified = 0usize;
    for row in rows {
        let (id, prev, stored, ts, user, action, details, pin, dev) =
            row.map_err(|e| TrustError::op_failed(format!("audit chain decode: {e}")))?;
        // Genesis/first link: prev must be GENESIS or a legacy boundary.
        if let Some(exp) = &expected_prev {
            if exp != &prev {
                return Err(TrustError::op_failed(format!(
                    "audit chain broken before {id}: link mismatch"
                )));
            }
        } else if prev != GENESIS_HASH && !prev.starts_with("LEGACY-BOUNDARY:") && prev != "NO-KEY" {
            return Err(TrustError::op_failed(format!(
                "audit chain has no valid genesis before {id}"
            )));
        }
        if stored == "NO-KEY" {
            // Unkeyed link: recorded, not verifiable — advance past it.
            expected_prev = None;
            continue;
        }
        let (ts, user, action, details) = match (ts, user, action, details) {
            (Some(a), Some(b), Some(c), Some(d)) => (a, b, c, d),
            _ => {
                return Err(TrustError::op_failed(format!(
                    "audit chain references missing log row: {id}"
                )))
            }
        };
        // Same store-tolerant defaults as append (minimal schemas verify).
        let recomputed = hex(&hmac_sha256_raw(
            &sub,
            &[
                prev.as_bytes(),
                &canonical_bytes(&id, &ts, &user, &action, &details, pin.unwrap_or(0) != 0, &dev.unwrap_or_default()),
            ]
            .concat(),
        ));
        let mut diff = 0u8;
        if recomputed.len() != stored.len() {
            return Err(TrustError::op_failed(format!(
                "audit chain MAC mismatch at {id}"
            )));
        }
        for (a, b) in recomputed.bytes().zip(stored.bytes()) {
            diff |= a ^ b;
        }
        if diff != 0 {
            return Err(TrustError::op_failed(format!(
                "audit chain MAC mismatch at {id}"
            )));
        }
        expected_prev = Some(stored);
        verified += 1;
    }
    Ok(verified)
}

/// Chain status for verifiers and the export manifest. `intact` and
/// `broken` are definitive; `unsealed` means no key was available (hashes
/// still checked for corruption where possible).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChainState {
    Intact,
    Broken(String),
    Unsealed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditChainStatus {
    pub state: ChainState,
    pub links_verified: usize,
    pub total_links: u64,
    pub head_seq: Option<u64>,
}

/// Head MAC binds (seq, hash): `HMAC(audit-subkey, "seq:hash")`.
fn head_mac(mac_key: &[u8], seq: u64, hash: &str) -> String {
    hex(&hmac_sha256_raw(
        &domain_subkey(mac_key, AUDIT_SUBKEY_LABEL),
        format!("{seq}:{hash}").as_bytes(),
    ))
}

/// Advance the keystore head after an append (fast path; verify heals when
/// this step was skipped by a crash). Best-effort: failure is logged by the
/// caller, and the next verify heals forward from valid links. Re-sealing
/// over an existing chain with no prior head is logged loudly: it is the
/// recovery path for a deleted head, and it necessarily baselines whatever
/// survived (a truncated chain would become the new baseline — accepted only
/// because a keyed append just proved live write access, and the event is
/// in the log for review).
pub fn advance_audit_head(
    conn: &Connection,
    store: &dyn KeyStore,
    mac_key: &[u8],
) -> Result<AuditHead, TrustError> {
    let total: u64 = conn
        .query_row("SELECT COUNT(*) FROM audit_chain", [], |r| r.get(0))
        .map_err(|e| TrustError::op_failed(format!("audit head count: {e}")))?;
    let last: String = conn
        .query_row(
            "SELECT entry_hash FROM audit_chain ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| TrustError::op_failed(format!("audit head read: {e}")))?;
    let head = AuditHead {
        seq: total,
        hash: last.clone(),
        mac: head_mac(mac_key, total, &last),
    };
    if total > 0 {
        // Re-seal recovery path (see `store_audit_head` monotonicity): a
        // readable older head can never move backwards — the store refuses.
        if matches!(store.load_audit_head(), Ok(None)) {
            eprintln!(
                "[trust_core] audit head re-sealed over {total}-link chain with no prior head \
                 (recovery path; survivors become the new baseline — review for truncation)"
            );
        }
    }
    store
        .store_audit_head(&head)
        .map_err(|e| TrustError::op_failed(format!("audit head store: {e:?}")))?;
    Ok(head)
}

/// Full verification with truncation defense:
/// 1. Walk every link with HMAC recomputation (legacy/NO-KEY boundaries as
///    in `verify_audit_chain`).
/// 2. Compare terminal (count, last hash) against the keystore head:
///    behind → Broken (truncation); ahead with valid links → heal forward.
/// 3. No head on record with a non-empty chain → Broken (fail closed: the
///    head is the truncation anchor, and silently re-sealing here would
///    bless a truncated chain as the new baseline). Recovery: the next
///    keyed `audit_append` re-seals via `advance_audit_head` (logged).
/// 4. No key → structural walk only (prev continuity, no MACs) → Intact or
///    Broken on linkage break, reported Unsealed by the caller variant.
/// 5. Unreadable chain table: fresh only when no head is sealed (no head +
///    no table = fresh install); a sealed head with no readable table is a
///    DB rollback under a live keystore → Broken.
pub fn verify_audit_chain_full(
    conn: &Connection,
    store: &dyn KeyStore,
    mac_key: Option<&[u8]>,
) -> AuditChainStatus {
    use super::secure_storage::StoreError;
    let total: u64 = match conn.query_row("SELECT COUNT(*) FROM audit_chain", [], |r| r.get(0)) {
        Ok(n) => n,
        Err(_) => match store.load_audit_head() {
            Ok(Some(head)) => {
                return AuditChainStatus {
                    state: ChainState::Broken(format!(
                        "audit chain table unreadable with sealed head seq {}: rollback suspected",
                        head.seq
                    )),
                    links_verified: 0,
                    total_links: 0,
                    head_seq: Some(head.seq),
                }
            }
            Ok(None) => {
                return AuditChainStatus {
                    state: ChainState::Intact,
                    links_verified: 0,
                    total_links: 0,
                    head_seq: None,
                }
            }
            Err(_) => {
                return AuditChainStatus {
                    state: ChainState::Broken("audit chain unreadable".into()),
                    links_verified: 0,
                    total_links: 0,
                    head_seq: None,
                }
            }
        },
    };
    let last: Option<String> = conn
        .query_row(
            "SELECT entry_hash FROM audit_chain ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    let Some(key) = mac_key else {
        // Keyless: structural continuity only.
        match verify_linkage_only(conn) {
            Ok(n) => {
                return AuditChainStatus {
                    state: ChainState::Unsealed,
                    links_verified: n,
                    total_links: total,
                    head_seq: None,
                }
            }
            Err(reason) => {
                return AuditChainStatus {
                    state: ChainState::Broken(reason),
                    links_verified: 0,
                    total_links: total,
                    head_seq: None,
                }
            }
        }
    };
    // Keyed full HMAC walk.
    let walked = match verify_audit_chain(conn, key) {
        Ok(n) => n,
        Err(e) => {
            return AuditChainStatus {
                state: ChainState::Broken(format!("link failure: {e}")),
                links_verified: 0,
                total_links: total,
                head_seq: store.load_audit_head().ok().flatten().map(|h| h.seq),
            }
        }
    };
    // For an empty chain there is nothing to anchor; absence of a head is
    // normal, not evidence.
    if total == 0 {
        return AuditChainStatus {
            state: ChainState::Intact,
            links_verified: 0,
            total_links: 0,
            head_seq: None,
        };
    }
    let last_hash = match last {
        Some(h) => h,
        None => {
            return AuditChainStatus {
                state: ChainState::Broken("empty chain with rows counted".into()),
                links_verified: walked,
                total_links: total,
                head_seq: None,
            }
        }
    };
    match store.load_audit_head() {
        Ok(None) => {
            // No head with a non-empty verified chain: fail closed. Re-sealing
            // here would bless whatever survived (possibly a truncated chain)
            // as the new baseline. The next keyed append re-seals loudly via
            // `advance_audit_head`; until then every consumer must treat the
            // chain as unverified.
            AuditChainStatus {
                state: ChainState::Broken(format!(
                    "audit head missing with {total}-link chain: refusing to reinitialize"
                )),
                links_verified: walked,
                total_links: total,
                head_seq: None,
            }
        }
        Ok(Some(head)) => {
            let expect = head_mac(key, head.seq, &head.hash);
            if !mac_eq(&head.mac, &expect) {
                return AuditChainStatus {
                    state: ChainState::Broken("head MAC invalid: head tampered".into()),
                    links_verified: walked,
                    total_links: total,
                    head_seq: Some(head.seq),
                };
            }
            if head.seq == total && head.hash == last_hash {
                AuditChainStatus {
                    state: ChainState::Intact,
                    links_verified: walked,
                    total_links: total,
                    head_seq: Some(head.seq),
                }
            } else if total > head.seq {
                // Longer valid chain than the head knows: only possible from
                // appends whose head-store step was skipped (keyed MACs can't
                // be forged) → heal forward, stay Intact.
                let healed = AuditHead {
                    seq: total,
                    hash: last_hash.clone(),
                    mac: head_mac(key, total, &last_hash),
                };
                if store.store_audit_head(&healed).is_err() {
                    return AuditChainStatus {
                        state: ChainState::Broken("head heal failed".into()),
                        links_verified: walked,
                        total_links: total,
                        head_seq: Some(head.seq),
                    };
                }
                AuditChainStatus {
                    state: ChainState::Intact,
                    links_verified: walked,
                    total_links: total,
                    head_seq: Some(total),
                }
            } else {
                AuditChainStatus {
                    state: ChainState::Broken(format!(
                        "truncation suspected: head seq {} hash {} vs chain {} {}",
                        head.seq, head.hash, total, last_hash
                    )),
                    links_verified: walked,
                    total_links: total,
                    head_seq: Some(head.seq),
                }
            }
        }
        Err(StoreError::NotFound) => AuditChainStatus {
            state: ChainState::Unsealed,
            links_verified: walked,
            total_links: total,
            head_seq: None,
        },
        Err(_) => AuditChainStatus {
            state: ChainState::Broken("audit head unreadable".into()),
            links_verified: walked,
            total_links: total,
            head_seq: None,
        },
    }
}

/// Structural walk without a key: prev-linkage continuity only.
fn verify_linkage_only(conn: &Connection) -> Result<usize, String> {
    let mut stmt = conn
        .prepare("SELECT prev_hash, entry_hash FROM audit_chain ORDER BY rowid")
        .map_err(|e| format!("read: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("read: {e}"))?;
    let mut expected: Option<String> = None;
    let mut n = 0usize;
    for row in rows {
        let (prev, stored) = row.map_err(|e| format!("decode: {e}"))?;
        if let Some(exp) = &expected {
            if exp != &prev {
                return Err(format!("linkage break before {stored}"));
            }
        } else if prev != GENESIS_HASH
            && !prev.starts_with("LEGACY-BOUNDARY:")
            && prev != "NO-KEY"
        {
            return Err("no valid genesis".into());
        }
        expected = Some(stored);
        n += 1;
    }
    Ok(n)
}

fn db_path_for(app: &tauri::AppHandle) -> Result<PathBuf, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("app dir: {e}")))?;
    let p = dir.join("mobi_pos.db");
    if !p.exists() {
        return Err(TrustError::op_failed("live database missing".to_string()));
    }
    Ok(p)
}

/// `#[tauri::command]` wrapper: authorize (OperationalWrites), validate,
/// resolve the chain key best-effort, append natively, advance the keystore
/// head. Audit must not fail primary flows: validation failures are typed;
/// transient DB failures propagate as typed errors for the caller to swallow
/// per existing policy. A failed head advance is logged, not fatal — the
/// next verify heals forward from valid links.
#[tauri::command]
pub fn audit_append(
    app: tauri::AppHandle,
    request: AuditAppendRequest,
) -> Result<AuditAppendReceipt, TrustError> {
    super::ipc_authorizer::authorize_and_execute(
        "audit_append",
        super::Capability::OperationalWrites,
        |_| {
            use tauri::Manager;
            let path = db_path_for(&app)?;
            let app_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| TrustError::op_failed(format!("app dir: {e}")))?;
            let mac_key = match resolve_manifest_mac_key(&app_dir) {
                ManifestMac::Key(k) => Some(k),
                ManifestMac::Unavailable(_) => None,
            };
            let mut conn = Connection::open_with_flags(
                &path,
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|e| TrustError::op_failed(format!("audit open: {e}")))?;
            conn.busy_timeout(std::time::Duration::from_secs(5))
                .map_err(|e| TrustError::op_failed(format!("audit busy_timeout: {e}")))?;
            let event_id = format!(
                "AUD-{}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0),
                &uuid::Uuid::new_v4().to_string()[..8]
            );
            let timestamp = chrono_iso8601_utc();
            let receipt =
                append_audit_event(&mut conn, mac_key.as_deref(), &request, &event_id, &timestamp)?;
            if let Some(key) = mac_key.as_deref() {
                let (store, _) = super::ipc_authorizer::select_store(&app_dir);
                if advance_audit_head(&conn, &*store, key).is_err() {
                    eprintln!("[trust_core] audit head advance failed (heals on verify)");
                }
            }
            Ok(receipt)
        },
    )
}

/// Flat verifier status for manifests and diagnostics. `broken` covers any
/// integrity failure (link MAC, linkage, head mismatch, truncation);
/// `unsealed` means no key was available (hashes still checked where
/// possible). Detail lives in logs/report strings, not in this value.
pub fn chain_state_value(state: &ChainState) -> &'static str {
    match state {
        ChainState::Intact => "intact",
        ChainState::Broken(_) => "broken",
        ChainState::Unsealed => "unsealed",
    }
}

/// Export gate for the audit-chain status (Phase 4.5, WP1e). A `Broken`
/// chain is tamper evidence: the export fails with typed
/// `ExportManifestFailed` (owner rule: manifest failure = fail export — no
/// unverified output). Exception, owner decision 2: terminals already in
/// `TAMPER_SUSPECTED` / `CLOCK_RESET_REQUIRED` may still run emergency
/// export; the `tamper`/`clock` integrity posture is MAC-covered evidence and
/// the broken `chain_status` string rides along in the same sealed manifest
/// (read-only, no state change, no unlock). `Unsealed` (no key available)
/// proceeds with the status recorded — the key-absent analog of the
/// UNAUTHENTICATED manifest-MAC decision (hashes still checked where
/// possible, recovery-only, never shown as verified).
pub fn chain_status_for_export(
    status: &AuditChainStatus,
    license_state: &str,
) -> Result<String, TrustError> {
    match &status.state {
        ChainState::Intact | ChainState::Unsealed => {
            Ok(chain_state_value(&status.state).to_string())
        }
        ChainState::Broken(reason) => {
            if license_state == "TAMPER_SUSPECTED" || license_state == "CLOCK_RESET_REQUIRED" {
                eprintln!(
                    "[trust_core] export proceeds with broken audit chain under {license_state} \
                     (owner decision 2; evidence preserved, no unlock)"
                );
                Ok("broken".to_string())
            } else {
                Err(TrustError::ExportManifestFailed {
                    detail: format!("audit chain broken, export refused: {reason}"),
                })
            }
        }
    }
}

/// TS-side swallowed-failure counter, mirrored natively (Phase 4.5 WP2a).
/// The WebView funnel swallows audit failures by policy (audit never blocks
/// primary flows) and counts them in TS; it also best-effort reports each
/// swallow here so the total is visible inside the trust boundary
/// (`get_gate_state.audit_swallowed`) even if the WebView is compromised or
/// reloaded (TS counter is per-session). Monotonic process total; no reset
/// path exists by design (reset would hide an audit outage).
static SWALLOWED_AUDIT_FAILURES: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// Current native swallowed-audit total for `get_gate_state`.
pub fn swallowed_audit_total() -> u64 {
    SWALLOWED_AUDIT_FAILURES.load(std::sync::atomic::Ordering::Relaxed)
}

/// Core increment (pure trust-boundary logic; the command wrapper only adds
/// authorization). Returns the new running total.
pub fn note_swallowed_audit_failure(context: &str) -> u64 {
    let ctx: String = context.chars().take(128).collect();
    let total = SWALLOWED_AUDIT_FAILURES.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    eprintln!("[trust_core] swallowed audit failure #{total} ({ctx})");
    total
}

/// `#[tauri::command]`: report one swallowed audit failure from the WebView
/// funnel. OperationalWrites (same plane as `audit_append`): callable whenever
/// audit writes are. `context` is a short machine tag (capped, never free
/// text — it lands in the log). Returns the running native total. Never
/// fails closed: reporting a swallow must itself be infallible from the
/// caller's view (validation errors are typed, storage cannot fail — the
/// counter is in-memory).
#[tauri::command]
pub fn audit_note_swallowed(
    app: tauri::AppHandle,
    context: String,
) -> Result<u64, TrustError> {
    super::ipc_authorizer::authorize_and_execute(
        "audit_note_swallowed",
        super::Capability::OperationalWrites,
        |_| {
            let _ = &app;
            Ok(note_swallowed_audit_failure(&context))
        },
    )
}

/// `#[tauri::command]`: full chain verification (ReadOperationalData — it is
/// a read; locked-state diagnostics keep their dedicated paths). Returns the
/// rich status; callers map it to UI.
#[tauri::command]
pub fn audit_verify(app: tauri::AppHandle) -> Result<AuditChainStatus, TrustError> {    super::ipc_authorizer::authorize_and_execute(
        "audit_verify",
        super::Capability::ReadOperationalData,
        |_| {
            use tauri::Manager;
            let path = db_path_for(&app)?;
            let app_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| TrustError::op_failed(format!("app dir: {e}")))?;
            let (store, _) = super::ipc_authorizer::select_store(&app_dir);
            let mac_key = match resolve_manifest_mac_key(&app_dir) {
                ManifestMac::Key(k) => Some(k),
                ManifestMac::Unavailable(_) => None,
            };
            let conn = Connection::open_with_flags(
                &path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|e| TrustError::op_failed(format!("audit verify open: {e}")))?;
            conn.execute_batch("PRAGMA query_only = ON;").ok();
            Ok(verify_audit_chain_full(&conn, &*store, mac_key.as_deref()))
        },
    )
}

/// Boot-time audit check: head-only comparison (count + terminal hash vs the
/// keystore head — O(1), no full walk), logging only. Never fails boot; full
/// verification runs at export and on explicit `audit_verify`. The outcome is
/// latched for `get_gate_state` so a failed background check is surfaced to
/// the UI on the next probe (the latch is write-once-per-boot from the
/// background thread; tests reset it via `record_boot_audit_status`).
static BOOT_AUDIT_STATUS: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
    std::sync::OnceLock::new();

/// Last boot audit-check outcome for `get_gate_state` (`None` = check has not
/// reported yet this boot). Values: `intact links=N`, `BROKEN ...`,
/// `unsealed ...`, `no-head ...`, `head-unreadable`, `unavailable: ...`.
pub fn boot_audit_status() -> Option<String> {
    BOOT_AUDIT_STATUS
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .ok()
        .and_then(|g| g.clone())
}

fn record_boot_audit_status(outcome: String) {
    let slot = BOOT_AUDIT_STATUS.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(outcome);
    }
}

pub fn boot_audit_check(app_data_dir: &std::path::Path) {
    let db_path = app_data_dir.join("mobi_pos.db");
    if !db_path.exists() {
        return;
    }
    let (store, _) = super::ipc_authorizer::select_store(app_data_dir);
    let mac_key = match resolve_manifest_mac_key(app_data_dir) {
        ManifestMac::Key(k) => Some(k),
        ManifestMac::Unavailable(_) => None,
    };
    let outcome = (|| -> Result<String, String> {
        let conn = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("open: {e}"))?;
        conn.execute_batch("PRAGMA query_only = ON;").ok();
        let total: u64 = conn
            .query_row("SELECT COUNT(*) FROM audit_chain", [], |r| r.get(0))
            .unwrap_or(0);
        let last: Option<String> = conn
            .query_row(
                "SELECT entry_hash FROM audit_chain ORDER BY rowid DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        let Some(key) = mac_key.as_deref() else {
            return Ok(format!("unsealed links={total}"));
        };
        match store.load_audit_head() {
            Ok(None) => Ok(format!("no-head links={total}")),
            Ok(Some(head)) => {
                let expect = hex(&hmac_sha256_raw(
                    &domain_subkey(key, AUDIT_SUBKEY_LABEL),
                    format!("{}:{}", head.seq, head.hash).as_bytes(),
                ));
                if !mac_eq(&head.mac, &expect) {
                    return Ok("BROKEN head-mac".into());
                }
                let last_hash = last.unwrap_or_default();
                if head.seq == total && head.hash == last_hash {
                    Ok(format!("intact links={total}"))
                } else {
                    Ok(format!(
                        "BROKEN head(seq={},hash={}) vs chain({},{})",
                        head.seq,
                        &head.hash[..head.hash.len().min(12)],
                        total,
                        &last_hash[..last_hash.len().min(12)]
                    ))
                }
            }
            Err(_) => Ok("head-unreadable".into()),
        }
    })();
    match &outcome {
        Ok(s) => eprintln!("[trust_core] boot audit check: {s}"),
        Err(e) => eprintln!("[trust_core] boot audit check unavailable: {e}"),
    }
    record_boot_audit_status(match outcome {
        Ok(s) => s,
        Err(e) => format!("unavailable: {e}"),
    });
}

/// Minimal UTC ISO-8601 (no date crate on this path).
fn chrono_iso8601_utc() -> String {
    // Reuse the exporter's formatter shape (YYYY-MM-DDTHH:MM:SSZ).
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
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
    use crate::trust_core::ipc_authorizer::serial_test_lock;
    use rusqlite::params;

    fn fixture_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE security_audit_logs (
                id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, user TEXT NOT NULL,
                action TEXT NOT NULL, details TEXT NOT NULL, requires_pin INTEGER DEFAULT 0,
                device_id TEXT, version INTEGER DEFAULT 1, ip_address TEXT);",
        )
        .unwrap();
        conn
    }

    fn req(action: &str) -> AuditAppendRequest {
        AuditAppendRequest {
            action: action.into(),
            details: "test details".into(),
            user: Some("tester".into()),
            requires_pin: Some(false),
            device_id: Some("dev1".into()),
            ip_address: None,
        }
    }

    #[test]
    fn chain_links_three_appends_and_verifies() {
        let _g = serial_test_lock();
        let mut conn = fixture_conn();
        let key = b"audit-test-key-32bytes!!!!!!!!".to_vec();
        let mut prev = "MOBI-AUDIT-GENESIS-V1".to_string();
        for i in 0..3 {
            let r = append_audit_event(
                &mut conn,
                Some(&key),
                &req(&format!("act-{i}")),
                &format!("EV-{i}"),
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
            let hash = r.entry_hash.expect("keyed append must seal");
            // Each link's prev is the previous hash (walk the table).
            let stored_prev: String = conn
                .query_row(
                    "SELECT prev_hash FROM audit_chain WHERE event_id = ?1",
                    params![format!("EV-{i}")],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(stored_prev, prev);
            prev = hash;
        }
        assert_eq!(verify_audit_chain(&conn, &key).unwrap(), 3);
    }

    #[test]
    fn tampered_row_breaks_verification() {
        let _g = serial_test_lock();
        let mut conn = fixture_conn();
        let key = b"audit-test-key-32bytes!!!!!!!!".to_vec();
        for i in 0..2 {
            append_audit_event(
                &mut conn,
                Some(&key),
                &req(&format!("act-{i}")),
                &format!("EV-{i}"),
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        }
        conn.execute(
            "UPDATE security_audit_logs SET action = 'forged' WHERE id = 'EV-1'",
            [],
        )
        .unwrap();
        assert!(verify_audit_chain(&conn, &key).is_err());
    }

    #[test]
    fn legacy_rows_form_genesis_boundary() {
        let _g = serial_test_lock();
        let mut conn = fixture_conn();
        // Pre-chain legacy row (no chain entry).
        conn.execute(
            "INSERT INTO security_audit_logs (id, timestamp, user, action, details)
             VALUES ('OLD-1', '2025-01-01T00:00:00Z', 'u', 'old', '{}')",
            [],
        )
        .unwrap();
        let key = b"audit-test-key-32bytes!!!!!!!!".to_vec();
        append_audit_event(&mut conn, Some(&key), &req("new"), "EV-9", "2026-01-01T00:00:00Z")
            .unwrap();
        assert_eq!(verify_audit_chain(&conn, &key).unwrap(), 1);
    }

    #[test]
    fn no_key_still_appends_unsealed() {
        let _g = serial_test_lock();
        let mut conn = fixture_conn();
        let r = append_audit_event(&mut conn, None, &req("plain"), "EV-0", "2026-01-01T00:00:00Z")
            .unwrap();
        assert!(r.entry_hash.is_none(), "absence recorded, never faked");
        // Unkeyed links are skipped by verification, not failed.
        let key = b"audit-test-key-32bytes!!!!!!!!".to_vec();
        assert_eq!(verify_audit_chain(&conn, &key).unwrap(), 0);
    }

    #[test]
    fn validation_rejects_empty_and_oversized() {
        let _g = serial_test_lock();
        let mut conn = fixture_conn();
        let key = b"k".to_vec();
        let mut bad = req("");
        assert!(append_audit_event(&mut conn, Some(&key), &bad, "E1", "t").is_err());
        bad = req("ok");
        bad.details = "x".repeat(MAX_DETAILS_LEN + 1);
        assert!(append_audit_event(&mut conn, Some(&key), &bad, "E2", "t").is_err());
        bad = req("ok");
        bad.action = "y".repeat(MAX_ACTION_LEN + 1);
        assert!(append_audit_event(&mut conn, Some(&key), &bad, "E3", "t").is_err());
    }

    #[test]
    fn schema_tolerance_minimal_table() {
        // Installs whose table lacks version/ip_address still work.
        let _g = serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE security_audit_logs (
                id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, user TEXT NOT NULL,
                action TEXT NOT NULL, details TEXT NOT NULL);",
        )
        .unwrap();
        let key = b"k".to_vec();
        let r = append_audit_event(&mut conn, Some(&key), &req("min"), "EV-M", "t").unwrap();
        assert!(r.entry_hash.is_some());
        assert_eq!(verify_audit_chain(&conn, &key).unwrap(), 1);
    }

    #[test]
    fn head_advance_and_truncation_detection() {
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        let _g = serial_test_lock();
        let mut conn = fixture_conn();
        let store = MemKeyStore::new();
        let key = b"audit-test-key-32bytes!!!!!!!!".to_vec();
        for i in 0..3 {
            append_audit_event(
                &mut conn,
                Some(&key),
                &req(&format!("act-{i}")),
                &format!("EV-{i}"),
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
            advance_audit_head(&conn, &store, &key).unwrap();
        }
        // Full status: intact with head seq 3.
        let st = verify_audit_chain_full(&conn, &store, Some(&key));
        assert!(matches!(st.state, ChainState::Intact));
        assert_eq!(st.total_links, 3);
        assert_eq!(st.head_seq, Some(3));
        // Attacker deletes the newest row + link: shorter valid chain.
        conn.execute("DELETE FROM security_audit_logs WHERE id = 'EV-2'", [])
            .unwrap();
        conn.execute("DELETE FROM audit_chain WHERE event_id = 'EV-2'", [])
            .unwrap();
        let st = verify_audit_chain_full(&conn, &store, Some(&key));
        assert!(
            matches!(st.state, ChainState::Broken(_)),
            "truncation must be detected, got {:?}",
            st.state
        );
    }

    #[test]
    fn head_tamper_detected() {
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        use crate::trust_core::secure_storage::AuditHead;
        let _g = serial_test_lock();
        let mut conn = fixture_conn();
        let store = MemKeyStore::new();
        let key = b"audit-test-key-32bytes!!!!!!!!".to_vec();
        append_audit_event(&mut conn, Some(&key), &req("a"), "EV-0", "t").unwrap();
        advance_audit_head(&conn, &store, &key).unwrap();
        // Forge the head (attacker with keystore write but no MAC key).
        store
            .store_audit_head(&AuditHead {
                seq: 99,
                hash: "forged".into(),
                mac: "00".into(),
            })
            .unwrap();
        let st = verify_audit_chain_full(&conn, &store, Some(&key));
        assert!(
            matches!(st.state, ChainState::Broken(_)),
            "forged head must fail, got {:?}",
            st.state
        );
    }

    #[test]
    fn stale_head_heals_forward_after_crash() {
        // Crash between DB commit and head store, with a prior head sealed:
        // the next verify heals forward from valid links instead of crying
        // truncation (only the never-sealed case fails closed — see below).
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        let _g = serial_test_lock();
        let mut conn = fixture_conn();
        let store = MemKeyStore::new();
        let key = b"audit-test-key-32bytes!!!!!!!!".to_vec();
        append_audit_event(&mut conn, Some(&key), &req("act-0"), "EV-0", "2026-01-01T00:00:00Z")
            .unwrap();
        advance_audit_head(&conn, &store, &key).unwrap();
        // Second append commits, head store skipped (simulated crash).
        append_audit_event(&mut conn, Some(&key), &req("act-1"), "EV-1", "2026-01-01T00:00:00Z")
            .unwrap();
        let st = verify_audit_chain_full(&conn, &store, Some(&key));
        assert!(matches!(st.state, ChainState::Intact), "stale head must heal, got {:?}", st.state);
        assert_eq!(st.head_seq, Some(2));
        // And a subsequent verify agrees without further writes.
        let st2 = verify_audit_chain_full(&conn, &store, Some(&key));
        assert!(matches!(st2.state, ChainState::Intact));
    }

    #[test]
    fn missing_head_after_chain_fails_closed_no_reinitialize() {
        // WP1a: a non-empty chain with no sealed head must NOT be silently
        // re-sealed (that would bless a truncated chain as the baseline).
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        let _g = serial_test_lock();
        let mut conn = fixture_conn();
        let store = MemKeyStore::new();
        let key = b"audit-test-key-32bytes!!!!!!!!".to_vec();
        for i in 0..2 {
            append_audit_event(
                &mut conn,
                Some(&key),
                &req(&format!("act-{i}")),
                &format!("EV-{i}"),
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        }
        // No head advance at all: verify fails closed instead of bootstrapping.
        let st = verify_audit_chain_full(&conn, &store, Some(&key));
        assert!(
            matches!(st.state, ChainState::Broken(_)),
            "missing head with chain must fail closed, got {:?}",
            st.state
        );
        // The store was NOT reinitialized behind our back.
        assert_eq!(store.load_audit_head().unwrap(), None);
        // Recovery: the next keyed append re-seals (loudly), then verify passes.
        append_audit_event(&mut conn, Some(&key), &req("act-2"), "EV-2", "2026-01-01T00:00:00Z")
            .unwrap();
        advance_audit_head(&conn, &store, &key).unwrap();
        let st2 = verify_audit_chain_full(&conn, &store, Some(&key));
        assert!(matches!(st2.state, ChainState::Intact));
        assert_eq!(st2.head_seq, Some(3));
    }

    #[test]
    fn keyless_status_is_unsealed_not_broken() {
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        let _g = serial_test_lock();
        let mut conn = fixture_conn();
        let store = MemKeyStore::new();
        append_audit_event(&mut conn, None, &req("plain"), "EV-0", "t").unwrap();
        let st = verify_audit_chain_full(&conn, &store, None);
        assert!(matches!(st.state, ChainState::Unsealed));
    }

    // --- WP1 acceptance: tamper variants (modified / deleted / reordered /
    // replaced tail), head rollback, unreadable chain table, concurrency.

    fn seal_three(
        conn: &mut Connection,
        store: &dyn KeyStore,
        key: &[u8],
    ) {
        for i in 0..3 {
            append_audit_event(
                conn,
                Some(key),
                &req(&format!("act-{i}")),
                &format!("EV-{i}"),
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
            advance_audit_head(conn, store, key).unwrap();
        }
    }

    #[test]
    fn deleted_middle_row_breaks_chain() {
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        let _g = serial_test_lock();
        let mut conn = fixture_conn();
        let store = MemKeyStore::new();
        let key = b"audit-test-key-32bytes!!!!!!!!".to_vec();
        seal_three(&mut conn, &store, &key);
        // Delete the middle audit row, leave its link: recompute fails.
        conn.execute("DELETE FROM security_audit_logs WHERE id = 'EV-1'", [])
            .unwrap();
        let st = verify_audit_chain_full(&conn, &store, Some(&key));
        assert!(matches!(st.state, ChainState::Broken(_)), "deleted row, got {:?}", st.state);
    }

    #[test]
    fn deleted_link_breaks_chain() {
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        let _g = serial_test_lock();
        let mut conn = fixture_conn();
        let store = MemKeyStore::new();
        let key = b"audit-test-key-32bytes!!!!!!!!".to_vec();
        seal_three(&mut conn, &store, &key);
        // Delete the middle link only: the next link's prev dangles.
        conn.execute("DELETE FROM audit_chain WHERE event_id = 'EV-1'", [])
            .unwrap();
        let st = verify_audit_chain_full(&conn, &store, Some(&key));
        assert!(matches!(st.state, ChainState::Broken(_)), "deleted link, got {:?}", st.state);
    }

    #[test]
    fn reordered_links_break_chain() {
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        let _g = serial_test_lock();
        let mut conn = fixture_conn();
        let store = MemKeyStore::new();
        let key = b"audit-test-key-32bytes!!!!!!!!".to_vec();
        seal_three(&mut conn, &store, &key);
        // Swap two links' entry hashes: prev continuity breaks.
        let h1: String = conn
            .query_row("SELECT entry_hash FROM audit_chain WHERE event_id = 'EV-1'", [], |r| r.get(0))
            .unwrap();
        let h2: String = conn
            .query_row("SELECT entry_hash FROM audit_chain WHERE event_id = 'EV-2'", [], |r| r.get(0))
            .unwrap();
        conn.execute("UPDATE audit_chain SET entry_hash = ?1 WHERE event_id = 'EV-1'", params![h2])
            .unwrap();
        conn.execute("UPDATE audit_chain SET entry_hash = ?1 WHERE event_id = 'EV-2'", params![h1])
            .unwrap();
        let st = verify_audit_chain_full(&conn, &store, Some(&key));
        assert!(matches!(st.state, ChainState::Broken(_)), "reordered, got {:?}", st.state);
    }

    #[test]
    fn replaced_tail_breaks_against_head() {
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        let _g = serial_test_lock();
        let mut conn = fixture_conn();
        let store = MemKeyStore::new();
        let key = b"audit-test-key-32bytes!!!!!!!!".to_vec();
        seal_three(&mut conn, &store, &key);
        // Attacker removes the tail row+link and appends an unkeyed row, so
        // the keyed walk still passes over a shorter valid prefix — the
        // keystore head (seq 3, old terminal) must catch the substitution.
        conn.execute("DELETE FROM security_audit_logs WHERE id = 'EV-2'", [])
            .unwrap();
        conn.execute("DELETE FROM audit_chain WHERE event_id = 'EV-2'", [])
            .unwrap();
        append_audit_event(&mut conn, None, &req("cover"), "EV-X", "2026-01-01T00:00:00Z").unwrap();
        let st = verify_audit_chain_full(&conn, &store, Some(&key));
        assert!(matches!(st.state, ChainState::Broken(_)), "replaced tail, got {:?}", st.state);
    }

    #[test]
    fn head_rollback_with_valid_mac_is_broken() {
        // DB rolled back under a live keystore: attacker replays a head with
        // a VALID mac for a seq the chain no longer reaches (the mac is
        // computable here only because the test holds the key — the point is
        // the seq comparison, not mac forgery).
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        use crate::trust_core::secure_storage::AuditHead;
        let _g = serial_test_lock();
        let mut conn = fixture_conn();
        let store = MemKeyStore::new();
        let key = b"audit-test-key-32bytes!!!!!!!!".to_vec();
        seal_three(&mut conn, &store, &key);
        let forged = AuditHead {
            seq: 99,
            hash: "future-hash".into(),
            mac: String::new(),
        };
        let forged = AuditHead {
            mac: head_mac(&key, forged.seq, &forged.hash),
            ..forged
        };
        // Bypass the monotonic store (it refuses this) to simulate a head
        // restored from a newer machine image onto an older DB.
        store
            .store_audit_head_raw_for_tests(&forged)
            .expect("test seam");
        let st = verify_audit_chain_full(&conn, &store, Some(&key));
        assert!(
            matches!(st.state, ChainState::Broken(_)),
            "rolled-back DB under newer head, got {:?}",
            st.state
        );
    }

    #[test]
    fn store_refuses_backwards_head_write() {
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        use crate::trust_core::secure_storage::AuditHead;
        let _g = serial_test_lock();
        let store = MemKeyStore::new();
        store
            .store_audit_head(&AuditHead { seq: 5, hash: "h".into(), mac: "m".into() })
            .unwrap();
        let refused = store.store_audit_head(&AuditHead { seq: 4, hash: "h".into(), mac: "m".into() });
        assert!(refused.is_err(), "backwards head write must be refused");
        assert_eq!(store.load_audit_head().unwrap().unwrap().seq, 5);
    }

    #[test]
    fn unreadable_chain_table_with_head_is_rollback() {
        // Fresh connection with no audit_chain table but a sealed head: the
        // DB was swapped under the keystore (fresh-install shape has no head).
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        let _g = serial_test_lock();
        let mut conn = fixture_conn();
        let bare: Connection = Connection::open_in_memory().unwrap();
        let store = MemKeyStore::new();
        let key = b"audit-test-key-32bytes!!!!!!!!".to_vec();
        seal_three(&mut conn, &store, &key);
        let head = store.load_audit_head().unwrap().unwrap();
        let store2 = MemKeyStore::new();
        store2.store_audit_head(&head).unwrap();
        let st = verify_audit_chain_full(&bare, &store2, Some(&key));
        assert!(
            matches!(st.state, ChainState::Broken(_)),
            "table missing under sealed head, got {:?}",
            st.state
        );
        // Same bare DB with no head at all: genuine fresh shape → Intact empty.
        let fresh_store = MemKeyStore::new();
        let st2 = verify_audit_chain_full(&bare, &fresh_store, Some(&key));
        assert!(matches!(st2.state, ChainState::Intact));
        assert_eq!(st2.total_links, 0);
    }

    #[test]
    fn concurrent_appends_lose_no_writes() {
        use crate::trust_core::secure_storage::test_support::MemKeyStore;
        use std::sync::Arc;
        let _g = serial_test_lock();
        let dir = std::env::temp_dir().join(format!(
            "mobi-audit-conc-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("conc.db");
        {
            let init = Connection::open(&db_path).unwrap();
            // WAL + pre-created chain table: production's steady state (the
            // table is created by the first append; racing DDL on a fresh
            // file is covered by the command wrapper's busy_timeout, not by
            // this test — here we measure lost writes under concurrency).
            init.execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE security_audit_logs (
                    id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, user TEXT NOT NULL,
                    action TEXT NOT NULL, details TEXT NOT NULL, requires_pin INTEGER DEFAULT 0,
                    device_id TEXT, version INTEGER DEFAULT 1, ip_address TEXT);
                 CREATE TABLE audit_chain (
                    event_id TEXT PRIMARY KEY,
                    prev_hash TEXT NOT NULL,
                    entry_hash TEXT NOT NULL
                 );",
            )
            .unwrap();
        }
        let key = Arc::new(b"audit-test-key-32bytes!!!!!!!!".to_vec());
        let path = Arc::new(db_path);
        const THREADS: usize = 4;
        const PER_THREAD: usize = 5;
        let mut handles = Vec::new();
        for t in 0..THREADS {
            let (k, p) = (Arc::clone(&key), Arc::clone(&path));
            handles.push(std::thread::spawn(move || {
                let mut conn = Connection::open(&*p).unwrap();
                conn.busy_timeout(std::time::Duration::from_secs(10)).unwrap();
                for i in 0..PER_THREAD {
                    let id = format!("T{t}-{i}");
                    // Bounded retry on transient write-write lock contention:
                    // production treats a persistent lock failure as a
                    // counted+swallowed audit failure (never blocks the
                    // primary flow); here we prove that under retry every
                    // append lands exactly once (no lost writes, no dupes).
                    let mut last_err = String::new();
                    for _ in 0..500 {
                        match append_audit_event(
                            &mut conn,
                            Some(&k),
                            &req("conc"),
                            &id,
                            "2026-01-01T00:00:00Z",
                        ) {
                            Ok(_) => {
                                last_err.clear();
                                break;
                            }
                            Err(e) => {
                                last_err = e.to_string();
                                std::thread::sleep(std::time::Duration::from_millis(10));
                            }
                        }
                    }
                    assert!(last_err.is_empty(), "concurrent append failed: {last_err}");
                }
            }));
        }
        for h in handles {
            h.join().expect("worker");
        }
        let conn = Connection::open(&*path).unwrap();
        let store = MemKeyStore::new();
        advance_audit_head(&conn, &store, &key).unwrap();
        let st = verify_audit_chain_full(&conn, &store, Some(&key));
        assert!(matches!(st.state, ChainState::Intact), "concurrent chains, got {:?}", st.state);
        assert_eq!(st.total_links, (THREADS * PER_THREAD) as u64);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_gate_broken_fails_except_quarantine() {
        let _g = serial_test_lock();
        let intact = AuditChainStatus {
            state: ChainState::Intact,
            links_verified: 3,
            total_links: 3,
            head_seq: Some(3),
        };
        assert_eq!(chain_status_for_export(&intact, "OPERATIONAL").unwrap(), "intact");
        let unsealed = AuditChainStatus {
            state: ChainState::Unsealed,
            links_verified: 2,
            total_links: 2,
            head_seq: None,
        };
        assert_eq!(chain_status_for_export(&unsealed, "OPERATIONAL").unwrap(), "unsealed");
        let broken = AuditChainStatus {
            state: ChainState::Broken("truncation suspected".into()),
            links_verified: 2,
            total_links: 2,
            head_seq: Some(3),
        };
        let err = chain_status_for_export(&broken, "OPERATIONAL").unwrap_err();
        assert!(
            matches!(err, TrustError::ExportManifestFailed { .. }),
            "operational broken chain must fail export, got {err:?}"
        );
        let err_revoked = chain_status_for_export(&broken, "REVOKED").unwrap_err();
        assert!(matches!(err_revoked, TrustError::ExportManifestFailed { .. }));
        // Owner decision 2: quarantine states keep read-only export with evidence.
        assert_eq!(chain_status_for_export(&broken, "TAMPER_SUSPECTED").unwrap(), "broken");
        assert_eq!(chain_status_for_export(&broken, "CLOCK_RESET_REQUIRED").unwrap(), "broken");
    }

    #[test]
    fn boot_latch_surfaces_through_gate_state() {        use super::super::ipc_authorizer::{get_gate_state, global_kernel};
        let _g = serial_test_lock();
        global_kernel().reset_for_tests();
        record_boot_audit_status("BROKEN head(seq=3) vs chain(2)".into());
        let gs = get_gate_state();
        assert_eq!(
            gs.audit_boot,
            Some("BROKEN head(seq=3) vs chain(2)".to_string())
        );
        record_boot_audit_status("intact links=3".into());
    }

    #[test]
    fn swallowed_counter_is_monotonic_and_capped() {
        use super::super::ipc_authorizer::global_kernel;
        let _g = serial_test_lock();
        global_kernel().reset_for_tests();
        let before = swallowed_audit_total();
        let t1 = note_swallowed_audit_failure("op-denied");
        let t2 = note_swallowed_audit_failure(&"x".repeat(500));
        assert_eq!(t1, before + 1);
        assert_eq!(t2, before + 2);
        assert_eq!(swallowed_audit_total(), before + 2);
        // No reset path: the total only moves forward.
    }
}
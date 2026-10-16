//! Native atomic refund barrier (MOBI-DEFECT-F: concurrent two-tab refund race).
//!
//! Every effect of one refund commits in a SINGLE `BEGIN IMMEDIATE`
//! transaction on a short-lived per-invoke `rusqlite` connection (same
//! ownership model as `commands::open_live_db`: no global mutex, no lock
//! held across `.await`, no pool multiplexing). The second tab blocks on the
//! journal lock, then fails deterministically on the `refund_dedup` gate or
//! the in-transaction quota check — `ROLLBACK`, zero side effects, typed
//! `ALREADY_REFUNDED`.
//!
//! Design notes (do not "simplify" without re-proving the race):
//! - `refund_dedup` is inserted FIRST so an exact replay reports
//!   `ALREADY_REFUNDED` rather than `REFUND_EXCEEDS`. It rolls back with the
//!   rest if any later step fails, so a failed attempt never poisons retries.
//! - The ticket status flip is a version CAS used as an INVARIANT assertion,
//!   not as the concurrency control: the version is read under the same
//!   write lock, so a mismatch means a writer bypassed the lock.
//! - Stock restitution uses RELATIVE updates (`quantity_remaining +
//!   ?`) which are exact under the write lock; no version CAS is needed on
//!   batches. `shadow-*` batch ids are never restored (shortage markers,
//!   not real stock — same rule as the TS restitution lane).
//! - Money math (funding split, loyalty, clamp) stays in TypeScript. Native
//!   enforces the BOUNDS (quota, caps, CAS) and applies the rows. Amounts
//!   arrive as integer DZD in REAL columns (existing convention).
//! - Audit is appended with [`crate::trust_core::audit_append::append_in_tx`]
//!   in the SAME transaction: the link commits iff the money does, so the
//!   chain can never branch under a race. Event id `AUD-<refund_id>` makes
//!   replays converge instead of forking.
//! - Sync-replicated rows (`sync_status = 'synced'`) are exempt from the
//!   `trg_refund_requires_dedup` trigger; this command always writes
//!   `pending` with the dedup row present, so it passes.
//! - All business conflicts are `TrustError::OperationFailed` with a
//!   machine-readable `CODE[:detail]` prefix (gate NONE — never a lock
//!   screen). TypeScript parses the prefix; `BUSY` is the only retryable
//!   code (nothing is applied before `BEGIN IMMEDIATE` succeeds, and any
//!   post-commit retry converges on the dedup gate).
//!
//! OFFLINE CONTAINMENT (MOBI-OFFLINE-REFUND-CONTAINMENT): single-node races
//! are closed above; disconnected multi-terminal races are contained here,
//! without consensus or network presence:
//! - Module A (device-origin affinity): offline, the ticket's durable
//!   `device_id` + `shift_id` must equal the asserted local context, else
//!   `OFFLINE_FOREIGN_TICKET` (mirrors `offlineRefundVerdict`; the local id
//!   is asserted over IPC like every other req field — enforcement, not
//!   attestation, lives here).
//! - Module B (shift offline cash cap): offline cash refunds accumulate per
//!   shift over `sync_status='pending'` rows; past
//!   `policy.offline_cash_refund_limit` (default 10000 DZD) the refund is
//!   refused with `OFFLINE_CASH_CAP_EXCEEDED` — the fallback is a
//!   non-cashable store voucher, never an override that pays cash.
//! - Module C (supervisor PIN): offline cash above
//!   `policy.offline_pin_threshold` (default 5000 DZD) requires a supervisor
//!   block. The SECRET is verified pre-submit through `pin_verify`
//!   (Argon2id + lockout in `trust_core/pin.rs` — attempt accounting must
//!   never sit inside the money txn, or a rollback would un-record the
//!   attempt); native requires the resulting authorization block and records
//!   it in the in-txn audit row, else `SUPERVISOR_PIN_REQUIRED`.
//!
//! ERROR DOMAIN (wire codes; TS maps them 1:1 in `refundNative.ts`):
//! `ALREADY_REFUNDED:<id>` (covers AlreadyRefunded + VersionConflict — a CAS
//! miss means the row moved under this lock, i.e. a duplicate),
//! `ZERO_REFUNDABLE`, `REFUND_EXCEEDS:<pid>:requested=<q>:remaining=<r>`
//! (QuotaExceeded), `CASH_CAP_EXCEEDED` (per-ticket), `ORIGINAL_VOIDED`,
//! `TICKET_NOT_FOUND`, `VOUCHER_CHANGED:<code>`, `VOUCHER_MISSING:<code>`,
//! `NO_OPEN_SHIFT` (covers DrawerShiftClosed), `OFFLINE_FOREIGN_TICKET:<td>:<ld>`,
//! `OFFLINE_CASH_CAP_EXCEEDED:<current>:<cap>:<attempted>`,
//! `SUPERVISOR_PIN_REQUIRED` (covers SupervisorPinRequired +
//! InvalidSupervisorPin — an empty/malformed block fails the same gate),
//! `BUSY` (covers SqliteBusy), `INVALID:<msg>`, `SCHEMA_UNHEALED:<msg>`,
//! `INTERNAL:<msg>` (covers Internal).
//!
//! MONEY DISCIPLINE: every currency field is `i64` integer DZD — no floats
//! cross this boundary in either direction (TS sends `Math.round`ed ints).

use crate::trust_core::{
    audit_append::{append_in_tx, AuditAppendRequest},
    capability_policy::Capability,
    clocks::production_monotonic,
    device_identity::{
        check_supervisor_freshness, refund_envelope, DeviceIdentity,
    },
    export_snapshot::{resolve_manifest_mac_key, ManifestMac},
    ipc_authorizer::{authorize_and_execute, global_kernel, TrustError},
    time_anchor,
};
use rusqlite::{params, Connection, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Wire types (camelCase to match the TS caller)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundItemIn {
    pub id: String,
    pub product_id: String,
    pub quantity: i64,
    pub applied_price: i64,
    pub unit_price_charged: i64,
    pub unit_cost_at_sale: i64,
    pub discount_amount: i64,
    pub line_profit: i64,
    pub imei_number: Option<String>,
    pub item_key: String,
    pub item_payload: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerDeltaIn {
    pub id: String,
    pub key: String,
    pub product_id: String,
    pub delta: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRestoreIn {
    pub batch_id: Option<String>,
    pub product_id: String,
    /// Restock units (NOT currency — may stay fractional; money never does).
    pub quantity: f64,
    pub unit_cost: i64,
    pub fallback_batch_id: String,
    pub fallback_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtReliefIn {
    pub entry_id: String,
    pub customer_id: String,
    pub customer_name: String,
    pub amount: i64,
    pub receipt_number: String,
    pub payment_method: String,
    pub notes: String,
    pub recorded_by: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoucherRestoreIn {
    pub code: String,
    pub amount: i64,
}

/// Supervisor authorization block (Module C). The PIN SECRET is verified
/// pre-submit via `pin_verify` (modal → pinGate → kernel); this block only
/// carries the resulting authorization, which native requires and records.
/// An absent or malformed block fails the gate — there is no override path
/// that pays cash without it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorIn {
    pub user_id: String,
    pub verified_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashMoveIn {
    pub id: String,
    pub session_id: String,
    pub amount: i64,
    pub reason: String,
    pub cashier_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditIn {
    pub action: String,
    pub details: String,
    pub user: String,
    pub requires_pin: bool,
    pub device_id: Option<String>,
    pub ip_address: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundRequest {
    pub ticket_id: String,
    pub refund_id: String,
    pub items_hash: String,
    pub receipt_number: String,
    pub method: String,
    pub customer_id: Option<String>,
    pub subtotal: i64,
    pub discount_total: i64,
    pub total_net: i64,
    pub cost_total: i64,
    pub pricing_tier: String,
    pub payment_method: String,
    pub cash_tendered: i64,
    pub change_due: i64,
    /// Net physical cash tendered on the ORIGINAL ticket (TS funding truth,
    /// deterministic from the ticket — identical for both racing tabs).
    /// Native sums already-disbursed cash from durable refund rows and
    /// refuses any payout past the cap: cumulative drawer cash out can never
    /// exceed what the customer physically handed over (Fix 2, enforced).
    pub cash_tendered_net: i64,
    /// Connectivity at submit time (TS `probeOnline`). Offline selects the
    /// containment gates (Modules A/B/C); online skips them (server claim +
    /// convergence govern instead).
    pub online: bool,
    /// Client-asserted local context (TS `getStableDeviceId` + open shift).
    /// The device id is NOT trusted: native loads the enrolled identity and
    /// rejects any mismatch as `DEVICE_IDENTITY_SPOOFED`. The field remains
    /// so spoof attempts fail loudly instead of silently changing semantics.
    pub local_device_id: String,
    pub active_shift_id: String,
    pub supervisor: Option<SupervisorIn>,
    pub created_at: String,
    /// Full receipt JSON (the refund transaction: carries
    /// `originalTransactionId`, `isRefund`, lines — same shape
    /// `writeCheckoutAtomicInner` persists, so the v109 backfill and the
    /// quota check keep working).
    pub refund_payload: String,
    /// Original-ticket JSON for the status-flip outbox row (version is
    /// stamped natively before enqueue).
    pub original_outbox_payload: String,
    pub device_id: String,
    pub lines: Vec<RefundItemIn>,
    pub deltas: Vec<LedgerDeltaIn>,
    pub batches: Vec<BatchRestoreIn>,
    pub imeis: Vec<String>,
    pub debt: Option<DebtReliefIn>,
    pub voucher: Option<VoucherRestoreIn>,
    pub cash_move: Option<CashMoveIn>,
    pub audit: AuditIn,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundOk {
    pub refund_id: String,
    pub receipt_number: String,
    pub ticket_status: String,
    pub ticket_version: i64,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Error helpers — every conflict is OperationFailed("CODE[:detail]")
// ---------------------------------------------------------------------------

fn conflict(code: &str) -> TrustError {
    TrustError::op_failed(code.to_string())
}

fn is_unique_violation(e: &rusqlite::Error) -> bool {
    match e {
        rusqlite::Error::SqliteFailure(f, msg) => {
            f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
                || f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY
                || msg
                    .as_ref()
                    .map(|m| m.contains("UNIQUE constraint failed"))
                    .unwrap_or(false)
        }
        _ => false,
    }
}

fn is_busy(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(f, _)
            if matches!(
                f.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            )
    )
}

fn map_rusqlite(context: &str, e: rusqlite::Error) -> TrustError {
    if is_busy(&e) {
        return conflict(&format!("BUSY:{context}"));
    }
    TrustError::op_failed(format!("{context}: {e}"))
}

fn validate(req: &RefundRequest) -> Result<(), TrustError> {
    if req.ticket_id.trim().is_empty()
        || req.refund_id.trim().is_empty()
        || req.items_hash.trim().is_empty()
        || req.receipt_number.trim().is_empty()
    {
        return Err(conflict("INVALID:ticket/refund identity required"));
    }
    if req.lines.is_empty() {
        return Err(conflict("INVALID:no refund lines"));
    }
    for l in &req.lines {
        if l.product_id.trim().is_empty() || l.id.trim().is_empty() || l.item_key.trim().is_empty()
        {
            return Err(conflict("INVALID:line identity required"));
        }
        if l.quantity <= 0 {
            return Err(conflict("INVALID:line quantity must be > 0"));
        }
    }
    for v in [
        req.subtotal,
        req.discount_total,
        req.total_net,
        req.cost_total,
        req.cash_tendered,
        req.change_due,
        req.cash_tendered_net,
    ] {
        if v < 0 {
            return Err(conflict("INVALID:order money must be >= 0"));
        }
    }
    for l in &req.lines {
        for v in [
            l.applied_price,
            l.unit_price_charged,
            l.unit_cost_at_sale,
            l.discount_amount,
            l.line_profit,
        ] {
            if v < 0 {
                return Err(conflict("INVALID:line money must be >= 0"));
            }
        }
    }
    if !req.online && (req.local_device_id.trim().is_empty() || req.active_shift_id.trim().is_empty()) {
        return Err(conflict("INVALID:offline refund requires local device + shift context"));
    }
    if let Some(s) = &req.supervisor {
        if s.user_id.trim().is_empty() || s.verified_at.trim().len() < 10 {
            return Err(conflict("SUPERVISOR_PIN_REQUIRED"));
        }
    }
    if req.audit.action.trim().is_empty() {
        return Err(conflict("INVALID:audit action required"));
    }
    Ok(())
}

fn has_column(tx: &Transaction, table: &str, col: &str) -> Result<bool, TrustError> {
    // Table names are internal constants at every call site — no interpolation
    // of caller input. `pragma_table_info` as a table-valued function.
    let sql = format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1");
    tx.query_row(&sql, [col], |_| Ok(()))
        .map(|_| true)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(false),
            other => Err(TrustError::op_failed(format!("schema probe: {other}"))),
        })
}

fn sql_value_to_json(v: rusqlite::types::Value) -> serde_json::Value {
    match v {
        rusqlite::types::Value::Null => serde_json::Value::Null,
        rusqlite::types::Value::Integer(i) => serde_json::Value::from(i),
        rusqlite::types::Value::Real(f) => serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        rusqlite::types::Value::Text(s) => serde_json::Value::from(s),
        rusqlite::types::Value::Blob(bytes) => {
            serde_json::Value::from(String::from_utf8_lossy(&bytes).into_owned())
        }
    }
}

/// Post-refund product row as JSON for the product outbox (same role as the
/// TS `SELECT *` + `toBoundedSyncJson(prow)` in `writeCheckoutAtomicInner`).
fn product_row_json(tx: &Transaction, pid: &str) -> Result<String, TrustError> {
    let mut stmt = tx
        .prepare("SELECT * FROM products WHERE id = ?1")
        .map_err(|e| TrustError::op_failed(format!("product row prepare: {e}")))?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt
        .query([pid])
        .map_err(|e| TrustError::op_failed(format!("product row read: {e}")))?;
    let row = rows
        .next()
        .map_err(|e| TrustError::op_failed(format!("product row next: {e}")))?
        .ok_or_else(|| TrustError::op_failed(format!("product {pid} missing for outbox")))?;
    let mut map = serde_json::Map::with_capacity(names.len());
    for (i, name) in names.iter().enumerate() {
        let v: rusqlite::types::Value =
            row.get(i)
                .map_err(|e| TrustError::op_failed(format!("product col {name}: {e}")))?;
        map.insert(name.clone(), sql_value_to_json(v));
    }
    Ok(serde_json::Value::Object(map).to_string())
}

/// Offline containment policy knob (Modules B/C). Stored as a JSON number
/// under `app_settings.key` (e.g. `10000`); any missing/unparseable value
/// falls back to the default. Never negative — a negative knob would deny
/// every offline cash refund, so it degrades to the default instead.
fn read_policy_i64(tx: &Transaction, key: &str, default: i64) -> i64 {
    let raw: Option<String> = tx
        .query_row("SELECT value_json FROM app_settings WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .ok()
        .flatten();
    let parsed = raw.as_deref().and_then(|s| {
        serde_json::from_str::<serde_json::Value>(s)
            .ok()
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|t| t.trim().parse().ok())))
            .or_else(|| s.trim().parse::<i64>().ok())
    });
    match parsed {
        Some(v) if v >= 0 => v,
        _ => default,
    }
}

fn open_live_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("refund open: {e}")))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| TrustError::op_failed(format!("refund wal: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| TrustError::op_failed(format!("refund busy_timeout: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("refund fk: {e}")))?;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Core: one Immediate transaction, all effects or none
// ---------------------------------------------------------------------------

fn sum_by_product(
    tx: &Transaction,
    sql: &str,
    ticket_id: &str,
) -> Result<std::collections::HashMap<String, i64>, TrustError> {
    let mut stmt = tx
        .prepare(sql)
        .map_err(|e| TrustError::op_failed(format!("quota prepare: {e}")))?;
    let rows = stmt
        .query_map([ticket_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|e| TrustError::op_failed(format!("quota read: {e}")))?;
    let mut out = std::collections::HashMap::new();
    for row in rows {
        let (k, v) = row.map_err(|e| TrustError::op_failed(format!("quota row: {e}")))?;
        out.insert(k, v);
    }
    Ok(out)
}

#[allow(clippy::too_many_lines)]
fn apply_refund_in_txn(
    tx: &Transaction,
    req: &RefundRequest,
    mac_key: Option<&[u8]>,
    clock: &dyn crate::trust_core::clocks::MonotonicSource,
    identity: &DeviceIdentity,
) -> Result<RefundOk, TrustError> {
    let mut warnings: Vec<String> = Vec::new();

    // 0. Money-path now: monotonic-derived, high-water floored, ratcheted —
    //    resolved FIRST inside the txn so every stamp below shares one
    //    instant and a rolled-back host clock aborts before any gate reads.
    //    Raw `SystemTime` never enters this pipeline.
    let anchor_ms = time_anchor::anchor_now_ms(tx, clock)?;
    let now_str = time_anchor::iso_utc_ms(anchor_ms);
    let now: &str = &now_str;

    // Supervisor freshness against the ANCHOR (not the wall): stale (>120 s)
    // and future-dated (>30 s) approvals roll back before touching money.
    let mut verified_ms: i64 = 0;
    if let Some(s) = &req.supervisor {
        check_supervisor_freshness(&s.verified_at, anchor_ms)?;
        verified_ms = crate::trust_core::device_identity::parse_iso_utc_ms(&s.verified_at)
            .map_err(|_| conflict("SUPERVISOR_PIN_REQUIRED:bad_timestamp"))?;
    }

    // 1. Authoritative ticket state, read under the write lock. The caller
    //    sends NO version: a stale snapshot must never cause a false 409.
    //    Authorship columns may be absent pre-heal — probe once and degrade
    //    to fail-closed (offline containment cannot evaluate without them).
    let has_device = has_column(tx, "transactions", "device_id")?;
    let has_shift_col = has_column(tx, "transactions", "shift_id")?;
    if !req.online && (!has_device || !has_shift_col) {
        return Err(conflict("SCHEMA_UNHEALED:transactions.device_id/shift_id"));
    }
    // Authorship columns degrade to NULL when absent (online path on a
    // pre-heal DB keeps working; offline already failed closed above).
    let ticket_sql = match (has_device, has_shift_col) {
        (true, true) => "SELECT status, version, device_id, shift_id FROM transactions WHERE id = ?1",
        (true, false) => "SELECT status, version, device_id, NULL FROM transactions WHERE id = ?1",
        _ => "SELECT status, version, NULL, NULL FROM transactions WHERE id = ?1",
    };
    let (status, version, ticket_device, ticket_shift): (String, i64, Option<String>, Option<String>) = tx
        .query_row(
            ticket_sql,
            [&req.ticket_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => conflict("TICKET_NOT_FOUND"),
            other => TrustError::op_failed(format!("ticket read: {other}")),
        })?;

    // 1b. Module A — device-origin affinity (offline only). A disconnected
    //     terminal may refund ONLY tickets its own ledger wrote during the
    //     currently open shift (same rule as `offlineRefundVerdict`, enforced
    //     here against the durable row instead of a snapshot). Legacy/empty
    //     authorship denies fail-closed — exactly like the TS verdict.
    if !req.online {
        // Compared against the NATIVELY enrolled id (spoof-checked above),
        // never the client string.
        let native_id = identity.device_id();
        let mut affinity = false;
        if let (Some(td), Some(ts)) = (ticket_device.as_deref(), ticket_shift.as_deref()) {
            affinity = !td.trim().is_empty()
                && td.trim() == native_id
                && !ts.trim().is_empty()
                && ts.trim() == req.active_shift_id.trim();
        }
        if !affinity {
            return Err(conflict(&format!(
                "OFFLINE_FOREIGN_TICKET:{}:{}",
                ticket_device.as_deref().unwrap_or(""),
                identity.device_id(),
            )));
        }
    }

    // 2. Exact-replay gate FIRST: the loser of a race blocks on the journal
    //    lock at BEGIN IMMEDIATE, then fails here. Different-hash replays
    //    (same items, different method) pass and are stopped by the quota.
    if let Err(e) = tx.execute(
        "INSERT INTO refund_dedup (ticket_id, items_hash, refund_id, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![req.ticket_id, req.items_hash, req.refund_id, now],
    ) {
        if is_unique_violation(&e) {
            let existing: String = tx
                .query_row(
                    "SELECT refund_id FROM refund_dedup WHERE ticket_id = ?1 AND items_hash = ?2",
                    params![req.ticket_id, req.items_hash],
                    |r| r.get(0),
                )
                .map_err(|qe| TrustError::op_failed(format!("dedup read: {qe}")))?;
            return Err(conflict(&format!("ALREADY_REFUNDED:{existing}")));
        }
        return Err(map_rusqlite("dedup insert", e));
    }

    // 3. State-machine guard (in-txn: a void racing us is decided here, not
    //    on a pre-read snapshot).
    if status == "VOIDED" {
        return Err(conflict("ORIGINAL_VOIDED"));
    }

    // 4. Quota: purchased (original lines) minus already-refunded (committed
    //    refund rows, indexed — never a LIKE scan). THE over-refund guard for
    //    concurrent partial refunds with different hashes.
    let purchased = sum_by_product(
        tx,
        "SELECT product_id, SUM(quantity) FROM transaction_items WHERE transaction_id = ?1 GROUP BY product_id",
        &req.ticket_id,
    )?;
    let refunded = sum_by_product(
        tx,
        "SELECT i.product_id, SUM(i.quantity) FROM transactions t \
          JOIN transaction_items i ON i.transaction_id = t.id \
         WHERE t.original_transaction_id = ?1 AND t.is_refund = 1 \
         GROUP BY i.product_id",
        &req.ticket_id,
    )?;
    let mut requested: std::collections::HashMap<String, i64> =
        std::collections::HashMap::new();
    for l in &req.lines {
        *requested.entry(l.product_id.clone()).or_insert(0) += l.quantity;
    }
    for (pid, qty) in &requested {
        let remaining =
            purchased.get(pid).copied().unwrap_or(0) - refunded.get(pid).copied().unwrap_or(0);
        if *qty > remaining {
            return Err(conflict(&format!(
                "REFUND_EXCEEDS:{pid}:requested={qty}:remaining={}",
                remaining.max(0)
            )));
        }
    }
    // Fix 1 (enforced): zero-value tickets never reach the write path — same
    // money-truth basis as the modal/slice filter. A zero-net "refund" that
    // restocks would mint free inventory against nothing returned.
    if req.total_net <= 0 {
        return Err(conflict("ZERO_REFUNDABLE"));
    }
    // Prior cash disbursed on this ticket, summed from DURABLE refund rows in
    // this same transaction (exact `cashDisbursed`, legacy `total` fallback
    // for rows without the field, non-cash methods contribute 0 — mirroring
    // `cashDisbursedOf`). Integer DZD throughout: the CASTs land on whole
    // numbers (writers store integers), COALESCE keeps the SUM non-null.
    let prior_ticket_cash: i64 = tx
        .query_row(
            "SELECT COALESCE(SUM(
               CASE WHEN json_extract(json_payload, '$.refundMethod') = 'Espèces'
                    THEN COALESCE(CAST(json_extract(json_payload, '$.cashDisbursed') AS INTEGER),
                           CASE WHEN json_extract(json_payload, '$.cashDisbursed') IS NULL
                                THEN COALESCE(CAST(json_extract(json_payload, '$.total') AS INTEGER), 0)
                                ELSE 0 END)
                    ELSE 0 END), 0)
             FROM transactions WHERE original_transaction_id = ?1 AND is_refund = 1",
            [&req.ticket_id],
            |r| r.get(0),
        )
        .map_err(|e| TrustError::op_failed(format!("cash cap read: {e}")))?;
    // Fix 2 (enforced): cumulative drawer cash out capped at the net physical
    // cash tendered, so two concurrent refunds cannot jointly exceed the cap
    // even with different hashes.
    let requested_cash: i64 = if req.method == "Espèces" {
        match &req.cash_move {
            Some(c) => c.amount,
            None => return Err(conflict("INVALID:cash refund without drawer movement")),
        }
    } else {
        0
    };
    if requested_cash > 0 && requested_cash > req.cash_tendered_net - prior_ticket_cash {
        return Err(conflict("CASH_CAP_EXCEEDED"));
    }
    // Module B — shift-level offline cash cap (token bucket). Offline cash
    // refunds accumulate per shift over PENDING (unsynced) rows; past the
    // policy limit the terminal must resync (rows flip to 'synced' and leave
    // the bucket) or route value as a non-cashable store voucher. Online
    // refunds skip this (server convergence governs).
    if !req.online && requested_cash > 0 {
        let shift_cash: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(
                   CASE WHEN json_extract(json_payload, '$.refundMethod') = 'Espèces'
                        THEN COALESCE(CAST(json_extract(json_payload, '$.cashDisbursed') AS INTEGER),
                               CASE WHEN json_extract(json_payload, '$.cashDisbursed') IS NULL
                                    THEN COALESCE(CAST(json_extract(json_payload, '$.total') AS INTEGER), 0)
                                    ELSE 0 END)
                        ELSE 0 END), 0)
                 FROM transactions
                 WHERE shift_id = ?1 AND sync_status = 'pending' AND is_refund = 1",
                [req.active_shift_id.trim()],
                |r| r.get(0),
            )
            .map_err(|e| TrustError::op_failed(format!("offline bucket read: {e}")))?;
        let cap = read_policy_i64(tx, "policy.offline_cash_refund_limit", 10_000);
        if shift_cash + requested_cash > cap {
            return Err(conflict(&format!(
                "OFFLINE_CASH_CAP_EXCEEDED:{shift_cash}:{cap}:{}",
                requested_cash
            )));
        }
    }
    // Module C — supervisor authorization for large offline cash. The secret
    // was verified pre-submit via `pin_verify` (attempts accounted in the
    // kernel, never inside this txn); native requires the resulting block
    // and records it in the in-txn audit row. Absent/malformed fails closed.
    if !req.online && req.method == "Espèces" && requested_cash > 0 {
        let threshold = read_policy_i64(tx, "policy.offline_pin_threshold", 5_000);
        if requested_cash > threshold {
            match &req.supervisor {
                Some(s) if !s.user_id.trim().is_empty() && s.verified_at.trim().len() >= 10 => {}
                _ => return Err(conflict("SUPERVISOR_PIN_REQUIRED")),
            }
        }
    }
    let fully_refunded = purchased.iter().all(|(pid, bought)| {
        bought - refunded.get(pid).copied().unwrap_or(0) - requested.get(pid).copied().unwrap_or(0)
            == 0
    });
    // An empty original (no item rows — legacy import) cannot prove full
    // coverage: stay PARTIALLY_REFUNDED rather than minting REFUNDED.
    let new_status = if fully_refunded && !purchased.is_empty() {
        "REFUNDED"
    } else {
        "PARTIALLY_REFUNDED"
    };

    // 5. Status flip with version CAS as an invariant assertion: the version
    //    was read under this same lock, so 0 rows means a writer bypassed
    //    the lock. Re-read to report VOIDED vs duplicate precisely.
    let flipped = tx
        .execute(
            "UPDATE transactions SET status = ?1, version = version + 1, updated_at = ?2, sync_status = 'pending' \
             WHERE id = ?3 AND version = ?4 AND status <> 'VOIDED'",
            params![new_status, now, req.ticket_id, version],
        )
        .map_err(|e| map_rusqlite("ticket cas", e))?;
    if flipped != 1 {
        let restatus: String = tx
            .query_row(
                "SELECT status FROM transactions WHERE id = ?1",
                [&req.ticket_id],
                |r| r.get(0),
            )
            .unwrap_or_default();
        if restatus == "VOIDED" {
            return Err(conflict("ORIGINAL_VOIDED"));
        }
        return Err(conflict("ALREADY_REFUNDED"));
    }

    // 6. Refund row. The dedup row (step 2) satisfies
    //    `trg_refund_requires_dedup`. `shift_id` / `ledger_cogs_total` may be
    //    absent on pre-heal DBs — probe and degrade like the TS writer.
    let has_shift = has_column(tx, "transactions", "shift_id")?;
    let has_ledger_cogs = has_column(tx, "transactions", "ledger_cogs_total")?;
    // The owning shift is the CURRENT shift (contra-revenue to this period);
    // verified OPEN at step 11 before any cash movement is recorded.
    let shift_id: Option<&str> = req.cash_move.as_ref().map(|c| c.session_id.as_str());
    let mut cols = "id, receipt_number, customer_id, subtotal, discount_total, total, \
        cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, \
        change_due, status, created_at, json_payload, device_id, idempotency_key, \
        sync_status, updated_at, version, deleted, original_transaction_id, is_refund"
        .to_string();
    if has_ledger_cogs {
        cols.push_str(", ledger_cogs_total");
    }
    if has_shift {
        cols.push_str(", shift_id");
    }
    let placeholders: Vec<String> = (1..=cols.split(',').count())
        .map(|i| format!("?{i}"))
        .collect();
    let mut stmt = tx
        .prepare(&format!(
            "INSERT INTO transactions ({cols}) VALUES ({})",
            placeholders.join(",")
        ))
        .map_err(|e| map_rusqlite("refund row prepare", e))?;
    {
        use rusqlite::ToSql;
        let mut p: Vec<&dyn ToSql> = vec![
            &req.refund_id,
            &req.receipt_number,
            &req.customer_id,
            &req.subtotal,
            &req.discount_total,
            &req.total_net,
            &req.cost_total,
            &0i64,
            &0i64,
            &req.pricing_tier,
            &req.payment_method,
            &req.cash_tendered,
            &req.change_due,
            &"COMPLETED",
            &req.created_at,
            &req.refund_payload,
            &req.device_id,
            &req.refund_id,
            &"pending",
            &now,
            &1i64,
            &0i64,
            &req.ticket_id,
            &1i64,
        ];
        let zero_cogs = 0i64;
        if has_ledger_cogs {
            p.push(&zero_cogs);
        }
        if has_shift {
            p.push(&shift_id);
        }
        stmt
            .execute(p.as_slice())
            .map_err(|e| map_rusqlite("refund row insert", e))?;
    }

    // 7. Refund lines (full column set; extended costing cols are
    //    heal-owned — degrade when absent).
    let has_ext = has_column(tx, "transaction_items", "unit_cost_at_sale")?;
    for l in &req.lines {
        if has_ext {
            tx.execute(
                "INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount, \
                 imei_number, cost_price, unit_price_charged, unit_cost_at_sale, discount_amount, line_profit, \
                 json_payload, device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 0, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'pending', ?14, ?14, 0, 1)",
                params![
                    l.id, req.refund_id, l.product_id, l.quantity, l.applied_price,
                    l.imei_number, l.unit_price_charged, l.unit_cost_at_sale,
                    l.discount_amount, l.line_profit, l.item_payload, req.device_id,
                    l.item_key, now,
                ],
            )
        } else {
            tx.execute(
                "INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount, \
                 imei_number, cost_price, json_payload, device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 0, ?7, ?8, ?9, 'pending', ?10, ?10, 0, 1)",
                params![
                    l.id, req.refund_id, l.product_id, l.quantity, l.applied_price,
                    l.imei_number, l.item_payload, req.device_id, l.item_key, now,
                ],
            )
        }
        .map_err(|e| map_rusqlite("refund line insert", e))?;
    }

    // 8. Inventory deltas (authoritative stock movement; deterministic keys
    //    make retries converge — unreachable post-dedup, but harmless).
    for d in &req.deltas {
        tx.execute(
            "INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, \
             idempotency_key, sync_status, created_at, updated_at, deleted, version) \
             VALUES (?1, ?2, ?3, 'REFUND', 'order', ?4, ?5, ?6, 'pending', ?7, ?7, 0, 1)",
            params![d.id, d.product_id, d.delta, req.refund_id, req.device_id, d.key, now],
        )
        .map_err(|e| map_rusqlite("ledger insert", e))?;
    }

    // 9. Batch restitution with the same shadow/tombstone rules as the TS
    //    lane: shadow markers are never restored; missing or deleted batches
    //    fall through to a deterministic REFUND batch (the unit physically
    //    came back, so it re-enters stock at original unit cost).
    for b in &req.batches {
        if b.quantity <= 0.0 {
            continue;
        }
        let live_id = b.batch_id.as_deref().filter(|id| !id.starts_with("shadow-"));
        let mut restored = false;
        if let Some(bid) = live_id {
            let n = tx
                .execute(
                    "UPDATE stock_batches SET quantity_remaining = quantity_remaining + ?1, version = version + 1, \
                     updated_at = ?2, sync_status = 'pending' \
                     WHERE batch_id = ?3 AND (deleted = 0 OR deleted IS NULL)",
                    params![b.quantity, now, bid],
                )
                .map_err(|e| map_rusqlite("batch restitute", e))?;
            restored = n == 1;
        }
        if !restored {
            tx.execute(
                "INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, \
                 purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) \
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, 'pending', 1, ?5, ?5, 0)",
                params![
                    b.fallback_batch_id, b.product_id, b.quantity, b.unit_cost,
                    now, req.device_id, b.fallback_key,
                ],
            )
            .map_err(|e| map_rusqlite("refund batch insert", e))?;
        }
    }

    // 9b. Cached stock recompute + product/batch outbox — the same contract
    //     as `writeCheckoutAtomicInner` step 7: `products.stock` is the
    //     cached SUM of the ledger, so it is recomputed AFTER this refund's
    //     deltas land, and the post-refund row is what the cloud converges
    //     on. Services (`qt-*`/`prod-misc-*`/Services) are untracked.
    {
        use std::collections::HashSet;
        let mut touched: HashSet<String> = HashSet::new();
        for d in &req.deltas {
            touched.insert(d.product_id.clone());
        }
        for pid in touched {
            if pid.starts_with("qt-") || pid.starts_with("prod-misc-") {
                continue;
            }
            let category: Option<String> = tx
                .query_row(
                    "SELECT category FROM products WHERE id = ?1",
                    [&pid],
                    |r| r.get(0),
                )
                .ok()
                .flatten();
            if category.as_deref() == Some("Services") {
                continue;
            }
            tx.execute(
                "UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id = ?1 AND deleted = 0), stock), \
                 version = version + 1, updated_at = ?2, sync_status = 'pending' WHERE id = ?1",
                params![pid, now],
            )
            .map_err(|e| map_rusqlite("products stock recompute", e))?;
            let prow = product_row_json(tx, &pid)?;
            let pkey: String = tx
                .query_row(
                    "SELECT idempotency_key FROM products WHERE id = ?1",
                    [&pid],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| format!("stub-{pid}"));
            tx.execute(
                "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
                 VALUES (?1, 'product', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
                 ON CONFLICT(idempotency_key) DO UPDATE SET operation = 'UPSERT', payload_json = excluded.payload_json, \
                 status = 'pending', retry_count = 0, next_retry_at = NULL, last_error = NULL, updated_at = ?4",
                params![pkey, pid, prow, now],
            )
            .map_err(|e| map_rusqlite("outbox product", e))?;
        }
        // Batch outbox rows for every restitution target touched above so
        // peers converge on post-refund quantities.
        for b in &req.batches {
            if b.quantity <= 0.0 {
                continue;
            }
            let live_id = b.batch_id.as_deref().filter(|id| !id.starts_with("shadow-"));
            // Restored onto the live batch, or minted as the fallback batch.
            let (bid, is_fallback) = match live_id {
                Some(id) => {
                    let alive: bool = tx
                        .query_row(
                            "SELECT 1 FROM stock_batches WHERE batch_id = ?1 AND (deleted = 0 OR deleted IS NULL)",
                            [id],
                            |_| Ok(()),
                        )
                        .is_ok();
                    if alive {
                        (id.to_string(), false)
                    } else {
                        (b.fallback_batch_id.clone(), true)
                    }
                }
                None => (b.fallback_batch_id.clone(), true),
            };
            let (qty, cost): (f64, f64) = tx
                .query_row(
                    "SELECT quantity_remaining, unit_cost FROM stock_batches WHERE batch_id = ?1",
                    [&bid],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap_or((b.quantity, b.unit_cost as f64));
            let key = if is_fallback {
                format!("sb-{bid}")
            } else {
                format!("sb-{}-{bid}", req.refund_id)
            };
            let payload = serde_json::json!({
                "batch_id": bid, "product_id": b.product_id,
                "quantity_remaining": qty, "unit_cost": cost, "updated_at": now,
            })
            .to_string();
            tx.execute(
                "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
                 VALUES (?1, 'stock_batches', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
                 ON CONFLICT(idempotency_key) DO UPDATE SET payload_json = excluded.payload_json, status = 'pending', updated_at = ?4",
                params![key, bid, payload, now],
            )
            .map_err(|e| map_rusqlite("outbox batch", e))?;
        }
    }

    // 10. IMEI release (best-effort mirror of the Dexie release: a missing
    //     row warns instead of failing the money — same policy as the TS
    //     lane, which collects these as warnings).
    for imei in &req.imeis {
        let imei = imei.trim();
        if imei.is_empty() {
            continue;
        }
        let n = tx
            .execute(
                "UPDATE imei_records SET sale_transaction_id = NULL, sold_at = NULL, version = version + 1 WHERE imei = ?1",
                [imei],
            )
            .map_err(|e| map_rusqlite("imei release", e))?;
        if n != 1 {
            warnings.push(format!("[refund] IMEI {imei} introuvable dans SQLite — vérification manuelle."));
        }
    }

    // 11. Debt relief as an authoritative ledger row with the deterministic
    //     entry id (same id the TS lane derives: replays converge on the PK,
    //     and a second tab never gets here — dedup fires first).
    if let Some(d) = &req.debt {
        if d.amount <= 0 {
            return Err(conflict("INVALID:debt relief amount must be > 0"));
        }
        tx.execute(
            "INSERT INTO customers (id, name, phone, json_payload, updated_at, idempotency_key, created_at) \
             VALUES (?1, ?2, '', '{}', ?3, 'stub-cust-' || ?1, ?3) ON CONFLICT(id) DO NOTHING",
            params![d.customer_id, d.customer_name, now],
        )
        .map_err(|e| map_rusqlite("debt parent stub", e))?;
        let debt_json = serde_json::json!({
            "id": d.entry_id, "customerId": d.customer_id, "customerName": d.customer_name,
            "type": "PAYMENT_SETTLED", "amount": d.amount, "receiptNumber": d.receipt_number,
            "paymentMethod": d.payment_method, "notes": d.notes, "recordedBy": d.recorded_by,
            "createdAt": now,
        })
        .to_string();
        if let Err(e) = tx.execute(
            "INSERT INTO customer_debts (id, customer_id, customer_name, type, amount, balance_after, \
             receipt_number, payment_method, notes, recorded_by, created_at, json_payload, version, updated_at, deleted) \
             VALUES (?1, ?2, ?3, 'PAYMENT_SETTLED', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?10, 0)",
            params![
                d.entry_id, d.customer_id, d.customer_name, d.amount, d.amount,
                d.receipt_number, d.payment_method, d.notes, d.recorded_by, now, debt_json,
            ],
        ) {
            // balance_after is informational on the ledger row (the cached
            // aggregate is reconciled from the ledger); only a PK collision
            // can fail here, which means this exact relief already applied.
            if is_unique_violation(&e) {
                warnings.push("[refund] Dette : écriture déjà appliquée (rejouée) — ignorée.".to_string());
            } else {
                return Err(map_rusqlite("debt relief insert", e));
            }
        }
    }

    // 12. Voucher credit-back with the same CAS discipline as
    //     `voucherAdapter.creditBack`: conditional update on the exact
    //     balance read; 0 rows re-inspects (already-applied converges,
    //     genuinely-moved fails closed for manual reissue).
    if let Some(v) = &req.voucher {
        if v.amount <= 0 {
            return Err(conflict("INVALID:voucher amount must be > 0"));
        }
        // Bearer balances ride REAL columns; the restore amount itself is
        // integer DZD (validated). Reads stay float, writes stay whole.
        let row: Option<(String, f64, f64, String)> = tx
            .query_row(
                "SELECT id, initial_amount, remaining_amount, status FROM credit_vouchers \
                 WHERE code = ?1 AND (deleted = 0 OR deleted IS NULL)",
                [&v.code],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(TrustError::op_failed(format!("voucher read: {other}"))),
            })?;
        let Some((vid, initial, remaining, _status)) = row else {
            return Err(conflict(&format!("VOUCHER_MISSING:{}", v.code)));
        };
        let target = initial.min(remaining + v.amount as f64);
        let n = tx
            .execute(
                "UPDATE credit_vouchers SET remaining_amount = ?1, \
                 status = CASE WHEN ?1 > 0 THEN 'ACTIVE' ELSE status END, \
                 updated_at = ?2, version = version + 1 WHERE id = ?3 AND remaining_amount = ?4",
                params![target, now, vid, remaining],
            )
            .map_err(|e| map_rusqlite("voucher credit", e))?;
        if n != 1 {
            let fresh: f64 = tx
                .query_row(
                    "SELECT remaining_amount FROM credit_vouchers WHERE id = ?1",
                    [&vid],
                    |r| r.get(0),
                )
                .unwrap_or(f64::NAN);
            if fresh.is_finite() && fresh >= target {
                warnings.push(format!(
                    "[refund] Bon {} déjà recrédité — convergé sans double émission.",
                    v.code
                ));
            } else {
                return Err(conflict(&format!("VOUCHER_CHANGED:{}", v.code)));
            }
        }
    }

    // 13. Drawer debit trail (informational ALLOCATION, allowlisted out of
    //     every cash-math reader — same contract as the TS lane). The shift
    //     gate is re-verified here against the durable session row: no open
    //     shift = no refund, even if the caller's snapshot claimed one.
    if let Some(c) = &req.cash_move {
        if c.amount > 0 {
            let st: Option<String> = tx
                .query_row(
                    "SELECT status FROM cash_sessions WHERE id = ?1",
                    [&c.session_id],
                    |r| r.get(0),
                )
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(TrustError::op_failed(format!("shift read: {other}"))),
                })?;
            if st.as_deref() != Some("OPEN") {
                return Err(conflict("NO_OPEN_SHIFT"));
            }
            let move_json = serde_json::json!({
                "id": c.id, "sessionId": c.session_id, "type": "ALLOCATION",
                "amount": c.amount, "reason": c.reason, "cashierName": c.cashier_name,
                "createdAt": now,
            })
            .to_string();
            tx.execute(
                "INSERT INTO cash_movements (id, session_id, type, amount, reason, cashier_name, created_at, json_payload) \
                 VALUES (?1, ?2, 'ALLOCATION', ?3, ?4, ?5, ?6, ?7)",
                params![c.id, c.session_id, c.amount, c.reason, c.cashier_name, now, move_json],
            )
            .map_err(|e| map_rusqlite("cash movement insert", e))?;
        }
    }

    // 14. Outbox rows so the refund converges to the cloud/peers: the refund
    //     receipt (full JSON, version 1) and the flipped original (status +
    //     bumped version stamped into the caller-supplied JSON). The refund
    //     row carries the device signature (Module C): positional envelope
    //     bytes signed by the enrolled key, so the backend proves the
    //     physical terminal that authorized the payout. `device_id` /
    //     `device_signature` are v110 columns — probed, never assumed
    //     (pre-migration DBs keep the unsigned shape; the money never waits
    //     on sync plumbing).
    // Monotonic outbox sequence (Module B): assigned under the same write
    // lock, so concurrent refunds can never share or reorder it. Overflow
    // is coded (unreachable in practice) rather than allowed to wrap.
    let seq_no: i64 = {
        let cur: i64 = tx
            .query_row(
                "SELECT last_outbox_seq FROM device_identity WHERE device_id = ?1",
                [identity.device_id()],
                |r| r.get(0),
            )
            .map_err(|e| TrustError::op_failed(format!("seq read: {e}")))?;
        if cur >= i64::MAX - 1 {
            return Err(conflict("OUTBOX_SEQUENCE_EXHAUSTED:overflow"));
        }
        tx.execute(
            "UPDATE device_identity SET last_outbox_seq = last_outbox_seq + 1 WHERE device_id = ?1",
            [identity.device_id()],
        )
        .map_err(|e| map_rusqlite("seq assign", e))?;
        cur + 1
    };
    let envelope = refund_envelope(
        &req.ticket_id,
        &req.refund_id,
        req.total_net,
        identity.device_id(),
        seq_no,
        verified_ms,
    );
    let signature = identity
        .sign_payload(&envelope)
        .map_err(|_| conflict("DEVICE_SIGNATURE_FAILED:sign_err"))?;
    // The envelope string itself is stored verbatim (v112): the gateway
    // verifies the signature over THESE bytes. Rebuilding them from other
    // fields (or re-serializing JSON) would break the covered-bytes
    // contract, so the row carries its own evidence.
    let envelope_str = String::from_utf8(envelope)
        .map_err(|e| TrustError::op_failed(format!("envelope utf8: {e}")))?;
    let has_outbox_sig = has_column(tx, "sync_outbox", "device_signature")?;
    let has_outbox_seq = has_column(tx, "sync_outbox", "seq_no")?;
    let has_outbox_env = has_column(tx, "sync_outbox", "envelope")?;
    if has_outbox_sig && has_outbox_seq && has_outbox_env {
        tx.execute(
            "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at, device_id, device_signature, seq_no, envelope) \
             VALUES (?1, 'order', ?2, 'UPSERT', ?3, 'pending', ?4, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT(idempotency_key) DO UPDATE SET operation = 'UPSERT', payload_json = excluded.payload_json, \
             status = 'pending', retry_count = 0, next_retry_at = NULL, last_error = NULL, updated_at = ?4, \
             device_id = excluded.device_id, device_signature = excluded.device_signature, seq_no = excluded.seq_no, envelope = excluded.envelope",
            params![req.refund_id, req.refund_id, req.refund_payload, now, identity.device_id(), signature, seq_no, envelope_str],
        )
        .map_err(|e| map_rusqlite("outbox refund", e))?;
    } else if has_outbox_sig && has_outbox_seq {
        tx.execute(
            "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at, device_id, device_signature, seq_no) \
             VALUES (?1, 'order', ?2, 'UPSERT', ?3, 'pending', ?4, ?4, ?5, ?6, ?7) \
             ON CONFLICT(idempotency_key) DO UPDATE SET operation = 'UPSERT', payload_json = excluded.payload_json, \
             status = 'pending', retry_count = 0, next_retry_at = NULL, last_error = NULL, updated_at = ?4, \
             device_id = excluded.device_id, device_signature = excluded.device_signature, seq_no = excluded.seq_no",
            params![req.refund_id, req.refund_id, req.refund_payload, now, identity.device_id(), signature, seq_no],
        )
        .map_err(|e| map_rusqlite("outbox refund", e))?;
    } else {
        tx.execute(
            "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
             VALUES (?1, 'order', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
             ON CONFLICT(idempotency_key) DO UPDATE SET operation = 'UPSERT', payload_json = excluded.payload_json, \
             status = 'pending', retry_count = 0, next_retry_at = NULL, last_error = NULL, updated_at = ?4",
            params![req.refund_id, req.refund_id, req.refund_payload, now],
        )
        .map_err(|e| map_rusqlite("outbox refund", e))?;
    }
    let orig_key: String = tx
        .query_row(
            "SELECT idempotency_key FROM transactions WHERE id = ?1",
            [&req.ticket_id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| format!("legacy-{}", req.ticket_id));
    let mut orig_value: serde_json::Value =
        serde_json::from_str(&req.original_outbox_payload)
            .map_err(|_| conflict("INVALID:original outbox payload must be JSON"))?;
    if let Some(obj) = orig_value.as_object_mut() {
        obj.insert(
            "version".to_string(),
            serde_json::Value::from(version + 1),
        );
        obj.insert(
            "status".to_string(),
            serde_json::Value::from(new_status),
        );
    }
    tx.execute(
        "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
         VALUES (?1, 'order', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
         ON CONFLICT(idempotency_key) DO UPDATE SET operation = 'UPSERT', payload_json = excluded.payload_json, \
         status = 'pending', retry_count = 0, next_retry_at = NULL, last_error = NULL, updated_at = ?4",
        params![orig_key, req.ticket_id, orig_value.to_string(), now],
    )
    .map_err(|e| map_rusqlite("outbox original", e))?;
    for l in &req.lines {
        tx.execute(
            "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
             VALUES (?1, 'order_item', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) ON CONFLICT(idempotency_key) DO NOTHING",
            params![l.item_key, l.id, l.item_payload, now],
        )
        .map_err(|e| map_rusqlite("outbox item", e))?;
    }

    // 15. Audit link in the same transaction: commits iff the money does.
    //     The supervisor attribution is composed HERE (not by the caller),
    //     so it cannot be dropped or forged around the gate.
    let mut audit_details = req.audit.details.clone();
    if let Some(s) = &req.supervisor {
        audit_details.push_str(&format!(
            " Superviseur: {} ({})",
            s.user_id.trim(),
            s.verified_at.trim()
        ));
    }
    let audit_req = AuditAppendRequest {
        action: req.audit.action.clone(),
        details: audit_details,
        user: Some(req.audit.user.clone()),
        requires_pin: Some(req.audit.requires_pin),
        // Authorship is the enrolled id, never the client string.
        device_id: Some(identity.device_id().to_string()),
        ip_address: req.audit.ip_address.clone(),
        idempotency_key: None,
    };
    let event_id = format!("AUD-{}", req.refund_id);
    append_in_tx(tx, mac_key, &audit_req, &event_id, now)
        .map_err(|e| TrustError::op_failed(format!("audit: {e:?}")))?;

    Ok(RefundOk {
        refund_id: req.refund_id.clone(),
        receipt_number: req.receipt_number.clone(),
        ticket_status: new_status.to_string(),
        ticket_version: version + 1,
        warnings,
    })
}

fn is_busy_conflict(e: &TrustError) -> bool {
    matches!(e, TrustError::OperationFailed(msg) if msg.starts_with("BUSY:"))
}

fn nanos_jitter(salt: u64) -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 ^ salt)
        .unwrap_or(salt)
        % 16
}

fn apply_refund(
    conn: &mut Connection,
    req: &RefundRequest,
    mac_key: Option<&[u8]>,
    entry_generation: u64,
    identity: &DeviceIdentity,
    clock: &dyn crate::trust_core::clocks::MonotonicSource,
) -> Result<RefundOk, TrustError> {
    // Contention retry (bounded): parallel refund bursts converge on the
    // single WAL writer; a BUSY begin/commit is transient. Retry the whole
    // begin→work→commit sequence — nothing commits until commit succeeds,
    // and the in-txn dedup guard makes reruns idempotent — with
    // backoff+jitter, then return the last BUSY as before. Contract
    // preserved: BUSY stays the only retryable code; attempts and budget
    // capped (≈250 ms worst case) so a real deadlock still surfaces fast.
    const BUSY_RETRIES: u32 = 4;
    const BUSY_BASE_MS: u64 = 25;
    let mut attempt = 0u32;
    loop {
        match try_apply_refund_once(conn, req, mac_key, entry_generation, identity, clock) {
            Ok(ok) => return Ok(ok),
            Err(e) if is_busy_conflict(&e) && attempt < BUSY_RETRIES => {
                attempt += 1;
                let backoff = BUSY_BASE_MS.saturating_mul(1 << attempt.min(6));
                let wait = backoff + nanos_jitter(attempt as u64 * 0x9E3779B9);
                std::thread::sleep(std::time::Duration::from_millis(wait));
            }
            Err(e) => return Err(e),
        }
    }
}

fn try_apply_refund_once(
    conn: &mut Connection,
    req: &RefundRequest,
    mac_key: Option<&[u8]>,
    entry_generation: u64,
    identity: &DeviceIdentity,
    clock: &dyn crate::trust_core::clocks::MonotonicSource,
) -> Result<RefundOk, TrustError> {
    validate(req)?;
    // Module B (identity): a non-empty client claim must EXACTLY match the
    // natively enrolled id — before any lock, before any write. Empty claims
    // (legacy callers) proceed with the native id; NOTHING downstream ever
    // reads the client string again. Supervisor freshness moved INSIDE the
    // txn (anchor-derived): pre-txn wall checks would reintroduce the clock
    // this module exists to remove.
    let claimed = req.local_device_id.trim();
    if !claimed.is_empty() && claimed != identity.device_id() {
        return Err(conflict(&format!(
            "DEVICE_IDENTITY_SPOOFED:client_claimed_{claimed}_native_{}",
            identity.device_id()
        )));
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| {
            if is_busy(&e) {
                conflict("BUSY:write lock held")
            } else {
                TrustError::op_failed(format!("refund begin: {e}"))
            }
        })?;
    let ok = apply_refund_in_txn(&tx, req, mac_key, clock, identity)?;
    // B.5 (same discipline as commit_stock_batch): a license transition that
    // landed mid-transaction aborts instead of committing under stale
    // authority — nothing persisted (drop = rollback).
    global_kernel().ensure_generation_unchanged(entry_generation)?;
    tx.commit().map_err(|e| {
        if is_busy(&e) {
            conflict("BUSY:commit")
        } else {
            TrustError::op_failed(format!("refund commit: {e}"))
        }
    })?;
    Ok(ok)
}

/// Native atomic refund (MOBI-DEFECT-F barrier). Fail-closed: any conflict
/// rolls back the whole transaction and returns a typed `OperationFailed`
/// `CODE[:detail]` the caller maps without side effects.
#[tauri::command]
pub fn refund_sale_atomic(
    app: tauri::AppHandle,
    req: RefundRequest,
) -> Result<RefundOk, TrustError> {
    authorize_and_execute("refund_sale_atomic", Capability::OperationalWrites, |ctx| {
        use tauri::Manager;
        let app_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| TrustError::op_failed(format!("app dir: {e}")))?;
        let mac_key = match resolve_manifest_mac_key(&app_dir) {
            ManifestMac::Key(k) => Some(k),
            ManifestMac::Unavailable(_) => None,
        };
        let mut conn = open_live_db(&app)?;
        // Native identity injection (TIER-B): the enrolled device id is
        // loaded here, inside the trust boundary — the client string in
        // `req.local_device_id` is only ever compared, never used.
        let identity =
            crate::trust_core::device_identity::ensure_loaded(&conn, &app_dir)?;
        let generation = ctx.generation;
        let clock = production_monotonic();
        let ok = apply_refund(&mut conn, &req, mac_key.as_deref(), generation, &identity, &clock)?;
        // Keystore head advance is best-effort (verify heals forward — same
        // contract as audit_append): it must never fail a committed refund.
        // Skipped here by design: the head re-seal path needs a live keystore
        // write after commit; the next keyed verify heals it forward.
        Ok(ok)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    fn test_schema(conn: &Connection) {
        conn.execute_batch(
            r#"
            CREATE TABLE products (
                id TEXT PRIMARY KEY, stock REAL NOT NULL DEFAULT 0, category TEXT,
                cost_price REAL DEFAULT 0, idempotency_key TEXT DEFAULT '',
                sync_status TEXT DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT DEFAULT ''
            );
            CREATE TABLE transactions (
                id TEXT PRIMARY KEY, receipt_number TEXT NOT NULL, customer_id TEXT,
                subtotal REAL NOT NULL, discount_total REAL DEFAULT 0, total REAL NOT NULL,
                cost_total REAL DEFAULT 0, profit REAL DEFAULT 0, profit_margin REAL DEFAULT 0,
                pricing_tier TEXT DEFAULT 'Retail', payment_method TEXT DEFAULT 'Especes',
                cash_tendered REAL DEFAULT 0, change_due REAL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'COMPLETED', created_at TEXT NOT NULL,
                json_payload TEXT NOT NULL, device_id TEXT DEFAULT 'local',
                idempotency_key TEXT DEFAULT '', sync_status TEXT DEFAULT 'pending',
                updated_at TEXT DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
                deleted INTEGER DEFAULT 0, ledger_cogs_total REAL, shift_id TEXT,
                original_transaction_id TEXT, is_refund INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE device_identity (
                device_id TEXT PRIMARY KEY, public_key_hex TEXT NOT NULL,
                private_key_enc BLOB NOT NULL, enrolled_at TEXT NOT NULL, status TEXT NOT NULL
            );
            CREATE TABLE transaction_items (
                id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, product_id TEXT NOT NULL,
                quantity INTEGER NOT NULL, applied_price REAL NOT NULL, discount REAL DEFAULT 0,
                imei_number TEXT, cost_price REAL DEFAULT 0,
                unit_price_charged REAL DEFAULT 0, unit_cost_at_sale REAL DEFAULT 0,
                discount_amount REAL DEFAULT 0, line_profit REAL DEFAULT 0,
                json_payload TEXT NOT NULL, device_id TEXT DEFAULT 'local',
                idempotency_key TEXT DEFAULT '', sync_status TEXT DEFAULT 'pending',
                created_at TEXT DEFAULT '', updated_at TEXT DEFAULT '',
                deleted INTEGER DEFAULT 0, version INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE inventory_ledger (
                id TEXT PRIMARY KEY, product_id TEXT NOT NULL, delta INTEGER NOT NULL,
                reason TEXT NOT NULL, ref_type TEXT, ref_id TEXT, device_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT DEFAULT 'pending',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE stock_batches (
                batch_id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
                quantity_remaining REAL NOT NULL DEFAULT 0, unit_cost REAL NOT NULL DEFAULT 0,
                received_at TEXT NOT NULL, purchase_order_id TEXT,
                device_id TEXT NOT NULL DEFAULT 'local', idempotency_key TEXT NOT NULL UNIQUE,
                sync_status TEXT DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER DEFAULT 0
            );
            CREATE TABLE customers (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL,
                json_payload TEXT NOT NULL, updated_at TEXT NOT NULL,
                idempotency_key TEXT DEFAULT '', created_at TEXT DEFAULT ''
            );
            CREATE TABLE customer_debts (
                id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, customer_name TEXT NOT NULL,
                type TEXT NOT NULL, amount REAL NOT NULL, balance_after REAL NOT NULL,
                receipt_number TEXT, payment_method TEXT, notes TEXT, recorded_by TEXT,
                created_at TEXT NOT NULL, json_payload TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
                deleted INTEGER DEFAULT 0
            );
            CREATE TABLE credit_vouchers (
                id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE,
                initial_amount REAL NOT NULL, remaining_amount REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'ACTIVE', updated_at TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1, deleted INTEGER DEFAULT 0
            );
            CREATE TABLE cash_sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'OPEN');
            CREATE TABLE cash_movements (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
                amount INTEGER NOT NULL, reason TEXT NOT NULL, cashier_name TEXT,
                created_at TEXT NOT NULL, json_payload TEXT NOT NULL
            );
            CREATE TABLE sync_outbox (
                rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                idempotency_key TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT, last_error TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                device_id TEXT, device_signature TEXT, seq_no INTEGER, envelope TEXT
            );
            CREATE TABLE refund_dedup (
                ticket_id TEXT NOT NULL, items_hash TEXT NOT NULL, refund_id TEXT NOT NULL,
                created_at TEXT NOT NULL, PRIMARY KEY (ticket_id, items_hash)
            );
            CREATE TABLE security_audit_logs (
                id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, user TEXT NOT NULL,
                action TEXT NOT NULL, details TEXT NOT NULL, requires_pin INTEGER DEFAULT 0
            );
            CREATE TABLE audit_chain (
                event_id TEXT PRIMARY KEY, prev_hash TEXT NOT NULL, entry_hash TEXT NOT NULL
            );
            CREATE TRIGGER trg_refund_requires_dedup
            BEFORE INSERT ON transactions
            WHEN NEW.is_refund = 1
             AND COALESCE(NEW.sync_status, '') <> 'synced'
             AND NOT EXISTS (SELECT 1 FROM refund_dedup WHERE refund_id = NEW.id)
            BEGIN
              SELECT RAISE(ABORT, 'REFUND_BYPASS: refunds must go through refund_sale_atomic');
            END;
            "#,
        )
        .unwrap();
    }

    fn seed_ticket(conn: &Connection) {
        conn.execute("INSERT INTO products (id) VALUES ('P1')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO transactions (id, receipt_number, subtotal, total, status, created_at, json_payload, version, device_id, shift_id) \
             VALUES ('TKT-1', 'REC-1', 200, 200, 'COMPLETED', '2026-01-01T00:00:00Z', '{}', 1, 'dev-A', 'S1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, json_payload) \
             VALUES ('TI-0', 'TKT-1', 'P1', 2, 100, '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, \
             device_id, idempotency_key, created_at, updated_at) \
             VALUES ('B1', 'P1', 10, 50, '2026-01-01T00:00:00Z', 'local', 'bk-B1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO customers (id, name, phone, json_payload, updated_at) \
             VALUES ('C1', 'Karim', '', '{}', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO credit_vouchers (id, code, initial_amount, remaining_amount, status, updated_at) \
             VALUES ('V1', 'BON1', 1000, 700, 'ACTIVE', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO cash_sessions (id, status) VALUES ('S1', 'OPEN')", [])
            .unwrap();
    }

    fn base_req() -> RefundRequest {
        RefundRequest {
            ticket_id: "TKT-1".into(),
            refund_id: "REF-H1".into(),
            items_hash: "H1".into(),
            receipt_number: "AVOIR-H1".into(),
            method: "Espèces".into(),
            customer_id: Some("C1".into()),
            subtotal: 200,
            discount_total: 0,
            total_net: 200,
            cost_total: 100,
            pricing_tier: "Retail".into(),
            payment_method: "Especes".into(),
            cash_tendered: 150,
            change_due: 0,
            cash_tendered_net: 200,
            online: true,
            local_device_id: "dev-A".into(),
            active_shift_id: "S1".into(),
            supervisor: None,
            created_at: "2026-01-02T00:00:00Z".into(),
            refund_payload: "{\"id\":\"REF-H1\",\"isRefund\":true,\"originalTransactionId\":\"TKT-1\",\
                \"refundMethod\":\"Espèces\",\"cashDisbursed\":150,\"total\":200}"
                .into(),
            original_outbox_payload: "{\"id\":\"TKT-1\"}".into(),
            device_id: "d1".into(),
            lines: vec![RefundItemIn {
                id: "RI-1".into(),
                product_id: "P1".into(),
                quantity: 2,
                applied_price: 100,
                unit_price_charged: 100,
                unit_cost_at_sale: 50,
                discount_amount: 0,
                line_profit: 50,
                imei_number: None,
                item_key: "IK-1".into(),
                item_payload: "{}".into(),
            }],
            deltas: vec![LedgerDeltaIn {
                id: "LED-1".into(),
                key: "LEDK-1".into(),
                product_id: "P1".into(),
                delta: 2,
            }],
            batches: vec![BatchRestoreIn {
                batch_id: Some("B1".into()),
                product_id: "P1".into(),
                quantity: 2.0,
                unit_cost: 50,
                fallback_batch_id: "FB-1".into(),
                fallback_key: "FBK-1".into(),
            }],
            imeis: vec![],
            debt: Some(DebtReliefIn {
                entry_id: "PAYREL-1".into(),
                customer_id: "C1".into(),
                customer_name: "Karim".into(),
                amount: 100,
                receipt_number: "AVOIR-H1".into(),
                payment_method: "Crédit Client".into(),
                notes: "relief".into(),
                recorded_by: "Manager".into(),
            }),
            voucher: Some(VoucherRestoreIn {
                code: "BON1".into(),
                amount: 200,
            }),
            cash_move: Some(CashMoveIn {
                id: "MOV-1".into(),
                session_id: "S1".into(),
                amount: 150,
                reason: "ALLOCATION test".into(),
                cashier_name: "Manager".into(),
            }),
            audit: AuditIn {
                action: "Remboursement / Avoir Émis".into(),
                details: "Avoir #AVOIR-H1 pour Ticket #REC-1".into(),
                user: "Manager".into(),
                requires_pin: true,
                device_id: Some("d1".into()),
                ip_address: None,
            },
        }
    }

    fn gen() -> u64 {
        crate::trust_core::ipc_authorizer::global_kernel().get().1
    }

    /// Test identity: enrolls the given id under an injected wrap key — never
    /// the OS keychain (the production `ensure_loaded` path is keychain
    /// backed; unit tests must not touch it). Enrolling a foreign id models
    /// a second terminal's keystore against the same replicated ticket.
    fn test_identity(conn: &Connection, device_id: &str) -> DeviceIdentity {
        crate::trust_core::device_identity::ensure_enrolled(
            conn,
            device_id,
            &zeroize::Zeroizing::new([1u8; 32]),
        )
        .expect("test enrollment")
    }

    /// Fixed fake clock: the anchor adopts the real wall on first boot and
    /// the frozen mono keeps it there, so live supervisor timestamps pass
    /// while every instant stays deterministic per test.
    fn test_clock() -> crate::trust_core::clocks::ManualClock {
        crate::trust_core::clocks::ManualClock::new(1_000_000)
    }

    fn run(
        conn: &mut Connection,
        req: &RefundRequest,
    ) -> Result<RefundOk, crate::trust_core::ipc_authorizer::TrustError> {
        let id = test_identity(conn, "dev-A");
        apply_refund(conn, req, None, gen(), &id, &test_clock())
    }

    #[allow(dead_code)]
    fn run_as(
        conn: &mut Connection,
        req: &RefundRequest,
        device_id: &str,
    ) -> Result<RefundOk, crate::trust_core::ipc_authorizer::TrustError> {
        let id = test_identity(conn, device_id);
        apply_refund(conn, req, None, gen(), &id, &test_clock())
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn full_refund_commits_every_effect_once() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        let req = base_req();
        let ok = run(&mut conn, &req).expect("refund must commit");
        assert_eq!(ok.ticket_status, "REFUNDED");
        assert_eq!(ok.ticket_version, 2);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM transactions WHERE id = 'REF-H1'"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM refund_dedup"), 1);
        assert_eq!(
            count(&conn, "SELECT SUM(quantity) FROM transaction_items WHERE transaction_id = 'REF-H1'"),
            2
        );
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM inventory_ledger"), 1);
        let qty: f64 = conn
            .query_row(
                "SELECT quantity_remaining FROM stock_batches WHERE batch_id = 'B1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(qty, 12.0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM customer_debts"), 1);
        let remaining: f64 = conn
            .query_row(
                "SELECT remaining_amount FROM credit_vouchers WHERE code = 'BON1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 900.0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM cash_movements"), 1);
        assert!(count(&conn, "SELECT COUNT(*) FROM sync_outbox") >= 3);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM audit_chain"), 1);
        // Trigger passes for the native path.
        assert_eq!(count(&conn, "SELECT is_refund FROM transactions WHERE id = 'REF-H1'"), 1);
    }

    #[test]
    fn exact_replay_reports_already_refunded_with_zero_side_effects() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        let req = base_req();
        run(&mut conn, &req).unwrap();
        let err = run(&mut conn, &req).expect_err("replay must fail");
        let msg = format!("{err:?}");
        assert!(msg.contains("ALREADY_REFUNDED"), "got: {msg}");
        assert!(msg.contains("REF-H1"), "got: {msg}");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM transactions WHERE is_refund = 1"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM inventory_ledger"), 1);
        let qty: f64 = conn
            .query_row(
                "SELECT quantity_remaining FROM stock_batches WHERE batch_id = 'B1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(qty, 12.0);
    }

    #[test]
    fn different_hash_over_refund_is_stopped_by_quota_and_rolls_back_dedup() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        let mut req = base_req();
        // Partial: 1 of 2.
        req.refund_id = "REF-P1".into();
        req.items_hash = "HP1".into();
        req.lines[0].quantity = 1;
        req.lines[0].id = "RI-P1".into();
        req.lines[0].item_key = "IK-P1".into();
        req.deltas[0].delta = 1;
        req.deltas[0].id = "LED-P1".into();
        req.deltas[0].key = "LEDK-P1".into();
        req.batches[0].quantity = 1.0;
        req.debt.as_mut().unwrap().entry_id = "PAYREL-P1".into();
        req.cash_move.as_mut().unwrap().id = "MOV-P1".into();
        let ok = run(&mut conn, &req).unwrap();
        assert_eq!(ok.ticket_status, "PARTIALLY_REFUNDED");
        // Same items, different method (different hash): quota must stop it.
        let mut greedy = base_req();
        greedy.refund_id = "REF-P2".into();
        greedy.items_hash = "HP2".into();
        greedy.method = "CARD".into();
        greedy.lines[0].id = "RI-P2".into();
        greedy.lines[0].item_key = "IK-P2".into();
        greedy.deltas[0].id = "LED-P2".into();
        greedy.deltas[0].key = "LEDK-P2".into();
        greedy.debt.as_mut().unwrap().entry_id = "PAYREL-P2".into();
        // drop cash/voucher to isolate the quota verdict
        greedy.cash_move = None;
        greedy.voucher = None;
        let err = run(&mut conn, &greedy).expect_err("must stop");
        let msg = format!("{err:?}");
        assert!(msg.contains("REFUND_EXCEEDS"), "got: {msg}");
        // Loser dedup row rolled back with the rest.
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM refund_dedup WHERE items_hash = 'HP2'"
            ),
            0
        );
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM transactions WHERE is_refund = 1"), 1);
    }

    #[test]
    fn joint_cash_payouts_cannot_exceed_tendered() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // Ticket tendered 150 net cash; first refund disburses the full 150.
        let mut first = base_req();
        first.cash_tendered_net = 150;
        run(&mut conn, &first).unwrap();
        // A concurrent refund of the REMAINING... nothing remains (full
        // refund), so craft a partial-cap scenario instead: fresh ticket.
        let mut conn2 = Connection::open_in_memory().unwrap();
        test_schema(&conn2);
        seed_ticket(&conn2);
        // Partial 1 of 2, cash 150 of tendered 150.
        let mut p1 = base_req();
        p1.refund_id = "REF-C1".into();
        p1.items_hash = "HC1".into();
        p1.method = "Espèces".into();
        p1.lines[0].quantity = 1;
        p1.lines[0].id = "RI-C1".into();
        p1.lines[0].item_key = "IK-C1".into();
        p1.deltas[0].delta = 1;
        p1.deltas[0].id = "LED-C1".into();
        p1.deltas[0].key = "LEDK-C1".into();
        p1.batches[0].quantity = 1.0;
        p1.cash_tendered_net = 150;
        p1.refund_payload = "{\"id\":\"REF-C1\",\"isRefund\":true,\"originalTransactionId\":\"TKT-1\",\
            \"refundMethod\":\"Espèces\",\"cashDisbursed\":150,\"total\":200}"
            .into();
        p1.debt.as_mut().unwrap().entry_id = "PAYREL-C1".into();
        p1.cash_move.as_mut().unwrap().id = "MOV-C1".into();
        run(&mut conn2, &p1).unwrap();
        // Second partial (last unit) asks for 100 more cash: cap is spent.
        let mut p2 = base_req();
        p2.refund_id = "REF-C2".into();
        p2.items_hash = "HC2".into();
        p2.method = "Espèces".into();
        p2.lines[0].quantity = 1;
        p2.lines[0].id = "RI-C2".into();
        p2.lines[0].item_key = "IK-C2".into();
        p2.deltas[0].delta = 1;
        p2.deltas[0].id = "LED-C2".into();
        p2.deltas[0].key = "LEDK-C2".into();
        p2.batches[0].quantity = 1.0;
        p2.cash_tendered_net = 150;
        p2.cash_move.as_mut().unwrap().id = "MOV-C2".into();
        p2.cash_move.as_mut().unwrap().amount = 100;
        p2.debt.as_mut().unwrap().entry_id = "PAYREL-C2".into();
        let err = run(&mut conn2, &p2).expect_err("cap");
        assert!(
            format!("{err:?}").contains("CASH_CAP_EXCEEDED"),
            "got: {err:?}"
        );
        assert_eq!(
            count(&conn2, "SELECT COUNT(*) FROM transactions WHERE is_refund = 1"),
            1
        );
    }

    #[test]
    fn voided_ticket_refuses_with_zero_side_effects() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        conn.execute("UPDATE transactions SET status = 'VOIDED' WHERE id = 'TKT-1'", [])
            .unwrap();
        let err = run(&mut conn, &base_req()).expect_err("voided");
        assert!(format!("{err:?}").contains("ORIGINAL_VOIDED"));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM refund_dedup"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM transactions WHERE is_refund = 1"), 0);
    }

    #[test]
    fn late_voucher_conflict_rolls_back_everything() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // A peer spends the voucher after our snapshot: CAS misses.
        conn.execute("UPDATE credit_vouchers SET remaining_amount = 100 WHERE code = 'BON1'", [])
            .unwrap();
        let mut req = base_req();
        // restore 200 onto 100 with initial 1000 -> target 300, but the test
        // simulates a concurrent spend by pre-setting remaining below; force
        // the mismatch by shrinking initial too:
        conn.execute("UPDATE credit_vouchers SET initial_amount = 150 WHERE code = 'BON1'", [])
            .unwrap();
        req.voucher.as_mut().unwrap().amount = 200;
        // target = min(150, 100+200) = 150; then simulate peer move: none —
        // instead break the CAS by changing remaining after read? Cannot
        // interleave single-threaded: emulate by pointing at a missing code.
        req.voucher.as_mut().unwrap().code = "BON-MISSING".into();
        let err = run(&mut conn, &req).expect_err("voucher");
        assert!(format!("{err:?}").contains("VOUCHER_MISSING"));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM transactions WHERE is_refund = 1"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM inventory_ledger"), 0);
        let qty: f64 = conn
            .query_row(
                "SELECT quantity_remaining FROM stock_batches WHERE batch_id = 'B1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(qty, 10.0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM customer_debts"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM refund_dedup"), 0);
        assert_eq!(
            conn.query_row(
                "SELECT status FROM transactions WHERE id = 'TKT-1'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "COMPLETED"
        );
    }

    /// Offline-shaped request: same-device, same-shift, small cash (under
    /// both the default bucket and the PIN threshold unless overridden).
    fn offline_req() -> RefundRequest {
        let mut req = base_req();
        req.online = false;
        req.local_device_id = "dev-A".into();
        req.active_shift_id = "S1".into();
        req
    }

    fn set_policy(conn: &Connection, key: &str, value_json: &str) {
        conn.execute(
            "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, 't') \
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
            [key, value_json],
        )
        .unwrap();
    }

    #[test]
    fn offline_foreign_ticket_rejected() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // Different terminal (its own keystore enrolled dev-B, ticket says
        // dev-A): hard deny on affinity, zero side effects.
        let mut foreign = offline_req();
        foreign.local_device_id = "dev-B".into();
        let id_b = test_identity(&conn, "dev-B");
        let err = apply_refund(&mut conn, &foreign, None, gen(), &id_b, &test_clock())
            .expect_err("foreign");
        let msg = format!("{err:?}");
        assert!(msg.contains("OFFLINE_FOREIGN_TICKET"), "got: {msg}");
        assert!(msg.contains("dev-A") && msg.contains("dev-B"), "got: {msg}");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM refund_dedup"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM transactions WHERE is_refund = 1"), 0);
        // Same terminal, wrong shift: same verdict (past-shift tickets need a
        // server claim, which cannot exist while disconnected).
        let mut shift = offline_req();
        shift.active_shift_id = "S9".into();
        let err = run(&mut conn, &shift).expect_err("shift");
        assert!(format!("{err:?}").contains("OFFLINE_FOREIGN_TICKET"));
        // Legacy authorship ('legacy' device): denies fail-closed, exactly
        // like the TS `offlineRefundVerdict` (empty origin never matches).
        conn.execute("UPDATE transactions SET device_id = 'legacy' WHERE id = 'TKT-1'", [])
            .unwrap();
        let err = run(&mut conn, &offline_req()).expect_err("legacy");
        assert!(format!("{err:?}").contains("OFFLINE_FOREIGN_TICKET"));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM transactions WHERE is_refund = 1"), 0);
    }

    #[test]
    fn offline_same_terminal_ticket_allowed() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // Small cash (150 < 5000 threshold, bucket empty): no supervisor
        // block needed, commits through dedup + quota like the online path.
        let ok = run(&mut conn, &offline_req()).expect("own-ticket");
        assert_eq!(ok.ticket_status, "REFUNDED");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM transactions WHERE is_refund = 1"), 1);
    }

    #[test]
    fn offline_cash_cap_enforcement() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        set_policy(&conn, "policy.offline_cash_refund_limit", "200");
        // Partial 1 of 2, cash 150 of bucket 200: commits. The tendered
        // basis is wide (10000) so only the shift bucket can bind below.
        let mut p1 = offline_req();
        p1.refund_id = "REF-O1".into();
        p1.items_hash = "HO1".into();
        p1.total_net = 10000;
        p1.cash_tendered_net = 10000;
        p1.refund_payload = "{\"id\":\"REF-O1\",\"isRefund\":true,\"originalTransactionId\":\"TKT-1\",\
            \"refundMethod\":\"Espèces\",\"cashDisbursed\":150,\"total\":10000}"
            .into();
        p1.lines[0].quantity = 1;
        p1.lines[0].id = "RI-O1".into();
        p1.lines[0].item_key = "IK-O1".into();
        p1.deltas[0].delta = 1;
        p1.deltas[0].id = "LED-O1".into();
        p1.deltas[0].key = "LEDK-O1".into();
        p1.batches[0].quantity = 1.0;
        p1.debt.as_mut().unwrap().entry_id = "PAYREL-O1".into();
        p1.cash_move.as_mut().unwrap().id = "MOV-O1".into();
        run(&mut conn, &p1).expect("first partial");
        // Second partial asks 150 more: 150 + 150 > 200 → clean abort.
        let mut p2 = offline_req();
        p2.refund_id = "REF-O2".into();
        p2.items_hash = "HO2".into();
        p2.total_net = 10000;
        p2.cash_tendered_net = 10000;
        p2.refund_payload = "{\"id\":\"REF-O2\",\"isRefund\":true,\"originalTransactionId\":\"TKT-1\",\
            \"refundMethod\":\"Espèces\",\"cashDisbursed\":150,\"total\":10000}"
            .into();
        p2.lines[0].quantity = 1;
        p2.lines[0].id = "RI-O2".into();
        p2.lines[0].item_key = "IK-O2".into();
        p2.deltas[0].delta = 1;
        p2.deltas[0].id = "LED-O2".into();
        p2.deltas[0].key = "LEDK-O2".into();
        p2.batches[0].quantity = 1.0;
        p2.debt.as_mut().unwrap().entry_id = "PAYREL-O2".into();
        p2.cash_move.as_mut().unwrap().id = "MOV-O2".into();
        let err = run(&mut conn, &p2).expect_err("cap");
        let msg = format!("{err:?}");
        assert!(msg.contains("OFFLINE_CASH_CAP_EXCEEDED"), "got: {msg}");
        assert!(msg.contains("150:200:150"), "got: {msg}");
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM transactions WHERE is_refund = 1"),
            1
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM refund_dedup WHERE items_hash = 'HO2'"),
            0
        );
        // Synced rows leave the bucket: after the first refund syncs, the
        // same second partial fits again (only PENDING rows accumulate).
        conn.execute(
            "UPDATE transactions SET sync_status = 'synced' WHERE id = 'REF-O1'",
            [],
        )
        .unwrap();
        let ok = run(&mut conn, &p2).expect("after sync");
        assert_eq!(ok.ticket_status, "REFUNDED");
    }

    #[test]
    fn supervisor_pin_bypass_prevention() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // Large offline cash (6000 > 5000 threshold, inside the 10000 bucket
        // and a 6000 tendered cap) with NO supervisor block: hard deny.
        let mut big = offline_req();
        big.total_net = 6000;
        big.cash_tendered_net = 6000;
        big.cash_move.as_mut().unwrap().amount = 6000;
        big.refund_payload = "{\"id\":\"REF-H1\",\"isRefund\":true,\"originalTransactionId\":\"TKT-1\",\
            \"refundMethod\":\"Espèces\",\"cashDisbursed\":6000,\"total\":6000}"
            .into();
        let err = run(&mut conn, &big).expect_err("no supervisor");
        assert!(format!("{err:?}").contains("SUPERVISOR_PIN_REQUIRED"));
        // Forged-but-empty block: same gate (there is no override path that
        // pays cash without a real pre-submit `pin_verify` pass).
        big.supervisor = Some(SupervisorIn {
            user_id: "".into(),
            verified_at: "".into(),
        });
        let err = run(&mut conn, &big).expect_err("empty block");
        assert!(format!("{err:?}").contains("SUPERVISOR_PIN_REQUIRED"));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM transactions WHERE is_refund = 1"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM refund_dedup"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM inventory_ledger"), 0);
        // Real block (post-`pin_verify` authorization): commits, and the
        // supervisor identity rides the in-txn audit row. Timestamp is live
        // (a fixed fixture would age past the 120 s window).
        big.supervisor = Some(SupervisorIn {
            user_id: "mgr-1".into(),
            verified_at: crate::trust_core::audit_append::chrono_iso8601_utc(),
        });
        let ok = run(&mut conn, &big).expect("authorized");
        assert_eq!(ok.ticket_status, "REFUNDED");
        let details: String = conn
            .query_row(
                "SELECT details FROM security_audit_logs WHERE id = 'AUD-REF-H1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(details.contains("mgr-1"), "audit must name the supervisor");
    }

    #[test]
    fn tampered_device_id_rejection() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // Falsified client claim vs enrolled dev-A: immediate abort, no lock,
        // no write, no dedup row.
        let mut evil = base_req();
        evil.local_device_id = "dev-EVE".into();
        let err = run(&mut conn, &evil).expect_err("spoof");
        let msg = format!("{err:?}");
        assert!(msg.contains("DEVICE_IDENTITY_SPOOFED"), "got: {msg}");
        assert!(msg.contains("dev-EVE") && msg.contains("dev-A"), "got: {msg}");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM refund_dedup"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM transactions WHERE is_refund = 1"), 0);
        // Empty claim (legacy caller): proceeds with the native id.
        let mut legacy = base_req();
        legacy.local_device_id = "".into();
        assert_eq!(run(&mut conn, &legacy).expect("legacy").ticket_status, "REFUNDED");
    }

    #[test]
    fn supervisor_authorization_staleness() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // Large offline cash needs a supervisor block; a 3-minute-old one is
        // replayed evidence, not live authorization — full rollback.
        let mut stale = offline_req();
        stale.total_net = 6000;
        stale.cash_tendered_net = 6000;
        stale.cash_move.as_mut().unwrap().amount = 6000;
        stale.refund_payload = "{\"id\":\"REF-H1\",\"isRefund\":true,\"originalTransactionId\":\"TKT-1\",\
            \"refundMethod\":\"Espèces\",\"cashDisbursed\":6000,\"total\":6000}"
            .into();
        stale.supervisor = Some(SupervisorIn {
            user_id: "mgr-1".into(),
            verified_at: "2001-01-01T00:00:00.000Z".into(),
        });
        let err = run(&mut conn, &stale).expect_err("stale");
        assert!(
            format!("{err:?}").contains("SUPERVISOR_AUTH_EXPIRED"),
            "got: {err:?}"
        );
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM transactions WHERE is_refund = 1"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM refund_dedup"), 0);
    }

    #[test]
    fn outbox_mutation_cryptographic_signature() {
        use crate::trust_core::device_identity::{refund_envelope, verify_signature};
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // Online small refund (no supervisor needed): commit, then verify
        // the outbox row carries a valid Ed25519 signature over the
        // positional envelope, checkable with the enrolled public key.
        let req = base_req();
        run(&mut conn, &req).expect("commit");
        let (dev, sig): (String, String) = conn
            .query_row(
                "SELECT device_id, device_signature FROM sync_outbox WHERE idempotency_key = 'REF-H1' AND entity_type = 'order'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("signed outbox row");
        assert_eq!(dev, "dev-A");
        let (pubkey,): (String,) = conn
            .query_row(
                "SELECT public_key_hex FROM device_identity WHERE device_id = 'dev-A'",
                [],
                |r| Ok((r.get(0)?,)),
            )
            .expect("enrolled pubkey");
        let (seq,): (i64,) = conn
            .query_row(
                "SELECT seq_no FROM sync_outbox WHERE idempotency_key = 'REF-H1' AND entity_type = 'order'",
                [],
                |r| Ok((r.get(0)?,)),
            )
            .expect("sequenced outbox row");
        assert_eq!(seq, 1);
        let envelope = refund_envelope("TKT-1", "REF-H1", 200, "dev-A", seq, 0);
        verify_signature(&pubkey, &envelope, &sig).expect("valid signature");
        // Wrong device bytes must NOT verify (envelope binds the author).
        let forged = refund_envelope("TKT-1", "REF-H1", 200, "dev-EVE", seq, 0);
        assert!(verify_signature(&pubkey, &forged, &sig).is_err());
        // Reordered sequence must NOT verify either (replay/reorder guard).
        let reordered = refund_envelope("TKT-1", "REF-H1", 200, "dev-A", seq + 1, 0);
        assert!(verify_signature(&pubkey, &reordered, &sig).is_err());
    }

    fn real_now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap()
    }

    #[test]
    fn clock_rollback_aborts_refund() {
        use crate::trust_core::time_anchor;
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // Plant a high-water an hour above any wall this test can observe:
        // the host clock is, by definition, rolled back behind it.
        let hw = real_now_ms() + 3_600_000;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS time_anchor (id INTEGER PRIMARY KEY CHECK (id = 1), \
             high_water_ms INTEGER NOT NULL, high_water_mono_ms INTEGER NOT NULL, \
             last_server_ms INTEGER NOT NULL DEFAULT 0, last_server_nonce TEXT NOT NULL DEFAULT '', \
             skew_ms INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO time_anchor (id, high_water_ms, high_water_mono_ms, updated_at) VALUES (1, ?1, 0, 't')",
            [hw],
        )
        .unwrap();
        let err = run(&mut conn, &base_req()).expect_err("rollback");
        let msg = format!("{err:?}");
        assert!(msg.contains("SYSTEM_CLOCK_REGRESSION"), "got: {msg}");
        assert!(msg.contains(&hw.to_string()), "got: {msg}");
        // Zero ledger mutation; the planted mark is untouched.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM transactions WHERE is_refund = 1"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM refund_dedup"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM inventory_ledger"), 0);
        assert_eq!(
            time_anchor::current_high_water(&conn),
            Some(hw),
            "advance must not run on the fault path"
        );
    }

    #[test]
    fn monotonic_outbox_sequence_increment() {
        use crate::trust_core::device_identity::{refund_envelope, verify_signature};
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // Third unit on the ticket so three qty-1 partials all fit quota.
        conn.execute(
            "INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, json_payload, idempotency_key) \
             VALUES ('TI-P1b', 'TKT-1', 'P1', 1, 100, '{}', 'TIK-P1b')",
            [],
        )
        .unwrap();
        // Non-cash method: sequencing is orthogonal to payout rails.
        let partial = |tag: &str, n: i64| {
            let mut r = base_req();
            r.online = true;
            r.method = "Avoir Client".into();
            r.cash_move = None;
            r.refund_id = format!("REF-S{n}");
            r.items_hash = format!("HS{n}");
            r.receipt_number = format!("AVOIR-S{n}");
            r.lines[0].quantity = 1;
            r.lines[0].id = format!("RI-S{n}");
            r.lines[0].item_key = format!("IK-S{n}");
            r.deltas[0].delta = 1;
            r.deltas[0].id = format!("LED-S{n}");
            r.deltas[0].key = format!("LEDK-S{n}");
            r.batches[0].quantity = 1.0;
            r.debt.as_mut().unwrap().entry_id = format!("PAYREL-S{n}");
            r.refund_payload = format!(
                "{{\"id\":\"REF-S{n}\",\"isRefund\":true,\"originalTransactionId\":\"TKT-1\",\
                 \"refundMethod\":\"Avoir Client\",\"cashDisbursed\":0,\"total\":200}}"
            );
            let _ = tag;
            r
        };
        for n in 1..=3i64 {
            run(&mut conn, &partial("", n)).expect("sequential partial");
        }
        let seqs: Vec<(String, i64)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT idempotency_key, seq_no FROM sync_outbox WHERE entity_type = 'order' AND idempotency_key LIKE 'REF-S%' ORDER BY seq_no",
                )
                .unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .map(|r| r.expect("row decode"))
                .collect()
        };
        assert_eq!(
            seqs.iter().map(|(_, s)| *s).collect::<Vec<_>>(),
            vec![1, 2, 3],
            "strictly sequential under one lock: {seqs:?}"
        );
        let (pubkey,): (String,) = conn
            .query_row(
                "SELECT public_key_hex FROM device_identity WHERE device_id = 'dev-A'",
                [],
                |r| Ok((r.get(0)?,)),
            )
            .unwrap();
        for (id, seq) in &seqs {
            let sig: String = conn
                .query_row(
                    "SELECT device_signature FROM sync_outbox WHERE idempotency_key = ?1 AND entity_type = 'order'",
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            let num: i64 = id.strip_prefix("REF-S").unwrap().parse().unwrap();
            let envelope = refund_envelope("TKT-1", id, 200, "dev-A", *seq, 0);
            verify_signature(&pubkey, &envelope, &sig)
                .expect("each signature covers its own seq");
            assert_eq!(*seq, num, "seq tracks commit order");
        }
    }

    #[test]
    fn supervisor_future_date_rejection() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // Approval 45 s ahead of now: forged-or-skewed, never honored —
        // distinct code from anchor rollback, same full rollback.
        let mut fwd = offline_req();
        fwd.total_net = 6000;
        fwd.cash_tendered_net = 6000;
        fwd.cash_move.as_mut().unwrap().amount = 6000;
        fwd.refund_payload = "{\"id\":\"REF-H1\",\"isRefund\":true,\"originalTransactionId\":\"TKT-1\",\
            \"refundMethod\":\"Espèces\",\"cashDisbursed\":6000,\"total\":6000}"
            .into();
        fwd.supervisor = Some(SupervisorIn {
            user_id: "mgr-1".into(),
            verified_at: crate::trust_core::time_anchor::iso_utc_ms(real_now_ms() + 45_000),
        });
        let err = run(&mut conn, &fwd).expect_err("future-dated");
        assert!(
            format!("{err:?}").contains("SUPERVISOR_AUTH_FUTURE_DATED"),
            "got: {err:?}"
        );
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM transactions WHERE is_refund = 1"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM refund_dedup"), 0);
    }

    #[test]
    fn concurrent_threads_one_winner_one_already_refunded() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let dir = std::env::temp_dir().join(format!(
            "mobi-refund-race-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("race.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "journal_mode", "WAL").unwrap();
            test_schema(&conn);
            seed_ticket(&conn);
        }
        let barrier = Arc::new(Barrier::new(2));
        let req = base_req();
        let generation = gen();
        // Both threads enroll-or-load the SAME device row: the enrollment
        // race itself is part of what this test proves converges.
        let spawn_racer = |path: std::path::PathBuf,
                           barrier: Arc<Barrier>,
                           req: RefundRequest| {
            std::thread::spawn(move || {
                // Set the busy timeout BEFORE flipping to WAL; and route setup
                // failures through the barrier rather than panicking first. A
                // pre-barrier panic (e.g. SQLITE_BUSY on the journal-mode
                // change) leaves the peer stuck on the barrier forever while
                // this thread holds the shared serial-test mutex, hanging every
                // other serialized test in the workspace.
                let setup = (|path: &std::path::Path| -> Result<Connection, String> {
                    let conn = Connection::open(path).map_err(|e| e.to_string())?;
                    conn.busy_timeout(std::time::Duration::from_millis(5000))
                        .map_err(|e| e.to_string())?;
                    conn.pragma_update(None, "journal_mode", "WAL")
                        .map_err(|e| e.to_string())?;
                    Ok(conn)
                })(&path);
                barrier.wait();
                let mut conn = setup.map_err(|e| format!("setup: {e}"))?;
                let id = test_identity(&conn, "dev-A");
                let clock = test_clock();
                apply_refund(&mut conn, &req, None, generation, &id, &clock)
                    .map(|o| o.ticket_status)
                    .map_err(|e| format!("{e:?}"))
            })
        };
        let a = spawn_racer(path.clone(), barrier.clone(), req.clone());
        let b = spawn_racer(path.clone(), barrier, req);
        let ra = a.join().unwrap();
        let rb = b.join().unwrap();
        let (ok, err) = match (ra, rb) {
            (Ok(s), Err(e)) => (s, e),
            (Err(e), Ok(s)) => (s, e),
            other => panic!("expected exactly one winner, got {other:?}"),
        };
        assert_eq!(ok, "REFUNDED");
        assert!(err.contains("ALREADY_REFUNDED"), "loser got: {err}");
        let conn = Connection::open(&path).unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM transactions WHERE is_refund = 1"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM inventory_ledger"), 1);
        let qty: f64 = conn
            .query_row(
                "SELECT quantity_remaining FROM stock_batches WHERE batch_id = 'B1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(qty, 12.0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM customer_debts"), 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}


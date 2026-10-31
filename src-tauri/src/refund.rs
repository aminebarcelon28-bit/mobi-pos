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
//! `RESTOCK_REASON_REQUIRED` (write-off line without its note),
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
    /// Original sale-line identity (`${saleTxnId}-item-${idx}` — the same
    /// derivation `sale_batch_allocations.sale_item_id` uses). Pins the line
    /// so a multi-line same-SKU ticket keeps per-line restitution state.
    /// Absent for pre-rebuild callers (product-keyed fallback only).
    pub sale_item_id: Option<String>,
    /// Zero-based index of the line in the original ticket (legacy
    /// `-item-N` fallback when `sale_item_id` is absent).
    pub line_index: Option<i64>,
    /// 'restock' | 'defective'. Absent = restock (the pre-rebuild behavior
    /// for every line that used to travel).
    pub condition: Option<String>,
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
    /// Value reversed by this refund: the funding returned to the customer
    /// PLUS any trade-in value restored to the wallet. This is what the row's
    /// `total` column carries, so the column and the JSON payload agree
    /// (G-11) and revenue lanes read the full reversal. Optional for wire
    /// compatibility: absent falls back to `total_net`. `total_net` stays the
    /// funding basis for the zero-value guard, the profit identity and the
    /// signed envelope.
    #[serde(default)]
    pub value_reversed: Option<i64>,
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
    /// Original-ticket JSON used as the merge FALLBACK base only when the
    /// durable row payload is unparseable — normally the base is the row
    /// payload itself (read under the write lock, so concurrent tabs'
    /// `refundedItems` accumulate instead of being dropped). The merged bytes
    /// (status/version/refundedItems) are what the row UPDATE, the outbox row
    /// and `RefundOk.ticket_payload` carry.
    pub original_outbox_payload: String,
    pub device_id: String,
    pub lines: Vec<RefundItemIn>,
    pub deltas: Vec<LedgerDeltaIn>,
    pub batches: Vec<BatchRestoreIn>,
    pub imeis: Vec<String>,
    /// IMEIs released as DEFECTIVE (quarantine): unlinked from the sale and
    /// landed `status='defective'`; restocked IMEIs ride `imeis` and land
    /// `status='in_stock'`. Both append ownership events in the same commit
    /// (`RETURN_IN` / `RETURN_DEFECTIVE`).
    #[serde(default)]
    pub defective_imeis: Vec<String>,
    /// Mandatory note when a line goes to write-off (mirrors the TS gate:
    /// `RESTOCK_REASON_REQUIRED` before submit). Recorded on the
    /// `defective_returns` rows.
    #[serde(default)]
    pub defect_note: Option<String>,
    /// Loyalty clawback result computed by the shared TS math from the
    /// original sale's immutable snapshots. Persisted here (points column +
    /// payload buckets) so the authority can reproduce the balance; this
    /// command never invents loyalty numbers.
    #[serde(default)]
    pub customer_points_after: Option<i64>,
    #[serde(default)]
    pub customer_point_buckets_json: Option<String>,
    pub debt: Option<DebtReliefIn>,
    pub voucher: Option<VoucherRestoreIn>,
    /// Avoir Client leg (DZD). Credited to the customer's wallet as an
    /// INCREMENT applied inside this transaction (balance + the
    /// `creditDeltaDzd` ledger emission that makes it a destination of record).
    /// Optional, so cash and card refunds stay byte-identical.
    #[serde(default)]
    pub wallet_credit: Option<i64>,
    /// Milestone clawback (positive DZD to REVOKE from the wallet) applied in the
    /// same transaction as the credit. The refund's Avoir leg and the revocation
    /// are two movements: the leg is part of the refund total, the revocation is
    /// the loyalty correction the refund un-earns.
    #[serde(default)]
    pub wallet_clawback: Option<i64>,
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
    /// Original-ticket JSON AFTER the in-txn merge (new status + accumulated
    /// `refundedItems` with line identity) — the exact bytes written to the
    /// row and enqueued to the outbox. Read-back hydration consumes these.
    pub ticket_payload: String,
    /// Post-refund customer debt aggregate recomputed from the durable
    /// `customer_debts` ledger inside this transaction (None when the refund
    /// carried no customer).
    pub customer_debt_after: Option<i64>,
    /// Wallet balance after the Avoir leg applied inside this transaction
    /// (None when the refund carried no wallet leg). The client mirrors this
    /// value; it never computes the credit itself.
    pub customer_store_credit_after: Option<i64>,
    /// Debt relief actually applied (≤ requested; clamped to the live
    /// balance with a warning when the requested share exceeded it).
    pub debt_relief_applied: i64,
    /// Loyalty points after clawback (echo of the persisted value).
    pub customer_points_after: Option<i64>,
    /// RESTOCKED-only cost credited back (Σ unit_cost_at_sale × qty over
    /// non-defective lines). Defective lines are NOT credited — their cost
    /// stays consumed on the original sale, and the loss is represented by
    /// `defective_returns` + the unrecovered COGS, never a second expense.
    pub recovered_cogs: i64,
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
        match l.condition.as_deref() {
            None | Some("restock") | Some("defective") => {}
            Some(other) => {
                return Err(conflict(&format!(
                    "INVALID:line condition must be restock|defective (got {other})"
                )))
            }
        }
    }
    for v in [
        req.subtotal,
        req.discount_total,
        req.total_net,
        req.value_reversed.unwrap_or(0),
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
    // Write-off lines quarantine physical stock: the reason note is the audit
    // evidence for that movement (same gate as the TS `RESTOCK_REASON_REQUIRED`
    // pre-submit check — native re-verifies instead of trusting the caller).
    if req.lines.iter().any(|l| l.condition.as_deref() == Some("defective"))
        && req
            .defect_note
            .as_deref()
            .map(str::trim)
            .map(str::is_empty)
            .unwrap_or(true)
    {
        return Err(conflict("RESTOCK_REASON_REQUIRED"));
    }
    // Loyalty clawback rides the customer row it belongs to.
    if (req.customer_points_after.is_some() || req.customer_point_buckets_json.is_some())
        && req
            .customer_id
            .as_deref()
            .map(str::trim)
            .map(str::is_empty)
            .unwrap_or(true)
    {
        return Err(conflict("INVALID:loyalty clawback requires the customer"));
    }
    // Debt relief must target the same customer the refund was written for.
    if let (Some(rc), Some(d)) = (req.customer_id.as_deref(), req.debt.as_ref()) {
        if rc.trim() != d.customer_id.trim() {
            return Err(conflict("INVALID:debt customer mismatch"));
        }
    }
    // Avoir leg: no wallet can be credited without a recipient. Enforced HERE,
    // at the money boundary, so no caller can bypass it (TS pre-checks are UX).
    if (req.wallet_credit.unwrap_or(0) > 0 || req.wallet_clawback.unwrap_or(0) > 0)
        && req
            .customer_id
            .as_deref()
            .map(str::trim)
            .map(str::is_empty)
            .unwrap_or(true)
    {
        return Err(conflict("AVOIR_RECIPIENT_REQUIRED"));
    }
    if let Some(s) = &req.supervisor {
        if s.user_id.trim().is_empty() || s.verified_at.trim().len() < 10 {
            return Err(conflict("SUPERVISOR_PIN_REQUIRED"));
        }
    }
    // Re-review finding (b): the clawback is a DEBIT. It must belong to the
    // ticket's own customer, otherwise any caller could zero an unrelated wallet.
    // validate() is DB-free: the clawback needs a customer here; ownership is
    // proven against the ticket row inside the transaction.
    if req.wallet_clawback.unwrap_or(0) > 0
        && req
            .customer_id
            .as_deref()
            .map(str::trim)
            .map(str::is_empty)
            .unwrap_or(true)
    {
        return Err(conflict("AVOIR_RECIPIENT_REQUIRED"));
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

/// Table-existence probe for OPTIONAL tables (`defective_returns` v116,
/// `imei_events` v123). Absent = skip the optional evidence lane like the
/// pre-rebuild builds did — never fail the money over an evidence table.
fn has_table(tx: &Transaction, table: &str) -> Result<bool, TrustError> {
    // Internal constants at every call site — no caller input interpolated.
    tx.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |_| Ok(()),
    )
    .map(|_| true)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(false),
        other => Err(TrustError::op_failed(format!("table probe: {other}"))),
    })
}

/// FNV-1a 32-bit over `parts.join('|')` — byte-for-byte the JS
/// `deterministicId` derivation for ASCII inputs, so ids for rows the TS lane
/// can equally write (quarantine ledger markers) converge via ON CONFLICT.
fn deterministic_id(prefix: &str, parts: &[&str]) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in parts.join("|").bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{prefix}-{h:08X}")
}

/// `'defective'` is the ONLY write-off condition; absent (pre-rebuild caller)
/// means restock, exactly like the TS default normalization
/// (`cri.condition = cri.restock ? 'restock' : 'defective'`).
fn line_is_defective(l: &RefundItemIn) -> bool {
    matches!(l.condition.as_deref(), Some("defective"))
}

/// Canonical condition stamped on the merged `refundedItems` entries.
fn line_condition(l: &RefundItemIn) -> &'static str {
    if line_is_defective(l) {
        "defective"
    } else {
        "restock"
    }
}

/// Original sale-line identity: explicit `sale_item_id` wins; the legacy
/// `-item-N` derivation recovers it for callers that only carry the index.
fn line_identity(req: &RefundRequest, l: &RefundItemIn) -> Option<String> {
    l.sale_item_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| l.line_index.map(|i| format!("{}-item-{}", req.ticket_id, i)))
}

/// Live outstanding debt recomputed from the durable ledger (same convention
/// as `reconcileCustomerDebtFromLedger`: DEBT_ACQUIRED adds, PAYMENT_SETTLED
/// subtracts, clamped at zero; the row's `balance_after` is a projection and
/// is never trusted). INTEGER DZD end to end — the CAST mirrors the cash-cap
/// read so REAL-affinity columns can never leak float dust into money.
fn customer_ledger_balance(tx: &Transaction, customer_id: &str) -> Result<i64, TrustError> {
    tx.query_row(
        "SELECT COALESCE(SUM(CAST(CASE WHEN type = 'PAYMENT_SETTLED' THEN -amount ELSE amount END AS INTEGER)), 0) \
         FROM customer_debts WHERE customer_id = ?1 AND deleted = 0",
        [customer_id],
        |r| r.get(0),
    )
    .map(|v: i64| v.max(0))
    .map_err(|e| TrustError::op_failed(format!("debt balance: {e}")))
}

/// Idempotent customer parent stub (same shape as the TS fallback writer):
/// only creates rows the refund's own writes need; an existing row is
/// untouched. `uq_customers_idem` keeps the stub key unique per customer.
fn ensure_customer_stub(tx: &Transaction, id: &str, name: &str, now: &str) -> Result<(), TrustError> {
    tx.execute(
        "INSERT INTO customers (id, name, phone, json_payload, updated_at, idempotency_key, created_at) \
         VALUES (?1, ?2, '', '{}', ?3, 'stub-cust-' || ?1, ?3) ON CONFLICT(id) DO NOTHING",
        params![id, name, now],
    )
    .map_err(|e| map_rusqlite("customer stub", e))?;
    Ok(())
}

/// Read-merge-write for `customers.json_payload`: parses the durable payload
/// (unparseable → empty projection + surfaced warning), applies the patch and
/// stamps the NEXT customer version into the payload so column version and
/// payload version agree. Returns the exact bytes the caller must persist.
fn merge_customer_payload(
    tx: &Transaction,
    customer_id: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
    warnings: &mut Vec<String>,
) -> Result<String, TrustError> {
    let (raw, ver): (String, i64) = tx
        .query_row(
            "SELECT json_payload, COALESCE(version, 1) FROM customers WHERE id = ?1",
            [customer_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => conflict("INVALID:customer row missing"),
            other => TrustError::op_failed(format!("customer payload read: {other}")),
        })?;
    let mut base: serde_json::Map<String, serde_json::Value> = match serde_json::from_str(&raw) {
        Ok(serde_json::Value::Object(m)) => m,
        _ => {
            let t = raw.trim();
            if !t.is_empty() && t != "{}" {
                warnings.push(format!(
                    "[refund] Payload client {customer_id} illisible — fusion minimale de la projection."
                ));
            }
            serde_json::Map::new()
        }
    };
    for (k, v) in patch {
        base.insert(k.clone(), v.clone());
    }
    base.insert("version".to_string(), serde_json::Value::from(ver + 1));
    Ok(serde_json::Value::Object(base).to_string())
}

/// Fill ACTIF installment plans of one customer FIFO (oldest plan first,
/// entries by seq) from an applied payment — the same allocation the TS
/// payment lane runs (`applyPaymentToPlanEntries`), executed natively so a
/// refund's debt reduction cannot leave the plan schedule stale when the
/// caller dies mid-post-commit work. Plan metadata LAGS the money trail by
/// design: the ledger row and aggregate are already committed above; an
/// interrupted fill is continued by the next payment instead of double
/// counting. `paid_at` is stamped only when an entry becomes fully paid.
fn fill_debt_plans_fifo(
    tx: &Transaction,
    customer_id: &str,
    amount: i64,
    now: &str,
) -> Result<(), TrustError> {
    if amount <= 0 || !has_table(tx, "debt_plans")? || !has_table(tx, "debt_plan_entries")? {
        return Ok(());
    }
    let mut plan_ids: Vec<String> = Vec::new();
    {
        let mut stmt = tx
            .prepare(
                "SELECT id FROM debt_plans WHERE customer_id = ?1 AND status = 'ACTIF' AND deleted = 0 \
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|e| TrustError::op_failed(format!("plans prepare: {e}")))?;
        let rows = stmt
            .query_map([customer_id], |r| r.get::<_, String>(0))
            .map_err(|e| TrustError::op_failed(format!("plans read: {e}")))?;
        for r in rows {
            plan_ids.push(r.map_err(|e| TrustError::op_failed(format!("plan row: {e}")))?);
        }
    }
    let mut remainder = amount;
    for plan_id in plan_ids {
        if remainder <= 0 {
            break;
        }
        let mut entries: Vec<(String, i64, i64)> = Vec::new();
        {
            // CAST keeps float dust from legacy rows out of money arithmetic;
            // entries are INTEGER DZD by contract.
            let mut stmt = tx
                .prepare(
                    "SELECT id, CAST(amount AS INTEGER), CAST(paid_amount AS INTEGER) \
                     FROM debt_plan_entries WHERE plan_id = ?1 AND deleted = 0 ORDER BY seq ASC, id ASC",
                )
                .map_err(|e| TrustError::op_failed(format!("plan entries prepare: {e}")))?;
            let rows = stmt
                .query_map([&plan_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(|e| TrustError::op_failed(format!("plan entries read: {e}")))?;
            for r in rows {
                entries.push(r.map_err(|e| TrustError::op_failed(format!("entry row: {e}")))?);
            }
        }
        let mut plan_fully_paid = !entries.is_empty();
        for (entry_id, amount_due, paid) in &entries {
            let due = (*amount_due).max(0);
            let had = (*paid).max(0);
            if remainder <= 0 {
                if had < due {
                    plan_fully_paid = false;
                }
                continue;
            }
            let capacity = due - had;
            if capacity <= 0 {
                continue;
            }
            let take = capacity.min(remainder);
            let new_paid = had + take;
            remainder -= take;
            tx.execute(
                "UPDATE debt_plan_entries SET paid_amount = ?2, \
                 paid_at = CASE WHEN ?2 >= amount THEN ?3 ELSE paid_at END \
                 WHERE id = ?1 AND deleted = 0",
                params![entry_id, new_paid, now],
            )
            .map_err(|e| map_rusqlite("debt plan entry fill", e))?;
            if new_paid < due {
                plan_fully_paid = false;
            }
        }
        if plan_fully_paid {
            tx.execute(
                "UPDATE debt_plans SET status = 'SOLDE', updated_at = ?2 \
                 WHERE id = ?1 AND status = 'ACTIF' AND deleted = 0",
                params![plan_id, now],
            )
            .map_err(|e| map_rusqlite("debt plan close", e))?;
        }
    }
    Ok(())
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
    crate::db::tune(&conn).map_err(|e| TrustError::op_failed(format!("refund tune: {e}")))?;
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
        (true, true) => "SELECT status, version, device_id, shift_id, json_payload, receipt_number, created_at FROM transactions WHERE id = ?1",
        (true, false) => "SELECT status, version, device_id, NULL, json_payload, receipt_number, created_at FROM transactions WHERE id = ?1",
        _ => "SELECT status, version, NULL, NULL, json_payload, receipt_number, created_at FROM transactions WHERE id = ?1",
    };
    #[allow(clippy::type_complexity)]
    let (status, version, ticket_device, ticket_shift, ticket_payload_raw, ticket_receipt, ticket_created_at): (
        String,
        i64,
        Option<String>,
        Option<String>,
        String,
        String,
        String,
    ) = tx
        .query_row(
            ticket_sql,
            [&req.ticket_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
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

    // 4b. Recovered COGS (RESTOCKED-only): Σ unit_cost_at_sale × qty over
    //     non-defective lines, integer DZD, native-computed — never trusted
    //     from the caller. Defective lines keep their cost consumed on the
    //     original sale: the loss is the unrecovered COGS + the
    //     `defective_returns` quarantine trail, never a second credit (the
    //     refund row's `profit` = net refund − recovered COGS is the net
    //     burden the reports read).
    let mut recovered_cogs: i64 = 0;
    for l in &req.lines {
        if !line_is_defective(l) {
            recovered_cogs = recovered_cogs
                .saturating_add(l.unit_cost_at_sale.saturating_mul(l.quantity));
        }
    }
    if req.cost_total != recovered_cogs {
        warnings.push(format!(
            "[refund] cost_total client ({}) ≠ COGS récupéré natif ({recovered_cogs}) — valeur native retenue.",
            req.cost_total
        ));
    }
    let profit_net = req.total_net.saturating_sub(recovered_cogs);

    // 4c. Original-ticket payload merge. The base is the DURABLE row payload
    //     read under this write lock, so `refundedItems` committed by a
    //     concurrent tab are accumulated, never dropped by a stale client
    //     snapshot. The client snapshot is the fallback base ONLY when the
    //     row payload is unparseable (surfaced as a warning). Status and
    //     version are stamped to match the CAS below; the merged bytes are
    //     what the row UPDATE, the outbox row and the read-back all carry.
    let mut merged: serde_json::Value = match serde_json::from_str::<serde_json::Value>(&ticket_payload_raw) {
        Ok(v) if v.is_object() => v,
        _ => {
            warnings.push(
                "[refund] Payload ticket original illisible — fusion depuis l'instantané client."
                    .to_string(),
            );
            serde_json::from_str::<serde_json::Value>(&req.original_outbox_payload)
                .ok()
                .filter(|v| v.is_object())
                .ok_or_else(|| conflict("INVALID:original outbox payload must be JSON"))?
        }
    };
    if let Some(obj) = merged.as_object_mut() {
        obj.insert("status".to_string(), serde_json::Value::from(new_status));
        obj.insert("version".to_string(), serde_json::Value::from(version + 1));
        let mut items: Vec<serde_json::Value> = obj
            .get("refundedItems")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for l in &req.lines {
            let sid = line_identity(req, l);
            let dup = items.iter().any(|e| {
                e.get("refundId").and_then(|v| v.as_str()) == Some(req.refund_id.as_str())
                    && e.get("saleItemId").and_then(|v| v.as_str()) == sid.as_deref()
                    && e.get("productId").and_then(|v| v.as_str()) == Some(l.product_id.as_str())
                    && e.get("condition").and_then(|v| v.as_str()) == Some(line_condition(l))
                    && e.get("imeiNumber").and_then(|v| v.as_str()) == l.imei_number.as_deref()
            });
            if dup {
                continue;
            }
            items.push(serde_json::json!({
                "saleItemId": sid,
                "lineIndex": l.line_index,
                "productId": l.product_id,
                "quantity": l.quantity,
                "imeiNumber": l.imei_number,
                "condition": line_condition(l),
                "refundId": req.refund_id,
                "refundReceiptNumber": req.receipt_number,
            }));
        }
        obj.insert("refundedItems".to_string(), serde_json::Value::Array(items));
        // Alias fields the slice historically stamped on the outbox payload.
        // Filled only when absent — the row's own columns win for readers.
        if !obj.contains_key("receipt_number") {
            obj.insert(
                "receipt_number".to_string(),
                serde_json::Value::from(ticket_receipt.as_str()),
            );
        }
        if !obj.contains_key("created_at") {
            obj.insert(
                "created_at".to_string(),
                serde_json::Value::from(ticket_created_at.as_str()),
            );
        }
    }
    let merged_str = merged.to_string();

    // 5. Status flip with version CAS as an invariant assertion: the version
    //    was read under this same lock, so 0 rows means a writer bypassed
    //    the lock. Re-read to report VOIDED vs duplicate precisely. The
    //    merged payload travels in the same write, so the row's JSON can
    //    never lag its status.
    let flipped = tx
        .execute(
            "UPDATE transactions SET status = ?1, version = version + 1, updated_at = ?2, sync_status = 'pending', \
             json_payload = ?3 WHERE id = ?4 AND version = ?5 AND status <> 'VOIDED'",
            params![new_status, now, merged_str, req.ticket_id, version],
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

    // 4b. Value cap (re-review findings 3 and 8): the refund can never be worth
    //     more than the ticket still has refundable. Basis: the sum of the
    //     ticket's tenders (a credit leg legitimately makes a refund exceed the
    //     net `total`), falling back to `total`.
    let row_total: f64 = tx
        .query_row("SELECT COALESCE(total,0) FROM transactions WHERE id = ?1", [&req.ticket_id], |r| r.get(0))
        .unwrap_or(0.0);
    let payload_value: f64 = serde_json::from_str::<serde_json::Value>(&ticket_payload_raw)
        .ok()
        .map(|v| {
            let tenders: f64 = v
                .get("tenders")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|t| t.get("amount").and_then(|n| n.as_f64())).sum())
                .unwrap_or(0.0);
            if tenders > 0.0 {
                tenders
            } else {
                v.get("total").and_then(|n| n.as_f64()).unwrap_or(0.0)
            }
        })
        .unwrap_or(0.0);
    let ticket_value = payload_value.max(row_total);
    let already_value: f64 = tx
        .query_row(
            "SELECT COALESCE(SUM(total),0) FROM transactions WHERE original_transaction_id = ?1 AND is_refund = 1",
            [&req.ticket_id],
            |r| r.get(0),
        )
        .map_err(|e| TrustError::op_failed(format!("refund value sum: {e}")))?;
    let requested_value = req.value_reversed.unwrap_or(req.total_net) as f64;
    if ticket_value > 0.0 && requested_value > (ticket_value - already_value).max(0.0) + 0.5 {
        return Err(conflict(&format!(
            "REFUND_EXCEEDS_VALUE:requested={requested_value}:remaining={}",
            (ticket_value - already_value).max(0.0)
        )));
    }

    // 6. Refund row. The dedup row (step 2) satisfies
    //    `trg_refund_requires_dedup`. `shift_id` / `ledger_cogs_total` /
    //    `restored_cogs` may be absent on pre-heal DBs — probe and degrade
    //    like the TS writer.
    let has_shift = has_column(tx, "transactions", "shift_id")?;
    let has_ledger_cogs = has_column(tx, "transactions", "ledger_cogs_total")?;
    let has_restored_cogs = has_column(tx, "transactions", "restored_cogs")?;
    // The owning shift is the CURRENT shift (contra-revenue to this period;
    // verified OPEN at step 13 before any cash movement is recorded). The
    // drawer movement names it for cash payouts; non-cash refunds anchor to
    // the asserted active shift so the Z-period sees every refund row.
    let shift_id: Option<&str> = req
        .cash_move
        .as_ref()
        .map(|c| c.session_id.trim())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let s = req.active_shift_id.trim();
            (!s.is_empty()).then_some(s)
        });
    let mut cols = "id, receipt_number, customer_id, subtotal, discount_total, total, \
        cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, \
        change_due, status, created_at, json_payload, device_id, idempotency_key, \
        sync_status, updated_at, version, deleted, original_transaction_id, is_refund"
        .to_string();
    if has_ledger_cogs {
        cols.push_str(", ledger_cogs_total");
    }
    if has_restored_cogs {
        cols.push_str(", restored_cogs");
    }
    if has_shift {
        cols.push_str(", shift_id");
    }
    let placeholders: Vec<String> = (1..=cols.split(',').count())
        .map(|i| format!("?{i}"))
        .collect();
    // The row's `total` is the VALUE REVERSED (funding + trade restore); the
    // funding basis (`total_net`) still drives the zero-value guard and the
    // profit identity below.
    let total_reversed = req.value_reversed.unwrap_or(req.total_net);
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
            &total_reversed,
            &recovered_cogs,
            &profit_net,
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
        if has_restored_cogs {
            p.push(&recovered_cogs);
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

    // 7b. Line identity (v127): stamp the original sale-line id on the refund
    //     line (per-line refund state becomes computable in SQL) and fill the
    //     ORIGINAL row's own identity once (joins on `sale_item_id`, same
    //     derivation `sale_batch_allocations.sale_item_id` already uses).
    //     Probed — pre-heal DBs degrade to the product-keyed state as before.
    if has_column(tx, "transaction_items", "sale_item_id")? {
        for l in &req.lines {
            let Some(sid) = line_identity(req, l) else { continue };
            tx.execute(
                "UPDATE transaction_items SET sale_item_id = ?1 WHERE id = ?2",
                params![sid, l.id],
            )
            .map_err(|e| map_rusqlite("refund line identity", e))?;
            tx.execute(
                "UPDATE transaction_items SET sale_item_id = ?1 \
                 WHERE id = ?1 AND (sale_item_id IS NULL OR sale_item_id = '')",
                [&sid],
            )
            .map_err(|e| map_rusqlite("original line identity", e))?;
        }
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
    //     lane, which collects these as warnings). Released units land
    //     `in_stock` (restock) or `defective` (quarantine) when the v127
    //     status column exists, and append the ownership event in the SAME
    //     commit — id formula mirrors TS `imeiTrustEventId` verbatim
    //     (`imev|{kind}|order|{refundId}|{imei}`); a truly missing event row
    //     is insert-or-ignore so retries converge.
    let has_imei_status = has_column(tx, "imei_records", "status")?;
    let has_imei_events = has_table(tx, "imei_events")?;
    let releases = req
        .imeis
        .iter()
        .map(|i| {
            (
                i.as_str(),
                "RETURN_IN",
                "in_stock",
                "Retour en stock (remboursement)",
            )
        })
        .chain(req.defective_imeis.iter().map(|i| {
            (
                i.as_str(),
                "RETURN_DEFECTIVE",
                "defective",
                "Retour défectueux — quarantaine (remboursement)",
            )
        }));
    for (imei_raw, kind, status, note) in releases {
        let imei = imei_raw.trim();
        if imei.is_empty() {
            continue;
        }
        let n = if has_imei_status {
            tx.execute(
                "UPDATE imei_records SET sale_transaction_id = NULL, sold_at = NULL, status = ?2, version = version + 1 WHERE imei = ?1",
                params![imei, status],
            )
            .map_err(|e| map_rusqlite("imei release", e))?
        } else {
            tx.execute(
                "UPDATE imei_records SET sale_transaction_id = NULL, sold_at = NULL, version = version + 1 WHERE imei = ?1",
                [imei],
            )
            .map_err(|e| map_rusqlite("imei release", e))?
        };
        if n != 1 {
            warnings.push(format!(
                "[refund] IMEI {imei} introuvable dans SQLite — vérification manuelle."
            ));
            continue;
        }
        if has_imei_events {
            tx.execute(
                "INSERT OR IGNORE INTO imei_events (id, imei, kind, ref_type, ref_id, at, actor, note) \
                 VALUES (?1, ?2, ?3, 'order', ?4, ?5, '', ?6)",
                params![
                    format!("imev|{kind}|order|{}|{imei}", req.refund_id),
                    imei,
                    kind,
                    req.refund_id,
                    now,
                    note,
                ],
            )
            .map_err(|e| map_rusqlite("imei event", e))?;
        }
    }

    // 10b. Defective write-off trail: one `defective_returns` row per
    //      write-off line (the quarantine list's reader contract) plus a
    //      ZERO-delta ledger marker (`ADJUST` / `DEFECTIVE_QUARANTINE` — the
    //      legacy lane's exact vocabulary and deterministic id, so the two
    //      lanes converge via ON CONFLICT). These units never re-enter
    //      inventory: no stock increment, no batch restitution, and no stock
    //      recompute for them (the cached SUM is untouched by a 0 delta).
    if req.lines.iter().any(line_is_defective) {
        let has_defective_table = has_table(tx, "defective_returns")?;
        for l in &req.lines {
            if !line_is_defective(l) {
                continue;
            }
            if has_defective_table {
                tx.execute(
                    "INSERT INTO defective_returns (id, product_id, product_name, imei, quantity, \
                     unit_cost, reason, sale_id, refund_id, device_id, idempotency_key, sync_status, \
                     version, created_at, updated_at, deleted) \
                     VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?1, 'pending', 1, ?10, ?10, 0) \
                     ON CONFLICT(id) DO NOTHING",
                    params![
                        format!("def-{}-{}", req.refund_id, l.item_key),
                        l.product_id,
                        l.imei_number,
                        l.quantity,
                        l.unit_cost_at_sale,
                        req.defect_note,
                        req.ticket_id,
                        req.refund_id,
                        req.device_id,
                        now,
                    ],
                )
                .map_err(|e| map_rusqlite("defective return insert", e))?;
            }
            let led_id = deterministic_id(
                "LED-DEF",
                &[&req.refund_id, &l.product_id, &l.quantity.to_string()],
            );
            tx.execute(
                "INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, \
                 device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version) \
                 VALUES (?1, ?2, 0, 'ADJUST', 'DEFECTIVE_QUARANTINE', ?3, ?4, ?1, 'pending', ?5, ?5, 0, 1) \
                 ON CONFLICT(id) DO NOTHING",
                params![led_id, l.product_id, req.refund_id, req.device_id, now],
            )
            .map_err(|e| map_rusqlite("quarantine marker", e))?;
        }
    }

    // 11. Debt relief as an authoritative ledger row. The applied amount is
    //     clamped to the LIVE balance recomputed from the ledger in this
    //     transaction (a stale client snapshot must never drive the ledger
    //     negative) and the clamp is SURFACED, never silent. The row keeps
    //     the caller's deterministic entry id so replays converge on the PK;
    //     the cached `customers.current_debt` aggregate is recomputed from
    //     the ledger, and ACTIF installment plans are filled FIFO in the
    //     same commit.
    let mut debt_relief_applied: i64 = 0;
    let mut customer_debt_after: Option<i64> = None;
    if let Some(d) = &req.debt {
        if d.amount <= 0 {
            return Err(conflict("INVALID:debt relief amount must be > 0"));
        }
        ensure_customer_stub(tx, &d.customer_id, &d.customer_name, now)?;
        let prior = customer_ledger_balance(tx, &d.customer_id)?;
        let applied = d.amount.min(prior);
        if applied < d.amount {
            warnings.push(format!(
                "[refund] Réduction de dette plafonnée: demandé {} DA, appliqué {applied} DA (solde réel {prior} DA).",
                d.amount
            ));
        }
        let balance_after = (prior - applied).max(0);
        debt_relief_applied = applied;
        if applied > 0 {
            let debt_json = serde_json::json!({
                "id": d.entry_id, "customerId": d.customer_id, "customerName": d.customer_name,
                "type": "PAYMENT_SETTLED", "amount": applied, "balanceAfter": balance_after,
                "receiptNumber": d.receipt_number, "paymentMethod": d.payment_method,
                "notes": d.notes, "recordedBy": d.recorded_by, "createdAt": now,
            })
            .to_string();
            if let Err(e) = tx.execute(
                "INSERT INTO customer_debts (id, customer_id, customer_name, type, amount, balance_after, \
                 receipt_number, payment_method, notes, recorded_by, created_at, json_payload, version, updated_at, deleted) \
                 VALUES (?1, ?2, ?3, 'PAYMENT_SETTLED', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?10, 0)",
                params![
                    d.entry_id, d.customer_id, d.customer_name, applied, balance_after,
                    d.receipt_number, d.payment_method, d.notes, d.recorded_by, now, debt_json,
                ],
            ) {
                // Only a PK collision can fail here, which means this exact
                // relief already applied (replay) — converged, not an error.
                if is_unique_violation(&e) {
                    warnings.push(
                        "[refund] Dette : écriture déjà appliquée (rejouée) — ignorée.".to_string(),
                    );
                } else {
                    return Err(map_rusqlite("debt relief insert", e));
                }
            }
            // Cached aggregate + payload projection (single authority: the
            // ledger sum above; `current_debt` and the payload ride the same
            // write so they can never disagree).
            let mut patch = serde_json::Map::new();
            patch.insert(
                "currentDebt".to_string(),
                serde_json::Value::from(balance_after),
            );
            let merged_payload =
                merge_customer_payload(tx, &d.customer_id, &patch, &mut warnings)?;
            if has_column(tx, "customers", "current_debt")? {
                tx.execute(
                    "UPDATE customers SET current_debt = ?2, json_payload = ?3, updated_at = ?4, version = version + 1 WHERE id = ?1",
                    params![d.customer_id, balance_after, merged_payload, now],
                )
                .map_err(|e| map_rusqlite("customer debt aggregate", e))?;
            } else {
                tx.execute(
                    "UPDATE customers SET json_payload = ?2, updated_at = ?3, version = version + 1 WHERE id = ?1",
                    params![d.customer_id, merged_payload, now],
                )
                .map_err(|e| map_rusqlite("customer debt payload", e))?;
            }
            fill_debt_plans_fifo(tx, &d.customer_id, applied, now)?;
        }
        customer_debt_after = Some(customer_ledger_balance(tx, &d.customer_id)?);
    } else if let Some(cid) = req
        .customer_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        customer_debt_after = Some(customer_ledger_balance(tx, cid)?);
    }

    // 11b. Loyalty clawback persistence (single authority: the shared TS
    //      math already derived the post-refund points + buckets from the
    //      original sale's immutable snapshots; native REPLAYS that verdict
    //      onto the durable row and never invents numbers). Read-merge-write
    //      on the same customer payload as the debt patch above.
    let mut loyalty_applied: Option<i64> = None;
    if let Some(points) = req.customer_points_after {
        let Some(cust_id) = req
            .customer_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return Err(conflict("INVALID:loyalty clawback requires the customer"));
        };
        ensure_customer_stub(tx, cust_id, "", now)?;
        let points = points.max(0);
        let mut patch = serde_json::Map::new();
        patch.insert("loyaltyPoints".to_string(), serde_json::Value::from(points));
        if let Some(buckets_json) = req.customer_point_buckets_json.as_deref() {
            let buckets: serde_json::Value = serde_json::from_str(buckets_json)
                .map_err(|_| conflict("INVALID:point buckets must be JSON"))?;
            if !buckets.is_null() {
                patch.insert("pointBuckets".to_string(), buckets);
            }
        }
        let merged_payload = merge_customer_payload(tx, cust_id, &patch, &mut warnings)?;
        tx.execute(
            "UPDATE customers SET loyalty_points = ?2, json_payload = ?3, updated_at = ?4, version = version + 1 WHERE id = ?1",
            params![cust_id, points, merged_payload, now],
        )
        .map_err(|e| map_rusqlite("loyalty persist", e))?;
        loyalty_applied = Some(points);
    }

    // 11c. Avoir Client leg: the wallet credit is money, so it is applied HERE,
    //      inside this transaction, as an INCREMENT on the durable balance —
    //      never an absolute value computed by the client. The `creditDeltaDzd`
    //      ledger emission that makes the credit a destination of record is
    //      written in the same step. No recipient -> refuse and roll everything
    //      back (the refund row and the restock die with it).
    // Re-review finding (b): the clawback is a DEBIT and may only touch the
    // ticket's own customer, proven against the durable row (not the client).
    if req.wallet_clawback.unwrap_or(0) > 0 {
        let ticket_customer: Option<String> = tx
            .query_row(
                "SELECT customer_id FROM transactions WHERE id = ?1",
                [&req.ticket_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .unwrap_or(None)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let req_customer = req.customer_id.as_deref().map(str::trim).unwrap_or("");
        match ticket_customer {
            Some(tc) if !req_customer.is_empty() && tc == req_customer => {}
            _ => return Err(conflict("INVALID:clawback customer mismatch")),
        }
    }

    let mut wallet_applied: i64 = 0;
    let mut wallet_after: Option<i64> = None;
    let wallet_inc = req.wallet_credit.unwrap_or(0).max(0);
    let wallet_claw = req.wallet_clawback.unwrap_or(0).max(0);
    if wallet_inc > 0 || wallet_claw > 0 {
        let Some(cust_id) = req
            .customer_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return Err(conflict("AVOIR_RECIPIENT_REQUIRED"));
        };
        ensure_customer_stub(tx, cust_id, "", now)?;
        let current: f64 = tx
            .query_row(
                "SELECT COALESCE(store_credit, 0) FROM customers WHERE id = ?1",
                [cust_id],
                |r| r.get(0),
            )
            .map_err(|e| TrustError::op_failed(format!("wallet read: {e}")))?;
        // Two movements, one transaction: the Avoir leg (part of the refund
        // total) and the milestone revocation the refund un-earns. The balance is
        // floored at zero; every movement is written as a separate ledger row so
        // the clawback is auditable, not netted away.
        let after_credit = (current + wallet_inc as f64).max(0.0);
        // Re-review finding (a): only what the wallet actually holds can be
        // revoked. Emitting -wallet_claw while flooring the balance at zero would
        // make the ledger sum diverge from the balance, and peers re-derive the
        // scalar unclamped (genericApply re-materialises storeCredit from the
        // ledger) -> negative balances.
        let revoked = (wallet_claw as f64).min(after_credit).max(0.0);
        let next = (after_credit - revoked).max(0.0);
        let raw: String = tx
            .query_row(
                "SELECT json_payload FROM customers WHERE id = ?1",
                [cust_id],
                |r| r.get(0),
            )
            .map_err(|e| TrustError::op_failed(format!("wallet payload read: {e}")))?;
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}));
        let obj = parsed.as_object().cloned().unwrap_or_default();
        let mut ledger = obj
            .get("ledger")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if revoked > 0.0 {
            ledger.insert(
                0,
                serde_json::json!({
                    "id": format!("LEDGER-REF-CLAW-{}", req.refund_id),
                    "customerId": cust_id,
                    "timestamp": now,
                    "type": "adjustment",
                    "points": 0,
                    "balanceAfter": next,
                    "description": format!(
                        "Reprise Avoir Client ({} DA) - palier désacquise suite au retour Ticket #{}",
                        revoked, req.receipt_number
                    ),
                    "referenceId": req.ticket_id,
                    "creditDeltaDzd": -(revoked.round() as i64),
                    "performedBy": "Système Caisse",
                }),
            );
        }
        if wallet_inc > 0 {
            ledger.insert(
                0,
                serde_json::json!({
                    "id": format!("LEDGER-REF-{}", req.refund_id),
                    "customerId": cust_id,
                    "timestamp": now,
                    "type": "conversion",
                    "points": 0,
                    "balanceAfter": after_credit,
                    "description": format!(
                        "Émission Avoir Client ({} DA) suite au retour Ticket #{}",
                        wallet_inc, req.receipt_number
                    ),
                    "referenceId": req.ticket_id,
                    "creditDeltaDzd": wallet_inc,
                    "performedBy": "Système Caisse",
                }),
            );
        }
        let mut patch = serde_json::Map::new();
        patch.insert("storeCredit".to_string(), serde_json::Value::from(next));
        patch.insert("ledger".to_string(), serde_json::Value::Array(ledger));
        let merged_payload = merge_customer_payload(tx, cust_id, &patch, &mut warnings)?;
        // The wallet is money that must propagate: stamp the row pending when the
        // column exists so a crash before the client's outbox enqueue still has a
        // durable marker (the outbox row itself stays best-effort).
        let pending_sql = if has_column(tx, "customers", "sync_status")? {
            "UPDATE customers SET store_credit = ?2, json_payload = ?3, updated_at = ?4, sync_status = 'pending', version = version + 1 WHERE id = ?1"
        } else {
            "UPDATE customers SET store_credit = ?2, json_payload = ?3, updated_at = ?4, version = version + 1 WHERE id = ?1"
        };
        tx.execute(pending_sql, params![cust_id, next, merged_payload, now])
            .map_err(|e| map_rusqlite("wallet persist", e))?;
        wallet_applied = wallet_inc;
        wallet_after = Some(next.round() as i64);
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
    // The outbox row carries the SAME merged bytes that were written to the
    // durable row in step 5 — status/version/refundedItems included — so a
    // reader can never see the row and the queue disagree.
    tx.execute(
        "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
         VALUES (?1, 'order', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
         ON CONFLICT(idempotency_key) DO UPDATE SET operation = 'UPSERT', payload_json = excluded.payload_json, \
         status = 'pending', retry_count = 0, next_retry_at = NULL, last_error = NULL, updated_at = ?4",
        params![orig_key, req.ticket_id, merged_str, now],
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
        actor_id: None,
        idempotency_key: None,
    };
    let event_id = format!("AUD-{}", req.refund_id);
    append_in_tx(tx, mac_key, &audit_req, &event_id, now)
        .map_err(|e| TrustError::op_failed(format!("audit: {e:?}")))?;

    // 16. Money conservation BEFORE COMMIT: the refund's total must equal the sum
    //     of the legs written in THIS transaction. The card lane has no
    //     destination of record in this schema, so a refund carrying a card leg is
    //     scoped OUT explicitly (warned) instead of being silently accepted.
    {
        let card_leg_minor: i64 = serde_json::from_str::<serde_json::Value>(&req.refund_payload)
            .ok()
            .and_then(|v| v.get("funding").cloned())
            .and_then(|f| f.get("digital").and_then(|d| d.as_i64()))
            .unwrap_or(0);
        if card_leg_minor > 0 {
            warnings.push(format!(
                "[refund] rail carte sans destination de remboursement: {:.2} DA hors équilibre.",
                card_leg_minor as f64 / 100.0
            ));
        } else {
            let voucher_leg = req.voucher.as_ref().map(|v| v.amount).unwrap_or(0).max(0);
            let cash_leg = req.cash_tendered.max(0);
            let sum = cash_leg + wallet_applied + voucher_leg + debt_relief_applied;
            if total_reversed != sum {
                return Err(conflict(&format!(
                    "INVALID:refund legs do not balance (total {total_reversed} != cash {cash_leg} + wallet {wallet_applied} + voucher {voucher_leg} + debt {debt_relief_applied})"
                )));
            }
        }
    }

    Ok(RefundOk {
        refund_id: req.refund_id.clone(),
        receipt_number: req.receipt_number.clone(),
        ticket_status: new_status.to_string(),
        ticket_version: version + 1,
        warnings,
        ticket_payload: merged_str,
        customer_debt_after,
        customer_store_credit_after: wallet_after,
        debt_relief_applied,
        customer_points_after: loyalty_applied,
        recovered_cogs,
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
                original_transaction_id TEXT, is_refund INTEGER NOT NULL DEFAULT 0,
                restored_cogs REAL
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
                sale_item_id TEXT,
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
                idempotency_key TEXT DEFAULT '', created_at TEXT DEFAULT '',
                loyalty_points INTEGER NOT NULL DEFAULT 0, current_debt INTEGER, store_credit REAL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1, device_id TEXT DEFAULT 'legacy',
                sync_status TEXT DEFAULT 'pending', deleted INTEGER DEFAULT 0
            );
            CREATE TABLE customer_debts (
                id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, customer_name TEXT NOT NULL,
                type TEXT NOT NULL, amount REAL NOT NULL, balance_after REAL NOT NULL,
                receipt_number TEXT, payment_method TEXT, notes TEXT, recorded_by TEXT,
                created_at TEXT NOT NULL, json_payload TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
                deleted INTEGER DEFAULT 0
            );
            CREATE TABLE imei_records (
                imei TEXT PRIMARY KEY, product_id TEXT NOT NULL,
                purchase_order_id TEXT, sale_transaction_id TEXT, warranty_expires_at TEXT,
                received_at TEXT, sold_at TEXT, version INTEGER NOT NULL DEFAULT 1,
                status TEXT
            );
            CREATE TABLE imei_events (
                id TEXT PRIMARY KEY, imei TEXT NOT NULL, kind TEXT NOT NULL,
                ref_type TEXT, ref_id TEXT, at TEXT NOT NULL, actor TEXT, note TEXT
            );
            CREATE TABLE defective_returns (
                id TEXT PRIMARY KEY, product_id TEXT NOT NULL, product_name TEXT,
                imei TEXT, quantity REAL NOT NULL DEFAULT 0, unit_cost REAL NOT NULL DEFAULT 0,
                reason TEXT, sale_id TEXT, refund_id TEXT, device_id TEXT,
                idempotency_key TEXT UNIQUE, sync_status TEXT DEFAULT 'pending',
                version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '', deleted INTEGER DEFAULT 0
            );
            CREATE TABLE debt_plans (
                id TEXT PRIMARY KEY, customer_id TEXT NOT NULL,
                total_amount REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ACTIF',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                deleted INTEGER DEFAULT 0
            );
            CREATE TABLE debt_plan_entries (
                id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, seq INTEGER NOT NULL,
                due_date TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0,
                paid_amount REAL NOT NULL DEFAULT 0, paid_at TEXT,
                created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
                deleted INTEGER DEFAULT 0, UNIQUE (plan_id, seq)
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
            "INSERT INTO transactions (id, receipt_number, subtotal, total, cost_total, profit, status, created_at, json_payload, version, device_id, shift_id, idempotency_key) \
             VALUES ('TKT-1', 'REC-1', 200, 200, 100, 100, 'COMPLETED', '2026-01-01T00:00:00Z', '{\"id\":\"TKT-1\",\"receiptNumber\":\"REC-1\",\"items\":[{\"id\":\"TKT-1-item-0\"}]}', 1, 'dev-A', 'S1', 'tik-TKT-1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, json_payload) \
             VALUES ('TKT-1-item-0', 'TKT-1', 'P1', 2, 100, '{}')",
            [],
        )
        .unwrap();
        // Fixture consistency (D3 / value cap): the shared base_req funds 150 cash
        // + 200 voucher + 100 debt = 450, so the ticket must be worth 450 with the
        // same tenders, or the money cap and the leg-sum gate describe different
        // sales.
        conn.execute(
            "UPDATE transactions SET subtotal = 450, total = 450, json_payload = ?1 WHERE id = 'TKT-1'",
            [r#"{"id":"TKT-1","receiptNumber":"REC-1","total":450,"tenders":[{"method":"Espèces","amount":150},{"method":"Avoir Client","amount":200},{"method":"Crédit Client","amount":100}],"items":[{"id":"TKT-1-item-0"}],"customer":{"id":"C1"}}"#],
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
             VALUES ('C1', 'Salma', '', '{}', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        // The ticket was partially credit-funded: a live 500 DA debt the
        // refund's relief clamps against (the durable ledger is the truth).
        conn.execute(
            "INSERT INTO customer_debts (id, customer_id, customer_name, type, amount, balance_after, \
             receipt_number, payment_method, notes, recorded_by, created_at, json_payload, version, updated_at, deleted) \
             VALUES ('DEBT-SEED', 'C1', 'Salma', 'DEBT_ACQUIRED', 500, 500, 'REC-DEBT', 'Crédit Client', \
             'seed', 'seed', '2026-01-01T00:00:00Z', '{}', 1, '2026-01-01T00:00:00Z', 0)",
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
            value_reversed: Some(450),
            wallet_credit: None,
            wallet_clawback: None,
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
                sale_item_id: Some("TKT-1-item-0".into()),
                line_index: Some(0),
                condition: None,
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
            defective_imeis: vec![],
            defect_note: None,
            customer_points_after: None,
            customer_point_buckets_json: None,
            debt: Some(DebtReliefIn {
                entry_id: "PAYREL-1".into(),
                customer_id: "C1".into(),
                customer_name: "Salma".into(),
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
        // Seed debt (500) + the relief row (100) — applied against the LIVE
        // ledger balance, with the cached aggregate recomputed.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM customer_debts"), 2);
        let (applied, bal): (f64, f64) = conn
            .query_row(
                "SELECT amount, balance_after FROM customer_debts WHERE id = 'PAYREL-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((applied, bal), (100.0, 400.0));
        assert_eq!(
            count(&conn, "SELECT current_debt FROM customers WHERE id = 'C1'"),
            400
        );
        assert_eq!(ok.debt_relief_applied, 100);
        assert_eq!(ok.customer_debt_after, Some(400));
        // Recovered COGS: restocked-only, native-computed; the refund row
        // carries it as cost_total + restored_cogs, profit = R − G.
        assert_eq!(ok.recovered_cogs, 100);
        let (rt, rc, rp, rsc): (f64, f64, f64, f64) = conn
            .query_row(
                "SELECT total, cost_total, profit, restored_cogs FROM transactions WHERE id = 'REF-H1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!((rt, rc, rp, rsc), (450.0, 100.0, 100.0, 100.0));
        // Line identity: the refund line pins the original sale line; the
        // original row self-fills once (joins on `sale_item_id`).
        let sid: String = conn
            .query_row(
                "SELECT sale_item_id FROM transaction_items WHERE id = 'RI-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sid, "TKT-1-item-0");
        let osid: String = conn
            .query_row(
                "SELECT sale_item_id FROM transaction_items WHERE id = 'TKT-1-item-0'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(osid, "TKT-1-item-0");
        // Ticket payload merge: accumulated refundedItems + status/version,
        // and the returned read-back payload is the exact row bytes.
        let (payload,): (String,) = conn
            .query_row(
                "SELECT json_payload FROM transactions WHERE id = 'TKT-1'",
                [],
                |r| Ok((r.get(0)?,)),
            )
            .unwrap();
        assert_eq!(payload, ok.ticket_payload);
        let pv: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(pv["status"], "REFUNDED");
        assert_eq!(pv["version"], 2);
        assert_eq!(pv["refundedItems"][0]["saleItemId"], "TKT-1-item-0");
        assert_eq!(pv["refundedItems"][0]["condition"], "restock");
        assert_eq!(pv["refundedItems"][0]["refundId"], "REF-H1");
        assert_eq!(pv["receipt_number"], "REC-1");
        // The outbox row carries the SAME merged bytes as the row.
        let (ob,): (String,) = conn
            .query_row(
                "SELECT payload_json FROM sync_outbox WHERE idempotency_key = 'tik-TKT-1' AND entity_type = 'order'",
                [],
                |r| Ok((r.get(0)?,)),
            )
            .unwrap();
        assert_eq!(ob, ok.ticket_payload);
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
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM customer_debts WHERE type = 'PAYMENT_SETTLED'"
            ),
            0
        );
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
        // Two 450 refunds in sequence: fund the ticket for both.
        conn.execute("UPDATE transactions SET subtotal = 900, total = 900 WHERE id = 'TKT-1'", []).unwrap();
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
        // Three 450 refunds in sequence: fund the ticket for all three.
        conn.execute("UPDATE transactions SET subtotal = 1350, total = 1350 WHERE id = 'TKT-1'", []).unwrap();
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
        // Seed debt + the winner's relief row: exactly one relief committed.
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM customer_debts WHERE type = 'PAYMENT_SETTLED'"
            ),
            1
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // -----------------------------------------------------------------
    // Scenario A — multi-step partials with an order-level discount,
    // conserved to the Dinar, fourth attempt rejected.
    // -----------------------------------------------------------------

    /// One-refund helper: non-cash payout on shift S1, no debt/voucher —
    /// isolates quota + payload accumulation math.
    fn partial_req(
        ticket: &str,
        tag: &str,
        qty: i64,
        total: i64,
        applied_price: i64,
        sale_item_id: Option<&str>,
    ) -> RefundRequest {
        let mut r = base_req();
        r.ticket_id = ticket.into();
        r.refund_id = format!("REF-{tag}");
        r.items_hash = format!("H-{tag}");
        r.receipt_number = format!("AVOIR-{tag}");
        r.method = "Avoir Client".into();
        r.payment_method = "Avoir Client".into();
        r.subtotal = total;
        r.discount_total = 0;
        r.total_net = total;
        r.cost_total = 50 * qty;
        r.cash_tendered = 0;
        r.change_due = 0;
        r.cash_tendered_net = 0;
        // Fixture intent: a partial Avoir refund of `total` DA - its value and
        // its single leg are the same amount; it inherits nothing from base_req.
        r.value_reversed = Some(total);
        r.voucher = None;
        r.debt = None;
        r.wallet_credit = Some(total);
        r.refund_payload = format!(
            "{{\"id\":\"REF-{tag}\",\"isRefund\":true,\"originalTransactionId\":\"{ticket}\",\
             \"refundMethod\":\"Avoir Client\",\"cashDisbursed\":0,\"total\":{total}}}"
        );
        r.lines[0].id = format!("RI-{tag}");
        r.lines[0].item_key = format!("IK-{tag}");
        r.lines[0].quantity = qty;
        r.lines[0].applied_price = applied_price;
        r.lines[0].unit_price_charged = applied_price;
        r.lines[0].unit_cost_at_sale = 50;
        r.lines[0].sale_item_id = sale_item_id.map(str::to_string);
        r.lines[0].line_index = sale_item_id.map(|_| 0);
        r.deltas[0].id = format!("LED-{tag}");
        r.deltas[0].key = format!("LEDK-{tag}");
        r.deltas[0].delta = qty;
        r.batches[0].quantity = qty as f64;
        r.batches[0].fallback_batch_id = format!("FB-{tag}");
        r.batches[0].fallback_key = format!("FBK-{tag}");
        r.imeis = vec![];
        r.debt = None;
        r.voucher = None;
        r.cash_move = None;
        r
    }

    #[test]
    fn scenario_a_multi_step_partial_order_discount_conserves_total() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // Ticket: 3 × 100 with a 30 DA order discount → total 270 (the
        // client prorates per step: 80 + 90 + 100 = 270 exactly).
        conn.execute("DELETE FROM transaction_items WHERE transaction_id = 'TKT-1'", [])
            .unwrap();
        conn.execute(
            "UPDATE transactions SET subtotal = 300, discount_total = 30, total = 270, cost_total = 150, profit = 120 WHERE id = 'TKT-1'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, json_payload) \
             VALUES ('TKT-1-item-0', 'TKT-1', 'P1', 3, 100, '{}')",
            [],
        )
        .unwrap();

        let steps = [("A1", 80i64), ("A2", 90), ("A3", 100)];
        for (i, (tag, amount)) in steps.iter().enumerate() {
            let req = partial_req("TKT-1", tag, 1, *amount, *amount, Some("TKT-1-item-0"));
            let ok = run(&mut conn, &req).expect("partial must commit");
            assert_eq!(ok.recovered_cogs, 50);
            let (len, status): (i64, String) = conn
                .query_row(
                    "SELECT json_array_length(json_extract(json_payload, '$.refundedItems')), \
                     json_extract(json_payload, '$.status') FROM transactions WHERE id = 'TKT-1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(len, (i + 1) as i64, "accumulated across steps");
            if i < 2 {
                assert_eq!(status, "PARTIALLY_REFUNDED");
                assert_eq!(ok.ticket_status, "PARTIALLY_REFUNDED");
            } else {
                assert_eq!(status, "REFUNDED", "last unit closes the ticket");
                assert_eq!(ok.ticket_status, "REFUNDED");
                assert_eq!(ok.ticket_version, 4);
            }
        }
        // Conservation: refunds sum EXACTLY to the discounted original total.
        assert_eq!(
            count(
                &conn,
                "SELECT CAST(SUM(total) AS INTEGER) FROM transactions WHERE original_transaction_id = 'TKT-1' AND is_refund = 1"
            ),
            270
        );
        assert_eq!(
            count(
                &conn,
                "SELECT CAST(SUM(restored_cogs) AS INTEGER) FROM transactions WHERE original_transaction_id = 'TKT-1' AND is_refund = 1"
            ),
            150
        );
        // Fourth attempt (different hash, quota exhausted): clean refusal.
        let greedy = partial_req("TKT-1", "A4", 1, 90, 90, Some("TKT-1-item-0"));
        let err = run(&mut conn, &greedy).expect_err("quota");
        assert!(format!("{err:?}").contains("REFUND_EXCEEDS"), "got: {err:?}");
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM transactions WHERE original_transaction_id = 'TKT-1' AND is_refund = 1"
            ),
            3
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM refund_dedup WHERE items_hash = 'H-A4'"),
            0
        );
    }

    // -----------------------------------------------------------------
    // Scenario B — cash + Kredy mix: debt-first waterfall against the live
    // ledger, cash capped at tendered, installment plans filled FIFO.
    // -----------------------------------------------------------------

    #[test]
    fn scenario_b_kredy_waterfall_clamps_and_fills_plans_fifo() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // Ticket: 4 × 200 = 800, only 150 net cash tendered (the rest was on
        // the customer's book). Two ACTIF plans: oldest is fully covered by
        // the first relief; the newer one absorbs the spillover.
        conn.execute("DELETE FROM transaction_items WHERE transaction_id = 'TKT-1'", [])
            .unwrap();
        conn.execute(
            "UPDATE transactions SET subtotal = 800, total = 800 WHERE id = 'TKT-1'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, json_payload) \
             VALUES ('TKT-1-item-0', 'TKT-1', 'P1', 4, 200, '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO debt_plans (id, customer_id, status, created_at, updated_at) \
             VALUES ('PL1', 'C1', 'ACTIF', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO debt_plans (id, customer_id, status, created_at, updated_at) \
             VALUES ('PL2', 'C1', 'ACTIF', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO debt_plan_entries (id, plan_id, seq, due_date, amount, paid_amount, created_at, updated_at) \
             VALUES ('E1', 'PL1', 1, '2026-02-01', 100, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), \
                    ('E2', 'PL1', 2, '2026-03-01', 100, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), \
                    ('E3', 'PL2', 1, '2026-04-01', 400, 0, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')",
            [],
        )
        .unwrap();

        // Refund 1: 2 units, 400 DA — 150 cash + 250 relief against the 500
        // live ledger; plan PL1 closes, PL2 takes the 50 DA remainder.
        let mut r1 = partial_req("TKT-1", "B1", 2, 400, 200, Some("TKT-1-item-0"));
        r1.method = "Espèces".into();
        r1.payment_method = "Espèces".into();
        r1.cash_tendered = 150;
        r1.cash_tendered_net = 150;
        r1.refund_payload = "{\"id\":\"REF-B1\",\"isRefund\":true,\"originalTransactionId\":\"TKT-1\",\
            \"refundMethod\":\"Espèces\",\"cashDisbursed\":150,\"total\":400}"
            .into();
        r1.cash_move = Some(CashMoveIn {
            id: "MOV-B1".into(),
            session_id: "S1".into(),
            amount: 150,
            reason: "ALLOCATION B1".into(),
            cashier_name: "Manager".into(),
        });
        r1.debt = Some(DebtReliefIn {
            entry_id: "PAYREL-B1".into(),
            customer_id: "C1".into(),
            customer_name: "Salma".into(),
            amount: 250,
            receipt_number: "AVOIR-B1".into(),
            payment_method: "Crédit Client".into(),
            notes: "relief B1".into(),
            recorded_by: "Manager".into(),
        });
        r1.value_reversed = Some(400); // 150 cash + 250 relief
        r1.wallet_credit = None; // this refund pays cash + debt, no Avoir leg
        let ok1 = run(&mut conn, &r1).expect("refund 1");
        assert_eq!(ok1.debt_relief_applied, 250);
        assert_eq!(ok1.customer_debt_after, Some(250));
        assert_eq!(
            count(&conn, "SELECT current_debt FROM customers WHERE id = 'C1'"),
            250
        );
        let (amt, bal): (f64, f64) = conn
            .query_row(
                "SELECT amount, balance_after FROM customer_debts WHERE id = 'PAYREL-B1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((amt, bal), (250.0, 250.0));
        // Plans: PL1 fully covered → SOLDE with paid_at stamped; PL2's E3
        // took the 50 DA spillover, still ACTIF, paid_at NULL.
        let (s1, s2): (String, String) = conn
            .query_row(
                "SELECT (SELECT status FROM debt_plans WHERE id = 'PL1'), \
                        (SELECT status FROM debt_plans WHERE id = 'PL2')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((s1.as_str(), s2.as_str()), ("SOLDE", "ACTIF"));
        let (p1, p2, e3): (f64, f64, f64) = conn
            .query_row(
                "SELECT (SELECT paid_amount FROM debt_plan_entries WHERE id = 'E1'), \
                        (SELECT paid_amount FROM debt_plan_entries WHERE id = 'E2'), \
                        (SELECT paid_amount FROM debt_plan_entries WHERE id = 'E3')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((p1, p2, e3), (100.0, 100.0, 50.0));
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM debt_plan_entries WHERE id IN ('E1','E2') AND paid_at IS NOT NULL"
            ),
            2
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM debt_plan_entries WHERE id = 'E3' AND paid_at IS NULL"),
            1
        );

        // Refund 2: remaining 2 units, 400 DA — non-cash; the client asks for
        // 999 of relief but only 250 remains live: clamped + surfaced.
        let mut r2 = partial_req("TKT-1", "B2", 2, 400, 200, Some("TKT-1-item-0"));
        r2.wallet_credit = Some(150); // 400 = 150 Avoir + 250 relief
        r2.debt = Some(DebtReliefIn {
            entry_id: "PAYREL-B2".into(),
            customer_id: "C1".into(),
            customer_name: "Salma".into(),
            amount: 999,
            receipt_number: "AVOIR-B2".into(),
            payment_method: "Crédit Client".into(),
            notes: "relief B2".into(),
            recorded_by: "Manager".into(),
        });
        let ok2 = run(&mut conn, &r2).expect("refund 2");
        assert_eq!(ok2.debt_relief_applied, 250);
        assert_eq!(ok2.customer_debt_after, Some(0));
        assert!(
            ok2.warnings.iter().any(|w| w.contains("plafonnée")),
            "clamp must be surfaced: {:?}",
            ok2.warnings
        );
        assert_eq!(
            count(&conn, "SELECT current_debt FROM customers WHERE id = 'C1'"),
            0
        );
        assert_eq!(
            count(
                &conn,
                "SELECT CAST(COALESCE(SUM(amount), 0) AS INTEGER) FROM customer_debts WHERE type = 'PAYMENT_SETTLED'"
            ),
            500
        );
        // No plan may be overdrawn: relief beyond PL2's capacity is refused
        // by exhaustion, not negative balances.
        let e3_after: f64 = conn
            .query_row(
                "SELECT paid_amount FROM debt_plan_entries WHERE id = 'E3'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(e3_after, 300.0);
        // Cash rail ran exactly once, for 150 (the tendered cap).
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM cash_movements"), 1);
    }

    // -----------------------------------------------------------------
    // Scenario C — same-SKU dual IMEI, one restocked and one quarantined:
    // stock math, ownership events and cost credit stay split correctly.
    // -----------------------------------------------------------------

    #[test]
    fn deterministic_id_matches_ts_fixed_vectors() {
        // Vectors computed by the TypeScript `deterministicId`
        // (src/utils/ids.ts — FNV-1a 32-bit over `parts.join('|')`, 8 upper
        // hex). ASCII parts only: the two lanes must derive the SAME ids or
        // quarantine dedup keys fork between native and web-preview writes.
        assert_eq!(deterministic_id("LED-DEF", &["REF-C", "P1", "1"]), "LED-DEF-AB72EE0E");
        assert_eq!(
            deterministic_id("REF", &["TKT-1", "P1:2:200:1::IMEI-A1:restock", "Voucher", "200", "1"]),
            "REF-87C70085"
        );
        assert_eq!(deterministic_id("LED-DEF", &["REF-A", "P1", "1"]), "LED-DEF-A9AF04CC");
    }

    #[test]
    fn scenario_c_dual_imei_restock_vs_defective_quarantine() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // Two same-SKU units sold, each with its own line identity + IMEI.
        conn.execute("DELETE FROM transaction_items WHERE transaction_id = 'TKT-1'", [])
            .unwrap();
        conn.execute(
            "INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, imei_number, json_payload) \
             VALUES ('TKT-1-item-0', 'TKT-1', 'P1', 1, 100, 'IMEI-A1', '{}'), \
                    ('TKT-1-item-1', 'TKT-1', 'P1', 1, 100, 'IMEI-A2', '{}')",
            [],
        )
        .unwrap();
        for imei in ["IMEI-A1", "IMEI-A2"] {
            conn.execute(
                "INSERT INTO imei_records (imei, product_id, sale_transaction_id, sold_at, status, version) \
                 VALUES (?1, 'P1', 'TKT-1', '2026-01-01T00:00:00Z', 'sold', 1)",
                [imei],
            )
            .unwrap();
        }

        let mut req = partial_req("TKT-1", "C", 1, 200, 100, Some("TKT-1-item-0"));
        req.receipt_number = "AVOIR-C".into();
        req.refund_id = "REF-C".into();
        req.items_hash = "H-C".into();
        req.refund_payload = "{\"id\":\"REF-C\",\"isRefund\":true,\"originalTransactionId\":\"TKT-1\",\
            \"refundMethod\":\"Avoir Client\",\"cashDisbursed\":0,\"total\":200}"
            .into();
        // Line 1: restock (default), Line 2: defective with the mandatory note.
        let mut l2 = req.lines[0].clone();
        l2.id = "RI-C2".into();
        l2.item_key = "IK-C2".into();
        l2.imei_number = Some("IMEI-A2".into());
        l2.sale_item_id = Some("TKT-1-item-1".into());
        l2.line_index = Some(1);
        l2.condition = Some("defective".into());
        req.lines[0].imei_number = Some("IMEI-A1".into());
        req.lines.push(l2);
        req.defect_note = Some("Écran fissuré (SAV)".into());
        req.imeis = vec!["IMEI-A1".into()];
        req.defective_imeis = vec!["IMEI-A2".into()];
        req.total_net = 200;
        req.cost_total = 50; // client cost is restock-only; native recomputes too

        let ok = run(&mut conn, &req).expect("mixed refund");
        assert_eq!(ok.recovered_cogs, 50, "only the restocked unit credits COGS");
        let (rt, rc, rp, rsc): (f64, f64, f64, f64) = conn
            .query_row(
                "SELECT total, cost_total, profit, restored_cogs FROM transactions WHERE id = 'REF-C'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!((rt, rc, rp, rsc), (200.0, 50.0, 150.0, 50.0));
        // Quarantine trail: defective_returns row with the reason note.
        let (did, dpid, dimei, dqty, dcost, dreason): (String, String, String, f64, f64, String) =
            conn.query_row(
                "SELECT id, product_id, imei, quantity, unit_cost, reason FROM defective_returns",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap();
        assert_eq!(did, "def-REF-C-IK-C2");
        assert_eq!((dpid.as_str(), dimei.as_str()), ("P1", "IMEI-A2"));
        assert_eq!((dqty, dcost), (1.0, 50.0));
        assert_eq!(dreason, "Écran fissuré (SAV)");
        // Zero-delta quarantine marker: the deterministically-named ledger row
        // (legacy lane's exact id derivation) that never moves stock.
        let qid = deterministic_id("LED-DEF", &["REF-C", "P1", "1"]);
        let (qdelta, qreason, qref): (i64, String, String) = conn
            .query_row(
                "SELECT delta, reason, ref_type FROM inventory_ledger WHERE id = ?1",
                [&qid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((qdelta, qreason.as_str(), qref.as_str()), (0, "ADJUST", "DEFECTIVE_QUARANTINE"));
        // IMEI states: released from the sale; restock in_stock, defective held.
        let (s1, t1, s2, t2): (Option<String>, Option<String>, Option<String>, Option<String>) =
            conn.query_row(
                "SELECT (SELECT status FROM imei_records WHERE imei = 'IMEI-A1'), \
                        (SELECT sale_transaction_id FROM imei_records WHERE imei = 'IMEI-A1'), \
                        (SELECT status FROM imei_records WHERE imei = 'IMEI-A2'), \
                        (SELECT sale_transaction_id FROM imei_records WHERE imei = 'IMEI-A2')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!((s1.as_deref(), t1), (Some("in_stock"), None));
        assert_eq!((s2.as_deref(), t2), (Some("defective"), None));
        // Ownership events, deterministic ids shared with the TS formula.
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM imei_events WHERE id = 'imev|RETURN_IN|order|REF-C|IMEI-A1'"
            ),
            1
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM imei_events WHERE id = 'imev|RETURN_DEFECTIVE|order|REF-C|IMEI-A2'"
            ),
            1
        );
        // Stock: only the restocked unit comes back to the batch.
        let qty: f64 = conn
            .query_row(
                "SELECT quantity_remaining FROM stock_batches WHERE batch_id = 'B1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(qty, 11.0);
        // Payload: per-line conditions + IMEIs travel with the refund state.
        let (payload,): (String,) = conn
            .query_row(
                "SELECT json_payload FROM transactions WHERE id = 'TKT-1'",
                [],
                |r| Ok((r.get(0)?,)),
            )
            .unwrap();
        let pv: serde_json::Value = serde_json::from_str(&payload).unwrap();
        let items = pv["refundedItems"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["condition"], "restock");
        assert_eq!(items[0]["imeiNumber"], "IMEI-A1");
        assert_eq!(items[1]["condition"], "defective");
        assert_eq!(items[1]["imeiNumber"], "IMEI-A2");
        assert_eq!(items[1]["saleItemId"], "TKT-1-item-1");
    }

    #[test]
    fn defect_write_off_requires_reason_and_valid_condition() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // Defective without the note: the same gate as the TS pre-submit.
        let mut missing_note = base_req();
        missing_note.lines[0].condition = Some("defective".into());
        let err = run(&mut conn, &missing_note).expect_err("note required");
        assert!(
            format!("{err:?}").contains("RESTOCK_REASON_REQUIRED"),
            "got: {err:?}"
        );
        // Garbage condition: protocol error, not a silent restock.
        let mut bad = base_req();
        bad.lines[0].condition = Some("banana".into());
        let err = run(&mut conn, &bad).expect_err("condition whitelist");
        assert!(format!("{err:?}").contains("INVALID:line condition"), "got: {err:?}");
        // Nothing may have been written by either refusal.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM refund_dedup"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM transactions WHERE is_refund = 1"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM defective_returns"), 0);
    }

    // -----------------------------------------------------------------
    // Loyalty clawback + debt clamp edge cases.
    // -----------------------------------------------------------------

    #[test]
    fn loyalty_clawback_persists_points_and_buckets() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        conn.execute("UPDATE customers SET loyalty_points = 120 WHERE id = 'C1'", [])
            .unwrap();
        let mut req = base_req();
        req.customer_points_after = Some(80);
        req.customer_point_buckets_json = Some("[{\"bucketId\":\"b1\",\"points\":80}]".into());
        let ok = run(&mut conn, &req).expect("loyalty commit");
        assert_eq!(ok.customer_points_after, Some(80));
        let points: i64 = conn
            .query_row(
                "SELECT loyalty_points FROM customers WHERE id = 'C1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(points, 80);
        let (payload,): (String,) = conn
            .query_row(
                "SELECT json_payload FROM customers WHERE id = 'C1'",
                [],
                |r| Ok((r.get(0)?,)),
            )
            .unwrap();
        let pv: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(pv["loyaltyPoints"], 80);
        assert_eq!(pv["pointBuckets"][0]["bucketId"], "b1");
        // Points without a customer is a protocol error (fail closed).
        let mut conn2 = Connection::open_in_memory().unwrap();
        test_schema(&conn2);
        seed_ticket(&conn2);
        let mut orphan = base_req();
        orphan.customer_id = None;
        orphan.debt = None;
        orphan.customer_points_after = Some(10);
        let err = run(&mut conn2, &orphan).expect_err("orphan points");
        assert!(
            format!("{err:?}").contains("INVALID:loyalty clawback requires the customer"),
            "got: {err:?}"
        );
    }

    #[test]
    fn debt_relief_clamped_to_zero_when_ledger_empty() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // The customer's book is empty (debt settled elsewhere): the relief
        // rail pays nothing, the clamp is surfaced, the money txn still
        // commits — never a silent wrong-rail payout, never a negative ledger.
        conn.execute("DELETE FROM customer_debts WHERE customer_id = 'C1'", [])
            .unwrap();
        let mut clamp_req = base_req();
        clamp_req.value_reversed = Some(350); // 150 cash + 200 voucher; relief clamps to 0
        let ok = run(&mut conn, &clamp_req).expect("commit with clamp");
        assert_eq!(ok.debt_relief_applied, 0);
        assert_eq!(ok.customer_debt_after, Some(0));
        assert!(
            ok.warnings.iter().any(|w| w.contains("plafonnée")),
            "clamp must be surfaced: {:?}",
            ok.warnings
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM customer_debts WHERE type = 'PAYMENT_SETTLED'"
            ),
            0
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM customers WHERE id = 'C1' AND current_debt IS NULL"
            ),
            1,
            "no aggregate write when nothing applied"
        );
    }

    // -----------------------------------------------------------------
    // Scenario D — Z-report / shift conservation + P&L inputs.
    // -----------------------------------------------------------------

    #[test]
    fn scenario_d_z_report_and_pnl_conservation() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        // Full refund: cash 150 + debt 100 + voucher 200 on shift S1.
        let ok = run(&mut conn, &base_req()).expect("full refund");
        assert_eq!(ok.ticket_status, "REFUNDED");
        // Cash rail: exactly ONE drawer movement, exactly the disbursed cash.
        let (cnt, amt, typ, sess): (i64, i64, String, String) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(amount), 0), MIN(type), MIN(session_id) FROM cash_movements",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!((cnt, amt), (1, 150));
        assert_eq!((typ.as_str(), sess.as_str()), ("ALLOCATION", "S1"));
        // The refund row anchors to the shift; its P&L contributions are
        // recovered-COGS based (R − G), so base(100) − burden(100) = 0 net.
        let (shift, rt, rc, rp, rsc): (String, f64, f64, f64, f64) = conn
            .query_row(
                "SELECT shift_id, total, cost_total, profit, restored_cogs FROM transactions WHERE id = 'REF-H1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(shift, "S1");
        assert_eq!((rt, rc, rp, rsc), (450.0, 100.0, 100.0, 100.0));
        let (base_total, base_cost, base_profit): (f64, f64, f64) = conn
            .query_row(
                "SELECT total, cost_total, profit FROM transactions WHERE id = 'TKT-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        // profitTotal = (sales − refunds) − baseCost + restoredCogs
        let net = (base_total - rt) - base_cost + rsc;
        assert_eq!(net, 0.0, "after a full restock refund the P&L is neutral");
        assert_eq!(net, base_profit - rp, "equals base − refund burden");

        // Second ticket, NON-cash refund: the row still anchors to the active
        // shift (so the Z-period sees it) and moves no drawer cash.
        conn.execute(
            "INSERT INTO transactions (id, receipt_number, subtotal, total, cost_total, profit, status, created_at, json_payload, version, device_id, shift_id, idempotency_key) \
             VALUES ('TKT-2', 'REC-2', 50, 50, 20, 30, 'COMPLETED', '2026-01-01T00:00:00Z', '{}', 1, 'dev-A', 'S1', 'tik-TKT-2')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, json_payload) \
             VALUES ('TKT-2-item-0', 'TKT-2', 'P1', 1, 50, '{}')",
            [],
        )
        .unwrap();
        let mut r2 = partial_req("TKT-2", "D2", 1, 50, 50, Some("TKT-2-item-0"));
        r2.cost_total = 20;
        r2.lines[0].unit_cost_at_sale = 20;
        r2.deltas = vec![];
        r2.batches = vec![];
        let ok2 = run(&mut conn, &r2).expect("non-cash refund");
        assert_eq!(ok2.ticket_status, "REFUNDED");
        let (shift2, cash2): (String, f64) = conn
            .query_row(
                "SELECT (SELECT shift_id FROM transactions WHERE id = 'REF-D2'), \
                        (SELECT COALESCE(SUM(amount), 0) FROM cash_movements)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(shift2, "S1");
        assert_eq!(cash2, 150.0, "no second cash movement");
    }

    // --- D4-A: the Avoir leg is native, incremental and atomic ---------------

    #[test]
    fn d4a_wallet_leg_commits_balance_and_ledger_once() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        let mut req = base_req();
        // 200 total = 150 cash + 50 wallet
        req.wallet_credit = Some(50);
        req.voucher = None;
        req.debt = None;
        req.value_reversed = None; // total = total_net = 150 cash + 50 wallet
        req.customer_id = Some("C1".into());
        conn.execute(
            "INSERT INTO customers (id, name, phone, json_payload, store_credit, updated_at) VALUES ('C1','C','','{}',10,'2026-01-01T00:00:00Z') ON CONFLICT(id) DO UPDATE SET store_credit = 10",
            [],
        )
        .unwrap();
        let ok = run(&mut conn, &req).expect("wallet refund commits");
        assert_eq!(ok.customer_store_credit_after, Some(60));
        let credit: f64 = conn
            .query_row("SELECT store_credit FROM customers WHERE id='C1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(credit, 60.0, "applied as an increment inside the txn");
        let payload: String = conn
            .query_row("SELECT json_payload FROM customers WHERE id='C1'", [], |r| r.get(0))
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&payload).unwrap();
        let ledger = v.get("ledger").and_then(|l| l.as_array()).cloned().unwrap_or_default();
        assert_eq!(ledger.len(), 1, "exactly one ledger emission");
        assert_eq!(ledger[0].get("creditDeltaDzd").and_then(|c| c.as_i64()), Some(50));
        assert_eq!(ledger[0].get("referenceId").and_then(|c| c.as_str()), Some("TKT-1"));
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM transactions WHERE id='REF-H1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn d4a_wallet_leg_without_recipient_is_refused_and_writes_nothing() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        let mut req = base_req();
        req.wallet_credit = Some(50);
        req.customer_id = None;
        let err = run(&mut conn, &req).expect_err("must refuse");
        assert!(format!("{err:?}").contains("AVOIR_RECIPIENT_REQUIRED"), "{err:?}");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM transactions WHERE id='REF-H1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "no refund row");
        let dedup: i64 = conn
            .query_row("SELECT COUNT(*) FROM refund_dedup", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dedup, 0, "no dedup hash");
        let ledger_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM inventory_ledger WHERE ref_id='REF-H1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ledger_rows, 0, "no restock");
    }

    #[test]
    fn d4a_clawback_revokes_in_the_same_transaction() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        conn.execute("UPDATE transactions SET customer_id = 'C1' WHERE id = 'TKT-1'", []).unwrap();
        conn.execute(
            "INSERT INTO customers (id, name, phone, json_payload, store_credit, updated_at) VALUES ('C1','C','','{}',100,'2026-01-01T00:00:00Z') ON CONFLICT(id) DO UPDATE SET store_credit = 100",
            [],
        )
        .unwrap();
        let mut req = base_req();
        req.voucher = None;
        req.debt = None;
        req.cash_tendered = 150;
        req.wallet_credit = Some(50);
        req.wallet_clawback = Some(30); // refund un-earns a milestone
        req.value_reversed = None; // total = 200 = 150 cash + 50 wallet
        let ok = run(&mut conn, &req).expect("wallet refund with clawback commits");
        // 100 + 50 - 30 = 120, applied in one transaction
        assert_eq!(ok.customer_store_credit_after, Some(120));
        let credit: f64 = conn
            .query_row("SELECT store_credit FROM customers WHERE id='C1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(credit, 120.0);
        let payload: String = conn
            .query_row("SELECT json_payload FROM customers WHERE id='C1'", [], |r| r.get(0))
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&payload).unwrap();
        let ledger = v.get("ledger").and_then(|l| l.as_array()).cloned().unwrap_or_default();
        assert_eq!(ledger.len(), 2, "emission + revocation both recorded");
        let deltas: Vec<i64> = ledger
            .iter()
            .filter_map(|e| e.get("creditDeltaDzd").and_then(|c| c.as_i64()))
            .collect();
        assert!(deltas.contains(&50) && deltas.contains(&-30), "{deltas:?}");
    }

    #[test]
    fn d4a_clawback_is_clamped_to_the_revocable_balance() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        conn.execute(
            "INSERT INTO customers (id, name, phone, json_payload, store_credit, updated_at) VALUES ('C1','C','','{}',100,'2026-01-01T00:00:00Z') ON CONFLICT(id) DO UPDATE SET store_credit = 100",
            [],
        )
        .unwrap();
        let mut req = base_req();
        req.voucher = None;
        req.debt = None;
        req.cash_tendered = 150;
        req.wallet_credit = Some(50);
        req.wallet_clawback = Some(500); // more than the wallet can ever hold
        req.value_reversed = None;
        // The clawback must be clamped to (100 + 50), never emit -500.
        let result = run(&mut conn, &req);
        // either it commits with a clamped revocation or refuses; both must leave a
        // ledger that reconciles to the balance
        let payload: String = conn
            .query_row("SELECT json_payload FROM customers WHERE id='C1'", [], |r| r.get(0))
            .unwrap();
        let credit: f64 = conn
            .query_row("SELECT store_credit FROM customers WHERE id='C1'", [], |r| r.get(0))
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&payload).unwrap();
        let ledger_sum: f64 = v
            .get("ledger")
            .and_then(|l| l.as_array())
            .map(|a| a.iter().filter_map(|e| e.get("creditDeltaDzd").and_then(|c| c.as_f64())).sum())
            .unwrap_or(0.0);
        assert_eq!(credit, ledger_sum + 100.0, "ledger must reconcile: credit {credit}, deltas {ledger_sum}, seed 100");
        assert!(credit >= 0.0);
        let _ = result;
    }

    #[test]
    fn d4a_refund_value_cannot_exceed_the_ticket() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        let mut req = base_req();
        req.value_reversed = Some(999_999); // far above the ticket's tenders
        let err = run(&mut conn, &req).expect_err("value cap must refuse");
        assert!(format!("{err:?}").contains("REFUND_EXCEEDS_VALUE"), "{err:?}");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM transactions WHERE id='REF-H1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "no refund row");
    }

    #[test]
    fn d4a_forced_wallet_failure_rolls_the_whole_refund_back() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = Connection::open_in_memory().unwrap();
        test_schema(&conn);
        seed_ticket(&conn);
        conn.execute(
            "INSERT INTO customers (id, name, phone, json_payload, store_credit, updated_at) VALUES ('C1','C','','{}',10,'2026-01-01T00:00:00Z') ON CONFLICT(id) DO UPDATE SET store_credit = 10",
            [],
        )
        .unwrap();
        // Force the wallet UPDATE to fail inside the transaction.
        conn.execute(
            "CREATE TRIGGER fail_wallet BEFORE UPDATE OF store_credit ON customers BEGIN SELECT RAISE(ABORT, 'wallet boom'); END",
            [],
        )
        .unwrap();
        let mut req = base_req();
        req.value_reversed = None; // 200 <= ticket 200 (value cap)
        req.wallet_credit = Some(50);
        let err = run(&mut conn, &req).expect_err("wallet failure must abort");
        assert!(format!("{err:?}").to_lowercase().contains("wallet"), "{err:?}");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM transactions WHERE id='REF-H1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "refund row rolled back");
        let ledger_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM inventory_ledger WHERE ref_id='REF-H1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ledger_rows, 0, "restock rolled back");
        let credit: f64 = conn
            .query_row("SELECT store_credit FROM customers WHERE id='C1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(credit, 10.0, "wallet untouched");
    }
}


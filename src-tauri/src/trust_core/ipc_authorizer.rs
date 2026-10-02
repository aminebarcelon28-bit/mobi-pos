//! Phase 1 — command registry (deny by default), TOCTOU-safe
//! authorize-and-execute, typed errors, `get_gate_state`, denial audit log.
//!
//! # TOCTOU mechanism (B.5, gap G-05)
//! `authorize_and_execute(command, capability, op)` performs CHECK LICENSE ->
//! DERIVE CAPABILITY -> AUTHORIZE COMMAND -> EXECUTE inside one native call
//! while holding the kernel state's read guard for the whole operation, so a
//! concurrent license transition cannot slip between the check and the
//! operation. A state generation counter is additionally captured at entry:
//! mutating operations re-verify it immediately before commit via
//! [`TrustKernel::ensure_generation_unchanged`]; a mismatch aborts with
//! [`TrustError::TerminalLocked`]. Capability is re-evaluated on every call —
//! nothing is cached across calls and no reusable token or "authorized" flag
//! is ever returned to JavaScript.
//!
//! # Deny by default (B.6, gaps G-06/G-07)
//! [`required_capability`] returns `None` for unregistered commands and every
//! such command is denied. Privileged handlers must go through
//! `authorize_and_execute` (sync) or [`require_capability`] (async entry
//! points that cannot hold the guard across `.await`); a source-enumeration
//! test below fails the build if any `#[tauri::command]` is missing from the
//! registry or if any registered handler body does not reference the
//! authorization path.
//!
//! # Errors (B.8, gap G-14)
//! [`TrustError`] serializes on the wire as exactly
//! `{gate_code, message_key, kind, detail?}`: `gate_code` tells the UI which
//! lock screen to show, `message_key` is an i18n key, and `detail` carries
//! only coarse, non-secret context. License internals, timestamps, key
//! material, and file paths are never serialized.
//!
//! # Denial audit (B.10, gap G-17)
//! Every denial logs `command`, required capability, coarse state code, and a
//! timestamp to stderr (host log pipeline). Secrets and license internals are
//! never logged. A file-backed security audit trail is deferred to the audit
//! subsystem (Phase 3 concern).

use super::capability_policy::{authorize, Capability};
use super::clocks::MonotonicSource;
use super::license_state::LicenseState;
use super::secure_storage::KeyStore;
use parking_lot::{RwLock, RwLockReadGuard};
use serde::ser::{SerializeStruct, Serializer};
use serde::Serialize;
use std::sync::OnceLock;

// ---------------------------------------------------------------------------
// Typed errors (B.8)
// ---------------------------------------------------------------------------

/// Native authorization failure. Wire shape is always
/// `{gate_code, message_key, kind, detail?}`.
#[derive(Debug, Clone)]
pub enum TrustError {
    /// Terminal is in a locked state; maps to a lock-screen gate.
    TerminalLocked { state_code: String },
    /// Policy denied `command` (needs `capability`) in `state_code`.
    CapabilityDenied {
        command: &'static str,
        capability: &'static str,
        state_code: String,
    },
    /// Persisted/license state could not be decoded. The kernel maps this to
    /// `CORRUPTED`; it is exposed so callers can distinguish decode failure
    /// from denial.
    InvalidLicenseState,
    /// Trusted-time evaluation failed (Phase 1 stub always fails).
    TrustedTimeFailure,
    /// Authenticated security check failed (bad signature, wrong PIN,
    /// not-yet-valid license). No secrets included.
    SecurityPolicyFailure { reason: &'static str },
    /// Malformed IPC input (bad token structure, bad encoding, bad args).
    IPCProtocolError { reason: &'static str },
    /// Legacy operational failure (I/O, SQLite). `detail` preserves the
    /// pre-Phase-1 message for transitional UX. Sanitizing these details
    /// (some contain file paths) is a deferred residual — see report.
    OperationFailed(String),
    /// Storage exhaustion during export staging/snapshot. Carries only
    /// coarse numbers (required/available bytes), never paths or secrets.
    /// Maps to gate NONE so the UI shows the detail as an operational error,
    /// not a lock screen.
    StorageExhausted { detail: String },
    /// Export manifest could not be written and fsynced. Distinct from other
    /// failures: output without evidence is refused, so the caller can free
    /// space and retry. Detail carries the OS-level cause, never secrets.
    ExportManifestFailed { detail: String },
}

impl TrustError {
    /// Coarse UI gate code (B.8): which lock screen to show.
    pub fn gate_code(&self) -> &'static str {
        match self {
            TrustError::TerminalLocked { .. } => "LOCKED",
            TrustError::CapabilityDenied { state_code, .. } => state_to_gate_code(state_code),
            TrustError::InvalidLicenseState => "LOCKED",
            TrustError::TrustedTimeFailure => "LOCKED",
            TrustError::SecurityPolicyFailure { .. } => "LOCKED",
            TrustError::IPCProtocolError { .. } => "LOCKED",
            TrustError::OperationFailed(_) => "NONE",
            TrustError::StorageExhausted { .. } => "NONE",
            TrustError::ExportManifestFailed { .. } => "NONE",
        }
    }

    /// i18n message key for the UI.
    pub fn message_key(&self) -> &'static str {
        match self {
            TrustError::TerminalLocked { .. } => "license.locked",
            TrustError::CapabilityDenied { .. } => "license.denied",
            TrustError::InvalidLicenseState => "license.corrupted",
            TrustError::TrustedTimeFailure => "license.time_failure",
            TrustError::SecurityPolicyFailure { .. } => "license.security",
            TrustError::IPCProtocolError { .. } => "license.protocol",
            TrustError::OperationFailed(_) => "op.failed",
            TrustError::StorageExhausted { .. } => "op.storage",
            TrustError::ExportManifestFailed { .. } => "op.manifest",
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            TrustError::TerminalLocked { .. } => "TerminalLocked",
            TrustError::CapabilityDenied { .. } => "CapabilityDenied",
            TrustError::InvalidLicenseState => "InvalidLicenseState",
            TrustError::TrustedTimeFailure => "TrustedTimeFailure",
            TrustError::SecurityPolicyFailure { .. } => "SecurityPolicyFailure",
            TrustError::IPCProtocolError { .. } => "IPCProtocolError",
            TrustError::OperationFailed(_) => "OperationFailed",
            TrustError::StorageExhausted { .. } => "StorageExhausted",
            TrustError::ExportManifestFailed { .. } => "ExportManifestFailed",
        }
    }

    /// Non-secret detail for the UI. `None` unless the variant carries
    /// coarse, display-safe context.
    fn detail(&self) -> Option<&str> {
        match self {
            TrustError::SecurityPolicyFailure { reason } => Some(reason),
            TrustError::IPCProtocolError { reason } => Some(reason),
            TrustError::OperationFailed(msg) => Some(msg.as_str()),
            TrustError::StorageExhausted { detail } => Some(detail.as_str()),
            TrustError::ExportManifestFailed { detail } => Some(detail.as_str()),
            _ => None,
        }
    }

    /// Constructor for legacy operational failures (transitional).
    pub fn op_failed(err: impl ToString) -> Self {
        TrustError::OperationFailed(err.to_string())
    }
}

impl std::fmt::Display for TrustError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TrustError::TerminalLocked { state_code } => {
                write!(f, "Terminal verrouillé (état {state_code}).")
            }
            TrustError::CapabilityDenied {
                command,
                capability,
                state_code,
            } => write!(
                f,
                "Opération '{command}' refusée (capacité {capability} requise, état {state_code})."
            ),
            TrustError::InvalidLicenseState => write!(f, "État de licence illisible ou corrompu."),
            TrustError::TrustedTimeFailure => {
                write!(f, "Horloge de confiance indisponible — opération refusée.")
            }
            TrustError::SecurityPolicyFailure { reason } => write!(f, "{reason}"),
            TrustError::IPCProtocolError { reason } => write!(f, "Requête invalide: {reason}."),
            TrustError::OperationFailed(msg) => write!(f, "{msg}"),
            TrustError::StorageExhausted { detail } => write!(f, "{detail}"),
            TrustError::ExportManifestFailed { detail } => write!(f, "{detail}"),
        }
    }
}

impl std::error::Error for TrustError {}

/// Transitional conversion: legacy `String` failures become
/// `OperationFailed` with the message preserved for UX. New code should
/// construct precise variants instead of relying on this.
impl From<String> for TrustError {
    fn from(msg: String) -> Self {
        TrustError::OperationFailed(msg)
    }
}

impl From<&str> for TrustError {
    fn from(msg: &str) -> Self {
        TrustError::OperationFailed(msg.to_string())
    }
}

/// Exact wire shape: `{gate_code, message_key, kind, detail?}`.
impl Serialize for TrustError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let has_detail = self.detail().is_some();
        let mut st = s.serialize_struct("TrustError", if has_detail { 4 } else { 3 })?;
        st.serialize_field("gate_code", self.gate_code())?;
        st.serialize_field("message_key", self.message_key())?;
        st.serialize_field("kind", self.kind())?;
        if let Some(d) = self.detail() {
            st.serialize_field("detail", d)?;
        }
        st.end()
    }
}

/// Maps a coarse state code to the UI gate code.
fn state_to_gate_code(state_code: &str) -> &'static str {
    match state_code {
        "UNACTIVATED" => "ACTIVATION",
        "OPERATIONAL" => "NONE",
        "EXPIRED" | "GRACE_EXCEEDED" => "EXPIRED",
        "SUSPENDED" => "SUSPENDED",
        "REVOKED" => "REVOKED",
        "CLOCK_RESET_REQUIRED" => "CLOCK",
        _ => "LOCKED",
    }
}

fn capability_name(cap: Capability) -> &'static str {
    match cap {
        Capability::OperationalWrites => "OperationalWrites",
        Capability::ReadOperationalData => "ReadOperationalData",
        Capability::EmergencyExport => "EmergencyExport",
        Capability::LicenseManagement => "LicenseManagement",
        Capability::Sync => "Sync",
        Capability::HardwareOperations => "HardwareOperations",
    }
}

// ---------------------------------------------------------------------------
// Kernel state + generation counter (B.5)
// ---------------------------------------------------------------------------

struct KernelInner {
    state: LicenseState,
    /// Incremented on every transition. Mutating operations capture it at
    /// entry and re-verify before commit.
    generation: u64,
    /// Monotonic counter mirrored into the persisted snapshot for rollback
    /// detection (B.4).
    counter: u64,
}

/// The native trust kernel: single owner of license state for all IPC.
pub struct TrustKernel {
    inner: RwLock<KernelInner>,
}

impl TrustKernel {
    fn new() -> Self {
        Self {
            inner: RwLock::new(KernelInner {
                state: LicenseState::Unknown,
                generation: 0,
                counter: 0,
            }),
        }
    }

    /// Current (state, generation). Generation lets callers detect a
    /// transition that happened between two calls (re-evaluation, B.11).
    pub fn get(&self) -> (LicenseState, u64) {
        let g = self.inner.read();
        (g.state, g.generation)
    }

    /// Transition to a new state. Increments generation and counter.
    /// Production transitions happen only via snapshot load at startup,
    /// `trust_sync_license` (signature-verified), `trust_report_revocation`,
    /// re-anchor flows, or time-engine verdicts — never from raw client
    /// state strings.
    pub fn set_state(&self, next: LicenseState) {
        let mut g = self.inner.write();
        g.state = next;
        g.generation = g.generation.wrapping_add(1);
        g.counter = g.counter.wrapping_add(1);
    }

    /// Bump the rollback counter without changing state or generation.
    /// Used by persisted time-only mutations (re-anchor, checkpoint
    /// ratchets) so rollback protection covers time state too.
    pub fn bump_counter_only(&self) {
        let mut g = self.inner.write();
        g.counter = g.counter.wrapping_add(1);
    }

    /// Restore (state, generation, counter) from an authenticated snapshot
    /// (startup path). The snapshot's own generation/counter are adopted so
    /// monotonicity survives restarts.
    pub fn restore(&self, state: LicenseState, generation: u64, counter: u64) {
        let mut g = self.inner.write();
        g.state = state;
        g.generation = generation;
        g.counter = counter;
    }

    /// Highest counter observed (for snapshot rollback checks).
    pub fn last_seen_counter(&self) -> u64 {
        self.inner.read().counter
    }

    /// Abort helper for mutating operations: fails when the kernel moved
    /// since `entry_generation` was captured.
    pub fn ensure_generation_unchanged(&self, entry_generation: u64) -> Result<(), TrustError> {
        let (state, current) = self.get();
        if current == entry_generation {
            Ok(())
        } else {
            Err(TrustError::TerminalLocked {
                state_code: state.as_code().to_string(),
            })
        }
    }

    #[cfg(test)]
    pub(crate) fn reset_for_tests(&self) {
        let mut g = self.inner.write();
        g.state = LicenseState::Unknown;
        g.generation = 0;
        g.counter = 0;
    }
}

static KERNEL: OnceLock<TrustKernel> = OnceLock::new();

/// Process-wide kernel singleton.
pub fn global_kernel() -> &'static TrustKernel {
    KERNEL.get_or_init(TrustKernel::new)
}

/// Serializes tests that mutate the global kernel. Kernel-mutating tests in
/// other modules (e.g. `commands`) must hold this lock to avoid generation
/// races with parallel test threads.
#[cfg(test)]
pub(crate) static SERIAL_TEST_MUTEX: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

#[cfg(test)]
pub(crate) fn serial_test_lock() -> parking_lot::MutexGuard<'static, ()> {
    SERIAL_TEST_MUTEX.lock()
}

// ---------------------------------------------------------------------------
// Command registry — deny by default (B.6)
// ---------------------------------------------------------------------------

/// Central map: Tauri command name -> required capability.
/// A command absent from this table is DENIED (see [`required_capability`]).
/// Public (unauthenticated, read-only, no-data) commands live in
/// [`PUBLIC_COMMANDS`], never here.
static COMMAND_REGISTRY: &[(&str, Capability)] = &[
    // Business writes.
    ("po_process_raw_scan", Capability::OperationalWrites),
    ("process_raw_scan", Capability::OperationalWrites),
    ("po_commit_stock_batch", Capability::OperationalWrites),
    ("commit_stock_batch", Capability::OperationalWrites),
    // Read-only operational data.
    ("create_database_backup", Capability::ReadOperationalData),
    ("list_database_backups", Capability::ReadOperationalData),
    // License / activation plane (reachable while locked by design, B.3).
    ("get_cloud_credentials", Capability::LicenseManagement),
    ("set_cloud_credentials", Capability::LicenseManagement),
    ("delete_cloud_credentials", Capability::LicenseManagement),
    ("get_hardware_fingerprint", Capability::LicenseManagement),
    ("get_license_token", Capability::LicenseManagement),
    ("set_license_token", Capability::LicenseManagement),
    ("delete_license_token", Capability::LicenseManagement),
    ("trust_sync_license", Capability::LicenseManagement),
    ("trust_report_revocation", Capability::LicenseManagement),
    ("trust_reanchor_challenge", Capability::LicenseManagement),
    ("trust_reanchor_time", Capability::LicenseManagement),
    // Controlled recovery.
    ("emergency_export_ledger", Capability::EmergencyExport),
    // SAV intake photo attachments (Phase 5): bytes go to the local
    // filesystem, never SQLite. Write/purge are OperationalWrites (fail-closed
    // while locked); read re-verifies the SHA-256 so a swapped image is
    // DETECTED rather than silently rendered on the work order.
    ("sav_attachment_write", Capability::OperationalWrites),
    ("sav_attachment_read", Capability::ReadOperationalData),
    ("sav_attachment_purge", Capability::OperationalWrites),
    // Crash-orphan sweep: same plane as purge — it DELETES staged photo bytes
    // and is refused while the terminal is locked.
    ("sav_attachment_sweep_stale_drafts", Capability::OperationalWrites),
    // Tier A audit path (Phase 4.4): native append-only writes.
    ("audit_append", Capability::OperationalWrites),
    // Swallowed-audit surfacing (Phase 4.5 WP2a): same plane as append.
    ("audit_note_swallowed", Capability::OperationalWrites),
    // Tier A PIN plane (Phase 4.5): device-local verify/rotate. Scoped to
    // LicenseManagement (provisioning plane) so first-boot setup and
    // rotation-while-locked stay reachable; neither grants business caps.
    ("pin_verify", Capability::LicenseManagement),
    // F3 (pending merge approval): read-only lockout countdown. Same plane
    // as pin_verify; loads state, never records or resets.
    ("pin_lockout_remaining", Capability::LicenseManagement),
    // Phase 3: snapshot prune destroys recovery points — OperationalWrites
    // (fail-closed outside Operational) PLUS a fresh manager PIN verified
    // inside the command through the unmodified pin_verify.
    ("prune_snapshots", Capability::OperationalWrites),
    ("pin_set", Capability::LicenseManagement),    // Audit verification is a read (locked-state diagnostics keep dedicated paths).
    ("audit_verify", Capability::ReadOperationalData),
    // Hardware / device egress.
    ("sqlite_print_raw_escpos", Capability::HardwareOperations),
    ("sqlite_open_cash_drawer", Capability::HardwareOperations),
    ("hardware_scan_devices", Capability::HardwareOperations),
    ("hardware_update_vfd", Capability::HardwareOperations),
    ("launch_dialer", Capability::HardwareOperations),
    ("launch_call", Capability::HardwareOperations),
    ("launch_whatsapp", Capability::HardwareOperations),
    ("launch_print", Capability::HardwareOperations),
    ("launch_print_label", Capability::HardwareOperations),
    ("mobile_wifi_print", Capability::HardwareOperations),
    ("mobile_bluetooth_printers", Capability::HardwareOperations),
    ("mobile_bluetooth_print", Capability::HardwareOperations),
    ("launch_url", Capability::HardwareOperations),
    ("mobile_scan_document", Capability::HardwareOperations),
];

/// Public commands: no capability required, callable in every state
/// including UNKNOWN. Membership is intentionally tiny: a coarse gate probe
/// plus two read-only boot probes that expose no business data.
static PUBLIC_COMMANDS: &[&str] = &[
    "get_gate_state",
    "sqlite_check_db_version",
    "sqlite_db_maintenance",
];

/// Required capability for a command, or `None` when the command is
/// unregistered (deny) or public (no capability needed — check
/// [`is_public_command`] first).
pub fn required_capability(command: &str) -> Option<Capability> {
    COMMAND_REGISTRY
        .iter()
        .find(|(name, _)| *name == command)
        .map(|(_, cap)| *cap)
}

pub fn is_public_command(command: &str) -> bool {
    PUBLIC_COMMANDS.contains(&command)
}

// ---------------------------------------------------------------------------
// Authorization context + entry points
// ---------------------------------------------------------------------------

/// Proof of a single authorization decision. Valid only for the call that
/// created it: it carries the entry generation so mutating operations can
/// abort when the kernel moved mid-operation. It authorizes nothing by
/// itself and is never serialized to JavaScript.
#[derive(Debug, Clone)]
pub struct AuthCtx {
    pub state_code: String,
    pub generation: u64,
}

/// Denial audit record (B.10). Secrets and license internals never included.
fn log_denial(command: &str, capability: &str, state_code: &str) {
    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    eprintln!(
        "[trust_core][deny] cmd={} required_capability={} state={} ts_ms={}",
        command, capability, state_code, ts_ms
    );
}

fn deny_unregistered(command: &str) -> TrustError {
    log_denial(command, "UNREGISTERED", "UNKNOWN");
    TrustError::SecurityPolicyFailure {
        reason: "unknown command denied",
    }
}

/// Entry check for async handlers that cannot hold the read guard across
/// `.await`. Performs CHECK LICENSE -> DERIVE CAPABILITY -> AUTHORIZE in one
/// native call and returns a generation-bound context. Mutating async flows
/// must call [`TrustKernel::ensure_generation_unchanged`] before commit.
pub fn require_capability(
    command: &'static str,
    required: Capability,
) -> Result<AuthCtx, TrustError> {
    if is_public_command(command) {
        let (state, generation) = global_kernel().get();
        return Ok(AuthCtx {
            state_code: state.as_code().to_string(),
            generation,
        });
    }
    match required_capability(command) {
        Some(registered) if registered == required => {}
        _ => return Err(deny_unregistered(command)),
    }
    let (state, generation) = global_kernel().get();
    let decision = authorize(&state, required);
    if decision.granted {
        Ok(AuthCtx {
            state_code: state.as_code().to_string(),
            generation,
        })
    } else {
        let code = state.as_code().to_string();
        log_denial(command, capability_name(required), &code);
        Err(TrustError::CapabilityDenied {
            command,
            capability: capability_name(required),
            state_code: code,
        })
    }
}

/// TOCTOU-safe authorize-and-execute (B.5). Reads state, derives capability,
/// checks the registry, and runs `op` while holding the kernel read guard,
/// then re-verifies the generation before returning. Sequence is always
/// CHECK LICENSE -> DERIVE CAPABILITY -> AUTHORIZE COMMAND -> EXECUTE.
///
/// `op` must not call `set_state`/`restore` (it would deadlock on the
/// guard); state transitions happen between calls, never inside them.
pub fn authorize_and_execute<T>(
    command: &'static str,
    required: Capability,
    op: impl FnOnce(&AuthCtx) -> Result<T, TrustError>,
) -> Result<T, TrustError> {
    if is_public_command(command) {
        let (state, generation) = global_kernel().get();
        let ctx = AuthCtx {
            state_code: state.as_code().to_string(),
            generation,
        };
        return op(&ctx);
    }
    match required_capability(command) {
        Some(registered) if registered == required => {}
        _ => return Err(deny_unregistered(command)),
    }
    let kernel = global_kernel();
    let guard: RwLockReadGuard<'_, KernelInner> = kernel.inner.read();
    let decision = authorize(&guard.state, required);
    if !decision.granted {
        let code = guard.state.as_code().to_string();
        drop(guard);
        log_denial(command, capability_name(required), &code);
        return Err(TrustError::CapabilityDenied {
            command,
            capability: capability_name(required),
            state_code: code,
        });
    }
    let ctx = AuthCtx {
        state_code: guard.state.as_code().to_string(),
        generation: guard.generation,
    };
    let result = op(&ctx);
    // Write-lock exclusion means the generation cannot have changed while
    // the guard is held; the check documents the invariant and fails closed
    // if the locking discipline is ever bypassed.
    if guard.generation != ctx.generation {
        return Err(TrustError::TerminalLocked {
            state_code: ctx.state_code,
        });
    }
    result
}

// ---------------------------------------------------------------------------
// Read-only gate probe (B.8 / gap G-13)
// ---------------------------------------------------------------------------

/// Coarse gate state for the UI. Read-only: it authorizes nothing, carries
/// no authority, and cannot be replayed into privilege (there is no token).
#[derive(Debug, Clone, Serialize)]
pub struct GateState {
    pub state_code: String,
    pub gate_code: String,
    pub message_key: &'static str,
    pub generation: u64,
    /// Phase 4.5 boot audit-check outcome (`None` = the background check has
    /// not reported yet this boot). Surfaces `BROKEN ...` without blocking
    /// startup or checkout; authoritative detail comes from `audit_verify`.
    pub audit_boot: Option<String>,
    /// Phase 4.5 WP2a native swallowed-audit total (monotonic per boot).
    /// Nonzero means audit writes have been failing and the funnel is
    /// swallowing; investigate the audit path, not the primary flows.
    pub audit_swallowed: u64,
}

/// UI presentation probe. Callable in every state including UNKNOWN.
/// Runs the time-policy evaluation first so the coarse code reflects clock
/// verdicts (strong signals may transition the kernel; advisory never does).
#[tauri::command]
pub fn get_gate_state() -> GateState {
    evaluate_time_policy();
    let (state, generation) = global_kernel().get();
    let code = state.as_code();
    GateState {
        state_code: code.to_string(),
        gate_code: state_to_gate_code(code).to_string(),
        message_key: match code {
            "UNACTIVATED" => "license.activate",
            "OPERATIONAL" => "license.ok",
            "EXPIRED" | "GRACE_EXCEEDED" => "license.expired",
            "SUSPENDED" => "license.suspended",
            "REVOKED" => "license.revoked",
            "CLOCK_RESET_REQUIRED" => "license.clock",
            _ => "license.locked",
        },
        generation,
        audit_boot: super::audit_append::boot_audit_status(),
        audit_swallowed: super::audit_append::swallowed_audit_total(),
    }
}

// ---------------------------------------------------------------------------
// Kernel lifecycle: startup resolution + verified transitions
// ---------------------------------------------------------------------------

/// Resolve the transient UNKNOWN state at startup (B.3 + Phase 2 v2):
/// load the authenticated snapshot through the full fail-closed rule set
/// (fresh-install → UNACTIVATED; verified → stored state; tamper → clock
/// quarantine; corrupt → CORRUPTED). Never leaves the kernel in UNKNOWN.
/// Remembers the app dir so later evaluations can persist without a handle.
pub fn resolve_at_startup(app_data_dir: &std::path::Path) {
    use super::secure_storage as ss;
    remember_app_dir(app_data_dir);
    let kernel = global_kernel();
    let (store, degraded) = select_store(app_data_dir);
    if degraded {
        eprintln!("[trust_core] keystore degraded: file-backed provisional store in use (flagged)");
    }
    let path = ss::snapshot_path(app_data_dir);

    // Prior-state probe for key resolution (a missing key means different
    // things on fresh vs. previously-active machines).
    let file_exists = path.exists();
    let counter_hint = store.load_counter().ok().flatten();
    let prior = file_exists || counter_hint.is_some();

    // Missing/unreadable store on a fresh machine is provisioned loudly at
    // first persist; anywhere else it quarantines (see select_store docs).
    let active_key: Option<Vec<u8>> = match ss::resolve_mac_key(&*store, prior) {
        ss::KeyResolution::Active { key, source } => {
            eprintln!("[trust_core] license MAC key source: {source}");
            Some(key)
        }
        ss::KeyResolution::ProvisionOnFirstPersist => {
            eprintln!("[trust_core] no trust key yet (fresh machine) — will provision on first persist");
            None
        }
        ss::KeyResolution::QuarantineNoKey => {
            kernel.set_state(LicenseState::TamperSuspected);
            eprintln!("[trust_core] keystore key missing with prior state -> TAMPER_SUSPECTED");
            return;
        }
    };

    match ss::load_trust_snapshot(&path, &*store, active_key.as_deref()) {
        ss::LoadVerdict::FreshInstall => {
            kernel.restore(LicenseState::Unactivated, 0, 0);
            super::time_engine::global_time_kernel().load_from_snapshot(&empty_time_snapshot());
            eprintln!("[trust_core] fresh install -> UNACTIVATED");
            persist_to_global_dir();
        }
        ss::LoadVerdict::Verified(d) => {
            kernel.restore(d.state, d.generation, d.counter);
            super::time_engine::global_time_kernel().load_from_snapshot(&d);
            eprintln!(
                "[trust_core] startup state={} generation={} counter={}",
                d.state.as_code(),
                d.generation,
                d.counter
            );
        }
        ss::LoadVerdict::MigratedV1 { state, generation } => {
            // Adopt the v1 generation/counter, clear time fields
            // (unanchored → Advisory until re-anchor), re-seal to v2 now.
            let counter = store.load_counter().ok().flatten().unwrap_or(0);
            kernel.restore(state, generation, counter.max(1));
            super::time_engine::global_time_kernel().load_from_snapshot(&empty_time_snapshot());
            eprintln!("[trust_core] v1 snapshot migrated -> {} (re-sealing v2)", state.as_code());
            persist_to_global_dir();
        }
        ss::LoadVerdict::QuarantineTamper(reason) => {
            kernel.set_state(LicenseState::TamperSuspected);
            eprintln!("[trust_core] snapshot tamper ({reason:?}) -> TAMPER_SUSPECTED");
        }
        ss::LoadVerdict::Corrupt => {
            kernel.set_state(LicenseState::Corrupted);
            eprintln!("[trust_core] snapshot verification failed -> CORRUPTED");
        }
    }
}

fn empty_time_snapshot() -> super::secure_storage::SnapshotData {
    super::secure_storage::SnapshotData {
        state: LicenseState::Unknown,
        generation: 0,
        counter: 0,
        boot_session_id: None,
        last_trusted_wall_utc_ms: None,
        last_monotonic_ms: None,
        last_server_time_utc_ms: None,
        last_server_seq: None,
    }
}

/// Persist the kernel + time state through the crash-safe dual path
/// (file first with fsync, keystore counter second). Best-effort: logs
/// failures, never panics.
pub fn persist_snapshot(app_data_dir: &std::path::Path) {
    persist_to_dir(app_data_dir);
}

fn persist_to_dir(app_data_dir: &std::path::Path) {
    let (store, _) = select_store(app_data_dir);
    persist_with_store(app_data_dir, &*store);
}

fn persist_with_store(app_data_dir: &std::path::Path, store: &dyn super::secure_storage::KeyStore) {
    use super::secure_storage as ss;
    let kernel = global_kernel();
    let guard = kernel.inner.read();
    let tf = super::time_engine::global_time_kernel().read_fields();
    let path = ss::snapshot_path(app_data_dir);

    // Resolve the sealing key: provision on genuine fresh machines only.
    let file_exists = path.exists();
    let counter_hint = store.load_counter().ok().flatten();
    let prior = file_exists || counter_hint.is_some();
    let key: Vec<u8> = match ss::resolve_mac_key(store, prior) {
        ss::KeyResolution::Active { key, .. } => key,
        ss::KeyResolution::ProvisionOnFirstPersist => match ss::provision_mac_key(store) {
            Ok(k) => {
                eprintln!("[trust_core] provisioned fresh trust key");
                k
            }
            Err(e) => {
                eprintln!("[trust_core] snapshot persist failed (no key): {e:?}");
                return;
            }
        },
        ss::KeyResolution::QuarantineNoKey => {
            eprintln!("[trust_core] snapshot persist refused: no usable key");
            return;
        }
    };

    let data = ss::SnapshotData {
        state: guard.state,
        generation: guard.generation,
        counter: guard.counter,
        boot_session_id: tf.boot_session_id,
        last_trusted_wall_utc_ms: tf.last_trusted_wall_utc_ms,
        last_monotonic_ms: tf.last_monotonic_ms,
        last_server_time_utc_ms: tf.last_server_time_utc_ms,
        last_server_seq: tf.last_server_seq,
    };
    drop(guard);
    if let Err(e) = ss::persist_trust_snapshot(&path, store, &data, &key) {
        eprintln!("[trust_core] snapshot persist failed: {e}");
    }
}

static APP_DIR: OnceLock<std::path::PathBuf> = OnceLock::new();

fn remember_app_dir(dir: &std::path::Path) {
    let _ = APP_DIR.set(dir.to_path_buf());
}

/// Persist using the startup-remembered directory (for evaluation paths
/// without an `AppHandle`).
fn persist_to_global_dir() {
    if let Some(dir) = APP_DIR.get() {
        persist_to_dir(dir);
    }
}

/// Select the keystore backend. Desktop production = OS keyring; a fresh
/// machine with a broken keyring degrades loudly to a provisional file
/// store (nothing to roll back yet); mobile = file vault (weak, flagged).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn select_store(app_data_dir: &std::path::Path) -> (Box<dyn super::secure_storage::KeyStore>, bool) {
    use super::secure_storage as ss;
    let os = ss::OsKeyStore;
    let file = ss::snapshot_path(app_data_dir);
    match os.load_counter() {
        Err(ss::StoreError::Unavailable(_)) if !file.exists() => {
            eprintln!("[trust_core] OS keyring unavailable on fresh machine — provisional file store (degraded)");
            (
                Box::new(ss::FileKeyStore::new(ss::FileKeyStore::default_path(
                    app_data_dir,
                ))),
                true,
            )
        }
        _ => (Box::new(os), false),
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) fn select_store(app_data_dir: &std::path::Path) -> (Box<dyn super::secure_storage::KeyStore>, bool) {
    use super::secure_storage as ss;
    // No Keystore/Keychain bridge exists: same-filesystem vault (flagged).
    (
        Box::new(ss::FileKeyStore::new(ss::FileKeyStore::default_path(
            app_data_dir,
        ))),
        true,
    )
}

/// Run the time decision engine and enforce strong verdicts. Advisory
/// verdicts change nothing. Clock states are sticky: only non-clock states
/// may enter them, and only re-anchor exits. Trusted ratchets persist.
fn evaluate_time_policy() {
    use super::clocks::production_monotonic;
    use super::time_engine as te;
    let kernel = global_kernel();
    let (state, _) = kernel.get();
    let eligible = matches!(
        state,
        LicenseState::Unactivated
            | LicenseState::Operational
            | LicenseState::Expired
            | LicenseState::GraceExceeded
    );
    if !eligible {
        return;
    }
    let wall_now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if wall_now_ms == 0 {
        return;
    }
    let tkm = te::global_time_kernel();
    let tf = tkm.read_fields();
    let checkpoint = match (tf.last_monotonic_ms, tf.last_trusted_wall_utc_ms) {
        (Some(m), Some(w)) => Some(te::PersistedCheckpoint {
            boot_session_id: tf.boot_session_id,
            monotonic_ms: m,
            wall_utc_ms: w,
        }),
        _ => None,
    };
    let clock = production_monotonic();
    let outcome = te::evaluate(checkpoint, wall_now_ms, &clock);
    match outcome.verdict {
        te::TimeVerdict::Trusted { .. } => {
            if let Some(upd) = outcome.checkpoint_update {
                tkm.apply_checkpoint(&upd);
                kernel.bump_counter_only();
                persist_to_global_dir();
            }
        }
        te::TimeVerdict::ResetRequired => {
            kernel.set_state(LicenseState::ClockResetRequired);
            eprintln!("[trust_core][time] CLOCK_RESET_REQUIRED (wall behind anchor)");
            persist_to_global_dir();
        }
        te::TimeVerdict::TamperSuspected => {
            kernel.set_state(LicenseState::TamperSuspected);
            eprintln!("[trust_core][time] TAMPER_SUSPECTED (same-boot rollback)");
            persist_to_global_dir();
        }
        te::TimeVerdict::Advisory => {}
    }
}

/// Native license sync (LicenseManagement): verifies the Ed25519 token
/// natively (see [`super::license_token`]) against the NATIVE hardware
/// fingerprint and advances the kernel to OPERATIONAL or EXPIRED. Invalid
/// tokens leave the kernel untouched. `native_hwid_hash` must be computed
/// natively — never accepted from the client.
///
/// Time seeding: on success the time checkpoint is seeded ONLY when absent.
/// Re-activation never re-seeds, so rollback cannot be laundered through
/// re-activation (the old checkpoint keeps judging the wall).
///
/// Wall-clock note: expiry uses caller `now_sec` (system clock) until
/// server-asserted time lands via re-anchor; signature forgery stays
/// impossible regardless.
pub fn sync_verified_license(
    token: &str,
    native_hwid_hash: &str,
    now_sec: u64,
) -> Result<LicenseState, TrustError> {
    use super::license_token as lt;
    let verified = lt::verify_license_token(token, lt::PRODUCTION_PUBLIC_KEY_B64URL, now_sec)?;
    if !lt::device_binding_ok(&verified.device_id, native_hwid_hash) {
        // Token belongs to another terminal (e.g. a cloned database moved
        // across devices): fail closed to CORRUPTED so only re-activation
        // (LicenseManagement) remains. Never leave a stale OPERATIONAL.
        global_kernel().set_state(LicenseState::Corrupted);
        return Err(TrustError::SecurityPolicyFailure {
            reason: "license bound to another device",
        });
    }
    let next = if verified.expired {
        LicenseState::Expired
    } else {
        LicenseState::Operational
    };
    global_kernel().set_state(next);
    seed_time_checkpoint_once(now_sec.saturating_mul(1000));
    Ok(next)
}

/// Seed the time checkpoint at activation iff absent. Best-effort wall time
/// (mirrors the previous `clockGuard` anchoring); all later judgments still
/// require continuity, so a manipulated wall at activation only buys an
/// Advisory baseline, never trust.
fn seed_time_checkpoint_once(wall_ms: u64) {
    use super::clocks::production_monotonic;
    let tkm = super::time_engine::global_time_kernel();
    let tf = tkm.read_fields();
    if tf.last_trusted_wall_utc_ms.is_some() {
        return;
    }
    let mono = production_monotonic();
    tkm.apply_checkpoint(&super::time_engine::CheckpointUpdate {
        boot_session_id: mono.boot_id(),
        wall_utc_ms: wall_ms,
        monotonic_ms: mono.now_ms().unwrap_or(0),
    });
    global_kernel().bump_counter_only();
}

/// Honest-client revocation propagation (LicenseManagement): records a
/// server-reported suspension/revocation in the kernel. Residual gap
/// (reported): a malicious client can omit this call, so revocation
/// freshness against an active webview attacker still depends on token
/// expiry + the TypeScript heartbeat until a native verification heartbeat
/// exists. Stale-OPERATIONAL-after-revocation is the accepted residual.
pub fn report_revocation(revoked: bool) -> LicenseState {
    let next = if revoked {
        LicenseState::Revoked
    } else {
        LicenseState::Suspended
    };
    global_kernel().set_state(next);
    next
}

/// `#[tauri::command]` wrapper for [`sync_verified_license`]. The native
/// hardware fingerprint is computed here, inside the trust boundary — the
/// client supplies only the token. Returns the coarse state code; never any
/// license internals.
#[tauri::command]
pub fn trust_sync_license(
    app: tauri::AppHandle,
    token: String,
) -> Result<String, TrustError> {
    require_capability("trust_sync_license", Capability::LicenseManagement)?;
    if token.len() > 16 * 1024 {
        return Err(TrustError::IPCProtocolError {
            reason: "license token oversized",
        });
    }
    let native_hwid = crate::hardware::native_hwid_hash(&app);
    let now_sec = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let next = sync_verified_license(token.trim(), &native_hwid, now_sec)?;
    persist_current_snapshot(&app);
    Ok(next.as_code().to_string())
}

/// `#[tauri::command]` wrapper for [`report_revocation`].
#[tauri::command]
pub fn trust_report_revocation(app: tauri::AppHandle, revoked: bool) -> Result<String, TrustError> {
    require_capability("trust_report_revocation", Capability::LicenseManagement)?;
    let next = report_revocation(revoked);
    persist_current_snapshot(&app);
    Ok(next.as_code().to_string())
}

pub(crate) fn persist_current_snapshot(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_data_dir() {
        remember_app_dir(&dir);
        persist_to_dir(&dir);
    }
}

/// All Tauri command names that must appear in either [`COMMAND_REGISTRY`]
/// or [`PUBLIC_COMMANDS`]. The completeness test enumerates the real
/// `#[tauri::command]` functions from source and diffs against this list, so
/// an unlisted handler fails the build.
#[cfg(test)]
pub static ALL_COMMAND_FNS_IN_TESTS: &[&str] = &[
    // SAV intake photo attachments (filesystem + SHA-256; never generic SQL).
    "sav_attachment_write",
    "sav_attachment_read",
"sav_attachment_purge",
    "sav_attachment_sweep_stale_drafts",
    "sqlite_print_raw_escpos",
    "sqlite_open_cash_drawer",
    "get_cloud_credentials",
    "set_cloud_credentials",
    "delete_cloud_credentials",
    "create_database_backup",
    "list_database_backups",
    "sqlite_check_db_version",
    "sqlite_db_maintenance",
    "emergency_export_ledger",
    "launch_dialer",
    "launch_call",
    "launch_whatsapp",
    "launch_print",
    "launch_print_label",
    "mobile_wifi_print",
    "mobile_bluetooth_printers",
    "mobile_bluetooth_print",
    "launch_url",
    "hardware_scan_devices",
    "hardware_update_vfd",
    "get_hardware_fingerprint",
    "get_license_token",
    "set_license_token",
    "delete_license_token",
    "po_process_raw_scan",
    "po_commit_stock_batch",
    "process_raw_scan",
    "commit_stock_batch",
    "mobile_scan_document",
    "get_gate_state",
    "trust_sync_license",
    "trust_report_revocation",
    "trust_reanchor_challenge",
    "trust_reanchor_time",
    "audit_append",
    "audit_note_swallowed",
    "audit_verify",
    "pin_verify",
    "pin_lockout_remaining",
    "prune_snapshots",
    "pin_set",
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn set(state: LicenseState) {
        global_kernel().set_state(state);
    }

    #[test]
    fn unknown_denies_everything_including_license_management() {
        let _g = serial_test_lock();
        global_kernel().reset_for_tests();
        for cap in super::super::capability_policy::ALL_CAPABILITIES {
            let r = require_capability("probe", cap);
            // "probe" is unregistered -> denied regardless; use a registered cmd:
            let _ = r;
        }
        // Registered command, UNKNOWN state -> denied for every capability.
        for (cmd, cap) in COMMAND_REGISTRY {
            let r = authorize_and_execute(cmd, *cap, |_| Ok::<_, TrustError>(()));
            assert!(r.is_err(), "{cmd} must be denied in UNKNOWN");
        }
        // Even LicenseManagement is denied in UNKNOWN (B.3).
        let r = authorize_and_execute(
            "get_license_token",
            Capability::LicenseManagement,
            |_| Ok::<_, TrustError>(()),
        );
        assert!(matches!(
            r.unwrap_err(),
            TrustError::CapabilityDenied { .. }
        ));
    }

    #[test]
    fn unactivated_allows_only_license_management() {
        let _g = serial_test_lock();
        global_kernel().reset_for_tests();
        set(LicenseState::Unactivated);
        assert!(authorize_and_execute(
            "get_license_token",
            Capability::LicenseManagement,
            |_| Ok::<_, TrustError>(())
        )
        .is_ok());
        for (cmd, cap) in COMMAND_REGISTRY {
            if *cap == Capability::LicenseManagement {
                continue;
            }
            let r = authorize_and_execute(cmd, *cap, |_| Ok::<_, TrustError>(()));
            assert!(r.is_err(), "{cmd} must be denied in UNACTIVATED");
        }
    }

    #[test]
    fn operational_allows_all_and_denied_op_never_runs() {
        let _g = serial_test_lock();
        global_kernel().reset_for_tests();
        set(LicenseState::Operational);
        let mut ran = false;
        let r = authorize_and_execute(
            "po_commit_stock_batch",
            Capability::OperationalWrites,
            |_| {
                ran = true;
                Ok::<_, TrustError>(())
            },
        );
        assert!(r.is_ok() && ran);

        set(LicenseState::Expired);
        let mut ran = false;
        let r = authorize_and_execute(
            "po_commit_stock_batch",
            Capability::OperationalWrites,
            |_| {
                ran = true;
                Ok::<_, TrustError>(())
            },
        );
        assert!(r.is_err() && !ran, "denied op must not execute");
        // EXPIRED keeps EmergencyExport (independent of OPERATIONAL).
        assert!(authorize_and_execute(
            "emergency_export_ledger",
            Capability::EmergencyExport,
            |_| Ok::<_, TrustError>(())
        )
        .is_ok());
        // REVOKED denies writes.
        set(LicenseState::Revoked);
        assert!(authorize_and_execute(
            "po_commit_stock_batch",
            Capability::OperationalWrites,
            |_| Ok::<_, TrustError>(())
        )
        .is_err());
    }

    #[test]
    fn unregistered_command_is_denied() {
        let _g = serial_test_lock();
        global_kernel().reset_for_tests();
        set(LicenseState::Operational);
        let r = authorize_and_execute("does_not_exist", Capability::OperationalWrites, |_| {
            Ok::<_, TrustError>(())
        });
        assert!(matches!(
            r.unwrap_err(),
            TrustError::SecurityPolicyFailure { .. }
        ));
        // Wrong capability for a registered command is also denied.
        let r = authorize_and_execute(
            "po_commit_stock_batch",
            Capability::Sync,
            |_| Ok::<_, TrustError>(()),
        );
        assert!(r.is_err());
    }

    #[test]
    fn capability_reevaluated_every_call_no_caching() {
        let _g = serial_test_lock();
        global_kernel().reset_for_tests();
        set(LicenseState::Operational);
        let (_, gen1) = global_kernel().get();
        assert!(authorize_and_execute(
            "po_commit_stock_batch",
            Capability::OperationalWrites,
            |_| Ok::<_, TrustError>(())
        )
        .is_ok());
        set(LicenseState::Expired);
        let (_, gen2) = global_kernel().get();
        assert_ne!(gen1, gen2, "transition must bump generation");
        assert!(authorize_and_execute(
            "po_commit_stock_batch",
            Capability::OperationalWrites,
            |_| Ok::<_, TrustError>(())
        )
        .is_err());
    }

    #[test]
    fn stale_generation_aborts_commit() {
        let _g = serial_test_lock();
        global_kernel().reset_for_tests();
        set(LicenseState::Operational);
        let (_, entry_gen) = global_kernel().get();
        // State moves mid-operation (e.g. revocation lands during a batch).
        set(LicenseState::Revoked);
        let r = global_kernel().ensure_generation_unchanged(entry_gen);
        assert!(matches!(
            r.unwrap_err(),
            TrustError::TerminalLocked { .. }
        ));
        // Fresh generation passes.
        let (_, fresh) = global_kernel().get();
        assert!(global_kernel().ensure_generation_unchanged(fresh).is_ok());
    }

    #[test]
    fn get_gate_state_is_public_and_coarse() {
        let _g = serial_test_lock();
        global_kernel().reset_for_tests();
        set(LicenseState::Expired);
        let gs = get_gate_state();
        assert_eq!(gs.state_code, "EXPIRED");
        assert_eq!(gs.gate_code, "EXPIRED");
        // No license internals, no timestamps, no paths in the struct.
        let json = serde_json::to_value(&gs).unwrap();
        assert!(json.get("state_code").is_some());
        assert!(json.get("generation").is_some());
        assert!(json.get("token").is_none());
        assert!(json.get("key").is_none());
        // Phase 4.5 surfaced fields are present and coarse (status string +
        // monotonic counter — no chains, hashes, or key material).
        assert!(json.get("audit_boot").is_some());
        assert!(json.get("audit_swallowed").is_some());
        assert!(json.get("entry_hash").is_none());
        assert!(json.get("mac").is_none());
    }

    #[test]
    fn error_wire_shape_is_coarse_only() {
        let e = TrustError::CapabilityDenied {
            command: "po_commit_stock_batch",
            capability: "OperationalWrites",
            state_code: "EXPIRED".to_string(),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["gate_code"], "EXPIRED");
        assert_eq!(v["message_key"], "license.denied");
        assert_eq!(v["kind"], "CapabilityDenied");
        let s = serde_json::to_string(&e).unwrap();
        // No secrets, credentials, tokens, or file paths on the wire.
        // (Note: the field NAME "message_key" legitimately contains "key".)
        assert!(!s.contains("secret"), "no secrets on the wire");
        assert!(!s.contains("token"), "no tokens on the wire");
        assert!(!s.contains("credential"), "no credentials on the wire");
        assert!(!s.contains(".db"), "no file paths on the wire");
    }

    /// B.6 completeness: every real `#[tauri::command]` in the crate must be
    /// listed in either the registry or the public set. Enumerates source so
    /// a newly added handler without a registry entry fails here.
    #[test]
    fn registry_covers_every_tauri_command() {
        let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let src = manifest.join("src");
        let mut found: HashMap<String, String> = HashMap::new();
        let mut files: Vec<std::path::PathBuf> = Vec::new();
        collect_rs(&src, &mut files);
        for f in &files {
            let text = std::fs::read_to_string(f).unwrap();
            for name in parse_tauri_commands(&text) {
                found.insert(name, f.display().to_string());
            }
        }
        let mut missing = Vec::new();
        for (name, file) in &found {
            let in_registry = COMMAND_REGISTRY.iter().any(|(n, _)| n == name);
            let in_public = PUBLIC_COMMANDS.contains(&name.as_str());
            let in_list = ALL_COMMAND_FNS_IN_TESTS.contains(&name.as_str());
            if !(in_registry || in_public) {
                missing.push(format!("{name} ({file}) not in registry/public"));
            }
            if !in_list {
                missing.push(format!("{name} ({file}) not in ALL_COMMAND_FNS_IN_TESTS"));
            }
        }
        // Reverse: registry entries must correspond to real commands.
        for (name, _) in COMMAND_REGISTRY {
            if !found.contains_key(*name) {
                missing.push(format!("registry entry {name} has no #[tauri::command]"));
            }
        }
        for name in PUBLIC_COMMANDS {
            if !found.contains_key(*name) {
                missing.push(format!("public entry {name} has no #[tauri::command]"));
            }
        }
        assert!(missing.is_empty(), "registry gaps:\n{}", missing.join("\n"));
    }

    /// G-07 guard: every registered handler body must reference the
    /// authorization path (or delegate to a function that does). A future
    /// command that skips the wrapper fails here and in CI
    /// (`scripts/check-trust-registry.mjs`).
    #[test]
    fn every_handler_references_authorization() {
        let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let src = manifest.join("src");
        // Commands allowed to delegate instead of wrapping directly.
        let delegates: HashMap<&str, &str> = [
            ("process_raw_scan", "po_process_raw_scan"),
            ("commit_stock_batch", "po_commit_stock_batch"),
        ]
        .into_iter()
        .collect();
        let mut violations = Vec::new();
        let mut files: Vec<std::path::PathBuf> = Vec::new();
        collect_rs(&src, &mut files);
        for f in &files {
            // Trust-core's own commands are the mechanism, not consumers.
            if f.ends_with("trust_core/ipc_authorizer.rs") {
                continue;
            }
            let text = std::fs::read_to_string(f).unwrap();
            for (name, body) in parse_tauri_command_bodies(&text) {
                if is_public_command(&name) {
                    continue;
                }
                let wrapped = body.contains("authorize_and_execute")
                    || body.contains("require_capability");
                let delegated = delegates
                    .get(name.as_str())
                    .map(|target| body.contains(target))
                    .unwrap_or(false);
                if !(wrapped || delegated) {
                    violations.push(format!("{name} ({}): no authorization call", f.display()));
                }
            }
        }
        assert!(
            violations.is_empty(),
            "handlers bypassing authorization:\n{}",
            violations.join("\n")
        );
    }

    fn collect_rs(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                // Skip target/ and gen/ build output.
                if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                    if name == "target" || name == "gen" || name == "target-test" {
                        continue;
                    }
                }
                collect_rs(&p, out);
            } else if p.extension().and_then(|e| e.to_str()) == Some("rs") {
                out.push(p);
            }
        }
    }

    /// Finds `fn NAME` (pub or private, sync or async) immediately following
    /// each `#[tauri::command]`.
    fn parse_tauri_commands(text: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut lines = text.lines().peekable();
        while let Some(line) = lines.next() {
            if line.trim() == "#[tauri::command]" {
                for next in lines.by_ref() {
                    let t = next.trim();
                    if t.is_empty() || t.starts_with('#') || t.starts_with("//") {
                        continue;
                    }
                    // `fn NAME`, `pub fn NAME`, `pub async fn NAME`, ...
                    if let Some(fn_pos) = t.find("fn ") {
                        let prefix = &t[..fn_pos];
                        if prefix.trim().is_empty()
                            || prefix.trim() == "pub"
                            || prefix.trim() == "pub async"
                            || prefix.trim() == "async"
                        {
                            out.push(fn_name(&t[fn_pos + "fn ".len()..]));
                        }
                    }
                    break;
                }
            }
        }
        out
    }

    /// Maps each `#[tauri::command]` fn to the text following its signature
    /// (up to 4000 chars — enough to contain the authorization call that
    /// every wrapped handler performs first).
    fn parse_tauri_command_bodies(text: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for name in parse_tauri_commands(text) {
            // Match `fn NAME(` regardless of pub/async qualifiers.
            let mut pos = None;
            for marker in [
                format!("fn {name}("),
                format!("fn {name}<"),
            ] {
                if let Some(i) = text.find(marker.as_str()) {
                    pos = Some(i);
                    break;
                }
            }
            if let Some(i) = pos {
                let end = (i + 4000).min(text.len());
                out.push((name, text[i..end].to_string()));
            }
        }
        out
    }

    fn fn_name(rest: &str) -> String {
        rest.chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect()
    }

    #[test]
    fn client_supplied_state_cannot_override_kernel() {
        // There is no API that sets kernel state from a client string:
        // set_state takes the typed enum, sync_verified_license verifies a
        // signature first. Forged input fails before any transition.
        let _g = serial_test_lock();
        global_kernel().reset_for_tests();
        set(LicenseState::Expired);
        let r = super::super::license_token::verify_license_token(
            "forged.token.here",
            super::super::license_token::PRODUCTION_PUBLIC_KEY_B64URL,
            1_800_000_000,
        );
        assert!(r.is_err());
        let (state, _) = global_kernel().get();
        assert_eq!(state, LicenseState::Expired, "kernel untouched by forgery");
    }

    #[test]
    fn fresh_machine_provisions_key_and_persists_even_with_bumped_counter() {
        let _g = serial_test_lock();
        global_kernel().reset_for_tests();
        set(LicenseState::Operational); // counter is now 1

        let temp_dir = std::env::temp_dir().join(format!(
            "mobi-fresh-persist-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let store = crate::trust_core::secure_storage::test_support::MemKeyStore::new();
        persist_with_store(&temp_dir, &store);

        // Key must have been provisioned on first persist
        let key = store.load_mac_key().unwrap();
        assert!(key.is_some(), "MAC key must be provisioned on first persist");

        // Counter must be stored in keystore
        let counter = store.load_counter().unwrap();
        assert_eq!(counter, Some(1), "counter must be stored in keystore");

        // Snapshot file must exist and verify
        let path = super::super::secure_storage::snapshot_path(&temp_dir);
        assert!(path.exists(), "snapshot file must exist");

        let verdict = super::super::secure_storage::load_trust_snapshot(&path, &store, key.as_deref());
        match verdict {
            super::super::secure_storage::LoadVerdict::Verified(data) => {
                assert_eq!(data.state, LicenseState::Operational);
                assert_eq!(data.counter, 1);
            }
            other => panic!("expected Verified, got {other:?}"),
        }

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}

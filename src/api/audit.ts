import { invokeCommand } from '../platform/invoke';

export interface NativeAuditAppendRequest {
  action: string;
  details: string;
  user?: string;
  requiresPin?: boolean;
  deviceId?: string;
  ipAddress?: string;
}

export interface NativeAuditAppendReceipt {
  eventId: string;
  entryHash?: string;
}

/**
 * IPC-011 budget: the native side holds a 5s busy_timeout on the audit
 * open, so 8s covers a slow-but-alive backend with margin while guaranteeing
 * a wedged backend surfaces as IPC_TIMEOUT instead of hanging the awaiting
 * primary flow forever. Callers keep the swallow policy (audit never blocks).
 */
export const AUDIT_IPC_TIMEOUT_MS = 8000;

/** Budget for the best-effort swallow report (fire-and-forget telemetry). */
export const AUDIT_REPORT_TIMEOUT_MS = 3000;

/**
 * Phase 4.4 Tier A audit path: the WebView never writes
 * `security_audit_logs` directly when this is available — native code
 * performs the INSERT plus the hash-chain link. Throws on validation or
 * denial; callers keep the existing swallow policy (audit never blocks).
 */
export async function auditAppend(
  request: NativeAuditAppendRequest
): Promise<NativeAuditAppendReceipt> {
  return invokeCommand<NativeAuditAppendReceipt>(
    'audit_append',
    { request },
    'INTERNAL_ERROR',
    { timeoutMs: AUDIT_IPC_TIMEOUT_MS }
  );
}

// ── Swallowed-failure visibility (Phase 4.5) ─────────────────────────────
// The funnel swallows audit failures by policy (audit never blocks money
// flows). Swallowed is not the same as invisible: every swallow increments
// this in-memory counter (reset on reload — it measures the session, not
// history) and logs with the running total. Surface for smoke checks and
// diagnostics; a persistently climbing count means the audit path is down.
//
// WP2a: each swallow is ALSO reported natively (best-effort, fire-and-forget)
// so the total survives WebView reloads and is visible inside the trust
// boundary via `get_gate_state.audit_swallowed`. The report itself can never
// throw or recurse: its own failure only leaves the TS counter (no infinite
// regress — a failing report is never itself reported).
let swallowedAuditFailures = 0;

export function noteSwallowedAuditFailure(context: string): number {
  swallowedAuditFailures += 1;
  console.warn(
    `[audit] swallowed failure #${swallowedAuditFailures} (${context}) — audit telemetry degraded, primary flow unaffected`
  );
  try {
    const p = invokeCommand<number>(
      'audit_note_swallowed',
      { context: String(context).slice(0, 128) },
      'INTERNAL_ERROR',
      { timeoutMs: AUDIT_REPORT_TIMEOUT_MS }
    );
    // Fire-and-forget: never let surfacing break the funnel it reports on.
    void Promise.resolve(p).catch(() => {});
  } catch {
    // Synchronous invoke failure (no backend): TS counter already recorded.
  }
  return swallowedAuditFailures;
}

export function getSwallowedAuditFailures(): number {
  return swallowedAuditFailures;
}

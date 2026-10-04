/**
 * Scoped emergency compliance exporter — TypeScript facade.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The activation gate is the only surface a merchant can reach once the licence
 * is not ACTIVE. It must be able to hand over financial records for statutory
 * retention WITHOUT becoming a back door into the POS. This module is that
 * narrow corridor, and it is deliberately the *only* thing the gate may import
 * from the data layer.
 *
 * The heavy lifting (read-only connection, SQL allowlist, streaming, SHA-256,
 * audit row) lives in `src-tauri/src/emergency_export.rs`. That is deliberate:
 * the read-only guarantee must be enforced by the SQLite engine, not by a
 * JavaScript convention that a future edit can quietly drop.
 *
 * ── BOUNDARY RULES (enforced by scripts/check-boundaries.mjs) ───────────────
 * This module — and `ActivationGateScreen` — must NOT import:
 *   • store slices / `usePosStore`  (would re-hydrate the operating app)
 *   • `db/adapters` or `db/repositories` (the app's pooled, WRITABLE handle)
 *   • `db/sqlPluginAdapter` (loads the plugin pool → the whole app DB layer)
 *   • `sync/*` (network egress from a locked terminal)
 *   • `licensing/client` (activation/heartbeat — the gate owns that already)
 *
 * The one permitted data dependency is `platform/invoke`, which is a thin
 * typed IPC wrapper with no app state. It is reached through an INJECTABLE
 * TRANSPORT rather than a module-level import, for three reasons:
 *   • the policy layer (allowlist, PIN presence, cancellation) becomes testable
 *     in plain Node, with no Tauri runtime present;
 *   • a test can substitute a transport and assert the exact command name and
 *     payload the gate sends, which is the contract that matters;
 *   • the gate cannot bypass the transport by importing the raw IPC helper.
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** Tables the exporter will accept. Mirrors the Rust `AllowedTable` enum. */
export type EmergencyExportTable =
  | 'sales_journal'
  | 'sales_journal_lines'
  | 'shift_sessions'
  | 'shift_movements';

export const EMERGENCY_EXPORT_TABLES: readonly EmergencyExportTable[] = [
  'sales_journal',
  'sales_journal_lines',
  'shift_sessions',
  'shift_movements',
];

/** Per-file result, including the SHA-256 the audit row is bound to. */
export interface EmergencyExportedFile {
  table: string;
  fileName: string;
  absolutePath: string;
  rowCount: number;
  byteLen: number;
  /** SHA-256 of the file contents, computed while streaming. */
  sha256: string;
}

export interface EmergencyExportResult {
  exportDir: string;
  files: EmergencyExportedFile[];
  auditEventId: string;
  authorizedAdminId: string;
  licenseStatusAtExport: string;
  completedAt: string;
  /** Absolute path of the external manifest (`manifest.json`). Phase 3. */
  manifestPath?: string;
  /** Top-level SHA-256 over the per-file hashes. Phase 3. */
  exportSha256?: string;
  /** HMAC-SHA256 over the canonical manifest bytes, if a trust key was
   * available at export time. Absence is recorded, never faked. Phase 3.1. */
  manifestMac?: string;
  /** Quarantine posture: "clean" | "tamper" | "clock". Non-clean exports are
   * verifier-flagged (recovery-only). Phase 3.1. */
  integrityState?: string;
  /** Set when the DB audit row could not be written. The export still
   * succeeded; the failure is recorded in the manifest instead. Phase 3. */
  auditError?: string;
}

export interface EmergencyExportProgress {
  table: string;
  rows: number;
}

export interface EmergencyExportRequest {
  /** Owner / manager PIN. Verified natively; never logged, never stored. */
  pin: string;
  /** Subset of {@link EMERGENCY_EXPORT_TABLES}. Omit for all. */
  tables?: EmergencyExportTable[];
  /**
   * REMOVED in Phase 1 (B.7): the native kernel determines and records its
   * own coarse license state. Kept as an ignored optional so older callers
   * still compile; it is never sent over IPC.
   * @deprecated Do not use — the kernel owns license state.
   */
  licenseStatus?: string;
}

export class EmergencyExportError extends Error {
  readonly code: 'INVALID_PIN' | 'FORBIDDEN_TABLE' | 'FAILED' | 'CANCELLED';
  constructor(message: string, code: EmergencyExportError['code'] = 'FAILED') {
    super(message);
    this.name = 'EmergencyExportError';
    this.code = code;
  }
}

// ── Injectable transport ────────────────────────────────────────────────────

/** The subset of the native command surface the exporter needs. */
export interface EmergencyExportTransport {
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  onProgress(handler: (p: EmergencyExportProgress) => void): Promise<() => void>;
}

let transportOverride: EmergencyExportTransport | null = null;

/**
 * Replace the transport. Intended for tests; production leaves it unset and
 * uses the Tauri-backed default below.
 */
export function setEmergencyExportTransport(t: EmergencyExportTransport | null): void {
  transportOverride = t;
}

/**
 * Default Tauri transport.
 *
 * Loaded lazily via dynamic import so importing this module has no side
 * effects and no hard dependency on the Tauri runtime — required by the
 * boundary and by the Node-based test suite.
 */
async function tauriTransport(): Promise<EmergencyExportTransport> {
  const [{ invokeCommand }, { listen }] = await Promise.all([
    import('../platform/invoke'),
    import('@tauri-apps/api/event'),
  ]);
  return {
    invoke: <T,>(command: string, args: Record<string, unknown>) =>
      invokeCommand<T>(command, args),
    onProgress: async (handler) => {
      const unlisten = await listen<EmergencyExportProgress>(
        'emergency-export-progress',
        (event) => handler(event.payload)
      );
      return unlisten;
    },
  };
}

async function getTransport(): Promise<EmergencyExportTransport> {
  return transportOverride ?? (await tauriTransport());
}

/**
 * Reject anything outside the allowlist before it reaches IPC.
 *
 * This is a fail-fast mirror of the Rust check, not the security boundary — the
 * Rust side re-validates. Its job is to make an over-broad request an obvious
 * client-side error instead of a round-trip, and to keep the allowed set
 * visible in one place for review.
 */
function assertTablesAllowed(tables: readonly string[] | undefined): void {
  if (!tables || tables.length === 0) return;
  const allowed = new Set<string>(EMERGENCY_EXPORT_TABLES);
  for (const t of tables) {
    if (!allowed.has(t)) {
      throw new EmergencyExportError(
        `Table non autorisée pour l'export de conformité : ${t}`,
        'FORBIDDEN_TABLE'
      );
    }
  }
}

/** Reject a blank PIN locally so a typo never round-trips to the engine. */
function assertPinPresent(pin: string): void {
  if (typeof pin !== 'string' || pin.trim().length === 0) {
    throw new EmergencyExportError('PIN gérant requis.', 'INVALID_PIN');
  }
}

/**
 * Subscribe to row-count progress. Returns an unsubscribe function.
 *
 * Listeners are attached per call and detached in `finally`, so a cancelled or
 * failed export cannot leave a listener behind holding the gate's closure.
 */
export async function onEmergencyExportProgress(
  handler: (p: EmergencyExportProgress) => void
): Promise<() => void> {
  const transport = await getTransport();
  return transport.onProgress(handler);
}

/**
 * Run the compliance export.
 *
 * Authentication is re-verified natively against the stored manager hash on
 * every invocation: there is no session token, no "already logged in" shortcut,
 * and no way to warm this path from an authenticated till.
 *
 * The progress listener is attached here and always detached, so callers
 * cannot leak a subscription on failure.
 *
 * @throws {EmergencyExportError} on invalid PIN, disallowed table, or engine failure.
 */
export async function runEmergencyComplianceExport(
  request: EmergencyExportRequest,
  options?: { signal?: AbortSignal; onProgress?: (p: EmergencyExportProgress) => void }
): Promise<EmergencyExportResult> {
  assertPinPresent(request.pin);
  assertTablesAllowed(request.tables);
  if (options?.signal?.aborted) {
    throw new EmergencyExportError('Export annulé.', 'CANCELLED');
  }

  const transport = await getTransport();
  let unlisten: (() => void) | null = null;
  try {
    if (options?.onProgress) {
      unlisten = await transport.onProgress(options.onProgress);
    }
    // Re-check after the (async) listener attach: an abort during setup must
    // not start an extraction.
    if (options?.signal?.aborted) {
      throw new EmergencyExportError('Export annulé.', 'CANCELLED');
    }

    return await transport.invoke<EmergencyExportResult>('emergency_export_ledger', {
      request: {
        pin: request.pin,
        tables: request.tables ?? [],
        // NOTE: no licenseStatus is sent (Phase 1 B.7). The native kernel
        // records its own coarse state code; client claims are ignored.
      },
    });
  } catch (err) {
    if (err instanceof EmergencyExportError) throw err;
    // Native denials arrive as { gate_code, message_key, kind, detail? } —
    // read the detail for the PIN retry signal, not just Error.message.
    const detail =
      err instanceof Error
        ? err.message
        : typeof err === 'object' && err !== null && 'detail' in err
          ? String((err as { detail?: unknown }).detail ?? '')
          : String(err);
    const message = detail || (err instanceof Error ? err.message : String(err));
    // The engine distinguishes an auth failure from an operational one; map
    // the auth case so the UI can prompt for a retry rather than a bug report.
    if (/pin/i.test(message) && /incorrect|refusé|refuse/i.test(message)) {
      throw new EmergencyExportError(message, 'INVALID_PIN');
    }
    throw new EmergencyExportError(message, 'FAILED');
  } finally {
    unlisten?.();
  }
}

/**
 * Human-readable one-line summary for the post-export receipt shown in the gate.
 * Pure formatting — no I/O, no state.
 */
export function summarizeExport(result: EmergencyExportResult): string {
  const total = result.files.reduce((sum, f) => sum + f.rowCount, 0);
  const bytes = result.files.reduce((sum, f) => sum + f.byteLen, 0);
  return `${result.files.length} fichier(s) · ${total.toLocaleString('fr-FR')} ligne(s) · ${(
    bytes /
    (1024 * 1024)
  ).toFixed(2)} Mo`;
}

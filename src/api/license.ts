import { invokeCommand } from '../platform/invoke';

export interface HardwareFingerprintResult {
  formatted: string; // e.g. "MOBI-7E28-A4F1-0B3C-9D82"
  hash: string;      // 64-character SHA-256 hex string
  platform: string;  // "windows" | "android" | "linux" | "macos" | "fallback"
}

export async function getHardwareFingerprint(): Promise<HardwareFingerprintResult> {
  return invokeCommand<HardwareFingerprintResult>('get_hardware_fingerprint');
}

export async function getLicenseToken(): Promise<string | null> {
  return invokeCommand<string | null>('get_license_token');
}

export async function setLicenseToken(token: string): Promise<void> {
  await invokeCommand('set_license_token', { token });
}

export async function deleteLicenseToken(): Promise<void> {
  await invokeCommand('delete_license_token');
}

// ── Phase 1 native trust kernel ─────────────────────────────────────────────
// The kernel owns license state natively (Ed25519-verified). These calls keep
// it in sync with the TypeScript verification flow; they never replace the
// existing React gating (presentation only until native enforcement is
// proven). All are best-effort from the UI perspective: failures are logged
// by callers and the kernel stays fail-closed.

export interface NativeGateState {
  state_code: string;
  gate_code: string;
  message_key: string;
  generation: number;
  /** Phase 4.5 boot audit-check outcome (`null` = background check has not
   * reported yet this boot). A `BROKEN ...` value is advisory here —
   * authoritative detail comes from `audit_verify` — but the UI must not
   * hide it: surface as a security warning, never as verified. */
  audit_boot: string | null;
}

/** Read-only coarse gate probe. Callable in every state, grants nothing. */
export async function getGateState(): Promise<NativeGateState> {
  return invokeCommand<NativeGateState>('get_gate_state');
}

/**
 * Ask the native kernel to verify `token` itself (Ed25519 + device binding)
 * and advance to OPERATIONAL/EXPIRED. The native hardware fingerprint is
 * computed inside the trust boundary — the client supplies only the token.
 * Returns the coarse native state code.
 */
export async function trustSyncLicense(token: string): Promise<string> {
  return invokeCommand<string>('trust_sync_license', { token });
}

/** Record a server-reported suspension/revocation in the native kernel. */
export async function trustReportRevocation(revoked: boolean): Promise<string> {
  return invokeCommand<string>('trust_report_revocation', { revoked });
}

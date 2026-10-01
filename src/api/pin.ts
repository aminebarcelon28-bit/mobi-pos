import { invokeCommand } from '../platform/invoke';

export interface NativePinVerifyRequest {
  userId: string;
  pin: string;
}

export interface NativePinVerifyResult {
  ok: boolean;
  locked: boolean;
  lockedRemainingMs: number;
  /**
   * Stored credential is legacy fast-hash: rotation required (manager) /
   * recommended. True by construction on the legacy path.
   */
  mustRotate: boolean;
  /**
   * True while the Argon2id backend is absent: no modern verification was
   * attempted. Callers must NOT treat this as success — only as
   * "unavailable, use the legacy JS path".
   */
  kdfUnavailable: boolean;
}

export interface NativePinSetRequest {
  userId: string;
  newPin: string;
}

/**
 * Phase 4.5 Tier A PIN plane (device-local, native verify). Legacy `v1$`
 * credentials verify natively TODAY (constant-time compare, persisted
 * escalating lockout, `mustRotate: true`); modern `v2$`/unknown formats fail
 * closed with `kdfUnavailable` until the Argon2id backend lands. The
 * lock-screen login calls this under Tauri and treats a native verdict as
 * final (no local fallback after a verdict — that would bypass the native
 * lockout); outside Tauri the login uses local verification. Never returns
 * the stored credential.
 */
export async function pinVerify(
  request: NativePinVerifyRequest
): Promise<NativePinVerifyResult> {
  return invokeCommand<NativePinVerifyResult>('pin_verify', {
    request,
  });
}

/**
 * Rotate a PIN to the modern format. Refuses until the Argon2id backend
 * lands (minting another fast hash would be a downgrade); policy validation
 * still runs so callers get typed errors today.
 */
export async function pinSet(request: NativePinSetRequest): Promise<string> {
  return invokeCommand<string>('pin_set', {
    request,
  });
}

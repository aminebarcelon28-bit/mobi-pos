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
   * True only when the KDF backend is genuinely absent (a degraded build).
   * Argon2id is always compiled in now, so this is false on every path — a
   * legacy success sets `mustRotate` instead. Never treat `true` as success.
   */
  kdfUnavailable: boolean;
}

export interface NativePinSetRequest {
  userId: string;
  newPin: string;
}

/**
 * Successful rotation. Carries NO credential material: the Argon2id hash is
 * minted AND persisted natively, never serialized into the WebView (trust
 * tables are native-write-only). There is deliberately no field to store.
 */
export interface NativePinSetResult {
  userId: string;
  /** Always `"v2"` — Argon2id is the only format minted. */
  format: string;
}

/**
 * Phase 4.5 Tier A PIN plane (device-local, native verify). Legacy `v1$`
 * credentials verify natively TODAY (constant-time compare, persisted
 * escalating lockout, `mustRotate: true`); modern `v2$` verifies with Argon2id
 * natively; an unknown/corrupt credential fails closed WITHOUT burning a
 * lockout slot (nothing was actually tested). The
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

export interface NativePinLockoutStatus {
  locked: boolean;
  lockedRemainingMs: number;
}

/**
 * F3 (pending merge approval): strictly read-only remaining-lockout query.
 * No PIN input, no state change. Unknown users answer identically to
 * known-unlocked ones ({locked:false, remaining 0}) — no enumeration.
 * No callers are wired to this yet.
 */
export async function pinLockoutRemaining(userId: string): Promise<NativePinLockoutStatus> {
  return invokeCommand<NativePinLockoutStatus>('pin_lockout_remaining', {
    request: { userId },
  });
}

/**
 * Rotate a PIN to Argon2id.
 *
 * The credential is minted and written by the Rust side; the returned result
 * carries no secret, so there is nothing here for a caller to persist (and no
 * way to persist it outside the trust boundary).
 */
export async function pinSet(request: NativePinSetRequest): Promise<NativePinSetResult> {
  return invokeCommand<NativePinSetResult>('pin_set', {
    request,
  });
}

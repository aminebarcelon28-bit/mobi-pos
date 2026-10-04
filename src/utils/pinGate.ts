/**
 * Phase 1 — ONE native-routing module for every manager/user PIN check.
 *
 * Rule: under Tauri, verification is `pin_verify` and ONLY `pin_verify`.
 * Transport error / unavailable kernel → deny, never a local fallback.
 * Outside Tauri (web preview / tests) a weak local fallback runs ONLY when
 * explicitly allowed, flagged `weaker: true`, and NEVER authorizes
 * wipe/export/restore/prune (those callers must not set the flag).
 *
 * Local outer pacing is preserved (same 5-fails → 15-min counter as before):
 * casual mashing throttles in UI before burning native budget. Native
 * `Locked` responses never record locally — the countdown comes straight
 * from the response (`locked_remaining_ms`, carried by the kernel).
 *
 * Input floor is digits-only, 4–32 chars for every role. This deliberately
 * admits legacy 4-digit manager credentials to the native check (the kernel
 * allows them once for migration); the kernel enforces the modern 6-floor
 * and burns budget on violations — that is the kernel's policy call, not
 * this module's. `mustRotate` is returned and ignored outside login flows
 * (rotation is owned by the lock screen).
 *
 * No audit rows are written here (FT-05 owns gate-denial rows; see the
 * coalesced-row proposal in the Phase 1 report). No state is kept that any
 * privileged action could consume — freshness windows stay caller-side.
 */

import { pinVerify } from '../api/pin';
import { checkPinLockout, recordPinFailure, resetPinLockout } from './security';
import { usePosStore } from '../store/usePosStore';
import { reportGateDenial } from './gateDenials';

/** Best-effort burst emitter shared with auditGate (single implementation). */
function burstEmit(signal: { gateName: string; userId: string; locked: boolean; lockoutDurationMs: number }): void {
  try {
    reportGateDenial(signal);
  } catch {
    // Telemetry must never break the gate it reports on.
  }
}

export type GateRole = 'manager' | 'cashier';

export interface GateResult {
  ok: boolean;
  locked: boolean;
  /** Milliseconds from a native Locked response (0 otherwise). */
  remainingMs: number;
  mustRotate: boolean;
  /** True only on the explicitly-allowed weak outside-Tauri fallback. */
  weaker: boolean;
  reason?: 'denied' | 'locked' | 'local-locked' | 'unavailable' | 'bad-length';
}

export interface GateOptions {
  /** Weak local fallback (outside Tauri ONLY). Privileged actions never set this. */
  allowWeakFallback?: boolean;
  /** Injected native verifier (tests). */
  pinVerifyFn?: typeof pinVerify;
  /** Injected local verifier (tests / outside-Tauri fallback). */
  localVerifyFn?: (pin: string) => boolean;
}

function digitsOnly(pin: string): string | null {
  const clean = (pin || '').trim();
  if (!/^\d+$/.test(clean) || clean.length < 4 || clean.length > 32) return null;
  return clean;
}

function localLockedResult(): GateResult {
  return { ok: false, locked: true, remainingMs: 0, mustRotate: false, weaker: false, reason: 'local-locked' };
}

async function runLocalFallback(
  clean: string,
  localVerify: ((pin: string) => boolean) | undefined
): Promise<GateResult> {
  if (!localVerify) {
    return { ok: false, locked: false, remainingMs: 0, mustRotate: false, weaker: false, reason: 'unavailable' };
  }
  try {
    const ok = Boolean(localVerify(clean));
    return ok
      ? { ok: true, locked: false, remainingMs: 0, mustRotate: false, weaker: true }
      : { ok: false, locked: false, remainingMs: 0, mustRotate: false, weaker: true, reason: 'denied' };
  } catch {
    return { ok: false, locked: false, remainingMs: 0, mustRotate: false, weaker: true, reason: 'unavailable' };
  }
}

/** Synchronous store-backed fallback for the weak path (same single call site). */
function defaultStoreLocalVerify(pin: string): boolean {
  try {
    return Boolean(usePosStore.getState().verifyManagerPin(pin));
  } catch {
    return false;
  }
}

/**
 * Exported for the ONE sanctioned weak consumer (journal view outside Tauri
 * dev builds): `auditGate.verifyManagerStepUp` accepts it as `localVerifyFn`.
 * Every other caller uses verifyManagerGate/verifyUserGate. This keeps the
 * literal `verifyManagerPin(` call in exactly one file (this one).
 */
export function storeLocalVerifyManager(pin: string): boolean {
  return defaultStoreLocalVerify(pin);
}

async function verifyNative(
  userId: string,
  clean: string,
  options: GateOptions
): Promise<GateResult> {
  // Outer pacing first: casual mashing throttles here without touching the
  // native budget. This is UI hygiene, not the boundary — the kernel's own
  // ladder is authoritative and cannot be cleared from here.
  const lock = checkPinLockout();
  if (lock.isLocked) return localLockedResult();

  const native = options.pinVerifyFn ?? pinVerify;
  try {
    const res = await native({ userId, pin: clean });
    const gateName = userId === 'manager' ? 'manager_pin' : `user_pin:${userId}`;
    if (res.locked) {
      // Locked ≠ wrong: do NOT record locally, surface the countdown —
      // but DO emit the burst immediately (a lockout is always visible).
      burstEmit({
        gateName,
        userId,
        locked: true,
        lockoutDurationMs: res.lockedRemainingMs,
      });
      return {
        ok: false,
        locked: true,
        remainingMs: res.lockedRemainingMs,
        mustRotate: false,
        weaker: false,
        reason: 'locked',
      };
    }
    if (!res.ok) {
      recordPinFailure();
      burstEmit({ gateName, userId, locked: false, lockoutDurationMs: 0 });
      return { ok: false, locked: false, remainingMs: 0, mustRotate: false, weaker: false, reason: 'denied' };
    }
    resetPinLockout();
    return { ok: true, locked: false, remainingMs: 0, mustRotate: res.mustRotate, weaker: false };
  } catch {
    // Transport failure under Tauri: fail closed, no local fallback (that
    // would bypass the native lockout exactly when something is wrong).
    // Not recorded locally either: an IPC outage is not a guess.
    return { ok: false, locked: false, remainingMs: 0, mustRotate: false, weaker: false, reason: 'unavailable' };
  }
}

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

/**
 * Verify a MANAGER PIN natively (`userId: 'manager'`). A cashier PIN never
 * passes unless byte-identical to the manager PIN (same guarantee as the
 * journal gate: the credential compared is always the manager's).
 */
export async function verifyManagerGate(pin: string, options: GateOptions = {}): Promise<GateResult> {
  const clean = digitsOnly(pin);
  if (!clean) {
    return { ok: false, locked: false, remainingMs: 0, mustRotate: false, weaker: false, reason: 'bad-length' };
  }
  if (isTauri()) return verifyNative('manager', clean, options);
  if (!options.allowWeakFallback) {
    return { ok: false, locked: false, remainingMs: 0, mustRotate: false, weaker: false, reason: 'unavailable' };
  }
  return runLocalFallback(clean, options.localVerifyFn ?? defaultStoreLocalVerify);
}

/**
 * Verify a specific user's PIN natively (self-checks: roster edit old-PIN,
 * cashier flows). Exact userId only — no manager override here; callers
 * compose `verifyUserGate(...) || verifyManagerGate(...)` explicitly when
 * either credential is acceptable, so profile confusion is always visible
 * at the call site.
 */
export async function verifyUserGate(
  userId: string,
  pin: string,
  options: GateOptions = {}
): Promise<GateResult> {
  const clean = digitsOnly(pin);
  const uid = (userId || '').trim();
  if (!clean || !uid) {
    return { ok: false, locked: false, remainingMs: 0, mustRotate: false, weaker: false, reason: 'bad-length' };
  }
  if (isTauri()) return verifyNative(uid, clean, options);
  if (!options.allowWeakFallback) {
    return { ok: false, locked: false, remainingMs: 0, mustRotate: false, weaker: false, reason: 'unavailable' };
  }
  const local = options.localVerifyFn;
  if (!local) {
    return { ok: false, locked: false, remainingMs: 0, mustRotate: false, weaker: false, reason: 'unavailable' };
  }
  return runLocalFallback(clean, local);
}

/** Minimum lengths for UI copy (the module floor is 4–32 for every role). */
export function minPinLengthForGateRole(role: GateRole): number {
  return role === 'cashier' ? 4 : 6;
}

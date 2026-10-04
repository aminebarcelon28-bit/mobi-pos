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
  /**
   * Pepper-dead recovery reset (tech-recovery flow only): re-provisions a
   * fresh device pepper and re-keys the MASTER in one step. Effective only
   * when the pepper is actually gone; rejected on healthy installs and for
   * non-master targets. Callers set this ONLY as a second attempt after the
   * plain rotation fails with a pepper-absent error — never preemptively.
   */
  recoveryReset?: boolean;
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

/**
 * French user-facing text for a failed `pinSet`. The native reasons are
 * stable wire strings (`TrustError` variants carry fixed reasons, never
 * secrets), so matching them here is safe. Unknown failures stay generic —
 * never echo raw wire text (it leaks internals, not help).
 */
export function friendlyPinSetError(err: unknown): string {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '').toLowerCase();
  if (msg.includes('pepper absent')) {
    return 'Clé de sécurité appareil manquante — poursuivez avec la récupération technicien.';
  }
  if (msg.includes('already used')) {
    return 'Chaque personne doit avoir un code PIN différent (code déjà utilisé).';
  }
  if (msg.includes('guessable')) {
    return 'Code trop simple (suite, répétition ou code banal) — choisissez un code moins prévisible.';
  }
  if (msg.includes('length invalid') || msg.includes('digits only') || msg.includes('oversized') || msg.includes('user id invalid')) {
    return 'Code PIN invalide (chiffres uniquement : 6 à 8 pour le gérant, 4 pour un caissier).';
  }
  if (msg.includes('unknown cashier') || msg.includes('roster')) {
    return 'Profil introuvable — actualisez et réessayez.';
  }
  return "Échec de l'enregistrement du nouveau PIN. Réessayez.";
}

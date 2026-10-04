/**
 * FT-01 — Modal-level journal gate (Track 1A).
 *
 * Casual / accidental access only. This gate defeats an unlocked cashier
 * tapping "Journal d'Audit" — it does NOT stop a modified WebView (raw SQL
 * bypass until the native read path FT-02 and the data-plane gateway land,
 * Phase 1C/3). The UI must label it honestly (see HONEST_GATE_LABEL).
 *
 * Rules enforced here (owner-recorded):
 * - Step-up verifies a MANAGER-role PIN natively (`pin_verify` with
 *   `userId: 'manager'`). A cashier entering their own PIN never passes,
 *   even though `pin_verify` accepts cashier credentials for other
 *   purposes (lock screen) — because we always verify against the manager
 *   credential, a cashier PIN only passes if it is byte-identical to the
 *   manager PIN (documented edge, not a bypass).
 * - Fail closed when the native kernel is unavailable. No local
 *   `verifyManagerPin` fallback on the native path — that helper is weak
 *   SHA-256 with a deletable localStorage lockout (see `utils/security.ts`).
 * - A weaker local fallback exists ONLY for opening the journal on non-Tauri
 *   DEV builds (`vite dev` / tests, where no trust kernel exists). It is
 *   flagged `weaker: true` and the caller must surface WEAK_FALLBACK_LABEL.
 *   Production browser builds fail closed ("application installée").
 *   Exports and privileged actions NEVER use it (fail closed).
 * - Step-up window lives in module memory ONLY. Never localStorage (it is
 *   deletable). Cleared on lock (`notifyLocked`) and on mobile
 *   background-relock (`notifyBackground` / `notifyForeground`).
 * - ACCESS_DENIED in 1A covers only denials the TS layer observes. Native
 *   IPC denials stay stderr-only (`ipc_authorizer.rs`) until 1B.
 *
 * FT-05 will emit JOURNAL_ACCESS (success/denied) from the call sites that
 * use this gate. This module does not write audit rows itself so the event
 * set stays atomic in FT-05.
 */

import { pinVerify } from '../api/pin';
import { reportGateDenial } from './gateDenials';

export const JOURNAL_STEPUP_WINDOW_MS = 5 * 60 * 1000;
export const MOBILE_BACKGROUND_RELOCK_MS = 60 * 1000;

/** Manager credential id on the native side (`pin.rs: MANAGER_USER_ID`). */
export const MANAGER_USER_ID = 'manager';

export type GateRole = 'manager' | 'cashier';

/** Honest label — render next to every journal gate prompt. */
export const HONEST_GATE_LABEL =
  'Contrôle d\u2019accès occasionnel — ne résiste pas à un WebView modifié (lecture via SQL local jusqu\u2019à FT-02/passerelle).';

/** Label for the weaker outside-Tauri fallback (journal view only). */
export const WEAK_FALLBACK_LABEL =
  'Vérification locale hors Tauri (prévisualisation web) — garantie réduite, jamais utilisée pour les exports.';

/** Minimum PIN length per role (journal gate: manager 6, cashier 4). */
export function minPinLengthForRole(role: GateRole): number {
  return role === 'cashier' ? 4 : 6;
}

export function isPinLengthValidForRole(pin: string, role: GateRole): boolean {
  const clean = (pin || '').trim();
  if (!/^\d+$/.test(clean)) return false;
  const len = clean.length;
  return len >= minPinLengthForRole(role) && len <= 32;
}

/**
 * PinDialog input bounds: 4–12 digits for both roles. The dialog does NOT
 * enforce the manager 6-digit policy — `verifyManagerPin` decides whether a
 * given PIN verifies (legacy 4-digit manager credentials still verify
 * locally). Strict-6 lives in the journal gate only (above).
 */
export const PIN_DIALOG_MIN_LENGTH = 4;
export const PIN_DIALOG_MAX_LENGTH = 12;

export function isPinDialogLengthOk(pin: string): boolean {
  const clean = (pin || '').trim();
  return (
    /^\d+$/.test(clean) &&
    clean.length >= PIN_DIALOG_MIN_LENGTH &&
    clean.length <= PIN_DIALOG_MAX_LENGTH
  );
}

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

/** Public read of the Tauri runtime probe (for UI copy decisions). */
export function isTauriRuntime(): boolean {
  return isTauri();
}

/**
 * True only in dev builds. Written as a DIRECT `import.meta.env.DEV` read so
 * Vite statically folds it at build time (same precedent as
 * `devBenchMark` in `db/sqlPluginAdapter.ts`, proven erased by
 * `scripts/test_bench_hook.mjs`): in a production bundle this function
 * compiles to `return false` and no runtime state — localStorage, URL
 * params, devtools — can flip it. A cast or optional-chaining form would
 * defeat the fold and is banned here.
 */
export function isDevBuild(): boolean {
  return import.meta.env.DEV === true;
}

export interface ManagerStepUpResult {
  ok: boolean;
  locked: boolean;
  lockedRemainingMs: number;
  mustRotate: boolean;
  /** True only on the weaker outside-Tauri journal-view fallback. */
  weaker: boolean;
  reason?: 'denied' | 'unavailable' | 'locked' | 'bad-length';
}

type PinVerifyFn = typeof pinVerify;

export interface VerifyManagerStepUpOptions {
  /**
   * Allow the weaker local fallback (journal VIEW, non-Tauri DEV builds
   * only — the caller must additionally gate on `isDevBuild()`; production
   * browser builds fail closed).
   */
  allowWeakFallback?: boolean;
  /** Injected native verifier (tests). Defaults to `pinVerify`. */
  pinVerifyFn?: PinVerifyFn;
  /**
   * Injected local fallback (tests / outside-Tauri journal view only).
   * Signature mirrors `verifyManagerPin(pin): boolean`.
   */
  localVerifyFn?: (pin: string) => boolean;
  /**
   * Phase F: burst attribution. Callers name their gate ('journal',
   * 'wipe', 'export', 'restore'); defaults to 'journal' (oldest caller).
   * Denied + locked outcomes emit through the shared coalescer.
   */
  gateName?: string;
}

/**
 * Verify a MANAGER PIN. Always verifies against `userId: 'manager'` so a
 * cashier PIN cannot pass by profile confusion.
 *
 * Fail-closed: transport errors, lockouts, bad lengths, and missing kernel
 * all return `{ ok: false }` and never fall through to the local helper —
 * except the explicitly-flagged weaker path (`allowWeakFallback`, non-Tauri
 * journal view only).
 */
export async function verifyManagerStepUp(
  pin: string,
  options: VerifyManagerStepUpOptions = {}
): Promise<ManagerStepUpResult> {
  const clean = (pin || '').trim();
  if (!isPinLengthValidForRole(clean, 'manager')) {
    return { ok: false, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: false, reason: 'bad-length' };
  }

  const native = options.pinVerifyFn ?? pinVerify;
  // Phase F: burst attribution for this step-up surface. Only real native
  // outcomes (denied/locked) emit — bad lengths never reached IPC, weak and
  // unavailable paths burned no budget.
  const gateName = options.gateName ?? 'journal';
  if (isTauri()) {
    try {
      const res = await native({ userId: MANAGER_USER_ID, pin: clean });
      if (res.locked) {
        reportGateDenial({ gateName, userId: MANAGER_USER_ID, locked: true, lockoutDurationMs: res.lockedRemainingMs });
        return {
          ok: false,
          locked: true,
          lockedRemainingMs: res.lockedRemainingMs,
          mustRotate: false,
          weaker: false,
          reason: 'locked',
        };
      }
      if (!res.ok) {
        reportGateDenial({ gateName, userId: MANAGER_USER_ID, locked: false, lockoutDurationMs: 0 });
        return { ok: false, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: false, reason: 'denied' };
      }
      return { ok: true, locked: false, lockedRemainingMs: 0, mustRotate: res.mustRotate, weaker: false };
    } catch {
      // Transport failure under Tauri: fail closed. Never fall back to
      // local verification here — that would bypass the native lockout
      // exactly when something is wrong (same rule as LockScreenOverlay).
      return { ok: false, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: false, reason: 'unavailable' };
    }
  }

  // Outside Tauri (web preview / tests): no trust kernel exists.
  if (!options.allowWeakFallback) {
    return { ok: false, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: false, reason: 'unavailable' };
  }
  const local = options.localVerifyFn;
  if (!local) {
    return { ok: false, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: false, reason: 'unavailable' };
  }
  try {
    const ok = Boolean(local(clean));
    return ok
      ? { ok: true, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: true }
      : { ok: false, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: true, reason: 'denied' };
  } catch {
    return { ok: false, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: true, reason: 'unavailable' };
  }
}

// ── In-memory step-up window (never localStorage) ──────────────────────────
// Module memory only. Survives re-renders, dies on reload — that is the
// point: a persisted window would survive longer than the session it gates.

let journalUnlockedAt: number | null = null;
let journalWindowMs: number = JOURNAL_STEPUP_WINDOW_MS;
let backgroundedAt: number | null = null;
let backgroundRelockMs: number = MOBILE_BACKGROUND_RELOCK_MS;

export function setJournalGateConfig(config: { windowMs?: number; backgroundRelockMs?: number }): void {
  if (typeof config.windowMs === 'number' && config.windowMs > 0) journalWindowMs = config.windowMs;
  if (typeof config.backgroundRelockMs === 'number' && config.backgroundRelockMs > 0) {
    backgroundRelockMs = config.backgroundRelockMs;
  }
}

export function getJournalGateConfig(): { windowMs: number; backgroundRelockMs: number } {
  return { windowMs: journalWindowMs, backgroundRelockMs };
}

export function markJournalUnlocked(now: number = Date.now()): void {
  journalUnlockedAt = now;
}

/** True while a previous manager step-up is still inside its window. */
export function isJournalUnlocked(now: number = Date.now()): boolean {
  if (journalUnlockedAt === null) return false;
  return now - journalUnlockedAt < journalWindowMs;
}

/**
 * Idle-window heartbeat: user activity inside the journal extends the
 * window (resets the timer). Never revives an expired or cleared window —
 * re-verification is required once it lapses. Returns true when extended.
 */
export function touchJournalGate(now: number = Date.now()): boolean {
  if (!isJournalUnlocked(now)) return false;
  journalUnlockedAt = now;
  return true;
}

/**
 * Launcher visibility rule (UX only — the modal gate is authoritative).
 * Cashiers get no journal entry point. Unknown/empty roles deny.
 */
export function canSeeJournalLauncher(role: string | null | undefined): boolean {
  return role === 'admin';
}

export function clearJournalUnlock(): void {
  journalUnlockedAt = null;
}

/** Call when the till locks (screen lock / session lock). */
export function notifyLocked(): void {
  clearJournalUnlock();
  backgroundedAt = null;
}

/** Call when the app goes to background (mobile relock source). */
export function notifyBackground(now: number = Date.now()): void {
  backgroundedAt = now;
}

/**
 * Call when the app returns to foreground. Returns true when the return
 * itself caused a relock (backgrounded longer than the relock interval).
 */
export function notifyForeground(now: number = Date.now()): boolean {
  if (backgroundedAt !== null && now - backgroundedAt >= backgroundRelockMs) {
    clearJournalUnlock();
    backgroundedAt = null;
    return true;
  }
  backgroundedAt = null;
  return false;
}

/** Test seam: read the raw unlock timestamp. */
export function getJournalUnlockedAtForTests(): number | null {
  return journalUnlockedAt;
}

/**
 * Anti-Clock-Tampering & Offline Grace Period Evaluation Engine
 * Protects software license validation against OS clock manipulation and freezing.
 */

export interface ClockGuardState {
  lastKnownTimestamp: number; // Monotonic high-water mark (ms)
  lastVerifiedAt: number;     // Server-attested timestamp of last successful online check (ms)
}

export type ClockGuardStatus =
  | { status: 'ACTIVE'; effectiveTime: number; daysRemainingGrace: number }
  | { status: 'TAMPERED_CLOCK'; message: string; rollbackDeltaMs: number }
  | { status: 'EXPIRED'; message: string; expiredAt: number }
  | { status: 'GRACE_EXCEEDED'; message: string; offlineDaysElapsed: number };

export class LicenseClockGuard {
  // 5 minutes legitimate NTP / daylight savings skew tolerance
  public static readonly SKEW_TOLERANCE_MS = 5 * 60 * 1000;

  private state: ClockGuardState;
  private readonly expMs: number;
  private readonly graceMs: number;
  private readonly isLifetime: boolean;

  // In-flight monotonic baseline tracking
  private lastEvaluatedPerfNow?: number;
  private lastEvaluatedWallClock?: number;

  constructor(
    state: ClockGuardState,
    expSec: number,
    graceDays: number = 7,
    isLifetime: boolean = false
  ) {
    this.state = { ...state };
    this.expMs = expSec > 0 ? expSec * 1000 : 0;
    this.graceMs = graceDays * 24 * 60 * 60 * 1000;
    this.isLifetime = isLifetime;
  }

  /**
   * Evaluates license validity using the tri-watermark anchor.
   *
   * @param currentWallClockMs Current system time (Date.now())
   * @param highestDbTimestampMs Highest seen HLC or receipt timestamp in local SQLite
   */
  public evaluate(
    currentWallClockMs: number = Date.now(),
    highestDbTimestampMs: number = 0
  ): { result: ClockGuardStatus; nextState: ClockGuardState } {
    // 1. Tri-Watermark High-Water Anchor
    const highWaterMark = Math.max(
      this.state.lastKnownTimestamp,
      highestDbTimestampMs
    );

    // 2. In-flight Clock Rollback Check between successive evaluations while running
    if (
      this.lastEvaluatedWallClock !== undefined &&
      this.lastEvaluatedPerfNow !== undefined &&
      typeof performance !== 'undefined'
    ) {
      const perfElapsedMs = performance.now() - this.lastEvaluatedPerfNow;
      const wallElapsedMs = currentWallClockMs - this.lastEvaluatedWallClock;
      // If wall clock rolled back more than 60s while monotonic performance timer advanced
      if (wallElapsedMs < -60000 && perfElapsedMs > 0) {
        return {
          result: {
            status: 'TAMPERED_CLOCK',
            message: 'Recul d’horloge système détecté pendant l’exécution de l’application.',
            rollbackDeltaMs: Math.abs(wallElapsedMs),
          },
          nextState: { ...this.state, lastKnownTimestamp: highWaterMark },
        };
      }
    }
    this.lastEvaluatedWallClock = currentWallClockMs;
    this.lastEvaluatedPerfNow = typeof performance !== 'undefined' ? performance.now() : 0;

    // 3. System Clock Rollback Check against persistent high-water mark
    if (currentWallClockMs < highWaterMark - LicenseClockGuard.SKEW_TOLERANCE_MS) {
      return {
        result: {
          status: 'TAMPERED_CLOCK',
          message: 'Horloge système antérieure aux dernières transactions enregistrées.',
          rollbackDeltaMs: highWaterMark - currentWallClockMs,
        },
        nextState: { ...this.state, lastKnownTimestamp: highWaterMark },
      };
    }

    // 4. Monotonic Effective Time calculation
    const effectiveTime = Math.max(currentWallClockMs, highWaterMark);
    const updatedState: ClockGuardState = {
      ...this.state,
      lastKnownTimestamp: effectiveTime,
    };

    // 5. Contractual Expiration Check (Lifetime licenses are exempt)
    if (!this.isLifetime && this.expMs > 0 && effectiveTime > this.expMs) {
      return {
        result: {
          status: 'EXPIRED',
          message: 'La durée de validité de votre licence a expiré.',
          expiredAt: this.expMs,
        },
        nextState: updatedState,
      };
    }

    // 6. Offline Grace Period Window Check
    // If lastVerifiedAt is 0, initialize it to effectiveTime
    const lastVerified = this.state.lastVerifiedAt > 0 ? this.state.lastVerifiedAt : effectiveTime;
    const timeSinceVerification = effectiveTime - lastVerified;

    if (!this.isLifetime && timeSinceVerification > this.graceMs) {
      return {
        result: {
          status: 'GRACE_EXCEEDED',
          message: 'Délai d’utilisation hors-ligne (7 jours) dépassé. Veuillez connecter l’appareil à Internet pour vérifier la licence.',
          offlineDaysElapsed: Number((timeSinceVerification / 86400000).toFixed(1)),
        },
        nextState: updatedState,
      };
    }

    const daysRemainingGrace = this.isLifetime
      ? 9999
      : Math.max(0, Number(((this.graceMs - timeSinceVerification) / 86400000).toFixed(1)));

    return {
      result: {
        status: 'ACTIVE',
        effectiveTime,
        daysRemainingGrace,
      },
      nextState: updatedState,
    };
  }
}

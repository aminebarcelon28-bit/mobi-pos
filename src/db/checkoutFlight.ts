/**
 * Cross-surface checkout flight lock (B-061 / B-063).
 *
 * processPayment, boot recovery replay and the refund writeCheckoutAtomic path
 * share this single mutex so only one durable-checkout writer runs at a time.
 * tryAcquire is non-blocking (second caller gets false immediately).
 *
 * B-063: the previous 60 s wall-clock force-release fired WHILE the owner was
 * still inside withBusyRetry (attempt 6/8 still sleeping) — a second
 * busy-retry:checkout then started on the same pool, and the first owner's
 * `finally` could free the second owner's lock (release was not owner-scoped).
 *
 * Fixes:
 *  - Idle watchdog, not wall-clock: force-release only after CHECKOUT_FLIGHT_TIMEOUT_MS
 *    with NO renew. withBusyRetry renews on every attempt, so a multi-minute
 *    retry loop stays owned; a truly frozen/never-finally path stops renewing
 *    and is still rescued (W3B1).
 *  - Owner-scoped release: releaseCheckoutFlight(owner) is a no-op unless the
 *    caller still owns the flight, so a late finally cannot free someone else.
 */

let flightActive = false;
let flightTimer: ReturnType<typeof setTimeout> | null = null;
let flightOwner = '';
let lastActivityAt = 0;

/** Idle time with no renewCheckoutFlight before force-release (W3B1 rescue). */
export const CHECKOUT_FLIGHT_TIMEOUT_MS = 60_000;

/**
 * Try to enter the checkout critical section. Returns false when another
 * entry point already holds it (double-tap, boot replay vs live payment,
 * concurrent refund). On success an idle watchdog is armed; always pair with
 * `releaseCheckoutFlight(owner)` in `finally`.
 */
export function tryAcquireCheckoutFlight(owner: string): boolean {
  if (flightActive) return false;
  flightActive = true;
  flightOwner = owner;
  lastActivityAt = Date.now();
  armIdleWatchdog(owner);
  return true;
}

/**
 * Refresh activity while the owner is still working (called from withBusyRetry
 * on every attempt when the lane holds the flight). Owner is REQUIRED:
 * anonymous renewals once let a pull-row retry keep a sale's flight alive
 * past the idle watchdog (IPC-007). No-op when the flight is free, owned by
 * someone else, or no owner is given.
 */
export function renewCheckoutFlight(owner?: string): void {
  if (!flightActive) return;
  if (owner === undefined || owner !== flightOwner) return;
  lastActivityAt = Date.now();
}

/**
 * Leave the critical section. When `owner` is provided, only releases if that
 * caller still owns the flight (safe after a force-release + re-acquire).
 * Omitting owner is a force-clear for tests / hard cleanup.
 */
export function releaseCheckoutFlight(owner?: string): void {
  if (owner !== undefined && flightActive && flightOwner !== owner) {
    // Stale owner after force-release — someone else holds the lock now.
    console.warn(
      `[checkoutFlight] ignoring release from stale owner=${owner} (current=${flightOwner})`
    );
    return;
  }
  flightActive = false;
  flightOwner = '';
  lastActivityAt = 0;
  clearFlightTimer();
}

/** Diagnostic probe — true while a checkout holds the lock. */
export function isCheckoutFlightActive(): boolean {
  return flightActive;
}

/** Current owner label for diagnostics ('' when free). */
export function checkoutFlightOwner(): string {
  return flightOwner;
}

function armIdleWatchdog(owner: string): void {
  clearFlightTimer();
  flightTimer = setTimeout(function checkIdle() {
    if (!flightActive || flightOwner !== owner) return;
    const idleFor = Date.now() - lastActivityAt;
    if (idleFor < CHECKOUT_FLIGHT_TIMEOUT_MS) {
      // Still renewing (busy-retry / live work) — re-arm for another window.
      armIdleWatchdog(owner);
      return;
    }
    // W3B1: no renew for a full timeout — frozen/never-finally path.
    console.warn(
      `[checkoutFlight] force-release after ${CHECKOUT_FLIGHT_TIMEOUT_MS}ms idle (owner=${owner})`
    );
    releaseCheckoutFlight();
  }, CHECKOUT_FLIGHT_TIMEOUT_MS);
}

function clearFlightTimer(): void {
  if (flightTimer !== null) {
    clearTimeout(flightTimer);
    flightTimer = null;
  }
}

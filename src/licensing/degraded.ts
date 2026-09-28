/**
 * Degraded-license mode (availability): an expired/suspended licence must
 * stop NEW revenue, never hold the merchant's own data hostage. When the
 * boot check reports EXPIRED / GRACE_EXCEEDED / SUSPENDED (billing or admin
 * states — never TAMPERED_CLOCK / DEVICE_MISMATCH / UNLICENSED), the app
 * runs degraded: reports, refunds, voids, shift close and local export stay
 * available, but new sales and new pairings are refused.
 *
 * Enforcement lives at the choke points (processPayment, pairing execute),
 * not in every button: the UI stays fully navigable and refusals are loud.
 * This module is dependency-free so store slices can read it synchronously
 * without import cycles.
 */

let saleBlocked = false;

export function setDegradedSaleBlock(on: boolean): void {
  saleBlocked = on;
}

/** Synchronous choke read for processPayment / pairing. Never throws. */
export function isSaleBlockedByLicense(): boolean {
  try {
    return saleBlocked;
  } catch {
    return false;
  }
}

/** Billing/admin states degrade; tamper/identity states hard-lock. */
export function isDegradedLicenseStatus(status: string | undefined | null): boolean {
  return status === 'EXPIRED' || status === 'GRACE_EXCEEDED' || status === 'SUSPENDED';
}

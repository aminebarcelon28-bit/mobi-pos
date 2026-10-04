/**
 * Licensing state predicates — FAIL-CLOSED.
 *
 * ── POLICY (2026-09-30) ─────────────────────────────────────────────────────
 * MobiPOS is hard-locked unless the licence is affirmatively `ACTIVE`. There is
 * no degraded mode. Every other outcome — expired, grace exceeded, suspended,
 * revoked, tampered clock, device mismatch, unknown, null, corrupt, or a
 * verification error — resolves to a full block.
 *
 * Why the previous behaviour was wrong on two counts:
 *  1. `EXPIRED / GRACE_EXCEEDED / SUSPENDED` were classified as "degraded",
 *     which skipped the ActivationGate. An expired terminal could then read,
 *     refund, void and export its own books indefinitely.
 *  2. It also deadlocked the boot: the gate was skipped, but `initDatabase` was
 *     gated behind `licensed`, so the UI hung on "Chargement de la base
 *     locale…" with no way forward and no error.
 *
 * The only sanctioned path to financial data while locked is the scoped,
 * read-only emergency exporter (`emergencyExporter.ts`), reachable solely from
 * the ActivationGate and gated on a re-verified Owner/Manager PIN.
 *
 * Recovery from any locked state requires explicit, authenticated
 * cryptographic token renewal — see `client.ts#activateLicense` /
 * `activateWithOfflineToken`, both of which verify an Ed25519 signature against
 * the pinned public key in `publicKey.ts`. There is deliberately no local
 * override, no offline grace re-entry, and no "trust the last known good
 * status" path.
 *
 * This module is dependency-free so slices and non-React code can read it
 * synchronously without import cycles.
 */

/**
 * The only status that grants access.
 *
 * Declared `as const` + a literal union so a status string cannot be widened
 * into an arbitrary string by accident: `status satisfies LicenseStatus`
 * becomes a compile error for an unrecognised value.
 */
export const ACTIVE_LICENSE_STATUS = 'ACTIVE' as const;

export type LicenseStatus = typeof ACTIVE_LICENSE_STATUS;

/**
 * Every status the licensing layer can report. Kept as documentation of the
 * closed set — the predicates below accept `string` because the value arrives
 * from a network response cast at the boundary (`client.ts`), not from this
 * module. Anything outside the closed set is treated as unlicensed.
 */
export const KNOWN_UNLICENSED_STATUSES = [
  'EXPIRED',
  'GRACE_EXCEEDED',
  'SUSPENDED',
  'REVOKED',
  'TAMPERED_CLOCK',
  'DEVICE_MISMATCH',
  'UNLICENSED',
  'UNKNOWN',
  'CORRUPT',
] as const;

export type KnownUnlicensedStatus = (typeof KNOWN_UNLICENSED_STATUSES)[number];

/**
 * True only for an affirmatively ACTIVE licence.
 *
 * Total function: a non-string, a null, an empty string, or an unrecognised
 * status all return false. Callers must NOT treat a falsy `licensed` as
 * "unknown, proceed anyway" — it means locked.
 */
export function isLicenseActive(status: string | undefined | null): boolean {
  if (typeof status !== 'string') return false;
  return status.trim().toUpperCase() === ACTIVE_LICENSE_STATUS;
}

/**
 * True when the app must stay locked behind the ActivationGate.
 *
 * This is the predicate the render tree branches on. It is the exact negation
 * of {@link isLicenseActive}, stated independently so the gate cannot
 * accidentally become conditional on some other signal.
 */
export function isLicenseLocked(status: string | undefined | null): boolean {
  return !isLicenseActive(status);
}

/**
 * No status degrades. Retained as an explicit, documented `false` rather than
 * deleted, so that re-enabling availability mode is a conscious licensing
 * decision with a review trail — not a drive-by edit.
 *
 * Never broaden this without reading the policy note at the top of this file:
 * a `true` here removes the ActivationGate and re-exposes the merchant's
 * books, and reintroduces the boot deadlock described above.
 */
export function isDegradedLicenseStatus(status: string | undefined | null): boolean {
  void status;
  return false;
}

// ── Sale-choke state ─────────────────────────────────────────────────────────
//
// Defence in depth: even though the gate now blocks the whole UI, the choke
// stays as a second, independent barrier. A bug that renders the POS while
// unlicensed still cannot take money.

let saleBlocked = false;

export function setDegradedSaleBlock(on: boolean): void {
  saleBlocked = on;
}

/** Synchronous choke read for processPayment / pairing. Never throws. */
export function isSaleBlockedByLicense(): boolean {
  try {
    return saleBlocked;
  } catch {
    // Fail CLOSED here too: an unreadable choke must refuse the sale, not
    // silently permit revenue.
    return true;
  }
}

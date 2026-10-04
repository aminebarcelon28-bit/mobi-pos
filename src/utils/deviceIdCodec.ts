/**
 * deviceIdCodec — THE single canonical form for a device identifier.
 *
 * A LEAF module by design: zero imports. Three components used to normalize an
 * IMEI three different ways (`createCartSlice`, `warrantyResolver`,
 * `savValidation`), which is how a hyphenated GSMA-scanned IMEI could be
 * "sold" in the cart yet "non enregistré" at lookup. A boundary codec that
 * itself imports application code re-creates the cycle problem, so this file
 * imports nothing and everything else delegates here.
 *
 * Scope: FORM ONLY. These functions make no claim about IMEI length or Luhn
 * validity — see `sanitizeDeviceIdentifier` (warrantyResolver) for the lookup
 * gate that enforces those. Keeping them separate is deliberate:
 *
 *   - The cart/trade-in intake handles IMEIs AND arbitrary serial numbers
 *     (`ABC-123-XYZ`, tablets, dead devices). Validating at ingest would brick
 *     those flows, which is why only the lookup gate checks checksums.
 *   - GS1 composite payloads (`(01)352099001761481`) must FAIL CLOSED. AI `(01)`
 *     is a defined 14-digit GTIN, so guessing which field carries the IMEI could
 *     resolve the WRONG device's warranty and grant free repairs on the wrong
 *     handset. Blanket non-digit stripping fails too, since `(01)`'s own digits
 *     corrupt the payload. Rejection is the correct posture.
 */

/**
 * Canonical comparison key. Strips every separator (space, hyphen, slash, dot,
 * zero-width, bidi control) and upper-cases, so `35-209900-176148-1`,
 * `352099001761481`, `35 209900 176148 1` and `35.209900.176148.1` are ONE
 * device.
 *
 * Use this on EVERY comparison of a stored identifier against a scanned or typed
 * one. Historic rows keep their original spelling, so reads must normalize
 * rather than compare raw.
 */
export function normalizeDeviceKey(raw: string | null | undefined): string {
  return (raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
}

/**
 * Canonical STORAGE form for a freshly ingested identifier: digits-only when the
 * payload compacts to exactly 15 digits (an IMEI), otherwise the cleaned
 * uppercase alphanumeric form so a serial like `ABC-123-XYZ` stays intact.
 *
 * Use at INGESTION so stored and queried forms agree by construction. Historic
 * rows are read through `normalizeDeviceKey`, so they resolve without a data
 * migration.
 */
export function canonicalDeviceId(raw: string | null | undefined): string {
  const cleaned = (raw || '').trim().replace(/[^a-zA-Z0-9-]/g, '').toUpperCase();
  const compact = cleaned.replace(/[^0-9]/g, '');
  return /^\d{15}$/.test(compact) ? compact : cleaned;
}

/**
 * savValidation — IMEI Luhn + DZ phone mask/validation (warn-only, never blocks save).
 */
import { canonicalDeviceId, normalizeDeviceKey } from './deviceIdCodec';

export type ImeiCheck = 'idle' | 'valid' | 'invalid' | 'neutral';

/** Luhn MOD-10 check for 15-digit IMEI. Returns true only for exactly 15 numeric digits passing checksum. */
export function luhnCheckImei(raw: string): boolean {
  const clean = (raw || '').replace(/\D/g, '');
  if (!/^\d{15}$/.test(clean)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(clean[14 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Chaos S6 sanitizer: delegates to the shared `deviceIdCodec`, the single
 * canonical form used by the cart and the warranty resolver.
 *
 * It previously had its own compaction that stripped only whitespace,
 * zero-width and bidi smugglers plus hyphens — NOT dots, slashes or `*`
 * fences. That made a third divergent spelling: the trade-in path kept
 * `35.209900.176148.1` and `*352099001761481*` verbatim while the checkout
 * path compacted them, so a device could be registered through buyback and
 * then be unresolvable at warranty lookup (and vice-versa).
 *
 * Applied on blur + submit (never destructive mid-typing). FORM ONLY — no
 * length or Luhn assertion; those belong to `luhnCheckImei` /
 * `imeiCheckState` below, which are warn-only by design.
 */
export function sanitizeImeiInput(raw: string): string {
  return canonicalDeviceId(raw);
}

export function imeiCheckState(raw: string): ImeiCheck {
  const v = (raw || '').trim();
  if (!v) return 'idle';
  // Delegates to the shared codec rather than its own `[\s-]` strip, which was
  // a FOURTH divergent spelling: it silently ignored dots, slashes and `*`
  // fences, so `35.209900.176148.1` reported 'neutral' (no feedback at all)
  // while the checkout path compacted and validated the same device. Now every
  // separator form gets real Luhn feedback.
  if (/^\d{15}$/.test(canonicalDeviceId(v))) {
    return luhnCheckImei(v) ? 'valid' : 'invalid';
  }
  // Alphanumeric S/N or short input (tablets/iPads/dead devices) — neutral, allow save.
  return 'neutral';
}

/**
 * THE gate every acquisition writer uses to accept a device identifier (W-43).
 *
 * Three rules, and they are deliberately NOT the same as the deprecated
 * store-level `validateIMEI` action:
 *
 *  1. A 15-DIGIT value must pass Luhn MOD-10, or the write is REFUSED. A wrong
 *     checksum is not a typo: it is an identifier that resolves to nothing at
 *     the till and nothing at SAV, so the registry row would be dead weight and
 *     the warranty lookup would fail closed forever after.
 *  2. Anything that is NOT 15 digits is ALLOWED and stored canonical: serials
 *     (`ABC-123-XYZ`), tablets and dead devices are real stock in this shop.
 *     Validating "is this an IMEI" at ingest would brick those flows, which is
 *     exactly what `validateIMEI` did.
 *  3. A duplicate is a WARNING, never a refusal. There is no owner-set rule
 *     that blocks a second acquisition of the same identifier, and a unit in
 *     front of the operator must be recorded — the operator is told instead.
 *     The ONE hard duplicate rule is the cart collision (the same unit cannot
 *     be sold and taken back on one ticket), which lives at the cart, not here.
 *
 * The canonical form comes from `deviceIdCodec`, so a hyphenated GSMA-scanned
 * IMEI and its digits-only twin cannot become two devices. Duplicates are
 * detected with `normalizeDeviceKey` — the same function the warranty resolver
 * and the origin join use — because historic rows keep their original
 * spelling and a raw compare would miss every one of them.
 *
 * Callers that legitimately accept a BLANK identifier (a PO line with no
 * serialized unit, a non-serialized product) must skip the call: this gate
 * reports `IDENTIFIER_ABSENT` rather than guessing.
 */
export type DeviceIdentifierIntakeVerdict =
  | {
      ok: true;
      /** Canonical storage form — assign THIS, never the raw input. */
      canonical: string;
      /** Canonical comparison key for duplicate detection. */
      key: string;
      /** The already-known spelling this identifier collides with. */
      duplicateOf: string | null;
      /** Operator-facing warning; present only for a duplicate. */
      warning: string | null;
    }
  | {
      ok: false;
      canonical: string;
      key: string;
      code: 'IDENTIFIER_ABSENT' | 'IMEI_LUHN_INVALID';
      /** Operator-facing French reason. */
      reason: string;
    };

export function validateDeviceIdentifierForIntake(
  raw: string | null | undefined,
  existing: readonly (string | null | undefined)[] = []
): DeviceIdentifierIntakeVerdict {
  const canonical = canonicalDeviceId(raw);
  if (!canonical) {
    return {
      ok: false,
      canonical: '',
      key: '',
      code: 'IDENTIFIER_ABSENT',
      reason: 'Identifiant appareil absent.',
    };
  }
  const key = normalizeDeviceKey(canonical);
  if (/^\d{15}$/.test(canonical) && !luhnCheckImei(canonical)) {
    return {
      ok: false,
      canonical,
      key,
      code: 'IMEI_LUHN_INVALID',
      reason: 'IMEI invalide (clé de contrôle Luhn).',
    };
  }
  const duplicateOf = existing.find((e) => normalizeDeviceKey(e) === key) ?? null;
  return {
    ok: true,
    canonical,
    key,
    duplicateOf,
    warning: duplicateOf
      ? `DUPLICATE_IMEI:${key} est déjà enregistré (${duplicateOf}). Vérifiez qu'il ne s'agit pas du même appareil.`
      : null,
  };
}

/** Strip to digits, normalize to E.164-ish 213... */
export function sanitizeDzPhone(raw: string): string {
  let d = (raw || '').replace(/\D/g, '');
  if (d.startsWith('00213')) d = d.slice(2);
  else if (d.startsWith('0')) d = '213' + d.slice(1);
  return d;
}

/** Algerian mobile regex: 0[567]xxxxxxxx or 213[567]xxxxxxxx */
export function isValidDzPhone(raw: string): boolean {
  const d = (raw || '').replace(/[\s.-]/g, '');
  return /^(0[567]\d{8}|213[567]\d{8})$/.test(d);
}

/** Live display mask: 0X XX XX XX XX (best-effort, preserves typing). */
export function formatDzPhoneDisplay(raw: string): string {
  const d = (raw || '').replace(/\D/g, '').slice(0, 10);
  if (!d) return '';
  // Normalize 213-prefixed to 0-prefixed for display.
  let local = d;
  if (local.startsWith('213')) local = '0' + local.slice(3);
  if (!local.startsWith('0')) return raw;
  const parts: string[] = [local.slice(0, 2)];
  for (let i = 2; i < local.length; i += 2) parts.push(local.slice(i, i + 2));
  return parts.filter(Boolean).join(' ');
}

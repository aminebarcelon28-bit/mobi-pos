/**
 * savValidation — IMEI Luhn + DZ phone mask/validation (warn-only, never blocks save).
 */

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
 * Chaos S6 sanitizer: strip embedded spaces/dashes + uppercase. When the
 * compacted form is a 15-digit candidate it wins (Luhn still decides);
 * otherwise the trimmed uppercased input is kept so WiFi S/N stay intact.
 * Applied on blur + submit (never destructive mid-typing).
 */
export function sanitizeImeiInput(raw: string): string {
  const t = (raw || '').toUpperCase().trim();
  const compact = t.replace(/[\s-]+/g, '');
  if (/^\d{15}$/.test(compact)) return compact;
  return t;
}

export function imeiCheckState(raw: string): ImeiCheck {
  const v = (raw || '').trim();
  if (!v) return 'idle';
  if (/^\d{15}$/.test(v.replace(/[\s-]/g, ''))) {
    return luhnCheckImei(v) ? 'valid' : 'invalid';
  }
  // Alphanumeric S/N or short input (tablets/iPads/dead devices) — neutral, allow save.
  return 'neutral';
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

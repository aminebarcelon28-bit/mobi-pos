/**
 * Money — the SINGLE money primitive (Stage A, Zero-Drift Mandate v4).
 *
 * Unit of account: integer minor units of DZD (1 dinar = 100 minor units).
 * The word for the subunit appears only in this comment and display-format
 * code — never in user-facing strings (PD-5).
 *
 * Laws:
 * - Construction ONLY via fromMinor / fromUserInput / fromJSON. No float
 *   ever touches a value: entry parses the decimal STRING directly
 *   (PD-22), display renders via integer div/mod + zero-pad (PD-23).
 * - This file is float-free by construction: no float math helpers, no
 *   float parsing, no integer-parse builtins, no Number() conversion of
 *   amounts. BigInt carries the string→integer parse (exact, arbitrary
 *   precision) with a safe-integer range check on the way into `number`.
 * - Transitional callers (receiptMath, adapters, UI) still use toIntMoney
 *   until Stage E migrates them. New code MUST use Money.
 * - ENTRY-ECHO NORM (C-2, extends PD-23): every money input field must
 *   render `Money.fromUserInput(value).format()` live while typing and
 *   before commit, so a grouping mis-parse (the 1000x ambiguity) is VISIBLE
 *   before money moves. Test J section J7 pins the echo vectors.
 */

export const CURRENCY = {
  code: 'DZD',
  /** User-facing label. */
  label: 'DA',
  /** Minor units per dinar. SINGLE exponent source for TS (Rust mirrors it
   * in src-tauri/src/money.rs CURRENCY_EXPONENT; Test J asserts == 2). */
  exponent: 2,
} as const;

const MAX_FRACTION_DIGITS = 2;

function fail(what: string): never {
  throw new Error(`[Money] ${what}`);
}

/**
 * C-2a: ASCII-space thousands grouping (escpos-safe, one implementation
 * point — all callers inherit). Pure string ops, no float.
 * "45000" → "45 000", "1000000" → "1 000 000", "130" → "130".
 */
function groupAscii(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.length % 3 || 3;
  const parts = [digits.slice(0, head)];
  for (let i = head; i < digits.length; i += 3) {
    parts.push(digits.slice(i, i + 3));
  }
  return parts.join(' ');
}

function assertSafeInteger(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) fail(`${what}: not a safe integer`);
}

/**
 * Canonical money value: integer minor units. Immutable. Signedness is
 * allowed (P&L intermediates, refunds) — ENTRY rejects negatives.
 */
export class Money {
  private readonly minor: number;
  private constructor(minor: number) {
    assertSafeInteger(minor, 'minor');
    this.minor = minor;
  }

  /** Single construction path for exact values. */
  static fromMinor(minor: number): Money {
    if (!Number.isSafeInteger(minor)) fail(`fromMinor: ${String(minor)} not a safe integer`);
    return new Money(minor);
  }

  /**
   * PD-22 string-based entry. NEVER float×100: the decimal string is split
   * and concatenated into minor units ("130.5"→13050, "4.35"→435).
   * Accepts "." and "," decimal separators (FR/DZ keyboards); strips
   * grouping spaces (regular, NBSP, narrow NBSP, apostrophe) and FR
   * thousand-grouping dots ("45.000"→45000, "12.500,50"→1250050).
   * REJECTS (throws, never silently rounds): 3+ decimals ("130.555"),
   * negatives, empty/unparseable input, values beyond safe integer.
   */
  static fromUserInput(input: unknown): Money {
    if (typeof input === 'number') {
      // Numbers are already float — reject the pattern, don't bless it.
      // Callers holding a float must go through Stage E migration, not here.
      fail('fromUserInput: number input forbidden (float intermediate); pass the raw decimal string');
    }
    const raw = String(input ?? '').trim();
    if (!raw) fail('fromUserInput: empty input');
    if (raw.startsWith('-') || raw.startsWith('+')) {
      fail(`fromUserInput: sign not allowed for money entry: ${raw}`);
    }
    const compact = raw.replace(/[\s  ’']/g, '');
    if (!compact) fail('fromUserInput: empty input');
    const hasComma = compact.includes(',');
    const hasDot = compact.includes('.');
    let intPart: string;
    let fracPart: string;
    if (hasComma && hasDot) {
      // Strict FR grouping only ("12.500,50"); US-grouped ("1,200.50")
      // is rejected rather than mangled 1000x (OBS-A4 parity).
      if (!/^\d{1,3}(\.\d{3})+,\d+$/.test(compact)) {
        fail(`fromUserInput: ambiguous separators: ${raw}`);
      }
      const noGroups = compact.replace(/\./g, '');
      const dot = noGroups.indexOf(',');
      intPart = noGroups.slice(0, dot);
      fracPart = noGroups.slice(dot + 1);
    } else if (hasComma) {
      const i = compact.indexOf(',');
      intPart = compact.slice(0, i);
      fracPart = compact.slice(i + 1);
    } else if (hasDot) {
      if (/^\d{1,3}(\.\d{3})+$/.test(compact)) {
        // FR thousand grouping, no decimal ("45.000" → 45000).
        intPart = compact.replace(/\./g, '');
        fracPart = '';
      } else {
        const i = compact.indexOf('.');
        intPart = compact.slice(0, i);
        fracPart = compact.slice(i + 1);
      }
    } else {
      intPart = compact;
      fracPart = '';
    }
    if (intPart === '') intPart = '0';
    if (!/^\d+$/.test(intPart) || !/^\d*$/.test(fracPart)) {
      fail(`fromUserInput: not a decimal amount: ${raw}`);
    }
    if (fracPart.length > MAX_FRACTION_DIGITS) {
      fail(`fromUserInput: max ${MAX_FRACTION_DIGITS} decimals, got "${raw}" — re-enter, not rounded`);
    }
    const padded = (intPart + fracPart.padEnd(MAX_FRACTION_DIGITS, '0')).replace(/^0+(?=\d)/, '');
    const minorBig = BigInt(padded === '' ? '0' : padded);
    if (minorBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail(`fromUserInput: amount exceeds safe integer: ${raw}`);
    }
    return new Money(Number(minorBig));
  }

  /** PD-3: JSON carries integer minor units as STRINGS. */
  static fromJSON(v: unknown): Money {
    const s = String(v ?? '');
    if (!/^\d+$/.test(s)) fail(`fromJSON: expected minor-unit digit string, got ${s}`);
    const big = BigInt(s);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail('fromJSON: amount exceeds safe integer');
    return new Money(Number(big));
  }

  toMinor(): number {
    return this.minor;
  }

  /** PD-3: serialize as minor-unit string. */
  toJSON(): string {
    return String(this.minor);
  }

  /**
   * PD-23 display: dinars with ALWAYS two decimals, pure string ops
   * (integer div/mod 100 + zero-pad). Zero arithmetic, zero float.
   * 13050 → "130.50 DA", 10000 → "100.00 DA", 10 → "0.10 DA".
   */
  format(): string {
    // Pure string split — a float floor of abs/100 would be unsound for
    // large values (float division can round a true n+0.99 quotient up to n+1).
    const neg = this.minor < 0;
    const digits = String(neg ? -this.minor : this.minor);
    const rawWhole = digits.length > MAX_FRACTION_DIGITS ? digits.slice(0, -MAX_FRACTION_DIGITS) : '0';
    const frac = digits.slice(-MAX_FRACTION_DIGITS).padStart(MAX_FRACTION_DIGITS, '0');
    return `${neg ? '-' : ''}${groupAscii(rawWhole)}.${frac} ${CURRENCY.label}`;
  }

  add(other: Money): Money {
    const r = this.minor + other.minor;
    assertSafeInteger(r, 'add overflow');
    return new Money(r);
  }

  sub(other: Money): Money {
    const r = this.minor - other.minor;
    assertSafeInteger(r, 'sub overflow');
    return new Money(r);
  }

  /** Integer multiplier (e.g. whole-unit qty). BigInt-checked. */
  mulInt(k: number): Money {
    if (!Number.isSafeInteger(k)) fail(`mulInt: multiplier not a safe integer`);
    const r = BigInt(this.minor) * BigInt(k);
    if (r > BigInt(Number.MAX_SAFE_INTEGER) || r < BigInt(Number.MIN_SAFE_INTEGER)) {
      fail('mulInt: overflow');
    }
    return new Money(Number(r));
  }

  /**
   * Exact proportional split core (future §8 allocator):
   * roundHalfUp(this.minor × mult / div) with a widened BigInt intermediate.
   * No float division, ever.
   */
  mulDivHalfUp(mult: number, div: number): Money {
    if (!Number.isSafeInteger(mult) || !Number.isSafeInteger(div) || div <= 0) {
      fail('mulDivHalfUp: mult/div must be safe integers, div > 0');
    }
    const num = BigInt(this.minor) * BigInt(mult);
    const d = BigInt(div);
    const q = num / d;
    const rem = num % d;
    const rounded = rem * 2n >= d ? q + 1n : q;
    if (rounded > BigInt(Number.MAX_SAFE_INTEGER) || rounded < BigInt(Number.MIN_SAFE_INTEGER)) {
      fail('mulDivHalfUp: overflow');
    }
    return new Money(Number(rounded));
  }

  compare(other: Money): number {
    if (this.minor < other.minor) return -1;
    if (this.minor > other.minor) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.minor === other.minor;
  }

  isZero(): boolean {
    return this.minor === 0;
  }

  isNegative(): boolean {
    return this.minor < 0;
  }
}

/**
 * Display helper for migrated callers: format integer minor units.
 * Same contract as Money.format; throws on non-safe-integer input.
 */
export function formatMinor(minor: number): string {
  return Money.fromMinor(minor).format();
}

/**
 * DEATH-MARKED: killed at 1b-ii Stage B/C. Transitional bridge for STORE
 * writes while columns are still REAL dinars: integer minor → float dinars
 * (13050 → 135.5). Exact for values whose dinar form is binary-exact;
 * values like 0.10 DA become the nearest float (storage limitation, not a
 * computation — 1b-ii ends it). The ONLY permitted float conversion in the
 * codebase: grep must show no other `minor / 100`-class conversion outside
 * this function. Callers: DB-write/submit boundaries only, never display,
 * never arithmetic.
 */
export function toLegacyReal(minor: number): number {
  assertSafeInteger(minor, 'toLegacyReal');
  return minor / 100;
}

/**
 * DEATH-MARKED: killed at 1b-ii Stage B/C. Transitional LOAD bridge for
 * Phase 1c entry fields whose parent state is still float dinars: dinars →
 * integer minor for the `valueMinor` prop. Exact paths first (integer
 * fast-path, then the string path via fromUserInput); the single
 * rounding-helper fallback below fires ONLY for float dust whose shortest
 * representation exceeds 2 decimals (error ≤ 1 minor unit, documented).
 * This is the ONE float-helper line allowed in this file — the boundary
 * gate pins it to its exact line. Never use in arithmetic or new code.
 */
export function dinarsToMinor(dinars: number): number {
  if (!Number.isFinite(dinars)) fail('dinarsToMinor: non-finite input');
  if (dinars >= Number.MAX_SAFE_INTEGER / 100 || dinars <= -Number.MAX_SAFE_INTEGER / 100) {
    fail('dinarsToMinor: magnitude exceeds safe minor range');
  }
  if (Number.isInteger(dinars)) {
    return dinars * 100;
  }
  try {
    return Money.fromUserInput(String(dinars)).toMinor();
  } catch {
    return Math.round(dinars * 100); // dust-only fallback (see doc above)
  }
}

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
    const whole = digits.length > MAX_FRACTION_DIGITS ? digits.slice(0, -MAX_FRACTION_DIGITS) : '0';
    const frac = digits.slice(-MAX_FRACTION_DIGITS).padStart(MAX_FRACTION_DIGITS, '0');
    return `${neg ? '-' : ''}${whole}.${frac} ${CURRENCY.label}`;
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

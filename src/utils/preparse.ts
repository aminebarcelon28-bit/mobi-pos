// src/utils/preparse.ts — NEW FILE (build adaptation A4)
// ---------------------------------------------------------------------------
// Pure string pre-normalization for Money.fromUserInput(), extracted from
// MoneyInput.tsx so the repo's node --experimental-strip-types check scripts
// can import it directly — node cannot type-strip .tsx (JSX is not erased by
// type stripping; importing the component from a .mjs check would syntax-error).
// money.ts stays FROZEN; this file owns ZERO parsing semantics.
//
// HARD RULE (regression-pinned by scripts/test_money_entry_preparse.mjs):
// NO Arabic digit/separator remapping here. money.ts:101-139 owns all digit
// and separator tolerance. A client-side Arabic thousands separator
// (U+066C) remap would corrupt 2000 DA into 2 DA.
// This module does exactly two things: bidi-control strip + ONE trailing
// unit-token strip. Nothing else, ever.
// ---------------------------------------------------------------------------

const BIDI_CONTROLS = /[\u200E\u200F\u061C\u202A-\u202E]/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strips invisible bidi control characters and ONE trailing currency token
 * ("2000.00 DA" → "2000.00"; the incident string). Deliberate semantics:
 * - Prefix units ("DA 2 000") pass through untouched → the frozen parser
 *   throws → rollback. Intentional, do not "fix".
 * - Doubled units ("2 000 DA DA" → "2 000 DA") strip once → unparseable.
 * - Garbage ("12.a", "9500.abc") passes through → parser throws (Test J /
 *   boundary guarantees preserved).
 */
export function preParse(raw: string, units: readonly string[]): string {
  const s = raw.replace(BIDI_CONTROLS, "");
  const alt = units.filter(Boolean).map(escapeRegExp).join("|");
  if (!alt) return s;
  return s.replace(new RegExp(`\\s*(?:${alt})\\s*$`, "i"), "");
}

// scripts/test_money_entry_preparse.mjs — preParse matrix in the repo's
// node-check style (no vitest in devDeps; rows ported 1:1 from the original
// matrix — assertions are runner-agnostic).
//
// Run: node --experimental-strip-types scripts/test_money_entry_preparse.mjs
// Gate semantics: exit 0 = all pass. Wire into package.json scripts alongside
// the existing node checks if a convenience alias is wanted.
import { preParse } from "../src/utils/preparse.ts";
import { Money } from "../src/utils/money.ts";

const UNITS = ["DA", "DZD", "دج"]; // DA, DZD, دج — mirrors component defaults

const tryParse = (raw) => {
  try {
    return Money.fromUserInput(preParse(raw, UNITS)).toMinor();
  } catch {
    return null;
  }
};

let failed = 0;
const check = (name, actual, ok) => {
  const pass = ok(actual);
  if (!pass) failed++;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}` +
      (pass ? "" : `  (got ${JSON.stringify(actual)})`)
  );
};

/* ---- preParse: unit strip (defense-in-depth) ---- */
check('preParse("2000.00 DA")', preParse("2000.00 DA", UNITS), (v) => v === "2000.00"); // the incident string
check('preParse("2 000 DA")', preParse("2 000 DA", UNITS), (v) => v === "2 000");
check('preParse("2 000 DZD")', preParse("2 000 DZD", UNITS), (v) => v === "2 000");
check('preParse("2000 dzd") case-insensitive', preParse("2000 dzd", UNITS), (v) => v === "2000");
check('preParse("2 000 دج")', preParse("2 000 دج", UNITS), (v) => v === "2 000");

/* ---- preParse: bidi control strip ---- */
check("preParse(bidi-wrapped 2000)", preParse("‎‏2000‏", UNITS), (v) => v === "2000");
check("preParse(bidi + DA)", preParse("‎‏2000‏ DA", UNITS), (v) => v === "2000");

/* ---- preParse: no over-strip (single-strip semantics intentional) ---- */
check('preParse("DA 2 000") stays prefixed', preParse("DA 2 000", UNITS), (v) => v === "DA 2 000");
check('preParse("2 000 DA DA") strips once', preParse("2 000 DA DA", UNITS), (v) => v === "2 000 DA");

/* ---- preParse: garbage passthrough (parser strictness intact — Test J) ---- */
check('preParse("12.a") untouched', preParse("12.a", UNITS), (v) => v === "12.a");
check('preParse("9500.abc") untouched', preParse("9500.abc", UNITS), (v) => v === "9500.abc");

/* ---- tryParse: full frozen-parser pipeline ---- */
check('tryParse("2000.00 DA") = 200000 minor', tryParse("2000.00 DA"), (v) => v === 200000);
check('tryParse("2 000 DA") = 200000 minor', tryParse("2 000 DA"), (v) => v === 200000);
check('tryParse("DA 2 000") = null (prefix rejects)', tryParse("DA 2 000"), (v) => v === null);
check('tryParse("12.a") = null', tryParse("12.a"), (v) => v === null);
check('tryParse("9500.abc") = null', tryParse("9500.abc"), (v) => v === null);
check('tryParse("") = null', tryParse(""), (v) => v === null);
check('tryParse("   ") = null', tryParse("   "), (v) => v === null);

/* ---- no-corruption guarantees (Arabic separators owned by frozen parser) ---- */
// Arabic thousands separator (U+066C): accepted-as-2000 OR rejected are both
// fine; 200 minor = the 1000x corruption signature = FAIL.
check("tryParse(Arabic-thousands 2000) = 200000 or null, NEVER 200", tryParse("٢٬٠٠٠"), (v) => v === null || v === 200000);
check("tryParse(Arabic-decimal 2.50) = 250 or null", tryParse("٢٫٥٠"), (v) => v === null || v === 250);
check('tryParse("2000,50") = 200050 (fr comma, parser-owned)', tryParse("2000,50"), (v) => v === 200050);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);

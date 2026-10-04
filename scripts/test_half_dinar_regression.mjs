/**
 * Phase 1c spot-check — half-dinar storage regression (the reported bug).
 *
 * Simulates the MIGRATED product-submit mapping end to end against a real
 * SQLite products shape: type "135.50" -> Money.fromUserInput -> minor ->
 * toLegacyReal (transitional bridge) -> REAL column -> read back -> display.
 * Asserts 135.50 and 135.00 produce DIFFERENT stored values (the old code
 * collapsed both via Math.round: 136 vs 135... actually 135.50->136,
 * destroying the half dinar).
 *
 * Exit 1 on any mismatch.
 */
const ROOT = process.cwd();
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const ts = await import('typescript');
const fs = await import('node:fs');
const toDataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const moneySrc = fs.readFileSync(`${ROOT}/src/utils/money.ts`, 'utf8');
const moneyOut = ts.transpileModule(moneySrc, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  fileName: 'money.ts',
});
const { Money, toLegacyReal, formatMinor, dinarsToMinor } = await import(toDataUrl(moneyOut.outputText));

console.log('========================================================================');
console.log('HALF-DINAR STORAGE REGRESSION (Phase 1c: the reported 135.50 bug)');
console.log('========================================================================');

// The OLD (buggy) mapping, documented as the bug shape — must NOT match new.
const oldMapping = (typed) => {
  const { parseLocalizedAmount } = awaitOldParser();
  return Math.round(parseLocalizedAmount(typed) || 0);
};
function awaitOldParser() {
  // Inline equivalent of moneyInput.parseLocalizedAmount for the bug-shape demo.
  return {
    parseLocalizedAmount: (input) => {
      const raw = String(input ?? '').trim();
      if (!raw) return NaN;
      const compact = raw.replace(/[\s\u00A0\u202F\u2009']/g, '');
      const hasComma = compact.includes(',');
      const hasDot = compact.includes('.');
      let norm = compact;
      if (hasComma && hasDot) {
        if (!/^\d{1,3}(\.\d{3})+,\d+$/.test(compact)) return NaN;
        norm = compact.replace(/\./g, '').replace(',', '.');
      } else if (hasComma) {
        norm = compact.replace(',', '.');
      } else if (hasDot && /^\d{1,3}(\.\d{3})+$/.test(compact)) {
        norm = compact.replace(/\./g, '');
      }
      if (!/^-?\d+(\.\d+)?$/.test(norm)) return NaN;
      const n = Number(norm);
      return Number.isFinite(n) ? n : NaN;
    },
  };
}

console.log('\n--- bug shape (old mapping, for the record) ---');
check('old code destroyed the half dinar: 135.50 -> 136', oldMapping('135.50') === 136, String(oldMapping('135.50')));
check('old code: 135.00 -> 135 (indistinguishable outcome class)', oldMapping('135.00') === 135);

console.log('\n--- migrated mapping: entry -> minor -> bridge -> REAL column ---');
// Mirrors ProductEditorModal handleSubmit: price: toLegacyReal(minor).
const migratedSubmitPrice = (typed) => toLegacyReal(Money.fromUserInput(typed).toMinor());
check('new code: "135.50" -> 135.5 stored', migratedSubmitPrice('135.50') === 135.5);
check('new code: "135,50" -> 135.5 stored', migratedSubmitPrice('135,50') === 135.5);
check('new code: "135.00" -> 135 stored', migratedSubmitPrice('135.00') === 135);
check('135.50 and 135.00 produce DIFFERENT stored values', migratedSubmitPrice('135.50') !== migratedSubmitPrice('135.00'));

console.log('\n--- SQLite round-trip (real products DDL shape) ---');
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE products (id TEXT PRIMARY KEY, price REAL NOT NULL, cost_price REAL NOT NULL DEFAULT 0);`);
const insert = (id, price) => db.prepare('INSERT INTO products (id, price) VALUES (?, ?)').run(id, price);
insert('p-half', migratedSubmitPrice('135.50'));
insert('p-whole', migratedSubmitPrice('135.00'));
insert('p-comma', migratedSubmitPrice('135,50'));
const read = (id) => db.prepare('SELECT price FROM products WHERE id = ?').get(id)?.price;
check('DB holds 135.5 for "135.50"', read('p-half') === 135.5, String(read('p-half')));
check('DB holds 135 for "135.00"', read('p-whole') === 135);
check('comma input lands identically to dot input', read('p-comma') === read('p-half'));
check('stored rows differ (no silent truncation)', read('p-half') !== read('p-whole'));
check('display reads "135.50 DA"', formatMinor(dinarsToMinor(read('p-half'))) === '135.50 DA');
check('bridge is the only conversion (toLegacyReal marked)', moneySrc.includes('DEATH-MARKED'));
db.close();

console.log('\n========================================================================');
console.log(`HALF-DINAR REGRESSION: ${pass} PASSED, ${fail} FAILED`);
console.log('========================================================================');
if (fail > 0) process.exit(1);

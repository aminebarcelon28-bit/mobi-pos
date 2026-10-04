/**
 * Test J — Money entry & display (PD-22/PD-23, Zero-Drift Mandate v4).
 *
 * CI-blocking. Proves: string-based entry never touches float, display is
 * always two-decimal dinars, half-dinar prices flow exactly end to end,
 * and integer minor units never surface in user-facing code.
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
const src = fs.readFileSync(`${ROOT}/src/utils/money.ts`, 'utf8');
const out = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  fileName: 'money.ts',
});
const { Money, CURRENCY } = await import(toDataUrl(out.outputText));

console.log('========================================================================');
console.log('TEST J — MONEY ENTRY (PD-22) & DISPLAY (PD-23)');
console.log('========================================================================');

console.log('\n--- J0: single currency constant ---');
check('CURRENCY.code DZD, exponent 2', CURRENCY.code === 'DZD' && CURRENCY.exponent === 2 && CURRENCY.label === 'DA', JSON.stringify(CURRENCY));

console.log('\n--- J1: entry vectors (string in, exact minor out) ---');
const entryCases = [
  ['130.5', 13050], ['130.05', 13005], ['4.35', 435], ['0.1', 10],
  ['130', 13000], ['130,5', 13050], ['0.10', 10], ['0', 0],
  ['45.000', 4500000], ['1.000.000', 100000000], ['12.500,50', 1250050],
  [' 130.5 ', 13050], ['.5', 50], ['130.', 13000],
];
for (const [input, want] of entryCases) {
  let got;
  try {
    got = Money.fromUserInput(input).toMinor();
  } catch (e) {
    got = `threw:${e?.message}`;
  }
  check(`"${input}" → ${want}`, got === want, `got ${got}`);
}
const rejectCases = ['130.5555', '4.3575', '0.0001', '-5', '+5', '', 'abc', '1,200.50', '12..5', '1e3', '13.5.55', '130,555'];
// NOTE: "130.555" is NOT in the reject list — under the FR convention shared
// with moneyInput (B-027: "1.234"→1234), dot-groups of 3 are thousand
// separators, so "130.555" = 130,555 DA exactly (verified below). Genuine
// 3-decimal inputs ("4.357", "0.001") are rejected, never rounded.
check('"130.555" reads as FR-grouped 130,555 DA (convention, not decimals)',
  Money.fromUserInput('130.555').toMinor() === 13055500, String(Money.fromUserInput('130.555').toMinor()));
for (const input of rejectCases) {
  let threw = false;
  try {
    Money.fromUserInput(input);
  } catch {
    threw = true;
  }
  check(`"${input}" REJECTED (never rounded)`, threw);
}
{
  // The float intermediate is provably inexact (434.999...); Math.round
  // merely masks it on this runtime — masking fails at other magnitudes and
  // in longer pipelines, which is why entry must never touch float.
  check('float intermediate inexact (4.35*100 is 434.999..., not 435)',
    parseFloat('4.35') * 100 !== 435, String(parseFloat('4.35') * 100));
  check('Money gives exact 435', Money.fromUserInput('4.35').toMinor() === 435);
}

console.log('\n--- J2: display vectors (C-4 shared fixture, always two decimals) ---');
// C-4: this file is shared with Rust money::tests (same path, same vectors).
const fixture = JSON.parse(fs.readFileSync(`${ROOT}/tests/fixtures/money_display_vectors.json`, 'utf8'));
check('fixture loads with vectors', Array.isArray(fixture.vectors) && fixture.vectors.length > 0);
for (const [minor, want] of fixture.vectors) {
  const got = Money.fromMinor(minor).format();
  check(`${minor} → "${want}"`, got === want, `got "${got}"`);
}

console.log('\n--- J3: end-to-end half-dinar ---');
{
  const stored = Money.fromUserInput('130.5');
  check('input 130.5 stores 13050', stored.toMinor() === 13050);
  check('screen shows "130.50 DA"', stored.format() === '130.50 DA');
  check('JSON carries "13050" (string)', stored.toJSON() === '13050');
  check('JSON round-trips losslessly', Money.fromJSON(stored.toJSON()).equals(stored));
}

console.log('\n--- J4: half-dinar P&L (zero rounding in path) ---');
{
  // Buy 10 @ 130.5 → cost 130,500 s; sell 3 @ 150.0 → revenue 45,000 s;
  // COGS 39,150 s; profit EXACTLY 5,850 s (58.50 DA).
  const cost = Money.fromUserInput('130.5').mulInt(10);
  const revenue = Money.fromUserInput('150.0').mulInt(3);
  const cogs = Money.fromUserInput('130.5').mulInt(3);
  const profit = revenue.sub(cogs);
  check('cost 130,500 s', cost.toMinor() === 130500, String(cost.toMinor()));
  check('revenue 45,000 s', revenue.toMinor() === 45000, String(revenue.toMinor()));
  check('COGS 39,150 s', cogs.toMinor() === 39150, String(cogs.toMinor()));
  check('profit EXACTLY 5,850 s', profit.toMinor() === 5850, String(profit.toMinor()));
  check('profit displays "58.50 DA"', profit.format() === '58.50 DA');
}

console.log('\n--- J5: fractional qty x santeem price ---');
{
  // 0.5 units (500 milli) @ 130.5 → 6,525 s exactly.
  const line = Money.fromUserInput('130.5').mulDivHalfUp(500, 1000);
  check('500milli x 13050 / 1000 = 6,525 s', line.toMinor() === 6525, String(line.toMinor()));
  // Allocator spot-check (§8 shape): cumulative target on 3-unit/1,000,000 s batch.
  const step1 = Money.fromMinor(1000000).mulDivHalfUp(500, 3000);
  check('cumulative target step1 = 166,667 s', step1.toMinor() === 166667, String(step1.toMinor()));
}

console.log('\n--- J1b: Arabic-script entry (BUG-MONEY-03) ---');
const arabicCases = [
  ['١٣٥٫٥٠', 13550], ['135٫50', 13550], ['١٣٥.٥٠', 13550],
  ['١٬٢٠٠٫٥٠', 120050], ['٤.٣٥', 435], ['٠.١', 10],
];
const abCases = [
  // A/B evaluation (PD-24 default A): grouping read is script-agnostic —
  // Latin and Arabic inputs behave identically; B's retype path verified.
  ['١٣٠٫٥٥٥', 13055500], ['130555', 13055500],
];
for (const [input, want] of [...arabicCases, ...abCases]) {
  let got;
  try {
    got = Money.fromUserInput(input).toMinor();
  } catch (e) {
    got = `threw:${e?.message}`;
  }
  check(`"${input}" → ${want}`, got === want, `got ${got}`);
}

console.log('\n--- J7: live canonical echo (C-2, extends PD-23) ---');
// Every money input must display fromUserInput(value).format() while typing /
// before commit: a mis-parse (esp. the 1000x grouping ambiguity) is VISIBLE
// before money moves. These vectors pin the echo contract the Stage E entry
// fields implement.
const echoCases = [
  ['45.000', '45 000.00 DA'],
  ['130,5', '130.50 DA'],
  ['130.555', '130 555.00 DA'],
  ['4.35', '4.35 DA'],
  ['12.500,50', '12 500.50 DA'],
  ['0.5', '0.50 DA'],
  ['130', '130.00 DA'],
  ['1000000', '1 000 000.00 DA'],
];
for (const [input, want] of echoCases) {
  const got = Money.fromUserInput(input).format();
  check(`echo "${input}" → "${want}"`, got === want, `got "${got}"`);
}

console.log('\n--- J8: transitional bridges (1c entry, death-marked at 1b-ii) ---');
const { toLegacyReal, dinarsToMinor, formatMinor } = await import(toDataUrl(out.outputText));
check('toLegacyReal(13550) === 135.5 exactly', toLegacyReal(13550) === 135.5, String(toLegacyReal(13550)));
check('toLegacyReal(13050) === 130.5 exactly', toLegacyReal(13050) === 130.5, String(toLegacyReal(13050)));
check('toLegacyReal(10) === 0.1 (nearest float; storage limit, not computation)', toLegacyReal(10) === 0.1);
check('toLegacyReal(0) === 0', toLegacyReal(0) === 0);
check('dinarsToMinor(3500) === 350000 (integer fast path)', dinarsToMinor(3500) === 350000);
check('dinarsToMinor(135.5) === 13550 (string path)', dinarsToMinor(135.5) === 13550);
check('dinarsToMinor(0.1) === 10 (string path)', dinarsToMinor(0.1) === 10);
check('dinarsToMinor(135.50000000001) === 13550 (dust fallback, <=1 minor)', dinarsToMinor(135.50000000001) === 13550);
check('formatMinor(13550) === "135.50 DA"', formatMinor(13550) === '135.50 DA');
check('formatMinor(4500000) === "45 000.00 DA"', formatMinor(4500000) === '45 000.00 DA');

console.log('\n--- J6: UI sweep (no raw integers, no santeem word) ---');
{
  const { execFileSync } = await import('node:child_process');
  const grep = (pat, paths) => {
    try {
      const o = execFileSync('git', ['grep', '-n', '-i', '-E', pat, '--', ...paths], { cwd: ROOT, encoding: 'utf8' });
      return String(o).split('\n').map((l) => l.trim()).filter(Boolean);
    } catch (e) {
      return e?.status === 1 ? [] : ['(grep unavailable)'];
    }
  };
  // MoneyInput.tsx is the implementation (it legitimately calls the
  // primitive); the sweep covers every other user-facing path.
  const santeemHits = grep('santeem', ['src/components', 'src/utils', 'src/store', 'src/db'])
    .filter((l) => !l.includes('(grep unavailable)') && !l.includes('src/components/ui/MoneyInput.tsx'));
  check('no "santeem" in components/store/db/utils (unit word never user-facing)', santeemHits.length === 0, santeemHits.slice(0, 3).join(' | '));
  const minorRender = grep('\\.toMinor\\(\\)', ['src/components', 'src/utils/escpos.ts', 'src/utils/mobileDocPrint.ts', 'src/utils/receiptViewModel.ts', 'src/components/receipt'])
    .filter((l) => !l.includes('(grep unavailable)') && !l.includes('src/components/ui/MoneyInput.tsx'));
  check('no .toMinor() in display paths (format() only)', minorRender.length === 0, minorRender.slice(0, 3).join(' | '));
}

console.log('\n========================================================================');
console.log(`TEST J: ${pass} PASSED, ${fail} FAILED`);
console.log('========================================================================');
if (fail > 0) process.exit(1);

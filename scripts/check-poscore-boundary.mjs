/**
 * pos-core quarantine gate (D4: CT-001). CI-blocking.
 *
 * crates/pos-core models a receipt WITHOUT status/money semantics (no
 * status, tenders, refunds, vouchers, shifts — see models.rs vs
 * src/types/pos.ts SaleTransaction). Its only legitimate consumer is
 * receipt PRINTING (crates/pos-peripherals ESC/POS display path), which
 * reads totals but never decides money. Any gateway, sync lane, store
 * slice, or adapter built on pos-core types would silently drop
 * status/refund/voucher/shift semantics.
 *
 * Rules:
 *  1. `use pos_core` appears ONLY in crates/pos-core itself and
 *     crates/pos-peripherals (plus #[cfg(test)] modules).
 *  2. No TS file under src/store, src/sync, src/db imports pos-core
 *     models (directly or via packages/shared mirror).
 *  3. pos-peripherals stays display-only: no money arithmetic on sale
 *     fields (no accumulation, change computation, or profit derivation).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';

const ROOT = process.cwd();
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

import { readdirSync, statSync } from 'node:fs';
function collect(dir, exts, out = []) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'target' || e === 'target-test' || e === '.git') continue;
    const p = join(dir, e);
    let st = null;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) collect(p, exts, out);
    else if (exts.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

console.log('========================================================================');
console.log('POS-CORE QUARANTINE GATE (D4/CT-001)');
console.log('========================================================================');

// Rule 1: Rust usage confined to pos-core + pos-peripherals (+ tests).
{
  const rsFiles = collect(join(ROOT, 'crates'), ['.rs']).concat(collect(join(ROOT, 'src-tauri', 'src'), ['.rs']));
  const bad = [];
  for (const f of rsFiles) {
    if (f.includes(`${sep}pos-core${sep}`)) continue;
    if (f.includes(`${sep}pos-peripherals${sep}`)) continue;
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    if (/use\s+pos_core::/.test(src)) bad.push(f);
  }
  check('use pos_core confined to pos-core/pos-peripherals', bad.length === 0, bad.slice(0, 5).join(' | '));
}

// Rule 2: no TS money-lane imports of the mirror.
{
  const tsFiles = [];
  for (const d of ['src/store', 'src/sync', 'src/db']) tsFiles.push(...collect(join(ROOT, d), ['.ts', '.tsx']));
  const bad = [];
  for (const f of tsFiles) {
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    if (/from\s+['"][^'"]*pos-core[^'"]*['"]/.test(src)) bad.push(f);
    if (/from\s+['"][^'"]*packages\/shared[^'"]*['"]/.test(src)) bad.push(f);
  }
  check('no TS money-lane imports of pos-core mirror', bad.length === 0, bad.slice(0, 5).join(' | '));
}

// Rule 3: pos-peripherals stays display-only.
{
  const lib = join(ROOT, 'crates', 'pos-peripherals', 'src', 'lib.rs');
  let src = '';
  try { src = existsSync(lib) ? readFileSync(lib, 'utf8') : ''; } catch { src = ''; }
  const code = src.split('#[cfg(test)]')[0];
  const moneyMath = /(sale|order)\s*\.\s*(subtotal|total|discount_total)\s*[-+*/]|change\s*[:=]|profit\s*[:=]|sum\s*\+=/.test(code);
  check('pos-peripherals has no money arithmetic', !moneyMath);
  check('pos-peripherals reads totals for display only', /sale\.total/.test(code));
}

console.log(`\nposcore-quarantine: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

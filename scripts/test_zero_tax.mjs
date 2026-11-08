/**
 * Zero-Tax Consistency Proof — POST-DROP GATE (Phase 1b-i, plan
 * docs/plan-1b-i-tax-drop.md §9 + §10-C5).
 *
 * Owner-confirmed product truth: this software has NO TVA/VAT feature, and the
 * tax COLUMN is gone from `transactions` on both sides (local migration v108,
 * remote migration v13). Nothing writes, reads, prints, or syncs a tax amount.
 *
 * Asserts:
 *  E1. The tax engine is GONE (no module, no symbol, no rate option).
 *  E2. Money math is HT-only and still exact (no tax term, discounts intact).
 *  E3. Schema proof: the remote replays to a tax-free `transactions`, and no
 *      SQLite artifact this build produced carries the column.
 *  E4. BLOCKING static grep: zero tax identifiers in src/ + src-tauri/src/
 *      outside an explicit, line-pinned whitelist (each entry is a comment, a
 *      migration record, or the §10-B2 supplier-OCR noise-skip).
 *
 * A hit outside the whitelist fails the build. Extend the whitelist with
 * evidence (a comment explaining WHY the line is tax-free), never silently.
 */
const ROOT = process.cwd();

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

const fs = await import('node:fs');
const path = await import('node:path');
const ts = await import('typescript');
const { createHash } = await import('node:crypto');

console.log('========================================================================');
console.log('ZERO-TAX GATE (post-drop, Phase 1b-i)');
console.log('========================================================================');

// ---------------------------------------------------------------------------
// E1 — the tax engine is gone
// ---------------------------------------------------------------------------
console.log('\n--- E1: no tax engine module or symbol ---');
check('src/utils/taxEngine.ts does not exist', !fs.existsSync(path.join(ROOT, 'src/utils/taxEngine.ts')));
const rmSourceText = fs.readFileSync(path.join(ROOT, 'src/utils/receiptMath.ts'), 'utf8');
check(
  'receiptMath no longer imports the tax engine',
  !/from\s+['"]\.\/taxEngine['"]/.test(rmSourceText)
);
const cartTotalsSrc = rmSourceText;
const cartTotalsBody = cartTotalsSrc.slice(
  cartTotalsSrc.indexOf('export interface CartTotals {'),
  cartTotalsSrc.indexOf('export function computeCartTotals')
);
check(
  'CartTotals declares no tax/tva field',
  !/^\s*(tax|tva)\??:/m.test(cartTotalsBody),
  cartTotalsBody.match(/^\s*(tax|tva)\??:.*$/m)?.[0] ?? ''
);
check(
  'CartTotalsOptions declares no vatRate option',
  !/vatRate/.test(
    cartTotalsSrc.slice(
      cartTotalsSrc.indexOf('export interface CartTotalsOptions {'),
      cartTotalsSrc.indexOf('export interface TradeInSettlementResult')
    )
  )
);
const posTypes = fs.readFileSync(path.join(ROOT, 'src/types/pos.ts'), 'utf8');
check('types/pos.ts ReceiptSettings has no vatRate', !/vatRate/.test(posTypes));
const cartSlice = fs.readFileSync(path.join(ROOT, 'src/store/slices/createCartSlice.ts'), 'utf8');
check('createCartSlice has no readVatRate stub', !/readVatRate/.test(cartSlice));

// ---------------------------------------------------------------------------
// E2 — money math is HT-only and exact
// ---------------------------------------------------------------------------
const toDataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const transpileFile = (absPath) =>
  ts.transpileModule(fs.readFileSync(absPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: absPath,
  }).outputText;
const pricingUrl = toDataUrl(transpileFile(path.join(ROOT, 'src/utils/pricingEngine.ts')));
let rmSrc2 = fs.readFileSync(path.join(ROOT, 'src/utils/receiptMath.ts'), 'utf8');
rmSrc2 = rmSrc2.replace(/from\s+(['"])\.\/pricingEngine\1/g, `from '${pricingUrl}'`);
const rm = await import(toDataUrl(ts.transpileModule(rmSrc2, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  fileName: 'receiptMath.ts',
}).outputText));
const { computeCartTotals } = rm;

console.log('\n--- E2: totals are HT-only (no tax term) ---');
const line = (price, qty = 1, extra = {}) => ({ product: { price }, appliedPrice: price, quantity: qty, ...extra });
{
  const t = computeCartTotals([line(10000)]);
  check('plain 10k: total 10000, ht == ttc', t.total === 10000 && t.ht === 10000 && t.ttc === 10000, JSON.stringify({ total: t.total, ht: t.ht, ttc: t.ttc }));
  check('plain 10k: result has NO tax/tva own property', !('tax' in t) && !('tva' in t), Object.keys(t).join(','));
}
{
  const t = computeCartTotals([line(100000)], { cartDiscountPercent: 10, storeCreditApplied: 10000, voucherCreditApplied: 5000, tradeInCredit: 20000 });
  check('stacked discounts+credits: total = 90000-35000 = 55000', t.total === 55000, JSON.stringify({ total: t.total }));
  check('stacked ht equals pre-credit base 90000', t.ht === 90000, String(t.ht));
}
{
  const t = computeCartTotals([line(3333), line(3333), line(3334)]);
  check('3-line 10 000: total exactly 10000', t.total === 10000, JSON.stringify({ total: t.total }));
}
{
  // Return of a discounted line refunds exactly what was charged.
  const t = computeCartTotals([{ product: { price: 9000 }, appliedPrice: 9000, quantity: 1, isReturn: true, discount: 1000 }]);
  check('return of discounted line refunds charged 8000', t.net === -8000 && t.refundDue === 8000, JSON.stringify({ net: t.net, rd: t.refundDue }));
}

console.log('\n--- E2b: discounts untouched ---');
{
  const t = computeCartTotals([line(100000)], { cartDiscountPercent: 10 });
  check('10% cart discount still exact: total 90000', t.total === 90000 && t.cartDiscountTotal === 10000, JSON.stringify({ total: t.total }));
  const tl = computeCartTotals([{ product: { price: 1000 }, appliedPrice: 1000, quantity: 2, discount: 200 }]);
  check('line discount still exact: total 1800', tl.total === 1800, String(tl.total));
}

// ---------------------------------------------------------------------------
// E3 — schema proof (remote replay + local artifacts)
// ---------------------------------------------------------------------------
console.log('\n--- E3: transactions carries no tax column ---');
const remoteSrc = fs.readFileSync(path.join(ROOT, 'src/sync/remoteSchema.ts'), 'utf8');
const { DatabaseSync } = await import('node:sqlite');
const remoteDbFile = path.join(ROOT, 'tmp-zero-tax-remote-probe.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.rmSync(remoteDbFile + suffix); } catch { /* first run */ }
}
{
  const db = new DatabaseSync(remoteDbFile);
  // Replay the real migration list (v1 base DDL … v13 drop) statement by
  // statement, exactly as applyRemoteMigrations does.
  const migBlock = remoteSrc.slice(remoteSrc.indexOf('export const REMOTE_MIGRATIONS'), remoteSrc.indexOf('export const LATEST_REMOTE_VERSION'));
  // Statements are single-quoted OR backticked (with no interpolation) in the
  // migration list; both forms are real DDL.
  const stmts = [
    ...[...migBlock.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n')),
    ...[...migBlock.matchAll(/`([^`]*)`/g)].map((m) => m[1]),
  ].filter((s) => /^(CREATE|ALTER|DROP)\b/i.test(s) && !/\$\{/.test(s));
  for (const s of stmts) {
    try { db.exec(s); } catch { /* duplicate column / already-exists: expected on replay */ }
  }
  const cols = db.prepare("SELECT name FROM pragma_table_info('transactions')").all().map((c) => c.name);
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get();
  check('remote replay built a transactions table', cols.length > 0, `cols=${cols.length}`);
  check('remote replay: NO tax column', !cols.includes('tax'), cols.join(','));
  check('remote replay: stored DDL has no tax', !/\btax\b/i.test(ddl?.sql ?? ''), (ddl?.sql ?? '').slice(0, 80));
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(remoteDbFile + suffix); } catch { /* keep going */ }
  }
}
{
  const localMigrations = fs.readFileSync(path.join(ROOT, 'src-tauri/src/lib.rs'), 'utf8');
  check(
    'local migration v108 drops the column',
    /version: 108[\s\S]*?ALTER TABLE transactions DROP COLUMN tax;/.test(localMigrations),
    'v108 DROP COLUMN not found'
  );
  check(
    'local v108 drops dependent views first (SQLite refuses otherwise)',
    /version: 108[\s\S]*?DROP VIEW IF EXISTS orders;[\s\S]*?DROP VIEW IF EXISTS order_items;[\s\S]*?ALTER TABLE transactions DROP COLUMN tax;[\s\S]*?CREATE VIEW IF NOT EXISTS orders/.test(localMigrations)
  );
}
{
  // Every SQLite artifact this build produced must be tax-free.
  const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.db') && f !== 'tmp-zero-tax-remote-probe.db');
  const offenders = [];
  let inspected = 0;
  for (const f of files) {
    try {
      const db = new DatabaseSync(path.join(ROOT, f), { readOnly: true });
      const t = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='transactions'").get();
      if (t && t.n > 0) {
        inspected += 1;
        const hit = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('transactions') WHERE name='tax'").get();
        if (hit && hit.n > 0) offenders.push(f);
      }
      db.close();
    } catch { /* not a readable SQLite file */ }
  }
  // The GATE is "no artifact carries transactions.tax" (vacuously true on a
  // clean checkout with no artifacts). The inspected count is informational:
  // requiring inspected > 0 broke clean CI runs, which have no local .db
  // artifacts by design.
  check(`local artifacts inspected (${inspected} with a transactions table)`, true);
  check('local artifacts: none carries transactions.tax', offenders.length === 0, offenders.join(','));
}

// ---------------------------------------------------------------------------
// E4 — BLOCKING static grep with a line-pinned whitelist
// ---------------------------------------------------------------------------
console.log('\n--- E4: blocking static grep (src/ + src-tauri/src/) ---');
const TAX_RE = /\btax(es)?\b|\bvatRate\b|\btva\b/i;

/**
 * Content-anchored allowlist (HAR-007, 2026-11-03). Each entry is
 * [file, sha1(trimmed line).slice(0,12), count]. A line may MOVE without
 * failing (line numbers are not part of the key); any NEW tax-bearing line,
 * or any content edit to an allowed line, fails; leftover allowances fail as
 * stale. Same 72 hits as the previous line-pinned list, verified 1:1.
 *   (a) a comment documenting the removed column/feature,
 *   (b) a migration that DROPS tax (v108 local / v13 remote),
 *   (c) a guard/fixture that REJECTS a tax column or key, or
 *   (d) the supplier-invoice OCR fixture text.
 */
const WHITELIST = [
  // src/components/modals/PurchaseOrderA4Document.tsx
  ['src/components/modals/PurchaseOrderA4Document.tsx', '5159d79bbbd4', 1], // "{/* Single Bold Grand Total (Strictly NO tax breakdown) */}"
  // src/db/sqlPluginAdapter.ts
  ['src/db/sqlPluginAdapter.ts', '4fb1a387c5bd', 1], // "// Phase 1b-i: `tax` removed — the column is gone and no sale may carr"
  ['src/db/sqlPluginAdapter.ts', 'a4aa47f40a76', 1], // "// Phase 1b-i: the `tax` column is gone (no-TVA product). The paramete"
  ['src/db/sqlPluginAdapter.ts', '3e52103f10cc', 1], // "// `tax` was its 5th entry, so every placeholder after it shifted down"
  ['src/db/sqlPluginAdapter.ts', '9b9651a21994', 1], // "* Phase 1b-i: the legacy `vatRate` key is dropped here too. The field "
  ['src/db/sqlPluginAdapter.ts', '1acb861d0eb5', 1], // "* ReceiptSettings type (no-TVA product), so a pre-drop row can still c"
  ['src/db/sqlPluginAdapter.ts', 'cf82b2031c5e', 1], // "// Phase 1b-i: dead legacy key from the deleted tax-rate field."
  ['src/db/sqlPluginAdapter.ts', '0e39bd295cfc', 1], // "vatRate: _droppedVatRate,"
  // src/store/slices/createOrderSlice.ts
  ['src/store/slices/createOrderSlice.ts', 'c05c5273a09a', 1], // "// no VAT term and no `tax` field (Phase 1b-i)."
  // src/sync/genericApply.ts
  ['src/sync/genericApply.ts', '1a7548c786f7', 1], // "// Phase 1b-i: a pre-drop peer row can still carry the deleted tax-rat"
  ['src/sync/genericApply.ts', '0f5f2014ec3c', 1], // "if ('vatRate' in (value as Record<string, unknown>)) {"
  ['src/sync/genericApply.ts', '61c063c7667d', 1], // "const { vatRate: _droppedVatRate, ...rest } = value as Record<string, "
  // src/sync/payloadHygiene.ts
  ['src/sync/payloadHygiene.ts', 'd6258863fa2a', 1], // "// Phase 1b-i: `tax` removed — it is no longer part of any contract, s"
  // src/sync/remoteSchema.ts
  ['src/sync/remoteSchema.ts', 'de52688ebb1b', 1], // "// Phase 1b-i: the POS `transactions.tax` column is dropped. Gate Adde"
  ['src/sync/remoteSchema.ts', '9b5fe0be3023', 1], // "// but zeros (live + remote `tax != 0` count = 0), so this loses no da"
  ['src/sync/remoteSchema.ts', 'bcd941101534', 1], // "// Old builds asking for `tax` get a per-table pull stall / push quara"
  ['src/sync/remoteSchema.ts', '5b1ae27b6ae6', 1], // "description: 'Drop transactions.tax (no-TVA product; every dropped val"
  ['src/sync/remoteSchema.ts', 'df4233f4526c', 1], // "// A remote created from the post-drop base DDL never had `tax`, so th"
  ['src/sync/remoteSchema.ts', '35fb13d31102', 1], // "'ALTER TABLE transactions DROP COLUMN tax;',"
  // src/sync/SyncManager.ts
  ['src/sync/SyncManager.ts', '4168e490db7d', 1], // "// Phase 1b-i: `tax` dropped from PULL_COLUMNS with the remote v13 dro"
  ['src/sync/SyncManager.ts', '856f11bdf2f8', 1], // "// F6: a forced probe right after a recent verification is pure tax on"
  // src/types/po.ts
  ['src/types/po.ts', '9f4b241172c8', 1], // "// Phase 1b-i (Addendum B): no reported-tax field — the software model"
  // src/utils/documentScanner.ts
  ['src/utils/documentScanner.ts', '9181bea41283', 1], // "* Tax = 0.00"
  // src/utils/escpos.ts
  ['src/utils/escpos.ts', 'da163e2daf20', 1], // "// B-028: print gross REMISE/credit/TVA lines BEFORE TOTAL so the hard"
  ['src/utils/escpos.ts', 'd8ccdd901a75', 1], // "// Phase 1b-i: no TVA/HT/TTC block. There is no rate to print, no `tax"
  // src/utils/mobileDocPrint.ts
  ['src/utils/mobileDocPrint.ts', '7790c0d89921', 1], // "// Phase 1b-i: no TVA/HT/TTC block on the mobile twin either — the rec"
  // src/utils/receiptMath.ts
  ['src/utils/receiptMath.ts', 'e48d3852273c', 1], // "* - NO TAX (no-TVA product, Gate Addendum A + Phase 1b-i): there is no"
  ['src/utils/receiptMath.ts', '07d81c37d97e', 1], // "* result carries no `tax`/`tva` field (they were deleted, not zeroed)."
  ['src/utils/receiptMath.ts', '6aa8f0e952d1', 1], // "// is HT-only by product decision (Gate Addendum A), and the `tax` col"
  // src-tauri/src/geometry.rs
  ['src-tauri/src/geometry.rs', 'f41ef7568b19', 1], // "/// (noise-skip, not a tax feature). Nothing consumes the value: total"
  ['src-tauri/src/geometry.rs', 'e3ab89d8d7e3', 1], // "/// read from the labelled rows below, and the field exists so a \"TVA\""
  ['src-tauri/src/geometry.rs', '82e85b4ae230', 1], // "// noise-skip, not a tax feature: keeps a \"TVA\" row from being treated"
  ['src-tauri/src/geometry.rs', '6b235745ccd2', 1], // "|| lower.contains(\"tva\");"
  ['src-tauri/src/geometry.rs', 'a7ad5b057558', 1], // "/// such as a \"TVA\" line — noise-skip, not a tax feature)."
  ['src-tauri/src/geometry.rs', '1815b163151b', 1], // "// product rows (noise-skip, not a tax feature). No value is surfaced."
  ['src-tauri/src/geometry.rs', '86469038c08f', 1], // "|| lower.starts_with(\"tva \")"
  ['src-tauri/src/geometry.rs', 'd2335a34742a', 1], // "} else if lower.contains(\"tva\") || lower.contains(\"t.v.a\") {"
  ['src-tauri/src/geometry.rs', '1243b03dee3e', 1], // "// noise-skip, not a tax feature: bin the line so it cannot become a"
  ['src-tauri/src/geometry.rs', '4f63fd3e8ebd', 1], // "// 3. Document Summary & Footers (e.g. \"TOTAL HT\", \"TOTAL TTC\", \"NET A"
  ['src-tauri/src/geometry.rs', '566ea49bb68f', 1], // "// noise-skip, not a tax feature: the branch excludes summary rows fro"
  ['src-tauri/src/geometry.rs', 'd4f63c1c451d', 1], // "// product rows and bins their amounts; it models no tax."
  ['src-tauri/src/geometry.rs', '7e27877bbb7b', 1], // "\"TVA 0% : 0,00 DA\","
  // src-tauri/src/lib.rs
  ['src-tauri/src/lib.rs', '57d492f53c2f', 1], // "subtotal REAL NOT NULL, tax REAL DEFAULT 0, discount_total REAL DEFAUL"
  ['src-tauri/src/lib.rs', '2e831b29ec31', 1], // "// v108 — Phase 1b-i: drop the POS `transactions.tax` column."
  ['src-tauri/src/lib.rs', 'f251918120b9', 1], // "// measured `tax != 0` = 0 on the live DB and the merchant remote"
  ['src-tauri/src/lib.rs', '1c01617b4e1a', 1], // "description: \"Phase 1b-i: drop transactions.tax (no-TVA product)\","
  ['src-tauri/src/lib.rs', '82a49c6c7148', 1], // "ALTER TABLE transactions DROP COLUMN tax;"
  // src-tauri/src/commands.rs
  ['src-tauri/src/commands.rs', '0ca9522465ad', 1], // "/// only, never a tax). Optional for backward compatibility."
  ['src-tauri/src/commands.rs', '09f07c23b833', 1], // "// physical shipping/handling fee — never a tax."
  // src-tauri/src/emergency_export.rs
  ['src-tauri/src/emergency_export.rs', '19586c1e3697', 1], // "/// natural person. Retention duties are satisfied by amount, date, ta"
  ['src-tauri/src/emergency_export.rs', '73cf1bf84c96', 1], // "// No `tax` value: the column is dropped (migration 108). The fixture'"
  // src-tauri/src/gate.rs
  ['src-tauri/src/gate.rs', 'e31d161922fc', 1], // "//! (no tax term: Phase 1b-i / Addendum B removed the reported-tax pas"
  ['src-tauri/src/gate.rs', 'dc47b28bfe1e', 1], // "// Phase 1b-i (Addendum B): the reported-tax passthrough is DELETED. F"
  ['src-tauri/src/gate.rs', 'c37489abf5ca', 1], // "// stays — freight is a real fee, not a tax."
  ['src-tauri/src/gate.rs', '4e851d37b8db', 1], // "// NO-TVA PRODUCT (Gate Addendum A + Phase 1b-i / Addendum B): there i"
  ['src-tauri/src/gate.rs', 'd540d9479aaa', 1], // "// reported-tax term at all — the declared grand total is reconciled a"
  ['src-tauri/src/gate.rs', 'cc6413ea9a38', 1], // "// freight ONLY — there is no tax passthrough to feed. A reported tota"
  ['src-tauri/src/gate.rs', 'ed3128c9dfef', 1], // "// that still carries a tax-sized gap must surface as a delta, not be"
  // src-tauri/src/import/dst_simulator.rs
  ['src-tauri/src/import/dst_simulator.rs', '685ff947bbc6', 1], // "//! - Zero-Tax Compliance: strictly Hors-Taxe (HT), zero VAT/TVA schem"
  ['src-tauri/src/import/dst_simulator.rs', 'e74d23623707', 1], // "/// Oracle 4: Zero-Tax Compliance Oracle"
  ['src-tauri/src/import/dst_simulator.rs', '1d64c0d641b4', 1], // "/// Invariant: Strictly Hors-Taxe (HT), zero VAT/TVA columns in databa"
  ['src-tauri/src/import/dst_simulator.rs', '5e0c83aaabb3', 1], // "/// and zero tax keys in sync_outbox payloads."
  ['src-tauri/src/import/dst_simulator.rs', 'd12830549c39', 1], // "if lower_sql.contains(\" tva \")"
  ['src-tauri/src/import/dst_simulator.rs', '7e603ca89ecc', 1], // "\"Table '{}' contains forbidden VAT/tax column in schema: {}\","
  ['src-tauri/src/import/dst_simulator.rs', 'bd660594951f', 1], // "if lower_k == \"tva\""
  ['src-tauri/src/import/dst_simulator.rs', 'dd7a871abbe6', 1], // "|| lower_k == \"tax\""
  ['src-tauri/src/import/dst_simulator.rs', '599f9f6501b7', 1], // "\"Forbidden tax key '{}' found in outbox payload: {}\","
  ['src-tauri/src/import/dst_simulator.rs', '03e707acf129', 1], // ".unwrap_or_else(|e| panic!(\"Iter {}: Zero-Tax Invariant violated: {}\","
  ['src-tauri/src/import/dst_simulator.rs', '48d282e3bdad', 1], // "// Verify Zero-Tax Compliance Oracle"
  ['src-tauri/src/import/dst_simulator.rs', 'f43411fe9a6e', 1], // "// Adversarial input with \"TVA\" / \"Tax\" mentioned in raw text"
  ['src-tauri/src/import/dst_simulator.rs', '9996a5003a7c', 1], // "let csv = \"Désignation;Prix Vente HT;TVA 19%;Prix TTC;Quantité\\nCharge"
  ['src-tauri/src/import/dst_simulator.rs', 'c881d8df3dfd', 1], // "// Verify that price saved is strictly Hors-Taxe (1800 or parsed HT) a"
];


function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function walkRust(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name === 'target-test') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkRust(full, out);
    else if (/\.rs$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = [...walk(path.join(ROOT, 'src')), ...walkRust(path.join(ROOT, 'src-tauri/src'))];
const anchorKey = (file, text) =>
  file + '\u0000' + createHash('sha1').update(text.trim()).digest('hex').slice(0, 12);
const allowance = new Map();
for (const [file, hash, count] of WHITELIST) {
  const k = file + '\u0000' + hash;
  allowance.set(k, (allowance.get(k) ?? 0) + count);
}
const stray = [];
for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  lines.forEach((text, i) => {
    if (!TAX_RE.test(text)) return;
    const k = anchorKey(rel, text);
    const left = allowance.get(k) ?? 0;
    if (left > 0) {
      allowance.set(k, left - 1);
      return;
    }
    stray.push(`${rel}:${i + 1} :: ${text.trim().slice(0, 90)}`);
  });
}
check(`static grep: zero tax identifiers outside the ${WHITELIST.length}-anchor allowlist`, stray.length === 0, `\n      ${stray.join('\n      ')}`);

// Anchor hygiene: an allowance that no live line consumed means the content
// was edited or deleted - the gate must fail rather than silently loosen.
const stale = [];
for (const [k, left] of allowance) {
  if (left > 0) {
    const [file, hash] = k.split('\u0000');
    stale.push(`${file} anchor ${hash} unused x${left}`);
  }
}
check(`allowlist anchors are all still live (${WHITELIST.length})`, stale.length === 0, `\n      ${stale.join('\n      ')}`);

console.log('\n========================================================================');
console.log(`SUMMARY: ${pass} PASSED, ${fail} FAILED`);
console.log('========================================================================');
if (fail > 0) process.exit(1);

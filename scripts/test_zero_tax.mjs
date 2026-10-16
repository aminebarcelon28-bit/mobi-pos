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
  check(`local artifacts inspected (${inspected} with a transactions table)`, inspected > 0, 'none found — run the DB suites first');
  check('local artifacts: none carries transactions.tax', offenders.length === 0, offenders.join(','));
}

// ---------------------------------------------------------------------------
// E4 — BLOCKING static grep with a line-pinned whitelist
// ---------------------------------------------------------------------------
console.log('\n--- E4: blocking static grep (src/ + src-tauri/src/) ---');
const TAX_RE = /\btax(es)?\b|\bvatRate\b|\btva\b/i;

/**
 * Every entry must be a comment, a migration record, or the §10-B2 supplier-OCR
 * noise-skip. Format: 'file:line'. Keep it line-pinned so a moved line fails.
 */
const WHITELIST = new Set([
  // Documented removals (comments recording what was deleted and why).
  'src/db/sqlPluginAdapter.ts:1313',
  'src/db/sqlPluginAdapter.ts:2120',
  'src/db/sqlPluginAdapter.ts:2122',
  // Legacy `vatRate` scrub on the settings lane (push strip + pull apply).
  'src/db/sqlPluginAdapter.ts:3653',
  'src/db/sqlPluginAdapter.ts:3654',
  'src/db/sqlPluginAdapter.ts:3666',
  'src/db/sqlPluginAdapter.ts:3667',
  'src/sync/genericApply.ts:624',
  'src/sync/genericApply.ts:630',
  'src/sync/genericApply.ts:631',
  'src/store/slices/createOrderSlice.ts:483',
  'src/sync/payloadHygiene.ts:37',
  'src/sync/SyncManager.ts:134',
  'src/utils/receiptMath.ts:241',
  'src/utils/receiptMath.ts:243',
  'src/utils/receiptMath.ts:396',
  'src/utils/escpos.ts:279',
  'src/utils/escpos.ts:296',
  'src/utils/mobileDocPrint.ts:162',
  'src/components/modals/PurchaseOrderA4Document.tsx:243',
  'src/types/po.ts:68',
  'src/sync/SyncManager.ts:1230', // "pure tax on the network" — English usage
  // Remote migration v13 (the drop itself + its tolerance note).
  'src/sync/remoteSchema.ts:374',
  'src/sync/remoteSchema.ts:377',
  'src/sync/remoteSchema.ts:376',
  'src/sync/remoteSchema.ts:381',
  'src/sync/remoteSchema.ts:380',
  'src/sync/remoteSchema.ts:385',
  // Local migration v108 + the vestigial creation column it removes on every
  // install (kept: the plugin migrator is transactional, so v1 must still
  // describe the pre-drop shape for v108 to drop; tracked in plan §13 R-5).
  'src-tauri/src/lib.rs:1034',
  'src-tauri/src/lib.rs:1608',
  'src-tauri/src/lib.rs:1612',
  'src-tauri/src/lib.rs:1622',
  'src-tauri/src/lib.rs:1626',
  // §10-B2 whitelist — supplier-OCR noise-skip, each carrying the
  // "noise-skip, not a tax feature" comment.
  'src-tauri/src/geometry.rs:61',
  'src-tauri/src/geometry.rs:62',
  'src-tauri/src/geometry.rs:243',
  'src-tauri/src/geometry.rs:245',
  'src-tauri/src/geometry.rs:250',
  'src-tauri/src/geometry.rs:264',
  'src-tauri/src/geometry.rs:265',
  'src-tauri/src/geometry.rs:295',
  'src-tauri/src/geometry.rs:296',
  'src-tauri/src/geometry.rs:745',
  'src-tauri/src/geometry.rs:746',
  'src-tauri/src/geometry.rs:747',
  'src-tauri/src/geometry.rs:1030', // supplier-invoice OCR fixture line
  'src/utils/documentScanner.ts:165', // supplier-invoice demo fixture line
  // Supplier-side gate (Addendum B): the reported-tax term is gone; these lines
  // document its absence and the freight term that replaced it.
  'src-tauri/src/gate.rs:6',
  'src-tauri/src/gate.rs:68',
  'src-tauri/src/gate.rs:69',
  'src-tauri/src/gate.rs:186',
  'src-tauri/src/gate.rs:187',
  'src-tauri/src/gate.rs:269',
  'src-tauri/src/gate.rs:270',
  // Locked-state export: the column is no longer selected; the retention note
  // names it because retention duties are keyed on the tax line by law.
  'src-tauri/src/emergency_export.rs:87',
  'src-tauri/src/emergency_export.rs:983',
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'src-tauri/src/geometry.rs'), path.join(ROOT, 'src-tauri/src/lib.rs'), path.join(ROOT, 'src-tauri/src/gate.rs'), path.join(ROOT, 'src-tauri/src/emergency_export.rs')];
const stray = [];
for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  lines.forEach((text, i) => {
    if (!TAX_RE.test(text)) return;
    const key = `${rel}:${i + 1}`;
    if (WHITELIST.has(key)) return;
    stray.push(`${key} :: ${text.trim().slice(0, 90)}`);
  });
}
check(`static grep: zero tax identifiers outside the whitelist (${WHITELIST.size} pinned lines)`, stray.length === 0, `\n      ${stray.join('\n      ')}`);

// Whitelist hygiene: a stale entry (line moved or deleted) must fail too,
// otherwise the gate silently loosens over time.
const stale = [];
for (const key of WHITELIST) {
  const at = key.lastIndexOf(':');
  const file = key.slice(0, at);
  const lineNo = Number(key.slice(at + 1));
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) { stale.push(`${key} :: file missing`); continue; }
  const lineText = fs.readFileSync(abs, 'utf8').split('\n')[lineNo - 1] ?? '';
  if (!TAX_RE.test(lineText)) stale.push(`${key} :: no tax token there any more`);
}
check(`whitelist entries are all still live (${WHITELIST.size})`, stale.length === 0, `\n      ${stale.join('\n      ')}`);

console.log('\n========================================================================');
console.log(`SUMMARY: ${pass} PASSED, ${fail} FAILED`);
console.log('========================================================================');
if (fail > 0) process.exit(1);

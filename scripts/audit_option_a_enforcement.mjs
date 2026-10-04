/**
 * Read-only PROOF that Option A is now enforced on the real catalog and the
 * real sold history. Writes nothing; opens the production DB read-only.
 *
 * Before this change, the 129 legacy occasion sales resolved to 12 months at the
 * SAV terminal while their receipts said 3. This re-runs the exposure question
 * through the *shipped* resolver rather than a re-implementation of it.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { resolveWarrantyWithFallback, resolveWarrantyMonths } from '../src/utils/warrantyResolver.ts';

const db = new DatabaseSync(join(process.env.APPDATA, 'com.mobi.pos', 'mobi_pos.db'), { readOnly: true });

const OCCASION_HINT = /(occasion|reprise)/i;
const stripAccents = (s) =>
  typeof s === 'string' ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : '';

const products = db
  .prepare('SELECT id, title, category, json_payload FROM products WHERE deleted = 0')
  .all()
  .map((p) => {
    let blob = null;
    try { blob = p.json_payload ? JSON.parse(p.json_payload) : null; } catch { blob = null; }
    return { id: p.id, title: p.title, category: p.category, blob };
  });
console.log(`products loaded: ${products.length}`);

// --- 1. How the whole active catalog now resolves -------------------------
const tally = new Map();
for (const p of products) {
  const m = resolveWarrantyMonths({ ...(p.blob ?? {}), category: p.category });
  const key = `${m}m`;
  tally.set(key, (tally.get(key) ?? 0) + 1);
}
console.log('\n--- active catalog, resolved term distribution (shipped resolver) ---');
for (const [term, n] of [...tally.entries()].sort()) console.log(String(n).padStart(6), term);

// Occasion rows specifically.
const occ = products.filter((p) => OCCASION_HINT.test(stripAccents(p.category)));
const occTerms = new Map();
for (const p of occ) {
  const m = resolveWarrantyMonths({ ...(p.blob ?? {}), category: p.category });
  occTerms.set(m, (occTerms.get(m) ?? 0) + 1);
}
console.log(`\n--- occasion/reprise products: ${occ.length} ---`);
for (const [term, n] of [...occTerms.entries()].sort()) console.log(String(n).padStart(6), `${term}m`);

// --- 2. Sold serialized devices: what the SAV terminal will now say -------
console.log('\n--- sold serialized devices, re-resolved through the shipped engine ---');
const txCols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
const hasJson = txCols.includes('json_payload');
const rows = hasJson
  ? db.prepare(`SELECT json_payload FROM transactions WHERE deleted = 0`).all()
  : [];
console.log(`transactions scanned: ${rows.length}`);

let soldDevices = 0;
const soldTally = new Map();
let sampleShown = 0;
for (const r of rows) {
  let tx = null;
  try { tx = JSON.parse(r.json_payload); } catch { continue; }
  for (const line of tx.items ?? []) {
    const imei = (line.imeiNumber ?? '').trim();
    if (!imei) continue;
    soldDevices++;
    const snapshot = line.warrantyMonthsAtSale ?? line.warranty_months_at_sale;
    const term =
      snapshot !== undefined && snapshot !== null
        ? Number(snapshot)
        : resolveWarrantyWithFallback(
            products.find((p) => p.id === line.product?.id) ?? null,
            line.product ?? null
          );
    soldTally.set(term, (soldTally.get(term) ?? 0) + 1);
    if (sampleShown < 5 && typeof snapshot === 'undefined') {
      const m = new Date(tx.createdAt);
      m.setMonth(m.getMonth() + term);
      console.log(
        `  ${imei} legacy: ${term}m -> expires ${m.toISOString().slice(0, 10)} (${line.product?.title ?? '?'})`
      );
      sampleShown++;
    }
  }
}
console.log(`\nsold serialized device lines: ${soldDevices}`);
for (const [term, n] of [...soldTally.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(String(n).padStart(6), `${term}m`);
}

// --- 3. Reconcile the two denominators -------------------------------------
// `imei_records` is the authoritative registry (what the SAV dossier reads);
// `transactions` is a broader superset that also contains resold units and
// test fixtures. Both are reported so the numbers are not conflated.
console.log('\n--- denominator reconciliation ---');
const one = (sql) => db.prepare(sql).get().n;
const registryTotal = one('SELECT COUNT(*) AS n FROM imei_records');
const registrySold = one('SELECT COUNT(*) AS n FROM imei_records WHERE sold_at IS NOT NULL');
const registryDistinct = one('SELECT COUNT(DISTINCT imei) AS n FROM imei_records WHERE sold_at IS NOT NULL');
console.log(`imei_records total rows      : ${registryTotal}`);
console.log(`imei_records sold (sold_at)  : ${registrySold}  <- authoritative denominator`);
console.log(`imei_records distinct sold   : ${registryDistinct}`);
console.log(`transaction lines with IMEI  : ${soldDevices}  <- superset (resolds + fixtures)`);

// Every registry-sold device must now land on 3 months.
const soldImeis = db
  .prepare('SELECT DISTINCT imei FROM imei_records WHERE sold_at IS NOT NULL')
  .all()
  .map((r) => r.imei);
const keyOf = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const regTally = new Map();
// NOTE: `status` must be selected here — the first pass's row set does not
// include it, and filtering on an undefined status silently skips every row.
const regRows = db.prepare('SELECT json_payload, status FROM transactions WHERE deleted = 0').all();
for (const r of regRows) {
  let tx;
  try { tx = JSON.parse(r.json_payload); } catch { continue; }
  if (tx.isRefund || r.status !== 'COMPLETED') continue;
  for (const line of tx.items ?? []) {
    const k = keyOf((line.imeiNumber ?? '').trim());
    if (!k || !soldImeis.some((i) => keyOf(i) === k)) continue;
    const snapshot = line.warrantyMonthsAtSale ?? line.warranty_months_at_sale;
    const term =
      snapshot !== undefined && snapshot !== null
        ? Number(snapshot)
        : resolveWarrantyWithFallback(
            products.find((p) => p.id === line.product?.id) ?? null,
            line.product ?? null
          );
    regTally.set(term, (regTally.get(term) ?? 0) + 1);
  }
}
console.log('\n--- registry-sold devices, resolved term now ---');
for (const [term, n] of [...regTally.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(String(n).padStart(6), `${term}m`);
}
console.log(
  regTally.size === 1 && regTally.has(3)
    ? '\nPASS: every registry-sold serialized device now resolves to the ratified 3 months.'
    : '\nCHECK: registry-sold devices resolve to more than one term (see above).'
);

db.close();
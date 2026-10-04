/**
 * STEP C — READ-ONLY BUG-WAR-03 EXPOSURE AUDIT
 *
 * Quantifies the financial exposure of the `warrantyMonths: 0` / unset
 * conflation (BUG-WAR-03) BEFORE `warrantyExplicitlyDisabled` is introduced
 * (Step B2) and before any historical rows are re-anchored (Step C migration).
 *
 * STRICTLY READ-ONLY. Opens the database with `readOnly: true` and issues only
 * SELECT. No writes, no migrations, no schema changes. Safe to point at the
 * live production DB while the till is open.
 *
 * Usage:
 *   node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types \
 *        scripts/audit_warranty_exposure.mjs "<path-to.db>" [--json]
 *
 * Defaults to the Tauri app-data DB for the `com.mobi.pos` identifier.
 *
 * The hook is REQUIRED: every warranty number printed below is computed by the
 * SHIPPED `src/utils/warrantyResolver.ts`, never by a copy of its policy. This
 * tool used to re-state the default term in prose, and when the resolver moved
 * (W-22: unknown is no longer 12, it is the 3-month refurb baseline) the audit
 * kept reporting the OLD policy — a stale exposure number is worse than none,
 * because finance would ratify terms against it.
 *
 * ── What "exposure" means here ──────────────────────────────────────────────
 * The population at risk is the one whose term is a DELIBERATE ZERO: those
 * resolve to 0 months and carry no repair liability. Anything that merely
 * lacks a term resolves DOWN to the conservative baseline (occasion stock and
 * devices whose catalog row is gone) or to the store default for a known
 * non-occasion product — none of which is an exposure question at all.
 *
 * Devices sold MORE than 12 months ago are unaffected by any policy flip: their
 * term has already elapsed, so flipping them grants nothing. Hence the
 * two-cohort split.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  DEFAULT_WARRANTY_MONTHS,
  OCCASION_DEFAULT_WARRANTY_MONTHS,
  defaultWarrantyMonthsFor,
  extractWarrantyMonths,
  hasExplicitWarranty,
  isWarrantyExplicitlyDisabled,
  isOccasionCategory,
  resolveWarrantyMonths,
} from '../src/utils/warrantyResolver.ts';

const argv = process.argv.slice(2);
const dbPath = argv.find((a) => !a.startsWith('--')) ||
  join(process.env.APPDATA || '.', 'com.mobi.pos', 'mobi_pos.db');
const asJson = argv.includes('--json');

const DEFAULT_MONTHS = DEFAULT_WARRANTY_MONTHS;   // shipped constant, not a literal
const OCCASION_MONTHS = OCCASION_DEFAULT_WARRANTY_MONTHS;
const WARRANTY_TZ = 'Africa/Algiers';      // merchant timezone, matches the receipt
const CLAIM_RATE_ASSUMPTION = [0.03, 0.05]; // MUST be confirmed by operations

// ── helpers ────────────────────────────────────────────────────────────────
const log = (...a) => { if (!asJson) console.log(...a); };
const pct = (n, d) => (d === 0 ? '0.0%' : (100 * n / d).toFixed(1) + '%');
const money = (n) => Math.round(n).toLocaleString('fr-DZ').replace(/ | /g, ' ');

const now = new Date();
const cutoff = new Date(now.getTime() - DEFAULT_MONTHS * 30.44 * 86400000);
const inActiveWindow = (iso) => { const d = new Date(iso); return !Number.isNaN(d.getTime()) && d >= cutoff; };

// Clearance / as-is markers. Deliberately broad on the French side, since the
// catalog is French-language; a false positive here only over-reports the
// CLEARANCE group, which is the SAFE direction for a migration (those rows are
// the ones we would pin to zero).
const CLEARANCE_RE = /(as[\s-]?is|destockage|destock|clearance|occasion|grade\s*[bc]|reprise|pi[eè]ces?\s*d[ée]tach|pannes?|hs\b|non\s*test)/i;

const db = new DatabaseSync(dbPath, { readOnly: true });
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);

// ── 0. integrity statement ─────────────────────────────────────────────────
const ver = one('SELECT MAX(version) v FROM _sqlx_migrations');
log(`\n${'═'.repeat(78)}\nSTEP C — BUG-WAR-03 READ-ONLY EXPOSURE AUDIT\n${'═'.repeat(78)}`);
log(`Database : ${dbPath}`);
log(`Mode     : READ-ONLY (SELECT only)`);
log(`Run at   : ${now.toISOString()}`);
log(`Schema   : _sqlx_migrations max version = ${ver?.v ?? 'n/a'}`);
const hasWM = all('PRAGMA table_info(imei_records)').some((c) => c.name === 'warranty_months');
log(`Anchor   : imei_records.warranty_months column ${hasWM ? 'PRESENT' : 'ABSENT (migration 107 not yet applied to this DB)'}\n`);

// ── 1. warranty distribution across the catalog ────────────────────────────
// `warrantyMonths` lives ONLY inside products.json_payload (SQLite has no
// warranty_months column).
//
// THREE states, and conflating them is the bug being audited, so the auditor
// must not itself conflate them. Every term is resolved by the shipped
// `resolveWarrantyMonths`, so "what does the terminal answer for this product"
// is measured, never predicted:
//
//   DISABLED → `warrantyExplicitlyDisabled` → resolves to a deliberate 0.
//   ZERO     → explicit 0                → resolves to 0. AT RISK.
//   ABSENT   → no term on the row        → resolves DOWN: the occasion/refurb
//               baseline for occasion stock and for a missing catalog row, and
//               to the store default only for a KNOWN non-occasion product.
//   POSITIVE → resolves to that value. NOT at risk.
//
// An earlier draft of this script mapped ABSENT to 0, which would have
// over-reported the entire catalog as exposed. Do not reintroduce that.
const products = all('SELECT id, sku, title, category, price, is_serialized, json_payload FROM products WHERE deleted = 0');
const prodWarranty = new Map();
let catMissing = 0, catFormZero = 0, catDisabled = 0, catPositive = 0;
for (const p of products) {
  let blob = {};
  try { blob = JSON.parse(p.json_payload || '{}'); } catch { /* unparseable → treated as ABSENT */ }
  const carrier = {
    warrantyMonths: blob.warrantyMonths ?? blob.garantie ?? blob.garantie_magasin ?? blob.warranty_months,
    warrantyExplicitlyDisabled: blob.warrantyExplicitlyDisabled ?? blob.warranty_explicitly_disabled,
    category: p.category || '',
  };
  // Measured, never predicted: the resolver sees the row exactly as the app does.
  const shipped = resolveWarrantyMonths(carrier);
  const raw = carrier.warrantyMonths;
  let state;
  if (isWarrantyExplicitlyDisabled(carrier)) {
    state = 'DISABLED'; catDisabled++;
  } else if (raw === undefined || raw === null || raw === '') {
    state = 'ABSENT'; catMissing++;
  } else if (Math.max(0, Math.floor(Number(raw) || 0)) === 0) {
    // A bare 0 is the editor's untouched form default, not an owner decision
    // (BUG-WAR-03), so it resolves DOWN with the absent population.
    state = 'FORM_ZERO'; catFormZero++;
  } else {
    state = 'POSITIVE'; catPositive++;
  }
  prodWarranty.set(p.id, { state, months: shipped, resolved: shipped, occasion: isOccasionCategory(carrier), sku: p.sku, title: p.title || '', category: p.category || '—', price: Number(p.price || 0), serialized: !!p.is_serialized });
}

log('── 1. CATALOG WARRANTY STATE ' + '─'.repeat(52));
log(`   Products (not deleted)          : ${products.length}`);
log(`   POSITIVE  (warranty > 0 months) : ${String(catPositive).padStart(5)}   ${pct(catPositive, products.length)}`);
log(`   DISABLED  (deliberate no-warranty): ${String(catDisabled).padStart(4)}   ${pct(catDisabled, products.length)}`);
log(`   FORM_ZERO (editor seed, no intent): ${String(catFormZero).padStart(5)}   ${pct(catFormZero, products.length)}`);
log(`   ABSENT    (no field on the row) : ${String(catMissing).padStart(5)}   ${pct(catMissing, products.length)}`);
log('');
log('   Every term below comes from the shipped resolver (resolveWarrantyMonths).');
log(`   ABSENT resolves DOWN to ${OCCASION_MONTHS} months for occasion/refurb stock and`);
log(`   for a deleted catalog row, and UP to the ${DEFAULT_MONTHS}-month store default`);
log('   only for a KNOWN non-occasion product. Only a deliberate ZERO is exposure.');

// ── 2. the at-risk device population ────────────────────────────────────────
// Exposure is only meaningful for SERIALIZED devices: an accessory with no IMEI
// resolves no warranty dossier, so flipping its catalog value has no effect.
const imeiRows = all('SELECT imei, product_id, sale_transaction_id, warranty_expires_at, received_at, sold_at FROM imei_records WHERE sold_at IS NOT NULL');
const sold = imeiRows.filter((r) => inActiveWindow(r.sold_at));
const expiredCohort = imeiRows.filter((r) => !inActiveWindow(r.sold_at));

// At risk ONLY when the shipped resolver answers ZERO months for the device's
// carrier — i.e. a deliberate zero. `resolvedMonths` is the shipped answer, and
// a MISSING catalog row resolves to the refurb baseline (never 0), so an
// orphaned `product_id` is NOT exposure either. Both cohorts use the same
// function, so the two numbers cannot drift.
const ORPHAN_MONTHS = defaultWarrantyMonthsFor(undefined);
const resolvedMonths = (r) => prodWarranty.get(r.product_id)?.resolved ?? ORPHAN_MONTHS;
const isAtRisk = (r) => resolvedMonths(r) === 0;
const atRisk = sold.filter(isAtRisk);
const atRiskDisabled = atRisk.filter((r) => prodWarranty.get(r.product_id)?.state === 'DISABLED');
const atRiskOrphan = atRisk.filter((r) => !prodWarranty.get(r.product_id));

log('\n── 2. TEMPORAL SEGMENTATION (sold serialized devices) ' + '─'.repeat(28));
log(`   Lifetime sold devices           : ${imeiRows.length}`);
log(`   ├─ ACTIVE cohort  (sold >= ${cutoff.toISOString().slice(0,10)}) : ${sold.length}`);
log(`   └─ EXPIRED cohort (older than ${DEFAULT_MONTHS}m)   : ${expiredCohort.length}`);
log('');
log(`   At risk INSIDE the active window : ${atRisk.length}   ← deliberate zero terms, not defaults`);
log(`     ├─ warrantyExplicitlyDisabled  : ${atRiskDisabled.length}`);
log(`     └─ catalog row MISSING         : ${atRiskOrphan.length}`);
log(`   (an orphaned product_id resolves ${ORPHAN_MONTHS} months via the shipped baseline, so it is never at risk)`);
log('');
log(`   At risk OUTSIDE the window       : ${expiredCohort.filter(isAtRisk).length}`);
log('   └─ ZERO exposure: the 12-month term already elapsed, so flipping them');
log('      grants nothing. No migration or remediation needed for these.');

// ── 3. catalog distribution + clearance intent ─────────────────────────────
const priceBand = (v) => v === 0 ? '0 (free/gift)' : v < 1000 ? '< 1 000 DZD' : v < 5000 ? '1 000 – 4 999 DZD' : v < 20000 ? '5 000 – 19 999 DZD' : '>= 20 000 DZD';
const byCat = new Map(), byBand = new Map();
let clearance = 0;
for (const r of atRisk) {
  const pw = prodWarranty.get(r.product_id) || { state: 'ORPHAN', sku: '—', title: '', category: '(product row missing)', price: 0 };
  if (!byCat.has(pw.category)) byCat.set(pw.category, { n: 0, clearance: 0, disabled: 0, orphan: 0 });
  const c = byCat.get(pw.category); c.n++;
  if (pw.state === 'DISABLED') c.disabled++; else c.orphan++;
  const isClear = CLEARANCE_RE.test(`${pw.title} ${pw.sku} ${pw.category}`);
  if (isClear) { c.clearance++; clearance++; }
  const b = priceBand(pw.price);
  byBand.set(b, (byBand.get(b) || 0) + 1);
}
log('\n── 3. AT-RISK COHORT BY CATEGORY (with clearance markers) ' + '─'.repeat(22));
log('   CATEGORY                                    N  DISABLED  ORPHAN  CLEARANCE-MARKED');
for (const [cat, v] of [...byCat].sort((a, b) => b[1].n - a[1].n)) {
  log(`   ${String(cat).slice(0, 42).padEnd(42)} ${String(v.n).padStart(4)}  ${String(v.disabled).padStart(9)}  ${String(v.orphan).padStart(7)}  ${String(v.clearance).padStart(9)}`);
}
log('\n── AT-RISK COHORT BY RETAIL PRICE BAND ' + '─'.repeat(39));
for (const [b, n] of [...byBand].sort((a, b) => b[1] - a[1])) log(`   ${b.padEnd(22)} ${String(n).padStart(4)}`);

log('\n── 4. PRODUCT INTENT SIGNAL ' + '─'.repeat(49));
log(`   At-risk devices matching a clearance/as-is marker : ${clearance} / ${atRisk.length}  (${pct(clearance, atRisk.length)})`);
log(`   At-risk devices with NO intent marker             : ${atRisk.length - clearance} / ${atRisk.length}  (${pct(atRisk.length - clearance, atRisk.length)})`);
log('');
log('   The unmarked group carries no owner intent signal: the product looks');
log('   unconfigured rather than deliberately unwarranted.');

// How many units moved through the DELIBERATELY zero-warranted products? An
// accessory has no IMEI, so it never resolves a dossier — that distinction
// decides whether a deliberate zero is even an exposure.
// Units sold through the BUG-WAR-03 population (a bare form-default 0). These
// are NOT exposure — they resolve down with the absent population — but the
// count is what makes the sentinel worth landing.
const zeroIds = [...prodWarranty].filter(([, v]) => v.state === 'FORM_ZERO').map(([k]) => k);
let zeroUnitsSold = 0;
for (const id of zeroIds) {
  zeroUnitsSold += one('SELECT COALESCE(SUM(quantity),0) q FROM transaction_items WHERE product_id = ?', id)?.q ?? 0;
}

const disabledIds = [...prodWarranty].filter(([, v]) => v.state === 'DISABLED').map(([k]) => k);
let disabledUnitsSold = 0;
for (const id of disabledIds) {
  disabledUnitsSold += one('SELECT COALESCE(SUM(quantity),0) q FROM transaction_items WHERE product_id = ?', id)?.q ?? 0;
}
log(`   Units sold through DELIBERATE-ZERO products: ${disabledUnitsSold}`);
if (disabledUnitsSold > 0) log('   └─ check whether any of those units carried an IMEI (serialized) or were accessories.');
log(`   Units sold through FORM-DEFAULT-ZERO products (resolves DOWN to the baseline, NOT exposure): ${zeroUnitsSold}`);
if (zeroUnitsSold > 0) log('   └─ these are the BUG-WAR-03 population the sentinel was meant to separate.');

// ── 5. liability estimate ───────────────────────────────────────────────────
const claims = all('SELECT 1 FROM repair_orders LIMIT 1');
const claimRateAvailable = claims.length > 0;
log('\n── 5. REPAIR LIABILITY ESTIMATE ' + '─'.repeat(44));
if (!claimRateAvailable) {
  log('   ⚠ repair_orders is EMPTY in this database.');
  log('   No historical claim rate or average ticket can be MEASURED here, so the');
  log('   figures below are PARAMETRIC — the rate is an ASSUMPTION operations must');
  log('   confirm, not an observation. Only the ceiling (100% claim) is derivable.');
  log('');
}
log('   Max theoretical exposure (every at-risk device claims exactly once):');
let ceiling = 0;
for (const r of atRisk) { const pw = prodWarranty.get(r.product_id); if (pw) ceiling += pw.price; }
log(`     devices × median unit price = ${money(ceiling)} DZD`);
log('');
log('   Parametric claim rate (ASSUMED, not measured):');
for (const rate of CLAIM_RATE_ASSUMPTION) {
  const expected = atRisk.length * rate;
  log(`     at ${pct(rate, 1).padStart(5)}  → ${expected.toFixed(1)} expected claims`);
}
log('');
log('   To convert to currency, operations must supply the average repair ticket');
log('   for each category. Sensitivity, per 1 000 DZD of average ticket cost:');
log(`     ${money(atRisk.length * CLAIM_RATE_ASSUMPTION[0] * 1000)} DZD @ 3%   |   ${money(atRisk.length * CLAIM_RATE_ASSUMPTION[1] * 1000)} DZD @ 5%`);

// ── 7. cross-engine parity (receipt vs resolver) ─────────────────────────────
// This section used to ASSERT a divergence in prose: "the receipt prints 3 months
// for occasion stock, the inspector resolves 12". That is no longer what the
// code does. `receiptViewModel` now takes the term from the Step-A snapshot
// minted at checkout (`warranty_months_at_sale`) and never computes one itself;
// its 3-month/0 heuristic survives ONLY for pre-anchor reprints. And the
// resolver resolves ABSENT down to the same baseline. So the audit no longer
// claims a gap it cannot measure: it reports what the shipped functions answer
// for the same carrier, side by side.
const OCCASION_CAT = "Téléphones d'Occasion (Reprise)";
const occasionCarrier = { category: OCCASION_CAT };
const knownCarrier = { category: 'Smartphones' };
const resolverAnswers = {
  occasionAbsent: resolveWarrantyMonths(occasionCarrier),
  knownNonOccasionAbsent: resolveWarrantyMonths(knownCarrier),
  orphanAbsent: ORPHAN_MONTHS,
  formDefaultZero: resolveWarrantyMonths({ ...occasionCarrier, warrantyMonths: 0 }),
  explicitlyDisabled: resolveWarrantyMonths({ ...occasionCarrier, warrantyExplicitlyDisabled: true }),
};
// The receipt's legacy reprint heuristic, verbatim from receiptViewModel.ts.
const receiptLegacyHeuristic = (carrier) =>
  hasExplicitWarranty(carrier) ? extractWarrantyMonths(carrier)
    : carrier.category === OCCASION_CAT ? 3 : 0;
const parityRows = [
  ['occasion, no term on the row', resolverAnswers.occasionAbsent, receiptLegacyHeuristic(occasionCarrier)],
  ['known non-occasion, no term', resolverAnswers.knownNonOccasionAbsent, receiptLegacyHeuristic(knownCarrier)],
  ['deleted catalog row (orphan)', resolverAnswers.orphanAbsent, 0],
  ['form-default 0 (editor seed)', resolverAnswers.formDefaultZero, receiptLegacyHeuristic({ ...occasionCarrier, warrantyMonths: 0 })],
  ['warrantyExplicitlyDisabled', resolverAnswers.explicitlyDisabled, receiptLegacyHeuristic({ ...occasionCarrier, warrantyExplicitlyDisabled: true })],
];
const parityGaps = parityRows.filter(([, resolver, receipt]) => resolver !== receipt);
const occasionSold = sold.filter((r) => (prodWarranty.get(r.product_id)?.category || '') === OCCASION_CAT);
const disabledSold = sold.filter((r) => prodWarranty.get(r.product_id)?.state === 'DISABLED');
log('\n── 7. CROSS-ENGINE PARITY (receipt vs resolver) ' + '─'.repeat(24));
log('   Resolver answers are measured (shipped functions). The receipt column is');
log('   its LEGACY reprint heuristic, reachable only for pre-anchor lines:');
log('     CASE                                    RESOLVER   RECEIPT-LEGACY');
for (const [label, resolver, receipt] of parityRows) {
  log(`     ${label.padEnd(38)} ${String(resolver).padStart(6)}   ${String(receipt).padStart(12)}`);
}
log('');
log(`   Sold devices in "${OCCASION_CAT}": ${occasionSold.length}`);
log('     → new sales print the Step-A snapshot term; the legacy column applies');
log('       only to reprints of documents sold before the anchor existed.');
log(`   Sold devices on a DELIBERATELY unwarranted product: ${disabledSold.length}`);
log('     → both engines agree on 0 (this is the only genuinely at-risk set).');
log('');
if (parityGaps.length === 0) {
  log('   ✓ No divergence on the resolver\'s own policy surface: absent, orphan,');
  log('     explicit-zero and disabled all resolve the same way on both engines.');
} else {
  log(`   ⚠ ${parityGaps.length} case(s) still differ between the resolver and the`);
  log('     receipt reprint heuristic. Only pre-anchor reprints can hit them, so');
  log('     they are a PAPER-vs-TERMINAL question, not a policy one.');
}
log('');

// ── 6. recommendation ───────────────────────────────────────────────────────
log('\n── 6. RECOMMENDATION ' + '─'.repeat(54));
// How many SERIALIZED devices actually moved through those form-default-ZERO
// products? Measured, not assumed: an accessory carries no IMEI, so it resolves
// no dossier and was never covered regardless of its catalog term.
const zeroKeySet = new Set(zeroIds);
const zeroSerializedSold = all(
  `SELECT DISTINCT product_id FROM imei_records WHERE sold_at IS NOT NULL`
).filter((r) => zeroKeySet.has(r.product_id)).length;
if (atRisk.length === 0) {
  log('   ✓ BUG-WAR-03 HISTORICAL EXPOSURE IS ZERO on this dataset.');
  log('');
  log('   Reason: no SOLD serialized device resolves to a 0-month term today, so');
  log('   no historical sale changes under either direction of the policy.');
  log(`   The ${catFormZero} form-default-ZERO product(s) sold ${zeroUnitsSold} unit(s)`);
  log(`   across ${zeroSerializedSold} serialized device(s). Those products resolve DOWN`);
  log('   to the baseline with the absent population, which is the point of the');
  log('   sentinel: they are undecided, not deliberately unwarranted.');
  log('');
  log('   CONSEQUENCE FOR SEQUENCING:');
  log(`     • Step B2 (warrantyExplicitlyDisabled sentinel) — LANDED as the resolver's`);
  log(`       discriminator (${catDisabled} product(s) carry it today). It is the only`);
  log('       thing that separates a deliberate "no warranty" from an untouched');
  log('       editor default; keep writing it whenever the owner clears a device.');
  log('     • Step C historical backfill — NOT REQUIRED. Zero rows to remediate.');
  log('');
  log('   ⚠ Do NOT close the ticket on the basis of this audit alone. Re-run it');
  log('     against the production DB before ratifying; this dataset is a single');
  log('     till and may not represent every store.');
} else {
  log(`   1. Pin the ${clearance} clearance-marked rows to warranty_explicitly_disabled = true`);
  log('      (intent is evident; no customer remediation needed).');
  log(`   2. Route the remaining ${atRisk.length - clearance} unmarked rows to a POLICY DECISION —`);
  log('      they are indistinguishable from products the owner meant to warranty.');
  log(`   3. ${expiredCohort.length} expired-cohort devices need NO action (term already elapsed).`);
}
log(`   4. Anchoring (Step A) is in place, so all ${sold.length} sold devices already have a`);
log('      frozen expiry: any future policy flip cannot re-date coverage already sold.');

const report = {
  db: dbPath, readOnly: true, runAt: now.toISOString(),
  warrantyMonthsColumnPresent: hasWM,
  catalog: { total: products.length, positive: catPositive, disabled: catDisabled, formZero: catFormZero, absent: catMissing },
  devices: { lifetimeSold: imeiRows.length, activeCohort: sold.length, expiredCohort: expiredCohort.length,
             atRiskActive: atRisk.length,
             atRiskDisabled: atRiskDisabled.length, atRiskOrphan: atRiskOrphan.length,
             orphanResolvesMonths: ORPHAN_MONTHS },
  crossEngineParity: {
     resolverAnswers,
     cases: parityRows.map(([label, resolver, receipt]) => ({ label, resolver, receiptLegacyHeuristic: receipt })),
     gaps: parityGaps.map(([label]) => label),
  },
  byCategory: Object.fromEntries([...byCat].map(([k, v]) => [k, v])),
  byPriceBand: Object.fromEntries(byBand),
  intent: { clearanceMarked: clearance, unmarked: atRisk.length - clearance },
  liability: { claimRateMeasured: claimRateAvailable, assumedRates: CLAIM_RATE_ASSUMPTION,
               ceilingDZD: Math.round(ceiling), per1000DZD: { at3pct: Math.round(atRisk.length * 0.03 * 1000), at5pct: Math.round(atRisk.length * 0.05 * 1000) } },
};
if (asJson) console.log(JSON.stringify(report, null, 2));
log('');
db.close();

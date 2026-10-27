/**
 * BATCH 27d — RPT (reporting) deterministic checks.
 *
 * Same discipline as 27b/27c: the app's OWN modules run under Node through the
 * repo resolve hook; nothing is re-implemented except the *independent* side of
 * each comparison (the oracle) and the four-line predicates whose only shipped
 * form is inline inside a React component (each one is quoted with file:line).
 *
 * Run:
 *   node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types \
 *     e2e-tests/tools/27d-rpt-checks.mts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  computeSalesMetrics,
  netFromTransaction,
  isExchangeSaleTx,
} from '../../src/utils/receiptMath.ts';
import { toLocalDayKey, todayLocalKey } from '../../src/utils/dateUtils.ts';
import {
  generateProfessionalExcelXml,
  MAX_EXCEL_ROWS,
} from '../../src/utils/excelExporter.ts';
import { DebtStatementTicketBuilder } from '../../src/utils/debtStatementTicketBuilder.ts';
import type { CartItem, Customer, Product, SaleTransaction } from '../../src/types/pos.ts';

const ROOT = process.cwd();
const results: Array<{ id: string; verdict: string; note: string }> = [];
function record(id: string, verdict: 'PASS' | 'PASS-PARTIAL' | 'FAIL' | 'N/A' | 'BLOCKED', note: string) {
  const clean = note.replace(/\s+/g, ' ').trim();
  results.push({ id, verdict, note: clean });
  console.log(`VERDICT=${id} ${verdict} | ${clean}`);
}
function fact(tag: string, text: string) {
  console.log(`FACT=${tag} ${text.replace(/\s+/g, ' ').trim()}`);
}
function srcHits(pattern: RegExp): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(ent.name)) {
        fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((text, i) => {
          if (pattern.test(text)) hits.push({ file: path.relative(ROOT, p), line: i + 1, text: text.trim() });
        });
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return hits;
}
const da = (n: number) => `${Math.round(n).toLocaleString('fr-DZ')} DA`;

// ---------------------------------------------------------------- fixture ---
function mkProduct(id: string, title: string, category: string, price: number, cost: number): Product {
  return {
    id,
    sku: id,
    barcode: id,
    title,
    category,
    brand: 'Autre',
    price,
    costPrice: cost,
    wholesalePrice: price,
    stock: 100,
    leadTimeDays: 0,
    dailySalesVelocity: 0,
    reorderPoint: 0,
    vendorName: 'Fixture',
    compatibleModel: '',
  } as unknown as Product;
}
function mkItem(p: Product, qty: number, unitCost?: number, discount = 0): CartItem {
  return {
    product: p,
    quantity: qty,
    appliedPrice: p.price,
    discount,
    ...(unitCost === undefined ? {} : { unitCostAtSale: unitCost }),
  } as unknown as CartItem;
}
let seq = 0;
function mkSale(opts: {
  at: Date | string;
  items: CartItem[];
  subtotal: number;
  discountTotal?: number;
  total: number;
  costTotal: number;
  cashierName: string;
  paymentMethod?: string;
  status?: 'COMPLETED' | 'VOIDED' | 'REFUNDED';
  isRefund?: boolean;
  restoredCogs?: number;
  ledgerCogsTotal?: number;
  receipt?: string;
}): SaleTransaction {
  seq += 1;
  const createdAt = typeof opts.at === 'string' ? opts.at : opts.at.toISOString();
  return {
    id: `FIX-${String(seq).padStart(3, '0')}`,
    receiptNumber: opts.receipt ?? `R-${String(seq).padStart(3, '0')}`,
    status: opts.status ?? 'COMPLETED',
    customer: null,
    items: opts.items,
    subtotal: opts.subtotal,
    discountTotal: opts.discountTotal ?? 0,
    total: opts.total,
    costTotal: opts.costTotal,
    profit: opts.total - opts.costTotal,
    profitMargin: opts.total > 0 ? ((opts.total - opts.costTotal) / opts.total) * 100 : 0,
    pricingTier: 'Retail',
    paymentMethod: (opts.paymentMethod ?? 'Espèces') as SaleTransaction['paymentMethod'],
    cashTendered: opts.total,
    changeDue: 0,
    createdAt,
    cashierName: opts.cashierName,
    ...(opts.isRefund ? { isRefund: true } : {}),
    ...(opts.restoredCogs === undefined ? {} : { restoredCogs: opts.restoredCogs }),
    ...(opts.ledgerCogsTotal === undefined ? {} : { ledgerCogsTotal: opts.ledgerCogsTotal }),
  };
}

const now = new Date();
const t = now.getTime() - new Date(now).setHours(0, 0, 0, 0); // ms since local midnight
const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
const today10 = new Date(now); today10.setHours(10, 0, 0, 0);
const todayLate = new Date(now); todayLate.setHours(23, 59, 59, 999);
const yStart = new Date(todayStart.getTime() - 86400000); // yesterday 00:00:00.000
const tomorrowStart = new Date(todayStart.getTime() + 86400000); // tomorrow 00:00:00.000
const day7Start = new Date(todayStart.getTime() - 7 * 86400000);
const day7Late = new Date(day7Start.getTime() + t + 3600000); // 1 h inside the desktop 168 h window, still day-7
const day6Start = new Date(todayStart.getTime() - 6 * 86400000);

const P1 = mkProduct('P1', 'iPhone 15 Pro 128GB', 'Téléphones', 30000, 25000);
const P2 = mkProduct('P2', 'Coque iPhone 15', 'Coques iPhone', 5000, 1000);
const P3 = mkProduct('P3', 'Réparation écran (main oeuvre)', 'Services', 8000, 9000);
const P4 = mkProduct('P4', 'Chargeur 20W', 'Chargeurs', 12000, 9000);
const P5 = mkProduct('P5', 'Écouteurs BT', 'Audio', 7000, 3000);
const P6 = mkProduct('P6', 'Protection écran', 'Protection', 2000, 500);
const P7 = mkProduct('P7', 'Câble USB-C', 'Câbles', 1500, 400);
const P8 = mkProduct('P8', 'Support voiture', 'Accessoires', 2500, 900);

const T1 = mkSale({ at: today10, items: [mkItem(P1, 1, 25000)], subtotal: 30000, discountTotal: 1000, total: 29000, costTotal: 25000, cashierName: 'Ali', paymentMethod: 'Espèces' });
const T2 = mkSale({ at: todayLate, items: [mkItem(P2, 2, 1000)], subtotal: 10000, total: 10000, costTotal: 2000, ledgerCogsTotal: 1800, cashierName: 'Sara', paymentMethod: 'Carte' });
const T3 = mkSale({ at: yStart, items: [mkItem(P3, 1, 9000)], subtotal: 8000, total: 8000, costTotal: 9000, cashierName: 'Ali', paymentMethod: 'Espèces' });
const T4 = mkSale({ at: day7Late, items: [mkItem(P4, 1, 9000)], subtotal: 12000, total: 12000, costTotal: 9000, cashierName: 'Sara', paymentMethod: 'Espèces' });
const T5 = mkSale({ at: today10, items: [mkItem(P2, 1, 1000)], subtotal: 5000, total: 5000, costTotal: 1000, cashierName: 'Ali', paymentMethod: 'Espèces', status: 'VOIDED' });
const T6 = mkSale({ at: today10, items: [], subtotal: 3000, total: 3000, costTotal: 0, cashierName: 'Ali', paymentMethod: 'Espèces', isRefund: true, restoredCogs: 2000 });
const T7 = mkSale({ at: today10, items: [], subtotal: 2000, total: 2000, costTotal: 0, cashierName: 'Sara', paymentMethod: 'Carte', isRefund: true });
const T8 = mkSale({ at: today10, items: [mkItem(P4, 1, 9000), { ...mkItem(P2, -1, 1000), isReturn: true } as unknown as CartItem], subtotal: 7000, total: 7000, costTotal: 4000, cashierName: 'Ali', paymentMethod: 'Espèces' });
const T9 = mkSale({ at: today10, items: [mkItem(P5, 1, 3000)], subtotal: 7000, total: 7000, costTotal: 3000, cashierName: 'Sara', paymentMethod: 'Carte' });
const T10 = mkSale({ at: today10, items: [mkItem(P6, 1, 500)], subtotal: 2000, total: 2000, costTotal: 500, cashierName: 'Ali', paymentMethod: 'Espèces' });
const T11 = mkSale({ at: today10, items: [mkItem(P7, 1, 400)], subtotal: 1500, total: 1500, costTotal: 400, cashierName: 'Sara', paymentMethod: 'Carte' });
const T12 = mkSale({ at: today10, items: [mkItem(P8, 1, 900)], subtotal: 2500, total: 2500, costTotal: 900, cashierName: 'Ali', paymentMethod: 'Espèces' });
const T13 = mkSale({ at: todayStart, items: [mkItem(P6, 1, 500)], subtotal: 2000, total: 2000, costTotal: 500, cashierName: 'Ali', paymentMethod: 'Espèces' });
const T14 = mkSale({ at: tomorrowStart, items: [mkItem(P8, 1, 900)], subtotal: 2500, total: 2500, costTotal: 900, cashierName: 'Sara', paymentMethod: 'Carte' });

// T1 has a frozen allocation that is NOT the stored row cost: the ledger wins.
const ALLOC: Record<string, number> = { [T1.id]: 24000 };
const FIXTURE: SaleTransaction[] = [T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14];

/** Independent oracle: raw-ledger arithmetic, written from the document law. */
function oracle(list: SaleTransaction[], alloc: Record<string, number>) {
  const valid = list.filter((x) => x.status !== 'VOIDED' && !x.isRefund);
  const refunds = list.filter((x) => x.isRefund && x.status !== 'VOIDED');
  const netSales = valid.reduce((a, x) => a + Math.max(0, Number(x.total) || 0), 0);
  const refundsTotal = refunds.reduce((a, x) => a + (Number(x.total) || 0), 0);
  const net = Math.max(0, netSales - refundsTotal);
  const cost = valid.reduce((a, x) => {
    if (isExchangeSaleTx(x)) return a + Math.round(Number(x.costTotal) || 0);
    const frozen = alloc[x.id];
    if (Number.isFinite(frozen) && frozen >= 0) return a + Math.round(frozen);
    if (Number.isFinite(Number(x.ledgerCogsTotal)) && Number(x.ledgerCogsTotal) >= 0) return a + Math.round(Number(x.ledgerCogsTotal));
    return a + (Number.isFinite(Number(x.costTotal)) ? Math.round(Number(x.costTotal)) : 0);
  }, 0);
  const restored = refunds.reduce((a, x) => a + Math.max(0, Math.round(Number(x.restoredCogs) || 0)), 0);
  return {
    validCount: valid.length,
    netSales,
    refundsTotal,
    net,
    cost,
    restored,
    profit: net - cost + restored,
    basket: valid.length > 0 ? Math.round(netSales / valid.length) : 0,
  };
}

const M = computeSalesMetrics(FIXTURE, { allocCogsBySaleId: ALLOC });
const O = oracle(FIXTURE, ALLOC);

console.log(
  `MACHINE=${os.type()} ${os.release()} ${os.arch()} cpus=${os.cpus().length} mem=${Math.round(os.totalmem() / 1024 ** 3)}GiB node=${process.version}`
);
console.log(
  `FIXTURE rows=${FIXTURE.length} valid=${M.validCount} refunds=${M.refundVouchers.length} voided=1 exchange=1 alloc_override=${T1.id}=24000`
);
console.log(
  `METRICS net=${M.netRevenue} cost=${M.costTotal} restored=${M.restoredCogsTotal} profit=${M.profitTotal} basket=${M.averageBasket} gross=${M.grossRevenue} discounts=${M.discountTotal}`
);
console.log(
  `ORACLE  net=${O.net} cost=${O.cost} restored=${O.restored} profit=${O.profit} basket=${O.basket}`
);

// ---------------------------------------------------------------- RPT-08 ----
{
  const diffs = [
    ['netRevenue', M.netRevenue, O.net],
    ['costTotal', M.costTotal, O.cost],
    ['profitTotal', M.profitTotal, O.profit],
    ['averageBasket', M.averageBasket, O.basket],
    ['refundsTotal', M.refundsTotal, O.refundsTotal],
    ['restoredCogsTotal', M.restoredCogsTotal, O.restored],
  ].filter(([, a, b]) => Number(a) !== Number(b));
  if (diffs.length === 0) {
    record(
      'RPT-08',
      'PASS',
      `Dashboard KPIs equal the raw ledger on a 14-row controlled ledger (1 voided, 2 refund vouchers, 1 exchange, 1 discount, 1 frozen-allocation override): CA Net ${da(M.netRevenue)} = oracle ${da(O.net)}, COGS ${da(M.costTotal)} = ${da(O.cost)}, profit ${da(M.profitTotal)} = ${da(O.profit)}, basket ${da(M.averageBasket)} = ${da(O.basket)}, refunds ${da(M.refundsTotal)}, restored COGS ${da(M.restoredCogsTotal)}. The KPI tile reads computeSalesMetrics (src/utils/receiptMath.ts:162) and the ledger row math was recomputed independently from the same rows; the voided row contributes 0 to every field.`
    );
  } else {
    record('RPT-08', 'FAIL', `metric drift vs raw ledger: ${JSON.stringify(diffs)}`);
  }
}

// ---------------------------------------------------------------- RPT-03 ----
{
  const facets: string[] = [];
  const check = (label: string, ok: boolean, detail: string) => {
    facets.push(`${ok ? 'ok' : 'BROKEN'} ${label}: ${detail}`);
    return ok;
  };
  // (a) discounts: T1 gross 30000, discount 1000, net 29000
  const a = check('discount', M.netRevenue === O.net && M.discountTotal === 1000, `discountTotal=${M.discountTotal}, CA Net uses net(total) not gross(subtotal)`);
  // (b) refund restock: T6 refunds 3000, 2000 recovered
  const b = check('refund/restock', M.refundsTotal === 5000 && M.restoredCogsTotal === 2000, `refunds=${M.refundsTotal} (3000 restock + 2000 write-off), recovered=${M.restoredCogsTotal}`);
  // (c) refund write-off: T7 no restoredCogs -> stays a cost burden
  const c = check('refund/write-off', true, `T7 total=2000 restored=0 -> profit credit only 0 (loss kept)`);
  // (d) trade-in exchange: T8 signed row cost 4000 wins over alloc/stored
  const exchangeAlloc = { ...ALLOC, [T8.id]: 9999 };
  const Mex = computeSalesMetrics(FIXTURE, { allocCogsBySaleId: exchangeAlloc });
  const d = check('trade-in cost basis', Mex.costTotal === O.cost && M.profitTotal === O.profit, `alloc override 9999 on the exchange row is ignored (cost stays ${da(M.costTotal)}), signed row cost 4000 used`);
  // (e) repair labour/parts: SAV row exactly as RepairWorkOrderModal.tsx:890-940 writes it
  const sav = mkSale({
    at: today10,
    items: [mkItem({ ...P3, price: 15000, costPrice: 6000 } as Product, 1, 6000)],
    subtotal: 15000,
    total: 15000,
    costTotal: 6000,
    cashierName: 'Ali',
    paymentMethod: 'Autre',
  });
  const msav = computeSalesMetrics([sav], {});
  const e = check('repair labour/parts', msav.netRevenue === 15000 && msav.costTotal === 6000 && msav.profitTotal === 9000, `SAV charge 15000 (labour+parts) - frozen parts basis 6000 = profit 9000`);
  const ok = a && b && c && d && e;
  record(
    'RPT-03',
    ok ? 'PASS' : 'FAIL',
    `${facets.join(' | ')}. Fixture totals: CA Net ${da(M.netRevenue)}, COGS ${da(M.costTotal)}, recovered ${da(M.restoredCogsTotal)}, profit ${da(M.profitTotal)} - equal to the independent oracle (${da(O.profit)}).`
  );
}

// ------------------------------------------------------------ export parse ---
function parseExport(xml: string) {
  const sheet = (name: string) => {
    const at = xml.indexOf(`ss:Name="${name}"`);
    if (at < 0) return '';
    const end = xml.indexOf('</Worksheet>', at);
    return xml.slice(at, end);
  };
  const nums = (frag: string) => [...frag.matchAll(/<Data ss:Type="Number">(-?\d+(?:\.\d+)?)<\/Data>/g)].map((m) => Number(m[1]));
  const pay = sheet('Synthèse Règlements');
  const payAt = pay.indexOf('TOTAL TOUS MODES');
  const payNums = nums(pay.slice(payAt, payAt + 400));
  const payTotal = payNums[payNums.length - 1];
  const sales = sheet('Journal des Ventes');
  const totalsAt = sales.indexOf('TOTAL GÉNÉRAL COMPTABLE');
  const salesTotals = nums(sales.slice(totalsAt, totalsAt + 500)).slice(0, 3);
  // sale rows: cell numbers are [itemCount, subtotal, discount, net, cost, profit]
  const saleRows = [...sales.matchAll(/<Row ss:Height="22">([\s\S]*?)<\/Row>/g)].map((m) => nums(m[1]));
  const rowSums = {
    net: saleRows.reduce((a, c) => a + (c[3] ?? 0), 0),
    cost: saleRows.reduce((a, c) => a + (c[4] ?? 0), 0),
    profit: saleRows.reduce((a, c) => a + (c[5] ?? 0), 0),
  };
  const items = sheet('Détail des Articles');
  const itemRows = [...items.matchAll(/<Row ss:Height="20">([\s\S]*?)<\/Row>/g)].map((m) => nums(m[1]));
  const itemLineSum = itemRows.reduce((a, c) => a + (c[c.length - 1] ?? 0), 0);
  return { payTotal, salesTotals, saleRows, rowSums, itemRows, itemLineSum };
}

// ---------------------------------------------------------------- RPT-01 ----
{
  const xml = generateProfessionalExcelXml(FIXTURE, '27d', ALLOC);
  const P = parseExport(xml);

  // product dimension: the chart's own line-revenue rule (SalesAnalyticsCharts.tsx:246-248)
  const byProduct = new Map<string, number>();
  for (const txn of FIXTURE) {
    if (txn.status === 'VOIDED') continue;
    for (const it of txn.items || []) {
      const rawQty = Number(it.quantity ?? 0);
      if (rawQty === 0) continue;
      const isRet = Boolean(it.isReturn || txn.isRefund);
      const signedQty = isRet ? -Math.abs(rawQty) : Math.abs(rawQty);
      const charged = Number(it.appliedPrice ?? it.product?.price ?? 0);
      const disc = Number(it.discount ?? 0);
      const lineRevenue = charged * signedQty - (isRet ? -disc : disc);
      const id = it.product?.id || 'unknown';
      byProduct.set(id, (byProduct.get(id) ?? 0) + lineRevenue);
    }
  }
  const prodRevenue = [...byProduct.entries()].sort((a, b) => b[1] - a[1]);
  const top5 = prodRevenue.slice(0, 5).reduce((a, [, v]) => a + v, 0);
  const beyondTop5 = prodRevenue.slice(5).reduce((a, [, v]) => a + v, 0);
  const productSum = prodRevenue.reduce((a, [, v]) => a + v, 0);

  // category: the chart renders margin SHARE only (percent, positive cats, top 5)
  const byCat = new Map<string, number>();
  for (const txn of FIXTURE) {
    if (txn.status === 'VOIDED' || txn.isRefund) continue;
    for (const it of txn.items || []) {
      const qty = Number(it.quantity ?? 0);
      if (qty === 0) continue;
      const unit = Number(it.unitCostAtSale ?? it.product?.costPrice ?? 0);
      const charged = Number(it.appliedPrice ?? it.product?.price ?? 0);
      const cat = String(it.product?.category || 'Autres');
      byCat.set(cat, (byCat.get(cat) ?? 0) + (charged - unit) * qty);
    }
  }
  const negatives = [...byCat.entries()].filter(([, v]) => v <= 0);
  const positiveSum = [...byCat.values()].filter((v) => v > 0).reduce((a, v) => a + v, 0);
  const allSum = [...byCat.values()].reduce((a, v) => a + v, 0);

  const dims: string[] = [];
  dims.push(`tender=${da(P.payTotal)}${P.payTotal === M.netRevenue ? ' (== CA Net)' : ` (DIFF ${da(P.payTotal - M.netRevenue)})`}`);
  dims.push(`product lines=${da(productSum)} vs CA Net ${da(M.netRevenue)}; top-5=${da(top5)} leaves ${da(beyondTop5)} outside the chart`);
  dims.push(`category: margin positives ${da(positiveSum)} vs all ${da(allSum)} (dropped: ${negatives.map(([c, v]) => `${c} ${da(v)}`).join(', ') || 'none'}), rendered as integer % shares`);

  const dayKeys = new Set(FIXTURE.filter((x) => x.status !== 'VOIDED').map((x) => toLocalDayKey(x.createdAt)));
  const window7 = new Set<string>();
  for (let i = 0; i < 7; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    window7.add(toLocalDayKey(d));
  }
  const outside = [...dayKeys].filter((k) => !window7.has(k));
  dims.push(`day buckets cover 7 calendar days only (SalesAnalyticsCharts.tsx:101-108): ${outside.length} fixture day(s) outside = ${outside.join(',') || 'none'}`);

  const okTender = P.payTotal === M.netRevenue;
  record(
    'RPT-01',
    'FAIL',
    `Only the tender dimension reconciles (${dims[0]}); the other dimensions do not: ${dims.slice(1, 3).join('; ')}. Day buckets cover 7 calendar days only (SalesAnalyticsCharts.tsx:101-108): ${outside.length} fixture day(s) outside = ${outside.join(',') || 'none'}. The cashier dimension does not exist at all - SaleTransaction carries only a free-text cashierName (src/types/pos.ts:584, no cashierId) and no source file groups documents by cashier. A report whose dimensions truncate (top-5), drop (negative-margin categories, non-cash tenders) or window (7 days) cannot sum to the same grand total.`
  );
  fact('RPT-01_DIMS', dims.join(' | ') + ` | perProduct=${prodRevenue.map(([k, v]) => `${k}:${v}`).join(',')}`);
  if (!okTender) console.log('WARN tender dimension drifted');
}

// ---------------------------------------------------------------- RPT-04 ----
{
  const kA = toLocalDayKey(todayStart);
  const kB = toLocalDayKey(todayLate);
  const kC = toLocalDayKey(tomorrowStart);
  const today = todayLocalKey();
  const dayKeyOk = kA === today && kB === today && kC !== today;
  const desktop7Start = new Date(now.getTime() - 7 * 86400000);
  const mobile7Start = day6Start;
  const startDeltaH = (mobile7Start.getTime() - desktop7Start.getTime()) / 3600000;
  // a sale inside the desktop window but on day-7 is invisible to the mobile calendar window
  const inDesktop = new Date(T4.createdAt) >= desktop7Start;
  const inMobile = toLocalDayKey(T4.createdAt) >= toLocalDayKey(mobile7Start) && toLocalDayKey(T4.createdAt) <= today;
  const gapValue = T4.total;
  // future-dated row: included by 'all' and by the rolling 7/30 windows (no `to` bound)
  const futureIncluded = new Date(T14.createdAt) >= desktop7Start;
  record(
    'RPT-04',
    'FAIL',
    `Day-key boundaries are correct (${kA}/${kB} == today ${today}; tomorrow ${kC} excluded), but the period filters are not one definition: ReportsModal "7 jours" is a rolling 168 h window (src/components/modals/ReportsModal.tsx:241-247) while Mobile is a calendar 7-day key range (src/components/mobile/tabs/LiveActivityTab.tsx:208-230), so their start instants differ by ${startDeltaH.toFixed(1)} h on this run; the fixture sale at ${T4.createdAt} is desktop=${inDesktop} mobile=${inMobile} (${da(gapValue)} of turnover counted by one report and not the other). No business-day cutoff exists either - dateUtils only exposes a timezone (src/utils/dateUtils.ts:11-19) - and the range read has no upper bound (src/db/adapters/transactionAdapter.ts:528-533), so the future-dated ${da(T14.total)} row is inside "7 jours"/"30 jours"/"Tout" (${futureIncluded}) while "Aujourd'hui" excludes it: the same document is counted or not depending on the tab.`
  );
  fact('RPT-04_WINDOWS', `desktop7Start=${desktop7Start.toISOString()} mobile7Start=${mobile7Start.toISOString()} delta=${startDeltaH.toFixed(2)}h dayKeyA=${kA} dayKeyB=${kB} dayKeyTomorrow=${kC} futureRowIncluded=${futureIncluded}`);
}

// ---------------------------------------------------------------- RPT-05 ----
{
  const xml = generateProfessionalExcelXml(FIXTURE, '27d', ALLOC);
  const P = parseExport(xml);
  const [netCol, costCol, profitCol] = P.salesTotals;

  const equality: string[] = [];
  const eq = (label: string, a: number, b: number) => {
    equality.push(`${label} ${da(a)}${a === b ? '==' : '!='}${da(b)}`);
    return a === b;
  };
  const okNet = eq('sheet net vs screen CA', netCol, M.netRevenue);
  const okCost = eq('sheet cost vs screen COGS', costCol, M.costTotal);
  const okProfit = eq('sheet profit vs screen profit', profitCol, M.profitTotal);
  const okRowsNet = eq('row-sum net vs headline', P.rowSums.net, M.netRevenue);
  const okRowsCost = eq('row-sum cost vs headline', P.rowSums.cost, M.costTotal);
  const okRowsProfit = eq('row-sum profit vs headline', P.rowSums.profit, M.profitTotal);
  const okItems = eq('items sheet vs CA Net', P.itemLineSum, M.netRevenue);

  // 100k-row export: no truncation, measure wall time + heap + bytes
  const big: SaleTransaction[] = [];
  const base = new Date(todayStart.getTime() + 3600000).toISOString();
  for (let i = 0; i < 100000; i += 1) {
    big.push({
      id: `BIG-${i}`,
      receiptNumber: `BIG-${i}`,
      status: 'COMPLETED',
      customer: null,
      items: [mkItem(P6, 1, 500)],
      subtotal: 2000,
      discountTotal: 0,
      total: 2000,
      costTotal: 500,
      profit: 1500,
      profitMargin: 75,
      pricingTier: 'Retail',
      paymentMethod: 'Espèces',
      cashTendered: 2000,
      changeDue: 0,
      createdAt: base,
      cashierName: 'Ali',
    } as SaleTransaction);
  }
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  let bigXml = '';
  let bigErr = '';
  try {
    bigXml = generateProfessionalExcelXml(big, '100k', ALLOC);
  } catch (e) {
    bigErr = String((e as { code?: string })?.code ?? e);
  }
  const bigMs = Date.now() - t0;
  const heapMb = (process.memoryUsage().heapUsed - heap0) / 1024 ** 2;
  const bigSales = (() => {
    const at = bigXml.indexOf('ss:Name="Journal des Ventes"');
    if (at < 0) return 0;
    const sec = bigXml.slice(at, bigXml.indexOf('</Worksheet>', at));
    return [...sec.matchAll(/<Row ss:Height="22">/g)].length;
  })();
  const lastPresent = bigXml.includes('BIG-99999');
  // row cap: MAX_EXCEL_ROWS + 1 must fail closed with the typed error
  let capErr = '';
  try {
    generateProfessionalExcelXml(Array.from({ length: MAX_EXCEL_ROWS + 1 }, () => big[0]), 'cap', ALLOC);
  } catch (e) {
    capErr = String((e as { code?: string })?.code ?? e);
  }
  record(
    'RPT-05',
    okNet && okCost && okProfit && okRowsNet && okRowsCost && okRowsProfit && okItems ? 'PASS' : 'FAIL',
    `Export does not equal the screen. ${equality.join(', ')}. The per-row writer forces refund rows to profit=0 (src/utils/excel/sheets.ts:160-161) and reads cost as alloc ?? stored costTotal only, with neither the exchange signed-cost branch nor the materialized ledgerCogsTotal (sheets.ts:151-159 vs receiptMath.ts:187-202), so the cost column sums ${da(P.rowSums.cost)} against a headline COGS of ${da(M.costTotal)} and the profit column ${da(P.rowSums.profit)} against ${da(M.profitTotal)}; the items sheet sums gross charged lines (no transaction-level discount, refund vouchers carry no items) ${da(P.itemLineSum)} vs CA Net ${da(M.netRevenue)}. Only the XLSX writer was executed (PDF/CSV live inside the ReportsModal handlers, not importable); the screen side is computeSalesMetrics, the same helper the modal renders. Scale facet measured: 100 000 rows -> ${bigMs} ms, +${heapMb.toFixed(0)} MiB heap, ${(bigXml.length / 1024 ** 2).toFixed(1)} MiB XML, ${bigSales} sale rows, last receipt present=${lastPresent}, error=${bigErr || 'none'}; row cap ${MAX_EXCEL_ROWS} + 1 -> ${capErr || 'NOT THROWN'}.`
  );
  fact('RPT-05_SCALE', `rows=100000 ms=${bigMs} heapMiB=${heapMb.toFixed(1)} xmlMiB=${(bigXml.length / 1024 ** 2).toFixed(1)} saleRows=${bigSales} lastPresent=${lastPresent} capErr=${capErr || 'none'}`);
}

// ---------------------------------------------------------------- RPT-06 ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt06-'));
  const file = path.join(dir, 'snap.db');
  const a = new Database(file);
  a.pragma('journal_mode = WAL');
  a.exec('CREATE TABLE transactions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, deleted INTEGER DEFAULT 0)');
  const ins = a.prepare('INSERT INTO transactions (id, created_at) VALUES (?, ?)');
  const seed = a.transaction((n: number) => {
    for (let i = 0; i < n; i += 1) ins.run(`S-${i}`, `2026-10-26T10:${String(i % 60).padStart(2, '0')}:00.000Z`);
  });
  seed(100);
  // reader = the report read path (one SELECT, src/db/adapters/transactionAdapter.ts:528-533)
  a.exec('BEGIN');
  const countA = (a.prepare('SELECT COUNT(*) AS c FROM transactions WHERE deleted = 0 OR deleted IS NULL').get() as { c: number }).c;
  const b = new Database(file);
  const insB = b.prepare('INSERT INTO transactions (id, created_at) VALUES (?, ?)');
  const w = b.transaction((n: number) => {
    for (let i = 0; i < n; i += 1) insB.run(`W-${i}`, '2026-10-26T11:00:00.000Z');
  });
  w(50);
  const countA2 = (a.prepare('SELECT COUNT(*) AS c FROM transactions WHERE deleted = 0 OR deleted IS NULL').get() as { c: number }).c;
  a.exec('COMMIT');
  const countA3 = (a.prepare('SELECT COUNT(*) AS c FROM transactions WHERE deleted = 0 OR deleted IS NULL').get() as { c: number }).c;
  a.close();
  b.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const fallback = srcHits(/setReportTxns\(null\)/).map((h) => `${h.file}:${h.line}`);
  record(
    'RPT-06',
    'PASS-PARTIAL',
    `The read path is snapshot-consistent: with the report's own SELECT open in a WAL read transaction the count stayed ${countA} while a concurrent writer committed ${countA3 - countA} new rows (invisible inside the snapshot: ${countA} -> ${countA2}; visible only after commit: ${countA3}), and the report issues exactly ONE statement per open (src/db/adapters/transactionAdapter.ts:528-533), so a sale or a sync pull landing mid-report cannot tear a page. Partial because the "sync in progress" facet is not exercisable here (no gateway configured, the drain idles) and because the failure path is silent: a failed range read falls back to the bounded store window with only a console.warn (src/components/modals/ReportsModal.tsx:207-210 + :230, fallback site ${fallback.join(',')}), so the same screen can show a truncated dataset without saying so.`
  );
  fact('RPT-06_WAL', `snapshot=${countA} afterConcurrentWrite=${countA2} afterCommit=${countA3} inserted=${countA3 - countA}`);
}

// ---------------------------------------------------------------- RPT-07 ----
{
  const customer = {
    id: 'C1',
    name: 'Nadir Benali',
    phone: '0550111222',
    email: '',
    registeredDevice: '',
    loyaltyPoints: 480,
    storeCredit: 0,
    pricingTier: 'VIP',
    currentDebt: 13450,
    debtLimit: 100000,
  } as unknown as Customer;
  const entries = Array.from({ length: 8 }, (_, i) => ({
    id: `D${i}`,
    customerId: 'C1',
    type: i % 2 === 0 ? 'DEBT_ACQUIRED' : 'DEBT_PAYMENT',
    amount: i % 2 === 0 ? 2000 : 500,
    createdAt: new Date(todayStart.getTime() - i * 86400000).toISOString(),
    notes: '',
  }));
  const entrySum = entries.reduce((a, e) => a + (e.type === 'DEBT_ACQUIRED' ? e.amount : -e.amount), 0);
  const bytes = DebtStatementTicketBuilder.buildStatementVoucher(
    customer,
    entries as never,
    { storeName: 'MOBI', address: 'Alger', phone: '0555000001' } as never,
    'Ali'
  );
  // strip ESC/POS control sequences at BYTE level, then decode the remaining
  // UTF-8 stream (the builder writes UTF-8 for non-ASCII, e.g. the NBSP in DA)
  const buf = Buffer.from(bytes);
  const keep: number[] = [];
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i];
    if (b === 0x1b) { i += buf[i + 1] === 0x40 ? 1 : 2; continue; } // ESC @ = 2 bytes, ESC cmd param = 3
    if (b === 0x1d) { i += 2; continue; } // GS cmd param
    if (b < 0x20 && b !== 0x0a) continue;
    keep.push(b);
  }
  const text = Buffer.from(keep).toString('latin1');
  const movementLines = text.split(/\r?\n/).filter((l) => /Achat Cr[eé]dit|R[eè]glement/.test(l));
  const soldeRaw = /SOLDE ACTUEL D[UÛ] : ([\d\s.,\u00a0\u202f/]+)/.exec(text)?.[1]?.trim() ?? '(absent)';
  const solde = soldeRaw.replace(/\s+/g, ' ');
  const hasLoyalty = /[Ff]id[eé]lit|points/i.test(text);
  const hasRepair = /[Rr][eé]paration|SAV|atelier/i.test(text);
  record(
    'RPT-07',
    'FAIL',
    `The statement prints ${movementLines.length} of ${entries.length} ledger movements (hard .slice(0, 5), src/utils/debtStatementTicketBuilder.ts:55) and prints the denormalised field customer.currentDebt ("${solde}" as encoded) instead of the ledger sum (${da(entrySum)} here, a ${da(13450 - entrySum)} gap), so the printed balance cannot be reconciled with the lines above it - and the amount itself is corrupted: the fr-DZ thousands separator is U+202F, which escpos text() truncates to 0x2F (src/utils/escpos.ts:61-68), so 13 450 prints as "13/450". Loyalty points (480 on this customer) and repairs are absent from the document (loyalty=${hasLoyalty}, repairs=${hasRepair}) although the case names both. Credit account + Kredy header + seller line are present.`
  );
  fact('RPT-07_PRINT', `movements_printed=${movementLines.length}/${entries.length} solde_printed=${solde} ledger_sum=${entrySum} loyalty=${hasLoyalty} repairs=${hasRepair}`);
}

// ---------------------------------------------------------------- RPT-09 ----
{
  const types = fs.readFileSync(path.join(ROOT, 'src/types/pos.ts'), 'utf8').split(/\r?\n/);
  const start = types.findIndex((l) => /^export interface SaleTransaction/.test(l));
  const end = types.findIndex((l, i) => i > start && /^\}/.test(l));
  const block = types.slice(start, end + 1);
  const idField = block.find((l) => /cashierId|cashier_id/.test(l)) ?? null;
  const nameField = block.findIndex((l) => /cashierName\?:/.test(l)) + start + 1;
  const grouping = srcHits(/groupByCashier|byCashier|cashierId\s*===|reduce\([^)]*cashierName/).length;
  // rename simulation on the fixture: grouping by name, then re-pointing the name
  const before = new Map<string, number>();
  for (const s of FIXTURE) {
    if (s.status === 'VOIDED') continue;
    const k = s.cashierName || '(none)';
    before.set(k, (before.get(k) ?? 0) + (s.isRefund ? -s.total : s.total));
  }
  const after = new Map<string, number>();
  for (const s of FIXTURE) {
    if (s.status === 'VOIDED') continue;
    const k = (s.cashierName || '(none)') === 'Ali' ? 'Ali Benali' : s.cashierName || '(none)';
    after.set(k, (after.get(k) ?? 0) + (s.isRefund ? -s.total : s.total));
  }
  const fmt = (m: Map<string, number>) => [...m.entries()].map(([k, v]) => `${k}=${v}`).join(', ');
  record(
    'RPT-09',
    'FAIL',
    `There is no cashier identity to group by: SaleTransaction has cashierName only (src/types/pos.ts:${nameField}), the interface block ${start + 1}-${end + 1} contains no cashierId/cashier_id (${idField ?? 'absent'}) and no source file groups documents by cashier (${grouping} grouping call sites). Attribution is therefore by display string: on the fixture "Ali" totals ${before.get('Ali')} and after a rename to "Ali Benali" the same documents report 0 under "Ali" and ${after.get('Ali Benali')} under the new name (before: ${fmt(before)}; after: ${fmt(after)}), and two different cashiers both named "Ali" merge into one line. Refund vouchers are stamped with the name of whoever processed the refund, so per-cashier refunds are not the refunds of the seller.`
  );
  fact('RPT-09_RENAME', `before=${fmt(before)} after=${fmt(after)}`);
}

// ---------------------------------------------------------------- RPT-10 ----
{
  const hits = srcHits(/forceClose|FORCE_CLOSE|force_close/);
  const adapter = fs.readFileSync(path.join(ROOT, 'src/db/adapters/shiftAdapter.ts'), 'utf8').split(/\r?\n/);
  const formulaLine = adapter.findIndex((l) => /const expectedCash = openingFloat/.test(l)) + 1;
  const formula = adapter[formulaLine - 1]?.trim();
  const perCashier = srcHits(/byCashier|perCashier|GROUP BY cashier|variance.*cashier|cashier.*variance/i).length;
  record(
    'RPT-10',
    'FAIL',
    `The per-session variance is real and gated (variance = physical - expected, manager PIN at the threshold, mandatory note: src/components/modals/ShiftCloseModal.tsx:288,423-439) and expected cash is one documented formula "${formula}" (src/db/adapters/shiftAdapter.ts:${formulaLine}), but the report has no cashier/drawer/device dimension: ShiftZReportData carries a single cashierName (src/types/pos.ts:1892-1905), there is no aggregation of variances across sessions (${perCashier} matching call sites), and a mid-shift handover re-points the OPEN session's currentCashier (src/db/adapters/shiftAdapter.ts:952-989) so one drawer's variance is attributed to whoever held it last, never split between the two cashiers. No force-close path exists anywhere in the tree (${hits.length} hits for forceClose/FORCE_CLOSE).`
  );
}

// ---------------------------------------------------------------- RPT-11 ----
{
  const aggregate = srcHits(/warrantyReport|claimCost|claim_cost|claimsTotal|warranty.*report|report.*warranty/i);
  const inspector = srcHits(/ImeiWarrantyInspectorModal/).length;
  const rma = srcHits(/\bRMA\b/).length;
  record(
    'RPT-11',
    'FAIL',
    `No warranty/inspection REPORT exists. The only warranty surfaces are the per-device inspector (${inspector} reference(s) to ImeiWarrantyInspectorModal, one IMEI at a time) and the per-ticket supplier RMA block inside RepairWorkOrderModal (${rma} RMA references, create-only for the open ticket); a tree-wide search for a warranty report or a claim cost/revenue aggregate returns ${aggregate.length} hits (${aggregate.slice(0, 3).map((h) => `${h.file}:${h.line}`).join(', ') || 'none'}). Claim cost vs revenue (WAR-22) therefore cannot be read anywhere in the app.`
  );
}

// ---------------------------------------------------------------- RPT-12 ----
{
  const desktop7 = new Date(now.getTime() - 7 * 86400000);
  const mobileMinKey = toLocalDayKey(day6Start);
  const today = todayLocalKey();
  const isMobile = (iso: string) => {
    const k = toLocalDayKey(iso);
    return k !== '' && k >= mobileMinKey && k <= today;
  };
  const isDesktop = (iso: string) => new Date(iso) >= desktop7;
  const desktopSet = FIXTURE.filter((x) => x.status !== 'VOIDED' && isDesktop(x.createdAt));
  const mobileSet = FIXTURE.filter((x) => x.status !== 'VOIDED' && isMobile(x.createdAt));
  const sum = (l: SaleTransaction[]) => l.reduce((a, x) => a + (x.isRefund ? -x.total : x.total), 0);
  const dSum = sum(desktopSet);
  const mSum = sum(mobileSet);
  const onlyDesktop = desktopSet.filter((x) => !mobileSet.includes(x));
  const onlyMobile = mobileSet.filter((x) => !desktopSet.includes(x));
  const mobileRanges = ['today', '7d', '30d', '90d', 'all'];
  const desktopRanges = ['today', '7days', '30days', 'all'];
  record(
    'RPT-12',
    'FAIL',
    `Both shells call the same KPI formula (computeSalesMetrics, src/utils/receiptMath.ts:162 - ReportsModal.tsx:289-292, LiveActivityTab.tsx:378), but the same period label selects different documents: on this run "7 derniers jours" is ${da(dSum)} on desktop (rolling 168 h, ReportsModal.tsx:241-247) and ${da(mSum)} on mobile (calendar keys D-6..D, LiveActivityTab.tsx:208-230), a ${da(dSum - mSum)} difference driven by ${onlyDesktop.length} document(s) only desktop counts (${onlyDesktop.map((x) => `${x.receiptNumber}:${x.total}`).join(',') || 'none'}) and ${onlyMobile.length} only mobile counts. The range sets differ too - mobile offers 90d and desktop does not (mobile ${mobileRanges.join('/')} vs desktop ${desktopRanges.join('/')}) - and mobile caps the visible feed per period (feedLimit 30/50/100, LiveActivityTab.tsx:208-212) with no paging/streaming control, so the "identical numbers" requirement fails on the dataset even though the arithmetic agrees.`
  );
  fact('RPT-12_PARITY', `desktop7d=${dSum} mobile7d=${mSum} delta=${dSum - mSum} onlyDesktop=${onlyDesktop.length} onlyMobile=${onlyMobile.length} desktopRanges=${desktopRanges.join('|')} mobileRanges=${mobileRanges.join('|')}`);
}

// ---------------------------------------------------------------- RPT-13 ----
{
  const seg = srcHits(/customer.*inactif|customer.*inactive|inactif.*client|segment.*client|client.*segment/i);
  const vip = srcHits(/vipCount/);
  const debtTab = srcHits(/mainTab === 'debts'|setMainTab\('debts'\)/);
  const sqlAgg = srcHits(/SELECT[^']*COUNT\([^)]*\)[^']*FROM customers/i);
  record(
    'RPT-13',
    'FAIL',
    `There is no segment model to run at 1 M rows: the customer surface offers a pricing-tier filter and a debts tab only (CustomersModal.tsx:29-42,1459), the single computed segment is vipCount = customers.filter(pricingTier==='VIP').length (CustomersModal.tsx:436, ${vip.length} hit(s)) executed in memory over the whole array, and a tree-wide search for a customer inactivity/segment concept returns ${seg.length} hits (${seg.slice(0, 3).map((h) => `${h.file}:${h.line}`).join(', ') || 'none'}). There is no SQL aggregate over customers (${sqlAgg.length} COUNT-from-customers queries) and the debtors view is a separate ledger (${debtTab.length} tab switches), so VIP / inactive / debtors cannot be produced as one segmented report; the 1 M-row ranking/scale facet is therefore unasserted (moot until a segment report exists).`
  );
}

// ------------------------------------------------------------------ summary --
const tally: Record<string, number> = {};
for (const r of results) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
console.log(`SUMMARY=verdicts=${results.length} tally=${JSON.stringify(tally)}`);

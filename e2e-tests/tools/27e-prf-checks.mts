/**
 * BATCH 27e — PRF (6) performance & resources checks.
 *
 * Same discipline as 27b/27c/27d: shipped modules run unmodified under Node
 * through the repo resolve hook. The independent side is the *measurement*
 * (wall clock, heap/RSS, row counts) — no business rule is re-implemented
 * except the two component expressions quoted by file:line (the desktop
 * catalog filter+sort and the boot customer loop), which are one-liners whose
 * only shipped form is inline in a React component.
 *
 * Run:
 *   node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types \
 *     e2e-tests/tools/27e-prf-checks.mts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { usePosStore } from '../../src/store/usePosStore.ts';
import { matchProductSearch } from '../../src/utils/catalogSearch.ts';
import type { Product } from '../../src/types/pos.ts';

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
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: pct(s, 50),
    p95: pct(s, 95),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
};
const ms = (n: number) => `${n.toFixed(1)} ms`;
const mb = (n: number) => `${(n / 1024 ** 2).toFixed(1)} MiB`;

console.log(
  `MACHINE=${os.type()} ${os.release()} ${os.arch()} cpus=${os.cpus().length} mem=${Math.round(os.totalmem() / 1024 ** 3)}GiB node=${process.version}`
);

// ------------------------------------------------------------- PRF-01 data ---
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261026);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)] as T;

const FR = ['Chargeur', 'Coque', 'Câble', 'Écouteurs', 'Protection écran', 'Batterie externe', 'Support voiture', 'Adaptateur', 'Enceinte', 'Souris'];
const AR = ['شاحن', 'غطاء', 'كابل', 'سماعات', 'واقي شاشة', 'بطارية', 'حامل سيارة', 'محول', 'مكبر صوت', 'فأرة'];
const MODELS = ['iPhone 15', 'iPhone 14', 'Galaxy S24', 'Galaxy A55', 'Pixel 8', 'Redmi Note 13', 'P30 Lite', 'iPhone 13'];
const CATS = ['Coques iPhone', 'Coques Samsung', 'Chargeurs', 'Câbles', 'Protection', 'Audio', 'Accessoires', 'Services'];
const BRANDS = ['Apple', 'Samsung', 'Google', 'Anker', 'Belkin', 'ZAGG', 'Autre'];
const VENDORS = ['Alger Mobile Import', 'Tech Distrib DZ', 'Global Access', 'Sarl Phone Parts'];

function mkProduct(i: number): Product {
  const fr = pick(FR);
  const ar = pick(AR);
  const model = pick(MODELS);
  const price = 500 + Math.floor(rnd() * 49500);
  return {
    id: `P-${String(i).padStart(6, '0')}`,
    sku: `SKU-${String(i).padStart(6, '0')}`,
    barcode: `613${String(i).padStart(10, '0')}`,
    title: `${fr} ${model} ${ar} ${i % 97}`,
    category: pick(CATS),
    brand: pick(BRANDS) as Product['brand'],
    price,
    costPrice: Math.round(price * 0.62),
    wholesalePrice: Math.round(price * 0.92),
    stock: 1000,
    leadTimeDays: 3,
    dailySalesVelocity: 1,
    reorderPoint: 10,
    vendorName: pick(VENDORS),
    compatibleModel: model,
  } as unknown as Product;
}

const N_PRODUCTS = 100_000;
const heapBeforeProducts = process.memoryUsage().heapUsed;
const PRODUCTS: Product[] = Array.from({ length: N_PRODUCTS }, (_, i) => mkProduct(i));
const heapAfterProducts = process.memoryUsage().heapUsed;
fact(
  'PRF-01_FIXTURE',
  `products=${N_PRODUCTS} heapMiB=${((heapAfterProducts - heapBeforeProducts) / 1024 ** 2).toFixed(1)} categories=${new Set(PRODUCTS.map((p) => p.category)).size} brands=${new Set(PRODUCTS.map((p) => p.brand)).size}`
);

// the sale surface keeps the whole table: productAdapter.ts:166-171 selects *
const bootProducts = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'src/db/adapters/productAdapter.ts'), 'utf8').split(/\r?\n/);
  const line = src.findIndex((l) => /SELECT \* FROM products WHERE deleted = 0/.test(l));
  return line + 1;
})();

// ----------------------------------------------------- PRF-01 add-to-cart ----
usePosStore.setState({ products: PRODUCTS, cart: [] });
const addToCart = usePosStore.getState().addToCart;

// warm-up (JIT) — 20 adds, then a clean cart
for (let i = 0; i < 20; i += 1) addToCart(PRODUCTS[i]);
usePosStore.setState({ cart: [] });

const addTimes: number[] = [];
let addRejected = 0;
for (let i = 0; i < 300; i += 1) {
  const p = PRODUCTS[(i * 137) % N_PRODUCTS] as Product;
  const t0 = performance.now();
  const res = addToCart(p);
  const dt = performance.now() - t0;
  addTimes.push(dt);
  if (!res || res.success !== true) addRejected += 1;
  // realistic till cart size: a cart is not a 300-line document
  if ((i + 1) % 20 === 0) usePosStore.setState({ cart: [] });
}
const addStats = stats(addTimes);
fact(
  'PRF-01_ADD',
  `n=${addStats.n} rejected=${addRejected} p50=${ms(addStats.p50)} p95=${ms(addStats.p95)} max=${ms(addStats.max)} cartClearedEvery=20`
);

// --------------------------------------------- PRF-01 search-as-you-type ----
const QUERIES = ['c', 'ch', 'cha', 'char', 'charge', 'chargeur', 'chargeur 2', 'coque', 'coque ip', 'iphone', 'ecran', 'batterie 10 000', 'سامسونج', 'شاحن'];
const desktop: Array<{ q: string; ms: number; hits: number }> = [];
const mobile: Array<{ q: string; ms: number; hits: number }> = [];

// warm-up pass (same work, discarded)
PRODUCTS.filter((p) => matchProductSearch(p, 'chargeur')).sort((a, b) => a.title.localeCompare(b.title));

for (const q of QUERIES) {
  // Desktop: ProductCatalog.tsx:475-507 — filter on every keystroke, then sort
  // by the store default name_asc (createCatalogSlice.ts:30) with localeCompare.
  const d0 = performance.now();
  const filtered = PRODUCTS.filter((p) => matchProductSearch(p, q));
  filtered.sort((a, b) => a.title.localeCompare(b.title));
  const dMs = performance.now() - d0;
  desktop.push({ q, ms: dMs, hits: filtered.length });

  // Mobile: CatalogSearchTab.tsx:173-189 — same scan, no sort, after a 200 ms
  // debounce (CatalogSearchTab.tsx:86-97).
  const m0 = performance.now();
  const mFiltered = PRODUCTS.filter((p) => matchProductSearch(p, q));
  const mMs = performance.now() - m0;
  mobile.push({ q, ms: mMs, hits: mFiltered.length });
}
const dStats = stats(desktop.map((x) => x.ms));
const mStats = stats(mobile.map((x) => x.ms));
const singleChar = desktop.find((x) => x.q === 'c');
fact(
  'PRF-01_SEARCH',
  `queries=${QUERIES.length} desktop p50=${ms(dStats.p50)} p95=${ms(dStats.p95)} max=${ms(dStats.max)} | mobile(filterOnly) p50=${ms(mStats.p50)} p95=${ms(mStats.p95)} max=${ms(mStats.max)} | widest='c' hits=${singleChar?.hits} (${ms(singleChar?.ms ?? 0)})`
);
fact('PRF-01_PER_QUERY', desktop.map((x) => `${x.q}=${x.ms.toFixed(0)}ms/${x.hits}`).join(' '));

const virtualHits = srcHits(/useVirtualizer|react-virtual/).map((h) => `${h.file}:${h.line}`);
const catalogVirtual = virtualHits.filter((h) => /ProductCatalog|CatalogSearchTab/.test(h));
const renderAllDesktop = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'src/components/ProductCatalog.tsx'), 'utf8').split(/\r?\n/);
  return src.reduce<number[]>((acc, l, i) => (/sortedProducts\.map\(/.test(l) ? [...acc, i + 1] : acc), []);
})();
const renderAllMobile = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'src/components/mobile/tabs/CatalogSearchTab.tsx'), 'utf8').split(/\r?\n/);
  return src.reduce<number[]>((acc, l, i) => (/filteredProducts\.map\(/.test(l) ? [...acc, i + 1] : acc), []);
})();

const BUDGET_MS = 100; // the case's own example budget (PRF-01 text)
const addOk = addStats.p95 < BUDGET_MS;
const searchOk = dStats.p95 < BUDGET_MS && mStats.p95 < BUDGET_MS;
record(
  'PRF-01',
  addOk && searchOk ? 'PASS' : 'FAIL',
  `Add-to-cart itself is fast (${addStats.n} shipped store adds: p50 ${ms(addStats.p50)}, p95 ${ms(addStats.p95)}, max ${ms(addStats.max)}, ${addRejected} rejected) but search-as-you-type is ${searchOk ? 'within' : 'far outside'} the case's 100 ms example budget: on ${N_PRODUCTS.toLocaleString('en-US')} products the desktop pipeline (filter with matchProductSearch + sort by name_asc, src/components/ProductCatalog.tsx:475-507) has p50 ${ms(dStats.p50)}, p95 ${ms(dStats.p95)}, max ${ms(dStats.max)}; the mobile pipeline does the same full scan after a 200 ms debounce (src/components/mobile/tabs/CatalogSearchTab.tsx:86-97,173-189) with p95 ${ms(mStats.p95)}. A one-character query returns ${singleChar?.hits?.toLocaleString('en-US')} rows and both sale surfaces render every one of them (ProductCatalog.tsx:${renderAllDesktop.join(',')}, CatalogSearchTab.tsx:${renderAllMobile.join(',')}) - @tanstack/react-virtual is used only by CustomersModal/InventoryManagerModal (${virtualHits.join(', ')}), never by the catalog the cashier sells from. The catalog is also fully materialised at boot (SELECT * with no LIMIT, src/db/adapters/productAdapter.ts:${bootProducts}), so the 100k rows are resident before the first keystroke.`
);

// ---------------------------------------------------------------- PRF-05 -----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prf05-'));
  const file = path.join(dir, 'customers.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');
  db.exec(`CREATE TABLE customers (
    id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT,
    loyalty_points INTEGER, store_credit INTEGER, pricing_tier TEXT, total_spent INTEGER,
    json_payload TEXT, updated_at TEXT, version INTEGER, created_at TEXT,
    current_debt INTEGER, whatsapp_opt_in INTEGER, deleted INTEGER DEFAULT 0
  )`);
  // the real schema indexes phone/barcode/loyalty_card (src-tauri/src/lib.rs:1023-1025)
  // and has NO index on name.
  db.exec('CREATE INDEX idx_customers_phone ON customers(phone)');

  const FIRST_FR = ['Mohamed', 'Ahmed', 'Nadir', 'Sami', 'Sofiane', 'Bilal', 'Rachid', 'Rachid', 'Nadia', 'Sara', 'Lina', 'Imene'];
  const LAST_FR = ['Benali', 'Boudiaf', 'Cherif', 'Haddad', 'Mansouri', 'Zerrouki', 'Bouzid', 'Khelifi'];
  const FIRST_AR = ['محمد', 'أحمد', 'كريم', 'ياسين', 'سفيان', 'بلال', 'أمين', 'رشيد'];
  const LAST_AR = ['بن علي', 'بوضياف', 'شريف', 'حداد', 'منصوري', 'زروقي'];
  const TIERS = ['Retail', 'VIP', 'Wholesale'];

  const ins = db.prepare(
    'INSERT INTO customers (id,name,phone,email,loyalty_points,store_credit,pricing_tier,total_spent,json_payload,updated_at,version,created_at,current_debt,whatsapp_opt_in,deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)'
  );
  const N = 1_000_000;
  const t0 = Date.now();
  const seed = db.transaction(() => {
    for (let i = 0; i < N; i += 1) {
      const arabic = i % 3 === 0;
      const first = arabic ? pick(FIRST_AR) : pick(FIRST_FR);
      const last = arabic ? pick(LAST_AR) : pick(LAST_FR);
      const name = `${first} ${last}${i % 11 === 0 ? ' ' + String(i % 100) : ''}`;
      // 15 % have no phone, ~3 % duplicate an earlier phone
      const phone = i % 20 < 3 ? null : i % 33 === 0 ? `05${String(50000000 + (i % 1000)).padStart(8, '0')}` : `05${String(i).padStart(8, '0')}`;
      const tier = TIERS[i % 3];
      const payload = JSON.stringify({
        id: `C-${i}`,
        name,
        phone,
        email: i % 7 === 0 ? `c${i}@example.dz` : '',
        loyaltyPoints: i % 500,
        storeCredit: i % 9 === 0 ? (i % 7) * 100 : 0,
        pricingTier: tier,
        totalSpent: (i % 97) * 1000,
        notes: i % 13 === 0 ? 'Client fidèle — livraison Alger centre' : '',
        createdAt: new Date(2024, i % 12, (i % 27) + 1).toISOString(),
      });
      ins.run(
        `C-${i}`,
        name,
        phone,
        i % 7 === 0 ? `c${i}@example.dz` : '',
        i % 500,
        i % 9 === 0 ? (i % 7) * 100 : 0,
        tier,
        (i % 97) * 1000,
        payload,
        new Date(2026, 9, 20 + (i % 6)).toISOString(),
        (i % 5) + 1,
        new Date(2024, i % 12, (i % 27) + 1).toISOString(),
        i % 31 === 0 ? (i % 11) * 1000 : 0,
        i % 2,
      );
    }
  });
  seed();
  const buildMs = Date.now() - t0;
  db.pragma('synchronous = NORMAL');
  const dbBytes = fs.statSync(file).size;
  fact('PRF-05_FIXTURE', `rows=${N} buildMs=${buildMs} dbMiB=${(dbBytes / 1024 ** 2).toFixed(1)} nameIndex=none phoneIndex=yes`);

  // The exact boot query, copied verbatim from src/db/adapters/customerAdapter.ts:221-224.
  const SQL =
    'SELECT id, name, phone, email, loyalty_points, store_credit, pricing_tier, total_spent, json_payload, updated_at, version, created_at, current_debt, whatsapp_opt_in FROM customers WHERE deleted = 0 ORDER BY name ASC';

  const heapBefore = process.memoryUsage().heapUsed;
  const rssBefore = process.memoryUsage().rss;
  const s0 = performance.now();
  const rows = db.prepare(SQL).all() as Array<Record<string, unknown>>;
  const sqlMs = performance.now() - s0;
  const rssAfterSql = process.memoryUsage().rss;

  const p0 = performance.now();
  const customers: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    let base: Record<string, unknown> = {};
    if (typeof r.json_payload === 'string' && r.json_payload.length > 0) {
      try {
        base = JSON.parse(r.json_payload) as Record<string, unknown>;
      } catch {
        base = {};
      }
    }
    customers.push({
      ...base,
      id: String(r.id ?? base.id ?? ''),
      name: String(base.name ?? r.name ?? ''),
      phone: String(base.phone ?? r.phone ?? ''),
      loyaltyPoints: Number(base.loyaltyPoints ?? r.loyalty_points ?? 0),
      storeCredit: Number(base.storeCredit ?? r.store_credit ?? 0),
      pricingTier: String(base.pricingTier ?? r.pricing_tier ?? 'Retail'),
      totalSpent: Number(base.totalSpent ?? r.total_spent ?? 0),
      currentDebt: Number(base.currentDebt ?? r.current_debt ?? 0),
    });
  }
  const mapMs = performance.now() - p0;
  const heapAfter = process.memoryUsage().heapUsed;
  const rssAfter = process.memoryUsage().rss;
  const payloadBytes = rows.reduce((a, r) => a + String(r.json_payload ?? '').length, 0);

  const totalMs = sqlMs + mapMs;
  fact(
    'PRF-05_BOOT',
    `rows=${rows.length} sqlMs=${sqlMs.toFixed(0)} mapMs=${mapMs.toFixed(0)} totalMs=${totalMs.toFixed(0)} payloadMiB=${(payloadBytes / 1024 ** 2).toFixed(1)} heapDeltaMiB=${((heapAfter - heapBefore) / 1024 ** 2).toFixed(0)} rssDeltaMiB=${((rssAfter - rssBefore) / 1024 ** 2).toFixed(0)} rssAfterSqlMiB=${(rssAfterSql / 1024 ** 2).toFixed(0)}`
  );

  const bootLanes = srcHits(/WINDOW_SIZE|_BOOT_WINDOW|getTransactionsWindow/).length;
  record(
    'PRF-05',
    'FAIL',
    `The customer lane is the only boot lane with no window: the exact query at src/db/adapters/customerAdapter.ts:221-224 selects every column of every live customer, ORDER BY name ASC with no supporting index (src-tauri/src/lib.rs:1023-1025 indexes phone/barcode/loyalty_card only) and no LIMIT, and the store awaits it in the boot Promise.all (src/store/slices/createUISlice.ts:1990-2023) while transactions/expenses/shifts get bounded windows (${bootLanes} window references). Measured on ${rows.length.toLocaleString('en-US')} customers: SQL ${ms(sqlMs)}, row+JSON mapping ${ms(mapMs)} (lower bound - excludes the tauri-plugin-sql IPC serialisation of ${rows.length.toLocaleString('en-US')} rows), ${mb(payloadBytes)} of payload, +${mb(heapAfter - heapBefore)} heap / +${mb(rssAfter - rssBefore)} RSS. The shell paints before wave 2, so "usable early" holds for the till, but every customer surface (search, credit, loyalty) stays empty until this full-table load finishes and the whole table stays resident afterwards.`
  );

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------ PRF-02/03/04/06 --
{
  const g16 = srcHits(/G-16|long.session|soak/i).length;
  record(
    'PRF-02',
    'BLOCKED',
    `An 8-hour and a 72-hour session cannot be produced in this run: the harness would need 72 h of wall clock plus handle/memory sampling of the real Tauri WebView (the case's invariant is G-16), and no soak driver or handle-count instrumentation exists in e2e-tests (${g16} references to G-16/soak in src). A shortened soak would not assert the named 8 h/72 h durations, so nothing is claimed here.`
  );
}
{
  record(
    'PRF-03',
    'BLOCKED',
    `No 2 GB / old-CPU machine is available: this host is a Ryzen 5 8500G with 15.1 GiB RAM (${os.cpus().length} cores), and Windows offers no reliable way to constrain the desktop app to 2 GB with CPU throttling. Running the suite here would measure the wrong machine, so the case is not asserted.`
  );
}
{
  record(
    'PRF-04',
    'BLOCKED',
    `No low-end Android device is attached and the mobile shell is only reachable as a WebView device-role switch, not as a phone with a camera: scrolling 100 k customers, searching and capturing a photo simultaneously (ANR/memory budget, MOB-21) needs real hardware and the native camera path. Nothing is claimed.`
  );
}
{
  record(
    'PRF-06',
    'BLOCKED',
    `Sync of 1 M customer changes plus 5 000 sales on mobile data needs three things this environment does not have: a configured merchant gateway (sync.gateway_url is unset, so the drain idles), a mobile-data link with measurable bandwidth/latency, and a second enrolled terminal for the peer side (SYN-09/SYN-24 resumability). The loopback verifier proves the signed-lane protocol, not the case's bandwidth/time budgets, so the case stays BLOCKED.`
  );
}

// ------------------------------------------------------------------ summary --
const tally: Record<string, number> = {};
for (const r of results) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
console.log(`SUMMARY=verdicts=${results.length} tally=${JSON.stringify(tally)}`);

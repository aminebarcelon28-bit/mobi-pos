/**
 * Production Gauntlet — ACID / concurrency / ledger stress on the REAL engine.
 *
 * Executes INSIDE the live Tauri WebView via CDP (:9222): full native lane
 * (SQLite WAL, FIFO depletion, ledger guards, drawer float guard). Store
 * actions are reached via dynamic /src/* imports (same Vite module graph).
 *
 * SAFETY PROTOCOL (mandatory):
 *   1. stop app; node scripts/production-gauntlet.mjs --backup <dir>
 *   2. launch app (CDP flag) + vite
 *   3. node scripts/production-gauntlet.mjs --phase all
 *   4. stop app; --restore <dir>; wipe WebView IndexedDB; reset remirror flags
 *   5. relaunch + verify counts
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

globalThis.__t0 = Date.now();
const DB = path.join(process.env.APPDATA || '', 'com.mobi.pos', 'mobi_pos.db');
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : null;
};
const dbTrio = () => ['', '-wal', '-shm'].map((s) => DB + s).filter((p) => fs.existsSync(p));

if (flag('--backup')) {
  const dir = flag('--backup');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of dbTrio()) fs.copyFileSync(f, path.join(dir, path.basename(f)));
  console.log(JSON.stringify({ backup: dir, ok: true }));
  process.exit(0);
}
if (flag('--restore')) {
  const dir = flag('--restore');
  for (const f of ['', '-wal', '-shm']) {
    const src = path.join(dir, `mobi_pos.db${f}`);
    if (fs.existsSync(src)) fs.copyFileSync(src, DB + f);
    else if (fs.existsSync(DB + f)) fs.rmSync(DB + f);
  }
  console.log(JSON.stringify({ restored: true }));
  process.exit(0);
}

const PHASE = flag('--phase') || 'all';
const results = {};
const timed = async (name, fn) => {
  const s = Date.now();
  try {
    results[name] = { ...(await fn()), ms: Date.now() - s };
  } catch (e) {
    results[name] = { pass: false, error: String((e && e.message) || e).slice(0, 400), ms: Date.now() - s };
  }
};

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => (p.url() || '').includes('1420')) ?? ctx.pages()[0];
console.log('attached:', page.url());
const ev = (fn, arg) => page.evaluate(fn, arg);

// --- setup: unlock if locked, open shift 15000 (fail if a different float is open) ---
await timed('setup', async () => {
  await page.waitForSelector('button', { timeout: 45000 });
  await page.waitForTimeout(4000);
  const locked = await ev(() => {
    const pw = document.querySelector('input[type="password"]');
    return pw !== null && (document.body.textContent || '').includes('code PIN');
  });
  if (locked) {
    await page.keyboard.type('202020', { delay: 80 });
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: /Valider/ }).first().click({ timeout: 15000 });
    await page.waitForTimeout(3000);
  }
  const shift = await ensureCleanShift(page, ev, 15000);
  return { locked, shift };
});

async function ensureCleanShift(page, ev, wantFloat) {
  // Returns { float } of a guaranteed-fresh OPEN shift, closing any stale
  // one first (Dexie/SQLite mismatch from killed sessions included).
  const st = await ev(async () => {
    const { usePosStore } = await import('/src/store/usePosStore.ts');
    const { db } = await import('/src/db/database.ts');
    const S = () => usePosStore.getState();
    const dex = await db.cashSessions.toArray().catch(() => []);
    return {
      mem: S().activeShift ? { id: S().activeShift.id, float: S().activeShift.openingFloat } : null,
      dex: dex.map((s) => ({ id: s.id, status: s.status, float: s.openingFloat })),
    };
  });
  // Never reuse: a reused window carries prior invocations' trades/sales,
  // which poisons the drawer estimate the overdraft test depends on.
  const closeParams = [0, 'Gauntlet reset', 'Gauntlet', '202020'];
  if (st.mem) {
    const closedMem = await ev(async (p) => {
      const { usePosStore } = await import('/src/store/usePosStore.ts');
      const S = () => usePosStore.getState();
      try {
        const r = await S().closeShift(p[0], p[1], p[2], p[3]);
        return { ok: !!(r && r.success), reason: (r && r.reason) || null };
      } catch (e) {
        return { ok: false, reason: 'threw:' + String((e && e.message) || e).slice(0, 100) };
      }
    }, closeParams);
    if (!closedMem.ok) throw new Error('cannot close live shift: ' + JSON.stringify({ st, closedMem }));
  }
  const dexOpen = (st.dex || []).find((s) => s.status === 'OPEN');
  if (!st.mem && dexOpen) {
    // Orphan OPEN row in Dexie (killed session) with no live shift: close it
    // by id so a fresh exact-float shift can open. Variance PIN + note cover
    // the blind count, like the stale-mem path below.
    const closedOrphan = await ev(async (sid) => {
      // Adapter-direct: the store closeShift() has no sessionId param, and
      // there is no live shift to close — only the orphan Dexie row.
      const { shiftAdapter } = await import('/src/db/adapters/shiftAdapter.ts');
      try {
        await shiftAdapter.closeShift(0, 'Gauntlet reset (orphan)', 'Gauntlet', sid, '202020');
        return { ok: true, reason: null };
      } catch (e) {
        return { ok: false, reason: 'threw:' + String((e && e.message) || e).slice(0, 100) };
      }
    }, dexOpen.id);
    if (!closedOrphan.ok) throw new Error('cannot close orphan shift: ' + JSON.stringify({ st, closedOrphan }));
  }
  const opened = await ev(async (f) => {
    const { usePosStore } = await import('/src/store/usePosStore.ts');
    const r = await usePosStore.getState().startShift(f, 'Gauntlet');
    return { ok: !!(r && r.success), reason: (r && r.reason) || null };
  }, wantFloat);
  if (!opened.ok) throw new Error('cannot open shift: ' + JSON.stringify({ st, opened }));
  return { float: wantFloat, reused: false, diag: st };
}

const P_ZERO = {
  id: 'prod-gauntlet-zero', sku: 'GAUNTLET-ZERO', barcode: '6139990000004',
  title: 'Gauntlet Zero Line', brand: 'Autre', compatibleModel: 'Gauntlet',
  category: 'Services', price: 0, wholesalePrice: 0, costPrice: 0,
  stock: 999999, imageUrl: '', isSerialized: false, vendorName: 'Gauntlet',
  leadTimeDays: 0, dailySalesVelocity: 0, reorderPoint: 0,
};

// --- phase 1: inverted float. FIRST: the fresh shift float is exact, and
// no drawer proceeds have landed yet, so the overdraft premise is airtight.
// (50000 soulte vs 15000 float blocks; exact 15000 clears to zero.)
if (PHASE === 'all' || PHASE === 'float') {
  await timed('float_block', async () => {
    return ev(async (PZERO) => {
      const { usePosStore } = await import('/src/store/usePosStore.ts');
      const { productRepository } = await import('/src/db/repositories/productRepository.ts');
      const S = () => usePosStore.getState();
      await productRepository.save(PZERO);
      usePosStore.setState({
        products: [...S().products.filter((p) => p.id !== PZERO.id), PZERO],
        cart: [{ product: PZERO, quantity: 1, appliedPrice: 0, discount: 0 }],
      });
      S().setStagedTradeIn({
        stagedId: 'g-float', customerName: 'Gauntlet', deviceModel: 'Gauntlet Phone',
        imei: 'GAUNTLET-FLOAT', brand: 'Autre', conditionGrade: 'Grade B (Bon État)',
        buybackValue: 50000, resaleMarginPercent: 30, creditToWallet: false,
      });
      S().setExchangeSoultePayout('cash');
      const r = await S().processPayment([{ method: 'Reprise', amount: 50000 }]);
      S().clearStagedTradeIn(); S().setExchangeSoultePayout(null); S().clearCart();
      return { success: !!(r && r.success), reason: (r && r.reason) || null };
    }, P_ZERO);
  });
  const f = results.float_block;
  if (!f.error) {
    f.pass = f.success === false && String(f.reason).startsWith('SOULTE_DRAWER_INSUFFICIENT');
    f.detail = `reason=${f.reason}`;
  }
  await timed('float_exact', async () => {
    // Exact-clearance: soulte == live float → single EXPENSE drains to 0.
    // Cash movements live in Dexie (native cash_movements unwritten by design).
    return ev(async (PZERO) => {
      const { usePosStore } = await import('/src/store/usePosStore.ts');
      const { db } = await import('/src/db/database.ts');
      const S = () => usePosStore.getState();
      const float = Math.max(0, Math.round(Number(S().activeShift?.openingFloat) || 0));
      usePosStore.setState({
        cart: [{ product: PZERO, quantity: 1, appliedPrice: 0, discount: 0 }],
      });
      const before = (await db.cashMovements.toArray().catch(() => [])).length;
      S().setStagedTradeIn({
        stagedId: 'g-floatex', customerName: 'Gauntlet', deviceModel: 'Gauntlet Phone',
        imei: 'GAUNTLET-FLOATEX', brand: 'Autre', conditionGrade: 'Grade B (Bon État)',
        buybackValue: float, resaleMarginPercent: 30, creditToWallet: false,
      });
      S().setExchangeSoultePayout('cash');
      const r = await S().processPayment([{ method: 'Reprise', amount: float }]);
      const movs = await db.cashMovements.toArray().catch(() => []);
      const fresh = movs.slice(before);
      const soulteMovs = fresh.filter((m) => String(m.reason || '').includes('Soulte'));
      S().clearStagedTradeIn(); S().setExchangeSoultePayout(null); S().clearCart();
      return {
        success: !!(r && r.success), reason: (r && r.reason) || null,
        float, movDelta: movs.length - before,
        soulteAmount: soulteMovs.length > 0 ? soulteMovs[0].amount : null,
      };
    }, P_ZERO);
  });
  const fx = results.float_exact;
  if (!fx.error) {
    fx.pass = fx.success === true && fx.movDelta === 1 && fx.soulteAmount === fx.float;
    fx.detail = `float=${fx.float} movDelta=${fx.movDelta} soulte=${fx.soulteAmount} reason=${fx.reason}`;
  }
  await timed('float_wallet', async () => {
    return ev(async (PZERO) => {
      const { usePosStore } = await import('/src/store/usePosStore.ts');
      const { customerRepository } = await import('/src/db/repositories/customerRepository.ts');
      const { db } = await import('/src/db/database.ts');
      const S = () => usePosStore.getState();
      const before = (await db.cashMovements.toArray().catch(() => [])).length;
      const cust = {
        id: 'cust-gauntlet', name: 'Gauntlet Client', phone: '0550000000',
        email: '', storeCredit: 0, loyaltyPoints: 0, totalSpent: 0, currentDebt: 0,
        loyaltyTier: 'Bronze', pointBuckets: [], ledger: [],
      };
      await customerRepository.save(cust);
      // Mirror into the store list too (slice resolves wallet targets there).
      usePosStore.setState({ customers: [...S().customers.filter((c) => c.id !== cust.id), { ...cust }] });
      S().setCurrentCustomer({ ...cust });
      usePosStore.setState({
        cart: [{ product: PZERO, quantity: 1, appliedPrice: 0, discount: 0 }],
      });
      S().setStagedTradeIn({
        stagedId: 'g-float2', customerName: 'Gauntlet Client', deviceModel: 'Gauntlet Phone',
        imei: 'GAUNTLET-FLOAT2', brand: 'Autre', conditionGrade: 'Grade B (Bon État)',
        buybackValue: 50000, resaleMarginPercent: 30, creditToWallet: false,
      });
      S().setExchangeSoultePayout('wallet');
      const r = await S().processPayment([{ method: 'Reprise', amount: 50000 }]);
      const after = (await db.cashMovements.toArray().catch(() => [])).length;
      const wallet = (S().customers.find((c) => c.id === 'cust-gauntlet') || {}).storeCredit;
      S().clearStagedTradeIn(); S().setExchangeSoultePayout(null);
      S().setCurrentCustomer(null); S().clearCart();
      return {
        success: !!(r && r.success), reason: (r && r.reason) || null,
        wallet, movDelta: after - before,
      };
    }, P_ZERO);
  });
  const w = results.float_wallet;
  if (!w.error) {
    w.pass = w.success === true && w.wallet === 50000 && w.movDelta === 0;
    w.detail = `wallet=${w.wallet} movDelta=${w.movDelta} reason=${w.reason}`;
  }
  }

// --- phase 2: hammer (stock=1, 10 concurrent checkouts) ---
if (PHASE === 'all' || PHASE === 'hammer') {
  await timed('hammer', async () => {
    return ev(async (PZERO) => {
      const { usePosStore } = await import('/src/store/usePosStore.ts');
      const { productRepository } = await import('/src/db/repositories/productRepository.ts');
      const { db } = await import('/src/db/database.ts');
      const S = () => usePosStore.getState();
      const P = {
        id: 'prod-gauntlet-hammer', sku: 'GAUNTLET-HAMMER', barcode: '6139990000011',
        title: 'Gauntlet Hammer Phone', brand: 'Autre', compatibleModel: 'Gauntlet',
        category: 'Smartphones Neufs', price: 42000, wholesalePrice: 33600, costPrice: 29400,
        stock: 1, imageUrl: '', isSerialized: false, vendorName: 'Gauntlet',
        leadTimeDays: 0, dailySalesVelocity: 0, reorderPoint: 0,
      };
      await productRepository.save(P);
      usePosStore.setState({ products: [...S().products.filter((p) => p.id !== P.id), P] });
      usePosStore.setState({ cart: [{ product: P, quantity: 1, appliedPrice: P.price, discount: 0 }] });
      const calls = Array.from({ length: 10 }, () =>
        S().processPayment([{ method: 'Espèces', amount: P.price }]).then(
          (r) => ((r && r.success) ? 'ok' : String((r && r.reason) || 'unknown')),
          (e) => 'threw:' + String((e && e.message) || e).slice(0, 80)));
      const reasons = await Promise.all(calls);
      const okCount = reasons.filter((r) => r === 'ok').length;
      const dexProd = await db.products.get(P.id).catch(() => null);
      S().clearCart();
      return { reasons, okCount, dexStock: dexProd ? dexProd.stock : 'missing' };
    }, P_ZERO);
  });
  const h = results.hammer;
  if (!h.error) {
    h.pass = h.okCount === 1 && h.dexStock === 0;
    h.detail = `ok=${h.okCount}/10 dexStock=${h.dexStock} reasons=${JSON.stringify(h.reasons)}`;
  }
}

// --- phase 3: 50 intake→sale cycles ---
if (PHASE === 'all' || PHASE === 'cycles') {
  await timed('cycles_50', async () => {
    return ev(async () => {
      const { usePosStore } = await import('/src/store/usePosStore.ts');
      const { db } = await import('/src/db/database.ts');
      const S = () => usePosStore.getState();
      const { db: dbgDb } = await import('/src/db/database.ts');
      const RUN = 'R' + Date.now().toString(36).toUpperCase();
      let ok = 0;
      const failures = [];
      for (let i = 0; i < 50; i++) {
        const tag = RUN + '-CYC-' + i;
        try {
          const buyback = 10000 + i;
          const r = await S().commitStagedTradeInIntake({
            stagedId: 'g-' + tag, customerName: 'Gauntlet', deviceModel: 'Gauntlet Cycle ' + i,
            imei: 'GAUNTLET-' + tag, brand: 'Autre', conditionGrade: 'Grade B (Bon État)',
            buybackValue: buyback, resaleMarginPercent: 30, creditToWallet: false,
          });
          if (!r.success) throw new Error('intake:' + r.reason);
          const prod = S().products.find((p) => p.id === r.productId);
          if (!prod) throw new Error('product-missing');
          S().setStagedTradeIn(null);
          usePosStore.setState({ cart: [{ product: prod, quantity: 1, appliedPrice: prod.price, discount: 0, imeiNumber: 'GAUNTLET-' + tag }] });
          const pay = await S().processPayment([{ method: 'Espèces', amount: prod.price }]);
          if (!pay.success) {
            // Forensics: which lane claims it sold? (mirror / dexie / sqlite)
            const imeiU = ('GAUNTLET-' + tag).toUpperCase();
            const mir = (S().imeiRecords || []).find((x) => String(x.imei || '').toUpperCase() === imeiU);
            let dex = null;
            try { dex = await dbgDb.imeiRecords.get(imeiU).catch(() => null); } catch {}
            throw new Error('pay:' + pay.reason + ' | mir=' + JSON.stringify(mir && { s: mir.soldAt, t: mir.saleTransactionId }) + ' dex=' + JSON.stringify(dex && { s: dex.soldAt, t: dex.saleTransactionId }));
          }
          ok++;
        } catch (e) {
          failures.push(i + ':' + String((e && e.message) || e).slice(0, 100));
        }
      }
      try { S().clearCart(); } catch {}
      const { db: db2 } = await import('/src/db/database.ts');
      const prods = await db2.products.toArray().catch(() => []);
      const g = prods.filter((p) => String(p.id || '').startsWith('prod-g-' + RUN));
      void dbgDb;
      return {
        ok, failures: failures.slice(0, 5), gauntletProducts: g.length, run: RUN,
        nonzero: g.filter((p) => p.stock !== 0).length,
      };
    });
  });
  const c = results.cycles_50;
  if (!c.error) {
    c.pass = c.ok === 50 && c.failures.length === 0 && c.nonzero === 0;
    c.detail = `ok=${c.ok}/50 nonzeroStock=${c.nonzero} failures=${JSON.stringify(c.failures)}`;
  }
}

await browser.close();
const allPass = Object.values(results).every((r) => r.pass !== false);
console.log(JSON.stringify({ results, totalMs: Date.now() - globalThis.__t0, allPass }, null, 1));
process.exit(allPass ? 0 : 1);

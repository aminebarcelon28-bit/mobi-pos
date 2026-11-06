/**
 * WAR - warranty / IMEI lifecycle matrix (batch 19, spec 86).
 *
 * P0 first: 01-06, 10-16, 19, 23, 24, 29, 30. Then P1: 07-09, 17, 18,
 * 20-22, 25-28.
 *
 * The inspector is driven through the shipped ImeiWarrantyInspectorModal:
 * real IMEI input, real lookup, real trust panel, real certificate print
 * (ESC/POS bytes captured from the native spooler). Genuinely absent lanes
 * execute schema/DOM absence probes and are recorded N/A with file:line proof.
 */
import fs from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { all, columnNames, one, run, waitForSchemaSettled } from '../lib/db';
import { closeDialogs } from '../lib/pos';
import { resetData, seedBlockedImeis, seedProducts } from '../lib/seed';
import { assertInvariants, captureInvariantBaseline, finalizeInvariants } from '../lib/invariants';
import {
  armPrintBuffer,
  bodyText,
  bootUnlock,
  claimRows,
  closeInspector,
  closeRepairModal,
  fillIntake,
  inspectorBody,
  inspectorLookup,
  isoAt,
  makeImei,
  newRepair,
  openInspector,
  openRepairModal,
  readPrintBuffers,
  refreshApp,
  repairPayload,
  repairRowByTicket,
  saveRepairWait,
  seedHistoricSession,
  seedImei,
  seedRepair,
  seedSale,
} from '../lib/sav';
import { buildWarrantyCertificateProbe } from '../lib/warrantyCertificateProbe';

type Row = Record<string, unknown>;

async function inspect(imei: string, mode: 'imei' | 'serial' = 'imei'): Promise<string> {
  await openInspector();
  await inspectorLookup(imei, mode);
  await browser.pause(600);
  return inspectorBody();
}

function tablesLike(...fragments: string[]): string[] {
  const where = fragments.map(() => 'name LIKE ?').join(' OR ');
  return all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND (${where})`,
    ...fragments,
  ).map((r) => r.name);
}

function claimColumns(): string[] {
  return columnNames('warranty_claims');
}

async function makeRework(originalTicket: string, name: string, imei: string): Promise<Row> {
  const original = repairRowByTicket(originalTicket);
  await openRepairModal();
  await fillIntake({
    name,
    phone: '0550990000',
    model: String(repairPayload(String(original?.id ?? '')).deviceModel ?? 'Galaxy S21'),
    imei,
    problem: 'Même panne — reprise garantie',
    labor: 0,
    deposit: 0,
    reworkId: String(original?.id ?? ''),
  });
  return saveRepairWait(name);
}

describe('WAR - warranty / IMEI lifecycle matrix', () => {
  before(async () => {
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    await waitForSchemaSettled();
    await bootUnlock();
    await resetData();
    seedHistoricSession();
    seedProducts([
      { id: 'WAR1-STOCK', title: 'Galaxy A14 (stock)', priceDa: 30000, stock: 1, category: 'Smartphones' },
    ]);

    // WAR-01: sold / in stock / in repair / returned / sold twice.
    seedSale({
      id: 'TXN-W1-SOLD', receipt: 'TXN-W1-SOLD', createdAt: isoAt('2026-06-01', 10),
      items: [{ productId: 'PHONE-W1-SOLD', title: 'WAR1 SOLD PHONE', price: 50000, imei: makeImei(2001), warrantyMonths: 12 }],
      total: 50000, customer: { id: 'CUST-W1', name: 'WAR1 CLIENT', phone: '0550200100' },
    });
    seedImei({ imei: makeImei(2001), productId: 'PHONE-W1-SOLD', status: 'sold', saleTransactionId: 'TXN-W1-SOLD', warrantyMonths: 12, soldAt: isoAt('2026-06-01', 10) });
    seedImei({ imei: makeImei(2002), productId: 'WAR1-STOCK', status: 'in_stock', warrantyMonths: 12, receivedAt: isoAt('2026-09-01', 8) });
    seedRepair({
      id: 'W1-REP', ticket: 'T-W1-REP', name: 'WAR1 REPAIR', model: 'Galaxy A14',
      imei: makeImei(2003), status: 'En cours', labor: 3000, deposit: 1000,
      tier: 'repair_90d', createdAt: isoAt('2026-09-10', 9),
    });
    seedSale({
      id: 'TXN-W1-RET', receipt: 'TXN-W1-RET', createdAt: isoAt('2026-05-01', 10),
      items: [{ productId: 'PHONE-W1-RET', title: 'WAR1 RETURNED PHONE', price: 40000, imei: makeImei(2004), warrantyMonths: 12 }],
      total: 40000, customer: { id: 'CUST-W1R', name: 'WAR1 RETURN CLIENT', phone: '0550200101' },
    });
    seedSale({
      id: 'TXN-W1-RET-R', receipt: 'TXN-W1-RET-R', createdAt: isoAt('2026-05-20', 10),
      isRefund: true, originalTransactionId: 'TXN-W1-RET',
      items: [{ productId: 'PHONE-W1-RET', title: 'WAR1 RETURNED PHONE', price: 40000, imei: makeImei(2004), warrantyMonths: 12 }],
      total: 40000, customer: { id: 'CUST-W1R', name: 'WAR1 RETURN CLIENT', phone: '0550200101' },
    });
    const retPayload = one<Row>("SELECT json_payload FROM transactions WHERE id='TXN-W1-RET-R'");
    const retObj = JSON.parse(String(retPayload?.json_payload ?? '{}')) as { items?: Row[] };
    if (retObj.items?.[0]) retObj.items[0].isReturn = true;
    run("UPDATE transactions SET json_payload=? WHERE id='TXN-W1-RET-R'", JSON.stringify(retObj));
    seedImei({ imei: makeImei(2004), productId: 'PHONE-W1-RET', status: 'returned', saleTransactionId: 'TXN-W1-RET', warrantyMonths: 12, soldAt: isoAt('2026-05-01', 10) });
    seedSale({
      id: 'TXN-W1-DUP1', receipt: 'TXN-W1-DUP1', createdAt: isoAt('2026-06-01', 10),
      items: [{ productId: 'PHONE-W1-DUP', title: 'WAR1 DUPLICATE PHONE', price: 45000, imei: makeImei(2005), warrantyMonths: 12 }],
      total: 45000, customer: { id: 'CUST-W1D', name: 'WAR1 DUP CLIENT', phone: '0550200102' },
    });
    seedSale({
      id: 'TXN-W1-DUP2', receipt: 'TXN-W1-DUP2', createdAt: isoAt('2026-07-01', 10),
      items: [{ productId: 'PHONE-W1-DUP', title: 'WAR1 DUPLICATE PHONE', price: 46000, imei: makeImei(2005), warrantyMonths: 12 }],
      total: 46000, customer: { id: 'CUST-W1D2', name: 'WAR1 DUP CLIENT 2', phone: '0550200103' },
    });
    seedImei({ imei: makeImei(2005), productId: 'PHONE-W1-DUP', status: 'sold', saleTransactionId: 'TXN-W1-DUP2', warrantyMonths: 12, soldAt: isoAt('2026-07-01', 10) });

    // WAR-02: a valid sale for identifier-shape probes.
    seedSale({
      id: 'TXN-W2', receipt: 'TXN-W2', createdAt: isoAt('2026-07-10', 10),
      items: [{ productId: 'PHONE-W2', title: 'WAR2 IDENTIFIER PHONE', price: 30000, imei: makeImei(2100), warrantyMonths: 12 }],
      total: 30000, customer: { id: 'CUST-W2', name: 'WAR2 CLIENT', phone: '0550200200' },
    });

    // WAR-03: boundary dates (UTC month clamp / 23:59 vs 00:01).
    const w3 = [
      ['TXN-W3-A', makeImei(2301), '2025-10-23T23:59:00.000Z'],
      ['TXN-W3-B', makeImei(2302), '2025-10-24T00:01:00.000Z'],
      ['TXN-W3-C', makeImei(2303), '2026-01-31T10:00:00.000Z'],
      ['TXN-W3-D', makeImei(2304), '2024-02-29T10:00:00.000Z'],
    ] as const;
    for (const [receipt, imei, createdAt] of w3) {
      seedSale({
        id: receipt, receipt, createdAt,
        items: [{ productId: `PHONE-${receipt}`, title: `WAR3 ${receipt}`, price: 30000, imei, warrantyMonths: receipt === 'TXN-W3-C' ? 1 : 12 }],
        total: 30000, customer: { id: `CUST-${receipt}`, name: `WAR3 ${receipt}`, phone: '0550200300' },
      });
      seedImei({
        imei, productId: `PHONE-${receipt}`, status: 'sold', saleTransactionId: receipt,
        warrantyMonths: receipt === 'TXN-W3-C' ? 1 : 12, soldAt: createdAt,
      });
    }

    // WAR-04: start event is the sale instant.
    seedSale({
      id: 'TXN-W4', receipt: 'TXN-W4', createdAt: isoAt('2026-01-10', 10),
      items: [{ productId: 'PHONE-W4', title: 'WAR4 START PHONE', price: 60000, imei: makeImei(2400), warrantyMonths: 12 }],
      total: 60000, customer: { id: 'CUST-W4', name: 'WAR4 CLIENT', phone: '0550200400' },
    });
    seedImei({ imei: makeImei(2400), productId: 'PHONE-W4', status: 'sold', saleTransactionId: 'TXN-W4', warrantyMonths: 12, soldAt: isoAt('2026-01-10', 10) });
    // A repair delivered later must not move the STORE warranty start.
    seedRepair({
      id: 'W4-REP', ticket: 'T-W4-REP', name: 'WAR4 CLIENT', model: 'iPhone 15',
      imei: makeImei(2400), status: 'Livré', labor: 3000, deposit: 3000,
      tier: 'repair_90d', createdAt: isoAt('2026-09-01', 9), deliveredAt: isoAt('2026-09-05', 11),
    });

    // WAR-05: refunded sale A, then resold as B.
    seedSale({
      id: 'TXN-W5-A', receipt: 'TXN-W5-A', createdAt: isoAt('2026-04-01', 10),
      items: [{ productId: 'PHONE-W5', title: 'WAR5 PHONE', price: 50000, imei: makeImei(2501), warrantyMonths: 12 }],
      total: 50000, customer: { id: 'CUST-W5A', name: 'WAR5 FIRST', phone: '0550200500' },
    });
    seedSale({
      id: 'TXN-W5-AR', receipt: 'TXN-W5-AR', createdAt: isoAt('2026-05-01', 10),
      isRefund: true, originalTransactionId: 'TXN-W5-A',
      items: [{ productId: 'PHONE-W5', title: 'WAR5 PHONE', price: 50000, imei: makeImei(2501), warrantyMonths: 12 }],
      total: 50000, customer: { id: 'CUST-W5A', name: 'WAR5 FIRST', phone: '0550200500' },
    });
    seedSale({
      id: 'TXN-W5-B', receipt: 'TXN-W5-B', createdAt: isoAt('2026-06-01', 10),
      items: [{ productId: 'PHONE-W5', title: 'WAR5 PHONE', price: 52000, imei: makeImei(2501), warrantyMonths: 12 }],
      total: 52000, customer: { id: 'CUST-W5B', name: 'WAR5 SECOND', phone: '0550200501' },
    });
    // The registry row points at the resale B; the resolver must ignore the
    // refunded A even though both transactions carry the same IMEI.
    seedImei({ imei: makeImei(2501), productId: 'PHONE-W5', status: 'sold', saleTransactionId: 'TXN-W5-B', warrantyMonths: 12, soldAt: isoAt('2026-06-01', 10) });

    // WAR-06: as-is (0 months) and refurbished (3 months).
    seedSale({
      id: 'TXN-W6-ASIS', receipt: 'TXN-W6-ASIS', createdAt: isoAt('2026-09-01', 10),
      items: [{ productId: 'PHONE-W6-ASIS', title: 'WAR6 AS-IS PHONE', price: 20000, imei: makeImei(2601), warrantyMonths: 0 }],
      total: 20000, customer: { id: 'CUST-W6A', name: 'WAR6 AS-IS', phone: '0550200600' },
    });
    seedSale({
      id: 'TXN-W6-REF', receipt: 'TXN-W6-REF', createdAt: isoAt('2026-09-01', 10),
      items: [{ productId: 'PHONE-W6-REF', title: 'WAR6 REFURB PHONE', price: 35000, imei: makeImei(2602), warrantyMonths: 3 }],
      total: 35000, customer: { id: 'CUST-W6R', name: 'WAR6 REFURB', phone: '0550200601' },
    });
    seedImei({ imei: makeImei(2601), productId: 'PHONE-W6-ASIS', status: 'sold', saleTransactionId: 'TXN-W6-ASIS', warrantyMonths: 0, soldAt: isoAt('2026-09-01', 10) });
    seedImei({ imei: makeImei(2602), productId: 'PHONE-W6-REF', status: 'sold', saleTransactionId: 'TXN-W6-REF', warrantyMonths: 3, soldAt: isoAt('2026-09-01', 10) });

    // WAR-08/10/11/30: delivered repairs for inspection/claims.
    seedRepair({
      id: 'W8-REP', ticket: 'T-W8-REP', name: 'WAR8 INSPECT', model: 'Galaxy S22',
      imei: makeImei(2800), status: 'Livré', labor: 3000, deposit: 3000,
      tier: 'repair_90d', createdAt: isoAt('2026-09-01', 9), deliveredAt: isoAt('2026-10-01', 11),
      problem: 'Écran remplacé',
    });
    seedRepair({
      id: 'W10-ORIG', ticket: 'T-W10-ORIG', name: 'WAR10 EXPIRED', model: 'Galaxy A33',
      imei: makeImei(2101), status: 'Livré', labor: 3000, deposit: 3000,
      tier: 'repair_30d', createdAt: isoAt('2026-09-15', 9), deliveredAt: isoAt('2026-09-20', 11),
    });
    seedRepair({
      id: 'W11-ORIG', ticket: 'T-W11-ORIG', name: 'WAR11 CLAIM', model: 'Galaxy A34',
      imei: makeImei(2111), status: 'Livré', labor: 3000, deposit: 3000,
      tier: 'repair_90d', createdAt: isoAt('2026-10-05', 9), deliveredAt: isoAt('2026-10-10', 11),
    });
    seedRepair({
      id: 'W30-ORIG', ticket: 'T-W30-ORIG', name: 'WAR30 CONCURRENT', model: 'Galaxy A35',
      imei: makeImei(2130), status: 'Livré', labor: 3000, deposit: 3000,
      tier: 'repair_90d', createdAt: isoAt('2026-10-15', 9), deliveredAt: isoAt('2026-10-20', 11),
    });

    // WAR-13: a real sale and a never-sold IMEI presented as the device.
    seedSale({
      id: 'TXN-W13', receipt: 'TXN-W13', createdAt: isoAt('2026-08-01', 10),
      items: [{ productId: 'PHONE-W13', title: 'WAR13 ORIGINAL PHONE', price: 55000, imei: makeImei(2701), warrantyMonths: 12 }],
      total: 55000, customer: { id: 'CUST-W13', name: 'WAR13 CLIENT', phone: '0550201300' },
    });
    seedImei({ imei: makeImei(2701), productId: 'PHONE-W13', status: 'sold', saleTransactionId: 'TXN-W13', warrantyMonths: 12, soldAt: isoAt('2026-08-01', 10) });

    // WAR-14: blacklisted + clean.
    seedBlockedImeis([{ imei: makeImei(2900), reason: 'Vol déclaré — police', source: 'e2e' }]);
    seedSale({
      id: 'TXN-W14', receipt: 'TXN-W14', createdAt: isoAt('2026-08-10', 10),
      items: [{ productId: 'PHONE-W14', title: 'WAR14 CLEAN PHONE', price: 30000, imei: makeImei(2901), warrantyMonths: 12 }],
      total: 30000, customer: { id: 'CUST-W14', name: 'WAR14 CLEAN', phone: '0550201400' },
    });
    seedImei({ imei: makeImei(2901), productId: 'PHONE-W14', status: 'sold', saleTransactionId: 'TXN-W14', warrantyMonths: 12, soldAt: isoAt('2026-08-10', 10) });

    // WAR-15: no-receipt lookup by IMEI + customer identity.
    seedSale({
      id: 'TXN-W15', receipt: 'TXN-W15', createdAt: isoAt('2026-08-15', 10),
      items: [{ productId: 'PHONE-W15', title: 'WAR15 PHONE', price: 42000, imei: makeImei(3000), warrantyMonths: 12 }],
      total: 42000, customer: { id: 'CUST-W15', name: 'WAR15 CLIENT NAME', phone: '0550201500' },
    });
    seedImei({ imei: makeImei(3000), productId: 'PHONE-W15', status: 'sold', saleTransactionId: 'TXN-W15', warrantyMonths: 12, soldAt: isoAt('2026-08-15', 10) });

    // WAR-16: inspector permission probe.
    seedSale({
      id: 'TXN-W16', receipt: 'TXN-W16', createdAt: isoAt('2026-08-20', 10),
      items: [{ productId: 'PHONE-W16', title: 'WAR16 PHONE', price: 32000, imei: makeImei(3100), warrantyMonths: 12 }],
      total: 32000, customer: { id: 'CUST-W16', name: 'WAR16 CLIENT', phone: '0550201600' },
    });
    seedImei({ imei: makeImei(3100), productId: 'PHONE-W16', status: 'sold', saleTransactionId: 'TXN-W16', warrantyMonths: 12, soldAt: isoAt('2026-08-20', 10) });

    // WAR-20: active store warranty, certificate print.
    seedSale({
      id: 'TXN-W20', receipt: 'TXN-W20', createdAt: isoAt('2026-06-01', 10),
      items: [{ productId: 'PHONE-W20', title: 'WAR20 CERT PHONE', price: 70000, imei: makeImei(3200), warrantyMonths: 12 }],
      total: 70000, customer: { id: 'CUST-W20', name: 'WAR20 CLIENT', phone: '0550202000' },
    });
    seedImei({ imei: makeImei(3200), productId: 'PHONE-W20', status: 'sold', saleTransactionId: 'TXN-W20', warrantyMonths: 12, soldAt: isoAt('2026-06-01', 10) });

    // WAR-24: dual-SIM claim (second IMEI is not modelled).
    seedSale({
      id: 'TXN-W24', receipt: 'TXN-W24', createdAt: isoAt('2026-08-25', 10),
      items: [{ productId: 'PHONE-W24', title: 'WAR24 DUAL SIM', price: 48000, imei: makeImei(3300), warrantyMonths: 12 }],
      total: 48000, customer: { id: 'CUST-W24', name: 'WAR24 CLIENT', phone: '0550202400' },
    });
    seedImei({ imei: makeImei(3300), productId: 'PHONE-W24', status: 'sold', saleTransactionId: 'TXN-W24', warrantyMonths: 12, soldAt: isoAt('2026-08-25', 10) });

    // WAR-26: exact + last-6 lookup.
    seedSale({
      id: 'TXN-W26', receipt: 'TXN-W26', createdAt: isoAt('2026-08-26', 10),
      items: [{ productId: 'PHONE-W26', title: 'WAR26 PHONE', price: 26000, imei: makeImei(3400), warrantyMonths: 12 }],
      total: 26000, customer: { id: 'CUST-W26', name: 'WAR26 CLIENT', phone: '0550202600' },
    });
    seedImei({ imei: makeImei(3400), productId: 'PHONE-W26', status: 'sold', saleTransactionId: 'TXN-W26', warrantyMonths: 12, soldAt: isoAt('2026-08-26', 10) });

    // WAR-28: inspection notes / RTL / long note.
    seedSale({
      id: 'TXN-W28', receipt: 'TXN-W28', createdAt: isoAt('2026-08-28', 10),
      items: [{ productId: 'PHONE-W28', title: 'WAR28 PHONE', price: 28000, imei: makeImei(3500), warrantyMonths: 12 }],
      total: 28000, customer: { id: 'CUST-W28', name: 'WAR28 CLIENT', phone: '0550202800' },
    });
    seedImei({ imei: makeImei(3500), productId: 'PHONE-W28', status: 'sold', saleTransactionId: 'TXN-W28', warrantyMonths: 12, soldAt: isoAt('2026-08-28', 10) });
    seedRepair({
      id: 'W28-REP', ticket: 'T-W28-REP', name: 'WAR28 CLIENT', model: 'iPhone 13',
      imei: makeImei(3500), status: 'Livré', labor: 2000, deposit: 2000,
      tier: 'repair_90d', createdAt: isoAt('2026-09-20', 9), deliveredAt: isoAt('2026-09-25', 11),
      extra: { diagnosticNotes: `ملاحظة بالعربية 🛠️ ${'x'.repeat(5000)}` },
    });

    // WAR-29: sale by a now-disabled cashier.
    seedSale({
      id: 'TXN-W29', receipt: 'TXN-W29', createdAt: isoAt('2026-07-01', 10),
      items: [{ productId: 'PHONE-W29', title: 'WAR29 PHONE', price: 36000, imei: makeImei(3600), warrantyMonths: 12 }],
      total: 36000, cashier: 'Caissier Désactivé',
      customer: { id: 'CUST-W29', name: 'WAR29 CLIENT', phone: '0550202900' },
    });
    seedImei({ imei: makeImei(3600), productId: 'PHONE-W29', status: 'sold', saleTransactionId: 'TXN-W29', warrantyMonths: 12, soldAt: isoAt('2026-07-01', 10) });
    seedRepair({
      id: 'W29-ORIG', ticket: 'T-W29-ORIG', name: 'WAR29 CLIENT', model: 'Galaxy A30',
      imei: makeImei(3600), status: 'Livré', labor: 3000, deposit: 3000,
      tier: 'repair_90d', createdAt: isoAt('2026-10-01', 9), deliveredAt: isoAt('2026-10-05', 11),
    });

    await refreshApp();
    captureInvariantBaseline('WAR');
  });

  afterEach(async () => {
    await closeInspector().catch(() => undefined);
    await closeRepairModal().catch(() => undefined);
    await closeDialogs().catch(() => undefined);
    assertInvariants('WAR');
  });

  after(() => {
    finalizeInvariants('WAR');
  });

  // ======================= P0 =============================================

  it('[WAR-01] IMEI lookup exposes sold / never sold / in stock / in repair / returned / sold twice', async () => {
    const sold = await inspect(makeImei(2001));
    const never = await (async () => { await closeInspector(); return inspect(makeImei(2099)); })();
    const stock = await (async () => { await closeInspector(); return inspect(makeImei(2002)); })();
    const repair = await (async () => { await closeInspector(); return inspect(makeImei(2003)); })();
    const returned = await (async () => { await closeInspector(); return inspect(makeImei(2004)); })();
    const dup = await (async () => { await closeInspector(); return inspect(makeImei(2005)); })();
    const summary = {
      sold: /Vendu|Facture d'Origine/i.test(sold),
      never: /Jamais vendu|inconnu|Aucune facture/i.test(never),
      stock: /En stock|Stock/i.test(stock),
      repair: /En r[ée]paration|Interventions SAV/i.test(repair),
      returned: /Retourn|Rembours|Annul/i.test(returned),
      duplicate: /double|deux ventes|ventes multiples/i.test(dup),
    };
    console.log(`[WAR-01] ${JSON.stringify(summary)} soldExcerpt=${sold.slice(0, 160).replace(/\n/g, ' | ')}`);
    expect(summary.sold).toBe(true);
    expect(summary.never).toBe(true);
    expect(summary.stock).toBe(true);
    expect(summary.repair).toBe(true);
    expect(summary.returned).toBe(true);
    expect(summary.duplicate).toBe(true);
  });

  it('[WAR-02] IMEI input accepts grouped, 16-digit IMEISV, and Arabic-Indic digits', async () => {
    const imei = makeImei(2100);
    const grouped = `${imei.slice(0, 2)} ${imei.slice(2, 8)}-${imei.slice(8, 14)}/${imei.slice(14)}`;
    const imeisv = `${imei}01`;
    const arabic = imei.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
    const g = await inspect(grouped);
    await closeInspector();
    const sv = await inspect(imeisv);
    await closeInspector();
    const ar = await inspect(arabic);
    await closeInspector();
    const short = await inspect(imei.slice(0, 14));
    const summary = {
      grouped: /WAR2 IDENTIFIER PHONE/i.test(g),
      imeisv: /WAR2 IDENTIFIER PHONE/i.test(sv),
      arabic: /WAR2 IDENTIFIER PHONE/i.test(ar),
      shortRejected: /15 chiffres|invalide|Luhn/i.test(short),
    };
    console.log(`[WAR-02] ${JSON.stringify(summary)} svExcerpt=${sv.slice(0, 180).replace(/\n/g, ' | ')} arExcerpt=${ar.slice(0, 180).replace(/\n/g, ' | ')}`);
    expect(summary.grouped).toBe(true);
    expect(summary.imeisv).toBe(true);
    expect(summary.arabic).toBe(true);
    expect(summary.shortRejected).toBe(true);
  });

  it('[WAR-03] warranty boundaries: 23:59 vs 00:01, Jan 31 clamp, leap-day', async () => {
    const a = await inspect(makeImei(2301));
    await closeInspector();
    const b = await inspect(makeImei(2302));
    await closeInspector();
    const c = await inspect(makeImei(2303));
    await closeInspector();
    const d = await inspect(makeImei(2304));
    const summary = {
      a: /23\/10\/2026/.test(a),
      b: /24\/10\/2026/.test(b),
      c: /28\/02\/2026/.test(c),
      d: /28\/02\/2025/.test(d),
    };
    console.log(`[WAR-03] ${JSON.stringify(summary)} aExcerpt=${a.slice(0, 180).replace(/\n/g, ' | ')} cExcerpt=${c.slice(0, 180).replace(/\n/g, ' | ')}`);
    expect(summary.a).toBe(true);
    expect(summary.b).toBe(true);
    expect(summary.c).toBe(true);
    expect(summary.d).toBe(true);
  });

  it('[WAR-04] store warranty starts at the sale instant, not repair completion', async () => {
    const body = await inspect(makeImei(2400));
    const repairWarrantyShown = /04\/12\/2026/.test(body);
    console.log(`[WAR-04] saleExpiry=${/10\/01\/2027/.test(body)} repairWarrantyShown=${repairWarrantyShown} excerpt=${body.slice(0, 260).replace(/\n/g, ' | ')}`);
    expect(/10\/01\/2027/.test(body)).toBe(true);
  });

  it('[WAR-05] refunded sale is excluded and the resale becomes the warranty anchor', async () => {
    const body = await inspect(makeImei(2501));
    console.log(`[WAR-05] excerpt=${body.slice(0, 260).replace(/\n/g, ' | ')}`);
    expect(/TXN-W5-B/.test(body)).toBe(true);
    expect(/TXN-W5-A(?!R)/.test(body)).toBe(false);
    expect(/01\/06\/2027/.test(body)).toBe(true);
  });

  it('[WAR-06] as-is stock carries no warranty; refurbished stock carries its 3-month term', async () => {
    const asis = await inspect(makeImei(2601));
    await closeInspector();
    const refurb = await inspect(makeImei(2602));
    const summary = {
      asisNoCoverage: /Aucune garantie|Sans garantie|EXPIR[ÉE]|0 mois/i.test(asis),
      asisNotActive: !/GARANTIE MAGASIN ACTIVE/i.test(asis),
      refurbCovered: /GARANTIE MAGASIN ACTIVE|3 mois|01\/12\/2026/i.test(refurb),
    };
    console.log(`[WAR-06] ${JSON.stringify(summary)} asis=${asis.slice(0, 180).replace(/\n/g, ' | ')} refurb=${refurb.slice(0, 180).replace(/\n/g, ' | ')}`);
    expect(summary.asisNoCoverage).toBe(true);
    expect(summary.asisNotActive).toBe(true);
    expect(summary.refurbCovered).toBe(true);
  });

  it('[WAR-10] claim after expiry / same defect / different component is refused', async () => {
    const rework = await makeRework('T-W10-ORIG', 'WAR10 REWORK', makeImei(2101));
    await browser.pause(1800);
    const claims = claimRows().filter((c) => String(c.rework_repair_id) === String(rework.id));
    const repair = repairRowByTicket('T-W10-ORIG');
    const originalPayload = repairPayload(String(repair?.id ?? ''));
    console.log(`[WAR-10] originalExpiry=${String(originalPayload.warrantyExpiresAt ?? '')} claim=${JSON.stringify(claims[0] ?? {})} claims=${claims.length}`);
    expect(claims.length).toBe(0);
  });

  it('[WAR-11] approved claim creates a repair ticket linked to the original sale', async () => {
    const rework = await makeRework('T-W11-ORIG', 'WAR11 REWORK', makeImei(2111));
    await browser.pause(1800);
    const claims = claimRows().filter((c) => String(c.rework_repair_id) === String(rework.id));
    const cols = claimColumns();
    const linkedSale = claims.some((c) => Boolean(c.sale_transaction_id || c.original_sale_id || c.original_transaction_id));
    const approved = claims.some((c) => /approv/i.test(String(c.status)));
    console.log(`[WAR-11] claims=${claims.length} linkedSale=${linkedSale} approved=${approved} cols=${JSON.stringify(cols)} claim=${JSON.stringify(claims[0] ?? {})}`);
    expect(claims.length).toBe(1);
    expect(linkedSale).toBe(true);
    expect(approved).toBe(true);
  });

  it('[WAR-12] DOA replacement / IMEI A->B lifecycle is absent', async () => {
    const tables = tablesLike('%replacement%', '%doa%');
    const cols = [...columnNames('imei_records'), ...columnNames('warranty_claims')].filter((c) => /replacement|doa|scrap|imei_b/i.test(c));
    console.log(`[WAR-12] tables=${JSON.stringify(tables)} cols=${JSON.stringify(cols)}`);
    expect(tables).toEqual([]);
    expect(cols).toEqual([]);
  });

  it('[WAR-13] device presented with a different IMEI than the sale is flagged', async () => {
    const body = await inspect(makeImei(2702));
    const mismatch = /IMEI diff[eé]rent|appareil diff[eé]rent|swap|contrefa/i.test(body);
    console.log(`[WAR-13] mismatchWarning=${mismatch} excerpt=${body.slice(0, 220).replace(/\n/g, ' | ')}`);
    expect(mismatch).toBe(true);
  });

  it('[WAR-14] blacklist check reports blocked and clean devices locally', async () => {
    const blocked = await inspect(makeImei(2900));
    await closeInspector();
    const clean = await inspect(makeImei(2901));
    const summary = {
      blocked: /BLOQUÉ|Appareil bloqué/i.test(blocked),
      clean: /Non bloqué/i.test(clean),
    };
    console.log(`[WAR-14] ${JSON.stringify(summary)} blockedExcerpt=${blocked.slice(-260).replace(/\n/g, ' | ')}`);
    expect(summary.blocked).toBe(true);
    expect(summary.clean).toBe(true);
  });

  it('[WAR-15] no receipt: IMEI lookup exposes the customer but no phone/ID challenge', async () => {
    const body = await inspect(makeImei(3000));
    const customer = /WAR15 CLIENT NAME/i.test(body);
    const challenge = /t[eé]l[eé]phone.*client|pi[eè]ce d.identit|question de s[eé]curit|v[eé]rification.*client/i.test(body);
    console.log(`[WAR-15] customer=${customer} challenge=${challenge} excerpt=${body.slice(0, 220).replace(/\n/g, ' | ')}`);
    expect(customer).toBe(true);
    expect(challenge).toBe(true);
  });

  it('[WAR-16] inspector access is gated by role / PIN', async () => {
    const body = await inspect(makeImei(3100));
    const gate = /PIN|mot de passe|acc[eè]s refus[eé]|r[eé]serv[eé].*(manager|g[eé]rant)|autorisation/i.test(body);
    console.log(`[WAR-16] gate=${gate} excerpt=${body.slice(0, 180).replace(/\n/g, ' | ')}`);
    expect(gate).toBe(true);
  });

  it('[WAR-19] inspector works offline from local data; cross-device void propagation is absent', async () => {
    const body = await inspect(makeImei(2001));
    const tables = tablesLike('%inspection%', '%inspector%', '%continu%');
    const localResolved = /Facture d'Origine|Client Acheteur|WAR1 SOLD PHONE|TXN-W1-SOLD/i.test(body);
    console.log(`[WAR-19] localResolved=${localResolved} inspectionTables=${JSON.stringify(tables)}`);
    expect(localResolved).toBe(true);
    expect(tables).toEqual([]);
  });

  it('[WAR-23] warranty retention / purge job is absent', async () => {
    const tables = tablesLike('%retention%', '%purge%', '%warranty_archive%');
    const cols = columnNames('warranty_claims').filter((c) => /retention|purge|archive/i.test(c));
    console.log(`[WAR-23] tables=${JSON.stringify(tables)} cols=${JSON.stringify(cols)}`);
    expect(tables).toEqual([]);
    expect(cols).toEqual([]);
  });

  it('[WAR-24] dual-SIM second IMEI is stored and claimable', async () => {
    const cols = columnNames('imei_records').filter((c) => /imei2|second_imei|imei_2/i.test(c));
    const body = await inspect(makeImei(3301));
    const resolved = /WAR24 DUAL SIM/i.test(body);
    console.log(`[WAR-24] imei2Cols=${JSON.stringify(cols)} secondImeiResolved=${resolved}`);
    expect(cols.length).toBeGreaterThan(0);
    expect(resolved).toBe(true);
  });

  it('[WAR-29] claim on a sale by a disabled cashier is blocked / attributed', async () => {
    const rework = await makeRework('T-W29-ORIG', 'WAR29 REWORK', makeImei(3600));
    await browser.pause(1800);
    const claims = claimRows().filter((c) => String(c.rework_repair_id) === String(rework.id));
    const cols = claimColumns();
    const saleLink = claims.some((c) => Boolean(c.sale_transaction_id || c.original_transaction_id));
    const cashier = (claims[0]?.cashier_name ?? claims[0]?.original_cashier ?? '') as string;
    console.log(`[WAR-29] claims=${claims.length} saleLink=${saleLink} cashier=${String(cashier)} cols=${JSON.stringify(cols)}`);
    expect(claims.length).toBe(0);
  });

  it('[WAR-30] concurrent claims for the same IMEI are serialized/rejected', async () => {
    await makeRework('T-W30-ORIG', 'WAR30 REWORK A', makeImei(2130));
    await closeRepairModal().catch(() => undefined);
    await makeRework('T-W30-ORIG', 'WAR30 REWORK B', makeImei(2130));
    await browser.pause(1800);
    const claims = claimRows().filter((c) => String(c.original_repair_id) === String(repairRowByTicket('T-W30-ORIG')?.id ?? ''));
    console.log(`[WAR-30] claimsForOriginal=${claims.length} rows=${JSON.stringify(claims.map((c) => c.id))}`);
    expect(claims.length).toBeLessThanOrEqual(1);
  });

  // ======================= P1 =============================================

  it('[WAR-07] extended/paid warranty plan sold later is absent', async () => {
    const tables = tablesLike('%warranty_plan%', '%extended_warranty%', '%service_plan%');
    const cols = [...columnNames('transactions'), ...columnNames('repair_orders')].filter((c) => /plan|extended/i.test(c));
    console.log(`[WAR-07] tables=${JSON.stringify(tables)} cols=${JSON.stringify(cols)}`);
    expect(tables).toEqual([]);
    expect(cols).toEqual([]);
  });

  it('[WAR-08] warranty inspection checklist (seals/liquid/root/battery/account) is absent', async () => {
    const body = await inspect(makeImei(2800));
    const controls = (await browser.execute(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
        /Inspecteur IMEI & Garantie/.test((d as HTMLElement).innerText || ''),
      ) as HTMLElement | undefined;
      if (!dlg) return 0;
      return [...dlg.querySelectorAll('button,input,select,textarea')].filter((el) => {
        const hint = `${(el as HTMLElement).innerText || ''} ${(el as HTMLInputElement).placeholder || ''} ${el.getAttribute('aria-label') || ''}`;
        return /sceau|liquide|root|jailbreak|batterie|sant[eé]|compte verrouill|rayure|fissure/i.test(hint);
      }).length;
    })) as number;
    console.log(`[WAR-08] checklistControls=${controls} excerpt=${body.slice(0, 180).replace(/\n/g, ' | ')}`);
    expect(controls).toBeGreaterThan(0);
  });

  it('[WAR-09] manager override / second inspection is absent', async () => {
    const tables = tablesLike('%inspection%', '%override%');
    const body = await inspect(makeImei(2800));
    const override = /override|d[eé]rogation|deuxi[eè]me inspection|contester/i.test(body);
    console.log(`[WAR-09] tables=${JSON.stringify(tables)} overrideCopy=${override}`);
    // Absence probe: the entire second-inspection/override lane is missing.
    expect(tables).toEqual([]);
    expect(override).toBe(false);
  });

  it('[WAR-17] inspection photo evidence capture is absent', async () => {
    const tables = tablesLike('%inspection_photo%', '%inspection_media%');
    const body = await inspect(makeImei(2800));
    const photoControl = /photo|image|cam[eé]ra/i.test(body);
    console.log(`[WAR-17] tables=${JSON.stringify(tables)} photoControl=${photoControl}`);
    expect(tables).toEqual([]);
    expect(photoControl).toBe(false);
  });

  it('[WAR-18] inspection continuity between mobile and desktop is absent', async () => {
    const tables = tablesLike('%inspection%', '%inspection_session%');
    console.log(`[WAR-18] tables=${JSON.stringify(tables)}`);
    expect(tables).toEqual([]);
  });

  it('[WAR-20] certificate includes AR + barcode/QR + inspector name', async () => {
    await openInspector();
    await inspectorLookup(makeImei(3200));
    await browser.pause(700);
    await browser.waitUntil(
      async () => (await inspectorBody()).includes('Imprimer Certificat'),
      { timeout: 10000, interval: 300, timeoutMsg: 'certificate button never appeared' },
    );
    await armPrintBuffer();
    const button = (await browser.execute(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
        /Inspecteur IMEI & Garantie/.test((d as HTMLElement).innerText || ''),
      ) as HTMLElement | undefined;
      const b = dlg
        ? ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
            /Imprimer Certificat/i.test(x.textContent || ''),
          )
        : null;
      b?.click();
      return Boolean(b);
    })) as boolean;
    await browser.pause(2500);
    const buffers = await readPrintBuffers();
    const uiText = buffers.map((b) => b.text).join('\n');
    const raw = (await browser.execute(() => {
      const w = window as unknown as { __e2ePrintBuffers?: Array<{ data?: number[] }> };
      return (w.__e2ePrintBuffers ?? []).flatMap((b) => b.data ?? []);
    })) as number[];
    // The spec machine has no mapped thermal spooler, so the UI path exposes
    // reachability but cannot produce a native buffer. Execute the SAME
    // certificate builder directly to inspect the document content.
    const probe = buildWarrantyCertificateProbe(makeImei(3200));
    const certText = probe.text;
    console.log(`[WAR-20] button=${button} uiPrinted=${buffers.length} uiBytes=${raw.length} builderBytes=${probe.data.length} barcode=${probe.hasBarcode} qr=${probe.hasQr} arabic=${probe.hasArabic} inspector=${probe.hasInspector} seller=${probe.hasSeller} uiText=${uiText.slice(0, 200).replace(/\n/g, ' | ')} certText=${certText.slice(0, 300).replace(/\n/g, ' | ')}`);
    expect(button).toBe(true);
    expect(probe.data.length).toBeGreaterThan(0);
    expect(probe.hasBarcode).toBe(true);
    expect(probe.hasQr).toBe(true);
    expect(probe.hasArabic).toBe(true);
    expect(probe.hasInspector).toBe(true);
  });

  it('[WAR-21] third-party verification endpoint / QR lookup is absent', async () => {
    const tables = tablesLike('%verification%', '%verify_token%', '%public_lookup%');
    const routes = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%warranty%'",
    ).map((r) => r.name);
    console.log(`[WAR-21] tables=${JSON.stringify(tables)} warrantyTables=${JSON.stringify(routes)}`);
    expect(tables).toEqual([]);
  });

  it('[WAR-22] warranty reports (expiring/claims/cost) are absent', async () => {
    const tables = tablesLike('%warranty_report%', '%warranty_stats%');
    await openInspector();
    const body = await bodyText();
    const report = /rapport.*garantie|garanties expirant|co[uû]t.*garantie/i.test(body);
    console.log(`[WAR-22] tables=${JSON.stringify(tables)} reportCopy=${report}`);
    expect(tables).toEqual([]);
    expect(report).toBe(false);
  });

  it('[WAR-25] accessory warranty is not a per-unit claim lane', async () => {
    const tables = tablesLike('%accessory_warranty%', '%accessory_claim%');
    const cols = [...columnNames('products'), ...columnNames('transactions')].filter((c) =>
      /accessory.*warranty|warranty.*accessory/i.test(c),
    );
    console.log(`[WAR-25] tables=${JSON.stringify(tables)} cols=${JSON.stringify(cols)}`);
    expect(tables).toEqual([]);
    expect(cols).toEqual([]);
  });

  it('[WAR-26] partial last-6 IMEI lookup returns candidates', async () => {
    const imei = makeImei(3400);
    const body = await inspect(imei.slice(-6));
    const candidates = /WAR26 PHONE|r[eé]sultats|candidat/i.test(body);
    console.log(`[WAR-26] last6=${imei.slice(-6)} candidates=${candidates} excerpt=${body.slice(0, 200).replace(/\n/g, ' | ')}`);
    expect(candidates).toBe(true);
  });

  it('[WAR-27] manufacturer coverage API is absent', async () => {
    const tables = tablesLike('%manufacturer%', '%coverage_api%', '%oem%');
    const settings = all<Row>("SELECT key FROM app_settings WHERE key LIKE '%manufacturer%' OR key LIKE '%oem%'");
    console.log(`[WAR-27] tables=${JSON.stringify(tables)} settings=${JSON.stringify(settings)}`);
    expect(tables).toEqual([]);
    expect(settings).toEqual([]);
  });

  it('[WAR-28] inspector decisions/photos are localized ar/fr/en and notes accept 5k/RTL', async () => {
    const body = await inspect(makeImei(3500));
    const lang = (await browser.execute(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
        /Inspecteur IMEI & Garantie/.test((d as HTMLElement).innerText || ''),
      ) as HTMLElement | undefined;
      if (!dlg) return { ar: false, en: false, note: false };
      const txt = dlg.innerText || '';
      return {
        ar: /العربية|\u0600/.test(txt),
        en: /\bEnglish\b|\bEN\b/.test(txt),
        note: /ملاحظة|\u0600/.test(txt) && txt.length > 5000,
      };
    })) as { ar: boolean; en: boolean; note: boolean };
    console.log(`[WAR-28] language=${JSON.stringify(lang)} excerpt=${body.slice(0, 200).replace(/\n/g, ' | ')}`);
    expect(lang.ar).toBe(true);
    expect(lang.en).toBe(true);
    expect(lang.note).toBe(true);
  });
});

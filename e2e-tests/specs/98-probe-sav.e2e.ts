/**
 * Temporary probe — REP/WAR helper validation (not part of the final matrix).
 * Run: npx wdio run e2e-tests/wdio.conf.ts --spec e2e-tests/specs/98-probe-sav.e2e.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { browser, expect } from '@wdio/globals';
import { DB_PATH, DB_DIR } from '../lib/env';
import { one, run, waitForSchemaSettled } from '../lib/db';
import { installErrorTrap, tid } from '../lib/pos';
import { resetData, seedProducts } from '../lib/seed';
import {
  assertInvariants,
  captureInvariantBaseline,
  finalizeInvariants,
} from '../lib/invariants';
import {
  bodyText,
  cardText,
  claimRows,
  closeRepairModal,
  deliverViaStatus,
  fillIntake,
  inspectorBody,
  inspectorLookup,
  makeImei,
  newRepair,
  openHistoryTab,
  openInspector,
  openRepairModal,
  refreshApp,
  repairPayload,
  saveRepairWait,
  seedHistoricSession,
  seedImei,
  seedRepair,
  seedSale,
  setCardStatus,
  setHistorySearch,
  isoAt,
  writeAttachment,
} from '../lib/sav';

const IMEI_UI = makeImei(900001);
const IMEI_SEED = makeImei(900002);
const IMEI_ZERO = makeImei(900003);
const IMEI_SALE = makeImei(900004);

describe('PROBE SAV helpers', () => {
  before(async () => {
    await installErrorTrap();
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    await waitForSchemaSettled();
    resetData();
    seedProducts([
      { id: 'PROBE-PART', title: 'PROBE PART', priceDa: 500, stock: 5, costDa: 200, barcode: 'PROBEPART01' },
      { id: 'PROBE-PHONE', title: 'PROBE PHONE', priceDa: 30000, stock: 1, costDa: 20000, isSerialized: true, barcode: 'PROBEPHONE1' },
    ]);
    seedHistoricSession();
    seedSale({
      id: 'PROBE-SALE-1',
      receipt: 'REC-PROBE-1',
      createdAt: isoAt('2026-01-31', 23, 59),
      items: [{ productId: 'PROBE-PHONE', title: 'PROBE PHONE', price: 30000, imei: IMEI_SALE, warrantyMonths: 12 }],
      customer: { id: 'CUST-PROBE', name: 'Probe Client', phone: '0550111222' },
      shiftId: 'E2E-HIST-SESSION',
    });
    seedImei({
      imei: IMEI_SALE,
      productId: 'PROBE-PHONE',
      status: 'sold',
      saleTransactionId: 'PROBE-SALE-1',
      soldAt: isoAt('2026-01-31', 23, 59),
      warrantyExpiresAt: isoAt('2027-01-31', 23, 59),
      warrantyMonths: 12,
    });
    seedRepair({
      id: 'PROBE-SEED',
      ticket: 'T-PROBE-SEED',
      name: 'PROBE SEED',
      phone: '0550222333',
      model: 'Galaxy Seed',
      imei: IMEI_SEED,
      status: 'Prêt / Terminé',
      labor: 2000,
      parts: 0,
      deposit: 1000,
      tier: 'repair_30d',
      createdAt: isoAt('2026-10-01', 9),
    });
    seedRepair({
      id: 'PROBE-ZERO',
      ticket: 'T-PROBE-ZERO',
      name: 'PROBE ZERO',
      phone: '0550333444',
      model: 'Galaxy Zero',
      imei: IMEI_ZERO,
      status: 'Prêt / Terminé',
      labor: 1000,
      parts: 0,
      deposit: 1000,
      tier: 'repair_90d',
      createdAt: isoAt('2026-10-01', 10),
    });
    await refreshApp();
    // G-26 clean fixture: a real native file with a non-draft order id.
    const cleanRef = await writeAttachment('PROBE-G26', 0);
    seedRepair({
      id: 'PROBE-G26',
      ticket: 'T-PROBE-G26',
      name: 'PROBE G26',
      phone: '0550555666',
      model: 'Galaxy G26',
      imei: makeImei(900005),
      status: 'Livré',
      labor: 1000,
      parts: 0,
      deposit: 1000,
      tier: 'repair_30d',
      deliveredAt: isoAt('2026-10-10', 11),
      photos: [cleanRef],
      createdAt: isoAt('2026-10-05', 9),
    });
    captureInvariantBaseline('PROBE');
  });

  afterEach(async function () {
    await closeRepairModal().catch(() => undefined);
    assertInvariants(`PROBE :: ${String((this as any).currentTest?.title ?? '')}`);
  });

  after(async () => {
    finalizeInvariants('PROBE sav helpers');
  });

  it('PROBE-1 UI intake persists v2 evidence + photo draft', async () => {
    await openRepairModal();
    await fillIntake({
      name: 'PROBE UI',
      phone: '0550444555',
      model: 'Galaxy Probe',
      problem: 'Écran fissuré probe',
      imei: IMEI_UI,
      labor: 2000,
      parts: 0,
      deposit: 500,
      tierLabel: 'Garantie réparation 90 jours',
      photos: 1,
    });
    const row = await saveRepairWait('PROBE UI');
    const p = repairPayload(String(row.id));
    console.log('[PROBE-1] row=', JSON.stringify({ id: row.id, ticket: row.ticket_number, status: row.status, total: row.total_cost, deposit: row.deposit_amount }));
    console.log('[PROBE-1] payload keys=', Object.keys(p).join(','));
    console.log('[PROBE-1] schema=', p.schemaVersion, 'sig=', String(p.signatureCustomerIntake ?? '').slice(0, 24), 'terms=', p.legalTermsAcceptedAt, 'photos=', JSON.stringify(p.intakePhotos));
    expect(Number(p.schemaVersion)).toBe(2);
    expect(String(p.signatureCustomerIntake)).toMatch(/^data:image\//);
    expect(String(p.legalTermsAcceptedAt ?? '')).toBeTruthy();
    const photos = (p.intakePhotos ?? []) as Array<Record<string, unknown>>;
    expect(photos.length).toBe(1);
    const rel = String(photos[0].relativePath ?? '');
    console.log('[PROBE-1] photo rel=', rel, 'sha=', String(photos[0].sha256 ?? '').slice(0, 16), 'size=', photos[0].byteSize);
    expect(rel.startsWith('sav_attachments/')).toBe(true);
    const abs = path.join(DB_DIR, rel);
    expect(fs.existsSync(abs)).toBe(true);
    expect(String(photos[0].sha256 ?? '')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('PROBE-2 seeded repair hydrates; card status; balance gate; zero-balance delivery', async () => {
    await openRepairModal();
    await openHistoryTab();
    await setHistorySearch('T-PROBE-SEED');
    const txt = await cardText('T-PROBE-SEED');
    console.log('[PROBE-2] card=', txt.replace(/\s+/g, ' ').slice(0, 260));
    expect(txt).toContain('PROBE SEED');
    expect(txt).toContain('Prêt / Terminé');

    // Unpaid Livré must be refused.
    await setCardStatus('T-PROBE-SEED', 'Livré');
    await browser.pause(700);
    const seedStatus = one<{ status: string }>("SELECT status FROM repair_orders WHERE id='PROBE-SEED'");
    console.log('[PROBE-2] unpaid Livré attempt status=', seedStatus?.status, 'body=', (await bodyText()).replace(/\s+/g, ' ').slice(-200));
    expect(String(seedStatus?.status)).toBe('Prêt / Terminé');

    // Zero-balance delivery works.
    await openRepairModal().catch(() => undefined);
    await openHistoryTab().catch(() => undefined);
    await setHistorySearch('T-PROBE-ZERO');
    const delivered = await deliverViaStatus('T-PROBE-ZERO');
    const z = one<Record<string, unknown>>("SELECT * FROM repair_orders WHERE id='PROBE-ZERO'");
    const zp = repairPayload('PROBE-ZERO');
    console.log('[PROBE-2] delivered=', delivered, 'status=', z?.status, 'deliveredAt=', zp.deliveredAt, 'expiry=', zp.warrantyExpiresAt);
    expect(delivered).toBe(true);
    expect(String(z?.status)).toBe('Livré');
    expect(String(zp.deliveredAt ?? '')).toBeTruthy();
    expect(String(zp.warrantyExpiresAt ?? '')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('PROBE-3 inspector resolves a seeded sale + warranty dates', async () => {
    await openInspector();
    await inspectorLookup(IMEI_SALE);
    const body = await inspectorBody();
    console.log('[PROBE-3] inspector=', body.replace(/\s+/g, ' ').slice(0, 600));
    expect(body).toContain('PROBE PHONE');
    expect(body).toContain('TXN-');
    expect(body).toMatch(/31\/01\/2027|2027-01-31/);
    expect(body).toContain('GARANTIE MAGASIN ACTIVE');
  });

  it('PROBE-4 G-26 flags a committed draft_* attachment', async () => {
    const draftRef = await writeAttachment(`draft_${Date.now()}`, 0);
    seedRepair({
      id: 'PROBE-DRAFT',
      ticket: 'T-PROBE-DRAFT',
      name: 'PROBE DRAFT',
      phone: '0550666777',
      model: 'Galaxy Draft',
      imei: makeImei(900006),
      status: 'Livré',
      labor: 1000,
      parts: 0,
      deposit: 1000,
      tier: 'repair_30d',
      deliveredAt: isoAt('2026-10-11', 11),
      photos: [draftRef],
      createdAt: isoAt('2026-10-06', 9),
    });
    console.log('[PROBE-4] draft ref=', JSON.stringify(draftRef));
    expect(draftRef.relativePath).toMatch(/sav_attachments\/draft_/);
  });
});

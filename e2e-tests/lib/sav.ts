/**
 * SAV / warranty shared harness helpers (REP batch 18, WAR batch 19).
 *
 * Everything here is OUT-OF-BAND seeding plus real-UI driving:
 *  - `seedRepair` / `seedSale` / `seedImei` write the same shapes the app's
 *    own adapters read (repair_orders.json_payload, transactions.json_payload,
 *    imei_records columns) so a SQLite seed hydrates after `clearWebMirrors()`.
 *  - The UI helpers drive the shipped RepairWorkOrderModal and
 *    ImeiWarrantyInspectorModal (no app-source edits).
 *
 * Invariant-safe: seeded delivered tickets are schema-v2 with a real signature
 * data URL, legal terms timestamp, damage constat and a Luhn-valid IMEI; seeded
 * sales carry device_id + shift_id + unique receipt numbers; refunds carry a
 * refund_dedup row (G-34) and sync_status='synced' (the native trigger).
 */
import fs from 'node:fs';
import path from 'node:path';
import { $, browser } from '@wdio/globals';
import { all, columnNames, one, run, tx } from './db';
import {
  APP_PIN,
  clearWebMirrors,
  closeDialogs,
  ensureShiftOpen,
  installPageShims,
  tid,
  typeMoneyInto,
  unlockIfNeeded,
} from './pos';
import { pageClick, pageClickByText, pageClickByTitle, pageClickSelector } from './pageClick';
import { describeClickDecision } from './clickGuard';

type Row = Record<string, unknown>;

export const REPAIR_MODAL_TITLE = 'Gestion des Réparations & Tickets SAV';
export const INSPECTOR_TITLE = 'Inspecteur Traçabilité IMEI & Modèles Téléphones (Cliquez pour ouvrir)';

const DAY_MS = 86_400_000;

/** 1x1 transparent PNG — a valid `data:image/` signature for v2 evidence. */
export const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** Tiny real PNG used for the photo-attachment upload path. */
export function tinyPngPath(): string {
  const dir = path.join(process.cwd(), 'results');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'e2e-tiny.png');
  if (!fs.existsSync(p)) {
    fs.writeFileSync(
      p,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
        'base64',
      ),
    );
  }
  return p;
}

// ---------------------------------------------------------------------------
// date / IMEI utilities
// ---------------------------------------------------------------------------

export function isoAt(day: string, hh = 10, mm = 0, ss = 0): string {
  // `day` is YYYY-MM-DD; the instant is UTC.
  return `${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.000Z`;
}

export function dayPlus(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const TIER_DAYS: Record<string, number> = {
  none: 0,
  test_7d: 7,
  repair_30d: 30,
  repair_90d: 90,
  repair_180d: 180,
};

export function expiryFor(deliveredAt: string, tier: string): string {
  const d = new Date(deliveredAt);
  if (Number.isNaN(d.getTime())) return '';
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  utc.setUTCDate(utc.getUTCDate() + (TIER_DAYS[tier] ?? 0));
  return utc.toISOString().slice(0, 10);
}

export function luhnCheckDigit14(p14: string): string {
  let sum = 0;
  for (let i = 0; i < p14.length; i++) {
    let n = Number(p14[p14.length - 1 - i]);
    if (i % 2 === 0) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return String((10 - (sum % 10)) % 10);
}

/** Deterministic Luhn-valid 15-digit IMEI from a 9-digit seed. */
export function makeImei(seed9: number): string {
  const p14 = `35892${String(500000000 + seed9).padStart(9, '0')}`;
  return p14 + luhnCheckDigit14(p14);
}

// ---------------------------------------------------------------------------
// boot / refresh
// ---------------------------------------------------------------------------

export async function bootUnlock(): Promise<void> {
  try {
    await unlockIfNeeded(APP_PIN);
  } catch (e) {
    console.log('[SAV boot] unlockIfNeeded:', String((e as Error)?.message ?? e));
  }
  const locked = await $(tid('lock-screen'))
    .isDisplayed()
    .catch(() => false);
  if (!locked) return;
  // The profile tile and the submit button are page clicks: guard them so a
  // late overlay (or a second modal) cannot swallow or redirect the unlock.
  await pageClick('lock-profile-usr-admin', {
    label: 'SAV bootUnlock:profile',
    throwOnRefusal: false,
  });
  await browser.pause(600);
  const input = await $(tid('login-pin-input'));
  if (await input.isDisplayed().catch(() => false)) {
    await input.setValue(APP_PIN);
    await browser.pause(250);
    await pageClick('login-submit', { label: 'SAV bootUnlock:submit', throwOnRefusal: false });
  }
  await browser.waitUntil(
    async () => !(await $(tid('lock-screen')).isDisplayed().catch(() => false)),
    { timeout: 20000, interval: 300, timeoutMsg: 'SAV boot unlock failed' },
  );
}

/** Wipe mirrors, reload, unlock, and make sure one shift is open.
 *  `ensureShift:false` is for mid-suite reloads where SQLite already has an
 *  OPEN cash_session: clearing Dexie made ensureShiftOpen try to open a second
 *  shift, and the dialog refused to close. Those probes only need the fresh
 *  repair rows, not a new shift. */
export async function refreshApp(opts: { ensureShift?: boolean } = {}): Promise<void> {
  await clearWebMirrors();
  await browser.pause(900);
  await installPageShims();
  await bootUnlock();
  if (opts.ensureShift !== false) await ensureShiftOpen(10000);
}

export function withConfirmAccepted(): Promise<void> {
  return browser.execute(() => {
    window.confirm = () => true;
  }) as Promise<void>;
}

// ---------------------------------------------------------------------------
// deterministic seeds
// ---------------------------------------------------------------------------

export interface RepairSeed {
  id: string;
  ticket: string;
  name: string;
  phone?: string;
  model?: string;
  imei?: string;
  imeiKind?: 'imei' | 'serial' | 'none';
  status?: string;
  labor?: number;
  parts?: number;
  deposit?: number;
  total?: number;
  createdAt?: string;
  deliveredAt?: string;
  tier?: string;
  expiresAt?: string | null;
  reworkOf?: { id: string; ticket: string };
  spareParts?: Array<{
    id?: string;
    productId: string;
    productTitle: string;
    quantity: number;
    unitPrice: number;
    unitCost?: number;
    isConsumed?: boolean;
    consumedAt?: string;
    batchAllocations?: Array<{ batchId: string; quantity: number; unitCost: number }>;
  }>;
  photos?: Array<Record<string, unknown>>;
  problem?: string;
  schemaVersion?: number;
  signature?: string | null;
  termsAt?: string | null;
  extra?: Row;
}

export function seedRepair(s: RepairSeed): Row {
  const createdAt = s.createdAt ?? isoAt('2026-09-01', 9);
  const status = s.status ?? 'Diagnostic';
  const labor = Math.max(0, Math.round(Number(s.labor ?? 0)));
  const parts = Math.max(0, Math.round(Number(s.parts ?? 0)));
  const total = Math.max(0, Math.round(Number(s.total ?? labor + parts)));
  const deposit = Math.max(0, Math.round(Number(s.deposit ?? 0)));
  const tier = s.tier ?? 'repair_90d';
  const deliveredAt =
    s.deliveredAt ?? (status === 'Livré' ? isoAt('2026-10-01', 11) : undefined);
  const expiresAt =
    s.expiresAt !== undefined
      ? s.expiresAt
      : status === 'Livré' && tier !== 'none'
        ? expiryFor(deliveredAt as string, tier)
        : null;
  const updatedAt = deliveredAt ?? createdAt;

  const spareParts = (s.spareParts ?? []).map((p) => ({
    id: p.id ?? `part-${s.id}-${p.productId}`,
    productId: p.productId,
    productTitle: p.productTitle,
    quantity: p.quantity,
    unitPrice: p.unitPrice,
    unitCost: p.unitCost ?? 0,
    isConsumed: Boolean(p.isConsumed),
    ...(p.isConsumed ? { consumedAt: p.consumedAt ?? deliveredAt ?? createdAt } : {}),
    ...(p.batchAllocations ? { batchAllocations: p.batchAllocations } : {}),
  }));

  const order: Row = {
    id: s.id,
    ticketNumber: s.ticket,
    schemaVersion: s.schemaVersion ?? 2,
    customerName: s.name,
    customerPhone: s.phone ?? '0555000001',
    deviceModel: s.model ?? 'Galaxy S21',
    imei: s.imei ?? '',
    imeiKind: s.imeiKind ?? 'imei',
    problemDescription: s.problem ?? 'Écran fissuré',
    diagnosticNotes: '',
    laborCost: labor,
    partsCost: parts,
    totalCost: total,
    depositAmount: deposit,
    status,
    createdAt,
    updatedAt,
    estimatedCompletionDate: dayPlus(createdAt.slice(0, 10), 3),
    conditionChecklist: {
      screenOk: true,
      faceIdOk: true,
      cameraOk: true,
      chargingOk: true,
      bodyOk: true,
      batteryOk: true,
      audioOk: true,
    },
    postRepairChecklist: {
      screenOk: true,
      faceIdOk: true,
      cameraOk: true,
      chargingOk: true,
      bodyOk: true,
      batteryOk: true,
      audioOk: true,
    },
    intakeDamage: {
      screenCondition: 'intact',
      chassisDamage: ['none'],
      liquidIndicatorTripped: false,
      deviceLock: { type: 'none' },
    },
    signatureCustomerIntake: s.signature === undefined ? TINY_PNG_DATA_URL : s.signature,
    signatureIntakeAt: createdAt,
    legalTermsAcceptedAt: s.termsAt === undefined ? createdAt : s.termsAt,
    warrantyTier: tier,
    intakePhotos: s.photos ?? [],
    spareParts,
    statusHistory: [
      { status: 'Diagnostic', timestamp: createdAt, updatedBy: 'E2E' },
      ...(status !== 'Diagnostic' ? [{ status, timestamp: updatedAt, updatedBy: 'E2E' }] : []),
    ],
    ...(deliveredAt ? { deliveredAt } : {}),
    ...(expiresAt ? { warrantyExpiresAt: expiresAt } : {}),
    ...(s.reworkOf
      ? { reworkOfRepairId: s.reworkOf.id, reworkOfTicketNumber: s.reworkOf.ticket }
      : {}),
    ...(s.extra ?? {}),
  };

  const cols = new Set(columnNames('repair_orders'));
  const row: Record<string, unknown> = {
    id: s.id,
    ticket_number: s.ticket,
    customer_name: s.name,
    customer_phone: String(order.customerPhone),
    device_model: String(order.deviceModel),
    imei: String(order.imei),
    status,
    labor_cost: labor,
    parts_cost: parts,
    total_cost: total,
    deposit_amount: deposit,
    created_at: createdAt,
    updated_at: updatedAt,
    json_payload: JSON.stringify(order),
    parts_cost_basis:
      spareParts.length > 0 && spareParts.every((p) => p.isConsumed)
        ? spareParts.reduce((sum, p) => sum + (p.unitCost ?? 0) * p.quantity, 0)
        : null,
    costing_model: spareParts.length > 0 && spareParts.every((p) => p.isConsumed) ? 'fifo' : null,
    rework_of_repair_id: s.reworkOf?.id ?? null,
    device_id: 'e2e-seed-device',
    idempotency_key: `e2e-repair-${s.id}`,
    sync_status: 'pending',
    deleted: 0,
    version: 1,
  };
  const keys = Object.keys(row).filter((k) => cols.has(k));
  run(
    `INSERT INTO repair_orders (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ...keys.map((k) => row[k]),
  );
  return order;
}

export interface SaleSeedItem {
  productId: string;
  title: string;
  price: number;
  imei?: string;
  warrantyMonths?: number;
  quantity?: number;
}

export interface SaleSeed {
  id: string;
  receipt: string;
  createdAt?: string;
  items: SaleSeedItem[];
  total?: number;
  discountTotal?: number;
  customer?: { id: string; name: string; phone: string } | null;
  cashier?: string;
  shiftId?: string;
  isRefund?: boolean;
  originalTransactionId?: string | null;
  status?: 'COMPLETED' | 'VOIDED' | 'REFUNDED';
  deviceId?: string;
}

/** Seed one transaction row that hydrates through transactionAdapter.
 *  Refunds also write a refund_dedup row so G-34 stays true. */
export function seedSale(s: SaleSeed): Row {
  const createdAt = s.createdAt ?? isoAt('2026-09-15', 10);
  const isRefund = Boolean(s.isRefund);
  const items = s.items.map((it) => {
    const qty = Math.max(1, Math.round(Number(it.quantity ?? 1)));
    const months = it.warrantyMonths;
    return {
      product: {
        id: it.productId,
        sku: it.productId,
        barcode: it.productId,
        title: it.title,
        brand: '',
        compatibleModel: '',
        category: 'Smartphones',
        price: it.price,
        wholesalePrice: 0,
        costPrice: 0,
        stock: 0,
        isSerialized: Boolean(it.imei),
        imeiNumber: it.imei ?? '',
      },
      quantity: qty,
      discount: 0,
      appliedPrice: it.price,
      unitCostPrice: 0,
      unitCostAtSale: 0,
      unitPriceCharged: it.price,
      discountAmount: 0,
      lineProfit: it.price * qty,
      ...(it.imei ? { imeiNumber: it.imei } : {}),
      ...(months !== undefined ? { warrantyMonthsAtSale: months } : {}),
    };
  });
  const total =
    s.total ??
    items.reduce((sum, it) => sum + it.appliedPrice * it.quantity, 0) - (s.discountTotal ?? 0);
  const shiftId = s.shiftId ?? openShiftId();
  const payload: Row = {
    id: s.id,
    receiptNumber: s.receipt,
    createdAt,
    cashierName: s.cashier ?? 'E2E Gerant',
    customer: s.customer ?? { id: 'CUST-COMPTOIR', name: 'Client Comptoir', phone: '-' },
    items,
    subtotal: total + (s.discountTotal ?? 0),
    discountTotal: s.discountTotal ?? 0,
    total,
    paymentMethod: 'Espèces',
    status: s.status ?? 'COMPLETED',
    isRefund,
    ...(s.originalTransactionId ? { originalTransactionId: s.originalTransactionId } : {}),
    ...(shiftId ? { shiftId } : {}),
    tenders: [{ method: 'Espèces', amount: total }],
    pricingTier: 'Retail',
    costTotal: 0,
    profit: total,
    profitMargin: 100,
  };
  const cols = new Set(columnNames('transactions'));
  const itemCols = new Set(columnNames('transaction_items'));
  const row: Record<string, unknown> = {
    id: s.id,
    receipt_number: s.receipt,
    customer_id: s.customer?.id ?? null,
    subtotal: total + (s.discountTotal ?? 0),
    tax: 0,
    discount_total: s.discountTotal ?? 0,
    total,
    cost_total: 0,
    profit: total,
    profit_margin: 100,
    pricing_tier: 'Retail',
    payment_method: 'Espèces',
    cash_tendered: total,
    change_due: 0,
    status: s.status ?? 'COMPLETED',
    created_at: createdAt,
    json_payload: JSON.stringify(payload),
    device_id: s.deviceId ?? 'e2e-seed-device',
    idempotency_key: `e2e-sale-${s.id}`,
    // Refund rows must satisfy the v109 native barrier: either a refund_dedup
    // row exists (inserted below, but the trigger runs first) or the row is
    // already 'synced'. The seed uses the latter, exactly like replay rows.
    sync_status: isRefund ? 'synced' : 'pending',
    updated_at: createdAt,
    version: 1,
    deleted: 0,
    original_transaction_id: s.originalTransactionId ?? null,
    is_refund: isRefund ? 1 : 0,
    shift_id: shiftId,
  };
  const keys = Object.keys(row).filter((k) => cols.has(k));
  tx((d) => {
    d.prepare(
      `INSERT INTO transactions (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ).run(...keys.map((k) => row[k]));
    // Keep the normalised line index in sync with the JSON payload: the app's
    // inspector uses `transaction_items(imei_number)` for historical devices
    // outside its bounded in-memory window. A JSON-only seed would make those
    // sales invisible to the direct IMEI read and let the repair branch win.
    items.forEach((it, idx) => {
      const itemId = `${s.id}-LI-${idx + 1}`;
      const itemRow: Record<string, unknown> = {
        id: itemId,
        transaction_id: s.id,
        product_id: it.product.id,
        quantity: it.quantity,
        applied_price: it.appliedPrice,
        discount: it.discount,
        imei_number: it.imeiNumber ?? null,
        cost_price: it.unitCostAtSale,
        json_payload: JSON.stringify(it),
        device_id: s.deviceId ?? 'e2e-seed-device',
        idempotency_key: `e2e-item-${s.id}-${idx + 1}`,
        sync_status: 'pending',
        created_at: createdAt,
        updated_at: createdAt,
        deleted: 0,
        version: 1,
        sale_item_id: itemId,
        unit_price_charged: it.unitPriceCharged,
        unit_cost_at_sale: it.unitCostAtSale,
        discount_amount: it.discountAmount,
        line_profit: it.lineProfit,
      };
      const itemKeys = Object.keys(itemRow).filter((k) => itemCols.has(k));
      d.prepare(
        `INSERT OR REPLACE INTO transaction_items (${itemKeys.join(', ')}) VALUES (${itemKeys.map(() => '?').join(', ')})`,
      ).run(...itemKeys.map((k) => itemRow[k]));
    });
    if (isRefund && s.originalTransactionId) {
      const dedupExists = d
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='refund_dedup'")
        .get();
      if (dedupExists) {
        d.prepare(
          `INSERT OR REPLACE INTO refund_dedup (ticket_id, items_hash, refund_id, created_at)
           VALUES (?, ?, ?, ?)`,
        ).run(s.originalTransactionId, `e2e-${s.id}`, s.id, createdAt);
      }
    }
  });
  return payload;
}

export interface ImeiSeed {
  imei: string;
  productId: string;
  status?: string;
  saleTransactionId?: string | null;
  warrantyMonths?: number;
  warrantyExpiresAt?: string | null;
  receivedAt?: string;
  soldAt?: string | null;
  notes?: string | null;
}

export function seedImei(s: ImeiSeed): void {
  const cols = new Set(columnNames('imei_records'));
  const row: Record<string, unknown> = {
    imei: s.imei,
    product_id: s.productId,
    purchase_order_id: null,
    sale_transaction_id: s.saleTransactionId ?? null,
    warranty_expires_at: s.warrantyExpiresAt ?? null,
    received_at: s.receivedAt ?? isoAt('2026-08-01', 8),
    sold_at: s.soldAt ?? null,
    version: 1,
    warranty_months: s.warrantyMonths ?? 12,
    status: s.status ?? 'sold',
    notes: s.notes ?? null,
  };
  const keys = Object.keys(row).filter((k) => cols.has(k));
  run(
    `INSERT INTO imei_records (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})
     ON CONFLICT(imei) DO UPDATE SET ${keys
       .filter((k) => k !== 'imei')
       .map((k) => `${k}=excluded.${k}`)
       .join(', ')}`,
    ...keys.map((k) => row[k]),
  );
}

/** A synthetic CLOSED session whose window brackets historical fixtures, so
 *  G-20 (refund within the session window) and G-18 (no future close) hold. */
export function seedHistoricSession(id = 'E2E-HIST-SESSION'): string {
  const cols = new Set(columnNames('cash_sessions'));
  const row: Record<string, unknown> = {
    id,
    opened_at: isoAt('2024-01-01', 8),
    closed_at: isoAt('2026-10-20', 18),
    opening_float: 0,
    expected_cash: 0,
    actual_cash: 0,
    status: 'CLOSED',
    cashier_name: 'E2E Historique',
    json_payload: '{}',
    updated_at: isoAt('2026-10-20', 18),
    version: 1,
    device_id: 'e2e-seed-device',
  };
  const keys = Object.keys(row).filter((k) => cols.has(k));
  run(
    `INSERT OR REPLACE INTO cash_sessions (${keys.join(', ')}) VALUES (${keys
      .map(() => '?')
      .join(', ')})`,
    ...keys.map((k) => row[k]),
  );
  return id;
}

export function openShiftId(): string | null {
  const r = one<{ id: string }>(
    "SELECT id FROM cash_sessions WHERE status='OPEN' ORDER BY opened_at DESC LIMIT 1",
  );
  return r?.id ? String(r.id) : null;
}

export function repairRow(id: string): Row | undefined {
  return one<Row>('SELECT * FROM repair_orders WHERE id = ?', id);
}

export function repairPayload(id: string): Row {
  const r = repairRow(id);
  if (!r) return {};
  try {
    return JSON.parse(String(r.json_payload ?? '{}')) as Row;
  } catch {
    return {};
  }
}

export function claimRows(): Row[] {
  try {
    return all<Row>('SELECT * FROM warranty_claims ORDER BY opened_at');
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// native attachment + print capture
// ---------------------------------------------------------------------------

export interface AttachmentRef {
  relativePath: string;
  sha256: string;
  byteSize: number;
  capturedAt: string;
  kind: 'intake' | 'bench' | 'delivery';
}

/** Write bytes through the real native `sav_attachment_write` command and
 *  return the exact evidence ref the app would persist. Used to seed G-26
 *  proofs (the shipped UI photo path is broken by blob-URL loading). */
export async function writeAttachment(
  orderId: string,
  index: number,
  kind: 'intake' | 'bench' | 'delivery' = 'intake',
  dataBase64 = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
): Promise<AttachmentRef> {
  const res = (await browser.execute(
    async (oid: string, idx: number, k: string, b64: string) => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke;
      return invoke('sav_attachment_write', {
        request: {
          orderId: oid,
          index: idx,
          dataBase64: b64,
          extension: 'webp',
          kind: k,
        },
      });
    },
    orderId,
    index,
    kind,
    dataBase64,
  )) as { relative_path: string; sha256: string; byte_size: number };
  return {
    relativePath: res.relative_path,
    sha256: res.sha256,
    byteSize: res.byte_size,
    capturedAt: new Date().toISOString(),
    kind,
  };
}

/** Capture raw ESC/POS buffers passed to the native spooler, so a printed
 *  certificate can be inspected as executed evidence (not just source). */
export async function armPrintBuffer(): Promise<string> {
  return (await browser.execute(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__?: { invoke?: (...args: unknown[]) => unknown };
      __e2ePrintBuffers?: Array<{ cmd: string; printer?: string; data?: number[] }>;
      __e2ePrintWrap?: string;
    };
    w.__e2ePrintBuffers = [];
    const internals = w.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') {
      w.__e2ePrintWrap = 'no-internals';
      return 'no-internals';
    }
    const orig = internals.invoke.bind(internals);
    const wrapper = (...args: unknown[]) => {
      try {
        const cmd = String(args[0] ?? '');
        const a = (args[1] ?? {}) as Record<string, unknown>;
        if (cmd === 'sqlite_print_raw_escpos') {
          const data = (a.data ?? a.request ?? a) as unknown;
          (w.__e2ePrintBuffers = w.__e2ePrintBuffers || []).push({
            cmd,
            printer: String(a.printerName ?? a.printer_name ?? ''),
            data: Array.isArray(data) ? (data as number[]) : undefined,
          });
        }
      } catch {
        /* recorder errors must never break the app */
      }
      return orig(...args);
    };
    try {
      internals.invoke = wrapper;
      if (internals.invoke === wrapper) {
        w.__e2ePrintWrap = 'wrapped';
        return 'wrapped';
      }
    } catch {
      /* fall through */
    }
    try {
      Object.defineProperty(internals, 'invoke', { value: wrapper, writable: true, configurable: true });
      w.__e2ePrintWrap = internals.invoke === wrapper ? 'wrapped' : 'inert';
      return w.__e2ePrintWrap;
    } catch {
      w.__e2ePrintWrap = 'failed';
      return 'failed';
    }
  })) as string;
}

export async function readPrintBuffers(): Promise<Array<{ cmd: string; printer?: string; text: string }>> {
  return (await browser.execute(() => {
    const w = window as unknown as {
      __e2ePrintBuffers?: Array<{ cmd: string; printer?: string; data?: number[] }>;
    };
    return (w.__e2ePrintBuffers ?? []).map((b) => ({
      cmd: b.cmd,
      printer: b.printer,
      text: (b.data ?? [])
        .map((n) => (n >= 32 && n < 127 ? String.fromCharCode(n) : n === 10 ? '\n' : ' '))
        .join(''),
    }));
  })) as Array<{ cmd: string; printer?: string; text: string }>;
}

// ---------------------------------------------------------------------------
// repair modal / history driving
// ---------------------------------------------------------------------------

export async function repairModalOpen(): Promise<boolean> {
  return (await browser.execute(() => {
    const t = document.body.innerText || '';
    return /Nouveau Ticket SAV/.test(t) && /Historique Atelier/.test(t);
  })) as boolean;
}

export async function openRepairModal(): Promise<void> {
  if (await repairModalOpen()) return;
  await closeDialogs().catch(() => undefined);
  // Guarded: the header button is background UI; a modal that is still up must
  // not be clicked through (the old page click did exactly that).
  await pageClickByTitle(REPAIR_MODAL_TITLE, { label: 'openRepairModal' });
  await browser.waitUntil(repairModalOpen, {
    timeout: 15000,
    interval: 300,
    timeoutMsg: 'repair modal never appeared',
  });
  await browser.pause(300);
}

export async function closeRepairModal(): Promise<void> {
  const decision = await pageClickSelector(
    '//div[@role="dialog"][contains(normalize-space(.), "RÉPARATIONS & TICKETS SAV")]//button[@aria-label="Fermer" or @title="Fermer"]',
    { label: 'closeRepairModal', throwOnRefusal: false },
  );
  if (!decision.allow) {
    console.log(`[closeRepairModal] not clicked: ${describeClickDecision(decision)}`);
  }
  await browser.pause(300);
}

export async function openHistoryTab(): Promise<void> {
  await pageClickByText('Historique Atelier', { label: 'openHistoryTab' });
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => {
        const input = [...document.querySelectorAll('input')].find((x) =>
          (x.placeholder || '').includes('Rechercher par N° Ticket'),
        );
        return Boolean(input);
      })) as boolean,
    { timeout: 10000, timeoutMsg: 'history tab did not open' },
  );
  await browser.pause(250);
}

export async function setHistorySearch(text: string): Promise<void> {
  await browser.execute((v: string) => {
    const input = [...document.querySelectorAll('input')].find((x) =>
      (x.placeholder || '').includes('Rechercher par N° Ticket'),
    ) as HTMLInputElement | undefined;
    if (!input) return;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, text);
  await browser.pause(350);
}

/** Locate the history card for a ticket inside the page (smallest div that
 *  contains the ticket text AND a status select). */
export async function cardText(ticket: string): Promise<string> {
  return (await browser.execute((t: string) => {
    const card = ([...document.querySelectorAll('div')] as HTMLElement[])
      .filter((d) => d.querySelector('select') && (d.innerText || '').includes(t))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
    return card ? card.innerText || '' : '';
  }, ticket)) as string;
}

export async function setCardStatus(ticket: string, status: string): Promise<boolean> {
  // Tag the card's status select, then drive it through the real WebDriver
  // select command. The native-setter + synthetic `change` trick is not
  // reliable for a React controlled <select> (the value tracker swallows it
  // and the handler never runs), which made status transitions look inert.
  const tagged = (await browser.execute((t: string) => {
    const card = ([...document.querySelectorAll('div')] as HTMLElement[])
      .filter((d) => d.querySelector('select') && (d.innerText || '').includes(t))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
    // A history card carries TWO selects: technician assignment first, then
    // the status machine. Select the one that actually offers the status set.
    const sel = ([...((card?.querySelectorAll('select') ?? []) as NodeListOf<HTMLSelectElement>)]).find(
      (s) => [...s.options].some((o) => o.value === 'Livré'),
    );
    if (!sel) return false;
    sel.setAttribute('data-e2e-card-status', t);
    return true;
  }, ticket)) as boolean;
  if (!tagged) return false;
  const sel = await $(`select[data-e2e-card-status="${ticket}"]`);
  if (!(await sel.isExisting())) return false;
  const info = (await browser.execute((t: string) => {
    const el = document.querySelector(`select[data-e2e-card-status="${t}"]`) as HTMLSelectElement | null;
    if (!el) return null;
    return {
      value: el.value,
      disabled: el.disabled,
      options: [...el.options].map((o) => ({ value: o.value, text: o.text })),
      outer: (el.outerHTML || '').slice(0, 400),
    };
  }, ticket)) as { value: string; disabled: boolean; options: Array<{ value: string; text: string }>; outer: string } | null;
  console.log(`[SAV] setCardStatus(${ticket}, ${status}) select=`, JSON.stringify(info));
  try {
    await sel.selectByVisibleText(status);
  } catch (e) {
    console.log(`[SAV] setCardStatus(${ticket}, ${status}) select failed: ${String((e as Error)?.message ?? e)}`);
    return false;
  }
  await browser.pause(900);
  return true;
}

export async function clickCardAction(ticket: string, label: string | RegExp): Promise<boolean> {
  const ok = (await browser.execute(
    (t: string, needle: string) => {
      const card = ([...document.querySelectorAll('div')] as HTMLElement[])
        .filter((d) => d.querySelector('select') && (d.innerText || '').includes(t))
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
      if (!card) return false;
      const re = new RegExp(needle, 'i');
      const b = ([...card.querySelectorAll('button')] as HTMLButtonElement[]).find(
        (x) => re.test(x.textContent || '') && !x.disabled,
      );
      if (!b) return false;
      b.click();
      return true;
    },
    ticket,
    typeof label === 'string' ? label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : label.source,
  )) as boolean;
  await browser.pause(500);
  return ok;
}

/** Set a card status to Livré (zero-balance path) and wait for the DB. */
export async function deliverViaStatus(ticket: string, timeout = 20000): Promise<boolean> {
  await withConfirmAccepted();
  const before = String(repairRowByTicket(ticket)?.status ?? '');
  if (before === 'Livré') return true;
  const set = await setCardStatus(ticket, 'Livré');
  console.log(`[SAV] deliverViaStatus(${ticket}) set=${set} before=${before}`);
  if (!set) return false;
  const t0 = Date.now();
  for (;;) {
    const st = String(repairRowByTicket(ticket)?.status ?? '');
    if (st === 'Livré') return true;
    if (Date.now() - t0 > timeout) return false;
    await browser.pause(400);
  }
}

export function repairRowByTicket(ticket: string): Row | undefined {
  return one<Row>('SELECT * FROM repair_orders WHERE ticket_number = ? ORDER BY rowid DESC LIMIT 1', ticket);
}

// ---------------------------------------------------------------------------
// intake form
// ---------------------------------------------------------------------------

export async function setInputValue(selector: string, value: string): Promise<boolean> {
  return (await browser.execute((sel: string, v: string) => {
    const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) return false;
    const proto =
      el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, selector, value)) as boolean;
}

export async function setInputInForm(
  by: 'placeholder' | 'aria',
  fragment: string,
  value: string,
): Promise<boolean> {
  return (await browser.execute((kind: string, frag: string, v: string) => {
    const fields = [
      ...document.querySelectorAll('#sav-intake-form input, #sav-intake-form textarea'),
    ] as Array<HTMLInputElement | HTMLTextAreaElement>;
    const el = fields.find((x) =>
      kind === 'placeholder'
        ? ((x as HTMLInputElement).placeholder || '').includes(frag)
        : new RegExp(frag, 'i').test(x.getAttribute('aria-label') || ''),
    );
    if (!el) return false;
    const proto =
      el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, by, fragment, value)) as boolean;
}

export async function selectInForm(selector: string, match: string): Promise<boolean> {
  return (await browser.execute((sel: string, m: string) => {
    const node = document.querySelector(sel) as HTMLSelectElement | null;
    if (!node) return false;
    const opt = [...node.options].find((o) => o.text.trim() === m || o.value === m);
    if (!opt) return false;
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(
      node,
      opt.value,
    );
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, selector, match)) as boolean;
}

/** Draw a real pointer stroke on the intake signature canvas. */
export async function drawSignature(): Promise<boolean> {
  const exists = (await browser.execute(() =>
    Boolean(document.querySelector('#sav-intake-form canvas')),
  )) as boolean;
  if (!exists) return false;
  const canvas = await $('#sav-intake-form canvas');
  await canvas.scrollIntoView().catch(() => undefined);
  await browser.pause(200);
  try {
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ origin: canvas as never, x: -70, y: -15 })
      .down()
      .move({ origin: canvas as never, x: -25, y: 18, duration: 120 })
      .move({ origin: canvas as never, x: 25, y: -14, duration: 120 })
      .move({ origin: canvas as never, x: 75, y: 14, duration: 120 })
      .up()
      .perform();
  } catch (e) {
    console.log(
      `[SAV] signature via pointer actions failed (${String((e as Error)?.message ?? e)}) — synthetic fallback`,
    );
    await browser.execute(() => {
      const c = document.querySelector('#sav-intake-form canvas') as HTMLCanvasElement | null;
      if (!c) return;
      try {
        c.setPointerCapture = () => undefined;
        c.releasePointerCapture = () => undefined;
      } catch {
        /* ignore */
      }
      const r0 = c.getBoundingClientRect();
      const fire = (type: string, x: number, y: number) => {
        c.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: 'mouse',
            clientX: x,
            clientY: y,
          }),
        );
      };
      fire('pointerdown', r0.left + 30, r0.top + 40);
      fire('pointermove', r0.left + 60, r0.top + 55);
      fire('pointermove', r0.left + 90, r0.top + 45);
      fire('pointerup', r0.left + 90, r0.top + 45);
      c.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  await browser.pause(350);
  return true;
}

export interface IntakeOpts {
  name: string;
  phone: string;
  model: string;
  problem: string;
  imei?: string;
  imeiKind?: 'imei' | 'serial' | 'none';
  labor?: number;
  parts?: number;
  deposit?: number;
  tierLabel?: string;
  statusValue?: string;
  reworkId?: string;
  sparePart?: string;
  spareQty?: number;
  photos?: number;
  keepSignature?: boolean;
}

export async function fillIntake(o: IntakeOpts): Promise<void> {
  // Opening the intake is a click on the SAV modal's own control; the guard
  // refuses it if a foreign modal is on top (the form-internal chip/radio
  // clicks below are inside the same dialog by construction).
  await pageClickByText('Nouveau Ticket SAV', { label: 'fillIntake:open' });
  await browser.pause(300);
  if (!(await browser.execute(() => Boolean(document.querySelector('#sav-intake-form'))))) {
    throw new Error('fillIntake: #sav-intake-form not visible');
  }

  await setInputValue('#sav-customer', o.name);
  await setInputValue('#sav-phone', o.phone);

  // Identifier mode tab (IMEI / N° Série / Sans ID).
  const mode = o.imeiKind ?? 'imei';
  const modeLabel = mode === 'serial' ? 'N° Série' : mode === 'none' ? 'Sans ID' : 'IMEI';
  await browser.execute((label: string) => {
    const tabs = [...document.querySelectorAll('#sav-intake-form [role="tab"]')] as HTMLButtonElement[];
    tabs.find((x) => (x.textContent || '').trim() === label)?.click();
  }, modeLabel);
  await browser.pause(200);

  await setInputInForm('placeholder', 'iPhone', o.model);
  if (o.imei && mode !== 'none') {
    const typed = await setInputInForm('aria', 'IMEI|série|Référence|Sans ID', o.imei);
    console.log(`[SAV] identifier ${o.imei} typed=${typed} mode=${mode}`);
  }
  await setInputValue('#sav-problem', o.problem);

  // Damage constat: first exact-'Intact' chip is the screen.
  await browser.execute(() => {
    const form = document.querySelector('#sav-intake-form');
    if (!form) return;
    const chip = ([...form.querySelectorAll('button')] as HTMLButtonElement[]).find(
      (x) => (x.textContent || '').trim() === 'Intact',
    );
    chip?.click();
  });
  await browser.pause(150);

  const tierLabel = o.tierLabel ?? 'Garantie réparation 90 jours';
  const tierClicked = (await browser.execute((label: string) => {
    const radios = [...document.querySelectorAll('#sav-intake-form [role="radio"]')] as HTMLButtonElement[];
    const b = radios.find((x) => (x.textContent || '').includes(label));
    if (!b) return false;
    b.click();
    return true;
  }, tierLabel)) as boolean;
  if (!tierClicked) throw new Error(`fillIntake: warranty tier "${tierLabel}" not found`);
  await browser.pause(150);

  await browser.execute(() => {
    const boxes = [...document.querySelectorAll('#sav-intake-form input[type="checkbox"]')] as HTMLInputElement[];
    const b = boxes.find((x) => /Le client a lu et accepte/.test(x.closest('label')?.textContent || ''));
    if (b && !b.checked) b.click();
  });
  await browser.pause(150);

  if (o.labor !== undefined) await typeMoneyInto(await $('#sav-labor'), o.labor);
  if (o.parts !== undefined) await typeMoneyInto(await $('#sav-parts'), o.parts);
  if (o.deposit !== undefined) await typeMoneyInto(await $('#sav-deposit'), o.deposit);
  await browser.pause(200);

  if (o.sparePart) {
    await setInputInForm('placeholder', 'Rechercher une pièce dans le catalogue', o.sparePart);
    await browser.pause(600);
    if (o.spareQty && o.spareQty > 1) {
      const qty = await $('#sav-intake-form input[type="number"]');
      const allNums = await $$('#sav-intake-form input[type="number"]');
      const qtyInput = allNums[allNums.length - 1] ?? qty;
      await qtyInput.setValue(String(o.spareQty)).catch(() => undefined);
      await browser.pause(150);
    }
    const added = (await browser.execute((needle: string) => {
      const rows = ([...document.querySelectorAll('#sav-intake-form div')] as HTMLElement[]).filter(
        (el) => /SKU:/.test(el.innerText || '') && (el.innerText || '').includes(needle),
      );
      const cand = rows.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
      if (!cand) return false;
      cand.click();
      return true;
    }, o.sparePart)) as boolean;
    console.log(`[SAV] spare part "${o.sparePart}" attached=${added}`);
    await browser.pause(250);
  }

  if (o.reworkId) {
    const linked = await selectInForm('#sav-rework-link', o.reworkId);
    if (!linked) throw new Error(`fillIntake: rework link option ${o.reworkId} missing`);
    await browser.pause(200);
  }

  if (o.statusValue) {
    const set = await selectInForm('#sav-status', o.statusValue);
    if (!set) throw new Error(`fillIntake: status ${o.statusValue} not selectable`);
    await browser.pause(150);
  }

  if (o.photos && o.photos > 0) {
    const input = await $('#sav-intake-form input[type="file"]');
    for (let i = 0; i < o.photos; i++) {
      await input.addValue(tinyPngPath());
      await browser.pause(900);
    }
  }

  if (!o.keepSignature) await drawSignature();
}

export async function clickSaveRepair(): Promise<boolean> {
  const decision = await pageClickSelector(
    '//button[contains(normalize-space(.), "Enregistrer le Ticket SAV") or contains(normalize-space(.), "Mettre à jour Ticket")]',
    { label: 'clickSaveRepair', throwOnRefusal: false },
  );
  if (!decision.allow) {
    console.log(`[clickSaveRepair] not clicked: ${describeClickDecision(decision)}`);
    return false;
  }
  return true;
}

export async function saveRepairWait(name: string, timeout = 25000): Promise<Row> {
  if (!(await clickSaveRepair())) throw new Error('saveRepairWait: save button missing');
  const t0 = Date.now();
  for (;;) {
    const row = one<Row>(
      'SELECT * FROM repair_orders WHERE customer_name = ? ORDER BY rowid DESC LIMIT 1',
      name,
    );
    if (row) return row;
    if (Date.now() - t0 > timeout) {
      const body = (await browser.execute(
        () => (document.body.innerText || '').slice(-1200),
      )) as string;
      throw new Error(`saveRepairWait(${name}): no repair row; tail=${body}`);
    }
    await browser.pause(400);
  }
}

export async function newRepair(o: IntakeOpts): Promise<Row> {
  await openRepairModal();
  await fillIntake(o);
  return saveRepairWait(o.name);
}

/** Open the history card's edit form. */
export async function editCard(ticket: string): Promise<boolean> {
  const ok = await clickCardAction(ticket, 'Éditer');
  if (!ok) return false;
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => {
        const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
          /Mettre à jour Ticket/.test(x.textContent || ''),
        );
        return Boolean(b);
      })) as boolean,
    { timeout: 10000, timeoutMsg: 'edit form did not open' },
  );
  await browser.pause(300);
  return true;
}

// ---------------------------------------------------------------------------
// inspector
// ---------------------------------------------------------------------------

export async function openInspector(): Promise<void> {
  const visible = (await browser.execute(() => /Inspecteur IMEI & Garantie/.test(document.body.innerText || ''))) as boolean;
  if (visible) return;
  await closeDialogs().catch(() => undefined);
  await pageClickByTitle(INSPECTOR_TITLE, { label: 'openInspector' });
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => /Inspecteur IMEI & Garantie/.test(document.body.innerText || ''))) as boolean,
    { timeout: 15000, timeoutMsg: 'inspector never appeared' },
  );
  await browser.pause(300);
}

export async function closeInspector(): Promise<void> {
  const decision = await pageClickSelector(
    '//div[@role="dialog"][contains(normalize-space(.), "Inspecteur IMEI & Garantie")]//button[@aria-label="Fermer" or @title="Fermer"]',
    { label: 'closeInspector', throwOnRefusal: false },
  );
  if (!decision.allow) {
    console.log(`[closeInspector] not clicked: ${describeClickDecision(decision)}`);
  }
  await browser.pause(250);
}

export async function inspectorLookup(idValue: string, mode: 'imei' | 'serial' = 'imei'): Promise<void> {
  const label = mode === 'serial' ? 'N° Série' : 'IMEI';
  await browser.execute((l: string) => {
    const tabs = [...document.querySelectorAll('[role="tablist"][aria-label="Type d\'identifiant"] [role="tab"]')] as HTMLButtonElement[];
    tabs.find((x) => (x.textContent || '').trim() === l)?.click();
  }, label);
  await browser.pause(200);
  const input = await $(`input[aria-label="${label}"]`);
  await input.waitForDisplayed({ timeout: 10000 });
  await input.click();
  await browser.execute((l: string, v: string) => {
    const el = document.querySelector(`input[aria-label="${l}"]`) as HTMLInputElement | null;
    if (!el) return;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, label, idValue);
  await browser.pause(150);
  await pageClickByText('Vérifier', { label: 'inspectorLookup:verifier' });
  await browser.pause(1200);
}

export async function inspectorBody(): Promise<string> {
  return (await browser.execute(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')] as HTMLElement[];
    const dlg = dialogs.find((d) => /Inspecteur IMEI & Garantie/.test(d.innerText || ''));
    return dlg ? dlg.innerText || '' : document.body.innerText || '';
  })) as string;
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

export function bodyText(): Promise<string> {
  return browser.execute(() => document.body.innerText || '') as Promise<string>;
}

export function countRepairs(where = '1=1', ...params: unknown[]): number {
  const r = one<{ c: number }>(`SELECT COUNT(*) AS c FROM repair_orders WHERE ${where}`, ...params);
  return Number(r?.c ?? 0);
}

export function stockOf(productId: string): number {
  return Number(one<{ stock: number }>('SELECT stock FROM products WHERE id = ?', productId)?.stock ?? NaN);
}

export function ledgerSum(productId: string): number {
  const r = one<{ s: number | null }>(
    'SELECT COALESCE(SUM(delta),0) AS s FROM inventory_ledger WHERE product_id = ?',
    productId,
  );
  return Number(r?.s ?? 0);
}

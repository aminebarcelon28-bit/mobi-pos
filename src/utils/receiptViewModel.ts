import type {
  CashSession,
  ReceiptSettings,
  RepairOrder,
  SaleTransaction,
  StagedTradeIn,
  TradeInItem,
} from '../types/pos';
import {
  repairFinancials,
  repairQuoteNumber,
  REPAIR_QUOTE_VALIDITY_DAYS,
} from '../types/pos';
import {
  discountsFromTransaction,
  grossFromTransaction,
  netFromTransaction,
} from './receiptMath';
import { coerceWarrantyMonths, extractWarrantyMonths, hasExplicitWarranty } from './warrantyResolver';

/** Single cart line in receipt terms. */
export interface ReceiptLineItem {
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
  discount: number;
  imei?: string;
  /** Included store warranty in months (0 = none). Preserved from sale time. */
  warrantyMonths?: number;
}

/** Trade-in / reprise block shown only when a device was taken back. */
export interface ReceiptTradeInInfo {
  /** Device brand / category (e.g. "Apple"). */
  category: string;
  /** Commercial model label (e.g. "iPhone 11 64GB Noir"). */
  model: string;
  /** Serial / IMEI identifier, digits only display. */
  imei: string;
  /** Cosmetic / functional grade (e.g. "Grade B (Bon État)"). */
  grade: string;
  /** Buyback allowance applied against the basket (>= 0, rendered negative). */
  valuation: number;
}

/** One applied tender leg. */
export interface ReceiptTender {
  /** Display label (e.g. "Crédit Reprise", "Espèces", "TPE / Carte"). */
  label: string;
  /** Raw method key for logic (never displayed alone). */
  method: string;
  amount: number;
}

export type ReceiptNatureKind = 'refund' | 'trade-in' | 'voucher' | 'cash';

export interface ReceiptStoreInfo {
  name: string;
  tagline: string;
  address: string;
  phone: string;
  /** Optional contact email — renderers omit the line entirely when blank. */
  email: string;
  /**
   * Effective footer policy: `footerMessage` wins, `customFooterMsg` is the
   * legacy fallback, empty means "print the default return policy". Never
   * whitespace-only (trimmed at build so no blank policy block can print).
   */
  footerMessage: string;
}

/**
 * Receipt telemetry timestamp: DD/MM/YYYY HH:mm:ss (24h, local). Deliberately
 * NOT `formatDateTime` (fr-DZ long form) — every slip in the fleet prints
 * this one compact shape so tickets, Z reports and vouchers sort visually.
 */
export function formatReceiptDateTime(dateStr?: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function cleanName(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
}

/**
 * Strict seller resolution (shift-opener rule). The printed `Vendeur` is
 * ALWAYS the cashier who opened the owning shift — the person legally and
 * financially responsible for the drawer — never a handover cashier, a stale
 * session user, or a hardcoded fallback:
 *
 *   1. `tx.shiftOpenedByName` — immutable commit-time snapshot (reprints
 *      stay correct weeks later, even by an admin on another shift);
 *   2. live `shiftOpener` — `activeShift.openedBy` (handover-proof);
 *   3. `activeShift.cashierName` — pre-handover / legacy sessions;
 *   4. `tx.cashierName` — legacy rows without any shift linkage;
 *   5. `'Caisse Principale'` — last resort, never blank.
 *
 * NOTE: the originating prompt named `openedByName` / `openedBy.name` — those
 * fields do not exist on `CashSession` (AGENTS.md report-first). The schema
 * carries immutable `openedBy?: string`, which is what step 2 reads.
 */
export function resolveSellerName(
  tx: Pick<SaleTransaction, 'shiftOpenedByName' | 'cashierName'> | null | undefined,
  shiftOpener?: string | CashSession | null,
): string {
  const live =
    typeof shiftOpener === 'string'
      ? shiftOpener
      : (shiftOpener as CashSession | null | undefined)?.openedBy ??
        (shiftOpener as CashSession | null | undefined)?.cashierName;
  return (
    cleanName(tx?.shiftOpenedByName) ||
    cleanName(live) ||
    cleanName(tx?.cashierName) ||
    'Caisse Principale'
  );
}

export interface ReceiptViewModel {
  store: ReceiptStoreInfo;
  ticketId: string;
  dateTime: string;
  /** Register / terminal identifier (Caisse). */
  registerId: string;
  /** Cashier display name (Vendeur) — ALWAYS the shift opener (see above). */
  cashierName: string;
  natureKind: ReceiptNatureKind;
  /** Dynamic header label (VENTE AU COMPTANT / VENTE + REPRISE … / …). */
  natureLabel: string;
  items: ReceiptLineItem[];
  tradeIn: ReceiptTradeInInfo | null;
  voucherCode: string | null;
  voucherCredit: number;
  avoirCredit: number;
  grossSubtotal: number;
  discounts: number;
  tradeInCredit: number;
  /** Net amount due: Math.max(0, gross − deductions), equals stored total. */
  netDue: number;
  tenders: ReceiptTender[];
  changeDue: number;
  isRefund: boolean;
  /** Sum of all tender legs (TOTAL PERÇU on the reference layout). */
  tenderedTotal: number;
  /** Signed article count (Articles remis on the reference layout). */
  itemCount: number;
  /** 1 when a trade-in device was taken back, else 0. */
  tradeInCount: number;
}

export const TRADE_IN_LEGAL_STATEMENT =
  "Le client certifie sur l'honneur être le légitime propriétaire de l'appareil cédé (IMEI vérifié).";

export const STORE_RETURN_POLICY =
  'Échange sous 48h avec ticket original. Articles ni repris ni remboursés sans ticket.';

/** Human tender label — never decouple from the method key. */
export function tenderDisplayLabel(method: string, reference?: string): string {
  const m = (method || '').trim();
  if (m === 'Reprise') return 'Crédit Reprise';
  if (m === 'Espèces') return 'Espèces';
  if (m === 'Avoir Client') return 'Avoir Client';
  if (m === 'Crédit Client') return 'Crédit Client';
  if (m === 'BaridiMob') return 'BaridiMob';
  if (m === 'Chèque') return 'Chèque';
  // "Autre" is the TPE / card rail on this till.
  if (m === 'Autre') {
    const ref = (reference || '').toLowerCase();
    if (ref.includes('tpe') || ref.includes('carte') || ref.includes('cb')) return 'TPE / Carte';
    return 'TPE / Carte';
  }
  return m || 'Espèces';
}

function toInt(n: unknown): number {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) ? Math.max(0, v) : 0;
}

// ── SAV (B4 dépôt / B5 restitution / devis) unified view model ─────────────
// One definition feeding the thermal ESC/POS builders AND the mobile text
// twins, so the two can never drift (the failure mode the receipt fix
// removed from sales tickets). The A4 HTML legal masters (`doc-*` system
// with signatures/CNI/folio) intentionally stay byte-identical — they are a
// different standard (A4 papier, not 80mm thermal) and SAV e2e specs pin
// their content.

export type SavDocKind = 'depot' | 'workshop' | 'restitution' | 'quote';

export interface SavChecklistView {
  screenOk?: boolean;
  faceIdOk?: boolean;
  cameraOk?: boolean;
  chargingOk?: boolean;
  bodyOk?: boolean;
  batteryOk?: boolean;
  audioOk?: boolean;
}

export interface SavViewModel {
  store: ReceiptStoreInfo;
  kind: SavDocKind;
  ticketNumber: string;
  /** `DEV-<ticket>` (quotes only, derived — never stored). */
  quoteNumber: string;
  createdAt: string;
  deliveredAt: string;
  /** Quote validity end (render time + 15 days, DD/MM/YYYY HH:mm:ss). */
  validUntil: string;
  /** Shift opener (Vendeur) — resolved by the caller (coordinator/modal). */
  sellerName: string;
  /** Technician id when assigned (no name directory exists in the store). */
  technicianName: string;
  customerName: string;
  customerPhone: string;
  deviceModel: string;
  imei: string;
  problem: string;
  diagnosticNotes: string;
  /** Post-repair checklist wins, intake checklist is the fallback. */
  checklist: SavChecklistView;
  partsCost: number;
  laborCost: number;
  totalCost: number;
  /** Cumulative acompte on the row (history, NOT today's collection). */
  depositAmount: number;
  /**
   * Collected during THIS pickup session only. Explicit opt-in, default 0 —
   * never fabricated: the persisted row cannot distinguish an old deposit
   * from money just tendered, so unknown means 0 (Case A) rather than an
   * echo of the cumulative deposit (the B5 bug: settledAmount mirroring).
   */
  paidToday: number;
  /**
   * `max(0, total − deposit − paidToday)`. Derived, never stored.
   * Case A (unpaid pickup): paidToday 0 → reste = balance (INVALID banner).
   * Case B (partial today): reste shrinks by exactly today's tender.
   * Case C (fully settled today): reste 0 → SOLDE RÉGLÉ banner.
   */
  balanceDue: number;
  /** Cumulative settled to date (total − balance, history included). */
  settledAmount: number;
  unsettled: boolean;
}

export interface BuildSavViewModelOptions {
  kind?: SavDocKind;
  seller?: string | null;
  technician?: string | null;
  /** Session tender collected at handover (B5 only). Omit when unknown. */
  paidToday?: number;
}

export function buildSavViewModel(
  order: RepairOrder,
  settings: ReceiptSettings,
  opts: BuildSavViewModelOptions = {}
): SavViewModel {
  const fin = repairFinancials(order);
  // repairFinancials() itself is correct (balance = total − clamped deposit);
  // today's collection layers on top and can only shrink what is still due.
  const paidToday = Math.max(0, Math.round(Number(opts.paidToday) || 0));
  const balanceDue = Math.max(0, fin.balanceDue - paidToday);
  const cl = order.postRepairChecklist || order.conditionChecklist || {};
  const validUntilDate = new Date();
  validUntilDate.setDate(validUntilDate.getDate() + REPAIR_QUOTE_VALIDITY_DAYS);
  return {
    store: {
      name: (settings.storeName || 'MAGASIN').trim() || 'MAGASIN',
      tagline: (settings.storeSubheader || settings.customHeaderMsg || '').trim(),
      address: (settings.address || '').trim(),
      phone: (settings.phone || '').trim(),
      email: (settings.email || '').trim(),
      footerMessage: (settings.footerMessage || settings.customFooterMsg || '').trim(),
    },
    kind: opts.kind ?? 'depot',
    ticketNumber: order.ticketNumber,
    quoteNumber: repairQuoteNumber(order),
    createdAt: formatReceiptDateTime(order.createdAt),
    deliveredAt: formatReceiptDateTime(order.updatedAt || order.createdAt),
    validUntil: formatReceiptDateTime(validUntilDate.toISOString()),
    sellerName: (opts.seller || '').trim() || 'Caisse Principale',
    technicianName: (opts.technician || order.assignedTechnicianId || '').trim(),
    customerName: (order.customerName || 'Client Comptoir').trim() || 'Client Comptoir',
    customerPhone: (order.customerPhone || '').trim(),
    deviceModel: (order.deviceModel || '').trim(),
    imei: (order.imei || '').trim(),
    problem: (order.problemDescription || '').trim(),
    diagnosticNotes: (order.diagnosticNotes || '').trim(),
    checklist: {
      screenOk: cl.screenOk,
      faceIdOk: cl.faceIdOk,
      cameraOk: cl.cameraOk,
      chargingOk: cl.chargingOk,
      bodyOk: cl.bodyOk,
      batteryOk: cl.batteryOk,
      audioOk: cl.audioOk,
    },
    partsCost: fin.partsCost,
    laborCost: fin.laborCost,
    totalCost: fin.totalCost,
    depositAmount: fin.depositAmount,
    paidToday,
    balanceDue,
    settledAmount: Math.max(0, fin.totalCost - balanceDue),
    unsettled: balanceDue > 0,
  };
}

/** Tri-state checklist cell: OK / KO / — (never fabricate KO from unknown). */
export function savCheckCell(ok: boolean | undefined): string {
  if (ok === true) return 'OK';
  if (ok === false) return 'KO';
  return '—';
}

export interface BuildReceiptViewModelOptions {
  /** Resolved intake record (store tradeIns lookup by tradeInId). */
  tradeIn?: TradeInItem | StagedTradeIn | null;
  /** Override register label (defaults to shift/device linkage). */
  registerId?: string;
  /**
   * Live shift opener (`activeShift.openedBy`, or the shift row). Second in
   * the seller chain — the commit-time `tx.shiftOpenedByName` snapshot wins
   * whenever present so reprints never follow a later handover.
   */
  shiftOpener?: string | CashSession | null;
}

function resolveTradeInInfo(
  tx: SaleTransaction,
  optTradeIn?: TradeInItem | StagedTradeIn | null,
): ReceiptTradeInInfo | null {
  const deduction = Math.max(
    0,
    Math.round(Number(tx.tradeInDeduction) || 0),
  );
  const repriseTender = (tx.tenders || [])
    .filter((t) => t.method === 'Reprise')
    .reduce((acc, t) => acc + (Number(t.amount) || 0), 0);
  const hasTradeLeg =
    Boolean(tx.tradeInId) || deduction > 0 || repriseTender > 0 || Boolean(optTradeIn);
  if (!hasTradeLeg) return null;

  const valuation = Math.max(
    0,
    Math.round(
      Number(optTradeIn?.buybackValue) || deduction || repriseTender || 0,
    ),
  );
  const imei =
    (optTradeIn as TradeInItem | undefined)?.imei?.trim() || '';
  const model =
    (optTradeIn as TradeInItem | undefined)?.deviceModel?.trim() ||
    'Appareil repris';
  const grade =
    (optTradeIn as TradeInItem | undefined)?.conditionGrade?.trim() || '';
  const category =
    (optTradeIn as TradeInItem | undefined)?.brand?.trim() ||
    "Téléphone d'Occasion";

  return { category, model, imei, grade, valuation };
}

/**
 * Unified receipt view model — the ONE mapping every receipt surface
 * (modal preview, silent print, ESC/POS) must read so the 80mm ticket
 * always reconciles with the stored transaction.
 */
export function buildReceiptViewModel(
  tx: SaleTransaction,
  settings: ReceiptSettings,
  opts: BuildReceiptViewModelOptions = {},
): ReceiptViewModel {
  const store: ReceiptStoreInfo = {
    name: (settings.storeName || 'MAGASIN').trim() || 'MAGASIN',
    tagline: (settings.storeSubheader || settings.customHeaderMsg || '').trim(),
    address: (settings.address || '').trim(),
    phone: (settings.phone || '').trim(),
    email: (settings.email || '').trim(),
    footerMessage: (settings.footerMessage || settings.customFooterMsg || '').trim(),
  };

  const isRefund = Boolean(tx.isRefund);
  const items: ReceiptLineItem[] = (tx.items || []).map((line) => {
    const unitPrice = Math.max(
      0,
      Math.round(
        Number(line.unitPriceCharged ?? line.appliedPrice ?? line.product?.price) || 0,
      ),
    );
    const qty = Math.abs(Math.round(Number(line.quantity) || 0));
    const discount = Math.max(0, Math.round(Number(line.discount) || 0));
    const imei = line.imeiNumber?.trim() || undefined;
    // THE RECEIPT MUST NOT COMPUTE A WARRANTY TERM.
    //
    // This used to run its own heuristic (explicit product value → else 3 months
    // for "Téléphones d'Occasion" → else 0), which disagreed with
    // `warrantyResolver` — the engine the SAV terminal actually honours. On the
    // live dataset 129 of 131 sold devices were occasion stock: customers were
    // printed "Garantie 3 mois" while the warranty screen resolved 12, a 9-month
    // gap of unpriced repair liability with no marketing benefit.
    //
    // Printing is presentation. The term comes from the Step A snapshot minted at
    // checkout (`warranty_months_at_sale`), so paper, database and terminal can
    // no longer drift apart.
    //
    // Legacy lines (sold before Step A) carry no snapshot. Those receipts are
    // reprints of a document the customer already holds, so the historical
    // heuristic is preserved for THEM ONLY — the sole remaining reason it exists.
    // New sales can never reach this branch.
    const snapshotMonths = coerceWarrantyMonths(
      line.warrantyMonthsAtSale ?? (line as { warranty_months_at_sale?: unknown }).warranty_months_at_sale
    );
    const warrantyMonths = !imei
      ? 0
      : snapshotMonths !== undefined
        ? snapshotMonths
        : hasExplicitWarranty(line.product)
          ? extractWarrantyMonths(line.product)
          : line.product?.category === "Téléphones d'Occasion (Reprise)"
            ? 3
            : 0;
    return {
      name: line.product?.title?.trim() || 'Article',
      quantity: qty,
      unitPrice,
      total: Math.max(0, unitPrice * qty - discount),
      discount,
      imei,
      warrantyMonths,
    };
  });

  const tradeIn = resolveTradeInInfo(tx, opts.tradeIn ?? null);
  const tradeInCredit = Math.max(
    0,
    Math.round(
      Number(tx.tradeInDeduction) ||
        (tx.tenders || [])
          .filter((t) => t.method === 'Reprise')
          .reduce((acc, t) => acc + (Number(t.amount) || 0), 0) ||
        tradeIn?.valuation ||
        0,
    ),
  );

  const voucherCode =
    typeof tx.voucherCode === 'string' && tx.voucherCode.trim()
      ? tx.voucherCode.trim()
      : null;
  const voucherCredit = Math.max(0, Math.round(Number(tx.voucherCreditApplied) || 0));
  const avoirCredit = Math.max(
    0,
    Math.round(
      (tx.tenders || [])
        .filter((t) => t.method === 'Avoir Client')
        .reduce((acc, t) => acc + (Number(t.amount) || 0), 0),
    ),
  );

  const grossSubtotal = grossFromTransaction(tx);
  const discounts = discountsFromTransaction(tx);
  // Stored total already nets discounts + all credits; clamp guards legacy rows.
  const netDue = Math.max(0, netFromTransaction(tx));

  const hasVoucherLeg =
    voucherCredit > 0 || Boolean(voucherCode) || avoirCredit > 0;

  let natureKind: ReceiptNatureKind;
  let natureLabel: string;
  if (isRefund) {
    natureKind = 'refund';
    natureLabel = "BON D'AVOIR / REMBOURSEMENT";
  } else if (tradeIn) {
    natureKind = 'trade-in';
    natureLabel = 'VENTE + REPRISE APPAREIL (TRADE-IN)';
  } else if (hasVoucherLeg) {
    natureKind = 'voucher';
    natureLabel = "VENTE AVEC BON D'ÉCHANGE";
  } else {
    natureKind = 'cash';
    natureLabel = 'VENTE AU COMPTANT';
  }

  const rawTenders = Array.isArray(tx.tenders) ? tx.tenders : [];
  const tenders: ReceiptTender[] =
    rawTenders.length > 0
      ? rawTenders.map((t) => ({
          label: tenderDisplayLabel(t.method, t.reference),
          method: t.method,
          amount: Math.max(0, Math.round(Number(t.amount) || 0)),
        }))
      : [
          {
            label: tenderDisplayLabel(tx.paymentMethod || 'Espèces'),
            method: tx.paymentMethod || 'Espèces',
            amount: netDue,
          },
        ];

  const shiftId = (tx.shiftId || '').trim();
  const deviceId = ((tx.deviceId || tx.device_id || '') as string).trim();
  const registerId =
    (opts.registerId || '').trim() ||
    (shiftId ? `Caisse ${shiftId.slice(-8)}` : '') ||
    (deviceId ? `Terminal ${deviceId.slice(-6)}` : '') ||
    'Caisse Principale';

  return {
    store,
    ticketId: tx.receiptNumber || tx.id,
    dateTime: formatReceiptDateTime(tx.createdAt),
    registerId,
    cashierName: resolveSellerName(tx, opts.shiftOpener ?? null),
    natureKind,
    natureLabel,
    items,
    tradeIn,
    voucherCode,
    voucherCredit: toInt(voucherCredit),
    avoirCredit: toInt(avoirCredit),
    grossSubtotal: toInt(grossSubtotal),
    discounts: toInt(discounts),
    tradeInCredit: toInt(tradeInCredit),
    netDue: toInt(netDue),
    tenders,
    changeDue: Math.max(0, Math.round(Number(tx.changeDue) || 0)),
    isRefund,
    tenderedTotal: toInt(tenders.reduce((acc, t) => acc + t.amount, 0)),
    itemCount: (tx.items || []).reduce(
      (acc, l) => acc + Math.abs(Math.round(Number(l.quantity) || 0)),
      0,
    ),
    tradeInCount: tradeIn ? 1 : 0,
  };
}

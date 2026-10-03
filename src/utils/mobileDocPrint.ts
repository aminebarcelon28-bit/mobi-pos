/**
 * mobileDocPrint — Plain-text business documents for the Android print sheet.
 *
 * The native `launch_print` adapter renders monospace text (A4-ish page, ~52
 * lines max), so every builder below targets a 42-column thermal layout and
 * caps long item lists. Used by all mobile print paths (tickets, Z/X
 * reports, statements, vouchers, supplier orders) so every printer model
 * reachable from Android (Mopria / vendor print services / Save as PDF)
 * produces a correct document.
 */
import type {
  CartItem,
  CashSession,
  CreditVoucher,
  Customer,
  CustomerDebtEntry,
  PurchaseOrder,
  ReceiptSettings,
  RepairOrder,
  SaleTransaction,
  TradeInItem,
} from '../types/pos';
import { formatDZD, formatDateTime, faitALine } from '../types/pos';
import { fiscalIdentifierLine, tvaSplitFromTotal } from './receiptMath';
import {
  STORE_RETURN_POLICY,
  TRADE_IN_LEGAL_STATEMENT,
  buildReceiptViewModel,
  formatReceiptDateTime,
} from './receiptViewModel';

const WIDTH = 42;
const MAX_LINES = 50;

const rule = (ch = '-'): string => ch.repeat(WIDTH);

function center(text: string): string {
  const s = (text || '').slice(0, WIDTH);
  const pad = Math.max(0, WIDTH - s.length);
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + s + ' '.repeat(pad - left);
}

function row(left: string, right: string): string {
  const r = right || '';
  const maxLeft = Math.max(0, WIDTH - r.length - 1);
  const l = (left || '').slice(0, maxLeft);
  return l + ' '.repeat(WIDTH - l.length - r.length) + r;
}

function storeNameOf(settings?: ReceiptSettings | null): string {
  return settings?.storeName || 'MOBI-POS';
}

function clip(lines: string[]): string {
  return lines.slice(0, MAX_LINES).join('\n');
}

/**
 * Sales ticket / refund slip — UNIFIED PRINT TARGET: every section is derived
 * from the shared `buildReceiptViewModel` (the same model behind ReceiptPaper
 * and the ESC/POS buffer) so the Android-sheet ticket, the hardware ticket
 * and the on-screen paper can never drift apart. Every money row stays ONE
 * paired 42-col line via `cell()` (labels are never split from values).
 */
export function receiptText(tx: SaleTransaction, settings?: ReceiptSettings | null): string {
  const vm = buildReceiptViewModel(
    tx,
    (settings || {}) as ReceiptSettings,
    // The sheet path receives no intake record: device detail lines fall back
    // to the persisted deduction leg (same rule as the ESC/POS buffer).
    { tradeIn: null },
  );
  // `row()` clips the LEFT side only — clip the right side too so long
  // ticket ids can never push a line past 42 cols (or throw on repeat()).
  const cell = (left: string, right: string): string =>
    row(left, String(right || '').slice(0, WIDTH));
  // Centered, word-wrapped banner lines (nature labels can exceed 42 cols).
  const banner = (text: string): string[] => {
    const words = (text || '').split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let cur = '';
    for (const w of words) {
      if ((cur + (cur ? ' ' : '') + w).length > WIDTH) {
        if (cur) out.push(center(cur));
        cur = w.length > WIDTH ? w.slice(0, WIDTH) : w;
      } else {
        cur = cur ? `${cur} ${w}` : w;
      }
    }
    if (cur) out.push(center(cur));
    return out;
  };

  const lines: string[] = [];
  lines.push(center(storeNameOf(settings)));
  if (settings?.address) lines.push(center(settings.address));
  if (settings?.phone) lines.push(center(`Tél: ${settings.phone}`));
  // Optional email — omitted entirely when blank (no ghost label/line).
  if (settings?.email && settings.email.trim()) {
    lines.push(center(`Email: ${settings.email.trim()}`.slice(0, WIDTH)));
  }
  const fiscalLine = fiscalIdentifierLine(settings);
  if (fiscalLine) lines.push(center(fiscalLine));
  lines.push(rule('='));
  // Transaction nature (derived header label, comme le papier écran).
  lines.push(...banner(`*** ${vm.natureLabel} ***`));
  // Session telemetry — paired rows, never decoupled columns.
  lines.push(cell('Ticket:', vm.ticketId));
  lines.push(cell('Date:', vm.dateTime));
  lines.push(cell('Caisse:', vm.registerId));
  lines.push(cell('Vendeur:', vm.cashierName));
  lines.push(rule());
  if (tx.customer?.name) lines.push(cell('Client:', tx.customer.name));
  let warrantyMonthsMax = 0;
  for (const line of vm.items) {
    const wMonths = line.warrantyMonths || 0;
    if (wMonths > 0) warrantyMonthsMax = Math.max(warrantyMonthsMax, wMonths);
    lines.push(`${line.quantity}x ${(line.name || 'Article').slice(0, 28)}${wMonths > 0 ? ' (*)' : ''}`);
    lines.push(cell(`  @ ${formatDZD(line.unitPrice)}`, formatDZD(line.total)));
    if (line.discount > 0) lines.push(cell('  Remise:', `-${formatDZD(line.discount)}`));
    if (line.imei) lines.push(`  IMEI: ${line.imei}`.slice(0, WIDTH));
  }
  lines.push(rule());
  // B-028: always print SOUS-TOTAL BRUT from the gross invariant so the
  // ticket reconciles even when discountTotal === 0 (legacy rows / credits).
  lines.push(cell('SOUS-TOTAL BRUT:', formatDZD(vm.grossSubtotal)));
  if (vm.discounts > 0) {
    lines.push(cell('REMISE ACCORDEE:', `-${formatDZD(vm.discounts)}`));
  }
  if (vm.tradeInCredit > 0) {
    lines.push(cell('CREDIT REPRISE DEDUIT:', `-${formatDZD(vm.tradeInCredit)}`));
  }
  if (vm.voucherCredit > 0) {
    lines.push(
      cell(vm.voucherCode ? `BON (${vm.voucherCode}):` : 'BON ECHANGE:', `-${formatDZD(vm.voucherCredit)}`)
    );
  }
  if (vm.avoirCredit > 0) {
    lines.push(cell('AVOIR CLIENT DEDUIT:', `-${formatDZD(vm.avoirCredit)}`));
  }
  const tva = tvaSplitFromTotal(vm.netDue, settings?.vatRate);
  if (tva) {
    lines.push(cell('HT:', formatDZD(tva.ht)));
    lines.push(cell(`TVA ${tva.rate}%:`, `+${formatDZD(tva.tva)}`));
    lines.push(cell('TTC:', formatDZD(tva.ttc)));
  }
  lines.push(cell(tx.isRefund ? 'TOTAL REMBOURSE:' : 'TOTAL NET A PAYER:', formatDZD(vm.netDue)));
  // Two-way exchange leg (never a cart line): print the deduction + soulte
  // so the thermal ticket reconciles like the desktop net receipt.
  if (tx.tradeInId && (tx.tradeInDeduction || 0) > 0) {
    lines.push(cell('Reprise deduite:', `-${formatDZD(tx.tradeInDeduction || 0)}`));
  }
  if (vm.tradeIn) {
    lines.push(center('[APPAREIL REPRIS / TRADE-IN]'));
    lines.push(cell('Modele:', vm.tradeIn.model));
    if (vm.tradeIn.imei) lines.push(cell('IMEI:', vm.tradeIn.imei));
    if (vm.tradeIn.grade) lines.push(cell('Etat:', vm.tradeIn.grade));
    for (const ln of banner(TRADE_IN_LEGAL_STATEMENT)) lines.push(ln);
  }
  if (tx.tradeInSoulte && tx.tradeInSoulte.amount > 0) {
    lines.push(
      cell(
        tx.tradeInSoulte.method === 'cash' ? 'Soulte versee (esp.):' : 'Soulte en avoir:',
        formatDZD(tx.tradeInSoulte.amount)
      )
    );
  }
  // Multi-tender settlement — one paired row per leg.
  lines.push(tx.isRefund ? 'Modes de Remboursement:' : 'Modes de Reglement:');
  for (const tender of vm.tenders) {
    lines.push(cell(`${tender.label}:`, formatDZD(tender.amount)));
  }
  if (!tx.isRefund) {
    lines.push(cell('TOTAL PERÇU:', formatDZD(vm.tenderedTotal)));
    lines.push(cell('Rendu:', formatDZD(vm.changeDue)));
  }
  lines.push(`Articles:${vm.itemCount} Repris:${vm.tradeInCount}`.slice(0, WIDTH));
  if ((tx.customer?.storeCredit || 0) > 0) {
    lines.push(cell('Avoir client dispo:', `+${formatDZD(tx.customer?.storeCredit || 0)}`));
  }
  if ((tx.customer?.currentDebt || 0) > 0) {
    lines.push(cell('Dette restante:', formatDZD(tx.customer?.currentDebt || 0)));
  }
  if (warrantyMonthsMax > 0) {
    lines.push(`Garantie: ${warrantyMonthsMax} mois sur articles (*)`);
  }
  if (tx.isRefund && tx.refundReason) lines.push(`Motif: ${tx.refundReason}`.slice(0, WIDTH));
  lines.push(rule('='));
  // Footer policy: custom message wins (primary block), otherwise the default
  // return policy — identical to the paper, never both, never blank.
  for (const ln of banner(vm.store.footerMessage ? vm.store.footerMessage : STORE_RETURN_POLICY)) {
    lines.push(ln);
  }
  lines.push(center('Merci de votre visite et à bientôt !'));
  return clip(lines);
}

export interface XReportTextData {
  sessionId: string;
  cashierName: string;
  dateStr: string;
  openingFloat: number;
  cashSales: number;
  deposits: number;
  expenses: number;
  refunds: number;
  /** SAV deposits taken (informational). Optional for legacy callers. */
  savDeposits?: number;
  /** SAV balances settled via checkout (informational, in cashSales). */
  savSettled?: number;
  /** Cash trade-in payouts, shift window (source table). */
  tradeIns?: number;
  /** Soulte boutique cash payouts, shift window (movement lane). */
  soulteOut?: number;
  expectedCash: number;
  salesCount: number;
  totalRevenue: number;
}

/** Mid-shift X snapshot (mirrors the ESC/POS X buffer content). */
export function xReportText(d: XReportTextData, storeName?: string): string {
  const savTotal = (d.savDeposits || 0) + (d.savSettled || 0);
  const lines: string[] = [
    center(storeName || 'MOBI-POS'),
    center('*** RAPPORT X (POINT MID-SHIFT) ***'),
    center(d.dateStr),
    rule('='),
    row('Session:', d.sessionId.slice(0, 20)),
    row('Caissier:', (d.cashierName || '').slice(0, 24)),
    rule(),
    row('Fond initial:', formatDZD(d.openingFloat)),
    row('Ventes espèces:', `+${formatDZD(d.cashSales)}`),
    row('Dépôts manuels:', `+${formatDZD(d.deposits)}`),
    row('Dépenses:', `-${formatDZD(d.expenses)}`),
    row('Remboursements:', `-${formatDZD(d.refunds)}`),
  ];
  if ((d.savDeposits || 0) > 0) lines.push(row('Acomptes SAV perçus:', `+${formatDZD(d.savDeposits || 0)}`));
  if ((d.savSettled || 0) > 0) lines.push(row('Soldes SAV encaissés:', `+${formatDZD(d.savSettled || 0)}`));
  if (savTotal > 0) lines.push(row('Total Encaissé Atelier:', `+${formatDZD(savTotal)}`));
  if ((d.tradeIns || 0) > 0) lines.push(row('Rachats occas.:', `-${formatDZD(d.tradeIns || 0)}`));
  if ((d.soulteOut || 0) > 0) lines.push(row('Soulte échange:', `-${formatDZD(d.soulteOut || 0)}`));
  lines.push(
    rule(),
    row('ESPECES THEORIQUES:', formatDZD(d.expectedCash)),
    rule('='),
    row('Nb ventes:', `${d.salesCount}`),
    row('CA total:', formatDZD(d.totalRevenue)),
    center('Document intermédiaire — caisse active')
  );
  return clip(lines);
}

export interface ZReportTextData {
  storeName?: string;
  /** Sequential Z-ticket number (YYYYMMDD-SEQ). Optional for legacy callers. */
  zNumber?: string;
  /** Turnover rails (reference layout). Optional: lines print only when set. */
  cardSales?: number;
  creditSales?: number;
  repriseTake?: number;
  netSales?: number;
  /** Shift window + register (reference telemetry). Optional. */
  openedAtISO?: string;
  closedAtISO?: string;
  registerLabel?: string;
  responsibleName?: string;
  cashierName: string;
  dateStr: string;
  openingFloat: number;
  cashSales: number;
  debtSettlements: number;
  /** SAV deposits actually taken (never imputed balances). Optional for legacy callers. */
  savDeposits?: number;
  /** SAV balances settled via checkout (informational, already in cashSales). */
  savSettled?: number;
  refunds: number;
  expenses: number;
  /** Cash trade-in payouts. Optional for legacy callers. */
  tradeIns?: number;
  drops: number;
  payouts: number;
  /** Exchange cash-outs. Optional for legacy callers. */
  exchangeOut?: number;
  /** Soulte boutique cash payouts (movement lane). Optional for legacy callers. */
  soulteOut?: number;
  /** Twin-less manual apports / décaissements. Optional for legacy callers. */
  manualIn?: number;
  manualOut?: number;
  expectedCash: number;
  countedCash: number;
  variance: number;
  dropsList?: Array<{ reason: string; amount: number }>;
}

/** End-of-day Z report (mirrors the Z print document). */
export function zReportText(d: ZReportTextData): string {
  const ref = (iso?: string): string =>
    iso ? formatReceiptDateTime(iso) : '';
  const lines: string[] = [
    center(d.storeName || 'MOBI-POS'),
    center('*** RAPPORT Z — CLOTURE ***'),
    ...(d.zNumber ? [center(`Z-TICKET N°: ${d.zNumber}`)] : []),
    ...(ref(d.openedAtISO) ? [center(`Ouvert le: ${ref(d.openedAtISO)}`)] : []),
    ...(ref(d.closedAtISO) ? [center(`Clôturé le: ${ref(d.closedAtISO)}`)] : []),
    center(d.dateStr),
    rule('='),
    ...(d.registerLabel ? [row('Caisse:', d.registerLabel.slice(0, 28))] : []),
    row(d.responsibleName ? 'Resp. Caisse:' : 'Caissier:', ((d.responsibleName || d.cashierName) || '').slice(0, 28)),
    rule(),
    row('Fond initial:', formatDZD(d.openingFloat)),
    row('Ventes espèces:', `+${formatDZD(d.cashSales)}`),
  ];
  if (d.cardSales !== undefined && d.cardSales > 0) {
    lines.push(row('Ventes TPE/Carte:', `+${formatDZD(d.cardSales)}`));
  }
  if (d.creditSales !== undefined && d.creditSales > 0) {
    lines.push(row('Ventes à crédit:', `+${formatDZD(d.creditSales)}`));
  }
  if (d.repriseTake !== undefined && d.repriseTake > 0) {
    lines.push(row('Reprises:', `-${formatDZD(d.repriseTake)}`));
  }
  if (d.netSales !== undefined) {
    lines.push(row('VENTES NETTES:', formatDZD(d.netSales)));
  }
  if (d.debtSettlements > 0) lines.push(row('Règl. dettes:', `+${formatDZD(d.debtSettlements)}`));
  if ((d.savDeposits || 0) > 0) lines.push(row('Acomptes SAV:', `+${formatDZD(d.savDeposits || 0)}`));
  if ((d.savSettled || 0) > 0) lines.push(row('Soldes SAV:', `+${formatDZD(d.savSettled || 0)}`));
  if ((d.manualIn || 0) > 0) lines.push(row('Apports manuels:', `+${formatDZD(d.manualIn || 0)}`));
  if (d.refunds > 0) lines.push(row('Remboursements:', `-${formatDZD(d.refunds)}`));
  if (d.expenses > 0) lines.push(row('Dépenses:', `-${formatDZD(d.expenses)}`));
  if ((d.tradeIns || 0) > 0) lines.push(row('Rachats occas.:', `-${formatDZD(d.tradeIns || 0)}`));
  if ((d.exchangeOut || 0) > 0) lines.push(row('Retours échanges:', `-${formatDZD(d.exchangeOut || 0)}`));
  if ((d.soulteOut || 0) > 0) lines.push(row('Soulte échange:', `-${formatDZD(d.soulteOut || 0)}`));
  if ((d.manualOut || 0) > 0) lines.push(row('Dép. manuelles:', `-${formatDZD(d.manualOut || 0)}`));
  if (d.drops > 0) lines.push(row('Dépôts coffre:', `-${formatDZD(d.drops)}`));
  if (d.payouts > 0) lines.push(row('Décaissements:', `-${formatDZD(d.payouts)}`));
  lines.push(rule());
  lines.push(row('ESPECES THEORIQUES:', formatDZD(d.expectedCash)));
  lines.push(row('Compte physique:', formatDZD(d.countedCash)));
  const v = d.variance >= 0 ? `+${formatDZD(d.variance)}` : formatDZD(d.variance);
  lines.push(row('ECART:', v));
  lines.push(rule('='));
  lines.push(center('Signature: ________________'));
  lines.push(center('Signature Responsable / Gérant: ______'));
  return clip(lines);
}

/** Supplier purchase order (A4 doc condensed for the text sheet). */
export function purchaseOrderText(po: PurchaseOrder, settings?: ReceiptSettings | null): string {
  const lines: string[] = [
    center(storeNameOf(settings)),
    center('BON DE COMMANDE FOURNISSEUR'),
    center(`N° ${po.poNumber} — ${formatDateTime(po.createdAt)}`),
    rule('='),
    `Fournisseur: ${po.vendorName}`,
    `Règlement: Paiement à réception / Espèces`,
    rule(),
  ];
  const items = po.items || [];
  const shown = items.slice(0, 24);
  shown.forEach((item, idx) => {
    lines.push(`${idx + 1}. ${(item.title || '').slice(0, 34)}`);
    lines.push(row(`   ${item.suggestedQty}x ${formatDZD(item.unitCost)}`, formatDZD(item.totalCost)));
  });
  if (items.length > shown.length) lines.push(`... +${items.length - shown.length} autres articles`);
  lines.push(rule());
  lines.push(row('TOTAL COMMANDE:', formatDZD(po.totalAmount)));
  lines.push(rule('='));
  lines.push(center('Cachet & signature magasin'));
  return clip(lines);
}

/**
 * SAV repair ticket (condensed).
 * @deprecated Superseded by {@link repairVoucherEscPosText} + {@link chassisTagEscPosText}
 * (the tested 58mm duo used by intake print). Kept for scripts/verify-doc-print.mts.
 */
export function repairTicketText(order: RepairOrder, settings?: ReceiptSettings | null): string {
  const cl = order.conditionChecklist;
  const chk = (label: string, ok?: boolean): string => `${label}:${ok ? 'OK' : 'KO'}`;
  const lines: string[] = [
    center(storeNameOf(settings)),
    center(`FICHE SAV N° ${order.ticketNumber}`),
    center(formatDateTime(order.createdAt)),
    rule('='),
    `Client: ${order.customerName}`,
    `Tél: ${order.customerPhone || '—'}`,
    `Appareil: ${order.deviceModel}`,
    `IMEI: ${order.imei || 'N/A'}`,
    rule(),
    `Panne: ${(order.problemDescription || '').slice(0, 84)}`,
  ];
  if (order.diagnosticNotes) lines.push(`Diag: ${order.diagnosticNotes.slice(0, 84)}`);
  lines.push(
    [chk('Écran', cl.screenOk), chk('FaceID', cl.faceIdOk), chk('Caméra', cl.cameraOk)].join(' '),
    [chk('Charge', cl.chargingOk), chk('Batt.', cl.batteryOk), chk('Audio', cl.audioOk)].join(' ')
  );
  lines.push(rule());
  lines.push(row('Devis:', formatDZD(order.totalCost)));
  if (order.depositAmount) lines.push(row('Acompte:', `-${formatDZD(order.depositAmount)}`));
  lines.push(row('RESTE:', formatDZD(Math.max(0, order.totalCost - (order.depositAmount || 0)))));
  lines.push(rule('='));
  lines.push(center('Signature client : __________'));
  return clip(lines);
}

/**
 * 58mm/80mm ESC/POS fallback builders (32-col) for the SAV triad when no
 * TSPL/ZPL label printer is reachable (mobile Android sheet / BT thermal).
 */
function center32(text: string): string {
  const s = (text || '').slice(0, 32);
  const pad = Math.max(0, 32 - s.length);
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + s + ' '.repeat(pad - left);
}

function row32(left: string, right: string): string {
  const r = right || '';
  const maxLeft = Math.max(0, 32 - r.length - 1);
  const l = (left || '').slice(0, maxLeft);
  return l + ' '.repeat(32 - l.length - r.length) + r;
}

/** Customer claim voucher — 58mm variant (mirrors SavTicketBuilder voucher). */
export function repairVoucherEscPosText(
  order: RepairOrder,
  settings?: ReceiptSettings | null,
  seller?: string | null
): string {
  const remaining = Math.max(0, order.totalCost - (order.depositAmount || 0));
  const lines = [
    center32(storeNameOf(settings)),
    center32('BON DE DEPOT SAV'),
    center32(`Ticket ${order.ticketNumber}`),
    center32(formatDateTime(order.createdAt)),
    ...(seller && seller.trim() ? [center32(`Vendeur: ${seller.trim()}`.slice(0, 32))] : []),
    '-'.repeat(32),
    `Client: ${(order.customerName || '').slice(0, 24)}`,
    `Tel: ${(order.customerPhone || '-').slice(0, 25)}`,
    `App: ${(order.deviceModel || '').slice(0, 26)}`,
    `IMEI: ${(order.imei || 'N/A').slice(0, 25)}`,
    `Panne: ${(order.problemDescription || '').slice(0, 64)}`,
    '-'.repeat(32),
    row32('Total:', formatDZD(order.totalCost)),
    row32('Acompte:', formatDZD(order.depositAmount || 0)),
    row32('RESTE DU:', formatDZD(remaining)),
    '-'.repeat(32),
    center32('*' + order.ticketNumber + '*'),
    center32('Bon obligatoire retrait'),
    center32('Non reclame 90j: abandon +'),
    center32('recyclage (Art. CGV)'),
    center32('AVIS: sauvegarde donnees'),
    center32('a la charge du client'),
    center32(faitALine(settings)),
  ];
  return lines.slice(0, MAX_LINES).join('\n');
}

/** Chassis tag — 58mm barcode fallback (Ticket#, IMEI, device, customer). */
export function chassisTagEscPosText(order: RepairOrder): string {
  const last4 = (order.customerPhone || '').replace(/\D/g, '').slice(-4) || '----';
  const lines = [
    center32(`SAV: ${order.ticketNumber}`),
    center32((order.deviceModel || '').slice(0, 30)),
    '-'.repeat(32),
    `Ticket: ${order.ticketNumber}`,
    `IMEI: ${order.imei || 'N/A'}`,
    `Client: ${(order.customerName || '').slice(0, 18)} (${last4})`,
    center32('*' + order.ticketNumber + '*'),
    center32(formatDateTime(order.createdAt)),
  ];
  return lines.slice(0, MAX_LINES).join('\n');
}

/** Trade-in cession attestation (condensed). */
export function tradeInText(trade: TradeInItem, settings?: ReceiptSettings | null): string {
  // Police-registry folio helper is thermal-safe (pure string math).
  const clean = (trade.id || '').replace(/[^A-Z0-9]/gi, '').toUpperCase() || '000000';
  const folioYear = new Date(trade.createdAt || Date.now()).getFullYear();
  const folio = `${clean.slice(-6).padStart(6, '0')}-${folioYear}-${clean.slice(0, 4).padStart(4, '0')}`;
  return clip([
    center(storeNameOf(settings)),
    center('ATTESTATION DE CESSION'),
    center(`Réf ${trade.id}`),
    center(`Folio Registre Police N°: ${folio}`),
    center(formatDateTime(trade.createdAt)),
    rule('='),
    `Vendeur: ${trade.customerName}`,
    `ID (CNI/Permis): ${trade.nationalIdNumber || 'Non renseigné'}`,
    `Appareil: ${trade.deviceModel} (${trade.brand})`,
    `IMEI: ${trade.imei}`,
    `État: ${trade.conditionGrade}`,
    `Règlement: ${trade.creditToWallet ? 'Wallet' : 'Espèces'}`,
    rule(),
    row('MONTANT REPRISE:', formatDZD(trade.buybackValue)),
    rule('='),
    center('Certifie sur l\'honneur en être le'),
    center('propriétaire légitime (ni gage, ni vol).'),
    center(faitALine(settings)),
    center('Signature cédant : __________'),
  ]);
}

/** Credit voucher thermal ticket (mirrors the HTML voucher doc). */
export function voucherText(
  voucher: CreditVoucher,
  settings?: ReceiptSettings | null,
  seller?: string | null
): string {
  const lines: string[] = [
    center(storeNameOf(settings)),
    center("*** BON D'AVOIR ***"),
    center(`Code: ${voucher.code}`),
    center(formatDateTime(voucher.createdAt)),
    ...(seller && seller.trim()
      ? [center(`Vendeur: ${seller.trim()}`.slice(0, WIDTH))]
      : []),
    rule('='),
    row('Montant:', formatDZD(voucher.initialAmount)),
  ];
  if (voucher.customerName) lines.push(row('Bénéficiaire:', voucher.customerName.slice(0, 24)));
  if (voucher.expiresAt) lines.push(row('Valable jusqu’au:', formatDateTime(voucher.expiresAt)));
  lines.push(rule());
  lines.push(center('Présentez ce ticket en caisse.'));
  lines.push(center('Échange sous 48h avec ticket.'));
  lines.push(center(`*${voucher.code}*`.slice(0, WIDTH)));
  return clip(lines);
}

/** Adapt an ESC/POS-cash-session into X-report text data. */
export function xReportFromSession(
  session: CashSession & {
    expectedCash?: number | null;
    totalSalesCount?: number;
    totalSalesRevenue?: number;
    manualDeposits?: number;
    expenses?: number;
    cashSales?: number;
  },
  computed: { cashSales: number; refunds: number; deposits: number; expenses: number },
  storeName?: string,
  extras?: { tradeIns?: number; soulteOut?: number }
): string {
  return xReportText(
    {
      sessionId: session.id,
      cashierName: session.cashierName || 'Caissier',
      dateStr: new Date().toLocaleString('fr-DZ'),
      openingFloat: session.openingFloat || 0,
      cashSales: session.cashSales ?? computed.cashSales,
      deposits: computed.deposits,
      expenses: computed.expenses,
      refunds: computed.refunds,
      savDeposits: session.savDeposits ?? 0,
      savSettled: session.savSettled ?? 0,
      tradeIns: extras?.tradeIns ?? 0,
      soulteOut: extras?.soulteOut ?? 0,
      expectedCash: session.expectedCash ?? 0,
      salesCount: session.totalSalesCount ?? 0,
      totalRevenue: session.totalSalesRevenue ?? 0,
    },
    storeName
  );
}

/** SAV restitution handover — 58mm text twin (mirrors SavRestitutionBuilder). */
export function repairRestitutionText(
  order: RepairOrder,
  settings?: ReceiptSettings | null,
  seller?: string | null
): string {
  const total = Math.round(order.totalCost || 0);
  const deposit = Math.round(order.depositAmount || 0);
  const remaining = Math.max(0, total - deposit);
  const cl = order.postRepairChecklist || order.conditionChecklist;
  const chk = (label: string, ok?: boolean): string => `${label}:${ok ? 'OK' : 'KO'}`;
  const deliveredAt = order.updatedAt || order.createdAt;
  const lines: string[] = [
    center32(storeNameOf(settings)),
    center32('BON DE RESTITUTION SAV'),
    center32(`Ticket ${order.ticketNumber}`),
    center32(formatDateTime(deliveredAt)),
    ...(seller && seller.trim() ? [center32(`Vendeur: ${seller.trim()}`.slice(0, 32))] : []),
    '-'.repeat(32),
  ];
  if (remaining > 0) {
    lines.push(center32('DOCUMENT NON VALIDE'));
    lines.push(center32('EN ATTENTE DE REGLEMENT'));
    lines.push('-'.repeat(32));
  }
  lines.push(
    `Client: ${(order.customerName || '').slice(0, 24)}`,
    `Tel: ${(order.customerPhone || '-').slice(0, 25)}`,
    `App: ${(order.deviceModel || '').slice(0, 26)}`,
    `IMEI: ${(order.imei || 'N/A').slice(0, 25)}`,
    '-'.repeat(32),
    row32("Main d'oeuvre:", formatDZD(order.laborCost)),
    row32('Pieces:', formatDZD(order.partsCost)),
    row32('TOTAL:', formatDZD(total)),
    row32('Acompte:', formatDZD(deposit)),
    row32('Solde regle:', formatDZD(total - remaining)),
    row32('RESTE:', formatDZD(remaining)),
    '-'.repeat(32),
    [chk('Ecran', cl.screenOk), chk('Cam', cl.cameraOk), chk('Charge', cl.chargingOk)].join(' '),
    [chk('FaceID', cl.faceIdOk), chk('Audio', cl.audioOk)].join(' '),
    '-'.repeat(32),
    center32('Garantie 30j pieces'),
    center32('(hors chocs/eau/demontage)'),
    center32('AVIS: sauvegarde donnees'),
    center32('a la charge du client'),
    center32('Non reclame 90j: abandon +'),
    center32('recyclage (Art. CGV)'),
    center32('Appareil verifie fonctionnel'),
    center32('*' + order.ticketNumber + '*'),
    center32(faitALine(settings)),
    center32('Atelier: ____ Client: ____'),
    center32('(Lu et approuve)')
  );
  return lines.slice(0, MAX_LINES).join('\n');
}

/** Pre-owned warranty certificate — 58mm text twin (mirrors WarrantyCertificateBuilder). */
export function warrantyCertificateText(
  tx: SaleTransaction,
  item: CartItem,
  months: number,
  settings?: ReceiptSettings | null,
  seller?: string | null
): string {
  const imei = item.imeiNumber || item.serialNumber || 'Non specifie';
  const start = new Date(tx.createdAt);
  const expiry = new Date(start);
  expiry.setMonth(expiry.getMonth() + months);
  const vendeur =
    (tx.shiftOpenedByName || '').trim() ||
    (seller || '').trim() ||
    (tx.cashierName || '').trim() ||
    'Caisse Principale';
  const lines: string[] = [
    center32(storeNameOf(settings)),
    center32('CERTIFICAT DE GARANTIE'),
    center32('APPAREIL OCCASION'),
    center32(`Ref GAR-${tx.receiptNumber}`),
    center32(`Vendeur: ${vendeur}`.slice(0, 32)),
    '-'.repeat(32),
    `Modele: ${(item.product.title || '').slice(0, 24)}`,
    `IMEI: ${imei.slice(0, 25)}`,
    `Achat: ${start.toLocaleDateString('fr-DZ')}`,
    row32('Prix:', formatDZD(item.appliedPrice)),
    '-'.repeat(32),
    center32(`GARANTIE ${months} MOIS`),
    center32(`au ${expiry.toLocaleDateString('fr-DZ')}`),
    '-'.repeat(32),
    center32('Pannes internes uniquement'),
    center32('(hors chocs/eau/demontage)'),
    center32('Facture + certificat exiges'),
    center32('*' + String(item.imeiNumber || tx.receiptNumber).slice(0, 24) + '*'),
    center32('Cachet du Magasin: ______'),
  ];
  return lines.slice(0, MAX_LINES).join('\n');
}

/** Customer debt statement — 58mm text twin (mirrors DebtStatementTicketBuilder). */
export function debtStatementText(
  customer: Customer,
  debts: CustomerDebtEntry[],
  settings?: ReceiptSettings | null,
  seller?: string | null
): string {
  const lines: string[] = [
    center32(storeNameOf(settings)),
    center32('RELEVE DE COMPTE (KREDY)'),
    center32(new Date().toLocaleDateString('fr-DZ')),
    ...(seller && seller.trim() ? [center32(`Vendeur: ${seller.trim()}`.slice(0, 32))] : []),
    '-'.repeat(32),
    `Client: ${(customer.name || '').slice(0, 24)}`,
    `Tel: ${(customer.phone || '-').slice(0, 25)}`,
    row32('Plafond:', formatDZD(customer.debtLimit ?? 100000)),
    '-'.repeat(32),
  ];
  (debts || []).slice(0, 5).forEach((d) => {
    const tag = d.type === 'DEBT_ACQUIRED' ? '(+) Achat' : '(-) Reglt';
    lines.push(`${new Date(d.createdAt).toLocaleDateString('fr-DZ')} ${tag}`);
    lines.push(row32('', formatDZD(d.amount)));
  });
  lines.push(
    '-'.repeat(32),
    row32('SOLDE DU:', formatDZD(customer.currentDebt || 0)),
    '-'.repeat(32),
    center32('Signature & Accord: ______')
  );
  return lines.slice(0, MAX_LINES).join('\n');
}

/** Technician routing slip — 32-col text twin (mirrors buildWorkshopJobSlip). */
export function workshopSlipText(
  order: RepairOrder,
  seller?: string | null,
  technician?: string | null
): string {
  const cl = order.conditionChecklist || {
    screenOk: true,
    faceIdOk: true,
    cameraOk: true,
    chargingOk: true,
    bodyOk: true,
    batteryOk: true,
    audioOk: true,
  };
  const chk = (label: string, ok?: boolean): string => `${label}:${ok ? 'OK' : 'KO'}`;
  const tech = (technician || order.assignedTechnicianId || '').trim();
  const lines: string[] = [
    center32('*** FICHE ATELIER ***'),
    center32(`TICKET ${order.ticketNumber}`),
    center32(formatDateTime(order.createdAt)),
    ...(seller && seller.trim() ? [center32(`Vendeur: ${seller.trim()}`.slice(0, 32))] : []),
    ...(tech ? [center32(`Tech: ${tech}`.slice(0, 32))] : []),
    '-'.repeat(32),
    `App: ${(order.deviceModel || '').slice(0, 26)}`,
    `Client: ${(order.customerName || '').slice(0, 21)}`,
    `Tel: ${(order.customerPhone || '-').slice(0, 25)}`,
    `IMEI: ${(order.imei || 'N/A').slice(0, 25)}`,
    `Prevue: ${(order.estimatedCompletionDate || 'Non specifiee').slice(0, 24)}`,
    '-'.repeat(32),
    `Panne: ${(order.problemDescription || '').slice(0, 64)}`,
  ];
  if (order.diagnosticNotes) lines.push(`Notes: ${order.diagnosticNotes.slice(0, 64)}`);
  lines.push(
    '-'.repeat(32),
    [chk('Ecran', cl.screenOk), chk('FaceID', cl.faceIdOk), chk('Cam', cl.cameraOk)].join(' '),
    [chk('Charge', cl.chargingOk), chk('Batt.', cl.batteryOk), chk('Audio', cl.audioOk)].join(' ')
  );
  return lines.slice(0, MAX_LINES).join('\n');
}

/** SAV repair quotation — 58mm text twin (mirrors SavQuoteBuilder). */
export function repairQuoteText(
  order: RepairOrder,
  settings?: ReceiptSettings | null,
  seller?: string | null
): string {
  const total = Math.round(order.totalCost || 0);
  const emittedAt = new Date();
  const validUntil = new Date(emittedAt);
  validUntil.setDate(validUntil.getDate() + 15);
  const lines: string[] = [
    center32(storeNameOf(settings)),
    center32('DEVIS ESTIMATIF SAV'),
    center32(`Devis DEV-${order.ticketNumber}`),
    center32(`Ticket ${order.ticketNumber}`),
    center32(formatDateTime(emittedAt.toISOString())),
    ...(seller && seller.trim() ? [center32(`Vendeur: ${seller.trim()}`.slice(0, 32))] : []),
    center32(`Validite 15j jusqu'au`),
    center32(validUntil.toLocaleDateString('fr-DZ')),
    '-'.repeat(32),
    `Client: ${(order.customerName || '').slice(0, 24)}`,
    `App: ${(order.deviceModel || '').slice(0, 26)}`,
    `IMEI: ${(order.imei || 'N/A').slice(0, 25)}`,
    `Panne: ${(order.problemDescription || '').slice(0, 64)}`,
    '-'.repeat(32),
    row32("M.O. estimee:", formatDZD(order.laborCost)),
    row32('Pieces estimees:', formatDZD(order.partsCost)),
    row32('TOTAL ESTIME:', formatDZD(total)),
    row32('Acompte requis:', formatDZD(Math.round(total / 2))),
    '-'.repeat(32),
    center32('Devis gratuit, sans engagement'),
    center32('Bon pour accord: ________'),
    center32('*' + order.ticketNumber + '*')
  ];
  return lines.slice(0, MAX_LINES).join('\n');
}

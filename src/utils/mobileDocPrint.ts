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
  CashSession,
  CreditVoucher,
  PurchaseOrder,
  ReceiptSettings,
  RepairOrder,
  SaleTransaction,
  TradeInItem,
} from '../types/pos';
import { formatDZD, formatDateTime } from '../types/pos';
import { grossFromTransaction } from './receiptMath';

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

/** Sales ticket / refund slip (mirrors the 80mm HTML receipt content). */
export function receiptText(tx: SaleTransaction, settings?: ReceiptSettings | null): string {
  const lines: string[] = [];
  lines.push(center(storeNameOf(settings)));
  if (settings?.address) lines.push(center(settings.address));
  if (settings?.phone) lines.push(center(`Tél: ${settings.phone}`));
  lines.push(rule('='));
  lines.push(center(tx.isRefund ? "*** BON D'AVOIR ***" : `Ticket N° ${tx.receiptNumber}`));
  if (tx.isRefund) lines.push(center(`N° Avoir: ${tx.receiptNumber}`));
  lines.push(center(formatDateTime(tx.createdAt)));
  lines.push(rule());
  if (tx.customer?.name) lines.push(`Client: ${tx.customer.name}`);
  for (const item of tx.items || []) {
    const title = item.product?.title || 'Article';
    const unit = item.unitPriceCharged ?? item.appliedPrice ?? item.product?.price ?? 0;
    const gross = unit * item.quantity;
    const net = Math.max(0, gross - (item.discount || 0));
    lines.push(`${item.quantity}x ${title.slice(0, 30)}`);
    lines.push(row(`  @ ${formatDZD(unit)}`, formatDZD(net)));
    if (item.discount > 0) lines.push(row('  Remise:', `-${formatDZD(item.discount)}`));
  }
  lines.push(rule());
  // B-028: always print SOUS-TOTAL BRUT from the gross invariant so the
  // ticket reconciles even when discountTotal === 0 (legacy rows / credits).
  {
    const gross = grossFromTransaction(tx);
    lines.push(row('SOUS-TOTAL:', formatDZD(gross)));
    if (tx.discountTotal > 0) {
      lines.push(row('REMISE:', `-${formatDZD(tx.discountTotal)}`));
    }
  }
  lines.push(row(tx.isRefund ? 'TOTAL REMBOURSE:' : 'TOTAL:', formatDZD(tx.total)));
  lines.push(row('Règlement:', tx.paymentMethod || 'Espèces'));
  if (!tx.isRefund && tx.cashTendered > 0) {
    lines.push(row('Reçu:', formatDZD(tx.cashTendered)));
    lines.push(row('Rendu:', formatDZD(tx.changeDue || 0)));
  }
  if (tx.isRefund && tx.refundReason) lines.push(`Motif: ${tx.refundReason}`);
  lines.push(rule('='));
  lines.push(center('Merci de votre visite !'));
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
  expectedCash: number;
  salesCount: number;
  totalRevenue: number;
}

/** Mid-shift X snapshot (mirrors the ESC/POS X buffer content). */
export function xReportText(d: XReportTextData, storeName?: string): string {
  return clip([
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
    rule(),
    row('ESPECES THEORIQUES:', formatDZD(d.expectedCash)),
    rule('='),
    row('Nb ventes:', `${d.salesCount}`),
    row('CA total:', formatDZD(d.totalRevenue)),
    center('Document intermédiaire — caisse active'),
  ]);
}

export interface ZReportTextData {
  storeName?: string;
  cashierName: string;
  dateStr: string;
  openingFloat: number;
  cashSales: number;
  debtSettlements: number;
  /** SAV deposits actually taken (never imputed balances). Optional for legacy callers. */
  savDeposits?: number;
  refunds: number;
  expenses: number;
  /** Cash trade-in payouts. Optional for legacy callers. */
  tradeIns?: number;
  drops: number;
  payouts: number;
  /** Exchange cash-outs. Optional for legacy callers. */
  exchangeOut?: number;
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
  const lines: string[] = [
    center(d.storeName || 'MOBI-POS'),
    center('*** RAPPORT Z — CLOTURE ***'),
    center(d.dateStr),
    rule('='),
    row('Caissier:', (d.cashierName || '').slice(0, 28)),
    rule(),
    row('Fond initial:', formatDZD(d.openingFloat)),
    row('Ventes espèces:', `+${formatDZD(d.cashSales)}`),
  ];
  if (d.debtSettlements > 0) lines.push(row('Règl. dettes:', `+${formatDZD(d.debtSettlements)}`));
  if ((d.savDeposits || 0) > 0) lines.push(row('Acomptes SAV:', `+${formatDZD(d.savDeposits || 0)}`));
  if ((d.manualIn || 0) > 0) lines.push(row('Apports manuels:', `+${formatDZD(d.manualIn || 0)}`));
  if (d.refunds > 0) lines.push(row('Remboursements:', `-${formatDZD(d.refunds)}`));
  if (d.expenses > 0) lines.push(row('Dépenses:', `-${formatDZD(d.expenses)}`));
  if ((d.tradeIns || 0) > 0) lines.push(row('Rachats occas.:', `-${formatDZD(d.tradeIns || 0)}`));
  if ((d.exchangeOut || 0) > 0) lines.push(row('Retours échanges:', `-${formatDZD(d.exchangeOut || 0)}`));
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

/** SAV repair ticket (condensed). */
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

/** Trade-in cession attestation (condensed). */
export function tradeInText(trade: TradeInItem, settings?: ReceiptSettings | null): string {
  return clip([
    center(storeNameOf(settings)),
    center('ATTESTATION DE CESSION'),
    center(`Réf ${trade.id}`),
    center(formatDateTime(trade.createdAt)),
    rule('='),
    `Vendeur: ${trade.customerName}`,
    `Appareil: ${trade.deviceModel} (${trade.brand})`,
    `IMEI: ${trade.imei}`,
    `État: ${trade.conditionGrade}`,
    `Règlement: ${trade.creditToWallet ? 'Wallet' : 'Espèces'}`,
    rule(),
    row('MONTANT REPRISE:', formatDZD(trade.buybackValue)),
    rule('='),
    center('Signature cédant : __________'),
  ]);
}

/** Credit voucher thermal ticket (mirrors the HTML voucher doc). */
export function voucherText(voucher: CreditVoucher, settings?: ReceiptSettings | null): string {
  const lines: string[] = [
    center(storeNameOf(settings)),
    center("*** BON D'AVOIR ***"),
    center(`Code: ${voucher.code}`),
    center(formatDateTime(voucher.createdAt)),
    rule('='),
    row('Montant:', formatDZD(voucher.initialAmount)),
  ];
  if (voucher.customerName) lines.push(row('Bénéficiaire:', voucher.customerName.slice(0, 24)));
  if (voucher.expiresAt) lines.push(row('Valable jusqu’au:', formatDateTime(voucher.expiresAt)));
  lines.push(rule());
  lines.push(center('Présentez ce ticket en caisse.'));
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
  storeName?: string
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
      expectedCash: session.expectedCash ?? 0,
      salesCount: session.totalSalesCount ?? 0,
      totalRevenue: session.totalSalesRevenue ?? 0,
    },
    storeName
  );
}

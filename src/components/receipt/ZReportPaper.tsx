import React from 'react';
import { formatDZD } from '../../types/pos';
import { formatReceiptDateTime } from '../../utils/receiptViewModel';

/** Frozen Z-report snapshot — the single truth for the HTML ticket, the
 * ESC/POS twin (`buildZReportBuffer`) and the mobile text (`zReportText`).
 * Both Z modals feed this shape from their own windowed aggregates; the
 * close modal freezes it BEFORE the slice nulls the session so the desktop
 * print always has a mounted target (never a blank page). */
export interface ZReportSnapshot {
  storeName: string;
  zNumber: string;
  /** ISO instants (formatted inside, DD/MM/YYYY HH:mm:ss). */
  openedAtISO: string;
  closedAtISO: string;
  /** `Caisse <id>` label. */
  registerLabel: string;
  /** Shift opener (Responsable Caisse) — never the handover cashier. */
  responsibleName: string;
  openingFloat: number;
  /** Turnover by rail (reference layout). */
  cashSales: number;
  cardSales: number;
  creditSales: number;
  /** Reprise deduction legs taken back (subtracted from turnover). */
  repriseTake: number;
  /** cash + card + credit − reprises. */
  netSales: number;
  /** Drawer lanes (cash only). */
  debtSettlements: number;
  savDeposits: number;
  savSettled: number;
  refunds: number;
  expenses: number;
  drops: number;
  payouts: number;
  exchangeOut: number;
  soulteOut: number;
  manualIn: number;
  manualOut: number;
  tradeInCashOut: number;
  expectedCash: number;
  countedCash: number;
  variance: number;
  dropsList?: Array<{ id: string; reason: string; amount: number }>;
}

function MoneyRow({ label, value, strong }: { label: string; value: string; strong?: boolean }): React.JSX.Element {
  return (
    <div className={`flex justify-between gap-2 ${strong ? 'font-extrabold text-[13px]' : ''}`}>
      <span>{label}</span>
      <span className="font-bold whitespace-nowrap">{value}</span>
    </div>
  );
}

/**
 * Production 80mm Z-report paper — the single visual truth for the interim
 * preview AND the close print (`.print-zreport-target`). Same layout contract
 * as ReceiptPaper: paired rows only, monospace + tabular numbers.
 */
export const ZReportPaper: React.FC<{ snapshot: ZReportSnapshot }> = ({ snapshot: s }) => (
  <div className="print-zreport-target w-[80mm] max-w-[80mm] bg-white text-black p-4 font-mono tabular-nums text-xs leading-tight">
    <div className="text-center pb-2 border-b border-dashed border-gray-400">
      <p className="font-extrabold text-sm uppercase tracking-wider">{s.storeName}</p>
      <p className="font-black text-xs uppercase mt-1">*** RAPPORT Z DE CLÔTURE ***</p>
      <p className="text-[10px] font-bold">Z-Ticket: {s.zNumber}</p>
      <p className="text-[10px]">Ouvert le: {formatReceiptDateTime(s.openedAtISO)}</p>
      <p className="text-[10px]">Clôturé le: {formatReceiptDateTime(s.closedAtISO)}</p>
      <p className="text-[10px]">Caisse: {s.registerLabel}</p>
      <p className="text-[10px] font-bold">Responsable Caisse: {s.responsibleName}</p>
    </div>

    <div className="py-2 space-y-0.5 border-b border-dashed border-gray-400">
      <p className="text-[9px] font-bold uppercase text-gray-600">Chiffre d&apos;affaires:</p>
      <MoneyRow label="Ventes Espèces:" value={formatDZD(s.cashSales)} />
      {s.cardSales > 0 ? <MoneyRow label="Ventes TPE / Carte:" value={formatDZD(s.cardSales)} /> : null}
      {s.creditSales > 0 ? <MoneyRow label="Ventes à Crédit:" value={formatDZD(s.creditSales)} /> : null}
      {s.repriseTake > 0 ? <MoneyRow label="Reprises (Trade-in):" value={`-${formatDZD(s.repriseTake)}`} /> : null}
      <MoneyRow label="TOTAL VENTES NETTES:" value={formatDZD(s.netSales)} strong />
    </div>

    <div className="py-2 space-y-0.5 border-b border-dashed border-gray-400">
      <p className="text-[9px] font-bold uppercase text-gray-600">Mouvements de caisse (espèces):</p>
      <MoneyRow label="Fond de caisse initial:" value={formatDZD(s.openingFloat)} />
      <MoneyRow label="Encaissements espèces:" value={`+${formatDZD(s.cashSales)}`} />
      {s.debtSettlements > 0 ? <MoneyRow label="Règlements dettes reçus:" value={`+${formatDZD(s.debtSettlements)}`} /> : null}
      {s.savDeposits > 0 ? <MoneyRow label="Acomptes SAV:" value={`+${formatDZD(s.savDeposits)}`} /> : null}
      {s.savSettled > 0 ? <MoneyRow label="Soldes SAV encaissés:" value={`+${formatDZD(s.savSettled)}`} /> : null}
      {s.manualIn > 0 ? <MoneyRow label="Apports manuels:" value={`+${formatDZD(s.manualIn)}`} /> : null}
      {s.refunds > 0 ? <MoneyRow label="Remboursements client:" value={`-${formatDZD(s.refunds)}`} /> : null}
      {s.expenses > 0 ? <MoneyRow label="Dépenses de caisse:" value={`-${formatDZD(s.expenses)}`} /> : null}
      {s.tradeInCashOut > 0 ? <MoneyRow label="Rachats occasions:" value={`-${formatDZD(s.tradeInCashOut)}`} /> : null}
      {s.exchangeOut > 0 ? <MoneyRow label="Retours échanges:" value={`-${formatDZD(s.exchangeOut)}`} /> : null}
      {s.soulteOut > 0 ? <MoneyRow label="Soulte reprise décaissée:" value={`-${formatDZD(s.soulteOut)}`} /> : null}
      {s.manualOut > 0 ? <MoneyRow label="Dépenses manuelles:" value={`-${formatDZD(s.manualOut)}`} /> : null}
      {s.drops > 0 ? <MoneyRow label="Dépôts coffre:" value={`-${formatDZD(s.drops)}`} /> : null}
      {s.payouts > 0 ? <MoneyRow label="Décaissements:" value={`-${formatDZD(s.payouts)}`} /> : null}
    </div>

    <div className="py-2 border-b border-dashed border-gray-400 space-y-0.5">
      <MoneyRow label="ESPÈCES THÉORIQUES:" value={formatDZD(s.expectedCash)} strong />
      <MoneyRow label="COMPTÉ EN CAISSE:" value={formatDZD(s.countedCash)} strong />
      <div className="flex justify-between gap-2 font-extrabold">
        <span>ÉCART:</span>
        <span className="whitespace-nowrap">{s.variance >= 0 ? `+${formatDZD(s.variance)}` : formatDZD(s.variance)}</span>
      </div>
    </div>

    {(s.dropsList || []).length > 0 ? (
      <div className="py-2 border-b border-dashed border-gray-400">
        <p className="font-bold text-[10px] uppercase mb-1">Dépôts coffre-fort:</p>
        {(s.dropsList || []).map((drop) => (
          <div key={drop.id} className="flex justify-between gap-2 text-[10px]">
            <span>{drop.reason}</span>
            <span className="font-bold whitespace-nowrap">{formatDZD(drop.amount)}</span>
          </div>
        ))}
      </div>
    ) : null}

    <div className="pt-2 text-center">
      <p className="text-[10px]">Signature Caissier: ____________________</p>
      <p className="text-[10px] mt-1">Signature Gérant: ____________________</p>
      <p className="text-[9px] text-gray-600 mt-2">Document généré par Mobi-POS • *{s.zNumber}*</p>
    </div>
  </div>
);

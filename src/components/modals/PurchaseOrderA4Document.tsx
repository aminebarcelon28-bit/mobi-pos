import React from 'react';
import type { PurchaseOrder, POReceptionSnapshot, ReceiptSettings } from '../../types/pos';
import { formatDZD, formatDateTime, faitALine } from '../../types/pos';
import type { PurchaseOrderExportData } from '../../utils/purchaseOrderXlsx';

export interface PurchaseOrderA4DocumentProps {
  po: PurchaseOrder | PurchaseOrderExportData;
  receiptSettings?: ReceiptSettings | null;
  /** When true, renders optimized for on-screen preview (with paper frame & subtle borders). */
  previewMode?: boolean;
  /** When set, appends the Bon de Réception & Contrôle Fournisseur section. */
  reception?: POReceptionSnapshot | null;
}

function receptionLineStatus(ordered: number, received: number, reason?: string): string {
  if (reason && /d[eé]fectueux|défectueuse|cass[eé]|ab[îi]m|non conforme/i.test(reason)) return 'Défectueux';
  if (received < ordered) return 'Manquant';
  if (received > ordered) return 'Excédent';
  return 'Conforme';
}

export const PurchaseOrderA4Document: React.FC<PurchaseOrderA4DocumentProps> = ({
  po,
  receiptSettings,
  previewMode = false,
  reception = null,
}) => {
  const storeName = receiptSettings?.storeName || 'MOBI ACCESSORIES';
  const items = po.items || [];
  const totalUnits = items.reduce((sum, item) => sum + (item.suggestedQty || 0), 0);
  const grandTotal =
    po.totalAmount ??
    items.reduce((sum, item) => sum + (item.totalCost ?? (item.suggestedQty || 0) * (item.unitCost || 0)), 0);

  const status = 'status' in po ? po.status : 'En Attente';

  return (
    <div
      className={`po-a4-document bg-white text-slate-900 font-sans select-text ${
        previewMode ? 'p-8 sm:p-10 shadow-2xl rounded-sm max-w-[210mm] mx-auto border border-slate-200' : 'p-0 w-full'
      }`}
      style={{
        boxSizing: 'border-box',
        color: '#0f172a',
      }}
    >
      {/* Top brand accent bar */}
      <div className="h-1.5 w-full bg-gradient-to-r from-emerald-600 via-teal-500 to-emerald-400 rounded-t mb-5" />

      {/* Header: Software Emblem, Store Info & Document Reference Box */}
      <div className="flex flex-col sm:flex-row justify-between items-start gap-4 pb-4 border-b border-slate-200">
        {/* Brand & Software Identity */}
        <div className="flex items-start gap-3.5 min-w-0">
          {receiptSettings?.logoUrl ? (
            <img
              src={receiptSettings.logoUrl}
              alt={storeName}
              className="h-14 w-auto max-w-[140px] object-contain rounded-lg border border-slate-200 p-1 flex-shrink-0 bg-white"
            />
          ) : (
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-600 to-teal-700 flex items-center justify-center text-white shadow-md shadow-emerald-900/20 flex-shrink-0">
              {/* High-res vector MobiPOS mark */}
              <svg viewBox="0 0 24 24" className="w-7 h-7 fill-none stroke-white stroke-[2.2]" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
                <path d="M7 8h4" />
                <path d="M7 11h2" />
              </svg>
            </div>
          )}

          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base sm:text-lg font-black tracking-tight text-slate-900 uppercase">
                {storeName}
              </span>
              <span className="text-[9px] font-extrabold px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 tracking-wide uppercase">
                Acheteur
              </span>
            </div>
            <p className="text-[11px] text-slate-600 font-medium mt-0.5 leading-relaxed">
              {receiptSettings?.address || 'Algérie'}
              {receiptSettings?.phone ? ` • Tél : ${receiptSettings.phone}` : ''}
              {receiptSettings?.email ? ` • ${receiptSettings.email}` : ''}
            </p>
            <div className="flex items-center gap-1.5 mt-1 text-[10px] text-slate-500 font-medium">
              <span className="font-semibold text-emerald-800">Système officiel Mobi-POS</span>
              <span>•</span>
              <span>Document commercial d'approvisionnement</span>
            </div>
          </div>
        </div>

        {/* Reference & Metadata Card */}
        <div className="bg-slate-50 border border-slate-200/90 rounded-xl p-3 sm:p-3.5 text-right min-w-[210px] flex-shrink-0 self-stretch sm:self-auto">
          <div className="flex items-center justify-end gap-1.5 text-emerald-700 font-black text-[11px] uppercase tracking-wider mb-1">
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-none stroke-current stroke-2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            <span>Bon de commande</span>
          </div>

          <div className="text-lg sm:text-xl font-black font-mono text-slate-900 tracking-tight">
            #{po.poNumber}
          </div>

          <div className="text-[10px] text-slate-500 font-medium mt-1">
            Date : {formatDateTime(po.createdAt ? String(po.createdAt) : undefined)}
          </div>

          {status && (
            <div className="mt-1.5 flex justify-end">
              <span
                className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full border tracking-wider ${
                  status === 'Completed' || status === 'Received'
                    ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                    : status === 'Partially Received'
                    ? 'bg-cyan-100 text-cyan-800 border-cyan-300'
                    : 'bg-amber-100 text-amber-800 border-amber-300'
                }`}
              >
                {status === 'Waiting List' ? 'En Liste d\'Attente' : status}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Balanced Two-Column Buyer & Supplier Information Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 my-4">
        {/* Buyer Card */}
        <div className="bg-slate-50/70 border border-slate-200 rounded-xl p-3.5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-black uppercase text-emerald-800 tracking-wider">
                Acheteur — Magasin
              </span>
              <span className="text-[9px] text-slate-400 font-medium">Bénéficiaire</span>
            </div>
            <p className="text-sm font-black text-slate-900">{storeName}</p>
            {receiptSettings?.address && (
              <p className="text-xs text-slate-600 mt-1 leading-snug">{receiptSettings.address}</p>
            )}
            <p className="text-xs text-slate-500 mt-1">
              {receiptSettings?.phone ? `Tél : ${receiptSettings.phone}` : ''}
              {receiptSettings?.email ? ` • ${receiptSettings.email}` : ''}
            </p>
          </div>
          <div className="pt-2 mt-2 border-t border-slate-200/60 text-[10px] text-slate-500 flex justify-between">
            <span>Règlement prévu :</span>
            <span className="font-bold text-slate-700">Espèces / À réception</span>
          </div>
        </div>

        {/* Supplier Card */}
        <div className="bg-slate-50/70 border border-slate-200 rounded-xl p-3.5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-black uppercase text-slate-700 tracking-wider">
                Fournisseur — Grossiste
              </span>
              <span className="text-[9px] text-slate-400 font-medium">Émetteur du bon</span>
            </div>
            <p className="text-sm font-black text-slate-900">{po.vendorName}</p>
            <p className="text-xs text-slate-600 mt-1">
              Conditions : <span className="font-semibold text-slate-800">Paiement à réception des stocks</span>
            </p>
            {po.notes ? (
              <p className="text-xs text-slate-500 mt-1 italic">
                Notes : {po.notes}
              </p>
            ) : (
              <p className="text-xs text-slate-400 mt-1 italic">
                Réapprovisionnement officiel de stock pour point de vente
              </p>
            )}
          </div>
          <div className="pt-2 mt-2 border-t border-slate-200/60 text-[10px] text-slate-500 flex justify-between">
            <span>Délai de confirmation :</span>
            <span className="font-bold text-slate-700">Sous 24h ouvrées</span>
          </div>
        </div>
      </div>

      {/* Edge-to-Edge Product List Table */}
      <div className="my-4 border border-slate-200 rounded-xl overflow-hidden shadow-xs">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="bg-slate-100/90 text-slate-700 font-bold uppercase text-[10px] tracking-wider border-b border-slate-200">
              <th className="py-2.5 px-3 text-center w-[6%]">N°</th>
              <th className="py-2.5 px-3 text-left">Désignation du Produit</th>
              <th className="py-2.5 px-3 text-left w-[20%]">Réf. / SKU</th>
              <th className="py-2.5 px-3 text-center w-[10%]">Qté</th>
              <th className="py-2.5 px-3 text-right w-[16%]">P.U. (DA)</th>
              <th className="py-2.5 px-3 text-right w-[18%]">Montant (DA)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200/80">
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-6 text-center text-slate-400 italic">
                  Aucun article sélectionné sur ce bon de commande.
                </td>
              </tr>
            ) : (
              items.map((item, idx) => {
                const qty = item.suggestedQty || 0;
                const pu = item.unitCost || 0;
                const lineTotal = item.totalCost ?? qty * pu;
                const isEven = idx % 2 === 1;

                return (
                  <tr key={item.productId || `${item.sku}-${idx}`} className={isEven ? 'bg-slate-50/50' : 'bg-white'}>
                    <td className="py-2.5 px-3 text-center font-bold text-slate-400 text-[11px]">{idx + 1}</td>
                    <td className="py-2.5 px-3 text-left">
                      <span className="font-bold text-slate-900 block leading-tight">{item.title}</span>
                    </td>
                    <td className="py-2.5 px-3 text-left font-mono text-[10px] text-slate-600">
                      {item.sku || '—'}
                    </td>
                    <td className="py-2.5 px-3 text-center font-black font-mono text-slate-900 text-[12px]">
                      {qty}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-slate-700 text-[11px]">
                      {formatDZD(pu)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-black font-mono text-slate-900 text-[12px]">
                      {formatDZD(lineTotal)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Single Bold Grand Total (Strictly NO tax breakdown) */}
      <div className="bg-slate-900 text-white rounded-xl p-4 my-4 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-md">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-black uppercase tracking-wider text-emerald-400">
              Total Commande Fournisseur
            </span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              Net à Payer
            </span>
          </div>
          <p className="text-[11px] text-slate-300 mt-0.5">
            Total : <strong className="text-white">{items.length}</strong> références • <strong className="text-white">{totalUnits}</strong> unités commandées
          </p>
        </div>

        <div className="text-right flex items-baseline gap-2">
          <span className="text-xs uppercase font-extrabold text-slate-400">Grand Total :</span>
          <span className="text-2xl sm:text-3xl font-black font-mono text-emerald-400 tracking-tight">
            {formatDZD(grandTotal)}
          </span>
        </div>
      </div>

      {/* Reception PV — Commandée vs Reçue vs Écart + supplier invoice + dual sign-off */}
      {reception && (
        <div className="my-4 border border-emerald-200 rounded-xl overflow-hidden shadow-xs">
          <div className="bg-emerald-50 px-3 py-2.5 border-b border-emerald-200">
            <p className="text-xs font-black uppercase tracking-wider text-emerald-800">
              Bon de Réception & Contrôle Fournisseur
            </p>
            <p className="text-[10px] text-slate-600 mt-0.5">
              Facture / BL Fournisseur : <strong>{reception.supplierInvoice || 'Non renseignée'}</strong>
              {' • '}Réceptionné le : <strong>{new Date(reception.receivedAt || Date.now()).toLocaleString('fr-DZ')}</strong>
            </p>
          </div>
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-100/90 text-slate-700 font-bold uppercase text-[10px] tracking-wider border-b border-slate-200">
                <th className="py-2 px-3 text-left">Désignation du Produit</th>
                <th className="py-2 px-3 text-center w-[12%]">Commandée</th>
                <th className="py-2 px-3 text-center w-[12%]">Reçue</th>
                <th className="py-2 px-3 text-center w-[12%]">Écart</th>
                <th className="py-2 px-3 text-center w-[16%]">Statut</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/80">
              {items.map((item, idx) => {
                const pid = item.productId || `${item.sku || 'row'}-${idx}`;
                const ordered = item.suggestedQty || 0;
                const baseReceived = 'receivedQty' in item ? item.receivedQty ?? ordered : ordered;
                const received = Math.max(0, Math.round(reception.receivedQty[pid] ?? baseReceived));
                const gap = received - ordered;
                const baseReason = 'discrepancyReason' in item ? item.discrepancyReason || '' : '';
                const reason = reception.reasons?.[pid] || baseReason;
                const status = receptionLineStatus(ordered, received, reason);
                return (
                  <tr key={pid} className={idx % 2 === 1 ? 'bg-slate-50/50' : 'bg-white'}>
                    <td className="py-2 px-3 text-left">
                      <span className="font-bold text-slate-900 block leading-tight">{item.title}</span>
                      <span className="font-mono text-[10px] text-slate-600">{item.sku || '—'}</span>
                      {reason ? <span className="block text-[9px] italic text-amber-700">Réserve : {reason}</span> : null}
                    </td>
                    <td className="py-2 px-3 text-center font-mono text-slate-700">{ordered}</td>
                    <td className="py-2 px-3 text-center font-black font-mono text-slate-900">{received}</td>
                    <td className="py-2 px-3 text-center font-mono font-bold text-slate-900">{gap > 0 ? `+${gap}` : `${gap}`}</td>
                    <td className="py-2 px-3 text-center text-[10px] font-black uppercase">{status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="px-3 py-2 text-[10px] text-slate-600">{faitALine(receiptSettings)}</p>
          <div className="grid grid-cols-2 gap-4 p-3 pt-1">
            <div className="border border-slate-300 rounded-xl p-3 bg-white min-h-[110px] flex flex-col justify-between">
              <span className="text-[10px] font-black uppercase text-slate-800 tracking-wider block">
                Réceptionné et vérifié par le magasinier
              </span>
              <span className="text-[9px] text-slate-500 text-center block border-t border-slate-200 pt-1">
                Nom, date & signature
              </span>
            </div>
            <div className="border border-slate-300 rounded-xl p-3 bg-white min-h-[110px] flex flex-col justify-between">
              <span className="text-[10px] font-black uppercase text-slate-800 tracking-wider block">
                Viseur Fournisseur / Livreur
              </span>
              <span className="text-[9px] text-slate-500 text-center block border-t border-slate-200 pt-1">
                Nom, date & signature
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Commercial & Legal Terms */}
      <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-3 my-4 text-[10.5px] text-slate-600 space-y-1">
        <p className="flex items-center gap-1.5 font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
          <span>Ce bon de commande constitue un engagement ferme d'approvisionnement des références et quantités indiquées.</span>
        </p>
        <p className="flex items-center gap-1.5 font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
          <span>Les prix convenus sont fermes, définitifs et payables à la livraison sous réserve de conformité physique.</span>
        </p>
      </div>

      {/* Side-by-Side Signature and Stamp Boxes */}
      <div className="grid grid-cols-2 gap-4 my-4 pt-1">
        {/* Store Stamp Box */}
        <div className="border border-slate-300 rounded-xl p-3.5 bg-white flex flex-col justify-between min-h-[120px]">
          <div>
            <span className="text-[10px] font-black uppercase text-slate-800 tracking-wider block">
              Cachet & Signature — Magasin
            </span>
            <span className="text-[9px] text-slate-400 block mt-0.5">Pour l'établissement acheteur</span>
          </div>
          <div className="my-2 h-16 border border-dashed border-slate-300 rounded-lg bg-slate-50/50 flex items-center justify-center">
            <span className="text-[9px] text-slate-400 italic">Emplacement cachet humide & date</span>
          </div>
          <span className="text-[9px] text-slate-500 text-center block border-t border-slate-200 pt-1">
            Nom, prénom & signature autorisée
          </span>
        </div>

        {/* Supplier Stamp Box */}
        <div className="border border-slate-300 rounded-xl p-3.5 bg-white flex flex-col justify-between min-h-[120px]">
          <div>
            <span className="text-[10px] font-black uppercase text-slate-800 tracking-wider block">
              Cachet & Signature — Fournisseur
            </span>
            <span className="text-[9px] text-slate-400 block mt-0.5">Pour le grossiste / livreur</span>
          </div>
          <div className="my-2 h-16 border border-dashed border-slate-300 rounded-lg bg-slate-50/50 flex items-center justify-center">
            <span className="text-[9px] text-slate-400 italic">Emplacement cachet & signature</span>
          </div>
          <span className="text-[9px] text-slate-500 text-center block border-t border-slate-200 pt-1">
            Mention manuscrite « Reçu et accepté »
          </span>
        </div>
      </div>

      {/* Document Footer */}
      <div className="pt-3 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between text-[10px] text-slate-500 gap-1.5">
        <span>{storeName} • Tél : {receiptSettings?.phone || '—'}</span>
        <span className="font-semibold text-slate-600">
          Document généré par Mobi-POS • Système de Caisse & Gestion de Stock
        </span>
        <span>Page 1 / 1</span>
      </div>
    </div>
  );
};

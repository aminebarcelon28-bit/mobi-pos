/**
 * UPGRADE-06 — supplier RMA loop + warranty claims surface.
 *
 * Dedicated modal opened from RepairWorkOrderModal ("Retours & RMA"):
 *  1. Quarantine list — the first reader of `defective_returns` (v116).
 *  2. RMA creation from selected quarantine items (one claim per item).
 *  3. RMA lifecycle: draft → sent → credited (credit amount + AP reference +
 *     optional vendor-dispute link) / rejected → closed.
 *  4. Warranty claims — every redo ticket's absorbed bases and its redo rate,
 *     with an optional link to the parts RMA.
 *
 * Storage is merchant-local (migration v121); outside Tauri reads degrade to
 * empty and writes fail loud — the modal explains and disables.
 * Money: integer DZD everywhere; the credit entry uses <MoneyInput/> and the
 * single rounding boundary sits in the adapter.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle, Package, Undo2, Wrench } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, formatDateTime } from '../../types/pos';
import { useToast } from '../ui/Toast';
import { MoneyInput } from '../ui/MoneyInput';
import { dinarsToMinor, toLegacyReal } from '../../utils/money';
import {
  isSavRmaStorageAvailable,
  listDefectiveReturns,
  listPartRmas,
  listWarrantyClaims,
  createPartRma,
  updatePartRmaStatus,
  linkClaimToRma,
  type DefectiveReturnRecord,
  type RmaRecord,
  type WarrantyClaimRecord,
  type PartRmaStatus,
} from '../../db/adapters/savRmaAdapter';

interface SavRmaModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Tolerant lite shape of a stored vendor dispute (json_payload). */
interface VendorDisputeLite {
  id: string;
  supplierName?: string;
  status?: string;
  adjustedPayableTotal?: number;
  totalClaimAmount?: number;
}

const RMA_STATUS_LABELS: Record<PartRmaStatus, string> = {
  draft: 'Brouillon',
  sent: 'Envoyée',
  credited: 'Avoir reçu',
  rejected: 'Refusée',
  closed: 'Clôturée',
};

const RMA_STATUS_CLASSES: Record<PartRmaStatus, string> = {
  draft: 'bg-pos-hover text-pos-muted border-pos-border',
  sent: 'bg-sky-500/10 text-sky-500 border-sky-500/30',
  credited: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  rejected: 'bg-rose-500/10 text-rose-500 border-rose-500/30',
  closed: 'bg-pos-hover text-pos-muted border-pos-border',
};

export const SavRmaModal: React.FC<SavRmaModalProps> = ({ isOpen, onClose }) => {
  const { showToast } = useToast();
  const storageOk = isSavRmaStorageAvailable();
  const repairOrders = usePosStore((s) => s.repairOrders);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [defective, setDefective] = useState<DefectiveReturnRecord[]>([]);
  const [rmas, setRmas] = useState<RmaRecord[]>([]);
  const [claims, setClaims] = useState<WarrantyClaimRecord[]>([]);
  const [disputes, setDisputes] = useState<VendorDisputeLite[]>([]);

  // Creation form
  const [selectedReturnIds, setSelectedReturnIds] = useState<Set<string>>(new Set());
  const [supplierName, setSupplierName] = useState('');
  const [rmaNotes, setRmaNotes] = useState('');

  // Credit capture form (one RMA at a time)
  const [creditFormFor, setCreditFormFor] = useState<string | null>(null);
  const [creditMinor, setCreditMinor] = useState(0);
  const [apReference, setApReference] = useState('');
  const [vendorDisputeId, setVendorDisputeId] = useState('');

  const reload = useCallback(async () => {
    if (!storageOk) {
      setDefective([]);
      setRmas([]);
      setClaims([]);
      setDisputes([]);
      return;
    }
    setLoading(true);
    try {
      const { getVendorDisputes } = await import('../../db/sqlPluginAdapter');
      const [defRows, rmaRows, claimRows, disputeRows] = await Promise.all([
        listDefectiveReturns(),
        listPartRmas(),
        listWarrantyClaims(),
        getVendorDisputes<VendorDisputeLite>(),
      ]);
      setDefective(defRows);
      setRmas(rmaRows);
      setClaims(claimRows);
      setDisputes(Array.isArray(disputeRows) ? disputeRows : []);
    } finally {
      setLoading(false);
    }
  }, [storageOk]);

  useEffect(() => {
    if (isOpen) void reload();
  }, [isOpen, reload]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const inputClass =
    'w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none';
  const labelClass = 'text-[10px] uppercase font-bold text-pos-muted block mb-1';

  const orderById = new Map(repairOrders.map((o) => [o.id, o]));
  const labelForRepair = (id: string | null | undefined): string =>
    id ? (orderById.get(id)?.ticketNumber ?? id) : '—';

  const deliveredCount = repairOrders.filter((o) => o.status === 'Livré').length;
  const redoRatePct =
    deliveredCount > 0 ? ((claims.length / deliveredCount) * 100).toFixed(1).replace('.', ',') : null;

  const selectableReturns = defective.filter((d) => !d.rmaId);
  const selectedCount = selectableReturns.filter((d) => selectedReturnIds.has(d.id)).length;

  const toggleReturn = (id: string) => {
    setSelectedReturnIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreateRma = async () => {
    const supplier = supplierName.trim();
    if (!supplier) {
      showToast('Renseignez le fournisseur de la RMA.', 'warning');
      return;
    }
    const selected = selectableReturns.filter((d) => selectedReturnIds.has(d.id));
    if (selected.length === 0) {
      showToast('Sélectionnez au moins un retour défectueux.', 'warning');
      return;
    }
    setBusy(true);
    try {
      const id = await createPartRma({
        supplierName: supplier,
        notes: rmaNotes.trim() || undefined,
        lines: selected.map((d) => ({
          defectiveReturnId: d.id,
          productId: d.productId,
          productName: d.productName ?? undefined,
          imei: d.imei ?? undefined,
          quantity: d.quantity,
          unitCost: d.unitCost,
          reason: d.reason ?? undefined,
        })),
      });
      if (!id) {
        showToast('Création de la RMA impossible (retours déjà réclamés ou base indisponible).', 'error');
        return;
      }
      showToast(`RMA créée — ${selected.length} article${selected.length > 1 ? 's' : ''} réclamé${selected.length > 1 ? 's' : ''}.`, 'success');
      setSelectedReturnIds(new Set());
      setRmaNotes('');
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (
    rma: RmaRecord,
    status: PartRmaStatus,
    patch: { creditAmount?: number; apReference?: string; vendorDisputeId?: string | null } = {}
  ) => {
    setBusy(true);
    try {
      const ok = await updatePartRmaStatus(rma.id, status, patch);
      if (!ok) {
        showToast('Mise à jour de la RMA impossible.', 'error');
        return;
      }
      showToast(`RMA ${rma.supplierName} — ${RMA_STATUS_LABELS[status]}.`, 'success');
      setCreditFormFor(null);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const openCreditForm = (rma: RmaRecord) => {
    setCreditFormFor(rma.id);
    setCreditMinor(dinarsToMinor(Math.max(0, rma.linesTotalCost)));
    setApReference('');
    setVendorDisputeId('');
  };

  const handleSaveCredit = async (rma: RmaRecord) => {
    await changeStatus(rma, 'credited', {
      creditAmount: toLegacyReal(creditMinor),
      apReference: apReference.trim() || undefined,
      vendorDisputeId: vendorDisputeId || null,
    });
  };

  const handleLinkClaim = async (claim: WarrantyClaimRecord, rmaId: string) => {
    setBusy(true);
    try {
      const ok = await linkClaimToRma(claim.id, rmaId || null);
      if (!ok) {
        showToast('Liaison à la RMA impossible.', 'error');
        return;
      }
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[80] flex items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Retours et RMA — pièces défectueuses, crédits fournisseur et reprises garantie"
        onClick={(e) => e.stopPropagation()}
        className="bg-pos-panel border border-pos-border rounded-t-[28px] sm:rounded-xl w-full max-w-4xl max-h-[92dvh] flex flex-col shadow-2xl animate-in zoom-in-95 relative overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-pos-border px-4 py-3 shrink-0">
          <div className="flex items-center gap-2 text-emerald-400">
            <Package className="w-5 h-5" aria-hidden="true" />
            <h3 className="text-sm font-black text-pos-text">
              Retours &amp; RMA — Défectueux, Crédits &amp; Reprises
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer la gestion des retours et RMA"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition shrink-0"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {!storageOk && (
          <div className="mx-4 mt-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-bold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            La gestion des retours est disponible uniquement dans l&apos;application de bureau (base locale).
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-4">
          {loading ? (
            <p className="text-xs text-pos-muted py-8 text-center">Chargement…</p>
          ) : (
            <>
              {/* ── 1. Quarantine (defective returns) ── */}
              <div className="space-y-2">
                <p className="text-[10px] uppercase font-bold text-pos-muted flex items-center gap-1.5">
                  <Package className="w-3.5 h-3.5" aria-hidden="true" />
                  Retours défectueux en quarantaine ({selectableReturns.length} réclamables)
                </p>
                {defective.length === 0 ? (
                  <p className="text-xs text-pos-muted">
                    Aucun retour défectueux enregistré. Les remboursements de pièces défectueuses
                    alimentent cette liste automatiquement.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {defective.map((d) => {
                      const linked = Boolean(d.rmaId);
                      return (
                        <label
                          key={d.id}
                          className={`flex items-center gap-3 p-2.5 rounded-xl border text-xs ${
                            linked
                              ? 'border-pos-border bg-pos-bg opacity-70'
                              : 'border-pos-border bg-pos-card hover:border-emerald-500/40 cursor-pointer'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={selectedReturnIds.has(d.id)}
                            disabled={linked || !storageOk}
                            onChange={() => toggleReturn(d.id)}
                            aria-label={`Sélectionner le retour ${d.productName ?? d.productId}`}
                            className="accent-emerald-500 w-4 h-4 shrink-0"
                          />
                          <span className="flex-1 min-w-0">
                            <span className="block font-bold text-pos-text truncate">
                              {d.productName ?? d.productId}
                              {d.imei ? ` · ${d.imei}` : ''}
                            </span>
                            <span className="block text-[10px] text-pos-muted">
                              {formatDateTime(d.createdAt)} · Qté {d.quantity} · Coût{' '}
                              {formatDZD(d.unitCost)}
                              {d.reason ? ` · ${d.reason}` : ''}
                            </span>
                          </span>
                          {linked && (
                            <span className="shrink-0 px-2 py-1 rounded-lg text-[10px] font-bold bg-sky-500/10 text-sky-500 border border-sky-500/30">
                              Réclamé en RMA
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ── 2. Create RMA from selection ── */}
              <div className="p-3 rounded-xl border border-pos-border bg-pos-card space-y-2.5">
                <p className="text-[11px] font-black text-pos-text">
                  Nouvelle RMA fournisseur ({selectedCount} article{selectedCount > 1 ? 's' : ''}{' '}
                  sélectionné{selectedCount > 1 ? 's' : ''})
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label htmlFor="sr-supplier" className={labelClass}>
                      Fournisseur
                    </label>
                    <input
                      id="sr-supplier"
                      type="text"
                      list="sr-supplier-options"
                      value={supplierName}
                      onChange={(e) => setSupplierName(e.target.value)}
                      placeholder="Nom du fournisseur"
                      className={inputClass}
                    />
                    <datalist id="sr-supplier-options">
                      {[...new Set(rmas.map((r) => r.supplierName))].map((name) => (
                        <option key={name} value={name} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label htmlFor="sr-notes" className={labelClass}>
                      Note (optionnel)
                    </label>
                    <input
                      id="sr-notes"
                      type="text"
                      value={rmaNotes}
                      onChange={(e) => setRmaNotes(e.target.value)}
                      placeholder="Référence, transporteur…"
                      className={inputClass}
                    />
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => void handleCreateRma()}
                    disabled={!storageOk || busy || selectedCount === 0 || !supplierName.trim()}
                    className="px-3 py-2 min-h-[38px] rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 text-[11px] font-black cursor-pointer"
                  >
                    Créer la RMA avec la sélection
                  </button>
                </div>
              </div>

              {/* ── 3. RMAs ── */}
              <div className="space-y-2">
                <p className="text-[10px] uppercase font-bold text-pos-muted flex items-center gap-1.5">
                  <Wrench className="w-3.5 h-3.5" aria-hidden="true" />
                  RMAs fournisseur ({rmas.length})
                </p>
                {rmas.length === 0 ? (
                  <p className="text-xs text-pos-muted">Aucune RMA. Sélectionnez des retours ci-dessus.</p>
                ) : (
                  rmas.map((rma) => (
                    <div
                      key={rma.id}
                      className="p-3 rounded-xl border border-pos-border bg-pos-card space-y-2"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-xs text-pos-text">{rma.supplierName}</span>
                        <span
                          className={`px-2 py-0.5 rounded-lg text-[10px] font-bold border ${RMA_STATUS_CLASSES[rma.status]}`}
                        >
                          {RMA_STATUS_LABELS[rma.status]}
                        </span>
                        <span className="text-[10px] text-pos-muted font-mono tabular-nums">
                          {rma.lineCount} art. · coût réclamé {formatDZD(rma.linesTotalCost)}
                        </span>
                        {rma.status === 'credited' && (
                          <span className="px-2 py-0.5 rounded-lg text-[10px] font-bold bg-emerald-500/10 text-emerald-500 border border-emerald-500/30 font-mono tabular-nums">
                            Avoir : {formatDZD(rma.creditAmount)}
                            {rma.apReference ? ` (${rma.apReference})` : ''}
                          </span>
                        )}
                        {rma.vendorDisputeId && (
                          <span className="px-2 py-0.5 rounded-lg text-[10px] font-bold bg-cyan-500/10 text-cyan-500 border border-cyan-500/30">
                            Litige lié
                          </span>
                        )}
                        <span className="text-[10px] text-pos-muted ml-auto">
                          {formatDateTime(rma.openedAt)}
                          {rma.sentAt ? ` · envoyée ${formatDateTime(rma.sentAt)}` : ''}
                          {rma.closedAt ? ` · clôturée ${formatDateTime(rma.closedAt)}` : ''}
                        </span>
                      </div>
                      {rma.notes && <p className="text-[10px] text-pos-muted">{rma.notes}</p>}

                      <div className="flex flex-wrap gap-2">
                        {rma.status === 'draft' && (
                          <button
                            type="button"
                            onClick={() => void changeStatus(rma, 'sent')}
                            disabled={busy}
                            className="px-3 py-1.5 min-h-[32px] rounded-lg bg-sky-500/10 hover:bg-sky-500/20 text-sky-500 border border-sky-500/30 text-[10px] font-bold cursor-pointer disabled:opacity-40"
                          >
                            Marquer envoyée
                          </button>
                        )}
                        {rma.status === 'sent' && (
                          <button
                            type="button"
                            onClick={() => openCreditForm(rma)}
                            disabled={busy}
                            className="px-3 py-1.5 min-h-[32px] rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 border border-emerald-500/30 text-[10px] font-bold cursor-pointer disabled:opacity-40"
                          >
                            Enregistrer l&apos;avoir
                          </button>
                        )}
                        {(rma.status === 'draft' || rma.status === 'sent') && (
                          <button
                            type="button"
                            onClick={() => void changeStatus(rma, 'rejected')}
                            disabled={busy}
                            className="px-3 py-1.5 min-h-[32px] rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 border border-rose-500/30 text-[10px] font-bold cursor-pointer disabled:opacity-40"
                          >
                            Refusée par le fournisseur
                          </button>
                        )}
                        {(rma.status === 'credited' || rma.status === 'rejected') && (
                          <button
                            type="button"
                            onClick={() => void changeStatus(rma, 'closed')}
                            disabled={busy}
                            className="px-3 py-1.5 min-h-[32px] rounded-lg bg-pos-hover hover:bg-pos-border text-pos-text text-[10px] font-bold cursor-pointer disabled:opacity-40"
                          >
                            Clôturer
                          </button>
                        )}
                      </div>

                      {/* Credit capture */}
                      {creditFormFor === rma.id && (
                        <div className="p-3 rounded-xl border border-pos-border bg-pos-bg space-y-2.5">
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                            <div>
                              <label htmlFor={`sr-credit-${rma.id}`} className={labelClass}>
                                Montant de l&apos;avoir (DA)
                              </label>
                              <MoneyInput
                                id={`sr-credit-${rma.id}`}
                                label="Montant de l'avoir (DA)"
                                valueMinor={creditMinor}
                                onChangeMinor={setCreditMinor}
                                className="w-full h-10 sm:h-9 bg-pos-card border border-pos-border rounded-lg px-3 py-1.5 text-base sm:text-xs font-normal font-mono tabular-nums text-pos-text placeholder:text-pos-muted focus:outline-none focus:ring-1 focus:ring-emerald-500"
                              />
                            </div>
                            <div>
                              <label htmlFor={`sr-apref-${rma.id}`} className={labelClass}>
                                Référence avoir / litige
                              </label>
                              <input
                                id={`sr-apref-${rma.id}`}
                                type="text"
                                value={apReference}
                                onChange={(e) => setApReference(e.target.value)}
                                placeholder="N° avoir fournisseur"
                                className={inputClass}
                              />
                            </div>
                            <div>
                              <label htmlFor={`sr-dispute-${rma.id}`} className={labelClass}>
                                Litige fournisseur (optionnel)
                              </label>
                              <select
                                id={`sr-dispute-${rma.id}`}
                                value={vendorDisputeId}
                                onChange={(e) => setVendorDisputeId(e.target.value)}
                                className={inputClass}
                              >
                                <option value="">— Aucun —</option>
                                {disputes.map((d) => (
                                  <option key={d.id} value={d.id}>
                                    {(d.supplierName ?? 'Fournisseur') +
                                      ' · ' +
                                      (d.status ?? 'DRAFT') +
                                      ' · ' +
                                      formatDZD(d.adjustedPayableTotal ?? d.totalClaimAmount ?? 0)}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setCreditFormFor(null)}
                              className="px-3 py-2 min-h-[38px] rounded-lg bg-pos-hover text-pos-muted hover:text-pos-text text-[11px] font-bold cursor-pointer"
                            >
                              Annuler
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleSaveCredit(rma)}
                              disabled={busy}
                              className="px-3 py-2 min-h-[38px] rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-[11px] font-black cursor-pointer"
                            >
                              Valider l&apos;avoir
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              {/* ── 4. Warranty claims ── */}
              <div className="space-y-2">
                <p className="text-[10px] uppercase font-bold text-pos-muted flex items-center gap-1.5">
                  <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
                  Garanties &amp; reprises ({claims.length}
                  {redoRatePct !== null ? ` — ${redoRatePct} % des livraisons` : ''})
                </p>
                {claims.length === 0 ? (
                  <p className="text-xs text-pos-muted">
                    Aucune reprise garantie. Un ticket créé comme reprise d&apos;un ticket livré
                    ouvre automatiquement une ligne ici.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {claims.map((claim) => (
                      <div
                        key={claim.id}
                        className="p-3 rounded-xl border border-pos-border bg-pos-card space-y-1.5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-bold text-pos-text">
                            Reprise {labelForRepair(claim.reworkRepairId)} ← ticket{' '}
                            {labelForRepair(claim.originalRepairId)}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-lg text-[10px] font-bold border ${
                              claim.status === 'open'
                                ? 'bg-amber-500/10 text-amber-500 border-amber-500/30'
                                : 'bg-pos-hover text-pos-muted border-pos-border'
                            }`}
                          >
                            {claim.status === 'open' ? 'Ouverte' : 'Clôturée'}
                          </span>
                          <span className="text-[10px] text-pos-muted font-mono tabular-nums">
                            MO absorbée {formatDZD(claim.laborBasis)} · Pièces absorbées{' '}
                            {formatDZD(claim.partsBasis)}
                          </span>
                        </div>
                        <p className="text-[10px] text-pos-muted">
                          Ouverte le {formatDateTime(claim.openedAt)}
                          {claim.closedAt ? ` · clôturée le ${formatDateTime(claim.closedAt)}` : ''}
                          {claim.notes ? ` · ${claim.notes}` : ''}
                        </p>
                        {claim.status === 'open' && rmas.length > 0 && (
                          <div className="flex items-center gap-2">
                            <label
                              htmlFor={`sr-claim-rma-${claim.id}`}
                              className="text-[10px] uppercase font-bold text-pos-muted"
                            >
                              RMA pièces
                            </label>
                            <select
                              id={`sr-claim-rma-${claim.id}`}
                              value={claim.rmaId ?? ''}
                              onChange={(e) => void handleLinkClaim(claim, e.target.value)}
                              disabled={busy}
                              className="bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer disabled:opacity-40"
                            >
                              <option value="">— Aucune —</option>
                              {rmas.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {r.supplierName} · {RMA_STATUS_LABELS[r.status]}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

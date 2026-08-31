import React from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  Wrench,
  Receipt,
  X,
  User,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';

export const ImeiWarrantyInspectorModal: React.FC = () => {
  const { activeModal, closeModal, activeImeiDossier, openModal } = usePosStore();

  if (activeModal !== 'imei_inspector' || !activeImeiDossier) return null;
  const d = activeImeiDossier;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none animate-in fade-in">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-in zoom-in-95 flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-pos-border bg-pos-card flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <div>
              <h2 className="text-sm font-bold text-pos-text">
                Dossier Traçabilité & Statut de Garantie IMEI
              </h2>
              <p className="text-[11px] text-pos-muted font-mono">IMEI : {d.imei}</p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 space-y-4">
          {/* Status Banner */}
          <div
            className={`p-4 rounded-xl border flex items-center gap-3 ${
              d.isWarrantyValid
                ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                : 'bg-red-500/10 border-red-500/40 text-red-300'
            }`}
          >
            {d.isWarrantyValid ? (
              <ShieldCheck className="w-8 h-8 text-emerald-400 shrink-0" />
            ) : (
              <ShieldAlert className="w-8 h-8 text-red-400 shrink-0" />
            )}
            <div>
              <p className="text-sm font-black uppercase">
                {d.isWarrantyValid ? 'Garantie Magasin Active' : 'Garantie Expirée / Hors Garantie'}
              </p>
              <p className="text-xs mt-0.5">
                {d.isWarrantyValid
                  ? `Valable encore ${d.daysRemaining} jours (Jusqu'au ${new Date(
                      d.warrantyExpiresAt!
                    ).toLocaleDateString('fr-DZ')})`
                  : d.warrantyExpiresAt
                  ? `A expiré le ${new Date(d.warrantyExpiresAt).toLocaleDateString('fr-DZ')}`
                  : 'Aucune garantie enregistrée sur ce numéro de série.'}
              </p>
            </div>
          </div>

          {/* Device & Purchase Card */}
          <div className="bg-pos-bg border border-pos-border rounded-xl p-3.5 space-y-2 text-xs">
            <div className="flex justify-between border-b border-pos-border/50 pb-2">
              <span className="text-pos-muted">Appareil :</span>
              <span className="font-bold text-pos-text">{d.productTitle}</span>
            </div>
            <div className="flex justify-between border-b border-pos-border/50 pb-2">
              <span className="text-pos-muted flex items-center gap-1">
                <Receipt className="w-3.5 h-3.5" /> Facture d'Origine :
              </span>
              <span className="font-mono font-bold text-emerald-400">
                {d.originalReceiptNumber || 'N/A'}
              </span>
            </div>
            <div className="flex justify-between border-b border-pos-border/50 pb-2">
              <span className="text-pos-muted flex items-center gap-1">
                <User className="w-3.5 h-3.5" /> Client Acheteur :
              </span>
              <span className="font-bold text-pos-text">
                {d.originalCustomerName || 'Client Comptoir'} ({d.originalCustomerPhone || '-'})
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-pos-muted flex items-center gap-1">
                <Wrench className="w-3.5 h-3.5" /> Réparations SAV Précédentes :
              </span>
              <span className="font-bold text-pos-text">{d.repairHistoryCount} intervention(s)</span>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between">
          <button
            onClick={closeModal}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text"
          >
            Fermer
          </button>
          <button
            onClick={() => {
              closeModal();
              openModal('repair_work_order');
            }}
            className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 transition active:scale-[0.98]"
          >
            <Wrench className="w-4 h-4" /> Créer Prise en Charge SAV
          </button>
        </div>
      </div>
    </div>
  );
};

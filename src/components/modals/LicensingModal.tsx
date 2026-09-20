import React from 'react';
import { X, ShieldCheck, Cpu, Key, Lock } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';

export const LicensingModal: React.FC = () => {
  const { activeModal, closeModal, licenseDetails } = usePosStore();

  if (activeModal !== 'licensing') return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 select-none">
      <div className="bg-pos-panel border-t sm:border border-pos-border rounded-t-3xl sm:rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 max-h-[92vh] flex flex-col pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] sm:py-0">
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2 text-emerald-400 min-w-0">
            <Lock className="w-5 h-5 shrink-0" />
            <h2 className="text-sm font-bold text-pos-text truncate">
              Licence Cryptographique (Ed25519)
            </h2>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-5 space-y-4 flex-1 overflow-y-auto">
          <div className="bg-emerald-950/40 border border-emerald-500/40 rounded-xl p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <ShieldCheck className="w-8 h-8 text-emerald-400 shrink-0" />
              <div>
                <p className="text-xs font-bold text-pos-text">Licence Entreprise Active</p>
                <p className="text-[10px] text-emerald-300 font-mono">Status: Validé par Signature Ed25519</p>
              </div>
            </div>
            <span className="text-[10px] font-bold text-emerald-400 bg-emerald-950 border border-emerald-800 px-2 py-0.5 rounded shrink-0">
              VERIFIED
            </span>
          </div>

          <div className="space-y-2 bg-pos-bg border border-pos-border rounded-xl p-3 text-xs">
            <div className="flex flex-col sm:flex-row sm:justify-between gap-0.5 sm:gap-2">
              <span className="text-pos-muted flex items-center gap-1"><Cpu className="w-3.5 h-3.5" /> Empreinte HWID:</span>
              <span className="font-mono font-bold text-pos-text truncate">{licenseDetails.machineFingerprint}</span>
            </div>
            <div className="flex flex-col sm:flex-row sm:justify-between gap-0.5 sm:gap-2">
              <span className="text-pos-muted flex items-center gap-1"><Key className="w-3.5 h-3.5" /> Clé Licence:</span>
              <span className="font-mono text-emerald-400 truncate">{licenseDetails.licenseKey}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-pos-muted">Terminaux Autorisés:</span>
              <span className="font-bold text-pos-text">{licenseDetails.maxTerminals} Caisses</span>
            </div>
            <div className="flex justify-between">
              <span className="text-pos-muted">Date d'Activation:</span>
              <span className="font-bold text-pos-text">{licenseDetails.activatedAt}</span>
            </div>
          </div>
        </div>

        <div className="p-3 sm:p-4 border-t border-pos-border bg-pos-card flex justify-end shrink-0">
          <button
            onClick={closeModal}
            className="w-full sm:w-auto px-5 py-2.5 rounded-xl text-xs font-bold text-pos-text bg-pos-hover hover:bg-pos-border transition min-h-[44px] flex items-center justify-center active-press"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};

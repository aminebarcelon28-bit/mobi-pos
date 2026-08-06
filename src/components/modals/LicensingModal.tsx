import React from 'react';
import { X, ShieldCheck, Cpu, Key, Lock } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';

export const LicensingModal: React.FC = () => {
  const { activeModal, closeModal, licenseDetails } = usePosStore();

  if (activeModal !== 'licensing') return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in-95">
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
          <div className="flex items-center gap-2 text-emerald-400">
            <Lock className="w-5 h-5" />
            <h2 className="text-sm font-bold text-pos-text">
              Licence Matérielle Cryptographique (Ed25519)
            </h2>
          </div>
          <button onClick={closeModal} className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="bg-emerald-950/40 border border-emerald-500/40 rounded-xl p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <ShieldCheck className="w-8 h-8 text-emerald-400" />
              <div>
                <p className="text-xs font-bold text-pos-text">Licence Entreprise Active</p>
                <p className="text-[10px] text-emerald-300 font-mono">Status: Validé par Signature Ed25519</p>
              </div>
            </div>
            <span className="text-[10px] font-bold text-emerald-400 bg-emerald-950 border border-emerald-800 px-2 py-0.5 rounded">
              VERIFIED
            </span>
          </div>

          <div className="space-y-2 bg-pos-bg border border-pos-border rounded-xl p-3 text-xs">
            <div className="flex justify-between">
              <span className="text-pos-muted flex items-center gap-1"><Cpu className="w-3.5 h-3.5" /> Empreinte Matérielle CPU/HWID:</span>
              <span className="font-mono font-bold text-pos-text">{licenseDetails.machineFingerprint}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-pos-muted flex items-center gap-1"><Key className="w-3.5 h-3.5" /> Clé de Licence Cryptographique:</span>
              <span className="font-mono text-emerald-400">{licenseDetails.licenseKey}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-pos-muted">Nombre Max Termineaux Autorisés:</span>
              <span className="font-bold text-pos-text">{licenseDetails.maxTerminals} Caisses</span>
            </div>
            <div className="flex justify-between">
              <span className="text-pos-muted">Date d'Activation:</span>
              <span className="font-bold text-pos-text">{licenseDetails.activatedAt}</span>
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-pos-border bg-pos-card flex justify-end">
          <button onClick={closeModal} className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-text bg-pos-hover">
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};

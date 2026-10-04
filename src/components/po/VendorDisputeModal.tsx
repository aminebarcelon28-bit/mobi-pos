import React, { useState } from 'react';
import {
  X,
  AlertTriangle,
  Send,
  Copy,
  Printer,
  Check,
  Phone,
} from 'lucide-react';
import { formatDZD } from '../../types/pos';
import { normalizeAlgerianPhone } from '../../utils/phoneUtils';
import { DzPhoneInput } from '../ui/DzPhoneInput';
import type { DisputeBrief } from '../../utils/disputeGenerator';

interface VendorDisputeModalProps {
  brief: DisputeBrief;
  onClose: () => void;
}

export const VendorDisputeModal: React.FC<VendorDisputeModalProps> = ({
  brief,
  onClose,
}) => {
  const [phoneNumber, setPhoneNumber] = useState(brief.supplierPhone || '');
  const [activeLang, setActiveLang] = useState<'fr' | 'ar'>('fr');
  const [copied, setCopied] = useState(false);

  const phoneNorm = normalizeAlgerianPhone(phoneNumber);
  const activeMessage = activeLang === 'fr' ? brief.whatsAppTextFr : brief.whatsAppTextAr;

  const handleCopyText = async () => {
    try {
      await navigator.clipboard.writeText(activeMessage);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback
    }
  };

  const handleOpenWhatsApp = () => {
    const targetDigits = phoneNorm.whatsAppFormat || phoneNumber.replace(/\D/g, '');
    const url = `https://wa.me/${targetDigits}?text=${encodeURIComponent(activeMessage)}`;
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const handlePrintDisputeSheet = () => {
    if (typeof window !== 'undefined') {
      window.print();
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-4 overflow-y-auto animate-in fade-in">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-2xl max-h-[92dvh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="p-4 bg-gradient-to-r from-rose-950/50 via-slate-900 to-slate-900 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-2xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-extrabold text-white flex items-center gap-2">
                <span>Dossier de Litige & Réclamation Fournisseur</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-rose-950 text-rose-300 border border-rose-800">
                  Avoir Demandé
                </span>
              </h2>
              <p className="text-[11px] text-slate-400">
                Génération automatique du dossier contradictoire pour négociation & avoir.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="p-4 sm:p-5 space-y-4 overflow-y-auto flex-1 text-xs">
          {/* Executive Claim Summary Banner */}
          <div className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div>
              <span className="text-[10px] font-bold text-slate-500 uppercase block">Fournisseur</span>
              <span className="text-xs font-bold text-white truncate block">{brief.supplierName}</span>
            </div>
            <div>
              <span className="text-[10px] font-bold text-slate-500 uppercase block">Facture Initiale</span>
              <span className="text-xs font-mono font-bold text-slate-300">
                {formatDZD(brief.originalReportedTotal)}
              </span>
            </div>
            <div>
              <span className="text-[10px] font-bold text-rose-400 uppercase block">Avoir Réclamé (Δ)</span>
              <span className="text-xs font-mono font-extrabold text-rose-400">
                -{formatDZD(brief.totalClaimAmount)}
              </span>
            </div>
            <div>
              <span className="text-[10px] font-bold text-emerald-400 uppercase block">Net Réglé Rectifié</span>
              <span className="text-xs font-mono font-extrabold text-emerald-300">
                {formatDZD(brief.adjustedPayableTotal)}
              </span>
            </div>
          </div>

          {/* Itemized Discrepancy Cards */}
          <div className="space-y-2">
            <h3 className="text-xs font-bold text-slate-300 flex items-center justify-between">
              <span>Lignes Contestées ({brief.items.length})</span>
              <span className="text-[10px] text-slate-500 font-normal">
                Contrôle arithmétique & tarifaire catalogué
              </span>
            </h3>

            {brief.items.length === 0 ? (
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-slate-400 text-center">
                Aucune surfacturation unitaire détectée. Écart global sur total document : {formatDZD(brief.mathDelta)}.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {brief.items.map((it) => (
                  <div
                    key={it.id}
                    className="p-2.5 rounded-xl bg-slate-950/80 border border-rose-950/80 hover:border-rose-700/60 transition space-y-1"
                  >
                    <div className="flex items-center justify-between text-xs font-bold">
                      <span className="text-white truncate max-w-[280px]">
                        #{it.lineIndex} - {it.description}
                      </span>
                      <span className="text-rose-400 font-mono">
                        +{formatDZD(it.claimAmount)}
                      </span>
                    </div>
                    <p className="text-[11px] text-rose-300/90 leading-tight">
                      {it.reason}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* WhatsApp Direct Dispatch Card */}
          <div className="bg-slate-950 rounded-2xl border border-slate-800 p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Send className="w-4 h-4 text-emerald-400" />
                <span className="font-bold text-white text-xs">Transmission Directe WhatsApp</span>
              </div>

              {/* Language Switch */}
              <div className="flex items-center bg-slate-900 p-0.5 rounded-xl border border-slate-800">
                <button
                  type="button"
                  onClick={() => setActiveLang('fr')}
                  className={`px-2 py-0.5 rounded-lg text-[10px] font-bold transition cursor-pointer ${
                    activeLang === 'fr'
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Français
                </button>
                <button
                  type="button"
                  onClick={() => setActiveLang('ar')}
                  className={`px-2 py-0.5 rounded-lg text-[10px] font-bold transition cursor-pointer ${
                    activeLang === 'ar'
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  العربية
                </button>
              </div>
            </div>

            {/* Phone Input */}
            <div>
              <label className="text-[10px] font-bold text-slate-400 block mb-1">
                Numéro WhatsApp du Fournisseur / Commercial
              </label>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Phone className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <DzPhoneInput
                    value={phoneNumber}
                    onChange={setPhoneNumber}
                    placeholder="Ex: 0550 12 34 56 ou 0661 00 11 22"
                    showBadge={false}
                    showHint={false}
                    inputClassName="w-full bg-slate-900 border border-slate-700 rounded-xl pl-8 pr-3 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-emerald-500"
                  />
                </div>
                {phoneNorm.isValid && (
                  <span className="text-[10px] font-bold px-2 py-1 rounded bg-emerald-950 text-emerald-300 border border-emerald-800">
                    {phoneNorm.operator}
                  </span>
                )}
              </div>
            </div>

            {/* Preview Text Box */}
            <div className="relative">
              <textarea
                readOnly
                value={activeMessage}
                rows={6}
                className="w-full bg-slate-900 border border-slate-800 rounded-xl p-2.5 text-slate-300 font-mono text-[11px] leading-relaxed resize-none focus:outline-none"
              />
              <button
                type="button"
                onClick={handleCopyText}
                className="absolute top-2 right-2 px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-bold flex items-center gap-1 border border-slate-700 transition cursor-pointer"
              >
                {copied ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span>Copié !</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>Copier</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 bg-slate-950 border-t border-slate-800 flex items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            onClick={handlePrintDisputeSheet}
            className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5 text-indigo-400" />
            <span>Imprimer Bordereau Litige</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 text-xs font-bold text-slate-400 hover:text-white cursor-pointer"
            >
              Fermer
            </button>
            <button
              type="button"
              onClick={handleOpenWhatsApp}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-extrabold flex items-center gap-2 shadow-lg shadow-emerald-950 transition active:scale-95 cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Envoyer sur WhatsApp (1-Clic)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

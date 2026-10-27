import React, { useState, useMemo, useEffect } from 'react';
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
import { usePosStore } from '../../store/usePosStore';
import type { DisputeBrief } from '../../utils/disputeGenerator';

export interface StoredVendorDispute {
  id: string;
  poId?: string;
  supplierName: string;
  supplierPhone: string;
  invoiceNumber: string;
  invoiceDate: string;
  originalReportedTotal: number;
  totalClaimAmount: number;
  adjustedPayableTotal: number;
  status: 'DRAFT' | 'TRANSMITTED_WHATSAPP' | 'PRINTED' | 'RESOLVED';
  itemsCount: number;
  items: Array<{
    lineIndex: number;
    description: string;
    claimAmount: number;
    reason: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

const DISPUTES_STORAGE_KEY = 'mobi_pos_vendor_disputes';

export function getStoredDisputes(): StoredVendorDispute[] {
  try {
    const raw = localStorage.getItem(DISPUTES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveStoredDispute(dispute: StoredVendorDispute): void {
  try {
    const list = getStoredDisputes();
    const idx = list.findIndex((d) => d.id === dispute.id);
    if (idx >= 0) {
      list[idx] = dispute;
    } else {
      list.unshift(dispute);
    }
    localStorage.setItem(DISPUTES_STORAGE_KEY, JSON.stringify(list));
    import('../../db/database').then(({ dexieDb }) => {
      dexieDb.appSettings.put({ key: `dispute_${dispute.id}`, value: JSON.stringify(dispute) }).catch(() => {});
    }).catch(() => {});
    import('../../db/sqlPluginAdapter').then(({ saveVendorDispute }) => {
      saveVendorDispute(dispute).catch(() => {});
    }).catch(() => {});
  } catch (e) {
    console.warn('[VendorDispute] Failed to persist dispute:', e);
  }
}

interface VendorDisputeModalProps {
  brief: DisputeBrief;
  onClose: () => void;
}

export const VendorDisputeModal: React.FC<VendorDisputeModalProps> = ({
  brief,
  onClose,
}) => {
  const vendorDirectory = usePosStore((s) => s.vendorDirectory);
  const setVendorContact = usePosStore((s) => s.setVendorContact);

  const initialPhone = useMemo(() => {
    if (brief.supplierPhone && brief.supplierPhone.trim()) {
      return brief.supplierPhone;
    }
    const dirContact = vendorDirectory?.[brief.supplierName];
    return dirContact?.whatsapp || dirContact?.phone || '';
  }, [brief.supplierPhone, brief.supplierName, vendorDirectory]);

  const [phoneNumber, setPhoneNumber] = useState(initialPhone);
  const [activeLang, setActiveLang] = useState<'fr' | 'ar'>('fr');
  const [copied, setCopied] = useState(false);
  const [savedDispute, setSavedDispute] = useState(false);

  const disputeId = useMemo(() => {
    return `disp-${brief.supplierName.toLowerCase().replace(/\s+/g, '-')}-${brief.invoiceNumber || 'draft'}-${brief.invoiceDate || 'now'}`;
  }, [brief.supplierName, brief.invoiceNumber, brief.invoiceDate]);

  // Persist dispute claim on mount / updates
  useEffect(() => {
    const claimRecord: StoredVendorDispute = {
      id: disputeId,
      poId: brief.poId,
      supplierName: brief.supplierName,
      supplierPhone: phoneNumber,
      invoiceNumber: brief.invoiceNumber || 'S/N',
      invoiceDate: brief.invoiceDate || new Date().toISOString().slice(0, 10),
      originalReportedTotal: brief.originalReportedTotal,
      totalClaimAmount: brief.totalClaimAmount,
      adjustedPayableTotal: brief.adjustedPayableTotal,
      status: 'DRAFT',
      itemsCount: brief.items.length,
      items: brief.items.map((it) => ({
        lineIndex: it.lineIndex,
        description: it.description,
        claimAmount: it.claimAmount,
        reason: it.reason,
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveStoredDispute(claimRecord);
    setSavedDispute(true);
  }, [disputeId, brief, phoneNumber]);

  // If user modifies phone number, sync to vendorDirectory if valid
  const handlePhoneChange = (val: string) => {
    setPhoneNumber(val);
    const norm = normalizeAlgerianPhone(val);
    if (norm.isValid) {
      setVendorContact(brief.supplierName, { phone: val, whatsapp: norm.whatsAppFormat || val });
    }
  };

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
    const existing = getStoredDisputes().find((d) => d.id === disputeId);
    if (existing) {
      saveStoredDispute({
        ...existing,
        status: 'TRANSMITTED_WHATSAPP',
        supplierPhone: phoneNumber,
        updatedAt: new Date().toISOString(),
      });
    }
  };

  const handlePrintDisputeSheet = () => {
    const existing = getStoredDisputes().find((d) => d.id === disputeId);
    if (existing) {
      saveStoredDispute({
        ...existing,
        status: 'PRINTED',
        updatedAt: new Date().toISOString(),
      });
    }
    if (typeof window !== 'undefined') {
      window.print();
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-md flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 overflow-y-auto animate-in fade-in select-none">
      <div className="bg-slate-900 border-t sm:border border-slate-800 rounded-t-[28px] sm:rounded-3xl w-full max-w-2xl max-h-[94dvh] sm:max-h-[92dvh] flex flex-col shadow-2xl overflow-hidden">
        {/* M3 Standard Drag Handle */}
        <div className="w-12 h-1.5 rounded-full bg-slate-700/60 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" aria-hidden="true" />

        {/* Header */}
        <div className="p-4 bg-gradient-to-r from-rose-950/50 via-slate-900 to-slate-900 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-2xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-extrabold text-white flex items-center gap-2 flex-wrap">
                <span>Dossier de Litige & Réclamation Fournisseur</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-rose-950 text-rose-300 border border-rose-800">
                  Avoir Demandé
                </span>
                {savedDispute && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800 flex items-center gap-1">
                    <Check className="w-3 h-3 text-emerald-400" /> Litige Enregistré
                  </span>
                )}
              </h2>
              <p className="text-[11px] text-slate-400">
                Génération automatique du dossier contradictoire pour négociation & avoir.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="Fermer le dossier de litige"
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
                    onChange={handlePhoneChange}
                    placeholder="Ex: 0550 00 22 22 ou 0661 00 11 22"
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
        <div className="p-4 bg-slate-950 border-t border-slate-800 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 shrink-0 pb-[max(1rem,var(--safe-bottom))] sm:pb-4">
          <button
            type="button"
            onClick={handlePrintDisputeSheet}
            className="min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold flex items-center justify-center gap-1.5 transition active-press cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5 text-indigo-400" />
            <span>Imprimer Bordereau Litige</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-3.5 py-2 text-xs font-bold text-slate-400 hover:text-white cursor-pointer active-press flex-1 sm:flex-initial"
            >
              Fermer
            </button>
            <button
              type="button"
              onClick={handleOpenWhatsApp}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-extrabold flex items-center justify-center gap-2 shadow-lg shadow-emerald-950 transition active-press cursor-pointer flex-1 sm:flex-initial"
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

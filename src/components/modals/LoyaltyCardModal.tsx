import React, { useEffect, useRef, useState } from 'react';
import { X, Printer, Award, CreditCard, Sparkles, QrCode, Smartphone, Check, ShieldCheck } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import { calculateCustomerTier, calculateNextTierProgress } from '../../utils/loyaltyEngine';
import { useToast } from '../ui/Toast';
import { renderBarcodeToCanvas } from '../../utils/barcodeGenerator';

export const LoyaltyCardModal: React.FC = () => {
  const { activeModal, closeModal, currentCustomer, receiptSettings } = usePosStore();
  const { showToast } = useToast();

  const [activeTab, setActiveTab] = useState<'pvc_physical' | 'digital_wallet'>('pvc_physical');
  const barcodeCanvasRef = useRef<HTMLCanvasElement>(null);

  const customer = currentCustomer;
  const tierInfo = customer ? calculateCustomerTier(customer.totalSpent || 0) : null;
  const progress = customer ? calculateNextTierProgress(customer.totalSpent || 0) : null;
  const cardCode = customer ? `LOY-${customer.id}` : 'LOY-CUST-000';

  useEffect(() => {
    if (activeModal === 'loyalty_card' && barcodeCanvasRef.current && customer) {
      renderBarcodeToCanvas(barcodeCanvasRef.current, cardCode, 'code128');
    }
  }, [activeModal, customer, cardCode]);

  if (activeModal !== 'loyalty_card' || !customer || !tierInfo || !progress) return null;

  const handlePrintCard = () => {
    showToast('Impression de la Carte PVC de Fidélité lancée...', 'info');
    setTimeout(() => {
      window.print();
    }, 150);
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-3xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 max-h-[92vh] flex flex-col">
        
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-emerald-600 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-amber-500/20">
              <Award className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <h2 className="text-sm font-extrabold text-pos-text tracking-wide flex items-center gap-2">
                CARTE DE FIDÉLITÉ NUMÉRIQUE & PVC IMPRIMABLE
                <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded border ${tierInfo.bgColor} ${tierInfo.badgeColor} ${tierInfo.borderColor}`}>
                  {tierInfo.icon} {tierInfo.name}
                </span>
              </h2>
              <p className="text-[11px] text-pos-muted">
                Client: <strong className="text-pos-text">{customer.name}</strong> • Code: <span className="font-mono text-emerald-400">{cardCode}</span>
              </p>
            </div>
          </div>
          <button onClick={closeModal} className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Studio Sub-Tabs */}
        <div className="px-5 pt-3 border-b border-pos-border bg-pos-bg flex gap-2 shrink-0">
          <button
            onClick={() => setActiveTab('pvc_physical')}
            className={`pb-2 px-3 text-xs font-bold transition flex items-center gap-1.5 border-b-2 ${
              activeTab === 'pvc_physical'
                ? 'border-emerald-400 text-emerald-400'
                : 'border-transparent text-pos-muted hover:text-pos-text'
            }`}
          >
            <CreditCard className="w-3.5 h-3.5" /> Carte Physique PVC (Format CR80)
          </button>
          <button
            onClick={() => setActiveTab('digital_wallet')}
            className={`pb-2 px-3 text-xs font-bold transition flex items-center gap-1.5 border-b-2 ${
              activeTab === 'digital_wallet'
                ? 'border-amber-400 text-amber-400'
                : 'border-transparent text-pos-muted hover:text-pos-text'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5" /> Pass Digital Wallet (Apple / Google)
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 bg-slate-950/50">

          {/* TAB 1: PHYSICAL PVC CARD TEMPLATE */}
          {activeTab === 'pvc_physical' && (
            <div className="space-y-6">
              
              {/* Printable Target Box */}
              <div data-printable="true" className="printable-area space-y-6 flex flex-col items-center">
                
                {/* PVC Card Front Side */}
                <div className="w-[340px] h-[210px] rounded-2xl p-5 shadow-2xl relative overflow-hidden flex flex-col justify-between border border-amber-500/30 bg-gradient-to-br from-slate-900 via-slate-950 to-amber-950/60 text-white font-sans">
                  
                  {/* Background Watermark Pattern */}
                  <div className="absolute -right-10 -bottom-10 w-44 h-44 rounded-full bg-amber-500/10 blur-2xl pointer-events-none" />

                  {/* Top Bar: Store Logo & VIP Badge */}
                  <div className="flex justify-between items-start z-10">
                    <div>
                      <span className="text-[10px] uppercase font-black tracking-widest text-amber-400 block">
                        {receiptSettings.storeName || 'ACCESSOIRES MOBI'}
                      </span>
                      <span className="text-[8px] text-gray-400 font-semibold tracking-wider uppercase block">
                        VIP Member Pass
                      </span>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[9px] font-extrabold flex items-center gap-1 border ${tierInfo.bgColor} ${tierInfo.badgeColor} ${tierInfo.borderColor}`}>
                      {tierInfo.icon} {tierInfo.name}
                    </span>
                  </div>

                  {/* Holographic Chip Simulation */}
                  <div className="z-10 flex items-center gap-3 my-1">
                    <div className="w-9 h-7 rounded-md bg-gradient-to-tr from-amber-300 via-amber-100 to-amber-400 border border-amber-200/50 shadow-inner flex items-center justify-center">
                      <div className="w-5 h-4 border border-amber-600/40 rounded-sm" />
                    </div>
                    <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />
                  </div>

                  {/* Cardholder Details */}
                  <div className="z-10">
                    <p className="text-[9px] text-gray-400 uppercase font-bold tracking-wider">Titulaire de la Carte</p>
                    <p className="text-base font-extrabold tracking-wide uppercase text-white truncate">{customer.name}</p>
                    <div className="flex justify-between items-end mt-1">
                      <span className="font-mono text-xs text-amber-300 font-bold tracking-widest">{cardCode}</span>
                      <span className="text-[9px] text-emerald-400 font-extrabold bg-emerald-500/20 px-1.5 py-0.5 rounded">
                        Multiplicateur: {tierInfo.pointsMultiplier}x
                      </span>
                    </div>
                  </div>
                </div>

                {/* PVC Card Back Side (Barcode & T&C) */}
                <div className="w-[340px] h-[210px] rounded-2xl p-4 shadow-2xl relative overflow-hidden flex flex-col justify-between border border-gray-700 bg-white text-black font-sans">
                  
                  {/* Magnetic Strip Simulation */}
                  <div className="w-full h-8 bg-slate-900 -mx-4 -mt-4 mb-2" />

                  {/* Barcode & Signature Strip */}
                  <div className="flex flex-col items-center justify-center my-1 bg-gray-50 p-2 rounded-lg border border-gray-200">
                    <canvas ref={barcodeCanvasRef} className="max-w-full mix-blend-multiply" />
                    <span className="text-[8px] font-mono text-gray-600 font-bold mt-0.5">Scannez ce code-barres en caisse pour attacher le client</span>
                  </div>

                  {/* Footer Terms */}
                  <div className="text-[7.5px] text-gray-500 text-center leading-tight">
                    <p className="font-semibold text-gray-700">Cette carte est strictement personnelle et régie par les conditions du Club Privilège MOBI.</p>
                    <p>SAV & Support Client: {receiptSettings.phone || '0555 00 00 00'} • {receiptSettings.address || 'Alger, Algérie'}</p>
                  </div>
                </div>
              </div>

            </div>
          )}

          {/* TAB 2: DIGITAL WALLET PASS PREVIEW */}
          {activeTab === 'digital_wallet' && (
            <div className="flex justify-center">
              <div className="w-[320px] rounded-3xl p-5 shadow-2xl bg-slate-900 border border-slate-700 text-white flex flex-col gap-4 font-sans relative overflow-hidden">
                
                {/* Header */}
                <div className="flex justify-between items-center pb-3 border-b border-slate-800">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5 text-emerald-400" />
                    <div>
                      <span className="text-xs font-bold text-white block">{receiptSettings.storeName || 'ACCESSOIRES MOBI'}</span>
                      <span className="text-[9px] text-slate-400 font-medium">Digital Loyalty Pass</span>
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-extrabold border ${tierInfo.bgColor} ${tierInfo.badgeColor} ${tierInfo.borderColor}`}>
                    {tierInfo.icon} {tierInfo.name}
                  </span>
                </div>

                {/* Points & Balance Box */}
                <div className="bg-slate-800/80 rounded-2xl p-4 border border-slate-700 grid grid-cols-2 gap-3 text-center">
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold block uppercase">Solde Points</span>
                    <span className="text-xl font-black text-amber-400">{(customer.loyaltyPoints || 0).toLocaleString('fr-DZ')}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold block uppercase">Valeur Avoir</span>
                    <span className="text-xl font-black text-emerald-400">{formatDZD((customer.loyaltyPoints || 0) * 10)}</span>
                  </div>
                </div>

                {/* Tier Progress Bar */}
                <div className="bg-slate-800/40 p-3 rounded-xl border border-slate-800 space-y-1.5">
                  <div className="flex justify-between text-[10px] font-semibold">
                    <span className="text-slate-400">Progression Statut</span>
                    <span className="text-amber-400 font-bold">{progress.progressPercent}%</span>
                  </div>
                  <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800">
                    <div className="bg-gradient-to-r from-amber-500 to-emerald-400 h-full rounded-full" style={{ width: `${progress.progressPercent}%` }} />
                  </div>
                  {progress.nextTier && (
                    <p className="text-[9px] text-slate-400 text-center">
                      Plus que <strong className="text-emerald-400">{formatDZD(progress.remainingSpend)}</strong> pour débloquer {progress.nextTier.name}
                    </p>
                  )}
                </div>

                {/* QR Code Container */}
                <div className="bg-white p-3 rounded-2xl flex flex-col items-center justify-center border border-gray-300 text-black">
                  <QrCode className="w-24 h-24 text-slate-950" />
                  <span className="text-[9px] font-mono font-bold text-gray-700 mt-1">{cardCode}</span>
                </div>

                <div className="text-center text-[9px] text-slate-400">
                  Présentez ce QR Code en caisse pour cumuler vos points automatiquement.
                </div>
              </div>
            </div>
          )}

        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between shrink-0">
          <div className="text-xs text-pos-muted flex items-center gap-1.5">
            <Check className="w-4 h-4 text-emerald-400" />
            <span>Format Standard PVC CR80 (85.60 x 53.98 mm) - Haute Définition</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={closeModal}
              className="px-4 py-2 rounded-xl bg-pos-bg hover:bg-pos-hover text-pos-text border border-pos-border text-xs font-semibold transition"
            >
              Fermer
            </button>
            <button
              onClick={handlePrintCard}
              className="px-4 py-2 rounded-xl glow-btn bg-gradient-to-r from-amber-500 to-emerald-600 hover:from-amber-400 hover:to-emerald-500 text-slate-950 font-bold text-xs flex items-center gap-2 shadow-lg shadow-amber-500/20"
            >
              <Printer className="w-4 h-4" /> Imprimer Carte PVC
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};

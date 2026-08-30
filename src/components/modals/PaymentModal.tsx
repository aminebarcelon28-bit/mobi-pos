import React, { useState, useEffect, useRef } from 'react';
import { X, Banknote, CheckCircle2, AlertCircle, ShieldCheck } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import type { PaymentTender } from '../../types/pos';
import { useToast } from '../../components/ui/Toast';

export const PaymentModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    cart,
    processPayment,
    pricingTier,
    currentCustomer,
    setCartItemIMEI,
  } = usePosStore();
  
  const { showToast } = useToast();
  const [tenderAmount, setTenderAmount] = useState<string>('');
  const amountInputRef = useRef<HTMLInputElement>(null);

  const grossSubtotal = cart.reduce((acc, item) => {
    const itemPrice =
      item.appliedPrice !== undefined
        ? item.appliedPrice
        : pricingTier === 'Wholesale'
        ? item.product.wholesalePrice || item.product.price * 0.75
        : item.product.price;
    return acc + itemPrice * item.quantity - (item.discount || 0);
  }, 0);

  useEffect(() => {
    if (activeModal === 'payment') {
      if (cart.length === 0) {
        closeModal();
        showToast('Panier vide — Ajoutez des articles au panier avant d\'encaisser.', 'warning');
        return;
      }
      setTenderAmount(grossSubtotal > 0 ? grossSubtotal.toString() : '');

      setTimeout(() => {
        if (amountInputRef.current) {
          amountInputRef.current.focus();
          amountInputRef.current.select();
        }
      }, 50);
    }
  }, [activeModal, cart.length, grossSubtotal, closeModal, showToast]);

  if (activeModal !== 'payment') return null;

  const montantTotal = grossSubtotal;
  const currentTypedAmount = parseFloat(tenderAmount) || 0;
  
  const resteAPayer = Math.max(0, montantTotal - currentTypedAmount);
  const changeDue = Math.max(0, currentTypedAmount - montantTotal);

  const quickBillsDZD = [500, 1000, 2000, 5000, 10000];

  const serializedItems = cart.filter(item => item.product.isSerialized);
  const hasMissingIMEI = serializedItems.some(item => !item.imeiNumber);

  const handleProcess = () => {
    if (cart.length === 0) {
      showToast('Panier vide — Veuillez ajouter des articles au panier.', 'warning');
      closeModal();
      return;
    }

    if (hasMissingIMEI) {
      showToast('Veuillez saisir les numéros IMEI pour tous les articles sérialisés.', 'warning');
      return;
    }

    const typedAmount = parseFloat(tenderAmount);
    const amountToTender = !isNaN(typedAmount) && typedAmount > 0 ? typedAmount : montantTotal;

    if (amountToTender < montantTotal) {
      showToast(`Montant espèces insuffisant — Il manque ${formatDZD(montantTotal - amountToTender)}`, 'error');
      return;
    }

    const finalTenders: PaymentTender[] = [
      {
        method: 'Espèces',
        amount: amountToTender,
      }
    ];

    const calculatedChange = Math.max(0, amountToTender - montantTotal);

    const result = processPayment(finalTenders);
    if (result && !result.success) {
      if (result.reason === 'INSUFFICIENT_CASH') {
        showToast('Montant espèces insuffisant', 'error');
      } else if (result.reason?.startsWith('IMEI_REQUIRED')) {
        showToast('Veuillez saisir les numéros IMEI pour tous les articles sérialisés.', 'warning');
      } else if (result.reason === 'EMPTY_CART') {
        showToast('Panier vide — Veuillez ajouter des articles au panier.', 'warning');
        closeModal();
      } else {
        showToast('Échec de validation de la vente', 'error');
      }
    } else {
      // Close modal immediately with zero blocking windows
      closeModal();

      // Silent direct print to thermal printer in background
      setTimeout(() => {
        window.print();
      }, 50);

      // Instant confirmation toast with change returned
      if (calculatedChange > 0) {
        showToast(`✅ Vente validée en Espèces • Rendu Monnaie : ${formatDZD(calculatedChange)} • Reçu imprimé`, 'success');
      } else {
        showToast('✅ Vente validée en Espèces • Montant exact • Reçu imprimé', 'success');
      }
    }
  };

  return (
    <div 
      className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleProcess();
        }
      }}
    >
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold">
              <Banknote className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-black text-pos-text">
                  Encaissement en Espèces (Cash Only)
                </h2>
                <span className="px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 font-bold text-[9px] uppercase border border-emerald-500/30">
                  Comptant
                </span>
              </div>
              <p className="text-[10px] text-pos-muted">Tapez le montant reçu puis appuyez sur Entrée ↵</p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-4">
          
          {/* Total Net Banner */}
          <div className="bg-pos-card border border-pos-border rounded-2xl p-4 flex items-center justify-between shadow-sm">
            <div>
              <span className="text-[11px] uppercase tracking-wider text-pos-muted font-bold block">
                Total Net à Payer
              </span>
              <span className="text-xs text-pos-muted">
                {currentCustomer ? `Client: ${currentCustomer.name}` : 'Client de passage'} • {pricingTier === 'Wholesale' ? 'Tarif Gros' : 'Tarif Détail'}
              </span>
            </div>
            <div className="text-right">
              <span className="text-3xl font-black text-emerald-400 tracking-tight font-mono">
                {formatDZD(montantTotal)}
              </span>
            </div>
          </div>

          {/* Real-time Change Due / Remaining Box */}
          <div className={`p-4 rounded-2xl border-2 transition-all duration-150 shadow-lg ${
            currentTypedAmount >= montantTotal
              ? 'bg-gradient-to-br from-emerald-950/80 to-teal-950/80 border-emerald-500 text-emerald-300 shadow-emerald-950/50'
              : 'bg-red-950/30 border-red-500/60 text-red-300 shadow-red-950/40'
          }`}>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-black uppercase tracking-wider block">
                  {currentTypedAmount >= montantTotal ? '⚡ À Rendre au Client (Rendu Monnaie)' : '⚠️ Reste à Payer (Montant Reçu Insuffisant)'}
                </span>
                <span className="text-[10px] opacity-80">
                  {currentTypedAmount >= montantTotal ? 'Calculé automatiquement en temps réel' : 'Saisissez les espèces remises par le client'}
                </span>
              </div>
              <div className="text-right">
                <span className={`text-3xl font-black tracking-tight font-mono ${
                  currentTypedAmount >= montantTotal ? 'text-emerald-300' : 'text-red-400'
                }`}>
                  {currentTypedAmount >= montantTotal ? formatDZD(changeDue) : formatDZD(resteAPayer)}
                </span>
              </div>
            </div>
          </div>

          {/* Amount Given Input */}
          <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-extrabold text-pos-text uppercase tracking-wide flex items-center gap-1.5">
                <Banknote className="w-4 h-4 text-emerald-400" />
                Espèces Reçues du Client (DA) :
              </label>
              <span className="text-[10px] bg-emerald-500/10 text-emerald-400 font-bold px-2 py-0.5 rounded border border-emerald-500/30">
                Paiement 100% Espèces
              </span>
            </div>

            <div className="relative">
              <input
                ref={amountInputRef}
                type="number"
                value={tenderAmount}
                onChange={(e) => setTenderAmount(e.target.value)}
                placeholder={montantTotal.toString()}
                className="w-full bg-pos-bg border-2 border-pos-border focus:border-emerald-400 rounded-xl px-4 py-3 text-3xl font-black font-mono text-pos-text focus:outline-none transition"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleProcess();
                  }
                }}
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-base font-black text-pos-muted font-mono pointer-events-none">
                DA
              </span>
            </div>

            {/* Quick Bill Tap Buttons */}
            <div className="space-y-1.5 pt-1">
              <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider block">
                Coupures Rapides (1-Clic) :
              </span>
              <div className="grid grid-cols-6 gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setTenderAmount(montantTotal.toString());
                    amountInputRef.current?.focus();
                  }}
                  className="py-2.5 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 rounded-xl text-xs font-black text-emerald-300 transition cursor-pointer"
                  title="Montant exact sans rendu"
                >
                  Exact
                </button>
                {quickBillsDZD.map((bill) => (
                  <button
                    key={bill}
                    type="button"
                    onClick={() => {
                      setTenderAmount(bill.toString());
                      amountInputRef.current?.focus();
                    }}
                    className={`py-2.5 rounded-xl text-xs font-black border transition cursor-pointer font-mono ${
                      bill >= montantTotal
                        ? 'bg-pos-bg hover:bg-emerald-500/20 border-pos-border hover:border-emerald-500/50 text-pos-text hover:text-emerald-300'
                        : 'bg-pos-bg border-pos-border opacity-40 text-pos-muted'
                    }`}
                  >
                    {bill.toLocaleString('fr-DZ')}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* IMEI Requirements for Serialized Items */}
          {serializedItems.length > 0 && (
            <div className="bg-amber-950/30 border border-amber-500/30 rounded-xl p-3 space-y-2">
              <h4 className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4" /> Numéros IMEI requis pour validation
              </h4>
              <div className="space-y-2">
                {serializedItems.map(item => (
                  <div key={item.product.id} className="flex items-center gap-2 bg-pos-bg p-2 rounded-lg border border-pos-border">
                    <span className="text-xs text-pos-text flex-1 truncate font-bold">{item.product.title}</span>
                    <input
                      type="text"
                      placeholder="Saisir l'IMEI..."
                      value={item.imeiNumber || ''}
                      onChange={(e) => setCartItemIMEI(item.product.id, e.target.value)}
                      className={`text-xs px-2.5 py-1.5 rounded-lg border ${!item.imeiNumber ? 'border-amber-500 bg-amber-500/10' : 'border-pos-border bg-pos-card'} text-pos-text focus:outline-none focus:border-emerald-500 w-40 font-mono`}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cash Only Policy Indicator */}
          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between text-xs text-pos-muted">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span className="text-[11px] font-semibold text-pos-text">Conditions : Règlement comptant en espèces uniquement</span>
            </div>
            <span className="text-[10px] text-emerald-400 font-bold">Encaissement Direct</span>
          </div>

        </div>

        {/* Footer */}
        <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between shrink-0">
          <button
            onClick={closeModal}
            className="px-4 py-2.5 rounded-xl text-xs font-bold text-pos-muted hover:text-pos-text hover:bg-pos-hover transition cursor-pointer"
          >
            Annuler (Échap)
          </button>
          <button
            type="button"
            onClick={handleProcess}
            className="glow-btn px-8 py-3.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-black text-sm shadow-xl shadow-emerald-600/25 flex items-center gap-2 transition cursor-pointer"
          >
            <CheckCircle2 className="w-5 h-5" />
            <span>Valider & Imprimer Reçu</span>
            <span className="bg-black/40 text-emerald-200 border border-white/20 px-2 py-0.5 rounded text-xs font-mono">
              Entrée ↵
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};


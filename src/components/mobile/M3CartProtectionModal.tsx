import React from 'react';
import { PauseCircle, Trash2, ArrowLeft, ShoppingBag } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import { soundEngine } from '../../utils/audioFeedback';

interface M3CartProtectionModalProps {
  isOpen: boolean;
  onContinueSale: () => void;
  onHoldAndExit: () => void;
  onDiscardAndExit: () => void;
}

export const M3CartProtectionModal: React.FC<M3CartProtectionModalProps> = ({
  isOpen,
  onContinueSale,
  onHoldAndExit,
  onDiscardAndExit,
}) => {
  if (!isOpen) return null;

  const cart = usePosStore((state) => state.cart);

  const cartTotal = cart.reduce((acc, item) => {
    const price = item.appliedPrice ?? item.product.price;
    return acc + price * item.quantity;
  }, 0);

  const totalItems = cart.reduce((acc, item) => acc + item.quantity, 0);

  return (
    <div
      onClick={onContinueSale}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(1rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-pos-panel border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-md overflow-hidden flex flex-col shadow-2xl animate-in slide-in-from-bottom-5 p-5 text-center space-y-4"
      >
        <div className="sheet-handle sm:hidden" />

        <div className="w-14 h-14 rounded-2xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center mx-auto shadow-xs">
          <ShoppingBag className="w-7 h-7" />
        </div>

        <div className="space-y-1">
          <h3 className="text-base font-black text-pos-text">Vente en cours non finalisée</h3>
          <p className="text-xs text-pos-muted max-w-xs mx-auto">
            Votre panier contient <strong className="text-pos-text">{totalItems} article{totalItems > 1 ? 's' : ''}</strong> pour un total de{' '}
            <strong className="text-emerald-400 font-mono tabular-nums">{formatDZD(cartTotal)}</strong>.
          </p>
        </div>

        <div className="flex flex-col gap-2 pt-2">
          <button
            type="button"
            onClick={() => {
              soundEngine.playSuccess?.();
              onHoldAndExit();
            }}
            className="w-full min-h-[50px] rounded-xl bg-amber-500 hover:bg-amber-400 active-press text-slate-950 font-black text-xs sm:text-sm flex items-center justify-center gap-2 shadow-md shadow-amber-500/20 transition cursor-pointer"
          >
            <PauseCircle className="w-4 h-4" />
            <span>Mettre la vente en attente (Sauvegarder)</span>
          </button>

          <button
            type="button"
            onClick={() => {
              soundEngine.playKeyBeep?.();
              onContinueSale();
            }}
            className="w-full min-h-[48px] rounded-xl bg-pos-card border border-pos-border hover:border-pos-text active-press text-pos-text font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Continuer la vente</span>
          </button>

          <button
            type="button"
            onClick={() => {
              soundEngine.playKeyBeep?.();
              onDiscardAndExit();
            }}
            className="w-full min-h-[44px] rounded-xl bg-rose-500/10 hover:bg-rose-500/20 active-press text-rose-400 font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
            <span>Abandonner et vider le panier</span>
          </button>
        </div>
      </div>
    </div>
  );
};

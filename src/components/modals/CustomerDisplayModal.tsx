import React, { useEffect, useRef } from 'react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import { getProductPriceForTier } from '../../utils/pricingEngine';
import { X, MonitorPlay } from 'lucide-react';

export const CustomerDisplayModal: React.FC = () => {
  const { activeModal, closeModal, cart, currentCustomer } = usePosStore();
    const pricingTier = usePosStore((s) => s.pricingTier);
  // Persistent channel: allocated once, reused across cart changes, closed on unmount.
  const channelRef = useRef<BroadcastChannel | null>(null);

  const getChannel = (): BroadcastChannel | null => {
    if (typeof BroadcastChannel === 'undefined') return null;
    if (!channelRef.current) {
      try {
        channelRef.current = new BroadcastChannel('mobi_pos_customer_display');
      } catch {
        return null;
      }
    }
    return channelRef.current;
  };

  // Use BroadcastChannel to sync data to external display if needed
  useEffect(() => {
    if (activeModal === 'customer_display') {
      getChannel()?.postMessage({
        type: 'SYNC_STATE',
        payload: {
          cart,
          currentCustomer,
        },
      });
    }
  }, [activeModal, cart, currentCustomer]);

  useEffect(() => {
    return () => {
      try {
        channelRef.current?.close();
      } catch {
        // ignore
      }
      channelRef.current = null;
    };
  }, []);

  if (activeModal !== 'customer_display') return null;

  // Mirror CartPanel: tier-aware unit price with a safe fallback, so a
  // Demi-Gros/Gros customer-facing screen never shows the retail total.
  const subtotal = cart.reduce((sum, item) => {
    const unit = item.appliedPrice ?? getProductPriceForTier(item.product, pricingTier);
    return sum + unit * item.quantity;
  }, 0);
  const totalDiscount = cart.reduce((sum, item) => sum + (item.discount || 0), 0);
  const total = Math.max(0, subtotal - totalDiscount);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm p-0 sm:p-4 select-none">
      <div className="w-full max-w-5xl bg-pos-panel border-t sm:border border-pos-border rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[94vh] sm:h-[80vh] pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] sm:py-0">
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />
        
        {/* Header */}
        <div className="flex items-center justify-between p-3.5 sm:p-6 border-b border-pos-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <MonitorPlay className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-500 shrink-0" />
            <h2 className="text-sm sm:text-xl font-semibold text-pos-text truncate">Affichage Client (Prévisualisation)</h2>
          </div>
          <div className="flex items-center gap-2 sm:gap-4 shrink-0">
            <button
              onClick={() => {
                window.open('/customer-display', 'CustomerDisplay', 'width=1024,height=768');
              }}
              className="px-3 sm:px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white font-medium rounded-lg transition-colors text-xs min-h-[44px] flex items-center justify-center active-press"
            >
              <span className="sm:hidden">Écran externe</span>
              <span className="hidden sm:inline">Ouvrir l'écran externe</span>
            </button>
            <button
              onClick={closeModal}
              className="p-2 rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
            >
              <X className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
          </div>
        </div>

        {/* Content Preview */}
        <div className="flex flex-col md:flex-row flex-1 overflow-hidden bg-pos-bg">
          {/* Promotional Banner (Left on desktop, compact on mobile) */}
          <div className="w-full md:w-1/2 p-3 sm:p-6 flex flex-col justify-center items-center bg-gradient-to-br from-emerald-500/10 to-pos-panel border-b md:border-b-0 md:border-r border-pos-border shrink-0 md:shrink">
            <div className="text-center space-y-1 sm:space-y-4">
              <h1 className="text-lg sm:text-4xl font-bold text-emerald-500">Bienvenue</h1>
              <p className="text-xs sm:text-xl text-pos-text">Découvrez nos nouvelles promotions !</p>
              <div className="w-28 h-12 sm:w-64 sm:h-64 bg-pos-panel rounded-xl sm:rounded-2xl shadow-inner border border-pos-border flex items-center justify-center mt-1 sm:mt-8 mx-auto">
                <span className="text-pos-muted text-[10px] sm:text-xs">Espace Promotionnel</span>
              </div>
            </div>
          </div>

          {/* Cart Summary (Right) */}
          <div className="w-full md:w-1/2 flex flex-col bg-pos-panel flex-1 overflow-hidden">
            {currentCustomer && (
              <div className="p-3 sm:p-4 bg-emerald-500/10 border-b border-pos-border shrink-0">
                <p className="text-sm sm:text-lg font-medium text-emerald-400 truncate">Client: {currentCustomer.name}</p>
                <p className="text-[10px] sm:text-xs text-emerald-400/80">Points de fidélité gagnés: {Math.floor(total / 100)}</p>
              </div>
            )}
            
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {cart.map((item) => (
                <div key={item.product.id} className="flex justify-between items-center p-3 bg-pos-bg rounded-xl border border-pos-border">
                  <div>
                    <p className="font-medium text-pos-text text-xs line-clamp-1">{item.product.title}</p>
                    <p className="text-xs text-pos-muted">
                      {item.quantity} × {formatDZD(item.appliedPrice)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-pos-text text-xs">
                      {formatDZD(item.appliedPrice * item.quantity - item.discount)}
                    </p>
                  </div>
                </div>
              ))}
              {cart.length === 0 && (
                <div className="flex-1 flex items-center justify-center h-full">
                  <p className="text-pos-muted text-xs">Le panier est vide</p>
                </div>
              )}
            </div>

            <div className="p-6 bg-pos-bg border-t border-pos-border space-y-3 text-xs">
              <div className="flex justify-between text-pos-muted">
                <span>Sous-total</span>
                <span>{formatDZD(subtotal)}</span>
              </div>
              {totalDiscount > 0 && (
                <div className="flex justify-between text-rose-500">
                  <span>Remise</span>
                  <span>-{formatDZD(totalDiscount)}</span>
                </div>
              )}
              <div className="flex justify-between items-center pt-3 border-t border-pos-border">
                <span className="text-lg font-bold text-pos-text">Total à payer</span>
                <span className="text-2xl font-bold text-emerald-400">{formatDZD(total)}</span>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};

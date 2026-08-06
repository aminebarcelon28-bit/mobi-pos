import React, { useEffect } from 'react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import { X, MonitorPlay } from 'lucide-react';

export const CustomerDisplayModal: React.FC = () => {
  const { activeModal, closeModal, cart, currentCustomer } = usePosStore();
  
  // Use BroadcastChannel to sync data to external display if needed
  useEffect(() => {
    if (activeModal === 'customer_display') {
      const channel = new BroadcastChannel('mobi_pos_customer_display');
      channel.postMessage({
        type: 'SYNC_STATE',
        payload: {
          cart,
          currentCustomer,
        },
      });
      return () => channel.close();
    }
  }, [activeModal, cart, currentCustomer]);

  if (activeModal !== 'customer_display') return null;

  const subtotal = cart.reduce((sum, item) => sum + item.appliedPrice * item.quantity, 0);
  const totalDiscount = cart.reduce((sum, item) => sum + (item.discount || 0), 0);
  const total = Math.max(0, subtotal - totalDiscount);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-5xl bg-pos-panel border-pos-border border rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[80vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-pos-border">
          <div className="flex items-center gap-2">
            <MonitorPlay className="w-6 h-6 text-emerald-500" />
            <h2 className="text-xl font-semibold text-pos-text">Affichage Client (Prévisualisation)</h2>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => {
                window.open('/customer-display', 'CustomerDisplay', 'width=1024,height=768');
              }}
              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white font-medium rounded-lg transition-colors text-xs"
            >
              Ouvrir l'écran externe
            </button>
            <button
              onClick={closeModal}
              className="p-2 rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Content Preview */}
        <div className="flex flex-1 overflow-hidden bg-pos-bg">
          {/* Promotional Banner (Left) */}
          <div className="w-1/2 p-6 flex flex-col justify-center items-center bg-gradient-to-br from-emerald-500/10 to-pos-panel border-r border-pos-border">
            <div className="text-center space-y-4">
              <h1 className="text-4xl font-bold text-emerald-500">Bienvenue</h1>
              <p className="text-xl text-pos-text">Découvrez nos nouvelles promotions !</p>
              <div className="w-64 h-64 bg-pos-panel rounded-2xl shadow-inner border border-pos-border flex items-center justify-center mt-8">
                <span className="text-pos-muted text-xs">Espace Promotionnel</span>
              </div>
            </div>
          </div>

          {/* Cart Summary (Right) */}
          <div className="w-1/2 flex flex-col bg-pos-panel">
            {currentCustomer && (
              <div className="p-4 bg-emerald-500/10 border-b border-pos-border">
                <p className="text-lg font-medium text-emerald-400">Client: {currentCustomer.name}</p>
                <p className="text-xs text-emerald-400/80">Points de fidélité gagnés lors de cet achat: {Math.floor(total / 100)}</p>
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

import React, { useState, useEffect, useRef } from 'react';
import type { CartItem, Customer } from '../types/pos';
import { formatDZD } from '../types/pos';
import { ShoppingBag, MonitorPlay, Sparkles, CheckCircle2, RotateCcw, Award } from 'lucide-react';

export interface CustomerDisplayState {
  cart: CartItem[];
  currentCustomer: Customer | null;
  totals: {
    grossSubtotal: number;
    discountTotal: number;
    subtotalAfterDiscount: number;
    total: number;
    tradeInCreditApplied?: number;
    storeCreditApplied?: number;
    voucherCreditApplied?: number;
  };
  storeName?: string;
  storeSubheader?: string;
}

export const CustomerDisplayScreen: React.FC = () => {
  const [displayState, setDisplayState] = useState<CustomerDisplayState>({
    cart: [],
    currentCustomer: null,
    totals: {
      grossSubtotal: 0,
      discountTotal: 0,
      subtotalAfterDiscount: 0,
      total: 0,
      tradeInCreditApplied: 0,
      storeCreditApplied: 0,
      voucherCreditApplied: 0,
    },
    storeName: 'MobiPOS',
    storeSubheader: 'Téléphonie & Accessoires',
  });

  const [connected, setConnected] = useState(false);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel('mobi_pos_customer_display');
      channelRef.current = channel;

      channel.onmessage = (event: MessageEvent) => {
        if (!event?.data) return;
        const { type, payload } = event.data;
        if (type === 'SYNC_STATE' && payload) {
          setDisplayState((prev) => ({
            ...prev,
            ...payload,
          }));
          setConnected(true);
        }
      };

      // Solicit current state from main POS window
      channel.postMessage({ type: 'REQUEST_STATE' });
      setConnected(true);
    } catch (err) {
      console.warn('[CustomerDisplayScreen] Channel error:', err);
    }

    return () => {
      try {
        channel?.close();
      } catch {
        // ignore
      }
      channelRef.current = null;
    };
  }, []);

  const { cart, currentCustomer, totals, storeName, storeSubheader } = displayState;
  const itemCount = cart.reduce((sum, it) => sum + (it.isReturn ? -it.quantity : it.quantity), 0);

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100 font-sans select-none overflow-hidden">
      {/* Top Branding Header */}
      <header className="h-16 px-6 bg-slate-900 border-b border-slate-800 flex items-center justify-between shrink-0 shadow-md">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
            <MonitorPlay className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-black tracking-tight text-white">{storeName || 'MobiPOS'}</h1>
            <p className="text-xs text-slate-400">{storeSubheader || 'Caisse Enregistreuse & SAV Spécialisé'}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {connected ? (
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-950/80 border border-emerald-700/60 text-emerald-400 text-xs font-semibold">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>En direct</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-950/80 border border-amber-700/60 text-amber-400 text-xs font-semibold">
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              <span>Attente liaison caisse…</span>
            </div>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Promotional & Greeting Panel */}
        <div className="w-2/5 p-8 flex flex-col justify-between bg-gradient-to-br from-slate-900 via-slate-950 to-indigo-950/40 border-r border-slate-800/80">
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-xs font-bold">
              <Sparkles className="w-4 h-4 text-indigo-400" />
              <span>Bienvenue chez votre spécialiste mobile</span>
            </div>

            <div className="space-y-2">
              <h2 className="text-3xl lg:text-4xl font-black text-white leading-tight">
                Qualité, Garantie & Service Express
              </h2>
              <p className="text-sm text-slate-400 leading-relaxed">
                Pièces d'origine testées, accessoires certifiés et garantie traçable par numéro de série IMEI.
              </p>
            </div>

            {/* Customer loyalty badge */}
            {currentCustomer && (
              <div className="p-4 rounded-2xl bg-emerald-950/40 border border-emerald-700/50 space-y-1">
                <div className="flex items-center gap-2 text-emerald-400 text-xs font-bold">
                  <Award className="w-4 h-4" />
                  <span>Compte Fidélité Client</span>
                </div>
                <p className="text-base font-extrabold text-white truncate">{currentCustomer.name}</p>
                <p className="text-xs text-emerald-300/80 font-mono">
                  Points cumulés : {currentCustomer.loyaltyPoints ?? 0} pts
                </p>
              </div>
            )}
          </div>

          <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 text-xs text-slate-400 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            <span>Ticket de caisse numérique et facture avec garantie imprimables sur demande.</span>
          </div>
        </div>

        {/* Right: Real-time Cart Summary & Financial Totals */}
        <div className="w-3/5 flex flex-col bg-slate-900 overflow-hidden">
          {/* Cart Header */}
          <div className="px-6 py-4 bg-slate-900/95 border-b border-slate-800 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <ShoppingBag className="w-5 h-5 text-emerald-400" />
              <h3 className="font-extrabold text-sm text-white uppercase tracking-wider">
                Panier ({itemCount} {itemCount <= 1 ? 'article' : 'articles'})
              </h3>
            </div>
            {cart.length > 0 && (
              <span className="text-xs font-mono text-slate-400">
                {cart.length} ligne{cart.length > 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Cart Items List */}
          <div className="flex-1 overflow-y-auto p-6 space-y-2.5">
            {cart.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-8 text-slate-500 space-y-3">
                <div className="w-16 h-16 rounded-3xl bg-slate-800/80 flex items-center justify-center text-slate-600">
                  <ShoppingBag className="w-8 h-8" />
                </div>
                <div>
                  <p className="text-base font-bold text-slate-400">En attente des articles</p>
                  <p className="text-xs text-slate-500 mt-1">Vos articles scannés s'afficheront ici en direct</p>
                </div>
              </div>
            ) : (
              cart.map((item, idx) => {
                const unitPrice = item.appliedPrice ?? item.product?.price ?? 0;
                const lineTotal = item.isReturn
                  ? -(unitPrice * item.quantity - (item.discount || 0))
                  : unitPrice * item.quantity - (item.discount || 0);

                return (
                  <div
                    key={`${item.product?.id || idx}-${idx}`}
                    className={`p-3.5 rounded-2xl border transition-all flex items-center justify-between gap-4 ${
                      item.isReturn
                        ? 'bg-rose-950/20 border-rose-900/50'
                        : 'bg-slate-950/70 border-slate-800/80 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {item.isReturn && (
                          <span className="px-1.5 py-0.5 rounded bg-rose-950 border border-rose-800 text-rose-300 text-[10px] font-bold flex items-center gap-1">
                            <RotateCcw className="w-2.5 h-2.5" /> Retour
                          </span>
                        )}
                        <p className="font-bold text-sm text-white truncate">
                          {item.product?.title || 'Article'}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-slate-400 font-mono mt-1">
                        <span>
                          {item.quantity} × {formatDZD(unitPrice)}
                        </span>
                        {item.discount > 0 && (
                          <span className="text-amber-400 font-semibold">
                            (Remise: -{formatDZD(item.discount)})
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <span
                        className={`font-black font-mono text-base ${
                          item.isReturn ? 'text-rose-400' : 'text-slate-100'
                        }`}
                      >
                        {formatDZD(lineTotal)}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Financial Breakdown & Total Due Footer */}
          <div className="p-6 bg-slate-950 border-t border-slate-800 space-y-3 shrink-0 shadow-2xl">
            <div className="space-y-1.5 text-xs text-slate-400">
              <div className="flex justify-between">
                <span>Sous-total brut</span>
                <span className="font-mono text-slate-300">{formatDZD(totals.grossSubtotal)}</span>
              </div>

              {totals.discountTotal > 0 && (
                <div className="flex justify-between text-amber-400 font-semibold">
                  <span>Remise accordée</span>
                  <span className="font-mono">-{formatDZD(totals.discountTotal)}</span>
                </div>
              )}

              {(totals.tradeInCreditApplied || 0) > 0 && (
                <div className="flex justify-between text-blue-400 font-semibold">
                  <span>Reprise appareil déduite</span>
                  <span className="font-mono">-{formatDZD(totals.tradeInCreditApplied || 0)}</span>
                </div>
              )}

              {(totals.storeCreditApplied || 0) > 0 && (
                <div className="flex justify-between text-purple-400 font-semibold">
                  <span>Avoir client utilisé</span>
                  <span className="font-mono">-{formatDZD(totals.storeCreditApplied || 0)}</span>
                </div>
              )}

              {(totals.voucherCreditApplied || 0) > 0 && (
                <div className="flex justify-between text-cyan-400 font-semibold">
                  <span>Bon d'achat déduit</span>
                  <span className="font-mono">-{formatDZD(totals.voucherCreditApplied || 0)}</span>
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-slate-800 flex items-baseline justify-between">
              <span className="text-base font-black text-white uppercase tracking-wider">
                Total Net à Payer
              </span>
              <span className="text-3xl lg:text-4xl font-black font-mono text-emerald-400 tracking-tight">
                {formatDZD(totals.total)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

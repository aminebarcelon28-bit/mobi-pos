import React from 'react';
import { X, Play, Clock, User } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';

export const HoldSalesModal: React.FC = () => {
  const { activeModal, closeModal, heldSales, retrieveSale } = usePosStore();

  if (activeModal !== 'hold') return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-in fade-in zoom-in-95">
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            Ventes en Attente ({heldSales.length})
          </h2>
          <button
            onClick={closeModal}
            className="p-1 hover:bg-pos-hover text-pos-muted hover:text-white rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-3 max-h-[60vh] overflow-y-auto">
          {heldSales.length === 0 ? (
            <div className="text-center py-8 text-pos-muted">
              <Clock className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-xs">Aucune vente en attente actuellement.</p>
            </div>
          ) : (
            heldSales.map((sale) => (
              <div
                key={sale.id}
                className="bg-pos-card border border-pos-border rounded-xl p-4 flex items-center justify-between hover:border-emerald-500/50 transition"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <User className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-xs font-semibold text-white">
                      {sale.customer ? sale.customer.name : 'Client Passage'}
                    </span>
                    <span className="text-[10px] text-pos-muted flex items-center gap-1">
                      <Clock className="w-3 h-3" /> {sale.timestamp}
                    </span>
                  </div>
                  <p className="text-xs text-pos-muted mt-1">
                    {sale.items.length} Articles ({sale.items.map((i) => i.product.title).join(', ')})
                  </p>
                </div>

                <button
                  onClick={() => retrieveSale(sale.id)}
                  className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center gap-1 transition shadow-md shadow-amber-500/20"
                >
                  <Play className="w-3.5 h-3.5 fill-slate-950" /> Reprendre
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

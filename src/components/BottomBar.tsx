import React, { useState, useEffect } from 'react';
import {
  PlusCircle,
  FileSearch,
  Users,
  Percent,
  PauseCircle,
  BarChart3,
  Settings,
  Database,
  Boxes,
  RotateCcw,
} from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import { useToast } from './ui/Toast';

export const BottomBar: React.FC = () => {
  const { openModal, holdSale, clearCart, heldSales } = usePosStore();
  const { showToast } = useToast();
  const [timeStr, setTimeStr] = useState('');
  const [dateStr, setDateStr] = useState('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTimeStr(now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
      setDateStr(
        now.toLocaleDateString('fr-DZ', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleHoldSaleClick = () => {
    const res = holdSale();
    if (res && res.success) {
      showToast('Vente mise en attente avec succès ! (Ticket sauvegardé)', 'success');
    } else {
      showToast('Le panier est vide. Aucun article à mettre en attente.', 'warning');
    }
  };

  const handleClearCartClick = () => {
    const currentCart = usePosStore.getState().cart;
    if (currentCart.length === 0) return;
    if (currentCart.length > 1) {
      const ok = window.confirm(
        `Voulez-vous vraiment vider les ${currentCart.reduce((a, i) => a + i.quantity, 0)} articles de la vente en cours ?`
      );
      if (!ok) return;
    }
    clearCart();
    showToast('Panier réinitialisé.', 'info');
  };

  return (
    <footer className="bg-pos-panel border-t border-pos-border px-3 py-1.5 select-none shrink-0 relative z-20 w-full">
      <div className="flex items-center justify-between gap-3 w-full">
        {/* Left Side: Shortcut Function Keys */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5 min-w-0">
          <button
            onClick={handleClearCartClick}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Nouveau Panier / Réinitialiser (F1)"
          >
            <PlusCircle className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
            <span>Nouveau</span>
            <span className="hotkey-badge">F1</span>
          </button>

          <button
            onClick={() => openModal('hold')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium relative cursor-pointer whitespace-nowrap shrink-0"
            title="Reprendre les Ventes en Attente (F4)"
          >
            <FileSearch className="w-3.5 h-3.5 text-amber-500 shrink-0" />
            <span>Reprendre</span>
            {heldSales.length > 0 && (
              <span className="w-4 h-4 rounded-full bg-amber-500 text-slate-950 text-[10px] font-black flex items-center justify-center">
                {heldSales.length}
              </span>
            )}
            <span className="hotkey-badge">F4</span>
          </button>

          <button
            onClick={() => openModal('customers')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Fichier Clients & Dettes Kredy (F5)"
          >
            <Users className="w-3.5 h-3.5 text-blue-500 shrink-0" />
            <span>Clients</span>
            <span className="hotkey-badge">F5</span>
          </button>

          <button
            onClick={() => openModal('discount')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Appliquer une Remise Panier (F6)"
          >
            <Percent className="w-3.5 h-3.5 text-purple-500 shrink-0" />
            <span>Remise</span>
            <span className="hotkey-badge">F6</span>
          </button>

          <button
            onClick={handleHoldSaleClick}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Mettre la Vente en Attente (F7)"
          >
            <PauseCircle className="w-3.5 h-3.5 text-teal-500 shrink-0" />
            <span>En Attente</span>
            <span className="hotkey-badge">F7</span>
          </button>

          <button
            onClick={() => openModal('reports')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Rapports Financiers & Synthèse (F9)"
          >
            <BarChart3 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span>Rapports</span>
            <span className="hotkey-badge">F9</span>
          </button>

          <button
            onClick={() => openModal('inventory_manager')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Gestion de Stock & Inventaire (F10)"
          >
            <Boxes className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>Stock</span>
            <span className="hotkey-badge">F10</span>
          </button>

          <button
            onClick={() => openModal('refund')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Retours Marchandise & Remboursements (F11)"
          >
            <RotateCcw className="w-3.5 h-3.5 text-purple-400 shrink-0" />
            <span>Remboursement</span>
            <span className="hotkey-badge">F11</span>
          </button>

          <button
            onClick={() => openModal('settings')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Paramètres & Diagnostic (F12)"
          >
            <Settings className="w-3.5 h-3.5 text-pos-muted shrink-0" />
            <span>Paramètres</span>
            <span className="hotkey-badge">F12</span>
          </button>
        </div>

        {/* Right Corner: Telemetry & System Clock */}
        <div className="flex items-center gap-3 pl-3 border-l border-pos-border shrink-0 text-xs">
          <button
            onClick={() => openModal('db_maintenance')}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-[11px] font-bold text-cyan-300 transition cursor-pointer shadow-sm shrink-0"
            title="Moteur SQLite WAL Actif • Cliquez pour ouvrir le Centre de Maintenance"
          >
            <Database className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span className="font-mono">SQLite WAL</span>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          </button>

          <div className="text-right whitespace-nowrap leading-tight">
            <span className="font-black text-pos-text text-xs tracking-wide font-mono">{timeStr || '19:30'}</span>
            <p className="text-[10px] text-pos-muted capitalize font-medium">{dateStr || '1 Septembre 2026'}</p>
          </div>

          <div
            className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-md shadow-emerald-500/50 animate-pulse shrink-0"
            title="Système En Ligne & Synchronisé"
          />
        </div>
      </div>
    </footer>
  );
};

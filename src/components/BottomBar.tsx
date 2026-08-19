import React, { useState, useEffect, useRef } from 'react';
import {
  PlusCircle,
  FileSearch,
  Users,
  Percent,
  PauseCircle,
  BarChart3,
  SlidersHorizontal,
  Settings,
  Wifi,
  ShieldAlert,
  FileText,
  Sliders,
  CheckCircle2,
  Database,
} from 'lucide-react';
import { usePosStore } from '../store/usePosStore';

export const BottomBar: React.FC = () => {
  const { openModal, holdSale, clearCart, heldSales } = usePosStore();
  const [timeStr, setTimeStr] = useState('');
  const [dateStr, setDateStr] = useState('');
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTimeStr(now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
      setDateStr(
        now.toLocaleDateString('fr-DZ', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMoreMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <footer className="bg-pos-panel border-t border-pos-border px-3 py-2 select-none relative">
      {/* Floating Shortcut Hint Bar */}
      <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-slate-950/90 border border-emerald-500/50 backdrop-blur-md px-4 py-1 rounded-full shadow-2xl flex items-center gap-3 text-[11px] font-medium text-slate-200 z-30">
        <span>Attente: <span className="hotkey-badge text-emerald-300">F4</span></span>
        <span className="text-pos-border">|</span>
        <span>Recherche: <span className="hotkey-badge text-emerald-300">F2</span></span>
        <span className="text-pos-border">|</span>
        <span>Remise: <span className="hotkey-badge text-emerald-300">F6</span></span>
        <span className="text-pos-border">|</span>
        <span>Rapports: <span className="hotkey-badge text-emerald-300">F10</span></span>
      </div>

      <div className="flex items-center justify-between gap-2">
        {/* Function Keys Grid */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
          <button
            onClick={clearCart}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium"
          >
            <PlusCircle className="w-3.5 h-3.5 text-emerald-500" />
            <span>Nouveau</span>
            <span className="hotkey-badge">F1</span>
          </button>

          <button
            onClick={() => openModal('hold')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium relative"
          >
            <FileSearch className="w-3.5 h-3.5 text-amber-500" />
            <span>Reprendre</span>
            {heldSales.length > 0 && (
              <span className="w-4 h-4 rounded-full bg-amber-500 text-slate-950 text-[10px] font-bold flex items-center justify-center">
                {heldSales.length}
              </span>
            )}
            <span className="hotkey-badge">F4</span>
          </button>

          <button
            onClick={() => openModal('customers')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium"
          >
            <Users className="w-3.5 h-3.5 text-blue-500" />
            <span>Clients</span>
            <span className="hotkey-badge">F5</span>
          </button>

          <button
            onClick={() => openModal('discount')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium"
          >
            <Percent className="w-3.5 h-3.5 text-purple-500" />
            <span>Remise</span>
            <span className="hotkey-badge">F6</span>
          </button>

          <button
            onClick={holdSale}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium"
          >
            <PauseCircle className="w-3.5 h-3.5 text-teal-500" />
            <span>Mettre en Attente</span>
            <span className="hotkey-badge">F4</span>
          </button>

          <button
            onClick={() => openModal('reports')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium"
          >
            <BarChart3 className="w-3.5 h-3.5 text-cyan-400" />
            <span>Rapports</span>
            <span className="hotkey-badge">F10</span>
          </button>

          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setIsMoreMenuOpen(!isMoreMenuOpen)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-pos-muted" />
              <span>Plus</span>
              <span className="hotkey-badge">F11</span>
            </button>
            
            {isMoreMenuOpen && (
              <div className="absolute bottom-full left-0 mb-2 w-56 bg-pos-panel border border-pos-border rounded-xl shadow-xl overflow-hidden z-50">
                <div className="p-1.5 space-y-1">
                  <button
                    onClick={() => { openModal('shift_zreport'); setIsMoreMenuOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-pos-hover text-xs text-pos-text transition"
                  >
                    <ShieldAlert className="w-4 h-4 text-emerald-400" />
                    <span>Rapport Z (Clôture)</span>
                  </button>
                  <button
                    onClick={() => { openModal('receipt_template'); setIsMoreMenuOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-pos-hover text-xs text-pos-text transition"
                  >
                    <Sliders className="w-4 h-4 text-cyan-400" />
                    <span>Modèle de Ticket</span>
                  </button>
                  <button
                    onClick={() => { openModal('invoice_ingestion'); setIsMoreMenuOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-pos-hover text-xs text-pos-text transition"
                  >
                    <FileText className="w-4 h-4 text-amber-400" />
                    <span>Ingestion Facture</span>
                  </button>
                  <button
                    onClick={() => { /* openModal('licensing') */ setIsMoreMenuOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-pos-hover text-xs text-pos-text transition"
                  >
                    <CheckCircle2 className="w-4 h-4 text-purple-400" />
                    <span>Licence & Activation</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          <button
            onClick={() => openModal('settings')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium"
          >
            <Settings className="w-3.5 h-3.5 text-pos-muted" />
            <span>Paramètres</span>
            <span className="hotkey-badge">F12</span>
          </button>
        </div>

        {/* System Time & Connection Indicators */}
        <div className="flex items-center gap-2.5 pl-3 border-l border-pos-border shrink-0">
          <button
            onClick={() => openModal('settings')}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-[10px] font-bold text-cyan-300 transition cursor-pointer"
            title="Moteur SQLite WAL Actif • Intégrité Totale & Zéro Perte de Données"
          >
            <Database className="w-3 h-3 text-cyan-400" />
            <span>SQLite WAL</span>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          </button>

          <div className="text-right text-xs">
            <span className="font-bold text-pos-text tracking-wide">{timeStr || '10:42'}</span>
            <p className="text-[10px] text-pos-muted capitalize">{dateStr || '1 août 2026'}</p>
          </div>
          <Wifi className="w-4 h-4 text-emerald-500" />
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-md shadow-emerald-500/50 animate-pulse" title="Système En Ligne" />
        </div>
      </div>
    </footer>
  );
};

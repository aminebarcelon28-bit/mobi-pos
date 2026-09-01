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
  ShieldAlert,
  FileText,
  Sliders,
  CheckCircle2,
  Database,
  Play,
  ArrowDownCircle,
  Keyboard,
  Boxes,
  RotateCcw,
  Clock,
  CreditCard,
  DollarSign,
  Smartphone,
  Monitor,
  Sparkles,
  Receipt,
} from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import { useToast } from './ui/Toast';

export const BottomBar: React.FC = () => {
  const { openModal, holdSale, clearCart, heldSales, activeShift } = usePosStore();
  const { showToast } = useToast();
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

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMoreMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
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
    <footer className="bg-pos-panel border-t border-pos-border px-3 py-1.5 select-none shrink-0 relative z-20">
      <div className="flex items-center justify-between gap-2 overflow-x-auto no-scrollbar">
        {/* Function Keys Grid */}
        <div className="flex items-center gap-1.5 shrink-0 py-0.5">
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

          {/* Refund / Remboursement F11 */}
          <button
            onClick={() => openModal('refund')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Retours Marchandise & Remboursements (F11)"
          >
            <RotateCcw className="w-3.5 h-3.5 text-purple-400 shrink-0" />
            <span>Remboursement</span>
            <span className="hotkey-badge">F11</span>
          </button>

          <div className="relative shrink-0" ref={menuRef}>
            <button
              onClick={() => setIsMoreMenuOpen(!isMoreMenuOpen)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-bold transition cursor-pointer whitespace-nowrap ${
                isMoreMenuOpen
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                  : 'bg-pos-card hover:bg-pos-hover border-pos-border text-pos-muted hover:text-pos-text'
              }`}
              title="Autres Actions & Menus"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>Plus</span>
            </button>

            {isMoreMenuOpen && (
              <div className="absolute bottom-full left-0 mb-2 w-64 bg-pos-panel border border-pos-border rounded-2xl shadow-2xl overflow-hidden z-50 animate-in fade-in zoom-in-95 max-h-[70vh] overflow-y-auto">
                <div className="p-2 space-y-1">
                  {activeShift ? (
                    <>
                      <button
                        onClick={() => {
                          openModal('shift_movement');
                          setIsMoreMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-pos-hover text-xs text-amber-400 font-bold transition cursor-pointer"
                      >
                        <ArrowDownCircle className="w-4 h-4 text-amber-400 shrink-0" />
                        <span>Dépense / Mouvement Caisse</span>
                      </button>
                      <button
                        onClick={() => {
                          openModal('shift_close');
                          setIsMoreMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-pos-hover text-xs text-emerald-400 font-bold transition cursor-pointer"
                      >
                        <ShieldAlert className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span>Clôture Caisse & Rapport Z</span>
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => {
                        openModal('shift_open');
                        setIsMoreMenuOpen(false);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-pos-hover text-xs text-emerald-400 font-bold transition cursor-pointer"
                    >
                      <Play className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>Ouvrir la Caisse (Start Shift)</span>
                    </button>
                  )}
                  <button
                    onClick={() => {
                      openModal('command_tickets');
                      setIsMoreMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-pos-hover text-xs text-amber-400 font-bold transition cursor-pointer"
                  >
                    <Clock className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>File d'Attente & Commandes</span>
                  </button>
                  <button
                    onClick={() => {
                      openModal('debt_ledger');
                      setIsMoreMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-pos-hover text-xs text-rose-400 font-bold transition cursor-pointer"
                  >
                    <CreditCard className="w-4 h-4 text-rose-400 shrink-0" />
                    <span>Dettes & Crédits (Kredy)</span>
                  </button>
                  <button
                    onClick={() => {
                      openModal('expense_manager');
                      setIsMoreMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-pos-hover text-xs text-amber-400 font-bold transition cursor-pointer"
                  >
                    <DollarSign className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>Dépenses & Sorties Caisse</span>
                  </button>
                  <button
                    onClick={() => {
                      openModal('db_maintenance');
                      setIsMoreMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-pos-hover text-xs text-cyan-400 font-bold transition cursor-pointer"
                  >
                    <Database className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span>Maintenance Base SQLite WAL</span>
                  </button>
                  <button
                    onClick={() => {
                      openModal('compatibility');
                      setIsMoreMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-pos-hover text-xs text-cyan-400 font-medium transition cursor-pointer"
                  >
                    <Sparkles className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span>Guide Compatibilité Modèles</span>
                  </button>
                  <button
                    onClick={() => {
                      openModal('imei_inspector');
                      setIsMoreMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-pos-hover text-xs text-emerald-400 font-medium transition cursor-pointer"
                  >
                    <Smartphone className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Traçabilité IMEI & Garanties</span>
                  </button>
                  <button
                    onClick={() => {
                      openModal('customer_display');
                      setIsMoreMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                  >
                    <Monitor className="w-4 h-4 text-purple-400 shrink-0" />
                    <span>Double Écran Client (Display)</span>
                  </button>
                  <button
                    onClick={() => {
                      openModal('shift_zreport');
                      setIsMoreMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                  >
                    <Receipt className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>Rapport Z (Aperçu Direct)</span>
                  </button>
                  <button
                    onClick={() => {
                      openModal('hotkey_guide');
                      setIsMoreMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                  >
                    <Keyboard className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Guide des Raccourcis (F8)</span>
                  </button>
                  <button
                    onClick={() => {
                      openModal('receipt_template');
                      setIsMoreMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                  >
                    <Sliders className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span>Modèle de Ticket</span>
                  </button>
                  <button
                    onClick={() => {
                      openModal('invoice_ingestion');
                      setIsMoreMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                  >
                    <FileText className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>Ingestion Facture Fournisseur</span>
                  </button>
                  <button
                    onClick={() => {
                      openModal('licensing');
                      setIsMoreMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                  >
                    <CheckCircle2 className="w-4 h-4 text-purple-400 shrink-0" />
                    <span>Licence & Activation</span>
                  </button>
                </div>
              </div>
            )}
          </div>

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

        {/* System Time & Connection Indicators */}
        <div className="flex items-center gap-2 pl-2 border-l border-pos-border shrink-0 text-xs">
          <button
            onClick={() => openModal('db_maintenance')}
            className="flex items-center gap-1 px-2 py-1 rounded-md bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-[10px] font-bold text-cyan-300 transition cursor-pointer shrink-0"
            title="Moteur SQLite WAL Actif • Cliquez pour ouvrir le Centre de Maintenance"
          >
            <Database className="w-3 h-3 text-cyan-400 shrink-0" />
            <span className="font-mono">WAL OK</span>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          </button>

          <div className="text-right whitespace-nowrap leading-tight">
            <span className="font-bold text-pos-text text-xs tracking-wide font-mono">{timeStr || '18:59'}</span>
            <p className="text-[10px] text-pos-muted capitalize">{dateStr || '1 Septembre'}</p>
          </div>

          <div
            className="w-2 h-2 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50 animate-pulse shrink-0"
            title="Système En Ligne & Synchronisé"
          />
        </div>
      </div>
    </footer>
  );
};

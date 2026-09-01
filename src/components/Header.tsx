import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Search,
  UserCheck,
  Star,
  Smartphone,
  PlusCircle,
  BarChart3,
  Barcode,
  FileText,
  ShieldAlert,
  Unlock,
  Sliders,
  Bell,
  Wrench,
  RefreshCw,
  Package,
  RotateCcw,
  Volume2,
  VolumeX,
  Clock,
  CreditCard,
  DollarSign,
  Database,
  Grid,
  ChevronDown,
  X,
} from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import { calculateStockAlerts } from '../utils/alertEngine';
import { ThemeToggle } from './ThemeToggle';
import { PinDialog } from './ui/PinDialog';
import { useToast } from './ui/Toast';
import { soundEngine } from '../utils/audioFeedback';
import { formatDZD } from '../types/pos';

export const Header: React.FC = () => {
  const {
    searchQuery,
    setSearchQuery,
    currentCustomer,
    setCurrentCustomer,
    customers,
    openModal,
    setEditingProduct,
    logSecurityAction,
    products,
    addToCart,
    activeShift,
    purchaseOrders,
    heldSales,
  } = usePosStore();

  const [isAudioMuted, setIsAudioMuted] = useState<boolean>(() => soundEngine.getProfile().isMuted);
  const [isToolsDropdownOpen, setIsToolsDropdownOpen] = useState(false);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const [isPinOpen, setIsPinOpen] = useState(false);
  const { showToast } = useToast();
  const searchInputRef = useRef<HTMLInputElement>(null);

  const waitingTicketsCount = useMemo(() => {
    const waitingPOs = (purchaseOrders || []).filter(
      (po) => po.status === 'Waiting List' || po.status === 'Draft' || po.status === 'Partially Received'
    ).length;
    const held = (heldSales || []).length;
    return waitingPOs + held;
  }, [purchaseOrders, heldSales]);

  const indebtedCount = useMemo(() => {
    return (customers || []).filter((c) => (c.currentDebt || 0) > 0).length;
  }, [customers]);

  const { stockAlerts, criticalCount } = useMemo(() => {
    const alerts = calculateStockAlerts(products);
    const critical = alerts.filter((a) => a.severity === 'critical').length;
    return { stockAlerts: alerts, criticalCount: critical };
  }, [products]);

  const handleToggleMute = () => {
    const muted = soundEngine.toggleMute();
    setIsAudioMuted(muted);
    if (!muted) {
      soundEngine.playScan();
    }
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(event.target as Node)) {
        setIsToolsDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Global Barcode Scanner Hardware Listener
  useEffect(() => {
    let buffer = '';
    let lastKeyTime = Date.now();

    const handleKeyDown = (e: KeyboardEvent) => {
      // Hotkey F2 to focus search input
      if (e.key === 'F2') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      // Ignore keys inside standard inputs to allow normal typing
      const activeTag = document.activeElement?.tagName.toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
        return;
      }

      const currentTime = Date.now();
      if (currentTime - lastKeyTime > 150) {
        buffer = '';
      }
      lastKeyTime = currentTime;

      if (e.key === 'Enter') {
        if (buffer.length >= 2) {
          e.preventDefault();
          const scannedCode = buffer.trim();

          // 1. Check Product Barcode or SKU Match
          const foundProduct = products.find(
            (p) =>
              p.barcode === scannedCode ||
              p.sku.toLowerCase() === scannedCode.toLowerCase()
          );

          if (foundProduct) {
            addToCart(foundProduct);
            showToast(`+1 ${foundProduct.title} ajouté au panier`, 'success');
            soundEngine.playScan();
            buffer = '';
            return;
          }

          // 2. Check Customer Loyalty Barcode or Phone Match
          const foundCustomer = (customers || []).find(
            (c) =>
              c.phone === scannedCode ||
              c.phone.replace(/^0/, '+213') === scannedCode ||
              c.id === scannedCode ||
              `LOY-${c.id}` === scannedCode
          );

          if (foundCustomer) {
            setCurrentCustomer(foundCustomer);
            showToast(`Client ${foundCustomer.name} identifié !`, 'success');
            soundEngine.playSuccess();
            buffer = '';
            return;
          }

          // 3. Fallback: put into search query
          setSearchQuery(scannedCode);
        }
        buffer = '';
      } else if (e.key.length === 1) {
        buffer += e.key;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [products, customers, addToCart, setCurrentCustomer, setSearchQuery, showToast]);

  const handleNoSaleDrawerOpen = () => {
    setIsPinOpen(true);
  };

  const handlePinSuccess = () => {
    soundEngine.playCashDrawer();
    logSecurityAction(
      'Ouverture Manuelle Tiroir ("No Sale")',
      'Tiroir-caisse ouvert sans vente par Administrateur',
      'Yacine (Admin)',
      true
    );
    showToast(
      'Ouverture manuelle du tiroir-caisse autorisée (Signal RJ11 envoyé). Action enregistrée.',
      'success'
    );
    setIsPinOpen(false);
  };

  return (
    <>
      <header className="bg-pos-panel border-b border-pos-border px-3 py-2 flex items-center justify-between gap-2.5 select-none transition-colors duration-200 shrink-0 z-30">
        {/* ══════════════════════════════════════════════════════════════ */}
        {/* 1. LEFT: SLEEK BRAND & GLOBAL SEARCH */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white shadow-md shadow-emerald-500/20 shrink-0">
            <Smartphone className="w-5 h-5 stroke-[2.5]" />
          </div>
          <div>
            <div className="flex items-center gap-1.5 leading-none">
              <span className="font-black text-sm text-pos-text tracking-tight">MobiPOS</span>
              <span className="text-[9px] uppercase font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded">
                PRO
              </span>
            </div>
            <span className="text-[10px] text-pos-muted font-medium">Accessoires & Caisse</span>
          </div>
        </div>

        {/* Global Search Bar */}
        <div className="flex-1 max-w-xs md:max-w-sm lg:max-w-md xl:max-w-lg relative mx-1">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Scanner code-barres ou rechercher Réf/SKU (F2)..."
            className="w-full bg-pos-bg border border-pos-border rounded-xl pl-9 pr-14 py-1.5 text-xs text-pos-text placeholder-pos-muted focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all font-medium"
          />
          {searchQuery ? (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-8 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text p-1 cursor-pointer"
            >
              <X className="w-3 h-3" />
            </button>
          ) : null}
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 hotkey-badge text-[10px]">F2</span>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* 2. CENTER: PRIMARY ACTION CONTROLS & DROPDOWN */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Quick Add Product */}
          <button
            onClick={() => setEditingProduct(null)}
            className="px-2.5 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center gap-1.5 shadow-sm transition cursor-pointer shrink-0"
            title="Ajouter un Nouveau Produit (avec photo et code-barres)"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">+ Produit</span>
          </button>

          {/* SAV Repair Work Orders */}
          <button
            onClick={() => openModal('repair_work_order')}
            className="p-1.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-emerald-400 hover:text-emerald-300 transition cursor-pointer"
            title="Gestion des Réparations & Tickets SAV"
          >
            <Wrench className="w-4 h-4" />
          </button>

          {/* Stock Alerts Bell */}
          <button
            onClick={() => openModal('vendor_procurement')}
            className="relative p-1.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-emerald-400 hover:text-emerald-300 transition cursor-pointer"
            title={`Alertes Réapprovisionnement (${stockAlerts.length} articles en alerte)`}
          >
            <Bell className="w-4 h-4" />
            {stockAlerts.length > 0 && (
              <span
                className={`absolute -top-1 -right-1 px-1 rounded-full text-[9px] font-black text-white ${
                  criticalCount > 0 ? 'bg-red-500 animate-pulse' : 'bg-amber-500'
                }`}
              >
                {stockAlerts.length}
              </span>
            )}
          </button>

          {/* Command Tickets & Waiting List */}
          <button
            onClick={() => openModal('command_tickets')}
            className="relative p-1.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-amber-400 hover:text-amber-300 transition cursor-pointer"
            title="File d'Attente des Commandes & Ventes Suspendues"
          >
            <Clock className="w-4 h-4" />
            {waitingTicketsCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-amber-500 text-slate-950 font-black text-[9px] w-4 h-4 rounded-full flex items-center justify-center border border-pos-card animate-pulse">
                {waitingTicketsCount > 9 ? '9+' : waitingTicketsCount}
              </span>
            )}
          </button>

          {/* Customer Debt & Kredy Ledger */}
          <button
            onClick={() => openModal('debt_ledger')}
            className="relative p-1.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-rose-400 hover:text-rose-300 transition cursor-pointer"
            title="Registre & Suivi des Dettes Clients (Kredy)"
          >
            <CreditCard className="w-4 h-4" />
            {indebtedCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-rose-500 text-white font-black text-[9px] w-4 h-4 rounded-full flex items-center justify-center border border-pos-card">
                {indebtedCount > 9 ? '9+' : indebtedCount}
              </span>
            )}
          </button>

          {/* Store Expenses Manager */}
          <button
            onClick={() => openModal('expense_manager')}
            className="p-1.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-amber-400 hover:text-amber-300 transition cursor-pointer"
            title="Gestionnaire des Dépenses & Sorties de Caisse (EBITDA)"
          >
            <DollarSign className="w-4 h-4" />
          </button>

          {/* ── Secondary Tools & Modules Dropdown Menu ── */}
          <div className="relative" ref={toolsMenuRef}>
            <button
              onClick={() => setIsToolsDropdownOpen(!isToolsDropdownOpen)}
              className={`p-1.5 rounded-xl border transition cursor-pointer flex items-center gap-1 ${
                isToolsDropdownOpen
                  ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/50'
                  : 'bg-pos-card hover:bg-pos-hover border-pos-border text-pos-muted hover:text-pos-text'
              }`}
              title="Centre d'Outils & Modules Complémentaires"
            >
              <Grid className="w-4 h-4 text-cyan-400" />
              <ChevronDown className="w-3 h-3" />
            </button>

            {isToolsDropdownOpen && (
              <div className="absolute right-0 top-full mt-2 w-64 bg-pos-panel border border-pos-border rounded-2xl shadow-2xl overflow-hidden z-50 animate-in fade-in zoom-in-95 p-1.5 space-y-1">
                <span className="text-[10px] font-bold text-pos-muted uppercase px-2 py-1 block">
                  Modules Spécialisés
                </span>

                <button
                  onClick={() => {
                    openModal('invoice_ingestion');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                >
                  <FileText className="w-4 h-4 text-emerald-400" />
                  <span>Ingestion Facture Fournisseur</span>
                </button>

                <button
                  onClick={() => {
                    openModal('label_printer');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                >
                  <Barcode className="w-4 h-4 text-emerald-500" />
                  <span>Étiquettes Codes-barres</span>
                </button>

                <button
                  onClick={() => {
                    openModal('imei_inspector');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                >
                  <Smartphone className="w-4 h-4 text-cyan-400" />
                  <span>Traçabilité IMEI & Garantie</span>
                </button>

                <button
                  onClick={() => {
                    openModal('kitting_bundle');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                >
                  <Package className="w-4 h-4 text-amber-400" />
                  <span>Packs Protection & Bundles</span>
                </button>

                <button
                  onClick={() => {
                    openModal('trade_in_buyback');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                >
                  <RefreshCw className="w-4 h-4 text-cyan-400" />
                  <span>Reprise Occasion (Trade-In)</span>
                </button>

                <div className="border-t border-pos-border my-1" />

                <button
                  onClick={() => {
                    openModal('reports');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                >
                  <BarChart3 className="w-4 h-4 text-cyan-400" />
                  <span>Rapports Financiers & Bilan (F9)</span>
                </button>

                <button
                  onClick={() => {
                    openModal('refund');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                >
                  <RotateCcw className="w-4 h-4 text-purple-400" />
                  <span>Retours & Remboursements (F11)</span>
                </button>

                <button
                  onClick={() => {
                    handleNoSaleDrawerOpen();
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                >
                  <Unlock className="w-4 h-4 text-amber-400" />
                  <span>Ouvrir Tiroir Caisse ('No Sale')</span>
                </button>

                <button
                  onClick={() => {
                    openModal('security_audit');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                >
                  <ShieldAlert className="w-4 h-4 text-amber-500" />
                  <span>Journal d'Audit Sécurité</span>
                </button>

                <button
                  onClick={() => {
                    openModal('receipt_template');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                >
                  <Sliders className="w-4 h-4 text-pos-muted" />
                  <span>Modèle de Ticket</span>
                </button>

                <button
                  onClick={() => {
                    openModal('db_maintenance');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer"
                >
                  <Database className="w-4 h-4 text-cyan-400" />
                  <span>Maintenance Base SQLite WAL</span>
                </button>
              </div>
            )}
          </div>

          {/* Cash Register Session Status */}
          {activeShift ? (
            <button
              onClick={() => openModal('shift_close')}
              className="px-2.5 py-1 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer shrink-0"
              title="Session Caisse Ouverte • Cliquez pour Clôturer / Rapport Z"
            >
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="font-mono text-[11px]">{activeShift.cashierName}</span>
            </button>
          ) : (
            <button
              onClick={() => openModal('shift_open')}
              className="px-2 py-1 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 text-[11px] font-bold flex items-center gap-1.5 transition cursor-pointer animate-pulse shrink-0"
              title="Caisse Fermée • Cliquez pour Ouvrir"
            >
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              <span>Ouvrir Caisse</span>
            </button>
          )}

          {/* Audio Mute Toggle */}
          <button
            type="button"
            onClick={handleToggleMute}
            className={`p-1.5 rounded-xl border transition cursor-pointer shrink-0 ${
              isAudioMuted
                ? 'bg-red-500/10 border-red-500/30 text-red-400'
                : 'bg-pos-card border-pos-border text-emerald-400 hover:border-emerald-400'
            }`}
            title={isAudioMuted ? 'Activer le son' : 'Mode Silencieux'}
          >
            {isAudioMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>

          {/* Dark / Light Theme Toggle */}
          <div className="shrink-0">
            <ThemeToggle />
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* 3. RIGHT: ANCHORED BEAUTIFUL CUSTOMER PROFILE WIDGET */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="shrink-0 max-w-[260px]">
          {currentCustomer ? (
            <div
              onClick={() => openModal('customers')}
              className="flex items-center gap-2 bg-pos-card hover:bg-pos-hover border border-pos-border hover:border-emerald-500/40 p-1.5 rounded-xl shadow-sm transition cursor-pointer"
              title="Cliquez pour changer ou modifier le client (F5)"
            >
              {currentCustomer.avatarUrl ? (
                <img
                  src={currentCustomer.avatarUrl}
                  alt={currentCustomer.name}
                  className="w-8 h-8 rounded-full object-cover border border-emerald-500/50 shrink-0"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 text-slate-950 font-black text-xs flex items-center justify-center shrink-0">
                  {currentCustomer.name.slice(0, 2).toUpperCase()}
                </div>
              )}

              <div className="text-left text-xs min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-pos-text truncate text-xs">{currentCustomer.name}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-pos-muted mt-0.5">
                  <span className="text-amber-400 font-bold flex items-center gap-0.5">
                    <Star className="w-2.5 h-2.5 fill-amber-400" />
                    {currentCustomer.loyaltyPoints} pts
                  </span>
                  {(currentCustomer.storeCredit || 0) > 0 && (
                    <span className="text-emerald-400 font-bold font-mono">
                      +{formatDZD(currentCustomer.storeCredit)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <button
              onClick={() => openModal('customers')}
              className="flex items-center gap-1.5 bg-pos-card hover:bg-pos-hover border border-pos-border hover:border-emerald-500/40 px-3 py-1.5 rounded-xl text-xs font-bold text-pos-muted hover:text-pos-text transition cursor-pointer"
              title="Sélectionner ou Créer un Client (F5)"
            >
              <UserCheck className="w-4 h-4 text-emerald-400" />
              <span>+ Client (F5)</span>
            </button>
          )}
        </div>
      </header>

      <PinDialog
        isOpen={isPinOpen}
        onSuccess={handlePinSuccess}
        onCancel={() => setIsPinOpen(false)}
        title="Autorisation Requise"
        description="Saisissez le code PIN Manager pour ouvrir le tiroir-caisse sans vente."
      />
    </>
  );
};

import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Search,
  UserCheck,
  Star,
  MoreVertical,
  Smartphone,
  ShieldCheck,
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
} from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import { calculateStockAlerts } from '../utils/alertEngine';
import { ThemeToggle } from './ThemeToggle';
import { PinDialog } from './ui/PinDialog';
import { useToast } from './ui/Toast';
import { soundEngine } from '../utils/audioFeedback';

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
  } = usePosStore();
  
  const [isAudioMuted, setIsAudioMuted] = useState<boolean>(() => soundEngine.getProfile().isMuted);

  const handleToggleMute = () => {
    const muted = soundEngine.toggleMute();
    setIsAudioMuted(muted);
    if (!muted) {
      soundEngine.playScan();
    }
  };
  const [isPinOpen, setIsPinOpen] = useState(false);
  const { showToast } = useToast();
  const searchInputRef = useRef<HTMLInputElement>(null);

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
        if (buffer.length >= 3) {
          const scannedCode = buffer.trim();
          buffer = '';

          // 1. Check if matches a Product Barcode or SKU
          const foundProduct = products.find(
            p => p.barcode === scannedCode || p.sku.toLowerCase() === scannedCode.toLowerCase()
          );

          if (foundProduct) {
            addToCart(foundProduct);
            showToast(`📦 Scanné : ${foundProduct.title}`, 'success');
            return;
          }

          // 2. Check if matches a Customer PVC Card or Phone Number
          const foundCustomer = customers.find(
            c => (c.id && `LOY-${c.id}` === scannedCode) || c.phone === scannedCode || c.name.toLowerCase() === scannedCode.toLowerCase()
          );

          if (foundCustomer) {
            setCurrentCustomer(foundCustomer);
            soundEngine.playSuccess();
            showToast(`👤 Client identifié : ${foundCustomer.name}`, 'success');
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

  const { stockAlerts, criticalCount } = useMemo(() => {
    const alerts = calculateStockAlerts(products);
    const critical = alerts.filter((a) => a.severity === 'critical').length;
    return { stockAlerts: alerts, criticalCount: critical };
  }, [products]);

  const handleNoSaleDrawerOpen = () => {
    setIsPinOpen(true);
  };

  const handlePinSuccess = () => {
    soundEngine.playCashDrawer();
    logSecurityAction('Ouverture Manuelle Tiroir ("No Sale")', 'Tiroir-caisse ouvert sans vente par Administrateur', 'Yacine (Admin)', true);
    showToast(
      'Ouverture manuelle du tiroir-caisse autorisée (Signal RJ11 envoyé). Action enregistrée dans le journal de sécurité.',
      'success'
    );
    setIsPinOpen(false);
  };

  return (
    <>
      <header className="bg-pos-panel border-b border-pos-border px-4 py-2.5 flex items-center justify-between gap-3 select-none transition-colors duration-200">
        {/* Brand & Logo */}
        <div className="flex items-center gap-3 min-w-[240px]">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white shadow-lg shadow-emerald-500/20">
            <Smartphone className="w-6 h-6 stroke-[2.5]" />
          </div>
          <div>
            <h1 className="font-extrabold text-lg tracking-wider text-pos-text leading-none flex items-center gap-1.5">
              ACCESSOIRES <span className="text-emerald-500 font-medium text-xs tracking-normal uppercase bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/30">MOBI</span>
            </h1>
            <p className="text-[11px] text-pos-muted font-medium mt-0.5 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3 text-emerald-500" /> Caisse Enterprise • SAV & Bundles
            </p>
          </div>
        </div>

        {/* Global Search Input */}
        <div className="flex-1 max-w-lg relative">
          <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-pos-muted" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Scanner code-barres ou rechercher Réf/SKU (F2)..."
            className="w-full bg-pos-bg border border-pos-border rounded-lg pl-10 pr-12 py-2 text-sm text-pos-text placeholder-pos-muted focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 hotkey-badge">F2</span>
        </div>

        {/* Action Controls: Enterprise Tools */}
        <div className="flex items-center gap-1.5">
          {/* Repair Work Orders Trigger */}
          <button
            onClick={() => openModal('repair_work_order')}
            className="p-2 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer"
            title="Gestion des Réparations & Tickets SAV"
          >
            <Wrench className="w-4 h-4 text-emerald-400" />
          </button>

          {/* Trade-In Buyback Trigger */}
          <button
            onClick={() => openModal('trade_in_buyback')}
            className="p-2 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer"
            title="Reprise & Rachat Smartphones d'Occasion"
          >
            <RefreshCw className="w-4 h-4 text-cyan-400" />
          </button>

          {/* Kitting Bundle Trigger */}
          <button
            onClick={() => openModal('kitting_bundle')}
            className="p-2 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer"
            title="Packs Protection & Bundles"
          >
            <Package className="w-4 h-4 text-amber-400" />
          </button>

          {/* Notification Bell for Stock Alerts */}
          <button
            onClick={() => openModal('vendor_procurement')}
            className="p-2 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition relative cursor-pointer"
            title={`Alertes Réapprovisionnement (${stockAlerts.length} articles en alerte)`}
          >
            <Bell className="w-4 h-4 text-emerald-400" />
            {stockAlerts.length > 0 && (
              <span
                className={`absolute -top-1 -right-1 px-1.5 py-0.2 rounded-full text-[9px] font-bold text-white shadow-md ${
                  criticalCount > 0 ? 'bg-red-500 animate-pulse' : 'bg-amber-500'
                }`}
              >
                {stockAlerts.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setEditingProduct(null)}
            className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-md shadow-emerald-500/20 transition cursor-pointer"
            title="Ajouter un Nouveau Produit avec Photo"
          >
            <PlusCircle className="w-4 h-4" /> <span className="hidden lg:inline">+ Produit</span>
          </button>

          <button
            onClick={() => openModal('label_printer')}
            className="p-2 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer"
            title="Imprimer Étiquettes Code-Barres"
          >
            <Barcode className="w-4 h-4 text-emerald-500" />
          </button>

          <button
            onClick={() => openModal('invoice_ingestion')}
            className="p-2 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer"
            title="Ingestion Automatique Facture Fournisseur"
          >
            <FileText className="w-4 h-4 text-emerald-500" />
          </button>

          <button
            onClick={handleNoSaleDrawerOpen}
            className="p-2 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer"
            title="Ouverture Tiroir-Caisse Sécurisée ('No Sale' - PIN Requis)"
          >
            <Unlock className="w-4 h-4 text-amber-500" />
          </button>

          <button
            onClick={() => openModal('security_audit')}
            className="p-2 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer"
            title="Journal d'Audit de Sécurité RBAC"
          >
            <ShieldAlert className="w-4 h-4 text-amber-500" />
          </button>

          <button
            onClick={() => openModal('refund')}
            className="p-2 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-purple-400 hover:text-purple-300 transition cursor-pointer"
            title="Retours Marchandise & Remboursements (Avoirs)"
          >
            <RotateCcw className="w-4 h-4 text-purple-400" />
          </button>

          <button
            onClick={() => openModal('reports')}
            className="p-2 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer"
            title="Rapports Financiers & Synthèse (F9)"
          >
            <BarChart3 className="w-4 h-4 text-cyan-400" />
          </button>

          <button
            onClick={() => openModal('receipt_template')}
            className="p-2 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer"
            title="Personnaliser le Modèle de Ticket"
          >
            <Sliders className="w-4 h-4 text-pos-muted" />
          </button>

          {/* Cash Register Session Status Widget */}
          {activeShift ? (
            <button
              onClick={() => openModal('shift_close')}
              className="px-2.5 py-1.5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
              title="Session Caisse Ouverte • Cliquez pour Clôturer / Rapport Z"
            >
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="hidden sm:inline font-mono">Caisse : {activeShift.cashierName}</span>
            </button>
          ) : (
            <button
              onClick={() => openModal('shift_open')}
              className="px-2.5 py-1.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer animate-pulse"
              title="Caisse Fermée • Cliquez pour Ouvrir la Session"
            >
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              <span>Ouvrir Caisse</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleToggleMute}
            className={`p-2 rounded-xl border transition cursor-pointer ${
              isAudioMuted
                ? 'bg-red-500/10 border-red-500/30 text-red-400'
                : 'bg-pos-card border-pos-border text-emerald-400 hover:border-emerald-400'
            }`}
            title={isAudioMuted ? 'Activer le son (Audio Muet)' : 'Mode Silencieux (Muet)'}
          >
            {isAudioMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>

          <ThemeToggle />
        </div>

        {/* Customer Profile Widget */}
        {currentCustomer ? (
          <div className="flex items-center gap-3 bg-pos-card border border-pos-border px-3 py-1.5 rounded-lg shadow-sm">
            <img
              src={currentCustomer.avatarUrl}
              alt={currentCustomer.name}
              className="w-9 h-9 rounded-full object-cover border border-emerald-500/50"
            />
            <div className="text-left text-xs">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-pos-text">{currentCustomer.name}</span>
                <span className="text-[10px] bg-emerald-500/10 text-emerald-500 font-medium px-1.5 py-0.2 rounded border border-emerald-500/30">
                  {currentCustomer.registeredDevice}
                </span>
              </div>
              <p className="text-[11px] text-pos-muted mt-0.5">
                {currentCustomer.email} | {currentCustomer.phone}
              </p>
            </div>

            <div className="ml-2 pl-3 border-l border-pos-border flex items-center gap-2">
              <div className="text-right">
                <p className="text-[9px] uppercase tracking-wider text-pos-muted font-bold">Fidélité</p>
                <p className="text-xs font-bold text-amber-500 flex items-center justify-end gap-1">
                  <Star className="w-3.5 h-3.5 fill-amber-500 text-amber-500" />
                  {currentCustomer.loyaltyPoints.toLocaleString()} PTS
                </p>
              </div>
              <button 
                onClick={() => openModal('customers')}
                className="p-1 hover:bg-pos-hover rounded text-pos-muted hover:text-pos-text transition cursor-pointer"
                title="Options Client"
              >
                <MoreVertical className="w-4 h-4" />
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => openModal('customers')}
            className="flex items-center gap-2 bg-pos-card hover:bg-pos-hover border border-pos-border px-3.5 py-2 rounded-lg text-xs font-medium text-pos-muted hover:text-pos-text transition cursor-pointer"
          >
            <UserCheck className="w-4 h-4 text-emerald-500" /> Profil Client
          </button>
        )}
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

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
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
  ArrowDownCircle,
  Monitor,
  CheckCircle2,
  Keyboard,
  Lock,
  Ticket,
} from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import { calculateStockAlerts } from '../utils/alertEngine';
import { ThemeToggle } from './ThemeToggle';
import { PinDialog } from './ui/PinDialog';
import { useToast } from './ui/Toast';
import { soundEngine } from '../utils/audioFeedback';
import { formatDZD } from '../types/pos';

export const Header: React.FC = () => {
  // Selective subscriptions: subscribing to the whole store re-renders the
  // header on every cart keystroke / sync tick (noticeable lag). Select only
  // the slices this toolbar reads.
  const searchQuery = usePosStore((s) => s.searchQuery);
  const setSearchQuery = usePosStore((s) => s.setSearchQuery);
  const currentCustomer = usePosStore((s) => s.currentCustomer);
  const customers = usePosStore((s) => s.customers);
  const openModal = usePosStore((s) => s.openModal);
  const setEditingProduct = usePosStore((s) => s.setEditingProduct);
  const logSecurityAction = usePosStore((s) => s.logSecurityAction);
  const products = usePosStore((s) => s.products);
  const activeShift = usePosStore((s) => s.activeShift);
  const purchaseOrders = usePosStore((s) => s.purchaseOrders);
  const heldSales = usePosStore((s) => s.heldSales);
  const activeCashier = usePosStore((s) => s.activeCashier);
  const lockScreen = usePosStore((s) => s.lockScreen);

  const [isAudioMuted, setIsAudioMuted] = useState<boolean>(() => soundEngine.getProfile().isMuted);
  const [isToolsDropdownOpen, setIsToolsDropdownOpen] = useState(false);
  const toolsAnchorRef = useRef<HTMLDivElement>(null);
  const toolsButtonRef = useRef<HTMLButtonElement>(null);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  // Fixed position of the portaled tools menu (computed from the anchor so
  // the menu is never clipped by the scrolling toolbar — see below).
  const [toolsMenuPos, setToolsMenuPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const [isPinOpen, setIsPinOpen] = useState(false);
  const { showToast } = useToast();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [localSearch, setLocalSearch] = useState(searchQuery);

  // ── Center-toolbar overflow affordance: the action strip scrolls on narrow
  // windows — track whether hidden actions exist on either side so fade edges
  // can hint at them (display only, no layout or behavior change).
  const centerScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollCenterLeft, setCanScrollCenterLeft] = useState(false);
  const [canScrollCenterRight, setCanScrollCenterRight] = useState(false);

  const updateCenterScrollEdges = () => {
    const el = centerScrollRef.current;
    if (!el) return;
    setCanScrollCenterLeft(el.scrollLeft > 4);
    setCanScrollCenterRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };

  useEffect(() => {
    const updateEdges = () => {
      const el = centerScrollRef.current;
      if (!el) return;
      setCanScrollCenterLeft(el.scrollLeft > 4);
      setCanScrollCenterRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    };
    updateEdges();
    window.addEventListener('resize', updateEdges);
    return () => window.removeEventListener('resize', updateEdges);
    // Mount-only: re-subscribing on every render (no deps array) churned a
    // resize listener per render — the visible system lag on the toolbar.
  }, []);

  useEffect(() => {
    setLocalSearch(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (localSearch !== searchQuery) {
        setSearchQuery(localSearch);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [localSearch, searchQuery, setSearchQuery]);

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

  // Tools menu: portaled to <body> with fixed positioning, so the
  // center toolbar's `overflow-x: auto` can never clip it (an abs-positioned
  // child of a scroll container is cut off — the menu appeared to open
  // nothing). Position is anchored under the Grid button and clamped to the
  // viewport; Escape / outside-click / resize / scroll dismiss or re-anchor.
  useEffect(() => {
    if (!isToolsDropdownOpen) return;
    const anchor = toolsAnchorRef.current;
    const place = () => {
      const r = anchor?.getBoundingClientRect();
      if (!r) return;
      setToolsMenuPos({
        top: Math.min(r.bottom + 8, window.innerHeight - 16),
        right: Math.max(8, window.innerWidth - r.right),
      });
    };
    place();
    const handleClickOutside = (event: MouseEvent) => {
      const t = event.target as Node;
      if (
        toolsMenuRef.current && !toolsMenuRef.current.contains(t) &&
        toolsAnchorRef.current && !toolsAnchorRef.current.contains(t)
      ) {
        setIsToolsDropdownOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsToolsDropdownOpen(false);
        toolsButtonRef.current?.focus();
      }
    };
    const handleReposition = () => place();
    const handleScroll = () => setIsToolsDropdownOpen(false);
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('resize', handleReposition);
    // Any scroll (toolbar strip, modal, page) invalidates the anchor — close
    // rather than float detached. Capture phase catches inner scrolls too.
    window.addEventListener('scroll', handleScroll, true);
    // Focus the first menu item for keyboard users.
    toolsMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isToolsDropdownOpen]);

  // F1 / "/" shortcut: focus the global search input.
  // NOTE: barcode wedge decoding lives in useBarcodeScanner (App-level,
  // indexed maps, debounced). The previous duplicate listener here ran a
  // linear products/customers scan on every keystroke and double-added every
  // scan (two Enter handlers) — a major source of the reported lag.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const activeTag = document.activeElement?.tagName.toLowerCase();
      if (e.key === 'F1' || (e.key === '/' && activeTag !== 'input' && activeTag !== 'textarea')) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
        <button
          type="button"
          onClick={() => openModal('compatibility')}
          className="flex items-center gap-2.5 shrink-0 hover:opacity-90 transition cursor-pointer text-left group"
          title="Guide de Compatibilité Modèles Smartphones & Accessoires (Cliquez pour ouvrir)"
        >
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white shadow-md shadow-emerald-500/20 group-hover:scale-105 transition shrink-0">
            <Smartphone className="w-5 h-5 stroke-[2.5]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 leading-none">
              <span className="font-black text-sm text-pos-text tracking-tight group-hover:text-emerald-400 transition truncate">
                MobiPOS
              </span>
              {/* PRO badge hides on very narrow windows so the brand block compresses gracefully */}
              <span className="hidden sm:inline-block text-[9px] uppercase font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded shrink-0">
                PRO
              </span>
            </div>
            {/* Subtitle already hidden below md — verified, kept */}
            <span className="text-[10px] text-pos-muted font-medium hidden md:block truncate">Accessoires & Caisse</span>
          </div>
        </button>

        {/* Global Search Bar — min width floor keeps the F1 badge visible at all widths */}
        <div className="flex-1 min-w-[110px] max-w-xs md:max-w-sm lg:max-w-md xl:max-w-lg relative mx-1">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted pointer-events-none" />
          <input
            ref={searchInputRef}
            id="catalog-search"
            name="catalog-search"
            type="text"
            value={localSearch}
            aria-label="Recherche catalogue (F1)"
            onChange={(e) => setLocalSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setSearchQuery(localSearch);
              }
            }}
            placeholder="Scanner code-barres ou rechercher (F1 ou /)..."
            className="w-full bg-pos-bg border border-pos-border rounded-xl pl-9 pr-14 py-1.5 text-xs text-pos-text placeholder-pos-muted focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all font-medium"
          />
          {localSearch ? (
            <button
              onClick={() => {
                setLocalSearch('');
                setSearchQuery('');
              }}
              className="absolute right-8 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text p-1 cursor-pointer"
            >
              <X className="w-3 h-3" />
            </button>
          ) : null}
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 hotkey-badge text-[10px]">F1</span>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* 2. CENTER: PRIMARY ACTION CONTROLS & DROPDOWN (scrolls on narrow screens) */}
        {/* Fade edges hint at hidden actions; customer widget + shift pill sit */}
        {/* outside this scroll zone so they never clip.                          */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="relative flex min-w-0 items-center">
        <div
          ref={centerScrollRef}
          onScroll={updateCenterScrollEdges}
          role="toolbar"
          aria-label="Barre d'outils caisse — faites défiler pour plus d'actions"
          className="flex items-center gap-1.5 min-w-0 overflow-x-auto no-scrollbar py-0.5"
        >
          {/* Quick Add Product */}
          <button
            onClick={() => setEditingProduct(null)}
            className="px-2.5 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center gap-1.5 shadow-sm transition cursor-pointer shrink-0"
            title="Ajouter un Nouveau Produit (avec photo et code-barres)"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">+ Produit</span>
          </button>

          {/* Smartphone IMEI & Warranty Inspector */}
          <button
            type="button"
            onClick={() => openModal('imei_inspector')}
            className="p-1.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-cyan-400 hover:text-cyan-300 transition cursor-pointer shrink-0"
            title="Inspecteur Traçabilité IMEI & Modèles Téléphones (Cliquez pour ouvrir)"
          >
            <Smartphone className="w-4 h-4" />
          </button>

          {/* SAV Repair Work Orders */}
          <button
            onClick={() => openModal('repair_work_order')}
            className="p-1.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-emerald-400 hover:text-emerald-300 transition cursor-pointer shrink-0"
            title="Gestion des Réparations & Tickets SAV"
          >
            <Wrench className="w-4 h-4" />
          </button>

          {/* Stock Alerts Bell */}
          <button
            onClick={() => openModal('vendor_procurement')}
            className="relative p-1.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-emerald-400 hover:text-emerald-300 transition cursor-pointer shrink-0"
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
            className="relative p-1.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-amber-400 hover:text-amber-300 transition cursor-pointer shrink-0"
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
            className="relative p-1.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-rose-400 hover:text-rose-300 transition cursor-pointer shrink-0"
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
            className="p-1.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-amber-400 hover:text-amber-300 transition cursor-pointer shrink-0"
            title="Gestionnaire des Dépenses & Sorties de Caisse (EBITDA)"
          >
            <DollarSign className="w-4 h-4" />
          </button>

          {/* ── Secondary Tools & Modules Dropdown Menu ── */}
          {/* NOTE: only the anchor button lives in the scrolling toolbar. The
              menu itself is portaled to <body> (see below): an abs-positioned
              child of an `overflow-x: auto` container is clipped, which made
              the Grid menu appear to open nothing. */}
          <div className="relative shrink-0" ref={toolsAnchorRef}>
            <button
              ref={toolsButtonRef}
              onClick={() => setIsToolsDropdownOpen(!isToolsDropdownOpen)}
              aria-haspopup="menu"
              aria-expanded={isToolsDropdownOpen}
              aria-label="Centre d'Outils & Modules Complémentaires"
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
          </div>

      {/* Portaled tools menu — rendered into <body> with fixed positioning so
          the toolbar's `overflow-x: auto` can never clip it. Anchored under
          the Grid button (toolsMenuPos), viewport-clamped, scrollable on
          short screens. */}
      {isToolsDropdownOpen && createPortal(
        <div
          ref={toolsMenuRef}
          role="menu"
          aria-label="Modules Spécialisés"
          style={{ position: 'fixed', top: toolsMenuPos.top, right: toolsMenuPos.right }}
          className="w-64 max-h-[70vh] overflow-y-auto bg-pos-panel border border-pos-border rounded-2xl shadow-2xl z-[60] animate-in fade-in zoom-in-95 p-1.5 space-y-1"
        >
                <span className="text-[10px] font-bold text-pos-muted uppercase px-2 py-1 block">
                  Modules Spécialisés
                </span>

                <button
                  onClick={() => {
                    openModal('invoice_ingestion');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer shrink-0"
                >
                  <FileText className="w-4 h-4 text-emerald-400" />
                  <span>Ingestion Facture Fournisseur</span>
                </button>

                <button
                  onClick={() => {
                    openModal('label_printer');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer shrink-0"
                >
                  <Barcode className="w-4 h-4 text-emerald-500" />
                  <span>Étiquettes Codes-barres</span>
                </button>

                <button
                  onClick={() => {
                    openModal('imei_inspector');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer shrink-0"
                >
                  <Smartphone className="w-4 h-4 text-cyan-400" />
                  <span>Traçabilité IMEI & Garantie</span>
                </button>

                <button
                  onClick={() => {
                    openModal('kitting_bundle');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer shrink-0"
                >
                  <Package className="w-4 h-4 text-amber-400" />
                  <span>Packs Protection & Bundles</span>
                </button>

                <button
                  onClick={() => {
                    openModal('trade_in_buyback');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer shrink-0"
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
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer shrink-0"
                >
                  <BarChart3 className="w-4 h-4 text-cyan-400" />
                  {/* F9 opens the custom-item modal (see useKeyboardHotkeys) — no key suffix here */}
                  <span>Rapports Financiers & Bilan</span>
                </button>

                <button
                  onClick={() => {
                    openModal('refund');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer shrink-0"
                >
                  <RotateCcw className="w-4 h-4 text-purple-400" />
                  <span>Retours & Remboursements (F11)</span>
                </button>

                <button
                  onClick={() => {
                    handleNoSaleDrawerOpen();
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer shrink-0"
                >
                  <Unlock className="w-4 h-4 text-amber-400" />
                  <span>Ouvrir Tiroir Caisse ('No Sale')</span>
                </button>

                <button
                  onClick={() => {
                    openModal('security_audit');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer shrink-0"
                >
                  <ShieldAlert className="w-4 h-4 text-amber-500" />
                  <span>Journal d'Audit Sécurité</span>
                </button>

                <button
                  onClick={() => {
                    openModal('receipt_template');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer shrink-0"
                >
                  <Sliders className="w-4 h-4 text-pos-muted" />
                  <span>Modèle de Ticket</span>
                </button>

                <button
                  onClick={() => {
                    openModal('shift_movement');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer shrink-0"
                >
                  <ArrowDownCircle className="w-4 h-4 text-amber-400" />
                  <span>Dépense / Mouvement Caisse</span>
                </button>

                <button
                  onClick={() => {
                    openModal('customer_display');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer shrink-0"
                >
                  <Monitor className="w-4 h-4 text-purple-400" />
                  <span>Double Écran Client</span>
                </button>

                <button
                  onClick={() => {
                    openModal('hotkey_guide');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer shrink-0"
                >
                  <Keyboard className="w-4 h-4 text-emerald-400" />
                  <span>Guide des Raccourcis (F8)</span>
                </button>

                <button
                  onClick={() => {
                    openModal('licensing');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer shrink-0"
                >
                  <CheckCircle2 className="w-4 h-4 text-purple-400" />
                  <span>Licence & Activation</span>
                </button>

                <button
                  onClick={() => {
                    openModal('db_maintenance');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer shrink-0"
                >
                  <Database className="w-4 h-4 text-cyan-400" />
                  <span>Maintenance Base SQLite WAL</span>
                </button>

                <button
                  onClick={() => {
                    openModal('mobile_simulator');
                    setIsToolsDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-pos-hover text-xs text-pos-text font-medium transition cursor-pointer shrink-0"
                >
                  <Smartphone className="w-4 h-4 text-cyan-400" />
                  <span>Simulateur Mobile</span>
                </button>
        </div>,
        document.body
      )}

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

          {/* Cashier Lock & Switch Button */}
          <button
            type="button"
            onClick={lockScreen}
            className="px-2.5 py-1 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-text text-xs font-bold flex items-center gap-1.5 transition cursor-pointer shrink-0 group"
            title="Verrouiller l'écran (Ctrl+L) • Changer de caissier"
          >
            <div
              className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-black text-slate-950"
              style={{ backgroundColor: activeCashier?.avatarColor || '#3b82f6' }}
            >
              {activeCashier?.name.charAt(0) || 'C'}
            </div>
            <span className="text-[11px] font-bold truncate max-w-[100px]">{activeCashier?.name || 'Caissier'}</span>
            <Lock className="w-3.5 h-3.5 text-pos-muted group-hover:text-amber-400 transition" />
          </button>

          {/* Scannable Store Credit Vouchers (Bons d'Avoir) */}
          <button
            type="button"
            onClick={() => openModal('credit_voucher')}
            className="px-2 py-1 rounded-xl bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 text-purple-300 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer shrink-0"
            title="Bons d'Avoir & Crédits d'Échange"
          >
            <Ticket className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-[11px]">Avoirs</span>
          </button>

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
        {/* Scroll affordance fades — pointer-events-none so no click is ever blocked */}
        {canScrollCenterLeft && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 w-6"
            style={{ background: 'linear-gradient(to right, var(--pos-panel), transparent)' }}
          />
        )}
        {canScrollCenterRight && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-6"
            style={{ background: 'linear-gradient(to left, var(--pos-panel), transparent)' }}
          />
        )}
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* 3. RIGHT: ANCHORED BEAUTIFUL CUSTOMER PROFILE WIDGET (never clips: */}
        {/*    shrink-0 keeps it out of the scroll zone, cap + truncate on xs)  */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="shrink-0 min-w-0 max-w-[150px] sm:max-w-[260px]">
          {currentCustomer ? (
            <div
              onClick={() => openModal('customers')}
              className="flex items-center gap-2 bg-pos-card hover:bg-pos-hover border border-pos-border hover:border-emerald-500/40 p-1.5 rounded-xl shadow-sm transition cursor-pointer shrink-0"
              title="Cliquez pour changer ou modifier le client (F3)"
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
              className="flex items-center gap-1.5 bg-pos-card hover:bg-pos-hover border border-pos-border hover:border-emerald-500/40 px-3 py-1.5 rounded-xl text-xs font-bold text-pos-muted hover:text-pos-text transition cursor-pointer shrink-0"
              title="Sélectionner ou Créer un Client (F3)"
            >
              <UserCheck className="w-4 h-4 text-emerald-400" />
              <span>+ Client (F3)</span>
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

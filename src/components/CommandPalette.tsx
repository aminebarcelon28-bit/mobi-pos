import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Search,
  Banknote,
  Users,
  Percent,
  PauseCircle,
  RotateCcw,
  PlusCircle,
  Smartphone,
  Package,
  Layers,
  Truck,
  FileText,
  Tag,
  Clock,
  ArrowRightLeft,
  Lock,
  BarChart3,
  ShieldCheck,
  CreditCard,
  Receipt,
  Settings,
  Keyboard,
  Database,
  Moon,
  Sun,
  X,
} from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import { Kbd } from '../design-system/desktop/Kbd';

interface CommandItem {
  id: string;
  name: string;
  category: 'Caisse' | 'Stock' | 'Session' | 'Audit' | 'Système';
  description: string;
  hotkey?: string;
  icon: React.ComponentType<{ className?: string }>;
  action: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose }) => {
  const [query, setQuery] = useState('');
  const [prevQuery, setPrevQuery] = useState(query);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);

  if (prevQuery !== query) {
    setPrevQuery(query);
    setSelectedIndex(0);
  }

  if (prevIsOpen !== isOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
    }
  }

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const openModal = usePosStore((s) => s.openModal);
  const lockScreen = usePosStore((s) => s.lockScreen);
  const toggleTheme = usePosStore((s) => s.toggleTheme);
  const themeMode = usePosStore((s) => s.themeMode);
  const cart = usePosStore((s) => s.cart);
  const holdSale = usePosStore((s) => s.holdSale);
  const lastTransaction = usePosStore((s) => s.lastTransaction);
  const reprintReceipt = usePosStore((s) => s.reprintReceipt);

  const commands: CommandItem[] = useMemo(() => [
    // ── Caisse ──
    {
      id: 'cmd-payment',
      name: 'Encaisser la vente',
      category: 'Caisse',
      description: 'Ouvrir le terminal d\'encaissement espèces ou mixte',
      hotkey: 'F2',
      icon: Banknote,
      action: () => {
        if (cart.length > 0) openModal('payment');
      },
    },
    {
      id: 'cmd-customers',
      name: 'Fichier Clients & Crédit Kredy',
      category: 'Caisse',
      description: 'Rechercher un client, consulter le solde dû ou attribuer la vente',
      hotkey: 'F3',
      icon: Users,
      action: () => openModal('customers'),
    },
    {
      id: 'cmd-discount',
      name: 'Remise sur panier',
      category: 'Caisse',
      description: 'Appliquer un pourcentage ou montant fixe de réduction',
      hotkey: 'F4',
      icon: Percent,
      action: () => openModal('discount'),
    },
    {
      id: 'cmd-hold',
      name: 'Mettre en attente ou rappeler un ticket',
      category: 'Caisse',
      description: 'Suspendre la commande en cours pour servir un autre client',
      hotkey: 'F6',
      icon: PauseCircle,
      action: () => {
        if (cart.length > 0) holdSale();
        else openModal('hold');
      },
    },
    {
      id: 'cmd-reprint',
      name: 'Réimprimer le dernier reçu',
      category: 'Caisse',
      description: 'Renvoyer le dernier ticket à l\'imprimante thermique',
      hotkey: 'F7',
      icon: Receipt,
      action: () => {
        if (lastTransaction) reprintReceipt(lastTransaction);
      },
    },
    {
      id: 'cmd-custom-item',
      name: 'Article hors catalogue & service',
      category: 'Caisse',
      description: 'Saisie rapide pour pose film, réparation, main d\'œuvre',
      hotkey: 'F9',
      icon: PlusCircle,
      action: () => openModal('custom_item'),
    },
    {
      id: 'cmd-refund',
      name: 'Remboursement ou retour article',
      category: 'Caisse',
      description: 'Traiter une reprise, échange ou restitution client',
      hotkey: 'F11',
      icon: RotateCcw,
      action: () => openModal('refund'),
    },
    {
      id: 'cmd-trade-in',
      name: 'Reprise d\'appareil d\'occasion (Trade-In)',
      category: 'Caisse',
      description: 'Évaluation argus, inspection IMEI et bon de rachat',
      icon: Smartphone,
      action: () => openModal('trade_in_buyback'),
    },

    // ── Stock ──
    {
      id: 'cmd-inventory',
      name: 'Gestion de stock & Catalogue',
      category: 'Stock',
      description: 'Consulter l\'état des stocks, alertes et mouvements',
      hotkey: 'F10',
      icon: Package,
      action: () => openModal('inventory_manager'),
    },
    {
      id: 'cmd-matrix',
      name: 'Matrice de variantes & déclinaisons',
      category: 'Stock',
      description: 'Créer et éditer les coloris, capacités et références',
      icon: Layers,
      action: () => openModal('product_matrix'),
    },
    {
      id: 'cmd-replenish',
      name: 'Réapprovisionnement & Commandes Fournisseur',
      category: 'Stock',
      description: 'Calculer les besoins d\'achat et préparer les bons de commande',
      icon: Truck,
      action: () => openModal('vendor_procurement'),
    },
    {
      id: 'cmd-invoice-ingest',
      name: 'Ingestion de factures fournisseurs',
      category: 'Stock',
      description: 'Numériser et intégrer les entrées de stock automatisées',
      icon: FileText,
      action: () => openModal('invoice_ingestion'),
    },
    {
      id: 'cmd-labels',
      name: 'Impression d\'étiquettes code-barres',
      category: 'Stock',
      description: 'Générer des planches de prix et codes-barres thermiques',
      icon: Tag,
      action: () => openModal('label_printer'),
    },

    // ── Session ──
    {
      id: 'cmd-shift-open',
      name: 'Ouvrir une session de caisse',
      category: 'Session',
      description: 'Comptage initial du fond de caisse et prise de poste',
      icon: Clock,
      action: () => openModal('shift_open'),
    },
    {
      id: 'cmd-shift-movement',
      name: 'Mouvement d\'espèces (Apport / Retrait)',
      category: 'Session',
      description: 'Enregistrer une entrée ou sortie de liquide du tiroir',
      icon: ArrowRightLeft,
      action: () => openModal('shift_movement'),
    },
    {
      id: 'cmd-shift-close',
      name: 'Clôturer la session de caisse',
      category: 'Session',
      description: 'Bilan de clôture et rapprochement des espèces',
      icon: Lock,
      action: () => openModal('shift_close'),
    },
    {
      id: 'cmd-shift-z',
      name: 'Rapport Z de caisse',
      category: 'Session',
      description: 'Générer et imprimer le rapport fiscal de clôture',
      icon: FileText,
      action: () => openModal('shift_zreport'),
    },

    // ── Audit & Finances ──
    {
      id: 'cmd-reports',
      name: 'Rapports financiers & Ventes',
      category: 'Audit',
      description: 'Statistiques de vente, marges, CA et ventilation',
      icon: BarChart3,
      action: () => openModal('reports'),
    },
    {
      id: 'cmd-security-audit',
      name: 'Journal d\'audit de sécurité',
      category: 'Audit',
      description: 'Traces inviolables, accès superviseur et modifications',
      icon: ShieldCheck,
      action: () => openModal('security_audit'),
    },
    {
      id: 'cmd-debt-ledger',
      name: 'Grand livre des dettes clients',
      category: 'Audit',
      description: 'Suivi global des créances et recouvrements en cours',
      icon: CreditCard,
      action: () => openModal('debt_ledger'),
    },

    // ── Système ──
    {
      id: 'cmd-settings',
      name: 'Paramètres système & Périphériques',
      category: 'Système',
      description: 'Configuration imprimante, tiroir-caisse, passerelle sync',
      hotkey: 'F12',
      icon: Settings,
      action: () => openModal('settings'),
    },
    {
      id: 'cmd-hotkeys',
      name: 'Guide des raccourcis clavier',
      category: 'Système',
      description: 'Afficher le répertoire complet des commandes rapides',
      hotkey: 'F8',
      icon: Keyboard,
      action: () => openModal('hotkey_guide'),
    },
    {
      id: 'cmd-db-maint',
      name: 'Maintenance base SQLite locale',
      category: 'Système',
      description: 'Contrôle d\'intégrité WAL, vacuum et instantanés',
      icon: Database,
      action: () => openModal('db_maintenance'),
    },
    {
      id: 'cmd-toggle-theme',
      name: themeMode === 'dark' ? 'Basculer en Thème Clair' : 'Basculer en Thème Sombre',
      category: 'Système',
      description: 'Alterner entre le mode clair et sombre de l\'interface',
      icon: themeMode === 'dark' ? Sun : Moon,
      action: () => toggleTheme(),
    },
    {
      id: 'cmd-lock',
      name: 'Verrouiller la session caissier',
      category: 'Système',
      description: 'Protéger l\'écran immédiatement par code PIN',
      hotkey: 'Ctrl+L',
      icon: Lock,
      action: () => lockScreen(),
    },
  ], [cart, lastTransaction, themeMode, openModal, holdSale, reprintReceipt, toggleTheme, lockScreen]);

  const filteredCommands = useMemo(() => {
    if (!query.trim()) return commands;
    const q = query.toLowerCase().trim();
    return commands.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q) ||
        (c.hotkey && c.hotkey.toLowerCase().includes(q))
    );
  }, [commands, query]);

  // Focus input on mount
  useEffect(() => {
    if (isOpen) {
      const id = setTimeout(() => inputRef.current?.focus(), 20);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [isOpen]);

  // Scroll active item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const activeEl = list.children[selectedIndex] as HTMLElement;
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, filteredCommands.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % Math.max(1, filteredCommands.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = filteredCommands[selectedIndex];
      if (selected) {
        onClose();
        selected.action();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Palette de commandes rapides"
      className="fixed inset-0 z-[var(--z-command-palette,70)] flex items-start justify-center pt-[15vh] px-4 bg-black/50 backdrop-blur-xs animate-in fade-in duration-150 select-none"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-surface-overlay border border-line-subtle rounded-ui-lg shadow-2xl overflow-hidden flex flex-col max-h-[60vh] animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search Input Bar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-line-subtle bg-surface-panel/50">
          <Search className="w-4 h-4 text-fg-muted shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher une commande, module ou action... (ex: F2, Stock, Clôture)"
            className="flex-1 bg-transparent text-ui-md text-fg placeholder:text-fg-muted outline-none font-medium"
            autoComplete="off"
            spellCheck={false}
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="p-1 rounded-ui-xs text-fg-muted hover:text-fg hover:bg-surface-card transition cursor-pointer"
              aria-label="Effacer la recherche"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : (
            <Kbd size="sm">Esc</Kbd>
          )}
        </div>

        {/* Results List */}
        <div ref={listRef} className="flex-1 overflow-y-auto overscroll-contain p-1.5 space-y-0.5">
          {filteredCommands.length === 0 ? (
            <div className="p-8 text-center text-fg-muted text-ui-sm">
              Aucune commande trouvée pour &ldquo;{query}&rdquo;
            </div>
          ) : (
            filteredCommands.map((cmd, idx) => {
              const isSelected = idx === selectedIndex;
              const Icon = cmd.icon;
              return (
                <div
                  key={cmd.id}
                  onClick={() => {
                    onClose();
                    cmd.action();
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`flex items-center justify-between px-3 py-2 rounded-ui-sm cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-pos-accent/10 text-fg border-s-2 border-pos-accent'
                      : 'text-fg-secondary hover:bg-surface-card hover:text-fg'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Icon className={`w-4 h-4 shrink-0 ${isSelected ? 'text-pos-accent' : 'text-fg-muted'}`} />
                    <div className="min-w-0 truncate">
                      <div className="text-ui-sm font-medium truncate flex items-center gap-2">
                        <span>{cmd.name}</span>
                        <span className="text-ui-2xs text-fg-muted font-normal uppercase tracking-wider px-1 py-0.2 rounded-ui-xs bg-surface-canvas border border-line-subtle">
                          {cmd.category}
                        </span>
                      </div>
                      <div className="text-ui-2xs text-fg-muted truncate">{cmd.description}</div>
                    </div>
                  </div>
                  {cmd.hotkey && (
                    <div className="shrink-0 ms-2">
                      <Kbd size="sm" variant={isSelected ? 'accent' : 'subtle'}>
                        {cmd.hotkey}
                      </Kbd>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer Hint */}
        <div className="px-4 py-2 bg-surface-panel border-t border-line-subtle flex items-center justify-between text-ui-2xs text-fg-muted">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <Kbd size="sm">↑</Kbd>
              <Kbd size="sm">↓</Kbd>
              <span>Naviguer</span>
            </span>
            <span className="flex items-center gap-1">
              <Kbd size="sm">↵</Kbd>
              <span>Exécuter</span>
            </span>
          </div>
          <span className="font-mono num">{filteredCommands.length} commandes</span>
        </div>
      </div>
    </div>
  );
};


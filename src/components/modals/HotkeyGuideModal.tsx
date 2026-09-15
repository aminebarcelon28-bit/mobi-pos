import React, { useState, useMemo, useRef, useEffect } from 'react';
import { usePosStore } from '../../store/usePosStore';
import {
  X,
  Keyboard,
  Search,
  Zap,
  Barcode,
  CreditCard,
  Sliders,
  Compass,
  Sparkles,
} from 'lucide-react';

interface HotkeyItem {
  key: string;
  name: string;
  description: string;
  category: 'checkout' | 'scanner' | 'payment' | 'management' | 'navigation';
  context: string;
  badge?: string;
  isNew?: boolean;
}

const ALL_HOTKEYS: HotkeyItem[] = [
  // ─── 1. Caisse & Vente au Comptoir ───
  {
    key: 'F1 ou /',
    name: 'Recherche Rapide Catalogue',
    description: 'Focalise immédiatement la barre de recherche ou active la détection de scan douchette USB.',
    category: 'checkout',
    context: 'Écran principal caisse',
    badge: 'Fréquent',
  },
  {
    key: 'F2 ou Espace',
    name: 'Encaisser Immédiatement (Espèces)',
    description: 'Ouvre le modal d\'encaissement rapide avec focus automatique sur le montant reçu et rendu de monnaie instantané.',
    category: 'checkout',
    context: 'Panier non vide',
    badge: 'Express',
  },
  {
    key: 'F3',
    name: 'Assigner un Client (CRM & Dettes)',
    description: 'Ouvre le répertoire client. Tapez le nom ou tél et appuyez sur Entrée ↵ pour lier le client au panier en 1 seconde.',
    category: 'checkout',
    context: 'À tout moment',
    badge: 'Nouveau F3',
    isNew: true,
  },
  {
    key: 'F4',
    name: 'Remise Globale sur Panier',
    description: 'Applique une réduction commerciale sur l\'ensemble de la commande en pourcentage (%) ou en montant fixe (DA).',
    category: 'checkout',
    context: 'Panier actif',
    badge: 'Commercial',
  },
  {
    key: 'F6',
    name: 'Mettre en Attente / Rappeler Ticket',
    description: 'Suspend le panier actuel pour encaisser un autre client pressé, ou rappelle un ticket mis en attente.',
    category: 'checkout',
    context: 'Gestion multi-clients',
    badge: 'Multi-caisse',
  },
  {
    key: 'F7',
    name: 'Réimprimer Dernier Ticket',
    description: 'Renvoie instantanément le ticket de la dernière vente à l\'imprimante thermique ticket de caisse (ESC/POS).',
    category: 'checkout',
    context: 'Après encaissement',
    badge: 'Imprimante',
  },
  {
    key: 'Ctrl + Suppr',
    name: 'Vider / Réinitialiser le Panier',
    description: 'Efface tous les articles du panier en cours pour repartir sur une vente vierge sans altérer les stocks.',
    category: 'checkout',
    context: 'Panier actif',
    badge: 'Sécurisé',
  },

  // ─── 2. Scanner Douchette & Saisie Rapide ───
  {
    key: '5*CODE',
    name: 'Multiplicateur de Quantité au Scan',
    description: 'Tapez la quantité suivie d\'un astérisque avant de scanner un article (ex: 3*613123456789 ajoute 3 unités d\'un coup).',
    category: 'scanner',
    context: 'Douchette USB / HID',
    badge: 'Productivité',
    isNew: true,
  },
  {
    key: 'Scan Carte PVC',
    name: 'Identification Carte Client & QR Pass',
    description: 'Scannez directement le code-barres ou QR code sur la carte de fidélité PVC ou le smartphone du client pour l\'assigner.',
    category: 'scanner',
    context: 'Scanner USB',
    badge: 'Fidélité',
    isNew: true,
  },
  {
    key: '1 à 9',
    name: 'Touches Rapides Services 1-Clic',
    description: 'Tuiles d\'action directe pour insérer les best-sellers et forfaits de service sans code-barre (pose film, flash, etc.).',
    category: 'scanner',
    context: 'Catalogue tactile / souris',
    badge: '1-Clic',
  },
  {
    key: 'Double-Clic Qté',
    name: 'Édition Numérique Directe',
    description: 'Double-cliquez sur le nombre d\'unités dans la ligne du panier pour taper directement la quantité désirée.',
    category: 'scanner',
    context: 'Panier actif',
    badge: 'Ergonomie',
  },

  // ─── 3. Règlement & Modal de Paiement ───
  {
    key: 'Entrée ↵',
    name: 'Valider et Clôturer la Vente',
    description: 'Confirme le paiement en espèces, valide l\'enregistrement de la transaction et imprime le reçu automatiquement.',
    category: 'payment',
    context: 'Modal Paiement F2',
    badge: 'Validation',
  },
  {
    key: '500 à 5000 DA',
    name: 'Coupures Rapides Espèces',
    description: 'Boutons pré-calculés des billets algériens pour calculer le rendu de monnaie immédiat sans taper le montant.',
    category: 'payment',
    context: 'Modal Paiement F2',
    badge: 'Coupures',
  },
  {
    key: 'Paiement Partiel',
    name: 'Espèces + Report sur Dette Kredy',
    description: 'Permet d\'encaisser un acompte en espèces et d\'ajouter automatiquement le reste à payer sur le compte crédit du client.',
    category: 'payment',
    context: 'Client identifié',
    badge: 'Carnet Kredy',
  },

  // ─── 4. Back-Office, Stock & Clôtures ───
  {
    key: 'F8',
    name: 'Guide Interactif des Raccourcis',
    description: 'Affiche ou masque ce panneau récapitulatif avec moteur de recherche en temps réel et conseils d\'ergonomie.',
    category: 'management',
    context: 'Partout dans l\'application',
    badge: 'Aide F8',
  },
  {
    key: 'F9',
    name: 'Rapports Financiers & Clôtures (X / Z)',
    description: 'Accède au chiffre d\'affaires journalier, marge brute, journal d\'audit et génération des rapports de clôture de caisse.',
    category: 'management',
    context: 'Supervision / Caisse',
    badge: 'Comptabilité',
  },
  {
    key: 'F10',
    name: 'Gestionnaire de Stock & Inventaire',
    description: 'Consultation rapide des disponibilités, alertes de réapprovisionnement, entrées d\'articles et ajustements.',
    category: 'management',
    context: 'Gestion de stock',
    badge: 'Inventaire',
  },
  {
    key: 'F11',
    name: 'Retours Marchandise & Remboursements',
    description: 'Gestion des retours d\'articles, réintégration automatique en inventaire et émission d\'un avoir ou remboursement espèces.',
    category: 'management',
    context: 'SAV & Avoirs',
    badge: 'Avoirs',
  },
  {
    key: 'F12',
    name: 'Paramètres & Configuration Périphériques',
    description: 'Réglages imprimante thermique, tiroir-caisse, synchronisation cloud Turso, mode sombre et diagnostic.',
    category: 'management',
    context: 'Paramètres système',
    badge: 'Configuration',
  },

  // ─── 5. Navigation Universelle & Dialogues ───
  {
    key: 'Échap (Esc)',
    name: 'Fermer la Boîte Active / Annuler',
    description: 'Ferme instantanément n\'importe quelle boîte modale ouverte ou quitte le champ de saisie actif.',
    category: 'navigation',
    context: 'Toutes fenêtres',
    badge: 'Universel',
  },
  {
    key: 'Flèches ↑ / ↓',
    name: 'Navigation dans les Listes & Tableaux',
    description: 'Parcourez les produits, les lignes de commande et les historiques d\'achats facilement au clavier.',
    category: 'navigation',
    context: 'Listes et tableaux',
    badge: 'Navigation',
  },
];

type CategoryFilter = 'all' | 'checkout' | 'scanner' | 'payment' | 'management' | 'navigation';

export const HotkeyGuideModal: React.FC = () => {
  const { activeModal, closeModal } = usePosStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<CategoryFilter>('all');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (activeModal === 'hotkey_guide') {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [activeModal]);

  const filteredHotkeys = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return ALL_HOTKEYS.filter((item) => {
      const matchesCategory = selectedCategory === 'all' || item.category === selectedCategory;
      if (!matchesCategory) return false;

      if (!q) return true;
      return (
        item.key.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.context.toLowerCase().includes(q) ||
        (item.badge && item.badge.toLowerCase().includes(q))
      );
    });
  }, [searchQuery, selectedCategory]);

  if (activeModal !== 'hotkey_guide') return null;

  const categories: { id: CategoryFilter; label: string; icon: React.ReactNode; count: number }[] = [
    {
      id: 'all',
      label: 'Tous les Raccourcis',
      icon: <Sparkles className="w-3.5 h-3.5 text-amber-400" />,
      count: ALL_HOTKEYS.length,
    },
    {
      id: 'checkout',
      label: 'Caisse & Vente',
      icon: <Zap className="w-3.5 h-3.5 text-emerald-400" />,
      count: ALL_HOTKEYS.filter((h) => h.category === 'checkout').length,
    },
    {
      id: 'scanner',
      label: 'Scanner & Douchette',
      icon: <Barcode className="w-3.5 h-3.5 text-blue-400" />,
      count: ALL_HOTKEYS.filter((h) => h.category === 'scanner').length,
    },
    {
      id: 'payment',
      label: 'Paiement & Monnaie',
      icon: <CreditCard className="w-3.5 h-3.5 text-purple-400" />,
      count: ALL_HOTKEYS.filter((h) => h.category === 'payment').length,
    },
    {
      id: 'management',
      label: 'Stock, Rapports & Outils',
      icon: <Sliders className="w-3.5 h-3.5 text-cyan-400" />,
      count: ALL_HOTKEYS.filter((h) => h.category === 'management').length,
    },
    {
      id: 'navigation',
      label: 'Navigation & Échap',
      icon: <Compass className="w-3.5 h-3.5 text-rose-400" />,
      count: ALL_HOTKEYS.filter((h) => h.category === 'navigation').length,
    },
  ];

  return (
    <div
      onClick={closeModal}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 select-none cursor-pointer animate-in fade-in duration-150"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-4xl bg-pos-panel border border-pos-border rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] cursor-default animate-in zoom-in-95 duration-150"
      >
        {/* ═══ Header ═══ */}
        <div className="p-4 border-b border-pos-border bg-pos-card flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-md">
              <Keyboard className="w-6 h-6 stroke-[2.2]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-extrabold text-pos-text tracking-wide uppercase">
                  Guide Complet des Raccourcis Clavier
                </h2>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-[10px] font-black uppercase">
                  F8 Actif
                </span>
              </div>
              <p className="text-[11px] text-pos-muted">
                Opérez 100% de la caisse au clavier sans souris • Ventes express en moins de 5 secondes
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Search Box */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filtrer (ex: F3, client, remise, scan)..."
                className="bg-pos-bg border border-pos-border rounded-xl pl-8 pr-3 py-1.5 text-xs text-pos-text focus:outline-none focus:border-emerald-400 w-64 transition"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text text-xs"
                >
                  ✕
                </button>
              )}
            </div>

            <button
              onClick={closeModal}
              className="p-1.5 rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition-colors"
              title="Fermer le guide (Échap)"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* ═══ Category Tabs Strip ═══ */}
        <div className="flex items-center gap-1 px-4 py-2 bg-pos-card/50 border-b border-pos-border overflow-x-auto shrink-0 no-scrollbar">
          {categories.map((cat) => {
            const isActive = selectedCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition whitespace-nowrap cursor-pointer ${
                  isActive
                    ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
                    : 'text-pos-muted hover:text-pos-text hover:bg-pos-hover border border-transparent hover:border-pos-border'
                }`}
              >
                {cat.icon}
                <span>{cat.label}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-bold ${
                    isActive ? 'bg-slate-950/30 text-current' : 'bg-pos-bg text-pos-muted'
                  }`}
                >
                  {cat.count}
                </span>
              </button>
            );
          })}
        </div>

        {/* ═══ Hotkeys Grid ═══ */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {filteredHotkeys.length === 0 ? (
            <div className="text-center py-12 text-pos-muted space-y-2">
              <Keyboard className="w-8 h-8 mx-auto opacity-40 text-emerald-400" />
              <p className="text-sm font-bold text-pos-text">Aucun raccourci correspondant</p>
              <p className="text-xs">Essayez un autre mot-clé ou réinitialisez le filtre de recherche.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {filteredHotkeys.map((hotkey) => (
                <div
                  key={hotkey.key + hotkey.name}
                  className="bg-pos-card hover:bg-pos-hover/70 border border-pos-border hover:border-emerald-500/40 rounded-xl p-3 flex items-start gap-3 transition-all group"
                >
                  {/* Physical Key Button Simulation */}
                  <div className="shrink-0 pt-0.5">
                    <kbd className="inline-flex items-center justify-center min-w-[70px] px-2.5 py-1.5 text-xs font-black font-mono text-emerald-400 bg-pos-bg border border-pos-border rounded-lg shadow-sm group-hover:border-emerald-500/50 group-hover:shadow-emerald-500/10 transition-all text-center">
                      {hotkey.key}
                    </kbd>
                  </div>

                  {/* Information Details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1 mb-0.5">
                      <h4 className="text-xs font-extrabold text-pos-text truncate flex items-center gap-1.5">
                        {hotkey.name}
                        {hotkey.isNew && (
                          <span className="px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[9px] font-black uppercase">
                            Nouveau
                          </span>
                        )}
                      </h4>
                      {hotkey.badge && (
                        <span className="shrink-0 text-[9px] font-bold text-pos-muted px-1.5 py-0.5 rounded bg-pos-bg border border-pos-border">
                          {hotkey.badge}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-pos-muted leading-relaxed line-clamp-2">
                      {hotkey.description}
                    </p>
                    <span className="text-[9px] text-emerald-400/80 font-semibold block mt-1">
                      Contexte : {hotkey.context}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ═══ Pro-Cashier Tip Banner & Footer ═══ */}
        <div className="p-3 bg-pos-card border-t border-pos-border flex items-center justify-between text-xs shrink-0">
          <div className="flex items-center gap-2 text-pos-muted">
            <span className="text-amber-400 text-sm">💡</span>
            <span className="text-[11px]">
              <strong className="text-pos-text font-bold">Astuce Pro Caissier :</strong> Tapez{' '}
              <code className="text-amber-300 font-mono font-bold bg-pos-bg px-1 py-0.5 rounded border border-pos-border">
                5*CODE
              </code>{' '}
              pour scanner 5 pièces, appuyez sur{' '}
              <code className="text-emerald-300 font-mono font-bold bg-pos-bg px-1 py-0.5 rounded border border-pos-border">
                F3
              </code>{' '}
              pour assigner le client et{' '}
              <code className="text-emerald-300 font-mono font-bold bg-pos-bg px-1 py-0.5 rounded border border-pos-border">
                F2
              </code>{' '}
              pour encaisser en espèces.
            </span>
          </div>

          <button
            onClick={closeModal}
            className="px-3.5 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-xl text-xs font-bold transition shadow-sm cursor-pointer shrink-0 ml-4"
          >
            Compris (Échap)
          </button>
        </div>
      </div>
    </div>
  );
};

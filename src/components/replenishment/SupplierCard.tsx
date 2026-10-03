import React, { useState } from 'react';
import { Phone, MessageCircle, Mail, AlertTriangle, PackageCheck, Plus, ChevronRight, ChevronDown, Edit3, Loader2, MoreHorizontal, ClipboardList, Minus, CheckSquare, Square } from 'lucide-react';
import type { SupplierItem, SupplierActionState, ActiveOrderStatus, ContactDetails, ReplenishmentLineItem } from './types';
import { formatDZD } from '../../types/pos';
import { stripAccents, stripAccentsWithMap } from './searchText';

interface SupplierCardProps {
  supplier: SupplierItem;
  isOrderView?: boolean;
  onCreatePO: () => void;
  onViewOrder?: (orderReference: string) => void;
  onContactAction: (action: 'call' | 'whatsapp' | 'email') => void;
  /** Native contact commit — writes straight to the vendor directory. */
  onSaveContact: (contact: ContactDetails) => void;
  actionState?: SupplierActionState;
  /** Live alert-derived line items (Stage 2). */
  items?: ReplenishmentLineItem[];
  selectedItems?: Record<string, boolean>;
  customQty?: Record<string, number>;
  onToggleItem?: (productId: string) => void;
  onQtyChange?: (productId: string, qty: number) => void;
  onToggleSelectAll?: (productIds: string[], selected: boolean) => void;
  /** Active search needle — highlights matching line-item title/SKU. */
  searchQuery?: string;
}

const ORDER_STATUS_LABELS: Record<ActiveOrderStatus, string> = {
  EN_COURS: 'En cours',
  PARTIELLE: 'Livraison partielle',
  EXPEDIEE: 'Expédiée',
};

const ORDER_STATUS_STYLES: Record<ActiveOrderStatus, string> = {
  EN_COURS: 'bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300',
  PARTIELLE: 'bg-cyan-50 dark:bg-cyan-950/40 border border-cyan-200 dark:border-cyan-800 text-cyan-700 dark:text-cyan-300',
  EXPEDIEE: 'bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300',
};

const SEVERITY_STYLES: Record<string, string> = {
  rupture: 'bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300',
  critical: 'bg-orange-50 dark:bg-orange-950/40 border border-orange-200 dark:border-orange-800 text-orange-700 dark:text-orange-300',
  warning: 'bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300',
};

const SEVERITY_LABELS: Record<string, string> = {
  rupture: 'Rupture',
  critical: 'Critique',
  warning: 'Sous seuil',
};

/**
 * Accent/case-insensitive match highlighting (§2.3): "ecran" highlights
 * "Écran". Literal indexOf scanning only — no RegExp construction, so
 * metacharacter payloads (§2.1) cannot compile or hang the thread. All
 * segments render as React text children — never dangerouslySetInnerHTML
 * (§2.2: XSS payloads in titles/SKUs stay inert).
 */
const HighlightedText: React.FC<{ text: string; needle: string }> = ({ text, needle }) => {
  const n = stripAccents(needle);
  if (n.length < 2) return <>{text}</>;
  const { stripped, origin } = stripAccentsWithMap(text);
  const parts: React.ReactNode[] = [];
  let cursor = 0; // index into the original display text
  let hit = stripped.indexOf(n);
  while (hit !== -1) {
    const origStart = origin[hit];
    const origEnd = origin[hit + n.length - 1] + 1;
    if (origStart > cursor) parts.push(text.slice(cursor, origStart));
    parts.push(
      <mark key={hit} className="bg-emerald-200/70 dark:bg-emerald-500/30 rounded-sm px-0.5">
        {text.slice(origStart, origEnd)}
      </mark>
    );
    cursor = origEnd;
    hit = stripped.indexOf(n, hit + n.length);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
};

const ContactIconButton: React.FC<{
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  ariaLabel: string;
  title: string;
  className?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
}> = ({ icon, onClick, disabled, loading, ariaLabel, title, className = '', variant = 'secondary' }) => {
  const baseClasses = 'min-w-[44px] min-h-[44px] w-11 h-11 rounded-full flex items-center justify-center transition cursor-pointer shrink-0';

  const variantClasses = {
    primary: 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed',
    secondary: 'border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed',
    ghost: 'border border-gray-300 bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 disabled:opacity-40 disabled:cursor-not-allowed',
  };

  const isDisabled = disabled || loading;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      className={`${baseClasses} ${variantClasses[variant]} ${className}`}
      title={title}
      aria-label={ariaLabel}
      aria-disabled={isDisabled}
      aria-busy={loading}
    >
      {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <span className="w-5 h-5">{icon}</span>}
    </button>
  );
};

const ActionButton: React.FC<{
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  variant?: 'primary' | 'secondary';
  'aria-label'?: string;
}> = ({ children, onClick, disabled, loading, className = '', variant = 'primary', 'aria-label': ariaLabel }) => {
  const isDisabled = disabled || loading;

  const baseClasses = 'min-h-[44px] min-w-[44px] flex items-center justify-center gap-2 transition-colors font-medium rounded-lg';
  const variantClasses = {
    primary: 'bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2.5 text-sm font-semibold shadow-sm w-full sm:w-auto sm:flex-initial sm:shrink-0 disabled:opacity-50 disabled:cursor-not-allowed',
    secondary: 'border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-200 px-4 py-2.5 text-sm font-medium w-full sm:w-auto sm:flex-initial sm:shrink-0 disabled:opacity-50 disabled:cursor-not-allowed',
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      className={`${baseClasses} ${variantClasses[variant]} ${className}`}
      aria-label={ariaLabel}
      aria-disabled={isDisabled}
      aria-busy={loading}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <>{children}</>}
    </button>
  );
};

export const SupplierCard: React.FC<SupplierCardProps> = ({
  supplier,
  isOrderView = false,
  onCreatePO,
  onViewOrder,
  onContactAction,
  onSaveContact,
  actionState,
  items,
  selectedItems,
  customQty,
  onToggleItem,
  onQtyChange,
  onToggleSelectAll,
  searchQuery,
}) => {
  const { name, totalReferences, outOfStockCount, contact, isOfficial } = supplier;
  const hasContact = contact.phone || contact.whatsapp || contact.email;
  const isCreatingPO = actionState?.isCreatingPO ?? false;
  const isLoadingContact = actionState?.isLoadingContact ?? false;
  const latestOrder = supplier.activeOrders?.[0];
  const showOrderCTA = isOrderView && !!latestOrder;
  const [menuOpen, setMenuOpen] = useState(false);
  // Stage 2: inline line-item inspection + native contact editing.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [editingContact, setEditingContact] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState('');
  const [whatsappDraft, setWhatsappDraft] = useState('');
  const [emailDraft, setEmailDraft] = useState('');

  const lineItems = items ?? [];
  const selectedLineItems = lineItems.filter((i) => selectedItems?.[i.productId] !== false);
  const estimatedTotal = selectedLineItems.reduce((sum, i) => {
    const qty = customQty?.[i.productId] !== undefined ? customQty[i.productId] : i.suggestedQty;
    return sum + qty * i.unitCost;
  }, 0);

  const startContactEdit = () => {
    setPhoneDraft(contact.phone ?? '');
    setWhatsappDraft(contact.whatsapp ?? '');
    setEmailDraft(contact.email ?? '');
    setEditingContact(true);
  };

  const saveContact = () => {
    onSaveContact({
      phone: phoneDraft.trim() || undefined,
      whatsapp: whatsappDraft.trim() || undefined,
      email: emailDraft.trim() || undefined,
    });
    setEditingContact(false);
  };

  return (
    <article className="bg-white dark:bg-slate-950 border border-gray-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 shadow-sm hover:border-emerald-300 dark:hover:border-emerald-500/50 transition-colors isolate overflow-hidden flex flex-col gap-3">
      {/* SECTION 1: HEADER — Identity (Left) | Metadata + Meatball (Right) */}
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-3 border-b border-gray-100 dark:border-slate-800/80 flex-shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-8 h-8 rounded-lg bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true">
            <PackageCheck className="w-4 h-4" />
          </span>
          <h3 className="text-base sm:text-lg font-bold text-gray-900 dark:text-white truncate flex-1 min-w-0 pr-2" title={name}>
            {name}
          </h3>
          {isOfficial && (
            <span className="bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 text-xs font-semibold px-2.5 py-0.5 rounded-full shrink-0 whitespace-nowrap">
              Officiel
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="bg-slate-100 dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-[11px] font-semibold px-2.5 py-1 rounded-full flex items-center gap-1 shrink-0 whitespace-nowrap" aria-label={`${totalReferences} références`}>
            <PackageCheck aria-hidden="true" className="w-3 h-3" />
            {totalReferences} Références
          </span>

          {outOfStockCount > 0 ? (
            <span className="bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 text-[11px] font-bold px-2.5 py-1 rounded-full flex items-center gap-1 shrink-0 whitespace-nowrap" aria-label={`${outOfStockCount} rupture${outOfStockCount > 1 ? 's' : ''} de stock`}>
              <AlertTriangle aria-hidden="true" className="w-3 h-3" />
              {outOfStockCount} Rupture{outOfStockCount > 1 ? 's' : ''}
            </span>
          ) : (
            <span className="bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 text-[11px] font-medium px-2.5 py-1 rounded-full flex items-center gap-1 shrink-0 whitespace-nowrap" aria-label="Stock conforme">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" aria-hidden="true" />
              Stock OK
            </span>
          )}

          <div className="relative shrink-0">
            <button
              type="button"
              className="w-10 h-10 min-w-[44px] min-h-[44px] rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white flex items-center justify-center transition shrink-0 cursor-pointer"
              aria-label={`Plus d'actions pour ${name}`}
              title={`Plus d'actions pour ${name}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <MoreHorizontal className="w-5 h-5" aria-hidden="true" />
            </button>
            {menuOpen && (
              <div
                role="menu"
                aria-label={`Actions pour ${name}`}
                className="absolute right-0 top-12 z-10 w-60 rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl py-1"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="w-full text-left px-3 py-2.5 text-xs font-medium text-gray-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-800 min-h-[44px] flex items-center gap-2 cursor-pointer"
                  onClick={() => {
                    setMenuOpen(false);
                    setDetailsOpen((v) => !v);
                  }}
                >
                  <ChevronRight aria-hidden="true" className="w-4 h-4" />
                  {detailsOpen ? 'Masquer les lignes' : 'Voir détails'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="w-full text-left px-3 py-2.5 text-xs font-medium text-gray-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-800 min-h-[44px] flex items-center gap-2 cursor-pointer"
                  onClick={() => {
                    setMenuOpen(false);
                    startContactEdit();
                  }}
                >
                  <Edit3 aria-hidden="true" className="w-4 h-4" />
                  {hasContact ? 'Modifier les coordonnées' : 'Ajouter les coordonnées'}
                </button>
                {!showOrderCTA && (
                  <button
                    type="button"
                    role="menuitem"
                    className="w-full text-left px-3 py-2.5 text-xs font-medium text-gray-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-800 min-h-[44px] flex items-center gap-2 cursor-pointer"
                    onClick={() => {
                      setMenuOpen(false);
                      onCreatePO();
                    }}
                  >
                    <Plus aria-hidden="true" className="w-4 h-4" />
                    Créer PO{totalReferences > 0 ? ` (${totalReferences})` : ''}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Active Order Context Strip (Commandes tab only) */}
      {showOrderCTA && latestOrder && (
        <div
          className="flex flex-wrap items-center gap-2 p-2 rounded-lg bg-slate-50 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800"
          aria-label={`Commande active ${latestOrder.reference} chez ${name}`}
        >
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1 shrink-0 ${ORDER_STATUS_STYLES[latestOrder.status]}`}>
            <ClipboardList aria-hidden="true" className="w-3 h-3" />
            {ORDER_STATUS_LABELS[latestOrder.status]}
          </span>
          <span className="text-xs font-mono font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2 py-0.5 rounded shrink-0">
            {latestOrder.reference}
          </span>
          <span className="text-xs text-slate-500 dark:text-slate-400 shrink-0">
            Passée le {latestOrder.date}
          </span>
          <span className="text-xs font-bold text-slate-900 dark:text-white tabular-nums ml-auto shrink-0">
            {latestOrder.totalFormatted}
          </span>
        </div>
      )}

      {/* SECTION 2: CONTACTS — inline native editor (Stage 2) or live directory display */}
      {editingContact ? (
        <div className="flex flex-col gap-2 py-1 flex-shrink-0" aria-label={`Édition des coordonnées de ${name}`}>
          <div className="flex flex-col sm:flex-row gap-2">
            <label className="flex-1 min-w-0">
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 mb-0.5">Téléphone</span>
              <input
                type="tel"
                value={phoneDraft}
                onChange={(e) => setPhoneDraft(e.target.value)}
                placeholder="0550 12 34 56"
                aria-label={`Téléphone de ${name}`}
                className="w-full min-h-[44px] bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
              />
            </label>
            <label className="flex-1 min-w-0">
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 mb-0.5">WhatsApp</span>
              <input
                type="tel"
                value={whatsappDraft}
                onChange={(e) => setWhatsappDraft(e.target.value)}
                placeholder="0550 12 34 56"
                aria-label={`WhatsApp de ${name}`}
                className="w-full min-h-[44px] bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
              />
            </label>
            <label className="flex-1 min-w-0">
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 mb-0.5">E-mail</span>
              <input
                type="email"
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
                placeholder="commande@grossiste.dz"
                aria-label={`E-mail de ${name}`}
                className="w-full min-h-[44px] bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
              />
            </label>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setEditingContact(false)}
              className="min-h-[44px] px-4 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-700 dark:text-slate-200 text-sm font-medium cursor-pointer"
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={saveContact}
              aria-label={`OK — Enregistrer les coordonnées de ${name}`}
              className="min-h-[44px] px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold cursor-pointer"
            >
              OK
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 py-1 flex-shrink-0" aria-label={`Coordonnées de ${name}`}>
          {/* Mobile: Compact icon strip */}
          <div className="flex items-center gap-2 sm:hidden flex-1 min-w-0">
            <ContactIconButton
              icon={<Phone className="w-5 h-5" />}
              onClick={() => onContactAction('call')}
              disabled={!contact.phone}
              loading={isLoadingContact}
              ariaLabel={contact.phone ? `Appeler ${name} au ${contact.phone}` : `Appeler ${name} — numéro manquant`}
              title={contact.phone ? `Appeler ${contact.phone}` : 'Ajouter un numéro de téléphone'}
              variant="secondary"
            />
            <ContactIconButton
              icon={<MessageCircle className="w-5 h-5" />}
              onClick={() => onContactAction('whatsapp')}
              disabled={!contact.whatsapp && !contact.phone}
              loading={isLoadingContact}
              ariaLabel={contact.whatsapp || contact.phone ? `Commander via WhatsApp chez ${name}` : `WhatsApp ${name} — numéro manquant`}
              title={contact.whatsapp || contact.phone ? `WhatsApp ${contact.whatsapp || contact.phone}` : 'Renseignez le téléphone pour WhatsApp'}
              variant="primary"
            />
            {contact.email ? (
              <a
                href={`mailto:${contact.email}`}
                className="min-w-[44px] min-h-[44px] w-11 h-11 rounded-full flex items-center justify-center border border-cyan-200 bg-cyan-50 text-cyan-700 hover:bg-cyan-100 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-300 transition shrink-0"
                title={`Écrire à ${contact.email}`}
                aria-label={`Envoyer un e-mail à ${name} (${contact.email})`}
              >
                <Mail className="w-5 h-5" aria-hidden="true" />
              </a>
            ) : (
              <ContactIconButton
                icon={<Mail className="w-5 h-5" />}
                onClick={() => {}}
                disabled
                ariaLabel={`E-mail ${name} — adresse manquante`}
                title="Ajouter un e-mail"
                variant="ghost"
              />
            )}
            <ContactIconButton
              icon={<Edit3 className="w-4 h-4" />}
              onClick={startContactEdit}
              loading={isLoadingContact}
              ariaLabel={`Modifier les coordonnées de ${name}`}
              title={hasContact ? 'Modifier les coordonnées' : 'Ajouter les coordonnées'}
              variant="ghost"
            />
            {!hasContact && (
              <span className="text-xs text-gray-400 dark:text-slate-500 italic truncate flex-1" aria-hidden="true">Non renseignées</span>
            )}
          </div>

          {/* Desktop: Expanded labeled contacts */}
          <div className="hidden sm:flex flex-wrap items-center gap-3 text-sm text-gray-600 dark:text-slate-400 flex-1 min-w-0">
            {contact.phone && (
              <button
                type="button"
                onClick={() => onContactAction('call')}
                disabled={isLoadingContact}
                className="flex items-center gap-1.5 font-mono hover:text-emerald-600 dark:hover:text-emerald-400 transition cursor-pointer min-h-[44px] min-w-[44px] px-2 rounded-lg shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                title={`Appeler ${contact.phone}`}
                aria-label={`${contact.phone} — Appeler ${name}`}
                aria-busy={isLoadingContact}
              >
                <Phone aria-hidden="true" className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                {isLoadingContact ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="break-all">{contact.phone}</span>}
              </button>
            )}
            {(contact.whatsapp || contact.phone) && (
              <button
                type="button"
                onClick={() => onContactAction('whatsapp')}
                disabled={isLoadingContact}
                className="flex items-center gap-1.5 font-mono hover:text-emerald-600 dark:hover:text-emerald-400 transition cursor-pointer min-h-[44px] min-w-[44px] px-2 rounded-lg shrink-0 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 disabled:opacity-50 disabled:cursor-not-allowed"
                title={`WhatsApp ${contact.whatsapp || contact.phone}`}
                aria-label={`WhatsApp — Commander chez ${name}`}
                aria-busy={isLoadingContact}
              >
                <MessageCircle aria-hidden="true" className="w-4 h-4 shrink-0" />
                {isLoadingContact ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="break-all">WhatsApp</span>}
              </button>
            )}
            {contact.email && (
              <a
                href={`mailto:${contact.email}`}
                className="flex items-center gap-1.5 font-mono hover:text-cyan-600 dark:hover:text-cyan-400 transition min-h-[44px] min-w-[44px] px-2 rounded-lg shrink-0"
                title={`Écrire à ${contact.email}`}
                aria-label={`Envoyer un e-mail à ${name} (${contact.email})`}
              >
                <Mail aria-hidden="true" className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
                <span className="break-all">{contact.email}</span>
              </a>
            )}
            {!hasContact && (
              <span className="text-xs text-gray-400 dark:text-slate-500 italic shrink-0" aria-hidden="true">Coordonnées non renseignées</span>
            )}
            <button
              type="button"
              onClick={startContactEdit}
              disabled={isLoadingContact}
              className="flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 underline min-h-[44px] min-w-[44px] px-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={hasContact ? `Modifier les coordonnées de ${name}` : `Ajouter contact pour ${name}`}
              aria-busy={isLoadingContact}
            >
              <Edit3 aria-hidden="true" className="w-3.5 h-3.5" />
              {hasContact ? 'Modifier' : 'Ajouter contact'}
            </button>
          </div>
        </div>
      )}

      {/* SECTION 2b: LIVE LINE-ITEM INSPECTION PANEL (Stage 2) */}
      {detailsOpen && lineItems.length > 0 && (
        <section
          className="border-t border-gray-100 dark:border-slate-800/80 pt-3 flex flex-col gap-2 flex-shrink-0"
          aria-label={`Lignes de commande pour ${name}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 flex items-center gap-1.5">
              <ChevronDown aria-hidden="true" className="w-3.5 h-3.5" />
              Lignes de commande ({lineItems.length})
            </span>
            <div className="flex items-center gap-2 text-[11px] font-semibold">
              <button
                type="button"
                onClick={() => onToggleSelectAll?.(lineItems.map((i) => i.productId), true)}
                className="text-emerald-600 dark:text-emerald-400 hover:underline min-h-[44px] min-w-[44px] flex items-center cursor-pointer px-1"
              >
                Tout cocher
              </button>
              <span aria-hidden="true">•</span>
              <button
                type="button"
                onClick={() => onToggleSelectAll?.(lineItems.map((i) => i.productId), false)}
                className="text-gray-500 dark:text-slate-400 hover:underline min-h-[44px] min-w-[44px] flex items-center cursor-pointer px-1"
              >
                Tout décocher
              </button>
            </div>
          </div>

          <ul className="space-y-2">
            {lineItems.map((item) => {
              const isSelected = selectedItems?.[item.productId] !== false;
              const qty = customQty?.[item.productId] !== undefined ? customQty[item.productId] : item.suggestedQty;
              const shortage = Math.max(0, item.reorderPoint - item.currentStock);
              return (
                <li
                  key={item.productId}
                  className={`p-2.5 rounded-lg border transition-colors ${
                    isSelected
                      ? 'bg-gray-50 dark:bg-slate-900/60 border-gray-200 dark:border-slate-700'
                      : 'bg-white dark:bg-slate-950 border-gray-100 dark:border-slate-800/60 opacity-60'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <button
                      type="button"
                      onClick={() => onToggleItem?.(item.productId)}
                      aria-label={isSelected ? `Désélectionner ${item.title}` : `Sélectionner ${item.title}`}
                      aria-pressed={isSelected}
                      className="min-w-[44px] min-h-[44px] flex items-center justify-center -ml-1.5 -mt-1.5 text-gray-400 hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer"
                    >
                      {isSelected ? (
                        <CheckSquare aria-hidden="true" className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <Square aria-hidden="true" className="w-4 h-4" />
                      )}
                    </button>

                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 dark:text-white truncate" title={item.title}>
                        <HighlightedText text={item.title} needle={searchQuery ?? ''} />
                      </p>
                      <p className="text-[11px] font-mono text-gray-500 dark:text-slate-400">
                        SKU: <HighlightedText text={item.sku} needle={searchQuery ?? ''} />
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${SEVERITY_STYLES[item.severity]}`}>
                          {SEVERITY_LABELS[item.severity]}
                        </span>
                        <span className="text-[11px] text-gray-500 dark:text-slate-400 tabular-nums">
                          Stock: <b className="text-gray-700 dark:text-slate-200">{item.currentStock}</b>
                        </span>
                        <span className="text-[11px] text-gray-500 dark:text-slate-400 tabular-nums">
                          Seuil: <b className="text-gray-700 dark:text-slate-200">{item.reorderPoint}</b>
                        </span>
                        <span className="text-[11px] text-gray-500 dark:text-slate-400 tabular-nums">
                          Manque: <b className="text-gray-700 dark:text-slate-200">{shortage}</b>
                        </span>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <span className="text-[9px] uppercase tracking-wider text-gray-400 dark:text-slate-500 block">Coût unit.</span>
                      <span className="text-xs font-bold text-gray-900 dark:text-white tabular-nums">
                        {formatDZD(item.unitCost)}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2 mt-2 border-t border-gray-100 dark:border-slate-800/60">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-gray-500 dark:text-slate-400">Commander :</span>
                      <div className="flex items-center border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden">
                        <button
                          type="button"
                          onClick={() => onQtyChange?.(item.productId, qty - 1)}
                          aria-label="Diminuer la quantité"
                          className="w-10 h-10 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-200 cursor-pointer"
                        >
                          <Minus aria-hidden="true" className="w-3.5 h-3.5" />
                        </button>
                        <input
                          type="number"
                          min={1}
                          value={qty}
                          onChange={(e) => onQtyChange?.(item.productId, parseInt(e.target.value, 10) || 1)}
                          aria-label={`Quantité à commander pour ${item.title}`}
                          className="w-14 h-10 min-h-[44px] text-center bg-transparent font-mono font-bold text-emerald-600 dark:text-emerald-400 focus:outline-none tabular-nums"
                        />
                        <button
                          type="button"
                          onClick={() => onQtyChange?.(item.productId, qty + 1)}
                          aria-label="Augmenter la quantité"
                          className="w-10 h-10 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-200 cursor-pointer"
                        >
                          <Plus aria-hidden="true" className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-[9px] uppercase tracking-wider text-gray-400 dark:text-slate-500 block">Sous-total</span>
                      <span className="text-xs font-black text-gray-900 dark:text-white tabular-nums">
                        {isSelected ? formatDZD(qty * item.unitCost) : 'Exclu (0 DA)'}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="flex items-center justify-between pt-2 text-xs">
            <span className="text-gray-500 dark:text-slate-400">
              {selectedLineItems.length} / {lineItems.length} ligne(s) sélectionnée(s)
            </span>
            <span className="font-bold text-gray-900 dark:text-white tabular-nums">
              Total estimé : {formatDZD(estimatedTotal)}
            </span>
          </div>
        </section>
      )}

      {/* SECTION 3: ACTIONS — justify-between footer */}
      <footer className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 mt-1 border-t border-gray-100 dark:border-slate-800/80 flex-shrink-0">
        <div className="flex items-center gap-2 w-full sm:w-auto">
          {/* Mobile: Secondary actions as grid */}
          <div className="sm:hidden grid grid-cols-2 gap-2 w-full">
            <ActionButton
              onClick={() => setDetailsOpen((v) => !v)}
              variant="secondary"
              aria-label={detailsOpen ? `Masquer les lignes de ${name}` : `Voir les détails de ${name}`}
            >
              <ChevronDown aria-hidden="true" className="w-4 h-4" />
              {detailsOpen ? 'Masquer' : 'Voir'}
            </ActionButton>
            <ActionButton
              onClick={startContactEdit}
              variant="secondary"
              loading={isLoadingContact}
              aria-label={`Contact — Ajouter ou modifier les coordonnées de ${name}`}
            >
              <Plus aria-hidden="true" className="w-4 h-4" />
              Contact
            </ActionButton>
          </div>

          {/* Desktop: Secondary actions */}
          <div className="hidden sm:flex items-center gap-2">
            <ActionButton
              onClick={() => setDetailsOpen((v) => !v)}
              variant="secondary"
              aria-label={detailsOpen ? `Masquer lignes de ${name}` : `Voir détails de ${name}`}
              className="w-auto"
            >
              <ChevronDown aria-hidden="true" className={`w-4 h-4 transition-transform ${detailsOpen ? 'rotate-180' : ''}`} />
              {detailsOpen ? 'Masquer lignes' : 'Voir détails'}
            </ActionButton>
            <ActionButton
              onClick={startContactEdit}
              variant="secondary"
              loading={isLoadingContact}
              aria-label={`Ajouter contact — Modifier les coordonnées de ${name}`}
              className="w-auto"
            >
              <Plus aria-hidden="true" className="w-4 h-4" />
              Ajouter contact
            </ActionButton>
          </div>
        </div>

        {/* Primary Action — Contextualized for Orders vs PO Creation */}
        {showOrderCTA && latestOrder ? (
          <ActionButton
            onClick={() => {
              if (onViewOrder) {
                onViewOrder(latestOrder.reference);
              } else {
                setDetailsOpen((v) => !v);
              }
            }}
            variant="primary"
            aria-label={`Voir Commande ${latestOrder.reference} pour ${name}, passée le ${latestOrder.date}, total ${latestOrder.totalFormatted}`}
            className="w-full sm:w-auto sm:flex-initial sm:shrink-0"
          >
            <ClipboardList aria-hidden="true" className="w-4 h-4" />
            <span>Voir Commande</span>
            <span className="text-xs font-semibold tabular-nums opacity-90 ml-1" aria-hidden="true">
              ({latestOrder.reference})
            </span>
            <ChevronRight aria-hidden="true" className="w-4 h-4 ml-0.5" />
          </ActionButton>
        ) : (
          <ActionButton
            onClick={onCreatePO}
            variant="primary"
            loading={isCreatingPO}
            disabled={isCreatingPO}
            aria-label={`Créer PO pour ${name}, ${totalReferences} référence${totalReferences > 1 ? 's' : ''}`}
            className="w-full sm:w-auto sm:flex-initial sm:shrink-0"
          >
            <Plus aria-hidden="true" className="w-4 h-4" />
            <span>Créer PO</span>
            {totalReferences > 0 && (
              <span className="text-xs font-semibold tabular-nums opacity-90 ml-1" aria-hidden="true">
                ({totalReferences})
              </span>
            )}
            <ChevronRight aria-hidden="true" className="w-4 h-4 ml-0.5" />
          </ActionButton>
        )}
      </footer>
    </article>
  );
};

export default SupplierCard;

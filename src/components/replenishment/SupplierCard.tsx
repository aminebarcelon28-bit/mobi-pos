import React from 'react';
import { Phone, MessageCircle, Mail, AlertTriangle, PackageCheck, Plus, ChevronRight, Edit3, Loader2 } from 'lucide-react';
import type { SupplierItem, SupplierActionState } from './types';

interface SupplierCardProps {
  supplier: SupplierItem;
  onCreatePO: () => void;
  onViewDetails: () => void;
  onContactAction: (action: 'call' | 'whatsapp' | 'email') => void;
  onAddContact: () => void;
  actionState?: SupplierActionState;
}

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
    ghost: 'border border-gray-300 bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed',
  };

  const isDisabled = disabled || loading;

  if (isDisabled && variant !== 'ghost') {
    return (
      <button
        type="button"
        disabled
        className={`${baseClasses} ${variantClasses[variant]} ${className}`}
        title={title}
        aria-label={ariaLabel}
        aria-disabled="true"
        aria-busy={loading}
      >
        {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <span className="w-5 h-5">{icon}</span>}
      </button>
    );
  }

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

  const baseClasses = 'min-h-[44px] flex items-center justify-center gap-2 transition-colors font-medium rounded-lg';
  const variantClasses = {
    primary: 'bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2.5 text-sm font-semibold shadow-sm w-full sm:w-auto disabled:opacity-50 disabled:cursor-not-allowed',
    secondary: 'border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 px-4 py-2.5 text-sm font-medium w-full sm:w-auto disabled:opacity-50 disabled:cursor-not-allowed',
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
  onCreatePO,
  onViewDetails,
  onContactAction,
  onAddContact,
  actionState,
}) => {
  const { name, totalReferences, outOfStockCount, contact, isOfficial } = supplier;
  const hasContact = contact.phone || contact.whatsapp || contact.email;
  const isCreatingPO = actionState?.isCreatingPO ?? false;
  const isLoadingContact = actionState?.isLoadingContact ?? false;

  return (
    <article className="bg-white border border-gray-200 rounded-xl p-4 sm:p-5 space-y-4 shadow-sm hover:border-emerald-300 transition-colors">
      {/* Vendor Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 pb-3 border-b border-gray-100">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-2 min-w-0">
            <span className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center text-emerald-600 shrink-0" aria-hidden="true">
              <PackageCheck className="w-4 h-4" />
            </span>
            <h3 className="text-base sm:text-lg font-bold text-gray-900 line-clamp-1 flex-1 min-w-0 pr-2" title={name}>
              {name}
            </h3>
            {isOfficial && (
              <span className="bg-emerald-50 text-emerald-700 text-xs font-semibold px-2.5 py-0.5 rounded-full shrink-0">
                Officiel
              </span>
            )}
          </div>
          
          {/* Badges Row */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="bg-gray-100 text-gray-700 text-xs font-medium px-2.5 py-1 rounded-full flex items-center gap-1" aria-label={`${totalReferences} références`}>
              <PackageCheck className="w-3 h-3" aria-hidden="true" />
              {totalReferences} Références
            </span>
            {outOfStockCount > 0 ? (
              <span className="bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold px-2.5 py-1 rounded-full flex items-center gap-1" aria-label={`${outOfStockCount} rupture${outOfStockCount > 1 ? 's' : ''} de stock`}>
                <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                {outOfStockCount} Rupture{outOfStockCount > 1 ? 's' : ''}
              </span>
            ) : (
              <span className="bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-medium px-2.5 py-1 rounded-full flex items-center gap-1" aria-label="Stock conforme">
                <span className="w-3 h-3 rounded-full bg-emerald-400" aria-hidden="true" />
                Stock OK
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Contact Row - Unified */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3" aria-label={`Coordonnées de ${name}`}>
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
            onClick={onAddContact}
            loading={isLoadingContact}
            ariaLabel={`Modifier les coordonnées de ${name}`}
            title={hasContact ? 'Modifier les coordonnées' : 'Ajouter les coordonnées'}
            variant="ghost"
          />
          {!hasContact && (
            <span className="text-xs text-gray-400 italic truncate flex-1" aria-hidden="true">Non renseignées</span>
          )}
        </div>

        {/* Desktop: Expanded labeled contacts */}
        <div className="hidden sm:flex flex-wrap items-center gap-3 text-sm text-gray-600 flex-1 min-w-0">
          {contact.phone && (
            <button
              type="button"
              onClick={() => onContactAction('call')}
              disabled={isLoadingContact}
              className="flex items-center gap-1.5 font-mono hover:text-emerald-600 transition cursor-pointer min-h-[44px] px-2 rounded-lg min-w-0 disabled:opacity-50 disabled:cursor-not-allowed"
              title={`Appeler ${contact.phone}`}
              aria-label={`Appeler ${name} au ${contact.phone}`}
              aria-busy={isLoadingContact}
            >
              <Phone className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
              {isLoadingContact ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="break-all">{contact.phone}</span>}
            </button>
          )}
          {(contact.whatsapp || contact.phone) && (
            <button
              type="button"
              onClick={() => onContactAction('whatsapp')}
              disabled={isLoadingContact}
              className="flex items-center gap-1.5 font-mono hover:text-emerald-600 transition cursor-pointer min-h-[44px] px-2 rounded-lg min-w-0 bg-emerald-50 text-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title={`WhatsApp ${contact.whatsapp || contact.phone}`}
              aria-label={`Commander via WhatsApp chez ${name}`}
              aria-busy={isLoadingContact}
            >
              <MessageCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
              {isLoadingContact ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="break-all">WhatsApp</span>}
            </button>
          )}
          {contact.email && (
            <a
              href={`mailto:${contact.email}`}
              className="flex items-center gap-1.5 font-mono hover:text-cyan-600 transition min-h-[44px] px-2 rounded-lg min-w-0"
              title={`Écrire à ${contact.email}`}
              aria-label={`Envoyer un e-mail à ${name} (${contact.email})`}
            >
              <Mail className="w-4 h-4 text-cyan-600 shrink-0" aria-hidden="true" />
              <span className="break-all">{contact.email}</span>
            </a>
          )}
          {!hasContact && (
            <span className="text-xs text-gray-400 italic" aria-hidden="true">Coordonnées non renseignées</span>
          )}
          <button
            type="button"
            onClick={onAddContact}
            disabled={isLoadingContact}
            className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-emerald-600 underline min-h-[44px] px-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label={`Modifier les coordonnées de ${name}`}
            aria-busy={isLoadingContact}
          >
            <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
            {hasContact ? 'Modifier' : 'Ajouter contact'}
          </button>
        </div>
      </div>

      {/* Actions */}
      <div className="pt-2 flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-3">
        {/* Desktop: Secondary action on the right */}
        <div className="hidden sm:flex items-center gap-2">
          <ActionButton
            onClick={onViewDetails}
            variant="secondary"
            aria-label={`Voir les détails de ${name}`}
            className="w-auto"
          >
            <ChevronRight className="w-4 h-4" aria-hidden="true" />
            Voir détails
          </ActionButton>
        </div>

        {/* Primary Action - CTA */}
        <ActionButton
          onClick={onCreatePO}
          variant="primary"
          loading={isCreatingPO}
          disabled={isCreatingPO}
          aria-label={`Créer un bon de commande pour ${name}, ${totalReferences} référence${totalReferences > 1 ? 's' : ''}`}
          className="w-full sm:w-auto"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          Créer PO
          {totalReferences > 0 && (
            <span className="text-xs font-semibold tabular-nums opacity-90" aria-hidden="true">
              ({totalReferences})
            </span>
          )}
        </ActionButton>

        {/* Mobile: Secondary actions as grid */}
        <div className="sm:hidden grid grid-cols-2 gap-2 w-full">
          <ActionButton
            onClick={onViewDetails}
            variant="secondary"
            aria-label={`Voir les détails de ${name}`}
          >
            <ChevronRight className="w-4 h-4" aria-hidden="true" />
            Voir
          </ActionButton>
          <ActionButton
            onClick={onAddContact}
            variant="secondary"
            loading={isLoadingContact}
            aria-label={`Ajouter ou modifier les coordonnées de ${name}`}
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            Contact
          </ActionButton>
        </div>
      </div>
    </article>
  );
};

export default SupplierCard;
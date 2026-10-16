import React from 'react';
import { X, Search, UserPlus, ArrowRight } from 'lucide-react';
import type { Customer } from '../../../types/pos';
import { formatDZD } from '../../../types/pos';
import { getEffectiveDebtLimit } from '../../../store/slices/createCustomerSlice';
import { useRegisterMobileBackHandler } from '../../../hooks/useMobileBackNavigation';
import { useTranslation, Bdi } from '../../../i18n';

export interface CustomerPickerSheetProps {
  isOpen: boolean;
  onClose: () => void;
  customerSearch: string;
  onCustomerSearchChange: (val: string) => void;
  filteredCustomers: Customer[];
  onSelectCustomer: (customer: Customer | null) => void;
  onOpenNewCustomerModal: () => void;
}

export const CustomerPickerSheet: React.FC<CustomerPickerSheetProps> = ({
  isOpen,
  onClose,
  customerSearch,
  onCustomerSearchChange,
  filteredCustomers,
  onSelectCustomer,
  onOpenNewCustomerModal,
}) => {
  const { t } = useTranslation();

  useRegisterMobileBackHandler(isOpen, onClose, 'checkout-customer-picker');

  if (!isOpen) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkout-customer-picker-title"
        className="pos-bottom-sheet bg-pos-panel border-t sm:border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[94dvh] sm:max-h-[85dvh] animate-in slide-in-from-bottom-5"
      >
        {/* Sheet Handle */}
        <div
          className="sheet-handle w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0"
          aria-hidden="true"
        />

        <div className="p-3.5 border-b border-pos-border flex items-center justify-between gap-2">
          <h3
            id="checkout-customer-picker-title"
            className="text-xs sm:text-sm font-black text-pos-text truncate min-w-0"
          >
            {t('checkout.selectCustomerModalTitle', 'Sélectionner un Client')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-pos-muted hover:text-pos-text min-h-[48px] min-w-[48px] flex items-center justify-center shrink-0 rounded-xl hover:bg-pos-card cursor-pointer"
            aria-label={t.common.close}
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Customer Search Bar & New Customer Action */}
        <div className="p-3 border-b border-pos-border bg-pos-card/50 flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              className="w-4 h-4 absolute start-3.5 top-1/2 -translate-y-1/2 text-pos-muted pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="text"
              value={customerSearch}
              onChange={(e) => onCustomerSearchChange(e.target.value)}
              placeholder={t(
                'checkout.searchCustomerPlaceholder',
                'Rechercher par nom ou numéro...',
              )}
              className="w-full min-h-[48px] bg-pos-card border border-pos-border rounded-xl ps-10 pe-12 py-2 text-base sm:text-xs text-pos-text placeholder-pos-muted focus:border-cyan-400 focus:outline-none"
              autoFocus
            />
            {customerSearch && (
              <button
                type="button"
                onClick={() => onCustomerSearchChange('')}
                className="absolute end-1 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text min-h-[48px] min-w-[48px] flex items-center justify-center cursor-pointer active-press rounded-lg"
                aria-label={t.common.clearField}
              >
                <span aria-hidden="true">✕</span>
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onOpenNewCustomerModal}
            className="min-h-[48px] px-3.5 rounded-xl bg-cyan-500/15 border border-cyan-500/40 text-cyan-800 dark:text-cyan-300 hover:bg-cyan-500/25 font-bold text-xs flex items-center gap-1.5 shrink-0 transition active:scale-95 cursor-pointer"
            title="Créer un nouveau client (Fichier CRM)"
          >
            <UserPlus className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="hidden xs:inline">{t.checkout.newCustomerButton}</span>
          </button>
        </div>

        <div className="p-3 overflow-y-auto overscroll-contain space-y-1.5 flex-1 max-h-72 pb-[max(1rem,var(--safe-bottom))] sm:pb-3">
          <button
            type="button"
            onClick={() => {
              onSelectCustomer(null);
              onClose();
            }}
            className="w-full min-h-[48px] text-start p-3 rounded-xl bg-pos-card border border-pos-border text-xs font-bold text-pos-muted hover:text-pos-text transition cursor-pointer flex items-center justify-between"
          >
            <span>{t('checkout.walkInCustomer', 'Client Comptoir (Anonyme)')}</span>
            <ArrowRight className="w-3.5 h-3.5 text-pos-muted rtl:rotate-180" aria-hidden="true" />
          </button>

          {filteredCustomers.length === 0 ? (
            <div className="py-6 text-center text-xs text-pos-muted">
              {t('checkout.noCustomerFound', { query: customerSearch })}
            </div>
          ) : (
            filteredCustomers.map((c: Customer) => {
              const currentDebt = c.currentDebt || 0;
              const debtLimit = getEffectiveDebtLimit(c);
              const debtPct = debtLimit > 0 ? Math.min(100, Math.round((currentDebt / debtLimit) * 100)) : 0;
              const isNearLimit = debtPct >= 80 && debtPct < 100;
              const isAtLimit = debtPct >= 100;

              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onSelectCustomer(c);
                    onClose();
                  }}
                  className="w-full min-h-[52px] text-start p-3 rounded-xl bg-pos-card border border-pos-border hover:border-cyan-400 flex flex-col gap-1.5 transition cursor-pointer"
                >
                  <div className="w-full flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-xs font-black text-pos-text block truncate">{c.name}</span>
                      <span className="text-[10px] text-pos-muted font-mono">
                        {c.phone ? <Bdi mono>{c.phone}</Bdi> : t.checkout.noPhoneNumber}
                      </span>
                    </div>
                    {currentDebt > 0 ? (
                      <span
                        className={`text-[11px] font-black font-mono shrink-0 ms-2 ${
                          isAtLimit
                            ? 'text-rose-700 dark:text-rose-400'
                            : isNearLimit
                            ? 'text-amber-700 dark:text-amber-400'
                            : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        <Bdi mono>{formatDZD(currentDebt)}</Bdi>
                      </span>
                    ) : null}
                  </div>

                  {/* Credit Ceiling Progress Bar (R-POS-09) */}
                  {currentDebt > 0 && debtLimit > 0 && (
                    <div className="w-full space-y-1 pt-0.5">
                      <div className="w-full h-1.5 rounded-full bg-pos-panel overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            isAtLimit
                              ? 'bg-rose-500'
                              : isNearLimit
                              ? 'bg-amber-500'
                              : 'bg-emerald-500'
                          }`}
                          style={{ width: `${debtPct}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[9px] font-mono text-pos-muted">
                        <span>
                          Plafond : <Bdi mono>{formatDZD(debtLimit)}</Bdi>
                        </span>
                        <span>
                          <Bdi mono>{debtPct}%</Bdi>
                        </span>
                      </div>
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

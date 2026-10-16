import React from 'react';
import { CheckCircle2, MessageSquare, Printer, RotateCcw } from 'lucide-react';
import type { CartItem } from '../../../types/pos';
import { formatDZD } from '../../../types/pos';
import { DzPhoneInput } from '../../ui/DzPhoneInput';
import { useRegisterMobileBackHandler } from '../../../hooks/useMobileBackNavigation';
import { useTranslation, Bdi } from '../../../i18n';

export interface SaleCelebrationData {
  receiptNumber: string;
  netTotal: number;
  tendered: number;
  changeDue: number;
  customerName?: string;
  customerPhone?: string;
  items: CartItem[];
}

export interface SaleCelebrationSheetProps {
  saleCelebrationData: SaleCelebrationData | null;
  onClose: () => void;
  whatsAppPhoneInput: string;
  onWhatsAppPhoneChange: (phone: string) => void;
  onSendWhatsAppReceipt: () => void;
  onOpenPrintReceipt: () => void;
}

export const SaleCelebrationSheet: React.FC<SaleCelebrationSheetProps> = ({
  saleCelebrationData,
  onClose,
  whatsAppPhoneInput,
  onWhatsAppPhoneChange,
  onSendWhatsAppReceipt,
  onOpenPrintReceipt,
}) => {
  const { t } = useTranslation();

  useRegisterMobileBackHandler(
    Boolean(saleCelebrationData),
    onClose,
    'checkout-sale-celebration',
  );

  if (!saleCelebrationData) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkout-celebration-title"
        className="pos-bottom-sheet bg-pos-panel border-t sm:border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[94dvh] sm:max-h-[92dvh] shadow-2xl animate-in slide-in-from-bottom-5 pb-[max(1.25rem,var(--safe-bottom))] sm:pb-0"
      >
        {/* Sheet Handle */}
        <div
          className="sheet-handle w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0"
          aria-hidden="true"
        />

        <div className="p-5 text-center space-y-3 overflow-y-auto overscroll-contain">
          {/* Success Icon */}
          <div className="w-16 h-16 rounded-3xl bg-emerald-500/15 border-2 border-emerald-500/30 text-emerald-700 dark:text-emerald-400 flex items-center justify-center mx-auto shadow-md shadow-emerald-500/20">
            <CheckCircle2 className="w-9 h-9" aria-hidden="true" />
          </div>

          <div>
            <h3 id="checkout-celebration-title" className="text-base font-black text-pos-text">
              {t('checkout.saleCelebrationTitle', 'Vente Encaissée avec Succès !')}
            </h3>
            <p className="text-xs text-pos-muted mt-0.5">
              Ticket{' '}
              <strong className="text-pos-text font-mono">
                <Bdi mono>#{saleCelebrationData.receiptNumber}</Bdi>
              </strong>
              {saleCelebrationData.customerName ? ` • ${saleCelebrationData.customerName}` : ''}
            </p>
          </div>

          {/* Monnaie Rendue HUD */}
          {saleCelebrationData.changeDue > 0 ? (
            <div className="pos-status-ok rounded-2xl p-4 space-y-1">
              <span className="text-[11px] font-black uppercase text-emerald-800 dark:text-emerald-300 tracking-wider block">
                {t.checkout.changeDueToCustomer}
              </span>
              <span className="text-3xl font-mono font-black text-emerald-700 dark:text-emerald-400 tabular-nums block">
                <Bdi mono>+{formatDZD(saleCelebrationData.changeDue)}</Bdi>
              </span>
              <span className="text-[11px] text-emerald-800/80 dark:text-emerald-200/80">
                Reçu <Bdi mono>{formatDZD(saleCelebrationData.tendered)}</Bdi> sur{' '}
                <Bdi mono>{formatDZD(saleCelebrationData.netTotal)}</Bdi>
              </span>
            </div>
          ) : (
            <div className="bg-pos-card border border-pos-border rounded-2xl p-3 flex justify-between items-center text-xs">
              <span className="text-pos-muted font-bold">{t.checkout.totalPaid}</span>
              <span className="text-base font-mono tabular-nums font-black text-emerald-700 dark:text-emerald-400">
                <Bdi mono>{formatDZD(saleCelebrationData.netTotal)}</Bdi>
              </span>
            </div>
          )}

          {/* WhatsApp Receipt Section */}
          <div className="bg-pos-card border border-pos-border rounded-2xl p-3.5 space-y-2.5 text-start">
            <div className="flex items-center gap-2 text-xs font-bold text-pos-text">
              <MessageSquare className="w-4 h-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
              <span>{t.checkout.sendReceiptWhatsAppTitle}</span>
            </div>

            <div className="relative">
              <DzPhoneInput
                value={whatsAppPhoneInput}
                onChange={onWhatsAppPhoneChange}
                placeholder={t.checkout.whatsAppPhonePlaceholder}
                inputClassName="w-full min-h-[48px] bg-pos-panel border border-pos-border focus:border-emerald-400 rounded-xl px-3 py-2 text-base sm:text-xs font-mono text-pos-text focus:outline-none"
              />
            </div>

            <button
              type="button"
              onClick={onSendWhatsAppReceipt}
              className="w-full min-h-[48px] rounded-xl bg-emerald-600 hover:bg-emerald-500 active-press text-white font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer shadow-xs"
            >
              <MessageSquare className="w-4 h-4" aria-hidden="true" />
              <span>{t.checkout.sendViaWhatsAppButton}</span>
            </button>
          </div>

          {/* Print & Reset Buttons */}
          <div className="grid grid-cols-2 gap-2.5 pt-1">
            <button
              type="button"
              onClick={onOpenPrintReceipt}
              className="min-h-[48px] rounded-xl bg-pos-card border border-pos-border hover:border-cyan-400 text-pos-text font-bold text-xs flex items-center justify-center gap-2 active-press transition cursor-pointer"
            >
              <Printer className="w-4 h-4 text-cyan-700 dark:text-cyan-400" aria-hidden="true" />
              <span>{t.checkout.printReceiptButton}</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="min-h-[48px] rounded-xl bg-cyan-500 hover:bg-cyan-400 active-press text-slate-950 font-black text-xs flex items-center justify-center gap-2 transition cursor-pointer shadow-md shadow-cyan-500/20"
            >
              <RotateCcw className="w-4 h-4" aria-hidden="true" />
              <span>{t.checkout.newSaleButton}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

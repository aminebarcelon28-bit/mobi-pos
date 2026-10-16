import React, { useEffect, useRef } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Kbd } from './Kbd';

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Enterprise confirmation dialog replacing blocking window.confirm calls.
 * Provides clear Secondary -> Primary button order, Esc dismissal, and focus trapping.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirmer',
  cancelLabel = 'Annuler',
  variant = 'default',
  onConfirm,
  onCancel,
}) => {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => confirmButtonRef.current?.focus(), 20);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const isDanger = variant === 'danger';

  const confirmBtnClasses = isDanger
    ? 'bg-status-danger-bg border-status-danger-border text-status-danger-fg hover:bg-status-danger-bg/80'
    : 'bg-pos-accent hover:bg-pos-accent/90 text-slate-950';

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-desc"
      className="fixed inset-0 z-[var(--z-modal,50)] flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150 select-none"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md bg-surface-overlay border border-line-subtle rounded-ui-lg shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line-subtle bg-surface-panel/40">
          <div className="flex items-center gap-2">
            {isDanger && (
              <AlertTriangle className="w-4 h-4 text-status-danger-fg shrink-0" aria-hidden="true" />
            )}
            <h3 id="confirm-dialog-title" className="text-ui-md font-bold text-fg">
              {title}
            </h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Fermer la boîte de dialogue"
            className="p-1 rounded-ui-xs text-fg-muted hover:text-fg hover:bg-surface-card transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div id="confirm-dialog-desc" className="p-4 text-ui-sm text-fg-secondary leading-relaxed">
          {message}
        </div>

        {/* Footer with Secondary -> Primary button order */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 bg-surface-panel/40 border-t border-line-subtle">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-ui-sm bg-surface-card hover:bg-surface-card/80 border border-line-subtle hover:border-line text-ui-xs font-semibold text-fg transition cursor-pointer active:scale-[0.98] h-ctl-md"
          >
            <span>{cancelLabel}</span>
            <Kbd size="sm">Esc</Kbd>
          </button>

          <button
            ref={confirmButtonRef}
            type="button"
            onClick={onConfirm}
            className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded-ui-sm border text-ui-xs font-bold transition cursor-pointer active:scale-[0.98] shadow-xs h-ctl-md ${confirmBtnClasses}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};


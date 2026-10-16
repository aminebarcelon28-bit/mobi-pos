import React from 'react';
import { X, Smartphone } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { CompanionShell } from './CompanionShell';
import { useRegisterMobileBackHandler } from '../../hooks/useMobileBackNavigation';

export const MobileSimulatorModal: React.FC = () => {
  const activeModal = usePosStore((s) => s.activeModal);
  const closeModal = usePosStore((s) => s.closeModal);

  const isOpen = activeModal === 'mobile_simulator';
  useRegisterMobileBackHandler(isOpen, closeModal, 'mobile-simulator');

  if (!isOpen) return null;

  return (
    <div
      onClick={closeModal}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 select-none"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-simulator-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-pos-panel border-t sm:border border-pos-border rounded-t-[28px] sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[94dvh] sm:h-[85dvh]"
      >
        <div className="w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" aria-hidden="true" />

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-pos-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Smartphone className="w-5 h-5 text-emerald-500 shrink-0" aria-hidden="true" />
            <h2 id="mobile-simulator-title" className="text-sm sm:text-base font-semibold text-pos-text truncate">
              Simulateur Mobile (Compagnon)
            </h2>
          </div>
          <button
            type="button"
            onClick={closeModal}
            className="p-2 rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition-colors min-h-[48px] min-w-[48px] flex items-center justify-center cursor-pointer"
            aria-label="Fermer — Simulateur mobile"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Phone-frame body — CompanionShell in embedded mode */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <CompanionShell fill="parent" />
        </div>
      </div>
    </div>
  );
};

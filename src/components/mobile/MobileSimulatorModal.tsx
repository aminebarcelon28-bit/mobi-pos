import React from 'react';
import { X, Smartphone } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { CompanionShell } from './CompanionShell';

export const MobileSimulatorModal: React.FC = () => {
  const activeModal = usePosStore((s) => s.activeModal);
  const closeModal = usePosStore((s) => s.closeModal);

  if (activeModal !== 'mobile_simulator') return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm p-0 sm:p-4 select-none">
      <div className="w-full max-w-md bg-pos-panel border-t sm:border border-pos-border rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[94vh] sm:h-[85vh]">
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-pos-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Smartphone className="w-5 h-5 text-emerald-500 shrink-0" />
            <h2 className="text-sm sm:text-base font-semibold text-pos-text truncate">
              Simulateur Mobile (Compagnon)
            </h2>
          </div>
          <button
            onClick={closeModal}
            className="p-2 rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="Fermer le simulateur mobile"
          >
            <X className="w-5 h-5" />
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

import React from 'react';
import { Smartphone, X } from 'lucide-react';
import { CompanionShell } from './CompanionShell';
import { usePosStore } from '../../store/usePosStore';

export const MobileSimulatorModal: React.FC = () => {
  const { activeModal, closeModal } = usePosStore();

  if (activeModal !== 'mobile_simulator') return null;

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4 select-none animate-in fade-in">
      <div className="flex flex-col items-center max-h-[96vh]">
        {/* Simulator Control Bar */}
        <div className="w-full max-w-[390px] flex items-center justify-between pb-2 text-white">
          <div className="flex items-center gap-2">
            <Smartphone className="w-4 h-4 text-cyan-400" />
            <span className="text-xs font-black tracking-wide">
              Simulateur Mobile MobiPOS (Android / iOS)
            </span>
          </div>

          <button
            type="button"
            onClick={closeModal}
            className="p-1.5 rounded-lg bg-pos-card border border-pos-border text-pos-muted hover:text-white cursor-pointer transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Smartphone Hardware Frame */}
        <div className="w-[380px] h-[780px] bg-slate-950 rounded-[48px] p-3 shadow-2xl border-4 border-slate-700 relative overflow-hidden flex flex-col">
          {/* Top Notch / Dynamic Island */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 w-28 h-5 bg-slate-900 rounded-full z-20 flex items-center justify-center pointer-events-none">
            <div className="w-2.5 h-2.5 rounded-full bg-slate-950 border border-slate-800" />
          </div>

          {/* Internal Mobile Screen View */}
          <div className="flex-1 w-full rounded-[38px] overflow-hidden flex flex-col bg-pos-bg pt-2 relative">
            <CompanionShell />
          </div>

          {/* Bottom Home Indicator Bar */}
          <div className="w-32 h-1 bg-slate-600 rounded-full mx-auto mt-2 shrink-0" />
        </div>
      </div>
    </div>
  );
};

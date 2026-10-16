import React from 'react';
import { ChevronLeft, X } from 'lucide-react';

interface MobileSheetHeaderProps {
  title: string;
  subtitle?: string;
  onBack: () => void;
  rightAction?: React.ReactNode;
}

export const MobileSheetHeader: React.FC<MobileSheetHeaderProps> = ({
  title,
  subtitle,
  onBack,
  rightAction,
}) => {
  return (
    <div className="flex items-center justify-between p-3 border-b border-pos-border bg-pos-panel shrink-0 select-none z-10">
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={onBack}
          aria-label="Retour"
          title="Revenir en arrière"
          className="p-2 -ms-1 rounded-xl hover:bg-pos-hover text-pos-muted hover:text-pos-text transition cursor-pointer flex items-center gap-1 font-bold text-xs min-h-[48px] min-w-[48px] shrink-0 active-press"
        >
          <ChevronLeft className="w-5 h-5 text-pos-accent-cyan stroke-[2.5] rtl:rotate-180" aria-hidden="true" />
          <span>Retour</span>
        </button>

        <div className="min-w-0 text-start">
          <h3 className="text-sm font-black text-pos-text truncate leading-tight">{title}</h3>
          {subtitle && <p className="text-[10px] text-pos-muted truncate">{subtitle}</p>}
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {rightAction}
        <button
          type="button"
          onClick={onBack}
          aria-label="Fermer la fenêtre"
          title="Fermer la fenêtre"
          className="p-2 rounded-xl hover:bg-pos-hover text-pos-muted hover:text-pos-text transition cursor-pointer min-h-[48px] min-w-[48px] flex items-center justify-center active-press"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

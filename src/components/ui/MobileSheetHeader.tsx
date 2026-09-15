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
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="p-2 -ml-1 rounded-xl hover:bg-pos-hover text-pos-muted hover:text-pos-text transition cursor-pointer flex items-center gap-1 font-bold text-xs"
          title="Revenir en arrière"
        >
          <ChevronLeft className="w-5 h-5 text-cyan-400 stroke-[2.5]" />
          <span>Retour</span>
        </button>

        <div className="min-w-0">
          <h3 className="text-sm font-black text-pos-text truncate leading-tight">{title}</h3>
          {subtitle && <p className="text-[10px] text-pos-muted truncate">{subtitle}</p>}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        {rightAction}
        <button
          type="button"
          onClick={onBack}
          className="p-2 rounded-xl hover:bg-pos-hover text-pos-muted hover:text-pos-text transition cursor-pointer"
          title="Fermer la fenêtre"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

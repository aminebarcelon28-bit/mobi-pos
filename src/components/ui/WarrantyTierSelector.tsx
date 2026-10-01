import React from 'react';
import { ShieldCheck, Info } from 'lucide-react';
import {
  REPAIR_WARRANTY_START,
  WARRANTY_TIER_DAYS,
  WARRANTY_TIER_LABELS,
  WARRANTY_TIER_ORDER,
  type WarrantyTier,
} from '../../types/pos';
import WarrantyBadge from './WarrantyBadge';

export interface WarrantyTierSelectorProps {
  value: WarrantyTier | undefined;
  onChange: (tier: WarrantyTier) => void;
  /** Pre-selected suggestion from the unified resolver (highlighted, not forced). */
  suggestedTier?: WarrantyTier | null;
  /** Exact restitution date; when present the expiry is previewed inline. */
  deliveredAt?: string | null;
  /** Set when physical damage voids coverage — tiers are downgraded visually. */
  damageBlocksWarranty?: boolean;
  readOnly?: boolean;
  className?: string;
}

/**
 * The ONLY warranty control. There is deliberately no free-text duration
 * input: floating ranges ("358J", "J-X") are unrepresentable, so a printed
 * ticket can only ever carry one of the immutable workshop tiers. Coverage
 * always starts at RESTITUE, never at intake.
 */
export const WarrantyTierSelector: React.FC<WarrantyTierSelectorProps> = ({
  value,
  onChange,
  suggestedTier = null,
  deliveredAt = null,
  damageBlocksWarranty = false,
  readOnly = false,
  className = '',
}) => {
  const previewExpiry = (tier: WarrantyTier): string | null => {
    if (!deliveredAt || tier === 'none') return null;
    const days = WARRANTY_TIER_DAYS[tier] || 0;
    if (days <= 0) return null;
    const d = new Date(deliveredAt);
    if (Number.isNaN(d.getTime())) return null;
    d.setDate(d.getDate() + days);
    return d.toLocaleDateString('fr-DZ');
  };

  return (
    <div className={`space-y-2 ${className}`}>
      <div className="flex items-start gap-2 rounded-lg bg-pos-bg border border-pos-border px-3 py-2">
        <Info className="w-3.5 h-3.5 text-pos-muted shrink-0 mt-0.5" aria-hidden="true" />
        <p className="text-[10px] text-pos-muted leading-snug">
          Garantie de réparation <strong className="text-pos-text">{REPAIR_WARRANTY_START}</strong>{' '}
          (jamais à la prise en charge) — échéance calculée sur la date de restitution.
        </p>
      </div>

      <div
        role="radiogroup"
        aria-label="Niveau de garantie SAV"
        className="grid grid-cols-1 sm:grid-cols-2 gap-2"
      >
        {WARRANTY_TIER_ORDER.map((tier) => {
          const selected = value === tier;
          const suggested = suggestedTier === tier && !selected;
          const days = WARRANTY_TIER_DAYS[tier] || 0;
          const tone = !selected
            ? 'bg-pos-card border-pos-border text-pos-muted'
            : tier === 'none'
              ? 'bg-slate-500/15 border-slate-400/60 text-slate-200'
              : days <= 7
                ? 'bg-amber-500/20 border-amber-500/60 text-amber-300'
                : 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300';
          const expiry = previewExpiry(tier);
          return (
            <button
              key={tier}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={readOnly}
              onClick={() => onChange(tier)}
              className={`min-h-[44px] sm:min-h-[36px] px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-lg border text-left text-xs sm:text-sm font-medium flex items-center justify-between gap-2 transition cursor-pointer active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 ${tone}`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {WARRANTY_TIER_LABELS[tier]}
                  {suggested && (
                    <span className="ml-1.5 text-[10px] font-medium text-pos-muted">(suggéré)</span>
                  )}
                </span>
              </span>
              {expiry && (
                <span className="text-[10px] font-normal opacity-80 whitespace-nowrap tabular-nums">
                  {expiry}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {value && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase font-medium text-pos-muted tracking-tight">Sélection :</span>
          <WarrantyBadge tier={value} expiryDate={previewExpiry(value)} size="sm" />
          {damageBlocksWarranty && value !== 'none' && (
            <span className="text-[10px] font-medium text-rose-600 dark:text-rose-400">
              Dommage physique constaté — la garantie peut être refusée à la restitution.
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export default WarrantyTierSelector;
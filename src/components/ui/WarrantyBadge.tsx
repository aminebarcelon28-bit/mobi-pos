import React from 'react';
import { ShieldCheck, ShieldX, Clock } from 'lucide-react';
import type { WarrantyTier } from '../../types/pos';
import { WARRANTY_TIER_DAYS, WARRANTY_TIER_LABELS } from '../../types/pos';

export interface WarrantyBadgeProps {
  tier: WarrantyTier;
  expiryDate?: string | null;
  daysRemaining?: number | null;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  showExpiry?: boolean;
  className?: string;
}

// Each tone carries an explicit light value: the previous `-300` shades were
// tuned for the dark card only and fell to ~1.6:1 on the white light-mode
// surface, so a valid warranty read as blank. Dark keeps the brighter step.
const TONE: Record<WarrantyTier, { ring: string; bg: string; text: string; Icon: React.FC<{ className?: string }> }> = {
  none: { ring: 'border-slate-500/40', bg: 'bg-slate-500/10', text: 'text-slate-600 dark:text-slate-300', Icon: ShieldX },
  test_7d: { ring: 'border-amber-500/40', bg: 'bg-amber-500/10', text: 'text-amber-700 dark:text-amber-300', Icon: Clock },
  repair_30d: { ring: 'border-cyan-500/40', bg: 'bg-cyan-500/10', text: 'text-cyan-700 dark:text-cyan-300', Icon: ShieldCheck },
  repair_90d: { ring: 'border-emerald-500/40', bg: 'bg-emerald-500/10', text: 'text-emerald-700 dark:text-emerald-300', Icon: ShieldCheck },
  repair_180d: { ring: 'border-emerald-500/50', bg: 'bg-emerald-500/15', text: 'text-emerald-800 dark:text-emerald-300', Icon: ShieldCheck },
};

// Weight ceiling is `font-medium` (500) and the label is NOT uppercased:
// uppercase + `tracking-wider` overflowed the chip and clipped inside the
// narrow history table cells. `tabular-nums` keeps the day counter aligned.
const SIZE: Record<NonNullable<WarrantyBadgeProps['size']>, { chip: string; icon: string; text: string }> = {
  sm: { chip: 'px-1.5 py-0.5 rounded-md', icon: 'w-3 h-3', text: 'text-[10px]' },
  md: { chip: 'px-2 py-0.5 rounded-md', icon: 'w-3.5 h-3.5', text: 'text-[11px]' },
  lg: { chip: 'px-2 py-0.5 rounded-md', icon: 'w-4 h-4', text: 'text-xs' },
};

/**
 * Strict color-semantics warranty badge. Emerald = valid repair warranty,
 * amber = short test window, slate = none/expired. Never renders a floating
 * day count ("358J") — only the immutable tier label plus an optional
 * calendar expiry date.
 */
export const WarrantyBadge: React.FC<WarrantyBadgeProps> = ({
  tier,
  expiryDate,
  daysRemaining,
  size = 'md',
  showLabel = true,
  showExpiry = true,
  className = '',
}) => {
  const tone = TONE[tier] ?? TONE.none;
  const s = SIZE[size];
  const Icon = tone.Icon;
  const days = WARRANTY_TIER_DAYS[tier] ?? 0;
  const label = WARRANTY_TIER_LABELS[tier] ?? 'Sans garantie';

  const expiryText = expiryDate
    ? `Jusqu'au ${new Date(expiryDate).toLocaleDateString('fr-DZ')}`
    : days > 0
      ? `${days}j`
      : '';

  return (
    <span
      className={`inline-flex items-center gap-1.5 border ${tone.ring} ${tone.bg} ${tone.text} ${s.chip} ${className}`}
      title={label}
    >
      <Icon className={s.icon} aria-hidden="true" />
      {showLabel && <span className={`font-medium tracking-tight ${s.text}`}>{label}</span>}
      {showExpiry && expiryText && (
        <span className={`font-normal opacity-80 ${s.text}`}>{expiryText}</span>
      )}
      {daysRemaining !== null && daysRemaining !== undefined && days > 0 && (
        <span className={`font-medium tabular-nums ${s.text}`}>J-{daysRemaining}</span>
      )}
    </span>
  );
};

export default WarrantyBadge;
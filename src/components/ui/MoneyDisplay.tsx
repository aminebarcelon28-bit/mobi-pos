import React from 'react';
import { formatDZD } from '../../types/pos';

interface MoneyDisplayProps {
  amount: number;
  className?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  showPlus?: boolean;
  color?: 'emerald' | 'cyan' | 'amber' | 'rose' | 'purple' | 'default';
}

const SIZE_CLASSES = {
  xs: 'text-[11px]',
  sm: 'text-xs',
  md: 'text-sm sm:text-base',
  lg: 'text-base sm:text-lg',
  xl: 'text-lg sm:text-xl',
  '2xl': 'text-xl sm:text-2xl',
};

const COLOR_CLASSES = {
  emerald: 'text-emerald-400',
  cyan: 'text-cyan-400',
  amber: 'text-amber-400',
  rose: 'text-rose-400',
  purple: 'text-purple-400',
  default: 'text-pos-text',
};

export const MoneyDisplay: React.FC<MoneyDisplayProps> = ({
  amount,
  className = '',
  size = 'md',
  showPlus = false,
  color = 'default',
}) => {
  const formatted = formatDZD(amount);
  const displayValue = showPlus && amount > 0 ? `+${formatted}` : formatted;

  return (
    <span
      title={formatted}
      className={`inline-block max-w-full truncate whitespace-nowrap font-mono font-black tracking-tight tabular-nums ${SIZE_CLASSES[size]} ${COLOR_CLASSES[color]} ${className}`}
    >
      {displayValue}
    </span>
  );
};

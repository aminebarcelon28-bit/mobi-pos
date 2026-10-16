import React, { type HTMLAttributes } from 'react';

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'text' | 'card' | 'circle' | 'pill';
  lines?: number;
}

const VARIANT_CLASSES: Record<NonNullable<SkeletonProps['variant']>, string> = {
  text: 'h-4 w-full rounded-md',
  card: 'h-20 w-full rounded-pos-card',
  circle: 'h-10 w-10 rounded-full shrink-0',
  pill: 'h-8 w-24 rounded-full',
};

export const Skeleton: React.FC<SkeletonProps> = ({
  variant = 'text',
  lines = 1,
  className = '',
  ...rest
}) => {
  if (lines > 1) {
    return (
      <div className="space-y-2.5 w-full" aria-hidden="true">
        {Array.from({ length: lines }).map((_, idx) => (
          <div
            key={idx}
            className={`bg-surface-highest/80 animate-pulse ${VARIANT_CLASSES[variant]} ${
              idx === lines - 1 ? 'w-3/4' : 'w-full'
            } ${className}`}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      aria-hidden="true"
      className={`bg-surface-highest/80 animate-pulse ${VARIANT_CLASSES[variant]} ${className}`}
      {...rest}
    />
  );
};

export default Skeleton;

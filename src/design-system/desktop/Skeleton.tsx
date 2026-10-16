import React from 'react';

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'text' | 'rectangular' | 'circular';
  width?: string | number;
  height?: string | number;
}

/**
 * High-craft shimmer skeleton replacement for full-screen loading spinners.
 * Adheres to desktop design token contract elevations.
 */
export const Skeleton: React.FC<SkeletonProps> = ({
  variant = 'rectangular',
  width,
  height,
  className = '',
  style,
  ...props
}) => {
  const variantClass =
    variant === 'circular'
      ? 'rounded-full'
      : variant === 'text'
      ? 'rounded-ui-xs h-3 w-full'
      : 'rounded-ui-md';

  return (
    <div
      aria-hidden="true"
      style={{
        width,
        height,
        ...style,
      }}
      className={`animate-pulse bg-pos-hover/60 border border-line-subtle/40 ${variantClass} ${className}`}
      {...props}
    />
  );
};


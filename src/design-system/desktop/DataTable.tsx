import React from 'react';

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  align?: 'left' | 'center' | 'right';
  width?: string;
  className?: string;
  render: (item: T, index: number) => React.ReactNode;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (item: T, index: number) => string;
  density?: 'compact' | 'normal';
  emptyMessage?: React.ReactNode;
  onRowClick?: (item: T) => void;
  selectedId?: string;
  className?: string;
}

/**
 * Enterprise data grid adhering to Linear/Stripe desktop density guidelines.
 * Features sticky blurred headers, strict tabular numeral alignment, and subtle row hovers.
 */
export function DataTable<T>({
  columns,
  data,
  keyExtractor,
  density = 'normal',
  emptyMessage = 'Aucune donnée disponible',
  onRowClick,
  selectedId,
  className = '',
}: DataTableProps<T>) {
  const pyClass = density === 'compact' ? 'py-1.5' : 'py-2.5';
  const pxClass = 'px-3';

  return (
    <div className={`w-full overflow-x-auto rounded-ui-md border border-line-subtle bg-surface-card shadow-xs ${className}`}>
      <table className="w-full text-start border-collapse select-none">
        <thead>
          <tr className="sticky top-0 z-10 bg-surface-panel/95 backdrop-blur-xs border-b border-line text-ui-2xs font-bold text-fg-muted uppercase tracking-wider">
            {columns.map((col) => {
              const alignClass =
                col.align === 'right'
                  ? 'text-end'
                  : col.align === 'center'
                  ? 'text-center'
                  : 'text-start';
              return (
                <th
                  key={col.key}
                  style={{ width: col.width }}
                  className={`${pxClass} py-2 ${alignClass} font-semibold ${col.className || ''}`}
                >
                  {col.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-subtle/40 text-ui-xs text-fg">
          {data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="py-8 text-center text-fg-muted">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((item, idx) => {
              const key = keyExtractor(item, idx);
              const isSelected = selectedId === key;
              return (
                <tr
                  key={key}
                  onClick={() => onRowClick?.(item)}
                  className={`transition-colors ${
                    onRowClick ? 'cursor-pointer' : ''
                  } ${
                    isSelected
                      ? 'bg-pos-accent/10 text-fg'
                      : 'hover:bg-pos-hover/60'
                  }`}
                >
                  {columns.map((col) => {
                    const alignClass =
                      col.align === 'right'
                        ? 'text-end font-mono num'
                        : col.align === 'center'
                        ? 'text-center'
                        : 'text-start';
                    return (
                      <td
                        key={col.key}
                        className={`${pxClass} ${pyClass} ${alignClass} ${col.className || ''}`}
                      >
                        {col.render(item, idx)}
                      </td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}


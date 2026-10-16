import React, { type InputHTMLAttributes, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { IconButton } from './IconButton';

export interface SearchFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: string;
  onChange: (nextValue: string) => void;
  onClear?: () => void;
  /** Accessible label for the search input (default: "Rechercher"). */
  ariaLabel?: string;
  /** Accessible label for the 48x48px clear button (default: "Effacer la recherche"). */
  clearAriaLabel?: string;
  /** Optional trailing action button (e.g., 48x48px barcode camera `IconButton`). */
  trailingAction?: ReactNode;
  /**
   * Guardrail G-09: Only attach `data-barcode-scan-target="true"` when explicitly
   * opted in on sanctioned barcode search inputs.
   */
  isBarcodeScanTarget?: boolean;
  containerClassName?: string;
}

export const SearchField = React.forwardRef<HTMLInputElement, SearchFieldProps>(
  (
    {
      value,
      onChange,
      onClear,
      ariaLabel = 'Rechercher',
      clearAriaLabel = 'Effacer la recherche',
      trailingAction,
      isBarcodeScanTarget = false,
      containerClassName = '',
      className = '',
      placeholder = 'Rechercher…',
      ...rest
    },
    ref,
  ) => {
    const handleClear = () => {
      if (onClear) {
        onClear();
      } else {
        onChange('');
      }
    };

    return (
      <div
        className={`relative flex items-center w-full min-h-[48px] rounded-2xl border border-pos-border bg-pos-input-bg focus-within:border-pos-focus focus-within:ring-2 focus-within:ring-pos-focus/20 transition ${containerClassName}`}
      >
        <span
          aria-hidden="true"
          className="ps-3.5 pe-2 text-pos-muted pointer-events-none shrink-0 inline-flex items-center"
        >
          <Search className="w-4 h-4" />
        </span>

        <input
          ref={ref}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={ariaLabel}
          placeholder={placeholder}
          data-barcode-scan-target={isBarcodeScanTarget ? 'true' : undefined}
          className={`flex-1 min-w-0 bg-transparent py-2.5 pe-2 text-base sm:text-sm font-medium text-pos-text placeholder:text-pos-muted focus:outline-none ${className}`}
          {...rest}
        />

        {value.length > 0 ? (
          <IconButton
            ariaLabel={clearAriaLabel}
            onClick={handleClear}
            icon={<X className="w-4 h-4" />}
            className="rounded-xl"
          />
        ) : null}

        {trailingAction ? (
          <div className="shrink-0 flex items-center pe-1">{trailingAction}</div>
        ) : null}
      </div>
    );
  },
);

SearchField.displayName = 'SearchField';
export default SearchField;

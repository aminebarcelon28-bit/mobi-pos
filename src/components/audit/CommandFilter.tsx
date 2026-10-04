import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ListFilter, Search, X } from 'lucide-react';

export interface CommandOption {
  value: string;
  label: string;
  count?: number;
  /** Extra tokens that match the query but are not displayed. */
  keywords?: string[];
  /** Rendered as a coloured dot before the label (severity, category). */
  dot?: string;
}

interface CommandFilterProps {
  options: CommandOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  icon?: React.ReactNode;
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Keyboard-first multi-select popover.
 *
 * Replaces the checkbox list the audit toolbar used previously: the register
 * is routinely scanned for « everything this cashier did today » and a
 * type-to-narrow list reaches that in two keystrokes where a checkbox list
 * needs a scroll. Arrow keys move, Enter/Space toggles, Escape closes and
 * returns focus to the trigger.
 *
 * Hand-rolled for the same reason as the rest of `components/ui`: the app has
 * no Radix/cmdk dependency and matches its own `pos-*` token language.
 */
export const CommandFilter: React.FC<CommandFilterProps> = ({
  options,
  selected,
  onChange,
  placeholder = 'Filtrer...',
  icon,
  emptyLabel = 'Aucun résultat',
  disabled = false,
  className = '',
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Portal dropdown anchoring — the filter often lives inside overflow-hidden
  // toolbar ancestors, so an absolutely-positioned child would be clipped.
  // The dropdown is portaled to document.body with position:fixed.
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 0, openUp: false });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((opt) => {
      const haystack = `${opt.label} ${(opt.keywords || []).join(' ')}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [options, query]);

  // Clamp during render rather than in an effect: narrowing the query can
  // shrink the list under the cursor, and a stale index would highlight
  // nothing (or crash) until the next keystroke.
  const activeCursor = filtered.length === 0 ? 0 : Math.min(cursor, filtered.length - 1);

  const close = useCallback(
    (restoreFocus = true) => {
      setOpen(false);
      if (restoreFocus) triggerRef.current?.focus();
    },
    [],
  );

  // Portaled dropdown: compute fixed position from the trigger anchor with
  // auto flip (open upward when near the bottom viewport edge), clamp to the
  // viewport, and dismiss on outside click / Escape / scroll / resize.
  useEffect(() => {
    if (!open) return;
    const MENU_H_EST = 320;
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < MENU_H_EST + 16;
      const top = openUp
        ? Math.max(8, r.top - MENU_H_EST - 8)
        : Math.min(r.bottom + 4, window.innerHeight - 16);
      const width = Math.max(0, Math.min(r.width, window.innerWidth - 16));
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      setMenuPos({ top, left, width, openUp });
    };
    place();
    const onPointerDown = (event: MouseEvent) => {
      const t = event.target as Node;
      // The menu is portaled outside rootRef, so test both containers.
      const inTrigger = rootRef.current?.contains(t) ?? false;
      const inMenu = menuRef.current?.contains(t) ?? false;
      if (!inTrigger && !inMenu) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onDismiss = () => setOpen(false);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onDismiss);
    // Capture phase: any inner scroll invalidates the anchor.
    window.addEventListener('scroll', onDismiss, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('scroll', onDismiss, true);
    };
  }, [open, close]);

  useEffect(() => {
    if (open) {
      // Focus on the next frame so the popover is mounted and scrollable.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    setQuery('');
    return undefined;
  }, [open]);

  const toggle = useCallback(
    (value: string) => {
      onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
    },
    [selected, onChange],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setCursor((c) => (filtered.length ? (c + 1) % filtered.length : 0));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setCursor((c) => (filtered.length ? (c - 1 + filtered.length) % filtered.length : 0));
        break;
      case 'Home':
        event.preventDefault();
        setCursor(0);
        break;
      case 'End':
        event.preventDefault();
        setCursor(Math.max(0, filtered.length - 1));
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (filtered[activeCursor]) toggle(filtered[activeCursor].value);
        break;
      case 'Escape':
        event.preventDefault();
        close();
        break;
      case 'Tab':
        // Let Tab move on, but not while the list is being driven by keyboard.
        if (open) close(false);
        break;
      default:
        break;
    }
  };

  // Keep the active option scrolled into the viewport.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeCursor, open]);

  const summary = useMemo(() => {
    if (selected.length === 0) return null;
    if (selected.length === options.length) return `Tous (${options.length})`;
    if (selected.length === 1) {
      return options.find((o) => o.value === selected[0])?.label ?? selected[0];
    }
    return `${selected.length} sélectionnés`;
  }, [selected, options]);

  return (
    <div className={`relative ${className}`} ref={rootRef}>
      {/* The clear affordance is a sibling of the trigger, never a child:
          nesting a button inside a button is invalid HTML and makes the
          control unreachable for keyboard and screen-reader users. */}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`w-full min-h-[42px] bg-pos-bg border border-pos-border rounded-xl pl-3 pr-9 py-2 text-xs text-pos-text flex items-center gap-2 transition focus:outline-none focus:border-amber-400 ${
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-amber-400/60'
        } ${selected.length > 0 ? 'pr-16' : ''}`}
      >
        {icon ?? <ListFilter className="w-3.5 h-3.5 text-pos-muted shrink-0" />}
        <span className="truncate flex-1 text-left">
          {summary ?? <span className="text-pos-muted">{placeholder}</span>}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-pos-muted absolute right-2.5 top-1/2 -translate-y-1/2 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {selected.length > 0 && !disabled && (
        <button
          type="button"
          aria-label={`Effacer ${selected.length} filtre(s)`}
          onClick={() => onChange([])}
          className="absolute right-7 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-pos-muted hover:text-rose-400 hover:bg-pos-hover transition cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}

      {open && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, width: menuPos.width || undefined, zIndex: 9999 }}
          data-open-up={menuPos.openUp ? 'true' : 'false'}
          className="bg-pos-panel border border-pos-border rounded-xl shadow-2xl overflow-hidden"
        >
          <div className="flex items-center gap-2 px-2.5 py-2 border-b border-pos-border">
            <Search className="w-3.5 h-3.5 text-pos-muted shrink-0" aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Taper pour filtrer…"
              aria-label="Filtrer les options"
              aria-controls="audit-command-list"
              className="flex-1 bg-transparent text-xs text-pos-text placeholder-pos-muted focus:outline-none min-w-0"
            />
          </div>

          <div
            ref={listRef}
            id="audit-command-list"
            role="listbox"
            aria-multiselectable="true"
            className="max-h-56 overflow-y-auto py-1"
          >
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-pos-muted">{emptyLabel}</div>
            ) : (
              filtered.map((opt, idx) => {
                const isSelected = selected.includes(opt.value);
                const isActive = idx === activeCursor;
                return (
                  <div
                    key={opt.value}
                    role="option"
                    aria-selected={isSelected}
                    data-active={isActive}
                    onMouseEnter={() => setCursor(idx)}
                    onClick={() => toggle(opt.value)}
                    className={`flex items-center gap-2 px-2.5 py-1.5 cursor-pointer transition ${
                      isActive ? 'bg-pos-hover' : ''
                    }`}
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                        isSelected
                          ? 'bg-amber-500 border-amber-500 text-slate-950'
                          : 'border-pos-border'
                      }`}
                    >
                      {isSelected && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
                    </span>
                    {opt.dot && (
                      <span className={`w-2 h-2 rounded-full shrink-0 ${opt.dot}`} aria-hidden="true" />
                    )}
                    <span className="text-xs text-pos-text flex-1 truncate">{opt.label}</span>
                    {opt.count !== undefined && (
                      <span className="text-[10px] text-pos-muted bg-pos-bg border border-pos-border px-1.5 py-0.5 rounded font-mono tabular-nums">
                        {opt.count}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-t border-pos-border text-[9px] text-pos-muted">
            <span className="hidden sm:inline">↑↓ naviguer · Entrée sélectionner · Échap fermer</span>
            <span className="flex-1 sm:hidden">↑↓ · ⏎ · Échap</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onChange(filtered.map((o) => o.value))}
                className="px-2 py-1 rounded-md hover:bg-pos-hover text-pos-text font-bold cursor-pointer"
              >
                Tout
              </button>
              <button
                type="button"
                onClick={() => onChange([])}
                className="px-2 py-1 rounded-md hover:bg-pos-hover text-pos-text font-bold cursor-pointer"
              >
                Aucun
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

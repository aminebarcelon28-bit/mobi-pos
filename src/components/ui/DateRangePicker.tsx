import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, X } from 'lucide-react';

interface DateRangePickerProps {
  startDate: Date | null;
  endDate: Date | null;
  onChange: (start: Date | null, end: Date | null) => void;
  placeholder?: string;
  disabled?: boolean;
}

export const DateRangePicker: React.FC<DateRangePickerProps> = ({
  startDate,
  endDate,
  onChange,
  placeholder = 'Période...',
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [tempStart, setTempStart] = useState<Date | null>(startDate);
  const [tempEnd, setTempEnd] = useState<Date | null>(endDate);
  const [focusedInput, setFocusedInput] = useState<'start' | 'end'>('start');
  const inputRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; openUp: boolean }>({
    top: 0,
    left: 0,
    openUp: false,
  });

  // Portaled calendar popover: fixed to viewport so it never clips inside
  // overflow-hidden modal cards. Auto flips up near the bottom edge, clamps
  // to the viewport, and dismisses on outside click / Escape / scroll / resize.
  useEffect(() => {
    if (!isOpen) return;
    const MENU_W = 520;
    const MENU_H_EST = 460;
    const place = () => {
      const anchor = anchorRef.current;
      const r = anchor?.getBoundingClientRect();
      if (!r) return;
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < MENU_H_EST + 16;
      const top = openUp
        ? Math.max(8, r.top - MENU_H_EST - 8)
        : Math.min(r.bottom + 8, window.innerHeight - 16);
      const isMobile = window.innerWidth < 640;
      const left = isMobile
        ? 8
        : Math.max(8, Math.min(r.left, window.innerWidth - MENU_W - 8));
      setMenuPos({ top, left, openUp });
    };
    place();
    const handleClickOutside = (event: MouseEvent) => {
      const t = event.target as Node;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(t) &&
        inputRef.current &&
        !inputRef.current.contains(t)
      ) {
        setIsOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        anchorRef.current?.focus();
      }
    };
    const handleScroll = () => setIsOpen(false);
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('resize', place);
    // Capture phase: any inner scroll (modal card list) invalidates the anchor.
    window.addEventListener('scroll', handleScroll, true);
    popoverRef.current
      ?.querySelector<HTMLButtonElement | HTMLInputElement>('button, input')
      ?.focus();
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen]);

  const formatDate = (date: Date | null): string => {
    if (!date) return '';
    return date.toLocaleDateString('fr-DZ', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  };

  const handleApply = () => {
    onChange(tempStart, tempEnd);
    setIsOpen(false);
  };

  const handleClear = () => {
    setTempStart(null);
    setTempEnd(null);
    onChange(null, null);
    setIsOpen(false);
  };

  const handleDateSelect = (date: Date) => {
    if (focusedInput === 'start') {
      setTempStart(date);
      if (!tempEnd || date > tempEnd) {
        setFocusedInput('end');
      }
    } else {
      setTempEnd(date);
      setFocusedInput('start');
    }
  };

  const getDisplayValue = (): string => {
    if (!startDate && !endDate) return placeholder;
    if (startDate && endDate) return `${formatDate(startDate)} → ${formatDate(endDate)}`;
    if (startDate) return `Depuis ${formatDate(startDate)}`;
    if (endDate) return `Jusqu'au ${formatDate(endDate)}`;
    return placeholder;
  };

  const renderCalendar = (month: Date, onSelect: (date: Date) => void, selected: Date | null, _other: Date | null) => {
    const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
    const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const startDay = firstDay.getDay();
    const daysInMonth = lastDay.getDate();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const weeks: (Date | null)[][] = [];
    let week: (Date | null)[] = new Array(startDay).fill(null);

    for (let day = 1; day <= daysInMonth; day++) {
      const currentDate = new Date(month.getFullYear(), month.getMonth(), day);
      week.push(currentDate);
      if (week.length === 7) {
        weeks.push(week);
        week = [];
      }
    }
    if (week.length > 0) {
      while (week.length < 7) week.push(null);
      weeks.push(week);
    }

    const isInRange = (date: Date) => {
      if (!startDate || !endDate) return false;
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      const s = new Date(startDate);
      s.setHours(0, 0, 0, 0);
      const e = new Date(endDate);
      e.setHours(0, 0, 0, 0);
      return d.getTime() >= s.getTime() && d.getTime() <= e.getTime();
    };

    const isSelected = (date: Date) => {
      if (!selected) return false;
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      const s = new Date(selected);
      s.setHours(0, 0, 0, 0);
      return d.getTime() === s.getTime();
    };

    return (
      <div className="p-2">
        <div className="flex items-center justify-between mb-2">
          <button
            type="button"
            onClick={() => onSelect(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            className="p-1 rounded hover:bg-pos-hover text-pos-muted text-xs"
            aria-label="Mois précédent"
          >
            <span aria-hidden="true">‹</span>
          </button>
          <span className="font-bold text-xs text-pos-text capitalize">
            {month.toLocaleDateString('fr-DZ', { month: 'long', year: 'numeric' })}
          </span>
          <button
            type="button"
            onClick={() => onSelect(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            className="p-1 rounded hover:bg-pos-hover text-pos-muted text-xs"
            aria-label="Mois suivant"
          >
            <span aria-hidden="true">›</span>
          </button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center text-[10px]">
          {['Di', 'Lu', 'Ma', 'Me', 'Je', 'Ve', 'Sa'].map((d) => (
            <div key={d} className="font-bold text-pos-muted py-0.5">{d}</div>
          ))}
          {weeks.map((week, wIdx) => (
            <div key={wIdx} className="contents">
              {week.map((day, dIdx) => (
                !day ? (
                  <div key={`${wIdx}-${dIdx}`} className="h-8" />
                ) : (
                  <button
                    key={`${wIdx}-${dIdx}`}
                    type="button"
                    onClick={() => onSelect(day)}
                    className={`h-8 w-full rounded-lg text-xs transition ${
                      isSelected(day)
                        ? 'bg-amber-500 text-slate-950 font-bold'
                        : isInRange(day)
                        ? 'bg-amber-500/20 text-amber-400 font-semibold'
                        : day.getTime() === today.getTime()
                        ? 'bg-emerald-500/20 text-emerald-400 font-bold ring-1 ring-emerald-500'
                        : 'text-pos-text hover:bg-pos-hover'
                    } ${day < new Date(month.getFullYear(), month.getMonth(), 1) ? 'opacity-30' : ''}`}
                  >
                    {day.getDate()}
                  </button>
                )
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="relative" ref={inputRef}>
      <button
        type="button"
        ref={anchorRef}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`w-full min-h-[42px] bg-pos-bg border border-pos-border rounded-xl pl-8 pr-10 py-2 text-xs text-pos-text placeholder-pos-muted focus:outline-none focus:border-amber-400 flex items-center justify-between transition ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Calendar className="w-3.5 h-3.5 text-pos-muted absolute left-3 shrink-0" />
          <span className="truncate">{getDisplayValue()}</span>
        </div>
        {(startDate || endDate) && !disabled && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleClear(); }}
            className="absolute right-8 top-1/2 -translate-y-1/2 text-pos-muted hover:text-rose-400 text-[10px] px-1 rounded cursor-pointer"
            aria-label="Effacer la période"
          >
            <span aria-hidden="true">✕</span>
          </button>
        )}
        <X className="w-3.5 h-3.5 text-pos-muted absolute right-3 shrink-0 rotate-45" />
      </button>

      {isOpen &&
        !disabled &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Choisir la période"
            style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 9999 }}
            data-open-up={menuPos.openUp ? 'true' : 'false'}
            className="w-[calc(100vw-16px)] sm:min-w-[520px] sm:w-auto bg-pos-panel border border-pos-border rounded-xl p-2 shadow-xl animate-in fade-in-0 zoom-in-95"
          >
            <div className="grid grid-cols-2 gap-2">
              <div className="border-r border-pos-border pr-2">
                <div className="text-[10px] font-bold text-pos-muted uppercase mb-1 px-1">
                  Date de début {focusedInput === 'start' ? '●' : ''}
                </div>
                <div className="relative">
                  <input
                    type="date"
                    value={tempStart ? tempStart.toISOString().split('T')[0] : ''}
                    onChange={(e) => setTempStart(e.target.value ? new Date(e.target.value) : null)}
                    className="w-full bg-pos-bg border border-pos-border rounded-lg px-2 py-1.5 text-[10px] text-pos-text focus:outline-none focus:border-amber-400"
                  />
                </div>
                {renderCalendar(
                  tempStart || new Date(),
                  (d) => handleDateSelect(d),
                  tempStart,
                  tempEnd
                )}
              </div>
              <div className="pl-2">
                <div className="text-[10px] font-bold text-pos-muted uppercase mb-1 px-1">
                  Date de fin {focusedInput === 'end' ? '●' : ''}
                </div>
                <div className="relative">
                  <input
                    type="date"
                    value={tempEnd ? tempEnd.toISOString().split('T')[0] : ''}
                    onChange={(e) => setTempEnd(e.target.value ? new Date(e.target.value) : null)}
                    className="w-full bg-pos-bg border border-pos-border rounded-lg px-2 py-1.5 text-[10px] text-pos-text focus:outline-none focus:border-amber-400"
                  />
                </div>
                {renderCalendar(
                  tempEnd || new Date(),
                  (d) => handleDateSelect(d),
                  tempEnd,
                  tempStart
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-3 pt-2 border-t border-pos-border">
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="px-3 py-1.5 rounded-lg text-[10px] font-bold text-pos-muted hover:text-pos-text bg-pos-bg border border-pos-border hover:bg-pos-hover transition cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={handleApply}
                className="px-3 py-1.5 rounded-lg text-[10px] font-bold bg-amber-500 text-slate-950 hover:bg-amber-400 transition cursor-pointer"
              >
                Appliquer
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

export interface MultiSelectProps {
  options: { value: string; label: string; count?: number }[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
  maxDisplay?: number;
  disabled?: boolean;
}

export const MultiSelect: React.FC<MultiSelectProps> = ({
  options,
  selected,
  onChange,
  placeholder = 'Sélectionner...',
  maxDisplay = 2,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number; openUp: boolean }>({
    top: 0,
    left: 0,
    width: 0,
    openUp: false,
  });

  // Portaled multiselect popover: fixed to viewport so it never clips inside
  // overflow-hidden modal cards. Width tracks the anchor, flips up near the
  // bottom edge, and dismisses on outside click / Escape / scroll / resize.
  useEffect(() => {
    if (!isOpen) return;
    const MENU_H_EST = 240;
    const place = () => {
      const anchor = buttonRef.current;
      const r = anchor?.getBoundingClientRect();
      if (!r) return;
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < MENU_H_EST + 16;
      const top = openUp
        ? Math.max(8, r.top - MENU_H_EST - 8)
        : Math.min(r.bottom + 8, window.innerHeight - 16);
      const isMobile = window.innerWidth < 640;
      if (isMobile) {
        setMenuPos({ top, left: 8, width: window.innerWidth - 16, openUp });
      } else {
        const width = r.width;
        const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
        setMenuPos({ top, left, width, openUp });
      }
    };
    place();
    const handleClickOutside = (event: MouseEvent) => {
      const t = event.target as Node;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(t) &&
        containerRef.current &&
        !containerRef.current.contains(t)
      ) {
        setIsOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };
    const handleScroll = () => setIsOpen(false);
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('resize', place);
    // Capture phase: any inner scroll (modal card list) invalidates the anchor.
    window.addEventListener('scroll', handleScroll, true);
    popoverRef.current
      ?.querySelector<HTMLButtonElement | HTMLInputElement>('button, input')
      ?.focus();
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen]);

  const toggleOption = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const selectAll = () => {
    onChange(options.map((o) => o.value));
  };

  const clearAll = () => {
    onChange([]);
  };

  const getDisplayText = (): string => {
    if (selected.length === 0) return placeholder;
    if (selected.length === options.length) return `Tous (${options.length})`;
    if (selected.length <= maxDisplay) {
      return selected.map((v) => options.find((o) => o.value === v)?.label || v).join(', ');
    }
    return `${selected.length} sélectionnés`;
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        ref={buttonRef}
        className={`w-full min-h-[42px] bg-pos-bg border border-pos-border rounded-xl pl-3 pr-10 py-2 text-xs text-pos-text placeholder-pos-muted focus:outline-none focus:border-amber-400 flex items-center justify-between transition ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <span className="truncate flex-1">{getDisplayText()}</span>
        <X className={`w-3.5 h-3.5 text-pos-muted absolute right-3 shrink-0 transition ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen &&
        !disabled &&
        createPortal(
          <div
            ref={popoverRef}
            role="menu"
            aria-label={placeholder}
            style={{
              position: 'fixed',
              top: menuPos.top,
              left: menuPos.left,
              ...(menuPos.width ? { width: menuPos.width } : null),
              zIndex: 9999,
            }}
            data-open-up={menuPos.openUp ? 'true' : 'false'}
            className="w-[calc(100vw-16px)] sm:w-auto bg-pos-panel border border-pos-border rounded-xl p-2 shadow-xl max-h-60 overflow-y-auto animate-in fade-in-0 zoom-in-95"
          >
            {options.length > 1 && (
              <div className="flex gap-2 pb-2 border-b border-pos-border mb-2">
                <button
                  type="button"
                  onClick={selectAll}
                  className="flex-1 px-2 py-1 rounded-lg text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition cursor-pointer"
                >
                  Tout cocher
                </button>
                <button
                  type="button"
                  onClick={clearAll}
                  className="flex-1 px-2 py-1 rounded-lg text-[10px] font-bold text-pos-muted bg-pos-bg border border-pos-border hover:bg-pos-hover transition cursor-pointer"
                >
                  Tout décocher
                </button>
              </div>
            )}
            <div className="space-y-1">
              {options.map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-pos-hover cursor-pointer transition"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(opt.value)}
                    onChange={() => toggleOption(opt.value)}
                    className="w-4 h-4 accent-amber-500 rounded cursor-pointer"
                  />
                  <span className="text-xs text-pos-text flex-1 truncate">{opt.label}</span>
                  {opt.count !== undefined && (
                    <span className="text-[10px] text-pos-muted bg-pos-bg px-1.5 py-0.5 rounded font-mono">
                      {opt.count}
                    </span>
                  )}
                </label>
              ))}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

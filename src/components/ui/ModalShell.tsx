/**
 * ModalShell — the ONE modal primitive for the SAV / Inspector surfaces.
 *
 * Layout contract (locked, non-negotiable):
 *  • Exactly ONE scroll container (the body). Backdrop and card are
 *    `overflow-hidden`, so no double scrollbars can ever appear.
 *  • Dynamic viewport units only (`100dvh` / `90dvh`) — no `100vh`, which
 *    is wrong on Android once the URL bar or the virtual keyboard resizes
 *    the visual viewport.
 *  • Bottom sheet under `sm`, centered dialog at ≥640px.
 *  • The Android virtual keyboard is shimmed via `window.visualViewport`:
 *    while the IME is open the container gets a bottom padding equal to the
 *    occluded height, so the pinned action bar is never hidden behind it.
 *    That is why the footer is a flex sibling and never `position: sticky`.
 */
import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

export type ModalShellWidth = 'xl' | '5xl' | 'full';

const WIDTH_CLASS: Record<ModalShellWidth, string> = {
  xl: 'sm:max-w-xl',
  '5xl': 'sm:max-w-5xl',
  full: 'sm:max-w-7xl',
};

export interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Rendered to the LEFT of the title (icon tile, status pill). */
  icon?: ReactNode;
  /** Pinned footer actions. Never stretched across a wide monitor. */
  footer?: ReactNode;
  width?: ModalShellWidth;
  /** Rendered under the header, OUTSIDE the scroll container (KPI strip, tabs). */
  headerExtras?: ReactNode;
  closeLabel?: string;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

export const ModalShell: React.FC<ModalShellProps> = ({
  open,
  onClose,
  title,
  subtitle,
  icon,
  footer,
  width = 'xl',
  headerExtras,
  closeLabel = 'Fermer',
  className = '',
  bodyClassName = '',
  children,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  // Height (px) currently occluded at the bottom of the visual viewport —
  // 0 when no keyboard is open.
  const [keyboardInset, setKeyboardInset] = useState(0);

  // IME shield. Recomputed on every resize/scroll of the visual viewport;
  // `layoutH - (visualH + offsetTop)` is the exact covered strip.
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const compute = () => {
      const layoutH = window.innerHeight;
      const occluded = Math.round(layoutH - (vv.height + vv.offsetTop));
      setKeyboardInset(occluded > 0 ? Math.min(occluded, layoutH) : 0);
    };
    compute();
    vv.addEventListener('resize', compute);
    vv.addEventListener('scroll', compute);
    return () => {
      vv.removeEventListener('resize', compute);
      vv.removeEventListener('scroll', compute);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    // Move focus into the dialog so Tab never lands behind the backdrop.
    const card = cardRef.current;
    const target = card?.querySelector<HTMLElement>('[data-modal-autofocus]');
    (target ?? card)?.focus?.();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center items-center bg-black/60 p-0 sm:p-4 overflow-hidden select-none animate-in fade-in"
      style={keyboardInset > 0 ? { paddingBottom: keyboardInset } : undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className={`w-full ${WIDTH_CLASS[width]} flex flex-col max-h-[100dvh] sm:max-h-[90dvh] bg-pos-panel border border-pos-border rounded-t-2xl sm:rounded-2xl overflow-hidden shadow-2xl outline-none animate-in slide-in-from-bottom-5 sm:zoom-in-95 ${className}`}
      >
        {/* Zone 1 — non-shrinking header (mobile swipe handle + close). */}
        <div className="flex-none">
          <div
            className="w-10 h-1 rounded-full bg-slate-300 dark:bg-pos-muted/50 mx-auto mt-2.5 mb-2 sm:hidden"
            aria-hidden="true"
          />
          <div className="p-3 sm:p-3.5 border-b border-pos-border bg-pos-card flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              {icon}
              <div className="min-w-0">
                <h2 className="text-sm sm:text-base font-semibold text-pos-text tracking-tight flex items-center gap-2 truncate">
                  {title}
                </h2>
                {subtitle && (
                  <p className="text-[11px] sm:text-xs text-pos-muted font-normal mt-0.5 truncate">
                    {subtitle}
                  </p>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
              aria-label={closeLabel}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          {headerExtras}
        </div>

        {/* Zone 2 — THE ONLY scrollable container in the dialog. */}
        <div
          className={`flex-1 overflow-y-auto overscroll-contain p-3 sm:p-3.5 space-y-3.5 bg-pos-bg ${bodyClassName}`}
        >
          {children}
        </div>

        {/* Zone 3 — pinned action bar (flex sibling, never sticky). */}
        {footer && (
          <div className="flex-none border-t border-pos-border bg-pos-card px-3 sm:px-3.5 py-2.5 sm:py-3 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

export default ModalShell;
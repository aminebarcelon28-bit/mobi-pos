import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { IconButton } from './IconButton';

export type BottomSheetDetent = 'auto' | 'half' | 'large' | 'full';

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Optional leading icon or badge next to title. */
  leadingIcon?: ReactNode;
  /** Optional trailing header action (rendered before the 48x48px Close IconButton). */
  headerAction?: ReactNode;
  /** Pinned sub-header (e.g., SearchField or SegmentedControl) outside the scroll body. */
  pinnedTop?: ReactNode;
  /** Pinned footer CTA bar (automatically padded above virtual keyboard & --safe-bottom). */
  footer?: ReactNode;
  detent?: BottomSheetDetent;
  /** Accessible label for the 48x48px close button (default: "Fermer"). */
  closeLabel?: string;
  /** Hides the close button when a blocking decision is required. */
  hideCloseButton?: boolean;
  /** Mounts inside `document.body` via `createPortal` when true. */
  portal?: boolean;
  /** Z-index override class (default: "z-50"). */
  zIndexClass?: string;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

const DETENT_CLASSES: Record<BottomSheetDetent, string> = {
  auto: 'max-h-[92dvh] sm:max-h-[88dvh]',
  half: 'min-h-[50dvh] max-h-[85dvh]',
  large: 'min-h-[75dvh] max-h-[94dvh]',
  full: 'h-[94dvh] max-h-[94dvh]',
};

export const BottomSheet: React.FC<BottomSheetProps> = ({
  open,
  onClose,
  title,
  subtitle,
  leadingIcon,
  headerAction,
  pinnedTop,
  footer,
  detent = 'auto',
  closeLabel = 'Fermer',
  hideCloseButton = false,
  portal = false,
  zIndexClass = 'z-50',
  children,
  className = '',
  bodyClassName = '',
}) => {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [keyboardInset, setKeyboardInset] = useState(0);

  // IME shield: recompute occluded visualViewport height so pinned footer stays visible
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const compute = () => {
      const layoutH = window.innerHeight;
      const occluded = Math.round(layoutH - (vv.height + vv.offsetTop));
      setKeyboardInset(occluded > 0 ? Math.min(occluded, layoutH) : 0);
    };
    compute();
    vv.addEventListener('resize', compute, { passive: true });
    vv.addEventListener('scroll', compute, { passive: true });
    return () => {
      vv.removeEventListener('resize', compute);
      vv.removeEventListener('scroll', compute);
    };
  }, []);

  // Move focus into the sheet ONCE on open (never re-keyed on `onClose` identity)
  useEffect(() => {
    if (!open) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    if (sheet.contains(document.activeElement)) return;
    const target = sheet.querySelector<HTMLElement>('[data-modal-autofocus]');
    (target ?? sheet).focus?.({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const node = (
    <div
      className={`fixed inset-0 ${zIndexClass} flex flex-col justify-end sm:justify-center items-center bg-black/50 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:p-4 overflow-hidden select-none animate-in fade-in`}
      style={keyboardInset > 0 ? { paddingBottom: keyboardInset } : undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !hideCloseButton) onClose();
      }}
    >
      <div
        ref={sheetRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className={`w-full sm:max-w-xl flex flex-col ${DETENT_CLASSES[detent]} platform-sheet-surface sm:rounded-2xl border border-pos-border overflow-hidden outline-none ${className}`}
      >
        {/* Zone 1: Drag Grabber + Header */}
        <div className="flex-none">
          <div className="sheet-handle sm:hidden" aria-hidden="true" />
          <div className="px-4 py-2.5 sm:py-3 border-b border-pos-border flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0 flex-1 text-start">
              {leadingIcon ? (
                <div className="shrink-0" aria-hidden="true">
                  {leadingIcon}
                </div>
              ) : null}
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-bold text-pos-text tracking-tight truncate">
                  {title}
                </h2>
                {subtitle ? (
                  <p className="text-xs text-pos-muted mt-0.5 truncate">
                    {subtitle}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-1">
              {headerAction}
              {!hideCloseButton ? (
                <IconButton
                  ariaLabel={closeLabel}
                  onClick={onClose}
                  icon={<X className="w-5 h-5" />}
                />
              ) : null}
            </div>
          </div>
          {pinnedTop ? <div className="shrink-0">{pinnedTop}</div> : null}
        </div>

        {/* Zone 2: Scrollable Content */}
        <div
          className={`flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 space-y-3.5 bg-pos-bg ${bodyClassName}`}
        >
          {children}
        </div>

        {/* Zone 3: Pinned Footer */}
        {footer ? (
          <div className="flex-none border-t border-pos-border bg-pos-card px-4 py-3 pb-[max(0.75rem,var(--safe-bottom))]">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );

  if (portal && typeof document !== 'undefined') {
    return createPortal(node, document.body);
  }

  return node;
};

export default BottomSheet;

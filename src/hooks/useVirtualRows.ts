import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Windowed list hook.
 *
 * The Journal d'Audit renders every row of a potentially very long register.
 * The DB adapter caps reads at 300 rows, but a live register plus an
 * unfiltered "tout l'historique" view still produces enough DOM to drop frames
 * on the low-end terminals this POS ships to — and each row mounts severity
 * chips, a live-updating relative timestamp and an entity-link tokenizer.
 *
 * This hook renders only the visible slice plus a small overscan, and supports
 * variable row heights by measuring each mounted row. Measurements are cached
 * by index and offsets are recomputed lazily, so scrolling stays proportional
 * to the window, not to the register length.
 *
 * Deliberately dependency-free: every other primitive in `components/ui` is
 * hand-rolled against the app's `pos-*` token system, so a local
 * implementation keeps the bundle and the visual language consistent.
 */

export interface VirtualRow {
  index: number;
  start: number;
  size: number;
}

export interface VirtualWindowResult {
  /** Spacer height for the full scrollable content. */
  totalSize: number;
  /** Rows to render, already offset-corrected via `start`. */
  rows: VirtualRow[];
  /** Attach to each rendered row element to feed its measured height back. */
  measureRef: (index: number) => (el: HTMLElement | null) => void;
  /** Bring a row into view, used when live entries are prepended. */
  scrollToIndex: (index: number, align?: 'start' | 'center' | 'nearest') => void;
  /** True while measured sizes are still settling after a data change. */
  measuring: boolean;
}

const DEFAULT_OVERSCAN = 8;

export function useVirtualRows(
  count: number,
  options: {
    estimateSize?: number;
    overscan?: number;
    /**
     * Scroll container, passed as a ref so the element is read inside an
     * effect. Reading `.current` during render would be null on the first pass
     * and would silently bind the hook to the window instead.
     */
    scrollRef?: React.RefObject<HTMLElement | null>;
  } = {},
): VirtualWindowResult {
  const {
    estimateSize = 56,
    overscan = DEFAULT_OVERSCAN,
    scrollRef,
  } = options;

  const sizesRef = useRef<Map<number, number>>(new Map());
  const observersRef = useRef<Map<number, ResizeObserver>>(new Map());
  const pendingRef = useRef(new Set<number>());
  const frameRef = useRef<number | null>(null);

  const [version, setVersion] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(() =>
    typeof window === 'undefined' ? 800 : window.innerHeight,
  );
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [measuring, setMeasuring] = useState(false);

  // ── scroll container plumbing ──────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef?.current ?? null;
    setContainer(el);
    if (!el) return;

    const onScroll = () => setScrollTop(el.scrollTop);
    const onResize = () => setViewport(el.clientHeight || 800);
    onScroll();
    onResize();
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [scrollRef]);

  // ── row measurement ────────────────────────────────────────────────────────
  const measureRef = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      const existing = observersRef.current.get(index);
      if (existing) {
        existing.disconnect();
        observersRef.current.delete(index);
      }
      if (!el) return;

      const apply = (height: number) => {
        if (height <= 0) return;
        const prev = sizesRef.current.get(index);
        if (prev !== undefined && Math.abs(prev - height) < 0.5) return;
        sizesRef.current.set(index, height);
        pendingRef.current.add(index);
      };

      apply(el.getBoundingClientRect().height);

      if (typeof ResizeObserver === 'undefined') {
        if (pendingRef.current.size) scheduleFlush();
        return;
      }
      setMeasuring(true);
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const measured =
            entry.borderBoxSize?.[0]?.blockSize ||
            entry.contentRect.height ||
            0;
          apply(measured);
        }
        if (pendingRef.current.size) scheduleFlush();
      });
      ro.observe(el);
      observersRef.current.set(index, ro);

      function scheduleFlush() {
        if (frameRef.current !== null) return;
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null;
          pendingRef.current.clear();
          setMeasuring(false);
          setVersion((v) => v + 1);
        });
      }
    },
    [],
  );

  // Drop observers and cached sizes for rows that no longer exist: a filter or
  // a search reshuffles the list, and a stale height applied to a different
  // entry would corrupt every offset below it.
  useEffect(() => {
    for (const [index, ro] of observersRef.current) {
      if (index >= count) {
        ro.disconnect();
        observersRef.current.delete(index);
        sizesRef.current.delete(index);
      }
    }
  }, [count]);

  useEffect(
    () => () => {
      observersRef.current.forEach((ro) => ro.disconnect());
      observersRef.current.clear();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  // ── offset computation ─────────────────────────────────────────────────────
  const { rows, totalSize } = useMemo(() => {
    const sizes = sizesRef.current;
    const starts: number[] = new Array(count);
    let total = 0;
    for (let i = 0; i < count; i++) {
      starts[i] = total;
      total += sizes.get(i) ?? estimateSize;
    }

    const top = scrollTop - overscan * estimateSize;
    const bottom = scrollTop + viewport + overscan * estimateSize;

    const window: VirtualRow[] = [];
    for (let i = 0; i < count; i++) {
      const size = sizes.get(i) ?? estimateSize;
      const start = starts[i];
      if (start + size < top) continue;
      if (start > bottom) break;
      window.push({ index: i, start, size });
    }

    return { rows: window, totalSize: total };
    // `version` is the measurement-tick signal; sizes live in a ref so the
    // cache itself never lands in a dependency array.
  }, [count, scrollTop, viewport, overscan, estimateSize, version]);

  const scrollToIndex = useCallback(
    (index: number, align: 'start' | 'center' | 'nearest' = 'nearest') => {
      if (index < 0 || index >= count) return;
      const el = container;
      const sizes = sizesRef.current;

      let start = 0;
      for (let i = 0; i < index; i++) start += sizes.get(i) ?? estimateSize;
      const size = sizes.get(index) ?? estimateSize;

      const currentTop = el ? el.scrollTop : window.scrollY;
      const currentHeight = el ? el.clientHeight : window.innerHeight;

      let target: number;
      if (align === 'center') target = start - (currentHeight - size) / 2;
      else if (align === 'start') target = start;
      else if (currentTop > start) target = start;
      else if (currentTop + currentHeight < start + size) target = start - currentHeight + size;
      else return;

      if (el) el.scrollTop = target;
      else window.scrollTo({ top: target });
      setScrollTop(target);
    },
    [count, estimateSize, container],
  );

  return { totalSize, rows, measureRef, scrollToIndex, measuring };
}

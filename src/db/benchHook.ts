/**
 * Dev-only timing hook (Phase 4.5 W4 follow-up).
 *
 * Zero-cost when disabled: every public function returns immediately unless
 * explicitly enabled AND running in a dev build or a bench-enabled Node run.
 * Release browser builds: `import.meta.env.DEV` is false (Vite replaces it
 * at build time and the minifier drops the branch), and there is no
 * `process.env` in the browser — so the hook cannot arm itself in prod.
 * Verified by: unit default-off test + scripts/test_bench_hook.mjs
 * source-gate assertions (see report for the dist-bundle check method).
 *
 * This module imports nothing: no cycles, no side effects on import.
 */

export interface BenchSpanStats {
  span: string;
  count: number;
  mean: number;
  p50: number;
  p95: number;
}

interface Mark {
  label: string;
  t: number;
}

const RING_CAP = 1024;

let armed = false;
let marks: Mark[] = [];

function isDevBuild(): boolean {
  try {
    const meta = import.meta as unknown as
      | { env?: { DEV?: boolean } }
      | undefined;
    if (meta && meta.env && meta.env.DEV === true) return true;
  } catch {
    // ignore — non-module runtimes fall through to the Node check below
  }
  try {
    const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
      .process;
    if (proc && proc.env && proc.env['MOBI_BENCH'] === '1') return true;
  } catch {
    // ignore
  }
  return false;
}

/** Arm/disarm. Arming is refused unless {@link isDevBuild} holds. */
export function setBenchEnabled(on: boolean): void {
  armed = on === true && isDevBuild();
  if (!armed) marks = [];
}

/** True only when armed in a dev-capable runtime. Never true in release. */
export function isBenchEnabled(): boolean {
  return armed === true && isDevBuild();
}

/** Record a timestamped mark. No-op unless enabled (hot-path safe). */
export function benchMark(label: string): void {
  if (!isBenchEnabled()) return;
  try {
    marks.push({ label, t: performance.now() });
    if (marks.length > RING_CAP) marks.splice(0, marks.length - RING_CAP);
  } catch {
    // Timing must never break production flows.
  }
}

interface SpanDef {
  span: string;
  start: string;
  end: string;
}

const SPANS: SpanDef[] = [
  { span: 'checkout:total', start: 'checkout:start', end: 'checkout:post-commit' },
  { span: 'checkout:db-work', start: 'checkout:start', end: 'checkout:pre-commit' },
  { span: 'checkout:commit', start: 'checkout:pre-commit', end: 'checkout:post-commit' },
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

/** p50/p95 per span over paired marks. Pure computation over the ring. */
export function getBenchReport(): BenchSpanStats[] {
  const buckets = new Map<string, number[]>();
  const pending = new Map<string, number[]>();
  for (const m of marks) {
    for (const s of SPANS) {
      if (m.label === s.start) {
        const q = pending.get(s.span) || [];
        q.push(m.t);
        pending.set(s.span, q);
      } else if (m.label === s.end) {
        const q = pending.get(s.span);
        const t0 = q && q.length > 0 ? (q.shift() as number) : undefined;
        if (t0 !== undefined) {
          const arr = buckets.get(s.span) || [];
          arr.push(m.t - t0);
          buckets.set(s.span, arr);
        }
      }
    }
  }
  const out: BenchSpanStats[] = [];
  for (const s of SPANS) {
    const arr = (buckets.get(s.span) || []).slice().sort((a, b) => a - b);
    const mean = arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    out.push({
      span: s.span,
      count: arr.length,
      mean,
      p50: percentile(arr, 50),
      p95: percentile(arr, 95),
    });
  }
  return out;
}

/** Test seam: clear recorded marks. */
export function __clearBenchMarksForTests(): void {
  marks = [];
}

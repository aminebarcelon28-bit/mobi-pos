import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import {
  shouldBlockForWebViewUpdate,
  renderWebViewUpdateScreen,
} from './utils/webviewCompat'
import { observeLcpOnce } from './utils/bootTimings'

function boot() {
  // Field LCP attribution (logs one line per LCP candidate, disconnects
  // after 30s - see bootTimings.ts). Needed to attribute slow LCP to a node.
  observeLcpOnce();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

// P2 crash telemetry (no new dependency): the freeze/crash investigation found
// zero crash capture - no Sentry, no window.onerror/unhandledrejection
// handler, ErrorBoundary only console.errors render errors. OOM kills and
// wedged sync loops left no trail. This ring buffer keeps the last 50 reports
// in localStorage; read via window.__mobipos_getCrashReports() or attach it
// to the Sync Diagnostics export. Never throws (storage may be full).
const CRASH_REPORT_KEY = 'mobipos_crash_reports';
const MAX_CRASH_REPORTS = 50;

interface CrashReport {
  kind: 'error' | 'unhandledrejection';
  message: string;
  stack: string;
  at: string;
}

function recordCrashReport(kind: CrashReport['kind'], message: unknown, stack?: unknown): void {
  try {
    const raw = localStorage.getItem(CRASH_REPORT_KEY);
    const arr: CrashReport[] = raw ? (JSON.parse(raw) as CrashReport[]) : [];
    arr.unshift({
      kind,
      message: String(message ?? 'unknown').slice(0, 500),
      stack: String(stack ?? '').slice(0, 1000),
      at: new Date().toISOString(),
    });
    localStorage.setItem(CRASH_REPORT_KEY, JSON.stringify(arr.slice(0, MAX_CRASH_REPORTS)));
  } catch {
    // Storage full or unavailable - the reporter must never crash the app.
  }
}

function installCrashCapture(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    recordCrashReport('error', event.message, (event.error as Error | undefined)?.stack);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as Error | undefined;
    recordCrashReport('unhandledrejection', reason?.message ?? String(event.reason), reason?.stack);
  });
  const w = window as unknown as Record<string, unknown>;
  w.__mobipos_getCrashReports = (): CrashReport[] => {
    try {
      const raw = localStorage.getItem(CRASH_REPORT_KEY);
      return raw ? (JSON.parse(raw) as CrashReport[]) : [];
    } catch {
      return [];
    }
  };
  w.__mobipos_clearCrashReports = (): void => {
    try {
      localStorage.removeItem(CRASH_REPORT_KEY);
    } catch {
      // ignore
    }
  };
}

installCrashCapture();

// Tier-B stress hook (E2E FLAVOR builds ONLY): exposes the REAL checkout
// path (store addToCart + processPayment) for seeded-volume runs. The e2e
// flavor is built with VITE_E2E=1 (scripts/build-e2e.mjs); plain `npm run
// build`/`dev` lack it, so esbuild dead-branch elimination erases this
// block from production AND plain-dev bundles — same pattern as
// devBenchMark (WP2c). Never referenced by app code; WDIO stress specs
// drive it. Absence from prod dist is proven by grepping dist for
// `__posStress` after a plain `npm run build`.
if (import.meta.env.VITE_E2E === '1') {
  (window as unknown as Record<string, unknown>).__posStress = {
    version: 2,
    probeFlight: async (): Promise<{ active: boolean; owner: string; idleMs: number; nowMs: number }> => {
      const { isCheckoutFlightActive, checkoutFlightOwner, checkoutFlightIdleMs } = await import('./db/checkoutFlight');
      return { active: isCheckoutFlightActive(), owner: checkoutFlightOwner(), idleMs: checkoutFlightIdleMs(), nowMs: Date.now() };
    },
    runBatch: async (
      baskets: Array<{ lines: Array<{ id: string; qty: number }>; tenderedDa: number }>
    ): Promise<Array<{ ok: boolean; ms: number; reason?: string }>> => {
      const { usePosStore } = await import('./store/usePosStore');
      const out: Array<{ ok: boolean; ms: number; reason?: string }> = [];
      for (const b of baskets) {
        const t0 = performance.now();
        try {
          const st = usePosStore.getState();
          (st.clearCart as () => void)();
          for (const line of b.lines) {
            const p = (st.products as Array<{ id: string }>).find((x) => x.id === line.id);
            if (!p) throw new Error(`UNKNOWN_PRODUCT:${line.id}`);
            const r = (st.addToCart as (
              p: unknown,
              o: boolean,
              q: number
            ) => { success: boolean; reason?: string })(p, false, line.qty);
            if (!r.success) throw new Error(r.reason ?? 'ADD_FAILED');
          }
          const res = (await (st.processPayment as (t: Array<{ method: string; amount: number }>) => Promise<{
            success: boolean;
            reason?: string;
          }>)([{ method: 'Espèces', amount: b.tenderedDa }])) as {
            success: boolean;
            reason?: string;
          };
          if (!res.success) throw new Error(res.reason ?? 'PAY_FAILED');
          out.push({ ok: true, ms: performance.now() - t0 });
        } catch (e) {
          try { (usePosStore.getState().clearCart as () => void)(); } catch { /* ignore */ }
          out.push({ ok: false, ms: performance.now() - t0, reason: (e as Error)?.message ?? String(e) });
        }
      }
      return out;
    },
    /**
     * Receipt bytes from the REAL builder (E2E flavor only). RCP specs need the
     * bytes the app would send, and the canvas exists only here: a host-side
     * rebuild in Node has no text stack and would exercise the CP864 fallback
     * instead of the Arabic raster lane. Returns a plain number[] (IPC-friendly).
     */
    buildReceipt: async (
      tx: Record<string, unknown>,
      settings: Record<string, unknown>,
      opts?: { raster?: 'canvas' | 'off' },
    ): Promise<number[]> => {
      const { buildReceiptBuffer } = await import('./utils/escpos');
      const bytes = buildReceiptBuffer(tx as never, settings as never, undefined, undefined, {
        rasterizer: opts?.raster === 'off' ? null : undefined,
      });
      return Array.from(bytes);
    },
  };
}

// SEC-01: a failed native schema migration is a STOP, never a silent fallback.
// The migration is transactional and verified against a golden manifest; when it
// fails the DB is untouched and the renderer must not try to heal it (after the
// read-only flip it cannot, and before it a fallback would hide the failure).
async function bootWithSchemaGate(): Promise<void> {
  try {
    const { invokeCommand } = await import('./platform/invoke');
    const status = await invokeCommand<{ applied: boolean; failed: boolean; error?: string | null }>(
      'schema_heal_status',
    );
    if (status?.failed) {
      const { renderSchemaRecovery } = await import('./components/SchemaRecoveryScreen');
      renderSchemaRecovery(status.error ?? null);
      return;
    }
  } catch {
    // Web preview / non-Tauri host: no native migration to gate.
  }
  // Old-Android gate: an outdated system WebView would render a broken UI
  // (Tailwind v4 needs Chrome 111+). Intercept first, offer the Play Store fix.
  if (shouldBlockForWebViewUpdate()) {
    renderWebViewUpdateScreen(boot);
  } else {
    boot();
  }
}

void bootWithSchemaGate();

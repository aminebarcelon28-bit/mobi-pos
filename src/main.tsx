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

// Old-Android gate: an outdated system WebView would render a broken UI
// (Tailwind v4 needs Chrome 111+). Intercept first, offer the Play Store fix.
if (shouldBlockForWebViewUpdate()) {
  renderWebViewUpdateScreen(boot)
} else {
  boot()
}

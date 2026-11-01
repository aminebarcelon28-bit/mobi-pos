/**
 * Refund Modal lifecycle diagnostics (E-0114). A ring buffer the E2E harness can
 * read, so the next lifecycle bug is traced instead of guessed. Diagnostics must
 * never throw or block the money path.
 */
const KEY = 'refund_diag';
const MAX = 200;

export function refundDiag(event: string, data?: Record<string, unknown>): void {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    const list = raw ? (JSON.parse(raw) as unknown[]) : [];
    list.push({ t: new Date().toISOString(), event, ...(data ?? {}) });
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch {
    /* diagnostics are best-effort, never a failure */
  }
}

export function readRefundDiag(): unknown[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown[];
  } catch {
    return [];
  }
}

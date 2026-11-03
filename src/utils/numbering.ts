/**
 * Document numbering (fiscal seam) — SYN-02, ADR-006.
 *
 * The fiscal rule is a *unique number, based on one or more series*, in
 * chronological order (EU VAT Directive 2006/112/EC art. 226 is the canonical
 * statement; Algerian practice is the same "chronologique et continue"). A
 * single merchant-wide counter cannot allocate offline, so the POS uses **one
 * series per terminal**: each terminal owns a short series token and a
 * continuous counter, and no two terminals can mint the same number.
 *
 * Provisional: the owner/accountant must confirm the series layout (and whether
 * the fiscal administration wants the series registered or reset annually)
 * before this goes to production. Until then the scheme is a **swappable seam**:
 * `setNumberingScheme('legacy-timestamp')` restores the previous behaviour
 * byte-for-byte, and `setSequenceStore()`/`setDeviceSeries()` let a host (app
 * boot, tests, a future native counter) supply the series and the durable
 * counter without touching callers.
 *
 * Why the counter is injected: it must eventually live in the native DB (one
 * source of truth, crash-safe). Today the default store is `localStorage`,
 * which is synchronous and per-device, and a degraded store falls back to the
 * legacy timestamp format *and* is counted — a silent gap-free claim would be
 * a fiscal lie.
 */

export type NumberingSchemeId = 'device-series-v1' | 'legacy-timestamp';

/** Prefixes that are fiscal documents; a prefix change is an owner decision. */
export const FISCAL_PREFIXES = ['REC', 'AVOIR', 'SAV', 'REP', 'PO', 'VERS'] as const;

const STORE_KEY = 'mobipos_numbering_v1';
const SERIES_KEY = 'mobipos_numbering_series_v1';
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface SequenceStore {
  read(key: string): number | null;
  write(key: string, value: number): void;
  /** True when the store cannot persist across restarts (memory/degraded). */
  degraded?: boolean;
}

const memory = new Map<string, number>();

const localStorageStore: SequenceStore = {
  read(key) {
    try {
      if (typeof localStorage === 'undefined') return memory.get(key) ?? null;
      const raw = localStorage.getItem(key);
      const n = raw === null ? NaN : Number(raw);
      return Number.isFinite(n) ? n : null;
    } catch {
      return memory.get(key) ?? null;
    }
  },
  write(key, value) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, String(value));
      else memory.set(key, value);
    } catch {
      memory.set(key, value);
    }
  },
};

const memoryStore: SequenceStore = {
  read: (key) => memory.get(key) ?? null,
  write: (key, value) => void memory.set(key, value),
  degraded: false,
};

let store: SequenceStore = localStorageStore;
let schemeId: NumberingSchemeId = 'device-series-v1';
let seriesToken: string | null = null;
/** Draws that had to fall back to the legacy format (diagnostics, never hidden). */
let degradedDraws = 0;

const randomToken = (length: number): string => {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
};

/** 4 characters from a stable device id, so the series is printed on the paper. */
export function seriesFromDevice(deviceId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < deviceId.length; i += 1) {
    h ^= deviceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const n = h >>> 0;
  let out = '';
  let x = n;
  for (let i = 0; i < 4; i += 1) {
    out += ALPHABET[x % ALPHABET.length];
    x = Math.floor(x / ALPHABET.length) + 7;
  }
  return out;
}

const readPersistedSeries = (): string | null => {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(SERIES_KEY);
    return raw && /^[0-9A-Z]{4}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
};

/** The series of THIS terminal (persisted; random only on first boot). */
export function currentDeviceSeries(): string {
  if (seriesToken) return seriesToken;
  const persisted = readPersistedSeries();
  if (persisted) {
    seriesToken = persisted;
    return persisted;
  }
  const fresh = randomToken(4);
  seriesToken = fresh;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SERIES_KEY, fresh);
  } catch {
    /* memory only: the caller still gets a stable token for this process */
  }
  return fresh;
}

export function setDeviceSeries(token: string): void {
  const clean = String(token || '').trim().toUpperCase();
  if (!/^[0-9A-Z]{4,8}$/.test(clean)) {
    throw new Error(`setDeviceSeries: expected 4-8 chars of 0-9A-Z, got "${token}"`);
  }
  seriesToken = clean;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SERIES_KEY, clean);
  } catch {
    /* in-memory fallback */
  }
}

export function setNumberingScheme(id: NumberingSchemeId): void {
  if (id !== 'device-series-v1' && id !== 'legacy-timestamp') {
    throw new Error(`setNumberingScheme: unknown scheme "${id}"`);
  }
  schemeId = id;
}

export function activeNumberingScheme(): NumberingSchemeId {
  return schemeId;
}

export function setSequenceStore(next: SequenceStore): void {
  store = next;
}

/** Swaps to a process-local, non-persistent store (tests / degraded hosts). */
export function useMemorySequenceStore(): void {
  memory.clear();
  store = memoryStore;
}

export function degradedNumberingDraws(): number {
  return degradedDraws;
}

// ── legacy scheme (the previous behaviour, kept byte-identical) ─────────────
let lastMs = 0;
let sameMsSeq = 0;
const legacySequence = (ms: number): number => {
  if (ms === lastMs) sameMsSeq += 1;
  else {
    lastMs = ms;
    sameMsSeq = 0;
  }
  return sameMsSeq;
};
const legacyEntropy = (length: number): string => randomToken(length);

const legacyNumber = (prefix: string, now: number): string => {
  const seq = legacySequence(now);
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const msOfDay = now - new Date(y, d.getMonth(), d.getDate()).getTime();
  return `${prefix}-${y}${m}${day}-${msOfDay.toString(36).toUpperCase()}-${String(seq).padStart(2, '0')}-${legacyEntropy(5)}`;
};

// ── device-series scheme ───────────────────────────────────────────────────
const counterKey = (prefix: string, series: string): string => `${STORE_KEY}:${prefix}:${series}`;

const nextSeriesSequence = (prefix: string, series: string): number | null => {
  const key = counterKey(prefix, series);
  const current = store.read(key);
  if (current === null && store.degraded) return null;
  const next = (current ?? 0) + 1;
  store.write(key, next);
  return next;
};

/**
 * Mint the next document number. Synchronous by contract: callers mint it inside
 * checkout/repair flows and print it immediately.
 */
export function newDocumentNumber(prefix: string, now: number = Date.now()): string {
  if (schemeId === 'legacy-timestamp') return legacyNumber(prefix, now);
  const series = currentDeviceSeries();
  const seq = nextSeriesSequence(prefix, series);
  if (seq === null) {
    // No durable counter: never claim a continuous series that we cannot honour.
    degradedDraws += 1;
    return legacyNumber(prefix, now);
  }
  return `${prefix}-${series}-${String(seq).padStart(6, '0')}`;
}

/** Read-only view for diagnostics/UI (never mutates). */
export function numberingState(): {
  scheme: NumberingSchemeId;
  series: string;
  degradedDraws: number;
  storeDegraded: boolean;
} {
  return {
    scheme: schemeId,
    series: currentDeviceSeries(),
    degradedDraws,
    storeDegraded: Boolean(store.degraded),
  };
}

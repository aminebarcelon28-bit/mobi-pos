import { useEffect, useMemo, useState } from 'react';

/**
 * Single source of truth for the mobile-pairing QR/text payload.
 *
 * Shape: `{ v: 1, type: 'mobipos-pair', url, token, ts }`. Credentials are
 * trimmed here so every builder normalizes identically.
 *
 * Security (do NOT "optimize" away): `ts` is minted fresh per payload and the
 * mobile side rejects codes older than PAIRING_QR_FRESHNESS_MS
 * (MobilePairingWizard — photo/screenshot/clipboard copies must expire).
 * Never memoize a built string across mounts or sessions without an explicit
 * expiry. Per-mount stability (mint once, expire visibly, re-entry mints
 * fresh) is the intended shape — see usePairingPayload.
 */

/** Codes older than this are rejected by the mobile wizard (15 minutes). */
export const PAIRING_QR_FRESHNESS_MS = 15 * 60_000;

/** Codes this far in the future are rejected (clock skew tolerance, 5 min). */
export const PAIRING_QR_FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Build one pairing payload, minting a fresh `ts` per call. */
export function buildPairingPayload(url: string, token: string, now: number = Date.now()): string {
  return JSON.stringify({
    v: 1,
    type: 'mobipos-pair',
    url: url.trim(),
    token: token.trim(),
    ts: now,
  });
}

/** Extract the `ts` stamp from a built payload, or null when absent/invalid. */
export function parsePairingTimestamp(payload: string): number | null {
  try {
    const ts = Number((JSON.parse(payload) as { ts?: unknown } | null)?.ts);
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  } catch {
    return null;
  }
}

/** Whole minutes of validity left for a minted stamp (0 once expired). */
export function pairingMinutesLeft(mintedAt: number, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((PAIRING_QR_FRESHNESS_MS - (now - mintedAt)) / 60_000));
}

export interface PairingPayload {
  /** Stable display/copy string ('' when credentials are missing). */
  payload: string;
  /** `ts` embedded in `payload`, or null when payload is empty. */
  mintedAt: number | null;
  /** Mint a fresh code (resets the 15-minute window). */
  refresh: () => void;
}

/**
 * Stable-per-mount pairing payload with a 30 s validity ticker.
 * The string is built once per credentials/nonce (no per-render `ts` churn,
 * so the copied text always equals the displayed QR), and `refresh()`
 * re-mints after expiry — re-opening the surface mints fresh automatically.
 */
export function usePairingPayload(url: string, token: string, ready: boolean): PairingPayload {
  const [nonce, setNonce] = useState(0);
  // Ticker only forces a re-render so the validity hint counts down.
  const [, setTick] = useState(0);
  const payload = useMemo(
    () => (ready && url && token ? buildPairingPayload(url, token) : ''),
    // nonce (via refresh) intentionally re-mints; ts is NOT recomputed per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, url, token, nonce],
  );
  const mintedAt = useMemo(() => (payload ? parsePairingTimestamp(payload) : null), [payload]);
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [ready]);
  return { payload, mintedAt, refresh: () => setNonce((n) => n + 1) };
}

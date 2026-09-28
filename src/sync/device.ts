// Stable per-install device id (used for SyncManager auth + audit).
// plugin-sql rows use their own app_settings id for authorship; this id is for
// the sync transport. Both identify the device; they may differ in sandbox v1.

const KEY = 'mobi_pos_device_id';

/**
 * In-memory stable copy. Storage hiccups (private browsing, transient
 * quota/permission failures, mid-write eviction) must never rotate the
 * device identity mid-session: a rotated id re-authors rows and splits the
 * entity version clocks, forking the merchant's sync history (C6).
 */
let memoryCachedId: string | null = null;

function readStoredId(): string | null {
  try {
    const existing = localStorage.getItem(KEY);
    // Regenerate ONLY when truly absent: empty/whitespace strings are treated
    // as absent, but any non-empty stored value is kept verbatim (even if it
    // looks odd — stability beats format-policing an established identity).
    if (existing && existing.trim().length > 0) return existing;
    return null;
  } catch {
    // Safe to ignore per R5.1: storage unreadable, fall through to cache.
    return null;
  }
}

export function getDeviceId(): string {
  // 1. Session truth: once resolved, the id never changes under us.
  if (memoryCachedId) return memoryCachedId;
  // 2. Stored truth: adopt the persisted id when present.
  const stored = readStoredId();
  if (stored) {
    memoryCachedId = stored;
    return stored;
  }
  // 3. Truly absent everywhere: mint once, persist best-effort, and keep the
  // minted value in memory so a failed write still yields a STABLE id for
  // this session instead of a fresh ephemeral one per call.
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `dev-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  memoryCachedId = id;
  try {
    // Re-check under the write: a concurrent tab may have stored an id
    // between our read and this write — adopt theirs, keep ours as fallback.
    const raced = readStoredId();
    if (raced) {
      memoryCachedId = raced;
      return raced;
    }
    localStorage.setItem(KEY, id);
  } catch {
    // Safe to ignore per R5.1: memory cache above keeps the session stable.
  }
  return memoryCachedId;
}

/**
 * Single stable device identity for the whole sync protocol (ADR-0008).
 * Prefers the SQLite authorship id — the same value stamped on every row
 * this device writes — and falls back to the localStorage transport id when
 * SQLite is unavailable (plain web preview). Never throws.
 */
export async function getStableDeviceId(): Promise<string> {
  try {
    const { getSyncDeviceId } = await import('../db/sqlPluginAdapter');
    const id = await getSyncDeviceId();
    if (id) return id;
  } catch {
    // Fall through to the transport id.
  }
  return getDeviceId();
}

// Stable per-install device id (used for SyncManager auth + audit).
// plugin-sql rows use their own app_settings id for authorship; this id is for
// the sync transport. Both identify the device; they may differ in sandbox v1.

const KEY = 'mobi_pos_device_id';

export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
  } catch {
    // Safe to ignore per R5.1: Private browsing restriction fallback.
  }
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `dev-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Safe to ignore per R5.1: Ephemeral device ID will be returned if storage is disabled.
  }
  return id;
}

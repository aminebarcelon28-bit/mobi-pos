import React from 'react';
// P11.3: the sync engine (~267 kB: turso client + sql adapter) must not sit in
// the entry chunk. Subscribe lazily — status arrives a tick after first paint.
import type { SyncStatus } from '../sync/types';

const initial: SyncStatus = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pushing: false, pulling: false, pendingCount: 0,
  lastPushAt: null, lastPullAt: null, lastError: null,
};

/** Subscribe to background sync status (pending count, online, errors). */
export function useSyncStatus(): SyncStatus {
  const [status, setStatus] = React.useState<SyncStatus>(initial);
  React.useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    import('../sync/SyncManager')
      .then(({ syncManager }) => {
        if (cancelled) return;
        unsub = syncManager.subscribe(setStatus);
      })
      .catch((err: unknown) => console.warn('[syncStatus] engine unavailable:', err));
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);
  return status;
}

import React from 'react';
import { syncManager } from '../sync/SyncManager';
import type { SyncStatus } from '../sync/types';

const initial: SyncStatus = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pushing: false, pulling: false, pendingCount: 0,
  lastPushAt: null, lastPullAt: null, lastError: null,
};

/** Subscribe to background sync status (pending count, online, errors). */
export function useSyncStatus(): SyncStatus {
  const [status, setStatus] = React.useState<SyncStatus>(initial);
  React.useEffect(() => syncManager.subscribe(setStatus), []);
  return status;
}

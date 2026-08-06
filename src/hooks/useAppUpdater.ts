import { useState, useEffect, useCallback } from 'react';

export interface UpdateInfo {
  version: string;
  body?: string;
  date?: string;
}

export function useAppUpdater() {
  const [isUpdateAvailable, setIsUpdateAvailable] = useState<boolean>(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [downloading, setDownloading] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [readyToRelaunch, setReadyToRelaunch] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingUpdateObj, setPendingUpdateObj] = useState<any>(null);

  const checkForUpdates = useCallback(async () => {
    try {
      setError(null);
      // Dynamic import to support web fallback gracefully
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();

      if (update && update.available) {
        setIsUpdateAvailable(true);
        setPendingUpdateObj(update);
        setUpdateInfo({
          version: update.version,
          body: update.body || 'Nouvelle version de MobiPOS disponible avec des améliorations et des correctifs.',
          date: update.date,
        });
      } else {
        setIsUpdateAvailable(false);
      }
    } catch (err: any) {
      // In web browser or unconfigured environment, fail silently or set error
      console.warn('Tauri Updater check skipped or failed:', err);
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    if (!pendingUpdateObj) return;

    try {
      setDownloading(true);
      setError(null);
      setProgress(0);

      let downloadedBytes = 0;
      let totalBytes = 0;

      await pendingUpdateObj.downloadAndInstall((event: any) => {
        if (event.event === 'Started') {
          totalBytes = event.data.contentLength || 0;
        } else if (event.event === 'Progress') {
          downloadedBytes += event.data.chunkLength || 0;
          if (totalBytes > 0) {
            const pct = Math.round((downloadedBytes / totalBytes) * 100);
            setProgress(pct);
          }
        } else if (event.event === 'Finished') {
          setProgress(100);
        }
      });

      setDownloading(false);
      setReadyToRelaunch(true);
    } catch (err: any) {
      setDownloading(false);
      setError(err?.message || 'Échec du téléchargement de la mise à jour.');
    }
  }, [pendingUpdateObj]);

  const relaunchApp = useCallback(async () => {
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err: any) {
      console.error('Failed to relaunch application:', err);
    }
  }, []);

  useEffect(() => {
    checkForUpdates();
  }, [checkForUpdates]);

  return {
    isUpdateAvailable,
    updateInfo,
    downloading,
    progress,
    readyToRelaunch,
    error,
    checkForUpdates,
    downloadAndInstall,
    relaunchApp,
    dismissUpdate: () => setIsUpdateAvailable(false),
  };
}

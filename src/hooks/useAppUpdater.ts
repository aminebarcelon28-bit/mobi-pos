import { useState, useEffect, useCallback, useRef } from 'react';
import { APP_VERSION } from '../types/pos';
import type { Update } from '@tauri-apps/plugin-updater';

export interface UpdateInfo {
  version: string;
  body?: string;
  date?: string;
}

/**
 * SemVer comparison utility to verify if remoteVersion is strictly newer than currentVersion.
 * Prevents false positive update prompts when versions are identical or formatted differently.
 */
export function isNewerVersion(remoteVersionStr?: string, currentVersionStr?: string): boolean {
  if (!remoteVersionStr || !currentVersionStr) return false;

  const clean = (v: string) => v.trim().replace(/^v/i, '').split('-')[0];
  const remoteParts = clean(remoteVersionStr).split('.').map((p) => parseInt(p, 10) || 0);
  const currentParts = clean(currentVersionStr).split('.').map((p) => parseInt(p, 10) || 0);

  const maxLength = Math.max(remoteParts.length, currentParts.length, 3);
  for (let i = 0; i < maxLength; i++) {
    const r = remoteParts[i] || 0;
    const c = currentParts[i] || 0;
    if (r > c) return true;
    if (r < c) return false;
  }
  return false;
}

function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function useAppUpdater() {
  const [isUpdateAvailable, setIsUpdateAvailable] = useState<boolean>(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [downloading, setDownloading] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [readyToRelaunch, setReadyToRelaunch] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [checkStatusMessage, setCheckStatusMessage] = useState<string | null>(null);

  const pendingUpdateRef = useRef<Update | null>(null);

  const checkForUpdates = useCallback(async (isManual: boolean = false) => {
    if (!isTauriEnvironment()) {
      if (isManual) {
        setCheckStatusMessage('Mise à jour non supportée en mode Web / Navigateur.');
      }
      return;
    }

    try {
      setIsChecking(true);
      setError(null);
      setCheckStatusMessage(null);

      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check({
        timeout: 10000, // 10s network timeout
      });

      const currentVer = update?.currentVersion || APP_VERSION;
      const hasNewerVersion = update && update.version && isNewerVersion(update.version, currentVer);

      if (hasNewerVersion && update) {
        pendingUpdateRef.current = update;
        setIsUpdateAvailable(true);
        setUpdateInfo({
          version: update.version,
          body: update.body || 'Nouvelle version de MobiPOS disponible avec des améliorations et des correctifs de stabilité.',
          date: update.date,
        });
        setCheckStatusMessage(`Mise à jour v${update.version} disponible !`);
      } else {
        pendingUpdateRef.current = null;
        setIsUpdateAvailable(false);
        setCheckStatusMessage('Vous utilisez déjà la version la plus récente de MobiPOS.');
      }
    } catch (err: any) {
      console.warn('Tauri Updater check skipped or failed:', err);
      pendingUpdateRef.current = null;
      setIsUpdateAvailable(false);
      const msg = err?.message || 'Impossible de joindre le serveur de mise à jour GitHub.';
      if (isManual) {
        setError(msg);
        setCheckStatusMessage(`Vérification échouée : ${msg}`);
      }
    } finally {
      setIsChecking(false);
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const update = pendingUpdateRef.current;
    if (!update) return;

    try {
      setDownloading(true);
      setError(null);
      setProgress(0);

      let downloadedBytes = 0;
      let totalBytes = 0;

      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          totalBytes = event.data.contentLength || 0;
        } else if (event.event === 'Progress') {
          downloadedBytes += event.data.chunkLength || 0;
          if (totalBytes > 0) {
            const pct = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
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
      setError(err?.message || 'Échec du téléchargement et de l\'installation de la mise à jour.');
    }
  }, []);

  const relaunchApp = useCallback(async () => {
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err: any) {
      console.error('Failed to relaunch application:', err);
    }
  }, []);

  useEffect(() => {
    // Initial check on startup
    checkForUpdates(false);

    // Periodic check every 4 hours
    const interval = setInterval(() => {
      checkForUpdates(false);
    }, 4 * 60 * 60 * 1000);

    return () => clearInterval(interval);
  }, [checkForUpdates]);

  return {
    isUpdateAvailable,
    updateInfo,
    downloading,
    progress,
    readyToRelaunch,
    error,
    isChecking,
    checkStatusMessage,
    checkForUpdates: (isManual: boolean = true) => checkForUpdates(isManual),
    downloadAndInstall,
    relaunchApp,
    dismissUpdate: () => setIsUpdateAvailable(false),
  };
}

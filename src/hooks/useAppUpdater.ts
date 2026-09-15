import { useState, useEffect, useCallback, useRef } from 'react';
import { APP_VERSION } from '../types/pos';
import type { Update } from '@tauri-apps/plugin-updater';
import { isMobileDevice, isAndroid, isIOS, isTauriEnvironment } from '../utils/platform';

export interface UpdateInfo {
  version: string;
  body?: string;
  date?: string;
  downloadUrl?: string;
  isMobile?: boolean;
}

const GITHUB_LATEST_RELEASE_URL = 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest';
const GITHUB_API_LATEST_RELEASE_URL = 'https://api.github.com/repos/aminebarcelon28-bit/mobi-pos/releases/latest';

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
    try {
      setIsChecking(true);
      setError(null);
      setCheckStatusMessage(null);

      const isMobile = isMobileDevice();

      // 1. On desktop Tauri, attempt native plugin updater first
      if (!isMobile && isTauriEnvironment()) {
        try {
          const { check } = await import('@tauri-apps/plugin-updater');
          const update = await check({
            timeout: 10000,
          });

          if (update) {
            const currentVer = update.currentVersion || APP_VERSION;
            const hasNewerVersion = update.version && isNewerVersion(update.version, currentVer);

            if (hasNewerVersion) {
              pendingUpdateRef.current = update;
              setIsUpdateAvailable(true);
              setUpdateInfo({
                version: update.version,
                body: update.body || 'Nouvelle version de MobiPOS disponible avec des améliorations et des correctifs de stabilité.',
                date: update.date,
                downloadUrl: GITHUB_LATEST_RELEASE_URL,
                isMobile: false,
              });
              setCheckStatusMessage(`Mise à jour v${update.version} disponible !`);
              return;
            } else {
              pendingUpdateRef.current = null;
              setIsUpdateAvailable(false);
              setCheckStatusMessage(`✅ Vous utilisez déjà la version de production la plus récente (v${APP_VERSION}).`);
              return;
            }
          } else {
            // Native updater returned null -> perfectly up to date!
            pendingUpdateRef.current = null;
            setIsUpdateAvailable(false);
            setCheckStatusMessage(`✅ Votre système est à jour. Version installée : v${APP_VERSION}.`);
            return;
          }
        } catch (pluginErr) {
          console.warn('Tauri native updater check skipped or failed, falling back to GitHub API check:', pluginErr);
        }
      }

      // 2. CORS-compliant GitHub REST API check (Works on Mobile Android/iOS, Web, and desktop fallback)
      const res = await fetch(GITHUB_API_LATEST_RELEASE_URL, {
        cache: 'no-cache',
        headers: { Accept: 'application/vnd.github.v3+json' },
      });

      if (!res.ok) {
        if (res.status === 403 || res.status === 429) {
          throw new Error('Limite de requêtes GitHub atteinte. Réessayez dans un instant.');
        }
        throw new Error(`Serveur GitHub indisponible (statut ${res.status})`);
      }

      const releaseData = await res.json();
      const rawTag: string = releaseData?.tag_name || '';
      const remoteVer = rawTag.replace(/^v/i, '').trim();

      if (remoteVer && isNewerVersion(remoteVer, APP_VERSION)) {
        pendingUpdateRef.current = null; // Direct download
        const targetDownloadUrl = isAndroid()
          ? 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-Android.apk'
          : isIOS()
          ? 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-iOS.ipa'
          : GITHUB_LATEST_RELEASE_URL;

        setIsUpdateAvailable(true);
        setUpdateInfo({
          version: remoteVer,
          body: releaseData.body || 'Nouvelle version de MobiPOS disponible avec des améliorations et des correctifs de stabilité.',
          date: releaseData.published_at,
          downloadUrl: targetDownloadUrl,
          isMobile: isMobile,
        });
        setCheckStatusMessage(`🚀 Nouvelle mise à jour v${remoteVer} disponible !`);
      } else {
        pendingUpdateRef.current = null;
        setIsUpdateAvailable(false);
        setCheckStatusMessage(`✅ Votre système est synchronisé avec la version la plus récente (v${APP_VERSION}).`);
      }
    } catch (err: unknown) {
      console.warn('Update check failed:', err);
      pendingUpdateRef.current = null;
      setIsUpdateAvailable(false);
      const msg = err instanceof Error ? err.message : 'Impossible de joindre le serveur de mise à jour GitHub.';
      if (isManual) {
        setError(msg);
        setCheckStatusMessage(`Vérification : ${msg}`);
      }
    } finally {
      setIsChecking(false);
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const update = pendingUpdateRef.current;
    if (!update) {
      // Direct external download fallback
      window.open(updateInfo?.downloadUrl || GITHUB_LATEST_RELEASE_URL, '_blank');
      return;
    }

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
    } catch (err: unknown) {
      setDownloading(false);
      setError(err instanceof Error ? err.message : 'Échec du téléchargement et de l\'installation de la mise à jour.');
    }
  }, [updateInfo]);

  const relaunchApp = useCallback(async () => {
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err: unknown) {
      console.error('Failed to relaunch application:', err);
      window.location.reload();
    }
  }, []);

  const openDownloadPage = useCallback((url?: string) => {
    let target = url || updateInfo?.downloadUrl;
    if (!target) {
      if (isAndroid()) {
        target = 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-Android.apk';
      } else if (isIOS()) {
        target = 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-iOS.ipa';
      } else {
        target = GITHUB_LATEST_RELEASE_URL;
      }
    }
    if (typeof window !== 'undefined') {
      window.open(target, '_blank');
    }
  }, [updateInfo]);

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
    hasNativeInstaller: Boolean(pendingUpdateRef.current),
    isMobile: isMobileDevice(),
    isAndroidDevice: isAndroid(),
    isIOSDevice: isIOS(),
    checkForUpdates: (isManual: boolean = true) => checkForUpdates(isManual),
    downloadAndInstall,
    relaunchApp,
    openDownloadPage,
    dismissUpdate: () => setIsUpdateAvailable(false),
  };
}

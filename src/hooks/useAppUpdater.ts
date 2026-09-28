import { useState, useEffect, useCallback } from 'react';
import { APP_VERSION } from '../types/pos';
import { checkNativeUpdate, relaunchApp as relaunchAppNative, type Update } from '../platform/updater';
import { isMobileDevice, isAndroid, isIOS, isTauriEnvironment } from '../utils/platform';

export interface UpdateInfo {
  version: string;
  body?: string;
  date?: string;
  downloadUrl?: string;
  isMobile?: boolean;
}

export interface CheckUpdateResult {
  success: boolean;
  hasUpdate: boolean;
  version?: string;
  message: string;
}

export const GITHUB_LATEST_RELEASE_URL = 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest';
export const GITHUB_API_LATEST_RELEASE_URL = 'https://api.github.com/repos/aminebarcelon28-bit/mobi-pos/releases/latest';

/**
 * Universal safe external URL opener and file downloader.
 * Supports desktop Tauri, mobile Android WebViews, iOS WKWebView, and standard web browsers.
 */
export function openExternalUrl(url: string): void {
  if (!url || typeof window === 'undefined') return;

  try {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    if (url.endsWith('.apk') || url.endsWith('.ipa') || url.endsWith('.exe')) {
      const name = url.split('/').pop() || 'download';
      link.setAttribute('download', name);
    }
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch {
    // fallback
  }

  // Secondary fallback for Android WebView or environments where synthetic click is blocked
  try {
    if (url.endsWith('.apk') || url.endsWith('.ipa')) {
      window.location.href = url;
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  } catch {
    window.location.href = url;
  }
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

interface SharedUpdaterState {
  isUpdateAvailable: boolean;
  updateInfo: UpdateInfo | null;
  downloading: boolean;
  progress: number;
  readyToRelaunch: boolean;
  error: string | null;
  isChecking: boolean;
  checkStatusMessage: string | null;
}

let sharedState: SharedUpdaterState = {
  isUpdateAvailable: false,
  updateInfo: null,
  downloading: false,
  progress: 0,
  readyToRelaunch: false,
  error: null,
  isChecking: false,
  checkStatusMessage: null,
};

let pendingUpdate: Update | null = null;
const listeners = new Set<() => void>();

function setSharedState(partial: Partial<SharedUpdaterState>) {
  sharedState = { ...sharedState, ...partial };
  listeners.forEach((l) => l());
}

export function useAppUpdater() {
  const [state, setState] = useState<SharedUpdaterState>(sharedState);

  useEffect(() => {
    const listener = () => setState(sharedState);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const openDownloadPage = useCallback((url?: string) => {
    let target = url || sharedState.updateInfo?.downloadUrl;
    if (!target) {
      if (isAndroid()) {
        target = 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-Android.apk';
      } else if (isIOS()) {
        target = 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-iOS.ipa';
      } else {
        target = GITHUB_LATEST_RELEASE_URL;
      }
    }
    openExternalUrl(target);
  }, []);

  const checkForUpdates = useCallback(async (isManual: boolean = false): Promise<CheckUpdateResult> => {
    try {
      setSharedState({ isChecking: true, error: null, checkStatusMessage: null });

      const isMobile = isMobileDevice();

      // 1. On desktop Tauri, attempt native plugin updater first
      if (!isMobile && isTauriEnvironment()) {
        try {
          const update = await checkNativeUpdate({ timeout: 10000 });

          if (update) {
            const currentVer = update.currentVersion || APP_VERSION;
            const hasNewerVersion = update.version && isNewerVersion(update.version, currentVer);

            if (hasNewerVersion) {
              pendingUpdate = update;
              const info: UpdateInfo = {
                version: update.version,
                body: update.body || 'Nouvelle version de MobiPOS disponible avec des améliorations et des correctifs de stabilité.',
                date: update.date,
                downloadUrl: GITHUB_LATEST_RELEASE_URL,
                isMobile: false,
              };
              setSharedState({
                isUpdateAvailable: true,
                updateInfo: info,
                checkStatusMessage: `Mise à jour v${update.version} disponible !`,
              });
              return {
                success: true,
                hasUpdate: true,
                version: update.version,
                message: `Mise à jour v${update.version} disponible !`,
              };
            } else {
              pendingUpdate = null;
              setSharedState({
                isUpdateAvailable: false,
                checkStatusMessage: `✅ Vous utilisez déjà la version de production la plus récente (v${APP_VERSION}).`,
              });
              return {
                success: true,
                hasUpdate: false,
                version: APP_VERSION,
                message: `Votre application est parfaitement à jour (Version v${APP_VERSION}).`,
              };
            }
          } else {
            // Native updater returned null -> perfectly up to date!
            pendingUpdate = null;
            setSharedState({
              isUpdateAvailable: false,
              checkStatusMessage: `✅ Votre système est à jour. Version installée : v${APP_VERSION}.`,
            });
            return {
              success: true,
              hasUpdate: false,
              version: APP_VERSION,
              message: `Votre application est parfaitement à jour (Version v${APP_VERSION}).`,
            };
          }
        } catch (pluginErr) {
          console.warn('Tauri native updater check skipped or failed, falling back to GitHub API check:', pluginErr);
        }
      }

      // 2. CORS-compliant GitHub REST API check (Works on Mobile Android/iOS, Web, and desktop fallback)
      // api.github.com sends `Access-Control-Allow-Origin: *`, so plain `mode: 'cors'`
      // works from http(s) web, Android WebView, iOS WKWebView and Tauri WebView
      // (CSP `connect-src https:` already allows it — no opener/fetch permission needed).
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      let res: Response;
      try {
        res = await fetch(GITHUB_API_LATEST_RELEASE_URL, {
          mode: 'cors',
          cache: 'no-store',
          signal: controller.signal,
          headers: { Accept: 'application/vnd.github.v3+json' },
        });
      } catch (fetchErr: unknown) {
        if (fetchErr instanceof DOMException && fetchErr.name === 'AbortError') {
          throw new Error('Délai de connexion GitHub dépassé. Vérifiez votre connexion.');
        }
        // TypeError: offline, DNS, adblock, or CORS blocked — keep message actionable
        throw new Error('Impossible de joindre GitHub. Vérifiez votre connexion internet.');
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        if (res.status === 404) {
          throw new Error('Aucune version publiée pour le moment.');
        }
        if (res.status === 403 || res.status === 429) {
          const retryAfter = res.headers.get('retry-after');
          const reset = res.headers.get('x-ratelimit-reset');
          let suffix = 'Réessayez dans un instant.';
          if (retryAfter) {
            suffix = `Réessayez dans ${retryAfter}s.`;
          } else if (reset) {
            const waitSec = Number(reset) * 1000 - Date.now();
            if (Number.isFinite(waitSec) && waitSec > 0) {
              const waitMin = Math.max(1, Math.ceil(waitSec / 60000));
              suffix = `Réessayez dans ~${waitMin} min.`;
            }
          }
          throw new Error(`Limite de requêtes GitHub atteinte. ${suffix}`);
        }
        if (res.status >= 500) {
          throw new Error(`GitHub momentanément indisponible (statut ${res.status}). Réessayez.`);
        }
        throw new Error(`Serveur GitHub indisponible (statut ${res.status})`);
      }

      const releaseData = await res.json();
      const rawTag: string = releaseData?.tag_name || '';
      const remoteVer = rawTag.replace(/^v/i, '').trim();

      if (remoteVer && isNewerVersion(remoteVer, APP_VERSION)) {
        pendingUpdate = null; // Direct download
        const targetDownloadUrl = isAndroid()
          ? 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-Android.apk'
          : isIOS()
          ? 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-iOS.ipa'
          : GITHUB_LATEST_RELEASE_URL;

        const info: UpdateInfo = {
          version: remoteVer,
          body: releaseData.body || 'Nouvelle version de MobiPOS disponible avec des améliorations et des correctifs de stabilité.',
          date: releaseData.published_at,
          downloadUrl: targetDownloadUrl,
          isMobile: isMobile,
        };

        setSharedState({
          isUpdateAvailable: true,
          updateInfo: info,
          checkStatusMessage: `🚀 Nouvelle mise à jour v${remoteVer} disponible !`,
        });
        return {
          success: true,
          hasUpdate: true,
          version: remoteVer,
          message: `Nouvelle mise à jour v${remoteVer} disponible !`,
        };
      } else {
        pendingUpdate = null;
        setSharedState({
          isUpdateAvailable: false,
          checkStatusMessage: `✅ Votre système est synchronisé avec la version la plus récente (v${APP_VERSION}).`,
        });
        return {
          success: true,
          hasUpdate: false,
          version: APP_VERSION,
          message: `Votre application est parfaitement à jour (Version v${APP_VERSION}).`,
        };
      }
    } catch (err: unknown) {
      console.warn('Update check failed:', err);
      pendingUpdate = null;
      const msg = err instanceof Error ? err.message : 'Impossible de joindre le serveur de mise à jour GitHub.';
      setSharedState({
        isUpdateAvailable: false,
        error: isManual ? msg : null,
        checkStatusMessage: isManual ? `Vérification : ${msg}` : null,
      });
      return {
        success: false,
        hasUpdate: false,
        message: msg,
      };
    } finally {
      setSharedState({ isChecking: false });
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const update = pendingUpdate;
    if (!update) {
      // Direct external download fallback
      openDownloadPage();
      return;
    }

    try {
      setSharedState({ downloading: true, error: null, progress: 0 });

      let downloadedBytes = 0;
      let totalBytes = 0;

      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          totalBytes = event.data.contentLength || 0;
        } else if (event.event === 'Progress') {
          downloadedBytes += event.data.chunkLength || 0;
          if (totalBytes > 0) {
            const pct = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
            setSharedState({ progress: pct });
          }
        } else if (event.event === 'Finished') {
          setSharedState({ progress: 100 });
        }
      });

      setSharedState({ downloading: false, readyToRelaunch: true });
    } catch (err: unknown) {
      setSharedState({
        downloading: false,
        error: err instanceof Error ? err.message : "Échec du téléchargement et de l'installation de la mise à jour.",
      });
    }
  }, [openDownloadPage]);

  const relaunchApp = useCallback(async () => {
    try {
      await relaunchAppNative();
    } catch (err: unknown) {
      console.error('Failed to relaunch application:', err);
      window.location.reload();
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
    isUpdateAvailable: state.isUpdateAvailable,
    updateInfo: state.updateInfo,
    downloading: state.downloading,
    progress: state.progress,
    readyToRelaunch: state.readyToRelaunch,
    error: state.error,
    isChecking: state.isChecking,
    checkStatusMessage: state.checkStatusMessage,
    hasNativeInstaller: Boolean(pendingUpdate),
    isMobile: isMobileDevice(),
    isAndroidDevice: isAndroid(),
    isIOSDevice: isIOS(),
    checkForUpdates: (isManual: boolean = true) => checkForUpdates(isManual),
    downloadAndInstall,
    relaunchApp,
    openDownloadPage,
    dismissUpdate: () => setSharedState({ isUpdateAvailable: false }),
  };
}

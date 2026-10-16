import React from 'react';
import {
  Sparkles,
  RefreshCcw,
  Download,
  RotateCcw,
  ExternalLink,
  ShieldCheck,
  Clock,
  Smartphone,
} from 'lucide-react';
import { useAppUpdater } from '../../../hooks/useAppUpdater';
import { APP_VERSION } from '../../../types/pos';
import { soundEngine } from '../../../utils/audioFeedback';

interface UpdatesSettingsTabProps {
  showToast: (msg: string, type?: 'success' | 'error' | 'info' | 'warning', duration?: number) => void;
}

export const UpdatesSettingsTab: React.FC<UpdatesSettingsTabProps> = ({ showToast }) => {
  const updater = useAppUpdater();

  const handleCheckUpdates = async () => {
    soundEngine.playKeyBeep?.();
    showToast('Recherche des mises à jour en cours...', 'info', 2000);
    const res = await updater.checkForUpdates(true);
    if (!res?.hasUpdate) {
      showToast('Votre système est déjà à jour (dernière version stable).', 'success');
    }
  };

  const openExternalUrl = (url: string) => {
    try {
      window.open(url, '_blank');
    } catch {
      window.location.href = url;
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto py-2">
      {/* Executive Version Header Card */}
      <div className="bg-gradient-to-br from-purple-950/40 via-pos-card to-slate-900 border border-purple-500/30 rounded-2xl p-5 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
          <Sparkles className="w-32 h-32 text-purple-400" />
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 relative z-10">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-purple-500/25 shrink-0">
              <Sparkles className="w-6 h-6 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-black text-pos-text tracking-wide">MobiPOS Pro</h3>
                <span className="px-2.5 py-0.5 rounded-full bg-purple-500/20 border border-purple-500/40 text-purple-300 font-mono font-black text-xs">
                  v{APP_VERSION}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[10px] font-bold">
                  Canal Stable
                </span>
              </div>
              <p className="text-xs text-pos-muted mt-0.5">
                Système de Caisse & Gestion de Stock • Architecture Hybride Tauri 2.0 & SQLite WAL
              </p>
            </div>
          </div>

          {/* Check Updates Button */}
          <button
            type="button"
            onClick={handleCheckUpdates}
            disabled={updater.isChecking || updater.downloading}
            className="py-2.5 px-4 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-black flex items-center justify-center gap-2 transition shadow-lg shadow-purple-600/30 cursor-pointer disabled:opacity-50 active:scale-95 shrink-0"
          >
            <RefreshCcw className={`w-4 h-4 ${updater.isChecking ? 'animate-spin' : ''}`} />
            <span>{updater.isChecking ? 'Vérification en cours...' : 'Vérifier Mises à Jour'}</span>
          </button>
        </div>

        {/* Status Indicator Banner */}
        <div className="mt-4 pt-4 border-t border-pos-border/60 flex items-center gap-3">
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              updater.isUpdateAvailable ? 'bg-purple-400 animate-ping' : 'bg-emerald-400 animate-pulse'
            }`}
          />
          <p className="text-xs font-semibold text-pos-text">
            {updater.checkStatusMessage ||
              (updater.isUpdateAvailable
                ? `🚀 Version ${updater.updateInfo?.version} disponible au téléchargement !`
                : `✅ Votre système est synchronisé avec la version de production la plus récente (v${APP_VERSION}).`)}
          </p>
        </div>
      </div>

      {/* Update Action Panel (If Update Available) */}
      {updater.isUpdateAvailable && updater.updateInfo && (
        <div className="bg-pos-card border border-purple-500/60 rounded-2xl p-5 space-y-4 animate-in fade-in zoom-in-95">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-purple-500/20 text-purple-400 flex items-center justify-center border border-purple-500/40 shrink-0">
                <Download className="w-4 h-4" />
              </div>
              <div>
                <h4 className="text-sm font-black text-pos-text">
                  Mise à Jour v{updater.updateInfo.version} Prête
                </h4>
                <p className="text-[11px] text-pos-muted">
                  Date de publication : {updater.updateInfo.date || 'Récemment'}
                </p>
              </div>
            </div>

            {updater.hasNativeInstaller ? (
              !updater.readyToRelaunch ? (
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playKeyBeep?.();
                    showToast('Téléchargement et installation en cours...', 'info');
                    updater.downloadAndInstall();
                  }}
                  disabled={updater.downloading}
                  className="py-2.5 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl flex items-center gap-2 transition shadow-lg shadow-emerald-500/25 cursor-pointer disabled:opacity-50 active:scale-95 shrink-0"
                >
                  <Download className={`w-4 h-4 ${updater.downloading ? 'animate-bounce' : ''}`} />
                  <span>
                    {updater.downloading
                      ? `Téléchargement (${updater.progress}%)...`
                      : 'Télécharger & Installer'}
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playKeyBeep?.();
                    updater.relaunchApp();
                  }}
                  className="py-2.5 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl flex items-center gap-2 transition shadow-lg shadow-emerald-500/25 cursor-pointer active:scale-95 shrink-0"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>Redémarrer l'App</span>
                </button>
              )
            ) : updater.isAndroidDevice ? (
              <a
                href={
                  updater.updateInfo.downloadUrl ||
                  'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-Android.apk'
                }
                download="MobiPOS-Android.apk"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  showToast("Téléchargement de l'APK Android démarré...", 'info');
                  updater.openDownloadPage();
                }}
                className="py-2.5 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl flex items-center gap-2 transition shadow-lg shadow-emerald-500/25 cursor-pointer no-underline active:scale-95 shrink-0"
              >
                <Download className="w-4 h-4" />
                <span>Télécharger l'APK v{updater.updateInfo.version}</span>
              </a>
            ) : (
              <a
                href={
                  updater.updateInfo.downloadUrl ||
                  'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest'
                }
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  showToast('Ouverture de la page de téléchargement...', 'info');
                  updater.openDownloadPage();
                }}
                className="py-2.5 px-4 bg-purple-600 hover:bg-purple-500 text-white font-black text-xs rounded-xl flex items-center gap-2 transition shadow-lg shadow-purple-600/25 cursor-pointer no-underline active:scale-95 shrink-0"
              >
                <Download className="w-4 h-4" />
                <span>Télécharger la Version</span>
              </a>
            )}
          </div>

          {/* Manual Reinstall Option */}
          <div className="pt-2 border-t border-pos-border/40 flex items-center justify-between text-xs text-pos-muted">
            <span>Problème de téléchargement direct ?</span>
            <button
              type="button"
              onClick={() =>
                openExternalUrl('https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest')
              }
              className="text-cyan-400 hover:underline flex items-center gap-1 font-semibold cursor-pointer"
            >
              <span>Ouvrir les Releases GitHub</span>
              <ExternalLink className="w-3 h-3" />
            </button>
          </div>

          {updater.downloading && (
            <div className="w-full bg-pos-panel h-2.5 rounded-full overflow-hidden border border-pos-border">
              <div
                className="bg-gradient-to-r from-purple-500 to-emerald-400 h-full transition-all duration-300 rounded-full"
                style={{ width: `${updater.progress}%` }}
              />
            </div>
          )}

          {updater.updateInfo.body && (
            <div className="p-3 bg-pos-bg/80 border border-pos-border rounded-xl text-xs text-pos-muted whitespace-pre-wrap font-sans">
              {updater.updateInfo.body}
            </div>
          )}
        </div>
      )}

      {/* Technical Information & Pipeline Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* How OTA Updates Work */}
        <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-2.5">
          <div className="flex items-center gap-2 text-pos-text font-bold text-xs">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>Sécurité & Signatures Cryptographiques</span>
          </div>
          <p className="text-[11px] text-pos-muted leading-relaxed">
            Chaque mise à jour déployée sur GitHub est vérifiée et validée par une signature
            cryptographique Minisign (clé publique intégrée). Aucune mise à jour corrompue ne peut être
            appliquée.
          </p>
        </div>

        {/* Pipeline Compilation Notice */}
        <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-2.5">
          <div className="flex items-center gap-2 text-pos-text font-bold text-xs">
            <Clock className="w-4 h-4 text-cyan-400" />
            <span>Cycle de Publication GitHub Actions</span>
          </div>
          <p className="text-[11px] text-pos-muted leading-relaxed">
            Lorsqu'une nouvelle version est publiée, le serveur GitHub CI/CD compile et génère
            automatiquement le paquet exécutable Windows et le fichier{' '}
            <code className="font-mono text-cyan-300">latest.json</code> (délai de 3 à 5 minutes).
          </p>
        </div>
      </div>

      {/* Manual Direct Download & Reinstall Card */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-purple-400 shrink-0">
            <Download className="w-4 h-4" />
          </div>
          <div>
            <span className="text-xs font-bold text-pos-text block">
              Installation Manuelle & Téléchargement Direct
            </span>
            <span className="text-[10px] text-pos-muted block">
              Télécharger l'APK mobile ou le paquet PC de la version v{APP_VERSION}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <a
            href="https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-Android.apk"
            download="MobiPOS-Android.apk"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              soundEngine.playKeyBeep?.();
              showToast("Téléchargement de l'APK Android démarré...", 'info');
            }}
            className="flex-1 sm:flex-none py-2 px-3 rounded-xl bg-pos-panel border border-pos-border hover:border-emerald-500/40 text-pos-text text-xs font-bold flex items-center justify-center gap-1.5 transition active:scale-95 no-underline cursor-pointer"
          >
            <Smartphone className="w-3.5 h-3.5 text-emerald-400" />
            <span>APK Android</span>
          </a>

          <a
            href="https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              soundEngine.playKeyBeep?.();
              showToast('Ouverture des releases GitHub...', 'info');
            }}
            className="flex-1 sm:flex-none py-2 px-3 rounded-xl bg-pos-panel border border-pos-border hover:border-purple-500/40 text-pos-text text-xs font-bold flex items-center justify-center gap-1.5 transition active:scale-95 no-underline cursor-pointer"
          >
            <ExternalLink className="w-3.5 h-3.5 text-purple-400" />
            <span>Releases GitHub</span>
          </a>
        </div>
      </div>
    </div>
  );
};


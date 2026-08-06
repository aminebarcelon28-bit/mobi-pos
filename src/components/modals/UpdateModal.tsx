import React from 'react';
import { Sparkles, DownloadCloud, RotateCcw, X, CheckCircle2, AlertCircle } from 'lucide-react';
import { useAppUpdater } from '../../hooks/useAppUpdater';

export const UpdateModal: React.FC = () => {
  const {
    isUpdateAvailable,
    updateInfo,
    downloading,
    progress,
    readyToRelaunch,
    error,
    downloadAndInstall,
    relaunchApp,
    dismissUpdate,
  } = useAppUpdater();

  if (!isUpdateAvailable) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[100] flex items-center justify-center p-4 select-none animate-in fade-in">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-in zoom-in-95 flex flex-col">
        {/* Header */}
        <div className="p-5 border-b border-pos-border bg-gradient-to-r from-blue-950/40 via-pos-card to-purple-950/40 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-500/20 text-blue-400 flex items-center justify-center border border-blue-500/30 shadow-lg">
              <Sparkles className="w-5 h-5 animate-pulse text-blue-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-extrabold text-pos-text tracking-wide">
                  Mise à Jour Disponible
                </h2>
                <span className="px-2 py-0.5 rounded-full bg-blue-500/20 border border-blue-500/40 text-blue-300 text-[10px] font-black uppercase font-mono">
                  {updateInfo?.version || 'Nouveau'}
                </span>
              </div>
              <p className="text-[11px] text-pos-muted">
                Une nouvelle version de MobiPOS est prête au téléchargement.
              </p>
            </div>
          </div>
          {!downloading && !readyToRelaunch && (
            <button
              onClick={dismissUpdate}
              className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-4">
          <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-2">
            <h3 className="text-xs font-bold text-pos-muted uppercase tracking-wider">
              Nouveautés & Modificateurs
            </h3>
            <div className="text-xs text-pos-text/90 font-sans leading-relaxed whitespace-pre-wrap max-h-36 overflow-y-auto pr-1">
              {updateInfo?.body || 'Performances optimisées, sécurité renforcée et corrections de bugs.'}
            </div>
          </div>

          {/* Error Banner */}
          {error && (
            <div className="p-3 border border-red-500/40 bg-red-950/40 rounded-xl text-xs text-red-300 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Download Progress Bar */}
          {downloading && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs font-bold">
                <span className="text-pos-muted flex items-center gap-1.5">
                  <DownloadCloud className="w-4 h-4 text-blue-400 animate-bounce" />
                  Téléchargement en cours...
                </span>
                <span className="text-blue-400 font-mono">{progress}%</span>
              </div>
              <div className="w-full bg-pos-bg rounded-full h-2.5 overflow-hidden border border-pos-border">
                <div
                  className="bg-gradient-to-r from-blue-500 to-indigo-500 h-full transition-all duration-300 rounded-full"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Ready to Relaunch State */}
          {readyToRelaunch && (
            <div className="p-4 border border-emerald-500/40 bg-emerald-950/30 rounded-xl text-xs text-emerald-300 flex items-center gap-3">
              <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
              <div>
                <p className="font-bold text-emerald-300">Mise à jour installée avec succès !</p>
                <p className="text-[11px] text-emerald-400/80 mt-0.5">
                  Redémarrez l'application pour appliquer les changements.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-pos-border bg-pos-card/80 flex items-center justify-end gap-2.5">
          {!readyToRelaunch && !downloading && (
            <>
              <button
                onClick={dismissUpdate}
                className="px-4 py-2 rounded-xl text-xs font-bold text-pos-muted hover:text-pos-text hover:bg-pos-hover transition"
              >
                Plus tard
              </button>
              <button
                onClick={downloadAndInstall}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-xs flex items-center gap-2 shadow-lg shadow-blue-500/25 transition cursor-pointer"
              >
                <DownloadCloud className="w-4 h-4" /> Mettre à jour maintenant
              </button>
            </>
          )}

          {readyToRelaunch && (
            <button
              onClick={relaunchApp}
              className="px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center gap-2 shadow-lg shadow-emerald-500/25 transition cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" /> Redémarrer l'application
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

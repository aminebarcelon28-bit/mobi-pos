import React, { useState, useCallback } from 'react';
import {
  Cloud,
  Key,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Eye,
  EyeOff,
  Clipboard,
  Smartphone,
  ArrowRight,
  Camera,
  X,
  QrCode,
} from 'lucide-react';
import { setCloudCredentials } from '../../sync/keychain';
import { testTursoConnection, type ConnectionTestResult } from '../../sync/tursoClient';
import { syncManager } from '../../sync/SyncManager';
import { getDeviceId } from '../../sync/device';
import { usePosStore } from '../../store/usePosStore';
import { useToast } from '../ui/Toast';
import { soundEngine } from '../../utils/audioFeedback';
import { MobileCameraScanner } from './MobileCameraScanner';

interface MobilePairingWizardProps {
  onPaired: () => void;
  onSkipDemo?: () => void;
  onClose?: () => void;
}

export const MobilePairingWizard: React.FC<MobilePairingWizardProps> = ({
  onPaired,
  onSkipDemo,
  onClose,
}) => {
  const { showToast } = useToast();
  const [mode, setMode] = useState<'camera' | 'paste' | 'manual'>('camera');
  const [qrText, setQrText] = useState('');
  const [dbUrl, setDbUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [showToken, setShowToken] = useState(false);

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionStep, setConnectionStep] = useState<string>('');

  // Execute full cloud pairing and database synchronization
  const executePairing = useCallback(async (targetUrl: string, targetToken: string) => {
    const trimmedUrl = targetUrl.trim();
    const trimmedToken = targetToken.trim();

    if (!trimmedUrl || !trimmedToken) {
      showToast('URL et Jeton d\'authentification requis', 'warning');
      return;
    }

    setIsConnecting(true);
    setConnectionStep('Vérification des accès cloud...');

    try {
      // 1. Verify credentials with Turso
      const test = await testTursoConnection(trimmedUrl, trimmedToken);
      if (!test.ok) {
        throw new Error(test.error || 'Connexion à la base de données refusée.');
      }

      setConnectionStep('Enregistrement sécurisé dans le trousseau...');
      await setCloudCredentials(trimmedUrl, trimmedToken);

      setConnectionStep('Synchronisation des données de la boutique...');
      await syncManager.start(getDeviceId());
      await syncManager.initialPull();
      await usePosStore.getState().initDatabase();

      soundEngine.playSuccess();
      showToast('Synchronisation réussie ! Votre boutique est prête.', 'success');
      onPaired();
    } catch (err) {
      console.error('Pairing error:', err);
      soundEngine.playError();
      const message = err instanceof Error ? err.message : 'Erreur de connexion Cloud';
      showToast(message, 'error');
      setConnectionStep('');
    } finally {
      setIsConnecting(false);
    }
  }, [onPaired, showToast]);

  // Handle scanned string from camera
  const handleScannedCode = useCallback((raw: string) => {
    if (isConnecting) return;

    try {
      // 1. Try JSON parsing
      const parsed = JSON.parse(raw);
      if (parsed.url && parsed.token) {
        setDbUrl(parsed.url);
        setAuthToken(parsed.token);
        executePairing(parsed.url, parsed.token);
        return;
      }
    } catch {
      // Not JSON
    }

    // 2. Direct libsql or https URL check
    if (raw.startsWith('libsql://') || raw.startsWith('https://')) {
      setDbUrl(raw);
      setMode('manual');
      showToast('URL détectée. Veuillez saisir le Token associé.', 'info');
      return;
    }

    showToast('Format de QR code non reconnu. Assurez-vous de scanner le QR code d\'appairage de la caisse.', 'error');
  }, [executePairing, isConnecting, showToast]);

  // Handle manual clipboard paste
  const handlePastePairingCode = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        showToast('Presse-papier vide', 'warning');
        return;
      }
      setQrText(text.trim());
      parseAndApplyPairingText(text.trim());
    } catch {
      showToast('Impossible d\'accéder au presse-papier', 'error');
    }
  };

  const parseAndApplyPairingText = (raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.url && parsed.token) {
        setDbUrl(parsed.url);
        setAuthToken(parsed.token);
        executePairing(parsed.url, parsed.token);
        return;
      }
    } catch {
      if (raw.startsWith('libsql://') || raw.startsWith('https://')) {
        setDbUrl(raw);
        setMode('manual');
        showToast('URL détectée. Entrez le jeton associé.', 'info');
      } else {
        showToast('Format de code non reconnu', 'error');
      }
    }
  };

  const handleTest = async () => {
    if (!dbUrl || !authToken) {
      showToast('Veuillez renseigner l\'URL et le Token', 'warning');
      return;
    }
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await testTursoConnection(dbUrl, authToken);
      setTestResult(res);
      if (res.ok) {
        showToast(`Connexion établie (${res.latencyMs} ms) !`, 'success');
      } else {
        showToast(res.error || 'Échec de connexion', 'error');
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Erreur réseau', 'error');
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-pos-bg text-pos-text flex flex-col justify-between p-4 overflow-y-auto font-sans">
      {/* Top Header */}
      <div className="space-y-3 pt-2 text-center relative max-w-sm mx-auto w-full">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="absolute -top-1 right-0 p-2 text-pos-muted hover:text-pos-text transition cursor-pointer"
            aria-label="Fermer"
          >
            <X className="w-5 h-5" />
          </button>
        )}

        <div className="w-12 h-12 mx-auto rounded-2xl bg-gradient-to-br from-cyan-500 to-emerald-500 flex items-center justify-center text-slate-950 shadow-lg shadow-emerald-500/20">
          <Smartphone className="w-6 h-6" />
        </div>

        <div>
          <h1 className="text-lg font-black text-pos-text tracking-tight">Synchronisation Mobile</h1>
          <p className="text-[11px] text-pos-muted mt-0.5">
            Liez votre smartphone à votre caisse pour synchroniser le catalogue et les ventes.
          </p>
        </div>

        {/* Mode Selector Tabs */}
        <div className="flex bg-pos-panel p-1 rounded-xl border border-pos-border">
          <button
            type="button"
            onClick={() => setMode('camera')}
            className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
              mode === 'camera'
                ? 'bg-cyan-500 text-slate-950 shadow-sm'
                : 'text-pos-muted hover:text-pos-text'
            }`}
          >
            <Camera className="w-3.5 h-3.5" />
            <span>Caméra</span>
          </button>

          <button
            type="button"
            onClick={() => setMode('paste')}
            className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
              mode === 'paste'
                ? 'bg-cyan-500 text-slate-950 shadow-sm'
                : 'text-pos-muted hover:text-pos-text'
            }`}
          >
            <Clipboard className="w-3.5 h-3.5" />
            <span>Coller</span>
          </button>

          <button
            type="button"
            onClick={() => setMode('manual')}
            className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
              mode === 'manual'
                ? 'bg-cyan-500 text-slate-950 shadow-sm'
                : 'text-pos-muted hover:text-pos-text'
            }`}
          >
            <Key className="w-3.5 h-3.5" />
            <span>Manuel</span>
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="my-3 max-w-sm w-full mx-auto flex-1 flex flex-col justify-center">
        {/* Active Connecting Overlay */}
        {isConnecting ? (
          <div className="bg-pos-panel border border-pos-border rounded-2xl p-6 text-center space-y-4 shadow-xl animate-in fade-in">
            <div className="w-14 h-14 mx-auto rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center animate-pulse">
              <RefreshCw className="w-7 h-7 animate-spin" />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-sm font-black text-pos-text">Appairage en cours...</h3>
              <p className="text-xs text-cyan-400 font-medium">{connectionStep || 'Connexion à la base...'}</p>
              <p className="text-[11px] text-pos-muted">
                Téléchargement du catalogue, des clients et des paramètres de votre boutique.
              </p>
            </div>
          </div>
        ) : mode === 'camera' ? (
          /* 1. Camera Live Viewfinder Mode */
          <div className="space-y-3">
            <div className="h-72 w-full rounded-2xl overflow-hidden relative shadow-inner">
              <MobileCameraScanner
                isActive={mode === 'camera' && !isConnecting}
                onScan={handleScannedCode}
              />
            </div>

            <div className="flex items-center justify-between text-[11px] px-1">
              <span className="text-pos-muted flex items-center gap-1">
                <QrCode className="w-3.5 h-3.5 text-cyan-400" />
                <span>Détection automatique dès le cadrage</span>
              </span>
              <button
                type="button"
                onClick={() => setMode('paste')}
                className="text-cyan-400 hover:underline font-bold cursor-pointer"
              >
                Coller le code &rarr;
              </button>
            </div>
          </div>
        ) : mode === 'paste' ? (
          /* 2. Clipboard Paste Mode */
          <div className="bg-pos-panel border border-pos-border rounded-2xl p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-pos-text">
              <QrCode className="w-4 h-4 text-cyan-400" />
              <span>Coller le code d'appairage depuis votre PC</span>
            </div>
            <p className="text-[11px] text-pos-muted leading-relaxed">
              Sur votre logiciel caisse PC, allez dans <strong className="text-pos-text">Paramètres &gt; Lier Smartphone &gt; Étape 2</strong> et copiez le code d'appairage.
            </p>

            <div className="space-y-2 pt-1">
              <textarea
                value={qrText}
                onChange={(e) => {
                  setQrText(e.target.value);
                  parseAndApplyPairingText(e.target.value);
                }}
                placeholder="Collez ici le code JSON généré par votre caisse PC..."
                rows={3}
                className="w-full bg-pos-bg border border-pos-border rounded-xl p-2.5 font-mono text-xs text-pos-text focus:outline-none focus:border-cyan-400 resize-none"
              />

              <button
                type="button"
                onClick={handlePastePairingCode}
                className="w-full py-2.5 px-3 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-xs font-bold text-pos-text flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <Clipboard className="w-3.5 h-3.5 text-cyan-400" />
                <span>Coller depuis le presse-papier</span>
              </button>
            </div>
          </div>
        ) : (
          /* 3. Manual Form Mode */
          <div className="bg-pos-panel border border-pos-border rounded-2xl p-4 space-y-3">
            <div>
              <label className="text-xs font-bold text-pos-muted block mb-1">URL de la base Turso :</label>
              <input
                type="text"
                value={dbUrl}
                onChange={(e) => setDbUrl(e.target.value)}
                placeholder="libsql://mobi-pos-boutique.turso.io"
                className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-mono text-pos-text focus:outline-none focus:border-cyan-400"
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-xs font-bold text-pos-muted">Jeton d'authentification :</label>
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="text-[10px] text-cyan-400 hover:underline flex items-center gap-1 cursor-pointer"
                >
                  {showToken ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  {showToken ? 'Masquer' : 'Afficher'}
                </button>
              </div>
              <input
                type={showToken ? 'text' : 'password'}
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder="eyJhbGciOiJFZERT..."
                className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-mono text-pos-text focus:outline-none focus:border-cyan-400"
              />
            </div>

            <button
              type="button"
              disabled={isTesting || !dbUrl || !authToken}
              onClick={handleTest}
              className="w-full py-2 px-3 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-xs font-bold text-pos-text flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-cyan-400 ${isTesting ? 'animate-spin' : ''}`} />
              <span>{isTesting ? 'Test en cours...' : 'Tester la Connexion'}</span>
            </button>

            {testResult && (
              <div
                className={`p-2.5 rounded-xl border text-xs flex items-center gap-2 ${
                  testResult.ok
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
                }`}
              >
                {testResult.ok ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 shrink-0" />
                )}
                <span className="font-medium">
                  {testResult.ok
                    ? `Base connectée (${testResult.latencyMs} ms).`
                    : testResult.error || 'Connexion échouée.'}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Security badge */}
        <div className="flex items-start gap-2 text-[10px] text-pos-muted px-2 mt-3">
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>
            Chiffrement de bout-en-bout. Vos identifiants restent stockés localement sur cet appareil dans le trousseau sécurisé.
          </span>
        </div>
      </div>

      {/* Bottom Actions */}
      <div className="max-w-sm w-full mx-auto space-y-2 pb-2">
        {mode === 'manual' && (
          <button
            type="button"
            disabled={isConnecting || !dbUrl || !authToken}
            onClick={() => executePairing(dbUrl, authToken)}
            className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 active:scale-[0.98] text-slate-950 font-black text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 transition cursor-pointer disabled:opacity-50"
          >
            <Cloud className="w-4 h-4" />
            <span>Enregistrer & Synchroniser</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        )}

        {onSkipDemo && !isConnecting && (
          <button
            type="button"
            onClick={onSkipDemo}
            className="w-full py-2 text-center text-xs text-pos-muted hover:text-pos-text font-medium cursor-pointer"
          >
            Continuer en Mode Démo Hors-Ligne
          </button>
        )}
      </div>
    </div>
  );
};

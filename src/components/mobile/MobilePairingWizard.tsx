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
import { setCloudCredentials, getCloudCredentials } from '../../sync/keychain';
import { testTursoConnection, type ConnectionTestResult } from '../../sync/tursoClient';
import { syncManager } from '../../sync/SyncManager';
import { getStableDeviceId } from '../../sync/device';
import { usePosStore } from '../../store/usePosStore';
import { useToast } from '../ui/Toast';
import { soundEngine } from '../../utils/audioFeedback';
import { MobileCameraScanner } from './MobileCameraScanner';
import { activateLicense } from '../../licensing/client';
import { isValidKeyFormat } from '../../licensing/keyFormat';

interface MobilePairingWizardProps {
  onPaired: () => void;
  onSkipDemo?: () => void;
  onClose?: () => void;
}

// Pairing QR freshness: the desktop QR embeds `ts: Date.now()`. A photo,
// screenshot or clipboard copy stays valid FOREVER unless checked — anyone
// holding one gets permanent DB credentials. Reject codes older than 15
// minutes (or >5 min in the future, i.e. clock skew): the operator simply
// re-opens the QR on the till for a fresh one. License-key payloads go
// through server-side activation instead and are exempt.
const PAIRING_QR_FRESHNESS_MS = 15 * 60_000;
const PAIRING_QR_FUTURE_TOLERANCE_MS = 5 * 60_000;

function pairingFreshnessError(parsed: unknown): string | null {
  const ts = Number((parsed as { ts?: unknown } | null)?.ts);
  if (!Number.isFinite(ts) || ts <= 0) {
    return 'Code d’appairage expiré ou invalide — réaffichez le QR sur la caisse puis scannez-le à nouveau.';
  }
  const age = Date.now() - ts;
  if (age > PAIRING_QR_FRESHNESS_MS || age < -PAIRING_QR_FUTURE_TOLERANCE_MS) {
    return 'Code d’appairage expiré — réaffichez le QR sur la caisse puis scannez-le à nouveau.';
  }
  return null;
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
  // Inline pairing error (plain French + retry) — complements the toast.
  const [pairingError, setPairingError] = useState<string | null>(null);

  // Progress step: 1 Scanner · 2 Vérifier · 3 Synchroniser (display only).
  const currentStep: 1 | 2 | 3 = isConnecting ? 3 : mode === 'camera' ? 1 : 2;
  const STEPS = [
    { n: 1 as const, label: 'Scanner' },
    { n: 2 as const, label: 'Vérifier' },
    { n: 3 as const, label: 'Synchroniser' },
  ];

  // Execute full cloud pairing and database synchronization
  const executePairing = useCallback(async (targetUrl: string, targetToken: string) => {
    const trimmedUrl = targetUrl.trim();
    const trimmedToken = targetToken.trim();

    if (!trimmedUrl || !trimmedToken) {
      showToast('URL et Jeton d\'authentification requis', 'warning');
      return;
    }

    // Degraded licence: no NEW pairings while expired/suspended (expanding an
    // unlicensed fleet is exactly what enforcement must prevent). Licence
    // activation itself stays reachable so the merchant can exit degraded.
    try {
      const { isSaleBlockedByLicense } = await import('../../licensing/degraded');
      if (isSaleBlockedByLicense()) {
        const msg = 'Appairage impossible : licence expirée — régularisez la licence sur la caisse principale.';
        setPairingError(msg);
        showToast(msg, 'error');
        return;
      }
    } catch {
      // Flag unreadable — fail open toward the credential check below, which
      // remains the authority (never invent a block on a read failure).
    }

    setIsConnecting(true);
    setConnectionStep('Vérification des accès cloud...');
    setPairingError(null);

    try {
      // 1. Verify credentials with Turso
      const test = await testTursoConnection(trimmedUrl, trimmedToken);
      if (!test.ok) {
        throw new Error(test.error || 'Connexion à la base de données refusée.');
      }

      setConnectionStep('Enregistrement sécurisé dans le trousseau...');
      await setCloudCredentials(trimmedUrl, trimmedToken);

      setConnectionStep('Synchronisation des données de la boutique...');
      await syncManager.start(await getStableDeviceId());
      await syncManager.initialPull();
      await usePosStore.getState().initDatabase();
      await usePosStore.getState().refreshAfterPull();

      // Paired + fully synced: a companion phone is a personal device the
      // merchant already unlocks at OS level — no app PIN wall from here on
      // (explicit lock + manager-PIN gates still apply).
      try {
        const { getDeviceRole, markCompanionTrusted } = await import('../../utils/platform');
        if (getDeviceRole() === 'companion_mobile') markCompanionTrusted();
      } catch {
        // Trust flag best-effort — worst case the lock screen shows once.
      }

      soundEngine.playSuccess();
      showToast('Synchronisation réussie ! Votre boutique est prête.', 'success');
      onPaired();
    } catch (err) {
      console.error('Pairing error:', err);
      soundEngine.playError();
      const message = err instanceof Error ? err.message : 'Erreur de connexion Cloud';
      showToast(message, 'error');
      // Plain-language inline error with retry (reuses executePairing below).
      setPairingError(
        'La liaison a échoué — vérifiez votre connexion Internet et que le code vient bien de votre caisse, puis touchez « Réessayer ».'
      );
      setConnectionStep('');
    } finally {
      setIsConnecting(false);
    }
  }, [onPaired, showToast]);

  // Handle scanned string from camera
  const handleScannedCode = useCallback((raw: string) => {
    if (isConnecting) return;
    const clean = raw.trim();

    try {
      // 1. Try JSON parsing
      const parsed = JSON.parse(clean);
      if (parsed.key) {
        setIsConnecting(true);
        setConnectionStep('Activation de la licence mobile...');
        activateLicense({ licenseKey: parsed.key, deviceType: 'mobile', friendlyName: 'Compagnon Mobile' })
          .then(async (actRes) => {
            if (!actRes.success) {
              throw new Error(actRes.message || 'Échec d’activation de la licence.');
            }
            const creds = await getCloudCredentials();
            if (creds && creds.url && creds.token) {
              await executePairing(creds.url, creds.token);
            } else {
              throw new Error('Identifiants cloud introuvables après activation.');
            }
          })
          .catch((err) => {
            soundEngine.playError();
            setPairingError(err.message || 'Erreur d’activation');
            setIsConnecting(false);
          });
        return;
      }
      if (parsed.url && parsed.token) {
        const stale = pairingFreshnessError(parsed);
        if (stale) {
          soundEngine.playError();
          setPairingError(stale);
          showToast(stale, 'error');
          return;
        }
        setDbUrl(parsed.url);
        setAuthToken(parsed.token);
        executePairing(parsed.url, parsed.token);
        return;
      }
    } catch {
      // Not JSON
    }

    // 2. Direct license key format check (e.g. MOBI-LIFE-XXXX-XXXX)
    if (isValidKeyFormat(clean)) {
      setIsConnecting(true);
      setConnectionStep('Activation de la licence mobile...');
      activateLicense({ licenseKey: clean, deviceType: 'mobile', friendlyName: 'Compagnon Mobile' })
        .then(async (actRes) => {
          if (!actRes.success) {
            throw new Error(actRes.message || 'Échec d’activation de la licence.');
          }
          const creds = await getCloudCredentials();
          if (creds && creds.url && creds.token) {
            await executePairing(creds.url, creds.token);
          } else {
            throw new Error('Identifiants cloud introuvables après activation.');
          }
        })
        .catch((err) => {
          soundEngine.playError();
          setPairingError(err.message || 'Erreur d’activation');
          setIsConnecting(false);
        });
      return;
    }

    // 3. Direct libsql or https URL check
    if (clean.startsWith('libsql://') || clean.startsWith('https://')) {
      setDbUrl(clean);
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
    const clean = raw.trim();
    try {
      const parsed = JSON.parse(clean);
      if (parsed.key) {
        handleScannedCode(clean);
        return;
      }
      if (parsed.url && parsed.token) {
        const stale = pairingFreshnessError(parsed);
        if (stale) {
          showToast(stale, 'error');
          return;
        }
        setDbUrl(parsed.url);
        setAuthToken(parsed.token);
        executePairing(parsed.url, parsed.token);
        return;
      }
    } catch {
      if (isValidKeyFormat(clean)) {
        handleScannedCode(clean);
        return;
      }
      if (clean.startsWith('libsql://') || clean.startsWith('https://')) {
        setDbUrl(clean);
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
    <div className="fixed inset-0 z-50 bg-pos-bg text-pos-text flex flex-col justify-between px-4 overflow-y-auto overscroll-contain font-sans pt-[var(--safe-top)] pb-[var(--safe-bottom)]">
      {/* Top Header */}
      <div className="space-y-3 pt-2 text-center relative max-w-sm mx-auto w-full">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="absolute -top-1 right-0 min-h-[44px] min-w-[44px] flex items-center justify-center p-2 text-pos-muted hover:text-pos-text transition cursor-pointer"
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

        {/* Progress steps: 1 Scanner · 2 Vérifier · 3 Synchroniser */}
        <ol aria-label="Progression de l'appairage" className="flex items-center justify-center gap-1.5 pt-1">
          {STEPS.map((s, i) => {
            const done = currentStep > s.n;
            const active = currentStep === s.n;
            return (
              <li key={s.n} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden="true" className="w-4 h-px bg-pos-border" />}
                <span
                  aria-current={active ? 'step' : undefined}
                  className={`min-h-[44px] flex items-center gap-1.5 px-2.5 rounded-xl border text-[11px] font-bold transition ${
                    active
                      ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300'
                      : done
                        ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                        : 'bg-pos-panel border-pos-border text-pos-muted'
                  }`}
                >
                  <span
                    className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0 ${
                      active
                        ? 'bg-cyan-500 text-slate-950'
                        : done
                          ? 'bg-emerald-500 text-slate-950'
                          : 'bg-pos-bg text-pos-muted border border-pos-border'
                    }`}
                  >
                    {done ? '✓' : s.n}
                  </span>
                  <span>{s.label}</span>
                </span>
              </li>
            );
          })}
        </ol>

        {/* Mode Selector Tabs */}
        <div className="flex bg-pos-panel p-1 rounded-xl border border-pos-border">
          <button
            type="button"
            onClick={() => setMode('camera')}
            aria-pressed={mode === 'camera'}
            className={`flex-1 min-h-[44px] py-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
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
            aria-pressed={mode === 'paste'}
            className={`flex-1 min-h-[44px] py-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
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
            aria-pressed={mode === 'manual'}
            className={`flex-1 min-h-[44px] py-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
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
        {/* Inline pairing error with retry (reuses executePairing — no new logic). */}
        {!isConnecting && pairingError && (
          <div
            role="alert"
            className="mb-3 bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 space-y-3"
          >
            <div className="flex items-start gap-2 text-xs">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <p className="text-rose-200 font-medium leading-relaxed">{pairingError}</p>
            </div>
            <button
              type="button"
              disabled={!dbUrl.trim() || !authToken.trim()}
              onClick={() => {
                setPairingError(null);
                void executePairing(dbUrl, authToken);
              }}
              className="w-full min-h-[44px] px-3 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 active:scale-95 border border-rose-500/40 text-rose-200 font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Réessayer la liaison</span>
            </button>
            {(!dbUrl.trim() || !authToken.trim()) && (
              <p className="text-[11px] text-pos-muted leading-relaxed">
                Aucun code en mémoire : rescanez le QR affiché sur votre caisse pour recommencer.
              </p>
            )}
          </div>
        )}

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
                className="min-h-[44px] px-2 text-cyan-400 hover:underline font-bold cursor-pointer"
              >
                Coller le code &rarr;
              </button>
            </div>

            <p className="text-[10px] text-pos-muted leading-relaxed px-1">
              Si la lecture échoue : tenez le téléphone à 15–20 cm de l'écran, montez la
              luminosité du PC au maximum et évitez les reflets sur l'écran.
            </p>
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
                className="w-full min-h-[44px] py-2.5 px-3 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-xs font-bold text-pos-text flex items-center justify-center gap-2 transition cursor-pointer"
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
                  aria-pressed={showToken}
                  className="min-h-[44px] px-2 text-[10px] text-cyan-400 hover:underline flex items-center gap-1 cursor-pointer"
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
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-mono text-pos-text focus:outline-none focus:border-cyan-400"
              />
              {/* Masked reminder: full token never displayed except via « Afficher ». */}
              {authToken && !showToken && (
                <p className="text-[10px] text-pos-muted font-mono mt-1">
                  Jeton saisi : ••••{authToken.trim().slice(-4)} (masqué — stocké uniquement dans le trousseau de l’appareil)
                </p>
              )}
            </div>

            <button
              type="button"
              disabled={isTesting || !dbUrl || !authToken}
              onClick={handleTest}
              className="w-full min-h-[44px] py-2 px-3 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-xs font-bold text-pos-text flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
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
            {testResult && !testResult.ok && (
              <p className="text-[11px] text-pos-muted leading-relaxed">
                Que faire : vérifiez l’URL (libsql://…), recollez le jeton depuis votre caisse, puis touchez « Tester la Connexion » à nouveau.
              </p>
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
            className="w-full min-h-[44px] py-2 text-center text-xs text-pos-muted hover:text-pos-text font-medium cursor-pointer"
          >
            Continuer en Mode Démo Hors-Ligne
          </button>
        )}
      </div>
    </div>
  );
};

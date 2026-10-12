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
  ArrowLeft,
  Camera,
  X,
  QrCode,
  Activity,
  Clock,
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
import {
  PAIRING_QR_FRESHNESS_MS,
  PAIRING_QR_FUTURE_TOLERANCE_MS,
  pairingMinutesLeft,
} from '../../utils/pairingPayload';

interface MobilePairingWizardProps {
  onPaired: () => void;
  onSkipDemo?: () => void;
  onClose?: () => void;
}

// Pairing QR freshness: the desktop QR embeds `ts: Date.now()` (minted by
// buildPairingPayload in utils/pairingPayload — the shared desktop builder).
// A photo, screenshot or clipboard copy stays valid FOREVER unless checked —
// anyone holding one gets permanent DB credentials. Reject codes older than
// 15 minutes (or >5 min in the future, i.e. clock skew): the operator simply
// re-opens the QR on the till for a fresh one. License-key payloads go
// through server-side activation instead and are exempt.
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
  // 3-step workflow: 1. Scanner / Saisir · 2. Vérifier & Latence · 3. Synchroniser
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [mode, setMode] = useState<'camera' | 'paste' | 'manual'>('camera');
  const [qrText, setQrText] = useState('');
  const [dbUrl, setDbUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [scannedTimestamp, setScannedTimestamp] = useState<number | null>(null);
  const [showToken, setShowToken] = useState(false);

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionStep, setConnectionStep] = useState<string>('');
  // Inline pairing error (plain French + retry) — complements the toast.
  const [pairingError, setPairingError] = useState<string | null>(null);

  const STEPS = [
    { n: 1 as const, label: 'Scanner' },
    { n: 2 as const, label: 'Vérifier' },
    { n: 3 as const, label: 'Synchroniser' },
  ];

  // Helper to test Turso connection and measure ping latency
  const handleTest = useCallback(
    async (targetUrl: string, targetToken: string) => {
      const trimmedUrl = targetUrl.trim();
      const trimmedToken = targetToken.trim();
      if (!trimmedUrl || !trimmedToken) {
        showToast('Veuillez renseigner l\'URL et le Jeton', 'warning');
        return;
      }
      setIsTesting(true);
      setTestResult(null);
      try {
        const res = await testTursoConnection(trimmedUrl, trimmedToken);
        setTestResult(res);
        if (res.ok) {
          soundEngine.playSuccess?.();
          showToast(`Connexion établie (${res.latencyMs} ms) !`, 'success');
        } else {
          soundEngine.playError?.();
          showToast(res.error || 'Échec de connexion', 'error');
        }
      } catch (e) {
        soundEngine.playError?.();
        showToast(e instanceof Error ? e.message : 'Erreur réseau', 'error');
      } finally {
        setIsTesting(false);
      }
    },
    [showToast]
  );

  // Execute full cloud pairing and database synchronization
  const executePairing = useCallback(
    async (targetUrl: string, targetToken: string) => {
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

      setStep(3);
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
    },
    [onPaired, showToast]
  );

  // Transition to Step 2 (Vérifier) with scanned or entered credentials
  const advanceToVerify = useCallback(
    (url: string, token: string, ts?: number | null) => {
      setDbUrl(url);
      setAuthToken(token);
      if (ts !== undefined) setScannedTimestamp(ts);
      setStep(2);
      setPairingError(null);
      void handleTest(url, token);
    },
    [handleTest]
  );

  // Handle scanned string from camera
  const handleScannedCode = useCallback(
    (raw: string) => {
      if (isConnecting) return;
      const clean = raw.trim();

      try {
        // 1. Try JSON parsing
        const parsed = JSON.parse(clean);
        if (parsed.key) {
          setIsConnecting(true);
          setStep(3);
          setConnectionStep('Activation de la licence mobile...');
          activateLicense({ licenseKey: parsed.key, deviceType: 'mobile', friendlyName: 'Compagnon Mobile' })
            .then(async (actRes) => {
              if (!actRes.success) {
                throw new Error(actRes.message || 'Échec d’activation de la licence.');
              }
              const creds = await getCloudCredentials();
              if (creds && creds.url && creds.token) {
                setDbUrl(creds.url);
                setAuthToken(creds.token);
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
          const ts = typeof parsed.ts === 'number' ? parsed.ts : null;
          advanceToVerify(parsed.url, parsed.token, ts);
          return;
        }
      } catch {
        // Not JSON
      }

      // 2. Direct license key format check (e.g. MOBI-LIFE-XXXX-XXXX)
      if (isValidKeyFormat(clean)) {
        setIsConnecting(true);
        setStep(3);
        setConnectionStep('Activation de la licence mobile...');
        activateLicense({ licenseKey: clean, deviceType: 'mobile', friendlyName: 'Compagnon Mobile' })
          .then(async (actRes) => {
            if (!actRes.success) {
              throw new Error(actRes.message || 'Échec d’activation de la licence.');
            }
            const creds = await getCloudCredentials();
            if (creds && creds.url && creds.token) {
              setDbUrl(creds.url);
              setAuthToken(creds.token);
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
    },
    [advanceToVerify, executePairing, isConnecting, showToast]
  );

  // Parse pairing text from clipboard or textarea
  const parseAndApplyPairingText = useCallback(
    (raw: string, announceErrors = true) => {
      const clean = raw.trim();
      if (!clean) return;

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
          const ts = typeof parsed.ts === 'number' ? parsed.ts : null;
          advanceToVerify(parsed.url, parsed.token, ts);
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
          return;
        }
        if (announceErrors) {
          showToast('Format de code non reconnu', 'error');
        }
      }
    },
    [advanceToVerify, handleScannedCode, showToast]
  );

  // Handle manual clipboard paste
  const handlePastePairingCode = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        showToast('Presse-papier vide', 'warning');
        return;
      }
      setQrText(text.trim());
      parseAndApplyPairingText(text.trim(), true);
    } catch {
      showToast('Impossible d\'accéder au presse-papier', 'error');
    }
  };

  const minutesRemaining = scannedTimestamp ? pairingMinutesLeft(scannedTimestamp) : null;

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
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        )}

        <div className="w-12 h-12 mx-auto rounded-2xl bg-gradient-to-br from-cyan-500 to-emerald-500 flex items-center justify-center text-slate-950 shadow-lg shadow-emerald-500/20">
          <Smartphone className="w-6 h-6" aria-hidden="true" />
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
            const done = step > s.n;
            const active = step === s.n;
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
                    aria-hidden="true"
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

        {/* Step 1 Mode Selector Tabs (Scanner mode only) */}
        {step === 1 && (
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
              <Camera className="w-3.5 h-3.5" aria-hidden="true" />
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
              <Clipboard className="w-3.5 h-3.5" aria-hidden="true" />
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
              <Key className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Manuel</span>
            </button>
          </div>
        )}
      </div>

      {/* Main Content Area */}
      <div className="my-3 max-w-sm w-full mx-auto flex-1 flex flex-col justify-center">
        {/* Inline pairing error with retry */}
        {!isConnecting && pairingError && (
          <div
            role="alert"
            className="mb-3 bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 space-y-3"
          >
            <div className="flex items-start gap-2 text-xs">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-rose-200 font-medium leading-relaxed">{pairingError}</p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!dbUrl.trim() || !authToken.trim()}
                onClick={() => {
                  setPairingError(null);
                  void executePairing(dbUrl, authToken);
                }}
                className="flex-1 min-h-[44px] px-3 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 active:scale-95 border border-rose-500/40 text-rose-200 font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Réessayer la liaison</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setPairingError(null);
                  setStep(1);
                }}
                className="min-h-[44px] px-3 rounded-xl bg-pos-panel hover:bg-pos-card border border-pos-border text-pos-muted font-bold text-xs flex items-center justify-center transition cursor-pointer"
              >
                <span>Rescanner</span>
              </button>
            </div>
            {(!dbUrl.trim() || !authToken.trim()) && (
              <p className="text-[11px] text-pos-muted leading-relaxed">
                Aucun code en mémoire : rescanez le QR affiché sur votre caisse pour recommencer.
              </p>
            )}
          </div>
        )}

        {/* STEP 3: Active Connecting Overlay */}
        {step === 3 && isConnecting ? (
          <div className="bg-pos-panel border border-pos-border rounded-2xl p-6 text-center space-y-4 shadow-xl animate-in fade-in">
            <div className="w-14 h-14 mx-auto rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center animate-pulse">
              <RefreshCw className="w-7 h-7 animate-spin" aria-hidden="true" />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-sm font-black text-pos-text">Synchronisation en cours...</h3>
              <p className="text-xs text-cyan-400 font-medium">{connectionStep || 'Connexion à la base...'}</p>
              <p className="text-[11px] text-pos-muted">
                Téléchargement du catalogue, des clients et des paramètres de votre boutique.
              </p>
            </div>
          </div>
        ) : step === 2 ? (
          /* STEP 2: Vérifier & Latence */
          <div className="bg-pos-panel border border-pos-border rounded-2xl p-4 space-y-3.5 shadow-sm">
            <div className="flex items-center justify-between border-b border-pos-border/60 pb-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                <h3 className="text-xs font-black text-pos-text uppercase tracking-wider">Identifiants Détectés</h3>
              </div>
              <button
                type="button"
                onClick={() => setStep(1)}
                className="text-[11px] text-cyan-400 hover:underline font-bold flex items-center gap-1 cursor-pointer min-h-[44px] px-1"
              >
                <ArrowLeft className="w-3 h-3" aria-hidden="true" />
                <span>Modifier</span>
              </button>
            </div>

            {/* Target URL */}
            <div className="space-y-1">
              <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider flex items-center gap-1">
                <Cloud className="w-3 h-3 text-cyan-400" aria-hidden="true" /> URL de la Base
              </span>
              <p className="text-xs font-mono text-pos-text bg-pos-bg p-2 rounded-xl border border-pos-border break-all">
                {dbUrl || '—'}
              </p>
            </div>

            {/* Auth Token preview with mask */}
            <div className="space-y-1">
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider flex items-center gap-1">
                  <Key className="w-3 h-3 text-amber-400" aria-hidden="true" /> Jeton d'authentification
                </span>
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  aria-pressed={showToken}
                  className="min-h-[44px] px-2 text-[10px] text-cyan-400 hover:underline flex items-center gap-1 cursor-pointer"
                >
                  {showToken ? <EyeOff className="w-3 h-3" aria-hidden="true" /> : <Eye className="w-3 h-3" aria-hidden="true" />}
                  <span>{showToken ? 'Masquer' : 'Afficher'}</span>
                </button>
              </div>
              <div className="bg-pos-bg p-2 rounded-xl border border-pos-border">
                {showToken ? (
                  <p className="text-xs font-mono text-pos-text break-all">{authToken}</p>
                ) : (
                  <p className="text-xs font-mono text-cyan-300">
                    ••••{authToken.trim().slice(-4)} <span className="text-[10px] text-pos-muted font-sans">(masqué pour sécurité)</span>
                  </p>
                )}
              </div>
            </div>

            {/* QR freshness stamp */}
            {minutesRemaining !== null && (
              <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1.5 rounded-xl">
                <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Code valide encore {minutesRemaining} minute(s).</span>
              </div>
            )}

            {/* Live Ping Indicator Card */}
            <div className="bg-pos-card border border-pos-border rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
                  <span>Test de Latence & Accès</span>
                </span>
                <button
                  type="button"
                  disabled={isTesting}
                  onClick={() => void handleTest(dbUrl, authToken)}
                  className="min-h-[44px] min-w-[44px] py-1 px-2.5 rounded-lg bg-pos-panel border border-pos-border text-xs font-bold text-cyan-300 hover:text-cyan-200 flex items-center gap-1.5 active:scale-95 transition cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${isTesting ? 'animate-spin' : ''}`} aria-hidden="true" />
                  <span>Tester à nouveau</span>
                </button>
              </div>

              {isTesting ? (
                <div className="flex items-center gap-2 p-2 bg-pos-bg rounded-lg text-xs text-cyan-300">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  <span>Mesure de la latence en direct...</span>
                </div>
              ) : testResult ? (
                <div
                  className={`p-2.5 rounded-xl border text-xs space-y-1 ${
                    testResult.ok
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 font-bold">
                      {testResult.ok ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" aria-hidden="true" />
                      )}
                      <span>{testResult.ok ? 'Base accessible' : 'Connexion échouée'}</span>
                    </span>
                    {testResult.ok && (
                      <span className="font-mono font-black px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                        {testResult.latencyMs} ms
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] leading-relaxed">
                    {testResult.ok
                      ? testResult.latencyMs < 150
                        ? `Latence excellente (${testResult.latencyMs} ms). Schéma cloud prêt (v${testResult.appliedVersion}).`
                        : testResult.latencyMs < 450
                          ? `Latence normale (${testResult.latencyMs} ms). Schéma cloud prêt (v${testResult.appliedVersion}).`
                          : `Latence élevée (${testResult.latencyMs} ms). Connexion utilisable mais lente.`
                      : testResult.error || 'Vérifiez l’URL et le jeton de sécurité.'}
                  </p>
                </div>
              ) : (
                <div className="p-2 bg-pos-bg rounded-lg text-[11px] text-pos-muted">
                  Touchez « Tester à nouveau » pour mesurer la latence en millisecondes.
                </div>
              )}
            </div>
          </div>
        ) : mode === 'camera' ? (
          /* STEP 1.1 Camera Live Viewfinder Mode */
          <div className="space-y-3">
            <div className="h-72 w-full rounded-2xl overflow-hidden relative shadow-inner">
              <MobileCameraScanner
                isActive={mode === 'camera' && !isConnecting && step === 1}
                onScan={handleScannedCode}
              />
            </div>

            <div className="flex items-center justify-between text-[11px] px-1">
              <span className="text-pos-muted flex items-center gap-1">
                <QrCode className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
                <span>Détection automatique dès le cadrage</span>
              </span>
              <button
                type="button"
                onClick={() => setMode('paste')}
                className="min-h-[44px] px-2 text-cyan-400 hover:underline font-bold cursor-pointer flex items-center gap-1"
              >
                <span>Coller le code</span>
                <span aria-hidden="true">&rarr;</span>
              </button>
            </div>

            <p className="text-[10px] text-pos-muted leading-relaxed px-1">
              Si la lecture échoue : tenez le téléphone à 15–20 cm de l'écran, montez la
              luminosité du PC au maximum et évitez les reflets sur l'écran.
            </p>
          </div>
        ) : mode === 'paste' ? (
          /* STEP 1.2 Clipboard Paste Mode */
          <div className="bg-pos-panel border border-pos-border rounded-2xl p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-pos-text">
              <QrCode className="w-4 h-4 text-cyan-400" aria-hidden="true" />
              <span>Coller le code d'appairage depuis votre PC</span>
            </div>
            <p className="text-[11px] text-pos-muted leading-relaxed">
              Sur votre logiciel caisse PC, allez dans <strong className="text-pos-text">Paramètres &gt; Lier Smartphone &gt; Étape 2</strong> et copiez le code d'appairage.
            </p>

            <div className="space-y-2 pt-1">
              <textarea
                value={qrText}
                onChange={(e) => setQrText(e.target.value)}
                placeholder="Collez ici le code JSON généré par votre caisse PC..."
                rows={3}
                className="w-full bg-pos-bg border border-pos-border rounded-xl p-2.5 font-mono text-base sm:text-xs text-pos-text focus:outline-none focus:border-cyan-400 resize-none"
              />

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handlePastePairingCode}
                  className="flex-1 min-h-[44px] py-2 px-3 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-xs font-bold text-pos-text flex items-center justify-center gap-2 transition cursor-pointer"
                >
                  <Clipboard className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
                  <span>Coller du presse-papier</span>
                </button>

                {qrText.trim() && (
                  <button
                    type="button"
                    onClick={() => parseAndApplyPairingText(qrText, true)}
                    className="min-h-[44px] px-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-black flex items-center justify-center gap-1.5 transition cursor-pointer"
                  >
                    <span>Valider</span>
                    <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          /* STEP 1.3 Manual Form Mode */
          <div className="bg-pos-panel border border-pos-border rounded-2xl p-4 space-y-3">
            <div>
              <label className="text-xs font-bold text-pos-muted block mb-1">URL de la base Turso :</label>
              <input
                type="text"
                value={dbUrl}
                onChange={(e) => setDbUrl(e.target.value)}
                placeholder="libsql://mobi-pos-boutique.turso.io"
                className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-base sm:text-xs font-mono text-pos-text focus:outline-none focus:border-cyan-400"
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
                  {showToken ? <EyeOff className="w-3 h-3" aria-hidden="true" /> : <Eye className="w-3 h-3" aria-hidden="true" />}
                  <span>{showToken ? 'Masquer' : 'Afficher'}</span>
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
                className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-base sm:text-xs font-mono text-pos-text focus:outline-none focus:border-cyan-400"
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
              disabled={!dbUrl.trim() || !authToken.trim()}
              onClick={() => advanceToVerify(dbUrl, authToken)}
              className="w-full min-h-[44px] py-2 px-3 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-xs font-bold text-pos-text flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
            >
              <span>Suivant : Vérifier la Connexion</span>
              <ArrowRight className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Security badge */}
        <div className="flex items-start gap-2 text-[10px] text-pos-muted px-2 mt-3">
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            Chiffrement de bout-en-bout. Vos identifiants restent stockés localement sur cet appareil dans le trousseau sécurisé.
          </span>
        </div>
      </div>

      {/* Bottom Actions */}
      <div className="max-w-sm w-full mx-auto space-y-2 pb-2">
        {step === 2 && (
          <button
            type="button"
            disabled={isConnecting || !dbUrl.trim() || !authToken.trim() || (testResult !== null && !testResult.ok)}
            onClick={() => executePairing(dbUrl, authToken)}
            className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 active:scale-[0.98] text-slate-950 font-black text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 transition cursor-pointer disabled:opacity-50"
          >
            <Cloud className="w-4 h-4" aria-hidden="true" />
            <span>Lancer la Synchronisation</span>
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
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

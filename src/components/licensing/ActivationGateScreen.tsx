import React, { useState, useEffect, useMemo, Suspense } from 'react';
import {
  Lock,
  ShieldCheck,
  ShieldAlert,
  Cpu,
  Key,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Loader2,
  Copy,
  Check,
  Server,
  CheckCircle2,
  Monitor,
  Smartphone,
  Tablet,
  Camera,
  ClipboardPaste,
  Sparkles,
  RefreshCw,
  MessageCircle,
  HelpCircle,
  ExternalLink,
  Download,
  X
} from 'lucide-react';
import { sanitizeLicenseKey, formatLicenseKeyForDisplay } from '../../licensing/keyFormat';
import {
  activateLicense,
  recheckLicenseStatus,
  DEFAULT_LICENSING_ENDPOINT,
  registerTrialLeadClient,
  TRIAL_WHATSAPP_OWNER,
} from '../../licensing/client';
import { resolveDeviceFingerprint } from '../../licensing/hwid';
import {
  loadSuspensionState,
  getLastActiveLicenseKey,
  clearSuspensionState,
  type LicenseSuspensionState
} from '../../licensing/store';
import {
  runEmergencyComplianceExport,
  summarizeExport,
  EmergencyExportError,
  type EmergencyExportResult,
} from '../../licensing/emergencyExporter';
import {
  getDetailedPlatform,
  type DevicePlatformDetails
} from '../../utils/platform';
import type { HardwareFingerprintResult } from '../../api/license';

// BOUNDARY (enforced by scripts/check-boundaries.mjs): this file must not
// import store slices, db adapters/repositories, sqlPluginAdapter, or sync/*.
// The only data path available while locked is the scoped read-only exporter
// above. Adding a domain import here would re-open the expired-licence bypass
// this gate exists to close.

// Lazy-load camera scanner to keep bundle slim
const MobileCameraScanner = React.lazy(() =>
  import('../mobile/MobileCameraScanner').then((m) => ({ default: m.MobileCameraScanner }))
);

interface ActivationGateScreenProps {
  onActivated: () => void;
  initialError?: string;
}

export const ActivationGateScreen: React.FC<ActivationGateScreenProps> = ({
  onActivated,
  initialError,
}) => {
  const [licenseKey, setLicenseKey] = useState<string>(() => {
    const lastKey = getLastActiveLicenseKey();
    return lastKey ? formatLicenseKeyForDisplay(lastKey) : '';
  });
  const [friendlyName, setFriendlyName] = useState('');
  const [loading, setLoading] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [error, setError] = useState<string | null>(initialError || null);
  const [prevInitialError, setPrevInitialError] = useState(initialError);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [hwid, setHwid] = useState<HardwareFingerprintResult | null>(null);
  const [deviceType, setDeviceType] = useState<'desktop' | 'mobile'>(() => getDetailedPlatform().roleHint);
  const [platformInfo] = useState<DevicePlatformDetails>(() => getDetailedPlatform());
  const [copiedHwid, setCopiedHwid] = useState(false);
  const [copiedPasteSuccess, setCopiedPasteSuccess] = useState(false);

  const [mode, setMode] = useState<'key' | 'token'>('key');
  const [offlineToken, setOfflineToken] = useState('');
  const [showScanner, setShowScanner] = useState(false);

  // M2 trial funnel: 2-field signup, no licence involved
  const [trialOpen, setTrialOpen] = useState(false);
  const [trialName, setTrialName] = useState('');
  const [trialWhatsapp, setTrialWhatsapp] = useState('');
  const [trialBusy, setTrialBusy] = useState(false);
  const [trialError, setTrialError] = useState<string | null>(null);
  const [trialDone, setTrialDone] = useState<null | 'registered' | 'already_registered'>(null);

  // Suspension detection
  const [suspension, setSuspension] = useState<LicenseSuspensionState | null>(() => {
    const current = loadSuspensionState();
    if (current?.suspended) return current;
    if (initialError && (initialError.toLowerCase().includes('suspend') || initialError.toLowerCase().includes('révoqu'))) {
      return {
        suspended: true,
        reason: initialError,
        suspendedAt: Date.now(),
        licenseKey: getLastActiveLicenseKey() || undefined,
      };
    }
    return null;
  });

  if (prevInitialError !== initialError) {
    setPrevInitialError(initialError);
    if (initialError) {
      setError(initialError);
      if (initialError.toLowerCase().includes('suspend') || initialError.toLowerCase().includes('révoqu')) {
        setSuspension({
          suspended: true,
          reason: initialError,
          suspendedAt: Date.now(),
          licenseKey: getLastActiveLicenseKey() || undefined,
        });
      }
    }
  }

  const [forcedNewKey, setForcedNewKey] = useState(false);

  // ── Scoped emergency compliance export ─────────────────────────────────────
  // Statutory retention must not require a paid licence, but an export must
  // never become a general-purpose data door. The workflow is deliberately
  // narrow: Owner/Manager PIN → native read-only extraction → file paths and
  // SHA-256 digests. No store hydration, no sync, no operational capability.
  const [exportPin, setExportPin] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<EmergencyExportResult | null>(null);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [showExportPanel, setShowExportPanel] = useState(false);

  const handleEmergencyExport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (exportBusy) return;
    const pin = exportPin.trim();
    if (!pin) {
      setExportError('Saisissez le PIN Gérant pour autoriser l\'export.');
      return;
    }
    setExportBusy(true);
    setExportError(null);
    setExportResult(null);
    setExportProgress('Ouverture de la connexion en lecture seule…');

    try {
      const result = await runEmergencyComplianceExport(
        // Phase 1 B.7: no licenseStatus is forwarded — the native kernel
        // records its own coarse state code in the audit row.
        { pin },
        {
          onProgress: (p) =>
            setExportProgress(
              `Extraction ${p.table}… ${p.rows.toLocaleString('fr-FR')} lignes`
            ),
        }
      );
      setExportResult(result);
      setExportProgress(null);
      // The PIN is not needed again for this archive; drop it from component
      // state so it does not linger in memory behind the receipt.
      setExportPin('');
    } catch (err) {
      setExportProgress(null);
      if (err instanceof EmergencyExportError) {
        setExportError(
          err.code === 'INVALID_PIN'
            ? 'PIN Gérant incorrect. L\'export a été refusé et la tentative consignée.'
            : err.message
        );
      } else {
        setExportError('Export impossible. Veuillez réessayer.');
      }
    } finally {
      setExportBusy(false);
    }
  };

  // Advanced options accordion
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [serverUrl, setServerUrl] = useState(DEFAULT_LICENSING_ENDPOINT);

  useEffect(() => {
    let cancelled = false;
    // Resolve hardware fingerprint
    resolveDeviceFingerprint()
      .then((res) => {
        if (!cancelled) {
          setHwid(res);
          const isMob = platformInfo.category === 'mobile' || platformInfo.category === 'tablet';
          setFriendlyName(isMob ? 'Mobile Vendeur' : 'Abdelkader Benali');
        }
      })
      .catch(console.warn);
    return () => {
      cancelled = true;
    };
  }, [platformInfo.category]);

  // Live Formula Detection from Key Tag
  const formulaInfo = useMemo(() => {
    const raw = licenseKey.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (raw.includes('LIFE')) {
      return { label: '✨ À VIE (LIFETIME)', desc: 'Licence Illimitée Permanente', color: 'text-emerald-800 dark:text-emerald-300 bg-emerald-500/15 border-emerald-500/40' };
    }
    if (raw.includes('90D')) {
      return { label: '📅 90 JOURS (3 MOIS)', desc: 'Abonnement Trimestriel', color: 'text-blue-800 dark:text-blue-300 bg-blue-500/15 border-blue-500/40' };
    }
    if (raw.includes('24H') || raw.includes('DEMO')) {
      return { label: '⚡ DÉMO 24 HEURES', desc: 'Essai Fonctionnel Complet', color: 'text-amber-800 dark:text-amber-300 bg-amber-500/15 border-amber-500/40' };
    }
    if (raw.includes('30D')) {
      return { label: '📅 30 JOURS (1 MOIS)', desc: 'Abonnement Mensuel', color: 'text-indigo-800 dark:text-indigo-300 bg-indigo-500/15 border-indigo-500/40' };
    }
    if (raw.includes('1Y')) {
      return { label: '📅 1 AN (ANNUEL)', desc: 'Abonnement Annuel', color: 'text-teal-800 dark:text-teal-300 bg-teal-500/15 border-teal-500/40' };
    }
    return null;
  }, [licenseKey]);

  const handleCopyHwid = () => {
    if (!hwid?.formatted) return;
    navigator.clipboard.writeText(hwid.formatted);
    setCopiedHwid(true);
    setTimeout(() => setCopiedHwid(false), 2000);
  };

  const handleKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const sanitized = sanitizeLicenseKey(raw);
    setLicenseKey(formatLicenseKeyForDisplay(sanitized));
    if (error) setError(null);
  };

  const handlePasteKey = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      let cleaned = text.trim().replace(/[*"'`]/g, '');
      const match = cleaned.match(/MOBI-[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+/i);
      if (match) {
        cleaned = match[0];
      }
      const sanitized = sanitizeLicenseKey(cleaned);
      setLicenseKey(formatLicenseKeyForDisplay(sanitized));
      setCopiedPasteSuccess(true);
      setTimeout(() => setCopiedPasteSuccess(false), 1500);
      if (error) setError(null);
    } catch {
      // Ignore clipboard permission denial
    }
  };

  const handleQrScanned = (data: string) => {
    let cleaned = data.trim().replace(/[*"'`]/g, '');
    const match = cleaned.match(/MOBI-[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+/i);
    if (match) {
      cleaned = match[0];
    }
    const sanitized = sanitizeLicenseKey(cleaned);
    setLicenseKey(formatLicenseKeyForDisplay(sanitized));
    setShowScanner(false);
    if (error) setError(null);
  };

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!licenseKey.trim()) {
      setError('Veuillez saisir votre clé de licence.');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await activateLicense({
        licenseKey,
        friendlyName,
        deviceType,
        serverUrl: serverUrl.trim() || undefined,
      });

      if (res.success) {
        clearSuspensionState();
        setSuspension(null);
        setSuccessMsg('Licence validée avec succès ! Démarrage de MobiPOS...');
        setTimeout(() => {
          onActivated();
        }, 800);
      } else {
        let msg = res.message || 'Échec de l’activation.';
        if (msg.includes('Limite d\'appareils') || msg.includes('quota')) {
          msg += ` (${deviceType === 'desktop' ? 'Quota Caisses PC atteint' : 'Quota Mobiles atteint'}. Contactez votre administrateur pour augmenter vos quotas).`;
        }
        setError(msg);
      }
    } catch (err: any) {
      setError(err.message || 'Une erreur inattendue est survenue.');
    } finally {
      setLoading(false);
    }
  };

  const handleActivateOfflineToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!offlineToken.trim()) {
      setError('Veuillez coller votre jeton de licence.');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const { activateWithOfflineToken } = await import('../../licensing/client');
      const res = await activateWithOfflineToken(offlineToken);

      if (res.success) {
        clearSuspensionState();
        setSuspension(null);
        setSuccessMsg('Licence validée avec succès ! Démarrage de MobiPOS...');
        setTimeout(() => {
          onActivated();
        }, 800);
      } else {
        setError(res.message || 'Échec de la validation du jeton.');
      }
    } catch (err: any) {
      setError(err.message || 'Erreur lors de la validation du jeton.');
    } finally {
      setLoading(false);
    }
  };

  // Re-check suspension status against server
  const handleRecheckStatus = async () => {
    setRechecking(true);
    setError(null);
    setSuccessMsg(null);

    const targetKey = suspension?.licenseKey || licenseKey || getLastActiveLicenseKey() || '';

    try {
      const res = await recheckLicenseStatus(targetKey, serverUrl.trim() || undefined);
      if (res.success) {
        setSuspension(null);
        clearSuspensionState();
        setSuccessMsg('Licence réactivée avec succès ! Chargement de MobiPOS...');
        setTimeout(() => {
          onActivated();
        }, 800);
      } else {
        setError(res.message);
      }
    } catch (err: any) {
      setError(err.message || 'Impossible de contacter le serveur de licence.');
    } finally {
      setRechecking(false);
    }
  };

  const handleOpenWhatsAppSupport = () => {
    const key = suspension?.licenseKey || licenseKey || getLastActiveLicenseKey() || 'INCONNUE';
    const hwidStr = hwid?.formatted || 'INCONNU';
    const text = encodeURIComponent(
      `Bonjour support MobiPOS,\n\nMa licence pour le terminal suivant est actuellement suspendue :\n- Clé : ${key}\n- Appareil : ${platformInfo.displayName} (${hwidStr})\n\nPourriez-vous vérifier et réactiver mon accès s'il vous plaît ? Merci.`
    );
    window.open(`https://wa.me/?text=${text}`, '_blank');
  };

  const isSuspendedView = Boolean(suspension?.suspended && !forcedNewKey);
  const isMobileLayout = platformInfo.category === 'mobile' || platformInfo.category === 'tablet';
  const isExportExpanded = showExportPanel || exportResult !== null || exportError !== null;

  const handleTrialSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (trialBusy) return;
    const name = trialName.trim().replace(/\s+/g, ' ');
    const wa = trialWhatsapp.trim();
    const waDigits = wa.replace(/[^0-9]/g, '');
    if (name.length < 2 || name.length > 80 || !/\p{L}/u.test(name)) {
      setTrialError('Nom invalide (2 à 80 caractères, au moins une lettre).');
      return;
    }
    if (waDigits.length < 8 || waDigits.length > 15) {
      setTrialError('Numéro WhatsApp invalide (8 à 15 chiffres).');
      return;
    }
    setTrialError(null);
    setTrialBusy(true);
    const result = await registerTrialLeadClient(name, wa);
    setTrialBusy(false);
    if (result.status === 'error') {
      setTrialError(result.message || 'Une erreur est survenue.');
      return;
    }
    setTrialDone(result.status === 'already_registered' ? 'already_registered' : 'registered');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-pos-bg text-pos-text p-3 sm:p-6 select-none overflow-y-auto pt-[max(0.75rem,var(--safe-top))] pb-[max(0.75rem,var(--safe-bottom))]">
      {/* Background Ambience */}
      <div className="absolute inset-0 bg-gradient-to-tr from-pos-bg via-pos-panel to-pos-bg pointer-events-none" />
      <div
        className={`absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[32rem] h-[32rem] max-w-full rounded-full blur-3xl pointer-events-none transition-all duration-700 ${
          isSuspendedView ? 'bg-rose-500/10' : 'bg-emerald-500/10'
        }`}
      />

      {/* QR Code Scanner Overlay */}
      {showScanner && (
        <div className="fixed inset-0 z-[60] bg-black/90 backdrop-blur-md flex flex-col items-center justify-center p-4">
          <div className="relative w-full max-w-sm bg-pos-panel border border-pos-border rounded-3xl overflow-hidden shadow-2xl p-4 flex flex-col items-center">
            <div className="w-full flex items-center justify-between pb-3 border-b border-pos-border">
              <div className="flex items-center gap-2 font-bold text-sm text-purple-600 dark:text-purple-400">
                <Camera className="w-4 h-4" aria-hidden="true" />
                <span>Scanner le QR Code de Licence</span>
              </div>
              <button
                type="button"
                onClick={() => setShowScanner(false)}
                aria-label="Fermer le scanner QR"
                className="min-h-[48px] min-w-[48px] flex items-center justify-center rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <div className="w-full min-h-[280px] h-auto mt-3 rounded-2xl overflow-hidden bg-black relative flex flex-col items-center justify-center">
              <Suspense
                fallback={
                  <div className="flex flex-col items-center gap-2 text-pos-muted text-xs">
                    <Loader2 className="w-6 h-6 animate-spin text-purple-500 dark:text-purple-400" />
                    <span>Démarrage de la caméra...</span>
                  </div>
                }
              >
                <MobileCameraScanner
                  isActive={true}
                  mode="qr"
                  hintText="Cadrez le QR Code affiché sur l'écran d'administration"
                  onScan={handleQrScanned}
                />
              </Suspense>
            </div>

            <p className="text-[11px] text-pos-muted text-center mt-3">
              Pointez la caméra vers le QR Code affiché dans le logiciel d'administration MobiPOS.
            </p>
          </div>
        </div>
      )}

      {/* Main Container Card */}
      <div
        className={`relative w-full ${
          isMobileLayout ? 'max-w-md' : 'max-w-xl'
        } bg-pos-panel/95 border border-pos-border rounded-3xl shadow-2xl p-5 sm:p-7 backdrop-blur-xl animate-in fade-in zoom-in-95 duration-200`}
      >
        {/* ========================================================================= */}
        {/* VIEW A: SUSPENDED LICENSE STATE                                           */}
        {/* ========================================================================= */}
        {isSuspendedView ? (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
            {/* Header Alert Banner */}
            <div className="text-center pt-1 pb-2">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-3xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 mb-3 shadow-inner ring-4 ring-rose-500/5">
                <ShieldAlert className="w-8 h-8" aria-hidden="true" />
              </div>
              <h1 className="text-lg sm:text-xl font-extrabold text-pos-text tracking-tight flex items-center justify-center gap-2">
                <span>Accès Temporairement Suspendu</span>
              </h1>
              <p className="text-xs text-rose-700 dark:text-rose-300 font-medium mt-1 max-w-sm mx-auto">
                {suspension?.reason || 'Cette licence a été suspendue par l’administrateur MobiPOS.'}
              </p>
            </div>

            {/* Client & Device Summary Card */}
            <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-2.5 text-xs">
              <div className="flex items-center justify-between pb-2 border-b border-pos-border/60">
                <span className="text-pos-muted font-medium">Statut de la licence :</span>
                <span className="px-2.5 py-0.5 rounded-full bg-rose-500/15 border border-rose-500/40 text-rose-800 dark:text-rose-300 font-bold text-[10px] flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
                  SUSPENDUE
                </span>
              </div>

              {suspension?.licenseKey && (
                <div className="flex items-center justify-between pb-2 border-b border-pos-border/60">
                  <span className="text-pos-muted font-medium">Clé associée :</span>
                  <span className="font-mono font-bold text-pos-text select-all">
                    <bdi dir="ltr">{suspension.licenseKey}</bdi>
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between pb-2 border-b border-pos-border/60">
                <span className="text-pos-muted font-medium">Cet appareil :</span>
                <span className="font-semibold text-pos-text flex items-center gap-1">
                  {platformInfo.category === 'mobile' ? (
                    <Smartphone className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" aria-hidden="true" />
                  ) : platformInfo.category === 'tablet' ? (
                    <Tablet className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                  ) : (
                    <Monitor className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                  )}
                  {platformInfo.displayName}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 pe-2">
                  <span className="text-[11px] text-pos-muted block font-medium">Empreinte Matériel (HWID) :</span>
                  <span className="font-mono text-[11px] font-bold text-pos-text truncate block select-all">
                    <bdi dir="ltr">{hwid?.formatted || 'Détection...'}</bdi>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleCopyHwid}
                  aria-label={copiedHwid ? 'Copié — Identifiant matériel' : 'Copier — Identifiant matériel'}
                  className="min-h-[48px] min-w-[48px] px-2.5 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border text-pos-text text-xs font-bold flex items-center justify-center gap-1.5 transition shrink-0"
                  title="Copier HWID"
                >
                  {copiedHwid ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
                  <span>{copiedHwid ? 'Copié' : 'Copier'}</span>
                </button>
              </div>
            </div>

            {/* Error feedback if recheck fails */}
            {error && (
              <div role="alert" className="p-3 bg-rose-500/15 border border-rose-500/50 rounded-2xl text-rose-800 dark:text-rose-200 text-xs flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="flex-1 font-medium">{error}</div>
              </div>
            )}

            {/* Success feedback */}
            {successMsg && (
              <div className="p-3 bg-emerald-500/15 border border-emerald-500/50 rounded-2xl text-emerald-800 dark:text-emerald-200 text-xs flex items-center gap-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true" />
                <div className="flex-1 font-medium">{successMsg}</div>
              </div>
            )}

            {/* Action Buttons for Suspended Client */}
            <div className="space-y-2.5 pt-1">
              {/* 1. Re-check Reactivation */}
              <button
                type="button"
                onClick={handleRecheckStatus}
                disabled={rechecking}
                className="w-full py-3.5 px-4 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-bold text-sm rounded-2xl shadow-lg shadow-emerald-500/20 transition flex items-center justify-center gap-2 active:scale-[0.98] min-h-[48px]"
              >
                {rechecking ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    <span>Vérification auprès du serveur...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4" aria-hidden="true" />
                    <span>Vérifier la Réactivation</span>
                  </>
                )}
              </button>

              {/* 2. Direct WhatsApp Support */}
              <button
                type="button"
                onClick={handleOpenWhatsAppSupport}
                className="w-full py-3 px-4 bg-pos-card hover:bg-pos-hover text-emerald-700 dark:text-emerald-400 font-semibold text-xs rounded-2xl border border-pos-border transition flex items-center justify-center gap-2 active:scale-[0.98] min-h-[48px]"
              >
                <MessageCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                <span>Contacter l'Assistance WhatsApp</span>
                <ExternalLink className="w-3 h-3 opacity-60 ms-0.5" aria-hidden="true" />
              </button>

              {/* 3. Switch to Another Key */}
              <button
                type="button"
                onClick={() => setForcedNewKey(true)}
                className="w-full min-h-[48px] px-3 rounded-xl text-center text-xs font-semibold text-pos-muted hover:text-pos-text transition flex items-center justify-center"
              >
                Utiliser une autre clé d'activation →
              </button>
            </div>
          </div>
        ) : (
          /* ========================================================================= */
          /* VIEW B: NORMAL ACTIVATION STATE                                           */
          /* ========================================================================= */
          <div className="space-y-4">
            {/* Header Branding */}
            <div className="text-center mb-4">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 mb-2.5 shadow-inner">
                <Lock className="w-7 h-7" aria-hidden="true" />
              </div>
              <h1 className="text-xl font-bold tracking-tight text-pos-text flex items-center justify-center gap-2">
                MobiPOS <span className="text-emerald-600 dark:text-emerald-400 font-normal">Licence</span>
              </h1>
              <p className="text-xs text-pos-muted mt-0.5">
                Activation sécurisée par signature cryptographique Ed25519
              </p>
            </div>

            {/* Platform Detection & HWID Card */}
            <div className="bg-pos-card border border-pos-border rounded-2xl p-3.5 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-pos-muted">Terminal détecté :</span>
                <span className="text-[10px] font-bold text-emerald-800 dark:text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                  {platformInfo.badgeLabel}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 pt-1 border-t border-pos-border/50">
                <div className="min-w-0 pe-2">
                  <div className="flex items-center gap-1.5 text-pos-muted mb-0.5">
                    <Cpu className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true" />
                    <span className="text-[11px] font-medium">Empreinte Matérielle (HWID) :</span>
                  </div>
                  <div className="font-mono font-bold text-pos-text truncate select-all">
                    <bdi dir="ltr">{hwid ? hwid.formatted : 'Calcul de l’empreinte...'}</bdi>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleCopyHwid}
                  title="Copier l'identifiant matériel"
                  aria-label={copiedHwid ? 'Copié — Identifiant matériel' : 'Copier — Identifiant matériel'}
                  className="min-h-[48px] min-w-[48px] px-2.5 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border text-pos-text text-xs font-bold flex items-center justify-center gap-1.5 transition shrink-0 active:scale-95"
                >
                  {copiedHwid ? <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
                  <span>{copiedHwid ? 'Copié' : 'Copier'}</span>
                </button>
              </div>
            </div>

            {/* Device Role Selector (PC Caisse vs Mobile Compagnon) */}
            <div>
              <div className="flex items-center justify-between text-[11px] font-semibold text-pos-muted mb-1.5">
                <span>Rôle de ce terminal :</span>
                <span className="text-[10px] text-pos-muted">
                  {deviceType === 'desktop' ? 'Abdelkader Benali (PC)' : 'Vendeur / Rayon (Mobile)'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 bg-pos-card p-1 rounded-2xl border border-pos-border">
                <button
                  type="button"
                  onClick={() => {
                    setDeviceType('desktop');
                    setFriendlyName('Abdelkader Benali');
                  }}
                  className={`min-h-[48px] py-2 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                    deviceType === 'desktop'
                      ? 'bg-pos-panel text-emerald-700 dark:text-emerald-400 border border-emerald-500/40 shadow'
                      : 'text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <Monitor className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Poste Caisse PC</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDeviceType('mobile');
                    setFriendlyName('Mobile Vendeur');
                  }}
                  className={`min-h-[48px] py-2 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                    deviceType === 'mobile'
                      ? 'bg-pos-panel text-purple-700 dark:text-purple-400 border border-purple-500/40 shadow'
                      : 'text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <Smartphone className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Mobile Compagnon</span>
                </button>
              </div>
            </div>

            {/* Feedback Alerts */}
            {error && (
              <div role="alert" className="p-3.5 bg-rose-500/15 border border-rose-500/50 rounded-2xl text-rose-800 dark:text-rose-200 text-xs flex items-start gap-2.5 animate-in shake">
                <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="flex-1 leading-relaxed font-medium">{error}</div>
              </div>
            )}

            {successMsg && (
              <div className="p-3.5 bg-emerald-500/15 border border-emerald-500/50 rounded-2xl text-emerald-800 dark:text-emerald-200 text-xs flex items-center gap-2.5 animate-in fade-in">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true" />
                <div className="flex-1 font-medium">{successMsg}</div>
              </div>
            )}

            {/* Mode Switcher Tabs */}
            <div className="flex bg-pos-card p-1 rounded-2xl border border-pos-border">
              <button
                type="button"
                onClick={() => { setMode('key'); setError(null); }}
                className={`flex-1 min-h-[48px] py-2 text-xs font-semibold rounded-xl transition ${
                  mode === 'key'
                    ? 'bg-pos-panel text-pos-text border border-pos-border shadow'
                    : 'text-pos-muted hover:text-pos-text'
                }`}
              >
                Clé d'Activation
              </button>
              <button
                type="button"
                onClick={() => { setMode('token'); setError(null); }}
                className={`flex-1 min-h-[48px] py-2 text-xs font-semibold rounded-xl transition ${
                  mode === 'token'
                    ? 'bg-pos-panel text-pos-text border border-pos-border shadow'
                    : 'text-pos-muted hover:text-pos-text'
                }`}
              >
                Jeton Hors-Ligne
              </button>
            </div>

            {mode === 'key' ? (
              /* Activation by Key Form */
              <form onSubmit={handleActivate} className="space-y-3.5">
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <label className="text-xs font-semibold text-pos-text flex items-center gap-1.5">
                      <Key className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                      Clé d'Activation :
                    </label>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={handlePasteKey}
                        title="Coller depuis le presse-papier"
                        className="min-h-[48px] px-3 text-[11px] font-semibold text-emerald-800 dark:text-emerald-300 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 rounded-xl flex items-center gap-1.5 transition active:scale-95"
                      >
                        <ClipboardPaste className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{copiedPasteSuccess ? 'Collé ✓' : 'Coller'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowScanner(true)}
                        title="Scanner un QR Code de licence"
                        className="min-h-[48px] px-3 text-[11px] font-semibold text-purple-800 dark:text-purple-300 bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/30 rounded-xl flex items-center gap-1.5 transition active:scale-95"
                      >
                        <Camera className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Scanner QR</span>
                      </button>
                    </div>
                  </div>

                  <input
                    type="text"
                    dir="ltr"
                    value={licenseKey}
                    onChange={handleKeyChange}
                    placeholder="MOBI-LIFE-XXXX-XXXX"
                    autoFocus
                    disabled={loading}
                    className="w-full min-h-[48px] px-4 py-3.5 bg-pos-card border border-pos-border focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded-2xl font-mono text-center text-sm sm:text-base font-bold tracking-wider text-emerald-700 dark:text-emerald-300 placeholder:text-pos-muted/50 transition outline-none"
                  />

                  {/* Live Formula Detection Pill */}
                  {formulaInfo && (
                    <div className={`mt-2 px-3 py-1.5 rounded-xl border flex items-center justify-between text-[11px] font-semibold animate-in fade-in ${formulaInfo.color}`}>
                      <span className="flex items-center gap-1">
                        <Sparkles className="w-3 h-3 shrink-0" aria-hidden="true" />
                        {formulaInfo.label}
                      </span>
                      <span className="text-[10px] opacity-80 font-normal">{formulaInfo.desc}</span>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-pos-muted mb-1">
                    Nom du terminal (optionnel) :
                  </label>
                  <input
                    type="text"
                    value={friendlyName}
                    onChange={(e) => setFriendlyName(e.target.value)}
                    placeholder="ex: Abdelkader Benali, Tablette Vendeur"
                    disabled={loading}
                    className="w-full min-h-[48px] px-4 py-2.5 bg-pos-card border border-pos-border focus:border-emerald-500 rounded-xl text-xs text-pos-text placeholder:text-pos-muted/50 transition outline-none"
                  />
                </div>

                {/* Advanced Server Options Accordion */}
                <div className="pt-0.5">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="min-h-[48px] px-2 rounded-xl text-[11px] font-medium text-pos-muted hover:text-pos-text flex items-center gap-1.5 transition"
                  >
                    <Server className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Options de serveur avancées</span>
                    {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />}
                  </button>

                  {showAdvanced && (
                    <div className="mt-2 p-3 bg-pos-card border border-pos-border rounded-xl space-y-2 text-xs animate-in slide-in-from-top-2">
                      <div>
                        <span className="text-[10px] text-pos-muted block mb-1">URL Serveur de Licence :</span>
                        <input
                          type="url"
                          dir="ltr"
                          value={serverUrl}
                          onChange={(e) => setServerUrl(e.target.value)}
                          placeholder="https://..."
                          className="w-full min-h-[48px] px-3 py-2 bg-pos-panel border border-pos-border rounded-lg font-mono text-[11px] text-pos-text outline-none"
                        />
                        <div className="mt-1 flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => setServerUrl('http://127.0.0.1:8787')}
                            className="min-h-[48px] px-2 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 hover:underline flex items-center"
                          >
                            ⚡ Utiliser serveur local (<bdi dir="ltr">http://127.0.0.1:8787</bdi>)
                          </button>
                          <button
                            type="button"
                            onClick={() => setServerUrl(DEFAULT_LICENSING_ENDPOINT)}
                            className="min-h-[48px] px-2 text-[10px] font-semibold text-pos-muted hover:text-pos-text flex items-center"
                          >
                            Défaut Cloud
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Submit Button */}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3.5 px-4 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-bold text-sm rounded-2xl shadow-lg shadow-emerald-500/20 transition flex items-center justify-center gap-2 active:scale-[0.98] min-h-[48px]"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                      <span>Vérification & Activation...</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                      <span>Activer la Licence</span>
                    </>
                  )}
                </button>
              </form>
            ) : (
              /* Activation by Offline Token Form */
              <form onSubmit={handleActivateOfflineToken} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-pos-text mb-1.5 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                    Jeton Cryptographique Signé (JWT Ed25519) :
                  </label>
                  <textarea
                    dir="ltr"
                    value={offlineToken}
                    onChange={(e) => setOfflineToken(e.target.value)}
                    placeholder="Collez ici le jeton eyJhbGciOi..."
                    rows={4}
                    autoFocus
                    disabled={loading}
                    className="w-full px-3 py-2 bg-pos-card border border-pos-border focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded-2xl font-mono text-[11px] text-pos-text placeholder:text-pos-muted/50 transition outline-none resize-none"
                  />
                  <p className="text-[10px] text-pos-muted mt-1">
                    Générez ce jeton via le logiciel d'administration ou la commande <code className="text-emerald-700 dark:text-emerald-400"><bdi dir="ltr">npm run license:token</bdi></code>.
                  </p>
                </div>

                {/* Submit Button */}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3.5 px-4 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-bold text-sm rounded-2xl shadow-lg shadow-emerald-500/20 transition flex items-center justify-center gap-2 active:scale-[0.98] min-h-[48px]"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                      <span>Validation du jeton...</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                      <span>Valider le Jeton Hors-Ligne</span>
                    </>
                  )}
                </button>
              </form>
            )}

            {/* Assistance Footer */}
            <div className="pt-2 border-t border-pos-border/60 flex items-center justify-between text-[11px] text-pos-muted">
              <span className="flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                <span>Fonctionne 100% hors-ligne après validation</span>
              </span>
              <button
                type="button"
                onClick={handleOpenWhatsAppSupport}
                className="min-h-[48px] px-2.5 rounded-xl text-emerald-700 dark:text-emerald-400 hover:bg-pos-card flex items-center gap-1 font-semibold transition"
              >
                <HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Assistance</span>
              </button>
            </div>

            {/* ═════════════════════════════════════════════════════════
                M2 TRIAL FUNNEL — 1-day trial, 1 PC + 1 phone (D1/D3/D4).
                Two fields, no licence minted here: the lead goes to the
                owner, contact and payment happen on WhatsApp. Rate-limited
                server-side; retries share one idempotency key per install.
                ═════════════════════════════════════════════════════════ */}
            <div className="pt-3 mt-1 border-t border-pos-border/60">
              {!trialDone ? (
                <>
                  <button
                    type="button"
                    onClick={() => setTrialOpen((v) => !v)}
                    aria-expanded={trialOpen}
                    data-testid="trial-toggle"
                    className="w-full min-h-[48px] px-2 rounded-xl flex items-center justify-between gap-2 text-[11px] font-semibold text-pos-muted hover:text-pos-text transition"
                  >
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" aria-hidden="true" />
                      <span>Pas encore de clé ? Essai gratuit — 1 jour</span>
                    </span>
                    {!trialOpen ? (
                      <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                    ) : (
                      <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                  </button>

                  {trialOpen && (
                    <form onSubmit={handleTrialSubmit} className="mt-2.5 space-y-2.5" data-testid="trial-form">
                      <p className="text-[10px] text-pos-muted leading-relaxed">
                        Laissez vos coordonnées : nous vous contactons sur WhatsApp et
                        vous recevez un essai d'un jour (1 PC + 1 mobile). Aucun paiement,
                        aucune carte.
                      </p>
                      <div>
                        <label htmlFor="trial-name" className="block text-[10px] font-medium text-pos-muted mb-1">
                          Votre nom :
                        </label>
                        <input
                          id="trial-name"
                          type="text"
                          value={trialName}
                          onChange={(e) => {
                            setTrialName(e.target.value);
                            if (trialError) setTrialError(null);
                          }}
                          placeholder="Prénom et nom"
                          maxLength={80}
                          autoComplete="name"
                          disabled={trialBusy}
                          data-testid="trial-name"
                          className="w-full min-h-[48px] px-3 py-2 bg-pos-card border border-pos-border focus:border-sky-500 focus:ring-1 focus:ring-sky-500 rounded-xl text-sm text-pos-text placeholder:text-pos-muted/50 outline-none disabled:opacity-50"
                        />
                      </div>
                      <div>
                        <label htmlFor="trial-whatsapp" className="block text-[10px] font-medium text-pos-muted mb-1">
                          Votre numéro WhatsApp :
                        </label>
                        <input
                          id="trial-whatsapp"
                          type="tel"
                          dir="ltr"
                          inputMode="tel"
                          value={trialWhatsapp}
                          onChange={(e) => {
                            setTrialWhatsapp(e.target.value);
                            if (trialError) setTrialError(null);
                          }}
                          placeholder="Ex : +213 555 12 34 56"
                          maxLength={20}
                          autoComplete="tel"
                          disabled={trialBusy}
                          data-testid="trial-whatsapp"
                          className="w-full min-h-[48px] px-3 py-2 bg-pos-card border border-pos-border focus:border-sky-500 focus:ring-1 focus:ring-sky-500 rounded-xl text-sm text-pos-text placeholder:text-pos-muted/50 outline-none disabled:opacity-50"
                        />
                      </div>

                      {trialError && (
                        <div role="alert" className="p-2.5 bg-rose-500/15 border border-rose-500/50 rounded-xl text-rose-800 dark:text-rose-200 text-[11px] flex items-start gap-2">
                          <AlertTriangle className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
                          <span className="font-medium leading-relaxed">{trialError}</span>
                        </div>
                      )}

                      <button
                        type="submit"
                        disabled={trialBusy}
                        data-testid="trial-submit"
                        className="w-full py-2.5 px-4 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-bold text-xs rounded-xl transition flex items-center justify-center gap-2 active:scale-[0.98] min-h-[48px]"
                      >
                        {trialBusy ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                            <span>Envoi en cours…</span>
                          </>
                        ) : (
                          <>
                            <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Demander mon essai gratuit</span>
                          </>
                        )}
                      </button>
                    </form>
                  )}
                </>
              ) : (
                <div className="mt-2.5 p-3.5 bg-emerald-500/10 border border-emerald-500/40 rounded-2xl space-y-2.5" data-testid="trial-success">
                  <div className="flex items-center gap-1.5 text-emerald-800 dark:text-emerald-300 text-xs font-bold">
                    <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>{trialDone === 'registered' ? 'Demande envoyée !' : 'Vous êtes déjà inscrit !'}</span>
                  </div>
                  <p className="text-[11px] text-pos-muted leading-relaxed">
                    Pour aller plus vite, copiez ce message et envoyez-le nous sur WhatsApp.
                    On vous répond et on active votre essai d'un jour.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      const msg = encodeURIComponent(
                        `Bonjour MobiPOS ! Je m'appelle ${trialName.trim().replace(/\s+/g, ' ')} et je souhaite tester l'application gratuitement pendant 1 jour.`
                      );
                      window.open(`https://wa.me/${TRIAL_WHATSAPP_OWNER}?text=${msg}`, '_blank');
                    }}
                    data-testid="trial-whatsapp-open"
                    className="w-full min-h-[48px] px-4 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-500/25 text-xs font-bold flex items-center justify-center gap-2 transition active:scale-[0.98]"
                  >
                    <MessageCircle className="w-4 h-4" aria-hidden="true" />
                    <span>Ouvrir WhatsApp</span>
                  </button>
                </div>
              )}
            </div>

            {/* ═══════════════════════════════════════════════════════════════
                SCOPED EMERGENCY COMPLIANCE EXPORT
                Statutory retention must not depend on a paid licence. This
                panel is the ONLY data access available while locked, and it is
                read-only by construction (SQLITE_OPEN_READ_ONLY +
                PRAGMA query_only). It requires a re-verified Owner/Manager
                PIN — never an existing session — and writes a tamper-evident
                EMERGENCY_DATA_EXPORT audit row carrying each file's SHA-256.
                ═══════════════════════════════════════════════════════════════ */}
            <div className="pt-3 mt-1 border-t border-pos-border/60">
              <button
                type="button"
                onClick={() => {
                  setShowExportPanel((prev) => {
                    const next = !prev;
                    if (!next) {
                      setExportError(null);
                      setExportResult(null);
                    }
                    return next;
                  });
                }}
                className="w-full min-h-[48px] px-2 rounded-xl flex items-center justify-between gap-2 text-[11px] font-semibold text-pos-muted hover:text-pos-text transition"
                aria-expanded={isExportExpanded}
              >
                <span className="flex items-center gap-1.5">
                  <Download className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" aria-hidden="true" />
                  <span>Exporter les registres comptables (conformité)</span>
                </span>
                {!isExportExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                ) : (
                  <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                )}
              </button>

              {isExportExpanded && (
                <div className="mt-2.5 space-y-2.5">
                  <p className="text-[10px] text-pos-muted leading-relaxed">
                    Extraction en lecture seule via une connexion SQLite dédiée.
                    Les données clients, identifiants appareils et secrets ne sont
                    jamais inclus. Chaque export est journalisé.
                  </p>

                  <form onSubmit={handleEmergencyExport} className="space-y-2">
                    <div>
                      <label className="block text-[10px] font-medium text-pos-muted mb-1">
                        PIN Gérant (autorisation requise) :
                      </label>
                      <input
                        type="password"
                        dir="ltr"
                        inputMode="numeric"
                        value={exportPin}
                        onChange={(e) => {
                          setExportPin(e.target.value);
                          if (exportError) setExportError(null);
                        }}
                        placeholder="••••"
                        disabled={exportBusy}
                        autoComplete="off"
                        className="w-full min-h-[48px] px-3 py-2 bg-pos-card border border-pos-border focus:border-sky-500 focus:ring-1 focus:ring-sky-500 rounded-xl text-sm text-center tracking-[0.4em] text-pos-text placeholder:text-pos-muted/50 outline-none disabled:opacity-50"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={exportBusy}
                      className="w-full py-2.5 px-4 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-bold text-xs rounded-xl transition flex items-center justify-center gap-2 active:scale-[0.98] min-h-[48px]"
                    >
                      {exportBusy ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                          <span>{exportProgress || 'Export en cours…'}</span>
                        </>
                      ) : (
                        <>
                          <Download className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Générer les registres CSV</span>
                        </>
                      )}
                    </button>
                  </form>

                  {exportError && (
                    <div role="alert" className="p-2.5 bg-rose-500/15 border border-rose-500/50 rounded-xl text-rose-800 dark:text-rose-200 text-[11px] flex items-start gap-2">
                      <AlertTriangle className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
                      <span className="font-medium leading-relaxed">{exportError}</span>
                    </div>
                  )}

                  {exportResult && (() => {
                    const isDegradedOrUnauth =
                      !exportResult.manifestMac ||
                      exportResult.integrityState === 'tamper' ||
                      exportResult.integrityState === 'clock' ||
                      exportResult.integrityState === 'UNAUTHENTICATED';
                    return isDegradedOrUnauth ? (
                      <div className="p-3 bg-amber-500/15 border border-amber-500/40 rounded-xl space-y-2 text-pos-text">
                        <div className="flex items-center gap-1.5 text-amber-800 dark:text-amber-300 text-[11px] font-bold">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                          <span>Export terminé (NON AUTHENTIFIÉ — Récupération uniquement) — {summarizeExport(exportResult)}</span>
                        </div>
                        <p className="text-[10px] text-amber-800/90 dark:text-amber-300/90 leading-relaxed">
                          {!exportResult.manifestMac
                            ? "Absence de signature MAC du manifeste : ces fichiers sont réservés à la récupération et ne constituent pas une preuve opposable."
                            : `État d'intégrité dégradé (${exportResult.integrityState}) : export sous quarantaine.`}
                        </p>
                        <div className="text-[10px] text-pos-muted font-mono break-all">
                          <bdi dir="ltr">{exportResult.exportDir}</bdi>
                        </div>
                        <ul className="space-y-1">
                          {exportResult.files.map((f) => (
                            <li key={f.fileName} className="text-[10px] text-pos-muted">
                              <span className="text-pos-text font-semibold"><bdi dir="ltr">{f.fileName}</bdi></span>
                              {' · '}
                              {f.rowCount.toLocaleString('fr-FR')} lignes
                              <div className="font-mono text-[9px] text-pos-muted/80 break-all">
                                SHA-256 <bdi dir="ltr">{f.sha256}</bdi>
                              </div>
                            </li>
                          ))}
                        </ul>
                        <div className="text-[9px] text-pos-muted pt-1 border-t border-amber-500/30">
                          Journalisé sous l&apos;identifiant{' '}
                          <span className="font-mono"><bdi dir="ltr">{exportResult.auditEventId}</bdi></span> —
                          vérifiez ce journal avant toute diffusion externe.
                        </div>
                      </div>
                    ) : (
                      <div className="p-3 bg-emerald-500/15 border border-emerald-500/40 rounded-xl space-y-2">
                        <div className="flex items-center gap-1.5 text-emerald-800 dark:text-emerald-300 text-[11px] font-bold">
                          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Export terminé — {summarizeExport(exportResult)}</span>
                        </div>
                        <div className="text-[10px] text-pos-muted font-mono break-all">
                          <bdi dir="ltr">{exportResult.exportDir}</bdi>
                        </div>
                        <ul className="space-y-1">
                          {exportResult.files.map((f) => (
                            <li key={f.fileName} className="text-[10px] text-pos-muted">
                              <span className="text-pos-text font-semibold"><bdi dir="ltr">{f.fileName}</bdi></span>
                              {' · '}
                              {f.rowCount.toLocaleString('fr-FR')} lignes
                              <div className="font-mono text-[9px] text-pos-muted/80 break-all">
                                SHA-256 <bdi dir="ltr">{f.sha256}</bdi>
                              </div>
                            </li>
                          ))}
                        </ul>
                        <div className="text-[9px] text-pos-muted pt-1 border-t border-emerald-500/30">
                          Journalisé sous l&apos;identifiant{' '}
                          <span className="font-mono"><bdi dir="ltr">{exportResult.auditEventId}</bdi></span> —
                          vérifiez ce journal avant toute diffusion externe.
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

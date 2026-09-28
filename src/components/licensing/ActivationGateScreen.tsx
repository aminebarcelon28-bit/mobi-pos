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
  X
} from 'lucide-react';
import { sanitizeLicenseKey, formatLicenseKeyForDisplay } from '../../licensing/keyFormat';
import {
  activateLicense,
  recheckLicenseStatus,
  DEFAULT_LICENSING_ENDPOINT
} from '../../licensing/client';
import { resolveDeviceFingerprint } from '../../licensing/hwid';
import {
  loadSuspensionState,
  getLastActiveLicenseKey,
  clearSuspensionState,
  type LicenseSuspensionState
} from '../../licensing/store';
import {
  getDetailedPlatform,
  type DevicePlatformDetails
} from '../../utils/platform';
import type { HardwareFingerprintResult } from '../../api/license';

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
  const [licenseKey, setLicenseKey] = useState('');
  const [friendlyName, setFriendlyName] = useState('');
  const [loading, setLoading] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [error, setError] = useState<string | null>(initialError || null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [hwid, setHwid] = useState<HardwareFingerprintResult | null>(null);
  const [deviceType, setDeviceType] = useState<'desktop' | 'mobile'>('desktop');
  const [platformInfo, setPlatformInfo] = useState<DevicePlatformDetails>(getDetailedPlatform());
  const [copiedHwid, setCopiedHwid] = useState(false);
  const [copiedPasteSuccess, setCopiedPasteSuccess] = useState(false);

  const [mode, setMode] = useState<'key' | 'token'>('key');
  const [offlineToken, setOfflineToken] = useState('');
  const [showScanner, setShowScanner] = useState(false);

  // Suspension detection
  const [suspension, setSuspension] = useState<LicenseSuspensionState | null>(null);
  const [forcedNewKey, setForcedNewKey] = useState(false);

  // Advanced options accordion
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [serverUrl, setServerUrl] = useState(DEFAULT_LICENSING_ENDPOINT);

  useEffect(() => {
    // 1. Detect platform details
    const p = getDetailedPlatform();
    setPlatformInfo(p);
    setDeviceType(p.roleHint);

    // 2. Check persistent suspension state
    const currentSuspension = loadSuspensionState();
    if (currentSuspension && currentSuspension.suspended) {
      setSuspension(currentSuspension);
    } else if (initialError && (initialError.toLowerCase().includes('suspend') || initialError.toLowerCase().includes('révoqu'))) {
      setSuspension({
        suspended: true,
        reason: initialError,
        suspendedAt: Date.now(),
        licenseKey: getLastActiveLicenseKey() || undefined,
      });
    }

    // 3. Resolve hardware fingerprint
    resolveDeviceFingerprint()
      .then((res) => {
        setHwid(res);
        const isMob = p.category === 'mobile' || p.category === 'tablet';
        setFriendlyName(isMob ? 'Mobile Vendeur' : 'Caisse Principale');
      })
      .catch(console.warn);

    // 4. Prepopulate last known key if available
    const lastKey = getLastActiveLicenseKey();
    if (lastKey && !licenseKey) {
      setLicenseKey(formatLicenseKeyForDisplay(lastKey));
    }
  }, [initialError]);

  // Live Formula Detection from Key Tag
  const formulaInfo = useMemo(() => {
    const raw = licenseKey.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (raw.includes('LIFE')) {
      return { label: '✨ À VIE (LIFETIME)', desc: 'Licence Illimitée Permanente', color: 'text-emerald-400 bg-emerald-950/70 border-emerald-500/40' };
    }
    if (raw.includes('90D')) {
      return { label: '📅 90 JOURS (3 MOIS)', desc: 'Abonnement Trimestriel', color: 'text-blue-400 bg-blue-950/70 border-blue-500/40' };
    }
    if (raw.includes('24H') || raw.includes('DEMO')) {
      return { label: '⚡ DÉMO 24 HEURES', desc: 'Essai Fonctionnel Complet', color: 'text-amber-400 bg-amber-950/70 border-amber-500/40' };
    }
    if (raw.includes('30D')) {
      return { label: '📅 30 JOURS (1 MOIS)', desc: 'Abonnement Mensuel', color: 'text-indigo-400 bg-indigo-950/70 border-indigo-500/40' };
    }
    if (raw.includes('1Y')) {
      return { label: '📅 1 AN (ANNUEL)', desc: 'Abonnement Annuel', color: 'text-teal-400 bg-teal-950/70 border-teal-500/40' };
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950 text-slate-100 p-3 sm:p-6 select-none overflow-y-auto pt-[max(0.75rem,var(--safe-top))] pb-[max(0.75rem,var(--safe-bottom))]">
      {/* Background Ambience */}
      <div className="absolute inset-0 bg-gradient-to-tr from-slate-950 via-slate-900 to-slate-950 pointer-events-none" />
      <div
        className={`absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[32rem] h-[32rem] rounded-full blur-3xl pointer-events-none transition-all duration-700 ${
          isSuspendedView ? 'bg-rose-500/10' : 'bg-emerald-500/10'
        }`}
      />

      {/* QR Code Scanner Overlay */}
      {showScanner && (
        <div className="fixed inset-0 z-60 bg-black/90 backdrop-blur-md flex flex-col items-center justify-center p-4">
          <div className="relative w-full max-w-sm bg-slate-900 border border-slate-700 rounded-3xl overflow-hidden shadow-2xl p-4 flex flex-col items-center">
            <div className="w-full flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2 font-bold text-sm text-purple-400">
                <Camera className="w-4 h-4" />
                <span>Scanner le QR Code de Licence</span>
              </div>
              <button
                type="button"
                onClick={() => setShowScanner(false)}
                className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="w-full aspect-square mt-3 rounded-2xl overflow-hidden bg-black relative flex items-center justify-center">
              <Suspense
                fallback={
                  <div className="flex flex-col items-center gap-2 text-slate-400 text-xs">
                    <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
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

            <p className="text-[11px] text-slate-400 text-center mt-3">
              Pointez la caméra vers le QR Code affiché dans le logiciel d'administration MobiPOS.
            </p>
          </div>
        </div>
      )}

      {/* Main Container Card */}
      <div
        className={`relative w-full ${
          isMobileLayout ? 'max-w-md' : 'max-w-xl'
        } bg-slate-900/95 border border-slate-800/90 rounded-3xl shadow-2xl p-5 sm:p-7 backdrop-blur-xl animate-in fade-in zoom-in-95 duration-200`}
      >
        {/* ========================================================================= */}
        {/* VIEW A: SUSPENDED LICENSE STATE                                           */}
        {/* ========================================================================= */}
        {isSuspendedView ? (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
            {/* Header Alert Banner */}
            <div className="text-center pt-1 pb-2">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-3xl bg-rose-500/10 border border-rose-500/30 text-rose-400 mb-3 shadow-inner ring-4 ring-rose-500/5">
                <ShieldAlert className="w-8 h-8" />
              </div>
              <h1 className="text-lg sm:text-xl font-extrabold text-white tracking-tight flex items-center justify-center gap-2">
                <span>Accès Temporairement Suspendu</span>
              </h1>
              <p className="text-xs text-rose-300 font-medium mt-1 max-w-sm mx-auto">
                {suspension?.reason || 'Cette licence a été suspendue par l’administrateur MobiPOS.'}
              </p>
            </div>

            {/* Client & Device Summary Card */}
            <div className="bg-slate-950/80 border border-slate-800/80 rounded-2xl p-4 space-y-2.5 text-xs">
              <div className="flex items-center justify-between pb-2 border-b border-slate-800/60">
                <span className="text-slate-400 font-medium">Statut de la licence :</span>
                <span className="px-2.5 py-0.5 rounded-full bg-rose-950 border border-rose-500/40 text-rose-300 font-bold text-[10px] flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
                  SUSPENDUE
                </span>
              </div>

              {suspension?.licenseKey && (
                <div className="flex items-center justify-between pb-2 border-b border-slate-800/60">
                  <span className="text-slate-400 font-medium">Clé associée :</span>
                  <span className="font-mono font-bold text-slate-200 select-all">
                    {suspension.licenseKey}
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between pb-2 border-b border-slate-800/60">
                <span className="text-slate-400 font-medium">Cet appareil :</span>
                <span className="font-semibold text-slate-200 flex items-center gap-1">
                  {platformInfo.category === 'mobile' ? (
                    <Smartphone className="w-3.5 h-3.5 text-purple-400" />
                  ) : platformInfo.category === 'tablet' ? (
                    <Tablet className="w-3.5 h-3.5 text-blue-400" />
                  ) : (
                    <Monitor className="w-3.5 h-3.5 text-emerald-400" />
                  )}
                  {platformInfo.displayName}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <div className="min-w-0 pr-2">
                  <span className="text-[11px] text-slate-400 block font-medium">Empreinte Matériel (HWID) :</span>
                  <span className="font-mono text-[11px] font-bold text-slate-300 truncate block select-all">
                    {hwid?.formatted || 'Détection...'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleCopyHwid}
                  className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition shrink-0"
                  title="Copier HWID"
                >
                  {copiedHwid ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {/* Error feedback if recheck fails */}
            {error && (
              <div className="p-3 bg-rose-950/70 border border-rose-500/50 rounded-2xl text-rose-200 text-xs flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div className="flex-1 font-medium">{error}</div>
              </div>
            )}

            {/* Success feedback */}
            {successMsg && (
              <div className="p-3 bg-emerald-950/70 border border-emerald-500/50 rounded-2xl text-emerald-200 text-xs flex items-center gap-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
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
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Vérification auprès du serveur...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4" />
                    <span>Vérifier la Réactivation</span>
                  </>
                )}
              </button>

              {/* 2. Direct WhatsApp Support */}
              <button
                type="button"
                onClick={handleOpenWhatsAppSupport}
                className="w-full py-3 px-4 bg-slate-800 hover:bg-slate-700 text-emerald-400 font-semibold text-xs rounded-2xl border border-slate-700/80 transition flex items-center justify-center gap-2 active:scale-[0.98] min-h-[44px]"
              >
                <MessageCircle className="w-4 h-4 text-emerald-400" />
                <span>Contacter l'Assistance WhatsApp</span>
                <ExternalLink className="w-3 h-3 opacity-60 ml-0.5" />
              </button>

              {/* 3. Switch to Another Key */}
              <button
                type="button"
                onClick={() => setForcedNewKey(true)}
                className="w-full py-2 text-center text-xs text-slate-400 hover:text-slate-200 transition"
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
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 mb-2.5 shadow-inner">
                <Lock className="w-7 h-7" />
              </div>
              <h1 className="text-xl font-bold tracking-tight text-white flex items-center justify-center gap-2">
                MobiPOS <span className="text-emerald-400 font-normal">Licence</span>
              </h1>
              <p className="text-xs text-slate-400 mt-0.5">
                Activation sécurisée par signature cryptographique Ed25519
              </p>
            </div>

            {/* Platform Detection & HWID Card */}
            <div className="bg-slate-950/70 border border-slate-800/80 rounded-2xl p-3.5 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-slate-400">Terminal détecté :</span>
                <span className="text-[10px] font-bold text-emerald-400 bg-emerald-950/80 border border-emerald-500/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                  {platformInfo.badgeLabel}
                </span>
              </div>

              <div className="flex items-center justify-between pt-1 border-t border-slate-800/50">
                <div className="min-w-0 pr-2">
                  <div className="flex items-center gap-1.5 text-slate-400 mb-0.5">
                    <Cpu className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span className="text-[11px] font-medium">Empreinte Matérielle (HWID) :</span>
                  </div>
                  <div className="font-mono font-bold text-slate-200 truncate select-all">
                    {hwid ? hwid.formatted : 'Calcul de l’empreinte...'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleCopyHwid}
                  title="Copier l'identifiant matériel"
                  className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition shrink-0 active:scale-95"
                >
                  {copiedHwid ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Device Role Selector (PC Caisse vs Mobile Compagnon) */}
            <div>
              <div className="flex items-center justify-between text-[11px] font-semibold text-slate-400 mb-1.5">
                <span>Rôle de ce terminal :</span>
                <span className="text-[10px] text-slate-500">
                  {deviceType === 'desktop' ? 'Caisse Principale (PC)' : 'Vendeur / Rayon (Mobile)'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 bg-slate-950 p-1 rounded-2xl border border-slate-800/80">
                <button
                  type="button"
                  onClick={() => {
                    setDeviceType('desktop');
                    setFriendlyName('Caisse Principale');
                  }}
                  className={`py-2 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                    deviceType === 'desktop'
                      ? 'bg-slate-800 text-emerald-400 border border-emerald-500/30 shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Monitor className="w-3.5 h-3.5" />
                  <span>Poste Caisse PC</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDeviceType('mobile');
                    setFriendlyName('Mobile Vendeur');
                  }}
                  className={`py-2 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                    deviceType === 'mobile'
                      ? 'bg-slate-800 text-purple-400 border border-purple-500/30 shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Smartphone className="w-3.5 h-3.5" />
                  <span>Mobile Compagnon</span>
                </button>
              </div>
            </div>

            {/* Feedback Alerts */}
            {error && (
              <div className="p-3.5 bg-rose-950/60 border border-rose-500/50 rounded-2xl text-rose-200 text-xs flex items-start gap-2.5 animate-in shake">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div className="flex-1 leading-relaxed font-medium">{error}</div>
              </div>
            )}

            {successMsg && (
              <div className="p-3.5 bg-emerald-950/60 border border-emerald-500/50 rounded-2xl text-emerald-200 text-xs flex items-center gap-2.5 animate-in fade-in">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <div className="flex-1 font-medium">{successMsg}</div>
              </div>
            )}

            {/* Mode Switcher Tabs */}
            <div className="flex bg-slate-950 p-1 rounded-2xl border border-slate-800/80">
              <button
                type="button"
                onClick={() => { setMode('key'); setError(null); }}
                className={`flex-1 py-2 text-xs font-semibold rounded-xl transition ${
                  mode === 'key'
                    ? 'bg-slate-800 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Clé d'Activation
              </button>
              <button
                type="button"
                onClick={() => { setMode('token'); setError(null); }}
                className={`flex-1 py-2 text-xs font-semibold rounded-xl transition ${
                  mode === 'token'
                    ? 'bg-slate-800 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Jeton Hors-Ligne
              </button>
            </div>

            {mode === 'key' ? (
              /* Activation by Key Form */
              <form onSubmit={handleActivate} className="space-y-3.5">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                      <Key className="w-3.5 h-3.5 text-emerald-400" />
                      Clé d'Activation :
                    </label>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={handlePasteKey}
                        title="Coller depuis le presse-papier"
                        className="text-[11px] font-medium text-emerald-400 hover:text-emerald-300 bg-emerald-950/60 hover:bg-emerald-900/60 border border-emerald-500/30 px-2 py-0.5 rounded-lg flex items-center gap-1 transition active:scale-95"
                      >
                        <ClipboardPaste className="w-3 h-3" />
                        <span>{copiedPasteSuccess ? 'Collé ✓' : 'Coller'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowScanner(true)}
                        title="Scanner un QR Code de licence"
                        className="text-[11px] font-medium text-purple-400 hover:text-purple-300 bg-purple-950/60 hover:bg-purple-900/60 border border-purple-500/30 px-2 py-0.5 rounded-lg flex items-center gap-1 transition active:scale-95"
                      >
                        <Camera className="w-3 h-3" />
                        <span>Scanner QR</span>
                      </button>
                    </div>
                  </div>

                  <input
                    type="text"
                    value={licenseKey}
                    onChange={handleKeyChange}
                    placeholder="MOBI-LIFE-XXXX-XXXX"
                    autoFocus
                    disabled={loading}
                    className="w-full px-4 py-3.5 bg-slate-950 border border-slate-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded-2xl font-mono text-center text-sm sm:text-base font-bold tracking-wider text-emerald-300 placeholder:text-slate-600 transition outline-none"
                  />

                  {/* Live Formula Detection Pill */}
                  {formulaInfo && (
                    <div className={`mt-2 px-3 py-1.5 rounded-xl border flex items-center justify-between text-[11px] font-semibold animate-in fade-in ${formulaInfo.color}`}>
                      <span className="flex items-center gap-1">
                        <Sparkles className="w-3 h-3 shrink-0" />
                        {formulaInfo.label}
                      </span>
                      <span className="text-[10px] opacity-80 font-normal">{formulaInfo.desc}</span>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">
                    Nom du terminal (optionnel) :
                  </label>
                  <input
                    type="text"
                    value={friendlyName}
                    onChange={(e) => setFriendlyName(e.target.value)}
                    placeholder="ex: Caisse Principale, Tablette Vendeur"
                    disabled={loading}
                    className="w-full px-4 py-2.5 bg-slate-950/80 border border-slate-800 focus:border-slate-700 rounded-xl text-xs text-slate-200 placeholder:text-slate-600 transition outline-none"
                  />
                </div>

                {/* Advanced Server Options Accordion */}
                <div className="pt-0.5">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="text-[11px] text-slate-500 hover:text-slate-400 flex items-center gap-1 transition"
                  >
                    <Server className="w-3 h-3" />
                    Options de serveur avancées
                    {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>

                  {showAdvanced && (
                    <div className="mt-2 p-3 bg-slate-950/60 border border-slate-800 rounded-xl space-y-2 text-xs animate-in slide-in-from-top-2">
                      <div>
                        <span className="text-[10px] text-slate-400 block mb-1">URL Serveur de Licence :</span>
                        <input
                          type="url"
                          value={serverUrl}
                          onChange={(e) => setServerUrl(e.target.value)}
                          placeholder="https://..."
                          className="w-full px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg font-mono text-[11px] text-slate-300 outline-none"
                        />
                        <div className="mt-1 flex items-center justify-between">
                          <button
                            type="button"
                            onClick={() => setServerUrl('http://127.0.0.1:8787')}
                            className="text-[10px] text-emerald-400 hover:underline"
                          >
                            ⚡ Utiliser serveur local (http://127.0.0.1:8787)
                          </button>
                          <button
                            type="button"
                            onClick={() => setServerUrl(DEFAULT_LICENSING_ENDPOINT)}
                            className="text-[10px] text-slate-500 hover:text-slate-400"
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
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Vérification & Activation...</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4" />
                      <span>Activer la Licence</span>
                    </>
                  )}
                </button>
              </form>
            ) : (
              /* Activation by Offline Token Form */
              <form onSubmit={handleActivateOfflineToken} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                    Jeton Cryptographique Signé (JWT Ed25519) :
                  </label>
                  <textarea
                    value={offlineToken}
                    onChange={(e) => setOfflineToken(e.target.value)}
                    placeholder="Collez ici le jeton eyJhbGciOi..."
                    rows={4}
                    autoFocus
                    disabled={loading}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded-2xl font-mono text-[11px] text-slate-300 placeholder:text-slate-600 transition outline-none resize-none"
                  />
                  <p className="text-[10px] text-slate-500 mt-1">
                    Générez ce jeton via le logiciel d'administration ou la commande <code className="text-emerald-400">npm run license:token</code>.
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
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Validation du jeton...</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4" />
                      <span>Valider le Jeton Hors-Ligne</span>
                    </>
                  )}
                </button>
              </form>
            )}

            {/* Assistance Footer */}
            <div className="pt-2 border-t border-slate-800/60 flex items-center justify-between text-[11px] text-slate-500">
              <span className="flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400/80" />
                <span>Fonctionne 100% hors-ligne après validation</span>
              </span>
              <button
                type="button"
                onClick={handleOpenWhatsAppSupport}
                className="text-emerald-400/90 hover:text-emerald-300 flex items-center gap-1 font-medium transition"
              >
                <HelpCircle className="w-3 h-3" />
                <span>Assistance</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

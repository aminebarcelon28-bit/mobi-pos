import React, { useState, useEffect } from 'react';
import {
  X,
  ShieldCheck,
  Cpu,
  Key,
  Lock,
  QrCode,
  Copy,
  Check,
  LogOut,
  Sparkles,
  RefreshCw,
  MessageCircle,
  ExternalLink,
  Loader2,
  Monitor,
  Smartphone,
  Tablet,
  CheckCircle2,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { resolveDeviceFingerprint } from '../../licensing/hwid';
import { loadStoredLicenseToken } from '../../licensing/store';
import { verifyLicenseToken, type LicenseTokenPayload } from '../../licensing/token';
import { activateLicense, unlinkLicense, recheckLicenseStatus } from '../../licensing/client';
import { sanitizeLicenseKey, formatLicenseKeyForDisplay } from '../../licensing/keyFormat';
import { getDetailedPlatform, type DevicePlatformDetails } from '../../utils/platform';
import { QRCodeImage } from '../ui/QRCodeImage';
import { useToast } from '../ui/Toast';
import type { HardwareFingerprintResult } from '../../api/license';

export const LicensingModal: React.FC = () => {
  const { activeModal, closeModal } = usePosStore();
  const { showToast } = useToast();

  const [hwid, setHwid] = useState<HardwareFingerprintResult | null>(null);
  const [tokenPayload, setTokenPayload] = useState<LicenseTokenPayload | null>(null);
  const [copiedHwid, setCopiedHwid] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [showQrLink, setShowQrLink] = useState(false);
  const [platformInfo, setPlatformInfo] = useState<DevicePlatformDetails>(getDetailedPlatform());

  // Live test & upgrade state
  const [testingConnection, setTestingConnection] = useState(false);
  const [upgradeKey, setUpgradeKey] = useState('');
  const [upgrading, setUpgrading] = useState(false);

  useEffect(() => {
    if (activeModal !== 'licensing') return;

    setPlatformInfo(getDetailedPlatform());

    resolveDeviceFingerprint()
      .then(setHwid)
      .catch(console.warn);

    loadStoredLicenseToken().then((token) => {
      if (token) {
        verifyLicenseToken(token).then((res) => {
          if (res.valid && res.payload) {
            setTokenPayload(res.payload);
          }
        });
      }
    });
  }, [activeModal]);

  if (activeModal !== 'licensing') return null;

  const isLicensed = Boolean(tokenPayload);

  const handleCopyHwid = () => {
    if (!hwid?.formatted) return;
    navigator.clipboard.writeText(hwid.formatted);
    setCopiedHwid(true);
    setTimeout(() => setCopiedHwid(false), 2000);
  };

  const handleCopyKey = () => {
    if (!tokenPayload?.lic_key) return;
    navigator.clipboard.writeText(tokenPayload.lic_key);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const handleLiveServerTest = async () => {
    setTestingConnection(true);
    try {
      const res = await recheckLicenseStatus(tokenPayload?.lic_key);
      if (res.success) {
        showToast('Connexion au serveur de licence réussie ! Licence active.', 'success');
        if (res.payload) setTokenPayload(res.payload);
      } else {
        showToast(`Avertissement : ${res.message}`, 'error');
      }
    } catch (err: any) {
      showToast(err.message || 'Serveur injoignable', 'error');
    } finally {
      setTestingConnection(false);
    }
  };

  const handleOpenWhatsAppSupport = () => {
    const key = tokenPayload?.lic_key || 'INCONNUE';
    const hwidStr = hwid?.formatted || 'INCONNU';
    const text = encodeURIComponent(
      `Bonjour assistance MobiPOS,\n\nJe vous contacte concernant ma licence :\n- Clé : ${key}\n- Appareil : ${platformInfo.displayName} (${hwidStr})\n- Formule : ${tokenPayload?.lic_type || 'N/A'}\n\nPourriez-vous m'assister s'il vous plaît ? Merci.`
    );
    window.open(`https://wa.me/?text=${text}`, '_blank');
  };

  const handleHotUpgrade = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!upgradeKey.trim()) return;

    setUpgrading(true);
    try {
      const res = await activateLicense({ licenseKey: upgradeKey });
      if (res.success && res.payload) {
        setTokenPayload(res.payload);
        setUpgradeKey('');
        showToast('Licence mise à jour avec succès !', 'success');
      } else {
        showToast(res.message || 'Échec de la mise à niveau.', 'error');
      }
    } catch (err: any) {
      showToast(err.message || 'Erreur réseau.', 'error');
    } finally {
      setUpgrading(false);
    }
  };

  const handleUnlink = async () => {
    if (!window.confirm('Voulez-vous vraiment délier cet appareil de cette licence ?')) return;

    try {
      await unlinkLicense();
      setTokenPayload(null);
      closeModal();
      showToast('Appareil délié avec succès. L’application va redémarrer.', 'info');
      setTimeout(() => {
        window.location.reload();
      }, 500);
    } catch {
      showToast('Erreur lors du déliement.', 'error');
    }
  };

  const qrPayload = tokenPayload ? JSON.stringify({ key: tokenPayload.lic_key, v: 1 }) : '';

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 select-none">
      <div className="bg-pos-panel border-t sm:border border-pos-border rounded-t-3xl sm:rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 max-h-[92vh] flex flex-col pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] sm:py-0">
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Modal Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2 text-emerald-400 min-w-0">
            <Lock className="w-5 h-5 shrink-0" />
            <h2 className="text-sm font-bold text-pos-text truncate">
              Gestion de la Licence Client
            </h2>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-4 sm:p-5 space-y-4 flex-1 overflow-y-auto">
          {/* Status Badge */}
          <div
            className={
              isLicensed
                ? 'bg-emerald-950/40 border border-emerald-500/40 rounded-2xl p-4 flex items-center justify-between'
                : 'bg-amber-950/40 border border-amber-500/40 rounded-2xl p-4 flex items-center justify-between'
            }
          >
            <div className="flex items-center gap-3">
              <ShieldCheck
                className={
                  isLicensed ? 'w-8 h-8 text-emerald-400 shrink-0' : 'w-8 h-8 text-amber-400 shrink-0'
                }
              />
              <div>
                <p className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                  {isLicensed
                    ? `Licence ${tokenPayload?.lic_type === 'LIFETIME' ? 'Illimitée à Vie' : tokenPayload?.lic_type}`
                    : 'Licence non activée'}
                  <span className="text-[10px] text-emerald-400 font-normal">
                    ({platformInfo.badgeLabel})
                  </span>
                </p>
                <p
                  className={
                    isLicensed
                      ? 'text-[10px] text-emerald-300 font-mono'
                      : 'text-[10px] text-amber-300 font-mono'
                  }
                >
                  {isLicensed
                    ? 'Signature cryptographique Ed25519 vérifiée • Chiffrement matériel'
                    : 'Aucun jeton cryptographique valide'}
                </p>
              </div>
            </div>
            <span
              className={
                isLicensed
                  ? 'text-[10px] font-bold text-emerald-400 bg-emerald-950 border border-emerald-800 px-2.5 py-1 rounded-lg shrink-0'
                  : 'text-[10px] font-bold text-amber-400 bg-amber-950 border border-amber-800 px-2.5 py-1 rounded-lg shrink-0'
              }
            >
              {isLicensed ? 'ACTIVÉE' : 'INACTIVE'}
            </span>
          </div>

          {/* Details Card */}
          <div className="space-y-2.5 bg-pos-bg border border-pos-border rounded-2xl p-3.5 text-xs">
            {/* Platform detection row */}
            <div className="flex justify-between items-center pb-2 border-b border-pos-border/60">
              <span className="text-pos-muted flex items-center gap-1.5">
                {platformInfo.category === 'mobile' ? (
                  <Smartphone className="w-3.5 h-3.5 text-purple-400" />
                ) : platformInfo.category === 'tablet' ? (
                  <Tablet className="w-3.5 h-3.5 text-blue-400" />
                ) : (
                  <Monitor className="w-3.5 h-3.5 text-emerald-400" />
                )}
                Type d'Appareil Détecté :
              </span>
              <span className="font-semibold text-pos-text flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                {platformInfo.displayName}
              </span>
            </div>

            {/* HWID row */}
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1 pb-2 border-b border-pos-border/60">
              <span className="text-pos-muted flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-emerald-400" /> Empreinte Matérielle (HWID) :
              </span>
              <div className="flex items-center gap-1.5">
                <span className="font-mono font-bold text-pos-text select-all">
                  {hwid ? hwid.formatted : '...'}
                </span>
                <button
                  type="button"
                  onClick={handleCopyHwid}
                  className="p-1 rounded bg-pos-card hover:bg-pos-hover text-pos-muted hover:text-pos-text transition"
                  title="Copier HWID"
                >
                  {copiedHwid ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
            </div>

            {tokenPayload && (
              <>
                {/* License Key row */}
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1 pb-2 border-b border-pos-border/60">
                  <span className="text-pos-muted flex items-center gap-1.5">
                    <Key className="w-3.5 h-3.5 text-emerald-400" /> Clé de Licence :
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-emerald-400 font-bold select-all">
                      {formatLicenseKeyForDisplay(tokenPayload.lic_key)}
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyKey}
                      className="p-1 rounded bg-pos-card hover:bg-pos-hover text-pos-muted hover:text-pos-text transition"
                      title="Copier la clé"
                    >
                      {copiedKey ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-pos-muted">Postes Caisse PC autorisés :</span>
                  <span className="font-bold text-pos-text">{tokenPayload.max_desktops} Poste(s)</span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-pos-muted">Mobiles / Tablettes autorisés :</span>
                  <span className="font-bold text-pos-text">{tokenPayload.max_mobiles} Mobile(s)</span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-pos-muted">Validité / Expiration :</span>
                  <span className="font-bold text-emerald-400">
                    {tokenPayload.lic_type === 'LIFETIME'
                      ? 'Illimitée sans expiration (À Vie)'
                      : new Date(tokenPayload.exp * 1000).toLocaleDateString('fr-DZ')}
                  </span>
                </div>
              </>
            )}
          </div>

          {/* Quick Actions Bar */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <button
              type="button"
              onClick={handleLiveServerTest}
              disabled={testingConnection}
              className="py-2.5 px-3 rounded-xl bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text font-medium flex items-center justify-center gap-1.5 transition active:scale-95"
            >
              {testingConnection ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
              )}
              <span>Tester Serveur</span>
            </button>

            <button
              type="button"
              onClick={handleOpenWhatsAppSupport}
              className="py-2.5 px-3 rounded-xl bg-emerald-950/60 hover:bg-emerald-900/60 border border-emerald-500/30 text-emerald-300 font-semibold flex items-center justify-center gap-1.5 transition active:scale-95"
            >
              <MessageCircle className="w-3.5 h-3.5 text-emerald-400" />
              <span>Support WhatsApp</span>
              <ExternalLink className="w-2.5 h-2.5 opacity-60" />
            </button>
          </div>

          {/* QR Code Linking for Mobiles */}
          {tokenPayload && (
            <div className="bg-pos-card border border-pos-border rounded-2xl p-3.5">
              <button
                type="button"
                onClick={() => setShowQrLink(!showQrLink)}
                className="w-full flex items-center justify-between text-xs font-bold text-emerald-400 hover:text-emerald-300 transition"
              >
                <div className="flex items-center gap-2">
                  <QrCode className="w-4 h-4" />
                  <span>Lier un Mobile Compagnon (QR Code)</span>
                </div>
                <span className="text-[10px] text-pos-muted underline">
                  {showQrLink ? 'Masquer' : 'Afficher'}
                </span>
              </button>

              {showQrLink && (
                <div className="mt-3.5 pt-3.5 border-t border-pos-border/60 flex flex-col items-center text-center animate-in fade-in">
                  <div className="p-3 bg-white rounded-2xl shadow-md mb-2">
                    <QRCodeImage value={qrPayload} size={150} />
                  </div>
                  <p className="text-[11px] text-pos-muted max-w-xs leading-relaxed">
                    Scannez ce code QR avec la caméra de l'application mobile MobiPOS pour activer
                    instantanément le smartphone vendeur sans taper la clé.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Hot Upgrade Form */}
          <div className="bg-pos-card border border-pos-border rounded-2xl p-3.5">
            <h3 className="text-xs font-bold text-pos-text mb-2 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              Changer ou Renouveler la Licence :
            </h3>
            <form onSubmit={handleHotUpgrade} className="flex gap-2">
              <input
                type="text"
                value={upgradeKey}
                onChange={(e) =>
                  setUpgradeKey(formatLicenseKeyForDisplay(sanitizeLicenseKey(e.target.value)))
                }
                placeholder="MOBI-LIFE-XXXX-XXXX"
                className="flex-1 px-3 py-2 bg-pos-bg border border-pos-border rounded-xl text-xs font-mono text-emerald-300 placeholder:text-pos-muted outline-none focus:border-emerald-500"
              />
              <button
                type="submit"
                disabled={upgrading || !upgradeKey.trim()}
                className="px-4 py-2 bg-pos-hover hover:bg-pos-border text-pos-text font-bold text-xs rounded-xl disabled:opacity-50 transition active:scale-95"
              >
                {upgrading ? 'Validation…' : 'Appliquer'}
              </button>
            </form>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-3 sm:p-4 border-t border-pos-border bg-pos-card flex items-center justify-between shrink-0">
          {tokenPayload ? (
            <button
              onClick={handleUnlink}
              className="text-[11px] text-rose-400 hover:text-rose-300 flex items-center gap-1 transition"
            >
              <LogOut className="w-3.5 h-3.5" /> Délier ce poste
            </button>
          ) : (
            <div />
          )}
          <button
            onClick={closeModal}
            className="px-5 py-2.5 rounded-xl text-xs font-bold text-pos-text bg-pos-hover hover:bg-pos-border transition min-h-[44px] flex items-center justify-center active-press"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};

import React, { useState, useEffect } from 'react';
import {
  X, Smartphone, ShieldCheck, Copy, Check, Eye, EyeOff, RefreshCw,
  QrCode, DownloadCloud, ExternalLink, Sparkles
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { getCloudCredentials } from '../../sync/keychain';
import { useToast } from '../ui/Toast';
import { QRCodeImage } from '../ui/QRCodeImage';

const ANDROID_APK_URL = 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-Android.apk';
const IOS_IPA_URL = 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-iOS.ipa';
const GITHUB_DOWNLOAD_HUB_URL = 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest';

export const CloudPairingModal: React.FC = () => {
  const { closeModal } = usePosStore();
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState<'download' | 'pair'>('download');
  const [creds, setCreds] = useState<{ url: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<'android' | 'ios' | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedMobilePlatform, setSelectedMobilePlatform] = useState<'android' | 'ios'>('android');

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const stored = await getCloudCredentials();
        if (stored && stored.url && stored.token) {
          setCreds(stored);
        }
      } catch (e) {
        console.warn('Failed to load cloud credentials for pairing:', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const pairingPayload = creds ? JSON.stringify({
    v: 1,
    type: 'mobipos-pair',
    url: creds.url,
    token: creds.token,
    ts: Date.now(),
  }) : '';

  const handleCopy = () => {
    if (!pairingPayload) return;
    navigator.clipboard.writeText(pairingPayload);
    setCopied(true);
    showToast("Code d'appairage copié dans le presse-papier !", 'success');
    setTimeout(() => setCopied(false), 2500);
  };

  const handleCopyDownloadUrl = (platform: 'android' | 'ios') => {
    const url = platform === 'android' ? ANDROID_APK_URL : IOS_IPA_URL;
    navigator.clipboard.writeText(url);
    setCopiedUrl(platform);
    showToast(`Lien de téléchargement ${platform === 'android' ? 'Android' : 'iOS'} copié !`, 'success');
    setTimeout(() => setCopiedUrl(null), 2500);
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div className="bg-pos-card border border-pos-border w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-pos-border bg-pos-panel">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-cyan-500/20 text-cyan-400 flex items-center justify-center">
              <Smartphone className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-black text-pos-text">Application Mobile & Synchronisation</h3>
              <p className="text-[10px] text-pos-muted">Hébergée sur GitHub pour Android et iOS</p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-pos-border bg-pos-panel/50 p-1 gap-1">
          <button
            onClick={() => setActiveTab('download')}
            className={`flex-1 py-2 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === 'download'
                ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20'
                : 'text-pos-muted hover:text-pos-text hover:bg-pos-hover'
            }`}
          >
            <DownloadCloud className="w-3.5 h-3.5" />
            <span>1. Télécharger l'App</span>
          </button>
          <button
            onClick={() => setActiveTab('pair')}
            className={`flex-1 py-2 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === 'pair'
                ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20'
                : 'text-pos-muted hover:text-pos-text hover:bg-pos-hover'
            }`}
          >
            <QrCode className="w-3.5 h-3.5" />
            <span>2. Lier la Boutique</span>
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 text-xs max-h-[75vh] overflow-y-auto">
          {activeTab === 'download' ? (
            <div className="space-y-4">
              {/* Platform Selector Buttons */}
              <div className="flex gap-2">
                <button
                  onClick={() => setSelectedMobilePlatform('android')}
                  className={`flex-1 p-2.5 rounded-xl border text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer ${
                    selectedMobilePlatform === 'android'
                      ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300'
                      : 'border-pos-border bg-pos-panel text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                  <span>Android (APK)</span>
                </button>
                <button
                  onClick={() => setSelectedMobilePlatform('ios')}
                  className={`flex-1 p-2.5 rounded-xl border text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer ${
                    selectedMobilePlatform === 'ios'
                      ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-300'
                      : 'border-pos-border bg-pos-panel text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full bg-cyan-400"></span>
                  <span>iPhone / iPad (iOS)</span>
                </button>
              </div>

              {/* QR Code & Scan Instructions */}
              <div className="bg-pos-panel border border-pos-border rounded-2xl p-4 flex flex-col sm:flex-row items-center gap-4">
                <div className="shrink-0 bg-white p-2 rounded-xl border border-slate-700 shadow-md flex items-center justify-center">
                  <QRCodeImage
                    value={selectedMobilePlatform === 'android' ? ANDROID_APK_URL : IOS_IPA_URL}
                    size={140}
                    alt="QR Code Mobile"
                  />
                </div>
                <div className="space-y-2 text-center sm:text-left flex-1">
                  <span className="inline-block px-2 py-0.5 rounded-full bg-pos-card border border-pos-border text-[10px] font-bold uppercase tracking-wider text-pos-muted">
                    Scannez avec votre téléphone
                  </span>
                  <p className="text-xs text-pos-text font-bold">
                    {selectedMobilePlatform === 'android'
                      ? 'Téléchargement direct APK pour smartphone Android'
                      : 'Package IPA officiel pour iPhone & iPad'}
                  </p>
                  <p className="text-[11px] text-pos-muted leading-relaxed">
                    Pointez l'appareil photo de votre smartphone vers le QR code pour lancer le téléchargement directement depuis GitHub.
                  </p>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => {
                    const target = selectedMobilePlatform === 'android' ? ANDROID_APK_URL : IOS_IPA_URL;
                    if (typeof window !== 'undefined') {
                      window.open(target, '_blank');
                    }
                  }}
                  className={`w-full py-3 px-4 rounded-xl text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg transition cursor-pointer active:scale-98 ${
                    selectedMobilePlatform === 'android'
                      ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-emerald-500/20'
                      : 'bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 shadow-cyan-500/20'
                  }`}
                >
                  <DownloadCloud className="w-4 h-4" />
                  <span>
                    Télécharger {selectedMobilePlatform === 'android' ? 'MobiPOS-Android.apk' : 'MobiPOS-iOS.ipa'}
                  </span>
                  <ExternalLink className="w-3.5 h-3.5 opacity-70" />
                </button>

                <div className="flex gap-2">
                  <button
                    onClick={() => handleCopyDownloadUrl(selectedMobilePlatform)}
                    className="flex-1 py-2 px-3 rounded-xl bg-pos-panel border border-pos-border hover:bg-pos-hover text-pos-muted hover:text-pos-text font-bold text-[11px] flex items-center justify-center gap-1.5 transition cursor-pointer"
                  >
                    {copiedUrl === selectedMobilePlatform ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedUrl === selectedMobilePlatform ? 'Lien copié !' : 'Copier le lien de téléchargement'}</span>
                  </button>

                  <a
                    href={GITHUB_DOWNLOAD_HUB_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="py-2 px-3 rounded-xl bg-pos-panel border border-pos-border hover:bg-pos-hover text-pos-muted hover:text-pos-text font-bold text-[11px] flex items-center justify-center gap-1.5 transition"
                  >
                    <span>Hub GitHub</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>

              {/* Next step hint */}
              <div className="p-3 rounded-xl bg-cyan-950/20 border border-cyan-800/40 flex items-center justify-between text-[11px]">
                <span className="text-cyan-300 font-medium">Une fois l'application installée sur votre smartphone :</span>
                <button
                  onClick={() => setActiveTab('pair')}
                  className="px-2.5 py-1 rounded-lg bg-cyan-500 text-slate-950 font-bold hover:bg-cyan-400 transition cursor-pointer"
                >
                  Passer à l'Étape 2 &rarr;
                </button>
              </div>
            </div>
          ) : (
            /* TAB 2: PAIRING */
            <div>
              {loading ? (
                <div className="py-8 flex flex-col items-center justify-center text-pos-muted gap-2">
                  <RefreshCw className="w-5 h-5 animate-spin text-cyan-400" />
                  <span>Chargement des identifiants Cloud...</span>
                </div>
              ) : !creds ? (
                <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 space-y-2 text-center">
                  <p className="font-bold">Aucune synchronisation Cloud configurée sur ce PC.</p>
                  <p className="text-[11px] text-pos-muted">
                    Configurez d'abord votre URL Turso et Token dans Paramètres &gt; Synchronisation Cloud avant de lier un smartphone.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Instructions */}
                  <p className="text-pos-muted">
                    Ouvrez l'application mobile <strong className="text-pos-text">MobiPOS</strong> sur votre smartphone, puis collez ce code d'appairage ou renseignez vos accès :
                  </p>

                  {/* QR code of pairing payload */}
                  <div className="bg-pos-panel border border-pos-border rounded-xl p-3 flex items-center gap-3">
                    <div className="shrink-0 bg-white p-1.5 rounded-lg border border-slate-700 flex items-center justify-center">
                      <QRCodeImage
                        value={pairingPayload}
                        size={90}
                        alt="QR Code Pairing"
                      />
                    </div>
                    <div className="space-y-1">
                      <span className="text-[10px] font-black uppercase text-cyan-400 tracking-wider flex items-center gap-1">
                        <Sparkles className="w-3 h-3" />
                        Scannable depuis MobiPOS
                      </span>
                      <p className="text-xs text-pos-text font-bold">Appairage Instantané</p>
                      <p className="text-[10px] text-pos-muted">Scannez ce code depuis l'écran de bienvenue de l'application mobile pour configurer automatiquement la boutique.</p>
                    </div>
                  </div>

                  {/* Pairing Code Card */}
                  <div className="bg-pos-panel border border-pos-border rounded-xl p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1">
                        <QrCode className="w-3.5 h-3.5 text-cyan-400" />
                        Code d'Appairage Texte
                      </span>
                      <button
                        onClick={handleCopy}
                        className="flex items-center gap-1 text-[10px] font-bold text-cyan-400 hover:text-cyan-300 cursor-pointer"
                      >
                        {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                        <span>{copied ? 'Copié !' : 'Copier le code'}</span>
                      </button>
                    </div>
                    <div className="p-2 bg-pos-bg rounded-lg border border-pos-border font-mono text-[10px] text-pos-muted break-all select-all max-h-20 overflow-y-auto">
                      {pairingPayload}
                    </div>
                  </div>

                  {/* Individual Credentials */}
                  <div className="space-y-2">
                    <div>
                      <label className="text-[10px] font-bold text-pos-muted block mb-0.5">URL Base de Données :</label>
                      <input
                        type="text"
                        readOnly
                        value={creds.url}
                        className="w-full bg-pos-panel border border-pos-border rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-pos-text"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between items-center mb-0.5">
                        <label className="text-[10px] font-bold text-pos-muted">Token d'Authentification :</label>
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
                        readOnly
                        value={creds.token}
                        className="w-full bg-pos-panel border border-pos-border rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-pos-text"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 text-[10px] text-emerald-400 pt-1">
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                    <span>Accès sécurisé chiffré de bout en bout. Zéro risque de perte de données.</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-pos-border bg-pos-panel flex justify-end">
          <button
            onClick={closeModal}
            className="px-4 py-1.5 rounded-xl bg-pos-card border border-pos-border hover:bg-pos-hover text-xs font-bold text-pos-text transition cursor-pointer"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};

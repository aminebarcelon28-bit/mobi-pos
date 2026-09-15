import React, { useState } from 'react';
import {
  Cloud,
  QrCode,
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
} from 'lucide-react';
import { setCloudCredentials } from '../../sync/keychain';
import { testTursoConnection, type ConnectionTestResult } from '../../sync/tursoClient';
import { syncManager } from '../../sync/SyncManager';
import { getDeviceId } from '../../sync/device';
import { usePosStore } from '../../store/usePosStore';
import { useToast } from '../ui/Toast';

interface MobilePairingWizardProps {
  onPaired: () => void;
  onSkipDemo?: () => void;
}

export const MobilePairingWizard: React.FC<MobilePairingWizardProps> = ({
  onPaired,
  onSkipDemo,
}) => {
  const { showToast } = useToast();
  const [mode, setMode] = useState<'qr' | 'manual'>('qr');
  const [qrText, setQrText] = useState('');
  const [dbUrl, setDbUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [showToken, setShowToken] = useState(false);

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

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
        setMode('manual');
        showToast('Identifiants importés avec succès !', 'success');
        return;
      }
    } catch {
      // Not JSON, check if it's a URL
      if (raw.startsWith('libsql://') || raw.startsWith('https://')) {
        setDbUrl(raw);
        setMode('manual');
        showToast('URL détectée', 'info');
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

  const handleSaveAndConnect = async () => {
    const trimmedUrl = dbUrl.trim();
    const trimmedToken = authToken.trim();
    if (!trimmedUrl || !trimmedToken) {
      showToast('URL et Jeton obligatoires', 'warning');
      return;
    }

    setIsConnecting(true);
    try {
      // 1. Save credentials to secure vault
      await setCloudCredentials(trimmedUrl, trimmedToken);

      // 2. Start SyncManager and run initial pull
      await syncManager.start(getDeviceId());
      await syncManager.initialPull();
      await usePosStore.getState().initDatabase();

      showToast('Synchronisation réussie ! Bienvenue sur MobiPOS.', 'success');
      onPaired();
    } catch (e) {
      console.error('Pairing error:', e);
      showToast(e instanceof Error ? e.message : 'Erreur de connexion Cloud', 'error');
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-pos-bg text-pos-text flex flex-col justify-between p-4 overflow-y-auto font-sans">
      {/* Top Header */}
      <div className="space-y-4 pt-4 text-center">
        <div className="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-br from-cyan-500 to-emerald-500 flex items-center justify-center text-slate-950 shadow-lg shadow-emerald-500/20">
          <Smartphone className="w-7 h-7" />
        </div>
        <div>
          <h1 className="text-xl font-black text-pos-text tracking-tight">Configuration MobiPOS</h1>
          <p className="text-xs text-pos-muted mt-1 max-w-xs mx-auto">
            Connectez votre smartphone à votre boutique pour synchroniser vos ventes en temps réel.
          </p>
        </div>

        {/* Mode Selector */}
        <div className="flex bg-pos-panel p-1 rounded-xl border border-pos-border max-w-xs mx-auto">
          <button
            type="button"
            onClick={() => setMode('qr')}
            className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
              mode === 'qr'
                ? 'bg-cyan-500 text-slate-950 shadow-sm'
                : 'text-pos-muted hover:text-pos-text'
            }`}
          >
            <QrCode className="w-3.5 h-3.5" />
            <span>Appairage PC</span>
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
            <span>Saisie Manuelle</span>
          </button>
        </div>
      </div>

      {/* Main Content Form */}
      <div className="my-6 max-w-sm w-full mx-auto space-y-4">
        {mode === 'qr' ? (
          <div className="bg-pos-panel border border-pos-border rounded-2xl p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-pos-text">
              <QrCode className="w-4 h-4 text-cyan-400" />
              <span>Coller le code d'appairage depuis votre PC</span>
            </div>
            <p className="text-[11px] text-pos-muted leading-relaxed">
              Sur votre logiciel caisse PC, allez dans <strong className="text-pos-text">Paramètres &gt; Lier un Smartphone</strong> et copiez le code d'appairage généré.
            </p>

            <div className="space-y-2 pt-1">
              <textarea
                value={qrText}
                onChange={(e) => {
                  setQrText(e.target.value);
                  parseAndApplyPairingText(e.target.value);
                }}
                placeholder="Collez ici le code généré par votre caisse PC..."
                rows={3}
                className="w-full bg-pos-bg border border-pos-border rounded-xl p-2.5 font-mono text-xs text-pos-text focus:outline-none focus:border-cyan-400 resize-none"
              />

              <button
                type="button"
                onClick={handlePastePairingCode}
                className="w-full py-2 px-3 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-xs font-bold text-pos-text flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <Clipboard className="w-3.5 h-3.5 text-cyan-400" />
                <span>Coller depuis le presse-papier</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-pos-panel border border-pos-border rounded-2xl p-4 space-y-3">
            <div>
              <label className="text-xs font-bold text-pos-muted block mb-1">URL de la base Turso :</label>
              <input
                type="text"
                value={dbUrl}
                onChange={(e) => setDbUrl(e.target.value)}
                placeholder="libsql://mobi-pos-votre-boutique.turso.io"
                className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-mono text-pos-text focus:outline-none focus:border-cyan-400"
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-xs font-bold text-pos-muted">Jeton d'authentification (Token) :</label>
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

            {/* Test Connection Button */}
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
                    ? `Base connectée avec succès (${testResult.latencyMs} ms).`
                    : testResult.error || 'Connexion échouée.'}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Security & Multi-Tenant Assurance Note */}
        <div className="flex items-start gap-2 text-[10px] text-pos-muted px-2">
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>
            Chaque boutique dispose de sa propre base sécurisée. Vos identifiants sont stockés de manière chiffrée sur votre appareil et conservés lors des mises à jour.
          </span>
        </div>
      </div>

      {/* Bottom Actions */}
      <div className="max-w-sm w-full mx-auto space-y-2 pb-2">
        <button
          type="button"
          disabled={isConnecting || !dbUrl || !authToken}
          onClick={handleSaveAndConnect}
          className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 active:scale-[0.98] text-slate-950 font-black text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 transition cursor-pointer disabled:opacity-50"
        >
          {isConnecting ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : (
            <Cloud className="w-4 h-4" />
          )}
          <span>{isConnecting ? 'Connexion et synchronisation...' : 'Enregistrer & Se Connecter'}</span>
          {!isConnecting && <ArrowRight className="w-4 h-4" />}
        </button>

        {onSkipDemo && (
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

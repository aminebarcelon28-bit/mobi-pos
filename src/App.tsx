import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { CartPanel } from './components/CartPanel';
import { ProductCatalog } from './components/ProductCatalog';
import { BottomBar } from './components/BottomBar';
import { ToastProvider, useToast } from './components/ui/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SilentReceiptPrinter } from './components/SilentReceiptPrinter';
import { useKeyboardHotkeys } from './hooks/useKeyboardHotkeys';
import { useBarcodeScanner } from './hooks/useBarcodeScanner';
import { GlobalModalHost } from './components/GlobalModalHost';
import { usePosStore } from './store/usePosStore';
import { useDeviceMode } from './hooks/useDeviceMode';
const CompanionShell = React.lazy(() =>
  import('./components/mobile/CompanionShell').then((m) => ({ default: m.CompanionShell })),
);
import { LockScreenOverlay } from './components/LockScreenOverlay';
// P11.3: the pairing wizard statically drags in tursoClient + device + the sync
// engine (~267 kB). It is only shown before credentials exist, so it is lazily
// loaded and the sync engine stays out of the entry chunk.
const MobilePairingWizard = React.lazy(() =>
  import('./components/mobile/MobilePairingWizard').then((m) => ({ default: m.MobilePairingWizard })),
);
import { getCloudCredentials } from './sync/keychain';
import { soundEngine } from './utils/audioFeedback';
import { hashPin } from './utils/security';
import { checkBootLicense, startLicenseHeartbeat } from './licensing/client';
import { isDegradedLicenseStatus, setDegradedSaleBlock } from './licensing/degraded';
import { onLicenseRevoked } from './licensing/store';
import { ActivationGateScreen } from './components/licensing/ActivationGateScreen';

import { isMobileDevice } from './utils/platform';
import { Smartphone, RotateCw, RefreshCw, ShieldCheck, Plus, Trash2 } from 'lucide-react';

const SyncNotificationListener: React.FC = () => {
  const { showToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    let unsubPull: (() => void) | undefined;
    import('./sync/SyncManager').then(({ syncManager }) => {
      if (cancelled) return;
      unsub = syncManager.onRemoteSaleReceived((sale) => {
        try {
          soundEngine.playSuccess();
        } catch {
          // ignore sound error
        }
        const total = typeof sale.total === 'number' ? sale.total : 0;
        const receipt = (sale.receiptNumber as string) || (sale.id as string) || '';
        const status = (sale.status as string) || 'COMPLETED';
        if (status === 'VOIDED') {
          showToast(`Vente annulée sur un autre appareil : #${receipt}`, 'info', 5000);
        } else if (status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED') {
          showToast(`Avoir émis sur un autre appareil : #${receipt}`, 'info', 5000);
        } else {
          showToast(
            `Vente synchronisée du mobile : #${receipt} (${Math.round(total).toLocaleString('fr-DZ')} DZD)`,
            'success',
            5000
          );
        }
      });
      // Both-offline convergence watch: a peer till may have paid out the
      // same ticket while both were offline. The detector files one shared
      // exception entry and we toast it loudly — money moved twice, the
      // merchant must know (ad.md §§7/10, C6).
      unsubPull = syncManager.onPullApplied(() => {
        if (cancelled) return;
        import('./sync/payoutWatch').then(({ checkDuplicatePayouts }) => {
          if (cancelled) return;
          checkDuplicatePayouts().then((dups) => {
            for (const d of dups) {
              try {
                soundEngine.playError?.();
              } catch {
                // ignore sound error
              }
              showToast(
                `Double encaissement suspecté : ticket ${d.payoutId.replace(/^(REF|VOID):/, '')} payé ${d.amount} DA sur ${d.devices.length} appareils — contrôlez la caisse.`,
                'error',
                8000
              );
            }
          }).catch(console.warn);
        }).catch(console.warn);
      });
    }).catch(console.warn);
    return () => {
      cancelled = true;
      unsub?.();
      unsubPull?.();
    };
  }, [showToast]);

  return null;
};

const PairingWizardFallback: React.FC = () => (
  <div className="h-[100dvh] w-full flex items-center justify-center bg-pos-bg text-pos-text">
    <div className="flex flex-col items-center gap-3">
      <RefreshCw className="w-8 h-8 text-cyan-400 animate-spin" />
      <span className="text-sm text-pos-muted">Chargement de la configuration mobile…</span>
    </div>
  </div>
);

const DbLoadingSplash: React.FC = () => (
  <div className="h-[100dvh] w-full flex items-center justify-center bg-pos-bg text-pos-text">
    <div className="flex flex-col items-center gap-3">
      <RefreshCw className="w-8 h-8 text-emerald-400 animate-spin" />
      <span className="text-sm text-pos-muted">Chargement de la base locale…</span>
    </div>
  </div>
);

// First-boot team setup: the merchant names the manager, sets the manager
// PIN, and builds the cashier roster (add/rename/remove rows freely — zero or
// more cashiers). While the manager PIN is unset ('') or still a known
// default, this overlay blocks the whole app (rendered above the lock screen,
// no dismiss path) until the team is saved. PINs are hashed with the existing
// hashPin before persist; plaintext lives only in transient component state
// and is never logged. PINs must all be distinct: the lock screen resolves
// identity by PIN, so a shared PIN would always unlock as the manager.
const KNOWN_DEFAULT_PINS = new Set(['1234', '0000', '1111']);
const PIN_4DIGITS_RE = /^\d{4}$/;
const CASHIER_COLORS = ['#10b981', '#f59e0b', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a5'];

interface SetupRow {
  key: string;
  name: string;
  pin: string;
}

const FirstBootPinSetup: React.FC = () => {
  const managerPin = usePosStore((s) => s.managerPin);
  const cashierUsers = usePosStore((s) => s.cashierUsers);
  const isDbInitialized = usePosStore((s) => s.isDbInitialized);
  const setManagerPin = usePosStore((s) => s.setManagerPin);
  const setCashierUsers = usePosStore((s) => s.setCashierUsers);
  const { showToast } = useToast();
  const [managerName, setManagerName] = useState('');
  const [managerNew, setManagerNew] = useState('');
  const [managerConfirm, setManagerConfirm] = useState('');
  const [rows, setRows] = useState<SetupRow[]>([]);
  const [seeded, setSeeded] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const managerNeedsSetup = managerPin === '' || KNOWN_DEFAULT_PINS.has(managerPin);

  // Seed the form once the team list has loaded: existing names are kept as
  // editable suggestions, every PIN field starts empty and must be set.
  useEffect(() => {
    if (!isDbInitialized || seeded) return;
    const users = cashierUsers || [];
    const admin = users.find((u) => u.role === 'admin') || users[0];
    setManagerName(admin?.name || '');
    setRows(
      users.filter((u) => u !== admin).map((u) => ({ key: u.id, name: u.name, pin: '' }))
    );
    setSeeded(true);
  }, [isDbInitialized, cashierUsers, seeded]);

  // ── Pavé PIN tactile ──
  // Touch/mouse PIN entry that never touches the OS keyboard: immune to
  // AZERTY-vs-QWERTY layouts (unshifted digit keys emit &é"'… which the
  // digit filter strips, making PIN fields look "dead"), kiosk WebViews
  // without a soft keyboard, and password+inputMode quirks on old WebViews.
  // NOTE: declared BEFORE the early return below — hooks must run in the same
  // order on every render (conditional useState breaks the PIN pad state and
  // can crash the setup screen when init status flips).
  type PinTarget = { kind: 'managerNew' } | { kind: 'managerConfirm' } | { kind: 'cashier'; key: string };
  const [pinTarget, setPinTarget] = useState<PinTarget | null>(null);

  if (!isDbInitialized || !managerNeedsSetup) return null;

  const addRow = () => {
    setRows((prev) => [...prev, { key: `new-${Date.now().toString(36)}-${prev.length}`, name: '', pin: '' }]);
  };

  const removeRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
  };

  const updateRow = (key: string, patch: Partial<SetupRow>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const appendPinDigit = (d: string) => {
    if (!pinTarget) {
      setError("Touchez d'abord un champ PIN (gérant ou caissier), puis composez le code sur le pavé.");
      return;
    }
    if (pinTarget.kind === 'managerNew') {
      setManagerNew((v) => (v + d).replace(/\D/g, '').slice(0, 4));
    } else if (pinTarget.kind === 'managerConfirm') {
      setManagerConfirm((v) => (v + d).replace(/\D/g, '').slice(0, 4));
    } else {
      setRows((prev) =>
        prev.map((r) =>
          r.key === pinTarget.key ? { ...r, pin: (r.pin + d).replace(/\D/g, '').slice(0, 4) } : r,
        ),
      );
    }
  };

  const backspacePinDigit = () => {
    if (!pinTarget) return;
    if (pinTarget.kind === 'managerNew') {
      setManagerNew((v) => v.slice(0, -1));
    } else if (pinTarget.kind === 'managerConfirm') {
      setManagerConfirm((v) => v.slice(0, -1));
    } else {
      setRows((prev) =>
        prev.map((r) => (r.key === pinTarget.key ? { ...r, pin: r.pin.slice(0, -1) } : r)),
      );
    }
  };

  const clearPinField = () => {
    if (!pinTarget) return;
    if (pinTarget.kind === 'managerNew') {
      setManagerNew('');
    } else if (pinTarget.kind === 'managerConfirm') {
      setManagerConfirm('');
    } else {
      setRows((prev) =>
        prev.map((r) => (r.key === pinTarget.key ? { ...r, pin: '' } : r)),
      );
    }
  };

  const pinTargetLabel = (() => {
    if (!pinTarget) return 'aucun champ sélectionné';
    if (pinTarget.kind === 'managerNew') return 'PIN gérant';
    if (pinTarget.kind === 'managerConfirm') return 'confirmation gérant';
    const row = rows.find((r) => r.key === pinTarget.key);
    return `PIN de ${row?.name?.trim() || 'caissier'}`;
  })();

  const handleSubmit = async () => {
    setError('');
    const cleanManagerName = managerName.trim();
    if (!cleanManagerName) {
      setError('Indiquez le nom du gérant (ex. Yacine).');
      return;
    }
    const cleanManagerPin = managerNew.trim();
    if (!PIN_4DIGITS_RE.test(cleanManagerPin)) {
      setError('Le code PIN gérant doit contenir exactement 4 chiffres.');
      return;
    }
    if (cleanManagerPin !== managerConfirm.trim()) {
      setError('La confirmation du code PIN gérant ne correspond pas.');
      return;
    }
    // Fully-empty rows are ignored (lets the merchant abandon a spare row);
    // half-filled rows are an error, not silently dropped.
    const activeRows = rows.filter((r) => r.name.trim() !== '' || r.pin !== '');
    for (const r of activeRows) {
      if (!r.name.trim()) {
        setError('Chaque ligne caissier doit avoir un nom (ou supprimez la ligne).');
        return;
      }
      if (!PIN_4DIGITS_RE.test(r.pin.trim())) {
        setError(`Code PIN à 4 chiffres requis pour ${r.name.trim()}.`);
        return;
      }
    }
    const allPins = [cleanManagerPin, ...activeRows.map((r) => r.pin.trim())];
    if (new Set(allPins).size !== allPins.length) {
      setError("Chaque personne doit avoir un code PIN différent, sinon l'écran verrouillé ne pourra pas distinguer les utilisateurs.");
      return;
    }
    setSaving(true);
    try {
      // setManagerPin mirrors the hash onto the primary admin row
      // (single-PIN contract) — reuse that exact hash for the new roster so
      // the manager holds one credential, not two hashes of the same code.
      await setManagerPin(cleanManagerPin);
      const managerHash = usePosStore.getState().managerPin || hashPin(cleanManagerPin);
      const users = cashierUsers || [];
      const prevAdmin = users.find((u) => u.role === 'admin') || users[0];
      await setCashierUsers([
        {
          id: prevAdmin?.id || 'usr-admin',
          name: cleanManagerName,
          pin: managerHash,
          role: 'admin' as const,
          avatarColor: prevAdmin?.avatarColor || '#3b82f6',
        },
        ...activeRows.map((r, i) => ({
          id: r.key.startsWith('usr-') ? r.key : `usr-${Date.now().toString(36)}-${i}`,
          name: r.name.trim(),
          pin: hashPin(r.pin.trim()),
          role: 'cashier' as const,
          avatarColor: CASHIER_COLORS[i % CASHIER_COLORS.length] as string,
        })),
      ]);
      showToast(`Équipe enregistrée : ${cleanManagerName} + ${activeRows.length} caissier(s). Accès caisse déverrouillé.`, 'success');
    } catch {
      setError("Échec de l'enregistrement de l'équipe. Réessayez.");
    } finally {
      setSaving(false);
    }
  };

  const pinInputClass =
    'w-full px-4 py-3 rounded-xl bg-pos-bg border border-pos-border text-pos-text text-center font-mono text-2xl tracking-[0.5em] outline-none focus:border-amber-500 transition';
  const nameInputClass =
    'w-full px-4 py-2.5 rounded-xl bg-pos-bg border border-pos-border text-pos-text text-sm font-semibold outline-none focus:border-amber-500 transition placeholder:text-pos-muted/60 placeholder:font-normal';

  return (
    <div className="fixed inset-0 z-[200] bg-slate-950/95 backdrop-blur-xl flex items-center justify-center p-4 select-none overflow-y-auto">
      <div className="w-full max-w-lg bg-pos-panel border border-amber-500/40 rounded-2xl shadow-2xl p-6 my-auto">
        <div className="flex flex-col items-center mb-5 text-center">
          <div className="w-12 h-12 rounded-full bg-amber-500/20 flex items-center justify-center mb-3 text-amber-400">
            <ShieldCheck size={28} />
          </div>
          <h2 className="text-lg font-bold text-pos-text mb-1">
            {managerPin === '' ? 'Configuration initiale — Votre équipe' : 'Sécurité — PIN par défaut détecté'}
          </h2>
          <p className="text-xs text-pos-muted leading-relaxed">
            {managerPin === ''
              ? "Nommez le gérant, créez son code PIN, puis ajoutez autant de caissiers que vous voulez."
              : 'Le code PIN gérant par défaut (1234) est actif. Redéfinissez-le et vérifiez votre équipe pour déverrouiller la caisse.'}
            {' '}Les codes PIN d'usine sont désactivés et ne permettent aucun accès.
          </p>
        </div>

        <div className="space-y-5">
          {/* ── Manager ── */}
          <div className="rounded-xl border border-pos-border bg-pos-bg/60 p-3.5 space-y-3">
            <p className="text-[11px] font-bold text-amber-400 uppercase tracking-wider">
              Gérant (administrateur)
            </p>
            <div>
              <label className="text-[11px] font-bold text-pos-muted uppercase tracking-wider block mb-1.5">
                Nom du gérant
              </label>
              <input
                type="text"
                autoComplete="off"
                maxLength={40}
                value={managerName}
                onChange={(e) => setManagerName(e.target.value)}
                className={nameInputClass}
                placeholder="Ex. Yacine"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-bold text-pos-muted uppercase tracking-wider block mb-1.5">
                  PIN gérant (4 chiffres)
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="new-password"
                  enterKeyHint="next"
                  aria-label="PIN gérant"
                  maxLength={4}
                  value={managerNew}
                  onFocus={() => setPinTarget({ kind: 'managerNew' })}
                  onClick={() => setPinTarget({ kind: 'managerNew' })}
                  onChange={(e) => setManagerNew(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  className={pinInputClass}
                  placeholder="••••"
                />
              </div>
              <div>
                <label className="text-[11px] font-bold text-pos-muted uppercase tracking-wider block mb-1.5">
                  Confirmer le PIN
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="new-password"
                  enterKeyHint="done"
                  aria-label="Confirmer le PIN gérant"
                  maxLength={4}
                  value={managerConfirm}
                  onFocus={() => setPinTarget({ kind: 'managerConfirm' })}
                  onClick={() => setPinTarget({ kind: 'managerConfirm' })}
                  onChange={(e) => setManagerConfirm(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  className={pinInputClass}
                  placeholder="••••"
                />
              </div>
            </div>
          </div>

          {/* ── Cashiers (dynamic) ── */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[11px] font-bold text-pos-muted uppercase tracking-wider">
                Caissiers ({rows.filter((r) => r.name.trim() !== '' || r.pin !== '').length})
              </p>
              <button
                type="button"
                onClick={addRow}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-bold transition active:scale-95 min-h-[40px]"
              >
                <Plus className="w-4 h-4" />
                <span>Ajouter un caissier</span>
              </button>
            </div>
            {rows.length === 0 ? (
              <p className="text-xs text-pos-muted bg-pos-bg/60 border border-dashed border-pos-border rounded-xl px-4 py-3 text-center">
                Aucun caissier pour le moment — le gérant peut tout faire seul. Ajoutez-en autant que vous voulez.
              </p>
            ) : (
              <div className="space-y-2">
                {rows.map((r) => (
                  <div key={r.key} className="flex items-center gap-2">
                    <input
                      type="text"
                      autoComplete="off"
                      maxLength={40}
                      value={r.name}
                      onChange={(e) => updateRow(r.key, { name: e.target.value })}
                      className={`${nameInputClass} flex-1 min-w-0`}
                      placeholder="Nom du caissier"
                      aria-label="Nom du caissier"
                    />
                    <input
                      type="password"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      autoComplete="new-password"
                      enterKeyHint="next"
                      maxLength={4}
                      value={r.pin}
                      onFocus={() => setPinTarget({ kind: 'cashier', key: r.key })}
                      onClick={() => setPinTarget({ kind: 'cashier', key: r.key })}
                      onChange={(e) => updateRow(r.key, { pin: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                      className="w-28 shrink-0 px-2 py-2 rounded-xl bg-pos-bg border border-pos-border text-pos-text text-center font-mono text-lg tracking-[0.3em] outline-none focus:border-amber-500 transition"
                      placeholder="••••"
                      aria-label={`Code PIN de ${r.name || 'caissier'}`}
                    />
                    <button
                      type="button"
                      onClick={() => removeRow(r.key)}
                      className="shrink-0 p-2 rounded-xl hover:bg-rose-500/15 border border-transparent hover:border-rose-500/30 text-pos-muted hover:text-rose-400 transition min-h-[44px] min-w-[44px] flex items-center justify-center"
                      title="Retirer ce caissier"
                      aria-label={`Retirer ${r.name || 'cette ligne'}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[11px] text-pos-muted mt-2 leading-relaxed">
              Chaque PIN doit être différent. Vous pourrez modifier l'équipe à tout moment depuis Paramètres → Caissiers.
            </p>
          </div>

          {/* ── On-screen PIN pad (keyboard-layout proof) ── */}
          <div className="rounded-xl border border-pos-border bg-pos-bg/60 p-3.5">
            <p className="text-[11px] font-bold text-pos-muted uppercase tracking-wider mb-1">
              Pavé PIN tactile
            </p>
            <p className="text-[11px] text-pos-muted mb-2.5 leading-relaxed">
              Touchez un champ PIN, puis composez le code ici — cible :{' '}
              <span className="font-bold text-amber-300">{pinTargetLabel}</span>.
            </p>
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => appendPinDigit(d)}
                  aria-label={`Chiffre ${d}`}
                  className="h-12 rounded-xl bg-pos-panel border border-pos-border text-pos-text text-xl font-bold transition active:scale-95 active:border-amber-500"
                >
                  {d}
                </button>
              ))}
              <button
                type="button"
                onClick={clearPinField}
                aria-label="Tout effacer"
                className="h-12 rounded-xl bg-pos-panel border border-pos-border text-pos-text text-base font-bold transition active:scale-95"
              >
                C
              </button>
              <button
                type="button"
                onClick={() => appendPinDigit('0')}
                aria-label="Chiffre 0"
                className="h-12 rounded-xl bg-pos-panel border border-pos-border text-pos-text text-xl font-bold transition active:scale-95 active:border-amber-500"
              >
                0
              </button>
              <button
                type="button"
                onClick={backspacePinDigit}
                aria-label="Effacer le dernier chiffre"
                className="h-12 rounded-xl bg-pos-panel border border-pos-border text-pos-text text-xl font-bold transition active:scale-95"
              >
                ⌫
              </button>
            </div>
          </div>

          {error && (
            <p className="text-center text-rose-400 text-xs font-bold">{error}</p>
          )}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving}
            className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-sm transition active:scale-[0.99] min-h-[48px]"
          >
            {saving ? 'Enregistrement…' : "Enregistrer l'équipe et déverrouiller"}
          </button>
        </div>
      </div>
    </div>
  );
};

export const App: React.FC = () => {
  const { isMobile, setRoleMode } = useDeviceMode();
  useKeyboardHotkeys();
  const { scannerActive } = useBarcodeScanner();
  const initDatabase = usePosStore((state) => state.initDatabase);
  const isDbInitialized = usePosStore((state) => state.isDbInitialized);

  const [isLandscape, setIsLandscape] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.innerWidth > window.innerHeight;
  });

  useEffect(() => {
    const handleOrientation = () => {
      setIsLandscape(window.innerWidth > window.innerHeight);
    };
    window.addEventListener('resize', handleOrientation);
    window.addEventListener('orientationchange', handleOrientation);
    return () => {
      window.removeEventListener('resize', handleOrientation);
      window.removeEventListener('orientationchange', handleOrientation);
    };
  }, []);

  const [showPairingWizard, setShowPairingWizard] = useState(false);
  const [checkedCredentials, setCheckedCredentials] = useState(false);

  // Pre-boot cryptographic licensing gate
  const [licenseState, setLicenseState] = useState<{
    checked: boolean;
    licensed: boolean;
    degraded: boolean;
    error?: string;
  }>({ checked: false, licensed: false, degraded: false });

  useEffect(() => {
    let unmounted = false;
    checkBootLicense({ bootTimeoutMs: 2500 })
      .then((res) => {
        if (unmounted) return;
        // Degraded mode (availability): billing/admin states (expired,
        // suspended, grace exceeded) keep the merchant's data and correction
        // flows (refunds, voids, reports, export) reachable while new sales
        // are refused at the choke points. Tamper/identity states hard-lock.
        const degraded =
          !res.licensed && isDegradedLicenseStatus((res as { status?: string }).status);
        setDegradedSaleBlock(degraded);
        setLicenseState({
          checked: true,
          licensed: res.licensed,
          degraded,
          error: res.licensed ? undefined : res.message,
        });
      })
      .catch((err) => {
        if (unmounted) return;
        setDegradedSaleBlock(false);
        setLicenseState({
          checked: true,
          licensed: false,
          degraded: false,
          error: err.message || 'Erreur de vérification de licence',
        });
      });

    const unsubRevoke = onLicenseRevoked((reason) => {
      setLicenseState({
        checked: true,
        licensed: false,
        degraded: false,
        error: reason,
      });
    });

    const stopHeartbeat = startLicenseHeartbeat({
      intervalMs: 120000, // 2 minutes (120 seconds) - ~360 requests/day per active device
      onRevoked: (reason) => {
        setLicenseState({
          checked: true,
          licensed: false,
          degraded: false,
          error: reason,
        });
      },
    });

    return () => {
      unmounted = true;
      unsubRevoke();
      stopHeartbeat();
    };
  }, []);

  // Post-boot clock-rollback tripwire (runs once the DB is up): the boot
  // check cannot consult the durable watermark without risking the heal
  // deadlock, so this verifies after init. If the money trail contains rows
  // more than 24h in the "future", the device clock was wound back (peer
  // skew is minutes, never days) — hard-lock as tampered. Never breaks
  // boot: every failure mode falls through silently.
  useEffect(() => {
    if (!isDbInitialized || !licenseState.checked || !licenseState.licensed) return;
    let cancelled = false;
    (async () => {
      try {
        const { getLocalDb } = await import('./db/sqlPluginAdapter');
        const db = await getLocalDb();
        const rows = (await db
          .select("SELECT MAX(updated_at) AS m FROM transactions WHERE deleted = 0")
          .catch(() => [])) as Array<{ m?: string | null }>;
        const maxMs = Date.parse(String(rows?.[0]?.m ?? ''));
        if (!Number.isFinite(maxMs)) return;
        if (maxMs - Date.now() > 24 * 3600_000) {
          if (cancelled) return;
          const { saveSuspensionState } = await import('./licensing/store');
          saveSuspensionState({
            suspended: true,
            reason: 'Horloge appareil incohérente avec les ventes enregistrées — vérification requise.',
            suspendedAt: Date.now(),
          });
          setDegradedSaleBlock(false);
          setLicenseState({
            checked: true,
            licensed: false,
            degraded: false,
            error: 'Horloge appareil incohérente — licence verrouillée.',
          });
        }
      } catch {
        // Unreadable DB here must never lock or break a healthy boot.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDbInitialized, licenseState.checked, licenseState.licensed]);

  // Check if credentials are present for mobile companion onboarding
  useEffect(() => {
    if (!licenseState.licensed) return;
    (async () => {
      try {
        const creds = await getCloudCredentials();
        if (isMobile && (!creds || !creds.url || !creds.token)) {
          setShowPairingWizard(true);
        }
      } catch (err) {
        console.warn('Check cloud credentials error:', err);
      } finally {
        setCheckedCredentials(true);
      }
    })();
  }, [isMobile, licenseState.licensed]);

  // Background two-way sync (Turso).
  React.useEffect(() => {
    if (!licenseState.licensed) return;
    let cancelled = false;
    let unsubPull: (() => void) | undefined;
    let refreshTimer: number | undefined;
    let remirrorIdleId: number | undefined;
    let remirrorTimeoutId: number | undefined;
    let backfillIdleId: number | undefined;
    let backfillTimeoutId: number | undefined;
    // 1. Instant Local Boot (Contract C3: <= 900ms desktop, local-first interactive)
    let dbReady = false;
    (async () => {
      // LCP/sync: wake the (possibly cold-started) Turso DB in parallel with
      // the local boot. First pipeline request after hours idle can take
      // seconds (scale-to-zero wake, far region) — firing it now overlaps the
      // wake with initDatabase instead of serializing it inside kick().
      // Fire-and-forget: never blocks paint, never throws; the client is
      // cached so kick()/initialPull reuse the warm connection.
      void (async () => {
        try {
          const { getTursoClient } = await import('./sync/tursoClient');
          const client = await getTursoClient();
          await client.execute('SELECT 1');
        } catch {
          // No creds / offline / still waking — sync start covers it.
        }
      })();
      try {
        await initDatabase();
        dbReady = true;
        // LCP: no refreshAfterPull() here — initDatabase just populated every
        // slice seconds ago; re-reading all 16 tables would double boot I/O.
        // The onPullApplied subscription below + initialPull() cover updates.
      } catch (dbErr) {
        // B-049: a failed local DB init must gate sync — pushing/pulling on a
        // half-initialized DB risks C6 (silent loss) worse than staying offline.
        console.error('[boot] Local DB init FAILED — sync deferred:', dbErr);
      }

      // 2. Non-blocking Background Sync & Cloud Replicas
      try {
        if (!dbReady) {
          console.warn('[boot] SyncManager skipped: local DB not ready.');
          return;
        }
        const { getStableDeviceId } = await import('./sync/device');
        const { syncManager } = await import('./sync/SyncManager');
        if (cancelled) return;
        unsubPull = syncManager.onPullApplied(() => {
          if (cancelled) return;
          if (refreshTimer) window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => {
            // P1: reload only slices the pull touched (products subset / txns);
            // falls back to the full reload when the touch summary is empty.
            const touched = syncManager.getLastPullTouched();
            const hasTouch = touched.productIds.length > 0 || touched.transactions || touched.tables.length > 0;
            const refresh = hasTouch
              ? usePosStore.getState().refreshPullTargets(touched)
              : usePosStore.getState().refreshAfterPull();
            refresh.catch((err: unknown) => {
              console.warn('[sync] Instant UI refresh error:', err);
            });
          }, 50);
        });
        await syncManager.start(await getStableDeviceId());
        if (!cancelled) await syncManager.initialPull();
      } catch (e) {
        console.warn('[boot] SyncManager background start skipped:', e);
      }

      if (!cancelled) {
        // P3.2: post-first-frame work — the mirror rebuild and outbox backfill
        // must not hold the boot critical path. requestIdleCallback with a
        // timeout fallback; the cancelled flag still guards every step.
        // Idle/timeout ids are tracked so unmount cancels the deferred work.
        const scheduleDeferred = (fn: () => void) => {
          const w = window as unknown as {
            requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
          };
          if (typeof w.requestIdleCallback === 'function') {
            remirrorIdleId = w.requestIdleCallback(() => fn(), { timeout: 3000 });
          } else {
            remirrorTimeoutId = window.setTimeout(fn, 1500);
          }
        };
        scheduleDeferred(() => {
          (async () => {
            try {
              const { remirrorToDexie } = await import('./db/backfill');
              const mirrorResult = await remirrorToDexie();
              if (mirrorResult.mirrored > 0 && !cancelled) {
                usePosStore.getState().refreshAfterPull().catch(console.warn);
              }
            } catch (e) {
              console.warn('[boot] Remirror skipped:', e);
            }
          })().catch((e: unknown) => console.warn('[boot] Deferred remirror failed:', e));
        });

        // LCP: monthly WAL-checkpoint + incremental vacuum must not hold the
        // boot critical path (on a 100MB+ file with a deep WAL it stalls boot
        // for seconds when it fires). Runs at most once per calendar month.
        scheduleDeferred(() => {
          (async () => {
            try {
              const { getLocalDb, checkAndRunScheduledDbMaintenance } = await import('./db/sqlPluginAdapter');
              await checkAndRunScheduledDbMaintenance(await getLocalDb());
            } catch (e) {
              console.warn('[boot] Maintenance skipped:', e);
            }
          })().catch((e: unknown) => console.warn('[boot] Deferred maintenance failed:', e));
        });

        // B-004 FIX-4: replay any durable checkout recovery intent left by a
        // prior PERSISTENCE_FAILED that landed the Dexie intent before the
        // SQLite throw. Idempotent (ON CONFLICT on order id).
        scheduleDeferred(() => {
          (async () => {
            try {
              const { replayCheckoutRecoveryIntents } = await import('./db/checkoutRecovery');
              const result = await replayCheckoutRecoveryIntents();
              if (result.replayed > 0 && !cancelled) {
                usePosStore.getState().refreshAfterPull().catch(console.warn);
                console.info(`[boot] Replayed ${result.replayed} checkout recovery intent(s)`);
              }
              if (result.remaining > 0) {
                console.warn('[boot] Checkout recovery intent still pending:', result.lastError);
              }
            } catch (e) {
              console.warn('[boot] Checkout recovery replay skipped:', e);
            }
          })().catch((e: unknown) => console.warn('[boot] Checkout recovery replay failed:', e));
        });
      }

      if (!cancelled) {
        const scheduleDeferredBackfill = (fn: () => void) => {
          const w = window as unknown as {
            requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
          };
          if (typeof w.requestIdleCallback === 'function') {
            backfillIdleId = w.requestIdleCallback(() => fn(), { timeout: 5000 });
          } else {
            backfillTimeoutId = window.setTimeout(fn, 2500);
          }
        };
        scheduleDeferredBackfill(() => {
          (async () => {
            try {
              const { backfillAllToOutbox } = await import('./db/backfill');
              const { syncManager } = await import('./sync/SyncManager');
              const backfillResult = await backfillAllToOutbox();
              if (backfillResult.enqueued > 0 && !cancelled) {
                syncManager.notifyLocalWrite();
              }
            } catch (e) {
              console.warn('[boot] Backfill skipped:', e);
            }
          })().catch((e: unknown) => console.warn('[boot] Deferred backfill failed:', e));
        });
      }
    })();
    return () => {
      cancelled = true;
      if (refreshTimer) window.clearTimeout(refreshTimer);
      if (remirrorTimeoutId) window.clearTimeout(remirrorTimeoutId);
      if (backfillTimeoutId) window.clearTimeout(backfillTimeoutId);
      try {
        const w = window as unknown as {
          cancelIdleCallback?: (id: number) => void;
        };
        if (typeof w.cancelIdleCallback === 'function') {
          if (remirrorIdleId !== undefined) w.cancelIdleCallback(remirrorIdleId);
          if (backfillIdleId !== undefined) w.cancelIdleCallback(backfillIdleId);
        }
      } catch {
        // ignore cleanup errors
      }
      unsubPull?.();
      import('./sync/SyncManager').then((m) => m.syncManager.stop()).catch((err: unknown) => {
        console.warn('[sync] Error stopping sync manager:', err);
      });
    };
  }, [initDatabase, licenseState.licensed]);

  React.useEffect(() => {
    // Read cart length via getState so this listener subscribes once (not on
    // every cart mutation — the old [cart] dep re-added it per keystroke).
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (usePosStore.getState().cart.length > 0) {
        e.preventDefault();
        e.returnValue = 'Un encaissement est en cours. Quitter cette page fermera la session de vente.';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // 1. Loading Splash while checking license
  if (!licenseState.checked) {
    return (
      <ErrorBoundary fallbackTitle="Démarrage MobiPOS">
        <ToastProvider>
          <DbLoadingSplash />
        </ToastProvider>
      </ErrorBoundary>
    );
  }

  // 2. Hardware-Locked Activation Gate (skipped in degraded mode: billing
  // states keep data + corrections reachable, only new sales are refused).
  if (!licenseState.licensed && !licenseState.degraded) {
    return (
      <ActivationGateScreen
        onActivated={() => {
          setDegradedSaleBlock(false);
          setLicenseState({ checked: true, licensed: true, degraded: false });
        }}
        initialError={licenseState.error}
      />
    );
  }

  if (isMobile) {
    if (showPairingWizard && checkedCredentials) {
      return (
        <ErrorBoundary fallbackTitle="Configuration Mobile Interceptée">
          <ToastProvider>
              <React.Suspense fallback={<PairingWizardFallback />}>
                <MobilePairingWizard
                  onPaired={() => setShowPairingWizard(false)}
                  onSkipDemo={() => setShowPairingWizard(false)}
                  onClose={() => setShowPairingWizard(false)}
                />
              </React.Suspense>
          </ToastProvider>
        </ErrorBoundary>
      );
    }

    // Gate the till UI on local DB readiness; the pairing-wizard branch above
    // stays ungated so the credential flow never blocks on SQLite.
    if (!isDbInitialized) {
      return (
        <ErrorBoundary fallbackTitle="Erreur Mobile POS Interceptée">
          <ToastProvider>
            <DbLoadingSplash />
          </ToastProvider>
        </ErrorBoundary>
      );
    }

    return (
      <ErrorBoundary fallbackTitle="Erreur Mobile POS Interceptée">
        <ToastProvider>
          <SyncNotificationListener />
          <div className="h-[100dvh] w-full flex flex-col bg-pos-bg text-pos-text overflow-hidden font-sans">
            {licenseState.degraded && (
              <div className="bg-amber-500/15 border-b border-amber-500/40 px-3 py-1.5 flex items-center justify-center gap-2 text-[11px] font-bold text-amber-300 shrink-0 select-none z-40">
                <span>Licence expirée — nouvelles ventes bloquées.</span>
              </div>
            )}
            <React.Suspense fallback={<PairingWizardFallback />}>
              <CompanionShell onOpenPairingWizard={() => setShowPairingWizard(true)} />
            </React.Suspense>
            <GlobalModalHost />
            <LockScreenOverlay />
            <FirstBootPinSetup />
          </div>
        </ToastProvider>
      </ErrorBoundary>
    );
  }

  // Gate the desktop till on local DB readiness (blocking splash).
  if (!isDbInitialized) {
    return (
      <ErrorBoundary fallbackTitle="Erreur Système POS Interceptée">
        <ToastProvider>
          <DbLoadingSplash />
        </ToastProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary fallbackTitle="Erreur Système POS Interceptée">
      <ToastProvider>
        <SyncNotificationListener />
        <div className={`h-[100dvh] w-full flex flex-col bg-pos-bg text-pos-text overflow-hidden font-sans transition-all duration-200 ${scannerActive ? 'ring-4 ring-inset ring-emerald-500' : ''}`}>
          {/* Degraded-license banner: billing states block new sales at the
          choke points — this banner is the visible counterpart so the till
          never fails silently. Corrections (refunds, voids, reports, export)
          stay available. */}
          {licenseState.degraded && (
            <div className="bg-amber-500/15 border-b border-amber-500/40 px-3 py-1.5 flex items-center justify-center gap-2 text-[11px] font-bold text-amber-300 shrink-0 select-none z-40">
              <span>Licence expirée — nouvelles ventes bloquées. Remboursements, rapports et exports restent disponibles.</span>
            </div>
          )}
          {/* Orientation Guidance on Mobile PC View */}
          {isMobileDevice() && !isLandscape && (
            <div className="bg-gradient-to-r from-indigo-950 via-purple-950 to-slate-900 border-b border-indigo-500/30 px-3 py-1.5 flex items-center justify-between text-[11px] text-indigo-200 shrink-0 select-none z-40">
              <div className="flex items-center gap-2 min-w-0">
                <RotateCw className="w-3.5 h-3.5 text-cyan-400 shrink-0 animate-spin" />
                <span className="truncate font-medium">Pivotez l'écran en paysage pour une vue caisse optimale</span>
              </div>
              <button
                type="button"
                onClick={() => setRoleMode('companion_mobile')}
                className="px-2 py-0.5 rounded-lg bg-indigo-500/30 hover:bg-indigo-500/40 text-cyan-300 font-bold text-[10px] shrink-0 ml-2 cursor-pointer transition active:scale-95"
              >
                Retour Mobile
              </button>
            </div>
          )}

          {/* Top Header */}
          <Header />

          {/* Main POS Workspace */}
          <div className="flex-1 flex overflow-hidden min-h-0">
            {/* Left: Cart & Payment Sidebar */}
            <CartPanel />

            {/* Right: Product Catalog Grid */}
            <ProductCatalog />
          </div>

          {/* Bottom Bar with Hotkeys & Status */}
          <BottomBar />

          {/* Floating Mobile Return Button on Touch Devices in PC view */}
          {isMobileDevice() && (
            <button
              type="button"
              onClick={() => setRoleMode('companion_mobile')}
              className="fixed right-3 z-50 px-3 py-1.5 rounded-xl bg-cyan-600/95 hover:bg-cyan-500 text-white font-bold text-xs shadow-xl shadow-cyan-950/60 border border-cyan-400/40 flex items-center gap-1.5 active:scale-95 transition cursor-pointer bottom-[calc(var(--safe-bottom)+3rem)]"
              title="Revenir au mode compagnon mobile"
            >
              <Smartphone className="w-3.5 h-3.5" />
              <span>Mode Mobile</span>
            </button>
          )}

          {/* Hidden Silent Thermal Receipt Printer (Direct window.print) */}
          <SilentReceiptPrinter />

          {/* Dialog Modals with Isolated Error Boundaries */}
          <GlobalModalHost />

          {/* Full-Screen Staff Lock Screen */}
          <LockScreenOverlay />
          {/* Blocking first-boot PIN setup (renders above the lock screen) */}
          <FirstBootPinSetup />
        </div>
      </ToastProvider>
    </ErrorBoundary>
  );
};

export default App;

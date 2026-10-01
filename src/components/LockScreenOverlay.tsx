import React, { useState, useEffect, useRef } from 'react';
import { Lock, Shield, User, AlertCircle } from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import type { CashierUser } from '../types/pos';
import { soundEngine } from '../utils/audioFeedback';
import { verifyPin, checkPinLockout, recordPinFailure, resetPinLockout, needsPinRotation, hashPin } from '../utils/security';
import { getDeviceRole, isCompanionTrusted, markCompanionTrusted, isEditableKeyTarget } from '../utils/platform';

export const LockScreenOverlay: React.FC = () => {
  // Selective subscriptions: whole-store spread re-rendered the lock screen
  // on every cart/sync tick even while unlocked (lag behind the overlay).
  const isScreenLocked = usePosStore((s) => s.isScreenLocked);
  const sessionLockRequested = usePosStore((s) => s.sessionLockRequested);
  const activeCashier = usePosStore((s) => s.activeCashier);
  const cashierUsers = usePosStore((s) => s.cashierUsers);
  const unlockScreen = usePosStore((s) => s.unlockScreen);
  const receiptSettings = usePosStore((s) => s.receiptSettings);

  const [selectedUser, setSelectedUser] = useState<CashierUser | null>(null);
  const [pinInput, setPinInput] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  // Phase 4.5 forced rotation: a successful login against a legacy
  // (pre-Argon2id) credential parks here INSTEAD of unlocking. The session
  // opens only after the user sets a fresh PIN below — old replicated
  // fast-hashes are treated as exposed, so they must not keep working.
  const [rotationFor, setRotationFor] = useState<{
    userId: string;
    name: string;
    isManager: boolean;
  } | null>(null);
  const [rotationNew, setRotationNew] = useState('');
  const [rotationConfirm, setRotationConfirm] = useState('');
  const [rotationError, setRotationError] = useState('');
  const [currentTime, setCurrentTime] = useState<string>('');
  const [currentDate, setCurrentDate] = useState<string>('');

  // Clock updater — gated on the locked state so an unlocked register does not
  // burn a 1 s wakeup for the app's whole lifetime (the overlay returns null
  // when unlocked, but the hook would otherwise keep ticking regardless).
  useEffect(() => {
    if (!isScreenLocked) return;
    const updateTime = () => {
      const now = new Date();
      setCurrentTime(
        now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      );
      setCurrentDate(
        now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, [isScreenLocked]);

  // Pre-select active cashier when locked
  useEffect(() => {
    if (isScreenLocked) {
      setSelectedUser(activeCashier || cashierUsers[0] || null);
      setPinInput('');
      setErrorMsg('');
      setRotationFor(null);
      setRotationNew('');
      setRotationConfirm('');
      setRotationError('');
    }
  }, [isScreenLocked, activeCashier, cashierUsers]);

  // PIN submit defined before the key effects so no effect reads it before
  // initialization. Strict per-profile PIN: the selected card unlocks only
  // with the PIN assigned to THAT account — another cashier's PIN is
  // rejected. The manager PIN is the sole override and always opens a
  // MANAGER session (admin user), never the selected cashier.
  //
  // Phase 4.5 WP3: under Tauri the verify decision is NATIVE (pin_verify —
  // constant-time compare, persisted escalating lockout, migration
  // detection). The stored hash never enters JS for the verdict, and a
  // native denial is final: there is deliberately NO local fallback after a
  // native verdict (falling back would bypass the native lockout). Local
  // verification runs ONLY outside Tauri (web preview / tests, where no
  // trust kernel exists). Order is selected-profile-first, then manager:
  // manager-first would burn a manager attempt on every cashier login and
  // lock the manager out; the single burned attempt on manager-override is
  // the documented cost (lockouts are per-profile, so blast radius is one
  // card).
  const handleSubmitPin = async () => {
    if (!pinInput) return;
    // Re-entry guard: a double-tap on Valider must not issue two native
    // verifies (each failure burns lockout budget).
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      await submitPinInner();
    } finally {
      submittingRef.current = false;
    }
  };

  const submitPinInner = async () => {
    const clean = pinInput.trim();
    const { logSecurityAction } = usePosStore.getState();

    // Brute-force lockout (same choke as unlockScreen/switchCashier): the
    // selected-profile branch below used to verify raw PINs with no attempt
    // counter — unlimited guesses at a 4-digit code.
    const lock = checkPinLockout();
    if (lock.isLocked) {
      soundEngine.playError();
      setErrorMsg(`Trop de tentatives — réessayez dans ${lock.remainingSeconds}s`);
      setPinInput('');
      return;
    }

    let success = false;
    let loggedInUser: CashierUser | null = null;
    let mustRotate = false;
    let nativeLockedRemainingMs = 0;

    const isTauri =
      typeof window !== 'undefined' &&
      Boolean(
        (window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown })
          .__TAURI_INTERNALS__ ||
          (window as unknown as { __TAURI__?: unknown }).__TAURI__
      );

    if (isTauri && selectedUser) {
      // Native-first: the hash never enters JS for the verdict.
      const { pinVerify } = await import('../api/pin');
      const st = usePosStore.getState();
      const adminUser =
        st.cashierUsers.find((u) => u.role === 'admin') || st.cashierUsers[0] || selectedUser;
      // Selected profile first, manager override second (see ordering note).
      const attempts: Array<{ userId: string; user: CashierUser }> = [
        { userId: selectedUser.id, user: selectedUser },
      ];
      if (adminUser.id !== selectedUser.id) {
        attempts.push({ userId: 'manager', user: adminUser });
      }
      for (const a of attempts) {
        let res;
        try {
          res = await pinVerify({ userId: a.userId, pin: clean });
        } catch {
          // Transport failure under Tauri: fail closed (deny). Never fall
          // back to local verification here — the native kernel is the
          // authority when present; a silent fallback would bypass its
          // lockout exactly when something is wrong.
          soundEngine.playError();
          setErrorMsg('Vérification indisponible — réessayez');
          setPinInput('');
          return;
        }
        if (res.locked) {
          nativeLockedRemainingMs = res.lockedRemainingMs;
          break;
        }
        if (res.ok) {
          success = true;
          loggedInUser = a.user;
          mustRotate = res.mustRotate;
          break;
        }
        // res.ok === false, not locked: try the next profile (manager
        // override) — the burned attempt on this profile is per-profile
        // bounded and documented above.
      }
    } else if (selectedUser) {
      // Non-Tauri only (web preview / Node tests): local verification. Under
      // Tauri this branch is unreachable by construction (isTauri above).
      const isTargetPin = verifyPin(clean, selectedUser.pin);
      // Raw manager-PIN compare (not verifyManagerPin — that helper records
      // its own failure, which would burn two attempts per wrong guess here;
      // the single recordPinFailure below owns the counter for this screen).
      const st0 = usePosStore.getState();
      const managerPin = st0.managerPin;
      const isMasterPin = Boolean(clean && managerPin && verifyPin(clean, managerPin));
      if (isMasterPin) {
        // The manager PIN always opens a MANAGER session — never whoever
        // happens to be selected on screen.
        const st = usePosStore.getState();
        const adminUser = st.cashierUsers.find((u) => u.role === 'admin') || st.cashierUsers[0] || selectedUser;
        success = true;
        loggedInUser = adminUser;
        mustRotate = needsPinRotation(managerPin);
      } else if (isTargetPin) {
        success = true;
        loggedInUser = selectedUser;
        mustRotate = needsPinRotation(selectedUser.pin);
      }
    } else {
      const res = unlockScreen(clean);
      success = res.success;
      loggedInUser = res.cashier || null;
      mustRotate = needsPinRotation(res.cashier?.pin || '');
    }

    // Phase 4.5 forced rotation: a correct legacy credential parks in the
    // rotation form instead of unlocking. Old replicated fast-hashes are
    // treated as exposed — they authenticate once, then must be replaced.
    // (Native path: mustRotate comes from pin_verify. Local path: derived
    // from the used credential — same gate, no hash leaves this closure.)
    if (success && loggedInUser && mustRotate) {
      const st = usePosStore.getState();
      const isManager = loggedInUser.role === 'admin' ||
        loggedInUser.id === (st.cashierUsers.find((u) => u.role === 'admin')?.id || '');
      setRotationFor({ userId: loggedInUser.id, name: loggedInUser.name, isManager });
      setRotationNew('');
      setRotationConfirm('');
      setRotationError('');
      setPinInput('');
      soundEngine.playError();
      return;
    }

    if (success && loggedInUser) {
      resetPinLockout();
      usePosStore.setState({ isScreenLocked: false, sessionLockRequested: false, activeCashier: loggedInUser });
      if (getDeviceRole() === 'companion_mobile') markCompanionTrusted();
      void logSecurityAction(
        'Connexion / Déverrouillage Caisse',
        `Session ouverte par ${loggedInUser.name} (${loggedInUser.role})`,
        loggedInUser.name,
        false
      );
      soundEngine.playSuccess();
      setPinInput('');
      setErrorMsg('');
    } else {
      const after = recordPinFailure();
      void logSecurityAction(
        'Échec Connexion PIN',
        `Tentative de code erroné pour ${selectedUser?.name || 'Inconnu'}`,
        selectedUser?.name || 'Inconnu',
        true
      );
      soundEngine.playError();
      // Native lockout is authoritative under Tauri (persisted, escalating,
      // not resettable from JS); the TS counter above is the cosmetic echo.
      setErrorMsg(
        nativeLockedRemainingMs > 0
          ? `Verrouillé — réessayez dans ${Math.ceil(nativeLockedRemainingMs / 1000)}s`
          : after.isLocked
            ? `Trop de tentatives — verrouillé ${after.remainingSeconds}s`
            : 'Code PIN incorrect'
      );
      setPinInput('');
    }
  };

  // Phase 4.5 forced rotation submit. Runs only from rotation mode (legacy
  // credential just verified). New PIN rules: manager 6+ digits, cashiers
  // exactly 4 digits, digits only, distinct from every other profile. Entry
  // fields cap at 8 digits (native ceiling is 32 — see report).
  const handleSubmitRotation = async () => {
    if (!rotationFor) return;
    const cleanNew = rotationNew.trim();
    const cleanConfirm = rotationConfirm.trim();
    const minLen = rotationFor.isManager ? 6 : 4;
    const maxLen = rotationFor.isManager ? 8 : 4;
    if (!/^[0-9]+$/.test(cleanNew) || cleanNew.length < minLen || cleanNew.length > maxLen) {
      setRotationError(
        rotationFor.isManager
          ? 'Le nouveau code PIN gérant doit comporter 6 à 8 chiffres.'
          : 'Le nouveau code PIN doit comporter exactement 4 chiffres.'
      );
      return;
    }
    if (cleanNew !== cleanConfirm) {
      setRotationError('Les deux codes saisis ne correspondent pas.');
      return;
    }
    const st = usePosStore.getState();
    // Distinctness across profiles (same rule as SettingsModal).
    const others = (st.cashierUsers || []).filter((u) => u.id !== rotationFor.userId);
    if (
      others.some((u) => verifyPin(cleanNew, u.pin)) ||
      (st.managerPin && verifyPin(cleanNew, st.managerPin))
    ) {
      setRotationError('Chaque personne doit avoir un code PIN différent (code déjà utilisé).');
      return;
    }
    try {
      if (rotationFor.isManager) {
        await st.setManagerPin(cleanNew);
      } else {
        await st.setCashierUsers(
          (st.cashierUsers || []).map((u) =>
            u.id === rotationFor.userId ? { ...u, pin: hashPin(cleanNew) } : u
          )
        );
      }
      const refreshed = usePosStore.getState();
      const loggedInUser =
        refreshed.cashierUsers.find((u) => u.id === rotationFor.userId) ||
        refreshed.cashierUsers[0];
      resetPinLockout();
      usePosStore.setState({ isScreenLocked: false, sessionLockRequested: false, activeCashier: loggedInUser });
      void usePosStore.getState().logSecurityAction(
        'Rotation PIN Sécurité',
        `Ancien hash pré-Argon2id remplacé pour ${rotationFor.name} (rotation forcée à la connexion)`,
        rotationFor.name,
        true
      );
      soundEngine.playSuccess();
      setRotationFor(null);
      setRotationNew('');
      setRotationConfirm('');
      setRotationError('');
      setPinInput('');
    } catch {
      setRotationError("Échec de l'enregistrement du nouveau PIN. Réessayez.");
    }
  };

  // Refs mirror the latest submit closure so the global key handler can stay
  // subscribed once per lock (not re-attached on every PIN digit — the old
  // [pinInput, selectedUser] deps re-added a window listener per keystroke).
  // submittingRef serializes native verifies (see handleSubmitPin).
  const submittingRef = useRef(false);
  const submitRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    submitRef.current = handleSubmitPin;
  });
  // Keyboard handler for quick PIN entry when no field owns the keystroke.
  // When the native PIN field is focused, the OS owns digits, Backspace and
  // Enter natively — intercepting here as well would double-apply digits and
  // kill native Backspace deletion on mobile soft keyboards.
  useEffect(() => {
    if (!isScreenLocked) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableKeyTarget(e)) return;
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        setErrorMsg('');
        soundEngine.playKeyBeep?.();
        setPinInput((prev) => (prev.length < 8 ? prev + e.key : prev));
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        setErrorMsg('');
        soundEngine.playKeyBeep?.();
        setPinInput((prev) => prev.slice(0, -1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        submitRef.current();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isScreenLocked]);

  // Phase 4.5: NO length-based auto-submit. Auto-submitting at 4 digits
  // would fire a wrong attempt (burning lockout budget) while a 6+ digit
  // manager PIN is still being typed. Every login is explicitly validated
  // via the Valider button or Enter — one extra tap, zero misfires.

  if (!isScreenLocked) return null;

  // Trusted companion: a paired phone/tablet the merchant already unlocks at
  // OS level skips the app PIN wall — unless explicitly locked this session
  // (lock button). Desktop tills always gate. Sensitive actions re-ask the
  // manager PIN regardless of trust.
  if (getDeviceRole() === 'companion_mobile' && isCompanionTrusted() && !sessionLockRequested) {
    return null;
  }

  // Salutation selon l'heure (affichage seul — aucune logique d'authentification touchée).
  const hourNow = new Date().getHours();
  const greeting = hourNow >= 18 || hourNow < 5 ? 'Bonsoir' : 'Bonjour';
  // Les points suivent la longueur réelle du PIN (4 points minimum) pour rester
  // cohérents avec le bouton Valider, qui apparaît dès 5 chiffres.
  const dotCount = Math.max(4, pinInput.length);

  return (
    <div className="fixed inset-0 z-[100] bg-slate-950/95 backdrop-blur-xl flex flex-col items-center justify-between p-6 select-none animate-in fade-in duration-200">
      {/* Top Bar: Store Brand & Live Clock */}
      <div className="w-full max-w-4xl flex items-center justify-between text-slate-400 pt-2">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center font-black text-sm">
            <Lock className="w-4 h-4" />
          </div>
          <div>
            <h1 className="text-sm font-black text-white tracking-wide uppercase">
              {receiptSettings.storeName || 'ACCESSOIRES MOBI'}
            </h1>
            <p className="text-[11px] text-slate-500">Connexion Caisse • Veille Sécurisée</p>
          </div>
        </div>

        <div className="text-right font-mono">
          <div className="text-xl font-black text-amber-400 tracking-wider">{currentTime}</div>
          <div className="text-[11px] text-slate-400 capitalize">{currentDate}</div>
        </div>
      </div>

      {/* Main Center Area: Staff Selector + PIN Pad */}
      <div className="w-full max-w-md flex flex-col items-center my-auto">
        {/* Cashier selection cards */}
        <div className="w-full mb-6">
          <label className="text-[10px] uppercase tracking-wider font-bold text-slate-400 block text-center mb-2.5">
            Sélectionnez votre compte caissier pour vous connecter
          </label>
          <div className="grid grid-cols-3 gap-2">
            {cashierUsers.map((u) => {
              const isSelected = selectedUser?.id === u.id;
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => {
                    setSelectedUser(u);
                    setPinInput('');
                    setErrorMsg('');
                    soundEngine.playKeyBeep?.();
                  }}
                  className={`p-3 rounded-2xl border transition-all flex flex-col items-center gap-1.5 cursor-pointer ${
                    isSelected
                      ? 'bg-amber-500/20 border-amber-500/80 text-white shadow-lg shadow-amber-500/10 scale-102'
                      : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-white'
                  }`}
                >
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center font-black text-sm text-slate-950 shadow"
                    style={{ backgroundColor: u.avatarColor || '#3b82f6' }}
                  >
                    {u.role === 'admin' ? <Shield className="w-5 h-5 text-white" /> : <User className="w-5 h-5 text-white" />}
                  </div>
                  <div className="text-center truncate w-full">
                    <span className="text-xs font-bold block truncate">{u.name}</span>
                    <span className="text-[9.5px] uppercase font-mono text-slate-400 block">{u.role}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Target Cashier Greeting & PIN Display */}
        <div className="text-center mb-4">
          <div className="text-sm font-semibold text-slate-300">
            {greeting}, <span className="font-black text-amber-400">{selectedUser?.name || 'Caissier'}</span>
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">Saisissez votre code PIN puis validez</div>

          {/* PIN Dots Display — suit la longueur réelle du PIN */}
          <div
            className="flex items-center justify-center gap-3 my-4"
            role="status"
            aria-label={pinInput.length === 0 ? 'PIN vide' : `${pinInput.length} chiffre${pinInput.length > 1 ? 's' : ''} saisi${pinInput.length > 1 ? 's' : ''}`}
          >
            {Array.from({ length: dotCount }).map((_, idx) => {
              const isFilled = pinInput.length > idx;
              return (
                <div
                  key={idx}
                  aria-hidden="true"
                  className={`w-4 h-4 rounded-full border-2 transition-all ${
                    isFilled
                      ? 'bg-amber-400 border-amber-400 scale-110 shadow-lg shadow-amber-400/50'
                      : 'border-slate-700 bg-slate-900'
                  }`}
                />
              );
            })}
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="text-rose-400 text-xs font-bold flex items-center justify-center gap-1 animate-in fade-in duration-150"
            >
              <AlertCircle className="w-3.5 h-3.5" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        {/* Phase 4.5 forced rotation: blocking, no dismiss path. The old
            credential verified correctly but its hash predates Argon2id
            (replicated fast-hash treated as exposed). Unlock completes only
            after a fresh PIN is set below. */}
        {rotationFor ? (
          <div className="w-full max-w-[280px] rounded-2xl border border-amber-500/50 bg-amber-500/10 p-4">
            <div className="text-amber-300 text-xs font-black text-center">
              Mise à jour sécurité requise
            </div>
            <p className="text-slate-300 text-[11px] text-center mt-1 mb-3 leading-relaxed">
              {rotationFor.name}, votre code PIN utilise un ancien format.
              Choisissez un nouveau code
              {rotationFor.isManager ? ' (gérant : 6 à 8 chiffres)' : ' (4 chiffres)'} pour
              continuer.
            </p>
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="new-password"
              aria-label="Nouveau code PIN"
              maxLength={8}
              value={rotationNew}
              onChange={(e) => {
                setRotationError('');
                setRotationNew(e.target.value.replace(/[^0-9]/g, '').slice(0, 8));
              }}
              placeholder="Nouveau PIN"
              autoFocus
              className="w-full min-h-[48px] bg-slate-900 border border-slate-700 rounded-xl px-4 text-center text-xl font-mono font-black tracking-[0.4em] text-white placeholder:text-slate-700 focus:outline-none focus:border-amber-400 transition mb-2"
            />
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="new-password"
              aria-label="Confirmer le nouveau code PIN"
              maxLength={8}
              value={rotationConfirm}
              onChange={(e) => {
                setRotationError('');
                setRotationConfirm(e.target.value.replace(/[^0-9]/g, '').slice(0, 8));
              }}
              placeholder="Confirmer"
              className="w-full min-h-[48px] bg-slate-900 border border-slate-700 rounded-xl px-4 text-center text-xl font-mono font-black tracking-[0.4em] text-white placeholder:text-slate-700 focus:outline-none focus:border-amber-400 transition"
            />
            {rotationError && (
              <div role="alert" className="text-rose-400 text-xs font-bold text-center mt-2">
                {rotationError}
              </div>
            )}
            <button
              type="button"
              onClick={() => void handleSubmitRotation()}
              className="mt-3 w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm transition active:scale-95 min-h-[48px]"
            >
              Enregistrer et déverrouiller
            </button>
          </div>
        ) : (
        <>
        {/* Native PIN field — the OS (incl. mobile soft keyboards) owns
            entry: digits, Backspace deletion and Enter validation are native. */}
        <form
          className="w-full max-w-[280px]"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmitPin();
          }}
        >
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="current-password"
            enterKeyHint="go"
            aria-label="Code PIN de connexion"
            maxLength={8}
            value={pinInput}
            onChange={(e) => {
              setErrorMsg('');
              setPinInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 8));
            }}
            placeholder="••••"
            autoFocus
            className="w-full min-h-[56px] bg-slate-900 border border-slate-700 rounded-2xl px-4 text-center text-2xl font-mono font-black tracking-[0.5em] text-white placeholder:text-slate-700 focus:outline-none focus:border-amber-400 transition"
          />
        </form>

        {/* Valider explicite uniquement (Phase 4.5 : plus de validation
            auto à 4 chiffres — une soumission prématurée brûlerait le quota
            de tentatives pendant la saisie d'un PIN gérant à 6+ chiffres). */}
        {pinInput.length > 0 && (
          <button
            type="button"
            onClick={() => void handleSubmitPin()}
            className="mt-3 px-8 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm transition active:scale-95 min-h-[48px]"
          >
            Valider
          </button>
        )}
        </>
        )}
      </div>

      {/* Footer Info */}
      <div className="text-center text-[11px] text-slate-400 font-mono">
        Saisissez votre code PIN au clavier ou sur l'écran tactile, puis validez
      </div>
    </div>
  );
};

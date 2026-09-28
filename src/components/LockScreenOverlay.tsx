import React, { useState, useEffect, useRef } from 'react';
import { Lock, Shield, User, AlertCircle } from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import type { CashierUser } from '../types/pos';
import { soundEngine } from '../utils/audioFeedback';
import { verifyPin, checkPinLockout, recordPinFailure, resetPinLockout } from '../utils/security';
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
    }
  }, [isScreenLocked, activeCashier, cashierUsers]);

  // PIN submit defined before the key effects so no effect reads it before
  // initialization. Strict per-profile PIN: the selected card unlocks only
  // with the PIN assigned to THAT account — another cashier's PIN is
  // rejected. The manager PIN is the sole override and always opens a
  // MANAGER session (admin user), never the selected cashier.
  const handleSubmitPin = () => {
    if (!pinInput) return;
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

    if (selectedUser) {
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
      } else if (isTargetPin) {
        success = true;
        loggedInUser = selectedUser;
      }
    } else {
      const res = unlockScreen(clean);
      success = res.success;
      loggedInUser = res.cashier || null;
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
      setErrorMsg(
        after.isLocked
          ? `Trop de tentatives — verrouillé ${after.remainingSeconds}s`
          : 'Code PIN incorrect'
      );
      setPinInput('');
    }
  };

  // Refs mirror the latest submit closure so the global key handler can stay
  // subscribed once per lock (not re-attached on every PIN digit — the old
  // [pinInput, selectedUser] deps re-added a window listener per keystroke).
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

  // Auto-submit when 4 digits entered (via ref to avoid re-subscribing).
  useEffect(() => {
    if (isScreenLocked && pinInput.length === 4) {
      submitRef.current();
    }
  }, [pinInput, isScreenLocked]);

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
          <div className="text-[11px] text-slate-400 mt-0.5">Saisissez votre code PIN à 4 chiffres</div>

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

        {/* Native PIN field — the OS (incl. mobile soft keyboards) owns
            entry: digits, Backspace deletion and Enter validation are native. */}
        <form
          className="w-full max-w-[280px]"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmitPin();
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

        {/* Manual submit for legacy >4-digit PINs: auto-submit fires at
            exactly 4 digits, so longer codes need an explicit validate key
            on touch-only terminals (physical Enter also works). */}
        {pinInput.length >= 5 && (
          <button
            type="button"
            onClick={() => handleSubmitPin()}
            className="mt-3 px-8 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm transition active:scale-95 min-h-[48px]"
          >
            Valider
          </button>
        )}
      </div>

      {/* Footer Info */}
      <div className="text-center text-[11px] text-slate-400 font-mono">
        Saisissez votre code PIN au clavier ou sur l'écran tactile, puis validez
        {pinInput.length >= 4 && (
          <span className="block mt-1 text-slate-500">Le bouton Valider apparaît pour les codes de plus de 4 chiffres</span>
        )}
      </div>
    </div>
  );
};

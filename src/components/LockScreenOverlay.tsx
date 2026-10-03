import React, { useState, useEffect, useRef } from 'react';
import { Lock, Shield, User, AlertCircle, Wrench, Copy, Check, RotateCw, X } from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import type { CashierUser } from '../types/pos';
import { soundEngine } from '../utils/audioFeedback';
import { verifyPin, checkPinLockout, recordPinFailure, resetPinLockout, needsPinRotation, isCommonPin } from '../utils/security';
import { getDeviceRole, isCompanionTrusted, markCompanionTrusted, isEditableKeyTarget } from '../utils/platform';
import { generateTechnicianChallenge, verifyTechnicianRecoveryCode, getActiveChallenge } from '../utils/technicianRecovery';

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
    // Same-session binding (OWASP re-auth pattern): the legacy verify that
    // parked this rotation expires after 5 min — a stale park must not mint.
    parkedAt: number;
  } | null>(null);
  const [rotationNew, setRotationNew] = useState('');
  const [rotationConfirm, setRotationConfirm] = useState('');
  const [rotationError, setRotationError] = useState('');
  const [currentTime, setCurrentTime] = useState<string>('');
  const [currentDate, setCurrentDate] = useState<string>('');

  // Technician Challenge-Response Recovery State (Model 1)
  const [showTechRecovery, setShowTechRecovery] = useState(false);
  const [recoveryChallenge, setRecoveryChallenge] = useState('');
  const [recoveryStep, setRecoveryStep] = useState<'enter_code' | 'set_new_pin'>('enter_code');
  const [recoveryOtpInput, setRecoveryOtpInput] = useState('');
  const [recoveryNewPin, setRecoveryNewPin] = useState('');
  const [recoveryConfirmPin, setRecoveryConfirmPin] = useState('');
  const [recoveryError, setRecoveryError] = useState('');
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [copiedChallenge, setCopiedChallenge] = useState(false);
  const [isShaking, setIsShaking] = useState(false);
  // F3 consumer: remaining native lockout for the manager credential,
  // polled (never attempting) so the user is not silently stuck. Null =
  // unknown/unavailable — never shown as unlocked.
  const [nativeLockRemainingMs, setNativeLockRemainingMs] = useState<number | null>(null);

  const isManagerProfile = Boolean(
    selectedUser?.role === 'admin' ||
    selectedUser?.id === 'usr-admin' ||
    selectedUser?.id === 'manager' ||
    (cashierUsers.find((u) => u.role === 'admin')?.id && selectedUser?.id === cashierUsers.find((u) => u.role === 'admin')?.id)
  );
  const targetPinLength = isManagerProfile ? 6 : 4;
  // Uniform policy (native validate_pin): manager 6–8, cashier exactly 4.
  // Length is ambiguous for managers, so auto-submit fires ONLY for the
  // fixed-length cashier PIN — managers always confirm with Valider. An
  // auto-submit at 6 would make 7–8-digit manager PINs untypeable
  // (self-lockout on a valid credential).
  const maxPinLength = isManagerProfile ? 8 : 4;
  const showManualSubmit =
    (isManagerProfile && pinInput.length >= 6) ||
    (!isManagerProfile && pinInput.length >= 4 && pinInput.length < targetPinLength);

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

  const inputRef = useRef<HTMLInputElement>(null);

  // Rotation-park expiry: the parked legacy verify is a live re-auth proof
  // for 5 minutes only. Past that the user re-enters their PIN (fresh
  // verify → fresh park) instead of minting on a stale proof.
  const ROTATION_PARK_TTL_MS = 5 * 60_000;
  useEffect(() => {
    if (!rotationFor) return;
    const remaining = rotationFor.parkedAt + ROTATION_PARK_TTL_MS - Date.now();
    if (remaining <= 0) {
      setRotationFor(null);
      setRotationNew('');
      setRotationConfirm('');
      setRotationError('Session expirée — ressaisissez votre code PIN.');
      setPinInput('');
      return;
    }
    const timer = window.setTimeout(() => {
      setRotationFor(null);
      setRotationNew('');
      setRotationConfirm('');
      setRotationError('Session expirée — ressaisissez votre code PIN.');
      setPinInput('');
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [rotationFor]);

  // Pre-select active cashier when locked. Guarded by profile identity:
  // roster reference churn (background sync, Dexie remirror) must NOT wipe an
  // in-flight PIN entry or steal focus — only an actual profile change (or a
  // fresh lock) resets the entry form.
  const selectedProfileIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isScreenLocked) {
      selectedProfileIdRef.current = null;
      return;
    }
    const next = activeCashier || cashierUsers[0] || null;
    const nextId = next?.id ?? null;
    if (nextId !== null && selectedProfileIdRef.current === nextId) {
      setSelectedUser(next);
      return;
    }
    selectedProfileIdRef.current = nextId;
    setSelectedUser(next);
    setPinInput('');
    setErrorMsg('');
    setRotationFor(null);
    setRotationNew('');
    setRotationConfirm('');
    setRotationError('');
    setTimeout(() => inputRef.current?.focus(), 60);
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
  const handleSubmitPin = async (candidate?: string) => {
    const raw = typeof candidate === 'string' ? candidate : pinInput;
    if (!raw) return;
    // Re-entry guard: a double-tap must not issue two native
    // verifies (each failure burns lockout budget).
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      await submitPinInner(raw);
    } finally {
      submittingRef.current = false;
    }
  };

  const submitPinInner = async (rawPin: string) => {
    const clean = rawPin.trim();
    const { logSecurityAction } = usePosStore.getState();

    const isTauri =
      typeof window !== 'undefined' &&
      Boolean(
        (window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown })
          .__TAURI_INTERNALS__ ||
          (window as unknown as { __TAURI__?: unknown }).__TAURI__
      );

    // Brute-force lockout: on non-Tauri (web preview/Node tests), local counter
    // governs. Under Tauri, native lockout is authoritative (escalating ladder
    // checked inside pin_verify).
    if (!isTauri) {
      const lock = checkPinLockout();
      if (lock.isLocked) {
        soundEngine.playError();
        setErrorMsg(`Trop de tentatives — réessayez dans ${lock.remainingSeconds}s`);
        setPinInput('');
        return;
      }
    }

    let success = false;
    let loggedInUser: CashierUser | null = null;
    let mustRotate = false;
    let nativeLockedRemainingMs = 0;

    if (isTauri && selectedUser) {
      // Native-first: the hash never enters JS for the verdict.
      const { pinVerify } = await import('../api/pin');
      const st = usePosStore.getState();
      const adminUser =
        st.cashierUsers.find((u) => u.role === 'admin') || st.cashierUsers[0] || selectedUser;
      // Selected profile first, manager override second (see ordering note).
      const attempts: Array<{ userId: string; user: CashierUser }> = [];
      if (selectedUser.role === 'admin' || selectedUser.id === adminUser.id || selectedUser.id === 'usr-admin') {
        // Admin profile: try manager credential (where manager PIN lives), then profile ID if distinct
        attempts.push({ userId: 'manager', user: adminUser });
        if (selectedUser.id !== 'manager') {
          attempts.push({ userId: selectedUser.id, user: selectedUser });
        }
      } else {
        // Cashier profile: try cashier first, then manager override
        attempts.push({ userId: selectedUser.id, user: selectedUser });
        attempts.push({ userId: 'manager', user: adminUser });
      }

      let transportFailureCount = 0;
      for (const a of attempts) {
        let res;
        try {
          res = await pinVerify({ userId: a.userId, pin: clean });
        } catch {
          // Transport failure under Tauri: fail closed (deny). Never fall
          // back to local verification here — the native kernel is the
          // authority when present; a silent fallback would bypass its
          // lockout exactly when something is wrong. No local fallback.
          transportFailureCount++;
          continue;
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
      if (!success && nativeLockedRemainingMs === 0 && transportFailureCount === attempts.length) {
        soundEngine.playError();
        setErrorMsg('Vérification indisponible — réessayez');
        setPinInput('');
        return;
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
      setRotationFor({ userId: loggedInUser.id, name: loggedInUser.name, isManager, parkedAt: Date.now() });
      setRotationNew('');
      setRotationConfirm('');
      setRotationError('');
      setPinInput('');
      soundEngine.playKeyBeep?.();
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
      setIsShaking(true);
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([60, 40, 60]);
      }
      setTimeout(() => setIsShaking(false), 500);

      const attemptsLeft = after.attemptsLeft;
      const msg =
        nativeLockedRemainingMs > 0
          ? `Accès verrouillé — réessayez dans ${Math.ceil(nativeLockedRemainingMs / 1000)}s`
          : after.isLocked
            ? `Trop de tentatives — verrouillé ${after.remainingSeconds}s`
            : attemptsLeft <= 3
              ? `Code d'accès incorrect • ${attemptsLeft} tentative${attemptsLeft > 1 ? 's' : ''} restante${attemptsLeft > 1 ? 's' : ''}`
              : 'Code d\'accès incorrect';
      setErrorMsg(msg);
      setTimeout(() => {
        setPinInput('');
        inputRef.current?.focus();
      }, 400);
    }
  };

  // Phase 4.5 forced rotation submit. Runs only from rotation mode (legacy
  // credential just verified). New PIN rules: manager 6+ digits, cashiers
  // exactly 4 digits, digits only, distinct from every other profile. Entry
  // fields cap at 8 digits (native ceiling is 32 — see report).
  const rotationSubmittingRef = useRef(false);
  const handleSubmitRotation = async () => {
    if (!rotationFor || rotationSubmittingRef.current) return;
    // Park expiry, checked at submit as well as by the timer: a stale park
    // fails closed back to PIN entry.
    if (Date.now() - rotationFor.parkedAt > ROTATION_PARK_TTL_MS) {
      setRotationFor(null);
      setRotationNew('');
      setRotationConfirm('');
      setRotationError('Session expirée — ressaisissez votre code PIN.');
      setPinInput('');
      return;
    }
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
    // Banal-PIN screen (NIST 800-63B-4): instant feedback here, authoritative
    // enforcement natively in pin_set — a bypass still cannot mint.
    if (isCommonPin(cleanNew)) {
      setRotationError('Code trop simple (suite, répétition ou code banal) — choisissez un code moins prévisible.');
      return;
    }
    const st = usePosStore.getState();
    // Distinctness across profiles (same rule as SettingsModal).
    const others = (st.cashierUsers || []).filter((u) => u.id !== rotationFor.userId);
    const conflictsWithOther = others.some((u) => verifyPin(cleanNew, u.pin));
    const conflictsWithManager =
      !rotationFor.isManager && Boolean(st.managerPin && verifyPin(cleanNew, st.managerPin));
    if (conflictsWithOther || conflictsWithManager) {
      setRotationError('Chaque personne doit avoir un code PIN différent (code déjà utilisé).');
      return;
    }
    rotationSubmittingRef.current = true;
    try {
      // Phase 4a: rotation mints through the native KDF under Tauri
      // (`pin_set` → Argon2id v2, hash never enters the WebView). The legacy
      // TS mint survives only outside Tauri (web preview) inside
      // rotatePinCredential — never as a fallback here.
      const rotated = await st.rotatePinCredential(rotationFor.userId, cleanNew, rotationFor.isManager);
      const refreshed = usePosStore.getState();
      const loggedInUser =
        refreshed.cashierUsers.find((u) => u.id === rotationFor.userId) ||
        refreshed.cashierUsers[0];
      resetPinLockout();
      usePosStore.setState({ isScreenLocked: false, sessionLockRequested: false, activeCashier: loggedInUser });
      void usePosStore.getState().logSecurityAction(
        'Rotation PIN Sécurité',
        `Credential renouvelée pour ${rotationFor.name} (rotation forcée à la connexion, format ${rotated.format})`,
        rotationFor.name,
        true
      );
      soundEngine.playSuccess();
      setRotationFor(null);
      setRotationNew('');
      setRotationConfirm('');
      setRotationError('');
      setPinInput('');
    } catch (e: unknown) {
      const { friendlyPinSetError } = await import('../api/pin');
      setRotationError(friendlyPinSetError(e));
    } finally {
      rotationSubmittingRef.current = false;
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
  const handleDigit = (d: string) => {
    if (submittingRef.current) return;
    setErrorMsg('');
    soundEngine.playKeyBeep?.();
    setPinInput((prev) => {
      if (prev.length >= maxPinLength) return prev;
      const next = prev + d;
      // Fixed-length cashier PIN only: manager length is ambiguous (6–8).
      if (!isManagerProfile && next.length === targetPinLength) {
        void handleSubmitPin(next);
      }
      return next;
    });
  };

  const handleBackspace = () => {
    if (submittingRef.current) return;
    setErrorMsg('');
    soundEngine.playKeyBeep?.();
    setPinInput((prev) => prev.slice(0, -1));
  };

  const handleClear = () => {
    if (submittingRef.current) return;
    setErrorMsg('');
    soundEngine.playKeyBeep?.();
    setPinInput('');
  };

  const handleOpenTechRecovery = async () => {
    setErrorMsg('');
    setRecoveryError('');
    setRecoveryOtpInput('');
    setRecoveryNewPin('');
    setRecoveryConfirmPin('');
    setRecoveryStep('enter_code');
    setNativeLockRemainingMs(null);
    // Read-only countdown: does not attempt, does not burn budget. A
    // rotation here replaces the LOCAL credential only — the native
    // lockout below still runs to expiry.
    try {
      const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
      if (w.__TAURI_INTERNALS__ || (w as unknown as { __TAURI__?: unknown }).__TAURI__) {
        const { pinLockoutRemaining } = await import('../api/pin');
        const st = await pinLockoutRemaining('manager');
        if (st.locked) setNativeLockRemainingMs(st.lockedRemainingMs);
      }
    } catch {
      // Unavailable — the panel works without the countdown.
    }
    const existing = getActiveChallenge();
    const ch = existing || (await generateTechnicianChallenge());
    setRecoveryChallenge(ch);
    setShowTechRecovery(true);
  };

  const handleRefreshChallenge = async () => {
    setRecoveryLoading(true);
    try {
      const fresh = await generateTechnicianChallenge();
      setRecoveryChallenge(fresh);
      setRecoveryOtpInput('');
      setRecoveryError('');
    } finally {
      setRecoveryLoading(false);
    }
  };

  const handleVerifyTechOtp = async () => {
    if (!recoveryOtpInput || recoveryOtpInput.length !== 6) {
      setRecoveryError('Veuillez saisir le code à 6 chiffres fourni par le technicien.');
      return;
    }
    setRecoveryLoading(true);
    setRecoveryError('');
    try {
      const res = await verifyTechnicianRecoveryCode(recoveryChallenge, recoveryOtpInput);
      if (res.ok) {
        soundEngine.playSuccess?.();
        setRecoveryStep('set_new_pin');
      } else {
        soundEngine.playError?.();
        setRecoveryError(res.error || 'Code technicien invalide ou expiré.');
      }
    } finally {
      setRecoveryLoading(false);
    }
  };

  const handleSubmitNewManagerPin = async () => {
    const cleanNew = recoveryNewPin.trim();
    const cleanConfirm = recoveryConfirmPin.trim();
    if (!/^[0-9]+$/.test(cleanNew) || cleanNew.length < 6 || cleanNew.length > 8) {
      setRecoveryError('Le nouveau code PIN gérant doit comporter 6 à 8 chiffres.');
      return;
    }
    if (cleanNew !== cleanConfirm) {
      setRecoveryError('Les deux codes saisis ne correspondent pas.');
      return;
    }
    if (isCommonPin(cleanNew)) {
      setRecoveryError('Code trop simple (suite, répétition ou code banal) — choisissez un code moins prévisible.');
      return;
    }
    if (recoveryLoading) return;
    setRecoveryLoading(true);
    try {
      const st = usePosStore.getState();
      // Same native-first rule as forced rotation: tech recovery re-keys to
      // Argon2id under Tauri, never to a locally-minted fast hash.
      // Pepper-dead unboxing: if the device pepper is gone (all v2 fail
      // closed), the plain rotation fails with a pepper-absent error — then
      // exactly one retry with recoveryReset re-provisions the pepper and
      // re-keys the master. Never preemptive (a healthy install rejects it).
      try {
        await st.rotatePinCredential('manager', cleanNew, true);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/pepper absent/i.test(msg)) throw e;
        await st.rotatePinCredential('manager', cleanNew, true, { recoveryReset: true });
      }
      resetPinLockout();
      const refreshed = usePosStore.getState();
      const adminUser =
        refreshed.cashierUsers.find((u) => u.role === 'admin') || refreshed.cashierUsers[0];
      usePosStore.setState({ isScreenLocked: false, sessionLockRequested: false, activeCashier: adminUser });
      void usePosStore.getState().logSecurityAction(
        'Récupération PIN Gérant',
        'Accès réinitialisé avec succès via code de secours technicien (Challenge-Response)',
        adminUser?.name || 'Manager',
        true
      );
      soundEngine.playSuccess?.();
      setShowTechRecovery(false);
      setPinInput('');
      setErrorMsg('');
    } catch (e: unknown) {
      const { friendlyPinSetError } = await import('../api/pin');
      setRecoveryError(friendlyPinSetError(e));
    } finally {
      setRecoveryLoading(false);
    }
  };

  // Keyboard handler for quick PIN entry.
  useEffect(() => {
    if (!isScreenLocked) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (showTechRecovery) return;
      if (isEditableKeyTarget(e) && e.target !== inputRef.current) return;
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        handleDigit(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handleBackspace();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleClear();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (pinInput.length > 0) {
          void handleSubmitPin();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isScreenLocked, pinInput, showTechRecovery]);

  useEffect(() => {
    if (isScreenLocked && !rotationFor && !showTechRecovery) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isScreenLocked, rotationFor, selectedUser, showTechRecovery]);

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
                    inputRef.current?.focus();
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

        {/* Target Cashier Greeting */}
        <div className="text-center mb-4">
          <div className="text-sm font-semibold text-slate-300">
            {greeting}, <span className="font-black text-amber-400">{selectedUser?.name || 'Caissier'}</span>
          </div>
          {!rotationFor && (
            <div className="text-[11px] text-slate-400 mt-0.5">
              {isManagerProfile
                ? 'Saisissez votre code PIN gérant (6 à 8 chiffres)'
                : 'Saisissez votre code PIN caissier (4 chiffres)'}
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
          <div className="w-full flex flex-col items-center">
            {/* Dynamic Slot PIN Input UI */}
            <div
              className={`relative flex items-center justify-center gap-2 sm:gap-3 cursor-pointer py-3 px-2 touch-manipulation ${
                isShaking ? 'animate-lock-shake' : ''
              }`}
              onClick={() => inputRef.current?.focus()}
            >
              <input
                ref={inputRef}
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-label={`Code PIN de connexion (${isManagerProfile ? '6 à 8' : '4'} chiffres)`}
                maxLength={maxPinLength}
                value={pinInput}
                onChange={(e) => {
                  if (submittingRef.current) return;
                  const val = e.target.value.replace(/[^0-9]/g, '').slice(0, maxPinLength);
                  if (val === pinInput) return;
                  setErrorMsg('');
                  soundEngine.playKeyBeep?.();
                  setPinInput(val);
                  if (!isManagerProfile && val.length === targetPinLength) {
                    void handleSubmitPin(val);
                  }
                }}
                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full text-transparent bg-transparent z-10 touch-manipulation caret-transparent"
                autoFocus
              />

              {Array.from({ length: maxPinLength }).map((_, idx) => {
                const isFilled = pinInput.length > idx;
                const isActive = pinInput.length === idx;
                const hasError = Boolean(errorMsg);

                return (
                  <div
                    key={idx}
                    className={`w-11 h-14 sm:w-14 sm:h-16 rounded-xl sm:rounded-2xl border-2 flex items-center justify-center transition-all duration-150 select-none ${
                      hasError
                        ? 'border-rose-500/80 bg-rose-950/30 text-rose-400 shadow-lg shadow-rose-950/30'
                        : isFilled
                          ? 'border-amber-400 bg-amber-500/10 text-amber-400 shadow-md shadow-amber-500/10 scale-102'
                          : isActive
                            ? 'border-amber-400/90 bg-slate-900 ring-4 ring-amber-400/20 text-white'
                            : 'border-slate-800 bg-slate-900/60 text-slate-600 hover:border-slate-700'
                    }`}
                  >
                    {isFilled ? (
                      <div className="w-3.5 h-3.5 sm:w-4 sm:h-4 rounded-full bg-amber-400 shadow-md shadow-amber-400/60" />
                    ) : isActive ? (
                      <div className="w-0.5 h-6 bg-amber-400 rounded-full animate-pulse" />
                    ) : (
                      <div className="w-2 h-2 rounded-full bg-slate-700/60" />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Error or Auto-submit Hint */}
            {errorMsg ? (
              <div
                role="alert"
                className="mt-3 px-3.5 py-1.5 rounded-full bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs font-semibold flex items-center justify-center gap-1.5 animate-in fade-in duration-150 min-h-[28px]"
              >
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            ) : (
              <div className="mt-3 text-[11px] text-slate-400 font-medium min-h-[28px] flex items-center justify-center">
                {isManagerProfile ? (
                  <span>Saisissez 6 à 8 chiffres puis Valider</span>
                ) : (
                  <span>Déverrouillage instantané dès {targetPinLength} chiffres</span>
                )}
              </div>
            )}

            {/* Manual submit: required for managers (variable length), escape
                hatch for cashiers */}
            {showManualSubmit && (
              <button
                type="button"
                onClick={() => void handleSubmitPin()}
                className="mt-3 px-6 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-bold transition active:scale-95 cursor-pointer"
              >
                Valider ({pinInput.length} chiffres)
              </button>
            )}

            {/* Technician Recovery Link */}
            <button
              type="button"
              onClick={() => void handleOpenTechRecovery()}
              className="mt-4 text-xs text-slate-400 hover:text-amber-400 transition underline underline-offset-4 cursor-pointer flex items-center gap-1.5"
            >
              <Wrench className="w-3.5 h-3.5" />
              <span>Code PIN oublié ? Assistance technicien</span>
            </button>
          </div>
        )}
      </div>

      {/* Footer Info */}
      <div className="text-center text-[11px] text-slate-500 font-mono">
        Saisissez votre code PIN au clavier
      </div>

      {/* Technician Recovery Modal (Model 1: Dynamic Challenge-Response) */}
      {showTechRecovery && (
        <div className="fixed inset-0 z-[110] bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md bg-slate-900 border border-amber-500/40 rounded-3xl p-6 shadow-2xl relative">
            <button
              type="button"
              onClick={() => setShowTechRecovery(false)}
              className="absolute top-5 right-5 text-slate-400 hover:text-white transition p-1 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-2xl bg-amber-500/20 border border-amber-500/40 text-amber-400 flex items-center justify-center font-black">
                <Wrench className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-black text-white">Assistance Technicien</h3>
                <p className="text-xs text-slate-400">Récupération d'accès sécurisée sans mot de passe universel</p>
              </div>
            </div>

            {recoveryStep === 'enter_code' ? (
              <div className="space-y-4">
                <p className="text-xs text-slate-300 leading-relaxed">
                  Si vous avez oublié le code PIN gérant, contactez votre distributeur / technicien (par téléphone ou WhatsApp) et communiquez-lui ce code de défi :
                </p>

                {/* Challenge Badge */}
                <div className="bg-slate-950 border border-amber-500/50 rounded-2xl p-4 flex items-center justify-between shadow-inner">
                  <div>
                    <div className="text-[10px] text-amber-400 font-bold uppercase tracking-wider">Code de défi caisse</div>
                    <div className="text-xl sm:text-2xl font-mono font-black text-white tracking-widest mt-0.5 select-all">
                      {recoveryChallenge || 'Chargement...'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (recoveryChallenge) {
                          navigator.clipboard?.writeText(recoveryChallenge);
                          setCopiedChallenge(true);
                          setTimeout(() => setCopiedChallenge(false), 2000);
                        }
                      }}
                      className="px-3 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs font-bold transition flex items-center gap-1.5 cursor-pointer"
                    >
                      {copiedChallenge ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedChallenge ? 'Copié' : 'Copier'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRefreshChallenge()}
                      title="Générer un nouveau code"
                      className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition cursor-pointer"
                    >
                      <RotateCw className={`w-4 h-4 ${recoveryLoading ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                </div>

                <div className="text-[11px] text-slate-400 bg-slate-800/40 rounded-xl p-3 border border-slate-800 leading-relaxed">
                  Le technicien calcule un code de déverrouillage temporaire (6 chiffres) signé pour votre terminal.
                  {nativeLockRemainingMs !== null && nativeLockRemainingMs > 0 && (
                    <span className="block mt-1.5 text-amber-300 font-bold">
                      Verrouillage natif actif : {Math.max(1, Math.ceil(nativeLockRemainingMs / 1000))}s restantes.
                      La récupération remplace le PIN local mais ne lève pas ce verrou avant son expiration.
                    </span>
                  )}
                </div>

                {/* Input for the 6-digit technician code */}
                <div>
                  <label className="text-[11px] font-bold text-slate-300 block mb-1.5">
                    Code de secours technicien (6 chiffres)
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={recoveryOtpInput}
                    onChange={(e) => {
                      setRecoveryError('');
                      setRecoveryOtpInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 6));
                    }}
                    placeholder="ex: 137680"
                    autoFocus
                    className="w-full h-12 bg-slate-950 border border-slate-700 rounded-xl px-4 text-center text-2xl font-mono font-black tracking-widest text-amber-400 placeholder:text-slate-700 focus:outline-none focus:border-amber-400 transition"
                  />
                </div>

                {recoveryError && (
                  <div role="alert" className="text-rose-400 text-xs font-bold flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{recoveryError}</span>
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowTechRecovery(false)}
                    className="flex-1 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs transition cursor-pointer"
                  >
                    Annuler
                  </button>
                  <button
                    type="button"
                    disabled={recoveryLoading || recoveryOtpInput.length !== 6}
                    onClick={() => void handleVerifyTechOtp()}
                    className="flex-1 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-xs transition cursor-pointer"
                  >
                    {recoveryLoading ? 'Vérification...' : 'Valider le code'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="bg-emerald-950/30 border border-emerald-500/40 rounded-2xl p-3.5 text-emerald-300 text-xs font-semibold leading-relaxed flex items-center gap-2">
                  <Check className="w-4 h-4 shrink-0 text-emerald-400" />
                  <span>Code technicien validé ! Veuillez définir votre nouveau code PIN gérant :</span>
                </div>

                <div>
                  <label className="text-[11px] font-bold text-slate-300 block mb-1">
                    Nouveau code PIN gérant (6 à 8 chiffres)
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={8}
                    value={recoveryNewPin}
                    onChange={(e) => {
                      setRecoveryError('');
                      setRecoveryNewPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 8));
                    }}
                    placeholder="••••••"
                    autoFocus
                    className="w-full h-12 bg-slate-950 border border-slate-700 rounded-xl px-4 text-center text-xl font-mono font-black tracking-widest text-white placeholder:text-slate-700 focus:outline-none focus:border-amber-400 transition"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-bold text-slate-300 block mb-1">
                    Confirmer le nouveau code PIN
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={8}
                    value={recoveryConfirmPin}
                    onChange={(e) => {
                      setRecoveryError('');
                      setRecoveryConfirmPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 8));
                    }}
                    placeholder="••••••"
                    className="w-full h-12 bg-slate-950 border border-slate-700 rounded-xl px-4 text-center text-xl font-mono font-black tracking-widest text-white placeholder:text-slate-700 focus:outline-none focus:border-amber-400 transition"
                  />
                </div>

                {recoveryError && (
                  <div role="alert" className="text-rose-400 text-xs font-bold flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{recoveryError}</span>
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowTechRecovery(false)}
                    className="flex-1 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs transition cursor-pointer"
                  >
                    Annuler
                  </button>
                  <button
                    type="button"
                    disabled={recoveryLoading || recoveryNewPin.length < 6}
                    onClick={() => void handleSubmitNewManagerPin()}
                    className="flex-1 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-xs transition cursor-pointer"
                  >
                    {recoveryLoading ? 'Enregistrement...' : 'Enregistrer et déverrouiller'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

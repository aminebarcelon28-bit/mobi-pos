import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ShieldCheck } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import {
  PIN_DIALOG_MAX_LENGTH,
  PIN_DIALOG_MIN_LENGTH,
  isPinDialogLengthOk,
  type GateRole,
} from '../../utils/auditGate';
import { verifyManagerGate } from '../../utils/pinGate';

interface PinDialogProps {
  isOpen: boolean;
  title: string;
  description?: string;
  onSuccess: () => void;
  onCancel: () => void;
  /**
   * Display role for copy only. Length is 4–12 for both roles (see
   * PIN_DIALOG_MIN/MAX_LENGTH) — verification decides, not the dialog.
   * Defaults to manager because every current call site gates a manager
   * action (drawer No-Sale, stock force-sale). No auto-submit at any
   * length — an explicit Valider press is required so longer PINs never
   * misfire.
   *
   * Phase 1: verification routes through the native gate
   * (`verifyManagerGate` — pin_verify under Tauri, fail-closed). The weak
   * local path survives ONLY outside Tauri (flagged in code, never for
   * privileged actions).
   */
  role?: GateRole;
}

export const PinDialog: React.FC<PinDialogProps> = ({
  isOpen,
  title,
  description,
  onSuccess,
  onCancel,
  role = 'manager',
}) => {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  // Focus trap-lite: remember the invoker to return focus on close.
  const previouslyFocusedRef = useRef<Element | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pinInputRef = useRef<HTMLInputElement>(null);
  
  // NOTE: verifyManagerPin is intentionally NOT read here anymore — the
  // dialog routes through verifyManagerGate (native under Tauri).
  const logSecurityAction = usePosStore((state) => state.logSecurityAction);

  const resetState = useCallback(() => {
    setPin('');
    setError(false);
    setLockMsg(null);
    setVerifying(false);
  }, []);

  useEffect(() => {
    if (isOpen) {
      resetState();
      // Store the invoker; move focus into the native PIN field so the OS
      // (and the mobile soft keyboard) owns entry — digits, Backspace and
      // Enter all behave natively.
      previouslyFocusedRef.current = document.activeElement;
      const raf = requestAnimationFrame(() => {
        pinInputRef.current?.focus();
      });
      return () => cancelAnimationFrame(raf);
    }
    // Return focus to the invoker on close (trap-lite, no behavior change).
    if (previouslyFocusedRef.current instanceof HTMLElement) {
      previouslyFocusedRef.current.focus();
    }
    previouslyFocusedRef.current = null;
  }, [isOpen, resetState]);

  const minLength = PIN_DIALOG_MIN_LENGTH;

  const [verifying, setVerifying] = useState(false);
  const [lockMsg, setLockMsg] = useState<string | null>(null);

  const handleVerify = useCallback(async (currentPin: string) => {
    // 4–12 digits, explicit submit only (no auto-submit). Verification is
    // native under Tauri (fail-closed); the weak local path runs ONLY
    // outside Tauri. Locked shows the native countdown — never recorded
    // locally, never retried silently.
    if (!isPinDialogLengthOk(currentPin)) {
      setError(true);
      setTimeout(() => {
        setError(false);
      }, 500);
      return;
    }
    if (verifying) return;
    setVerifying(true);
    setError(false);
    try {
      const res = await verifyManagerGate(currentPin);
      if (res.ok) {
        setLockMsg(null);
        if (logSecurityAction) {
          logSecurityAction('Vérification PIN Réussie', 'Validation du code PIN manager');
        }
        onSuccess();
        return;
      }
      if (logSecurityAction) {
        logSecurityAction('Tentative PIN Échouée', res.locked ? 'Code PIN verrouillé (compte à rebours natif)' : 'Code PIN incorrect saisi');
      }
      if (res.locked) {
        const secs = Math.max(1, Math.ceil(res.remainingMs / 1000));
        setLockMsg(`Verrouillé — réessayez dans ${secs}s.`);
      }
      setError(true);
      setTimeout(() => {
        setPin('');
        setError(false);
      }, 500); // 500ms allows the shake animation to finish
    } finally {
      setVerifying(false);
    }
  }, [verifying, logSecurityAction, onSuccess]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape ferme ; chiffres / Backspace / Enter appartiennent au champ
      // natif (saisie OS, suppression et validation natives).
      if (e.key === 'Escape') {
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <>
      <style>
        {`
          @keyframes shake {
            0%, 100% { transform: translateX(0); }
            10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }
            20%, 40%, 60%, 80% { transform: translateX(5px); }
          }
          .animate-shake {
            animation: shake 0.4s cubic-bezier(.36,.07,.19,.97) both;
          }
        `}
      </style>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div 
          ref={dialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="pin-dialog-title"
          aria-describedby="pin-dialog-desc"
          className={`w-full max-w-sm bg-pos-panel border border-pos-border rounded-2xl shadow-2xl p-6 outline-none ${error ? 'animate-shake' : ''}`}
        >
          <div className="flex flex-col items-center mb-6 text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center mb-4 text-emerald-500" aria-hidden="true">
              <ShieldCheck size={28} />
            </div>
            <h2 id="pin-dialog-title" className="text-xl font-bold text-pos-text mb-2">{title}</h2>
            <p id="pin-dialog-desc" className="text-sm text-pos-muted">
              {description || (role === 'cashier' ? 'Entrez le PIN à 4 chiffres' : 'Entrez le PIN manager')}
            </p>
          </div>

          {/* Champ PIN natif : le clavier OS (tactile y compris) gère la
              saisie et la suppression. Pas de vérification automatique :
              la validation exige un appui explicite sur Valider (Entrée). */}
          <form
            className="mb-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (!error && !verifying) void handleVerify(pin);
            }}
          >
            <input
              ref={pinInputRef}
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="current-password"
              enterKeyHint="done"
              aria-label={role === 'cashier' ? 'Code PIN à 4 chiffres' : 'Code PIN manager'}
              aria-invalid={error}
              aria-describedby={error ? 'pin-dialog-error' : 'pin-dialog-desc'}
              maxLength={PIN_DIALOG_MAX_LENGTH}
              value={pin}
              onChange={(e) => {
                if (error) return;
                const next = e.target.value.replace(/[^0-9]/g, '').slice(0, PIN_DIALOG_MAX_LENGTH);
                setPin(next);
              }}
              placeholder="••••"
              className="w-full min-h-[56px] bg-pos-card border border-pos-border rounded-xl px-4 text-center text-2xl font-mono font-black tracking-[0.5em] text-pos-text focus:outline-none focus:border-emerald-500 transition"
            />
            <span className="sr-only" role="status">
              {pin.length} chiffres saisis, {minLength} minimum
            </span>
            <button
              type="submit"
              disabled={pin.trim().length < minLength || error || verifying}
              className="mt-4 w-full min-h-[48px] rounded-xl font-bold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition"
            >
              {verifying ? 'Vérification…' : 'Valider'}
            </button>
          </form>

          {(error || lockMsg) && (
            <div id="pin-dialog-error" role="alert" className="text-center text-red-500 text-sm mb-4 font-medium">
              {lockMsg ?? 'PIN incorrect. Veuillez réessayer.'}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 py-3 px-4 rounded-xl font-bold text-pos-muted bg-pos-card hover:bg-pos-hover border border-pos-border transition-colors duration-200"
            >
              Annuler
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

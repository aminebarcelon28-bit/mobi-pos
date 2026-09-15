import React, { useState, useEffect } from 'react';
import { ShieldCheck, X, KeyRound, AlertTriangle, Lock } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { useToast } from '../ui/Toast';
import { checkPinLockout, recordPinFailure, resetPinLockout } from '../../utils/security';

export const PinPromptModal: React.FC = () => {
  const { activeModal, closeModal, verifyManagerPin, pendingPinAction, setPendingPinAction, logSecurityAction } = usePosStore();
  const { showToast } = useToast();

  const [pin, setPin] = useState<string>('');
  const [error, setError] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [lockout, setLockout] = useState<{ isLocked: boolean; remainingSeconds: number; attemptsLeft: number }>(() => checkPinLockout());

  useEffect(() => {
    if (activeModal === 'pin_prompt') {
      setPin('');
      setError(false);
      setErrorMessage('');
      setLockout(checkPinLockout());
    }
  }, [activeModal]);

  // Lockout countdown timer
  useEffect(() => {
    if (!lockout.isLocked) return;
    const interval = setInterval(() => {
      const current = checkPinLockout();
      setLockout(current);
      if (!current.isLocked) {
        clearInterval(interval);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [lockout.isLocked]);

  if (activeModal !== 'pin_prompt') return null;

  const handleKeyPress = (digit: string) => {
    if (lockout.isLocked) return;
    if (pin.length < 4) {
      setError(false);
      setErrorMessage('');
      setPin((prev) => prev + digit);
    }
  };

  const handleDelete = () => {
    if (lockout.isLocked) return;
    setError(false);
    setErrorMessage('');
    setPin((prev) => prev.slice(0, -1));
  };

  const handleClear = () => {
    if (lockout.isLocked) return;
    setError(false);
    setErrorMessage('');
    setPin('');
  };

  const handleVerify = () => {
    if (lockout.isLocked) {
      showToast(`Accès temporairement bloqué (${lockout.remainingSeconds}s restantes)`, 'error');
      return;
    }

    if (verifyManagerPin(pin)) {
      resetPinLockout();
      setLockout(checkPinLockout());
      showToast('Autorisation Responsable Accordée', 'success');
      logSecurityAction('Autorisation PIN Responsable', 'Action sensible débloquée avec succès', 'Responsable', true);
      
      const actionToRun = pendingPinAction;
      setPendingPinAction(null);
      closeModal();
      
      if (actionToRun) {
        actionToRun();
      }
    } else {
      const lockRes = recordPinFailure();
      setLockout(lockRes);
      setError(true);
      setPin('');
      if (lockRes.isLocked) {
        const mins = Math.ceil(lockRes.remainingSeconds / 60);
        setErrorMessage(`Trop de tentatives. Bloqué pendant ${mins} minute(s).`);
        showToast(`Sécurité : PIN bloqué pendant ${mins} min`, 'error');
        logSecurityAction('Verrouillage Sécurité PIN', `5 tentatives infructueuses - Bloqué 15 min`, 'Système', true);
      } else {
        setErrorMessage(`Code PIN incorrect. ${lockRes.attemptsLeft} tentative(s) restante(s).`);
        showToast(`Code PIN incorrect (${lockRes.attemptsLeft} restantes)`, 'error');
        logSecurityAction('Échec Vérification PIN', `Tentative infructueuse (${lockRes.attemptsLeft} restantes)`, 'Caissier', true);
      }
    }
  };

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-[100] flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
          <div className="flex items-center gap-2 text-amber-400">
            <ShieldCheck className="w-5 h-5" />
            <h2 className="text-sm font-bold text-pos-text">Autorisation Responsable</h2>
          </div>
          <button
            onClick={() => {
              setPendingPinAction(null);
              closeModal();
            }}
            className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 flex flex-col items-center space-y-5">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center ${lockout.isLocked ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'}`}>
            {lockout.isLocked ? <Lock className="w-6 h-6 animate-pulse" /> : <KeyRound className="w-6 h-6" />}
          </div>

          <div className="text-center">
            <p className="text-xs text-pos-muted">
              {lockout.isLocked
                ? `Sécurité anti-intrusion active (${lockout.remainingSeconds}s)`
                : 'Veuillez saisir votre code PIN Manager pour valider cette opération'}
            </p>
          </div>

          {/* PIN Digits Display */}
          <div className="flex gap-3 justify-center">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className={`w-11 h-12 rounded-xl border flex items-center justify-center text-xl font-bold font-mono transition-all ${
                  lockout.isLocked
                    ? 'border-red-500/40 bg-red-950/20 text-red-500'
                    : error
                    ? 'border-red-500 bg-red-500/10 text-red-400 animate-shake'
                    : pin.length > i
                    ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400'
                    : 'border-pos-border bg-pos-bg text-pos-muted'
                }`}
              >
                {lockout.isLocked ? '🔒' : pin.length > i ? '•' : ''}
              </div>
            ))}
          </div>

          {error && errorMessage && (
            <div className="flex items-center gap-1.5 text-red-400 text-xs font-semibold text-center">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Keypad */}
          <div className="grid grid-cols-3 gap-2.5 w-full pt-2">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
              <button
                key={digit}
                disabled={lockout.isLocked}
                onClick={() => handleKeyPress(digit)}
                className="py-3 rounded-xl bg-pos-card border border-pos-border hover:bg-pos-hover text-pos-text font-bold text-lg transition active:scale-95 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {digit}
              </button>
            ))}
            <button
              disabled={lockout.isLocked}
              onClick={handleClear}
              className="py-3 rounded-xl bg-pos-card border border-pos-border hover:bg-red-500/20 text-red-400 font-semibold text-xs transition active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Effacer
            </button>
            <button
              disabled={lockout.isLocked}
              onClick={() => handleKeyPress('0')}
              className="py-3 rounded-xl bg-pos-card border border-pos-border hover:bg-pos-hover text-pos-text font-bold text-lg transition active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              0
            </button>
            <button
              disabled={lockout.isLocked}
              onClick={handleDelete}
              className="py-3 rounded-xl bg-pos-card border border-pos-border hover:bg-pos-hover text-pos-muted font-semibold text-xs transition active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ⌫
            </button>
          </div>

          {/* Submit Button */}
          <button
            disabled={pin.length !== 4 || lockout.isLocked}
            onClick={handleVerify}
            className={`w-full py-3 rounded-xl font-bold text-xs uppercase tracking-wider transition shadow-lg ${
              pin.length === 4 && !lockout.isLocked
                ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-amber-500/20 cursor-pointer'
                : 'bg-pos-border text-pos-muted cursor-not-allowed opacity-50'
            }`}
          >
            Valider l'Autorisation
          </button>
        </div>
      </div>
    </div>
  );
};

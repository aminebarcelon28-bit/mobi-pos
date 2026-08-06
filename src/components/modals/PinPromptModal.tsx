import React, { useState, useEffect } from 'react';
import { ShieldCheck, X, KeyRound, AlertTriangle } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { useToast } from '../ui/Toast';

export const PinPromptModal: React.FC = () => {
  const { activeModal, closeModal, verifyManagerPin, pendingPinAction, setPendingPinAction, logSecurityAction } = usePosStore();
  const { showToast } = useToast();

  const [pin, setPin] = useState<string>('');
  const [error, setError] = useState<boolean>(false);

  useEffect(() => {
    if (activeModal === 'pin_prompt') {
      setPin('');
      setError(false);
    }
  }, [activeModal]);

  if (activeModal !== 'pin_prompt') return null;

  const handleKeyPress = (digit: string) => {
    if (pin.length < 4) {
      setError(false);
      setPin((prev) => prev + digit);
    }
  };

  const handleDelete = () => {
    setError(false);
    setPin((prev) => prev.slice(0, -1));
  };

  const handleClear = () => {
    setError(false);
    setPin('');
  };

  const handleVerify = () => {
    if (verifyManagerPin(pin)) {
      showToast('Autorisation Responsable Accordée', 'success');
      logSecurityAction('Autorisation PIN Responsable', 'Action sensible débloquée avec succès', 'Responsable', true);
      
      const actionToRun = pendingPinAction;
      setPendingPinAction(null);
      closeModal();
      
      if (actionToRun) {
        actionToRun();
      }
    } else {
      setError(true);
      showToast('Code PIN incorrect (Défaut: 1234)', 'error');
      logSecurityAction('Échec Vérification PIN', `Code saisi invalide: ${pin}`, 'Caissier', true);
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
          <div className="w-12 h-12 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center">
            <KeyRound className="w-6 h-6" />
          </div>

          <div className="text-center">
            <p className="text-xs text-pos-muted">Veuillez saisir le code PIN Gérant (Défaut: <strong className="text-pos-text font-mono">1234</strong>)</p>
          </div>

          {/* PIN Digits Display */}
          <div className="flex gap-3 justify-center">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className={`w-11 h-12 rounded-xl border flex items-center justify-center text-xl font-bold font-mono transition-all ${
                  error
                    ? 'border-red-500 bg-red-500/10 text-red-400 animate-shake'
                    : pin.length > i
                    ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400'
                    : 'border-pos-border bg-pos-bg text-pos-muted'
                }`}
              >
                {pin.length > i ? '•' : ''}
              </div>
            ))}
          </div>

          {error && (
            <div className="flex items-center gap-1.5 text-red-400 text-xs font-semibold">
              <AlertTriangle className="w-4 h-4" />
              <span>Code PIN incorrect. Réessayez avec 1234.</span>
            </div>
          )}

          {/* Keypad */}
          <div className="grid grid-cols-3 gap-2.5 w-full pt-2">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
              <button
                key={digit}
                onClick={() => handleKeyPress(digit)}
                className="py-3 rounded-xl bg-pos-card border border-pos-border hover:bg-pos-hover text-pos-text font-bold text-lg transition active:scale-95 shadow-sm"
              >
                {digit}
              </button>
            ))}
            <button
              onClick={handleClear}
              className="py-3 rounded-xl bg-pos-card border border-pos-border hover:bg-red-500/20 text-red-400 font-semibold text-xs transition active:scale-95"
            >
              Effacer
            </button>
            <button
              onClick={() => handleKeyPress('0')}
              className="py-3 rounded-xl bg-pos-card border border-pos-border hover:bg-pos-hover text-pos-text font-bold text-lg transition active:scale-95"
            >
              0
            </button>
            <button
              onClick={handleDelete}
              className="py-3 rounded-xl bg-pos-card border border-pos-border hover:bg-pos-hover text-pos-muted font-semibold text-xs transition active:scale-95"
            >
              ⌫
            </button>
          </div>

          {/* Submit Button */}
          <button
            disabled={pin.length !== 4}
            onClick={handleVerify}
            className={`w-full py-3 rounded-xl font-bold text-xs uppercase tracking-wider transition shadow-lg ${
              pin.length === 4
                ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-amber-500/20'
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

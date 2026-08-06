import React, { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, Delete } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';

interface PinDialogProps {
  isOpen: boolean;
  title: string;
  description?: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export const PinDialog: React.FC<PinDialogProps> = ({
  isOpen,
  title,
  description,
  onSuccess,
  onCancel,
}) => {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  
  // Access store actions. Fallback functions are provided for development safety.
  const verifyManagerPin = usePosStore((state) => state.verifyManagerPin);
  const logSecurityAction = usePosStore((state) => state.logSecurityAction);

  const resetState = useCallback(() => {
    setPin('');
    setError(false);
  }, []);

  useEffect(() => {
    if (isOpen) {
      resetState();
    }
  }, [isOpen, resetState]);

  const handleVerify = useCallback((currentPin: string) => {
    if (currentPin.length !== 4) return;
    
    // Default fallback '1234' just in case store function isn't fully implemented
    const isSuccess = verifyManagerPin ? verifyManagerPin(currentPin) : currentPin === '1234';

    if (isSuccess) {
      if (logSecurityAction) {
        logSecurityAction('Vérification PIN Réussie', 'Validation du code PIN manager');
      }
      onSuccess();
    } else {
      if (logSecurityAction) {
        logSecurityAction('Tentative PIN Échouée', 'Code PIN incorrect saisi');
      }
      setError(true);
      setTimeout(() => {
        setPin('');
        setError(false);
      }, 500); // 500ms allows the shake animation to finish
    }
  }, [verifyManagerPin, logSecurityAction, onSuccess]);

  const handleNumber = useCallback((num: string) => {
    if (pin.length < 4 && !error) {
      const newPin = pin + num;
      setPin(newPin);
      if (newPin.length === 4) {
        handleVerify(newPin);
      }
    }
  }, [pin, error, handleVerify]);

  const handleDelete = useCallback(() => {
    if (pin.length > 0 && !error) {
      setPin(pin.slice(0, -1));
    }
  }, [pin, error]);

  const handleClear = useCallback(() => {
    if (!error) {
      setPin('');
    }
  }, [error]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      } else if (e.key === 'Backspace') {
        handleDelete();
      } else if (e.key === 'Enter') {
        if (pin.length === 4) {
          handleVerify(pin);
        }
      } else if (/^[0-9]$/.test(e.key)) {
        handleNumber(e.key);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, pin, handleNumber, handleDelete, handleVerify, onCancel]);

  if (!isOpen) return null;

  const renderDots = () => {
    const dots = [];
    for (let i = 0; i < 4; i++) {
      dots.push(
        <div
          key={i}
          className={`w-4 h-4 rounded-full border-2 mx-1 flex items-center justify-center transition-colors duration-200 ${
            i < pin.length
              ? 'bg-emerald-500 border-emerald-500'
              : 'border-pos-border'
          }`}
        />
      );
    }
    return dots;
  };

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
          className={`w-full max-w-sm bg-pos-panel border border-pos-border rounded-2xl shadow-2xl p-6 ${error ? 'animate-shake' : ''}`}
        >
          <div className="flex flex-col items-center mb-6 text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center mb-4 text-emerald-500">
              <ShieldCheck size={28} />
            </div>
            <h2 className="text-xl font-bold text-pos-text mb-2">{title}</h2>
            <p className="text-sm text-pos-muted">
              {description || 'Entrez le PIN à 4 chiffres'}
            </p>
          </div>

          <div className="flex justify-center mb-8">
            <div className="flex items-center">
              {renderDots()}
            </div>
          </div>

          {error && (
            <div className="text-center text-red-500 text-sm mb-4 font-medium">
              PIN incorrect. Veuillez réessayer.
            </div>
          )}

          <div className="grid grid-cols-3 gap-3 mb-6">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
              <button
                key={num}
                type="button"
                onClick={() => handleNumber(num.toString())}
                className="h-14 bg-pos-card border border-pos-border rounded-xl text-xl font-bold text-pos-text hover:bg-pos-hover transition-colors duration-200"
              >
                {num}
              </button>
            ))}
            <button
              type="button"
              onClick={handleClear}
              className="h-14 bg-pos-card border border-pos-border rounded-xl text-lg font-bold text-pos-text hover:bg-pos-hover transition-colors duration-200 flex items-center justify-center"
            >
              C
            </button>
            <button
              type="button"
              onClick={() => handleNumber('0')}
              className="h-14 bg-pos-card border border-pos-border rounded-xl text-xl font-bold text-pos-text hover:bg-pos-hover transition-colors duration-200"
            >
              0
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="h-14 bg-pos-card border border-pos-border rounded-xl text-lg font-bold text-pos-text hover:bg-pos-hover transition-colors duration-200 flex items-center justify-center"
            >
              <Delete size={24} />
            </button>
          </div>

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

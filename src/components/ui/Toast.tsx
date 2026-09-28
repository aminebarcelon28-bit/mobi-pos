import React, { createContext, useContext, useState, useCallback, type ReactNode, useEffect, useRef } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastMessage {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

interface ToastContextType {
  showToast: (message: string, type: ToastType, duration?: number) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};

const getIcon = (type: ToastType) => {
  switch (type) {
    case 'success': return <CheckCircle className="w-5 h-5 text-emerald-500" aria-hidden="true" />;
    case 'error': return <XCircle className="w-5 h-5 text-red-500" aria-hidden="true" />;
    case 'warning': return <AlertTriangle className="w-5 h-5 text-amber-500" aria-hidden="true" />;
    case 'info': return <Info className="w-5 h-5 text-blue-500" aria-hidden="true" />;
  }
};

const getBorderClass = (type: ToastType) => {
  switch (type) {
    case 'success': return 'border-l-emerald-500';
    case 'error': return 'border-l-red-500';
    case 'warning': return 'border-l-amber-500';
    case 'info': return 'border-l-blue-500';
  }
};

interface ToastProviderProps {
  children: ReactNode;
}

export const ToastProvider: React.FC<ToastProviderProps> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback((message: string, type: ToastType, duration = 3000) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => {
      const newToasts = [...prev, { id, message, type, duration }];
      if (newToasts.length > 5) {
        return newToasts.slice(newToasts.length - 5);
      }
      return newToasts;
    });
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Bridge for store-layer failure signals: slices/adapters dispatch
  // window CustomEvents ('mobi:toast', 'mobi:storage-quota') because they
  // cannot call the useToast hook. Subscribed once with cleanup.
  useEffect(() => {
    const validTypes: ToastType[] = ['success', 'error', 'warning', 'info'];
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent).detail as { message?: unknown; type?: unknown } | undefined;
      const message = typeof detail?.message === 'string' ? detail.message : null;
      if (!message) return;
      const type: ToastType =
        typeof detail?.type === 'string' && (validTypes as string[]).includes(detail.type)
          ? (detail.type as ToastType)
          : 'info';
      showToast(message, type, 5000);
    };
    const onQuota = (e: Event) => {
      const detail = (e as CustomEvent).detail as { area?: unknown; isQuota?: unknown } | undefined;
      const area = typeof detail?.area === 'string' ? detail.area : 'stockage local';
      showToast(
        detail?.isQuota
          ? `Stockage saturé (${area}) : la sauvegarde locale est incomplète. Libérez de l'espace puis réessayez.`
          : `Écriture impossible (${area}). Vérifiez le stockage puis réessayez.`,
        'error',
        6000
      );
    };
    window.addEventListener('mobi:toast', onToast);
    window.addEventListener('mobi:storage-quota', onQuota);
    return () => {
      window.removeEventListener('mobi:toast', onToast);
      window.removeEventListener('mobi:storage-quota', onQuota);
    };
  }, [showToast]);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed right-4 z-50 flex flex-col gap-2 pointer-events-none top-[max(1rem,var(--safe-top))]">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
};

interface ToastItemProps {
  toast: ToastMessage;
  onRemove: (id: string) => void;
}

const ToastItem: React.FC<ToastItemProps> = ({ toast, onRemove }) => {
  const [isShowing, setIsShowing] = useState(false);
  // Track the inner exit timer so unmount clears it (no setState/post-remove
  // after unmount, no orphaned onRemove calls).
  const exitTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // Trigger animation in
    const raf = requestAnimationFrame(() => {
      setIsShowing(true);
    });

    const timer = setTimeout(() => {
      setIsShowing(false);
      // Wait for exit animation
      exitTimerRef.current = window.setTimeout(() => onRemove(toast.id), 300);
    }, toast.duration || 3000);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      if (exitTimerRef.current !== null) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, [toast, onRemove]);

  const handleClose = () => {
    setIsShowing(false);
    if (exitTimerRef.current !== null) {
      clearTimeout(exitTimerRef.current);
    }
    exitTimerRef.current = window.setTimeout(() => onRemove(toast.id), 300);
  };

  // Clear any pending exit timer if this item unmounts via the manual close path.
  useEffect(() => {
    return () => {
      if (exitTimerRef.current !== null) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, []);

  // Screen-reader politeness per severity (timing/behavior unchanged):
  // errors + warnings interrupt (assertive), success + info do not (polite).
  const isAssertive = toast.type === 'error' || toast.type === 'warning';

  return (
    <div
      role={isAssertive ? 'alert' : 'status'}
      aria-live={isAssertive ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={`bg-pos-panel border border-pos-border border-l-4 ${getBorderClass(toast.type)} 
        rounded-lg shadow-lg p-4 flex items-start gap-3 pointer-events-auto min-w-[300px] max-w-md
        transition-all duration-300 transform origin-top-right
        ${isShowing ? 'opacity-100 translate-x-0 scale-100' : 'opacity-0 translate-x-8 scale-95'}
      `}
    >
      <div className="shrink-0 mt-0.5" aria-hidden="true">
        {getIcon(toast.type)}
      </div>
      <div className="flex-1 text-sm text-pos-text">
        {toast.message}
      </div>
      <button 
        onClick={handleClose}
        type="button"
        aria-label="Fermer la notification"
        className="shrink-0 text-pos-muted hover:text-pos-text transition-colors"
      >
        <X className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
};

import React, { createContext, useContext, useState, useCallback, type ReactNode, useEffect } from 'react';
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
    case 'success': return <CheckCircle className="w-5 h-5 text-emerald-500" />;
    case 'error': return <XCircle className="w-5 h-5 text-red-500" />;
    case 'warning': return <AlertTriangle className="w-5 h-5 text-amber-500" />;
    case 'info': return <Info className="w-5 h-5 text-blue-500" />;
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

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
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

  useEffect(() => {
    // Trigger animation in
    const raf = requestAnimationFrame(() => {
      setIsShowing(true);
    });

    const timer = setTimeout(() => {
      setIsShowing(false);
      // Wait for exit animation
      setTimeout(() => onRemove(toast.id), 300);
    }, toast.duration || 3000);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [toast, onRemove]);

  const handleClose = () => {
    setIsShowing(false);
    setTimeout(() => onRemove(toast.id), 300);
  };

  return (
    <div
      className={`bg-pos-panel border border-pos-border border-l-4 ${getBorderClass(toast.type)} 
        rounded-lg shadow-lg p-4 flex items-start gap-3 pointer-events-auto min-w-[300px] max-w-md
        transition-all duration-300 transform origin-top-right
        ${isShowing ? 'opacity-100 translate-x-0 scale-100' : 'opacity-0 translate-x-8 scale-95'}
      `}
    >
      <div className="shrink-0 mt-0.5">
        {getIcon(toast.type)}
      </div>
      <div className="flex-1 text-sm text-pos-text">
        {toast.message}
      </div>
      <button 
        onClick={handleClose}
        className="shrink-0 text-pos-muted hover:text-pos-text transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};

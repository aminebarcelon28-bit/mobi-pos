import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error in POS Component:', error, errorInfo);
    this.setState({ error, errorInfo });
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 bg-pos-panel border border-pos-border rounded-2xl max-w-md mx-auto my-8 text-center space-y-4 shadow-2xl animate-in fade-in select-none">
          <div className="w-14 h-14 rounded-2xl bg-rose-500/20 text-rose-400 flex items-center justify-center border border-rose-500/30 mx-auto shadow-lg">
            <AlertTriangle className="w-7 h-7 stroke-[2.5]" />
          </div>

          <div>
            <h3 className="text-base font-extrabold text-pos-text">
              {this.props.fallbackTitle || 'Un problème temporaire est survenu'}
            </h3>
            <p className="text-xs text-pos-muted mt-1">
              L'application a intercepté une erreur d'affichage. Vos données de caisse sont conservées en sécurité.
            </p>
          </div>

          {this.state.error && (
            <div className="bg-pos-bg p-3 rounded-xl border border-pos-border text-left font-mono text-[10px] text-rose-300 max-h-24 overflow-y-auto">
              {this.state.error.toString()}
            </div>
          )}

          <div className="flex justify-center gap-2 pt-2">
            <button
              onClick={this.handleReset}
              className="px-4 py-2 rounded-xl bg-pos-card border border-pos-border text-pos-text font-bold text-xs hover:border-emerald-400 flex items-center gap-1.5 transition cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Réessayer
            </button>
            <button
              onClick={this.handleReload}
              className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition shadow-lg shadow-emerald-500/20 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Recharger l'App
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

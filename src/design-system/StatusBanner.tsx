import React, { type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  ShieldAlert,
  X,
} from 'lucide-react';
import { IconButton } from './IconButton';

export type StatusBannerTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

export interface StatusBannerProps {
  /**
   * Semantic tone (`AGENTS.md` §1-2 & `R-POS-C`):
   * - `UNAUTHENTICATED` / `CLOCK_RESET_REQUIRED` / `SUPERVISOR_AUTH_EXPIRED` -> `'warn'` or `'danger'`
   * - `TAMPER_SUSPECTED` / `REVOKED` -> `'danger'`
   * - Never render unverified or degraded trust states as `'ok'`.
   */
  tone: StatusBannerTone;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /** Optional primary action button (`min-h-[48px]`). */
  action?: ReactNode;
  /** Optional dismiss handler (renders a 48x48px `IconButton` with `dismissLabel`). */
  onDismiss?: () => void;
  dismissLabel?: string;
  role?: 'status' | 'alert';
  className?: string;
}

const TONE_CLASSES: Record<StatusBannerTone, string> = {
  ok: 'pos-status-ok',
  warn: 'pos-status-warn',
  danger: 'pos-status-danger',
  info: 'pos-status-info',
  neutral: 'pos-status-neutral',
};

function getDefaultIcon(tone: StatusBannerTone): ReactNode {
  switch (tone) {
    case 'ok':
      return <CheckCircle2 className="w-5 h-5" />;
    case 'warn':
      return <AlertTriangle className="w-5 h-5" />;
    case 'danger':
      return <ShieldAlert className="w-5 h-5" />;
    case 'info':
    case 'neutral':
      return <Info className="w-5 h-5" />;
  }
}

export const StatusBanner: React.FC<StatusBannerProps> = ({
  tone,
  title,
  description,
  icon,
  action,
  onDismiss,
  dismissLabel = "Fermer l'alerte",
  role,
  className = '',
}) => {
  const resolvedRole =
    role ?? (tone === 'danger' || tone === 'warn' ? 'alert' : 'status');

  return (
    <div
      role={resolvedRole}
      className={`w-full rounded-pos-card border p-3.5 flex items-start justify-between gap-3 text-start ${TONE_CLASSES[tone]} ${className}`}
    >
      <div className="flex items-start gap-2.5 min-w-0 flex-1">
        <span aria-hidden="true" className="shrink-0 mt-0.5 inline-flex">
          {icon ?? getDefaultIcon(tone)}
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="text-xs sm:text-sm font-bold leading-snug">
            {title}
          </div>
          {description ? (
            <div className="text-xs opacity-90 leading-relaxed">
              {description}
            </div>
          ) : null}
          {action ? <div className="pt-2">{action}</div> : null}
        </div>
      </div>

      {onDismiss ? (
        <IconButton
          ariaLabel={dismissLabel}
          onClick={onDismiss}
          icon={<X className="w-4 h-4" />}
          className="shrink-0 -my-1 -me-1"
        />
      ) : null}
    </div>
  );
};

export default StatusBanner;

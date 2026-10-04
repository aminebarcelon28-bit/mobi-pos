import React from 'react';
import { AlertTriangle, Clock, History } from 'lucide-react';
import { useSharedClock } from '../../hooks/useSharedClock';
import { describeAuditTime } from '../../utils/auditIntel';

interface AuditRelativeTimeProps {
  /** Raw audit timestamp exactly as persisted (ISO-8601 or legacy `HH:MM`). */
  timestamp: string;
  /** When false the label is frozen at mount time (frozen exports, snapshots). */
  live?: boolean;
  className?: string;
  showIcon?: boolean;
}

/**
 * Renders « il y a 2 min » and keeps it honest while the panel is open.
 *
 * All visible timestamps share one interval via `useSharedClock`, so a table
 * of forty rows costs one timer rather than forty, and the tick is suspended
 * while the document is hidden.
 *
 * Forensic honesty is delegated to `describeAuditTime`: dateless legacy rows
 * render « date inconnue » (never "today"), and future-skewed ISO rows render
 * « Horloge locale décalée » instead of a countdown. The exact forensic value
 * is exposed two ways: a native `title` tooltip for pointer users, and an
 * always-present `sr-only` node for assistive tech, because `title` is not
 * reliably announced.
 */
export const AuditRelativeTime: React.FC<AuditRelativeTimeProps> = ({
  timestamp,
  live = true,
  className = '',
  showIcon = true,
}) => {
  const now = useSharedClock(live);
  const desc = describeAuditTime(timestamp, new Date(now));

  const Icon = desc.kind === 'legacy-wall' ? History : desc.clockSkewed ? AlertTriangle : Clock;
  const iconClass =
    desc.kind === 'legacy-wall' || desc.clockSkewed
      ? 'w-3 h-3 text-pos-warn shrink-0'
      : 'w-3 h-3 text-pos-muted shrink-0';

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`} title={desc.title}>
      {showIcon && <Icon className={iconClass} aria-hidden="true" />}
      <span className="tabular-nums whitespace-nowrap">{desc.relative}</span>
      <span className="sr-only">— {desc.title}</span>
    </span>
  );
};

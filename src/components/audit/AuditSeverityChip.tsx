import React from 'react';
import { ShieldAlert, Siren, Info, ScrollText, type LucideIcon } from 'lucide-react';
import { SEVERITY_META, type AuditSeverity } from '../../utils/auditIntel';

const SEVERITY_ICON: Record<AuditSeverity, LucideIcon> = {
  critical: Siren,
  warning: ShieldAlert,
  info: Info,
  audit: ScrollText,
};

interface AuditSeverityChipProps {
  severity: AuditSeverity;
  /** Category label shown next to the severity code (desktop table). */
  category?: string;
  className?: string;
  size?: 'sm' | 'xs';
}

/**
 * Severity is a first-class, visually-ranked dimension rather than an implicit
 * consequence of the text colour.
 *
 * The pill is a `pos-micro-badge` so severity, connection state and PIN proof
 * all render at the same optical weight, and the colour comes from the
 * semantic `pos-*` palette that flips with the light/dark theme instead of a
 * hard-coded Tailwind step.
 *
 * The short code is decorative next to the category label; assistive tech reads
 * the full severity once from the sr-only node, because `aria-hidden` on the
 * code avoids "CRIT … Sévérité Critique".
 */
export const AuditSeverityChip: React.FC<AuditSeverityChipProps> = ({
  severity,
  category,
  className = '',
  size = 'sm',
}) => {
  const meta = SEVERITY_META[severity];
  const Icon = SEVERITY_ICON[severity];
  const pad = size === 'xs' ? 'px-1 py-0.5 text-[9px]' : 'px-1.5 py-1 text-[10px]';
  const iconSize = size === 'xs' ? 'w-2.5 h-2.5' : 'w-3 h-3';

  return (
    <span
      className={`pos-micro-badge ${meta.badge} ${pad} ${className}`}
      title={`Sévérité : ${meta.label}`}
    >
      <Icon className={iconSize} aria-hidden="true" />
      <span aria-hidden="true">{meta.short}</span>
      {category && (
        <span className="font-semibold normal-case tracking-normal opacity-80 border-l border-current/25 pl-1">
          {category}
        </span>
      )}
      <span className="sr-only">Sévérité {meta.label}</span>
    </span>
  );
};

/** Compact dot + label used in the mobile card list. */
export const AuditSeverityDot: React.FC<{ severity: AuditSeverity }> = ({ severity }) => {
  const meta = SEVERITY_META[severity];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold ${meta.text}`}>
      <span className={`pos-status-dot ${meta.dot}`} aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  );
};

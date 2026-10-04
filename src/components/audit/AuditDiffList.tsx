import React from 'react';
import { ArrowRight, Minus, Plus, ScanEye } from 'lucide-react';
import type { AuditChange, AuditItem } from '../../utils/auditIntel';

const KIND_STYLE: Record<AuditChange['kind'], { label: string; cls: string; Icon: typeof Plus }> = {
  added: { label: 'Ajouté', cls: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10', Icon: Plus },
  removed: { label: 'Supprimé', cls: 'text-rose-400 border-rose-500/40 bg-rose-500/10', Icon: Minus },
  changed: { label: 'Modifié', cls: 'text-amber-400 border-amber-500/40 bg-amber-500/10', Icon: ArrowRight },
};

interface AuditDiffListProps {
  changes: AuditChange[];
  removedItems?: AuditItem[];
  className?: string;
}

/**
 * Before/after state diff.
 *
 * The audit `details` column carries deltas inline (`creditLimit: 0 → 5000`),
 * so this renders them as a labelled two-column comparison rather than prose.
 * A one-line textual diff is unreadable in a review context; the whole point
 * of the drawer is that an auditor can see *which field* moved and by how much
 * without opening the raw payload.
 */
export const AuditDiffList: React.FC<AuditDiffListProps> = ({ changes, removedItems = [], className = '' }) => {
  if (changes.length === 0 && removedItems.length === 0) return null;

  return (
    <div className={`space-y-2.5 ${className}`}>
      {changes.length > 0 && (
        <div className="space-y-1.5">
          {changes.map((change, idx) => {
            const style = KIND_STYLE[change.kind];
            const { Icon } = style;
            return (
              <div
                key={`${change.field}-${idx}`}
                className="bg-pos-bg border border-pos-border rounded-lg overflow-hidden"
              >
                <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-pos-border/70">
                  <span className="font-mono text-[10px] font-bold text-pos-text flex-1 truncate">
                    {change.field}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase ${style.cls}`}
                  >
                    <Icon className="w-2.5 h-2.5" aria-hidden="true" />
                    {style.label}
                  </span>
                </div>
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-2.5 py-2 text-[11px]">
                  <span className="font-mono text-rose-300/90 line-through decoration-rose-500/50 break-all min-w-0">
                    {change.before || '∅'}
                  </span>
                  <ArrowRight className="w-3 h-3 text-pos-muted shrink-0" aria-hidden="true" />
                  <span className="font-mono text-emerald-300 break-all min-w-0">
                    {change.after || '∅'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {removedItems.length > 0 && (
        <div className="bg-rose-500/5 border border-rose-500/30 rounded-lg">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-rose-500/20">
            <ScanEye className="w-3.5 h-3.5 text-rose-400" aria-hidden="true" />
            <span className="text-[10px] font-bold text-rose-300 uppercase tracking-wide">
              Éléments retirés ({removedItems.length})
            </span>
          </div>
          <ul className="divide-y divide-rose-500/10">
            {removedItems.map((item, idx) => (
              <li key={`${item.label}-${idx}`} className="px-2.5 py-1.5 flex items-center gap-2 text-[11px]">
                <span className="text-pos-text flex-1 min-w-0 break-words">{item.label}</span>
                {item.quantity !== null && (
                  <span className="font-mono text-[10px] text-pos-muted shrink-0">
                    ×{item.quantity} u.
                  </span>
                )}
                {item.total !== null && (
                  <span className="font-mono text-[10px] text-rose-300 shrink-0 tabular-nums">
                    {item.total} DA
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

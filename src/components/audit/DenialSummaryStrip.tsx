import React from 'react';
import { ShieldAlert } from 'lucide-react';
import type { DenialSummary } from '../../utils/auditIntel';

interface DenialSummaryStripProps {
  summary: DenialSummary;
  /** Filter the journal to a gate's burst rows (sets the search box). */
  onFilterGate: (gate: string) => void;
}

/**
 * Phase F denial dashboard, compact edition. Burst rows are cumulative
 * snapshots, so the numbers shown are latest-per-(gate,user,window) —
 * never raw row sums (see summarizeDenialBursts). Renders nothing when the
 * current window holds no burst rows. Clicking a gate chip filters the
 * journal to that gate's rows for drill-down.
 */
export const DenialSummaryStrip: React.FC<DenialSummaryStripProps> = ({
  summary,
  onFilterGate,
}) => {
  if (summary.totalDenials === 0 && summary.totalLockouts === 0) return null;
  return (
    <div
      role="status"
      aria-label={`Tentatives refusées : ${summary.totalDenials}, verrouillages : ${summary.totalLockouts}`}
      className="flex flex-wrap items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] px-2.5 py-2"
    >
      <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-pos-text shrink-0">
        <ShieldAlert className="w-3.5 h-3.5 text-pos-danger" aria-hidden="true" />
        Tentatives refusées&nbsp;·&nbsp;
        <span className="font-mono tabular-nums">{summary.totalDenials}</span>
        {summary.totalLockouts > 0 && (
          <span className="text-pos-danger">
            ·&nbsp;<span className="font-mono tabular-nums">{summary.totalLockouts}</span> verrouillage{summary.totalLockouts > 1 ? 's' : ''}
          </span>
        )}
        <span className="font-normal text-pos-muted">
          · {summary.users} profil{summary.users > 1 ? 's' : ''}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {summary.gates.map((g) => (
          <button
            key={g.gate}
            type="button"
            onClick={() => onFilterGate(g.gate)}
            title={`Filtrer le journal : ${g.gate}`}
            className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-pos-bg px-2 py-1 text-[10px] font-mono text-pos-text hover:border-rose-500/60 hover:bg-rose-500/10 transition cursor-pointer"
          >
            {g.gate}
            <span className="tabular-nums text-pos-muted">· {g.denials}</span>
            {g.lockouts > 0 && <span className="tabular-nums text-pos-danger">· {g.lockouts} verr.</span>}
          </button>
        ))}
      </span>
    </div>
  );
};

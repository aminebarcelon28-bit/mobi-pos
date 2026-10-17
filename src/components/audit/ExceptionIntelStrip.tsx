import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw, ShieldAlert } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import {
  computeExceptionIntel,
  EXCEPTION_CATEGORIES,
  EXCEPTION_CATEGORY_LABELS,
  type ExceptionIntelResult,
} from '../../utils/cashierExceptionRates';

/**
 * UPGRADE-09 — cashier exception intelligence (EBR-lite), compact edition.
 *
 * Compute-on-read: expanding the section runs three bounded reads (audit
 * window, shift-linked transaction counts, closed sessions) and renders the
 * PURE engine's output. Nothing here is persisted; no rate is raw k/n — the
 * table ranks by GATED anomaly confidence and displays shrunk rates, so a
 * small denominator can never top the list (owner invariant; pinned by
 * `scripts/test_exception_intel.mts`).
 */

const WINDOW_CHOICES: ReadonlyArray<{ days: number; label: string }> = [
  { days: 7, label: '7 j' },
  { days: 30, label: '30 j' },
  { days: 90, label: '90 j' },
];

const fmtAmount = (n: number) => `${Math.round(n).toLocaleString('fr-FR')} DA`;

export const ExceptionIntelStrip: React.FC = () => {
  const cashierUsers = usePosStore((s) => s.cashierUsers);
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(30);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExceptionIntelResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const until = new Date();
      const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
      const { loadExceptionIntelSnapshot } = await import('../../db/exceptionIntelAdapter');
      const snapshot = await loadExceptionIntelSnapshot({
        sinceIso: since.toISOString(),
        untilIso: until.toISOString(),
      });
      setResult(
        computeExceptionIntel({
          sinceIso: since.toISOString(),
          untilIso: until.toISOString(),
          auditRows: snapshot.auditRows,
          shiftTxnCounts: snapshot.shiftTxnCounts,
          sessions: snapshot.sessions,
          roster: (cashierUsers || []).map((u) => ({ id: u.id, name: u.name })),
        })
      );
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [days, cashierUsers]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, reloadKey, load]);

  const flagged = result ? result.actors.filter((a) => a.flagged) : [];
  const varianceTop = result ? result.variance.slice(0, 8) : [];

  return (
    <section className="rounded-xl border border-pos-border bg-pos-panel/40 mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-pos-text hover:bg-pos-panel/60 rounded-xl"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-pos-muted shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-pos-muted shrink-0" aria-hidden="true" />
        )}
        <ShieldAlert className="w-3.5 h-3.5 text-pos-warn shrink-0" aria-hidden="true" />
        <span>Intelligence Exceptions Caissiers</span>
        <span className="font-normal text-pos-muted">— taux lissés, support minimum (EBR-lite)</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {WINDOW_CHOICES.map((c) => (
              <button
                key={c.days}
                type="button"
                onClick={() => setDays(c.days)}
                aria-pressed={days === c.days}
                className={`px-2 py-1 rounded-lg border text-[11px] font-semibold ${
                  days === c.days
                    ? 'border-pos-warn text-pos-warn'
                    : 'border-pos-border text-pos-muted hover:text-pos-text'
                }`}
              >
                {c.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg border border-pos-border text-[11px] text-pos-muted hover:text-pos-text"
            >
              <RefreshCw className="w-3 h-3" aria-hidden="true" />
              Actualiser
            </button>
            {loading && (
              <span role="status" className="text-[11px] text-pos-muted">
                Analyse de la fenêtre…
              </span>
            )}
            {error && (
              <span role="status" className="text-[11px] text-pos-danger">
                Chargement impossible : {error}
              </span>
            )}
          </div>

          {result && (
            <>
              <p className="text-[11px] text-pos-muted">
                Fenêtre analysée : {result.pool.txns.toLocaleString('fr-FR')} transaction(s) liée(s)
                à des postes, {result.pool.shifts} poste(s) clôturé(s),{' '}
                {result.pool.totalExceptions} exception(s) classée(s)
                {result.unattributedTxns > 0
                  ? ` — dont ${result.unattributedTxns} transaction(s) non attribuable(s) (poste absent de la fenêtre)`
                  : ''}
                .
              </p>

              {flagged.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-pos-warn">
                  <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>
                    À examiner :{' '}
                    {flagged.map((a) => `${a.actorName} (${a.totalExceptions} exception(s))`).join(', ')}
                  </span>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-[11px]">
                  <caption className="sr-only">
                    Taux d&apos;exceptions par caissier — classement par confiance d&apos;anomalie
                    (borne inférieure de Wilson), support minimum 20 transactions
                  </caption>
                  <thead>
                    <tr className="text-pos-muted text-left">
                      <th scope="col" className="py-1 pr-3 font-semibold">Caissier</th>
                      <th scope="col" className="py-1 pr-3 font-semibold">Txns</th>
                      <th scope="col" className="py-1 pr-3 font-semibold">Postes</th>
                      {EXCEPTION_CATEGORIES.map((c) => (
                        <th key={c} scope="col" className="py-1 pr-3 font-semibold">
                          {EXCEPTION_CATEGORY_LABELS[c]}
                        </th>
                      ))}
                      <th scope="col" className="py-1 pr-3 font-semibold">/100 txns</th>
                      <th scope="col" className="py-1 pr-3 font-semibold">Confiance</th>
                      <th scope="col" className="py-1 font-semibold">Statut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.actors.map((a) => (
                      <tr key={a.actorKey} className="border-t border-pos-border/60 text-pos-text">
                        <td className="py-1 pr-3 font-semibold">{a.actorName}</td>
                        <td className="py-1 pr-3">{a.txns}</td>
                        <td className="py-1 pr-3">{a.shifts}</td>
                        {EXCEPTION_CATEGORIES.map((c) => (
                          <td key={c} className="py-1 pr-3">{a.counts[c]}</td>
                        ))}
                        <td className="py-1 pr-3">
                          {a.txns > 0 ? a.shrunkPer100.toFixed(2) : '—'}
                        </td>
                        <td className="py-1 pr-3">
                          {a.sufficientSupport ? `${(a.confidence * 100).toFixed(1)} %` : '—'}
                        </td>
                        <td className="py-1">
                          {a.flagged ? (
                            <span className="text-pos-warn font-semibold">À examiner</span>
                          ) : a.sufficientSupport ? (
                            <span className="text-pos-muted">Normal</span>
                          ) : (
                            <span className="text-pos-muted">Support insuffisant</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-pos-border/60 p-2">
                  <h4 className="text-[11px] font-semibold text-pos-text mb-1">
                    Concentration des approbations (Manager → Caissier)
                  </h4>
                  {result.approvals.total === 0 ? (
                    <p className="text-[11px] text-pos-muted">Aucune approbation sur la fenêtre.</p>
                  ) : (
                    <>
                      <ul className="text-[11px] text-pos-muted space-y-0.5">
                        {result.approvals.pairs.slice(0, 6).map((p) => (
                          <li key={`${p.approverKey}:${p.cashierKey}`}>
                            Manager → {p.cashierName} : {p.count} approbation(s)
                          </li>
                        ))}
                      </ul>
                      <p className="text-[11px] text-pos-muted mt-1">
                        HHI {result.approvals.hhi.toFixed(2)} — part du caissier principal{' '}
                        {(result.approvals.topShare * 100).toFixed(0)} %
                      </p>
                    </>
                  )}
                </div>

                <div className="rounded-lg border border-pos-border/60 p-2">
                  <h4 className="text-[11px] font-semibold text-pos-text mb-1">
                    Écarts de clôture (Z) vs exceptions du poste
                  </h4>
                  {varianceTop.length === 0 ? (
                    <p className="text-[11px] text-pos-muted">Aucun poste clôturé sur la fenêtre.</p>
                  ) : (
                    <ul className="text-[11px] text-pos-muted space-y-0.5">
                      {varianceTop.map((v) => (
                        <li key={v.sessionId}>
                          {v.actorName} — écart {v.variance >= 0 ? '+' : ''}
                          {fmtAmount(v.variance)} — {v.exceptionCount} exception(s)
                          {v.closedAt ? ` — clôturé ${v.closedAt.slice(0, 16).replace('T', ' ')}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
};

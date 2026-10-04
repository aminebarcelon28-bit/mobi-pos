import React from 'react';
import { ShieldQuestion } from 'lucide-react';
import {
  buildVerificationView,
  rowChipLabel,
  rowChipTone,
  TONE_BADGE,
  TONE_ICON,
  type AuditVerificationView,
} from './auditVerificationView';
import type {
  AuditVerificationReport,
  AuditVerificationVerdict,
} from '../../utils/auditIntegrity';

interface AuditVerificationBannerProps {
  verdict: AuditVerificationVerdict;
  report: AuditVerificationReport;
  /** Rows an auditor can expand for a side-by-side digest comparison. */
  onInspect?: (rowId: string) => void;
}

/**
 * Verification state of an imported audit document.
 *
 * The distinction this component exists to make: a document that does not hash
 * the way *this* build hashes is not automatically a tampered document. A
 * manifest exported by an older build uses an older canonical serializer, so
 * its bytes are intact while its format is legacy. Rendering both cases as one
 * red "verification failed" would make the indicator something an auditor learns
 * to dismiss — which destroys its value for the case that matters.
 *
 * So the digest decides the verdict, and the format decides the severity:
 *   - digest does not match            -> TAMPER, danger, blocking
 *   - digest matches, format differs   -> DRIFT, warn, open for reading
 *   - nothing to compare               -> UNVERIFIABLE, danger, never a pass
 *
 * All of that logic lives in `auditVerificationView` and `utils/auditIntegrity`;
 * this file only renders it, so the rules stay assertable without a DOM.
 */
export const AuditVerificationBanner: React.FC<AuditVerificationBannerProps> = ({
  verdict,
  report,
  onInspect,
}) => {
  const view: AuditVerificationView = buildVerificationView(verdict);
  const Icon = TONE_ICON[view.tone];
  const failing = report.rows.filter((r) => !r.ok);

  return (
    <div
      // `role="status"` rather than `alert`: a drift notice is informational
      // and must not interrupt a screen reader mid-sentence, while a tamper
      // verdict still gets announced because it lands on the same live region.
      role="status"
      aria-live="polite"
      data-verification-state={view.state}
      data-tone={view.tone}
      data-blocking={view.blocking ? 'true' : 'false'}
      className={`rounded-xl border p-3 space-y-2 ${view.bannerClass}`}
    >
      <div className="flex items-start gap-2">
        <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${view.iconClass}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`pos-micro-badge ${view.badgeClass}`}>{view.badgeLabel}</span>
            <span className="text-[10px] text-pos-muted tabular-nums">
              {report.checked} ligne(s) vérifiée(s)
            </span>
          </div>
          {/* The operator-facing finding, stated in outcome terms. */}
          <p className="text-[11px] text-pos-text font-semibold mt-1 leading-relaxed">
            {view.message}
          </p>
          {view.detail && (
            <p className="text-[10px] text-pos-muted mt-1 leading-relaxed">{view.detail}</p>
          )}
        </div>
      </div>

      {/* Digest comparison, so the verdict is checkable rather than asserted. */}
      {view.showComparison && failing.length > 0 && (
        <details open={view.comparisonOpen} className="group">
          <summary className="cursor-pointer text-[9px] font-bold uppercase tracking-wide text-pos-muted hover:text-pos-text transition flex items-center gap-1 select-none">
            Comparaison des empreintes
          </summary>
          <ul className="mt-1.5 space-y-1">
            {failing.map((r) => {
              const tone = rowChipTone(r.reason, r.canonicalDrift);
              return (
                <li key={r.id} className="rounded-lg border border-pos-border bg-pos-card p-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <code className="font-mono text-[10px] text-pos-text break-all min-w-0 flex-1">
                      {r.id}
                    </code>
                    <span className={`pos-micro-badge ${TONE_BADGE[tone]}`}>
                      {rowChipLabel(r.reason, r.canonicalDrift)}
                    </span>
                  </div>
                  {r.reason === 'DIGEST_MISMATCH' && (
                    <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[9px]">
                      <dt className="text-pos-muted font-bold">Enregistrée</dt>
                      <dd className="font-mono text-pos-text break-all">{r.expected}</dd>
                      <dt className="text-pos-muted font-bold">Recalculée</dt>
                      <dd className="font-mono text-pos-danger break-all">{r.actual}</dd>
                    </dl>
                  )}
                  {onInspect && (
                    <button
                      type="button"
                      onClick={() => onInspect(r.id)}
                      className="mt-1.5 text-[9px] font-bold uppercase tracking-wide text-pos-muted hover:text-pos-text transition cursor-pointer"
                    >
                      Inspecter la ligne
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {view.state === 'VERIFIED' && (
        <p className="text-[9px] text-pos-muted flex items-center gap-1">
          <ShieldQuestion className="w-3 h-3" aria-hidden="true" />
          Empreinte applicative non signée côté serveur : elle détecte une altération
          locale, pas une falsification par un attaquant maîtrisant l’application.
        </p>
      )}
    </div>
  );
};

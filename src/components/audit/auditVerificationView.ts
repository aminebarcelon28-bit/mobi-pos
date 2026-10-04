/**
 * Presentation contract for audit verification states.
 *
 * Split out of the banner component on purpose. "A tampered document renders
 * red and blocks; a legacy-format document renders amber and does not" is a
 * security contract, not a styling preference — an auditor's decision to trust
 * or escalate rests on it. Keeping it in a pure, DOM-free module means it can
 * be asserted headlessly, and means the component cannot quietly drift away
 * from the classification rules in `utils/auditIntegrity`.
 *
 * The invariant to preserve when editing: `DRIFT` must never be reachable with
 * danger styling, and `TAMPER` must never be reachable with warning styling.
 */
import type { LucideIcon } from 'lucide-react';
import { AlertOctagon, FileWarning, ShieldCheck } from 'lucide-react';
import type { AuditVerificationVerdict } from '../../utils/auditIntegrity';

export type VerificationTone = AuditVerificationVerdict['tone'];

/** Short badge label. */
export const STATE_LABEL: Record<AuditVerificationVerdict['state'], string> = {
  VERIFIED: 'Conforme',
  DRIFT: 'Schéma hérité',
  TAMPER: 'Altération',
  UNVERIFIABLE: 'Non vérifiable',
};

/** Pill class. One per tone, so a tone can never be styled two ways. */
export const TONE_BADGE: Record<VerificationTone, string> = {
  ok: 'pos-micro-badge--ok',
  warn: 'pos-micro-badge--warn',
  danger: 'pos-micro-badge--danger',
};

/** Banner surface class. */
export const TONE_BANNER: Record<VerificationTone, string> = {
  ok: 'bg-pos-ok/10 border-pos-ok/30',
  warn: 'bg-pos-warn/10 border-pos-warn/30',
  danger: 'bg-pos-danger/10 border-pos-danger/30',
};

/** Foreground class for the banner icon. */
export const TONE_ICON_CLASS: Record<VerificationTone, string> = {
  ok: 'text-pos-ok',
  warn: 'text-pos-warn',
  danger: 'text-pos-danger',
};

export const TONE_ICON: Record<VerificationTone, LucideIcon> = {
  ok: ShieldCheck,
  warn: FileWarning,
  danger: AlertOctagon,
};

/**
 * Per-row chip shown in the digest comparison list.
 *
 * Kept distinct from the banner tone: a document can be a hard tamper overall
 * while an individual listed row is only showing a format difference, and
 * conflating the two would overstate what is known about that row.
 */
export function rowChipTone(reason: string | undefined, canonicalDrift: boolean): VerificationTone {
  if (reason === 'DIGEST_MISMATCH') return 'danger';
  if (canonicalDrift) return 'warn';
  return 'ok';
}

export function rowChipLabel(reason: string | undefined, canonicalDrift: boolean): string {
  if (reason === 'DIGEST_MISMATCH') return 'Empreinte divergente';
  if (canonicalDrift) return 'Format hérité';
  return 'Non comparable';
}

/** Full view model for one banner, so rendering is a single lookup. */
export interface AuditVerificationView {
  state: AuditVerificationVerdict['state'];
  tone: VerificationTone;
  badgeLabel: string;
  badgeClass: string;
  bannerClass: string;
  iconClass: string;
  message: string;
  blocking: boolean;
  /** Extra sentence explaining the finding, or null when there is none. */
  detail: string | null;
  /** Whether the digest comparison list should render. */
  showComparison: boolean;
  /** Whether the comparison starts expanded. Tamper is expanded by default. */
  comparisonOpen: boolean;
}

export function buildVerificationView(verdict: AuditVerificationVerdict): AuditVerificationView {
  return {
    state: verdict.state,
    tone: verdict.tone,
    badgeLabel: STATE_LABEL[verdict.state] ?? verdict.state,
    badgeClass: TONE_BADGE[verdict.tone],
    bannerClass: TONE_BANNER[verdict.tone],
    iconClass: TONE_ICON_CLASS[verdict.tone],
    message: verdict.message,
    blocking: verdict.blocking,
    detail:
      verdict.state === 'DRIFT'
        ? 'Les empreintes concordent : le contenu est celui exporté. Seule la forme canonique a changé depuis. La lecture reste possible.'
        : verdict.state === 'TAMPER'
          ? "L'empreinte recalculée ne correspond plus à celle enregistrée à l'exportation."
          : null,
    showComparison: verdict.state !== 'VERIFIED',
    // Tamper is opened by default so the claim is checkable without a click;
    // drift stays collapsed because it is not a blocking finding.
    comparisonOpen: verdict.state === 'TAMPER',
  };
}

import React from 'react';
import { ShieldCheck, ShieldAlert, Wrench } from 'lucide-react';
import {
  warrantyChipLabel,
  warrantyStateLabel,
} from '../../utils/warrantyResolver';
import type { WarrantyState, WarrantyStatus } from '../../utils/warrantyResolver';

/**
 * Tone per state, EXHAUSTIVE: the `never` guard makes the compiler reject a new
 * state that has no colour, instead of silently inheriting the expired red.
 * `NOT_STARTED` is deliberately slate, never red — the device carries coverage,
 * it just has not started, and must not read as expired or uncovered.
 */
const TONE = {
  ACTIVE: 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300',
  EXPIRING_SOON:
    'bg-amber-50 dark:bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-300',
  NOT_STARTED: 'bg-pos-muted/10 border-pos-border text-pos-text',
  EXPIRED: 'bg-rose-50 dark:bg-rose-500/10 border-rose-500/30 text-rose-700 dark:text-rose-300',
  NEVER_COVERED:
    'bg-rose-50 dark:bg-rose-500/10 border-rose-500/30 text-rose-700 dark:text-rose-300',
  VOID: 'bg-rose-50 dark:bg-rose-500/10 border-rose-500/30 text-rose-700 dark:text-rose-300',
  REPAIR_WARRANTY_ACTIVE:
    'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300',
} satisfies Record<WarrantyState, string>;

const ALERTING_STATES: ReadonlySet<WarrantyState> = new Set<WarrantyState>([
  'EXPIRED',
  'NEVER_COVERED',
  'VOID',
]);

const BASE =
  'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[9px] font-medium uppercase tracking-normal';

function Chip({ status, icon }: { status: WarrantyStatus; icon?: React.ReactNode }) {
  return (
    <span
      className={`${BASE} ${TONE[status.state]}`}
      data-testid={`warranty-chip-${status.kind.toLowerCase()}`}
    >
      {icon ?? (ALERTING_STATES.has(status.state) ? (
        <ShieldAlert className="w-3 h-3" aria-hidden="true" />
      ) : (
        <ShieldCheck className="w-3 h-3" aria-hidden="true" />
      ))}
      {warrantyChipLabel(status)}
    </span>
  );
}

/**
 * Renders the STORE warranty and, when one exists, the REPAIR warranty as
 * SEPARATE chips (Q1). The two were previously conflated into a single field,
 * so a delivered repair warranty was unreachable and every live device claimed
 * a hardcoded 90-day repair term.
 */
export default function WarrantyStatusChips({
  store,
  repair,
}: {
  store?: WarrantyStatus | null;
  repair?: WarrantyStatus | null;
}) {
  return (
    <>
      {store ? <Chip status={store} /> : null}
      {repair ? (
        <Chip
          status={repair}
          icon={<Wrench className="w-3 h-3" aria-hidden="true" />}
        />
      ) : null}
    </>
  );
}

export { warrantyStateLabel };

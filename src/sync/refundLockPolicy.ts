/**
 * Offline refund lock policy (split-brain guard). Pure — the modal (UI hint),
 * the slice (execution gate), and unit tests share this, so the badge can
 * never disagree with the gate.
 *
 * Rule: an offline till may only refund tickets that originated from its own
 * local ledger during the currently open shift. Remote tickets (another
 * device) and past-shift tickets require an active server-acquired claim with
 * REFUND_CLAIM_TTL_SEC TTL; without one the refund is denied fail-closed.
 */

/** Server-acquired refund claim TTL: 90 seconds (abandoned locks self-sweep). */
export const REFUND_CLAIM_TTL_SEC = 90;

export interface RefundTicketOrigin {
  deviceId?: string;
  device_id?: string;
  shiftId?: string;
}

export interface RefundLocalContext {
  localDeviceId: string;
  activeShiftId: string | null;
}

export type OfflineRefundVerdict =
  | { allow: true }
  | { allow: false; reason: 'OFFLINE_REMOTE_TICKET' };

/** True when the ticket was created by this device inside the open shift. */
export function isOwnShiftTicket(
  ticket: RefundTicketOrigin | undefined | null,
  ctx: RefundLocalContext
): boolean {
  if (!ticket || !ctx.activeShiftId) return false;
  const origin = (ticket.deviceId || ticket.device_id || '').trim();
  if (!origin || origin !== ctx.localDeviceId.trim() || !ctx.localDeviceId.trim()) return false;
  return (ticket.shiftId || '').trim() === ctx.activeShiftId.trim();
}

/** Offline gate: own-shift tickets pass, everything else denies fail-closed. */
export function offlineRefundVerdict(
  ticket: RefundTicketOrigin | undefined | null,
  ctx: RefundLocalContext
): OfflineRefundVerdict {
  if (isOwnShiftTicket(ticket, ctx)) return { allow: true };
  return { allow: false, reason: 'OFFLINE_REMOTE_TICKET' };
}

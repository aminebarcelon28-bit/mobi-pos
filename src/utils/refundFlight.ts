/**
 * A refund submission is in flight. Global modal closes (a late checkout
 * effect, a payment-modal timer, a keyboard handler) must not dismiss the
 * refund dialog while the native refund is committing - that is how REF-87
 * lost its refund after the offline cash-cap switch.
 */
let flight = 0;

export function beginRefundFlight(): void {
  flight += 1;
}

export function endRefundFlight(): void {
  flight = Math.max(0, flight - 1);
}

export function isRefundFlight(): boolean {
  return flight > 0;
}

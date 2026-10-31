import type { Customer } from '../types/pos';

/**
 * D6 (docs/decisions/D6-milestone-tranche-payload.md) — the sale payload must not
 * embed the customer's whole loyalty book.
 *
 * The payload copy is what made a large ticket unrefundable: a 4e9 DA sale carries
 * ~200 000 milestone-tranche ledger rows on the customer, and the transaction
 * embedded the entire customer object, so `json_payload` reached ~96–139 MB and
 * the native refund merge could not finish.
 *
 * The embedded book is redundant: refunds and voids read the durable `customers`
 * row (that is the authority), and nothing reads `transactions.customer.ledger`
 * or `.pointBuckets`. What the ticket DOES need is the identity and the scalar
 * loyalty state at sale time (receipts, REF-40 ownership, debugging).
 *
 * Identity + scalar loyalty state only. The unbounded arrays are dropped; every
 * other field is preserved, so receipts and attribution do not change.
 */
export function saleCustomerSnapshot(
  customer: Customer | null | undefined,
): Customer | undefined {
  if (!customer) return undefined;
  const { ledger: _ledger, pointBuckets: _pointBuckets, ...rest } = customer;
  void _ledger;
  void _pointBuckets;
  // The omitted arrays are optional on `Customer`, so the shape is valid; the
  // cast just avoids widening the function's signature to a mapped type.
  return rest as Customer;
}

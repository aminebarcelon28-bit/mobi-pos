# ADR-002 — Convergence model for offline-first rows (SYN-04, and the money-row split)

- **Status:** accepted (documents existing behaviour; no code change)
- **Date:** 2026-11-03
- **Cases:** SYN-04 (accepted design), part of SYN-19/27 contract

## Context

Two terminals can edit the same row while offline. The local SQLite DB is the fiscal source of
truth and sync is an append-only outbox applied with a per-entity clock. Different row classes
carry different risk: a lost catalogue rename is an annoyance; a lost refund, double refund or
duplicated receipt number is a fiscal failure.

## Decision

1. **Every replicated row carries `version`** (bumped on each write; `entity_keys` records the
   highest applied version per `(entity_type, entity_id)`).
2. **Apply is version-primary:** a guarded upsert accepts only a strictly higher version; equal
   versions are resolved by a **deterministic device-id tiebreak**
   (`src/sync/causalVersion.ts: tiedVersionGuardSql`), proven order-independent by
   `scripts/test_sync_tiebreak.mts` (equal versions converge to the same winner in any apply
   order; the legacy `>=` guard is order-dependent and characterised as the bug).
3. **Money-bearing rows do not rely on LWW alone:** refunds run through `refund_sale_atomic` with
   a cumulative-quota gate, idempotency key, per-device signature and an in-transaction
   conservation check (`total == cash + wallet + voucher + debt`); customer debt and store credit
   are ledger-derived (`customer_debts`, `loyalty_ledger`) and CAS/version-guarded.
4. **Stock is not LWW:** `products.stock` is a projection of `inventory_ledger` deltas, rebuilt by
   `SUM(delta)` in the same transactions that write the ledger.

## Guarantees

- No silent loss of a committed money row: the refund/void lane is atomic and idempotent; a
  replay yields one effect.
- Concurrent catalogue edits converge to one row without order dependence (version, then tiebreak).
- Tombstones (`deleted=1`) replicate as versioned rows and cannot be resurrected by a stale edit.
- Stock cannot drift from its ledger through a catalogue LWW write.

## Non-guarantees

- **No field-level merge:** a concurrent edit of two different fields of the same catalogue row
  keeps the higher-version row whole; the other field's edit is overwritten. Accepted for
  non-money catalogue fields.
- **No CRDT semantics** (no commutative merge, no causal ordering of unrelated rows); the model is
  a versioned register plus domain-specific money guards.
- Wall-clock timestamps are not used to decide the winner (SYN-27's defect class); ordering is the
  version clock, and the pull cursor is being moved off timestamps (queue item).

## Rejected alternatives

- **CRDTs for the whole schema:** large rewrite, no fiscal benefit over the versioned register;
  money rows still need transactional guards.
- **Last-writer-wins by wall clock:** rejected — device clocks drift; a clock change reorders
  (SYN-27).
- **Server-authoritative sequencing:** incompatible with offline-first; the terminal must commit a
  sale with no network.

## Consequences

- SYN-04 stays an **ACCEPTED** case, pinned by this ADR.
- SYN-27 (pull cursor ordering) remains a product defect to fix; this ADR states the intended
  contract (version clock, not wall clock).

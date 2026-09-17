# ADR-0007: Bidirectional sync repair (mobile→desktop notifications + stock)

- Status: accepted · Date: 2026-09-16
- Context: desktop sales surfaced on mobile (toast + stock), but mobile sales
  never surfaced on desktop (no toast, stale stock). Pure-SQL simulation of the
  push/pull path moved rows both ways, so the defect was in ordering,
  convergence, and notification semantics — not transport.
  Repro: `scripts/verify-bidirectional-fix.mjs` (wired into `npm test`).
- Decision:
  1. `writeCheckoutAtomic`: ledger inserts now precede the cached-stock
     recompute; product outbox snapshots are refreshed post-recompute (step 7).
     Pre-fix order recomputed from the pre-sale ledger, shipping stale caches
     and stale product payloads (regression from ADR-0006-era commit 689870e).
  2. Pull `products` upsert now converges `stock` (+ catalog columns) under LWW
     instead of pinning the local cache; Dexie mirror gives remote columns
     precedence over the embedded (possibly pre-sale) json blob.
  3. Pull cursors advance only past successfully applied rows (C6: no silent
     skip on apply failure; poison rows are retried, not skipped).
  4. Remote-sale notification fires on genuinely new transaction ids (presence
     check), with deviceId match as an additional suppressor — robust to the
     two device-id namespaces (localStorage transport id vs SQLite authorship
     id). Own-write echoes never notify.
  5. `syncProductsFromSqlToDexie` upserts missing peer products (was
     update-only, so new peer SKUs never entered the Dexie catalog).
  6. One-shot cloud clock-skew probe on sync start (>10 s warns; cursor sync
     keys on wall clocks, so skew can permanently hide a peer's rows).
- Consequences: both directions converge (stocks equal, toasts fire) in the
  headless two-device simulation; full `npm test` green; polling/relay behavior
  unchanged. Follow-up (not in this ADR): cut idle read volume — pull polling
  alone exceeds a 10 M rows-read/month budget (see capacity note in 0006 radar).

## Addendum 2026-09-16 — void/refund receipt preservation + cancel notices
- Void/refund pushed a 5-field status stub that overwrote the cloud receipt and
  wiped line items + customer on peers at pull time. `enqueueOrderSync` callers
  now push the full transaction object; pull merges status-only payloads over
  the existing Dexie receipt instead of replacing it.
- Status flips to VOIDED/REFUNDED/PARTIALLY_REFUNDED on a known sale now emit a
  remote-sale notice ("Vente annulée…"/"Avoir émis…") on the peer.
- Customer delete was traced end to end and already converges: Dexie row
  removed + SQLite `deleted=1` + tombstone outbox op + pull delete branch +
  `refreshAfterPull` reload. No change; the UI guard blocking deletes with
  active debt is intentional.

## Addendum 2026-09-16 — live Khobz case (17 phone vs 19 desktop, true 18)
- Cloud forensics (`turso db shell`) showed the cloud holding exactly the
  desktop's rows (ledger SUM 18) and zero phone-originated order/ledger rows
  for the product — while the phone demonstrably pushes (its 13:31 test sale +
  stock adjusts are in the cloud). Verdict: that sale is stuck in the phone's
  outbox (pending/backoff/quarantine, dead token, or app backgrounded before
  the push tick), not a pull/notify defect on desktop.
- Same case exposed a live `device_id` corruption: `getOrCreateDeviceId`
  returned the legacy Dexie-port envelope object, stringified into every new
  row (`[object Object]` in the cloud). It now unwraps `value_json_text` and
  repairs the setting in place, preserving the stable UUID.
- Desktop showing 19 against SQLite/cloud 18 is a stale-Dexie window (two
  desktop instances share SQLite but not IndexedDB); the fixed stock mirror
  converges it on the next pull carrying new rows.

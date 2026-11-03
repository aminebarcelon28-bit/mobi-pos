# ADR-006 — Fiscal document numbering: one continuous series per terminal

- **Status:** accepted, **provisional** (owner/accountant confirmation required
  before production)
- **Date:** 2026-11-03
- **Case:** SYN-02 (stamped against this contract)
- **Evidence:** E-0172

## Context

Sales, credit notes (`AVOIR`), repair tickets and purchase orders all carry a
human-readable number that is a fiscal identifier. Two facts shape the design:

1. The rule is a **unique, sequential number based on one or more series**,
   chronological and without gaps within the series (EU VAT Directive
   2006/112/EC art. 226 is the canonical statement; Algerian invoicing practice
   is the same "chronologique et continue" requirement).
2. The terminal must commit a sale **with no network**. A single merchant-wide
   counter therefore cannot allocate: two disconnected terminals would either
   block or mint the same number.

The old generator was `PREFIX-YYYYMMDD-<msOfDay base36>-<seq2>-<random5>`: unique
in practice by randomness, **not a series**, with no counter and no DB constraint
— two terminals could mint the same string and both rows were accepted (the
SYN-02 defect).

## Decision

**One series per terminal, continuous within the series, behind a swappable
seam** (`src/utils/numbering.ts`).

- Format: `PREFIX-<SERIES>-<000001>`, where `SERIES` is 4 characters derived from
  the terminal identity (stable, printed on the paper) and the counter is
  per `(prefix, series)`.
- Prefixes keep their meaning (`REC` sale, `AVOIR` credit note, `REP/SAV`
  repair, `PO` purchase order, `VERS` debt settlement), so each document type is
  its own lane.
- The counter is **injected** (`SequenceStore`): today `localStorage` (sync,
  per-device), eventually the native DB. When no durable counter exists the
  generator falls back to the legacy timestamp format and increments a
  **degraded-draw counter** — it never claims a continuous series it cannot
  honour.
- `setNumberingScheme('legacy-timestamp')` restores the previous behaviour
  byte-for-byte (characterisation test keeps it honest); `setDeviceSeries()`
  lets the app bind the series to the enrolled device id at boot.

**Provisional because it is a fiscal format decision:** the owner/accountant must
confirm (a) the series layout and whether it is printed/registered, (b) whether
the series resets annually, and (c) whether the tax administration expects one
merchant series instead. The seam exists so that confirmation changes
configuration, not code.

## Rejected alternatives

- **Merchant-wide single counter.** Cannot allocate offline; needs online block
  reservation, which still reduces to a per-device component.
- **Keep timestamp + random, add a unique index.** No series, no continuity; the
  index would only turn a silent duplicate into a failed sale at the till.
- **UUID/ULID numbers.** Unique but not sequential; unacceptable for a fiscal
  document.
- **Date-based reset (`YYYYMMDD-0001`).** Breaks continuity across days and
  duplicates after a year; rejected unless the accountant asks for it.

## Consequences and follow-ups

- Printed numbers change shape (`REC-<SERIES>-000123`); existing rows are
  untouched. The series is printed so two terminals are visually distinguishable.
- **Follow-up (before production):** move the counter to the native DB in the
  same transaction that writes the sale (one source of truth, crash-safe), and
  add `UNIQUE(receipt_number)` once every writer uses the seam (legacy rows may
  collide). Until then the counter is per-device storage.
- SYN-02 is stamped **PASS** against this contract with the pre-production flag
  recorded here, in `agent/HUMAN_ACTIONS.md` (HAR-004) and in the evidence line.

## Sources

- Directive 2006/112/EC, art. 226(2): "a sequential number, based on one or more
  series, which uniquely identifies the invoice" —
  https://eur-lex.europa.eu/eli/dir/2006/112/oj
- Sequential-numbering compliance summary (uniqueness, no gaps, chronological) —
  https://www.csv2invoice.com/compliance/sequential-numbering
- Algerian invoicing practice (numérotation chronologique et continue) —
  https://www.digitaliac.com/slides/slide/facturation-en-algerie-normes-legales-et-obligations-2025-50
- Multi-series guidance (one written policy, keep per-series records) —
  https://invoicemonk.com/en/blog/sequential-invoice-numbering-guide

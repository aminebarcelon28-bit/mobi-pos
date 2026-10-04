# IMEI / serial identity → warranty chain — policy proposal and current state

Owner review document for the identity + warranty chain. Everything below was
verified by executing the shipped code; each claim carries its evidence and a
`VERIFIED-BY-TEST` / `VERIFIED-BY-READING` label. Where a decision is still open
it is listed in [Open decisions](#open-decisions), not silently implemented.

---

## 1. Identifier policy

One gate, one spelling. `validateDeviceIdentifierForIntake`
(`src/utils/savValidation.ts:109`) is the only identifier acceptance rule in the
app, and every acquisition writer calls it:

| Writer | Site | Failure mode |
|---|---|---|
| Trade-in (standalone) | `src/store/slices/createUISlice.ts:804` | refuses the device |
| Exchange (staged leg) | `src/store/slices/createUISlice.ts:1215` | refuses the device |
| PO receipt | `src/store/slices/createProcurementSlice.ts:433` | **aborts the whole receipt** (signed commercial document) |
| CSV invoice import | `src/store/slices/createCatalogSlice.ts:363` | drops that row only; the other lines still land |
| Catalog editor (`saveProduct`) | `src/store/slices/createCatalogSlice.ts:60` | refuses the save |

Rules, in the order they are evaluated:

1. **Blank → `IDENTIFIER_ABSENT`.** Callers that legitimately accept a blank
   (a non-serialized PO line, a non-serialized product) skip the call rather
   than trying to interpret the verdict.
2. **Exactly 15 digits → Luhn MOD-10 is mandatory.** A failure is
   `IMEI_LUHN_INVALID` and the write is refused: a wrong checksum resolves to
   nothing at the till and nothing at SAV, so the registry row would be dead
   weight and the warranty lookup would fail closed forever after.
3. **Anything else is accepted and canonicalised.** Serial numbers, tablets and
   dead devices are real stock here. `canonicalDeviceId`
   (`src/utils/deviceIdCodec.ts:51`) is the single spelling, so a hyphenated
   GSMA-scanned IMEI and its digits-only twin can never become two devices.
4. **Duplicates are a warning, never a refusal** — `DUPLICATE_IMEI:<key> …`.
   The one hard duplicate rule that remains is the *cart* collision (the same
   unit cannot be sold and taken back on one ticket), which lives at the cart,
   not at ingest (`src/store/slices/createOrderSlice.ts:313`).

`validateIMEI` (store action) is **deprecated and unchanged**: something still
pins its literal `luhnCheckImei(imei)` call
(`scripts/verify-tradein-phase01.mjs`), and reusing it for writers would block
non-15-digit serials and duplicates. It is not called by any writer.

VERIFIED-BY-TEST — `test_warranty_chain_scenarios.mts` S29, S29e.

---

## 2. Warranty policy

### States (the only three that matter)

| State | Representation | Resolution |
|---|---|---|
| Custom / explicit term | `warrantyMonths: n` (or a legacy alias) | `n` months, anchored at sale |
| Deliberately disabled | `warrantyExplicitlyDisabled: true` | 0 — "Sans Garantie" |
| Absent | no warranty field at all | category default |

`warrantyExplicitlyDisabled` **outranks** a stale positive term
(`src/utils/warrantyResolver.ts:229`). A bare `warrantyMonths: 0` is NOT a
decision: it is the `ProductEditorModal` form default (BUG-WAR-03), so it falls
through to aliases and the nested editor blob before anything is concluded.

### Malformed values never become a zero-month warranty

`coerceWarrantyMonths` (`src/utils/warrantyResolver.ts:135`) clamps, so `-6`,
`0.4` and `Infinity` all coerce to `0`. `readWarrantyField`
(`src/utils/warrantyResolver.ts:177`) therefore skips any candidate that
reaches `0` **without being a literal zero** (`isLiteralZeroTerm`), so a
malformed value can neither become a term nor shadow a well-formed sibling
(`{ warrantyMonths: -6, garantie: 12 }` still resolves 12). A literal `0`, and
legacy aliases such as `garantie: 0`, are still honoured — those keys predate
the editor default and were only ever written deliberately.

VERIFIED-BY-TEST — S32c / S32d, including the same rule inside the nested blob.

### Unknown carrier

`OCCASION_DEFAULT_WARRANTY_MONTHS` (3), never the known non-occasion 12
(`src/utils/warrantyResolver.ts:70`, W-22). An unknown carrier is not evidence
of a 12-month manufacturer term.

### Anchor, not recompute

The term a customer actually bought is minted once at sale and read
preferentially; a later catalog edit cannot re-date coverage already sold. The
anchor travels in `imeiData` (outbox payload) and, from migration 107, in its
own column.

VERIFIED-BY-TEST — S4, S31e, S33b.

---

## 3. Snapshot semantics

`WarrantyDossierSnapshot` (`src/types/pos.ts:1420`) is the **bounded** evidence
the SAV operator was shown: free text is capped at **120 characters** and the
full dossier is never copied into a persistent or sync payload.

- Persisted by `RepairWorkOrderModal` at ticket save
  (`src/components/modals/RepairWorkOrderModal.tsx:719-728`) and re-projected
  on re-open (`:824`).
- `resolveWarrantyDossier` returns `snapshot: null` in `manual` mode
  (`src/utils/warrantyResolver.ts:1527-1534`) — a manual identity resolves
  nothing, so it can have no dossier.
- A snapshot is non-null only for a **resolved searchable identity**, and a
  valid one always carries non-empty `idValue`, `idMode` and `resolvedAt`.
- Readers tolerate missing and malformed snapshots and **never invent coverage**:
  `minimalTicketDossierSnapshot` returns `null` for an unparseable envelope, an
  unparseable `resolvedAt`, a wrong-typed verdict, an array, a string, or a
  `manual` envelope that claims a dossier. It keeps only a well-formed
  envelope, and coerces the claims inside it (a peer string is not coverage, an
  illegal tier is not a tier).

VERIFIED-BY-TEST — S25, S30a–e.

---

## 4. Synchronization behaviour

**Push** — `enqueueGenericSync` → `toBoundedSyncJson` → `sync_outbox.payload_json`.
Whole-object persistence: there is no per-field whitelist, so nothing is shed on
the way out, and the anchor fields ride inside the payload.

**Receive** — `applyGenericRemoteRow` runs `sanitizeSyncPayload` (a different
function from the push serializer — pinned separately), then mirrors.
`repair_orders` has no SQLite mirror, so the Dexie put is a raw put of the
sanitized payload, which is why the snapshot lands intact (W-27).

**Warranty anchor on `imei_records` (INSERT-only).**

- Schema probing: `imeiAnchorColumnsPresent` (`src/db/imeiAnchorSchema.ts`),
  a `WeakMap<Database, Promise<Set<string>>>` running
  `SELECT name FROM pragma_table_info('imei_records')`, falling back to the
  base-schema column set when the schema cannot be read. Keyed per handle so a
  test double and the real database cannot inherit each other's answer.
- Coercion: a non-finite, negative or non-numeric term is dropped to `NULL`;
  `0` is preserved (it is the encoding of "sold with no warranty"). An
  unparseable expiry is dropped.
- The anchor columns are written **on INSERT only**. The conflict branch does not
  touch them, so a peer holding the shared merchant sync token cannot widen a
  locally frozen anchor. `excluded.version >= imei_records.version` is retained,
  and the `version` INSERT column must stay because that predicate reads it.
- The **sale** lane shares one probe with the pull lane. That is not cosmetic:
  the anchor columns share a single INSERT with `sold_at` /
  `sale_transaction_id`, so naming `warranty_months` on a database without
  migration 107 threw `no such column` and took the whole registry row down with
  it — expiry and sold stamp included. An unmigrated device now loses only its
  local copy of the term; the term still reaches peers in the outbox payload.

VERIFIED-BY-TEST — S30 (push + receive), S31 (pull), S33 (real SQLite engine).

---

## 5. Audit requirements

| Flow | Authorization | Audit | Value in the log? |
|---|---|---|---|
| Seller-ID reveal (`ImeiWarrantyInspectorModal`) | `canRevealSellerId`, fail-closed on unknown role | written **before** the value renders | masked form only |
| Blind-count reveal (`ShiftZReportModal`) | none today (unchanged business rule) | one line per **reveal**, on the first keystroke | **no** monetary value |
| Journal export (`SecurityAuditModal`) | fresh PIN | `EXPORT_JOURNAL` then deliver, failing closed | n/a |
| Shift close / recount (`createShiftSlice`) | manager recount on variance | variance + recount recorded | yes (variance is not concealed there) |

Two rules are load-bearing:

1. **Concealed values must not be journalised.** `security_audit_logs` is synced
   to peers and merged into backups, so writing the blind-count figure would copy
   it into the one table every device and every restore can read. The entry is
   built by `blindRevealAuditDetail` (`src/utils/zReportSnapshot.ts`), whose
   argument type accepts **no money field at all**, so the exclusion cannot be
   widened by accident. The Z number and the operator are kept — an
   accountability event with no document reference is useless.
2. **`logSecurityAction` stays best-effort** and never re-throws
   (`src/store/slices/createUISlice.ts:462`). The blind-count reveal is therefore
   fire-and-forget (`void logSecurityAction(...)`): an awaited write would stall
   the money input that triggered it, and making a till-closing figure depend on
   a bookkeeping side-effect would break the money flows that contract exists to
   protect. The write-ahead ordering (`saveAuditLog` before the in-memory
   append) is the real protection: on failure the UI never shows a row the
   database rejected.

Seller-ID scope is a **UI/security concern only** — sync, retention and deletion
behaviour are untouched by this work.

VERIFIED-BY-TEST — S26 (seller reveal + role gate + masked detail), S34 (blind
count). `logSecurityAction` contract VERIFIED-BY-READING
(`createUISlice.ts:456-489`).

### Z-report print settlement: an un-counted drawer prints no figure

`ZReportSnapshot` carries `blindCountPerformed`. `countedCash` is 0 until an
operator tallies the drawer and `variance` is derived from it, so the **interim**
Z report — a preview printed before any count — used to print `COMPTÉ 0 DA` and
`ÉCART -<expected> DA`: a fabricated full-drawer shortage on a document that
carries two signature lines.

- The flag is **carried by the caller, never inferred** from `countedCash`: a
  legitimately empty drawer is a real count of 0, and an un-counted drawer is a
  different fact. Only `ShiftZReportModal` passes `false`, tied to its reveal
  flag.
- All three renderers agree — HTML paper (`ZReportPaper`), ESC/POS twin
  (`buildZReportBuffer`) and mobile text (`zReportText`) print
  `non effectué` for both lines. The theoretical balance still prints: that
  figure is computed, not concealed.
- The close ticket is unchanged by default (it is gated on a positive count at
  `ShiftCloseModal.tsx:331`), so the signed document keeps its real numbers.

VERIFIED-BY-TEST — S36, driving the decoded ESC/POS buffer and the mobile text
twin, with a control that a counted shift still prints `44 …` and a real
variance.

---

## 6. Role gating

`canRevealSellerId` matches the role **exactly** (no case folding, no prefix),
and an unknown or empty role denies. Fail-closed: no matching role, no reveal,
and no audit line claiming a reveal happened.

VERIFIED-BY-TEST — S26d.

---

## 7. Known legacy parity gaps (finance decision, not a code fix)

`npm run audit:warranty` measures the resolver and the receipt column
independently and reports divergence. Two cases still differ:

| Case | Resolver | Receipt column (legacy path) |
|---|---|---|
| known non-occasion, no term on the row | 12 | 0 |
| deleted catalog row (orphan) | 3 | 0 |

Both are reachable **only** by a reprint of a pre-anchor legacy receipt. New
sales print the Step-A snapshot term, so no new document can hit them. Closing
them means rewriting legacy receipt semantics — a finance decision, deliberately
**not** taken here. The `warrantyExplicitlyDisabled`, form-default-zero and
occasion cases already agree.

---

## 8. Migration 107 status — NOT APPLIED

Migration 107 (`src-tauri/src/lib.rs:1541`) is additive-only by design: it adds
`imei_records.warranty_months` and two indexes, with **no backfill**. Backfilling
would freeze today's resolver answer into history before the zero-warranty policy
question is signed off, and `warranty_expires_at IS NULL` remains a valid
"not yet anchored" state.

Live database probe (read-only, `node:sqlite`, `AppData\Roaming\com.mobi.pos\
mobi_pos.db`):

```
max sqlx migration version: 106
imei_records columns: imei, product_id, purchase_order_id, sale_transaction_id,
                       warranty_expires_at, received_at, sold_at, version
anchor indexes present: idx_imei_prod, idx_imei_sale_txn, idx_imei_po
```

So on this machine `warranty_months` does **not** exist and `idx_imei_sold` does
not exist yet. The sale and pull lanes are therefore verified against **both**
schemas: the migrated shape through controlled in-memory SQLite databases (S33)
and the pre-107 shape through the real engine, which is the shape this device is
actually running today. Nothing in the chain requires the migration to have run.

---

## 9. Testing strategy

- `scripts/test_warranty_chain_scenarios.mts` is the behavioural spine: 33
  sections, 428 assertions, all against the **shipped** functions — no
  hand-written doubles of the logic under test. Where a component cannot run in
  Node (the blind-count reveal), the assertion pins the shipped audit-detail
  function on hostile inputs and the source invariant that the reveal is
  once-guarded and amount-free.
- Real SQLite (`node:sqlite`) is used wherever the failure mode is one only the
  engine can produce (a statement naming a missing column); parameter style is
  adapted (`$1` → `?`) and nothing else.
- `scripts/audit_warranty_exposure.mjs` stays **read-only** and answers from the
  shipped resolver, so exposure and parity are measured, not asserted.
- Playwright covers the modal surfaces (SAV + inspector, trade-in origin,
  device input) under the dev harness.

VERIFIED-BY-TEST.

---

## Open decisions

1. **Legacy receipt parity** (§7) — reprint semantics for the two divergent
   cases. Finance call.
2. **Migration 107 backfill** — deliberately not performed; needs the
   zero-warranty policy decision first. The column and indexes apply cleanly on
   the next app start (additive, `IF NOT EXISTS` for indexes).
3. **Blind-count reveal authorization** — currently unauthenticated by business
   rule. Auditing was added; a manager gate would be a policy change, not a fix.
4. **Shared merchant sync token** (Tier B residual, tracked in `AGENTS.md`) —
   the anchor cannot be widened from the wire, but a peer can still rewrite
   unrelated merchant data. Per-device credentials remain the gate.
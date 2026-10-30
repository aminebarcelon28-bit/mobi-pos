# Feature discovery - deriving the cases a change needs

Gate 2 says "one row per case, before any code". This file is how the rows are found. It is not a
checklist to fill in: each pass is a way of *generating* candidates, and every candidate that
survives becomes a row with a written pass condition.

The rule that makes this worth doing: **a case is derived from the change, not remembered from
last time.** If you cannot say which pass produced a case, it is probably a case for a different
feature.

Run the passes in order. Each one is cheap; skipping one is how the same class of defect gets
re-found a batch later.

---

## Pass A - Input boundaries

Take every field the feature reads (UI input, CSV import, IPC argument, barcode, PIN, search box)
and walk this table. The third column is where the product already handles it - a change near that
code must prove the rest of the table still holds.

| Class | Try | Where it is handled today |
|---|---|---|
| Empty / whitespace only | `''`, `'   '`, a lone NBSP | `Money.fromUserInput` fails loudly on empty (`src/utils/money.ts:92-93`) |
| One character | `'1'`, `'0'`, `'.'`, `','` | money: `'0'` is valid, `'.'` alone fails |
| Max length | the field's `maxLength`, then +1 pasted | manager PIN is 6-8 (`LockScreenOverlay`), product name 67 chars is a P3 case |
| Unicode / emoji | `😀`, combining accents, RTL Arabic | names render in an LTR shell; long values overflow columns, not code points |
| Arabic-Indic digits | `١٣٥٫٥٠` (= 135.50) | normalized in `Money.fromUserInput` (`src/utils/money.ts:97-105`) and asserted natively (`src-tauri/src/money.rs:341-343`) |
| Arabic thousands separator | `١٢٬٥٠٠` | `U+066C` is dropped by the same normalizer (`money.ts:104`) |
| FR grouping | `12.500,50`, `45.000`, `1 234,56` | strict FR only; US grouping (`1,200.50`) is **rejected**, not mangled (`money.ts:112-118`) |
| 3+ decimals | `130.555` | throws - never silently rounds (`money.ts:83-84`) |
| Sign / negatives | `-1`, `+5`, `−5` (U+2212) | signs are refused at entry; U+2212 is a separate case |
| Huge values | `9007199254740993` | `assertSafeInteger` on add/sub (`money.ts:190,197`) |
| Control / bidi characters | `\u0000`, `\u202E` (RTL override), `\u200B` | no filter in most fields - a real finding if it reaches a print or a file name |
| Non-ASCII in a printed line | Arabic product name, `1 234 567 DA` with U+202F | **`escpos.ts:63-69` encodes with `charCodeAt(i) & 0xFF`** - U+202F becomes `/` (bug A4, still open) |
| Phone numbers | `+213 555 01 02 03`, Arabic-Indic digits, 9 vs 10 digits | `src/utils/phoneUtils.ts:25-28`, `dzPhoneUtils.ts:120-126`, `validateDzPhone` |
| CSV cells | quoted commas, embedded newlines, Arabic digits, empty cells | `src-tauri/src/import/detect.rs:230` normalizes digits/separators on import |
| Quantity | `0`, `-1`, `1.5`, `999999` | the mobile sheet floors at 1 (`QuantityEditSheet.tsx:76`); the desktop path is the parity case |

RTL specifics, because "RTL support" is too vague to test:
- The app is **LTR** (French UI). `grep -rn 'dir="rtl"' src` returns exactly one hit: the Arabic
  legal-terms block in `RepairWorkOrderModal.tsx:2554`.
- Numerals, keys and codes are bidi-isolated with `<bdi dir="ltr">` (e.g.
  `LockScreenOverlay.tsx:718`), because an Arabic name next to a number reorders the punctuation.
- So the RTL cases are: an Arabic customer/product name in an LTR row (does the amount stay
  readable?), the Arabic terms block (does it read right-to-left and still fit?), and an Arabic
  name on a printed ticket (does it survive the `& 0xFF` encoder?).

Every boundary that is rejected must be rejected **with a message and without a write**. A
rejection that leaves a partial row is a finding, not a validation detail.

---

## Pass B - States x actions

Enumerate the screen states the feature can be in, then for each state the legal action, the
illegal action, and the interrupted action. The interrupted column is the one that finds P0s.

| State | Legal action | Illegal action (must be refused, typed) | Interrupted action (must leave a known state) |
|---|---|---|---|
| Fresh sandbox, no data | open the feature | pay an empty cart | kill the app during first boot |
| Loaded, cart with lines | apply a discount, pay | refund more than was collected | kill during checkout (`taskkill /F /IM mobi-pos.exe`) |
| Modal / overlay open | complete the modal | scan or click behind it | lock the terminal with the modal open |
| Locked terminal | unlock with a PIN | invoke `refund_sale_atomic` directly | clock jump while locked |
| Offline (gateway unset / airplane) | sell, queue | close a shift that needs the server | reconnect mid-drain |
| Mid-sync (outbox draining) | keep selling | edit a row the drain is sending | kill during the drain, then restart |
| Degraded boot (wrong DB name, bad overlay) | read the log, refuse | record a verdict | - |
| Tamper / clock-reset terminal | emergency export (MAC-covered, read-only) | unlock, write, sell | - |

Recipes that are known to work in this harness:

| Interruption | How | Expected observation |
|---|---|---|
| Kill mid-checkout | `taskkill /F /IM mobi-pos.exe` between the confirm click and the receipt | either the sale row + items + stock movement all exist, or none do - never a partial |
| Lock mid-cart | lock from the header, unlock | cart preserved or explicitly cleared, never silently lost |
| Clock jump | set the OS clock forward/back, then hit a money path | wall clock behind the monotonic high-water fails `SYSTEM_CLOCK_REGRESSION`; a forward jump past 30 s fails `SUPERVISOR_AUTH_FUTURE_DATED` |
| Network drop | unset `sync.gateway_url` (desktop) / airplane mode (mobile) | the sale commits locally and queues; nothing is dropped |
| Kill mid-import | `taskkill` during a 100k-row CSV import | import is atomic or resumable - never half-written |
| Overlay left open | `listDialogs()`, then `closeDialogs()` before blaming a click | the flow either closes it or refuses with a message |

The illegal column is not optional: every manager-gated command gets one direct-IPC negative case
(`invoke('refund_sale_atomic', ...)` while locked must return a typed `CODE:detail` denial, never
a silent success).

---

## Pass C - Invariants

An invariant is a statement that must hold after *any* sequence of actions. Assert it by
comparing two independently produced values, never by re-reading the value the code just wrote.

| Invariant | Statement | How to check here |
|---|---|---|
| Conservation of money | `collected == committed == stored` for a sale and for its refund | three reads: the tender rows, the refund rows, the transaction total |
| Two outputs equal | receipt bytes == screen total; export cell == headline | decode the captured buffer / read the sheet, compare with the headline on the same fixture |
| Stock conservation | `stock_before - sold + returned == stock_after`, per product | `inventory_ledger` sum vs the product row |
| Idempotency | the same refund twice applies once | `refund_dedup` PK `(ticket_id, items_hash)` is written first inside the native refund (`src-tauri/src/lib.rs:1653-1659`, `src-tauri/src/refund.rs:7-12`); an exact replay fails deterministically |
| No bypass | a refund cannot be written except through `refund_sale_atomic` | trigger `trg_refund_requires_dedup` raises `REFUND_BYPASS` (`src-tauri/src/lib.rs:1672-1679`) - a case must prove the trigger still fires |
| Contiguity | outbox rows carry monotonic `seq_no`, no gaps per device | `sync_outbox` ordered by `seq_no` for the device, `last_acked_seq` never ahead of the rows |
| Audit completeness | every trust-table write leaves one audit row naming the actor | `security_audit_logs` count + actor, before/after |
| Monotonic time | the money path never reads the wall clock backwards | the durable anchor (`time_anchor.rs`) is the source; wall behind high-water fails |

The harness already implements a general version of this: `captureInvariantBaseline(tag)` before
the flow, `assertInvariants(tag)` after it, `finalizeInvariants(label)` once at the end
(`e2e-tests/lib/invariants.ts:184,1334,1374`; the checks are `INVARIANT_IDS` at `:49-52`). A
violation is reported once, never thrown inside `afterEach` (that would skip the remaining tests).

Rule: **one invariant per case**, named in the title. "Everything is consistent" is not a pass
condition.

---

## Pass D - Interactions

Take the feature and cross it with the subsystems it can touch. The interesting defects live at
the seams, not in the happy path.

| Crossed with | Ask | Assert |
|---|---|---|
| Discounts | is the discount applied before or after tax, and does the refund use the same base? | refund == collected, not == stored total |
| Refunds / voids | can a refunded line be refunded again, or a partially refunded line fully refunded? | dedup gate + conservation |
| Shifts / drawer | does the sale land in the open session, and does Z include it once? | session id on the row, one Z line |
| Outbox / sync | is the row signed and queued exactly once, in `seq_no` order? | outbox row count + contiguity |
| Receipts / printing | do the printed bytes carry the same amount and the same separator as the screen? | byte decode vs screen |
| Reports / exports | does the aggregate include the new row, once, in the right period? | export cell == headline, `[start, end)` |
| AR / FR | does the value survive a language switch, and does an Arabic name stay readable next to a number? | text round-trip + no mojibake |
| Mobile | does the same flow work at 1080x2424 with touch, and does the desktop twin stay hidden? | `shown()` not `$()`, one action per viewport |
| Roles / PIN | can a cashier reach the action, and does a manager gate actually gate? | typed refusal, no state change |
| Import | does the new field survive a CSV round-trip with Arabic digits and empty cells? | row values after import |

A seam with no case is a seam that has never been tested; say so in the report rather than
implying coverage.

---

## Pass E - Seeded random walk

A random walk finds the sequences nobody writes down: discount, then partial refund, then a shift
close, then a replay. It is only useful if it is **reproducible**, so it is seeded and bounded.

Building blocks that already exist:

| Piece | API | Note |
|---|---|---|
| Seeded PRNG | `makeRng(seed)` -> `next/int/pick/weighted/chance` (`e2e-tests/lib/rng.ts:30-46`) | mulberry32: the same seed replays the same sequence |
| Invariants | `captureInvariantBaseline`, `assertInvariants`, `finalizeInvariants` (`e2e-tests/lib/invariants.ts`) | the walk asserts after every step group, not only at the end |

Shape of a walk case:

1. Fix the seed in the case (`WALK_SEED`), and allow an override from the environment so a failure
   can be replayed with the exact seed the log printed.
2. Build a **weighted action table** (sell 40, add line 20, discount 10, refund 8, void 4, shift
   close 2, replay a refund 2, ...). Weights are part of the case: changing them changes the
   coverage, so record them.
3. `captureInvariantBaseline('walk:<seed>')`, then run `N` steps (bounded: steps and wall-clock
   budget both), calling `assertInvariants` every ~10 steps.
4. On a violation, log exactly `WALK_VIOLATION seed=<n> step=<k> action=<name> invariant=<G-nn>`.
   That line is the reproduction recipe: seed + step replays the sequence up to the failure.
5. Keep the walk deterministic: no `Date.now()` in the action choice, no `Math.random()`, no
   retry-inside-step. Time-dependent steps are injected as explicit actions with a fixed value.

**Honest status:** no walk spec exists in this repo yet. `lib/rng.ts` has no consumer today (the
only `mulberry32` in the tree besides it is an inline copy in `tools/27e-prf-checks.mts:68`). So a
change that claims "walk coverage" is claiming something that does not exist - write the walk spec
in Gate 2, or say "no walk" in the report.

---

## From passes to Gate 2 rows

Selection rule: happy path + 2 edges from `references/edge-case-matrix.md` + 1 negative, plus
whatever Pass A-D produced for the specific change. A walk (Pass E) is one extra case, not a
replacement for the others.

Each row needs: an ID from `CASE_INDEX.csv`, the pass that produced it, a precondition that either
exists or is BLOCKED with the missing item named, and a pass condition a stranger could evaluate.

Anti-patterns that have cost time here:

- **Asserting the absence of an exception.** That was 4 FAILs in batch 26 with no actionable
  evidence. Assert a value.
- **Testing the framework.** A case that only proves mocha ran is not a case.
- **Re-deriving the implementation in the test.** Compare two independent outputs instead (the
  export cell vs the headline, the receipt bytes vs the screen).
- **A threshold with no number.** Write "boot < 2 s at 1M customers" before measuring, or the
  result is an opinion.
- **One case with five assertions.** When it fails you cannot say which facet broke; split it, and
  use PASS-PARTIAL only when a facet genuinely cannot be asserted.

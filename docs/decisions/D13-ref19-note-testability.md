# Decision D13 — REF-19's write-off note is not scriptable (accepted testability residual)

- **Status:** accepted 2026-11-01. Not a money defect; the money path refuses unknown states, which is correct.
- **Case:** `docs/EDGE_CASES.md` #52.

## The finding

REF-19's part (a) refunds a **write-off** line ("rebut", no restock). The product requires an
operator-authored note for that lane (REF-36 owner rule; `RefundModal.tsx` note gate + the slice's
`defectNote`). The test sets the reason category and the note text, and the DOM reports them
(`{"ok":true,"select":"Autre","note":"Autre"}`), yet the submit handler returns **before** `processRefund`:
the lifecycle ring buffer shows `submit:start` with no `submit:result`, and the gate instrumentation added
for this investigation does not fire either — the handler aborts earlier than every named gate.

## Why it is accepted rather than "fixed" by force

- The product behaviour is **safe**: a write-off refund without a note is refused, no row, no stock movement,
  no drawer movement. The refusal is the correct outcome for the state the component actually holds.
- The gap is **testability**: the two controls are React-controlled and re-render after the refusal, and a
  scripted value change (native setter + input/change events, real keystrokes, `addValue`) does not reliably
  reach component state on this build. Forcing it from the test (e.g. dispatching a fabricated submit) would
  test something the application cannot actually do through its own UI.
- The suite already covers the *noted* write-off path in REF-19 part (b) and the write-off money rules in the
  native tests (defective returns consume COGS, never restock).

## Options considered

| # | Option | Verdict |
|---|---|---|
| A | Make the note input uncontrolled (or add a stable `data-testid` + `onInput`) so a script can drive it | the correct long-term fix; not a money change, but touches a refund form used by every refund — scheduled as UI debt, not smuggled into a money-cycle |
| B | Let the test bypass the gate | rejected: fabricates a note the operator never wrote |
| C | Accept the residual, keep the refusal asserted as a negative control | **chosen** |

## Exit criteria

Uncontrolled note input (or a documented test hook) + REF-19 part (a) asserting: bare category → refused, no
row; note supplied → lands with the note stored verbatim in `defective_returns.reason` and the refund audit.

## Reversal

Nothing to reverse: no product behaviour changed for this case (only instrumentation was added, which is
kept because it names the failing gate in future runs).

## Update 2026-11-01 (stop point) — three attempts, one guardrail

Three fixes were tried on this single symptom: (1) product-side note fallback to the field value (kept — it
removes a real fast-typist hazard), (2) harness-side native `selectByVisibleText` gesture, (3) a
verify-the-selection-stuck check that triggers (2). The controlled `<select>` still reverts to its default
option on the next render, so the `Autre` detail view never persists and the note input is never rendered.
Per the guardrails I stopped rather than trying a fourth variant.

**Exit criteria (sharpened):** make the reason select **uncontrolled** (a ref + `defaultValue`, reading
`ref.current.value` at submit like the note now does) or expose a documented test hook. Then the existing
assertions prove the verbatim note end-to-end.

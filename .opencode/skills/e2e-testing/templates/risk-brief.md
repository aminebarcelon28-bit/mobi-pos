# Risk brief - `<change>`

Five lines. Gate 1 output. If a line cannot be filled, the change is not understood yet.

1. **Changed:** files/modules, and the one behaviour that changed.
2. **Touches:** domains from the Gate 1 table (money / refunds / data / sync / print /
   reports / auth / shifts / catalog / scale).
3. **Blast radius:** which flows, roles and stored data can now be wrong.
4. **Riskiest flow:** the single path most likely to break, and why.
5. **Invariant that would break silently:** e.g. "stock decrements exactly once",
   "export cell == headline", "outbox stays contiguous", "refund == collected".

## Minimum run set

| Gate | Spec | Why |
|---|---|---|
| smoke | `00-harness-smoke.e2e.ts` | environment is sane |
| new / changed | `<spec>` | the change itself |
| adjacent | `<spec>` | shared helper or shared table |
| full suite | only if `lib/`, `src/services/`, `src/db/`, `src-tauri/` changed | |

## Preconditions I am declaring BLOCKED up front

| Case | Missing |
|---|---|
| | |

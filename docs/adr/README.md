# Architecture Decision Records

Short, dated records of decisions that are expensive to reverse. Each one states
the forces, the decision, the rejected alternatives and the residual risk. Code
that contradicts an ADR is a bug until the ADR is superseded.

| # | Decision | Status | Case |
|---|---|---|---|
| [ADR-001](ADR-001-native-session-principal.md) | Session principal is native; the WebView cannot assert identity | accepted | SEC-01 foundation |
| [ADR-002](ADR-002-convergence-model.md) | Versioned register + deterministic device tiebreak; money rows use transactional guards, never plain LWW | accepted | SYN-04 |
| [ADR-003](ADR-003-at-rest-residual.md) | The working DB is not encrypted; full-disk encryption is a deployment requirement, SQLCipher deferred with a key-escrow plan | accepted residual | SYN-26 |
| [ADR-004](ADR-004-escpos-arabic-raster.md) | Arabic prints as a `GS v 0` raster rendered by the platform; CP864 is a measured fallback, not the path | accepted | RCP-01/12/21 |
| [ADR-005](ADR-005-role-bound-ipc.md) | Role-bound native authorisation, then read-only SQL, then a data-plane gateway | proposed, staged | SEC-01 |
| [ADR-006](ADR-006-fiscal-numbering.md) | One continuous fiscal series per terminal; printed PREFIX-SERIES-000001; swappable seam | accepted, provisional | SYN-02 |
| [ADR-007](ADR-007-audit-baseline-reset.md) | The audit chain never auto-heals; one sanctioned reset retires the head after a wipe and logs the reset as the new genesis link | accepted | SEC-05 |

## Adding an ADR

1. Copy the shape of an existing record (Status / Context / Decision /
   Rejected alternatives / Consequences / Sources).
2. Cite primary sources (vendor docs, standards, upstream issues) — the repo
   rule is that a non-trivial decision is grounded, not asserted.
3. If the decision changes behaviour, land it behind tests in the same change and
   cite the evidence ID.

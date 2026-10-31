# C01 — final report (2026-10-31)

## Verdict in one paragraph

The refund and void money paths are now settled **inside one SQLite write transaction** and proven at
the 32-bit boundaries; the TypeScript side can no longer overwrite a wallet movement; the library suite is
fully green; the E2E refund suite is **17/18 with zero skipped tests and a clean invariant oracle**, with the
single red case accepted in writing because the fix requires a data migration that the guardrails forbid
without a backup and a dry run. The edge-case register has **zero OPEN items**. Static, boundary and
dependency audits are recorded. Everything below is reproducible with the commands in the last section.

## What is proven

| Claim | Evidence |
|---|---|
| Refund wallet leg commits with the refund (balance + ledger + row + restock in one `BEGIN IMMEDIATE`) | 33 native tests; E-0090; D4-A |
| Avoir refunds at **2³¹+1**, **4e9** and **past 2³²** credit exactly once, exact amount | E-0080, E-0097, E-0098, E-0099 |
| A refund can never erase a concurrent wallet debit (review N2) | 11-case real-SQLite test (E-0094, E-0095) |
| The native wallet marker `sync_status='pending'` is consumed at boot | 6-case test (E-0106) |
| A void persists its loyalty reversal with the status flip | REF-48 green (E-0104) |
| A forged/legacy refund cannot leave spendable points behind | native derivation + test (E-0104) |
| Money conservation gate + 31→33 refund tests under the strict invariant | E-0090, E-0104 |
| Library suite green | `cargo test --lib` **436/436** (E-0096 + later) |
| E2E refund suite | **17/18**, 0 skipped, invariants clean (ref33final) |
| Booting gate tracks the migration list (a device at v128 would have refused to boot) | D8 / E-0096 |

## Decisions (all in `docs/decisions/`)

| ADR | Subject |
|---|---|
| D4-A | Avoir wallet leg settles inside `refund_sale_atomic` (increment + ledger, recipient gate, pre-COMMIT balance) — 5 primary sources |
| D2 | Test-only lift: four `Some(200)` → `Some(200.0)` literals in `checkout.rs` |
| D3 | Legacy refund fixtures were inconsistent; per-test intent, never expectation-to-output |
| D5 | Refund selection reads a `json_extract` projection, not the 139 MB payload |
| D7 | Money-float registry: narrow, justified ceiling update (+4/+1), gate unchanged |
| D8 | Boot gate constant must equal the highest migration (v127 → v128) + golden pinned to 1.7.0 |
| D9 | REF-87 stays red until the tranche-ledger payload is aggregated (migration + dry run required) |
| D10 | Audit baseline: clippy 0 errors, npm highs fixed, 9 moderate `exceljs` advisories accepted |
| D11 | Negative-control writes are logged as `RESIDUAL-ACCEPTED` (id-shaped), never silently dropped |
| D12 | Card lane and drawer-movement amount: accepted residuals with exit criteria |

## Defects found and fixed in this cycle

- **Over-credit (review 1)**: the milestone clawback no longer rides the wallet leg → now `wallet_clawback`
  in the same transaction, clamped to the revocable balance.
- **Conservation gate bypass**: `funding.digital` was caller JSON → the card leg is derived from the durable
  ticket tenders; `wallet leg ≤ refund value`.
- **Recipient unbound**: the Avoir credit is proven against the ticket's own customer (column, else payload).
- **Mirror could erase a concurrent debit** → loyalty-only merge mirror (`saveRefundMirror`).
- **A cash payout could have no drawer movement** (any method string) → refused.
- **A void left its loyalty reversal unsaved** (Dexie-only) → written in the status-flip transaction.
- **Checkout computed loyalty from a stale snapshot** → durable row is the basis.
- **Boot gate would refuse a v128 database** → constant fixed.
- **REF-51 "flake"** → readiness wait + cap-closed dialog classified + landed-row grace.
- **REF-56 reports read race** → wait for the reports body, one retry.
- **REF-35** → spec corrected to ISO 4217 + MNY-01/02/03 (the 0,01 line is charged).

## Residual risks (honest list)

1. **REF-87 / D6**: a 4e9 ticket carries ~96–139 MB because the milestone engine writes one ledger row per
   20 000 DA tranche (200 000 rows). Refunds of such tickets are too slow for the harness (and for a
   counter). Money path is proven separately; the fix is a data-model change + migration (D9).
2. **Card refunds have no destination of record** (D12): the native scopes the card leg out with a warning
   and the money gate reports it. Card refunds are not offered in the UI; only a forged/IPC caller reaches it.
3. **`cash_move.amount` ≠ payout amount** (D12): presence is enforced; amount equality needs a schema split.
4. **9 moderate npm advisories** in `exceljs → archiver/glob` (D10): local-file parsing only; the remedy is a
   semver-major upgrade, scheduled as its own change.
5. **Renderer trust** (D11): a modified WebView can call the native refund with a forged actor; detection is
   the audit trail + oracle logging until the data-plane gateway lands.
6. **Parked (need hardware/credentials/policy)**: printer/scanner/drawer failures, CIB/Edahabia/BaridiMob
   callbacks, walk-in trade-in restore, loyalty double-burn policy. Each is registered with its reason.

## How to verify (from a clean checkout)

```bash
# 1. Native suite (refunds, voids, trust kernel)
cd src-tauri && cargo test --lib                 # 436 passed

# 2. Refund-specific proofs (real SQLite, no app needed)
npm run test:refund-mirror                       # 11 passed — a concurrent debit survives
npm run test:pending-requeue                     #  6 passed — sync_status='pending' is consumed
node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_refund_guards.mts

# 3. Static / money gates
npx tsc -b
npm run test:boundaries                          # 65 + 80 + 23 + 34 checks
node .opencode/skills/e2e-testing/scripts/selftest.mjs
node .opencode/skills/e2e-testing/scripts/reconcile.mjs

# 4. E2E refund suite (build first)
npm run build:e2e
node .opencode/skills/e2e-testing/scripts/run.mjs \
  --spec e2e-tests/specs/33-ref-refunds-part4.e2e.ts --wipe
# expected: 17 passing, 1 failing (REF-87, accepted in D9), invariants clean

# 5. Boundary proofs at 32-bit limits (diagnostic specs)
node .opencode/skills/e2e-testing/scripts/run.mjs --spec e2e-tests/diag/d4a-wallet-big.e2e.ts --wipe
```

## Known limitation of the harness

The invariant oracle intentionally prints `[INVARIANT RESIDUAL-ACCEPTED]` lines for the **deliberate
forged-refund probes** (D11). They are visible in every run and are the documented pre-gateway residual, not
hidden findings.

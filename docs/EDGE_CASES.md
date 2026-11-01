# EDGE_CASES — register (owner: C01 / full-repo ownership)

Status vocabulary: **OPEN** (no passing test / known defect), **COVERED** (test passing), **ACCEPTED**
(documented residual with a decision), **PARKED** (needs hardware, credentials or an owner/legal call).

| # | Case | Status | Linked test / evidence |
|---|---|---|---|
| 1 | Refund value exceeds the ticket's remaining refundable value | **COVERED** | `refund::tests::d4a_refund_value_cannot_exceed_the_ticket` (E-0090) |
| 2 | Avoir refund with no recipient (anonymous ticket) | **COVERED** | `d4a_wallet_leg_without_recipient_is_refused_and_writes_nothing`, diag `p0-avoir-recipient` 3/3 (E-0062) |
| 3 | Milestone clawback larger than the wallet (would drive it negative) | **COVERED** | `d4a_clawback_is_clamped_to_the_revocable_balance` (ledger reconciles) (E-0090) |
| 4 | Clawback must belong to the ticket's own customer | **COVERED** | `INVALID:clawback customer mismatch` + `d4a_clawback_revokes_in_the_same_transaction` |
| 5 | Forced wallet-write failure must roll back the whole refund | **COVERED** | `d4a_forced_wallet_failure_rolls_the_whole_refund_back` |
| 6 | Avoir wallet credit at 2^31+1 | **COVERED** | diag `d4a-wallet-big` (E-0080) |
| 7 | Avoir wallet credit at 4e9 | **COVERED** | diag `d4a-wallet-big` (E-0087) |
| 8 | Wallet balance pushed past 2^32 | **COVERED** | diag `d4a-wallet-big` past-2^32: 4,294,967,000 → 6,442,450,649 (E-0099) |
| 9 | Refund of a 139 MB ticket (payload scales with value) | **ACCEPTED (mitigated)** | selection projection D5-A; storage blow-up tracked as D6 |
| 10 | Refund submit re-entrancy (double click in one tick) | **COVERED** | `scripts/test_refund_guards.mts` (submit guard) |
| 11 | PIN approved for ticket A must not authorise ticket B | **COVERED (unit)** | `pinAuthorisesTicket` tests; E2E pending |
| 12 | Duplicate refund replay (idempotency) | **COVERED** | `exact_replay_reports_already_refunded_with_zero_side_effects` |
| 13 | Void restock off-by-one | **COVERED** | REF-13 3/3 (E-0038) |
| 14 | Write-off with an empty motive | **COVERED** | REF-36 3/3 (E-0040) |
| 15 | Credit-sale refund refused through the UI | **COVERED** | REF-65 3/3 (E-0041) |
| 16 | Deleted customer resurrected by a refund | **COVERED** | REF-40 3/3 (E-0047) |
| 17 | Overcharge on credit-covered sales (100 DA) | **COVERED** | REF-28 3/3 (E-0030) |
| 18 | Card-funded refund delivers value twice / nowhere | **COVERED (measurement)** | REF-42 3/3 after the narrow fix (E-0068) |
| 19 | Refund legs must equal the destinations of record | **COVERED (native)** | pre-COMMIT gate + 31/31 refund module (E-0090) |
| 20 | Historical DBs with unbalanced refunds | **ACCEPTED (D11/D12)** | re-proved on a retained DB: strict mode flags ONLY `REF-FORGE-*` negative-control rows (total 500 / delivered 0) and the card lane; `--exclude-forge` → 0 violations. Production DBs never carry forged ids. Exit criteria: card lane (D12) + gateway (D11) |
| 21 | Schema migration version drift (`EXPECTED_MAX_DB_USER_VERSION` 127 vs migration 128 — the boot gate would refuse a device that had migrated) | **COVERED** | D8: constant 127 → 128; `tests::base_schema_migrations_are_strictly_increasing_and_wellformed` passes (E-0096) |
| 22 | Export-manifest golden bytes drift on a release bump | **COVERED** | D8: the fixture pins `app_version` 1.7.0 instead of `env!(CARGO_PKG_VERSION)`; the golden test passes (E-0096) |
| 23 | `sync_status='pending'` stamped natively but never read | **COVERED** | boot pass `requeuePendingCustomerWrites` re-enqueues pending customers before the credential gate; 6-case test (E-0106) |
| 31 | Card leg / gate bypass via client-controlled `funding.digital` | **COVERED** | N1: leg derived from the durable ticket tenders + `wallet <= value` (E-0093) |
| 32 | Avoir credit to a customer other than the ticket's | **COVERED** | N3: ownership proven for credit and clawback (E-0093) |
| 33 | Post-commit `store_credit` mirror can erase a concurrent debit | **COVERED** | N2: loyalty-only merge mirror (`saveRefundMirror`), `scripts/test_refund_mirror.mts` 8/8 (E-0094) |
| 34 | `cash_move.amount` vs `cash_tendered` semantics | **ACCEPTED (amount, D12) / COVERED (presence)** | presence enforced for any cash payout (`d4a_cash_payout_requires_a_drawer_movement`); the amount is a drawer allocation (fixture 6000 vs 150), so equality needs a schema split |
| 24 | REF-51 offline cash-cap spec flake ("submit not clickable") | **COVERED** | root-caused: submit disabled during preview recompute + the cap switch closes the dialog. Spec waits for readiness, classifies a closed dialog as a refusal, credits a landed row. REF-51 PASS in the 17/18 batch (E-0105) |
| 25 | REF-35: 0,01 gift line charged vs spec expectation 500 | **COVERED** | spec corrected to the authority (ISO 4217 + MNY-01/02/03): basket total 500.01, paid-line refund exactly 500; REF-35 PASS (E-0102) |
| 26 | Card/cheque lane has no destination of record | **COVERED for cash-refusal + Avoir delivery** | native always-balance gate refuses a legs-empty cash refund (`INVALID:refund legs do not balance`, REF-67 PASS) and an Avoir refund delivers the digital share (REF-06 PASS, cashDisbursed 0, drawer untouched). A real acquirer refund table remains D12 |
| 27 | Walk-in trade-in restore (anonymous) | **PARKED (policy)** | `docs/c01-ref15-loyalty-pack.md` family; REF-49 evidence |
| 28 | Loyalty double-burn + G-07 after a conversion refund | **PARKED (policy)** | REF-15 pack |
| 29 | Hardware: printer/scanner/drawer failures | **PARKED** | no hardware in the sandbox; simulator not yet built |
| 30 | Payment rails CIB/Edahabia/BaridiMob timeouts & duplicate callbacks | **PARKED** | no acquirer credentials; contract-level only |

| 39 | Reports modal read after a refund ran before the view rendered (REF-56 flake) | **COVERED** | harness waits for the reports body / PIN gate and retries once; REF-56 PASS (E-0100) |
| 40 | REF-87: a 2e9/unit ticket could not be refunded within a reasonable window | **COVERED** | D6-A: the milestone ledger is one row per tranche RANGE; the full 33-ref batch is 18/18 with a clean oracle (E-0118); compaction migration proven on a DB copy, 76.1 MB → 1.6 KB with backup (E-0119) |
| 41 | Void lane left its loyalty reversal unsaved (G-07) | **COVERED** | fixed: `voidTransactionAtomic` writes the loyalty patch + money deltas inside the status-flip transaction; REF-48 GREEN, G-07 gone (E-0104) |
| 42 | A forged refund call from the renderer records an audit row for an unknown actor (G-15) | **ACCEPTED (documented pre-gateway residual)** | AGENTS.md "WebView SQL bypass (OPEN residual)"; REF-58 deliberately forges the call to prove dedupe (E-0100) |

| 43 | Dependency advisories (npm prod tree) | **ACCEPTED (moderate) / FIXED (high)** | D10: zod + source-map-js highs fixed by patch bumps; 9 moderate in exceljs→archiver/glob accepted pending a planned major upgrade (E-0101) |

| 44 | Forged/native-only refund leaves the in-memory snapshot stale; a later sale rewrites the pre-write bucket | **COVERED** | checkout now reads the durable customer row before computing loyalty (`processPayment`); REF-24 green, invariants clean (E-0105) |

| 45 | A loyalty headline that no bucket backs (legacy rows, seeded fixtures) | **COVERED** | hydration mints one deterministic legacy-genesis bucket for the unbacked remainder (idempotent); `scripts/test_loyalty_backing.mts` 11/11, REF-15 green (E-0127) |
| 46 | Credit minted by a points→Avoir conversion redeemed its points again at checkout (400 → 372) | **COVERED** | `creditFromPointsDzd` marker + `splitCreditRedemption`; lpAfterSale 412, unit proofs 11/11 (E-0127) |

## Notes

- Items 1–7 and 10–19 are covered by tests that run in CI-local (`cargo test` + the diag specs).
- Items 21/22 are pre-existing library failures; `git log`/`git diff` prove `lib.rs` and `trust_core/` were
  never touched by this work, so they are registered as independent defects to fix next.
- Item 8 is a harness limitation (seeding the wallet near 2^32 does not survive checkout); the native
  increment itself is proven at 2^31+1 and 4e9.

| 35 | Outbox/Dexie pushed the pre-commit customer snapshot (a debit's pending payload could be replaced; the 64 KB cap could shed the ledger) | **COVERED** | F1: mirror returns the committed snapshot and the refund enqueues THAT; money keys are protected in `payloadHygiene` — `test_refund_mirror.mts` + `test_h24_payload_hygiene.mjs` (E-0095) |
| 36 | Milestone revocation mirrored twice (TS row + native row, ids never match) | **COVERED** | F2: `clawbackLedgerForMirror` is the single tested gate — `test_refund_mirror.mts` (E-0095) |
| 37 | Legacy double-encoded ledger: append silently did nothing | **COVERED** | F3: `json_type(...) = 'array'` guard + a 0-row warning — `test_refund_mirror.mts` (E-0095) |
| 38 | Mirror patched/version-bumped a soft-deleted customer row | **COVERED** | F4: `AND deleted = 0` — `test_refund_mirror.mts` (E-0095) |

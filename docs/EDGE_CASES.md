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
| 8 | Wallet balance pushed past 2^32 | **OPEN** | diag case exists; harness seeding not yet green |
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
| 20 | Historical DBs with unbalanced refunds | **OPEN** | money gate 16 violations in 25 DBs (E-0067) — pre-D4-A data |
| 21 | Schema migration version drift (`EXPECTED_MAX_DB_USER_VERSION`) | **OPEN** | `tests::base_schema_migrations_are_strictly_increasing_and_wellformed` (E-0091) — pre-existing, files untouched by C01 |
| 22 | Export-manifest golden bytes drift | **OPEN** | `trust_core::export_snapshot::tests::manifest_canonical_bytes_are_stable_golden` (E-0091) — pre-existing |
| 23 | `sync_status='pending'` stamped natively but never read (no drain) | **OPEN** | review finding 5 |
| 24 | REF-51 offline cash-cap spec flake ("submit not clickable", 1 in 5) | **OPEN** | E-0033 |
| 25 | REF-35: 0,01 gift line charged vs spec expectation 500 | **ACCEPTED (authority: ISO 4217 + MNY-01)** | decision pack `docs/c01-ref35-minor-unit.md`; spec fix pending |
| 26 | Card lane has no destination of record | **OPEN** | REF-42 decision pack; money gate reports it |
| 27 | Walk-in trade-in restore (anonymous) | **PARKED (policy)** | `docs/c01-ref15-loyalty-pack.md` family; REF-49 evidence |
| 28 | Loyalty double-burn + G-07 after a conversion refund | **PARKED (policy)** | REF-15 pack |
| 29 | Hardware: printer/scanner/drawer failures | **PARKED** | no hardware in the sandbox; simulator not yet built |
| 30 | Payment rails CIB/Edahabia/BaridiMob timeouts & duplicate callbacks | **PARKED** | no acquirer credentials; contract-level only |

## Notes

- Items 1–7 and 10–19 are covered by tests that run in CI-local (`cargo test` + the diag specs).
- Items 21/22 are pre-existing library failures; `git log`/`git diff` prove `lib.rs` and `trust_core/` were
  never touched by this work, so they are registered as independent defects to fix next.
- Item 8 is a harness limitation (seeding the wallet near 2^32 does not survive checkout); the native
  increment itself is proven at 2^31+1 and 4e9.

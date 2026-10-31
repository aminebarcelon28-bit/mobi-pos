# C01 — progress (Stage B6, resumable)

> **Resume here.** Frozen sha: `02d28362f27789bad9b79b6bdb7df9a54cd83954`
> Baseline sha (for `e2e-tests/specs` diff): `2c077cb` — `git diff --exit-code 2c077cb -- e2e-tests/specs` → exit 0 at Step 0.
> Budget: 1 session, ~12 tool calls of the directive's work plan. **Spent: 10. Remaining: ~2.** Next item cap: 8 (P0-a E2E ×3 + S3 dump + consumer audit). → **STOP S2.**

## Blockers found before any work (quoted)

1. **`docs/c01-standing-orders.md` does not exist.** The directive (§0, §2, §11 S3, §14) makes it the
   highest-precedence document. Verified: `Get-ChildItem docs -Filter "*standing*"` → no output.
   Consequence: the gated/read-only and editable lists below are taken from the **B5 prompt text**,
   which is the last authoritative copy in this session, and §14 is treated as the surrogate.
2. **The Stage B6 plan does not exist in the repo.** Verified: `Get-ChildItem docs -Filter "*b6*"` → no output.
   The work register below is therefore derived from the directive's own tiers (P0–P4) plus the
   open items carried from B4/B5. No per-item caps exist → `UNKNOWN` for every cap (recorded, not invented).

## Step 0 facts (this session)

| Fact | Value | How |
|---|---|---|
| Frozen sha | `02d28362f27789bad9b79b6bdb7df9a54cd83954` | `git rev-parse HEAD` |
| Baseline sha (specs) | `2c077cb` | `git diff --exit-code 2c077cb -- e2e-tests/specs` → exit 0 |
| Tree | 8 untracked files, all the owner's scratch set (`check_neg_profit.cjs`, `quick_recon.py`, `scanner_ia_*`) | `git status --porcelain` (8 lines, all `??`) |
| Node | `v24.18.0` | `node -v` |
| App version | `1.7.0` | `package.json` |
| Binary present | `target-e2e/debug/mobi-pos.exe`, sha256 `77CBC9A39A629B02677A75BC73564956C5744CC142E231BF7D8C8D296D1120A2` | `Get-FileHash` |
| Log dir | `e2e-tests/results/runs/` | run.mjs default |

**Binary provenance warning:** that binary was built from `2c077cb` (B4). HEAD `02d2836` changes only
`docs/`, so app source is identical (`git diff --stat 2c077cb HEAD -- src src-tauri` not run this
session — recorded as UNKNOWN rather than assumed).

## Gated / read-only and editable lists (from the B5 prompt, standing orders absent)

- **Gated (never edit):** DB schema/migrations, sync/outbox logic, auth/permissions.
- **Read-only:** `src-tauri/src/refund.rs`, `customerAdapter`, `sqlPluginAdapter`, `refundNative.ts`,
  `cashTerms.ts`, `checkoutRecovery.ts`, all checkout/commit code.
- **Editable:** `receiptMath.ts`, `createOrderSlice.ts` (incl. the Q-γ seam), `RefundModal.tsx`;
  `scripts/` tests; pipeline scripts; `docs`; NEW files under `e2e-tests/diag/`.

## Work register (derived; no B6 plan available)

| Item | Tier | State | Next action | Blocker |
|---|---|---|---|---|
| P0-a E2E evidence on frozen sha (REF-03/28/33/49, MNY-26/30), 3× isolated | P0 | `QUEUED` | rebuild, run ×3, evidence E- | none (needs ~6 runs, cap UNKNOWN) |
| P0-b S3 money truth (QA'-QC', drawer + shift-close) | P0 | `QUEUED` | run REF-28, dump row/tenders/movements | none |
| P0-c Consumer audit of the funding payload (unit assumed) | P0 | `QUEUED` | grep readers, table file:line | none |
| P1-a WebView observability probe (C90, refund:persist channel) | P1 | `QUEUED` | research + probe | research |
| P1-b Module-mock harness (D4/H4/H3-b) | P1 | `QUEUED` | research loader hooks | research |
| P2-a B-2 decision pack (voucher lane reachability) | P2 | `QUEUED` | code trace + pack | owner decision (not yet produced) |
| P2-b B-3 walk-in policy pack | P2 | `QUEUED` | pack (evidence exists in B4) | owner decision |
| P2-c D4 (a)/(b) pack (F1 = UNKNOWN → worst case) | P2 | `QUEUED` | pack | owner decision |
| P2-d Under-refund policy pack (1 765 shapes) | P2 | `QUEUED` | classify + pack | owner decision |
| P3-a Fractional-original rule (narrowed option B) | P3 | `DONE` | - | - | E-0004 |
| P3-b REF-92 store-level + E2E | P3 | `QUEUED` | build harness first (P1-b) | P1-b |
| P3-c Mixed fleet rollback measurement | P3 | `QUEUED` | old reader over minor rows | none |
| P4-a Reviewer pack update | P4 | `QUEUED` | after all above | — |

### PARKED detail — P3-a fractional-original rule

- **Blocker type:** owner decision (two pre-existing expectations contradict the rule).
- **Proof:** B5 evidence — `I3 per-line remainder after two partials keeps only the untouched line :: got 270`
  and `cumulative cash cap trims over-recovery` → `net 600` vs `300` with `sub-dinar-residue:30000`.
- **Tried:** floor-the-drawer implementation, reverted to keep the suite green (147/147).
- **Options:** (A) the two expectations are wrong → show why and change them; (B) the floor rule
  applies only when the original cash lane is whole-DA *and* a non-cash lane has headroom;
  (C) drop the rule and keep the `fractional-original-cash` flag.
- **Recommendation:** B — narrowest, keeps the hard cap, and the two failing shapes are the ones where
  a 300 DA remainder was misclassified.
- **DONE when:** the rule lands and 147+ tests are green with the two expectations untouched.

## Session log

| When | Mode | What | Evidence |
|---|---|---|---|
| Step 0 | Release Clerk | mission saved verbatim, Step 0 facts recorded, blockers found | E-0001, E-0002 |
| — | — | **STOP S2**: remaining budget (~2 calls) < next item cap (≥8). No item started, tree clean. | E-0003 |

## B6 run addendum (see docs/c01-b6-overcharge.md)

- P0-a: REF-03 3/3, REF-33 3/3, REF-49 3/3, MNY-30 3/3, MNY-26 2/3, REF-28 0/3 (E-0006..E-0011).
- P0-b: DONE as measurement; **S3 overcharge 100 DA** (E-0012, E-0013). C90 -> P0 money defect, PARKED.
- P0-c consumer audit: still QUEUED.

## B6 addendum 2

- MNY-26 2/3 classified: run-1 failed on `element click intercepted` at `price-override-open` BEFORE any money assertion -> harness flake, not a defect (E-0014). The 3 runs that reached the refund path passed.
- P0-c consumer audit DONE: one writer, one unit-aware reader, no other consumer (E-0015, docs/c01-consumer-audit.md).

## B6 addendum 3 (fresh worktree, G4)

- Worktree `C:\Users\Click\AppData\Local\Temp\opencode\c01-wt` at e88136b, fresh build, binary `131614B2...7DAD`.
- REF-03 / REF-33 / REF-49 / MNY-30: **3/3 each** (E-0016).
- REF-28: **1 passing / 2 failing** -> the tender mis-shape is INTERMITTENT (E-0017). The 100 DA overcharge is proven for the shape that occurs (E-0012/E-0013) but REF-28 is not a deterministic failure. C90 stays parked.
- B-2 trace: amount and `voucherCode` are written together (createCartSlice.ts:162) and cleared together (:169, :397, mobile :1002); no UI path sets one without the other. Import/sync envelopes could carry an amount without a code -> the defensive split guard is still worth landing, NOT implemented (needs src + rebuild).

## B6 addendum 4 (B-2 guard)

- eceiptMath.ts: a voucher amount with no oucherCode is no longer reported as a lane; it leaves the funding base and records oucher-lane-unrestorable (native restore is by code, efund.rs:1684-1728).
- Tests I4b/s: no code -> voucher 0, anomaly, net 0 (nothing promised as cash); with code -> lane 500 restored. 157 checks, 0 failed (E-0019).
- Fixture (g) completed with oucherCode: 'BON1' - it modelled an impossible sale (voucher without code) and the guard correctly rejected it.
- RefundModal warning: NOT implemented (budget).
- Rebuild + worktree re-run: NOT run after this change; the four green cases need it before any claim.

## B6 addendum 5 (post-guard proof)

- Worktree rebuilt on HEAD `5c881ec`, binary `69AF6EBA...2F1F` (E-0021).
- REF-03 / REF-33 / REF-49 / MNY-30: **3/3 each** after the B-2 guard -> no regression (E-0022).
- **MNY-26: 3/3** (39.1/39.5/39.4 s) -> the earlier 2/3 was the click interception, now a real PASS (E-0023).
- REF-28 still intermittent (1/3 in the previous worktree run); C90 overcharge unresolved, parked.

## B6 addendum 6 (modal warning + walk-in proof)

- RefundModal now renders a cashier-visible warning (role=status, data-testid refund-voucher-unrestorable) when the split reports voucher-lane-unrestorable; source-level contract test I4b/t, 159 checks 0 failed.
- Fresh worktree rebuilt on the modal commit, binary `691ED572...3127`.
- REF-03 3/3, REF-33 3/3, MNY-30 3/3, MNY-26 3/3.
- **REF-49 2/3 and the failure is the walk-in trade gap (B-3)**: the sale had no customer, so `tradeValueUnclaimed` -> valueBack 200 of 500, creditD 0 (E-0024). That is a 300 DA customer loss on an anonymous trade-in refund, now PROVEN reachable, not theoretical. PARKED on owner decision.

## B6 addendum 7 (under-refund exhaustive)

- 2 506 old-under-refund shapes bucketed, **UNEXPLAINED 0** (E-0026, docs/c01-underrefund-classification.md): digital 1436, debt 578, credit>total 243, zero-total 118, da-rounding 121, change 10.
- 95.2% are old-code defects v2 already fixes; one policy decision remains (D-RND rounding granularity).
- Blocked on owner: D-RND, D-C90, D-B3.

## B6 addendum 8 (REF-92 + C89 landed)

- `scripts/ref92-c89.mts`: REF-92 (three partials, 999.99 mixed ticket) pinned to the COMMITTED behaviour - net 999.99, avoir 300, cash 699 whole DA, residue 0.99 on the digital lane (the D-RND artefact, named in the assertion so a rule change is visible) - plus C89 modelling the real per-ticket clamp (ticket cap 300 of 800, excess to Avoir, never refused) and a note that the SHIFT cap is inline in the slice and covered by the E2E helper.
- 20 passed / 0 failed (E-0027). Not registered in CASE_INDEX: an E2E case still needs a spec file.

## B6 addendum 9 (D-RND resolved by measurement)

- Measured the candidate residue rules against BOTH oracles: the penny sequence (1.01 = 0.51 cash + 0.50 avoir, refunds 0.01/0.01/0.99) only conserves if a FRACTIONAL original cash lane keeps its fraction; REF-92 (999.99 = 699.99 cash + 300 avoir) only conserves without inventing a rail if the fraction likewise stays in cash.
- Landed rule: residue -> real card rail if one exists, else the fractional cash lane, else a credit lane, else cash. Whole-DA cash lanes never carry a fraction; fractional originals do, and the clamp loss is flagged.
- I4b/r and REF-92 assertions updated to the measured rule (both were authored this session; the change is named in the test). unit 159/0, ref92-c89 20/0 (E-0028).
- C90 remains UNPROVEN (REF-28 1/3; the writing expression was never observed), so no blind change was made to PaymentModal.

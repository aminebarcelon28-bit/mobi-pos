# Human actions — c01-rc6 work

## HAR-001 — money-boundary gate: 58 vs 54 (owner decision) — corrected 2026-11-02

- **What:** `node scripts/check-money-boundary.mjs` is **64/65**, failing on
  `src/store/slices/createOrderSlice.ts: 58 <= 54`.
- **Corrected provenance (verified, replaces the earlier attribution):** the four extra hits did
  **not** arrive with `8c1fcf4` — the file already had 58 there. They arrived with **`177e6b1`**
  (REF-66 Avoir leg, 2026-11-01 08:26): `54 -> 58`, and no later commit changed the count.
  `177e6b1` is an ancestor of `c01-rc-5`; the script, registry and slice are byte-identical at
  `c01-rc-5` and `HEAD`. **The CI-blocking money gate is therefore also red at the existing
  candidate.**
- **Exact four lines (177e6b1):** `reliefPlanned`, `voucherPlanned`, `cashPlanned`, and the
  `Math.round(netRefund)` term of `uncoveredCredit` (`createOrderSlice.ts:2996-3001`).
- **Unit analysis:** `RefundFundingSplit` returns **DA floats** (`fromMinor` divides centimes by
  100). `voucherShare` and `netRefund` are such floats, so their `Math.round` is a semantic
  integer-DA conversion, not a redundant wrapper. `relief` (`reliefAmt`) and `cashOut`
  (`clampCashRefund`) are already integers, so those two wrappers are redundant — but removing
  only them leaves **56 > 54**, and removing all four would let fractional DA reach the native
  `i64` balance gate (`refund.rs` pre-COMMIT conservation) — a behavior change, not an
  equivalence.
- **Decision needed:** which of these is authorized?
  - **(B, recommended) reconcile the registry 54 → 58**, with a comment naming `177e6b1` and
    stating the four hits are integer-DA boundary conversions of a float-DA split type; then a
    separate Stage E task unifies refund money on minor units. Rationale: the code is already in
    `c01-rc-5`; the cap is stale, not the code new.
  - **(A) Stage E refactor** of `RefundFundingSplit` + this slice to minor units, with
    fractional-cent boundary tests: larger, changes money-path code, needs its own brief.
  - **(C) waive the gate** for `c01-rc-6` (and state the disposition of `c01-rc-5`, which shares
    the same failure).
- **Time:** B ≈ 1 min + CI run; A ≈ 1–2 days with tests; C = decision only.
- **Unblocks on approval:** tag `c01-rc-6` (B) or a scoped money refactor (A).

## HAR-005 — is the design-token ratchet a release criterion? (owner decision)

- **What:** `node scripts/check-design-tokens.mjs` reports **39 file violations** (24 files over
  their pinned debt, 15 files absent from the baseline with debt > 0).
- **Verified provenance:** total debt is **identical** at `c01-rc-5` and `HEAD` (5975 items
  across 103 files, zero per-file deltas). The baseline was last written 2026-10-16
  (`d913b4c`); the violating files were changed by later commits (`2193436`, `bdca981`,
  `1a1f8d1`, `8c1fcf4`, …). Nothing this branch touched is in the violation set.
- **Gate wiring:** **not** in `.github/workflows` (neither CI nor release) and **not** in
  `npm test`; it is reachable only as `npm run test:tokens`.
- **Decision needed:** (i) declare it non-blocking for `c01-rc-6` (recommended: it is not a
  recorded release criterion), or (ii) adopt it as a criterion and authorize the remediation
  lane, or (iii) authorize a baseline refresh — the last would bless 437+ inherited growth items
  and should not be done casually.
- **If remediation is later authorized:** per-file mapping only, reviewed against the semantic
  token families (`surface-*`, `line-*`, `fg`, `muted`, `status-ok/warn/danger`) and re-run
  `check-contrast`; no blind substitutions.

## HAR-002 — physical ESC/POS printer session (R4)

- **What:** a 58 mm and an 80 mm printer (one genuine Epson or best-documented equivalent, one
  common budget clone).
- **Why:** 4 cases are hardware-only (RCP-19/24, TIM-09/10) and the paper leg of 8 MIXED cases
  (codepage, raster, width, cut, kick) cannot be proven from bytes.
- **Steps:** run `agent/triage/26-rcp.md` §hardware kit (self-test receipts, rubric, photo
  naming), then feed results through `verdicts.mjs --write-index`.
- **Time:** ~2 h for the full matrix.
- **Unblocks:** RCP-01/02/10/11/12/19/21/22/24 + TIM-09/10 and the 3 partials' paper leg.

## HAR-003 — merchant gateway + enrolled device keys (R3, Tier B)

- **What:** a real merchant sync gateway endpoint, with each terminal's Ed25519 pubkey enrolled.
- **Why:** 10 of the 17 blocked 24-syn cases need a second peer; the signed lane is proven only
  against the loopback verifier today.
- **Steps:** deploy `proxy/gateway.mjs` behind the merchant origin (or the real backend), enroll
  device pubkeys, set `sync.gateway_url` + per-device sync credentials.
- **Time:** ~1 day including credential provisioning.
- **Unblocks:** SYN-05/06/07/11/19/21/22/23/28/29 (and turns the 6 PASS-SIM candidates into
  headline-eligible runs).

## HAR-004 — fiscal numbering decision for SYN-02

- **What:** confirm the fiscal rule for receipt/invoice/ticket numbering across terminals
  (merchant-scoped sequence vs device-prefixed sequence) before the R2 fix.
- **Why:** both are defensible; the choice changes the migration and the printed number format.
- **Time:** a decision, then ~half a day to implement + migrate.

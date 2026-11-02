# Human actions — c01-rc6 work

## HAR-001 — money-boundary gate is red on a pre-existing delta (owner decision)

- **What:** `node scripts/check-money-boundary.mjs` is **64/65**. It fails on
  `src/store/slices/createOrderSlice.ts: 58 <= 54 — got 58, allowed 54`.
- **Why it is not mine to resolve:** the file is unchanged since `c01-rc-5`; the four net-new
  `Math.round` hits arrived with `8c1fcf4` (the mid-run sec/shf fix: refund total-leg rounding
  `reliefPlanned`/`voucherPlanned`/`cashPlanned`). The guard deliberately allows counts to
  *decrease only*; raising the registry is a policy change, and rewriting four money-path lines
  is outside this brief's scope.
- **Exact options:** (a) rewrite those four sites to integer helpers and keep 54; (b) authorize
  raising the registry entry to 58 with a one-line justification (the values are integer dinars).
- **Time:** ~30–60 min for (a), 1 min for (b).
- **Unblocks:** the `boundary` gate, and therefore checkpoint tag `c01-rc-6`.
- **Also red, pre-existing, untouched by this branch:** `scripts/check-design-tokens.mjs`
  (ratchet violations across `settings/*`, `Shift*Modal`, `TradeInBuybackModal`, …). Not in the
  brief's gate list; listed here so it is not mistaken for a new regression.

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

# C01 research log

Header versions (this session): node v24.18.0, app package.json 1.7.0.
No research entry yet: the session stopped at Step 0 (budget S2) before P1-a/P1-b research targets.

| question | source URL | version | access date | finding | meaning here | verified by | status |
|---|---|---|---|---|---|---|---|

### R-004 - refund-to-original-tender semantics (REF-42 / REF-65 payout lanes)

| field | value |
|---|---|
| question | For a card-funded sale, where may the refund value go? |
| source | https://docs.stripe.com/refunds (section "Refund destinations") |
| version | stable documentation page, no version tag; accessed 2026-10-31 |
| what it says (own words) | A card refund can only be sent back to the original payment method; it cannot be redirected to another card or bank account. Refunds to expired/cancelled cards are handled by the issuer. |
| meaning for this repo | The terminal has no acquirer integration, so it cannot actually push the money back to the CIB rail. Its own audit line admits this ("rail d'origine a reverser ... jamais en especes", createOrderSlice.ts:2695). Cash is therefore wrong for a card sale (and the native lane already refuses it: INVALID: cash refund without drawer movement), and any fallback that keeps the value for the customer (wallet credit or store voucher) is a MERCHANT POLICY choice, not something the card rules decide. |
| what I verified here | REF-65: a debt-only (credit) sale refunds with cash 0 and debt relief (E-0041). REF-42: a CIB sale refunds into the wallet once (col=payload=700, no vouchers, E-0044) and the case's own measure counts that one credit twice. |
| status | RESEARCHED (external), reproduced here only in the sense that the native lane refuses cash on a card sale - observed in the REF-42 log |
# Edge-case matrix

Rows are ranked by how often they produced a real finding in this product. "Always" rows are
the default Gate 2 set; the rest are selected by what the change touches. Generic rows that
never applied here were removed on purpose - this is not a checklist to fill in, it is a list
of things that already bit us.

| # | Trigger | How to test it here | Expected | Priority |
|---|---|---|---|---|
| 1 | Two outputs describe the same money | assert `collected == committed == stored`, `export cell == headline` | identical | Always |
| 2 | Rounding at a half-cent / half-dinar boundary | price 0.01, 10 % discount, qty 3; x.005 / x.015 / x.025 | one documented rounding rule, same everywhere | Always |
| 3 | Stacked discounts, then a full refund | sale with two discounts, refund all lines | refund == collected, not == stored total | Always |
| 4 | Empty cart checkout | press pay with 0 lines | button disabled or typed error, no sale row | Always |
| 5 | Double-submit (pay, refund, shift close) | click the confirm twice in 50 ms | exactly one row, one receipt number | Always |
| 6 | Overlay/modal left open | `listDialogs()` before blaming a click | the flow either closes it or refuses | Always |
| 7 | Money text parsing | Arabic-Indic digits, U+2212 minus, U+00A0/U+202F separators | `displayedToMinor` round-trips exactly | Always |
| 8 | Quantity 0 / negative / decimal | type `0`, `-1`, `1.5` into the qty field | rejected with a message, cart unchanged | Always |
| 9 | Max length and unicode in names | 67-char product name, emoji, Arabic, RTL mixed | no code-point split, no column overflow crash | When touching labels/receipts |
| 10 | Barcode duplicate / reuse after delete | create, delete, create with the same barcode | second create refused; lookup misses after delete | When touching catalog |
| 11 | Search with 1 character | type `a` in the catalog search | bounded result set; measure p95 and rendered nodes | When touching catalog/search |
| 12 | List at 100k+ rows | seed 100k in `tx()`, then boot and scroll | p95 within the pre-written threshold, bounded memory. **1M is BLOCKED in the WebView**: seed and time it Node-side (`tools/27e-prf-checks.mts:233`) and label the result a lower bound - 100k is the WebView ceiling | When touching adapters/lists |
| 13 | Out-of-band write then UI read | seed via `lib/db.ts`, do **not** reload | document whether the UI is stale (that is the finding) | When touching cache/mirror |
| 14 | Sale committed, then app killed | `taskkill` mid-checkout, restart, inspect rows | either fully committed or fully absent | When touching checkout/DB |
| 15 | Offline sale, then reconnect | airplane mode on mobile / gateway unset on desktop | queued, ordered, replayed once | When touching sync |
| 16 | Outbox ordering under retry | force a 409 gap from the loopback gateway | rows re-sent in `seq_no` order, no duplicates | When touching sync/outbox |
| 17 | Clock change / DST / timezone | `tools/tim09-timezone.mjs` pattern: same fixture, two TZ | same business day, same totals | When touching time/reports/printing |
| 18 | Period boundary | report for a single day, and for `[start, end)` | totals match a hand-written SQL `SUM` | When touching reports |
| 19 | Session expiry / lock mid-flow | lock the terminal during a cart, then unlock | cart preserved or explicitly cleared, no silent loss | When touching auth/session |
| 20 | Wrong role reaches a manager action | cashier opens a manager-gated modal | PIN gate, or typed refusal | When touching permissions |
| 21 | Direct IPC call bypassing the UI | `invoke('refund_sale_atomic', ...)` while locked | typed `CODE:detail` denial | When touching native commands |
| 22 | Legacy data on an upgraded DB | boot the binary on an upgraded-shape DB copy | migrations heal, no data loss, version monotonic | When touching migrations |
| 23 | Deleted record still referenced | delete a customer with an open credit | refused, or cascade documented | When touching deletes |
| 24 | Large file import (100k CSV, bad rows, duplicates) | kill/resume mid-import | partial import is atomic or resumable, never half-written | When touching import |
| 25 | Export at the size cap | 200 000 and 200 001 rows, Node-side (`27d-rpt-checks.mts`) | below cap succeeds, above cap returns `TOO_LARGE`; a WebView export case tops out at 100k rows | When touching export |
| 26 | Print failure | make the spooler fail, then retry | user-visible failure, no silent drop | When touching printing |
| 27 | Reprint | print twice | second copy marked, same totals | When touching receipts |
| 28 | Keyboard-only flow | Tab through checkout, `setWindowSize(800,600)` | primary action reachable and not clipped | When touching layout |
| 29 | HID scanner terminator variants | synthetic burst ending in Enter, then in Tab | both add exactly one unit | When touching scanning |
| 30 | Mobile viewport / touch target | 1080x2424, one-handed reach | no clipped action, no hover-only affordance | When touching mobile |
| 31 | Arabic / French UI strings | switch language, check truncation and RTL order | no mojibake, no reversed numbers | When touching i18n |
| 32 | Empty state | fresh sandbox, no products/customers/sales | explicit empty message, no crash, no `NaN` | Always |
| 33 | Idempotency of a retried command | send the same refund twice | second is rejected or deduped, never double-applied | When touching money commands |
| 34 | Rollback after a partial failure | make the second line of a 3-line sale fail | nothing committed, stock unchanged | When touching transactions |

## Selection rule

For a normal change, take row 1, 2, 4, 5, 6, 32 plus the two rows matching the domain you
touched. For a money change, add 3, 33, 34. For a data/migration change, add 14, 22, 23.
For a scale change, add 11, 12, 25 and write the threshold down first. For sync, add 15, 16.
For printing, add 9, 26, 27. For UI, add 28, 30, 31.

## Rows that are BLOCKED in this environment

Do not weaken these into a different case. Name the missing thing and move on.

| Row | Needs |
|---|---|
| 15, 16 | a real merchant gateway with enrolled device keys (the loopback verifier is test-only) |
| 12 at 1M, 25 above 100k in the WebView | 1M rows cannot be seeded or rendered through the UI/IPC (300 s mocha timeout + WebView heap). Measure Node-side and label the number a lower bound; 100k is the WebView ceiling |
| 30 on a low-end device | a real Android device; the `MobiLite` AVD currently exits code 4 |
| 26, 27 physical | a real ESC/POS printer and label rolls |
| 29 physical | a real HID wedge; synthetic bursts are the substitute and prove the parser, not the device |

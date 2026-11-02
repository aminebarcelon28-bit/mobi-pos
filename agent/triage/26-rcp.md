# Triage — 26-rcp (29 cases: 3 PASS · 16 FAIL · 4 BLOCKED · 4 N/A · 3 partial)

Register basis: `docs/non-refund-suite-register.md` (all 16 FAILs share one environment cause:
the assertions depend on printer firmware behaviour the sandbox spooler does not provide).
No FAIL is called a product defect here: the product × helper 2×2 bisect has not been run for
these cases, and the register's own evidence points at the helper.

Buckets: **SW** = software-verifiable today (encoder bytes / column math / template strings /
injected clock) · **HW** = hardware-only (paper legibility, physical cut/kick/scan) ·
**MIXED** = SW half runnable now, HW half needs the device.

| Case | Assertion | Bucket | SW verification method (now) | HW part that stays BLOCKED |
|---|---|---|---|---|
| RCP-01 | Arabic / French / mixed line in text vs raster | MIXED | encoder golden bytes: codepage select + raster command sequence; bidi/shaping choice per UAX #9 | legibility on firmware |
| RCP-02 | 58/80 mm widths (32/42/48 chars), long names | MIXED | column math per printer profile; wrap decisions asserted | actual wrap on paper |
| RCP-05 | Reprint marked copy, same number, no new sale | SW | DB + template assertions; no printer needed | — |
| RCP-07 | 20-job queue, close with pending jobs, reconnect | SW | queue persistence + drain order against a file/TCP sink | physical reconnect |
| RCP-08 (partial) | UI blocked by hung printer | SW | hanging sink + timeout assertion | — |
| RCP-10 | Drawer kick on cash, not card; no-sale permission | MIXED | byte assertion (`ESC p`) + permission denial | physical pulse |
| RCP-11 | QR/barcode scannable, fits width | MIXED | symbol module math + command bytes | scan on paper |
| RCP-12 | Logo/header/footer, œ é ç, Arabic punctuation | MIXED | raster/bitmap bytes + string table | printed output |
| RCP-13 | Negative amounts, separators, Arabic-Indic digits | SW | formatting assertions (pure string) | — |
| RCP-15 | Gift/refund/trade-in/repair/Z/deposit documents | SW | template + totals assertions | — |
| RCP-16 | Date/time vs DST/timezone/clock change | SW | injected clock (compile-gated) + stamp assertions | — |
| RCP-18 | Header shows cashier/drawer/device/reprint marker | SW | template assertions | — |
| RCP-21 | Mixed-direction header ("Caissier: محمد") | MIXED | raster shaping golden bytes | legibility |
| RCP-22 | IMEI/serial + barcode on 58 mm, two IMEIs | MIXED | width math + barcode bytes | scan |
| RCP-23 | Warranty footer variants in ar/fr | SW | template assertions | — |
| TIM-02 | Timezone change on device | SW | injected TZ + clock | — |
| TIM-07 | NTP resync jump during a sale | SW | injected clock jump + sale stamp | — |
| RCP-19 | Same sale printed from desktop (USB) and mobile (BT) | HW | — | two transports/devices |
| RCP-24 | Remote print: mobile finalizes, desktop prints | HW | — | two devices + transport |
| TIM-09 | Mobile in another timezone/VPN/roaming | HW | — | device + network |
| TIM-10 | Device asleep for days, jobs/token resume | HW | — | device |
| RCP-08 (rest), TIM-03, TIM-06 (partials) | bytes asserted, paper leg end open | MIXED | keep the byte half; TIM-03/TIM-06 already exercise injected date/schedule | paper leg |

**Summary:** SW 10 (RCP-05/07/08/13/15/16/18/23, TIM-02/07) · MIXED 8 (RCP-01/02/10/11/12/21/22 + the 3 partials' paper leg) · HW 4 (RCP-19/24, TIM-09/10).
Every SW case is verifiable today through a byte-capture sink + decoder oracle; none is promoted
to PASS without a run. MIXED cases can be split: encoder half PASS now, paper half BLOCKED.

## Hardware verification kit (R4 deliverable)

`hardware/` needs (not built here — physical session required):

1. `runbook.md` — order of operations, one page: power, paper, self-test, then the six receipts.
2. `selftest-receipts.md` — codepage chart (CP437/850/1252/864 if present), French accents
   (é è ç œ), Arabic raster sample, currency formats (1 234,56 DA / دج), barcode + QR,
   width ruler at 32/42/48 chars, cut, drawer kick, logo block.
3. `rubric.md` — pass/fail per row with photo-evidence naming `<case>-<printer>-<date>.jpg`.
4. `intake.md` — how the operator's results are entered so verdicts go through
   `verdicts.mjs --write-index` (no hand edits).

Minimum matrix: one 58 mm + one 80 mm; one genuine Epson (or best-documented equivalent) + one
common budget clone (codepage tables differ most here).

## R4 research answers (recorded once, reused)

- ESC/POS: `ESC @` init, `ESC t n` codepage, `GS ( L` / `GS v 0` raster, `ESC d n` feed,
  `GS V` cut variants, `ESC p m t1 t2` drawer kick — semantics and model variance per the Epson
  reference; clone firmware frequently ignores codepage select for non-ASCII.
- Printer capability data: an `escpos-printer-db`-style profile (JSON) is a better source than
  hard-coded tables; adopt only if license/maintenance vetting passes (not adopted here).
- Arabic/RTL: codepage text is unreliable on cheap clones; software-shaped raster (UAX #9 bidi +
  a shaping engine) is the robust path. Printable dot widths: 58 mm ≈ 384 dots, 80 mm ≈ 576 dots
  at 203 dpi (vendor docs) — assert against the profile, not a constant.

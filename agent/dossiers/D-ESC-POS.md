# D-ESC/POS — capture sink, parser, goldens and the hardware kit (RCP queue item 3)

**Date:** 2026-11-03 · **Evidence:** E-0166 · **ADR:** ADR-004

## What exists now

| Piece | File | Purpose |
|---|---|---|
| Virtual printer | `scripts/escpos_sink.mjs` (`npm run escpos:sink`) | raw TCP listener (default 9100, `--port 0` for ephemeral), writes each job as `<stamp>.bin` + `.json` (bytes, sha256, peer, first/last byte, idle window) so a test proves one continuous write |
| Decoder/oracle | `e2e-tests/lib/escpos-parse.ts` | turns bytes into executed commands: init, code-page selects, alignment, bold, text runs (CP864 decoded), lines, barcodes, cuts, drawer pulses, raster geometry (with a truncation check), unknown commands |
| Suite | `scripts/test_escpos_sink.mjs` (`npm run test:escpos`) | build with the **production** builder → send over loopback TCP → parse what the sink captured → assert structure → compare byte-exact goldens; negative controls inside the same run |
| Goldens | `tests/fixtures/escpos/*.golden.bin` | `receipt-arabic-80mm`, `receipt-latin-80mm`, `receipt-arabic-58mm` |
| Deterministic renderer | `e2e-tests/tools/escpos-raster-stub.mjs` | pins the Arabic raster bytes without depending on installed fonts |
| Fixture | `e2e-tests/tools/escpos-fixture.mjs` | fixed ids/date/money, Arabic customer name |
| Hardware kit | `scripts/escpos_hardware_kit.mjs` (`npm run escpos:kit`) | builds the four artifacts, writes `CHECKLIST.md`, and with `--host` prints them to a real printer |

## What the suite proves (27 checks, `PASS-SIM`)

- Wire integrity: every built byte arrives at the sink unchanged (sha256 equality).
- `ESC @` once, partial `GS V 1` cut at the end, no unknown command in the stream.
- Arabic is printed as a `GS v 0` bit image, geometry inside the head width
  (≤ 72 bytes/row on 80 mm, ≤ 48 on 58 mm) and payload length equal to
  width × height; the Latin label around it stays text.
- Totals print as integer DA with a plain-space thousands separator (the fr-DZ
  U+202F used to become `?`).
- Barcode is CODE128 carrying the transaction id.
- Drawer kick is its own command (`ESC @` + `ESC p 0 0x32 0xFA`); the receipt
  stream deliberately contains none.
- 58 mm build stays within 32 columns.
- Reprint of the same row is byte-identical.

Negative controls (each must fail):
1. removing the cut → cut check fails;
2. raster disabled (`raster: 'off'`) → no raster, CP864 fallback observed;
3. a `?` where a money separator belongs → totals check fails;
4. a truncated bit image → parser reports `TRUNCATED` instead of skipping;
5. a pin-1 drawer pulse → pin-0 assertion fails.

## Honesty qualifiers

- **`PASS-SIM`, never hardware PASS.** Bytes and structure are verified; legibility
  on paper is HAR-002 (a human with a 58 mm and an 80 mm printer, Epson-class and
  one clone).
- The Arabic raster in the suite is drawn by the **deterministic** renderer; the
  app draws it with the canvas renderer. Goldens pin the protocol, not the font.
- The CP864 fallback is exercised and asserted as a fallback, not as working
  Arabic (52 of 117 contextual forms have no CP864 byte).

## Owner ask (minimised)

One printer session, two rolls: **58 mm and 80 mm**, one Epson-class and one
clone, plus the interface (USB / network IP:port / Bluetooth name). Then:
`npm run escpos:kit -- --host <ip>` and tick the 11 lines in `CHECKLIST.md`.

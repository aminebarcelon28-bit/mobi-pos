# ADR-004 — Printing Arabic on ESC/POS: raster lane, not a code page

- **Status:** accepted
- **Date:** 2026-11-03
- **Cases:** RCP-01, RCP-02, RCP-12, RCP-13, RCP-21
- **Evidence:** E-0166 (sink suite 27/27, goldens, negative controls)

## Context

The receipt builder (`src/utils/escpos.ts`) printed text by pushing each UTF-16
code unit's low byte. Arabic (U+0600–U+06FF) has no Latin-1 byte, so every Arabic
character became `0x3F` (`?`) — an Arabic customer's name printed as a row of
question marks (RCP-01 FAIL). Cashier names and item titles have the same
exposure (RCP-21), and the store header/footer can be Arabic (RCP-12).

Two facts constrain the fix:

1. **ESC/POS has no shaping engine.** The printer receives glyph codes and prints
   them left to right. Arabic needs contextual forms (isolated/final/initial/
   medial) and a visual (RTL) order, or the word is unreadable.
2. **No single-byte code page carries Arabic *and* the forms.** Epson's Arabic
   page is CP864 (`ESC t 37` on the TM-T20/TM-T88V table). CP864 holds the ASCII
   set plus 186 Arabic-range code points, but only 65 of the **117 contextual
   forms** the Unicode Character Database defines for the Arabic letters
   (measured with `scripts/gen-arabic-cp864.mjs` against `UnicodeData.txt`:
   52 forms — including beh/teh/yah final and medial — have no CP864 byte).

A page that cannot represent the joined forms cannot render a word correctly,
and no amount of shaping fixes a missing glyph.

## Decision

**Print Arabic as a raster bit image (`GS v 0`), rendered by the platform.**

- `EscPosBuilder.text()` splits a line into directional runs
  (`src/utils/arabicText.ts`). Latin runs keep the existing byte path; each
  Arabic run is handed to an injected `LineRasterizer` and emitted as a
  `GS v 0` image on the same printed line.
- The production rasterizer (`src/utils/receiptRaster.ts`) draws the run with the
  renderer's canvas, which applies platform shaping and bidi, then thresholds to
  1-bit and packs MSB-first rows. Canvas is only available in the renderer, so the
  builder takes the rasterizer as an **injection seam**
  (`buildReceiptBuffer(..., { rasterizer })`) — explicitly permitted by the work
  rules; no `if (test)` branch exists in product code.
- **Fallback:** without a rasterizer (Node, SSR, or a caller that disables it) the
  builder emits CP864 with the forms the page does carry and increments
  `arabicFallbackLines`. It is a documented degradation, not a silent success:
  the tests assert that the app path rasterises.
- The Arabic raster respects the paper width (384 dots for 58 mm, 576 for 80 mm)
  and is bounded to 8191 bytes/row × 1662 rows, the `GS v 0` limits.

## Rejected alternatives

- **CP864 + shaping only.** Renders connected letters as isolated glyphs (52 of
  117 forms missing) — visibly wrong Arabic. Rejected on measurement.
- **Windows-1256 / CP720 base letters and hope the printer shapes.** No Epson-
  class firmware shapes; the ticket would print disconnected letters in logical
  order (visually reversed). Rejected.
- **Ship an Arabic bitmap font + own rasteriser.** Correct but large: needs a
  font licence, a shaper and a rasteriser in the bundle. The renderer already has
  a shaped, bidi-aware text stack; reusing it is smaller and always matches the
  UI.
- **Do nothing and mark the cases N/A.** Arabic is a primary market requirement
  for this product; a row of `?` on a customer receipt is a defect, not a scope
  choice.

## Consequences

- Receipts with Arabic carry an image for the Arabic run only; the rest of the
  ticket is still text (searchable, and the byte protocol is unchanged for
  Latin-only receipts — the Latin golden is byte-identical to before).
- Print time grows by the render (milliseconds) and the image bytes (a name is
  ~200 bytes at 1 bpp).
- **Hardware truth is not claimed.** Bytes are verified (sink + parser +
  goldens); that the dots are legible on a given printer is HAR-002 — a human
  prints `npm run escpos:kit` and walks the checklist.
- Two companion fixes shipped in the same change, both printing-only and
  measured: the fr-DZ money separator (U+202F) printed as `?` inside amounts
  ("1?700 DA" → "1 700 DA"), and the item-count / thanks / total lines
  overflowed a 58 mm head (39 and 36 columns on a 32-column paper).

## Sources

- Epson TM-T20 ESC/POS quick reference (code-page table, `ESC t`): 37 = PC864
  Arabic, 32 = PC720, 50 = WPC1256 — http://www.novopos.ch/client/EPSON/TM-T20/TM-T20_eng_qr.pdf
- Epson TM-T88V Technical Reference Guide, Appendix C "Page 37 (PC864: Arabic)"
  — https://files.support.epson.com/pdf/pos/bulk/tmt88v_trg_reve.pdf
- ESC/POS command reference (`ESC t`, `GS v 0` raster): AURES ESC/POS manual —
  https://aures-support.com/DATA/drivers/Imprimantes/Commande%20ESCPOS.pdf
- Unicode CP864 (DOS Arabic) mapping — https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/PC/CP864.TXT
- Unicode Character Database (Arabic Presentation Forms-B shaping data) —
  https://www.unicode.org/Public/UCD/latest/ucd/UnicodeData.txt
- UAX #9 (Unicode Bidirectional Algorithm) — https://www.unicode.org/reports/tr9/

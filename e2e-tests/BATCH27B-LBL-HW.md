# Batch 27b — LBL (13) + HW (8): triage and execution

Date: 2026-10-26
Scope: every `LBL-*` (13) and `HW-*` (8) row still sitting in the REMAIN
bucket — 21 cases, triaged before execution, then run in two halves.
Canonical log: `e2e-tests/logs/part0-27b.log` (21 `VERDICT=` lines)
Artifacts: `e2e-tests/tools/27b-lbl-checks.mts` (deterministic half),
`e2e-tests/specs/27b-lbl-hw.e2e.ts` (interactive half),
`e2e-tests/tools/build-27b-log.mjs` (assembles the canonical log),
`e2e-tests/results/27b-lbl-checks.json` (machine specs + raw records).

Result: **21/21 cases produced a `VERDICT=` line** —
**1 PASS, 2 PASS-PARTIAL, 9 FAIL, 4 N/A, 5 BLOCKED**.

---

## 1. How 27b was run (and why it is split in two)

Label correctness is mostly a *byte* question, and the sandbox has no label
printer. So the batch runs in two halves:

1. **Deterministic half** (`tools/27b-lbl-checks.mts`, 18 cases). The app's own
   modules — `src/utils/productLabelBuilder.ts`, `src/utils/barcodeGenerator.ts`,
   `src/types/pos.ts` — are executed **unmodified** under Node with the repo's
   TS resolve hook:

   ```
   node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types \
     e2e-tests/tools/27b-lbl-checks.mts
   ```

   Nothing is re-implemented: the checks call the shipped functions and then
   verify their output with **independent** decoders (an EAN-13 L/G/R table
   written from the standard, and a Code128 table whose anchors 0/103/104/105/106
   are asserted so the table cannot be a copy that cancels an encoder bug).

2. **Interactive half** (`specs/27b-lbl-hw.e2e.ts`, 3 cases) against the real
   Tauri WebView, wiped sandbox:

   ```
   POS_E2E_WIPE=1 npx wdio run e2e-tests/wdio.conf.ts \
     --spec e2e-tests/specs/27b-lbl-hw.e2e.ts
   ```

Machine: `AMD Ryzen 5 8500G`, 12 cores, 15.1 GiB RAM, 63.3 GiB free,
Windows 10.0.26300, Node v24.18.0. Binary `target-e2e/debug/mobi-pos.exe`
(43,368,448 bytes, 2026-10-22). Sandbox
`%TEMP%\opencode\pos-wdio-sandbox`, wiped before the run.

**Thresholds, written before measuring:**

| Case | Pass condition |
|---|---|
| LBL-01 | 0 bad check digits out of every generated code; every SVG decodes back to its own digits; guard bars intact |
| LBL-02 | every tested value round-trips byte-exactly **and** the required symbologies exist |
| LBL-04 | label price == DB price **and** a stale label is detectable |
| LBL-05 | requested count == emitted count for 1/50/500/501/1000 and for copies > 1 |
| LBL-06 | long/mixed/Arabic titles survive with no split code point and a shaping rule |
| LBL-08 | duplicate blocked at creation **and** a deleted product's barcode not reusable |
| HW-01 | HID Enter burst decodes, modal scan is parked, Tab-terminated burst decodes |
| HW-05 | keyboard-only add works; no primary action clipped at 800x600 |

**Honest limitation:** `__TAURI_INTERNALS__.invoke` is non-writable in this
build (`armInvokeCounter` → `wrap-failed`), so the raw bytes handed to
`sqlite_print_raw_escpos` cannot be captured at the IPC boundary. The byte
checks therefore prove the *builder* output, and LBL-11 proves the *call path*;
the physical print is unasserted (that is why LBL-11 is PASS-PARTIAL and LBL-03
is BLOCKED).

---

## 2. Triage (before execution)

| Case | Half | Precondition cited |
|---|---|---|
| LBL-01 | node | pure generator + SVG renderer, no IPC |
| LBL-02 | node | same, plus the symbology union in `barcodeGenerator.ts` |
| LBL-03 | — | **physical printer + ≥2 label rolls**; also checks the calibration UI in `LabelPrinterModal.tsx` |
| LBL-04 | node | builder reads `product.price`; stale-detection needs the modal/builder source |
| LBL-05 | node | `PRINT n` in TSPL / `GS k` count in ESCPOS, plus `handlePrintBatchQueue` |
| LBL-06 | node | `TEXT` element + title slice in `productLabelBuilder.ts` |
| LBL-07 | node | conditional "[if used]" — probe the source for any variable-weight path |
| LBL-08 | node | `findBarcodeDuplicate` + the `deleted = 0` list filter |
| LBL-09 | node | does any builder accept a repair order? |
| LBL-10 | node | conditional "[if any]" — probe for a template editor |
| LBL-11 | wdio | real sale in progress + real label modal |
| LBL-12 | node | IMEI/warranty fields in the label builder |
| LBL-13 | node | mobile→desktop relay path in `phoneUtils`/outbox |
| HW-01 | wdio | HID wedge via synthetic machine-grade bursts (Enter and Tab) |
| HW-02 | — | **serial VFD / second screen on a COM port** |
| HW-03 | node | probe for scale integration |
| HW-04 | — | **USB printer + scanner + drawer to unplug mid-sale** |
| HW-05 | wdio | keyboard-only + `setWindowSize(800x600)` |
| HW-06 | — | **Android + bonded BT/OTG printer** |
| HW-07 | — | **phone camera + printed barcodes** |
| HW-08 | node | probe for a cross-device drawer request channel |

Nothing was executed before its precondition was written down. The five
hardware cases were declared BLOCKED on the cited missing device rather than
being faked with a stub.

---

## 3. Per-case verdicts

### 3a. Label generation (LBL-01, 02, 07)

- **LBL-01 PASS** — 204/204 check digits match an independent EAN-13
  calculation, 204/204 SVGs decode back to their own 13 digits with the
  independent L/G/R decoder, 204/204 guard patterns (`101`/`01010`/`101`) are
  present, and 200/200 generated codes are unique across four prefixes
  (`613`, `200`, `000`, `999`). This is a decode round-trip, not a physical
  scanner read — stated plainly.
- **LBL-02 FAIL** — Code128 is correct: 5/5 values round-trip byte-exactly,
  including a 40-char serial, a 19-char ticket number and an **80-char** value,
  with valid checksums and stop patterns, and the full value reaches both the
  TSPL `BARCODE` command and the ESC/POS buffer. But the generator's symbology
  union is only `code128 | ean13` (`barcodeGenerator.ts`): there is **no QR,
  DataMatrix or PDF417 encoder and no selector**, so the case's required
  symbologies for IMEI/serial/ticket use do not exist.
- **LBL-07 N/A** — conditional "[if used]"; no variable-weight or
  embedded-price path exists (0 source hits), and the label builder only emits
  the product's plain barcode as Code128.

### 3b. Label content (LBL-04, 06, 08, 09, 12)

- **LBL-04 FAIL** — the builder reads `product.price` at call time (1500 → the
  label carries `1 500 DA`; 2500 → `2 500 DA`; the two buffers differ), which is
  correct. But nothing records the price a label was printed at and no reprint
  prompt exists in the modal or the builder, so a label already stuck on a shelf
  cannot be detected as stale. The case requires "stale labels detectable".
- **LBL-06 FAIL** — a 56-char French title is cut to **24** UTF-16 units by a
  hard slice (no wrap, no shrink); a 23-char title ending in an emoji is cut
  mid-surrogate and encodes as **U+FFFD**; Arabic is emitted as raw UTF-8 with
  no code-page/font selection and no shaping/RTL run (77 source hits for
  bidi/shaping live elsewhere in the app, none in the label path).
- **LBL-08 FAIL** — an active duplicate is correctly blocked
  (`ProductEditorModal.tsx:411` → `findBarcodeDuplicate`), but deletion is a
  soft tombstone and the editor only receives the live list
  (`WHERE deleted = 0`), so the deleted row is invisible to the uniqueness check
  and its barcode can be assigned to a new product. The case requires
  duplicates **and reuse after deletion** to be blocked.
- **LBL-09 FAIL** — the only builder is product-centric
  (`quantity/labelSize/storeName/showStoreName/showPrice/showModel/protocol`);
  `printerRoutingEngine` knows a `repair_ticket` document type but no content
  builder emits ticket no. / IMEI barcode / date / customer name, so the SAV
  label cannot be produced from the app at all.
- **LBL-12 FAIL** — 0 IMEI/warranty matches in `productLabelBuilder.ts`: the
  label exposes title, compatible model, barcode, price and store name only.
  No IMEI last-4 policy and no warranty type field.

### 3c. Label workflow (LBL-03, 05, 10, 11, 13)

- **LBL-03 BLOCKED** — needs a physical label printer and at least two label
  rolls to observe clipping. Independently, the source has **no calibration
  surface**: `GAP 2 mm, 0 mm` is hardcoded, `DIRECTION 1` is fixed, and the
  label modal has no dpi / printhead / gap / offset control — so 203-vs-300 dpi
  and roll-gap calibration cannot even be configured. Only three fixed sizes
  exist in the UI.
- **LBL-05 FAIL** — 1, 50 and 500 are exact (TSPL `PRINT n,1`), but **501 and
  1000 are silently clamped to 500** and ESC/POS copies clamp 51 → 50, so the
  operator gets fewer labels than requested and a success toast. Failure
  handling is worse: `printViaWindowsSpooler` catches the invoke error and
  returns `false`, so `handlePrintBatchQueue`'s `try/catch` is unreachable — a
  printer error mid-batch neither aborts nor names the failed SKU, the loop
  still ends with "Lot terminé : N étiquette(s) envoyée(s)" and the queue is
  cleared, leaving an unretryable "success". No per-label progress, no cancel,
  no resume.
- **LBL-10 N/A** — conditional "[if any]"; no label-template editor exists. The
  layout is fixed in `productLabelBuilder.ts` with three element toggles, so
  there is no template that could be left with a missing field or a huge font.
- **LBL-11 PASS-PARTIAL** — with a real sale in progress (1 line,
  1,200,000 minor), opening the label studio, selecting a product and pressing
  `Imprimer (10)` leaves the cart **byte-identical** (1 line, 1,200,000 minor),
  the modal stays open, the catalog search box is untouched, and no UI error is
  raised: no focus steal, no cart mutation. The printed output itself is
  unasserted (no printer), and the toast reveals a defect of its own — see
  P2-85.
- **LBL-13 FAIL** — mobile label printing goes to the Android system print
  sheet **on the same device** (`launch_print_label` → `PhonePlugin.printLabel`);
  there is no job queue, no desktop routing, no idempotency key and no failure
  report back to the sender, so a label cannot be sent from mobile to the
  desktop's label printer.

### 3d. Hardware (HW-01 … HW-08)

- **HW-01 FAIL** — an Enter-terminated HID burst decodes (1 line added, scan
  event with the exact code), and a scan **while the label modal is open** is
  correctly parked by the `useBarcodeScanner.ts:190-196` guard: the
  `pos:barcode-scanned` event fires, the cart does not move
  (1 → 1 line, 1,200,000 minor). A **Tab-terminated** burst is dropped
  completely: 0 cart delta, 0 scan events, while the same characters with Enter
  decode immediately. `useBarcodeScanner.ts:412-415` only terminates on
  `Enter` and ignores every key with `length !== 1`, so a scanner configured
  with a Tab suffix cannot sell at all. Serial (non-HID) scanners were not
  exercisable — no serial scanner on this box.
- **HW-02 BLOCKED** — the VFD path is real (`hardware_update_vfd`,
  `mobilePosRoutingEngine` sale update, a test button in `HardwareSettingsTab`),
  but there is no serial VFD or second screen on a COM port, so "same totals"
  cannot be observed.
- **HW-03 N/A** — no scale integration: `weighingScale` exists only as a
  discovered-device type, with no read/parse path for weight, unit g/kg, zero or
  negative values. Nothing to test.
- **HW-04 BLOCKED** — needs a USB printer + scanner + drawer to unplug and
  replug mid-sale. Source subscribes to **no** device-attach event
  (`hotplug`/`devicechange`/`navigator.usb` hits = 0; the only mention is a doc
  comment), so discovery is a manual `scanHardwareDevices` rescan; the sandbox
  has no detachable USB device and the IPC wrapper cannot be instrumented in
  this build.
- **HW-05 PASS-PARTIAL** — keyboard-only operation works: `F1` focuses the
  catalog search, typing filters, `Tab` reaches the first product tile and
  `Enter` adds a line with no mouse. At `800x600` the label dialog spans
  exactly 0–800 and its `Imprimer` button sits at x 609–755, inside the
  viewport; `document.scrollWidth` stays 800, so nothing is horizontally
  clipped. Unasserted: high-DPI scaling (dpr fixed at 1 by the single display),
  minimize/restore and multi-monitor placement.
- **HW-06 BLOCKED** — real code exists (`utils/mobilePrinter.ts` Wi-Fi TCP 9100
  + Bluetooth SPP, `listBondedBluetoothPrinters`, `printLabelImageNative`), but
  the case needs an Android device with a **bonded** BT or USB-OTG printer and a
  paired-device list that changes during the session. The emulator has no
  Bluetooth stack and no USB host.
- **HW-07 BLOCKED** — `MobileCameraScanner.tsx` implements `getUserMedia` +
  `BarcodeDetector` + torch capability, but the case needs a physical phone
  camera pointed at real barcodes to measure speed, double reads, torch and
  permission prompts. The emulator only offers a synthetic test-pattern camera.
- **HW-08 N/A** — no cross-device drawer request channel (0 source hits). Mobile
  opens the drawer through its own local spooler, and the only device-to-device
  transport is the row outbox, which has no drawer-command table. With a single
  install (desktop and `?mode=mobile` share the DB) there is no
  desktop-attached-only drawer to ask.

---

## 4. Every verdict that moved

All 21 came out of REMAIN:

| Verdict | Cases |
|---|---|
| PASS (1) | LBL-01 |
| PASS-PARTIAL (2) | LBL-11, HW-05 |
| FAIL (9) | LBL-02, LBL-04, LBL-05, LBL-06, LBL-08, LBL-09, LBL-12, LBL-13, HW-01 |
| N/A (4) | LBL-07, LBL-10, HW-03, HW-08 |
| BLOCKED (5) | LBL-03, HW-02, HW-04, HW-06, HW-07 |

Dashboard (687 active cases):

| | before | after |
|---|---|---|
| PASS | 174 | **175** |
| PASS-PARTIAL | 20 | **22** |
| FAIL | 218 | **227** |
| N/A | 113 | **117** |
| REMAIN | 100 | **79** |
| BLOCKED | 62 | **67** |
| total | 687 | 687 |

`CASE_INDEX.csv` re-validated after the update: 697 rows, 11 fields,
0 bad-field rows, 697 unique ids.

---

## 5. New findings

### P2-85 — a failed label print is reported to the operator as success

`src/utils/escpos.ts` → `printViaWindowsSpooler()` catches the
`sqlite_print_raw_escpos` error and **returns `false`**. Both callers then treat
that as "probably fine":

- single label: `LabelPrinterModal.tsx` shows an **info** toast
  `⚠️ Étiquettes envoyées au spooler d'impression Windows.` — observed verbatim
  in the 27b run, where the sandbox has no printer at all;
- batch: the loop never throws, so it ends with the success toast
  `Lot terminé : N étiquettes envoyée(s)` and **clears the queue**.

Impact: an operator prints 500 shelf labels, sees success, and gets nothing —
with no way to know which SKUs failed and no queue left to retry. Evidence:
LBL-11 toast in `logs/part0-27b.log`; LBL-05 source path.

### P2-86 — a Tab-terminated HID scanner cannot sell

`src/hooks/useBarcodeScanner.ts:412-415`: the decoder only terminates on
`e.key === 'Enter'`; any other key with `length !== 1` (Tab, CR-as-Tab, F-keys)
falls through both branches and the accumulated burst is silently abandoned.
Tab is a common factory suffix on Zebra/Honeywell scanners, so such a device
adds nothing to the cart while the same characters with Enter decode. Evidence:
HW-01 (`tab_terminated_decoded=false`, `tab_events=0`,
`enter_control_decoded=true`).

---

## 6. Observations recorded without a finding number

- **66 Tab presses** from the catalog search box to the first product tile
  (category pills and brand chips sit in the tab order ahead of the grid). The
  path works, but a keyboard-only cashier pays it on every sale. Measured, not
  filed, because the case only asks for "usable".
- The label studio has **no scan field**: a scan while it is open is parked with
  `setLastScannedCode` and a `pos:barcode-scanned` event that no component in
  the modal listens to. Harmless today (the cart is protected), but the operator
  cannot scan a product to label it.
- `LabelPrinterModal` clamps the quantity input to `max=1000` in the UI while
  the builder clamps to 500 — two different ceilings for the same number.

---

## 7. Residuals

- Physical label output (LBL-03, and the output half of LBL-05/LBL-11) needs a
  thermal label printer and two rolls; no amount of source reading substitutes
  for it.
- The five hardware cases (HW-02/04/06/07 and the serial half of HW-01) need a
  device bench. HW-04 additionally needs a sale in progress during the unplug.
- `HW-05`'s high-DPI, minimize/restore and multi-monitor facets need a second
  display and a DPI change.
- QR/DataMatrix (LBL-02) is a missing feature, not a blocked test: it will stay
  FAIL until an encoder lands.

---

## 8. Next batch

**27c** — the remaining I18 (14) + DAT-79/84. Triage facts already established:
only `fr`, `ar` and `pseudo` are supported locales
(`isSupportedLocale`, `src/i18n/index.ts:52-54`), so any English assertion is
N/A-by-absence; customer search folds only NFD + lowercase
(`CustomersModal.tsx:23-24`) while the product search uses the real Arabic
normalizer (`utils/catalogSearch.ts:47-58`) — SCL-61 already FAILed on that
asymmetry, so 27c must not mint a duplicate.

# Batch 27c — I18 (14) + DAT (2): triage and execution

Date: 2026-10-26
Scope: every `I18-*` (14) and the two open `DAT-*` rows (`DAT-79`, `DAT-84`)
still sitting in the REMAIN bucket — 16 cases, triaged before execution, then
run in two halves.
Canonical log: `e2e-tests/logs/part0-27c.log` (16 `VERDICT=` lines + 4 `FACT=` lines)
Artifacts: `e2e-tests/tools/27c-i18-checks.mts` (deterministic half),
`e2e-tests/specs/27c-i18-ui.e2e.ts` (interactive half),
`e2e-tests/tools/build-27c-log.mjs` (assembles the canonical log),
`e2e-tests/tools/run-27c-ui.mjs` (single interactive run, raw UTF-8 capture).

Result: **16/16 cases produced a `VERDICT=` line** —
**1 PASS, 1 PASS-PARTIAL, 13 FAIL, 1 BLOCKED**.

---

## 1. How 27c was run, and the surface it had to be run against

Two halves, because half of the i18n surface is byte-level and half is layout:

1. **Deterministic half** (`tools/27c-i18-checks.mts`, 8 cases). The app's own
   modules are executed unmodified under Node with the repo TS resolve hook:
   the catalog fold, the customer fold, every `localeCompare` call site, the
   CSV exporter and importer, the name normaliser, the phone normaliser, the
   ESC/POS text encoder, and the backup/data-safety surface inventory.

   ```
   node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types \
     e2e-tests/tools/27c-i18-checks.mts
   ```

   Four of these cases also emit `FACT=` lines (`I18-10_DICT`,
   `I18-13_CANONICAL`, `I18-03_PRINT`, `I18-07_PRINT`) that the interactive
   verdicts cite instead of re-deriving the same measurement twice.

2. **Interactive half** (`specs/27c-i18-ui.e2e.ts`, 8 cases) against the real
   Tauri WebView, wiped sandbox:

   ```
   POS_E2E_WIPE=1 npx wdio run e2e-tests/wdio.conf.ts \
     --spec e2e-tests/specs/27c-i18-ui.e2e.ts
   ```

Machine: `AMD Ryzen 5 8500G`, 12 cores, 15.1 GiB RAM, 62.7 GiB free,
Windows 10.0.26300, Node v24.18.0. Binary `target-e2e/debug/mobi-pos.exe`
(43,368,448 bytes, 2026-10-22). Sandbox `%TEMP%\opencode\pos-wdio-sandbox`,
wiped before the run.

### 1.1 The measurement that changed the batch: there is no desktop language control

The first four probe runs (deleted before the batch closed) established, by
measurement rather than reading:

- `src/i18n` is imported by **17 files, all under `src/components/mobile/`** —
  every one of the 18 `useTranslation` call sites is the mobile companion shell.
  The desktop till is hard-coded French.
- The built WebView has **no** `window.__setMobiLocale` / `__getMobiLocale`
  (they exist only inside the lazy `MobileCameraScanner` chunk, which is not
  loaded until that modal opens), `document.documentElement` has no `dir`
  attribute, and `localStorage.mobi_pos_locale='ar'` is ignored at desktop boot
  (`PROBE3_BOOT_AR` → `lang=fr dir=null`).
- The Settings modal has one tab, "Général & Apparence", and no language row
  (`GeneralSettingsTab.tsx` has zero `Langue|locale|setLocale` hits).
- The companion shell **is** reachable in this WebView through the app's own
  device-role switch — `localStorage.mobi_pos_device_mode_override =
  'companion_mobile'` + a `mobi:devicerole-change` event (`utils/platform.ts:202`,
  `hooks/useDeviceMode.ts:12-13`) — and then the pairing wizard's
  "Continuer en Mode Démo Hors-Ligne (Sans Sync)" button. There the FR/AR
  toggle (`CompanionHeader.tsx:156`) works live.

So the interactive half runs against the **companion shell**, which is the only
surface in this build where switching language mid-sale is even expressible.
That is itself a finding (P1-88), not a workaround to hide.

### 1.2 Thresholds, written before measuring

| Case | Pass condition |
|---|---|
| I18-01 | FR→AR→FR flips `dir`/`lang` live **and** cart lines, cart total, every per-row control for the same product and the typed search term are identical before/during/after **and** a language switch is possible mid-payment **and** every named locale (ar, fr, **en**) is switchable |
| I18-02 | no horizontal overflow in either direction; nav rail, cart pane and dialog mirror across the centre line; DA amounts render identically; dialog content inside its own box |
| I18-03 | stored string == typed string == DOM text, and the same logical order survives display **and print** **and export** |
| I18-04 | every case-listed variant pair folds to the same search key, in the product **and** the customer directory |
| I18-06 | a language-driven collation exists and is used by the lists |
| I18-07 | payloads stored byte-exactly, rendered as text (no node, no handler), layout unbroken, **and** the same string safe on the print path |
| I18-08 | export and import round-trip a French-format CSV without changing any amount |
| I18-09 | a US-HID burst sells **and** the same digits typed on an AZERTY or Arabic layout sell |
| I18-10 | zero raw i18n keys and zero horizontal overflow on **all** screens |
| I18-11 | name variants collapse to one customer key, including Arabic script |
| I18-12 | title/honorific and family name are stored and usable separately |
| I18-13 | invalid numbers are rejected **at save** with a message |
| I18-14 | IME composition on a real Android keyboard does not mutate fields |
| I18-15 | pasted NBSP/RLM/newline never survives into a stored field or a misread amount |
| DAT-79 | a replica/standby exists with a measured RPO, a lag badge, an alert and a promotion drill |
| DAT-84 | the owner sees backup age, verified/off-machine, last restore, and gets alerted |

---

## 2. Triage (before execution)

| Case | Half | Precondition cited | Order |
|---|---|---|---|
| I18-03, 07 | node + UI | needs the print byte encoder **and** a live form; the receipt builder is pure, so bytes are countable under Node | 1 (money-adjacent: printed ticket) |
| I18-13, 15 | UI | needs the customer form and the tender sheet in the real WebView, plus a DB read of the saved row | 2 (money-adjacent: wrong phone, misread amount) |
| I18-09 | UI | needs a real keyboard-event stream at the document level; the wedge is a DOM listener, so synthesised `KeyboardEvent`s with explicit `key`/`code` are faithful | 3 (selling blocked) |
| I18-01, 02 | UI | needs a surface that owns a locale; only the companion shell does (§1.1) | 4 |
| I18-04, 11 | node | pure fold functions; no UI needed | 5 |
| I18-08 | node | exporter + importer are pure string functions | 6 |
| I18-06, 12 | node | static inventory of call sites / type fields | 7 |
| I18-10 | UI | needs every screen rendered in Arabic | 8 (partial by construction) |
| DAT-79, 84 | node | capability inventory; no second machine exists | 9 |
| I18-14 | — | needs a physical Android IME | BLOCKED |

---

## 3. Per-case verdicts

### 3a. Switching and layout

**I18-01 — FAIL.** The companion shell flips `dir` `ltr↔rtl`, `<html lang>`
`fr↔ar` and all six nav labels live, and the sale survives it: cart badge
`"Caisse — 1" → "الصندوق — 1" → "Caisse — 1"`, all 5 controls referencing the
product title, and the typed search `"PROBE"` identical across the round trip.
Two named facets fail:

- mid-payment switch is **impossible** — with the cash sheet open,
  `elementFromPoint` at the language button's centre returns
  `DIV fixed inset-0 bg-black/80 backdrop-blur-sm z-50 …` and the real click is
  `element click intercepted`;
- `en` is not a shipped locale (`isSupportedLocale` accepts `fr/ar/pseudo`,
  `src/i18n/index.ts:52-54`), and mid-ticket printing needs a printer.

**I18-02 — PASS.** At 1280×749: `scrollWidth == innerWidth` in both directions
(1280/1280); the nav rail mirrors (`l=4 → l=1204`); the cart pane control
crosses the centre line (`l=1194 → l=32`); the cash sheet stays inside the
viewport (`416..864`, `scrollW 446 == clientW 446`) with its Arabic title
`تحصيل نقدي` inside and the close button on the flipped side; the visible DA
amounts are the same multiset both ways (`["500 DA","438 DA","375 DA"]`). The
two remaining named facets are **measured vacuous** rather than unasserted:
`tables=0, gridRoles=0, customTooltips=0` (only 83 native `title` attributes),
so there is no RTL table column or tooltip layer on this screen to misplace.

**I18-10 — PASS-PARTIAL.** Dictionaries are key-identical: 822/822/822 keys
(fr/ar/pseudo), 0 missing in Arabic, 0 extra, 0 interpolation-placeholder
mismatches, 0 Arabic values that are still raw keys (FACT=I18-10_DICT). Four
Arabic screens were walked — checkout, cash sheet, activity, management — each
confirmed active by its own `aria-selected` tab (`الصندوق — 1`, `الصندوق — 1`,
`النشاط`, `الإدارة`), with 0 raw i18n keys and 0 horizontal overflow. Partial
because "scan all screens" includes reports, labels, refund and the settings
sub-tabs, which were not walked.

### 3b. Mixed-direction text, long strings, printing

**I18-03 — FAIL (print facet).** Display and storage are correct end to end:
`"أحمد بن علي iPhone 15"` stored byte-exact (DB string == DOM string), phone
`0555000000`, and the product tile `"غلاف iPhone 15 Pro 128GB"` renders with
`direction:ltr, unicode-bidi:isolate` so the Latin+digit run is not reordered.
Printing is not: `text()` does `charCodeAt(i) & 0xFF` with **no code page
command** (`src/utils/escpos.ts:61-68`), so the receipt line becomes
`Client: #-E/ (F 9DJ` (`43 6c 69 65 6e 74 3a 20 23 2d 45 2f 20 28 46 20 39 44 4a`),
and even `Tél:` becomes `54 e9 6c 3a` (FACT=I18-03_PRINT). Export is measured
by I18-08.

**I18-07 — FAIL (print facet).** Storage and rendering are safe: the XSS
payload, the RLO/ZWSP name and the 229-char emoji+Arabic product title are
stored byte-exactly, React renders them as text (0 `<img>`, 0 `<script>`, no
handler ran), no horizontal break (1280/1280), and the catalog tile keeps the
full logical string. Printing is not safe: `🔛` has low surrogate `0x1B`, so
`"🔛@X"` emits `3d 1b 40 58` — a raw `ESC @` printer-reset **inside the
receipt stream** (FACT=I18-07_PRINT: `esc_injected=true, esc_at=1,
following_byte=0x40`).

**I18-15 — FAIL (name field).** The phone field owns a paste handler
(`preventDefault` + `cleanPhone` + `formatDzPhone`): `"+213<NBSP>770<RLM>111222"`
lands as `+213 770 11 12 22` and stores as `0770111222`; the NBSP-grouped tender
`"1 000"` parses as 1000 with change `11 000 DA`. The name field has no handler
at all — the synthetic `ClipboardEvent` is not cancelled — so
`"  أحمد<NBSP>بن<RLM> علي\n"` is written to the CRM row **verbatim**, NBSP and
RLM intact: exactly the invisible characters a WhatsApp paste carries, and the
ones the search fold does not strip (I18-04).

### 3c. Input correctness

**I18-09 — FAIL.** The wedge accumulates `e.key` verbatim
(`src/hooks/useBarcodeScanner.ts:412-415`), so it is layout-dependent:

| burst | scan event | cart delta |
|---|---|---|
| ASCII `key` + `code=DigitN` | `6132700000017` | **+1 200 000** |
| ASCII `key` + bogus `code=KeyQ` | `6132700000017` | **+1 200 000** (proves `code` is ignored) |
| Arabic-Indic digits | `٦١٣٢٧٠٠٠٠٠٠١٧` | 0 |
| AZERTY top row (`&é" '(-è_çà`) | `-&"éèàààààà&è` | 0 |

A US-HID scanner on an AZERTY or Arabic-keyboard machine therefore cannot sell.

**I18-13 — FAIL (save path).** The field itself is good: 9 written variants of
one mobile collapse to one canonical form `+213550123456`, 4 of 14 inputs report
`isValid=false`, and a 9-digit entry shows the amber `Format DZ attendu` hint
plus `aria-invalid=true`. The save path ignores it —
`cleanPhone = norm.isValid ? norm.local : (norm.digitsOnly || phone.trim())`
(`src/components/modals/CustomersModal.tsx:550-551`) — and fires `showSuccess`
anyway, so `"055012345"` is written to the CRM with no rejection. A valid
control case (`0555000000`) stores correctly, so the defect is the guard, not
the formatter.

**I18-04 — FAIL.** The product omnisearch fold covers 8/10 of the case list
(0 misses among harakat, hamza-alef forms, ta marbuta, alef maqsura, Latin
accents) but misses **tatweel** and **Arabic-Indic digits**. The customer
directory fold is a *different* inline helper —
`normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()` — which handles
**none** of the Arabic variants (2/10 pairs fold equal, only the two
Latin-accent ones). There are **8 duplicate `foldForSearch` definitions**
(`catalogSearch.ts:58`, `CustomersModal.tsx:23`, `KredyTab.tsx:49`,
`DebtLedgerModal.tsx:4`, `KittingBundleModal.tsx:5`, `LabelPrinterModal.tsx:23`,
`PriceBooksModal.tsx:40`, `RefundModal.tsx:3`), so the same typed name finds a
product and misses the customer (SCL-61 is the measured consequence).

**I18-11 — FAIL.** Five transliterations of "Mohamed" stay five distinct search
keys (`mohamed/mohammed/muhammad/mhamed/mohamad`); the Arabic form folds to the
**empty string** because `cleanAlphanumeric` keeps only `a-z0-9`; the only
synonym table in the app is the retail product cluster list
(`utils/catalogSearch.ts:20-36`, 2 sites), with no name alias table. The 1M-row
ranking half of the case is NEEDS-LONG and is not asserted.

**I18-12 — FAIL.** `Customer` carries one free-text `name` with no first/family
split and no title or `Ep.`/`Vve` field (0 hits), so the directory cannot sort
by family name and cannot render a consistent "family name first" form.

### 3d. Data formats, collation, backup

**I18-06 — FAIL.** 18 `localeCompare` call sites, **0** pass an explicit
locale, **0** use `Intl.Collator`. Default code-unit order puts `"Élodie"`
after `"Zineb"` and `"أحمد"` after `"زيد"`; the Arabic-locale sort of the same
names is `["أحمد","بشير","زيد","Ali","Rachid","Élodie","Zineb"]`. There is no
collation setting to be stable about.

**I18-08 — FAIL.** The export is well-formed (UTF-8 BOM, `;` separator, quoted
text, `;` stripped from values) but writes `.` decimals into a `;`-separated
French file, and the importer strips every non-`[0-9.-]` character instead of
normalising: `"1 234,56" → 123456`, `"1 234,5" → 12345`, `"12,5" → 125`,
`"1.234,56" → 1.23456`. That is a 100× price/stock error on a French-format CSV
with no warning.

**DAT-84 — FAIL.** 3 of 10 required data-safety signals exist
(`last_backup_verified`, `integrity_result`, `wal_size`); missing are
`last_backup_age`, `off_machine_copy`, `last_restore_test`, `unsynced_count_age`,
`free_disk`, `canary`, `clock_sanity`. `owner_alert_channel_hits=0`, and
`integrity_status` is a stored string rendered green with no timestamp — the
stale-value-shown-as-fresh the case forbids.

**DAT-79 — FAIL.** `replica_hits=24` but every hit is the Dexie UI mirror or a
causal-convergence comment (`sync/causalVersion.ts:14`, `sync/genericApply.ts:4`),
never a second DB copy; `standby_hits=3`, `RPO_hits=0`, `promote_hits=5`,
`lag_or_age_badge_hits=0`, `failover_or_drill_hits=0`. The only cross-machine
transport is the row outbox to Turso. No replica exists, so no RPO could be
measured — which is itself the verdict.

**I18-14 — BLOCKED.** Needs a physical Android phone with Gboard in Arabic and
French (learned dictionary, cloud suggestions, voice input); the emulator's
AOSP keyboard has no learned dictionary and driving the IME composition
protocol over CDP is not equivalent.

---

## 4. Every verdict that moved

| Case | Was | Now | One-line reason |
|---|---|---|---|
| I18-01 | REMAIN | FAIL | switch works live but not mid-payment; `en` not shipped |
| I18-02 | REMAIN | **PASS** | full mirror, no overflow, dialog inside, numbers identical |
| I18-03 | REMAIN | FAIL | print truncates to low bytes, no code page |
| I18-04 | REMAIN | FAIL | product fold 8/10, customer fold 2/10, 8 duplicate folds |
| I18-06 | REMAIN | FAIL | 18 `localeCompare`, 0 explicit locale, 0 `Intl.Collator` |
| I18-07 | REMAIN | FAIL | `🔛@X` injects `ESC @` into the receipt stream |
| I18-08 | REMAIN | FAIL | `"1 234,56"` imports as `123456` |
| I18-09 | REMAIN | FAIL | wedge reads `e.key`; AZERTY/Arabic bursts cannot sell |
| I18-10 | REMAIN | PASS-PARTIAL | 822/822/822 keys, 4 screens clean, not all screens walked |
| I18-11 | REMAIN | FAIL | 5 Mohamed variants = 5 keys; Arabic folds to `""` |
| I18-12 | REMAIN | FAIL | single free-text name field |
| I18-13 | REMAIN | FAIL | save path ignores `isValid`, writes `055012345` |
| I18-14 | REMAIN | BLOCKED | needs a real Android IME |
| I18-15 | REMAIN | FAIL | name paste keeps NBSP/RLM in the stored row |
| DAT-79 | REMAIN | FAIL | no replica/standby/RPO/promotion drill |
| DAT-84 | REMAIN | FAIL | 3/10 signals, no alert channel |

Dashboard after 27c: **176 PASS + 23 PARTIAL + 240 FAIL + 117 N/A + 63 REMAIN
+ 68 BLOCKED = 687** (was 175/22/227/117/79/67).

---

## 5. New findings

### P1-87 — every non-ASCII character printed on a receipt is mangled, and some inject printer commands

`src/utils/escpos.ts:61-68` encodes text as `charCodeAt(i) & 0xFF` and never
emits a code-page selection (`ESC t` is never sent). Consequences, all measured
on the shipped builder:

- Arabic customer `أحمد بن علي` prints as `#-E/ (F 9DJ`;
- French `Tél:` prints as `T\xe9l:` (byte `e9`, CP437/CP850 `Ú` on most
  printers);
- an emoji whose low surrogate ends in `0x1B` puts a raw **ESC** into the
  stream, and `🔛@X` produces `ESC @` — a printer reset — mid-ticket.

This is the same encoder behind LBL-06's truncation, so the label and receipt
paths share the defect. Affects I18-03, I18-07 (and LBL-05/LBL-06 evidence).

### P1-88 — the i18n system exists only in the mobile companion; the desktop till is French-only by construction

`src/i18n` is imported by 17 files, all under `src/components/mobile/`
(all 18 `useTranslation` sites). The desktop till has no language control at
all: `SettingsModal` exposes one tab, `GeneralSettingsTab` has no language row,
`document.documentElement` has no `dir`, `mobi_pos_locale` is ignored at boot
and `window.__setMobiLocale` does not exist in the built WebView outside a lazy
chunk. For an Algerian merchant the primary counter surface cannot be switched
to Arabic, while the companion (a secondary surface) can.

### P1-89 — language cannot be switched mid-payment, and the desktop inherits the companion's direction

With the cash sheet open, the only language control is behind the sheet's
`fixed inset-0 bg-black/80` backdrop: `elementFromPoint` returns the backdrop
and a real click raises `element click intercepted`. Separately, the desktop
till has no locale of its own, so returning to PC mode while in Arabic leaves
`dir=rtl lang=ar` over hard-coded French labels (measured in
`PROBE4_BACK_DESKTOP`). Both are visible to a cashier who tries to change
language at the till.

---

## 6. Observations recorded without a finding number

- **The cart-protection sheet is real and blocks navigation by design.** Leaving
  the Caisse tab with a non-empty cart raises `M3CartProtectionModal`
  (`aria-labelledby="cart-protection-title"`, Arabic text observed:
  "عملية بيع جارية غير مكتملة … مواصلة البيع / تعليق الوصل / إفراغ السلة"), and
  its backdrop intercepts the bottom-nav click. This is intended M3 behaviour,
  not a defect; the harness answers it the way an operator must (choosing
  "إفراغ السلة" / clear cart), and records the sheet text.
- **The Arabic dictionary is genuinely complete for the keys it has**: 0 raw
  keys, 0 placeholder drift, only 3 Arabic values identical to French with
  Latin text, and 25 French keys not in dotted-camel form. The gaps are
  surface coverage (P1-88), not translation quality.
- **The DZ phone normaliser is a strong component** and should be reused: 9
  variants → 1 canonical form, 4/14 invalid inputs flagged, paste sanitised.
  I18-13 fails because the *caller* ignores `isValid`, not because the
  formatter is weak.
- **`getByRole`-style locators needed a badge-tolerant match.** The nav tab's
  accessible name is `"Caisse — 1"` (cart count appended), so
  `@aria-label="Caisse"` never matches; every nav locator uses
  `starts-with(@aria-label, "Caisse")` / `"الصندوق"` / `"النشاط"` / `"الإدارة"`.
  Worth remembering for every mobile-shell spec.

---

## 7. Residuals

| Residual | Why it is open |
|---|---|
| I18-14 | physical Android IME (Gboard ar/fr) — BLOCKED, not skipped |
| I18-10 "all screens" | reports, labels, refund and settings sub-tabs not walked — PASS-PARTIAL |
| I18-11 1M-row ranking | NEEDS-LONG; only the variant-collapse half is asserted |
| I18-01 `en` + mid-ticket print | `en` is not a shipped locale (finding, not a gap); printing needs a printer |
| I18-02 tables/tooltips | vacuous on the checkout screen (measured 0/0/0), not absent from the app |
| I18-03 export facet | delegated to I18-08, which measures it and fails |
| Print path end-to-end | bytes are counted on the builder; the physical print is LBL-03/LBL-11 territory |

---

## 8. Next batch

Remaining bucket is now **63**. Proposed **27d**: `RPT-*` (12) + `PRF-*` (6),
same two-half shape (deterministic aggregation checks + interactive report
rendering), then 27e/27f for the remaining `SCL-*` (45) to drive REMAIN to 0
before the PARTIAL bucket is touched.

# Smart Import & Easy Migration — Design

**Status:** Approved design; awaiting user review before implementation
**Date:** 2026-10-22

## Goal

Harden the existing “Import Intelligent & Migration Facile” flow so catalog and
customer data can be imported from `.xlsx`, `.xls`, CSV, TSV, vCard, JSON and
SQL with reliable parsing, deterministic mappings, transactional persistence,
and immediate visibility in the Product Catalog, POS search and client picker.
The adversarial Playwright suite must exercise the actual UI and verify both
SQLite persistence and rendered/searchable results.

## Phase 1 — current-state findings

The import button is in Backup Settings and opens `SmartImportModal`. In the
native desktop flow the modal calls Tauri commands for inspection, staging and
commit. Parsing and staging are Rust-native; the staging database is separate
from the live SQLite database.

### Parser and detection

- Text decoding already handles UTF-8 (including BOM), UTF-16 LE/BE,
  Windows-1252 and Windows-1256, with a French/Arabic coherence heuristic.
  CSV/TSV delimiter sniffing supports comma, semicolon and tabs. XLSX/XLS uses
  Calamine; the parser scores one worksheet and either honors a selected sheet
  or chooses a likely populated sheet. Header selection scans up to 15
  nonblank rows and scores known header synonyms.
- XLSX numeric cells are stringified from their numeric values. Source
  formatting and leading zeroes are not recoverable if Excel already stored
  an identifier as a number; scientific notation expansion can normalize
  suitable text but cannot restore precision already lost by Excel.
- vCard handling currently reads FN/N, one TEL and NOTE; folded lines,
  quoted-printable, email, address and secondary TEL are not handled.
- SQL input is never passed to a database executor. The current extractor
  scans lines beginning with `INSERT INTO`, then splits columns and values on
  punctuation. This avoids executing `DROP` but is not a safe/complete SQL
  tokenizer and can misread quoted commas/parentheses, multiline statements
  and mixed-table inserts.
- Header matching uses French/English/Arabic synonyms. Content sampling is
  used when header confidence is low; explicit header matches skip that
  sampling. Two-price ordering and below-cost warnings exist. The money parser
  does not normalize all requested currency labels, and mapping parse errors
  can silently become zero-valued prices instead of row-level rejection.

### Persistence and UI

- The native commit uses a single SQLite `IMMEDIATE` transaction and writes
  products/customers plus related stock, ledger and sync-outbox records.
  Defaults are mostly explicit in INSERT statements. Product barcode/SKU and
  customer phone indexes are non-unique.
- Staging probes products by barcode, then SKU only when barcode is absent;
  customer identity uses normalized phone, not email. Duplicate in-file
  barcodes can be marked for review without being rejected. Existing product
  stock is incremented by imported quantity, so a snapshot re-import can add
  stock a second time.
- The live commit does not verify rows by read-back before reporting success.
  The staging batch status update happens after the live transaction in a
  separate database.
- The modal reloads products and customers and calls `refreshAfterPull`, but
  it enters the success state before those refreshes finish and logs refresh
  errors instead of surfacing them. The success summary omits total parsed,
  skipped and quarantined counts. The main catalog search is derived from the
  Zustand product store; index refresh is not guaranteed by the import path.
- Existing Playwright coverage includes a product import test in the browser
  preview. The repository also has an isolated Tauri E2E build and test-only
  database oracle, which will be used to avoid treating the Dexie/browser
  fallback as proof of native SQLite persistence.

## Phase 2 — approved hardening design

### Data flow and parser contract

Keep the current pipeline:

`file bytes → native parse → mapped/staged rows → validated SQLite write → read-back verification → store refresh`

The Rust-native parser remains authoritative. It will preserve raw identifier
strings whenever present and flag suspected numeric precision loss rather than
fabricate digits. Text decoding remains deterministic across UTF-8/BOM,
Windows-1252, Windows-1256 and UTF-16; delimiter and header detection will
continue to support offset headers and a user-selected worksheet.

The SQL parser will use bounded lexical state (quotes, escaped quotes,
comments, parentheses and statement boundaries) to extract only recognized
`INSERT INTO` value payloads. It will never execute input SQL or accept DDL/DML
as commands. Unrecognized target tables and malformed statements are reported
as warnings/rejections. vCard parsing will unfold continuation lines, decode
quoted-printable parameters and extract FN/N, primary/secondary TEL, EMAIL and
ADR fields before mapping.

Column mapping will combine multilingual lexical header scores and up-to-50
row content samples. Price parsing will normalize DZD aliases, grouping and
decimal separators; explicit cost/selling headers take precedence, with
statistical lower/higher ordering only when headers are ambiguous. Rows with
invalid prices or required product names are quarantined with reasons.
Selling-price-below-cost remains a visible row warning. Euro/dollar values are
quarantined with a currency warning because no exchange rate is supplied;
they will not silently be treated as DZD.

### Identity, writes and consistency

Product matching will resolve normalized barcode and SKU deterministically.
If both keys point to different existing products, the row is quarantined as
ambiguous rather than choosing one. Customer matching will use normalized
phone and email; conflicting/multiple matches are quarantined. Duplicate
identities within the same file receive explicit row-level diagnostics and
cannot create duplicate entities.

The selected stock policy is an **absolute snapshot**: re-importing a catalog
sets stock to the submitted quantity rather than adding it. New products keep
the existing opening-stock, stock-batch and ledger behavior. Existing stock
changes must use a ledger-consistent adjustment (including decreases); they
must not create a second additive receipt on re-import.

Invalid rows are excluded from the valid commit set and retained as staged
quarantines. The valid set is processed in bounded 500–1,000-row slices inside
one outer `IMMEDIATE` transaction: any database error rolls back all valid
rows in that import. Thus row-level quarantine is partial acceptance, but a
database failure never yields a partially committed file. After the database
commit, the command reads back imported identities/counts before the batch is
marked committed or success is returned. The result reports total parsed,
newly inserted, updated/upserted, skipped and rejected/quarantined rows with
reasons.

### UI synchronization

Success is shown only after authoritative read-back and refresh succeed. Reload
products, customers and customer debts into the store in one update, reset
stale catalog filters/search state, and explicitly refresh any active
catalog/POS suggestion index. Read-back or refresh failures remain visible as
errors and cannot produce a success-shaped result.

## Phase 3 — adversarial Playwright verification

Create `e2e/smart-import.spec.ts` and run it against the isolated Tauri E2E
flavor/data directory. Playwright attaches to the WebView2 using the
repository's CDP test setup. Each case resets only the isolated E2E database,
clicks the real Backup Settings “Lancer l'Import Intelligent” button, uploads
generated files, confirms the UI flow, and asserts live UI visibility without
page reload. Database assertions use read-only SQLite access using the
test-build DB path oracle; import itself is always driven through the UI.

The six scenarios cover:

1. Banner/offset-header French XLSX with multiple sheets and deliberate
   worksheet selection, accented product data, and a French CSV; include
   `.xls` upload if a deterministic fixture generator is available.
2. vCard 2.1/3.0 with folded, quoted-printable French/Arabic names and multiple
   contacts/phones, followed by JSON customer migration.
3. SQL target INSERT extraction mixed with comments, quoted delimiters,
   multiline statements, CREATE/DROP/DELETE/UPDATE and SQL-looking text values;
   assert expected rows are persisted, hostile statements have no effect and
   imported values remain literal.
4. A 50-product CSV and modified re-import; assert 10 updates, 5 inserts, no
   duplicate identities, absolute stock values and immediate updated-price UI
   results.
5. A 100-row TSV with 95 valid and 5 invalid rows; assert exact quarantine
   reasons/counts and visibility of all accepted products.
6. A 2,500-row CSV; assert page responsiveness, no page errors, exact database
   and catalog totals, and first/middle/last search results without reload.

The format matrix also exercises UTF-8 BOM, Windows-1252 and Windows-1256
text, textual scientific notation, leading-zero text identifiers, and price
forms such as `1 450,50 DA`, `1,250.50 DZD`, `800.00` and negative values.
The 2,500-row commit target is 30 seconds; observed duration is reported.
`.xls` is reported as uncovered if deterministic UI fixture generation cannot
be achieved. No green status is claimed for a scenario that did not run against
the isolated native database and the real UI.

## Decisions and boundaries

- Keep the native Rust parser/staging/commit architecture; do not move import
  writes into the frontend.
- Use absolute product stock snapshots on re-import.
- Quarantine €/$ prices unless corrected and re-imported; no implicit
  conversion without a supplied rate.
- Row-level invalid data may be quarantined while valid rows commit; live DB
  failures are all-or-nothing for the import.
- Keep worksheet selection to one chosen worksheet per import; do not silently
  combine unrelated sheets.
- Preserve unrelated existing worktree changes. Do not weaken license,
  trust-table or SQLite authorization boundaries for testing.
- Scope is limited to import parsing/mapping/persistence, its immediate UI
  synchronization, directly related documentation and adversarial E2E tests.

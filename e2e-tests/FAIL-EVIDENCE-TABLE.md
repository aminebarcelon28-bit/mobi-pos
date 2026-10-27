# FAIL evidence classification — 140 classified FAIL cases (table + batch appendices 27a–27e)

Part A item 9. One row per FAIL. **Class** is the *decisive* evidence:
what the verdict would still rest on if every other observation were removed.

| Class | Meaning |
|---|---|
| DB | SQLite row/column/state assertion (counts, payloads, before/after) |
| BYTES | decoded ESC/POS payload or captured print bytes |
| RUNTIME | observed runtime behaviour (command registry, console taps, taps) |
| SOURCE | static absence only — no runtime artifact exists to assert on |
| UI | visible text/DOM only — **0 allowed** |

## Counts

| Class | Cases |
|---|---|
| DB | 57 |
| BYTES | 29 |
| RUNTIME | 20 |
| SOURCE | 33 |
| UI | 1 |
| **Total** | **140** |

**UI-text-only FAILs: 0.** No FAIL rests on visible text alone. The single `UI`
case (I18-01, batch 27c) rests on DOM hit-testing — `elementFromPoint` returns
the modal backdrop over the only language control — not on any string being
visible.

## Table

| # | ID | Class | Secondary evidence | Decisive observation | Citation |
|---|---|---|---|---|---|
| 1 | CRT-05 | DB | — | FAIL (confirmed P0-9): stacked discounts are applied, but a full refund of a stacked-discount sale does not return the collected amount. Canonical REF-28 evidence: 900 collected, committed refund 579 (cash 515, wallet sh | e2e-tests/specs/31-ref-refunds-part2.e2e.ts [REF-28] (failing assertion on the full-reversal identity) |
| 2 | CRT-06 | DB | DB (refund rows) + BYTES (refund receipt) | FAIL (confirmed P0-8): invoice-level discount allocation is not honoured on refund of one line. Canonical REF-03 evidence: a 1 000 DA basket discounted 10% (sale total 900) previews the correct 450 net share for one P500 | e2e-tests/specs/30-ref-refunds.e2e.ts:713-735 ([REF-03], failing assertion at :724) |
| 3 | CRT-17 | DB | — | FAIL (confirmed P0-9): the bundle/phone+accessory price itself is applied, but a bundle-child refund commits the wrong share. Canonical REF-33 evidence: child RB350 preview 269 (350 - allocated 81) but commit 207 (subtot | e2e-tests/specs/32-ref-refunds-part3.e2e.ts [REF-33] bundle-child refund |
| 4 | LOY-05 | DB | — | FAIL (same refund path as LOY-04): a full refund does not reduce the durable loyaltyPoints balance; a customer who already spent the points keeps a balance that the refunded sale no longer backs. | src/store/slices/createOrderSlice.ts:2354-2365 |
| 5 | CRM-03 | DB | — | FAIL (P1-20): customer deletion is a soft tombstone that retains PII. The row keeps name/phone and the same values in json_payload; no anonymization or legal-retention split exists. | e2e-tests/specs/70-crm-customers.e2e.ts [CRM-03] |
| 6 | CRM-06 | DB | — | FAIL (P2-43): two same-phone customers are created as distinct ids without the required duplicate warning; selecting CRM06-A attaches only A. G-23 records the duplicate active identity. | e2e-tests/specs/70-crm-customers.e2e.ts [CRM-06] |
| 7 | LOY-02 | DB | — | FAIL (P1-21): discounted basket is discounted twice for points; 1 800 DA earns 32 instead of 36 because itemGross is already net of the line discount and is multiplied by netRatio again. | src/store/slices/createOrderSlice.ts:789 (pre-discount grossSubtotal passed) |
| 8 | LOY-04 | DB | — | FAIL (P1-22): a full 1 000 DA refund commits a refund row but leaves the durable loyaltyPoints balance at 20 (20 -> 20, column and payload), so the earned points remain durable; repeated cycles accumulate toward the 50-p | src/store/slices/createOrderSlice.ts:2354-2365 (residual-only headline deduction) |
| 9 | LOY-07 | DB | — | FAIL (P1-24): an expired point bucket is redeemable. Canonical evidence: before=100 after=50 credit=500 expiresAt=2025-02-05; expected zero credit and an unchanged balance. | e2e-tests/specs/75-loy-loyalty.e2e.ts [LOY-07] |
| 10 | LOY-08 | DB | — | FAIL (P1-25 + P2-47): a 50 000 DA sale promotes the payload tier to Silver but the loyalty_tier column stays Bronze; a full Avoir Magasin refund leaves pointsAfter=1000, spentPayloadAfter=50000 and tierAfter=Silver inste | e2e-tests/specs/75-loy-loyalty.e2e.ts [LOY-08] |
| 11 | LOY-12 | SOURCE | — | FAIL (P1-23): manual points adjustment has no manager PIN or role check. | src/components/modals/CustomersModal.tsx:1390, :2450-2545 (adjustCustomerPoints) |
| 12 | LOY-14 | DB | DB (payload totals) + UI (coverage banner) | FAIL (P1-26): a zero-total stacked sale (zero-cost product + 50% discount + 100 DA voucher + 100 DA Avoir) shows net=0 and "Panier 100% Couvert", but confirm rejects with "Avoir Client 100 DA > 0 DA"; no new transaction  | e2e-tests/specs/75-loy-loyalty.e2e.ts [LOY-14] |
| 13 | LOY-16 | DB | DB (points balance) + UI (mobile card) | FAIL (P2-44): desktop earns 20 points, but the mobile CustomerPickerSheet card shows only the name and phone ("LOY-MOB0551400011") and no loyalty balance; desktop/mobile parity is broken. | e2e-tests/specs/75-loy-loyalty.e2e.ts [LOY-16] |
| 14 | LOY-19 | DB | — | FAIL (P1-27): the configured campaign is expired (2025-01-01..2025-02-01, 5x) but the sale earns 20 points instead of the 10-point base; createOrderSlice.ts:778 calls activeCampaignMultiplier() with no config, so the def | e2e-tests/specs/75-loy-loyalty.e2e.ts [LOY-19] |
| 15 | TIN-01 | SOURCE | — | imeiInputs=1; enabled14=true, enabledLetters=true, enabledSpaces=true | e2e-tests/specs/80-tin-tradein.e2e.ts [TIN-01] |
| 16 | TIN-04 | SOURCE | — | addressSurface=false, photoSurface=false, retention=false | e2e-tests/specs/80-tin-tradein.e2e.ts [TIN-04] |
| 17 | TIN-06 | DB | — | FAIL (P1-30): changing the inspection grade does not re-quote the buyback; before=after=1 000.00 and recalculated=false. | e2e-tests/specs/80-tin-tradein.e2e.ts [TIN-06] |
| 18 | TIN-08 | DB | — | reprise=300 | e2e-tests/specs/80-tin-tradein.e2e.ts [TIN-08] |
| 19 | TIN-14 | DB | — | FAIL (P2-45): the cession contract prints the IMEI and seller ID but Arabic=false; the template is French-only ("Attestation officielle de cession", no Arabic text). | e2e-tests/specs/80-tin-tradein.e2e.ts [TIN-14] |
| 20 | TIN-17 | SOURCE | — | trades=3, warned=false | e2e-tests/specs/80-tin-tradein.e2e.ts [TIN-17] |
| 21 | INV-03 | DB | — | batchCost=120, actualInput=120.00 | e2e-tests/specs/82-inv-inventory.e2e.ts [INV-03] |
| 22 | INV-06 | SOURCE | — | variantTable=0, serializedSwitch=false | e2e-tests/specs/82-inv-inventory.e2e.ts [INV-06] |
| 23 | INV-13 | DB | — | stock=2, imeiRows=0 | e2e-tests/specs/82-inv-inventory.e2e.ts [INV-13] |
| 24 | INV-17 | DB | — | FAIL (P1-33): repair parts are edited as a scalar partsCost; repair_orders has a generic version but no expectedVersion/claimId predicate and no repair_parts/claim tables, so concurrent edits are last-write-wins. | e2e-tests/specs/82-inv-inventory.e2e.ts [INV-17] |
| 25 | SHF-10 | SOURCE | — | FAIL: the handover lane exists (switchCashier re-points the open session) but has no blind-count step, no denomination entry and no variance record. The case premise (handover with blind count) is therefore a missing beh | src/db/adapters/shiftAdapter.ts:952-999 (setShiftCashier only) vs :650/:835 (blindCount enters only closeShift) |
| 26 | CRM-09 | SOURCE | — | FAIL: customer debt is visible to every role and there is no backend redaction. The ID-number/notes fields are genuinely absent, but the financial-visibility facet exists and is not role-gated, so the case cannot be N/A. | src/components/modals/CustomersModal.tsx:1050-1120 (profile tabs incl. debt shown to every role) |
| 27 | DAT-07 | DB | — | FAIL (P0-18): create_database_backup cannot complete on the shipped schema: "integrity_check failed: unable to validate the inverted index for FTS5 table main.products_fts: attempt to write a readonly database"; backups= | e2e-tests/specs/20-dat-data-integrity-part1.e2e.ts [DAT-07] |
| 28 | DAT-08 | RUNTIME | — | autoBackupKeys=[] | e2e-tests/specs/20-dat-data-integrity-part1.e2e.ts [DAT-08] |
| 29 | DAT-10 | DB | — | corruptMarker=false | e2e-tests/specs/20-dat-data-integrity-part1.e2e.ts [DAT-10] |
| 30 | DAT-11 | SOURCE | — | singleInstancePlugin=false | e2e-tests/specs/20-dat-data-integrity-part1.e2e.ts [DAT-11] |
| 31 | DAT-19 | DB | — | purgeSettings=[] | e2e-tests/specs/20-dat-data-integrity-part1.e2e.ts [DAT-19] |
| 32 | DAT-20 | DB | — | FAIL (P0-21): journal_mode=wal but synchronous=1 (NORMAL) on the live connection; only NORMAL is set (src-tauri/src/db.rs:115; src-tauri/src/import/mod.rs:408), no FULL fsync on money commits. A committed sale can be los | e2e-tests/specs/20-dat-data-integrity-part1.e2e.ts [DAT-20] |
| 33 | DAT-28 | SOURCE | — | checkSettings=[], scheduledCheck=false, startupCheck=false | e2e-tests/specs/20-dat-data-integrity-part1.e2e.ts [DAT-28] |
| 34 | DAT-29 | DB | — | corruptMarker=false | e2e-tests/specs/20-dat-data-integrity-part1.e2e.ts [DAT-29] |
| 35 | DAT-30 | DB | — | snapshotKeys=[], attachments=false, license=false | e2e-tests/specs/21-dat-data-integrity-part2.e2e.ts [DAT-30] |
| 36 | DAT-31 | SOURCE | — | dailyWeeklyMonthly=false, manualWipeSweepable=false | e2e-tests/specs/21-dat-data-integrity-part2.e2e.ts [DAT-31] |
| 37 | DAT-32 | DB | — | restoreToTemp=false | e2e-tests/specs/21-dat-data-integrity-part2.e2e.ts [DAT-32] |
| 38 | DAT-33 | SOURCE | — | localOnly=true | e2e-tests/specs/21-dat-data-integrity-part2.e2e.ts [DAT-33] |
| 39 | DAT-35 | RUNTIME | — | FAIL (P0-22): restore_database_backup is not registered: "Command restore_database_backup not found when running execute/async"; the source marks the swap/restore lane REMOVED in Phase 4.4. There is no live-shop restore  | e2e-tests/specs/21-dat-data-integrity-part2.e2e.ts [DAT-35] |
| 40 | DAT-36 | RUNTIME | — | reverseRebuild=false | e2e-tests/specs/21-dat-data-integrity-part2.e2e.ts [DAT-36] |
| 41 | DAT-38 | SOURCE | — | wipePreBackup=true | e2e-tests/specs/21-dat-data-integrity-part2.e2e.ts [DAT-38] |
| 42 | DAT-40 | DB | — | versionAfterReplace=1, versionAfterUpsert=7 | e2e-tests/specs/21-dat-data-integrity-part2.e2e.ts [DAT-40] |
| 43 | DAT-43 | DB | — | deleteItem=true | e2e-tests/specs/21-dat-data-integrity-part2.e2e.ts [DAT-43] |
| 44 | DAT-47 | RUNTIME | — | cartBeforeHold=100000, cartAfterRecall=100000 | e2e-tests/specs/21-dat-data-integrity-part2.e2e.ts [DAT-47] |
| 45 | DAT-48 | DB | — | versionPredicate=false; operationsAdapter.ts:65-90 | e2e-tests/specs/21-dat-data-integrity-part2.e2e.ts [DAT-48] |
| 46 | DAT-50 | DB | — | receiptKey=true | e2e-tests/specs/21-dat-data-integrity-part2.e2e.ts [DAT-50] |
| 47 | DAT-55 | DB | — | holdId=hold-1792805787486-1-D5KD, beforeDeleted=0, afterDeleted=1, purged=true | e2e-tests/specs/21-dat-data-integrity-part2.e2e.ts [DAT-55] |
| 48 | DAT-56 | DB | — | auditInDelete=false | e2e-tests/specs/21-dat-data-integrity-part2.e2e.ts [DAT-56] |
| 49 | DAT-57 | SOURCE | — | preExport=false | e2e-tests/specs/21-dat-data-integrity-part2.e2e.ts [DAT-57] |
| 50 | DAT-58 | DB | — | retentionKeys=[] | e2e-tests/specs/21-dat-data-integrity-part2.e2e.ts [DAT-58] |
| 51 | DAT-59 | RUNTIME | — | validSaleOk=true | e2e-tests/specs/22-dat-data-integrity-part3.e2e.ts [DAT-59] |
| 52 | DAT-63 | DB | — | backupOk=false | e2e-tests/specs/22-dat-data-integrity-part3.e2e.ts [DAT-63] |
| 53 | DAT-65 | DB | — | attachmentTables=[] | e2e-tests/specs/22-dat-data-integrity-part3.e2e.ts [DAT-65] |
| 54 | DAT-69 | DB | — | backupOk=false, dbFiles=0 | e2e-tests/specs/22-dat-data-integrity-part3.e2e.ts [DAT-69] |
| 55 | DAT-74 | DB | — | identityCols=[device_id, public_key_hex, private_key_enc, enrolled_at, status, last_outbox_seq], machineCols=[] | e2e-tests/specs/22-dat-data-integrity-part3.e2e.ts [DAT-74] |
| 56 | DAT-75 | SOURCE | — | hardcodedSecret=true, exportedOtp=true | e2e-tests/specs/22-dat-data-integrity-part3.e2e.ts [DAT-75] |
| 57 | DAT-78 | RUNTIME | — | FAIL (P0-22): restore_database_backup is not registered ("Command restore_database_backup not found"), selectiveUi=[] and selectiveApi=false; no selective restore of one product/customer/period exists (src-tauri/src/lib. | e2e-tests/specs/22-dat-data-integrity-part3.e2e.ts [DAT-78] |
| 58 | DAT-82 | DB | — | updateChanges=1, deleteChanges=1, triggers=[] | e2e-tests/specs/22-dat-data-integrity-part3.e2e.ts [DAT-82] |
| 59 | DAT-87 | DB | — | verifyCommandOk=false | e2e-tests/specs/22-dat-data-integrity-part3.e2e.ts [DAT-87] |
| 60 | SCL-07 | DB | — | duplicateRows=2, unique=0 | e2e-tests/specs/23-scl-rcp-tim-i18.e2e.ts [SCL-07] |
| 61 | SCL-12 | DB | — | headerCount=0 | e2e-tests/specs/23-scl-scale-customers.e2e.ts [SCL-12] |
| 62 | SCL-13 | DB | — | headerCount=0 | e2e-tests/specs/23-scl-scale-customers.e2e.ts [SCL-13] |
| 63 | SCL-14 | BYTES | — | checkpoint busy=1 | e2e-tests/specs/23-scl-rcp-tim-i18.e2e.ts [SCL-14] |
| 64 | SCL-23 | BYTES | — | FAIL (P1-54): the backend returns 100,000 rows / 9,877,781 bytes to the WebView in one IPC payload (2,594 ms) with no cap or paging. | e2e-tests/specs/23-scl-scale-customers.e2e.ts [SCL-23] |
| 65 | SCL-26 | DB | — | FAIL (P2-48): two sales update one stored counters row (total_spent 0->2000, version 1->3) with no shard tables; the second sale takes 846 ms. | e2e-tests/specs/23-scl-rcp-tim-i18.e2e.ts [SCL-26] |
| 66 | SCL-36 | SOURCE | — | FAIL (P0-26): with 10M stock movements, one sale takes 178,091 ms because appendInventoryDeltas recomputes products.stock with SUM(delta) over the whole ledger; there is no chunked/resumable recompute job. | e2e-tests/specs/23-scl-scale-ledger-probe.e2e.ts [SCL-36] |
| 67 | SCL-37 | DB | — | changes=1/1 | e2e-tests/specs/23-scl-scale-db.e2e.ts [SCL-37] |
| 68 | SCL-45 | RUNTIME | — | FAIL (P1-48): create_database_backup fails with an FTS5 integrity_check readonly error and neither backup nor VACUUM performs a free-space preflight. | e2e-tests/specs/23-scl-rcp-tim-i18.e2e.ts [SCL-45] |
| 69 | SCL-46 | DB | DB + RUNTIME (row counts + query timings) | interruptApi=[] | e2e-tests/specs/23-scl-rcp-tim-i18.e2e.ts [SCL-46] |
| 70 | SCL-48 | BYTES | — | FAIL (P0-27): a 5,000-sale burst commits 0/200 attempts, adds only 36 transactions and 62 distinct receipt numbers, with ALREADY_PROCESSING for the rest; offline sales are dropped or collapsed. | e2e-tests/specs/23-scl-rcp-tim-i18.e2e.ts [SCL-48] |
| 71 | SCL-58 | DB | — | FAIL (P1-53): per-row ingest takes 1,274 ms versus 331 ms for the chunked path (3.8x); the per-row path is still used at SyncManager.ts:2397/2403. | e2e-tests/specs/23-scl-rcp-tim-i18.e2e.ts [SCL-58] |
| 72 | SCL-77 | DB | — | FAIL (P2-50): six bare-rowid references remain in cycleCountSql.ts:10-31 and schemaHeal.ts:49; a future VACUUM/rebuild can renumber them. | e2e-tests/specs/23-scl-rcp-tim-i18.e2e.ts [SCL-77] |
| 73 | SCL-78 | DB | DB + UI (stored totals + rendered total) | FAIL (P2-51): products/transactions/inventory_ledger/customers are not STRICT, money columns are REAL and a TEXT value is accepted in total; expected integer money or rejection. | e2e-tests/specs/23-scl-rcp-tim-i18.e2e.ts [SCL-78] |
| 74 | SCL-79 | SOURCE | — | startupSelfTestHits=[] | e2e-tests/specs/23-scl-rcp-tim-i18.e2e.ts [SCL-79] |
| 75 | SCL-83 | BYTES | — | FAIL (P2-53): a 91,810,112-byte WAL recovers in 2,670 ms but the splash has no progress/progressbar element, so recovery is invisible. | e2e-tests/specs/23-scl-scale-wal.e2e.ts [SCL-83] |
| 76 | RCP-06 | BYTES | — | FAIL (P1-50): a failed native print still shows a success toast and no visible printer-offline error; the cashier is told the receipt printed when it did not. | e2e-tests/specs/23-scl-rcp-tim-i18.e2e.ts [RCP-06] |
| 77 | TIM-01 | BYTES | DB + BYTES (receipt bytes AND transaction timestamps) | clockAuditRows=0 | e2e-tests/specs/23-scl-rcp-tim-i18.e2e.ts [TIM-01] |
| 78 | SYN-02 | DB | — | deviceDiscriminator=false | e2e-tests/specs/24-syn-sync.e2e.ts [SYN-02] |
| 79 | SYN-04 | DB | — | customerCas=true | e2e-tests/specs/24-syn-sync.e2e.ts [SYN-04] |
| 80 | SYN-26 | DB | — | privateKeySealed=true | e2e-tests/specs/24-syn-sync.e2e.ts [SYN-26] |
| 81 | SYN-27 | DB | — | tiedVersionGuard=true | e2e-tests/specs/24-syn-sync.e2e.ts [SYN-27] |
| 82 | MOB-03 | DB | — | cartLostSilently=true recoveryPrompt=false | e2e-tests/mobile/25-mob-mobile.mjs [MOB-03] |
| 83 | MOB-07 | BYTES | — | FAIL: the phone clock can be moved a year ahead with no audit trail. Setting 2027-01-01 10:00 produced receipt REC-20270101-LGFP1-02-R1GP4 (createdAt 2027-01-01T09:00:38.914Z) while clockAuditRows=0 and no warning was sh | e2e-tests/mobile/25-mob-mobile.mjs [MOB-07] |
| 84 | MOB-08 | RUNTIME | — | txBeforeLock=256 txDuringLock=256 txAfterRelease=257, errorShownWhileLocked=false | e2e-tests/mobile/25-mob-mobile.mjs [MOB-08] |
| 85 | MOB-09 | SOURCE | — | FAIL: no update gate between schema generations. The mobile build 1.6.8/13 runs schema 103 while the desktop build ships 112 and the source tree is at 128 (lag 25); forcedUpdateGateHits=0, updateBannerVisible=false, upda | e2e-tests/mobile/25-mob-mobile.mjs [MOB-09] |
| 86 | MOB-10 | SOURCE | — | flagSecure=false | e2e-tests/mobile/25-mob-mobile.mjs [MOB-10] |
| 87 | MOB-11 | SOURCE | — | landscapeNavVisible=false | e2e-tests/mobile/25-mob-mobile.mjs [MOB-11] |
| 88 | MOB-17 | SOURCE | — | background65sPinGate=false, caisseVisibleWithoutReauth=true | e2e-tests/mobile/25-mob-mobile.mjs [MOB-17] |
| 89 | MOB-20 | BYTES | — | FAIL: offline receipt numbers carry no terminal discriminator and are not unique. idx_transactions_receipt is a plain (non-UNIQUE) index and the format REC-<YYYYMMDD>-<msOfDay base36>-<same-ms seq>-<5 random> (src/utils/ | e2e-tests/mobile/25-mob-mobile.mjs [MOB-20] |
| 90 | MOB-21 | BYTES | BYTES + DB (printed receipt + stored row) | searchCount=0, searchProductVisible=false | e2e-tests/mobile/25-mob-mobile.mjs [MOB-21] |
| 91 | MOB-23 | RUNTIME | — | FAIL (P0): a hardware keyboard-wedge scan crashes the till. A 13-digit EAN followed by ENTER on the Caisse screen throws "ReferenceError: Cannot access 'y' before initialization" and shows the mobile error boundary (repr | e2e-tests/mobile/25-mob-mobile.mjs [MOB-23] |
| 92 | RCP-01 | BYTES | — | FAIL: FAIL: saleOk=true printAttempts=1 bytes=935 hasRaster=false hasImageCmd=false hasCodepage=false arabicUtf8Present=false maskedTitlePresent=true itemLine="G'*A 3'E3HF, ,'DC3J S24 'D*1'" raw=escpos.ts:56-60 charCodeA | e2e-tests/specs/26-rcp-tim.e2e.ts [RCP-01] |
| 93 | RCP-02 | BYTES | — | FAIL: FAIL: 80mm maxLineLen=67 nameLen=67 customerLineLen=42 label80Preserved=true name80="Cable USB-C Tresse 2M Charge Rapide 65W Compatible Samsung Apple ZX" cust80="Client: RCP26 Client Nom Tres Long 30X" \| 58mm maxLi | e2e-tests/specs/26-rcp-tim.e2e.ts [RCP-02] |
| 94 | RCP-05 | BYTES | — | FAIL: FAIL: reprintAttempts=1 sameBytes=true copyMarker=false txBefore=9 txAfter=9 receipt=REC-20261025-T22VQ-02-4DB0R id=TXN-1792931605910-1-7Q2S barcode="TXN-1792931605910-1-7Q2S" (reprintReceipt has no copy flag: the  | e2e-tests/specs/26-rcp-tim.e2e.ts [RCP-05] |
| 95 | RCP-07 | BYTES | — | FAIL: FAIL: sales=20/20 printAttempts=20 retriesAfterReconnect=0 printQueueTables=[] otherQueueTables=["dunning_queue"] printViaWindowsSpooler returns false on error (escpos.ts:394-406), callers are fire-and-forget (crea | e2e-tests/specs/26-rcp-tim.e2e.ts [RCP-07] |
| 96 | RCP-10 | BYTES | RUNTIME + BYTES (drawer pulse taps AND print-dialog behaviour) | FAIL: FAIL: cashSalePulses=1 cashSaleOk=true cardSalePulses=1 cardClicked=true confirmLabel="Valider Carte CIB (1 000 DA) Entr├⌐e Γå╡" method=CIB / Edahabia cardLegReal=true (pulses counted from the spooler's own [Cash D | e2e-tests/specs/26-rcp-tim.e2e.ts [RCP-10] |
| 97 | RCP-11 | BYTES | — | FAIL: FAIL: barcodePayload="TXN-1792931643190-1-86D9" receiptNumber="REC-20261025-T2VNA-02-RLQKW" internalId="TXN-1792931643190-1-86D9" encodesDocumentNumber=false encodesInternalId=true dotsNeeded=528 printableDots=576  | e2e-tests/specs/26-rcp-tim.e2e.ts [RCP-11] |
| 98 | RCP-12 | BYTES | — | FAIL: FAIL: logoUrlSet=true bytes=925 hasRaster=false hasImageCmd=false arabicUtf8Present=false header="Caf├⌐ ├ël├⌐gant BGH)" footer="3J'3) 'D%1,'9: 7 #J'E \u0014 Merci de votre" (ReceiptPaper renders the logo in the DOM | e2e-tests/specs/26-rcp-tim.e2e.ts [RCP-12] |
| 99 | RCP-13 | BYTES | — | FAIL: FAIL: total="TOTAL NET A PAYER: 1/234/567┬áDA" unit="1 x 1/234/567┬áDA 1/234/567┬áDA" slashedGroups=true realGroupSeparator=false formatDZD uses U+202F group separator; text() masks it to 0x2F '/' (escpos.ts:56-60) | e2e-tests/specs/26-rcp-tim.e2e.ts [RCP-13] |
| 100 | RCP-15 | BYTES | — | FAIL: FAIL: giftReceiptHits=0 depositSlipHits=0 avoirHits=12 tradeInHits=12 zReportHits=15 refund/trade-in/Z builders exist; no price-free (gift) ticket and no deposit slip builder exist | e2e-tests/specs/26-rcp-tim.e2e.ts [RCP-15] |
| 101 | RCP-16 | BYTES | — | FAIL: FAIL: fakeClock=2026-03-29T01:30:00.000Z storedCreatedAt=2026-03-29T01:30:00.000Z reprintAttempts=1 printed="Date: 29/03/2026 02:30:00" reprintedWithDeviceTZShift="Date: 29/03/2026 03:30:00" offsetMarker=false shop | e2e-tests/specs/26-rcp-tim.e2e.ts [RCP-16] |
| 102 | RCP-18 | BYTES | — | FAIL: FAIL: cashierLine="Vendeur: E2EGerant" registerLine="Caisse: Caisse 8-1-Y4Q2" deviceLine="<absent>" copyMarker="<absent>" (escpos.ts:224-227 prints Ticket/Date/Caisse/Vendeur only) | e2e-tests/specs/26-rcp-tim.e2e.ts [RCP-18] |
| 103 | RCP-21 | BYTES | — | FAIL: FAIL: shiftRename=renamed cashierName=┘à╪¡┘à╪» ╪ú┘à┘è┘å vendorLine="Vendeur: E-E/ #EJF" arabicPreserved=false maskedToLatin=true (no bidi/shaping layer; text() masks each UTF-16 unit to its low byte, escpos.ts:56-6 | e2e-tests/specs/26-rcp-tim.e2e.ts [RCP-21] |
| 104 | RCP-22 | BYTES | — | FAIL: FAIL: imeiLine=" IMEI: 356938035643809" digits=356938035643809 barcodeCount=1 barcodes=["TXN-1792931670272-1-WPUD"] imeiBarcode=false (escpos.ts:248-250 prints the IMEI as text; the only barcode is the ticket id, e | e2e-tests/specs/26-rcp-tim.e2e.ts [RCP-22] |
| 105 | RCP-23 | BYTES | — | FAIL: FAIL: warrantyLines=[] genericTemplate=true conditionVariantsInReceiptModules=0 ([]) arabicWarrantyLine=false (one generic line built from warrantyMonthsMax, escpos.ts:334-336; no per-condition wording) | e2e-tests/specs/26-rcp-tim.e2e.ts [RCP-23] |
| 106 | TIM-02 | BYTES | DB + BYTES (receipt bytes AND stored created_at) | FAIL: FAIL: createdAt=2026-10-25T12:34:49.218Z businessDayKey=2026-10-25 receipt=REC-20261025-T3V5S-02-860MW printedDay=2026-10-25 base="Date: 25/10/2026 13:34:49" withDeviceTZShift="Date: 26/10/2026 01:34:49" shiftedDay | e2e-tests/specs/26-rcp-tim.e2e.ts [TIM-02] |
| 107 | TIM-07 | DB | — | FAIL: FAIL: jumpLanded=true attempts=[{"k":2,"armed":true,"readsBeforeJump":2,"readsTotal":7,"jumped":true,"saleOk":true,"reason":"-","createdAt":"2026-10-25T12:39:56.948Z","driftMs":299909}] txDelta=1 clockAuditRows=0 ( | e2e-tests/specs/26-rcp-tim.e2e.ts [TIM-07] |

## Method

Classification was done from `fixtures/fail-cases.json` (the canonical reason +
citation for each FAIL), not from memory. A case is `BYTES` when the assertion
decodes the ESC/POS stream, `DB` when it reads a row/column back, `RUNTIME`
when it observes command registration or interaction behaviour, and `SOURCE`
only when the feature is absent and no runtime artifact can exist.

Receipt and clock FAILs (all `RCP-*`, `TIM-01/02`, four `SCL`, three `MOB`) rest on
decoded bytes; several of them also carry a DB assertion, recorded in the
*Secondary* column. `RCP-10` was previously listed as "UI text match only" — it is
not: the drawer pulse is proven by console taps and print-dialog behaviour, with
the byte stream as the decisive artifact.

---

## Batch 27a additions (17 new FAILs, 2026-10-26)

Classified with the same rule; **UI-only: 0**.

| Class | Cases | Count |
|---|---|---|
| DB | SCL-27, SCL-31, SCL-61, SCL-03, SCL-76, SCL-57 | 6 |
| PLAN (EXPLAIN QUERY PLAN / schema) | SCL-02, SCL-71, SCL-74, SCL-10, SCL-88 | 5 |
| BYTES (IPC payload size) | SCL-23 | 1 |
| DOM (geometry + rendered state) | SCL-04, SCL-06 | 2 |
| RUNTIME | SCL-11, SCL-62 | 2 |
| SOURCE + RUNTIME | TIM-09 (formatter source + measured 12 h zone divergence) | 1 |

Every one of these quotes raw numbers in `BATCH27A-SCL.md` §3 (row counts,
decoded byte sizes, query plans, canvas pixels, wall-clock ms) - none rests on
visible text alone.

## Batch 27b additions (9 new FAILs, 2026-10-26)

Classified with the same rule; **UI-only: 0**. Evidence lives in
`logs/part0-27b.log` (one `VERDICT=` line per case) and `BATCH27B-LBL-HW.md`.

| Class | Cases | Count |
|---|---|---|
| BYTES (emitted label bytes, counted) | LBL-05 (TSPL `PRINT n` = 501->500, 1000->500; ESC/POS `GS k` 51->50), LBL-06 (title 56->24 UTF-16 units; emoji cut mid-surrogate -> U+FFFD) | 2 |
| RUNTIME (shipped function executed, result observed) | LBL-08 (`findBarcodeDuplicate` returns undefined for the live list, so a tombstoned barcode is reusable), HW-01 (Tab burst: 0 scan events, 0 cart delta; Enter control: 1 event, cart moved) | 2 |
| SOURCE (static absence only) | LBL-02 (type union `code128 \| ean13`), LBL-04 (no last-printed price / stale prompt), LBL-09 (no repair-ticket builder), LBL-12 (no IMEI/warranty field), LBL-13 (no mobile->desktop relay) | 5 |
| DB | - | 0 |
| UI | - | 0 |
| **Total** | | **9** |

Cumulative FAIL classes: DB 54, BYTES 26, RUNTIME 11, SOURCE 25, UI 0 = **116**
(the 27a additions keep their own PLAN/DOM sub-classes, all of which are
non-text evidence).

## Batch 27c additions (13 new FAILs, 2026-10-26)

Classified with the same rule. Evidence lives in `logs/part0-27c.log` (one
`VERDICT=` line per case, plus 4 `FACT=` lines) and `BATCH27C-I18-DAT.md`.

| Class | Cases | Count |
|---|---|---|
| BYTES (emitted print bytes, counted) | I18-03 (`أحمد بن علي` -> `23 2d 45 2f 20 28 46 20 39 44 4a`, no code page), I18-07 (`🔛@X` -> `3d 1b 40 58`, raw `ESC @`) | 2 |
| RUNTIME (shipped function executed, result observed) | I18-04 (product fold 8/10, customer fold 2/10 on the same pairs), I18-08 (importer: `1 234,56`->`123456`, `12,5`->`125`), I18-09 (wedge: ASCII burst +1200000 minor, Arabic-Indic/AZERTY bursts 0), I18-11 (5 Mohamed variants -> 5 keys, Arabic -> `""`) | 4 |
| SOURCE (static absence only) | I18-06 (18 `localeCompare`, 0 explicit locale, 0 `Intl.Collator`), I18-12 (single free-text `name`), DAT-79 (no replica/standby/RPO/promotion drill), DAT-84 (3/10 signals, no alert channel) | 4 |
| DB (row/column assertion) | I18-13 (`customers` row `{name:"B27 Tel Court", phone:"055012345"}` — invalid accepted), I18-15 (`customers` row keeps NBSP+RLM in `name`) | 2 |
| UI (DOM hit-test/geometry) | I18-01 (`elementFromPoint` at the language control returns the cash-sheet backdrop; real click intercepted) | 1 |
| **Total** | | **13** |

Cumulative FAIL classes: DB 56, BYTES 28, RUNTIME 15, SOURCE 29, UI 1 = **129**.
Visible-text-only FAILs remain **0**: the single UI case rests on a hit-test,
not on a rendered string.

## Batch 27d additions (9 new FAILs, 2026-10-26)

Classified with the same rule. Evidence lives in `logs/part0-27d.log` (one
`VERDICT=` line per case, 7 `FACT=` lines) and `BATCH27D-RPT.md`. The two 27d
PASSes (RPT-03, RPT-08) are not classified here; the PASS-PARTIAL (RPT-06) is
not a FAIL.

| Class | Cases | Count |
|---|---|---|
| RUNTIME (shipped function executed, totals compared to an independent oracle) | RPT-01 (product dimension 84 500 DA vs CA Net 78 500; top-5 74 000 leaves 10 500 outside; donut positives 26 300 vs all 25 300), RPT-04 (window starts 16.2 h apart; day-7 sale 12 000 DA counted by one report only), RPT-05 (row cost 54 200 vs 54 000; row profit 29 300 vs 26 500; items sheet 84 500 vs 78 500), RPT-12 (same label: 78 500 desktop vs 64 000 mobile, 14 500 DA gap) | 4 |
| BYTES (decoded ESC/POS statement) | RPT-07 (5 of 8 movements printed; balance "13/450" — U+202F separator truncated to 0x2F; ledger sum 6 000 vs printed 13 450) | 1 |
| SOURCE (static absence only) | RPT-09 (no `cashierId` in `SaleTransaction`), RPT-10 (no per-cashier/drawer/device variance aggregation, no force-close), RPT-11 (no warranty/claim report), RPT-13 (no customer segment model) | 4 |
| DB | - | 0 |
| UI | - | 0 |
| **Total** | | **9** |

Cumulative FAIL classes: DB 56, BYTES 29, RUNTIME 19, SOURCE 33, UI 1 = **138**.
Visible-text-only FAILs remain **0**.

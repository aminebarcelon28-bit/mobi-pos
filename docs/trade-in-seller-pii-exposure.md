# Seller identity (PII) exposure in the trade-in sync path

Status: **proposal only — nothing is implemented, no remote query was run, no
migration was executed.** The owner decided that sync, retention, deletion and
encryption behaviour must not change in this batch. This document records the
exposure with `file:line` evidence so the decision can be made on facts.

## 1. What the field is

`TradeInItem.nationalIdNumber` is the seller's identity-document number
(CNI / Permis / Passeport), collected for the **Livre de Police**. It is the
seller's PII, not the shop's. It is legally required in the police register and
must never appear in a customer-facing print.

This batch added `TradeInItem.nationalIdType` next to it (optional, JSON only).
**Both fields are in scope for this document.**

PII currently inside the same payload:

| Field | PII | Note |
|---|---|---|
| `customerName` | yes | Seller's name; also the previous owner's name |
| `customerPhone` | yes | Seller's phone |
| `nationalIdNumber` | yes | Government document number — highest sensitivity |
| `nationalIdType` | no | Document *kind*, not an identifier |
| `imei`, `barcode`, amounts, `createdAt` | no | Device / commercial data |

## 2. Exact propagation path (all plaintext)

| Step | Evidence |
|---|---|
| 1. Operator types the number | `src/components/modals/TradeInBuybackModal.tsx` (`nationalIdNumber` / `nationalIdType` state) |
| 2. Written into the record | `src/store/slices/createUISlice.ts:846` (`processTradeIn` builds `TradeInItem`) |
| 2'. Same, exchange/staged leg | `src/store/slices/createUISlice.ts:1213` (`commitStagedTradeInIntake`) |
| 3. Persisted locally | `src/db/adapters/operationsAdapter.ts:92` → `saveTradeIn` → Dexie `tradeIns.put` |
| 4. Pushed to the remote | `src/db/adapters/operationsAdapter.ts:92` `void fireSync('trade_in', trade.id, trade)` — the **entire object** |
| 5. Lane mapping | `src/sync/SyncManager.ts:106` `trade_ins: { dexie: 'tradeIns', ts: ['createdAt'] }` |
| 6. Remote storage | `src-tauri/src/lib.rs:1011-1017` — `trade_ins` with `customer_name TEXT NOT NULL` **and** `json_payload TEXT NOT NULL`; `src-tauri/src/lib.rs:1018` indexes the IMEI |
| 7. Pulled back to any device | same lane, `SyncManager.ts:106` → Dexie `tradeIns` |
| 8. JSON backups | `src/schemas/backupSchema.ts:63` (`tradeIns?: TradeInItem[]`), serialized at `:89` |

There is a **second** copy of the seller's name outside `trade_ins`:

| Step | Evidence |
|---|---|
| Seller name written into free text | `src/store/slices/createUISlice.ts:870` and `:1271` — `notes: \`Rachat d'occasion: … - Client: ${newTradeIn.customerName}\`` |
| Synced as its own lane | `src/sync/SyncManager.ts:107` `imei_records: { dexie: 'imeiRecords', ts: ['soldAt', 'receivedAt'] }` |
| Remote table | `src-tauri/src/lib.rs:1019` (`imei_records`) |

So a device bought in twice carries the **previous owner's name in free text**
in `imei_records.notes`, which no masking or projection can remove.

## 3. What is verified, and what is not

- **Verified by test** (`scripts/test_warranty_chain_scenarios.mts`, S28): the
  warranty certificate (58 mm + 80 mm), the sale-receipt view model, the SAV
  repair voucher, chassis tag, workshop slip and restitution ticket contain
  **no** seller name, phone or document number. Exactly two renderers print it,
  by design: `tradeInVoucherBuilder.ts` (police register, 80 mm) and
  `tradeInText` (buyback slip, 58 mm).
- **Not verified**: no live Turso database was inspected. The row counts and the
  historical payloads on the merchant's remote are unknown. No dry run was run.

## 4. Options (none implemented)

### Option A — local-only (`nationalIdLocalOnly` flag), default OFF

Add `nationalIdLocalOnly?: boolean` to `TradeInItem`. When true, the writer
stamps the record as local-only and `fireSync` pushes the object **with
`customerName`, `customerPhone`, `nationalIdNumber` replaced by `''`**; the
local row keeps the real values.

- Cost: low. One writer branch + one sync branch.
- Consequence, and it is a real one: **every other device and the merchant's
  remote lose the police-register fields.** A physical register that only
  exists on the till that took the device is not a register.
- Backup files are unaffected (they are per-device and still carry the value).
- Needs an owner ruling on whether the police register is allowed to be
  device-local at all.

### Option B — field-level encryption

Encrypt `customerName` / `customerPhone` / `nationalIdNumber` in the payload
with a merchant key held natively (never in the WebView), decrypt on read.

- Cost: high — new native command, key lifecycle, rotation, and a decision about
  what a device that lacks the key displays (fail closed: masked).
- Preserves the register on every device and in the remote.
- Does not help `imei_records.notes`: free text cannot be selectively
  encrypted, so that lane must be changed to stop writing the name at all.

### Option C — do nothing now (current decision)

Keep the plaintext payload. Accept that the merchant's remote and every synced
device hold seller PII, mitigated by masked-by-default UI and a logged,
manager-only reveal.

## 5. Proposed, NOT executed, dry run

Before any migration, a read-only plan would answer three questions. It must be
approved before it runs, and it must not write:

1. How many remote `trade_ins` rows carry a non-empty `nationalIdNumber`?
2. How many distinct `imei_records.notes` contain `- Client:`?
3. How many rows predate the `nationalIdType` field (they must keep rendering
   `Pièce (type non précisé)`)?

Nothing in this batch queries the remote. No schema change, no
`ALTER TABLE`, no backfill.

## 6. Open questions for the owner (not agent calls)

- Legal retention period for the police register, and who may purge it. This is
  a legal/accounting decision; the agent must not set it.
- Whether a device-local register (Option A) satisfies the obligation.
- Whether the remote may hold unencrypted document numbers at all.
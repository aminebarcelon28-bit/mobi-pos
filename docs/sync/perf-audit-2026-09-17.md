# MobiPOS Mobile Performance Audit — Cloud Sync Bottleneck Investigation

**Date:** 2026-09-17 · **Scope:** measured audit (no production changes, no commits).
**Deliverables:** this report + `perf-optimization-guide-2026-09-17.md` (same folder).
**Question:** is cloud sync the primary cause of the mobile-app freezing?

## 0. Verdict (read this first)

**Yes — with a precise mechanism.** The network side of sync is well batched
(12 cloud roundtrips move a 5,300-row first sync). The freeze is **main-thread
CPU + GC pressure on the WebView thread**, in this order:

| Rank | Cause | Measured cost | Where |
|---|---|---|---|
| 1 (acute) | Poisoned blob rows re-downloaded, parsed, and mirrored into Dexie **unsanitized** | 20 MB page → 150 MB heap transient, 219 ms CPU (node); live row is now **38.64 MB** | `SyncManager.ts:1520-1550` vs sanitized SQLite path `:1504` |
| 2 (chronic) | Every peer sale triggers a **full-history** Dexie transaction rebuild | 141.9 ms of a 171.7 ms pull cycle = **83 %** (500-txn history, node) | `SyncManager.ts:1211-1220` → `backfill.ts:190-314` |
| 3 (one-off) | First sync: serial per-row apply + per-product Dexie mirror | 4.2 s CPU, 5,897 IPC ops, 6,625 Dexie ops, +55.6 MB heap (5,300 rows) | `SyncManager.ts:1141-1168`, `sqlPluginAdapter.ts:569-644` |
| 4 (chronic) | Push bookkeeping: 2 IPC calls per outbox row + 17 cursor reads per pull | 104 IPC per 50-row push; 22 IPC per idle pull | `SyncManager.ts:677-782`, `:1091-1106` |

**Explicitly innocent:** checkout (`S4`: 39 IPC, ~0 ms CPU — fast and local),
the network protocol itself, and cold-start JS parse (≈25 ms desktop for the
841 KB chunk). Cold start has real but second-order issues (§6).

A merchant running the current live cloud DB (§7) freezes because **every
5-second pull cycle can drag tens of megabytes of base64 through the WebView
heap**, and every peer sale re-runs an O(history) rebuild on top.

### How to read the numbers

- `cpuMs` = main-thread busy time on desktop Node 24 (V8). Rule of thumb used
  in this report: **×1 desktop, ×2.5 Android-mid, ×4–6 Android-low** (slower
  single thread + GC pressure). Awaited network/IPC latency does **not** block
  the main thread — only CPU between awaits does. "Modeled wall" figures are
  given for completeness but the freeze analysis uses CPU + heap.
- All scenario numbers come from executing the **real app code** (see §1).

## 1. Method

**Harness:** `C:\Users\Click\Desktop\perf-harness\mobipos-harness`
(portable via `MOBIPOS_REPO` env; this run pointed at this repo).
`npm install`, then `node entry.mjs`. It runs the real
`SyncManager`/`sqlPluginAdapter`/`backfill`/`tursoClient` against three mocks:
in-memory local SQLite shape (`mocks/tauri-plugin-sql.mjs`), in-memory cloud
(`mocks/libsql-client.mjs`, incl. faithful failures: no `event_log` table,
duplicate-column ALTERs), and real Dexie 4 over `fake-indexeddb`.
`node probe.mjs` re-ran two scenarios dumping the in-app `perfTrace` spans.

**Dataset** (`seed.mjs`, shapes mirror `src/types/pos.ts`): 1,500 products,
500 transactions × 3 items, 300 customers, 1,500 ledger rows, plus the forensic
poison rows from `diagnostic-baseline-2026-09-17.md` (20.26 MB product blob,
~779 KB receipt blob).

**Device profiles are MODELED, not measured** (no emulator on this machine):
desktop `{ipc 0.15 ms, dexie 0.05 ms, rtt 60 ms, 100 Mbps}`,
androidMid `{0.70, 0.30, 250, 10}`, androidLow `{1.80, 0.80, 500, 3}`.
The guide (§5 of the companion doc) gives the on-device capture protocol that
replaces these with real numbers. No Android cold-start/pull numbers are
claimed as measured.

**Live-cloud forensics** were strictly read-only (`SELECT`, `LENGTH`,
`PRAGMA` via a throwaway script; the merchant DB was never written to).

## 2. Measured breakdown

Full tables: `results.json`, per-statement log `boot-statements.json`,
span dump `probe-spans.json` (all in the harness folder).

| Scenario | CPU (node) | IPC (x/s) | Dexie ops | Cloud | Heap Δ | Modeled wall mid / low |
|---|---|---|---|---|---|---|
| BOOT `getLocalDb()` | ~3 ms | 36 (33/3), **22 failed** | 0 | 0 | — | — |
| S1 idle push+pull (no changes) | 16 ms | 22 (0/22) | 0 | 2 RT | +3.3 MB | 539 ms / 1,079 ms |
| S2 1 peer sale over 500-txn history | **234 ms** | 39 (17/22) | 17 | 2 RT, 11 rows / 10 KB | +18 MB | 789 ms / 1,392 ms |
| S3 first 50-row push (cold session) | ~0 ms | 104 (100/4) | 0 | 20 RT (18 one-time) | +4.4 MB | 5,284 ms / 10,891 ms |
| S3b warm 50-row push | ~0 ms | 104 (100/4) | 0 | 2 RT | +2.9 MB | 782 ms / 1,884 ms |
| S4 checkout (3 items, 1 serialized) | ~0 ms | 39 (32/7), **4 doomed** | 0 | 0 | +1.3 MB | 27 ms / 70 ms |
| S5 first sync, 5,300 rows / 12 RT | **4,219 ms** | 5,897 (5,315/582) | 6,625 | 4,633 KB read | +55.6 MB | 20,603 ms / 50,364 ms |
| S6 20 MB poison page (32 rows) | 219 ms | 58 (36/22) | 116 | 20,585 KB read | **+149.8 MB** | 32,966 ms / 108,654 ms |
| S7 reconstruct 200/400/800 txns | 47 / 32 / 78 ms | 1 / 1 / 1 | 3 | 0 | — | — |
| S8 779 KB outbox row | ~0 ms | 5 | 0 | 1 RT | — | quarantined `failed`, "762KB > 512KB budget" |
| S9 double-sanitize microbench | — | 0 | 0 | 0 | — | 2.00× cost (0.045 vs 0.022 ms/row large) |
| S10 840 KB bundle proxy | 25 ms compile | 0 | 0 | 0 | — | order-of-magnitude only |

**Span attribution (probe, node CPU):**

- *P1 — one peer sale:* `pull.total` 171.7 ms =
  `reconstructTxns` **141.9** + `applyLoop` 12.9 + `mirrorStockToDexie` 10.5 +
  `batchRead` 1.5 + `stockRecompute` 0.4 + `cursorReads` 0.2.
- *P2 — first sync (4 pull rounds):* `pull.total` 3,588.9 ms =
  `mirrorStockToDexie` **2,374.3** + `applyLoop` 738.9 + `reconstructTxns`
  431.7 + `stockRecompute` 25.9 + `batchRead` 14.5.
- *Per-row apply (first sync):* products 0.24 ms × 1,500; transactions
  0.46 ms × 500; customers 0.37 ms × 300; items/ledger ~0.01 ms.

**Build (measured `npm run build`, exit 0):** eager `index-*.js`
**841.57 KB** (gzip 245.83 KB); lazy chunks exist (Reports 97 KB, Settings
129 KB, database 97 KB). Rolldown warns about >500 KB chunks and reports
`SyncManager.ts` as `INEFFECTIVE_DYNAMIC_IMPORT` (statically retained by 7
modules despite `import()` call sites).

## 3. Ranked findings (file:line evidence)

**F1 — Poisoned rows bypass the sanitizer on the Dexie mirror path (P0).**
`applyRemoteRow/products` writes SQLite with `cleanRemoteJson(r.json_payload)`
(`SyncManager.ts:1504`, measured local copy 830 B) but builds the Dexie record
from `...JSON.parse(r.json_payload)` raw (`:1522-1550`) — measured Dexie copy
**20,260,799 B**. The mirror is what the UI reads. S6: +149.8 MB heap, 219 ms
CPU for one 20 MB page; the live row is now 38.64 MB (§7), so scale ≈2×.

**F2 — Full-history rebuild on every triggering pull (P0 chronic).**
Any transaction/item/customer row sets `transactionsNeedReconstruction`
(`SyncManager.ts:1147-1149`) →
`reconstructDexieTransactionsFromSql(db)` (`:1211-1220`) re-reads **all**
transactions (`backfill.ts:193`), all items (`:207-209`), whole catalog +
customers into memory (`:220-223`), re-parses every receipt (`:229-304`),
`bulkPut`s everything (`:307`). Measured 83 % of a peer-sale cycle; fires
every 5–6 s (`:94-95`, `:311-312`) while any peer sells.

**F3 — Per-product Dexie mirror does get+put per row (P1).**
`syncProductsFromSqlToDexie` (`sqlPluginAdapter.ts:587-627`): one `SELECT`,
then per product a `get` + conditional `update`/`put` inside a transaction.
Measured 66 % of first-sync CPU (2,374 ms / 1,500 products × 3 rounds).
Same `...base` spread pattern as F1 but fed from already-clean SQLite rows.

**F4 — Serial per-row pull apply (P1).**
`for (const row of rsRows) { await this.applyRemoteRow(...) }`
(`SyncManager.ts:1141-1168`): each row costs its own IPC `INSERT` plus, for
transactions, an existence `SELECT` (`:1358`), a Dexie `get` (`:1360`), and a
`put` (`:1422`); products cost an `INSERT` (`:1481`) plus a Dexie `put`
(`:1550`). Measured 5,315 executes + 582 selects for 5,300 rows; 0.24–0.46 ms
CPU/row on node (≈1–2.5 ms/row on android-low before IPC latency).

**F5 — Push/pull bookkeeping storms (P2).**
Per outbox row: `markOutbox(inflight)` + `markOutbox(synced|failed)` =
2 IPC (`SyncManager.ts:704`, `:712-782`) → 100 executes per 50-row push
(measured S3/S3b). Per pull: 17 sequential cursor reads (`:1091-1106`,
measured 17/19 selects in S1/debug probe) + server-clock probe + one-time
remote-schema ensure (18 RT on cold session, S3).

**F6 — Double JSON sanitize per transactions row (P2, free).**
`sanitizeSyncPayload(JSON.parse(cleanRemoteJson(...)))`
(`SyncManager.ts:1399-1400`; `cleanRemoteJson` itself = parse+sanitize+
stringify, `:79-82`). Measured exactly 2.00× (S9). Same single-use pattern at
`:1378` is fine.

**F7 — Broken ES-LFP event lane charges full price for zero function (P2).**
Writer emits `INSERT INTO event_log (event_type, …)` (`eventInterceptor.ts:83`,
also `eventSyncEngine.ts:66`, `:144`) but the local table has no such columns
(`src-tauri/src/lib.rs:700-709`) and the cloud schema has no `event_log`
table at all (forensics §7). Measured: 4 doomed INSERTs per checkout (S4),
1 failed cloud RT per pull cycle (prior + current run logs), plus failing
local reads (`eventSyncEngine.ts:44`, replay path). Nothing reads this lane
successfully anywhere.

**F8 — Checkout runs ~39 autocommit IPC statements, no transaction wrapper
(P2).** `writeCheckoutAtomic` (`sqlPluginAdapter.ts:268-562`): measured 32
executes + 7 selects (S4). Fast and local — not the freeze — but one
mid-flight kill leaves a torn sale; kept out of the freeze critical path,
listed because Phase 2 touches the same code.

**F9 — Cold-start drag (P3, second-order).**
841.57 KB eager chunk (measured); `SyncManager` statically retained despite
dynamic imports (build warning); all six mobile tabs statically imported
(`CompanionShell.tsx:6-11`); `initDatabase` awaits 16 full-table loads
serially (`createUISlice.ts:412-427`); boot fires 36 IPC ops incl. 22 doomed
`ALTER TABLE` duplicates (measured BOOT). None of this freezes the app alone;
it sets the floor the sync storms pile onto.

## 4. The poisoned-row analysis (live forensics, read-only)

The merchant cloud DB (`zou-zoughlal`, read 2026-09-17, never written to):

| Row | json_payload | Updated |
|---|---|---|
| `prod-1789591848585-909` (baseline's exact ID) | **38.64 MB** (was 20.26 MB) | today 16:54 |
| `prod-2` | 0.55 MB | today 16:41 |
| `TXN-1789599857746-1364`, `TXN-1789599875039-8611` | 4.84 MB each | today 14:22 |
| `TXN-1789665012960-3871` | 2.08 MB | today 17:10 |
| 2 more receipts | 0.27 MB each | today 17:07 |

DB size 92 MB (22,537 × 4 KB pages), 37 MB freelist → ~55 MB live. The blob
is **growing** (re-saved through paths that re-embed it) and receipts keep
embedding multi-MB payloads *today*. Consequences: (a) every fresh-device
first sync downloads ~50 MB of base64 into the WebView heap (S5-class cost at
~10× the measured scale); (b) every pull page containing these rows repeats
the S6 parse/mirror/GC storm; (c) the S8 push gate (512 KB, `SyncManager.ts:69`)
quarantines *outbound* giants but nothing stops *inbound* ones — F1's mirror
bypass then plants them in Dexie permanently. The purge procedure exists and
is referenced in the guide (dry-run by default; **not executed** in this audit).

## 5. Threats to validity (what these numbers are not)

1. Mock SQLite/IndexedDB ≠ device engines; per-op latencies are modeled from
   three uncalibrated profiles. CPU ratios (×2.5/×4–6) are engineering
   judgment, not measurement — the guide's capture protocol replaces them.
2. `fake-indexeddb` runs in-process; real IndexedDB crosses an async boundary
   (more latency, less main-thread CPU per op).
3. Single-run scenario numbers (except S9's interleaved medians and S7's
   scaling trio). Shapes are stable across runs (prior run-output.log shows
   the same failure signatures); magnitudes carry ±20 % noise.
4. The seed's 20 MB poison understates production's 38.64 MB row — scale S6
   linearly (≈2×) for today's reality.
5. S10 is a synthetic proxy, not the real chunk under a profiler.

## 6. §8.2 discrepancy notes (charter/docs vs reality)

1. `AGENTS.md` mandates **Vue 3**; the app is **React 19**
   (`package.json:47-48`). All Vue-specific guidance in the charter does not
   apply to this tree.
2. `AGENTS.md` routes work via `docs/TAURI_V2_POS_PLAYBOOK.md` — **the file
   does not exist** (`docs/` contains 7 other docs, no playbook).
3. Charter "Engine A" (`turso` crate push/pull) vs reality: `crates/pos-core`
   exists (incl. `turso_engine.rs`) but **`src-tauri` does not depend on
   `pos-core`** (neither `Cargo.toml` references it); live sync is JS
   (`tursoClient.ts` + `plugin-sql`). Engine A is an ADR-0009 aspiration, not
   the running system.
4. Contract-C1 "two-device suites" are **single-process node invariant
   scripts** (`scripts/test_*.mjs`), not device फ़arms; C1 ≤ 1.5 s has no
   measured device evidence either way.
5. Brief line citations drifted (working tree moved): all file:line references
   above were re-verified against the tree on 2026-09-17.

## 7. Critical process finding (left safe, flagged for follow-up)

The working tree contained a **crash introduced by the prior instrumentation
pass** (uncommitted): the `push.total` span hook placed in `pushOnce`'s
`finally` referenced try-scoped `okCount` (`SyncManager.ts:818`), throwing
`ReferenceError` on *every* completed push — which also skipped
`this.pushing = false`, **wedging all future pushes after the first one**.
Reproduced under the harness, then neutralized by removing that single hook
line (Step-5 cleanup removes the remaining hooks, restoring the committed
code, which never had the bug). Notes: `tsc -b`, `oxlint`, and `npm test`
all passed with the crash present — none of them executes `pushOnce`
end-to-end. Recommended follow-up (guide P0): a completion smoke test that
fails closed on this class.

## 8. Reproducing this audit

```bash
cd C:\Users\Click\Desktop\perf-harness\mobipos-harness
npm install
node entry.mjs        # full S0–S10 → results.json, boot-statements.json
node probe.mjs        # span attribution (peer sale + first sync) → probe-spans.json
node debug1.mjs       # smoke: module load, Dexie wrap, lone pullOnce
# Debug1/runner path fix + live-binding fix + crash-hook removal are already applied.
# MOBIPOS_REPO env overrides the repo location (default: this machine's clone).
```

Harness edits made during this audit (measurement tooling only, all outside
the repo): path portability (`REPO`/`MOBIPOS_REPO`), output paths relative to
the harness dir, `getLocalDb()` priming + live-binding fix in `debug1.mjs`,
new `probe.mjs`. `results.json`, `boot-statements.json`, `run-output.log`,
`probe-spans.json` are the measured artifacts.

## 10. Remediation log (2026-09-18 — all findings fixed, measured)

Every fix was re-measured with the same harness (exit 0). Before → after:

| Area | Before | After |
|---|---|---|
| Boot probes | 36 IPC, 22 doomed | 15 IPC, 1 doomed (probe gate) |
| Idle pull cycle | 22 IPC + 2 RT | 4 IPC + 1 RT |
| Peer-sale pull CPU | 234 ms | 47 ms (−80 %) |
| 50-row push bookkeeping | 104 IPC | 5 IPC (−95 %) |
| Checkout shadow waste | 4 doomed INSERTs | 1 (circuit-breaker trip), then zero |
| First sync | 4,219 ms CPU, 6,625 Dexie ops | 3,548 ms CPU, 3,631 Dexie ops |
| Poison mirror | 20,260,799 B in Dexie | 425 B (sanitized) |
| Eager chunk | 841.57 KB | 708.13 KB (−133 KB jsQR split) |

Code changes: single sanitize (F6), boot probe gate, batched cursors,
`markOutboxMany` set bookkeeping, event-lane retirement with session circuit
breaker (ADR-0010; P1 lifecycle gate still exercises the full write→reduce
path unmodified), sanitized Dexie product mirror (F1), incremental
reconstruct via touched txn IDs (F2), bulk Dexie mirror (F3), chunked apply
with per-chunk cursor commits — per-row writes retained, plugin-sql v2 has no
local batch API (F4), targeted refresh on the hot tab, cold-start batch,
`smoke-push.mjs` regression test.

**F8 REVERTED same day (checkout-breaking):** the BEGIN/COMMIT wrapper was
rolled back after it blocked every sale with the exact toast in §0 ("Erreur
d'écriture…"). Root cause, verified in the plugin source
(`tauri-plugin-sql-2.4.1/src/wrapper.rs`): the driver fronts an sqlx
`Pool<Sqlite>`, so each `execute()` may land on a different pooled connection
— COMMIT fails with "no transaction is active" while the preceding statements
already committed individually. Multi-statement transactions from JS are
impossible on this driver; true atomicity needs a Rust-side command over one
rusqlite connection (future work, never as JS BEGIN/COMMIT — a guard comment
at the site says so). Operational note: a failed COMMIT leaves the sale rows
persisted, so the toast understates reality — check history before re-entering
a sale or it will duplicate (fresh idempotency keys per attempt).
`SyncManager` stays in the eager chunk deliberately (9 modules need the live
singleton value — splitting it is surgery without freeze benefit).

Cloud purge: the purge script assumed an `image_url` column the cloud
`transactions` table lacks — fixed with per-table DDL probing + incremental
backup manifest. Dry-run then `--apply`: **15 rows healed, ~52.6 MB
reclaimed** (products 40.3 MB → 125 KB, transactions 12.8 MB → 108.5 KB),
`purge-backup-*.json` manifest kept, live re-verified clean (largest product
0.03 MB, largest receipt 0.01 MB). Peers re-pull the bumped rows and heal
local mirrors automatically. The 3 product rows were healed by the first
attempt before it failed; the fixed script healed the 12 receipts.

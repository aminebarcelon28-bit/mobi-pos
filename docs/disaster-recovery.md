# Disaster recovery — laptop dead, everything back from Turso

> Sandbox: `phone3-sync-lab`. Cloud: Turso `mobi-pos` (17 tables).

## What's covered (pushes automatically, offline-first)

Sales + receipts (full JSON), sale/void/refund ledgers, products incl. stock
deltas, customers + loyalty, repair tickets, purchase orders, trade-ins, IMEI
records, audit logs, cash drops/payouts, bundles, Kredy debts, store expenses,
cash shifts + drawer movements, app settings (manager PIN, receipt setup).

NOT synced on purpose: per-device sync state (`sync.*` keys), held (unpaid)
cart tickets (in-memory only — cash them before disaster), already-printed
paper, files in Downloads/exports, `proxy/.env` token (re-create it).

## How restore works on a fresh machine

1. Install the app, set `VITE_SYNC_PROXY_URL`, start the broker.
2. First launch: `initialPull()` downloads all 17 tables (paged, cursor-safe),
   THEN `initDatabase()` loads the UI from it. Demo seed is skipped because
   the catalog is non-empty. `backfillAllToOutbox()` runs once (no-op when
   the cloud already has everything).
3. Badge flips green when push catches up (nothing to push on a fresh
   restore — outbox starts empty).

## Wipe-and-restore drill (proves it, ~10 min, reversible)

1. Close the app. Back up the live DB + browser store:
   - Copy `%APPDATA%\com.mobi.pos\` to Desktop as `mobi_pos.BAK`.
   - Counts baseline: note products/transactions/debts totals in the UI.
2. Delete `%APPDATA%\com.mobi.pos\` and clear site data for localhost:1420
   (DevTools > Application > Clear storage) — this is the "dead laptop".
3. Launch via `start-dev.bat`. Watch the badge: `Sync…` then green.
4. Verify: catalog count, last receipts, debts, shifts, settings match baseline.
5. If anything is off: close app, delete the new folder, rename `mobi_pos.BAK`
   back. Nothing is lost — the cloud is append-only truth.

## RPO / RTO

- RPO: outbox drains every ~5s online; offline sales queue locally and push on
  reconnect. Worst case = sales made after the last successful push on a
  machine that then dies while still offline.
- RTO: fresh install + pull time (thousands of rows = under a minute).

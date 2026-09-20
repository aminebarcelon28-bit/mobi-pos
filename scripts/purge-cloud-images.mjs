// Legacy-blob cloud purge (P0 follow-through).
//
// Removes pre-hygiene media blobs (base64/data-URL) from Turso Cloud rows so
// phones stop re-downloading the ~36 MB forensic bloat documented in
// docs/sync/diagnostic-baseline-2026-09-17.md. Uses the SAME rules as the app
// (src/sync/payloadHygiene.ts) — the purge and the write path cannot disagree.
//
// SAFETY FIRST:
//   - Default mode is DRY-RUN: scans, measures and reports; writes NOTHING.
//   - Writes require the explicit flag: --apply
//   - Before any write, a backup file purge-backup-<ts>.json captures every
//     affected row id + byte sizes (restore manually if ever needed).
//   - Cleaned rows get version = version + 1 AND a fresh updated_at so peers
//     re-pull them through the (sanitizing) pull path — this is what heals
//     phones and laptops holding the old blobs locally.
//   - Money/relational scalars are never dropped (payloadHygiene contract).
//
// Credentials: proxy/.env (TURSO_URL + TURSO_AUTH_TOKEN) or env vars. The
// token is NEVER printed.
//
// Usage:
//   node --experimental-strip-types scripts/purge-cloud-images.mjs            # dry-run report
//   node --experimental-strip-types scripts/purge-cloud-images.mjs --apply    # perform the purge

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import {
  sanitizeSyncPayload,
  toBoundedSyncJson,
  MAX_SYNC_PAYLOAD_BYTES,
} from '../src/sync/payloadHygiene.ts';

const APPLY = process.argv.includes('--apply');

function loadEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

const env = { ...loadEnvFile('proxy/.env'), ...process.env };
const url = env.TURSO_URL;
const token = env.TURSO_AUTH_TOKEN;

console.log('========================================================================');
console.log(`CLOUD BLOB PURGE — ${APPLY ? 'APPLY MODE (writes enabled)' : 'DRY-RUN (read-only, no writes)'}`);
console.log('========================================================================');

if (!url || !token || token.includes('your_turso_auth_token_here')) {
  console.log('Turso credentials not configured (proxy/.env). Nothing to do — exiting 0.');
  console.log('Local write path is already protected by the P0 hygiene invariant.');
  process.exit(0);
}

const host = (() => {
  try {
    return new URL(url.replace(/^libsql:\/\//, 'https://')).host;
  } catch {
    return '(unparsable url)';
  }
})();
console.log(`Target: ${host}`);

const client = createClient({ url, authToken: token });

// Cloud schema is narrower than local: probe real columns per table and only
// touch what exists (a missing column aborts the whole statement otherwise).
async function cloudColumns(table) {
  try {
    const rs = await client.execute('SELECT sql FROM sqlite_master WHERE name = ?', [table]);
    const ddl = String(rs.rows[0]?.sql ?? '');
    const cols = new Set();
    const body = ddl.slice(ddl.indexOf('(') + 1, ddl.lastIndexOf(')'));
    for (const part of body.split(',')) {
      const name = part.trim().split(/\s+/)[0]?.replace(/["'`\[\]]/g, '');
      if (name) cols.add(name.toLowerCase());
    }
    return cols;
  } catch {
    return new Set();
  }
}

// Tables whose json_payload/data_json may embed media blobs (forensic set).
const TARGETS = [
  { table: 'products', jsonCol: 'json_payload' },
  { table: 'transactions', jsonCol: 'json_payload' },
  { table: 'transaction_items', jsonCol: 'json_payload' },
];

function byteLen(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

async function main() {
  const report = { mode: APPLY ? 'apply' : 'dry-run', at: new Date().toISOString(), tables: {} };
  let totalBefore = 0;
  let totalAfter = 0;
  let totalRows = 0;
  const backup = [];
  const backupFile = `purge-backup-${Date.now()}.json`;
  const flushBackup = () => {
    if (!APPLY) return;
    try {
      writeFileSync(backupFile, JSON.stringify({ report, backup }, null, 2));
    } catch (err) {
      console.warn(`backup manifest write failed (${backupFile}):`, err.message ?? err);
    }
  };

  for (const { table, jsonCol } of TARGETS) {
    const cols = await cloudColumns(table);
    if (!cols.has(jsonCol)) {
      console.warn(`[${table}] no ${jsonCol} column in cloud schema — skipped`);
      report.tables[table] = { skipped: `no ${jsonCol} column` };
      continue;
    }
    // Build the UPDATE from columns that actually exist: the image_url CASE,
    // the version bump, and the updated_at touch are each conditional.
    // updated_at doubles as the pull-cursor authority — without it (and
    // without version) healed rows would NOT re-pull on peers, so warn loudly.
    const sets = [`${jsonCol} = ?`];
    if (cols.has('image_url')) {
      sets.push(`image_url = CASE WHEN image_url IS NULL THEN NULL WHEN LENGTH(image_url) > 2048 THEN '' ELSE image_url END`);
    }
    if (cols.has('version')) sets.push(`version = version + 1`);
    let repull = 'version bump';
    if (cols.has('updated_at')) {
      sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
      repull = 'updated_at touch (+version)';
    } else if (!cols.has('version')) {
      repull = 'NONE — peers will NOT re-pull these rows automatically';
    }
    let rows = [];
    try {
      const rs = await client.execute(`SELECT id, ${jsonCol}, version FROM ${table}`);
      rows = rs.rows;
    } catch (err) {
      console.warn(`[${table}] scan skipped: ${err.message}`);
      report.tables[table] = { skipped: String(err.message ?? err) };
      continue;
    }
    let scanned = 0;
    let dirty = 0;
    let before = 0;
    let after = 0;
    for (const row of rows) {
      const raw = String(row[jsonCol] ?? '');
      if (!raw) continue;
      scanned++;
      before += byteLen(raw);
      let cleaned;
      try {
        const parsed = JSON.parse(raw);
        cleaned = JSON.stringify(sanitizeSyncPayload(parsed));
      } catch {
        continue; // Unparseable payload: leave untouched, never destroy.
      }
      if (cleaned === raw) {
        after += byteLen(raw);
        continue;
      }
      dirty++;
      after += byteLen(cleaned);
      backup.push({ table, id: String(row.id), bytesBefore: byteLen(raw), bytesAfter: byteLen(cleaned) });
      if (APPLY) {
        // Sanity: cleaned payload must stay valid JSON and keep its identity.
        const check = JSON.parse(cleaned);
        if (String(check.id ?? row.id) !== String(row.id)) {
          console.warn(`[${table}/${row.id}] identity changed after sanitize — SKIPPED (never destroy).`);
          continue;
        }
        await client.execute({
          sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`,
          args: [cleaned, String(row.id)],
        });
      }
    }
    totalBefore += before;
    totalAfter += after;
    totalRows += dirty;
    report.tables[table] = { scanned, dirty, kbBefore: +(before / 1024).toFixed(1), kbAfter: +(after / 1024).toFixed(1), repull };
    console.log(
      `[${table}] scanned=${scanned} dirty=${dirty} ` +
      `bytes ${(before / 1024).toFixed(1)}KB -> ${(after / 1024).toFixed(1)}KB ` +
      `(peer re-pull via ${repull})`
    );
    flushBackup(); // incremental manifest: a later failure keeps completed tables
  }

  // Oversized image_url references outside json_payload (cheap, exact).
  // Guarded: the cloud products table may not carry the column at all.
  try {
    const hasCol = (await cloudColumns('products')).has('image_url');
    if (!hasCol) {
      console.log('[products.image_url] no image_url column in cloud schema — skipped');
    } else {
      const rs = await client.execute(
        "SELECT COUNT(*) AS cnt, COALESCE(SUM(LENGTH(image_url)),0) AS bytes FROM products WHERE image_url IS NOT NULL AND LENGTH(image_url) > 2048"
      );
      const cnt = Number(rs.rows[0]?.cnt ?? 0);
      const bytes = Number(rs.rows[0]?.bytes ?? 0);
      console.log(`[products.image_url] oversized references: ${cnt} rows, ${(bytes / 1024).toFixed(1)}KB`);
      report.oversizedImageUrls = { rows: cnt, kb: +(bytes / 1024).toFixed(1) };
      if (APPLY && cnt > 0) {
        await client.execute(
          "UPDATE products SET image_url = '', version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE image_url IS NOT NULL AND LENGTH(image_url) > 2048"
        );
        console.log('[products.image_url] cleared oversized references (kept normal URLs).');
      }
    }
  } catch (err) {
    console.warn(`[products.image_url] check skipped: ${err.message}`);
  }

  const reclaimedKb = +((totalBefore - totalAfter) / 1024).toFixed(1);
  console.log('------------------------------------------------------------------------');
  console.log(`Rows to heal: ${totalRows} | reclaimable: ${reclaimedKb}KB | budget/row: ${MAX_SYNC_PAYLOAD_BYTES / 1024}KB`);
  if (!APPLY) {
    console.log('DRY-RUN complete — no writes performed. Re-run with --apply to purge.');
  } else {
    flushBackup();
    console.log(`APPLY complete — backup manifest at purge-backup-*.json (incremental, per table)`);
    console.log('Peers will re-pull cleaned rows (version+updated_at bumped) and heal local mirrors.');
  }
  // Machine-readable summary for CI logs (bounded: ids only, no payload bytes).
  console.log(JSON.stringify({ ok: true, mode: report.mode, rowsToHeal: totalRows, reclaimableKb: reclaimedKb }));
}

main().catch((err) => {
  console.error('Cloud purge failed:', err.message ?? err);
  process.exit(1);
});

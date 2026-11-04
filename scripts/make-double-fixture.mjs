#!/usr/bin/env node
/**
 * Build the row-driven-backfill fixture: a copy of a legacy DB with the
 * json_dedouble latch removed and a few json_payload values double-encoded.
 * Dev/test only.
 *
 *   node scripts/make-double-fixture.mjs <legacy.db> <out.db>
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';

const [, , src, out] = process.argv;
if (!src || !out) {
  console.error('usage: node scripts/make-double-fixture.mjs <legacy.db> <out.db>');
  process.exit(2);
}
fs.copyFileSync(src, out);
const db = new Database(out);
db.prepare("DELETE FROM app_settings WHERE key LIKE 'schema.heal.json_dedouble%'").run();

const targets = [
  ['products', 'json_payload'],
  ['transactions', 'json_payload'],
  ['customers', 'json_payload'],
];
let wrapped = 0;
for (const [table, col] of targets) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  if (!cols.includes('id') || !cols.includes(col)) continue;
  const rows = db.prepare(`SELECT rowid AS rid, id, ${col} AS payload FROM "${table}" LIMIT 2`).all();
  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const double = JSON.stringify({ json_payload: JSON.stringify(parsed), fixture: true });
    db.prepare(`UPDATE "${table}" SET ${col} = ? WHERE rowid = ?`).run(double, row.rid);
    wrapped += 1;
  }
}
db.close();
console.log(`wrote ${out} (${wrapped} double-encoded payload(s), latch removed)`);

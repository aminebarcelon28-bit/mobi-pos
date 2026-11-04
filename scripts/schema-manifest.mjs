#!/usr/bin/env node
/**
 * Canonical schema manifest + data digest for a SQLite database (dev/test only).
 *
 *   node scripts/schema-manifest.mjs <db> [--json]
 *
 * Prints { schemaSha256, tables: { name: { rows, sha256 } } } — the same
 * canonicalisation the native heal compares against (sqlite_master +
 * table_xinfo + index_xinfo, virtual tables excluded), plus an order-independent
 * per-table row hash so a backfill that changes data is visible.
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: node scripts/schema-manifest.mjs <db> [--json]');
  process.exit(2);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normSql = (s) => (s ? s.replace(/\s+/g, ' ').trim().replace(/;$/, '') : '');
const quote = (n) => `"${String(n).replace(/"/g, '""')}"`;

// JSON text columns are compared semantically: key order is an artefact of the
// writer (TS spread vs serde), not data. Only columns that hold JSON are
// canonicalised.
const canonicalJson = (text) => {
  try {
    const value = JSON.parse(text);
    const sort = (v) => {
      if (Array.isArray(v)) return v.map(sort);
      if (v && typeof v === 'object') {
        return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
      }
      return v;
    };
    return JSON.stringify(sort(value));
  } catch {
    return text;
  }
};

const db = new Database(dbPath, { readonly: true });

const objects = db
  .prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND name <> '_sqlx_migrations'
        AND (sql IS NULL OR sql NOT LIKE 'CREATE VIRTUAL TABLE%')
      ORDER BY type, name`,
  )
  .all()
  .map((r) => {
    const o = { type: r.type, name: r.name, tbl: r.tbl_name, sql: normSql(r.sql) };
    if (r.type === 'table') {
      o.columns = db
        .prepare(`PRAGMA table_xinfo(${quote(r.name)})`)
        .all()
        .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value ?? null, pk: c.pk, hidden: c.hidden }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
    if (r.type === 'index') {
      o.columns = db
        .prepare(`PRAGMA index_xinfo(${quote(r.name)})`)
        .all()
        .map((c) => ({ seqno: c.seqno, cid: c.cid, name: c.name ?? null, desc: c.desc, coll: c.coll ?? null, key: c.key }))
        .sort((a, b) => a.seqno - b.seqno);
    }
    return o;
  });
const schema = JSON.stringify({ version: 1, objects });
const schemaSha256 = sha256(schema);

const tables = db
  .prepare(
    `SELECT name FROM sqlite_master WHERE type='table'
      AND name NOT LIKE 'sqlite_%' AND name <> '_sqlx_migrations'
      AND (sql IS NULL OR sql NOT LIKE 'CREATE VIRTUAL TABLE%')
      ORDER BY name`,
  )
  .all();
const digests = {};
for (const { name } of tables) {
  const rows = db.prepare(`SELECT * FROM ${quote(name)}`).all();
  const serialized = rows
    .map((row) => {
      const cols = Object.keys(row).sort();
      return JSON.stringify(
        cols.map((c) => {
          const value = row[c];
          // Clock-only differences are not data differences: the renderer and
          // native migrations run seconds apart and both stamp datetime('now').
          const clockColumn = /(_at|^timestamp$|^updated$)/i.test(c);
          const clock = clockColumn && typeof value === 'string' ? '<clock>' : value;
          const jsonColumn = typeof value === 'string' && /json|payload/i.test(c);
          return [c, jsonColumn ? canonicalJson(clock) : clock];
        }),
      );
    })
    .sort();
  digests[name] = { rows: rows.length, sha256: sha256(serialized.join('\n')) };
}

const out = { schemaSha256, tables: digests };
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out));
} else {
  console.log(`schema ${schemaSha256}`);
  for (const [name, d] of Object.entries(digests)) {
    console.log(`  ${name}: rows=${d.rows} sha=${d.sha256.slice(0, 12)}`);
  }
}
db.close();

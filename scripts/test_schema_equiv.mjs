#!/usr/bin/env node
/**
 * Schema + data equivalence gate: native heal vs the renderer heal.
 *
 *   node scripts/test_schema_equiv.mjs            # all fixtures in tests/fixtures/legacy
 *   node scripts/test_schema_equiv.mjs <db> …     # explicit databases
 *
 * For every fixture:
 *   1. copy A → renderer path: execute tests/fixtures/schema-heal-renderer.json
 *      statement by statement (errors swallowed, exactly like the TS heal);
 *   2. copy B → native path: cargo test schema_equiv_fixture with POS_EQUIV_DB=B
 *      (the production run_schema_heal, fail-closed);
 *   3. compare the canonical schema manifest (sqlite_master + table_xinfo +
 *      index_xinfo, virtual tables excluded) AND every table's row count and
 *      order-independent row hash.
 *
 * A mismatch fails the gate: the native migration must produce exactly the
 * renderer's schema and the same data changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';

const ROOT = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-equiv-'));
const OUT = path.join(ROOT, 'tests', 'results');
fs.mkdirSync(OUT, { recursive: true });

const rendererList = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/schema-heal-renderer.json'), 'utf8'));

const args = process.argv.slice(2);
let fixtures = args;
if (fixtures.length === 0) {
  const dir = path.join(ROOT, 'tests', 'fixtures', 'legacy');
  fixtures = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.db') || f.endsWith('.db.gz'))
        .sort()
        .map((f) => path.join(dir, f))
    : [];
}
if (fixtures.length === 0) {
  console.error('[schema-equiv] no fixtures (tests/fixtures/legacy/*.db) — run the legacy capture first');
  process.exit(2);
}

const manifestOf = (dbPath) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/schema-manifest.mjs'), dbPath, '--json'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`manifest failed for ${dbPath}: ${r.stderr}`);
  return JSON.parse(r.stdout);
};

// Faithful port of the renderer's row-driven backfills: the TS heal parses each
// row and rewrites it, then latches. Executing only the captured statements
// would miss this and make equivalence meaningless.
const unwrap = (value) => {
  let current = value;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current === 'string') {
      try {
        const inner = JSON.parse(current);
        if (inner !== null && typeof inner === 'object') {
          current = inner;
          continue;
        }
      } catch {
        /* not JSON */
      }
      break;
    }
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      if (typeof current.json_payload !== 'string') break;
      let inner;
      try {
        inner = JSON.parse(current.json_payload);
      } catch {
        break;
      }
      if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) break;
      const outer = { ...current };
      delete outer.json_payload;
      current = { ...inner, ...outer };
      continue;
    }
    break;
  }
  return current;
};

const JSON_TABLES = ['products','customers','transactions','transaction_items','repair_orders',
  'purchase_orders','trade_ins','product_bundles','cash_sessions','cash_movements',
  'customer_debts','store_expenses','held_orders','vendor_disputes'];

const rendererBackfills = (db) => {
  let rewritten = 0;
  const latched = db.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key='schema.heal.json_dedouble.done'").get().n;
  if (latched === 0) {
    for (const table of JSON_TABLES) {
      let cols;
      try {
        cols = db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
      } catch {
        continue;
      }
      if (!cols.includes('id') || !cols.includes('json_payload')) continue;
      let cursor = 0;
      for (;;) {
        const rows = db
          .prepare(`SELECT rowid AS rid, id, json_payload FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT 500`)
          .all(cursor);
        if (rows.length === 0) break;
        for (const row of rows) {
          cursor = row.rid;
          const raw = String(row.json_payload ?? '');
          if (!raw || !row.id) continue;
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            continue;
          }
          const encoded = JSON.stringify(unwrap(parsed));
          if (encoded === raw) continue;
          db.prepare(`UPDATE "${table}" SET json_payload = ? WHERE id = ?`).run(encoded, String(row.id));
          rewritten += 1;
        }
        if (rows.length < 500) break;
      }
    }
    db.prepare(
      "INSERT INTO app_settings (key, value_json, updated_at, version) VALUES ('schema.heal.json_dedouble.done','true',datetime('now','utc'),1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
    ).run();
  }
  // event_log prune (only with a positive sync marker)
  let pruned = 0;
  try {
    const cols = db.prepare('PRAGMA table_info("event_log")').all().map((c) => c.name);
    const ts = cols.includes('created_at') ? 'created_at' : cols.includes('ts') ? 'ts' : null;
    if (cols.includes('synced_to_cloud') && ts) {
      const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
      pruned = db.prepare(`DELETE FROM event_log WHERE synced_to_cloud = 1 AND ${ts} < ?`).run(cutoff).changes;
    }
  } catch {
    /* no event_log */
  }
  return { rewritten, pruned };
};

// Native boot objects are created by Rust before/around the heal (audit chain +
// SEC-18 attribution columns). The renderer-only comparison must include them or
// it measures a state the app never actually reaches.
const applyNativeBootObjects = (db) => {
  db.exec(
    "CREATE TABLE IF NOT EXISTS audit_chain (\n        event_id TEXT PRIMARY KEY,\n        prev_hash TEXT NOT NULL,\n        entry_hash TEXT NOT NULL\n    );",
  );
  const cols = db.prepare('PRAGMA table_info("security_audit_logs")').all().map((c) => c.name);
  if (cols.length && !cols.includes('app_version')) db.exec('ALTER TABLE security_audit_logs ADD COLUMN app_version TEXT;');
  if (cols.length && !cols.includes('session_id')) db.exec('ALTER TABLE security_audit_logs ADD COLUMN session_id TEXT;');
};

const applyRenderer = (dbPath) => {
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 15000');
  applyNativeBootObjects(db);
  let applied = 0;
  let swallowed = 0;
  for (const sql of rendererList) {
    // The latch belongs to the backfill, not the statement list.
    if (/INSERT INTO app_settings \(key, value_json, updated_at[^)]*\) VALUES \('schema\.heal\.json_dedouble/.test(sql)) continue;
    try {
      db.exec(sql.replace(/\?1/g, "'true'").replace(/\$1/g, "datetime('now','utc')"));
      applied += 1;
    } catch {
      swallowed += 1; // the TS heal catches per statement
    }
  }
  const backfills = rendererBackfills(db);
  db.close();
  return { applied, swallowed, ...backfills };
};

const applyNative = (dbPath) => {
  const r = spawnSync(
    process.platform === 'win32' ? 'cargo.exe' : 'cargo',
    ['test', '--lib', 'schema_equiv_fixture', '--', '--nocapture'],
    {
      cwd: path.join(ROOT, 'src-tauri'),
      env: { ...process.env, POS_EQUIV_DB: dbPath, POS_SCHEMA_HEAL_DELAY_MS: '', POS_SCHEMA_HEAL_ABORT_AT: '' },
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
    },
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const ok = /EQUIV_NATIVE_OK schema_sha=([0-9a-f]{64}) applied=(\d+) tolerated=(\d+)/.exec(out);
  if (!ok) return { ok: false, detail: out.split('\n').slice(-20).join('\n') };
  return { ok: true, schemaSha: ok[1], applied: Number(ok[2]), tolerated: Number(ok[3]) };
};

const results = [];
let failures = 0;

for (const fixture of fixtures) {
  const name = path.basename(fixture).replace(/\.db(\.gz)?$/, '');
  // Fixtures are committed gzipped (they are multi-MB databases).
  const plain = path.join(TMP, `${name}.db`);
  if (fixture.endsWith('.gz')) {
    fs.writeFileSync(plain, zlib.gunzipSync(fs.readFileSync(fixture)));
  } else {
    fs.copyFileSync(fixture, plain);
  }
  const a = path.join(TMP, `${name}-renderer.db`);
  const b = path.join(TMP, `${name}-native.db`);
  fs.copyFileSync(plain, a);
  fs.copyFileSync(plain, b);

  const renderer = applyRenderer(a);
  const native = applyNative(b);
  if (!native.ok) {
    failures += 1;
    results.push({ fixture: name, error: 'native heal failed', detail: native.detail });
    console.log(`[schema-equiv] FAIL ${name}: native heal failed\n${native.detail}`);
    continue;
  }

  const ma = manifestOf(a);
  const mb = manifestOf(b);
  const schemaEqual = ma.schemaSha256 === mb.schemaSha256;
  const tables = new Set([...Object.keys(ma.tables), ...Object.keys(mb.tables)]);
  const dataDiffs = [];
  for (const t of [...tables].sort()) {
    const x = ma.tables[t];
    const y = mb.tables[t];
    if (!x || !y) {
      dataDiffs.push(`${t}: table only on ${x ? 'renderer' : 'native'}`);
      continue;
    }
    if (x.rows !== y.rows || x.sha256 !== y.sha256) {
      dataDiffs.push(`${t}: renderer rows=${x.rows} sha=${x.sha256.slice(0, 10)} vs native rows=${y.rows} sha=${y.sha256.slice(0, 10)}`);
    }
  }

  const ok = schemaEqual && dataDiffs.length === 0;
  if (!ok) failures += 1;
  results.push({
    fixture: name,
    ok,
    renderer,
    native,
    schemaSha: { renderer: ma.schemaSha256, native: mb.schemaSha256 },
    dataDiffs,
  });
  console.log(
    `[schema-equiv] ${ok ? 'PASS' : 'FAIL'} ${name} :: schema ${schemaEqual ? 'equal' : 'DIFF'} ` +
      `(renderer ${ma.schemaSha256.slice(0, 10)} / native ${mb.schemaSha256.slice(0, 10)}), ` +
      `tables ${tables.size}, data diffs ${dataDiffs.length}, ` +
      `renderer applied ${renderer.applied}/swallowed ${renderer.swallowed}, native applied ${native.applied}/tolerated ${native.tolerated}`,
  );
  for (const d of dataDiffs.slice(0, 10)) console.log(`    ${d}`);
}

fs.writeFileSync(path.join(OUT, 'schema-equiv.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
console.log(`\nSCHEMA EQUIVALENCE: ${fixtures.length - failures}/${fixtures.length} fixture(s) identical`);
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * Generate the native schema-heal migration (dev-only, run by hand).
 *
 *   node scripts/gen-schema-heal.mjs <capture.log> <reference-healed.db>
 *
 * Inputs:
 *  - capture.log: statements the app actually ran (instrumented plugin,
 *    POS_SQL_CAPTURE=1) — matched back to the heal functions in
 *    src/db/sqlPluginAdapter.ts so the list cannot drift from the source.
 *  - reference-healed.db: a database AFTER the renderer heal completed. The
 *    generator replays every statement against it to learn the ONLY tolerated
 *    per-statement errors (duplicate column / already exists), and records the
 *    resulting schema as the golden manifest the native run must reproduce.
 *
 * Outputs:
 *  - src-tauri/src/schema_heal_sql.rs: statements + hashes + exact tolerance map
 *    + golden manifest + manifest sha256 + sha256 of the TS heal sources (drift gate).
 *  - docs/schema-manifest.json: human-auditable copy of the manifest.
 *
 * The generator FAILS if a statement produces any error that is not one of the
 * two idempotent outcomes — that is the fail-closed rule encoded at build time.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const [capturePath, refPath] = process.argv.slice(2);
if (!capturePath || !refPath) {
  console.error('usage: node scripts/gen-schema-heal.mjs <capture.log> <reference-healed.db>');
  process.exit(2);
}

const norm = (s) => s.replace(/\s+/g, ' ').trim().replace(/;$/, '');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fnv1a64 = (s) => {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(s, 'utf8')) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
};

// ── 1. The heal sources (drift gate) ────────────────────────────────────────
const src = fs.readFileSync('src/db/sqlPluginAdapter.ts', 'utf8').split(/\r?\n/);
// ensureLocalSyncColumns (line 89) through its two helpers, ending before
// healPoisonedInventoryBaselines (line 1056).
const sourceRegion = norm(src.slice(88, 1055).join('\n'));
const sourceSha = sha256(sourceRegion);

// ── 2. Statements the app ran, owned by those functions ─────────────────────
const TX = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
// Pre-v100 app_settings shape only (no id/data_json on a modern DB), plus the
// json_dedouble latch: that latch is written by the native backfill AFTER it
// processes rows, so replaying it as a statement would skip the backfill.
const OBSOLETE = /^(UPDATE app_settings SET (key = id|value_json = data_json)|INSERT INTO app_settings \(id,|INSERT INTO app_settings \(key, value_json, updated_at[^)]*\) VALUES \('schema\.heal\.json_dedouble)/i;

const lines = fs.readFileSync(capturePath, 'utf8').split(/\r?\n/).filter(Boolean);
const seen = new Set();
const owned = [];
for (const line of lines) {
  const n = norm(line);
  if (!n || seen.has(n)) continue;
  if (TX.test(n) || OBSOLETE.test(n)) continue;
  if (!sourceRegion.includes(n)) continue;
  seen.add(n);
  owned.push(n);
}
if (owned.length < 50) throw new Error(`only ${owned.length} heal statements captured — refusing to generate`);

// ── 3. Learn the exact tolerated errors against a healed DB ─────────────────
const db = new Database(refPath);
const classify = (msg) => {
  const m = String(msg).toLowerCase();
  if (m.startsWith('duplicate column name:')) return 'DuplicateColumn';
  if (m.includes('already exists')) return 'AlreadyExists';
  return null;
};
const tolerances = [];
const statements = owned.map((sql, index) => {
  // Parameterised latch statements cannot run here; they become fixed literals.
  const fixed = sql.replace(/\?1/g, "'true'").replace(/\$1/g, "datetime('now','utc')");
  try {
    db.exec(fixed);
  } catch (e) {
    const kind = classify(e.message);
    if (!kind) {
      throw new Error(`statement ${index} produced a non-idempotent error: ${e.message} :: ${fixed.slice(0, 80)}`);
    }
    tolerances.push({ index, hash: fnv1a64(fixed).toString(), kind });
  }
  return fixed;
});

// ── 4. Golden manifest from the healed reference DB ─────────────────────────
const normalizeSql = (sql) => (sql ? sql.replace(/\s+/g, ' ').trim() : '');
const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

const master = db
  .prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND name <> '_sqlx_migrations'
        AND (sql IS NULL OR sql NOT LIKE 'CREATE VIRTUAL TABLE%')
      ORDER BY type, name`,
  )
  .all();

const objects = master.map((row) => {
  const obj = { type: row.type, name: row.name, tbl: row.tbl_name, sql: normalizeSql(row.sql) };
  if (row.type === 'table') {
    obj.columns = db
      .prepare(`PRAGMA table_xinfo(${quote(row.name)})`)
      .all()
      .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value ?? null, pk: c.pk, hidden: c.hidden }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  if (row.type === 'index') {
    obj.columns = db
      .prepare(`PRAGMA index_xinfo(${quote(row.name)})`)
      .all()
      .map((c) => ({ seqno: c.seqno, cid: c.cid, name: c.name ?? null, desc: c.desc, coll: c.coll ?? null, key: c.key }))
      .sort((a, b) => a.seqno - b.seqno);
  }
  return obj;
});
const manifest = JSON.stringify({ version: 1, objects });
const manifestSha = sha256(manifest);
db.close();

// ── 5. Emit Rust ────────────────────────────────────────────────────────────
const lit = (s) => `    r##"${s}"##,`;
const hex = (x) => `0x${x.toString(16).padStart(16, '0')}`;
const out = `//! GENERATED — do not edit by hand.
//!
//! Native replay of the renderer's schema heal, captured from a real boot and
//! matched to its source functions. Regenerate:
//!
//!   POS_SQL_CAPTURE=1 <run the app once>
//!   node scripts/gen-schema-heal.mjs %TEMP%/mobi-sql-capture.log <healed.db>
//!
//! Drift gate: SOURCE_SHA256 is the hash of the heal functions in
//! src/db/sqlPluginAdapter.ts. scripts/check-schema-heal-drift.mjs fails when the
//! source changes without regenerating this file and the golden manifest.
//!
//! Tolerance is per statement and EXACT: a statement may only produce the error
//! recorded here by replaying it against a healed database. Anything else aborts
//! the migration (see boot_maintenance::run_schema_heal). No message-substring
//! matching, no "has no column named" escape hatch.

pub const SOURCE_SHA256: &str = "${sourceSha}";
pub const MANIFEST_SHA256: &str = "${manifestSha}";
pub const SCHEMA_MANIFEST: &str = r##"${manifest}"##;

/// Statements, in the order the app runs them.
pub const SCHEMA_HEAL_STATEMENTS: &[&str] = &[
${statements.map(lit).join('\n')}
];

/// Stable FNV-1a-64 of each statement (index-aligned).
pub const SCHEMA_HEAL_HASHES: &[u64] = &[
${statements.map((s) => '    ' + hex(fnv1a64(s)) + ',').join('\n')}
];

/// Exact tolerated outcomes, keyed by statement hash.
pub const TOLERANCES: &[(u64, crate::boot_maintenance::Tolerance)] = &[
${
  tolerances.length
    ? tolerances
        .map((t) => `    (${t.hash}, crate::boot_maintenance::Tolerance::${t.kind}), // #${t.index}`)
        .join('\n')
    : '    // none on the reference database'
}
];
`;
fs.writeFileSync('src-tauri/src/schema_heal_sql.rs', out);
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/schema-manifest.json', JSON.stringify(JSON.parse(manifest), null, 2) + '\n');

console.log(
  `wrote src-tauri/src/schema_heal_sql.rs\n` +
    `  statements ${statements.length} (${statements.filter((s) => /^(CREATE|ALTER|DROP)/i.test(s)).length} DDL)\n` +
    `  tolerances ${tolerances.length} (${[...new Set(tolerances.map((t) => t.kind))].join(', ') || 'none'})\n` +
    `  manifest ${manifest.length} bytes, sha256 ${manifestSha.slice(0, 16)}…\n` +
    `  source sha256 ${sourceSha.slice(0, 16)}…`,
);

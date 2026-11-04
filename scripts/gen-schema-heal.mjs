#!/usr/bin/env node
/**
 * Generate `src-tauri/src/schema_heal_sql.rs` from a captured boot (dev-only).
 *
 * The schema heal lives in TypeScript today and is the largest block of renderer
 * writes (118 DDL + 13 backfills). Copying it by hand would drift; instead this
 * script takes the statements the app ACTUALLY ran (captured by the instrumented
 * SQL plugin under POS_SQL_CAPTURE=1) and keeps the ones that belong to the heal
 * functions, matched against their source region. The output is committed and
 * reviewable, and the native migration runs exactly those statements.
 *
 *   node scripts/gen-schema-heal.mjs <capture.log>
 *
 * Parameterised statements (5 latch/settings inserts) get fixed literals:
 * value_json -> 'true', updated_at -> datetime('now','utc'). They are idempotent
 * receipts, not data.
 */
import fs from 'node:fs';

const capturePath = process.argv[2];
if (!capturePath) {
  console.error('usage: node scripts/gen-schema-heal.mjs <capture.log>');
  process.exit(2);
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const src = fs.readFileSync('src/db/sqlPluginAdapter.ts', 'utf8').split(/\r?\n/);
// ensureLocalSyncColumns starts at line 89; the region runs through the helpers
// healSyncOutboxEntityCheck and ensureShiftLedgerV113, ending before
// healPoisonedInventoryBaselines (line 1056).
const region = norm(src.slice(88, 1055).join('\n'));

const lines = fs.readFileSync(capturePath, 'utf8').split(/\r?\n/).filter(Boolean);
const seen = new Set();
const owned = [];
const TX = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
// Pre-v100 app_settings shape only; a modern DB has no id/data_json columns
// and the statement would fail with "no such column" on every boot.
const OBSOLETE = /^UPDATE app_settings SET (key = id|value_json = data_json)\b/i;
for (const line of lines) {
  const n = norm(line);
  if (!n || seen.has(n)) continue;
  if (TX.test(n) || OBSOLETE.test(n)) continue; // transaction control is the runner ship; native owns it
  if (!region.includes(n)) continue;
  seen.add(n);
  owned.push(n);
}

const fixed = owned.map((sql) =>
  sql
    .replace(/\?1/g, "'true'")
    .replace(/\$1/g, "datetime('now','utc')"),
);

const literal = (sql) => `    r##"${sql}"##,`;
const out = `//! GENERATED — do not edit by hand.
//!
//! The renderer's schema heal (\`ensureLocalSyncColumns\` + its two helpers), captured
//! from a real boot and re-emitted here so the migration can run natively. Regenerate:
//!
//!   POS_SQL_CAPTURE=1 <run the app once> && node scripts/gen-schema-heal.mjs %TEMP%/mobi-sql-capture.log
//!
//! Every statement is idempotent (CREATE … IF NOT EXISTS / ADD COLUMN whose
//! "duplicate column" is tolerated / OF CONFLICT upserts), which is why replaying
//! the list on an already-healed database is a no-op.

/// The heal statements, in the order the app runs them.
pub const SCHEMA_HEAL_STATEMENTS: &[&str] = &[
${fixed.map(literal).join('\n')}
];
`;

fs.writeFileSync('src-tauri/src/schema_heal_sql.rs', out);
console.log(
  `wrote src-tauri/src/schema_heal_sql.rs (${fixed.length} statements: ` +
    `${fixed.filter((s) => /^(CREATE|ALTER|DROP)/i.test(s)).length} DDL)`,
);

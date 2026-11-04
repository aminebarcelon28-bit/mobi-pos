#!/usr/bin/env node
/**
 * Drift gate for the generated native schema heal (release hygiene, item 6/7).
 *
 *   node scripts/check-schema-heal-drift.mjs
 *
 * Fails when:
 *  - the TS heal sources changed without regenerating schema_heal_sql.rs
 *    (SOURCE_SHA256 mismatch);
 *  - the generated file contains captured data instead of fixed literals
 *    (paths, timestamps, parameter placeholders, capture markers);
 *  - the capture hook is compiled into non-debug builds (the hook must be
 *    behind #[cfg(debug_assertions)]).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const src = fs.readFileSync('src/db/sqlPluginAdapter.ts', 'utf8').split(/\r?\n/);
const region = norm(src.slice(88, 1055).join('\n'));
const actual = sha256(region);

const gen = fs.readFileSync('src-tauri/src/schema_heal_sql.rs', 'utf8');
const declared = /pub const SOURCE_SHA256: &str = "([0-9a-f]{64})";/.exec(gen)?.[1] ?? '';

const problems = [];
if (declared !== actual) {
  problems.push(
    `source drift: sqlPluginAdapter heal region is ${actual.slice(0, 16)}… but the generated file says ${declared.slice(0, 16)}… — run scripts/gen-schema-heal.mjs`,
  );
}

// Fixed literals only: no paths, no timestamps, no bind placeholders, no capture markers.
const body = gen.slice(gen.indexOf('pub const SCHEMA_HEAL_STATEMENTS'));
const forbidden = [
  [/\$\{/, 'template interpolation'],
  [/\?[0-9]/, 'positional bind placeholder'],
  [/\$[0-9]/, 'numeric bind placeholder'],
  [/mobi-sql-capture/i, 'capture log path'],
  [/[A-Za-z]:\\\\|C:\//, 'absolute path'],
  [/POS_SQL_CAPTURE|POS_SCHEMA_HEAL/, 'capture/test env marker'],
];
for (const [re, label] of forbidden) {
  if (re.test(body)) problems.push(`generated statements contain a ${label}`);
}

// The capture hook must be debug-only in the patched plugin.
const wrapper = fs.readFileSync('patches/tauri-plugin-sql/src/wrapper.rs', 'utf8');
const captureIdx = wrapper.indexOf('fn record_captured_sql');
const captureFn = wrapper.slice(Math.max(0, captureIdx - 200), wrapper.indexOf('fn record_write_violation'));
if (!captureFn.includes('#[cfg(debug_assertions)]') || !captureFn.includes('#[cfg(not(debug_assertions))]')) {
  problems.push('record_captured_sql is not debug-gated (would ship in release)');
}
if (!/#\[cfg\(not\(debug_assertions\)\)\][\s\S]{0,80}fn record_captured_sql\(_query: &str\) \{\}/.test(wrapper)) {
  problems.push('record_captured_sql has no release no-op');
}

if (problems.length) {
  console.error('[schema-heal-drift] FAIL');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('[schema-heal-drift] OK (source hash matches, fixed literals only, capture hook debug-gated)');

#!/usr/bin/env node
/**
 * SQL boundary gate (SEC-01 / ADR-005 item 4).
 *
 * The renderer still holds a writable SQL pool. That is a migration, not a flag:
 * boot writes through the pool (measured — flipping it prevents the app from
 * starting). Until every write has a native command, this gate makes the debt
 * **visible and ratcheted** instead of invisible.
 *
 *   node scripts/check-sql-boundary.mjs                 # report (default)
 *   node scripts/check-sql-boundary.mjs --ratchet       # fail on new writes / grown baseline
 *   node scripts/check-sql-boundary.mjs --fail          # end state: zero writes allowed
 *   node scripts/check-sql-boundary.mjs --write-baseline
 *
 * A violation is a SQL string literal in `src/` whose statement text starts with a
 * write statement (INSERT/REPLACE/UPDATE … SET/DELETE FROM/CREATE/ALTER/DROP/
 * VACUUM/ATTACH). Reads (SELECT/WITH/PRAGMA) are not violations. The detector is
 * intentionally structural (statement start + SQL keywords), not a full parser:
 * a false positive is visible in the list, a false negative would hide the debt.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const BASELINE_PATH = path.join(ROOT, 'scripts', 'sql-boundary-baseline.json');

const argv = new Set(process.argv.slice(2));
const MODE = argv.has('--fail')
  ? 'fail'
  : argv.has('--ratchet')
    ? 'ratchet'
    : argv.has('--write-baseline')
      ? 'write'
      : 'report';

const WRITE_START =
  /^(INSERT\s+(OR\s+[A-Za-z]+\s+)?INTO|REPLACE\s+INTO|UPDATE\s+[^;]{1,80}\sSET|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|DROP\s+(TABLE|INDEX|VIEW|TRIGGER)|VACUUM|ATTACH\s+DATABASE)\b/i;
const READ_START = /^(SELECT|WITH|PRAGMA)\b/i;
const SQLISH = /\b(FROM|INTO|VALUES|TABLE|INDEX|WHERE|SET|KEY)\b/i;

const LITERAL = /(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/g;

function literals(source) {
  const out = [];
  LITERAL.lastIndex = 0;
  let m;
  while ((m = LITERAL.exec(source))) {
    const text = m[2].replace(/\$\{[^}]*\}/g, ' ? ').replace(/\\n/g, ' ').trim();
    if (text.length < 12) continue;
    const line = source.slice(0, m.index).split('\n').length;
    out.push({ line, text, index: m.index });
  }
  return out;
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}

const violations = [];
for (const file of walk(SRC)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const src = fs.readFileSync(file, 'utf8');
  for (const lit of literals(src)) {
    if (READ_START.test(lit.text)) continue;
    if (!WRITE_START.test(lit.text)) continue;
    if (!SQLISH.test(lit.text)) continue;
    violations.push({
      file: rel,
      line: lit.line,
      snippet: lit.text.replace(/\s+/g, ' ').slice(0, 100),
    });
  }
}
violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

const baseline = fs.existsSync(BASELINE_PATH)
  ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
  : null;

console.log(`[sql-boundary] mode=${MODE} renderer write statements in src/: ${violations.length}`);
if (baseline) console.log(`[sql-boundary] baseline: ${baseline.count} (${baseline.at})`);
for (const v of violations.slice(0, 40)) console.log(`  ${v.file}:${v.line}  ${v.snippet}`);
if (violations.length > 40) console.log(`  … ${violations.length - 40} more`);

if (MODE === 'write') {
  fs.writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      { at: new Date().toISOString(), count: violations.length, entries: violations.map((v) => `${v.file}:${v.line}`) },
      null,
      2,
    ) + '\n',
  );
  console.log(`[sql-boundary] baseline written (${violations.length})`);
  process.exit(0);
}

if (MODE === 'report') {
  const byFile = new Map();
  for (const v of violations) byFile.set(v.file, (byFile.get(v.file) ?? 0) + 1);
  console.log('[sql-boundary] top files:');
  for (const [f, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${n}\t${f}`);
  process.exit(0);
}

if (MODE === 'fail') {
  if (violations.length > 0) {
    console.log(`[sql-boundary] FAIL: ${violations.length} renderer write statement(s) — the end state requires a read-only renderer pool`);
    process.exit(1);
  }
  console.log('[sql-boundary] OK: no renderer writes');
  process.exit(0);
}

if (!baseline) {
  console.log('[sql-boundary] FAIL: no baseline; run --write-baseline once and commit it');
  process.exit(1);
}
const current = new Set(violations.map((v) => `${v.file}:${v.line}`));
const known = new Set(baseline.entries ?? []);
const added = [...current].filter((k) => !known.has(k));
const removed = [...known].filter((k) => !current.has(k));
if (added.length) {
  console.log(`[sql-boundary] FAIL: ${added.length} new renderer write(s):`);
  for (const a of added.slice(0, 20)) console.log(`  + ${a}`);
}
if (removed.length) {
  console.log(`[sql-boundary] ${removed.length} baseline entr(ies) gone — shrink with --write-baseline: ${removed.slice(0, 8).join(', ')}`);
}
if (added.length || violations.length > baseline.count) process.exit(1);
console.log(`[sql-boundary] OK: ${violations.length} <= baseline ${baseline.count}${removed.length ? ` (${removed.length} removable)` : ''}`);
process.exit(0);

/**
 * Assemble the canonical BATCH 27d log: the 12 RPT verdicts produced by
 * e2e-tests/tools/27d-rpt-checks.mts (app modules executed under Node) plus
 * the measured FACT lines, UTF-8, with machine specs and the exact command.
 *
 *   node e2e-tests/tools/build-27d-log.mjs
 *
 * The child is captured as a raw buffer so no console code page can mangle the
 * fr-DZ amounts or the accented source quotes.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'e2e-tests', 'logs', 'part0-27d.log');

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
function clean(buf) {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(ANSI, '');
}

const CMD = [
  '--import',
  './scripts/ts-resolve-hook.mjs',
  '--experimental-strip-types',
  'e2e-tests/tools/27d-rpt-checks.mts',
];

console.log(`[1/1] node ${CMD.join(' ')}`);
const run = spawnSync(process.execPath, CMD, {
  cwd: ROOT,
  encoding: 'buffer',
  maxBuffer: 64 * 1024 * 1024,
});
const out = clean(run.stdout ?? Buffer.alloc(0));
const err = clean(run.stderr ?? Buffer.alloc(0));
if (run.status !== 0) {
  console.error(err);
  process.exit(1);
}

const lines = out
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);
const verdicts = lines.filter((l) => /^VERDICT=[A-Z0-9-]+ /.test(l));
const facts = lines.filter((l) => /^FACT=/.test(l));
const machine = lines.find((l) => l.startsWith('MACHINE=')) ?? 'MACHINE=unknown';
const summary = lines.find((l) => l.startsWith('SUMMARY=')) ?? 'SUMMARY=unknown';
const fixture = lines.filter((l) => /^(FIXTURE|METRICS|ORACLE) /.test(l));

const ids = verdicts.map((l) => /VERDICT=([A-Z0-9-]+)/.exec(l)?.[1] ?? '?');
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) console.warn(`[warn] duplicate verdict ids: ${dupes.join(', ')}`);

const tally = {};
for (const l of verdicts) {
  const v = /VERDICT=[A-Z0-9-]+ ([A-Z-]+)/.exec(l)?.[1] ?? '?';
  tally[v] = (tally[v] || 0) + 1;
}

const header = [
  '# BATCH 27d — RPT (12) — canonical log',
  '',
  `generated_at=${new Date().toISOString()}`,
  `machine=${machine.replace(/^MACHINE=/, '')}`,
  'sandbox=none (deterministic module run: no Tauri WebView, no live DB)',
  'fixture=e2e-tests/tools/27d-rpt-checks.mts (14 controlled ledger rows, integer DA)',
  '',
  '## Command',
  '',
  `   node ${CMD.join(' ')}`,
  '',
  '## Fixture + canonical metrics (app code) vs independent oracle',
  '',
  ...fixture,
  '',
  '## Verdicts (12: RPT-01/03/04/05/06/07/08/09/10/11/12/13)',
  '',
  ...verdicts,
  '',
  '## Measured facts cited by the verdicts',
  '',
  ...facts,
  '',
  summary,
  '',
  `tally=${JSON.stringify(tally)} unique_ids=${new Set(ids).size}`,
  '',
].join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, header, 'utf8');
console.log(`wrote ${OUT} (${Buffer.byteLength(header, 'utf8')} bytes, ${verdicts.length} verdicts, ${facts.length} facts)`);

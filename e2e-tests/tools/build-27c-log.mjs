/**
 * Assemble the canonical BATCH 27c log: the Node deterministic half (I18-04/06/
 * 08/11/12/14 + DAT-79/84 and the four FACT lines) plus the WDIO interactive
 * half (I18-01/02/03/07/09/10/13/15), one VERDICT= line per case, UTF-8, with
 * the machine specs and the exact commands that produced it.
 *
 *   node e2e-tests/tools/build-27c-log.mjs
 *
 * Both children are captured as raw buffers so no PowerShell console code page
 * can mangle the Arabic/accented strings.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'e2e-tests', 'logs', 'part0-27c.log');

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
function clean(buf) {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(ANSI, '');
}

const NODE_CMD = [
  '--import',
  './scripts/ts-resolve-hook.mjs',
  '--experimental-strip-types',
  'e2e-tests/tools/27c-i18-checks.mts',
];
const UI_CMD = ['wdio', 'run', 'e2e-tests/wdio.conf.ts', '--spec', 'e2e-tests/specs/27c-i18-ui.e2e.ts'];

console.log(`[1/2] node ${NODE_CMD.join(' ')}`);
const nodeRun = spawnSync(process.execPath, NODE_CMD, {
  cwd: ROOT,
  encoding: 'buffer',
  maxBuffer: 64 * 1024 * 1024,
});
if (nodeRun.status !== 0) {
  console.error(clean(nodeRun.stderr ?? Buffer.alloc(0)));
  process.exit(1);
}
const nodeOut = clean(nodeRun.stdout ?? Buffer.alloc(0));

console.log(`[2/2] npx ${UI_CMD.join(' ')}`);
const uiRun = spawnSync('npx', UI_CMD, {
  cwd: ROOT,
  encoding: 'buffer',
  maxBuffer: 64 * 1024 * 1024,
  shell: true,
  env: { ...process.env, POS_E2E_WIPE: '1' },
});
const uiOut = clean(uiRun.stdout ?? Buffer.alloc(0)) + clean(uiRun.stderr ?? Buffer.alloc(0));

const lines = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[0-0\]\s*/, '').trim())
    .filter(Boolean);
const verdictLines = (text) => lines(text).filter((l) => /VERDICT=[A-Z0-9-]+ /.test(l));
const factLines = (text) => lines(text).filter((l) => /^FACT=/.test(l));

const nodeVerdicts = verdictLines(nodeOut);
const uiVerdicts = verdictLines(uiOut);
const facts = factLines(nodeOut);
if (nodeVerdicts.length !== 8) {
  console.warn(`[warn] expected 8 node verdicts, got ${nodeVerdicts.length}; keeping the log for inspection`);
}
if (uiVerdicts.length !== 8) {
  console.warn(`[warn] expected 8 UI verdicts, got ${uiVerdicts.length}; keeping the log for inspection`);
}

const all = [...nodeVerdicts, ...uiVerdicts];
const ids = all.map((l) => /VERDICT=([A-Z0-9-]+)/.exec(l)?.[1] ?? '?');
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) console.warn(`[warn] duplicate verdict ids: ${dupes.join(', ')}`);

const tally = {};
for (const l of all) {
  const v = /VERDICT=[A-Z0-9-]+ ([A-Z-]+)/.exec(l)?.[1] ?? '?';
  tally[v] = (tally[v] || 0) + 1;
}

const machine = lines(nodeOut).find((l) => l.startsWith('MACHINE=')) ?? 'MACHINE=unknown';
const summary = lines(nodeOut).find((l) => l.startsWith('SUMMARY=')) ?? 'SUMMARY=unknown';
const uiSpecSummary = lines(uiOut)
  .filter((l) => /passing|failing|Spec Files|BATCH27C_UI_SUMMARY/.test(l))
  .join('\n');

const header = [
  '# BATCH 27c — I18 (14) + DAT (2) — canonical log',
  '',
  `generated_at=${new Date().toISOString()}`,
  `machine=${machine.replace(/^MACHINE=/, '')}`,
  'binary=target-e2e/debug/mobi-pos.exe (43,368,448 bytes, 2026-10-22)',
  'sandbox=%TEMP%\\opencode\\pos-wdio-sandbox',
  '',
  '## Commands',
  '',
  '1) deterministic i18n/search/print/backup checks (app modules executed under Node):',
  `   node ${NODE_CMD.join(' ')}`,
  '',
  '2) interactive i18n checks (real Tauri WebView, wiped sandbox):',
  `   POS_E2E_WIPE=1 npx ${UI_CMD.join(' ')}`,
  '',
  '## Part 1 — deterministic checks (8 verdicts: I18-04/06/08/11/12/14, DAT-79/84)',
  '',
  ...nodeVerdicts,
  '',
  summary,
  '',
  '## Part 1b — measured facts cited by the interactive verdicts (4)',
  '',
  ...facts,
  '',
  '## Part 2 — interactive checks (8 verdicts: I18-01/02/03/07/09/10/13/15)',
  '',
  ...uiVerdicts,
  '',
  '### WDIO spec summary',
  '',
  uiSpecSummary,
  '',
  '## Combined verdict tally',
  '',
  `verdicts_in_log=${all.length} (node=${nodeVerdicts.length}, ui=${uiVerdicts.length}) unique_ids=${new Set(ids).size}`,
  `tally=${JSON.stringify(tally)}`,
  '',
].join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, header, 'utf8');
console.log(`wrote ${OUT} (${Buffer.byteLength(header, 'utf8')} bytes, ${all.length} verdicts)`);

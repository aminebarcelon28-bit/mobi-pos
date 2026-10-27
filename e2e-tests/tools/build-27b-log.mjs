/**
 * Assemble the canonical BATCH 27b log: the Node byte-level checks plus the
 * WDIO interactive run, one VERDICT= line per case, UTF-8, with the machine
 * specs and the exact commands that produced it.
 *
 *   node e2e-tests/tools/build-27b-log.mjs
 *
 * Both children are captured as raw buffers so no PowerShell console code page
 * can mangle the accents (Tee-Object re-encodes UTF-8 as UTF-16LE and the
 * round-trip is lossy for the WDIO child's stdout).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'e2e-tests', 'logs', 'part0-27b.log');

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
  'e2e-tests/tools/27b-lbl-checks.mts',
];
const UI_CMD = [
  'wdio',
  'run',
  'e2e-tests/wdio.conf.ts',
  '--spec',
  'e2e-tests/specs/27b-lbl-hw.e2e.ts',
];

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

const verdictLines = (text) =>
  text
    .split(/\r?\n/)
    .filter((l) => /VERDICT=[A-Z0-9-]+ /.test(l))
    .map((l) => l.replace(/^\[0-0\]\s*/, '').trim());

const nodeVerdicts = verdictLines(nodeOut);
const uiVerdicts = verdictLines(uiOut);
if (uiVerdicts.length !== 3) {
  console.warn(`[warn] expected 3 UI verdicts, got ${uiVerdicts.length}; keeping the log for inspection`);
}

const machine = nodeOut.split(/\r?\n/).find((l) => l.startsWith('MACHINE=')) ?? 'MACHINE=unknown';
const summary = nodeOut.split(/\r?\n/).find((l) => l.startsWith('SUMMARY=')) ?? 'SUMMARY=unknown';
const uiSpecSummary = uiOut
  .split(/\r?\n/)
  .filter((l) => /passing|failing|Spec Files/.test(l))
  .map((l) => l.trim())
  .join('\n');

const header = [
  '# BATCH 27b — LBL (13) + HW (8) — canonical log',
  '',
  `generated_at=${new Date().toISOString()}`,
  `machine=${machine.replace(/^MACHINE=/, '')}`,
  'binary=target-e2e/debug/mobi-pos.exe (43,368,448 bytes, 2026-10-22)',
  'sandbox=%TEMP%\\opencode\\pos-wdio-sandbox',
  '',
  '## Commands',
  '',
  '1) deterministic label/HW checks (app modules executed under Node):',
  `   node ${NODE_CMD.join(' ')}`,
  '',
  '2) interactive label/HW checks (real Tauri WebView, wiped sandbox):',
  `   POS_E2E_WIPE=1 npx ${UI_CMD.join(' ')}`,
  '',
  '## Part 1 — deterministic checks (15 cases)',
  '',
  ...nodeVerdicts,
  '',
  summary,
  '',
  '## Part 2 — interactive checks (3 cases)',
  '',
  ...uiVerdicts,
  '',
  '### WDIO spec summary',
  '',
  uiSpecSummary,
  '',
  '## Combined verdict tally',
  '',
  `verdicts_in_log=${nodeVerdicts.length + uiVerdicts.length} (node=${nodeVerdicts.length}, ui=${uiVerdicts.length})`,
  '',
].join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, header, 'utf8');
console.log(
  `wrote ${OUT} (${Buffer.byteLength(header, 'utf8')} bytes, ${nodeVerdicts.length + uiVerdicts.length} verdicts)`,
);

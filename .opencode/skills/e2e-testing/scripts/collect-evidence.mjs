#!/usr/bin/env node
/**
 * collect-evidence.mjs - assemble the evidence bundle for the latest (or a given) run.
 *
 * Usage:
 *   node .opencode/skills/e2e-testing/scripts/collect-evidence.mjs
 *   node ... --run e2e-tests/results/runs/2026-10-27T...-refunds.json
 *   node ... --minutes 45          # no sidecar: look back N minutes
 *
 * Output: e2e-tests/results/evidence/<stamp>/report.md + copied screenshots.
 * Prints the failures so you can start triage without opening the log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, repoRoot, stamp, parseArgs, ok, warn, info, C } from './_lib.mjs';

const args = parseArgs();
const root = repoRoot();
const p = paths(root);

function latestSidecar() {
  if (!fs.existsSync(p.runs)) return null;
  const files = fs.readdirSync(p.runs).filter((f) => f.endsWith('.json')).sort();
  return files.length ? path.join(p.runs, files[files.length - 1]) : null;
}

const sidecarPath = args.run ? path.resolve(root, args.run) : latestSidecar();
let meta = null;
let from;
let to;

if (sidecarPath && fs.existsSync(sidecarPath)) {
  meta = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  from = new Date(meta.startedAt).getTime() - 1000;
  to = from + meta.durationMs + 5000;
  info(`run     ${meta.tag}  ${meta.gitSha}  exit ${meta.exitCode}`);
} else {
  const minutes = Number(args.minutes || 30);
  to = Date.now();
  from = to - minutes * 60000;
  warn(`no run sidecar found - using the last ${minutes} minutes of events.ndjson`);
}

const eventsFile = path.join(p.results, 'events.ndjson');
const events = [];
if (fs.existsSync(eventsFile)) {
  for (const line of fs.readFileSync(eventsFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const t = new Date(rec.ts).getTime();
    if (t >= from && t <= to) events.push(rec);
  }
}

const fails = events.filter((e) => e.state === 'fail');
const skips = events.filter((e) => e.state === 'skip');
const passes = events.filter((e) => e.state === 'pass');

const outDir = path.join(p.results, 'evidence', stamp());
fs.mkdirSync(outDir, { recursive: true });

// Screenshots written during the window.
const shots = [];
for (const f of fs.readdirSync(p.results)) {
  if (!f.toLowerCase().endsWith('.png')) continue;
  const full = path.join(p.results, f);
  const st = fs.statSync(full);
  if (st.mtimeMs >= from && st.mtimeMs <= to) {
    fs.copyFileSync(full, path.join(outDir, f));
    shots.push(f);
  }
}

const rel = (x) => path.relative(root, x).replace(/\\/g, '/');
const md = [];
md.push(`# Evidence bundle - ${meta ? meta.tag : 'adhoc'}`);
md.push('');
md.push(`- generated: ${new Date().toISOString()}`);
md.push(`- git: \`${meta?.gitSha ?? 'unknown'}\``);
md.push(`- specs: ${(meta?.specs ?? ['(unknown)']).map((s) => `\`${s}\``).join(', ')}`);
md.push(`- wipe: ${meta ? (meta.wipe ? 'yes' : 'no') : 'unknown'}`);
md.push(`- duration: ${meta ? (meta.durationMs / 1000).toFixed(1) + 's' : 'n/a'}`);
md.push(`- exit: ${meta?.exitCode ?? 'n/a'} (pass ${passes.length} / fail ${fails.length} / skip ${skips.length})`);
md.push('');
md.push('## Failures');
md.push('');
if (!fails.length) {
  md.push('_none_');
} else {
  md.push('| test | file | error |');
  md.push('|---|---|---|');
  for (const f of fails) {
    const err = String((f.error && f.error[0]) || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 400);
    md.push(`| ${String(f.fullTitle || '').replace(/\|/g, '\\|')} | ${f.file || ''} | ${err} |`);
  }
}
if (skips.length) {
  md.push('');
  md.push('## Skips');
  md.push('');
  for (const s of skips) md.push(`- ${s.fullTitle}`);
}
md.push('');
md.push('## Screenshots captured during the run');
md.push('');
md.push(shots.length ? shots.map((s) => `- \`${s}\``).join('\n') : '_none_');
md.push('');
md.push('## Raw artifacts');
md.push('');
md.push(`- log: \`${meta?.log ?? '(none)'}\``);
md.push(`- events: \`${rel(eventsFile)}\``);
md.push(`- sidecar: \`${sidecarPath ? rel(sidecarPath) : '(none)'}\``);
md.push('');
md.push('## Next');
md.push('');
md.push('1. Classify each failure with `references/triage-playbook.md` before editing code.');
md.push('2. Quote the raw observation in the verdict; name the evidence class.');
md.push('3. `repeat-run.mjs --spec <spec> --times 3` if any failure looks intermittent.');

const reportPath = path.join(outDir, 'report.md');
fs.writeFileSync(reportPath, md.join('\n') + '\n', 'utf8');

console.log('');
ok(`bundle ${rel(reportPath)}`);
info(`pass ${passes.length} / fail ${fails.length} / skip ${skips.length}, ${shots.length} screenshot(s)`);
if (fails.length) {
  console.log('');
  console.log(`${C.red}${fails.length} failure(s):${C.reset}`);
  for (const f of fails.slice(0, 20)) {
    const err = String((f.error && f.error[0]) || '').split(/\r?\n/)[0].slice(0, 140);
    console.log(`  - ${f.fullTitle}\n      ${err}`);
  }
  if (fails.length > 20) console.log(`  ... and ${fails.length - 20} more (see report)`);
}

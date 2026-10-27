import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// Check summary.json dashboard math
const summary = JSON.parse(fs.readFileSync(path.join(ROOT, 'results/summary.json'), 'utf8'));
const d = summary.dashboard;
const sum = d.passedFull + d.passPartial + d.failed + d.na + d.remaining + d.blocked;
console.log('=== summary.json dashboard ===');
console.log(`PASS ${d.passedFull} + PARTIAL ${d.passPartial} + FAIL ${d.failed} + N/A ${d.na} + REMAIN ${d.remaining} + BLOCKED ${d.blocked} = ${sum} (total ${d.total})`);

// Check fixtures
const failCases = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/fail-cases.json'), 'utf8'));
const naCases = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/na-cases.json'), 'utf8'));
const blockedCases = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/blocked-cases.json'), 'utf8'));
console.log(`\n=== fixtures ===`);
console.log(`fail-cases.json: ${failCases.length}`);
console.log(`na-cases.json: ${naCases.length}`);
console.log(`blocked-cases.json: ${blockedCases.length}`);

// Check COVERAGE.md dashboard
const cov = fs.readFileSync(path.join(ROOT, 'COVERAGE.md'), 'utf8');
const dashMatch = cov.match(/\|\s*Passed \(full\)\s*\|\s*(\d+)/);
const partialMatch = cov.match(/\|\s*Passed \(partial[^)]*\)\s*\|\s*(\d+)/);
const failMatch = cov.match(/\|\s*\*\*FAILED\*\*\s*\|\s*(\d+)/);
const naMatch = cov.match(/\|\s*N\/A \(absent[^)]*\)\s*\|\s*(\d+)/);
const remMatch = cov.match(/\|\s*Remaining[^)]*\s*\|\s*(\d+)/);
const blockMatch = cov.match(/\|\s*BLOCKED \([^)]*\)\s*\|\s*(\d+)/);
console.log(`\n=== COVERAGE.md dashboard ===`);
console.log(`PASS: ${dashMatch?.[1] ?? '?'} (expect ${d.passedFull})`);
console.log(`PARTIAL: ${partialMatch?.[1] ?? '?'} (expect ${d.passPartial})`);
console.log(`FAIL: ${failMatch?.[1] ?? '?'} (expect ${d.failed})`);
console.log(`N/A: ${naMatch?.[1] ?? '?'} (expect ${d.na})`);
console.log(`REMAIN: ${remMatch?.[1] ?? '?'} (expect ${d.remaining})`);
console.log(`BLOCKED: ${blockMatch?.[1] ?? '?'} (expect ${d.blocked})`);

// Count Batch 26 cases in each fixture
const BATCH26 = [
  'RCP-01','RCP-02','RCP-03','RCP-05','RCP-07','RCP-08','RCP-09','RCP-10',
  'RCP-11','RCP-12','RCP-13','RCP-14','RCP-15','RCP-16','RCP-17','RCP-18',
  'RCP-19','RCP-21','RCP-22','RCP-23','RCP-24',
  'TIM-02','TIM-03','TIM-04','TIM-05','TIM-06','TIM-07','TIM-09','TIM-10'
];
const b26Fail = failCases.filter(e => BATCH26.includes(e.id));
const b26Na = naCases.filter(e => BATCH26.includes(e.id));
const b26Blocked = blockedCases.filter(e => BATCH26.includes(e.id));
console.log(`\n=== Batch 26 in fixtures ===`);
console.log(`FAIL: ${b26Fail.length} (${b26Fail.map(e => e.id).join(', ')})`);
console.log(`N/A: ${b26Na.length} (${b26Na.map(e => e.id).join(', ')})`);
console.log(`BLOCKED: ${b26Blocked.length} (${b26Blocked.map(e => e.id).join(', ')})`);

// Read CSV for Batch 26 IDs
const csvText = fs.readFileSync(path.join(ROOT, 'CASE_INDEX.csv'), 'utf8').replace(/^\uFEFF/, '');
const rows = [];
let cur = '', inQ = false;
for (let i = 0; i < csvText.length; i += 1) {
  const c = csvText[i];
  if (inQ) { if (c === '"') { if (csvText[i+1] === '"') { cur += '"'; i += 1; } else inQ = false; } else cur += c; }
  else if (c === '"') inQ = true;
  else if (c === ',') cur += '\u0001';
  else if (c === '\n') { if (cur.endsWith('\r')) cur = cur.slice(0,-1); rows.push(cur.split('\u0001')); cur = ''; }
  else cur += c;
}
if (cur) rows.push(cur.split('\u0001'));
const h = rows.shift();
const col = Object.fromEntries(h.map((x,i) => [x,i]));
const b26rows = rows.filter(r => r.length >= h.length && BATCH26.includes(r[col.id]));
const byVerdict = {};
for (const r of b26rows) { const v = r[col.verdict] || 'REMAIN'; byVerdict[v] = (byVerdict[v]||0)+1; }
console.log(`\n=== Batch 26 in CSV ===`);
console.log(JSON.stringify(byVerdict));
console.log(`total Batch 26 rows: ${b26rows.length}`);

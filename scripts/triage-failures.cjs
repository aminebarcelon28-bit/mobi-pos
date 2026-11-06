const fs = require('fs');
const path = require('path');

// 1. Baseline verdicts from COVERAGE.md
const cov = fs.readFileSync('e2e-tests/results/baseline/c01-stage-a/COVERAGE.md', 'utf8');
const baseline = new Map();
for (const line of cov.split(/\r?\n/)) {
  if (!line.startsWith('|')) continue;
  const cols = line.split('|').map((c) => c.trim());
  if (cols.length < 7) continue;
  const id = cols[1];
  if (!/^[A-Z]{2,4}-\d+/.test(id)) continue;
  const verdict = (cols[5] || '').split(' ')[0] || '';
  const reason = cols.slice(6).join(' | ').trim();
  baseline.set(id, { verdict, reason });
}

// 2. Failing cases in the tagrun (43-spec sweep)
const runLog = fs
  .readdirSync('e2e-tests/results/runs')
  .filter((f) => f.includes('tagrun-382c1bf') && f.endsWith('.log'))
  .map((f) => path.join('e2e-tests/results/runs', f))
  .sort()
  .pop();
const log = fs.readFileSync(runLog, 'utf8');
const failing = new Set();
for (const line of log.split(/\r?\n/)) {
  const m = /\[([A-Z]{2,4}-\d+)\]/.exec(line);
  if (m && /Error in "|✖|FAILED/.test(line)) failing.add(m[1]);
}

// 3. Isolated scale runs
const scale = [];
for (const f of fs.readdirSync('e2e-tests/results/runs').filter((x) => x.includes('-iso-') && x.endsWith('.json'))) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join('e2e-tests/results/runs', f), 'utf8'));
    scale.push({ file: f, passing: j.passing, failing: j.failing, cases: j.cases });
  } catch {}
}

// 4. Classify every failing case against the baseline row
const rows = [...failing].sort().map((id) => {
  const b = baseline.get(id);
  if (!b) return { id, verdict: 'NO-BASELINE-ROW', reason: '' };
  return { id, verdict: b.verdict, reason: b.reason.slice(0, 90) };
});

const bucket = (v) => {
  if (/^PASS/.test(v)) return 'REGRESSION?';
  if (/^N\/A/.test(v)) return 'N/A-by-design';
  if (/^FAIL/.test(v)) return 'real-gap';
  return v;
};
const counts = {};
for (const r of rows) {
  const k = bucket(r.verdict);
  counts[k] = (counts[k] || 0) + 1;
}

// baseline totals for reconciliation
const baseCounts = {};
for (const [, b] of baseline) {
  const k = bucket(b.verdict);
  baseCounts[k] = (baseCounts[k] || 0) + 1;
}

console.log('=== run:', path.basename(runLog));
console.log('=== failing cases in tagrun:', rows.length);
console.log('=== classification:', JSON.stringify(counts));
console.log('=== baseline totals (all rows):', JSON.stringify(baseCounts), 'rows:', baseline.size);
console.log('=== scale isolated:', JSON.stringify(scale));
console.log('=== REGRESSIONS (fail now, PASS in baseline):');
for (const r of rows.filter((x) => bucket(x.verdict) === 'REGRESSION?')) console.log('  ', r.id, r.verdict);
console.log('=== NO BASELINE ROW (needs a ruling):');
for (const r of rows.filter((x) => x.verdict === 'NO-BASELINE-ROW')) console.log('  ', r.id);
console.log('=== real gaps by spec prefix:');
const byPrefix = {};
for (const r of rows.filter((x) => bucket(x.verdict) === 'real-gap')) {
  const p = r.id.split('-')[0];
  byPrefix[p] = (byPrefix[p] || 0) + 1;
}
console.log(JSON.stringify(byPrefix));
console.log('=== N/A-by-design (first 10):');
for (const r of rows.filter((x) => bucket(x.verdict) === 'N/A-by-design').slice(0, 10))
  console.log('  ', r.id, '::', r.reason);

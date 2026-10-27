/** Emit the SCL triage table (markdown) for BATCH27A-SCL.md. */
import fs from 'node:fs';

const already = [7, 12, 13, 14, 23, 26, 36, 37, 38, 43, 45, 46, 47, 48, 58, 77, 78, 79, 83, 84];
const mobile = [16, 34, 35, 44, 56];
const gateway = [9, 21, 42, 66, 69, 73, 87];

const in27a = [27, 31, 61, 2, 3, 11, 23, 88, 71, 74, 4, 6, 5, 28, 10, 52, 53, 80, 82, 76, 70, 57, 59, 62, 63];
const long = [];
for (let i = 1; i <= 89; i += 1) {
  if (!already.includes(i) && !in27a.includes(i) && !mobile.includes(i) && !gateway.includes(i)) long.push(i);
}

// Re-triage of the executables not run in 27a + one promotion.
const reTriage = {
  1: { cat: 'NEEDS-LONG', tier: 'L', why: 'case needs a p95 curve from 1 k → 1 M rows and stale-query cancellation; the largest fixture the box has ever held is 1,006 customers (27a log)' },
  17: { cat: 'NEEDS-GATEWAY', tier: '—', why: 'needs a replicated table + ≥2 enrolled terminals to observe conflict creation and convergence; no gateway harness exists (`syncDrainWorker.ts` idles when `sync.gateway_url` is unset)' },
  40: { cat: 'NEEDS-LONG', tier: 'L', why: 'needs 5 M sales and a 1 M-row import to measure commit p95 and per-index write amplification' },
  50: { cat: 'EXECUTABLE-DESKTOP', tier: '—', why: '40 k sale ids is a ~3 s seed at the measured 5,000 rows/394 ms rate; promoted to 27b' },
  54: { cat: 'EXECUTABLE-DESKTOP', tier: '—', why: 'no fixture size in the case text — it asks that opening the dashboard repeatedly never delays a sale; promoted to 27b' },
  86: { cat: 'EXECUTABLE-DESKTOP', tier: '—', why: 'derived-table rebuild + drift detector can be probed on the normal sandbox (SCL-27 already proved no rebuild command exists); 27b' },
};

const whyLong = {
  8: '100 k-row CSV import (Arabic, bad rows, duplicates) + kill/resume',
  15: '1 M customers + 5 M lines: VACUUM/backup/restore timing',
  18: '1 M rows under a custom Arabic/French collation on every connection',
  19: '1 M-row CSV/XLSX export, cancel midway, low-RAM profile',
  20: 'aggregate screens over 1 M customers',
  22: '5 M sale lines / 10 M audit rows / 2 M IMEIs growth curve',
  24: 'reports over 1 M customers / 5 M sales',
  25: 'ranking at 100 k customers with a brute-force oracle',
  29: 'sales history at 100 k / 1 M / 5 M sales',
  30: 'receipt/IMEI lookup at 5 M sales',
  32: 'period reports at 5 M sales / 10 M lines',
  33: 'product search at 100 k–500 k products',
  39: 'FTS maintenance over a 100 k-product bulk update',
  41: '10 M-row audit chain append/verify/export',
  49: 'planner stats after a 1 M import with 90 % skew',
  51: 'ORDER BY over 1 M rows with temp-B-tree spill',
  55: '3-year projection fixture (sales/day × 365 × 3)',
  60: '100 k products with deep price history',
  64: 'duplicate detection over 1 M customers',
  65: 'nightly jobs over 1 M customers',
  67: 'import into a non-empty 1 M-customer table',
  68: 'bulk anonymise of 100 k customers',
  72: '500 k products + 2 M IMEIs barcode namespace',
  75: 'bulk price change on 100 k products',
  81: 'per-table/per-index size at every fixture size',
  85: 'statement-count budget on the 5 M fixture',
  89: 'rebuild commands on a 5 M DB',
};

const rows = [];
for (let i = 1; i <= 89; i += 1) {
  const id = `SCL-${String(i).padStart(2, '0')}`;
  let cat;
  let tier = '—';
  let why;
  if (in27a.includes(i)) {
    cat = already.includes(i) ? 'EXECUTED (re-run)' : 'EXECUTED 27a';
    why = already.includes(i) ? 'already executed in an earlier batch; re-run in 27a because the case was rewritten' : 'runs on the desktop sandbox (wdio.conf.ts, disposable DB copy)';
  } else if (already.includes(i)) {
    cat = 'EXECUTED';
    why = 'executed in an earlier batch (CASE_INDEX.csv)';
  } else if (reTriage[i]) {
    ({ cat, tier, why } = reTriage[i]);
  } else if (mobile.includes(i)) {
    cat = 'NEEDS-MOBILE';
    why = {
      16: 'needs mobile enrol/bootstrap against a paired till',
      34: 'mobile-only variant/image UI',
      35: 'mobile-only variant/image UI',
      44: 'mobile Dexie/sync path',
      56: 'mobile Dexie/sync path',
    }[i];
  } else if (gateway.includes(i)) {
    cat = 'NEEDS-GATEWAY';
    why = {
      9: 'merge of two terminals’ edits — needs the sync gateway',
      21: 'gateway or second device',
      42: 'concurrent writes from two devices',
      66: 'gateway/SMS integration',
      69: 'second enrolled terminal',
      73: 'three enrolled devices',
      87: 'cloud backend + volume fixture',
    }[i];
  } else if (long.includes(i)) {
    cat = 'NEEDS-LONG';
    tier = /^(8|25|33|39|60|68|75)$/.test(String(i)) ? 'S' : /^(15|18|19|20|24|29|49|51|64|65|67|81)$/.test(String(i)) ? 'L' : 'X';
    why = whyLong[i] ?? 'scale fixture';
  } else {
    cat = 'EXECUTABLE-DESKTOP';
    why = 'runs on the desktop sandbox';
  }
  rows.push(`| ${id} | ${cat} | ${tier} | ${why} |`);
}

const counts = rows.reduce((a, r) => {
  const c = r.split('|')[2].trim();
  a[c] = (a[c] || 0) + 1;
  return a;
}, {});
const ascii = (s) =>
  s
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/[\u2019]/g, "'")
    .replace(/\u2192/g, '->')
    .replace(/\u2265/g, '>=')
    .replace(/\u00d7/g, 'x')
    .replace(/\u2190/g, '<-');
fs.writeFileSync(process.env.TEMP + '/scl-triage-table.md', ascii(rows.join('\n')) + '\n', 'utf8');
console.log(JSON.stringify(counts, null, 1));
console.log('rows=' + rows.length);

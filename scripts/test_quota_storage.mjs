/**
 * MOBI POS — Cloud Storage Meter Test Suite
 *
 * Guards the on-device Turso quota meter (2026-09-18): the billed basis is the
 * dbstat tables+indexes sum (freelist is NOT billed), the default quota is the
 * 5 GB merchant plan, and threshold alerts fire at 70/85/95/100%.
 *
 * Pure math only (storageReport.ts has zero platform imports): no network, no
 * credentials, deterministic.
 */

import {
  buildStorageReport,
  formatBytes,
  DEFAULT_DATABASE_QUOTA_BYTES,
  QUOTA_THRESHOLDS,
} from '../src/sync/storageReport.ts';

console.log('========================================================================');
console.log('MOBI POS — CLOUD STORAGE METER SUITE');
console.log('========================================================================\n');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS ${message}`);
    passCount++;
  } else {
    console.log(`  FAIL ${message}`);
    failCount++;
  }
}

const GB5 = 5 * 1024 * 1024 * 1024;

// --- TEST 1: plan constants ---
assert(DEFAULT_DATABASE_QUOTA_BYTES === GB5, 'default quota is the 5 GB merchant plan');
assert(QUOTA_THRESHOLDS.NOTICE === 0.7 && QUOTA_THRESHOLDS.WARNING === 0.85 && QUOTA_THRESHOLDS.CRITICAL === 0.95, 'thresholds are 70/85/95');

// --- TEST 2: billed basis preferred over file size ---
// Post-purge merchant shape: 92.3 MB file, 91.6 MB freelist, ~0.6 MB dbstat.
const fileBytes = 22537 * 4096;
const freelistBytes = 22356 * 4096;
const r = buildStorageReport({
  fileBytes,
  freelistBytes,
  billedBytes: 600000,
  quotaBytes: GB5,
  tableBreakdown: [],
  isEstimated: false,
});
assert(r.totalBytes === 600000, 'total uses the dbstat billed sum, not the file size');
assert(r.fileBytes === fileBytes, 'file bytes preserved for display');
assert(r.liveBytes === fileBytes - freelistBytes, 'live = file − freelist');
assert(r.freelistBytes === freelistBytes, 'freelist preserved for display');
assert(r.usedPercentage === 0, '0.6 MB of 5 GB rounds to 0% (no false alarm)');
assert(r.thresholdLevel === 'OK' && !r.alertMessage, 'no alert near zero');
assert(r.remainingBytes === GB5 - 600000, 'remaining = quota − billed');

// --- TEST 3: file fallback when dbstat unavailable ---
const fb = buildStorageReport({
  fileBytes,
  freelistBytes: 0,
  billedBytes: null,
  quotaBytes: GB5,
  tableBreakdown: [{ tableName: 'products', bytes: 1000, isEstimated: true }],
  isEstimated: true,
});
assert(fb.totalBytes === fileBytes, 'without dbstat, total falls back to file size');
assert(fb.isEstimated === true, 'fallback path flagged estimated');

// --- TEST 4: empty/error state degrades to zeros, never NaN ---
const zero = buildStorageReport({
  fileBytes: 0,
  freelistBytes: 0,
  billedBytes: null,
  quotaBytes: GB5,
  tableBreakdown: [],
  isEstimated: true,
});
assert(zero.totalBytes === 0 && zero.usedPercentage === 0, 'empty state is zeros, not NaN');
assert(zero.remainingBytes === GB5 && zero.thresholdLevel === 'OK', 'empty state shows full quota OK');

// --- TEST 5: threshold boundaries (exact edges) ---
const at = (ratio) =>
  buildStorageReport({
    fileBytes: 0,
    freelistBytes: 0,
    billedBytes: Math.floor(GB5 * ratio),
    quotaBytes: GB5,
    tableBreakdown: [],
    isEstimated: false,
  });
assert(at(0.69).thresholdLevel === 'OK', '69% stays OK');
assert(at(0.7).thresholdLevel === 'NOTICE', '70% trips NOTICE');
assert(at(0.849).thresholdLevel === 'NOTICE', '84.9% stays NOTICE');
assert(at(0.85).thresholdLevel === 'WARNING', '85% trips WARNING');
assert(at(0.949).thresholdLevel === 'WARNING', '94.9% stays WARNING');
assert(at(0.95).thresholdLevel === 'CRITICAL', '95% trips CRITICAL');
assert(at(1.0).thresholdLevel === 'EXCEEDED', '100% trips EXCEEDED with action');
assert(at(1.0).actionRequired !== undefined, 'EXCEEDED carries an action message');
assert(at(1.4).thresholdLevel === 'EXCEEDED', '140% stays EXCEEDED');
assert(at(1.4).usedPercentage === 100, 'percentage clamps at 100');
assert(at(1.4).remainingBytes === 0, 'remaining clamps at 0, never negative');

// --- TEST 6: formatter (French units, shared desktop/mobile) ---
assert(formatBytes(0) === '0 Mo', 'zero formats as 0 Mo');
assert(formatBytes(2048) === '2.0 Ko', 'kilobytes with one decimal');
assert(formatBytes(92.3 * 1048576).startsWith('92.3 Mo'), 'megabytes with one decimal');
assert(formatBytes(GB5) === '5.00 Go', 'gigabytes with two decimals');

console.log('\n========================================================================');
console.log(`STORAGE METER RESULTS: ${passCount} Passed, ${failCount} Failed`);
console.log('========================================================================');
if (failCount > 0) {
  console.error('Storage-meter invariant VIOLATED.');
  process.exit(1);
}
console.log('Storage meter holds: billed basis, 5 GB quota, 70/85/95/100 alerts.');

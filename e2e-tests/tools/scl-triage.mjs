#!/usr/bin/env node
// SCL triage - classify all 89 SCL rows
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CSV = path.join(ROOT, 'CASE_INDEX.csv');

const csvText = fs.readFileSync(CSV, 'utf8').replace(/^\uFEFF/, '');
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

// All SCL rows
const sclRows = rows.filter(r => r.length >= h.length && r[col.domain] === 'SCL' && r[col.retired] !== '1');
console.log(`Total SCL rows: ${sclRows.length}`);

// Classify
const EXECUTABLE = [];
const NEEDS_MOBILE = [];
const NEEDS_GATEWAY = [];
const NEEDS_LONG = [];
const NA = [];
const ALREADY = []; // already executed

const REASONS = {};

function classify(id, title, verdict) {
  const t = (title || '').toLowerCase();
  // Already executed
  if (['PASS', 'FAIL', 'N/A'].includes(verdict)) {
    ALREADY.push(id);
    return;
  }
  // N/A
  if (t.includes('archive') && (t.includes('old sales') || t.includes('attached database'))) {
    NA.push(id); REASONS[id] = 'Archiving feature does not exist'; return;
  }
  // Needs mobile
  if (t.includes('mobile') || t.includes('android') || t.includes('ios') || t.includes('dexie')) {
    NEEDS_MOBILE.push(id); REASONS[id] = 'Mobile-specific: Dexie/mobile sync'; return;
  }
  if (t.includes('variant explosion') || t.includes('product images')) {
    NEEDS_MOBILE.push(id); REASONS[id] = 'Mobile-specific: variant/images'; return;
  }
  if (t.includes('walk-in customer') && t.includes('4.5 m')) {
    NEEDS_GATEWAY.push(id); REASONS[id] = 'Needs second enrolled terminal or gateway'; return;
  }
  if (t.includes('new device bootstrap') || t.includes('new tablet')) {
    NEEDS_MOBILE.push(id); REASONS[id] = 'Needs mobile enroll/bootstrap'; return;
  }
  if (t.includes('attached database') || t.includes('archive file')) {
    NA.push(id); REASONS[id] = 'Archive across attached DBs feature absent'; return;
  }
  // Needs long window
  if (t.includes('1 m ') || t.includes('100 k') || t.includes('10 m') || t.includes('2 m') || t.includes('5 m')) {
    if (t.includes('cold start') || t.includes('warm start') || t.includes('bulk import') || t.includes('export 1 m') || t.includes('migration') || t.includes('vacuum') || t.includes('disk space') || t.includes('3-year') || t.includes('nightly') || t.includes('integrity') || t.includes('where the space') || t.includes('bulk anonymize')) {
      NEEDS_LONG.push(id); REASONS[id] = 'Needs >1h fixture generation or execution'; return;
    }
  }
  if (t.includes('bulk duplicate merge') && t.includes('10 k')) {
    NEEDS_GATEWAY.push(id); REASONS[id] = 'Needs second terminal or gateway for merge'; return;
  }
  if (t.includes('concurrent') && (t.includes('20 writes') || t.includes('20 devices'))) {
    NEEDS_GATEWAY.push(id); REASONS[id] = 'Needs second device or gateway for concurrent writes'; return;
  }
  if (t.includes('bulk sms') || t.includes('whatsapp campaign')) {
    NEEDS_GATEWAY.push(id); REASONS[id] = 'Needs gateway/SMS integration'; return;
  }
  if (t.includes('full stocktake') && t.includes('3 devices')) {
    NEEDS_GATEWAY.push(id); REASONS[id] = 'Needs 3 enrolled devices'; return;
  }
  if (t.includes('backend quota') || t.includes('turso') || t.includes('3-year volume')) {
    NEEDS_GATEWAY.push(id); REASONS[id] = 'Needs cloud backend + volume fixture'; return;
  }
  if (t.includes('attached database')) {
    NA.push(id); REASONS[id] = 'Archive across attached databases feature absent'; return;
  }
  if (t.includes('cold start') || t.includes('warm start')) {
    NEEDS_LONG.push(id); REASONS[id] = 'Needs 1M-row DB fixture'; return;
  }
  if (t.includes('slow or cold storage') || t.includes('5400 rpm') || t.includes('sd card')) {
    NEEDS_MOBILE.push(id); REASONS[id] = 'Mobile storage test (SD card)'; return;
  }
  if (t.includes('mobile keeps only') || t.includes('recent window')) {
    NEEDS_MOBILE.push(id); REASONS[id] = 'Mobile-only history window'; return;
  }
  if (t.includes('archiving') || t.includes('archive across')) {
    NA.push(id); REASONS[id] = 'Archive feature does not exist'; return;
  }
  if (t.includes('document-number counters') && t.includes('across devices')) {
    NEEDS_GATEWAY.push(id); REASONS[id] = 'Needs second enrolled terminal'; return;
  }
  if (t.includes('anonymize') && t.includes('one customer')) {
    NEEDS_GATEWAY.push(id); REASONS[id] = 'Needs gateway or second device'; return;
  }
  // Default: check if needs scale fixture
  if (t.includes('10 m') || t.includes('100 k') || t.includes('1 m ') || t.includes('2 m') || t.includes('5 m')) {
    NEEDS_LONG.push(id); REASONS[id] = 'Needs large-scale fixture (>1307 rows) not yet available'; return;
  }
  // Check by ID number ranges
  const n = parseInt(id.replace('SCL-',''));
  // Long-running or heavy
  if ([39, 41, 45, 54, 55, 65, 66, 68, 81].includes(n)) {
    NEEDS_LONG.push(id); REASONS[id] = 'Scale/long-window test (>1h)'; return;
  }
  // Executable
  EXECUTABLE.push(id);
}

for (const r of sclRows) {
  classify(r[col.id], r[col.title], r[col.verdict] || 'REMAIN');
}

console.log('\n=== TRIAGE RESULTS ===');
console.log(`ALREADY EXECUTED: ${ALREADY.length} (${ALREADY.join(', ')})`);
console.log(`EXECUTABLE-DESKTOP: ${EXECUTABLE.length}`);
console.log(`NEEDS-MOBILE: ${NEEDS_MOBILE.length}`);
console.log(`NEEDS-GATEWAY/2ND-TERMINAL: ${NEEDS_GATEWAY.length}`);
console.log(`NEEDS-LONG-WINDOW: ${NEEDS_LONG.length}`);
console.log(`N/A: ${NA.length}`);

console.log('\nNEEDS-MOBILE:'); NEEDS_MOBILE.forEach(id => console.log(`  ${id}: ${REASONS[id]}`));
console.log('\nNEEDS-GATEWAY:'); NEEDS_GATEWAY.forEach(id => console.log(`  ${id}: ${REASONS[id]}`));
console.log('\nNEEDS-LONG:'); NEEDS_LONG.forEach(id => console.log(`  ${id}: ${REASONS[id]}`));
console.log('\nN/A:'); NA.forEach(id => console.log(`  ${id}: ${REASONS[id]}`));
console.log('\nEXECUTABLE-DESKTOP:'); console.log(EXECUTABLE.join(', '));

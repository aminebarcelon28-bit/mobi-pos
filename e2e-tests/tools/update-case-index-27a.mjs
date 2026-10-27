/** Update CASE_INDEX.csv from the Batch 27a log + the TIM-09 / RCP-19 outcomes. */
import fs from 'node:fs';

const LOG = 'logs/part0-27a-scl.log';
const CSV = 'CASE_INDEX.csv';
const raw = fs.readFileSync(LOG);
// PowerShell Tee-Object writes UTF-16LE; plain redirects write UTF-8.
const log =
  raw[0] === 0xff && raw[1] === 0xfe ? raw.slice(2).toString('utf16le') : raw.toString('utf8');

// Parse the VERDICT lines: "VERDICT=SCL-27 FAIL | note"
const verdicts = new Map();
for (const m of log.matchAll(/VERDICT=(SCL-\d{2}) (PASS-PARTIAL|PASS|FAIL|N\/A) \| ([\s\S]*?)(?=\r?\n)/g)) {
  verdicts.set(m[1], { verdict: m[2], note: m[3].replace(/\s+/g, ' ').trim() });
}
console.log(`parsed ${verdicts.size} verdicts`);

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;

const lines = fs.readFileSync(CSV, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
const header = lines[0];
const rows = lines.slice(1).filter(Boolean).map(parseCsvLine);
const idx = Object.fromEntries(parseCsvLine(header).map((h, i) => [h, i]));

let changed = 0;
for (const row of rows) {
  const id = row[idx.id];
  const v = verdicts.get(id);
  if (v) {
    row[idx.verdict] = v.verdict;
    row[idx.spec] = '27a-scl-batch.e2e.ts';
    row[idx.evidence] = `${v.verdict}: ${v.note} (e2e-tests/logs/part0-27a-scl.log)`;
    changed += 1;
    continue;
  }
  if (id === 'TIM-09') {
    row[idx.verdict] = 'FAIL';
    row[idx.spec] = 'tools/tim09-timezone.mjs';
    row[idx.evidence] =
      'FAIL: mobile in Pacific/Midway (device Sun Oct 25 14:29 SST) vs shop Africa/Algiers for the instant 2026-10-26T00:30:00Z: shop day 2026-10-26 01:30 vs device day 2026-10-25 13:30 (discriminating=true). The day-bucket half passes - todayLocalKey/toLocalDayKey force the shop TZ (dateUtils.ts:11-28) and the app date strip rendered 2026-10-26 while the device was on 25 Oct - but every display formatter omits timeZone, so the same sale renders in DEVICE time: i18n/index.ts:323-345 (fr/ar/pseudo Intl.DateTimeFormat with no timeZone), types/pos.ts:1952-1965 (toLocaleString fr-DZ, no timeZone), LiveActivityTab.tsx:866-875 (toLocaleTimeString/toLocaleString, no timeZone). WAR-03 requires the same date on receipt, desktop and mobile; on a roaming phone it is not. The rendered sale itself could not be photographed because the unpaired companion renders no sales (see P1-67 withdrawal) - the display half rests on formatter source + the measured 12 h zone divergence, not on a screenshot. (e2e-tests/logs/tim09-timezone.log)';
    changed += 1;
    continue;
  }
  if (id === 'RCP-19') {
    row[idx.evidence] =
      'BLOCKED: needs a Bluetooth ESC/POS printer. The Android half is no longer blocked - first-run setup, manager login and PIN unlock are scripted and proven from a wiped state (e2e-tests/lib/session.mjs, logs/part0-mobile-proof.log: PROOF_RESULT=PASS, at_till=true). P1-67 is withdrawn (a pushed DB survives boot unchanged; the companion reads the sync projection p_products, not products), so the remaining gap is the physical printer only. (e2e-tests/logs/batch26-rcp-tim.log, e2e-tests/logs/part0-mobile-proof.log)';
    changed += 1;
  }
}

fs.writeFileSync(CSV, [header, ...rows.map((r) => r.map(quote).join(','))].join('\n') + '\n', 'utf8');
console.log(`updated ${changed} rows; total rows ${rows.length}`);

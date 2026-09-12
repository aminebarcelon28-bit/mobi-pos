// Static audit: every INSERT INTO in sync SQL must have matching column/value
// counts (split VALUES on top-level commas, strings/parens aware).
// Run: node scripts/audit-sql.mjs  (exit 1 on mismatch)
import { readFileSync } from 'node:fs';

const files = ['src/sync/SyncManager.ts', 'src/db/sqlPluginAdapter.ts', 'src/db/backfill.ts'];
let failures = 0;

function splitTop(s) {
  const parts = [];
  let depth = 0, inStr = false, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && s[i - 1] !== '\\') { inStr = !inStr; cur += c; continue; }
    if (inStr) { cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean);
}

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const re = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([^\s(]+)\s*\(([^)]+)\)\s*VALUES\s*\(/gis;
  let m;
  while ((m = re.exec(src)) !== null) {
    const table = m[1];
    const cols = splitTop(m[2]);
    // find matching close paren of VALUES(
    let i = re.lastIndex, depth = 1, inStr = false, buf = '';
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (c === "'" && src[i - 1] !== '\\') inStr = !inStr;
      if (!inStr) {
        if (c === '(') depth++;
        if (c === ')') { depth--; if (depth === 0) break; }
      }
      buf += c;
    }
    re.lastIndex = i;
    const vals = splitTop(buf);
    const tag = `${f.split('/').pop()} ${table}`;
    if (vals.length !== cols.length) {
      console.log(`MISMATCH ${tag}: cols=${cols.length} values=${vals.length}`);
      failures++;
      continue;
    }
    // Positional check: status literals must land on status-like columns.
    // (Catches the 'synced'-at-wrong-index class that counts alone miss.)
    vals.forEach((v, i) => {
      const lit = /^'(.*)'$/.exec(v.trim());
      if (!lit) return;
      const text = lit[1];
      const col = (cols[i] || '').toLowerCase();
      if (/^(synced|pending|inflight|failed)$/i.test(text) && !/(sync|status)/i.test(col)) {
        console.log(`MISPLACED ${tag}: '${text}' at col ${i + 1} (${cols[i]})`);
        failures++;
      }
      if (/^(UPSERT|DELETE)$/i.test(text) && !/operation/i.test(col)) {
        console.log(`MISPLACED ${tag}: '${text}' at col ${i + 1} (${cols[i]})`);
        failures++;
      }
    });
    console.log(`ok ${tag}: ${cols.length}`);
  }
}
console.log(failures === 0 ? 'AUDIT OK' : `AUDIT FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);

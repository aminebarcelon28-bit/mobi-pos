/** Recount CASE_INDEX.csv verdicts (all rows and the 687-row catalog scope). */
import fs from 'node:fs';

const t = fs.readFileSync('CASE_INDEX.csv', 'utf8').replace(/^\uFEFF/, '');
const lines = t.split(/\r?\n/).filter(Boolean);
const parse = (l) => {
  const o = [];
  let c = '';
  let q = false;
  for (let i = 0; i < l.length; i += 1) {
    const ch = l[i];
    if (q) {
      if (ch === '"' && l[i + 1] === '"') {
        c += '"';
        i += 1;
      } else if (ch === '"') q = false;
      else c += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      o.push(c);
      c = '';
    } else c += ch;
  }
  o.push(c);
  return o;
};
const h = parse(lines[0]);
const I = Object.fromEntries(h.map((x, i) => [x, i]));
const rows = lines.slice(1).map(parse);
const cnt = (rs) => {
  const m = {};
  for (const r of rs) m[r[I.verdict]] = (m[r[I.verdict]] || 0) + 1;
  return m;
};
const retired = rows.filter((r) => r[I.retired] === '1');
const active = rows.filter((r) => r[I.retired] !== '1');
console.log(`rows=${rows.length} retired=${retired.length} active=${active.length}`);
const bad = rows.filter((r) => r.length !== h.length);
console.log(`field_count_mismatches=${bad.length}${bad.length ? ' ' + JSON.stringify(bad.slice(0, 5).map((r) => r[0])) : ''}`);
console.log(`all=${JSON.stringify(cnt(rows))}`);
console.log(`active=${JSON.stringify(cnt(active))}`);
const domains = {};
for (const r of active) {
  const d = r[I.domain];
  domains[d] = domains[d] || {};
  domains[d][r[I.verdict]] = (domains[d][r[I.verdict]] || 0) + 1;
}
console.log(`SCL=${JSON.stringify(domains.SCL)}`);

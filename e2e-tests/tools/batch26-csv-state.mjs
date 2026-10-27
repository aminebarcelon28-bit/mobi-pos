import fs from 'node:fs';
const t = fs.readFileSync('CASE_INDEX.csv', 'utf8').replace(/^\uFEFF/, '');
const rows = [];
let cur = '';
let inQ = false;
for (let i = 0; i < t.length; i += 1) {
  const c = t[i];
  if (inQ) {
    if (c === '"') {
      if (t[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else inQ = false;
    } else cur += c;
  } else if (c === '"') inQ = true;
  else if (c === ',') cur += '\u0001';
  else if (c === '\n') {
    if (cur.endsWith('\r')) cur = cur.slice(0, -1);
    rows.push(cur.split('\u0001'));
    cur = '';
  } else cur += c;
}
const h = rows.shift();
const col = Object.fromEntries(h.map((x, i) => [x, i]));
const rcp = rows.filter((r) => r.length >= h.length && ['RCP', 'TIM'].includes(r[col.domain]));
console.log('RCP/TIM rows', rcp.length);
const by = {};
for (const r of rcp) by[r[col.verdict]] = (by[r[col.verdict]] || 0) + 1;
console.log(by);
console.log('retired', rcp.filter((r) => r[col.retired] === '1').map((r) => r[col.id]));
console.log('non-REMAIN', rcp.filter((r) => r[col.verdict] !== 'REMAIN').map((r) => `${r[col.id]}=${r[col.verdict]}`).join(' '));
const all = rows.filter((r) => r.length >= h.length);
const cnt = {};
for (const r of all) if (r[col.retired] !== '1') cnt[r[col.verdict] || 'REMAIN'] = (cnt[r[col.verdict] || 'REMAIN'] || 0) + 1;
console.log('active total', all.filter((r) => r[col.retired] !== '1').length, cnt);

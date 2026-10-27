/** List CASE_INDEX rows by verdict with domain/priority/title. */
import fs from 'node:fs';

const want = (process.argv[2] || 'REMAIN').split(',');
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
const rows = lines.slice(1).map(parse).filter((r) => r[I.retired] !== '1');
const sel = rows.filter((r) => want.includes(r[I.verdict]));
const byDomain = {};
for (const r of sel) byDomain[r[I.domain]] = (byDomain[r[I.domain]] || 0) + 1;
console.log(`selected=${sel.length} by_domain=${JSON.stringify(byDomain)}`);
for (const r of sel) {
  console.log(`${r[I.id]}\t${r[I.domain]}\t${r[I.priority]}\t${r[I.title].slice(0, 150)}`);
}

import fs from 'node:fs';

const text = fs.readFileSync(new URL('../CASE_INDEX.csv', import.meta.url), 'utf8').replace(/^\uFEFF/, '');
const rows = [];
let cur = '';
let inQ = false;
for (let i = 0; i < text.length; i += 1) {
  const c = text[i];
  if (inQ) {
    if (c === '"') {
      if (text[i + 1] === '"') { cur += '"'; i += 1; } else inQ = false;
    } else cur += c;
  } else if (c === '"') inQ = true;
  else if (c === ',') cur += '\u0001';
  else if (c === '\n') { if (cur.endsWith('\r')) cur = cur.slice(0, -1); rows.push(cur.split('\u0001')); cur = ''; }
  else cur += c;
}
if (cur) rows.push(cur.split('\u0001'));
const h = rows.shift();
const col = Object.fromEntries(h.map((x, i) => [x, i]));
console.log('COLUMNS: ' + h.join(' | '));

const want = process.argv.slice(2);
const ids = want.length ? want : rows.map((r) => r[col.id]);
for (const r of rows) {
  const id = r[col.id];
  if (!ids.includes(id)) continue;
  console.log('\n### ' + id + ' [' + (r[col.priority] || '') + '] ' + (r[col.title] || ''));
  for (const key of Object.keys(col)) {
    if (['id', 'domain', 'priority', 'title'].includes(key)) continue;
    const v = r[col[key]];
    if (v) console.log('  ' + key + ': ' + v.replace(/\s+/g, ' ').slice(0, 500));
  }
}

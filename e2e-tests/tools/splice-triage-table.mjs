/** Replace <!--TRIAGE_TABLE--> in BATCH27A-SCL.md with the generated table. */
import fs from 'node:fs';

const doc = 'BATCH27A-SCL.md';
const table = fs.readFileSync(process.env.TEMP + '/scl-triage-table.md', 'utf8').trimEnd();
const body = fs.readFileSync(doc, 'utf8');
if (!body.includes('<!--TRIAGE_TABLE-->')) throw new Error('placeholder missing');
const head = '| Case | Category | Tier | Precondition cited |\n|---|---|---|---|';
fs.writeFileSync(doc, body.replace('<!--TRIAGE_TABLE-->', `${head}\n${table}`), 'utf8');
console.log('spliced ' + table.split('\n').length + ' rows');

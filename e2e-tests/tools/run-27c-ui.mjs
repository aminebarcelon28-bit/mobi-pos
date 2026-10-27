/**
 * Run the 27c UI half once, streaming to stdout and keeping a raw UTF-8 copy
 * (PowerShell redirection would re-encode to UTF-16LE and mangle the child).
 *
 *   node e2e-tests/tools/run-27c-ui.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'e2e-tests', 'results', '27c-ui-raw.log');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const args = ['wdio', 'run', 'e2e-tests/wdio.conf.ts', '--spec', 'e2e-tests/specs/27c-i18-ui.e2e.ts'];
console.log(`[run] POS_E2E_WIPE=1 npx ${args.join(' ')}`);
const child = spawn('npx', args, {
  cwd: ROOT,
  shell: true,
  env: { ...process.env, POS_E2E_WIPE: '1' },
});
const chunks = [];
const push = (d) => {
  chunks.push(d);
  process.stdout.write(d);
};
child.stdout.on('data', push);
child.stderr.on('data', push);
child.on('close', (code) => {
  let text = Buffer.concat(chunks).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  fs.writeFileSync(OUT, text, 'utf8');
  const verdicts = text.split(/\r?\n/).filter((l) => /VERDICT=[A-Z0-9-]+ /.test(l));
  console.log(`\n[run] exit=${code} raw=${OUT} (${Buffer.byteLength(text, 'utf8')} bytes, ${verdicts.length} verdicts)`);
});

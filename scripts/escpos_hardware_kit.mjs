#!/usr/bin/env node
/**
 * HAR-002 hardware kit — one command, one ticket, a 10-minute eyeball check.
 *
 *   npm run escpos:kit                          # build the artifacts only
 *   npm run escpos:kit -- --host 192.168.1.50   # ... and print them (raw 9100)
 *   npm run escpos:kit -- --host 192.168.1.50 --port 9100 --paper 58mm
 *
 * What it produces (in tests/results/escpos/hardware-kit/):
 *   arabic-80mm.bin / .txt   the Arabic ticket (raster lane), bytes + the text a
 *                            printer would show
 *   latin-80mm.bin / .txt    the same ticket without Arabic (no raster)
 *   arabic-58mm.bin / .txt   the 58 mm build (line widths + raster width)
 *   drawer.bin               the standalone drawer pulse (opens the drawer)
 *   CHECKLIST.md             what to look at, mapped to the RCP cases
 *
 * QUALIFIER: everything here is byte/simulator-verified. It becomes
 * hardware-verified only when a human with the printer walks CHECKLIST.md and
 * signs it — that is HAR-002, and the evidence stamp says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseEscpos, receiptText } from '../e2e-tests/lib/escpos-parse.ts';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'tests', 'results', 'escpos', 'hardware-kit');
fs.mkdirSync(OUT, { recursive: true });

const { FIXTURE_SETTINGS, fixtureTransaction } = await import('../e2e-tests/tools/escpos-fixture.mjs');
const BUILD_CLI = path.join(ROOT, 'e2e-tests', 'tools', 'escpos-build.mjs');

const build = (tx, settings, extra = {}) =>
  Buffer.from(
    JSON.parse(
      execFileSync(process.execPath, [BUILD_CLI], {
        input: JSON.stringify({ tx, settings, raster: 'deterministic', ...extra }),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }),
    ),
  );

const jobs = [];
const add = (name, bytes, note) => {
  fs.writeFileSync(path.join(OUT, `${name}.bin`), bytes);
  const parsed = parseEscpos(bytes);
  fs.writeFileSync(
    path.join(OUT, `${name}.txt`),
    `${note}\nsha256=${createHash('sha256').update(bytes).digest('hex')}\nbytes=${bytes.length}\n` +
      `rasters=${parsed.rasters.length} barcodes=${JSON.stringify(parsed.barcodes)} cuts=${parsed.cuts.length} drawer=${JSON.stringify(parsed.drawerPulses)}\n` +
      `${'-'.repeat(42)}\n${receiptText(parsed)}\n`,
  );
  jobs.push({ name, bytes, note });
  console.log(`[kit] ${name}.bin  ${bytes.length} bytes  sha256=${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`);
};

const latinTx = fixtureTransaction({ customer: { id: 'CUST-ESC-2', name: 'Karim Bensalem' } });
add('arabic-80mm', build(fixtureTransaction(), FIXTURE_SETTINGS), 'Arabic customer (raster lane) — 80 mm');
add('latin-80mm', build(latinTx, FIXTURE_SETTINGS), 'Latin customer (text lane) — 80 mm');
add(
  'arabic-58mm',
  build(fixtureTransaction(), { ...FIXTURE_SETTINGS, paperWidth: '58mm' }),
  'Arabic customer (raster lane) — 58 mm',
);
add('drawer', build(fixtureTransaction(), FIXTURE_SETTINGS, { pulse: true }), 'Standalone drawer kick (ESC p)');

const CHECKLIST = `# HAR-002 — 10-minute printer check

**Build:** simulator/byte-verified. This page becomes hardware-verified only when a
human with the printer ticks every line and signs at the bottom.

Printer: ______________________  Interface: USB / network / Bluetooth
Model: ________________________  Paper: 80 mm / 58 mm
Date: ______________  Operator: ______________________

Send the artifacts (or run \`npm run escpos:kit -- --host <printer-ip>\`), then:

| # | Look at | Pass looks like | RCP |
|---|---|---|---|
| 1 | \`latin-80mm\` header | store name centred and bold, no clipping at 42 columns | RCP-02/18 |
| 2 | \`latin-80mm\` accents | "Espèces", "Rendue" print with the correct accented glyphs (no boxes, no "?") | RCP-13 |
| 3 | \`latin-80mm\` amounts | thousands separator is a plain space: "1 700 DA", never "1?700" | RCP-13 |
| 4 | \`arabic-80mm\` customer line | the Arabic name is legible, joined correctly, reads right-to-left | RCP-01/12/21 |
| 5 | \`arabic-80mm\` width | the Arabic image fits the paper, no cut-off letters | RCP-02 |
| 6 | barcode | scans to the ticket id (\`TXN-ESC-POS-0001\`), bars not smeared | RCP-11 |
| 7 | total line | bold/double-height total is complete, not clipped | RCP-13 |
| 8 | end of ticket | clean partial cut below the last line (no torn text) | RCP-06 |
| 9 | \`drawer\` | the cash drawer opens on the pulse | RCP-10 |
| 10 | \`arabic-58mm\` | lines wrap at 32 columns, nothing runs off the edge | RCP-02 |
| 11 | reprint | printing \`arabic-80mm\` twice gives two identical tickets (no copy marker) | RCP-05 |

Signature: ____________________   Result: PASS / FAIL
Notes (any failed row, with the artifact name):

`;

fs.writeFileSync(path.join(OUT, 'CHECKLIST.md'), CHECKLIST);
console.log(`[kit] CHECKLIST.md written (${OUT})`);

// Print to a real printer when a host is given.
const host = arg('host', null);
if (host) {
  const port = Number(arg('port', 9100));
  const paper = arg('paper', null);
  const wanted = paper ? jobs.filter((j) => j.name.includes(String(paper)) || j.name === 'drawer') : jobs;
  for (const job of wanted) {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: String(host), port }, () => socket.end(job.bytes));
      socket.on('error', reject);
      socket.on('close', resolve);
      socket.setTimeout(8000, () => {
        socket.destroy();
        resolve();
      });
    });
    console.log(`[kit] sent ${job.name} -> ${host}:${port} (${job.bytes.length} bytes)`);
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log('[kit] now walk CHECKLIST.md — the artifacts are byte-verified, the paper is not.');
} else {
  console.log('[kit] no --host given: artifacts written only. Re-run with --host <printer-ip> to print.');
}

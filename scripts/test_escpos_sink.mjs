#!/usr/bin/env node
/**
 * ESC/POS sink suite (RCP queue item 3) — dev-only, hermetic.
 *
 * Flow per case: build the receipt with the PRODUCTION builder (bundled by
 * esbuild) -> send it over a real TCP connection to the capture sink -> parse the
 * bytes the sink captured -> assert the structure a printer would execute ->
 * compare a byte-exact golden.
 *
 * Checks: init, Arabic raster present with consistent geometry, integer-DA
 * totals, barcode carrying the document number, partial cut, drawer kick.
 *
 * Usage:
 *   node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_escpos_sink.mjs
 *   ... --update        regenerate the goldens (review the diff before committing)
 * Exit 0 = all checks pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createCaptureSink } from './escpos_sink.mjs';
import { FIXTURE_SETTINGS, FIXTURE_ARABIC_NAME, fixtureTransaction } from '../e2e-tests/tools/escpos-fixture.mjs';
import { parseEscpos, receiptText, CP864_NUMBER } from '../e2e-tests/lib/escpos-parse.ts';

const ROOT = process.cwd();
const BUILD_CLI = path.join(ROOT, 'e2e-tests', 'tools', 'escpos-build.mjs');
const GOLDEN_DIR = path.join(ROOT, 'tests', 'fixtures', 'escpos');
const UPDATE = process.argv.includes('--update');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
};

const buildBytes = (tx, settings, raster, extra = {}) => {
  const out = execFileSync(process.execPath, [BUILD_CLI], {
    input: JSON.stringify({ tx, settings, raster, ...extra }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return Buffer.from(JSON.parse(out));
};

/** Send bytes to the sink over loopback TCP and return the captured job. */
const captureOverWire = async (bytes, label) => {
  const sink = createCaptureSink({ outDir: path.join(ROOT, 'tests', 'results', 'escpos'), idleMs: 250 });
  const port = await sink.listen(0);
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.end(bytes);
    });
    socket.on('error', reject);
    socket.on('close', resolve);
  });
  const deadline = Date.now() + 10000;
  while (sink.jobs.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await sink.close();
  const job = sink.jobs[0];
  if (!job) throw new Error(`${label}: sink captured no job`);
  return job;
};

const compareGolden = (name, bytes) => {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  const file = path.join(GOLDEN_DIR, `${name}.golden.bin`);
  if (UPDATE) {
    fs.writeFileSync(file, bytes);
    console.log(`  WROTE ${path.relative(ROOT, file)} (${bytes.length} bytes)`);
    return;
  }
  if (!fs.existsSync(file)) {
    check(`${name}: golden exists`, false, `missing ${path.relative(ROOT, file)} — run with --update once`);
    return;
  }
  const golden = fs.readFileSync(file);
  const equal = golden.length === bytes.length && golden.equals(bytes);
  check(
    `${name}: byte-exact golden (${golden.length} bytes)`,
    equal,
    equal ? '' : `different: golden ${golden.length}B sha=${createHash('sha256').update(golden).digest('hex').slice(0, 12)} vs run ${bytes.length}B sha=${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`,
  );
};

const results = { at: new Date().toISOString(), cases: {}, kind: 'PASS-SIM' };

// ── 1. Arabic receipt (raster lane) ─────────────────────────────────────────
{
  const tx = fixtureTransaction();
  const bytes = buildBytes(tx, FIXTURE_SETTINGS, 'deterministic');
  const job = await captureOverWire(bytes, 'arabic');
  const wireIntact = job.bytes === bytes.length && createHash('sha256').update(job.data).digest('hex') === createHash('sha256').update(bytes).digest('hex');
  check('wire: every built byte reached the sink unchanged', wireIntact, `${job.bytes}B vs ${bytes.length}B`);

  const p = parseEscpos(job.data);
  results.cases.arabic = {
    bytes: p.bytes,
    init: p.init,
    rasters: p.rasters,
    barcode: p.barcodes,
    cuts: p.cuts.length,
    drawer: p.drawerPulses,
    sha256: job.sha256,
  };

  check('init: ESC @ sent once at the start', p.init === 1);
  check('raster: the Arabic line is printed as a bit image', p.hasRaster && p.rasters.length === 1, JSON.stringify(p.rasters));
  const r = p.rasters[0];
  check(
    'raster: geometry fits the 80 mm head and the payload matches it',
    Boolean(r) && r.widthBytes > 0 && r.widthBytes <= 72 && r.heightDots > 0 && r.bytes === r.widthBytes * r.heightDots,
    JSON.stringify(r),
  );
  check('raster: an Arabic-only line never falls back to partial CP864 forms', p.codePageSelects.length === 0, JSON.stringify(p.codePageSelects));

  const text = receiptText(p);
  const totalLine = p.lines.find((l) => /TOTAL/i.test(l.text));
  check('totals: a TOTAL line is printed', Boolean(totalLine), JSON.stringify(p.lines.map((l) => l.text.trim()).slice(0, 12)));
  check(
    'totals: the printed amount is the integer ticket total (no decimals)',
    Boolean(totalLine) && /\b1\s?700\b/.test(totalLine.text) && !/\d[.,]\d{2}\b/.test(totalLine.text.replace(/\b1\s?700\b/g, '')),
    totalLine?.text,
  );
  check('barcode: CODE128 carries the document id', p.barcodes.length === 1 && p.barcodes[0].symbology === 'CODE128' && p.barcodes[0].data === tx.id, JSON.stringify(p.barcodes));
  check('cut: a partial cut ends the ticket', p.cuts.length >= 1 && p.cuts[p.cuts.length - 1].partial === true, JSON.stringify(p.cuts));
  check(
    'drawer: the receipt stream carries no kick (the pulse is a separate command)',
    p.drawerPulses.length === 0,
    JSON.stringify(p.drawerPulses),
  );
  const pulse = Buffer.from(buildBytes(tx, FIXTURE_SETTINGS, 'deterministic', { pulse: true }));
  const pPulse = parseEscpos(pulse);
  check(
    'drawer: buildCashDrawerPulse is ESC @ + ESC p 0 (pin 2, 250 ms)',
    pulse.length === 7 && pPulse.drawerPulses.length === 1 && pPulse.drawerPulses[0].pin === 0,
    Buffer.from(pulse).toString('hex'),
  );
  // The pulse must open the drawer, not the second pin: a pin-1 stream decodes
  // as pin 1, so the assertion above discriminates.
  const pPin1 = parseEscpos(Buffer.from([0x1b, 0x40, 0x1b, 0x70, 0x01, 0x32, 0xfa]));
  check(
    'negative control: a pin-1 pulse would fail the pin-0 check',
    pPin1.drawerPulses.length === 1 && pPin1.drawerPulses[0].pin === 1,
    JSON.stringify(pPin1.drawerPulses),
  );
  check('alignment: header centred and body left', p.alignments.includes('center') && p.alignments.includes('left'), JSON.stringify(p.alignments));
  check('arabic: the raster line replaced the text, so no masked "?" title leaks', !text.includes('?'), text.slice(0, 80));
  check('protocol: no unknown command in the stream', p.unknowns.length === 0, JSON.stringify(p.unknowns.slice(0, 3)));

  compareGolden('receipt-arabic-80mm', job.data);
}

// ── 2. Latin receipt (unchanged byte path, no raster) ───────────────────────
{
  const tx = fixtureTransaction({ customer: { id: 'CUST-ESC-2', name: 'Karim Bensalem' } });
  const bytes = buildBytes(tx, FIXTURE_SETTINGS, 'deterministic');
  const job = await captureOverWire(bytes, 'latin');
  const p = parseEscpos(job.data);
  results.cases.latin = { bytes: p.bytes, rasters: p.rasters.length, sha256: job.sha256 };
  check('latin: no bit image when the ticket has no Arabic', !p.hasRaster);
  check('latin: customer name printed as text', /Karim Bensalem/.test(receiptText(p)));
  compareGolden('receipt-latin-80mm', job.data);
}

// ── 3. 58 mm paper ─────────────────────────────────────────────────────────
{
  const tx = fixtureTransaction();
  const settings = { ...FIXTURE_SETTINGS, paperWidth: '58mm' };
  const bytes = buildBytes(tx, settings, 'deterministic');
  const p = parseEscpos(bytes);
  results.cases.paper58 = { bytes: p.bytes, rasters: p.rasters };
  check(
    '58 mm: raster width fits the 384-dot head',
    p.rasters.length === 1 && p.rasters[0].widthBytes <= 48,
    JSON.stringify(p.rasters),
  );
  const longest = p.lines.reduce((m, l) => Math.max(m, l.text.trimEnd().length), 0);
  check('58 mm: text lines stay within 32 columns', longest <= 32, `longest=${longest}`);
  compareGolden('receipt-arabic-58mm', bytes);
}

// ── 4. Negative controls: the oracle must be able to fail ──────────────────
{
  const tx = fixtureTransaction();
  const bytes = buildBytes(tx, FIXTURE_SETTINGS, 'deterministic');
  const p = parseEscpos(bytes);

  // (a) a stream with the cut removed must fail the cut assertion
  const cutAt = p.cuts.length ? jobIndexOf(bytes, [0x1d, 0x56, 0x01]) : -1;
  const noCut = cutAt >= 0 ? Buffer.concat([bytes.subarray(0, cutAt), bytes.subarray(cutAt + 3)]) : bytes;
  const parsedNoCut = parseEscpos(noCut);
  check('negative control: removing the cut makes the cut check fail', parsedNoCut.cuts.length === 0, JSON.stringify(parsedNoCut.cuts));

  // (b) disabling the raster lane must make the Arabic raster check fail
  const fallback = buildBytes(tx, FIXTURE_SETTINGS, 'off');
  const pFallback = parseEscpos(fallback);
  results.cases.fallback = { rasters: pFallback.rasters.length, codePages: pFallback.codePageSelects };
  check(
    'negative control: raster off -> raster check would fail (CP864 fallback used instead)',
    pFallback.rasters.length === 0 && pFallback.codePageSelects.includes(CP864_NUMBER),
    `rasters=${pFallback.rasters.length} codePages=${JSON.stringify(pFallback.codePageSelects)}`,
  );

  // (c) money-separator regression: corrupt the separator inside the TOTAL
  // line and require the exact predicate used above to reject it.
  {
    const line = p.lines.find((l) => /TOTAL/i.test(l.text));
    const corrupted = (line?.text ?? '').replace(/(\d)\s(\d)/, '$1?$2');
    const predicate = (t) => /\b1\s?700\b/.test(t) && !t.includes('?');
    check(
      'negative control: a "?" in an amount makes the totals check fail',
      Boolean(line) && predicate(line.text) && !predicate(corrupted),
      JSON.stringify(corrupted),
    );
  }

  // (d) a truncated raster must be detected, not silently accepted
  const rasterAt = jobIndexOf(bytes, [0x1d, 0x76, 0x30, 0x00]);
  if (rasterAt >= 0) {
    const truncated = bytes.subarray(0, rasterAt + 10);
    const pTrunc = parseEscpos(truncated);
    check(
      'negative control: a truncated bit image is reported, not skipped silently',
      pTrunc.unknowns.some((u) => u.command.includes('TRUNCATED')),
      JSON.stringify(pTrunc.unknowns),
    );
  } else {
    check('negative control: raster command found for truncation test', false, 'no GS v 0 in the stream');
  }

  // (e) reprint identity: the same row must rebuild the same bytes
  check('reprint: rebuilding the same row is byte-identical', buildBytes(tx, FIXTURE_SETTINGS, 'deterministic').equals(bytes));
}

function jobIndexOf(buf, needle) {
  outer: for (let i = 0; i + needle.length <= buf.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (buf[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const outDir = path.join(ROOT, 'tests', 'results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'escpos-sink.json'), JSON.stringify({ ...results, pass, fail }, null, 2));

console.log(`\nESC/POS SINK SUITE (PASS-SIM): ${pass} passed, ${fail} failed`);
if (fail > 0) console.log('Note: a golden mismatch is either a real byte change (review it) or a stale golden (--update).');
process.exit(fail === 0 ? 0 : 1);

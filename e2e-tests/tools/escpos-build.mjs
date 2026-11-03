// CLI wrapper around the production ESC/POS builder, for the batch-26 spec and
// the sink suite.
// stdin : { tx, settings, raster?: 'deterministic' | 'off', pulse?: true }
// stdout: number[]
// `raster: 'deterministic'` injects the byte-stable test renderer (see
// escpos-raster-stub.mjs); 'off' disables the raster lane so the CP864 fallback
// is what gets exercised. Omitted = the production default (canvas in a
// browser; none in Node, hence the CP864 fallback).
// `pulse: true` returns the standalone drawer-kick buffer instead of a receipt.
import fs from 'node:fs';
import { buildReceiptBytes, loadEscposModule } from './escpos-bytes.mjs';
import { deterministicLineRasterizer } from './escpos-raster-stub.mjs';

const raw = fs.readFileSync(0, 'utf8');
const { tx, settings, raster, pulse } = JSON.parse(raw);

if (pulse) {
  const mod = await loadEscposModule();
  process.stdout.write(JSON.stringify(Array.from(mod.buildCashDrawerPulse())));
} else {
  const options = {};
  if (raster === 'deterministic') options.rasterizer = deterministicLineRasterizer;
  if (raster === 'off') options.rasterizer = null;
  const bytes =
    Object.keys(options).length > 0
      ? await buildReceiptBytes(tx, settings ?? {}, options)
      : await buildReceiptBytes(tx, settings ?? {});
  process.stdout.write(JSON.stringify(bytes));
}

// CLI wrapper around the production ESC/POS builder, for the batch-26 spec.
// stdin : { tx, settings, tz? }   stdout: number[]
// Spawned with execFileSync so the spec never has to import ESM directly.
import fs from 'node:fs';
import { buildReceiptBytes } from './escpos-bytes.mjs';

const raw = fs.readFileSync(0, 'utf8');
const { tx, settings } = JSON.parse(raw);
const bytes = await buildReceiptBytes(tx, settings ?? {});
process.stdout.write(JSON.stringify(bytes));

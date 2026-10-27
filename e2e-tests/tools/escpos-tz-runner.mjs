// Child-process runner: builds a receipt's ESC/POS bytes under a given TZ.
// Reads { tx, settings } on stdin, writes the byte array as JSON on stdout.
// Spawned by buildReceiptBytesInTZ (tools/escpos-bytes.mjs).
import fs from 'node:fs';
import { buildReceiptBytes } from './escpos-bytes.mjs';

const { tx, settings } = JSON.parse(fs.readFileSync(0, 'utf8'));
const bytes = await buildReceiptBytes(tx, settings);
process.stdout.write(JSON.stringify(bytes));

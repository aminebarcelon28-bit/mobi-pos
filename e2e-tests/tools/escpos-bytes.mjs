/**
 * Host-side ESC/POS byte builder for batch 26.
 *
 * WHY THIS EXISTS (harness constraint, proven in logs/batch26-probe-seam.log):
 * the sandbox has no printer, and the WebView's IPC channel cannot be
 * intercepted — `window.__TAURI_INTERNALS__` and every member of it
 * (`invoke`, `ipc`, `postMessage`, `transformCallback`, ...) are own
 * properties with `writable:false, configurable:false`. Assigning to
 * `invoke` silently no-ops, so a wrapper can never observe the payload.
 *
 * The bytes therefore come from the SAME production module the app calls —
 * `src/utils/escpos.ts` `buildReceiptBuffer(transaction, settings)` — fed the
 * app's OWN persisted row (`transactions.json_payload`, written by the real
 * checkout) and the app's own receipt settings. The app-side proof that the
 * print path ran is the `[ESC/POS Spooler Error]` line the spooler emits once
 * per attempt (escpos.ts:394-406), counted from the console tap.
 *
 * The bundle is compiled with esbuild (the same compiler Vite uses for the
 * app), so the emitted bytes are the production bytes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(
  process.env.TEMP || os.tmpdir(),
  'opencode',
  'rcp26',
  'escpos.bundle.cjs',
);

let loaded = null;

async function loadModule() {
  if (loaded) return loaded;
  const esbuild = await import('esbuild');
  const src = path.join(ROOT, 'src', 'utils', 'escpos.ts');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // Rebuild only when the source is newer than the cached bundle: the batch
  // spawns this helper once per sale.
  let stale = true;
  try {
    stale = fs.statSync(OUT).mtimeMs < fs.statSync(src).mtimeMs;
  } catch {
    stale = true;
  }
  if (stale) {
    await esbuild.build({
      entryPoints: [src],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: OUT,
      // Bundle @tauri-apps/* too: the output lives under %TEMP%, which cannot
      // resolve the repo's node_modules. The IPC module is only *called* at
      // print time, never at import time, so bundling is inert here.
      logLevel: 'silent',
      define: { 'import.meta.env': '{}' },
    });
  }
  const require = createRequire(import.meta.url);
  loaded = require(OUT);
  return loaded;
}

/**
 * @param {Record<string, unknown>} transaction the persisted SaleTransaction
 * @param {Record<string, unknown>} settings   the app's receipt settings
 * @returns {Promise<number[]>} the exact byte array handed to the spooler
 */
export async function loadEscposModule() {
  return await loadModule();
}

export async function buildReceiptBytes(transaction, settings, builderOptions = null) {
  const mod = await loadModule();
  const bytes = builderOptions
    ? mod.buildReceiptBuffer(transaction, settings ?? {}, undefined, undefined, builderOptions)
    : mod.buildReceiptBuffer(transaction, settings ?? {});
  return Array.from(bytes);
}

/** Escape-hatch for diagnostics: any exported builder by name. */
export async function callBuilder(name, ...args) {
  const mod = await loadModule();
  if (typeof mod[name] !== 'function') throw new Error(`no export ${name}`);
  const out = mod[name](...args);
  return out instanceof Uint8Array ? Array.from(out) : out;
}

/**
 * Same builder, executed in a child process with `TZ` set, so the receipt's
 * device-local date/time fields can be observed for another device timezone
 * (the app uses local getters only — receiptViewModel.ts:78-84).
 */
export async function buildReceiptBytesInTZ(transaction, settings, tz) {
  const { execFileSync } = await import('node:child_process');
  const runner = path.join(import.meta.dirname, 'escpos-tz-runner.mjs');
  const out = execFileSync(process.execPath, [runner], {
    input: JSON.stringify({ tx: transaction, settings: settings ?? {}, tz }),
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

#!/usr/bin/env node
/**
 * Release-hygiene gate for the SQL capture hook (SEC-01 item 7).
 *
 *   node scripts/check-capture-release.mjs [--build]
 *
 * Two independent checks:
 *
 *  1. SOURCE: the capture function must be `#[cfg(debug_assertions)]` with a
 *     `#[cfg(not(debug_assertions))]` no-op, and the capture marker strings must
 *     not appear anywhere else in the patched plugin.
 *
 *  2. ARTIFACT: build the patched plugin in RELEASE and prove the produced rlib
 *     does not contain the capture log marker. This is the check that matters:
 *     a source-level grep cannot see a `cfg` mistake that still ships.
 *
 *     `--build` runs `cargo build -p tauri-plugin-sql --release` first; without
 *     it the newest release rlib is used and the gate fails if none exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const WRAPPER = path.join(ROOT, 'patches/tauri-plugin-sql/src/wrapper.rs');
const MARKER = 'mobi-sql-capture.log';
const ENV_MARKER = 'POS_SQL_CAPTURE';

const problems = [];
const wrapper = fs.readFileSync(WRAPPER, 'utf8');

// ── 1. source ───────────────────────────────────────────────────────────────
// The capture hook was deleted after the migration list was captured, so the
// only correct state is "no capture path anywhere in the plugin or native core".
const CAPTURE_MARKERS = [MARKER, ENV_MARKER, 'record_captured_sql'];
const sourceRoots = [path.join(ROOT, 'patches', 'tauri-plugin-sql', 'src'), path.join(ROOT, 'src-tauri', 'src')];
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/target|node_modules/.test(full)) walk(full, out);
    } else if (entry.name.endsWith('.rs')) {
      out.push(full);
    }
  }
  return out;
};
for (const file of sourceRoots.flatMap((d) => (fs.existsSync(d) ? walk(d) : []))) {
  const text = fs.readFileSync(file, 'utf8');
  for (const marker of CAPTURE_MARKERS) {
    if (text.includes(marker)) {
      problems.push(`capture marker ${marker} present in ${path.relative(ROOT, file)}`);
    }
  }
}

// ── 2. artifact ─────────────────────────────────────────────────────────────
// Cargo may place the workspace target at the repo root or under src-tauri.
const targetCandidates = [path.join(ROOT, 'target'), path.join(ROOT, 'src-tauri', 'target')];
const targetDir =
  targetCandidates.find((d) => fs.existsSync(path.join(d, 'release', 'deps'))) || targetCandidates[0];
const releaseDeps = path.join(targetDir, 'release', 'deps');

if (process.argv.includes('--build')) {
  console.log('[capture-release] building tauri-plugin-sql in release…');
  const build = spawnSync('cargo', ['build', '-p', 'tauri-plugin-sql', '--release'], {
    cwd: path.join(ROOT, 'src-tauri'),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) {
    console.error('[capture-release] FAIL: release build of the plugin failed');
    process.exit(1);
  }
}

let rlibs = [];
if (fs.existsSync(releaseDeps)) {
  rlibs = fs
    .readdirSync(releaseDeps)
    .filter((f) => f.startsWith('libtauri_plugin_sql') && f.endsWith('.rlib'))
    .map((f) => path.join(releaseDeps, f));
}

if (rlibs.length === 0) {
  problems.push(
    'no release rlib for tauri-plugin-sql (run with --build); cannot prove the capture path is absent',
  );
} else {
  for (const rlib of rlibs) {
    const bytes = fs.readFileSync(rlib);
    if (bytes.includes(Buffer.from(MARKER, 'utf8'))) {
      problems.push(`capture marker leaked into release artifact: ${path.basename(rlib)}`);
    }
    if (bytes.includes(Buffer.from(ENV_MARKER, 'utf8'))) {
      problems.push(`capture env marker leaked into release artifact: ${path.basename(rlib)}`);
    }
  }
}

if (problems.length) {
  console.error('[capture-release] FAIL');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(
  `[capture-release] OK (capture path absent from source, ${rlibs.length} release rlib(s) free of capture markers)`,
);

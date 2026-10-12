// Builds the isolated E2E flavor of MobiPOS (Phase 1 harness).
//
// What it does:
//   tauri build --debug --no-bundle --features e2e
//     --config src-tauri/tauri.e2e.conf.json
// with CARGO_TARGET_DIR=<root>/target-e2e so the plain dev binaries in
// target/debug are never overwritten.
//
// Isolation (owner direction 2026-10-10, Phase 1: isolated `.e2e` container):
//   - identifier: `com.mobi.pos.e2e` (overlay) — the e2e flavor opens its OWN
//     data dir, never the real till's. The DB filename stays `mobi_pos.db`
//     (the workspace-patched sql plugin confines `load` to exactly that
//     name), so isolation lives in the data DIR, never the filename.
//   - feature e2e: e2e_* IPC + embedded WebDriver server + CLOUD SEAL
//     (get_cloud_credentials -> None, set/delete -> denied). Test data is
//     isolated; the merchant cloud is never touched (no pulls, no pushes).
//   - withGlobalTauri (overlay): specs invoke e2e_* via
//     window.__TAURI__.core.invoke.
//
// Usage:
//   node scripts/build-e2e.mjs            (debug e2e flavor)
//   POS_E2E_PROFILE=release node scripts/build-e2e.mjs   (release+e2e, CI perf)
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const profile = process.env.POS_E2E_PROFILE === 'release' ? 'release' : 'debug';
const targetDir = path.join(root, 'target-e2e');
const PROD_IDENTIFIER = 'com.mobi.pos';

// Preflight (fail-closed): the live filename must be `mobi_pos.db` on all
// three sides — Rust migration URL (lib.rs DB_URL), TS loader
// (sqlPluginAdapter DB_PATH), and the plugin's 4.4 confinement
// (validate_db_name, pinned by load_confined_to_exact_db_name). Isolation
// lives in the data DIR (e2e identifier), never the filename: a different
// filename is rejected at `load` and the app boots degraded (Phase 1
// finding). The overlay MUST carry the isolated test identifier
// `com.mobi.pos.e2e` so test runs never open the real till's data dir.
const libRs = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
const adapter = fs.readFileSync(path.join(root, 'src', 'db', 'sqlPluginAdapter.ts'), 'utf8');
const overlay = fs.readFileSync(path.join(root, 'src-tauri', 'tauri.e2e.conf.json'), 'utf8');
const pluginGuard = fs.readFileSync(
  path.join(root, 'patches', 'tauri-plugin-sql', 'src', 'wrapper.rs'), 'utf8');
for (const [label, src, needle] of [
  ['lib.rs DB_URL', libRs, 'const DB_URL: &str = "sqlite:mobi_pos.db"'],
  ['sqlPluginAdapter DB_PATH', adapter, "const DB_PATH = 'sqlite:mobi_pos.db'"],
  ['plugin 4.4 confinement', pluginGuard, 'if raw != "mobi_pos.db"'],
]) {
  if (!src.includes(needle)) {
    console.error(`[build:e2e] PREFLIGHT FAIL: ${label} missing ${needle}`);
    process.exit(1);
  }
}
// The overlay must carry the isolated test identifier.
if (!overlay.includes('com.mobi.pos.e2e')) {
  console.error('[build:e2e] PREFLIGHT FAIL: overlay missing isolated identifier com.mobi.pos.e2e');
  process.exit(1);
}
console.log('[build:e2e] preflight OK (mobi_pos.db everywhere, isolated .e2e identifier)');

// Step 1: frontend FIRST, as a direct child (the overlay below disables
// tauri's beforeBuildCommand, so this step owns the bundle). VITE_E2E=1
// stamps the e2e flavor: e2e-only TS seams (`window.__posStress`, …) exist
// ONLY in this bundle. Plain `npm run build` (production) omits it, so the
// seams are tree-shaken away — never ship test surface to customers.
console.log('[build:e2e] step 1/2: frontend (npm run build, VITE_E2E=1)');
let r = spawnSync('npm', ['run', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, VITE_E2E: '1' },
});
if (r.status !== 0) {
  console.error('[build:e2e] frontend FAILED');
  process.exit(r.status ?? 1);
}

// Step 2: Rust + bundling of the already-built frontend.
console.log('[build:e2e] step 2/2: tauri build (beforeBuild disabled by overlay)');

const args = [
  'tauri',
  'build',
  '--no-bundle',
  '--features',
  'e2e',
  '--config',
  'src-tauri/tauri.e2e.conf.json',
];
if (profile === 'debug') args.push('--debug');

console.log(`[build:e2e] profile=${profile} targetDir=${targetDir}`);
// Provenance: stamp the git SHA into the binary so e2e_build_info can prove
// the suite ran against current sources (Gate 1.6). Best-effort: unknown on
// failure, never fatal here — wdio.conf records HEAD in the manifest too.
let gitSha = 'unknown';
try {
  const g = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', shell: true });
  const s = (g.stdout ?? '').trim();
  if (/^[0-9a-f]{40}$/.test(s)) gitSha = s;
} catch {
  // keep 'unknown'
}
console.log(`[build:e2e] gitSha=${gitSha}`);
r = spawnSync('npx', args, {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
    E2E_GIT_SHA: gitSha,
  },
});
if (r.status !== 0) {
  console.error('[build:e2e] FAILED');
  process.exit(r.status ?? 1);
}
console.log('[build:e2e] OK');

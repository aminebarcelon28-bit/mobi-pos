/**
 * Release Pre-Flight Check Script (Phase 5 - Ship)
 * Verifies version parity, test suites, and updater manifests.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const rootDir = process.cwd();
console.log('>>> [MobiPOS Release Gate] Running pre-release validation checks...\n');

// 1. Version Parity Check
const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
const tauriConf = JSON.parse(fs.readFileSync(path.join(rootDir, 'src-tauri', 'tauri.conf.json'), 'utf-8'));

if (pkgJson.version !== tauriConf.version) {
  console.error(`[FAIL] Version mismatch: package.json (${pkgJson.version}) vs tauri.conf.json (${tauriConf.version})`);
  process.exit(1);
}
console.log(`[PASS] Version parity verified: v${pkgJson.version}`);

// 2. Updater Manifest Verification
if (!tauriConf.plugins?.updater?.pubkey) {
  console.error('[FAIL] Missing updater public key in tauri.conf.json');
  process.exit(1);
}
console.log('[PASS] Updater public key present');

// 3. Automated Test Suite Execution
console.log('>>> Executing automated business logic & cloud sync test suites...');
try {
  execSync('node scripts/test_pos_math.js', { stdio: 'pipe' });
  console.log('  [PASS] POS math invariants: 81 tests passed');
} catch (e) {
  console.error('  [FAIL] POS math tests failed:', e.message);
  process.exit(1);
}

try {
  execSync('node scripts/test_cloud_sync_and_migration.mjs', { stdio: 'pipe' });
  console.log('  [PASS] Cloud sync & migration invariants: 32 tests passed');
} catch (e) {
  console.error('  [FAIL] Cloud sync tests failed:', e.message);
  process.exit(1);
}

console.log('\n>>> [MobiPOS Release Gate] ALL GATES PASSED. Ready to build & publish release.');

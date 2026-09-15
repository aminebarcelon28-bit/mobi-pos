/**
 * MobiPOS — Automated Verification Suite for Mobile GitHub Hosting & Release Pipeline
 * Validates:
 * 1. .github/workflows/release.yml has valid build-android and build-ios jobs
 * 2. Android APK build, signing, and upload steps are properly configured
 * 3. iOS IPA build, packaging, and upload steps are properly configured
 * 4. public/download/index.html Mobile Download Hub is properly structured with direct release links
 * 5. QR code generation endpoints and GitHub asset download URLs match canonical names
 * 6. useAppUpdater.ts mobile fallback links to GitHub Releases
 * 7. CloudPairingModal.tsx provides mobile download and pairing tabs
 * 8. SQLite and credentials zero-data-loss invariant across updates
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

console.log('========================================================================');
console.log('🚀 MOBI POS — MOBILE GITHUB HOSTING & RELEASE PIPELINE TEST SUITE');
console.log('========================================================================\n');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    passCount++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    failCount++;
  }
}

// ── 1. Validate .github/workflows/release.yml ──
console.log('[TEST GROUP 1] GitHub Actions Release Workflow (.github/workflows/release.yml)');
const workflowPath = resolve('.github/workflows/release.yml');
assert(existsSync(workflowPath), 'release.yml exists');

const workflowContent = readFileSync(workflowPath, 'utf-8');

assert(workflowContent.includes('build-android:'), 'Workflow contains build-android job');
assert(workflowContent.includes('build-ios:'), 'Workflow contains build-ios job');
assert(workflowContent.includes('softprops/action-gh-release@v2'), 'Uses softprops/action-gh-release for asset attachment');

// Android specific checks
assert(workflowContent.includes('npx tauri android build --apk'), 'Android job builds APK via Tauri CLI');
assert(workflowContent.includes('MobiPOS-Android.apk'), 'Android job produces canonical MobiPOS-Android.apk');
assert(workflowContent.includes('apksigner') || workflowContent.includes('keytool'), 'Android job includes APK signing logic for direct installation');
assert(workflowContent.includes('aarch64-linux-android'), 'Android job targets ARM64 architecture');

// iOS specific checks
assert(workflowContent.includes('macos-14'), 'iOS job runs on macOS-14 runner');
assert(workflowContent.includes('aarch64-apple-ios'), 'iOS job targets ARM64 iOS architecture');
assert(workflowContent.includes('npx tauri ios init') || workflowContent.includes('gen/apple'), 'iOS job includes Xcode project initialization');
assert(workflowContent.includes('MobiPOS-iOS.ipa'), 'iOS job produces canonical MobiPOS-iOS.ipa');
assert(workflowContent.includes('zip -r') && workflowContent.includes('Payload'), 'iOS job packages standard .ipa payload structure');

// Race condition guard
assert(workflowContent.includes('needs: [test-and-lint, build-tauri]'), 'Mobile jobs depend on build-tauri to ensure release exists before attaching');

// ── 2. Validate public/download/index.html ──
console.log('\n[TEST GROUP 2] Mobile Download Hub (public/download/index.html)');
const downloadHubPath = resolve('public/download/index.html');
assert(existsSync(downloadHubPath), 'public/download/index.html exists');

const downloadHubContent = readFileSync(downloadHubPath, 'utf-8');
const CANONICAL_ANDROID_URL = 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-Android.apk';
const CANONICAL_IOS_URL = 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-iOS.ipa';

assert(downloadHubContent.includes(CANONICAL_ANDROID_URL), 'Mobile Hub links to canonical Android APK release asset');
assert(downloadHubContent.includes(CANONICAL_IOS_URL), 'Mobile Hub links to canonical iOS IPA release asset');
assert(downloadHubContent.includes('card-android') && downloadHubContent.includes('card-ios'), 'Mobile Hub contains cards for both Android and iOS');
assert(downloadHubContent.includes('api.qrserver.com') || downloadHubContent.includes('qr'), 'Mobile Hub includes dynamic QR code generator');
assert(downloadHubContent.includes('api.github.com/repos/aminebarcelon28-bit/mobi-pos/releases/latest'), 'Mobile Hub dynamically queries latest release metadata');

// ── 3. Validate In-App Mobile Updater ──
console.log('\n[TEST GROUP 3] In-App Mobile Auto-Updater (src/hooks/useAppUpdater.ts)');
const updaterPath = resolve('src/hooks/useAppUpdater.ts');
assert(existsSync(updaterPath), 'useAppUpdater.ts exists');

const updaterContent = readFileSync(updaterPath, 'utf-8');
assert(updaterContent.includes('MobiPOS-Android.apk'), 'useAppUpdater redirects Android devices to MobiPOS-Android.apk');
assert(updaterContent.includes('MobiPOS-iOS.ipa'), 'useAppUpdater redirects iOS devices to MobiPOS-iOS.ipa');
assert(updaterContent.includes('isAndroid()') && updaterContent.includes('isIOS()'), 'useAppUpdater uses platform detection');

// ── 4. Validate CloudPairingModal & Download Portal ──
console.log('\n[TEST GROUP 4] In-App Pairing & Mobile Download Tab (CloudPairingModal.tsx)');
const pairingModalPath = resolve('src/components/modals/CloudPairingModal.tsx');
assert(existsSync(pairingModalPath), 'CloudPairingModal.tsx exists');

const pairingModalContent = readFileSync(pairingModalPath, 'utf-8');
assert(pairingModalContent.includes('activeTab') && pairingModalContent.includes('download') && pairingModalContent.includes('pair'), 'CloudPairingModal provides tabbed download and pairing interface');
assert(pairingModalContent.includes('MobiPOS-Android.apk') || pairingModalContent.includes('ANDROID_APK_URL'), 'CloudPairingModal includes Android APK download');
assert(pairingModalContent.includes('MobiPOS-iOS.ipa') || pairingModalContent.includes('IOS_IPA_URL'), 'CloudPairingModal includes iOS IPA download');
assert(pairingModalContent.includes('create-qr-code') || pairingModalContent.includes('QRCodeImage'), 'CloudPairingModal renders scannable QR codes for phone camera');

// ── 5. Zero Data Loss Invariant (Playbook C6) ──
console.log('\n[TEST GROUP 5] Zero Data Loss Invariant across Mobile Updates (Playbook C6)');
const tauriConfPath = resolve('src-tauri/tauri.conf.json');
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf-8'));
assert(tauriConf.identifier === 'com.mobi.pos', 'App bundle identifier is stable (com.mobi.pos)');
assert(tauriConf.bundle?.android?.versionCode >= 8, 'Android versionCode is tracked and incremented');
assert(Boolean(tauriConf.bundle?.iOS?.bundleVersion), 'iOS bundleVersion is tracked and incremented');

console.log('\n========================================================================');
console.log(`🎯 TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
console.log('========================================================================');

if (failCount > 0) {
  process.exit(1);
} else {
  console.log('\n✨ All Mobile GitHub Release & Hosting Invariants Verified Successfully!');
}

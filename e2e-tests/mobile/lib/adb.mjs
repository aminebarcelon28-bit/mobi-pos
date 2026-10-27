/**
 * Mobile (Android emulator) harness for batch 25.
 *
 * The desktop WDIO harness cannot drive the Android build, so this module
 * uses adb + the emulator + Windows OCR. Every test is a Mocha `it()` and
 * logs one `[MOB-xx] VERDICT=...` line with the observed values.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

export const ROOT = path.resolve(process.cwd(), '..');
export const E2E = process.cwd();
export const MOBILE = path.join(E2E, 'mobile');
export const SHOTS = path.join(E2E, 'logs', 'mob-shots');
export const BASELINE = path.join(MOBILE, 'fixtures', 'mobile-baseline.db');
// Full app-data snapshot (DB + WebView profile + native files). A DB-only
// restore cannot reproduce the provisioned state: the manager PIN is read
// Dexie-first, and a wiped WebView profile forces the first-boot setup gate.
export const STATE_TAR = path.join(MOBILE, 'fixtures', 'mobile-state.tar.gz');
export const APK = path.join(MOBILE, 'fixtures', 'mobile-release-signed.apk');
export const OCR_PS1 = path.join(MOBILE, 'ocr-boxes.ps1');
export const ADB = process.env.ADB || 'adb';
export const PACKAGE = 'com.mobi.pos';
export const ACTIVITY = `${PACKAGE}/.MainActivity`;

/**
 * Mobile fixtures are NOT in the repo (see .gitignore): the baseline DB was
 * pulled from a real shop terminal and the APK is a build artifact. Fail
 * closed with an actionable message and a distinct exit code instead of a
 * stack trace when they are absent.
 */
export const BLOCKED_EXIT = 78; // sysexits.h EX_CONFIG

export function requireBaseline() {
  const missing = [];
  if (!fs.existsSync(BASELINE)) missing.push('mobile-baseline.db');
  if (!fs.existsSync(STATE_TAR)) missing.push('mobile-state.tar.gz');
  if (missing.length) {
    console.error('BLOCKED: mobile baseline not in repo, rebuild from a device (see COVERAGE.md)');
    console.error(`  missing: ${missing.join(', ')} in ${path.join(MOBILE, 'fixtures')}`);
    process.exit(BLOCKED_EXIT);
  }
  if (!fs.existsSync(APK)) {
    console.error('BLOCKED: mobile release APK not in repo, rebuild it (see COVERAGE.md)');
    console.error(`  missing: ${APK}`);
    process.exit(BLOCKED_EXIT);
  }
}

fs.mkdirSync(SHOTS, { recursive: true });

export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  }).trim();
}

export function adb(args, opts = {}) {
  return run(ADB, args, opts);
}

export function shell(cmd, opts = {}) {
  return adb(['shell', cmd], opts);
}

export function tap(x, y) {
  shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
}

export function key(code) {
  shell(`input keyevent ${code}`);
}

export function text(value) {
  const escaped = String(value).replace(/([\\()'"&|;<> ])/g, '\\$1');
  shell(`input text ${escaped}`);
}

export function screenshot(name) {
  const remote = `/sdcard/${name}.png`;
  const local = path.join(SHOTS, `${name}.png`);
  shell(`screencap -p ${remote}`);
  adb(['pull', remote, local]);
  return local;
}

export function ocr(file) {
  let out = '';
  try {
    out = run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      OCR_PS1,
      '-Path',
      file,
    ]);
  } catch {
    return [];
  }
  return out
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter((p) => p.length >= 5)
    .map((p) => ({ cx: Number(p[0]), cy: Number(p[1]), w: Number(p[2]), h: Number(p[3]), text: p.slice(4).join('\t') }))
    .filter((l) => Number.isFinite(l.cx) && Number.isFinite(l.cy) && l.text.trim());
}

export function ocrScreen(name = `screen-${Date.now()}`) {
  return ocr(screenshot(name));
}

export function findLine(lines, re) {
  return lines.find((l) => re.test(l.text));
}

export function waitFor(re, timeoutMs = 20000, name = `wait-${Date.now()}`) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = ocrScreen(`${name}-${Math.floor((deadline - Date.now()) / 1000)}`);
    const hit = findLine(last, re);
    if (hit) return { hit, lines: last };
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
  }
  const flat = last.map((l) => l.text).join(' | ');
  throw new Error(`OCR timeout for ${re}: ${flat.slice(0, 500)}`);
}

export function tapText(re, timeoutMs = 20000, name = `tap-${Date.now()}`) {
  const { hit, lines } = waitFor(re, timeoutMs, name);
  tap(hit.cx, hit.cy);
  return { hit, lines };
}

export function startApp() {
  shell(`am start -n ${ACTIVITY}`);
}

export function stopApp() {
  shell(`am force-stop ${PACKAGE}`);
}

export function appPid() {
  try {
    return shell(`pidof ${PACKAGE}`).trim();
  } catch {
    return '';
  }
}

export function appUidGid() {
  return shell(`stat -c %u:%g /data/data/${PACKAGE}`).trim();
}

export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function home() {
  key(3);
}

export function wake() {
  key(224);
}

export function screenOff() {
  key(223);
}

export function setAirplane(on) {
  shell(`cmd connectivity airplane-mode ${on ? 'enable' : 'disable'}`);
}

export function setWifi(on) {
  shell(`svc wifi ${on ? 'enable' : 'disable'}`);
}

export function pushDbFile(localPath, remoteName = 'seed.db') {
  stopApp();
  adb(['push', localPath, `/data/local/tmp/${remoteName}`]);
  shell(`rm -f /data/data/${PACKAGE}/mobi_pos.db /data/data/${PACKAGE}/mobi_pos.db-wal /data/data/${PACKAGE}/mobi_pos.db-shm`);
  shell(`cp /data/local/tmp/${remoteName} /data/data/${PACKAGE}/mobi_pos.db`);
  shell(`chown ${appUidGid()} /data/data/${PACKAGE}/mobi_pos.db`);
  shell(`chmod 600 /data/data/${PACKAGE}/mobi_pos.db`);
  try {
    shell(`restorecon /data/data/${PACKAGE}/mobi_pos.db`);
  } catch {
    /* best effort */
  }
}

export function pushBaseline() {
  requireBaseline();
  pushDbFile(BASELINE, 'mobile-baseline.db');
}

export function bootMs(timeoutMs = 60000) {
  const t0 = Date.now();
  startApp();
  waitFor(/MobiPOS/, timeoutMs, 'boot');
  return Date.now() - t0;
}

export function restoreState() {
  stopApp();
  adb(['push', STATE_TAR, '/data/local/tmp/mobi-state.tar.gz']);
  shell(`rm -rf /data/data/${PACKAGE}/app_webview /data/data/${PACKAGE}/shared_prefs /data/data/${PACKAGE}/files /data/data/${PACKAGE}/no_backup /data/data/${PACKAGE}/mobi_pos.db /data/data/${PACKAGE}/mobi_pos.db-wal /data/data/${PACKAGE}/mobi_pos.db-shm`);
  shell(`cd /data/data/${PACKAGE} && tar -xzpf /data/local/tmp/mobi-state.tar.gz`);
  shell(`chown -R ${appUidGid()} /data/data/${PACKAGE}/app_webview /data/data/${PACKAGE}/shared_prefs /data/data/${PACKAGE}/files /data/data/${PACKAGE}/no_backup /data/data/${PACKAGE}/mobi_pos.db 2>/dev/null || true`);
  shell(`chmod 600 /data/data/${PACKAGE}/mobi_pos.db`);
  try {
    shell(`restorecon -R /data/data/${PACKAGE} 2>/dev/null || true`);
  } catch {
    /* best effort */
  }
}

export function resetApp() {
  requireBaseline();
  restoreState();
  startApp();
  // A wiped native credential vault makes the app open the mobile pairing
  // wizard on boot; close it (top-right X) before waiting for the till UI.
  const deadline = Date.now() + 30000;
  let last = [];
  while (Date.now() < deadline) {
    last = ocrScreen('reset-start');
    if (last.some((l) => /MobiPOS|Caisse/.test(l.text))) return last;
    if (last.some((l) => /Synchronisation Mobile/.test(l.text))) {
      const close = last.find((l) => /^x$/i.test(l.text)) || last.find((l) => /^\u2715$/.test(l.text));
      if (close) {
        tap(close.cx, close.cy);
        sleep(1200);
        continue;
      }
    }
    sleep(700);
  }
  return waitFor(/MobiPOS|Caisse/, 30000, 'reset-start');
}

export function pullDb(tag = `mob-${Date.now()}`) {
  stopApp();
  const dir = path.join(MOBILE, 'tmp', tag);
  fs.mkdirSync(dir, { recursive: true });
  shell(`cp /data/data/${PACKAGE}/mobi_pos.db /sdcard/${tag}.db`);
  adb(['pull', `/sdcard/${tag}.db`, path.join(dir, 'mobi_pos.db')]);
  for (const ext of ['-wal', '-shm']) {
    try {
      shell(`cp /data/data/${PACKAGE}/mobi_pos.db${ext} /sdcard/${tag}.db${ext}`);
      adb(['pull', `/sdcard/${tag}.db${ext}`, path.join(dir, `mobi_pos.db${ext}`)]);
    } catch {
      /* no wal/shm */
    }
  }
  const db = new Database(path.join(dir, 'mobi_pos.db'));
  return { db, dir };
}

export function openCaisse() {
  tapText(/^Caisse$/m, 20000, 'nav-caisse');
  return waitFor(/Articles au Panier/, 15000, 'caisse');
}

export function openCatalog() {
  tapText(/Catalogue Articles/, 15000, 'open-catalog');
  return waitFor(/Tous\s+[Il]es\s+articles|articles\s+trouv/i, 20000, 'catalog');
}

export function addFirstProduct() {
  tapText(/\+ Au Panier/, 15000, 'add-first');
  return waitFor(/Articles au Panier\s*\(1\)|E2E Num A/, 15000, 'added');
}

export function checkoutCash() {
  tapText(/Esp.{1,4}ces/, 15000, 'pay-cash');
  waitFor(/Encaissement/, 15000, 'pay-screen');
  tapText(/Exact\s*\(/, 10000, 'exact');
  tapText(/Confirmer/, 10000, 'confirm');
  const receipt = waitFor(/Ticket NO|REC-\d{8}/, 25000, 'receipt');
  key(4);
  return receipt;
}

export function closePrint() {
  key(4);
  try {
    tapText(/^x$/m, 3000, 'close-print');
  } catch {
    /* already closed */
  }
}

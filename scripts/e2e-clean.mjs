// E2E process cleanup (Phase 1 harness).
//
// Kills orphaned app/driver processes. The embedded WebDriver service does
// not reliably reap the app, which then holds the DB lock and the next run
// "gets stuck" (Phase 1 finding).
//
// Shutdown order matters (Phase 3 incident): graceful close FIRST so SQLite
// finishes journal work — a force-kill landing mid-vacuum tore freelist
// pages once (quarantined 18:36 snapshot, DISCOVERY §12). taskkill /F is
// the fallback after a 15 s wait; drivers are always force-killed.
//
// ISOLATED-CONTAINER MODE (Phase 1): the e2e flavor opens ONLY the
// com.mobi.pos.e2e data dir. This script NEVER deletes data directories —
// mid-run isolation is e2e_reset_and_seed (SQLite, via IPC). Pass
// POS_E2E_WIPE=1 to wdio (not here) for a clean-room container wipe.
// Do NOT add recursive deletes here.
import { execSync } from 'node:child_process';

function running(image) {
  try {
    return execSync(`tasklist /FI "IMAGENAME eq ${image}" /NH`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .toLowerCase()
      .includes(image.toLowerCase());
  } catch {
    return false;
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (running('mobi-pos.exe')) {
  try {
    execSync('taskkill /IM mobi-pos.exe', { stdio: 'ignore' });
    console.log('[e2e:clean] graceful close requested (mobi-pos.exe)');
  } catch {
    // fall through to the wait
  }
  for (let i = 0; i < 30 && running('mobi-pos.exe'); i++) sleepMs(500);
}
for (const proc of ['mobi-pos', 'msedgedriver', 'tauri-driver']) {
  if (!running(`${proc}.exe`)) continue;
  try {
    execSync(`taskkill /F /IM ${proc}.exe`, { stdio: 'ignore' });
    console.log(`[e2e:clean] force-killed ${proc}.exe (graceful timed out)`);
  } catch {
    // not running — fine
  }
}
// WebView2 orphans (Gate 4 lesson): killing mobi-pos.exe does NOT reap its
// msedgewebview2.exe broker/renderers — they linger holding the SQLite/WAL
// file locks and running page timers against the container, wedging later
// runs (lock cascades, FTS failures, phantom contention). Reap them here.
// Dev-machine scope: this also closes other apps' embedded WebViews.
try {
  execSync('taskkill /F /IM msedgewebview2.exe', { stdio: 'ignore' });
  console.log('[e2e:clean] reaped msedgewebview2.exe orphans');
} catch {
  // none running — fine
}
// Verify: a surviving app poisons the next run (stale page, wedged guard,
// shared DB file). Fail LOUDLY instead of letting it contaminate results.
for (let i = 0; i < 10 && running('mobi-pos.exe'); i++) sleepMs(500);
if (running('mobi-pos.exe')) {
  console.error('[e2e:clean] FATAL: mobi-pos.exe survives force-kill — refusing to continue (reboot or kill it manually)');
  process.exit(1);
}
console.log('[e2e:clean] OK (processes only — data dirs untouched by design)');

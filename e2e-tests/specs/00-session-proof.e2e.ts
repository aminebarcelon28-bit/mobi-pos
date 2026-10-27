/**
 * PART 0 PROOF — desktop.
 *
 * Proves `ensureDesktopSession()` (lib/session.mjs) takes the app from a
 * COMPLETELY FRESH sandbox (first-run setup gate) to an authenticated
 * dashboard, and that the session is real (DB row written by setup, header
 * mounted) — not merely "no error thrown".
 *
 * Run fresh:
 *   POS_E2E_WIPE=1 npx wdio run e2e-tests/wdio.conf.ts \
 *     --spec e2e-tests/specs/00-session-proof.e2e.ts
 *
 * The spec also exercises the SECOND branch (lock gate): it reloads the
 * WebView after setup, which remounts the lock screen, then calls the same
 * helper again and expects the dashboard.
 */
import { browser, $ } from '@wdio/globals';
import fs from 'node:fs';
import * as pos from '../lib/pos';
import {
  ensureDesktopSession,
  assertPinValid,
  MANAGER_NAME,
  MANAGER_PIN,
  PIN_MIN_DIGITS,
} from '../lib/session.mjs';
import { DB_PATH, SANDBOX, APP_PIN } from '../lib/env';
import { one, scalar } from '../lib/db';

const log = (k: string, v: unknown) => console.log(`[PROOF] ${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);

describe('PART0 — shared session helper, desktop, from fresh state', function () {
  this.timeout(300000);

  it('goes fresh -> setup -> dashboard, then reload -> lock -> dashboard', async () => {
    assertPinValid(MANAGER_PIN);

    log('sandbox', SANDBOX);
    log('db_path', DB_PATH);
    log('credentials', `manager="${MANAGER_NAME}" pin=${MANAGER_PIN} (${MANAGER_PIN.length} digits, min ${PIN_MIN_DIGITS})`);
    log('env_pin_matches', APP_PIN === MANAGER_PIN);

    // ── 0. Preconditions: the wipe really happened ──────────────────────────
    // onPrepare deletes the data dir before the app launches, so the app must
    // have recreated the DB from scratch on this launch. The WebView boots
    // asynchronously — wait for the native side to create the file.
    const dbDeadline = Date.now() + 180000;
    while (!fs.existsSync(DB_PATH) && Date.now() < dbDeadline) {
      await browser.pause(500);
    }
    const dbExisted = fs.existsSync(DB_PATH);
    log('db_file_exists', dbExisted);
    if (!dbExisted) throw new Error('app never created its DB — wrong sandbox?');

    const bootBefore = await pos.waitForBootGate(120000);
    log('boot_screen_before', bootBefore);

    const settingsCountBefore = Number(scalar<number>('SELECT COUNT(*) FROM app_settings') ?? -1);
    log('app_settings_rows_before', settingsCountBefore);

    if (bootBefore !== 'setup') {
      throw new Error(
        `expected the first-run SETUP gate on a wiped sandbox, got "${bootBefore}" — ` +
          'the proof only means something from a genuinely fresh state (use POS_E2E_WIPE=1).',
      );
    }

    // ── 1. First branch: setup gate -> dashboard ────────────────────────────
    const t0 = Date.now();
    const res1 = await ensureDesktopSession(MANAGER_PIN, pos);
    log('helper_result_1', res1);
    log('setup_to_dashboard_ms', Date.now() - t0);

    // The helper resolves when the header mounts; the lock overlay unmounts a
    // frame later. Wait for it to go away before asserting the end state.
    await browser
      .waitUntil(
        async () => !(await (await $('[data-testid="lock-screen"]')).isDisplayed().catch(() => false)),
        { timeout: 20000, timeoutMsg: 'lock overlay never unmounted after unlock' },
      )
      .catch((e: Error) => log('lock_unmount_wait', e.message));

    const bootAfterSetup = await pos.detectBootScreen();
    log('boot_screen_after_setup', bootAfterSetup);

    const header = await $('header');
    const headerShown = await header.isDisplayed().catch(() => false);
    const headerText = headerShown ? (await header.getText()).replace(/\s+/g, ' ').slice(0, 160) : '';
    log('header_displayed', headerShown);
    log('header_text', headerText);

    const lockStillUp = await (await $('[data-testid="lock-screen"]')).isDisplayed().catch(() => false);
    log('lock_screen_still_displayed', lockStillUp);
    // ── 2. DB evidence: setup actually wrote the team/PIN ───────────────────
    const pinRow = one<{ key: string; value_json: string }>(
      "SELECT key, value_json FROM app_settings WHERE key = 'manager_pin'",
    );
    log('db_manager_pin_row_present', Boolean(pinRow));
    log('db_manager_pin_value_len', pinRow ? String(pinRow.value_json).length : 0);
    // The stored PIN must never be the plaintext we typed (native hash/seal).
    log('db_manager_pin_is_plaintext', pinRow ? String(pinRow.value_json).includes(MANAGER_PIN) : null);

    const cashiers = one<{ value_json: string }>(
      "SELECT value_json FROM app_settings WHERE key = 'cashier_users'",
    );
    log('db_cashier_users_row_present', Boolean(cashiers));

    const settingsCountAfter = Number(scalar<number>('SELECT COUNT(*) FROM app_settings') ?? -1);
    log('app_settings_rows_after', settingsCountAfter);

    // ── 3. Second branch: reload -> lock gate -> dashboard ──────────────────
    await browser.refresh();
    await pos.waitForBootGate(120000);
    const bootAfterReload = await pos.detectBootScreen();
    log('boot_screen_after_reload', bootAfterReload);

    const res2 = await ensureDesktopSession(MANAGER_PIN, pos);
    log('helper_result_2', res2);

    const header2Shown = await (await $('header')).isDisplayed().catch(() => false);
    log('header_displayed_after_relock', header2Shown);

    // ── 4. Verdict ──────────────────────────────────────────────────────────
    const pass =
      bootBefore === 'setup' &&
      bootAfterSetup === 'dashboard' &&
      headerShown &&
      !lockStillUp &&
      Boolean(pinRow) &&
      !(pinRow && String(pinRow.value_json).includes(MANAGER_PIN)) &&
      Boolean(cashiers) &&
      header2Shown;

    log('VERDICT', pass ? 'PASS' : 'FAIL');
    if (!pass) throw new Error('desktop session proof failed — see [PROOF] lines above');
  });
});

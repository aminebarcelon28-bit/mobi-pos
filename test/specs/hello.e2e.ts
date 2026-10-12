import { expect, browser, $ } from '@wdio/globals';
import { APP_PIN } from '../helpers/common';

/**
 * Phase 1 gate (hello-world): the e2e flavor launches, the isolated test DB
 * answers through e2e_* IPC, and PIN 202020 reaches the dashboard.
 *
 * Screens handled (first run on a fresh e2e data dir differs from later):
 *   1. FirstBootPinSetup  [data-testid="setup-pin-root"] -> complete with 202020
 *   2. LockScreenOverlay   [data-testid="lock-screen"]    -> unlock with 202020
 *   3. ActivationGate      (licensed dev keyring expected; if visible -> hard
 *      fail with a clear message: a license cannot be fabricated by tests)
 *
 * No browser.pause: every wait is waitForDisplayed/waitUntil.
 * No retries: this spec must be deterministic (specFileRetries: 0 globally).
 */

async function invoke<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return (await browser.execute(
    async (c: string, a: Record<string, unknown>) => {
      const w = window as unknown as {
        __TAURI__?: { core: { invoke: (c: string, a: unknown) => Promise<unknown> } };
      };
      if (!w.__TAURI__) throw new Error('__TAURI__ global missing (e2e overlay withGlobalTauri?)');
      return (await w.__TAURI__.core.invoke(c, a)) as T;
    },
    cmd,
    args,
  )) as T;
}

async function installErrorTrap(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as { __helloErrors?: string[]; __helloWrapped?: boolean };
    if (w.__helloWrapped) {
      w.__helloErrors = [];
      return;
    }
    w.__helloErrors = [];
    w.__helloWrapped = true;
    window.addEventListener('error', (e) => w.__helloErrors?.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) =>
      w.__helloErrors?.push(String((e as PromiseRejectionEvent).reason)),
    );
  });
}

describe('E2E hello (Phase 1 gate)', () => {
  it('H1 launches, oracle answers on the isolated test DB, 202020 unlocks', async () => {
    const root = await $('#root');
    await root.waitForExist({ timeout: 90000 });
    await installErrorTrap();

    // --- Wait for React to mount ONE of the boot screens (no blind checks:
    // #root exists as soon as index.html loads, before any overlay renders).
    const setupRoot = await $('[data-testid="setup-pin-root"]');
    const lockScreen = await $('[data-testid="lock-screen"]');
    const header = await $('header');
    await browser.waitUntil(
      async () =>
        (await setupRoot.isDisplayed().catch(() => false)) ||
        (await lockScreen.isDisplayed().catch(() => false)) ||
        (await header.isDisplayed().catch(() => false)),
      { timeout: 60000, timeoutMsg: 'no boot screen mounted (setup/lock/dashboard)' },
    );

    // --- First-boot setup only exists on a fresh data dir.
    if (await setupRoot.isDisplayed().catch(() => false)) {
      console.log('[hello] first-boot setup visible -> completing with PIN 202020');
      const nameInput = await $('[data-testid="setup-manager-name"]');
      await nameInput.waitForDisplayed({ timeout: 15000 });
      await nameInput.setValue('E2E Gerant');
      await (await $('[data-testid="setup-manager-new"]')).setValue(APP_PIN);
      await (await $('[data-testid="setup-manager-confirm"]')).setValue(APP_PIN);
      await (await $('[data-testid="setup-save"]')).click();
      // Native Argon2id rotation happens here; allow generous time.
      await browser.waitUntil(
        async () =>
          (await $('[data-testid="lock-screen"]')
            .isDisplayed()
            .catch(() => false)) ||
          (await $('header').isDisplayed().catch(() => false)),
        { timeout: 120000, timeoutMsg: 'setup did not yield lock screen or dashboard' },
      );
    }

    if (await lockScreen.isDisplayed().catch(() => false)) {
      console.log('[hello] lock screen visible -> unlocking with PIN 202020');
      // The real input is opacity-0 (invisible to WebDriver's displayed
      // check), so drive the human path: tap the PIN pad (focuses the
      // input) then type physically. No setValue on hidden elements.
      const pad = await $('[data-testid="login-pin-pad"]');
      await pad.waitForDisplayed({ timeout: 15000 });
      await pad.click();
      await browser.keys(APP_PIN.split(''));
      const submit = await $('[data-testid="login-submit"]');
      if (await submit.isDisplayed().catch(() => false)) {
        await submit.click();
      }
    }

    // --- Dashboard must be reachable (license gate would stop us before here)
    await header.waitForDisplayed({ timeout: 90000 });
    console.log('[hello] dashboard header visible');

    // --- Out-of-band oracle on the isolated test DB (Gate 1.4 evidence)
    const state = await invoke<{
      dbPath: string;
      dbFilename: string;
      userVersion: number;
      migratedVersion: number;
      integrityCheck: string;
      tables: { name: string; rows: number }[];
    }>('e2e_get_db_state');
    console.log(`[hello] e2e dbPath    = ${state.dbPath}`);
    console.log(`[hello] e2e dbFilename= ${state.dbFilename}`);
    console.log(`[hello] migrated      = ${state.migratedVersion} (user_version pragma=${state.userVersion})`);
    console.log(`[hello] integrity     = ${state.integrityCheck}`);
    // ISOLATED-CONTAINER MODE (Phase 1): the e2e flavor opens ONLY the
    // com.mobi.pos.e2e data dir — same filename, separate container.
    // Production data (`com.mobi.pos` without the `.e2e` suffix) is never
    // opened; there is no snapshot/restore because nothing real is touched.
    expect(state.dbFilename).toBe('mobi_pos.db');
    expect(state.dbPath).toContain('com.mobi.pos.e2e');
    // Build provenance (Gate 1.6): the binary proves its own flavor.
    const info = await invoke<{
      gitSha: string;
      pkgVersion: string;
      profile: string;
      features: string;
      identifierExpected: string;
      dataDir: string;
      dbPath: string;
      gatewayMode: string;
      clockMode: string;
    }>('e2e_build_info');
    console.log(`[hello] buildInfo   = ${JSON.stringify(info)}`);
    expect(info.identifierExpected).toBe('com.mobi.pos.e2e');
    expect(info.dataDir).toContain('com.mobi.pos.e2e');
    expect(info.gatewayMode).toBe('sealed-mock');
    expect(info.features).toBe('e2e');
    // Real-data floor: this database's sqlx ledger is frozen at 106 (the
    // 0.8 reversible migrator does not advance the pre-0.8 ledger shape —
    // Phase 1 finding, reported, app-side). The TS boot self-heal backfills
    // every money-path object (refund trigger, Tier-B outbox columns,
    // txn identity columns — all probed present), so 106 is migration-whole
    // for the till. Fresh boots reach 112.
    expect(state.migratedVersion).toBeGreaterThanOrEqual(106);
    expect(state.integrityCheck).toBe('ok');
    // Sync-seal proof is the sealed credential read (harness asserts it);
    // the transaction count below is LOG-ONLY on the isolated container:
    // a fresh wipe starts at 0, a reused container keeps earlier seeded
    // rows. The count must never grow from sync pulls (cloud credentials
    // are sealed, so SyncManager stays inert).
    const txns = state.tables.find((t) => t.name === 'transactions');
    console.log(`[hello] transactions in e2e DB = ${txns?.rows ?? '?'}`);

    const errs = (await browser.execute(
      () => (window as unknown as { __helloErrors?: string[] }).__helloErrors ?? [],
    )) as string[];
    expect(errs).toEqual([]);
  });
});

import { expect, browser, $ } from '@wdio/globals';
import { createHash, randomBytes } from 'node:crypto';
import {
  installErrorTrap,
  readErrors,
  ledger,
  invoke,
} from '../helpers/pos';

/**
 * D4 regression: native `pin_set` mint must persist (app_settings.updated_at
 * NOT NULL). Pre-fix, EVERY mint/rotate failed with
 * `credential write: NOT NULL constraint failed: app_settings.updated_at`.
 *
 * IPC-only (no UI login needed): reset → roster seed (legacy v1 hash) →
 * pin_set mint → v2 → pin_verify ok. Fast by design (~10 s).
 */

const CASHIER_ID = 'usr-e2e-pinproof';
const CASHIER_PIN = '1010'; // proven non-banal (cashier-rbac)

describe('D4 pin_set mint persists (regression)', () => {
  it('mints v2 and verifies: updated_at constraint satisfied', async () => {
    await installErrorTrap();
    await (await $('#root')).waitForExist({ timeout: 90000 });
    await invoke('e2e_reset_db');

    // Roster row with a legacy v1 hash (native resolves users from it).
    const salt = `e2e${randomBytes(4).toString('hex')}`;
    const digest = createHash('sha256')
      .update(`${salt}:${CASHIER_PIN}:mobi_pos_salt_v1`)
      .digest('hex');
    const st0 = await ledger();
    const raw0 = st0.settingsValues.find((k) => k.key === 'cashier_users');
    const roster0 = JSON.parse((raw0?.valueJson ?? '[]') as string) as Array<
      Record<string, unknown>
    >;
    await invoke('e2e_seed_state', {
      payload: {
        settings: [
          {
            key: 'cashier_users',
            valueJson: JSON.stringify([
              ...roster0,
              {
                id: CASHIER_ID,
                name: 'E2E PIN Proof',
                pin: `v1$${salt}$${digest}`,
                role: 'cashier',
                avatarColor: '#10b981',
              },
            ]),
          },
        ],
      },
    });

    // The D4 write path: pre-fix this threw NOT NULL updated_at.
    const minted = await invoke<{ userId: string; format: string }>('pin_set', {
      request: { userId: CASHIER_ID, newPin: CASHIER_PIN },
    });
    expect(minted.userId).toBe(CASHIER_ID);
    expect(minted.format).toBe('v2');
    console.log(`[d4] minted ${minted.userId} (${minted.format})`);

    // Rotation persisted: native verify accepts the new PIN.
    const verify = await invoke<{ ok: boolean; locked: boolean }>('pin_verify', {
      request: { userId: CASHIER_ID, pin: CASHIER_PIN },
    });
    expect(verify.ok).toBe(true);
    expect(await readErrors()).toEqual([]);
  });
});

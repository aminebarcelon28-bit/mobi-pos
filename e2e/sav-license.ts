/**
 * E2E licensing helper: seeds a deterministic web HWID + offline-minted
 * LIFETIME token (placeholder ledger key, device-bound) so the till UI is
 * reachable in a fresh headless Chromium profile.
 *
 * No cloud writes: `license-admin token` only Ed25519-signs locally using
 * the repo .env.licensing private key. Uses the generic "Client MobiPOS"
 * placeholder ledger entry — never a real customer key.
 */
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';

export const E2E_HWID_HASH = 'e2e5a17ec0ffee1234567890abcdef01';
const PLACEHOLDER_KEY = 'MOBI-LIFE-KSXF-HTV4';

/**
 * Locator for the blocking activation gate (ActivationGateScreen.tsx).
 *
 * Covers BOTH mutually exclusive branches the gate can render:
 *   - SUSPENDED/revoked  → <h1>Accès Temporairement Suspendu</h1>  (:438)
 *   - UNLICENSED/unbound → <h1>MobiPOS <span>Licence</span></h1>     (:565)
 *
 * Two things this deliberately avoids:
 *   - `getByText('MobiPOS Licence')` — the heading string is split across two
 *     elements, so the text query never matches.
 *   - the accented "è" — matched on the ASCII tail ("Temporairement
 *     Suspendu") so the locator cannot rot on file encoding.
 *
 * Every gate assertion in the suite used the broken text query as
 * `toHaveCount(0)`, so they all passed VACUOUSLY — the gate was never actually
 * asserted anywhere, which is how a stale spec could keep skipping "license
 * gate state is visible" unnoticed. Accessible names concatenate, so a heading
 * role matches.
 */
export function licenseGate(page: Page) {
  return page.getByRole('heading', { name: /MobiPOS\s+Licence|Temporairement\s+Suspendu/i });
}

/** True when the till is blocked behind the activation gate. */
export async function isLicenseGateVisible(page: Page): Promise<boolean> {
  return (await licenseGate(page).count()) > 0;
}

/**
 * Stub the licensing backend so e2e runs never touch production.
 *
 * The app POSTs {license_key, device_id} to <endpoint>/api/v1/license/verify on
 * boot (src/licensing/client.ts:378) and to the same path on the ≤120s
 * heartbeat. The placeholder key was retired server-side, so the live worker
 * answered 403 "Terminal révoqué ou non rattaché" — which latches
 * `mobi_pos_license_suspension_v1` (client.ts:402) and fail-closes the whole
 * till before any UI renders. That made every e2e spec unrunnable and made the
 * suite depend on a live third-party service.
 *
 * This intercepts that network call ONLY. The app's own licensing logic is
 * untouched: signature check, device binding, clock guard and the fail-closed
 * 403 path all still run exactly as shipped, and a 403 from this stub would
 * still suspend. What is stubbed is the remote ledger's answer, so the suite is
 * hermetic and deterministic.
 *
 * Trade-off worth stating plainly: e2e therefore does NOT exercise the real
 * remote revocation path. `npm run test:license` covers that logic directly.
 */
export async function stubLicensingBackend(page: Page): Promise<void> {
  const ok = {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ active: true, license_key: PLACEHOLDER_KEY }),
  };
  await page.route('**/api/v1/license/verify', (route) => route.fulfill(ok));
  await page.route('**/api/v1/license/activate', (route) =>
    route.fulfill({ ...ok, body: JSON.stringify({ active: true, license_key: PLACEHOLDER_KEY, token: null }) })
  );
}

/**
 * Make the licensing endpoint answer the retired-key 403.
 *
 * Registers AFTER `stubLicensingBackend` (Playwright matches the most recently
 * added handler first), so this wins over the 200 stub. That ordering is what
 * makes the revocation scenario faithful: the till boots licensed, then the
 * next verify/heartbeat (client.ts:378) returns the production
 * "Terminal révoqué ou non rattaché" answer and must fail the till closed
 * exactly as it does in the field.
 */
export async function stubRevokedLicensingBackend(page: Page): Promise<void> {
  const revoked = {
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Terminal révoqué ou non rattaché' }),
  };
  await page.route('**/api/v1/license/verify', (route) => route.fulfill(revoked));
  await page.route('**/api/v1/license/activate', (route) => route.fulfill(revoked));
}

export async function seedE2ELicense(page: Page): Promise<void> {
  // Registered before the first navigation: boot-time verify fires on load.
  await stubLicensingBackend(page);
  // Pre-seed the HWID before app boot so the fingerprint is deterministic.
  await page.addInitScript(
    ({ hwid }: { hwid: string }) => {
      try {
        if (!localStorage.getItem('mobi_pos_web_hwid_v1')) {
          localStorage.setItem('mobi_pos_web_hwid_v1', hwid);
        }
        // Stub print: receipt auto-print must never block headless runs.
        (window as unknown as { print: () => void }).print = () => {};
      } catch {
        /* storage restricted — fall through to gate detection */
      }
    },
    { hwid: E2E_HWID_HASH }
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // Licensed already (e.g. re-run with persisted state)? Nothing to do.
  if (!(await isLicenseGateVisible(page))) return;

  const out = execFileSync(
    process.execPath,
    ['scripts/license-admin.mjs', 'token', '--key', PLACEHOLDER_KEY, '--hwid', E2E_HWID_HASH],
    { encoding: 'utf8', timeout: 60_000 }
  );
  const m = out.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (!m) throw new Error(`offline token mint produced no JWT. Output:\n${out.slice(0, 500)}`);
  await page.evaluate((token: string) => {
    localStorage.setItem('mobi_pos_web_license_token', token);
  }, m[0]);
  await page.reload({ waitUntil: 'domcontentloaded' });
}

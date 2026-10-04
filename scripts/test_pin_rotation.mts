/**
 * Phase 4a rotation-wiring regression.
 *
 * Run: node --experimental-strip-types scripts/test_pin_rotation.mts
 *
 * The Argon2id backend (`pin_set` → v2) existed and was unit-tested while
 * every production rotation still minted fast hashes in TypeScript — the
 * backend was dead code and the journal even claimed "pré-Argon2id remplacé"
 * while planting another fast hash. This suite pins the wiring so that can
 * never regress silently:
 *
 * - every credential-minting UI path routes through `rotatePinCredential`
 *   (native Argon2id under Tauri; legacy TS mint only outside Tauri);
 * - no component mints `hashDeviceLocalPin`/`hashPin` for credentials
 *   anymore (definition + boot migration + the non-Tauri fallback stay);
 * - `v2$` semantics hold: no forced rotation, TS verification fails closed;
 * - rotation audit rows keep their category/severity (accountability
 *   unchanged by the KDF upgrade).
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`);
  }
}

const {
  needsPinRotation,
  verifyPin,
  hashDeviceLocalPin,
  isCommonPin,
} = (await import('../src/utils/security.ts')) as typeof import('../src/utils/security.ts');
const {
  getActionCategory,
  classifySeverity,
} = (await import('../src/utils/auditIntel.ts')) as typeof import('../src/utils/auditIntel.ts');

// ── 1. v2$ envelope semantics ─────────────────────────────────────────────
{
  const modern = 'v2$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA';
  check('v2$ needs no rotation', needsPinRotation(modern) === false);
  check('malformed v2$ still rotates (fail closed toward rotation)', needsPinRotation('v2$abc') === true);
  check('TS verification fails closed on v2$ (native-only)', verifyPin('1234', modern) === false);
  check('TS verification fails closed on unknown formats', verifyPin('1234', 'plaintext') === false);
  const legacy = hashDeviceLocalPin('1234');
  check('legacy v1 local_ needs no rotation (preview parity)', needsPinRotation(legacy) === false);
  check('legacy v1 verifies locally (preview/tests only)', verifyPin('1234', legacy) === true);
}

// ── 2. Every minting UI path routes through rotatePinCredential ───────────
{
  const overlay = read('src/components/LockScreenOverlay.tsx');
  const settings = read('src/components/modals/SettingsModal.tsx');
  const slice = read('src/store/slices/createUISlice.ts');
  const api = read('src/api/pin.ts');

  check('lock screen rotates via the native-first action', overlay.includes('rotatePinCredential('));
  check(
    'lock screen mints nothing locally for credentials',
    !overlay.includes('hashDeviceLocalPin(') && !overlay.includes('hashPin('),
  );
  check('settings rotates via the native-first action', settings.includes('rotatePinCredential('));
  // The single surviving TS mint is the non-Tauri creation fallback (web
  // preview): it must sit behind the isTauriEnv() else, never on the Tauri
  // path. Count it exactly so a second mint cannot creep back.
  {
    const hits = [...settings.matchAll(/hashDeviceLocalPin\(/g)].map((m) => m.index ?? 0);
    const idx = settings.indexOf('targetPin = hashDeviceLocalPin(cleanNew);');
    const head = idx === -1 ? '' : settings.slice(Math.max(0, idx - 4500), idx);
    check(
      'exactly one TS mint left in settings, guarded as the non-Tauri fallback',
      hits.length === 1 && idx !== -1 && head.includes('isTauriEnv()') && head.includes('} else {'),
      `mints: ${hits.length}`,
    );
  }
  check('store defines the rotation authority', slice.includes('rotatePinCredential: async'));
  check('store refreshes memory + mirror from SQLite after native set', slice.includes('refreshCredentialsFromAuthority'));
  check('native set is invoked by name pin_set', api.includes("'pin_set'"));
  check(
    'native failure never falls back to a local mint (comment contract)',
    /NEVER falls back to a local mint|never falls back to a local mint/i.test(slice),
  );
}

// ── 3. Rotation audit rows keep accountability ────────────────────────────
{
  check(
    'rotation maps to Autorisation PIN',
    getActionCategory('Rotation PIN Sécurité').label === 'Autorisation PIN',
  );
  check(
    'rotation stays above noise (requiresPin → info)',
    classifySeverity('Rotation PIN Sécurité', 'Credential renouvelée pour Y (format v2)', true) === 'info',
  );
  check(
    'manager PIN update stays critical-adjacent',
    getActionCategory('Mise à Jour Code PIN Gérant').label === 'Autorisation PIN',
  );
  // Kernel clock-anomaly evidence row (native emit on quarantine entry):
  // the `anomalie` keyword must keep it CRIT even though its category is
  // Autre — this is the contract the Rust constructor documents.
  check(
    'clock-anomaly row classifies critical',
    classifySeverity(
      'Horloge Appareil Anormale',
      "Anomalie d'horloge détectée par le noyau : verdict=CLOCK_RESET_REQUIRED (mur=1700000000000 ms, ancre=1699999000000 ms).",
      false,
    ) === 'critical',
  );
}

// ── 4. Uniform policy + hardening ────────────────────────────────────────
// Mint policy is 6–8 manager / exactly-4 cashier on BOTH sides (a wider
// native cap would mint credentials the login keypad cannot type).
{
  for (const banal of ['1234', '0000', '1111', '4321', '2580', '123456', '654321', '000000', '111111', '2222', '9876']) {
    check(`blocklist rejects ${banal}`, isCommonPin(banal) === true);
  }
  check('blocklist passes a real PIN (4)', isCommonPin('9137') === false);
  check('blocklist passes a real PIN (6)', isCommonPin('482916') === false);

  const overlay = read('src/components/LockScreenOverlay.tsx');
  const settings = read('src/components/modals/SettingsModal.tsx');
  const app = read('src/App.tsx');
  const slice = read('src/store/slices/createUISlice.ts');
  const api = read('src/api/pin.ts');

  check('login caps manager entry at 8 (no untypeable credential)', overlay.includes('maxPinLength = isManagerProfile ? 8 : 4'));
  check('login never auto-submits a variable-length manager PIN', overlay.includes('!isManagerProfile && next.length === targetPinLength'));
  check('rotation forms enforce 6–8 / exactly-4', overlay.includes('rotationFor.isManager ? 6 : 4') && overlay.includes('rotationFor.isManager ? 8 : 4'));
  check('rotation park expires (5 min session binding)', overlay.includes('ROTATION_PARK_TTL_MS') && overlay.includes('parkedAt'));
  check('rotation submit is double-submit guarded', overlay.includes('rotationSubmittingRef.current = true'));
  check('rotation surfaces friendly native errors', overlay.includes('friendlyPinSetError('));
  check('settings manager update enforces 6–8', settings.includes('/^[0-9]{6,8}$/'));
  check('settings screens banal PINs before minting', settings.includes('isCommonPin(cleanNew)'));
  check('settings skeleton uses an inert placeholder, never empty', settings.includes('PENDING-') && !settings.includes("pin: ''"));
  check('settings badge reads the live envelope', settings.includes('managerKdfLabel'));
  check('first-boot enforces 6–8 + blocklist + native route', app.includes('/^\\d{6,8}$/') && app.includes('isCommonPin(') && app.includes('rotatePinCredential('));
  check('boot migration never wraps v2', slice.includes("!p.startsWith('v2$')"));
  check('boot reconciles Dexie/SQLite by envelope strength', slice.includes('credentialRank'));
  check('refresh throws when the authority is unreadable', slice.includes("throw new Error('CREDENTIAL_REFRESH_FAILED')"));
  check('friendly mapper covers duplicate/guessable/policy', api.includes('already used') && api.includes('guessable'));
}

// ── 5. Phase 4d recovery decrypt ─────────────────────────────────────────
{
  const lib = read('src-tauri/src/lib.rs');
  const authorizer = read('src-tauri/src/trust_core/ipc_authorizer.rs');
  const backupApi = read('src/api/backup.ts');
  check('decrypt command registered as EmergencyExport (quarantine-capable)', authorizer.includes('("decrypt_snapshot_for_recovery", Capability::EmergencyExport)'));
  check('decrypt command exists + verifies manager PIN inside', lib.includes('fn decrypt_snapshot_for_recovery(') && lib.includes('user_id: "manager"'));
  check('decrypt validates snapshot-id shape before any FS touch', lib.includes('validate_snapshot_id(&request.snapshot_id)?'));
  check('decrypt verifies the plaintext image before reporting', lib.includes('integrity_check(&ro)'));
  check('decrypt never modifies the sealed original', lib.includes('create_new(true)'));
  check('TS wrapper exists', backupApi.includes('decryptSnapshotForRecovery'));
  check(
    'recovery decrypt row classifies critical',
    classifySeverity(
      'Décryptage Snapshot Secours',
      'Copie de travail en clair produite pour restauration manuelle : a.db -> a.recovery.db.',
      true,
    ) === 'critical',
  );
}

// ── 6. Pepper-dead recovery unboxing ─────────────────────────────────────
// The flag exists, is master-gated natively, and tech recovery retries with
// it ONLY on a pepper-absent failure — never preemptively.
{
  const api = read('src/api/pin.ts');
  const overlay = read('src/components/LockScreenOverlay.tsx');
  const slice = read('src/store/slices/createUISlice.ts');
  check('request carries the recovery flag', api.includes('recoveryReset?: boolean'));
  check('store passes the flag through (never invents it)', slice.includes('recoveryReset: opts?.recoveryReset'));
  check(
    'tech recovery retries with the flag only on pepper-absent failure',
    overlay.includes("rotatePinCredential('manager', cleanNew, true, { recoveryReset: true })") &&
      overlay.includes('/pepper absent/i'),
  );
  check(
    'recovery flag appears exactly once (catch-retry only, never preemptive)',
    overlay.split('recoveryReset: true').length - 1 === 1,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

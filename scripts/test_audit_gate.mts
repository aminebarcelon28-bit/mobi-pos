/**
 * FT-01 gate tests (Track 1A).
 *
 * Run: node --experimental-strip-types scripts/test_audit_gate.mts
 *
 * Covers (owner-required):
 * - cashier PIN cannot pass the manager gate (userId is always 'manager')
 * - fail-closed on transport failure / missing kernel (no local fallback)
 * - window expiry + lock + mobile background relock (memory only)
 * - PinDialog per-role lengths (manager 6, cashier 4), no auto-submit
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failures += 1;
    console.error(`  [FAIL] ${name} ${extra}`);
  }
}

// Outside-Tauri by default here (no window yet) — set a fake window before
// importing the gate so isTauri() is controllable per case.
(globalThis as any).window = {};

const gate = await import('../src/utils/auditGate.ts');
const {
  verifyManagerStepUp,
  isPinLengthValidForRole,
  minPinLengthForRole,
  markJournalUnlocked,
  isJournalUnlocked,
  touchJournalGate,
  canSeeJournalLauncher,
  isPinDialogLengthOk,
  clearJournalUnlock,
  notifyLocked,
  notifyBackground,
  notifyForeground,
  setJournalGateConfig,
} = gate as typeof import('../src/utils/auditGate.ts');

const MANAGER_PIN = '123456';
const CASHIER_PIN = '654321'; // 6 digits: passes the length rule, must still fail (wrong credential)

// ── 1. Manager gate always verifies against userId 'manager' ──
{
  const seen: string[] = [];
  const mockNative = async (req: { userId: string; pin: string }) => {
    seen.push(req.userId);
    const ok = req.userId === 'manager' && req.pin === MANAGER_PIN;
    return { ok, locked: false, lockedRemainingMs: 0, mustRotate: false, kdfUnavailable: true };
  };
  (globalThis as any).window = { __TAURI_INTERNALS__: {} };
  const asCashier = await verifyManagerStepUp(CASHIER_PIN, { pinVerifyFn: mockNative as any });
  check('cashier PIN does not pass manager gate', asCashier.ok === false, JSON.stringify(asCashier));
  check('gate verifies against userId manager only', seen.length === 1 && seen[0] === 'manager', seen.join(','));
  const asManager = await verifyManagerStepUp(MANAGER_PIN, { pinVerifyFn: mockNative as any });
  check('manager PIN passes manager gate', asManager.ok === true && asManager.weaker === false);
}

// ── 2. Fail closed: transport throws → no unlock, no local fallback ──
{
  (globalThis as any).window = { __TAURI_INTERNALS__: {} };
  let localUsed = false;
  const res = await verifyManagerStepUp(MANAGER_PIN, {
    pinVerifyFn: (async () => {
      throw new Error('ipc down');
    }) as any,
    localVerifyFn: () => {
      localUsed = true;
      return true;
    },
  });
  check('transport failure fails closed', res.ok === false && res.reason === 'unavailable');
  check('no local fallback on native path', localUsed === false);
}

// ── 3. Fail closed outside Tauri for privileged (no weak fallback) ──
{
  (globalThis as any).window = {};
  const res = await verifyManagerStepUp(MANAGER_PIN, {
    allowWeakFallback: false,
    pinVerifyFn: (async () => ({ ok: true, locked: false, lockedRemainingMs: 0, mustRotate: false, kdfUnavailable: true })) as any,
    localVerifyFn: () => true,
  });
  check('missing kernel fails closed without fallback flag', res.ok === false);
}

// ── 4. Window expiry + lock + mobile background relock (memory only) ──
{
  setJournalGateConfig({ windowMs: 5 * 60 * 1000, backgroundRelockMs: 60 * 1000 });
  clearJournalUnlock();
  const t0 = 1_700_000_000_000;
  markJournalUnlocked(t0);
  check('window valid before expiry', isJournalUnlocked(t0 + 4 * 60 * 1000 + 59 * 1000) === true);
  check('window expired at 5min', isJournalUnlocked(t0 + 5 * 60 * 1000) === false);
  markJournalUnlocked(t0);
  notifyLocked();
  check('lock clears window', isJournalUnlocked(t0 + 1000) === false);
  markJournalUnlocked(t0);
  notifyBackground(t0);
  check('short background keeps window', notifyForeground(t0 + 30 * 1000) === false && isJournalUnlocked(t0 + 30 * 1000) === true);
  markJournalUnlocked(t0);
  notifyBackground(t0);
  check('60s background relocks', notifyForeground(t0 + 60 * 1000) === true && isJournalUnlocked(t0 + 60 * 1000) === false);
}

// ── 4b. Idle window: activity extends, expiry never revives ──
{
  setJournalGateConfig({ windowMs: 5 * 60 * 1000, backgroundRelockMs: 60 * 1000 });
  clearJournalUnlock();
  const t0 = 2_700_000_000_000;
  markJournalUnlocked(t0);
  check('activity at 4min extends window', touchJournalGate(t0 + 4 * 60 * 1000) === true);
  check('extended window valid at 8min', isJournalUnlocked(t0 + 8 * 60 * 1000) === true);
  check('extended window expires 5min after touch', isJournalUnlocked(t0 + 9 * 60 * 1000 + 1000) === false);
  check('touch on expired window does not revive', touchJournalGate(t0 + 9 * 60 * 1000 + 1000) === false);
  clearJournalUnlock();
  check('touch on cleared window does not revive', touchJournalGate(t0) === false);
}

// ── 4c. Native locked verdict maps to countdown (no unlock) ──
{
  (globalThis as any).window = { __TAURI_INTERNALS__: {} };
  const res = await verifyManagerStepUp('123456', {
    pinVerifyFn: (async () => ({ ok: false, locked: true, lockedRemainingMs: 47_000, mustRotate: false, kdfUnavailable: true })) as any,
  });
  check('native lockout surfaces locked + countdown', res.ok === false && res.locked === true && res.lockedRemainingMs === 47_000);
}

// ── 4d. Launcher visibility rule (behavior, not grep) ──
{
  check('admin sees launcher', canSeeJournalLauncher('admin') === true);
  check('cashier hidden', canSeeJournalLauncher('cashier') === false);
  check('null role denied (fail closed)', canSeeJournalLauncher(null) === false);
  check('unknown role denied (fail closed)', canSeeJournalLauncher('owner') === false);
}

// ── 5. Length rules: strict-6 lives in the journal gate only ──
// auditGate keeps manager 6 (journal), PinDialog accepts 4–12 and lets
// verifyManagerPin decide (legacy 4-digit managers still verify locally).
{
  check('manager min is 6', minPinLengthForRole('manager') === 6);
  check('cashier min is 4', minPinLengthForRole('cashier') === 4);
  check('manager 4-digit rejected by length rule', isPinLengthValidForRole('1111', 'manager') === false);
  check('manager 6-digit accepted by length rule', isPinLengthValidForRole('123456', 'manager') === true);
  check('cashier 4-digit accepted by length rule', isPinLengthValidForRole('1111', 'cashier') === true);
  check('non-digits rejected', isPinLengthValidForRole('12ab56', 'manager') === false);
  check('dialog accepts 4-digit manager (verify decides)', isPinDialogLengthOk('1111') === true);
  check('dialog accepts 6-digit manager', isPinDialogLengthOk('123456') === true);
  check('dialog rejects 3 digits', isPinDialogLengthOk('111') === false);
  check('dialog rejects 13 digits', isPinDialogLengthOk('1234567890123') === false);
}

// ── 6. PinDialog: 4–12 bounds, verify decides, no auto-submit, Valider ──
{
  const src = readFileSync(join(ROOT, 'src/components/ui/PinDialog.tsx'), 'utf8');
  check('no hard length!==4 gate', !src.includes('length !== 4'));
  check('no auto-verify at 4 chars', !src.includes('if (next.length === 4) handleVerify'));
  check('explicit Valider button', src.includes('Valider'));
  check('role prop exists', src.includes('role?: GateRole') || src.includes("role = 'manager'"));
  check('PinDialog verifies 4–12, strict-6 only in gate', src.includes('isPinDialogLengthOk') && !src.includes('isPinLengthValidForRole'));
  check('PinDialog claims no 6-digit minimum', !src.includes('6 chiffres minimum'));
}

// ── 7. Gate is memory-only + native-only + modal-authoritative ──
{
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const gateSrc = strip(readFileSync(join(ROOT, 'src/utils/auditGate.ts'), 'utf8'));
  check('gate never touches localStorage', !gateSrc.includes('localStorage'));
  check('gate never calls local verifyManagerPin', !gateSrc.includes('verifyManagerPin'));
  check('gate pins manager userId', gateSrc.includes("userId: MANAGER_USER_ID") || gateSrc.includes("userId: 'manager'"));
  const modal = readFileSync(join(ROOT, 'src/components/modals/SecurityAuditModal.tsx'), 'utf8');
  check('modal imports gate', modal.includes('verifyManagerStepUp') && modal.includes('isJournalUnlocked'));
  check('modal hides content until unlocked', modal.includes('!gateUnlocked') && modal.includes('Accès réservé'));
  check('modal feed disabled until unlocked', modal.includes('isOpen && liveEnabled && gateUnlocked'));
  check('pivot re-checks gate', modal.includes('if (!isJournalUnlocked()) return;') || modal.includes('if (!isJournalUnlocked())'));
  check('honest label rendered', modal.includes('HONEST_GATE_LABEL'));
  check('weak fallback is dev-gated in modal', modal.includes('isDevBuild()'));
  check('production browser fails closed with installed-app copy', modal.includes('application installée'));
  for (const f of [
    'src/components/Header.tsx',
    'src/components/mobile/tabs/ManagementTab.tsx',
    'src/components/modals/SettingsModal.tsx',
  ]) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    check(`${f} gates entry via canSeeJournalLauncher`, s.includes('canSeeJournalLauncher('));
  }
}

// ── 8. Burst wiring: auditGate denials report with caller gate names ──
{
  const src = readFileSync(join(ROOT, 'src/utils/auditGate.ts'), 'utf8');
  check('auditGate reports denials through the shared coalescer', src.includes('reportGateDenial({ gateName'));
  check('auditGate locked branch reports with countdown', src.includes('lockoutDurationMs: res.lockedRemainingMs'));
  check('auditGate defaults attribution to journal', src.includes("options.gateName ?? 'journal'"));
  for (const [f, name] of [
    ['src/db/wipeGuard.ts', "'wipe'"],
    ['src/db/restoreGuard.ts', "'restore'"],
    ['src/utils/auditExport.ts', "'export'"],
    ['src/components/modals/SecurityAuditModal.tsx', "'journal'"],
  ] as const) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    check(`${f} attributes bursts as ${name}`, s.includes(`gateName: ${name}`));
  }
}

console.log('');
if (failures === 0) console.log('RESULT: FT-01 gate intact.');
else {
  console.error(`RESULT: ${failures} FAILURE(S)`);
  process.exit(1);
}

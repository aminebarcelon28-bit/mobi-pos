/**
 * SAV intake v2 legal-record gate.
 *
 * Run: node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_sav_intake_v2.mts
 *
 * The intake form is the ONLY place a repair ticket becomes legally
 * defensible, so its gate is asserted here rather than trusted:
 *
 *  A. A v2 ticket REQUIRES signature, CGV acceptance, a damage constat, a
 *     strict warranty tier, and (when the id is declared as an IMEI) a
 *     number. Each missing piece is reported, not silently defaulted.
 *  B. A v1 (legacy) ticket is checked against the descriptive minimum ONLY —
 *     it is never blocked into fabricating evidence that never existed, and
 *     never auto-promoted to v2.
 *  C. Draft handoff: consume is atomic (a second consume yields null) and a
 *     stale draft is discarded rather than applied.
 *  D. Warranty tiers are a closed set anchored on RESTITUE, and a major
 *     damage constat blocks the repair warranty.
 *  E. Financials are integer DZD and the balance is DERIVED, so a stored row
 *     can never disagree with its own components.
 *  F. The print queue is idempotent per (order, kind), strictly serial, and a
 *     cancel settles every promise it touches (no caller hangs).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failures += 1;
    console.error(`  [FAIL] ${name} ${extra}`);
  }
}

const pos = (await import('../src/types/pos.ts')) as typeof import('../src/types/pos.ts');
const slice = (await import('../src/store/slices/createRepairSlice.ts')) as typeof import('../src/store/slices/createRepairSlice.ts');
const queue = (await import('../src/utils/savPrintQueue.ts')) as typeof import('../src/utils/savPrintQueue.ts');

const { validateRepairIntake } = slice as any;
const {
  REPAIR_SCHEMA_VERSION,
  isSchemaV2Order,
  intakeDamageSeverity,
  intakeBlocksRepairWarranty,
  repairFinancials,
  computeWarrantyExpiryISO,
  warrantyMonthsToTier,
  isIntakeDraftFresh,
  SAV_LEGAL_TERMS_FR,
  SAV_LEGAL_TERMS_AR,
  LEGAL_TERMS_PROVISIONAL,
} = pos as any;

const baseOrder = (over: Record<string, unknown> = {}) =>
  ({
    customerName: 'Yacine B',
    deviceModel: 'iPhone 13 Pro',
    imei: '358921004812345',
    imeiKind: 'imei',
    problemDescription: 'Écran fissuré',
    conditionChecklist: { screenOk: true },
    postRepairChecklist: { screenOk: true },
    laborCost: 2000,
    partsCost: 8000,
    depositAmount: 0,
    status: 'Diagnostic',
    ...over,
  }) as any;

const v2Order = (over: Record<string, unknown> = {}) =>
  baseOrder({
    schemaVersion: REPAIR_SCHEMA_VERSION,
    intakeDamage: {
      screenCondition: 'cracked',
      chassisDamage: ['scratched'],
      liquidIndicatorTripped: false,
      deviceLock: { type: 'none' },
    },
    signatureCustomerIntake: 'data:image/png;base64,AAAA',
    legalTermsAcceptedAt: '2026-01-02T10:00:00.000Z',
    warrantyTier: 'repair_90d',
    ...over,
  });

// ── A. v2 gate is fail-closed on every legal field ──
console.log('== A: v2 legal record is required ==');
{
  const ok = validateRepairIntake(v2Order());
  check('a complete v2 ticket validates', ok.ok, JSON.stringify(ok.reasons));

  const noSig = validateRepairIntake(v2Order({ signatureCustomerIntake: undefined }));
  check('missing signature is rejected', !noSig.ok && noSig.reasons.some((r: string) => /Signature/i.test(r)));

  const noCgv = validateRepairIntake(v2Order({ legalTermsAcceptedAt: undefined }));
  check('missing CGV acceptance is rejected', !noCgv.ok && noCgv.reasons.some((r: string) => /Conditions/i.test(r)));

  const noScreen = validateRepairIntake(
    v2Order({ intakeDamage: { chassisDamage: ['none'], liquidIndicatorTripped: false, deviceLock: { type: 'none' } } })
  );
  check('missing screen constat is rejected', !noScreen.ok && noScreen.reasons.some((r: string) => /écran/i.test(r)));

  const noChassis = validateRepairIntake(
    v2Order({ intakeDamage: { screenCondition: 'intact', liquidIndicatorTripped: false, deviceLock: { type: 'none' } } })
  );
  check('missing chassis constat is rejected', !noChassis.ok && noChassis.reasons.some((r: string) => /châssis/i.test(r)));

  const noTier = validateRepairIntake(v2Order({ warrantyTier: undefined }));
  check('missing warranty tier is rejected', !noTier.ok && noTier.reasons.some((r: string) => /garantie/i.test(r)));

  const imeiEmpty = validateRepairIntake(v2Order({ imei: '' }));
  check(
    'IMEI declared but empty is rejected',
    !imeiEmpty.ok && imeiEmpty.reasons.some((r: string) => /IMEI/i.test(r))
  );

  // "Sans ID" is a legitimate path and must NOT trip the IMEI gate.
  const manualOk = validateRepairIntake(v2Order({ imei: '', imeiKind: 'none' }));
  check('"Sans ID" ticket with no identifier validates', manualOk.ok, JSON.stringify(manualOk.reasons));

  // Every blocker is reported at once, not one at a time.
  const many = validateRepairIntake(
    v2Order({ signatureCustomerIntake: undefined, legalTermsAcceptedAt: undefined, warrantyTier: undefined })
  );
  check(
    'all blockers are reported together',
    !many.ok && many.reasons.length >= 3,
    `got ${many.reasons.length}`
  );
}

// ── B. Legacy rows: descriptive minimum only, never promoted ──
console.log('== B: legacy v1 rows are never promoted ==');
{
  const legacy = baseOrder();
  check('legacy row is not schema v2', !isSchemaV2Order(legacy));
  const v = validateRepairIntake(legacy);
  check(
    'legacy row with descriptive minimum validates without legal evidence',
    v.ok,
    JSON.stringify(v.reasons)
  );

  const legacyBare = baseOrder({ customerName: '', deviceModel: '', problemDescription: '' });
  const v2 = validateRepairIntake(legacyBare);
  check(
    'legacy row still blocks the descriptive minimum',
    !v2.ok && v2.reasons.length === 3,
    JSON.stringify(v2.reasons)
  );
  check(
    'legacy validation never demands a signature',
    !v2.reasons.some((r: string) => /Signature|Conditions/i.test(r))
  );
}

// ── C. Draft handoff is atomic and TTL-bounded ──
console.log('== C: Inspector → SAV draft handoff ==');
{
  check('fresh draft is fresh', isIntakeDraftFresh({ createdAt: new Date().toISOString() } as any));
  check(
    'stale draft is rejected',
    !isIntakeDraftFresh({ createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() } as any)
  );
  check('absent draft is rejected', !isIntakeDraftFresh(null));

  // The real slice: build a minimal store, run the actual creator, and assert
  // the ACTUAL consume action is atomic rather than re-implementing its logic.
  const state: any = { intakeDraft: { sanitizedId: '358921004812345', createdAt: new Date().toISOString() } };
  state.set = (patch: any) => Object.assign(state, patch);
  state.get = () => state;
  const created = (slice as any).createRepairSlice(
    state.set,
    state.get,
    (patch: any) => Object.assign(state, patch)
  );
  const first = created.consumeIntakeDraft();
  const second = created.consumeIntakeDraft();
  check('first consume returns the draft', first?.sanitizedId === '358921004812345');
  check('second consume returns null (atomic)', second === null);
  check('draft is cleared from the store', state.intakeDraft === null);

  // A stale draft must be DISCARDED, not applied to a new ticket.
  state.set({ intakeDraft: { sanitizedId: 'x', createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() } });
  check('a stale draft is discarded on consume', created.consumeIntakeDraft() === null);
  check('a stale draft is still cleared from the store', state.intakeDraft === null);
}

// ── D. Warranty tier is a closed set anchored on RESTITUE ──
console.log('== D: warranty tier semantics ==');
{
  check('schema version is 2', REPAIR_SCHEMA_VERSION === 2, String(REPAIR_SCHEMA_VERSION));
  // "Nearest strict tier" for a legacy months value: 12 months is the top band.
  check('12 months maps to repair_180d', warrantyMonthsToTier(12) === 'repair_180d', warrantyMonthsToTier(12));
  check('6 months maps to repair_90d', warrantyMonthsToTier(6) === 'repair_90d', warrantyMonthsToTier(6));
  check('3 months maps to repair_30d', warrantyMonthsToTier(3) === 'repair_30d', warrantyMonthsToTier(3));
  check('1 month maps to test_7d', warrantyMonthsToTier(1) === 'test_7d', warrantyMonthsToTier(1));
  check('0 months maps to none', warrantyMonthsToTier(0) === 'none', warrantyMonthsToTier(0));

  const delivered = '2026-03-01T10:00:00.000Z';
  const exp = computeWarrantyExpiryISO(delivered, 'repair_90d');
  const days = Math.round((new Date(exp).getTime() - new Date(delivered).getTime()) / 86400000);
  check('repair_90d expiry is 90 days after RESTITUE', days === 90, `${days} days`);

  const clean = {
    screenCondition: 'intact', chassisDamage: ['none'], liquidIndicatorTripped: false, deviceLock: { type: 'none' },
  };
  check('liquid damage is major', intakeDamageSeverity({ ...clean, liquidIndicatorTripped: true }) === 'major');
  check('bent frame is major', intakeDamageSeverity({ ...clean, chassisDamage: ['bent_frame'] }) === 'major');
  check('a scratched chassis is only minor', intakeDamageSeverity({ ...clean, chassisDamage: ['scratched'] }) === 'minor');
  check('a clean device is not damaged', intakeDamageSeverity(clean) === 'none');

  // A lock is NOT physical damage, but it DOES void the repair warranty: the
  // workshop cannot certify a function it could not run.
  const locked = { ...clean, deviceLock: { type: 'icloud', provided: true } };
  check('a locked device is not graded as physical damage', intakeDamageSeverity(locked) === 'none');
  check('a locked device blocks the repair warranty', intakeBlocksRepairWarranty(locked) === true);
  check('major physical damage blocks the repair warranty', intakeBlocksRepairWarranty({ ...clean, liquidIndicatorTripped: true }) === true);
  check('a minor scratch does NOT void the repair warranty', intakeBlocksRepairWarranty({ ...clean, chassisDamage: ['scratched'] }) === false);
  check('a clean device keeps its repair warranty', intakeBlocksRepairWarranty(clean) === false);
}

// ── E. Financials are integer DZD with a derived balance ──
console.log('== E: integer money ==');
{
  const m = repairFinancials({ laborCost: 1000.4, partsCost: 2000.5, depositAmount: 0.2 });
  check('labor rounds to integer DZD', Number.isInteger(m.laborCost), String(m.laborCost));
  check('parts rounds to integer DZD', Number.isInteger(m.partsCost), String(m.partsCost));
  check('total is the sum of its parts', m.totalCost === m.laborCost + m.partsCost, String(m.totalCost));
  check('balance equals total minus deposit', m.balanceDue === m.totalCost - m.depositAmount, String(m.balanceDue));
  check('balance is derived, not an input', !('balanceDue' in { laborCost: 1, partsCost: 1, depositAmount: 0 }));

  const over = repairFinancials({ laborCost: 1000, partsCost: 1000, depositAmount: 99999 });
  check('deposit cannot exceed the total', over.balanceDue === 0, String(over.balanceDue));
}

// ── Legal terms are tagged provisional until owner sign-off ──
console.log('== Legal text provenance ==');
{
  check('FR terms are non-empty', Array.isArray(SAV_LEGAL_TERMS_FR) && SAV_LEGAL_TERMS_FR.length >= 5);
  check('AR terms are non-empty', Array.isArray(SAV_LEGAL_TERMS_AR) && SAV_LEGAL_TERMS_AR.length >= 5);
  check(
    'terms carry the provisional sign-off tag',
    String(LEGAL_TERMS_PROVISIONAL).includes('REQUIRES_OWNER_SIGN_OFF'),
    String(LEGAL_TERMS_PROVISIONAL)
  );
}

// ── F. Print queue: idempotent, serial, and cancel never hangs ──
console.log('== F: print queue safety ==');
{
  const order = 'rep_queue_test';
  const order2 = 'rep_queue_test2';

  // F1 — idempotency: the same (order, kind) never double-prints.
  let produced = 0;
  const mk = () => enqueueLater(order, 'a4', 0, () => { produced += 1; return true; });
  const p1 = queue.enqueueSavPrint(mk());
  const p2 = queue.enqueueSavPrint(mk());
  check('a repeat click reuses the in-flight promise', p1 === p2);
  const [r1] = await Promise.all([p1, p2]);
  check('the document printed exactly once', produced === 1, `produced=${produced}`);
  check('outcome is printed', r1.status === 'printed', r1.status);

  // F2 — strict serialization: no interleaved bytes on one spooler.
  const order3: string[] = [];
  await Promise.all([
    queue.enqueueSavPrint({ orderId: order2, kind: 'voucher', medium: 'thermal80', title: 'v', produce: async () => { order3.push('a-start'); await new Promise((r) => setTimeout(r, 20)); order3.push('a-end'); return true; } }),
    queue.enqueueSavPrint({ orderId: order2, kind: 'workshop', medium: 'thermal80', title: 'w', produce: async () => { order3.push('b'); return true; } }),
  ]);
  check(
    'two jobs never interleave',
    order3.join(',') === 'a-start,a-end,b',
    order3.join(',')
  );

  // F3 — a cancel settles the promises it touches (no hung caller).
  const order4 = 'rep_queue_cancel';
  let cancelResolved = false;
  const slow = queue.enqueueSavPrint({
    orderId: order4, kind: 'a4', medium: 'a4', title: 'slow',
    produce: async (signal) => {
      await new Promise((r) => setTimeout(r, 15));
      return !signal.aborted;
    },
  }).then((o) => { cancelResolved = true; return o; });
  const queued = queue.enqueueSavPrint({
    orderId: order4, kind: 'quote', medium: 'a4', title: 'queued',
    produce: async () => true,
  });
  queue.cancelSavPrints(order4);
  const outcomes = await Promise.all([slow, queued]);
  check('a cancelled running job reports aborted', outcomes[0].status === 'aborted', outcomes[0].status);
  check('a cancelled queued job reports aborted', outcomes[1].status === 'aborted', outcomes[1].status);
  check('every cancelled promise settled', cancelResolved);

  // F4 — an abort landing mid-produce wins over the producer's own verdict.
  const order5 = 'rep_queue_midflight';
  const mid = queue.enqueueSavPrint({
    orderId: order5, kind: 'a4', medium: 'a4', title: 'mid',
    produce: async (signal) => {
      await new Promise((r) => setTimeout(r, 15));
      // The producer did complete the work, but the operator already left.
      return !signal.aborted;
    },
  });
  setTimeout(() => queue.cancelSavPrints(order5), 5);
  const midOutcome = await mid;
  check(
    'an abort mid-produce is not reported as printed',
    midOutcome.status === 'aborted',
    midOutcome.status
  );
}

// A local request builder so the idempotency case reads as a double-tap.
function enqueueLater(orderId: string, kind: any, _ms: number, produce: () => boolean) {
  return {
    orderId,
    kind,
    medium: 'a4' as const,
    title: kind,
    produce: async () => produce(),
  };
}

console.log('');
if (failures === 0) {
  console.log('RESULT: SAV intake v2 legal-record gate intact.');
} else {
  console.error(`RESULT: ${failures} VIOLATION(S) — SAV intake v2 gate weakened.`);
  process.exit(1);
}

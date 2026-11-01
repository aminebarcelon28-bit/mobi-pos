/**
 * D6 parity test — aggregated tranche ranges must grant/revoke the SAME money and
 * the SAME tranche count as the legacy one-row-per-tranche model.
 *
 * Run: node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_milestone_ranges.mts
 */
import {
  evaluateSpendMilestones,
  computeMilestoneClawback,
  reconcileMilestoneTranches,
  activeTrancheCount,
  netMilestoneGrants,
  milestoneRangeKey,
  parseMilestoneRef,
  normalizeLoyaltyConfig,
  DEFAULT_LOYALTY_CONFIG,
} from '../src/utils/loyaltyEngine.ts';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}
function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

const CUST = 'C-RANGE';
const cfg = normalizeLoyaltyConfig(DEFAULT_LOYALTY_CONFIG);
// Default config: one repeatable milestone every 20 000 DA, 1 000 DA reward.
const TH = 20_000;
const REWARD = 1_000;

/** Reference (legacy per-tranche) money for a cumulative spend. */
const legacyMoney = (spent: number): number => Math.floor(spent / TH) * REWARD;

console.log('milestone tranche ranges — D6 parity');

check('a 4e9 sale writes ONE row worth 200 000 tranches', () => {
  const r = evaluateSpendMilestones(CUST, 0, 4_000_000_000, cfg, [], 0);
  eq(r.entries.length, 1, 'one ledger row');
  eq(r.totalReward, legacyMoney(4_000_000_000), 'money equals the per-tranche model');
  const ref = parseMilestoneRef(r.entries[0].referenceId, CUST, r.awards[0].milestoneId);
  eq(ref?.from, 1, 'range starts at tranche 1');
  eq(ref?.to, 200_000, 'range ends at tranche 200 000');
  eq(ref?.count, 200_000, 'count');
  eq(r.entries[0].creditDeltaDzd, legacyMoney(4_000_000_000), 'credit delta is the total');
});

check('a refund revokes the un-crossed range in ONE row with the right money', () => {
  const sale = evaluateSpendMilestones(CUST, 0, 4_000_000_000, cfg, [], 0);
  const ledger = sale.entries;
  const cb = computeMilestoneClawback(CUST, 4_000_000_000, 2_000_000_000, cfg, {
    txnId: 'TXN-1',
    awards: sale.awards,
    ledger,
  });
  eq(cb.entries.length, 1, 'one revocation row');
  eq(cb.totalRevoked, 100_000 * REWARD, 'revoked money = 100 000 tranches');
  eq(cb.entries[0].creditDeltaDzd, -(100_000 * REWARD), 'negative total');
  eq(activeTrancheCount([...ledger, ...cb.entries], CUST, sale.awards[0].milestoneId), 100_000, 'active count drops');
});

check('a later sale resumes from the active high-water (no re-grant)', () => {
  const sale = evaluateSpendMilestones(CUST, 0, 4_000_000_000, cfg, [], 0);
  const cb = computeMilestoneClawback(CUST, 4_000_000_000, 2_000_000_000, cfg, {
    txnId: 'TXN-1',
    awards: sale.awards,
    ledger: sale.entries,
  });
  const ledger = [...sale.entries, ...cb.entries];
  const again = evaluateSpendMilestones(CUST, 2_000_000_000, 3_000_000_000, cfg, ledger, 0);
  eq(again.entries.length, 1, 'one top-up row');
  const ref = parseMilestoneRef(again.entries[0].referenceId, CUST, again.awards[0].milestoneId);
  eq(ref?.from, 100_001, 'starts after the active high-water');
  eq(ref?.to, 150_000, 'ends at the new index');
  eq(again.totalReward, 50_000 * REWARD, 'only the new tranches are granted');
});

check('legacy per-tranche rows are still understood (no double grant)', () => {
  const legacy = Array.from({ length: 5 }, (_, i) => ({
    id: `L${i}`,
    customerId: CUST,
    type: 'milestone',
    points: 0,
    balanceAfter: 0,
    description: 'Palier 20k',
    referenceId: `${CUST}:milestone:ms-20k:tranche:${i + 1}`,
    creditDeltaDzd: REWARD,
    milestoneRewardDzd: REWARD,
    milestoneThresholdDzd: TH,
    timestamp: '2026-01-01T00:00:00Z',
  }));
  eq(activeTrancheCount(legacy as never, CUST, 'ms-20k'), 5, 'legacy rows count individually');
  eq(netMilestoneGrants(legacy as never, CUST, 'ms-20k', 5), 1, 'tranche 5 already granted');
  eq(netMilestoneGrants(legacy as never, CUST, 'ms-20k', 6), 0, 'tranche 6 not granted');
  const next = evaluateSpendMilestones(CUST, 100_000, 140_000, cfg, legacy as never, 0);
  eq(next.entries.length, 1, 'top-up from legacy state');
  const ref = parseMilestoneRef(next.entries[0].referenceId, CUST, 'ms-20k');
  eq(ref?.from, 6, 'starts after the legacy rows');
  eq(ref?.to, 7, 'ends at the new index');
});

check('bootstrap of an existing 4e9 customer is ONE row (reconcile)', () => {
  const r = reconcileMilestoneTranches(CUST, 4_000_000_000, cfg, [], 0);
  eq(r.entries.length, 1, 'one catch-up row');
  eq(r.totalReward, legacyMoney(4_000_000_000), 'same total as per-tranche');
});

check('single-tranche grants keep the LEGACY key form', () => {
  const r = evaluateSpendMilestones(CUST, 0, 20_000, cfg, [], 0);
  eq(r.entries.length, 1, 'one row');
  eq(r.entries[0].referenceId, `${CUST}:milestone:ms-20k:tranche:1`, 'legacy single key');
});

check('range key round-trips', () => {
  eq(milestoneRangeKey(CUST, 'ms-20k', 3, 3), `${CUST}:milestone:ms-20k:tranche:3`, 'single');
  eq(milestoneRangeKey(CUST, 'ms-20k', 3, 9), `${CUST}:milestone:ms-20k:tranches:3-9`, 'range');
  const p = parseMilestoneRef(`${CUST}:milestone:ms-20k:tranches:3-9:clawback:TXN-9`, CUST, 'ms-20k');
  eq(p?.clawback, true, 'clawback flagged');
  eq(p?.count, 7, 'count');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

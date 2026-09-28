import {
  calculateCustomerTier,
  calculateEarnedPoints,
  convertPointsToCredit,
  calculateNextTierProgress,
  createLedgerEntry,
  syncCustomerLoyaltyState,
  calculateNetPaidEarnedPoints,
  calculateEarnedPointsForCart,
  canRedeemPoints,
  normalizeLoyaltyConfig,
  trancheIndex,
  milestoneGrantKey,
  milestoneClawbackKey,
  netMilestoneGrants,
  parseLegacyBonusTranches,
  evaluateSpendMilestones,
  computeMilestoneClawback,
  computeSpendReversal,
  reconcileMilestoneTranches,
  ensureCreditGenesis,
  deriveStoreCreditFromLedger,
  isEarnAllowed,
  isRedeemAllowed,
  DEFAULT_LOYALTY_CONFIG,
} from './loyaltyEngine';
import type {
  Customer,
  LoyaltyProgramConfig,
  LoyaltyLedgerEntry,
  MilestoneAward,
  CartItem,
} from '../types/pos';

export const runLoyaltyEngineTests = () => {
  console.log('🧪 Starting End-to-End Loyalty Engine Test Suite...\n');
  let passed = 0;
  let failed = 0;

  const assert = (condition: boolean, testName: string, errorDetails?: string) => {
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}${errorDetails ? ` - ${errorDetails}` : ''}`);
      failed++;
    }
  };

  // Test 1: Tier Resolution by Spend Thresholds
  const tierBronze = calculateCustomerTier(0);
  assert(tierBronze.name === 'Bronze' && tierBronze.pointsMultiplier === 1.0, '0 DA spend resolves to Bronze (1x multiplier)');

  const tierSilver = calculateCustomerTier(50000);
  assert(tierSilver.name === 'Silver' && tierSilver.pointsMultiplier === 1.25, '50,000 DA spend resolves to Silver (1.25x multiplier)');

  const tierGold = calculateCustomerTier(180000);
  assert(tierGold.name === 'Gold' && tierGold.pointsMultiplier === 1.5, '180,000 DA spend resolves to Gold (1.5x multiplier)');

  const tierPlatinum = calculateCustomerTier(350000);
  assert(tierPlatinum.name === 'Platinum' && tierPlatinum.pointsMultiplier === 2.0, '350,000 DA spend resolves to Platinum (2.0x multiplier)');

  const tierVIP = calculateCustomerTier(750000);
  assert(tierVIP.name === 'VIP Diamond' && tierVIP.pointsMultiplier === 2.5, '750,000 DA spend resolves to VIP Diamond (2.5x multiplier)');

  // Test 2: Points Earned Math with Tier Multipliers
  // Sale of 10,000 DA
  const pointsBronze = calculateEarnedPoints(10000, 1.0); // 100 * 1.0 = 100 pts
  assert(pointsBronze === 100, 'Bronze 10,000 DA sale earns 100 pts');

  const pointsGold = calculateEarnedPoints(10000, 1.5); // 100 * 1.5 = 150 pts
  assert(pointsGold === 150, 'Gold (1.5x) 10,000 DA sale earns 150 pts');

  const pointsVIP = calculateEarnedPoints(10000, 2.5); // 100 * 2.5 = 250 pts
  assert(pointsVIP === 250, 'VIP Diamond (2.5x) 10,000 DA sale earns 250 pts');

  // Test 3: Points to Store Credit Conversion Math
  const conversion50 = convertPointsToCredit(50); // 50 pts * 10 = 500 DA credit
  assert(conversion50.creditAmount === 500, '50 pts converts to 500 DA store credit');

  const conversionZero = convertPointsToCredit(0);
  assert(conversionZero.creditAmount === 0, '0 pts converts to 0 DA store credit');

  // Test 4: Next Tier Progress Progression Math
  // Spent 100,000 DA (Between Silver 50k and Gold 150k) -> 50,000 / 100,000 = 50%
  const progressMid = calculateNextTierProgress(100000);
  assert(
    progressMid.currentTier.name === 'Silver' &&
    progressMid.nextTier?.name === 'Gold' &&
    progressMid.progressPercent === 50 &&
    progressMid.remainingSpend === 50000,
    '100,000 DA spend shows Silver tier with 50% progress toward Gold (50,000 DA remaining)'
  );

  const progressMax = calculateNextTierProgress(1000000);
  assert(
    progressMax.currentTier.name === 'VIP Diamond' &&
    progressMax.nextTier === null &&
    progressMax.progressPercent === 100 &&
    progressMax.remainingSpend === 0,
    '1,000,000 DA spend shows VIP Diamond tier with 100% progress and no remaining spend'
  );

  // Test 5: Ledger Entry & Customer State Sync
  const mockCustomer: Customer = {
    id: 'CUST-001',
    name: 'Karim Hadj',
    phone: '0555123456',
    email: 'karim@test.dz',
    registeredDevice: 'iPhone 15',
    loyaltyPoints: 120,
    storeCredit: 500,
    pricingTier: 'Retail',
    totalSpent: 160000,
  };

  const synced = syncCustomerLoyaltyState(mockCustomer);
  assert(synced.loyaltyTier === 'Gold', 'Customer with 160,000 DA spent is synced to Gold tier');

  const ledgerEntry = createLedgerEntry(
    mockCustomer.id,
    'earn',
    150,
    synced.loyaltyPoints + 150,
    'Achat REC-123456',
    'TXN-999'
  );
  assert(
    ledgerEntry.points === 150 && ledgerEntry.balanceAfter === 270 && ledgerEntry.type === 'earn',
    'Ledger entry created with correct points and updated balance'
  );

  // ──────────────────────────────────────────────────────────
  // SUITE 6: Config normalization & safe defaults
  // ──────────────────────────────────────────────────────────
  const normalizedDefault = normalizeLoyaltyConfig(undefined);
  assert(
    normalizedDefault.enabled === true &&
      normalizedDefault.tiers.length === 5 &&
      normalizedDefault.tiers[0].id === 'tier-0' &&
      normalizedDefault.tiers[0].minSpend === 0 &&
      normalizedDefault.spendMilestones.length === 1 &&
      normalizedDefault.spendMilestones[0].threshold === 20000 &&
      normalizedDefault.spendMilestones[0].reward === 1000,
    'normalize(undefined) injects default tiers (Tier 0 first) + legacy 20k→1k milestone'
  );

  const legacyCfg = normalizeLoyaltyConfig({
    ...DEFAULT_LOYALTY_CONFIG,
    tiers: undefined,
    spendMilestones: undefined,
    tierThresholds: { silverMinSpend: 40000, goldMinSpend: 150000, platinumMinSpend: 300000, vipDiamondMinSpend: 600000 },
  });
  assert(
    legacyCfg.tiers.length === 5 && legacyCfg.tiers[1].minSpend === 40000,
    'legacy tierThresholds/tierMultipliers map onto dynamic tiers when tiers[] absent'
  );

  const messyCfg = normalizeLoyaltyConfig({
    ...DEFAULT_LOYALTY_CONFIG,
    tiers: [
      { id: 't-gold', name: 'Gold', minSpend: 50000, multiplier: 2, style: { badgeColor: '', bgColor: '', borderColor: '', icon: '🥇' } },
      { id: 't-bad', name: 'Bad', minSpend: -10, multiplier: 1, style: { badgeColor: '', bgColor: '', borderColor: '', icon: '' } },
    ],
    spendMilestones: [
      { id: 'm-bad-th', threshold: 0, reward: 100, repeatable: true },
      { id: 'm-bad-rw', threshold: 5000, reward: -50, repeatable: false },
      { id: 'm-ok', threshold: 5000, reward: 200, repeatable: false },
      { id: 'm-ok', threshold: 9000, reward: 300, repeatable: false },
    ],
  });
  assert(
    messyCfg.tiers.length === 2 &&
      messyCfg.tiers[0].id === 'tier-0' &&
      messyCfg.tiers[0].minSpend === 0 &&
      messyCfg.tiers[1].name === 'Gold' &&
      messyCfg.spendMilestones.length === 1 &&
      messyCfg.spendMilestones[0].id === 'm-ok',
    'normalization injects Tier 0, sorts ascending, drops invalid tiers/milestones + dup ids'
  );

  // ──────────────────────────────────────────────────────────
  // SUITE 7: Dynamic tiers (N-tier resolution + progress + fallback)
  // ──────────────────────────────────────────────────────────
  const threeTierCfg: LoyaltyProgramConfig = {
    ...normalizeLoyaltyConfig(undefined),
    tiers: [
      { id: 'tier-0', name: 'Bronze', minSpend: 0, multiplier: 1, style: { badgeColor: '', bgColor: '', borderColor: '', icon: '🥉' } },
      { id: 't-s', name: 'Silver', minSpend: 30000, multiplier: 1.25, style: { badgeColor: '', bgColor: '', borderColor: '', icon: '🥈' } },
      { id: 't-g', name: 'Gold', minSpend: 80000, multiplier: 1.5, style: { badgeColor: '', bgColor: '', borderColor: '', icon: '🥇' } },
    ],
  };
  assert(calculateCustomerTier(45000, threeTierCfg).name === 'Silver', 'custom 3-tier table resolves Silver at 45k');
  assert(calculateCustomerTier(90000, threeTierCfg).name === 'Gold', 'custom 3-tier table resolves Gold at 90k');
  const threeTierProgress = calculateNextTierProgress(45000, threeTierCfg);
  assert(
    threeTierProgress.currentTier.name === 'Silver' &&
      threeTierProgress.nextTier?.name === 'Gold' &&
      threeTierProgress.remainingSpend === 35000,
    'progress walks dynamic tiers (45k Silver → 35k remaining to Gold)'
  );
  const topProgress = calculateNextTierProgress(200000, threeTierCfg);
  assert(
    topProgress.nextTier === null && topProgress.progressPercent === 100,
    'top dynamic tier is terminal (no next tier)'
  );
  const emptyTierCfg = normalizeLoyaltyConfig({ ...DEFAULT_LOYALTY_CONFIG, tiers: [] });
  assert(
    calculateCustomerTier(999999, emptyTierCfg).name === 'Bronze' &&
      calculateCustomerTier(999999, emptyTierCfg).minSpend === 0,
    'empty tiers[] falls back to Tier 0'
  );
  const legacyTierCustomer: Customer = {
    ...mockCustomer, id: 'CUST-TIER', loyaltyTier: 'VIP Diamond', totalSpent: 60000,
  };
  const resynced = syncCustomerLoyaltyState(legacyTierCustomer, threeTierCfg);
  assert(
    resynced.loyaltyTier === 'Silver',
    'deleted/legacy tier string re-resolves from totalSpent (cache never trusted)'
  );

  // ──────────────────────────────────────────────────────────
  // SUITE 8: Tranche math (FP invariance)
  // ──────────────────────────────────────────────────────────
  assert(trancheIndex(19999.99, 20000) === 1, 'FP boundary 19999.99 resolves to tranche 1');
  assert(trancheIndex(19999.4, 20000) === 0, '19999.4 stays in tranche 0');
  assert(trancheIndex(59999.5, 20000) === 3, '59999.5 resolves to tranche 3');
  assert(trancheIndex(0, 20000) === 0, 'zero spend is tranche 0');
  assert(trancheIndex(50000, 0) === 0, 'non-positive threshold guards to 0');

  // ──────────────────────────────────────────────────────────
  // SUITE 9: Milestone evaluation (one-time vs repeatable, dedup)
  // ──────────────────────────────────────────────────────────
  const cfg20k = normalizeLoyaltyConfig(undefined);
  const leap = evaluateSpendMilestones('c1', 15000, 65000, cfg20k, []);
  assert(
    leap.awards.length === 3 &&
      leap.awards.map((a: MilestoneAward) => a.tranche).join(',') === '1,2,3' &&
      leap.totalReward === 3000 &&
      leap.entries.length === 3 &&
      new Set(leap.entries.map((e: LoyaltyLedgerEntry) => e.referenceId)).size === 3,
    'single sale jumping 3 tranches awards each tranche with distinct ledger keys'
  );
  assert(
    leap.awards.every((a: MilestoneAward) => a.threshold === 20000 && a.rewardAmount === 1000),
    'award snapshots record threshold + rewardAmount'
  );

  const oneTimeCfg: LoyaltyProgramConfig = {
    ...cfg20k,
    spendMilestones: [{ id: 'm1', threshold: 20000, reward: 1000, repeatable: false }],
  };
  const oneTimeFirst = evaluateSpendMilestones('c1', 0, 25000, oneTimeCfg, []);
  assert(
    oneTimeFirst.awards.length === 1 && oneTimeFirst.totalReward === 1000,
    'one-time milestone fires once on crossing'
  );
  const oneTimeAgain = evaluateSpendMilestones(
    'c1', 25000, 45000, oneTimeCfg,
    oneTimeFirst.entries
  );
  assert(oneTimeAgain.awards.length === 0, 'one-time milestone never fires twice');

  const noRetro = evaluateSpendMilestones('c1', 25000, 35000, cfg20k, []);
  assert(noRetro.awards.length === 0, 'tranches below prevSpent are never retro-awarded');

  const withT2 = evaluateSpendMilestones(
    'c1', 15000, 65000, cfg20k,
    [{
      id: 'LEDGER-T2', customerId: 'c1', timestamp: new Date().toISOString(), type: 'milestone',
      points: 0, balanceAfter: 1000, description: 't2', referenceId: milestoneGrantKey('c1', 'ms-20k', 2),
      creditDeltaDzd: 1000,
    }]
  );
  assert(
    withT2.awards.length === 2 &&
      withT2.awards.every((a: MilestoneAward) => a.tranche !== 2) &&
      withT2.totalReward === 2000,
    'pre-granted tranche is skipped via deterministic key dedup'
  );
  assert(
    netMilestoneGrants(withT2.entries.concat([{
      id: 'LEDGER-T2', customerId: 'c1', timestamp: new Date().toISOString(), type: 'milestone',
      points: 0, balanceAfter: 1000, description: 't2', referenceId: milestoneGrantKey('c1', 'ms-20k', 2),
      creditDeltaDzd: 1000,
    }]), 'c1', 'ms-20k', 2) === 1,
    'netMilestoneGrants counts the active grant'
  );

  const legacyLedger: LoyaltyLedgerEntry[] = [{
    id: 'LEDGER-LEG', customerId: 'c1', timestamp: new Date().toISOString(), type: 'bonus',
    points: 0, balanceAfter: 2000, description: "Bonus Palier 20k DZD (+2000 DA d'Avoir) débloqué sur Ticket #REC-1",
    referenceId: 'TXN-1', creditDeltaDzd: 2000,
  }];
  assert(parseLegacyBonusTranches(legacyLedger, 1000) === 2, 'legacy +2000 DA bonus parses to 2 assumed tranches');
  const legacyBridge = evaluateSpendMilestones('c1', 15000, 25000, cfg20k, legacyLedger);
  assert(
    legacyBridge.awards.length === 0,
    'legacy bridge: assumed-claimed tranches are not double-awarded on re-cross'
  );

  const gatedOff = evaluateSpendMilestones(
    'c1', 0, 65000, { ...cfg20k, enabled: false }, []
  );
  assert(gatedOff.awards.length === 0, 'disabled program grants nothing');
  const gatedEarnOff = evaluateSpendMilestones(
    'c1', 0, 65000, { ...cfg20k, enabled: false, disabledMode: 'earn-off-redeem-on' }, []
  );
  assert(gatedEarnOff.awards.length === 0, 'earn-off mode grants no milestones');

  // ──────────────────────────────────────────────────────────
  // SUITE 10: Clawback (crossing vs same-tranche, snapshots, negatives)
  // ──────────────────────────────────────────────────────────
  const claw = computeMilestoneClawback('c1', 65000, 15000, cfg20k, { txnId: 't1', ledger: [] });
  assert(
    claw.revoked.length === 3 && claw.totalRevoked === 3000 && claw.entries.length === 3,
    'refund un-crossing 3 tranches revokes each with its own entry'
  );
  assert(
    claw.entries.every((e: LoyaltyLedgerEntry) => e.type === 'milestone' && (e.creditDeltaDzd || 0) < 0) &&
      claw.entries[0].referenceId === milestoneClawbackKey('c1', 'ms-20k', 3, 't1'),
    'clawback entries are negative milestone entries with deterministic keys'
  );
  const sameTranche = computeMilestoneClawback('c1', 65000, 61000, cfg20k, { txnId: 't2', ledger: [] });
  assert(
    sameTranche.revoked.length === 0 && sameTranche.totalRevoked === 0,
    'partial return inside one tranche yields zero clawback'
  );
  const snapshotClaw = computeMilestoneClawback('c1', 25000, 5000, {
    ...cfg20k,
    spendMilestones: [{ id: 'ms-20k', threshold: 20000, reward: 500, repeatable: true }],
  }, {
    txnId: 't3',
    awards: [{ milestoneId: 'ms-20k', threshold: 20000, rewardAmount: 1000, tranche: 1 }],
    ledger: [],
  });
  assert(
    snapshotClaw.totalRevoked === 1000,
    'clawback reverses the snapshot reward (1000), not the edited live config (500)'
  );

  // ──────────────────────────────────────────────────────────
  // SUITE 11: Re-qualification after refund (no permanent dedup lock)
  // ──────────────────────────────────────────────────────────
  const grantEntries = evaluateSpendMilestones('c1', 0, 25000, cfg20k, [], 0).entries;
  const clawEntries = computeMilestoneClawback('c1', 25000, 5000, cfg20k, {
    txnId: 't9', ledger: grantEntries,
  }).entries;
  const requalify = evaluateSpendMilestones(
    'c1', 5000, 25000, cfg20k, [...grantEntries, ...clawEntries]
  );
  assert(
    requalify.awards.length === 1 && requalify.awards[0].tranche === 1,
    'clawed-back tranche re-qualifies on re-cross (grants − clawbacks == 0)'
  );
  const noRequalify = evaluateSpendMilestones(
    'c1', 5000, 25000, cfg20k, grantEntries
  );
  assert(noRequalify.awards.length === 0, 'active (unclawed) grant is never re-awarded');

  // ──────────────────────────────────────────────────────────
  // SUITE 12: Sweeper (skipped tranches, retired IDs)
  // ──────────────────────────────────────────────────────────
  const sweep = reconcileMilestoneTranches('c1', 65000, cfg20k, []);
  assert(
    sweep.awards.length === 3 && sweep.totalReward === 3000,
    'sweeper catches up 3 missing tranches on a spend leap with no checkout events'
  );
  const sweepPartial = reconcileMilestoneTranches('c1', 65000, cfg20k, grantEntries);
  assert(
    sweepPartial.awards.length === 2 && sweepPartial.awards.every((a: MilestoneAward) => a.tranche !== 1),
    'sweeper skips already-granted tranches'
  );
  const retiredCfg: LoyaltyProgramConfig = { ...cfg20k, spendMilestones: [] };
  const sweepRetired = reconcileMilestoneTranches('c1', 65000, retiredCfg, []);
  assert(
    sweepRetired.awards.length === 0,
    'sweeper never backfills retired milestone IDs'
  );

  // ──────────────────────────────────────────────────────────
  // SUITE 13: Genesis + ledger-derived balances + negative handling
  // ──────────────────────────────────────────────────────────
  const genesisCust: Customer = { ...mockCustomer, id: 'c-gen', storeCredit: 1500, ledger: [] };
  const genesis = ensureCreditGenesis(genesisCust);
  assert(
    genesis !== null &&
      genesis.creditDeltaDzd === 1500 &&
      genesis.referenceId === 'c-gen:credit-genesis',
    'genesis entry freezes the legacy scalar balance once'
  );
  const genesisAgain = ensureCreditGenesis({ ...genesisCust, ledger: genesis ? [genesis] : [] });
  assert(genesisAgain === null, 'genesis is appended exactly once');
  const derived = deriveStoreCreditFromLedger([
    ...(genesis ? [genesis] : []),
    {
      id: 'L-MS', customerId: 'c-gen', timestamp: new Date().toISOString(), type: 'milestone',
      points: 0, balanceAfter: 2500, description: 'ms', referenceId: 'c-gen:milestone:ms-20k:tranche:1',
      creditDeltaDzd: 1000,
    },
    {
      id: 'L-CB', customerId: 'c-gen', timestamp: new Date().toISOString(), type: 'milestone',
      points: 0, balanceAfter: 1500, description: 'claw', referenceId: 'c-gen:milestone:ms-20k:tranche:1:clawback:t1',
      creditDeltaDzd: -1000,
    },
    {
      id: 'L-CV', customerId: 'c-gen', timestamp: new Date().toISOString(), type: 'conversion',
      points: 0, balanceAfter: 4000, description: 'refund wallet', referenceId: 'TXN-X',
      creditDeltaDzd: 2500,
    },
    {
      id: 'L-NODELTA', customerId: 'c-gen', timestamp: new Date().toISOString(), type: 'earn',
      points: 10, balanceAfter: 10, description: 'earn (no credit movement)',
    },
  ]);
  assert(derived === 4000, 'ledger-derived balance sums credit deltas (1500+1000−1000+2500)');
  const negCheck = canRedeemPoints(-500, 10);
  assert(!negCheck.allowed, 'negative store credit is never spendable');

  // ──────────────────────────────────────────────────────────
  // SUITE 14: Gates + multiplier stacking lock-in
  // ──────────────────────────────────────────────────────────
  assert(!isEarnAllowed({ ...cfg20k, enabled: false }), 'disabled program blocks earn');
  assert(!isRedeemAllowed({ ...cfg20k, enabled: false }), 'freeze-all blocks redeem');
  assert(!isEarnAllowed({ ...cfg20k, enabled: false, disabledMode: 'earn-off-redeem-on' }), 'earn-off mode blocks earn');
  assert(
    isRedeemAllowed({ ...cfg20k, enabled: false, disabledMode: 'earn-off-redeem-on' }),
    'earn-off mode still allows redeem'
  );
  assert(isEarnAllowed(cfg20k) && isRedeemAllowed(cfg20k), 'enabled program allows earn + redeem');
  assert(isEarnAllowed(undefined) && isRedeemAllowed(undefined), 'missing config falls back to enabled defaults');

  const stackItem = {
    appliedPrice: 10000, quantity: 1, discount: 0, product: { category: 'Services' },
  } as unknown as CartItem;
  const stacked = calculateNetPaidEarnedPoints([stackItem], 10000, 10000, 1.5, cfg20k, 2);
  assert(stacked === 300, 'multiplier stacks multiplicatively: 100 base × 1.5 tier × 2.0 campaign = 300');

  // ──────────────────────────────────────────────────────────
  // SUITE 15: Granular toggles (points + tier multipliers)
  // ──────────────────────────────────────────────────────────
  const ptsOffCfg: LoyaltyProgramConfig = { ...cfg20k, pointsEnabled: false };
  const noMultCfg: LoyaltyProgramConfig = { ...cfg20k, tierMultipliersEnabled: false };

  // 1. pointsEnabled: false → zero earn, no redeem, milestones unaffected.
  const ptsOffEarn = calculateNetPaidEarnedPoints([stackItem], 10000, 10000, 1.5, ptsOffCfg, 2);
  assert(ptsOffEarn === 0, 'points off yields strictly 0 earned points');
  const ptsOffRedeem = canRedeemPoints(500, 50, 10000, ptsOffCfg);
  assert(
    !ptsOffRedeem.allowed && ptsOffRedeem.reason === 'PROGRAM_DISABLED',
    'points off rejects redemptions with PROGRAM_DISABLED'
  );
  const ptsOffMilestones = evaluateSpendMilestones('c1', 0, 25000, ptsOffCfg, []);
  assert(
    ptsOffMilestones.awards.length === 1 && ptsOffMilestones.totalReward === 1000,
    'points off leaves spend milestones awarding normally'
  );

  // 2. tierMultipliersEnabled: false → Gold/Platinum earn at 1.0x base rate.
  const goldFlat = calculateNetPaidEarnedPoints([stackItem], 10000, 10000, 1.5, noMultCfg, 1);
  assert(goldFlat === 100, 'multipliers off forces Gold 1.5x down to 1.0x base (100 pts)');
  const goldFlatCampaign = calculateNetPaidEarnedPoints([stackItem], 10000, 10000, 2.5, noMultCfg, 2);
  assert(goldFlatCampaign === 200, 'campaigns still apply with tier multipliers off (100 × 2.0)');
  const forCartFlat = calculateEarnedPointsForCart(
    [{ ...stackItem, product: { category: 'Chargeurs' } } as unknown as CartItem],
    10000, 1.5, noMultCfg
  );
  // 100 base × 1.0 (flattened tier) × 1.5 (Chargeurs) × 2.0 (default weekend campaign).
  assert(forCartFlat === 300, 'cart earn path also flattens tiers while keeping category + campaign');

  // 3. Legacy/undefined configs default both toggles to true.
  const legacyToggles = normalizeLoyaltyConfig({ ...DEFAULT_LOYALTY_CONFIG, pointsEnabled: undefined, tierMultipliersEnabled: undefined });
  assert(
    legacyToggles.pointsEnabled === true && legacyToggles.tierMultipliersEnabled === true,
    'legacy configs default both toggles to true'
  );
  const legacyEarn = calculateNetPaidEarnedPoints([stackItem], 10000, 10000, 1.5, legacyToggles, 1);
  assert(legacyEarn === 150, 'legacy config earns unchanged (100 × 1.5)');
  const legacyRedeem = canRedeemPoints(500, 50, 10000, legacyToggles);
  assert(legacyRedeem.allowed, 'legacy config redeems unchanged');

  // ──────────────────────────────────────────────────────────
  // SUITE 16: Phase 2 — snapshots, reversal, Tier-0 pin, convergence
  // ──────────────────────────────────────────────────────────

  // P1: legacy row (no txn snapshots) voided after a config edit revokes
  // the LEDGER-recorded amount, not the live config value.
  const legacyGrantLedger: LoyaltyLedgerEntry[] = [{
    id: 'LEDGER-LEG-GRANT', customerId: 'c-leg', timestamp: new Date().toISOString(),
    type: 'milestone', points: 0, balanceAfter: 1000,
    description: 'Palier 20 000 DZD débloqué (+1000 DA)',
    referenceId: milestoneGrantKey('c-leg', 'ms-20k', 1),
    creditDeltaDzd: 1000, milestoneThresholdDzd: 20000, milestoneRewardDzd: 1000,
  }];
  const editedCfg: LoyaltyProgramConfig = {
    ...cfg20k,
    spendMilestones: [{ id: 'ms-20k', threshold: 20000, reward: 500, repeatable: true }],
  };
  const legacyClaw = computeMilestoneClawback('c-leg', 25000, 5000, editedCfg, {
    txnId: 't-legacy', ledger: legacyGrantLedger,
  });
  assert(
    legacyClaw.totalRevoked === 1000 && legacyClaw.revoked[0]?.reward === 1000,
    'legacy void after config edit revokes ledger snapshot (1000), not live config (500)'
  );
  // Fallback tier 2: grant entry carrying only a credit delta, no snapshots.
  const deltaOnlyLedger: LoyaltyLedgerEntry[] = [{
    id: 'LEDGER-DELTA', customerId: 'c-leg', timestamp: new Date().toISOString(),
    type: 'milestone', points: 0, balanceAfter: 1000, description: 'grant',
    referenceId: milestoneGrantKey('c-leg', 'ms-20k', 1), creditDeltaDzd: 1000,
  }];
  const deltaClaw = computeMilestoneClawback('c-leg', 25000, 5000, editedCfg, {
    txnId: 't-legacy2', ledger: deltaOnlyLedger,
  });
  assert(
    deltaClaw.totalRevoked === 1000,
    'clawback falls back to grant creditDeltaDzd when snapshots are absent'
  );

  // P1: net-spend reversal matches tender actually paid (split cash/Avoir).
  assert(computeSpendReversal(9000, 2000, 1000) === 6000, 'reversal strips avoir+voucher shares (9000−2000−1000)');
  assert(computeSpendReversal(5000, 4000, 2000) === 0, 'reversal floors at zero, never negative');
  assert(computeSpendReversal(10000, 0, 0) === 10000, 'pure-cash refund reverses in full');

  // P2.2: impostor zero-floor tiers cannot displace tier-0.
  const impostorCfg = normalizeLoyaltyConfig({
    ...DEFAULT_LOYALTY_CONFIG,
    tiers: [
      { id: 't-x', name: 'Impostor', minSpend: 0, multiplier: 9, style: { badgeColor: '', bgColor: '', borderColor: '', icon: '' } },
      { id: 'tier-0', name: 'Bronze', minSpend: 0, multiplier: 1, style: { badgeColor: '', bgColor: '', borderColor: '', icon: '' } },
      { id: 't-g', name: 'Gold', minSpend: 50000, multiplier: 2, style: { badgeColor: '', bgColor: '', borderColor: '', icon: '' } },
    ],
  });
  assert(
    impostorCfg.tiers[0].id === 'tier-0' && impostorCfg.tiers.every((t) => t.id === 'tier-0' || t.minSpend > 0),
    'non-tier-0 zero floors are dropped and tier-0 is pinned first'
  );
  assert(
    calculateCustomerTier(0, impostorCfg).name === 'Bronze',
    'zero spend still resolves to the pinned Tier 0'
  );

  // P2.3: two-till convergence on ledger fixtures (deterministic keys dedup).
  const tillA = reconcileMilestoneTranches('c9', 45000, cfg20k, []);
  const tillB = reconcileMilestoneTranches('c9', 45000, cfg20k, []);
  assert(
    tillA.awards.length === 2 && tillB.awards.length === 2,
    'both tills independently derive the same catch-up tranches'
  );
  const merged = [...tillA.entries, ...tillB.entries];
  const byKey = new Map<string, LoyaltyLedgerEntry>();
  for (const e of merged) {
    if (e.referenceId && !byKey.has(e.referenceId)) byKey.set(e.referenceId, e);
  }
  const convergedLedger = [...byKey.values()];
  assert(
    deriveStoreCreditFromLedger(convergedLedger) === 2000,
    'key-deduped merge credits each tranche exactly once (no doubling)'
  );
  const afterMerge = evaluateSpendMilestones('c9', 45000, 65000, cfg20k, convergedLedger, 2000);
  assert(
    afterMerge.awards.length === 1 && afterMerge.awards[0].tranche === 3,
    'post-merge crossing awards only the genuinely new tranche'
  );

  console.log(`\n📊 TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  return { passed, failed, total: passed + failed };
};

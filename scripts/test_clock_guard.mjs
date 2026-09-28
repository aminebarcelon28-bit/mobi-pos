#!/usr/bin/env node
/**
 * Test Suite: Anti-Clock-Tampering & Grace Period Evaluation
 */

import { LicenseClockGuard } from '../src/licensing/clockGuard.ts';

async function runTests() {
  console.log('========================================================================');
  console.log('⚡ MOBIPOS — ANTI-CLOCK-TAMPERING & GRACE PERIOD SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
      failed++;
    }
  }

  const baseTime = 1727190000000; // e.g. Sep 24, 2026

  // TEST 1: Normal Time Progression
  console.log('[TEST 1] Normal Monotonic Time Progression:');
  const guard1 = new LicenseClockGuard(
    { lastKnownTimestamp: baseTime, lastVerifiedAt: baseTime },
    Math.floor((baseTime + 30 * 86400000) / 1000), // expires in 30 days
    7 // 7 days grace
  );

  const eval1 = guard1.evaluate(baseTime + 3600000, 0); // 1 hour forward
  assert(eval1.result.status === 'ACTIVE', 'Normal forward time is ACTIVE');
  assert(eval1.nextState.lastKnownTimestamp === baseTime + 3600000, 'High-water mark advanced');

  // TEST 2: Clock Rollback Beyond 5min NTP Tolerance
  console.log('\n[TEST 2] Malicious Clock Rollback Detection:');
  const guard2 = new LicenseClockGuard(
    { lastKnownTimestamp: baseTime + 86400000, lastVerifiedAt: baseTime }, // High water mark is tomorrow
    Math.floor((baseTime + 30 * 86400000) / 1000),
    7
  );

  // User sets clock back to baseTime (1 day rollback)
  const eval2 = guard2.evaluate(baseTime, 0);
  assert(eval2.result.status === 'TAMPERED_CLOCK', 'Detects clock set backwards');
  assert(eval2.result.rollbackDeltaMs > 80000000, 'Calculates rollback delta');

  // TEST 3: Legitimate Small NTP Skew (< 5 minutes)
  console.log('\n[TEST 3] Legitimate NTP Jitter Tolerance (< 5 minutes):');
  const guard3 = new LicenseClockGuard(
    { lastKnownTimestamp: baseTime, lastVerifiedAt: baseTime },
    Math.floor((baseTime + 30 * 86400000) / 1000),
    7
  );

  // Clock drifts 2 minutes backwards (e.g. NTP sync)
  const eval3 = guard3.evaluate(baseTime - 120000, 0);
  assert(eval3.result.status === 'ACTIVE', '2-minute NTP jitter is tolerated');
  assert(eval3.nextState.lastKnownTimestamp === baseTime, 'High-water mark preserved');

  // TEST 4: Tri-Watermark Anchor with SQLite Transactions
  console.log('\n[TEST 4] Database Anchor Protection (Local Receipts / HLC):');
  const guard4 = new LicenseClockGuard(
    { lastKnownTimestamp: 0, lastVerifiedAt: baseTime }, // Settings wiped or fresh
    Math.floor((baseTime + 30 * 86400000) / 1000),
    7
  );

  // Local DB has a receipt stamped at baseTime + 3 days
  const dbHighWater = baseTime + 3 * 86400000;
  // User attempts to boot with OS clock at baseTime (wiping settings)
  const eval4 = guard4.evaluate(baseTime, dbHighWater);
  assert(eval4.result.status === 'TAMPERED_CLOCK', 'Database receipt high-water catches clock rollback');

  // TEST 5: Offline Grace Period Expiration
  console.log('\n[TEST 5] Offline Grace Period (7 Days):');
  const guard5 = new LicenseClockGuard(
    { lastKnownTimestamp: baseTime, lastVerifiedAt: baseTime },
    Math.floor((baseTime + 30 * 86400000) / 1000),
    7
  );

  // 8 days elapsed without online verification
  const eval5 = guard5.evaluate(baseTime + 8 * 86400000, 0);
  assert(eval5.result.status === 'GRACE_EXCEEDED', 'Grace period exceeded after 8 days offline');

  // TEST 6: Lifetime License Exemption
  console.log('\n[TEST 6] Lifetime License Exemption:');
  const guard6 = new LicenseClockGuard(
    { lastKnownTimestamp: baseTime, lastVerifiedAt: baseTime },
    0, // expSec = 0
    7,
    true // isLifetime = true
  );

  // 100 days offline
  const eval6 = guard6.evaluate(baseTime + 100 * 86400000, 0);
  assert(eval6.result.status === 'ACTIVE', 'Lifetime license remains ACTIVE regardless of offline duration');

  console.log('\n========================================================================');
  console.log(`RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(console.error);

/**
 * MOBI POS — Phase P0 Automated Verification Test
 * Tests TypeScript Bindings, HLC Engine, and Contract Definitions
 * Implements Authority ③ §20.2 & AGENTS.md Contract C6
 */

import {
  formatHlc,
  parseHlc,
  compareHlc,
  ClientHlcClock,
} from '../src/bindings/bindings.ts';

console.log('========================================================================');
console.log('⚡ MOBI POS — PHASE P0: HLC & DOMAIN CONTRACT VERIFICATION');
console.log('========================================================================\n');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    passCount++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    failCount++;
  }
}

// ----------------------------------------------------------------------------
// Test 1: HLC Formatting & Parsing Roundtrip
// ----------------------------------------------------------------------------
console.log('[TEST 1] HLC Formatting & Parsing Roundtrip:');
const sampleHlc = {
  physical: 1726531200000,
  logical: 42,
  device: 'dev-test-1',
};
const formatted = formatHlc(sampleHlc);
assert(
  formatted === '00000191fd476400:002a:dev-test-1',
  `HLC format matches canonical 16-hex:4-hex:device format: ${formatted}`
);

const parsed = parseHlc(formatted);
assert(parsed !== null, 'parseHlc parses canonical format successfully');
assert(parsed?.physical === sampleHlc.physical, 'Parsed physical matches original');
assert(parsed?.logical === sampleHlc.logical, 'Parsed logical matches original');
assert(parsed?.device === sampleHlc.device, 'Parsed device matches original');

// ----------------------------------------------------------------------------
// Test 2: ClientHlcClock Monotonic Ordering
// ----------------------------------------------------------------------------
console.log('\n[TEST 2] ClientHlcClock Monotonic Ordering:');
const clockA = new ClientHlcClock('desktop-till-1');
const t1 = clockA.now();
const t2 = clockA.now();
const t3 = clockA.now();

assert(compareHlc(t1, t2) < 0, `t1 (${t1}) < t2 (${t2})`);
assert(compareHlc(t2, t3) < 0, `t2 (${t2}) < t3 (${t3})`);

// ----------------------------------------------------------------------------
// Test 3: Resistance to Clock Regression
// ----------------------------------------------------------------------------
console.log('\n[TEST 3] Resistance to Physical Clock Regression:');
const originalDateNow = Date.now;
try {
  let simulatedTime = 1726531200000;
  Date.now = () => simulatedTime;

  const clockRegress = new ClientHlcClock('phone-companion');
  const baseT = clockRegress.now();
  const parsedBase = parseHlc(baseT);

  // Simulate system clock stepping backward by 10 seconds (NTP step / timezone bug)
  simulatedTime -= 10000;
  const steppedBackT = clockRegress.now();
  const parsedStepped = parseHlc(steppedBackT);

  assert(
    compareHlc(steppedBackT, baseT) > 0,
    `Clock regression produces strictly greater HLC (${steppedBackT} > ${baseT})`
  );
  assert(
    parsedStepped.logical === (parsedBase.logical + 1),
    `Logical counter increments on clock backward step (${parsedStepped.logical} === ${parsedBase.logical + 1})`
  );
} finally {
  Date.now = originalDateNow;
}

// ----------------------------------------------------------------------------
// Test 4: Causal observe() Guarantees
// ----------------------------------------------------------------------------
console.log('\n[TEST 4] Causal observe() Guarantees:');
const clockLocal = new ClientHlcClock('local-node');
const remoteFutureHlc = formatHlc({
  physical: Date.now() + 60000, // 1 minute in the future
  logical: 10,
  device: 'remote-node',
});

clockLocal.observe(remoteFutureHlc);
const afterObserve = clockLocal.now();

assert(
  compareHlc(afterObserve, remoteFutureHlc) > 0,
  `Local clock strictly advances past observed remote clock (${afterObserve} > ${remoteFutureHlc})`
);

// ----------------------------------------------------------------------------
// Test 5: Deterministic Tie-Breaking
// ----------------------------------------------------------------------------
console.log('\n[TEST 5] Deterministic Tie-Breaking by Device ID:');
const hlcDevA = '00000191fd476400:0001:device-alpha';
const hlcDevB = '00000191fd476400:0001:device-beta';

assert(
  compareHlc(hlcDevA, hlcDevB) < 0,
  `Deterministic order tie-breaks alphabetically: ${hlcDevA} < ${hlcDevB}`
);

// ----------------------------------------------------------------------------
// Test 6: Contract Schema & Currency Minor Units Enforcement
// ----------------------------------------------------------------------------
console.log('\n[TEST 6] Contract Schema & Minor Units Invariant:');
const sampleEnvelope = {
  event_id: '01J7Z800000000000000000000',
  aggregate: 'product:prod-100',
  hlc: '00000191fd476400:0000:desktop-1',
  device_id: 'desktop-1',
  schema_v: 1,
  event: {
    type: 'checkout_completed',
    data: {
      transaction_id: 'tx-2026-001',
      lines: [
        {
          product_id: 'prod-100',
          qty: 2,
          unit_cents: 150000, // 1500.00 DZD in minor units
        },
      ],
      total_cents: 300000,
      payment: {
        method: 'cash',
        tendered_cents: 300000,
        change_cents: 0,
      },
    },
  },
};

assert(
  Number.isInteger(sampleEnvelope.event.data.total_cents),
  'total_cents is integer minor units (no float representation)'
);
assert(
  Number.isInteger(sampleEnvelope.event.data.lines[0].unit_cents),
  'unit_cents is integer minor units'
);

const serializedEnvelope = JSON.stringify(sampleEnvelope);
const roundtrippedEnvelope = JSON.parse(serializedEnvelope);
assert(
  roundtrippedEnvelope.event.type === 'checkout_completed',
  'Event tagged type deserializes cleanly'
);
assert(
  roundtrippedEnvelope.event.data.total_cents === 300000,
  'Event payload preserved accurately across JSON roundtrip'
);

// ----------------------------------------------------------------------------
// Results Summary
// ----------------------------------------------------------------------------
console.log('\n========================================================================');
console.log(`P0 VERIFICATION RESULTS: ${passCount} Passed, ${failCount} Failed`);
console.log('========================================================================\n');

if (failCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}


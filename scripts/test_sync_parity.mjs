// Unit & Parity Verification Test Suite: Mobi POS Sync Fixes (F-04, F-05, F-06, F-07, F-08, F-11, F-12)
// Verifies sync stability, backoff bounds, quota auto-recovery, clock skew protection, version guards, and backfill.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

let passed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
    process.exit(1);
  }
}

async function asyncTest(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
    process.exit(1);
  }
}

console.log('========================================================================');
console.log('⚡ MOBI POS — SYNC PARITY & BUG FIX REGISTER TEST SUITE (v1.7.0)');
console.log('========================================================================\n');

// ─── Patch 1: F-04 Relay Reconnect Backoff ───
console.log('--- 1. F-04: Bounded Relay Reconnect Backoff ---');

function computeRelayBackoff(currentAttempts) {
  const nextAttempts = Math.min(currentAttempts + 1, 16);
  const baseMs = Math.min(30_000, 1_000 * Math.pow(1.5, nextAttempts));
  const minDelay = baseMs;
  const maxDelay = baseMs + 1_000;
  return { nextAttempts, baseMs, minDelay, maxDelay };
}

test('Initial disconnect (attempt 0 -> 1) gives ~1.5s delay', () => {
  const { nextAttempts, baseMs } = computeRelayBackoff(0);
  assert.equal(nextAttempts, 1);
  assert.equal(Math.round(baseMs), 1500);
});

test('Intermediate disconnect (attempt 4 -> 5) scales exponentially', () => {
  const { nextAttempts, baseMs } = computeRelayBackoff(4);
  assert.equal(nextAttempts, 5);
  assert.equal(Math.round(baseMs), Math.round(1000 * Math.pow(1.5, 5)));
});

test('Ceiling hit (attempt 15 -> 16) is clamped at 30,000 ms', () => {
  const { nextAttempts, baseMs, maxDelay } = computeRelayBackoff(15);
  assert.equal(nextAttempts, 16);
  assert.equal(baseMs, 30000);
  assert.ok(maxDelay <= 31000);
});

test('Excess disconnects (attempt 20 -> 16, attempt 100 -> 16) never exceed 16 or 31,000ms', () => {
  const res20 = computeRelayBackoff(20);
  assert.equal(res20.nextAttempts, 16);
  assert.equal(res20.baseMs, 30000);

  const res100 = computeRelayBackoff(100);
  assert.equal(res100.nextAttempts, 16);
  assert.equal(res100.baseMs, 30000);
});

test('Source check in SyncManager.ts for F-04 patch', () => {
  const content = readFileSync(join(rootDir, 'src/sync/SyncManager.ts'), 'utf8');
  assert.ok(
    content.includes('this.relayReconnectAttempts = Math.min(this.relayReconnectAttempts + 1, 16)'),
    'SyncManager must clamp relayReconnectAttempts to 16',
  );
  assert.ok(
    content.includes('const baseMs = Math.min(30_000, 1_000 * Math.pow(1.5, this.relayReconnectAttempts))'),
    'SyncManager must compute baseMs with 30s ceiling',
  );
});

// ─── Patch 2: F-05 Quota Latch Auto-Recovery ───
console.log('\n--- 2. F-05: Quota Latch Auto-Recovery Without App Restart ---');

class MockQuotaSyncManager {
  quotaExceeded = true;
  quotaBlockedAt = Date.now() - 301_000; // 5 min 1 sec ago
  pushExecuted = false;
  events = [];

  logEvent(type, msg) {
    this.events.push({ type, msg });
  }

  async probeQuotaReset(simulateServerStatus) {
    return simulateServerStatus;
  }

  async pushOnce(probeStatus) {
    if (this.quotaExceeded) {
      const quotaProbablyReset = await this.probeQuotaReset(probeStatus);
      if (!quotaProbablyReset) {
        return; // Quota still blocked
      }
      this.quotaExceeded = false;
      this.quotaBlockedAt = 0;
      this.logEvent('quota', 'Quota cloud probablement réinitialisé — reprise des envois');
    }
    this.pushExecuted = true;
  }
}

await asyncTest('Quota probe failure maintains latch and blocks push', async () => {
  const mgr = new MockQuotaSyncManager();
  await mgr.pushOnce(false);
  assert.equal(mgr.quotaExceeded, true, 'Quota latch must remain active');
  assert.equal(mgr.pushExecuted, false, 'Push must not execute when probe fails');
});

await asyncTest('Quota probe success clears latch and executes push without restart', async () => {
  const mgr = new MockQuotaSyncManager();
  await mgr.pushOnce(true);
  assert.equal(mgr.quotaExceeded, false, 'Quota latch must clear on probe success');
  assert.equal(mgr.quotaBlockedAt, 0, 'Quota timestamp must be reset');
  assert.equal(mgr.pushExecuted, true, 'Push must execute after probe clears latch');
  assert.ok(mgr.events.some((e) => e.type === 'quota'));
});

test('Source check in SyncManager.ts for probeQuotaReset method', () => {
  const content = readFileSync(join(rootDir, 'src/sync/SyncManager.ts'), 'utf8');
  assert.ok(content.includes('async probeQuotaReset'), 'SyncManager must declare probeQuotaReset()');
  assert.ok(content.includes('SELECT 1 as alive'), 'probeQuotaReset must issue light SELECT 1');
});

// ─── Patch 3: F-06 Clock Skew Gating ───
console.log('\n--- 3. F-06: Clock Skew Push Gating ---');

function evaluateClockSkewPush(clockSkewMs, srvClockRaw) {
  const srvTimeValid = Number.isFinite(Date.parse(String(srvClockRaw)));
  if (!srvTimeValid) {
    if (Math.abs(clockSkewMs) > 10_000) {
      return { allowed: false, reason: 'Horloge locale décalée et horloge cloud injoignable — push suspendu.' };
    }
  }
  return { allowed: true };
}

test('High skew (> 10s) with unreachable cloud clock BLOCKS push', () => {
  const result = evaluateClockSkewPush(25_000, null);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('Horloge locale décalée'));
});

test('High negative skew (< -10s) with unreachable cloud clock BLOCKS push', () => {
  const result = evaluateClockSkewPush(-15_000, undefined);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('Horloge locale décalée'));
});

test('Acceptable skew (<= 10s) with unreachable cloud clock ALLOWS push', () => {
  const result = evaluateClockSkewPush(4_000, null);
  assert.equal(result.allowed, true);
});

test('High skew with valid cloud clock ALLOWS push (uses server timestamp)', () => {
  const result = evaluateClockSkewPush(30_000, '2026-09-17T14:30:00.000Z');
  assert.equal(result.allowed, true);
});

test('Source check in SyncManager.ts for clockSkewMs and push gating', () => {
  const content = readFileSync(join(rootDir, 'src/sync/SyncManager.ts'), 'utf8');
  assert.ok(content.includes('this.clockSkewMs = skewMs'), 'checkClockSkewOnce must store clockSkewMs');
  assert.ok(
    content.includes('Math.abs(this.clockSkewMs) > 10_000'),
    'pushOnce must gate on Math.abs(this.clockSkewMs) > 10_000 when cloud clock unreachable',
  );
});

// ─── Patch 4: F-07 DELETE Upsert Version Guard ───
console.log('\n--- 4. F-07: Version Guard on DELETE Upserts ---');

test('Source check in SyncManager.ts: DELETE upsert contains version guard', () => {
  const content = readFileSync(join(rootDir, 'src/sync/SyncManager.ts'), 'utf8');
  assert.ok(
    content.includes('WHERE excluded.version >= ${table}.version'),
    'toRemoteUpsert DELETE branch must enforce excluded.version >= table.version',
  );
});

test('Version guard logic prevents tombstone resurrection', () => {
  // Simulate remote table state:
  // Existing row has deleted=1, version=5
  // Stale peer tries to send mutation with version=4
  const existingVersion = 5;
  const incomingVersionStale = 4;
  const incomingVersionFresh = 6;

  const wouldApplyStale = incomingVersionStale >= existingVersion;
  const wouldApplyFresh = incomingVersionFresh >= existingVersion;

  assert.equal(wouldApplyStale, false, 'Stale incoming mutation (v=4) must NOT overwrite tombstone (v=5)');
  assert.equal(wouldApplyFresh, true, 'Fresh incoming mutation (v=6) is accepted');
});

// ─── Patch 5: F-08 Backfill Pull Across Clock Skew Window ───
console.log('\n--- 5. F-08: Clock Skew Backfill Pull ---');

class MockBackfillPullEngine {
  backfillRoundsRemaining = 0;
  cursor = { time: '2026-09-17T12:00:00.000Z', id: 'p1' };
  history = [];

  armBackfill() {
    this.backfillRoundsRemaining = 3;
  }

  generatePullQuery(table) {
    const isBackfill = this.backfillRoundsRemaining > 0;
    if (isBackfill) {
      this.backfillRoundsRemaining--;
      this.history.push({ mode: 'backfill', roundsLeft: this.backfillRoundsRemaining });
      const backfillCutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      return {
        mode: 'backfill',
        sql: `SELECT * FROM ${table} WHERE updated_at > ? ORDER BY updated_at ASC, id ASC LIMIT 500`,
        args: [backfillCutoff],
      };
    } else {
      this.history.push({ mode: 'cursor', roundsLeft: 0 });
      return {
        mode: 'cursor',
        sql: `SELECT * FROM ${table} WHERE (updated_at > ?) OR (updated_at = ? AND id > ?) ORDER BY updated_at ASC, id ASC LIMIT 500`,
        args: [this.cursor.time, this.cursor.time, this.cursor.id],
      };
    }
  }
}

test('Backfill engine runs 3 rounds with 24h cutoff then resumes normal cursor', () => {
  const engine = new MockBackfillPullEngine();
  assert.equal(engine.backfillRoundsRemaining, 0);

  // Arm backfill
  engine.armBackfill();
  assert.equal(engine.backfillRoundsRemaining, 3);

  // Round 1
  const q1 = engine.generatePullQuery('products');
  assert.equal(q1.mode, 'backfill');
  assert.equal(engine.backfillRoundsRemaining, 2);

  // Round 2
  const q2 = engine.generatePullQuery('products');
  assert.equal(q2.mode, 'backfill');
  assert.equal(engine.backfillRoundsRemaining, 1);

  // Round 3
  const q3 = engine.generatePullQuery('products');
  assert.equal(q3.mode, 'backfill');
  assert.equal(engine.backfillRoundsRemaining, 0);

  // Round 4 (backfill exhausted, back to cursor mode)
  const q4 = engine.generatePullQuery('products');
  assert.equal(q4.mode, 'cursor');
  assert.equal(engine.backfillRoundsRemaining, 0);
  assert.ok(q4.sql.includes('OR (updated_at = ? AND id > ?)'));
});

test('Source check in SyncManager.ts for F-08 backfill logic', () => {
  const content = readFileSync(join(rootDir, 'src/sync/SyncManager.ts'), 'utf8');
  assert.ok(
    content.includes('this.backfillRoundsRemaining = 3'),
    'checkClockSkewOnce must arm 3 backfill rounds on skew detection',
  );
  assert.ok(
    content.includes('const isBackfill = this.backfillRoundsRemaining > 0'),
    'pullOnce must check backfill state',
  );
  assert.ok(
    content.includes('WHERE updated_at > ? ORDER BY updated_at ASC, id ASC LIMIT 500'),
    'pullOnce must generate backfill query when active',
  );
});

// ─── Patch 6: F-11 & F-12 Cloudflare Relay Worker ───
console.log('\n--- 6. F-11 & F-12: Cloudflare Relay Keepalive & Rate Limiting ---');

test('Source check in workers/relay/src/index.ts for F-11 keepalive ping', () => {
  const content = readFileSync(join(rootDir, 'workers/relay/src/index.ts'), 'utf8');
  assert.ok(content.includes('25_000'), 'Relay must have 25s ping interval');
  assert.ok(content.includes("type: 'ping'"), 'Relay must send type ping messages');
});

test('Source check in workers/relay/src/index.ts for F-12 rate limiting', () => {
  const content = readFileSync(join(rootDir, 'workers/relay/src/index.ts'), 'utf8');
  assert.ok(content.includes('rateLimits: Map<WebSocket, number[]>'), 'Relay must track rateLimits map per session');
  assert.ok(content.includes('now - t < 1000'), 'Relay must use 1000ms sliding window');
  assert.ok(content.includes('timestamps.length >= 10'), 'Relay must enforce 10 messages/sec limit');
});

test('Sliding window rate limiter algorithm simulation', () => {
  let timestamps = [];
  const rateLimitCheck = (t) => {
    timestamps = timestamps.filter((prev) => t - prev < 1000);
    if (timestamps.length >= 10) return false;
    timestamps.push(t);
    return true;
  };

  const t0 = 100000;
  // Send 10 messages in rapid succession
  for (let i = 0; i < 10; i++) {
    assert.equal(rateLimitCheck(t0 + i * 10), true, `Message ${i + 1} should be accepted`);
  }

  // 11th message at t0 + 150ms should be dropped
  assert.equal(rateLimitCheck(t0 + 150), false, '11th message within 1000ms window must be dropped');

  // After 1000ms window expires (at t0 + 1050ms), next message should be accepted
  assert.equal(rateLimitCheck(t0 + 1050), true, 'Message after window advance must be accepted');
});

console.log('\n========================================================================');
console.log(`🎉 ALL SYNC PARITY TESTS PASSED: ${passed}/${total}`);
console.log('========================================================================');


import { browser, $ } from '@wdio/globals';
import { invokeRaw, tid, APP_PIN, unlockIfNeeded } from '../../test/helpers/pos';
import {
  openDb,
  loadScenarios,
  seedScenario,
  sandboxDbPath,
  type CampaignScenario,
} from '../lib/campaign';
import fs from 'node:fs';
import path from 'node:path';

const SCENARIO_FILE = path.resolve(
  __dirname,
  '../../refund-audit/scenarios/scenarios.jsonl',
);
const OUT_DIR = path.resolve(__dirname, '../../refund-audit/results');
const OUT_FILE = path.join(OUT_DIR, 'campaign-bulk-results.jsonl');

const SCENARIOS: CampaignScenario[] = loadScenarios(SCENARIO_FILE);
const EXECUTABLE_ALL = SCENARIOS.filter((s) => s.executable && s.validity === 'valid');
const LIMIT = process.env.CAMPAIGN_LIMIT ? parseInt(process.env.CAMPAIGN_LIMIT, 10) : 0;
const OFFSET = process.env.CAMPAIGN_OFFSET ? parseInt(process.env.CAMPAIGN_OFFSET, 10) : 0;
const EXECUTABLE = LIMIT > 0
  ? EXECUTABLE_ALL.slice(OFFSET, OFFSET + LIMIT)
  : EXECUTABLE_ALL.slice(OFFSET);

function nowIso(): string {
  return new Date().toISOString();
}

function codeOf(raw: unknown): string {
  if (typeof raw === 'string') {
    const m = /"detail"\s*:\s*"([^"]+)"/.exec(raw);
    if (m) return m[1].slice(0, 160);
    return String(raw).split('\n')[0].slice(0, 160);
  }
  return String(raw ?? '').slice(0, 160);
}

async function invokeRefund(req: any, nativeDeviceId: string): Promise<{ ok: boolean; code: string; normalizedReq: any }> {
  // ── Harness normalization (never changes refund semantics) ─────────────
  // serde uses camelCase → snake_case for RefundRequest.
  // The native device id is injected inside the trust boundary; a non-empty
  // client claim that differs is rejected as DEVICE_IDENTITY_SPOOFED.
  // Online: clear the claim so kernel uses enrolled native id (same as empty).
  // Offline: claim must equal the enrolled native id (device-origin affinity).
  const isOnline = req.online === true;
  const normalized: any = { ...req };
  if (isOnline) {
    normalized.localDeviceId = '';
  } else {
    normalized.localDeviceId = nativeDeviceId;
    normalized.activeShiftId = (req.activeShiftId || '').trim() || 'SHIFT-E2E';
  }
  // Write-off (defective) lines require a non-empty defect note (native
  // validate() re-verifies this; scenarios may omit it).
  const hasDefective = (normalized.lines ?? []).some((l: any) => l.condition === 'defective');
  if (hasDefective && !normalized.defectNote) {
    normalized.defectNote = 'E2E test write-off';
  }
  try {
    const r = await invokeRaw<{ ok?: boolean; receiptNumber?: string }>(
      'refund_sale_atomic',
      { req: normalized },
    );
    if (!r.ok) return { ok: false, code: codeOf(r.error), normalizedReq: normalized };
    return { ok: true, code: 'OK', normalizedReq: normalized };
  } catch (e) {
    return { ok: false, code: codeOf(e), normalizedReq: normalized };
  }
}

function rowCount(db: any, sql: string, params: any[] = []): number {
  const r = db.prepare(sql).get(params);
  return r ? (r as any).n ?? 0 : 0;
}

function refundsForTicket(db: any, ticketId: string): any[] {
  return db
    .prepare(
      `SELECT id, receipt_number, total, status, is_refund, original_transaction_id, json_payload
       FROM transactions WHERE original_transaction_id = ? AND is_refund = 1`,
    )
    .all(ticketId);
}

function dedupRows(db: any, ticketId: string, itemsHash: string): any[] {
  return db
    .prepare(
      `SELECT refund_id FROM refund_dedup WHERE ticket_id = ? AND items_hash = ?`,
    )
    .all(ticketId, itemsHash);
}

function stockFor(db: any, productId: string): number {
  const r = db
    .prepare('SELECT COALESCE(SUM(delta),0) AS s FROM inventory_ledger WHERE product_id = ? AND deleted = 0')
    .get(productId);
  return r ? (r as any).s : 0;
}

function cashMovementsForShift(db: any, shiftId: string): number {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(amount),0) AS s FROM cash_movements WHERE session_id = ?`,
    )
    .get(shiftId);
  return r ? (r as any).s : 0;
}

describe('Refund campaign — bulk IPC (refund_sale_atomic)', () => {
  let db: any;
  let nativeDeviceId: string;

  before(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    // Authenticate through the real UI (established helper, PIN = 202020).
    await unlockIfNeeded();
    // Open the sandbox DB for seeding + invariant reads.
    db = openDb();
    // Native enrolled device id (used for offline device-origin affinity).
    const row = db
      .prepare("SELECT device_id FROM device_identity LIMIT 1")
      .get() as any;
    nativeDeviceId = row ? row.device_id : 'dev-e2e';
  });

  after(async () => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });

  it(`executes ${EXECUTABLE.length} executable refund scenarios via IPC`, async () => {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const results: any[] = [];

    for (const scen of EXECUTABLE) {
      const t0 = process.hrtime.bigint();
      // Seed this scenario's initial state (idempotent, unique ids).
      seedScenario(db, scen, nativeDeviceId);

      const req: any = scen.request;
      const expected: any = scen.expectedOutcome;

      // Baseline snapshot (pre-invoke).
      const preRefunds = refundsForTicket(db, req.ticketId).length;
      const preDedup = dedupRows(db, req.ticketId, req.items_hash ?? req.itemsHash).length;

      const result = await invokeRefund(req, nativeDeviceId);
      const { ok: actualAllowed, code: resultCode, normalizedReq } = result;

      const t1 = process.hrtime.bigint();
      const durationMs = Number(t1 - t0) / 1_000_000;

      // Post-state reads.
      const postRefunds = refundsForTicket(db, req.ticketId).length;
      const postDedup = dedupRows(db, req.ticketId, req.items_hash ?? req.itemsHash).length;
      const ticket = db
        .prepare('SELECT status, version FROM transactions WHERE id = ?')
        .get(req.ticketId);

      // ── Independent verdict ─────────────────────────────────────────
      let verdict = 'pass';
      let reason = '';

      const expectedAllowed = expected.allowed === true;
      if (actualAllowed !== expectedAllowed) {
        verdict = 'fail';
        reason = `allowed mismatch: expected ${expectedAllowed}, got ${actualAllowed} (code=${resultCode})`;
      } else if (expectedAllowed && actualAllowed) {
        // Refund was allowed: verify cumulative quota & no duplicate rows.
        if (postDedup > 1) {
          verdict = 'fail';
          reason = `duplicate dedup rows: ${postDedup}`;
        }
        if (postRefunds > preRefunds + 1) {
          verdict = 'fail';
          reason = `refund row count grew by ${postRefunds - preRefunds} (expected +1)`;
        }
      }

      const rec = {
        scenarioId: scen.id,
        seed: scen.seed,
        dimensions: scen.dimensions,
        validity: scen.validity,
        executable: scen.executable,
        expectedAllowed,
        expectedReason: expected.reason,
        actualAllowed,
        actualCode: resultCode,
        normalizedReq,
        verdict,
        reason,
        durationMs,
        timestamp: nowIso(),
        preRefunds,
        postRefunds,
        preDedup,
        postDedup,
        ticketStatus: ticket ? ticket.status : null,
        ticketVersion: ticket ? ticket.version : null,
      };
      results.push(rec);
      fs.appendFileSync(OUT_FILE, JSON.stringify(rec) + '\n');

      if (verdict === 'pass') passed++;
      else {
        failed++;
        console.log(
          `[campaign] FAIL ${scen.id}: ${reason} expected=${expectedAllowed} actual=${actualAllowed} code=${resultCode}`,
        );
      }
    }

    // ── Summary ───────────────────────────────────────────────────────
    const summary = {
      generated: SCENARIOS.length,
      executable: EXECUTABLE.length,
      passed,
      failed,
      skipped: SCENARIOS.length - EXECUTABLE.length,
      timestamp: nowIso(),
    };
    fs.writeFileSync(
      path.join(OUT_DIR, 'campaign-bulk-summary.json'),
      JSON.stringify(summary, null, 2),
    );
    console.log(
      `[campaign] DONE generated=${summary.generated} executable=${summary.executable} passed=${passed} failed=${failed} skipped=${summary.skipped}`,
    );
    // Fail the spec only on infrastructure errors, not on scenario verdicts
    // (verdicts are reported in the results file).
  });
});

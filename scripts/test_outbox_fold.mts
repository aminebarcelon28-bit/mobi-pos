/**
 * Outbox folding for atomic money lanes (C1: DB-012) — tests for
 * src/sync/outboxFold.ts. Executes the REAL builder output against a
 * disposable libsql file DB mirroring the sync_outbox shape.
 *
 * Proves: row content/keys/args order; ON CONFLICT refreshes payload and
 * resets retry state (later explicit enqueues converge, never duplicate);
 * key derivations match the later paths (existing→idempotency/legacy,
 * new→idempotency/order-); repeated folds are idempotent.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';
import {
  buildOrderOutboxInsert,
  existingRowOutboxKey,
  newReceiptOutboxKey,
} from '../src/sync/outboxFold.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const DB_FILE = 'tmp-outbox-fold.db';

async function main() {
  // 1. Key derivations match the later paths exactly.
  check('existing row keeps its key', existingRowOutboxKey('TX-1', 'idem-abc') === 'idem-abc');
  check('missing key falls back to legacy- (enqueueOrderSync shape)',
    existingRowOutboxKey('TX-1', undefined) === 'legacy-TX-1' &&
    existingRowOutboxKey('TX-1', '') === 'legacy-TX-1');
  check('new receipt keeps its key', newReceiptOutboxKey('REF-1', 'idem-r') === 'idem-r');
  check('new receipt falls back to order- (writeCheckoutAtomic shape)',
    newReceiptOutboxKey('REF-1', undefined) === 'order-REF-1');

  try { rmSync(DB_FILE); } catch { /* fresh */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  const db = createClient({ url: `file:${DB_FILE}` });
  await db.execute(
    `CREATE TABLE sync_outbox (idempotency_key TEXT PRIMARY KEY, entity_type TEXT,
      entity_id TEXT, operation TEXT, payload_json TEXT, status TEXT,
      retry_count INTEGER DEFAULT 0, next_retry_at TEXT, last_error TEXT, updated_at TEXT)`,
  );
  async function outboxRow(key: string) {
    const rs = await db.execute({ sql: 'SELECT * FROM sync_outbox WHERE idempotency_key = ?', args: [key] });
    return rs.rows[0] as unknown as Record<string, unknown> | undefined;
  }

  // 2. Folded insert lands with the canonical shape.
  const first = buildOrderOutboxInsert(
    'TX-1', 'legacy-TX-1',
    { id: 'TX-1', receipt_number: 'REC-1', status: 'VOIDED', total: 500, version: 4, idempotency_key: 'legacy-TX-1', updated_at: 't0' },
    't0',
  );
  await db.execute({ sql: first.sql, args: [...(first.args as unknown[])] });
  const row = await outboxRow('legacy-TX-1');
  check('folded row lands pending UPSERT order lane',
    row?.entity_type === 'order' && row?.entity_id === 'TX-1' && row?.operation === 'UPSERT' && row?.status === 'pending');
  const payload = JSON.parse(String(row?.payload_json ?? '{}')) as Record<string, unknown>;
  check('payload carries money + version + key',
    payload.status === 'VOIDED' && payload.total === 500 && payload.version === 4);

  // 3. Later explicit enqueue refreshes (same key) instead of duplicating.
  const second = buildOrderOutboxInsert(
    'TX-1', 'legacy-TX-1',
    { id: 'TX-1', receipt_number: 'REC-1', status: 'VOIDED', total: 500, version: 5, idempotency_key: 'legacy-TX-1', updated_at: 't1' },
    't1',
  );
  await db.execute({ sql: 'UPDATE sync_outbox SET retry_count = 9, last_error = \'x\' WHERE idempotency_key = ?', args: ['legacy-TX-1'] });
  await db.execute({ sql: second.sql, args: [...(second.args as unknown[])] });
  const refreshed = await outboxRow('legacy-TX-1');
  const payload2 = JSON.parse(String(refreshed?.payload_json ?? '{}')) as Record<string, unknown>;
  check('re-enqueue refreshes payload version', payload2.version === 5);
  check('re-enqueue resets retry state',
    refreshed?.retry_count === 0 && refreshed?.next_retry_at === null && refreshed?.last_error === null);
  const count = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM sync_outbox', args: [] });
  check('no duplicate outbox rows', Number((count.rows[0] as { n: number }).n) === 1);

  // 4. Idempotent replay: same fold twice, one row.
  await db.execute({ sql: second.sql, args: [...(second.args as unknown[])] });
  const count2 = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM sync_outbox', args: [] });
  check('fold replay converges', Number((count2.rows[0] as { n: number }).n) === 1);

  db.close();
  try { rmSync(DB_FILE); } catch { /* cleanup */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  console.log(`\noutbox-fold: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

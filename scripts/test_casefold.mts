/**
 * Casefold identifier lookups (C2: DB-003) — tests for normalizeImeiKey /
 * normalizeVoucherCode plus the fast-path + legacy-fallback + lazy-heal
 * read pattern, executed against a disposable libsql file DB.
 *
 * Proves: normalization contract; fixed queries use the index (SEARCH);
 * mixed-case legacy rows are still found (fallback), healed in place, and
 * fast-pathed thereafter; new writes land normalized.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';
import { normalizeImeiKey, normalizeVoucherCode } from '../src/utils/ids.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const DB_FILE = 'tmp-casefold.db';

async function main() {
  // 1. Normalization contract.
  check('imei trims + uppers', normalizeImeiKey('  ab12cd34  ') === 'AB12CD34');
  check('digits identity', normalizeImeiKey('359881234567890') === '359881234567890');
  check('empty stays empty', normalizeImeiKey('') === '' && normalizeImeiKey(null) === '');
  check('voucher trims + uppers', normalizeVoucherCode(' avoir-9x ') === 'AVOIR-9X');
  check('non-string coerces safely', normalizeVoucherCode(123 as unknown as string) === '123');

  try { rmSync(DB_FILE); } catch { /* fresh */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  const db = createClient({ url: `file:${DB_FILE}` });
  await db.execute('CREATE TABLE credit_vouchers (id TEXT PRIMARY KEY, code TEXT, deleted INTEGER DEFAULT 0)');
  await db.execute('CREATE INDEX idx_code ON credit_vouchers(code)');

  // 2. EXPLAIN: fixed shape uses the index.
  const plan = await db.execute({
    sql: 'EXPLAIN QUERY PLAN SELECT * FROM credit_vouchers WHERE code = ? AND deleted = 0 LIMIT 1',
    args: ['X'],
  });
  const details = (plan.rows as Array<{ detail: string }>).map((r) => String(r.detail)).join(' | ');
  check('fixed query SEARCHes the index (no SCAN)', /SEARCH/i.test(details) && !/SCAN(?!.*USING)/i.test(details), details);

  // 3. Legacy mixed-case row: fast miss → fallback hit → heal → fast hit.
  await db.execute({
    sql: "INSERT INTO credit_vouchers (id, code, deleted) VALUES ('V1', 'Avoir-9x', 0)",
    args: [],
  });
  async function find(codeRaw: string, heal: boolean): Promise<string | null> {
    const code = normalizeVoucherCode(codeRaw);
    if (!code) return null;
    const fast = await db.execute({
      sql: 'SELECT id, code FROM credit_vouchers WHERE code = ? AND deleted = 0 LIMIT 1', args: [code],
    });
    if (fast.rows.length > 0) return String((fast.rows[0] as { id: string }).id);
    const slow = await db.execute({
      sql: 'SELECT id, code FROM credit_vouchers WHERE UPPER(code) = ? AND deleted = 0 LIMIT 1', args: [code],
    });
    const row = slow.rows[0] as { id: string; code: string } | undefined;
    if (!row) return null;
    if (heal) {
      await db.execute({ sql: 'UPDATE credit_vouchers SET code = ? WHERE id = ?', args: [code, row.id] });
    }
    return row.id;
  }
  check('legacy row found via fallback', (await find('avoir-9X', false)) === 'V1');
  await find('AVOIR-9x', true); // heal
  const stored = await db.execute({ sql: 'SELECT code FROM credit_vouchers WHERE id = ?', args: ['V1'] });
  check('fallback heals the row in place',
    String((stored.rows[0] as { code: string }).code) === 'AVOIR-9X');
  check('healed row takes the fast path thereafter', (await find('avoir-9x', false)) === 'V1');
  check('unknown code misses both paths', (await find('NOPE-0', true)) === null);

  // 4. New writes land normalized.
  await db.execute({
    sql: "INSERT INTO credit_vouchers (id, code, deleted) VALUES ('V2', ?, 0)",
    args: [normalizeVoucherCode('bon-42z')],
  });
  const v2 = await db.execute({ sql: 'SELECT code FROM credit_vouchers WHERE id = ?', args: ['V2'] });
  check('write path normalizes', String((v2.rows[0] as { code: string }).code) === 'BON-42Z');

  db.close();
  try { rmSync(DB_FILE); } catch { /* cleanup */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  console.log(`\ncasefold: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

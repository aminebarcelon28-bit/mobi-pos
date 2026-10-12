import { createClient } from '@libsql/client';
import path from 'node:path';
import os from 'node:os';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getTestStock(seq) {
  const rand = mulberry32(42);
  let s = 25;
  for (let i = 1; i <= seq; i++) {
    rand(); rand(); rand(); rand(); rand();
    const st = rand() < 0.05 ? 0 : 1 + Math.floor(rand() * 60);
    if (i === seq) s = st;
  }
  return s;
}

async function run() {
  const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'com.mobi.pos', 'mobi_pos.db');
  const db = createClient({ url: 'file:' + dbPath.replace(/\\/g, '/') });

  // 1. Purge accidental SALE/ADJUST deltas on service items
  await db.execute(
    "DELETE FROM inventory_ledger WHERE (product_id LIKE 'qt-%' OR product_id LIKE 'prod-misc-%') AND reason IN ('SALE', 'ADJUST');"
  );
  await db.execute(
    "UPDATE products SET stock = 999999, category = 'Services' WHERE (id LIKE 'qt-%' OR id LIKE 'prod-misc-%' OR category = 'Services') AND stock < 999999;"
  );

  // 2. Identify products with negative ledger or negative stock, having zero SEED/RECEIVE/ADJUST rows
  const poisoned = await db.execute(`
    SELECT p.id, p.stock, p.json_payload, COALESCE(SUM(l.delta), 0) AS ledger_sum,
           COALESCE(SUM(CASE WHEN l.reason IN ('SEED', 'RECEIVE', 'ADJUST') THEN 1 ELSE 0 END), 0) AS seeds
    FROM products p
    LEFT JOIN inventory_ledger l ON l.product_id = p.id AND l.deleted = 0
    WHERE p.category != 'Services' AND p.id NOT LIKE 'qt-%' AND p.id NOT LIKE 'prod-misc-%'
    GROUP BY p.id
    HAVING (COALESCE(SUM(l.delta), 0) < 0 OR p.stock < 0) AND COALESCE(SUM(CASE WHEN l.reason IN ('SEED', 'RECEIVE', 'ADJUST') THEN 1 ELSE 0 END), 0) = 0
  `);

  console.log('Poisoned products found:', poisoned.rows.length);

  const now = new Date().toISOString();
  for (const p of poisoned.rows) {
    const pid = String(p.id);
    let baselineStock = 0;

    if (p.json_payload) {
      try {
        let parsed = JSON.parse(String(p.json_payload));
        if (parsed && typeof parsed.json_payload === 'string') {
          try { parsed = JSON.parse(parsed.json_payload); } catch {}
        }
        const s = Number(parsed?.stock);
        if (Number.isFinite(s) && s > 0) baselineStock = s;
      } catch {}
    }

    if (baselineStock <= 0) {
      const match = pid.match(/^prod-test-(\d{4})$/);
      if (match) {
        const seq = Number(match[1]);
        const st = getTestStock(seq);
        if (st > 0) baselineStock = st;
      }
    }

    if (baselineStock <= 0) {
      baselineStock = Math.max(25, Math.abs(Number(p.ledger_sum || 0)) + 20);
    }

    const seedKey = `seed-baseline-${pid}`;
    await db.execute({
      sql: `INSERT INTO inventory_ledger (id,product_id,delta,reason,ref_type,ref_id,device_id,idempotency_key,sync_status,created_at,updated_at,deleted)
            VALUES (?,?,?,'SEED','heal','heal-baseline','local',?,'pending',?,?,0)
            ON CONFLICT(id) DO NOTHING`,
      args: [seedKey, pid, baselineStock, seedKey, now, now],
    });
    await db.execute({
      sql: `INSERT INTO sync_outbox (idempotency_key,entity_type,entity_id,operation,payload_json,status)
            VALUES (?,'ledger',?,'UPSERT',?,'pending')
            ON CONFLICT(idempotency_key) DO NOTHING`,
      args: [seedKey, seedKey, JSON.stringify({ id: seedKey, product_id: pid, delta: baselineStock, reason: 'SEED' })],
    });
    await db.execute({
      sql: `UPDATE products SET stock = (SELECT SUM(delta) FROM inventory_ledger WHERE product_id=? AND deleted=0),
            version = version + 1, updated_at=?, sync_status='pending' WHERE id=?`,
      args: [pid, now, pid],
    });

    const rows = await db.execute({ sql: 'SELECT stock, json_payload FROM products WHERE id=?', args: [pid] });
    if (rows.rows?.[0]?.json_payload) {
      try {
        let pj = JSON.parse(String(rows.rows[0].json_payload));
        pj.stock = Number(rows.rows[0].stock ?? baselineStock);
        if (pj.json_payload && typeof pj.json_payload === 'string') {
          try {
            let inner = JSON.parse(pj.json_payload);
            inner.stock = pj.stock;
            pj.json_payload = JSON.stringify(inner);
          } catch {}
        }
        await db.execute({
          sql: 'UPDATE products SET json_payload=? WHERE id=?',
          args: [JSON.stringify(pj), pid],
        });
      } catch {}
    }

    const check = await db.execute({ sql: 'SELECT stock FROM products WHERE id=?', args: [pid] });
    const ledSum = await db.execute({ sql: 'SELECT SUM(delta) as s FROM inventory_ledger WHERE product_id=? AND deleted=0', args: [pid] });
    console.log(`[HEALED] ${pid}: baseline=${baselineStock}, new_stock=${check.rows[0]?.stock}, ledger_sum=${ledSum.rows[0]?.s}`);
  }
}

run().catch(console.error);


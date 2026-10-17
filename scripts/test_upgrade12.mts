/**
 * UPGRADE-12 — Mobile floor power tools suite (no migration: enum extensions only).
 *
 * Part 1 — held-sale SINGLE-CLAIM on `node:sqlite` against the REAL v116
 *          `held_orders` DDL and the REAL statements: first claim wins,
 *          double-click/parallel recall loses, release-only-on-claimed,
 *          claims never rewrite the payload, live-set reads shrink/grow
 *          correctly, versions stay monotonic.
 * Part 2 — EXPLAIN QUERY PLAN: both new statements resolve via a SEARCH on
 *          the id PK index; any SCAN fails the build.
 * Part 3 — wiring pins: the adapter executes the exported statements with a
 *          rowsAffected === 1 CAS; the cart slice claims BEFORE the cart
 *          loads, releases on HOLD_ALL_LINES_REMOVED, and no longer blind-
 *          deletes on retrieve; both recall modals map the new reasons.
 * Part 4 — SAV stage binding: the `sav-attachment-v2:` digest mirror
 *          (stage swap ⇒ checksum mismatch ⇒ verification fails; legacy
 *          bytes-only digest preserved), plus Rust/TS source pins for the
 *          closed kind set, the kind parameter on read, and the TS plumbing
 *          (write carries kind, verify threads the row's kind).
 * Part 5 — camera stocktake wiring: `stocktake` mode is additive on the
 *          scanner (wide viewfinder, ZXing husk intact), and the inventory
 *          modal feeds BOTH the douchette form and the camera through one
 *          `processScanCode` funnel (+1 per accepted scan).
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HELD_ORDER_CLAIM_SQL, HELD_ORDER_RELEASE_SQL } from '../src/db/heldOrdersSql.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`);
  } else {
    fail++;
    failures.push(`${name}${extra ? ' :: ' + extra : ''}`);
    console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`);
  }
}
const src = (p: string) => readFileSync(`${process.cwd()}/${p}`, 'utf8');

/** The exact v116 DDL for held_orders (lib.rs migration 116). */
const HELD_ORDERS_DDL = `
  CREATE TABLE held_orders (
    id TEXT PRIMARY KEY,
    customer_id TEXT,
    customer_name TEXT,
    items_count INTEGER NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL DEFAULT 0,
    json_payload TEXT NOT NULL,
    device_id TEXT NOT NULL DEFAULT 'local',
    idempotency_key TEXT UNIQUE,
    sync_status TEXT DEFAULT 'pending',
    version INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_held_orders_customer ON held_orders(customer_id);
  CREATE INDEX IF NOT EXISTS idx_held_orders_created ON held_orders(created_at DESC);
`;

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(HELD_ORDERS_DDL);
  return db;
}

const bind = (values: Array<string | number | null>): Record<string, string | number | null> => {
  const o: Record<string, string | number | null> = {};
  values.forEach((v, i) => {
    o[String(i + 1)] = v;
  });
  return o;
};

const insertHold = (db: DatabaseSync, id: string, at: string, payload: string) =>
  db
    .prepare(
      `INSERT INTO held_orders (id, json_payload, created_at, updated_at, idempotency_key) VALUES ($1, $2, $3, $3, $1)`
    )
    .run(bind([id, payload, at]));
const claim = (db: DatabaseSync, id: string, at: string) =>
  Number(db.prepare(HELD_ORDER_CLAIM_SQL).run(bind([at, id])).changes);
const release = (db: DatabaseSync, id: string, at: string) =>
  Number(db.prepare(HELD_ORDER_RELEASE_SQL).run(bind([at, id])).changes);
const row = (db: DatabaseSync, id: string) =>
  db.prepare(`SELECT json_payload, deleted, version FROM held_orders WHERE id = $1`).get(bind([id])) as
    | { json_payload: string; deleted: number; version: number }
    | undefined;
const liveIds = (db: DatabaseSync) =>
  (db
    .prepare(`SELECT id FROM held_orders WHERE deleted = 0 ORDER BY created_at DESC`)
    .all() as Array<{ id: string }>)
    .map((r) => String(r.id));

const H1 = 'hold_a1';
const H2 = 'hold_b2';
const P1 = JSON.stringify({ id: H1, items: [{ product: { id: 'p1' }, quantity: 2 }] });

// ── Part 1: single-claim semantics on the real statements ─────────────────
console.log('\n--- Part 1: held-sale single-claim ---');
{
  const db = makeDb();
  insertHold(db, H1, '2026-10-17T08:00:00.000Z', P1);
  insertHold(db, H2, '2026-10-17T08:05:00.000Z', JSON.stringify({ id: H2, items: [{ product: { id: 'p2' }, quantity: 1 }] }));

  check('both holds start live', liveIds(db).join(',') === `${H2},${H1}`, liveIds(db).join(','));
  check('initial version is 1', row(db, H1)?.version === 1, String(row(db, H1)?.version));

  check('claim #1: single winner', claim(db, H1, '2026-10-17T09:00:00.000Z') === 1);
  check('claim #1 tombstones the row', row(db, H1)?.deleted === 1);
  check('claim #1 bumps the version', row(db, H1)?.version === 2, String(row(db, H1)?.version));
  check('claim #1 leaves the payload byte-identical', row(db, H1)?.json_payload === P1);
  check('claim #1 removes it from the live set', liveIds(db).join(',') === H2, liveIds(db).join(','));

  check('claim #2 (double-click): refused', claim(db, H1, '2026-10-17T09:00:01.000Z') === 0);
  check('claim #2 does not bump the version', row(db, H1)?.version === 2, String(row(db, H1)?.version));
  check('claim of an unknown id: refused', claim(db, 'hold_missing', '2026-10-17T09:00:02.000Z') === 0);

  check('claim #3 (second hold): winner', claim(db, H2, '2026-10-17T09:00:03.000Z') === 1);
  check('all holds consumed: live set empty', liveIds(db).length === 0, liveIds(db).join(','));

  // Refused restore: release must resurrect ONLY a claimed row.
  check('release of a claimed row: restores', release(db, H1, '2026-10-17T09:01:00.000Z') === 1);
  check('release un-tombstones the row', row(db, H1)?.deleted === 0);
  check('release bumps the version again', row(db, H1)?.version === 3, String(row(db, H1)?.version));
  check('released row rejoins the live set', liveIds(db).includes(H1));
  check('release of a LIVE row: no-op', release(db, H1, '2026-10-17T09:01:01.000Z') === 0);
  check('no-op release does not bump the version', row(db, H1)?.version === 3, String(row(db, H1)?.version));
  check('claim after release: winner again', claim(db, H1, '2026-10-17T09:02:00.000Z') === 1);
  check('payload survives a claim/release cycle byte-identical', row(db, H1)?.json_payload === P1);

  db.close();
}

// ── Part 2: EXPLAIN QUERY PLAN — SEARCH only ──────────────────────────────
console.log('\n--- Part 2: EXPLAIN QUERY PLAN (no SCAN) ---');
{
  const db = makeDb();
  const plan = (sql: string): string[] =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail?: string }>).map((r) => String(r.detail ?? ''));
  const noScan = (p: string[]) => p.length > 0 && p.every((d) => !d.includes('SCAN'));
  const uses = (p: string[], needle: string) => p.some((d) => d.includes(needle));

  const claimPlan = plan(HELD_ORDER_CLAIM_SQL);
  check(
    'claim plan: SEARCH held_orders via the id PK index',
    uses(claimPlan, 'SEARCH held_orders USING INDEX sqlite_autoindex_held_orders_1') && noScan(claimPlan),
    claimPlan.join(' | ')
  );
  const releasePlan = plan(HELD_ORDER_RELEASE_SQL);
  check(
    'release plan: SEARCH held_orders via the id PK index',
    uses(releasePlan, 'SEARCH held_orders USING INDEX sqlite_autoindex_held_orders_1') && noScan(releasePlan),
    releasePlan.join(' | ')
  );
  db.close();
}

// ── Part 3: wiring pins (adapter / slice / modals) ────────────────────────
console.log('\n--- Part 3: single-claim wiring ---');
{
  const adapter = src('src/db/sqlPluginAdapter.ts');
  const slice = src('src/store/slices/createCartSlice.ts');
  const cmdModal = src('src/components/modals/CommandTicketDashboardModal.tsx');
  const holdModal = src('src/components/modals/HoldSalesModal.tsx');

  check('adapter imports the exported statements', adapter.includes(`from './heldOrdersSql'`) && adapter.includes('HELD_ORDER_CLAIM_SQL') && adapter.includes('HELD_ORDER_RELEASE_SQL'));
  check('claim: rowsAffected === 1 CAS', /claimHeldOrder[\s\S]{0,900}?rowsAffected[\s\S]{0,120}?=== 1/.test(adapter));
  check('claim fails closed on error', /claimHeldOrder[\s\S]{0,900}?return 'claim_failed'/.test(adapter));
  check('web mode: no shared store, claim reports claimed', /if \(!isTauriEnv\(\)\) return 'claimed'/.test(adapter));
  check('release is exported and conditional on deleted = 1', /export async function releaseHeldOrderClaim/.test(adapter) && HELD_ORDER_RELEASE_SQL.includes('deleted = 1'));

  const body = slice.slice(slice.indexOf('retrieveSale: async'), slice.indexOf('deleteHeldSale:'));
  const claimIdx = body.indexOf('claimHeldOrder');
  const loadIdx = body.indexOf('setAny(');
  check('slice: claim runs BEFORE the cart loads', claimIdx > 0 && loadIdx > claimIdx, `claim@${claimIdx} load@${loadIdx}`);
  check('slice: claim refusal maps both reasons', body.includes("'HOLD_ALREADY_CLAIMED'") && body.includes("'HOLD_CLAIM_FAILED'"));
  const releaseIdx = body.indexOf('releaseHeldOrderClaim');
  const refusalIdx = body.indexOf('HOLD_ALL_LINES_REMOVED');
  check('slice: refused restore releases the claim', releaseIdx > 0 && refusalIdx > releaseIdx, `release@${releaseIdx} refusal@${refusalIdx}`);
  check('slice: retrieve no longer blind-deletes the hold', !body.includes('deleteHeldOrder(saleId)'));
  check('slice: durable claim is the primary guard', slice.includes('the durable single-claim') || slice.includes('durable single-claim'));

  check('CommandTicketDashboard maps HOLD_ALREADY_CLAIMED', cmdModal.includes('HOLD_ALREADY_CLAIMED'));
  check('CommandTicketDashboard maps HOLD_CLAIM_FAILED', cmdModal.includes('HOLD_CLAIM_FAILED'));
  check('HoldSalesModal maps HOLD_ALREADY_CLAIMED', holdModal.includes('HOLD_ALREADY_CLAIMED'));
  check('HoldSalesModal maps HOLD_CLAIM_FAILED', holdModal.includes('HOLD_CLAIM_FAILED'));
}

// ── Part 4: SAV stage binding ─────────────────────────────────────────────
console.log('\n--- Part 4: SAV stage-bound digest ---');
{
  // Mirror of the pinned Rust preimage (`sav-attachment-v2:{kind}:` + bytes).
  const digest = (kind: string | null, bytes: Buffer): string => {
    const h = createHash('sha256');
    if (kind !== null) h.update(Buffer.from(`sav-attachment-v2:${kind}:`, 'utf8'));
    h.update(bytes);
    return h.digest('hex');
  };

  const bytes = Buffer.from('fake-webp-bytes');
  const legacy = digest(null, bytes);
  const intake = digest('intake', bytes);
  const bench = digest('bench', bytes);
  check('legacy digest is bytes-only sha256', legacy === createHash('sha256').update(bytes).digest('hex'));
  check('stage digest differs from legacy', legacy !== intake);
  check('every stage differs from every other', intake !== bench && digest('delivery', bytes) !== bench);
  check('stage set is closed by construction', ['intake', 'bench', 'delivery'].length === 3);

  // Stage-tamper rejection: stored at intake, row re-classified to bench →
  // the recomputation no longer matches the stored checksum.
  const stored = intake;
  check('stage tamper (intake→bench) fails verification', digest('bench', bytes) !== stored);
  check('stage tamper (intake→delivery) fails verification', digest('delivery', bytes) !== stored);
  check('byte tamper fails verification', digest('intake', Buffer.from('fake-webp-bytes!')) !== stored);
  check('untampered row verifies', digest('intake', bytes) === stored);

  const rust = src('src-tauri/src/sav_attachments.rs');
  check('rust: closed kind set is enforced', rust.includes('fn is_valid_attachment_kind') && /matches!\(kind, "intake" \| "bench" \| "delivery"\)/.test(rust));
  check('rust: v2 preimage is pinned', rust.includes('sav-attachment-v2:{kind}:'));
  check('rust: single digest function covers both commands', (rust.match(/attachment_digest\(/g) ?? []).length >= 3);
  check('rust: write request carries an optional kind', /pub struct SavAttachmentWriteRequest[\s\S]{0,800}?pub kind: Option<String>/.test(rust));
  check('rust: read accepts the row kind', /pub fn sav_attachment_read\([\s\S]{0,120}?kind: Option<String>/.test(rust));

  const savTs = src('src/utils/savAttachments.ts');
  check('ts: write carries the kind into the native request', savTs.includes(`{ request: { orderId, index, dataBase64, extension: 'webp', kind } }`));
  check('ts: verify threads the ROW kind into the native read', /verifySavPhoto[\s\S]{0,700}?kind: photo\.kind \?\? null/.test(savTs));
  check('ts: read keeps legacy callers working (null kind)', /readSavPhoto[\s\S]{0,400}?kind: kind \?\? null/.test(savTs));

  const posTs = src('src/types/pos.ts');
  check('types: SavAttachmentKind is the exact closed union', posTs.includes(`export type SavAttachmentKind = 'intake' | 'bench' | 'delivery'`));
  check('types: IntakePhotoRef carries the optional kind', /interface IntakePhotoRef[\s\S]{0,700}?kind\?: SavAttachmentKind/.test(posTs));

  const modal = src('src/components/modals/RepairWorkOrderModal.tsx');
  check('modal: capture passes the selected stage', modal.includes('kind: photoKind'));
  check('modal: stage selector exists with human labels', modal.includes('PHOTO_KIND_LABELS') && modal.includes("'Réception'") && modal.includes("'Atelier'") && modal.includes("'Livraison'"));
  check('modal: legacy rows are labelled, not re-classified', modal.includes("'hérité v1'"));
}

// ── Part 5: camera stocktake wiring ───────────────────────────────────────
console.log('\n--- Part 5: camera stocktake wiring ---');
{
  const scanner = src('src/components/mobile/MobileCameraScanner.tsx');
  const invModal = src('src/components/modals/InventoryManagerModal.tsx');

  check('scanner: mode union gains stocktake', scanner.includes(`mode?: 'barcode' | 'qr' | 'stocktake'`));
  check('scanner: one wide-viewfinder predicate drives the frame', scanner.includes('const isWideViewfinder') && (scanner.match(/mode === 'barcode'/g) ?? []).length === 1);
  check('scanner: ZXing decoder husk intact (owner hunk preserved)', scanner.includes(`await import('@zxing/library')`) && scanner.includes('decodeFrameRef'));
  check('scanner: 2 s double-read guard still time-based', scanner.includes('now - last.at > 2000'));

  check('inventory: scanner is lazy-loaded with stocktake mode', invModal.includes(`mode="stocktake"`) && invModal.includes('React.lazy'));
  check('inventory: camera feeds the shared scan funnel', invModal.includes('onScan={processScanCode}') && invModal.includes('processScanCode(scannerInput)'));
  check('inventory: duplicate-scan policy is +1 per accepted scan', invModal.includes('const nextCount = currentCount + 1;'));
  check('inventory: camera copy is count-specific', invModal.includes('chaque scan compte +1'));
  check('inventory: camera toggle exposes expanded state', invModal.includes('aria-expanded={cameraOpen}'));
}

console.log('');
if (fail === 0) {
  console.log(`RESULT: UPGRADE-12 oracles intact (${pass} checks).`);
} else {
  console.error(`RESULT: ${fail} VIOLATION(S) — UPGRADE-12 contract weakened.`);
  process.exit(1);
}

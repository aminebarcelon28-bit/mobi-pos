/**
 * UPGRADE-08 — Device Trust Pack suite.
 *
 * Part 1 — trade-in rubric derivation (`src/utils/deviceTrust.ts`):
 *   deterministic markers → suggested grade; hard disqualifiers land on D;
 *   A/B/C read straight off the markers; the operator's grade always wins but
 *   a disagreement is recorded (`inconsistent`) with a visible reason.
 *
 * Part 2 — inspection envelope (`inspection_json`): self-contained round trip.
 *
 * Part 3 — ownership-ledger event ids: deterministic (retry/replay
 *   convergence via INSERT OR IGNORE) and collision-free across kind/ref/imei.
 *
 * Part 4 — blocked-override grant helpers: TTL pruning, freshness, one-shot
 *   consumption.
 *
 * Part 5 — `BlockedDeviceError` + refusal-reason parsing (surface mapping).
 *
 * Part 6 — behavioral SQLite (node:sqlite, in-memory): the exact v123 DDL
 *   semantics — ALTER on an existing trade_ins shape, blocked active-filter,
 *   unblock = deactivate (never delete), re-block re-activates, ledger
 *   idempotency under duplicate appends.
 *
 * Part 7 — wiring pins: migration (native) + heal lane (TS) verbatim parity,
 *   gate/event call sites in every lane, and the UI surfaces that offer (or
 *   refuse) the override.
 */
import { readFileSync } from 'node:fs';
import {
  deriveTradeInGrade,
  buildTradeInInspectionJson,
  parseTradeInInspectionJson,
  imeiTrustEventId,
  pruneBlockedDeviceGrants,
  hasFreshBlockedDeviceGrant,
  consumeBlockedDeviceGrant,
  BlockedDeviceError,
  parseBlockedRefusal,
  BLOCKED_DEVICE_OVERRIDE_TTL_MS,
  INSPECTION_SCREEN_LABELS,
  INSPECTION_BODY_LABELS,
  INSPECTION_WATER_LABELS,
} from '../src/utils/deviceTrust';
import type { TradeInInspectionMarkers } from '../src/types/pos';

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
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

const base: TradeInInspectionMarkers = {
  batteryHealthPercent: 95,
  screen: 'intact',
  body: 'comme_neuf',
  functionalOk: true,
  water: 'aucun',
};

// ── Part 1: rubric derivation ──────────────────────────────────────────────

{
  const a = deriveTradeInGrade(base, 'Grade A (Comme Neuf)');
  check('A: pristine markers → Grade A', a.suggestedGrade === 'Grade A (Comme Neuf)');
  check('A: no reasons', a.reasons.length === 0);
  check('A: chosen matches → consistent', a.inconsistent === false);
}

{
  const b = deriveTradeInGrade({ ...base, batteryHealthPercent: 88, screen: 'micro_rayures', body: 'bon' }, 'Grade B (Bon État)');
  check('B: 88% + micro-rayures + bon → Grade B', b.suggestedGrade === 'Grade B (Bon État)');
  check('B: consistent when chosen B', b.inconsistent === false);
}

{
  const c1 = deriveTradeInGrade({ ...base, batteryHealthPercent: 80 }, 'Grade C (Usagé)');
  check('C: battery 80% → Grade C', c1.suggestedGrade === 'Grade C (Usagé)');
  check('C: battery reason mentions 85%', c1.reasons.some((r) => r.includes('85%') && r.includes('80')));
}

{
  const c2 = deriveTradeInGrade({ ...base, body: 'marque' }, 'Grade C (Usagé)');
  check('C: chassis marqué → Grade C', c2.suggestedGrade === 'Grade C (Usagé)');
  check('C: chassis reason present', c2.reasons.some((r) => r.toLowerCase().includes('usure')));
}

{
  const c3 = deriveTradeInGrade({ ...base, water: 'suspecte' }, 'Grade C (Usagé)');
  check('C: water suspecte → Grade C', c3.suggestedGrade === 'Grade C (Usagé)');
  check('C: humidity reason present', c3.reasons.some((r) => r.includes('humidité')));
}

{
  const d = deriveTradeInGrade({ ...base, water: 'constate' }, 'Grade D (Écran Fissuré)');
  check('D: water constatée → Grade D', d.suggestedGrade === 'Grade D (Écran Fissuré)');
  check('D: water reason present', d.reasons.some((r) => r.includes('eau')));
}

{
  const d = deriveTradeInGrade({ ...base, screen: 'fissure' }, 'Grade D (Écran Fissuré)');
  check('D: écran fissuré → Grade D', d.suggestedGrade === 'Grade D (Écran Fissuré)');
  check('D: screen reason present', d.reasons.some((r) => r.includes('Écran fissuré')));
}

{
  const d = deriveTradeInGrade({ ...base, body: 'deforme' }, 'Grade D (Écran Fissuré)');
  check('D: châssis déformé → Grade D', d.suggestedGrade === 'Grade D (Écran Fissuré)');
}

{
  const d = deriveTradeInGrade({ ...base, functionalOk: false }, 'Grade D (Écran Fissuré)');
  check('D: fonctions non validées → Grade D', d.suggestedGrade === 'Grade D (Écran Fissuré)');
  check('D: functional reason present', d.reasons.some((r) => r.includes('Fonctions')));
}

{
  const d = deriveTradeInGrade({ ...base, batteryHealthPercent: 65 }, 'Grade D (Écran Fissuré)');
  check('D: battery 65% → Grade D', d.suggestedGrade === 'Grade D (Écran Fissuré)');
  check('D: battery reason mentions 70%', d.reasons.some((r) => r.includes('70%')));
}

{
  // Operator chose a GENTLER grade than the rubric allows → flagged + reason.
  const v = deriveTradeInGrade({ ...base, screen: 'fissure' }, 'Grade A (Comme Neuf)');
  check('inconsistent: better-than-rubric choice flagged', v.inconsistent === true);
  check('inconsistent: reason names the gap', v.reasons.some((r) => r.includes('supérieur au référentiel')));
}

{
  // Operator chose a HARSHER grade → also flagged (advisory), no extra reason.
  const v = deriveTradeInGrade(base, 'Grade C (Usagé)');
  check('inconsistent: harsher choice flagged', v.inconsistent === true);
  check('inconsistent: no gap reason for harsher choice', !v.reasons.some((r) => r.includes('supérieur au référentiel')));
}

{
  const hi = deriveTradeInGrade({ ...base, batteryHealthPercent: 250 }, 'Grade A (Comme Neuf)');
  check('clamp: 250% clamps to 100 (still A)', hi.suggestedGrade === 'Grade A (Comme Neuf)');
  const lo = deriveTradeInGrade({ ...base, batteryHealthPercent: -10 }, 'Grade D (Écran Fissuré)');
  check('clamp: -10% clamps to 0 (D)', lo.suggestedGrade === 'Grade D (Écran Fissuré)');
  const nan = deriveTradeInGrade({ ...base, batteryHealthPercent: Number.NaN }, 'Grade D (Écran Fissuré)');
  check('clamp: NaN reads as 0 (D, never throws)', nan.suggestedGrade === 'Grade D (Écran Fissuré)');
}

// ── Part 2: inspection envelope ────────────────────────────────────────────

{
  const raw = buildTradeInInspectionJson(
    { ...base, screen: 'micro_rayures', batteryHealthPercent: 88 },
    'Grade C (Usagé)'
  );
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  check('envelope: version 1', parsed.version === 1);
  check('envelope: markers embedded', (parsed.markers as TradeInInspectionMarkers).batteryHealthPercent === 88);
  check('envelope: suggestedGrade embedded', parsed.suggestedGrade === 'Grade B (Bon État)');
  check('envelope: chosenGrade embedded', parsed.chosenGrade === 'Grade C (Usagé)');
  check('envelope: inconsistent flag', parsed.inconsistent === true);
  check('envelope: reasons array', Array.isArray(parsed.reasons));

  const round = parseTradeInInspectionJson(raw);
  check('envelope: round trip markers', round?.markers.screen === 'micro_rayures');
  check('envelope: round trip suggested', round?.suggestedGrade === 'Grade B (Bon État)');
  check('envelope: garbage parses to null', parseTradeInInspectionJson('{oops') === null);
  check('envelope: missing markers parses to null', parseTradeInInspectionJson('{"version":1}') === null);
}

{
  check('labels: screen map complete', Object.keys(INSPECTION_SCREEN_LABELS).length === 3);
  check('labels: body map complete', Object.keys(INSPECTION_BODY_LABELS).length === 4);
  check('labels: water map complete', Object.keys(INSPECTION_WATER_LABELS).length === 3);
}

// ── Part 3: ownership-ledger event ids ─────────────────────────────────────

{
  const a = imeiTrustEventId('SALE', 'order', 'txn-1', '356789012345678');
  check('id: deterministic', a === imeiTrustEventId('SALE', 'order', 'txn-1', '356789012345678'));
  check('id: namespaced', a.startsWith('imev|SALE|order|txn-1|'));
  check('id: kind distinguishes', a !== imeiTrustEventId('RETURN_IN', 'order', 'txn-1', '356789012345678'));
  check('id: ref distinguishes', a !== imeiTrustEventId('SALE', 'order', 'txn-2', '356789012345678'));
  check('id: imei distinguishes', a !== imeiTrustEventId('SALE', 'order', 'txn-1', '356789012345679'));
  check('id: reconnect (PO nonce) distinguishes', imeiTrustEventId('PO_RECEIVE', 'purchase_order', 'po-1#n1', 'X') !== imeiTrustEventId('PO_RECEIVE', 'purchase_order', 'po-1#n2', 'X'));
}

// ── Part 4: grant helpers ──────────────────────────────────────────────────

{
  const now = 1_000_000;
  const grants = { fresh: now + 5_000, stale: now - 1 };
  const pruned = pruneBlockedDeviceGrants(grants, now);
  check('grants: prune keeps fresh', pruned.fresh === now + 5_000);
  check('grants: prune drops stale', pruned.stale === undefined);
  const untouched = { a: now + 1 };
  check('grants: same-reference no-op when nothing expired', pruneBlockedDeviceGrants(untouched, now) === untouched);

  check('grants: fresh detected', hasFreshBlockedDeviceGrant(grants, 'fresh', now));
  check('grants: stale refused', !hasFreshBlockedDeviceGrant(grants, 'stale', now));
  check('grants: missing refused', !hasFreshBlockedDeviceGrant(grants, 'nope', now));

  const consumed = consumeBlockedDeviceGrant({ a: now + 5_000, b: now + 5_000 }, 'a', now);
  check('grants: consume removes target', consumed.a === undefined);
  check('grants: consume keeps others', consumed.b === now + 5_000);
  check('grants: TTL is 10 minutes', BLOCKED_DEVICE_OVERRIDE_TTL_MS === 600_000);
}

// ── Part 5: BlockedDeviceError + refusal parsing ───────────────────────────

{
  const err = new BlockedDeviceError('356789012345678', 'vol déclaré');
  check('error: instanceof Error', err instanceof Error);
  check('error: identifier kept', err.identifier === '356789012345678');
  check('error: reason kept', err.blockReason === 'vol déclaré');
  check('error: message readable + names reason', err.message.includes('vol déclaré') && err.message.includes('356789012345678'));
  const empty = new BlockedDeviceError('X', '');
  check('error: empty reason falls back', empty.message.includes('sans motif précisé'));

  const p = parseBlockedRefusal('DEVICE_BLOQUE:356789012345678:vol déclaré: suite');
  check('parse: identifier extracted', p?.identifier === '356789012345678');
  check('parse: reason joins trailing colons', p?.reasonText === 'vol déclaré: suite');
  check('parse: non-matching → null', parseBlockedRefusal('OTHER:1:2') === null);
  const ip = parseBlockedRefusal('INTAKE_BLOQUE:1:2', 'INTAKE_BLOQUE:');
  check('parse: custom prefix', ip?.identifier === '1' && ip?.reasonText === '2');
}

// ── Part 6: behavioral SQLite (in-memory) ──────────────────────────────────

{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');

  // Simulate v123 applied to an EXISTING (upgraded-shape) DB: trade_ins
  // already exists, so the ALTER is the only structural change there.
  db.exec('CREATE TABLE trade_ins (id TEXT PRIMARY KEY NOT NULL, json_payload TEXT);');
  db.exec('ALTER TABLE trade_ins ADD COLUMN inspection_json TEXT;');
  db.exec(`CREATE TABLE blocked_imeis (
    imei TEXT PRIMARY KEY NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    added_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );`);
  db.exec('CREATE INDEX idx_blocked_imeis_active ON blocked_imeis(active);');
  db.exec(`CREATE TABLE imei_events (
    id TEXT PRIMARY KEY NOT NULL,
    imei TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref_type TEXT NOT NULL DEFAULT '',
    ref_id TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT ''
  );`);
  db.exec('CREATE INDEX idx_imei_events_imei ON imei_events(imei, at DESC);');

  const alterCols = db.prepare('SELECT name FROM pragma_table_info(?)').all('trade_ins') as Array<{ name: string }>;
  check('sqlite: trade_ins.inspection_json added', alterCols.some((c) => c.name === 'inspection_json'));

  // Blocked upsert → active read → deactivate → re-block reactivates.
  db.prepare('INSERT INTO blocked_imeis (imei, reason, source, added_at, active) VALUES (?, ?, ?, ?, 1)').run('356789012345678', 'vol', 'inspecteur', '2026-10-17T10:00:00.000Z');
  const hit = db.prepare('SELECT imei, reason FROM blocked_imeis WHERE imei = ? AND active = 1 LIMIT 1').get('356789012345678') as { imei?: string } | undefined;
  check('sqlite: blocked lookup hits active row', hit?.imei === '356789012345678');

  db.prepare('UPDATE blocked_imeis SET active = 0 WHERE imei = ?').run('356789012345678');
  const miss = db.prepare('SELECT imei FROM blocked_imeis WHERE imei = ? AND active = 1 LIMIT 1').get('356789012345678');
  check('sqlite: deactivated row is invisible to the screen', miss === undefined);
  const kept = db.prepare('SELECT active FROM blocked_imeis WHERE imei = ?').get('356789012345678') as { active?: number } | undefined;
  check('sqlite: deactivation keeps the row (never deletes)', kept?.active === 0);

  db.prepare(`INSERT INTO blocked_imeis (imei, reason, source, added_at, active) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(imei) DO UPDATE SET reason=excluded.reason, source=excluded.source, added_at=excluded.added_at, active=1`)
    .run('356789012345678', 'vol confirmé', 'inspecteur', '2026-10-17T11:00:00.000Z');
  const again = db.prepare('SELECT reason, active FROM blocked_imeis WHERE imei = ?').get('356789012345678') as { reason?: string; active?: number } | undefined;
  check('sqlite: re-block reactivates + updates reason', again?.active === 1 && again?.reason === 'vol confirmé');
  const rowCount = db.prepare('SELECT COUNT(*) AS n FROM blocked_imeis').get() as { n?: number };
  check('sqlite: upsert never duplicates the key', rowCount.n === 1);

  // Ledger idempotency: duplicate appends (retry/replay) converge.
  const ins = db.prepare('INSERT OR IGNORE INTO imei_events (id, imei, kind, ref_type, ref_id, at, actor, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const id = imeiTrustEventId('SALE', 'order', 'txn-9', '356789012345678');
  ins.run(id, '356789012345678', 'SALE', 'order', 'txn-9', '2026-10-17T12:00:00.000Z', 'Caissier', '');
  ins.run(id, '356789012345678', 'SALE', 'order', 'txn-9', '2026-10-17T12:00:00.000Z', 'Caissier', '');
  const n1 = db.prepare('SELECT COUNT(*) AS n FROM imei_events').get() as { n?: number };
  check('sqlite: duplicate append converges to one row', n1.n === 1);
  ins.run(imeiTrustEventId('RETURN_IN', 'order', 'txn-9', '356789012345678'), '356789012345678', 'RETURN_IN', 'order', 'txn-9', '2026-10-17T13:00:00.000Z', '', 'Annulation de vente');
  const n2 = db.prepare('SELECT COUNT(*) AS n FROM imei_events').get() as { n?: number };
  check('sqlite: distinct events accumulate', n2.n === 2);
  const timeline = db.prepare('SELECT kind FROM imei_events WHERE imei = ? ORDER BY at DESC, id DESC').all('356789012345678') as Array<{ kind: string }>;
  check('sqlite: timeline order newest-first', timeline[0]?.kind === 'RETURN_IN' && timeline[1]?.kind === 'SALE');
  db.close();
}

// ── Part 7: wiring pins ────────────────────────────────────────────────────

{
  const lib = src('src-tauri/src/lib.rs');
  // The ceiling pin re-bumps with each upgrade; UPGRADE-10 landed v125.
  check('lib.rs: expected version bumped to 125', lib.includes('const EXPECTED_MAX_DB_USER_VERSION: u32 = 125;'));
  check('lib.rs: v123 migration present', norm(lib).includes('version: 123, description: "UPGRADE-08: trade_ins.inspection_json, blocked_imeis, imei_events"'));

  const v123Stmts = [
    'ALTER TABLE trade_ins ADD COLUMN inspection_json TEXT;',
    `CREATE TABLE IF NOT EXISTS blocked_imeis ( imei TEXT PRIMARY KEY NOT NULL, reason TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 );`,
    'CREATE INDEX IF NOT EXISTS idx_blocked_imeis_active ON blocked_imeis(active);',
    `CREATE TABLE IF NOT EXISTS imei_events ( id TEXT PRIMARY KEY NOT NULL, imei TEXT NOT NULL, kind TEXT NOT NULL, ref_type TEXT NOT NULL DEFAULT '', ref_id TEXT NOT NULL DEFAULT '', at TEXT NOT NULL, actor TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '' );`,
    'CREATE INDEX IF NOT EXISTS idx_imei_events_imei ON imei_events(imei, at DESC);',
  ];
  const libNorm = norm(lib);
  const sqlAdapter = src('src/db/sqlPluginAdapter.ts');
  const sqlNorm = norm(sqlAdapter);
  for (const stmt of v123Stmts) {
    check(`heal parity: rust contains ${stmt.slice(0, 44)}…`, libNorm.includes(norm(stmt)));
    check(`heal parity: TS contains ${stmt.slice(0, 44)}…`, sqlNorm.includes(norm(stmt)));
  }
  check(
    'heal lane: v123 probes present',
    sqlAdapter.includes('SELECT inspection_json FROM trade_ins LIMIT 0;') &&
      sqlAdapter.includes('SELECT imei, reason, source, added_at, active FROM blocked_imeis LIMIT 0;') &&
      sqlAdapter.includes('SELECT id, imei, kind, ref_type, ref_id, at, actor, note FROM imei_events LIMIT 0;')
  );
  check('heal lane reads probes BEFORE statements execute', sqlAdapter.indexOf('SELECT inspection_json FROM trade_ins LIMIT 0;') < sqlAdapter.indexOf('ALTER TABLE trade_ins ADD COLUMN inspection_json TEXT;'));
  check('sqlPluginAdapter: import of deterministic id builder', sqlAdapter.includes("import { imeiTrustEventId } from '../utils/deviceTrust';"));
  check('sqlPluginAdapter: SALE ledger append in the sale lane', sqlAdapter.includes('INSERT OR IGNORE INTO imei_events') && sqlAdapter.includes("imeiTrustEventId('SALE', 'order', txId, pit.imeiNum)"));

  const adapter = src('src/db/adapters/deviceTrustAdapter.ts');
  check('adapter: canonicalizes at the boundary', adapter.includes('normalizeDeviceKey'));
  check('adapter: blocked read filters active=1', adapter.includes('WHERE imei = $1 AND active = 1 LIMIT 1'));
  check('adapter: unblock deactivates', adapter.includes('UPDATE blocked_imeis SET active = 0 WHERE imei = $1'));
  check('adapter: block upsert reactivates', adapter.includes('ON CONFLICT(imei) DO UPDATE SET') && adapter.includes('active=1'));
  check('adapter: ledger insert-or-ignore', adapter.includes('INSERT OR IGNORE INTO imei_events'));
  check('adapter: unknown state is a distinct verdict', adapter.includes("status: 'unknown'"));
  check('adapter: outside-Tauri reads answer clear', adapter.includes("if (!isTauriEnv()) return { status: 'clear' };"));

  const uiSlice = src('src/store/slices/createUISlice.ts');
  check('uiSlice: grant action present', uiSlice.includes('grantBlockedDeviceOverride: async'));
  check('uiSlice: grant audits BEFORE arming', uiSlice.indexOf("'Dérogation appareil bloqué'") > 0 && uiSlice.indexOf('Dérogation appareil bloqué') < uiSlice.indexOf('BLOCKED_DEVICE_OVERRIDE_TTL_MS'));
  check('uiSlice: processTradeIn blocked gate', uiSlice.includes('const blockVerdict = await checkImeiBlocked(canonicalImei);'));
  check('uiSlice: standalone refusal reason', uiSlice.includes('`DEVICE_BLOQUE:${blockVerdict.imei}:${blockVerdict.reason}`'));
  check('uiSlice: exchange refusal reason', uiSlice.includes('`INTAKE_BLOQUE:${blockVerdict.imei}:${blockVerdict.reason}`'));
  check('uiSlice: TRADE_IN event on standalone intake', uiSlice.includes("kind: 'TRADE_IN',"));
  check('uiSlice: grants consumed only after persistence', uiSlice.indexOf('consumeBlockedDeviceGrant') > uiSlice.indexOf("kind: 'TRADE_IN',"));
  check('uiSlice: unknown denies in standalone lane', uiSlice.includes('DEVICE_CHECK_UNAVAILABLE:${blockVerdict.detail}'));

  const orderSlice = src('src/store/slices/createOrderSlice.ts');
  check('orderSlice: checkout pre-flight helper', orderSlice.includes('async function checkoutDeviceTrustRefusal('));
  check('orderSlice: sale items hard-refused', orderSlice.includes('return `DEVICE_BLOQUE:${verdict.imei}:${verdict.reason}`;'));
  check('orderSlice: staged intake grant-aware', orderSlice.includes('hasFreshBlockedDeviceGrant'));
  check('orderSlice: pre-flight wired into processPayment', orderSlice.includes('const trustRefusal = await checkoutDeviceTrustRefusal('));

  const repairSlice = src('src/store/slices/createRepairSlice.ts');
  check('repairSlice: typed blocked error thrown', repairSlice.includes('throw new BlockedDeviceError(blockVerdict.imei, blockVerdict.reason);'));
  check('repairSlice: REPAIR_INTAKE event', repairSlice.includes("kind: 'REPAIR_INTAKE',"));

  const procSlice = src('src/store/slices/createProcurementSlice.ts');
  check('procurement: PO_RECEIVE events', procSlice.includes("kind: 'PO_RECEIVE' as const,"));
  check('procurement: events keyed by receipt nonce', procSlice.includes('refId: `${poId}#${receiveNonce}`,'));

  const txAdapter = src('src/db/adapters/transactionAdapter.ts');
  const returnInCount = (txAdapter.match(/INSERT OR IGNORE INTO imei_events/g) || []).length;
  check('transactionAdapter: BOTH release lanes append RETURN_IN', returnInCount === 2 && txAdapter.includes("imeiTrustEventId('RETURN_IN', 'order', voidedTransaction.id, imei)") && txAdapter.includes("imeiTrustEventId('RETURN_IN', 'order', refundTransaction.id, imei)"));

  const opsAdapter = src('src/db/adapters/operationsAdapter.ts');
  check('operationsAdapter: trade_ins carries inspection_json', opsAdapter.includes('inspection_json') && opsAdapter.includes('buildTradeInInspectionJson(trade.inspectionMarkers, trade.conditionGrade)'));

  const voucher = src('src/utils/tradeInVoucherBuilder.ts');
  check('voucher: prints rubric markers', voucher.includes('tradeIn.inspectionMarkers') && voucher.includes('INSPECTION_SCREEN_LABELS[m.screen]'));

  const modal = src('src/components/modals/TradeInBuybackModal.tsx');
  check('buyback modal: rubric section renders suggestion', modal.includes('deriveTradeInGrade(inspection, grade)'));
  check('buyback modal: partial override flow', modal.includes('handleGrantBlockedOverride') && modal.includes('grantBlockedDeviceOverride('));
  check('buyback modal: markers ride both payloads', (modal.match(/inspectionMarkers: inspection,/g) || []).length === 2);
  check('buyback modal: blocked refusal arms the panel', modal.includes('parseBlockedRefusal(reason)'));

  const inspector = src('src/components/modals/ImeiWarrantyInspectorModal.tsx');
  check('inspector: trust panel state + mutation', inspector.includes('handleTrustMutation') && inspector.includes('listImeiEvents'));
  check('inspector: audit-before-change for block/unblock', inspector.includes("action === 'block' ? 'Blocage appareil' : 'Déblocage appareil'"));
  check('inspector: timeline labels', inspector.includes('IMEI_TRUST_EVENT_LABELS'));

  const repairModal = src('src/components/modals/RepairWorkOrderModal.tsx');
  check('repair modal: BlockedDeviceError arms override', repairModal.includes('err instanceof BlockedDeviceError') && repairModal.includes('handleGrantBlockedOverride'));

  check('payment modal: blocked refusal mapped', src('src/components/modals/PaymentModal.tsx').includes("startsWith('INTAKE_BLOQUE')"));
  check('cart panel: blocked refusal mapped', src('src/components/CartPanel.tsx').includes("reason.startsWith('DEVICE_BLOQUE') || reason.startsWith('INTAKE_BLOQUE')"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('FAILURES:\n' + failures.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}

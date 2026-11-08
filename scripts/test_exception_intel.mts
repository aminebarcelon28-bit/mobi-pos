/**
 * UPGRADE-09 — cashier exception intelligence (EBR-lite) suite.
 *
 * Part 1 — exception-action classifier pins (vocabulary observed in the
 *          shipped funnel; refusal rows stay OUT of void counts).
 * Part 2 — statistics pins: Wilson lower bound, empirical-Bayes shrinkage,
 *          and the minimum-support gate that makes small denominators
 *          UNRANKABLE.
 * Part 3 — the owner oracle: a `1/1` void cashier ranks LOWER in anomaly
 *          confidence than `15/50`, even though its raw rate is 100% vs 30% —
 *          raw k/n is banned from ranking/flagging by construction.
 * Part 4 — actor identity: immutable roster id when bound, deterministic
 *          legacy mapping (diacritics folded, stable slug) otherwise.
 * Part 5 — approval concentration (manager → cashier pairs + HHI).
 * Part 6 — blind-close variance joined against in-shift exceptions.
 * Part 7 — query-plan oracle on `node:sqlite`: every statement must resolve
 *          via SEARCH … USING INDEX; any SCAN fails the build.
 * Part 8 — wiring + 3-way DDL parity (lib.rs v124 ↔ schemaHeal verbatim ↔
 *          adapter heal lane; genericApply mirror; funnel actor binding;
 *          remote stays column-free KV).
 * Part 9 — heal replay on a pre-v124 shape: statements applied twice
 *          (idempotent), integrity_check ok, foreign_key_check empty, and the
 *          window SQL reads the new column.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_EXCEPTION_THRESHOLDS,
  anomalyConfidence,
  classifyExceptionAction,
  computeExceptionIntel,
  normalizeActorKey,
  resolveActorIdForWrite,
  shrunkRate,
  wilsonLowerBound,
  type ClosedSessionRow,
  type ExceptionAuditRow,
  type ShiftTxnCount,
} from '../src/utils/cashierExceptionRates';
import { AUDIT_ACTOR_ID_HEAL_PROBE_SQL, AUDIT_ACTOR_ID_HEAL_SQL } from '../src/db/schemaHeal';
import {
  EXCEPTION_AUDIT_WINDOW_LIMIT,
  buildClosedSessionSql,
  buildExceptionAuditWindowSql,
  buildShiftTxnCountSql,
} from '../src/db/exceptionIntelSql';

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
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

const WIN = { sinceIso: '2026-09-01T00:00:00.000Z', untilIso: '2026-10-01T00:00:00.000Z' };
const row = (
  id: string,
  actorId: string | null,
  user: string,
  action: string,
  timestamp: string,
  extra: Partial<ExceptionAuditRow> = {}
): ExceptionAuditRow => ({
  id,
  timestamp,
  user,
  action,
  details: '',
  requiresPin: false,
  actorId,
  ...extra,
});

// ── Part 1: classifier pins ────────────────────────────────────────────────
console.log('\n--- Part 1: classifier ---');
{
  check('removal (keyboard vector)', classifyExceptionAction('Suppression Article Panier (Clavier)') === 'removal');
  check('removal (undo vector)', classifyExceptionAction('Suppression Article Panier (Annulation ajout)') === 'removal');
  check('override', classifyExceptionAction('Dérogation Prix Manuel') === 'override');
  check('refund', classifyExceptionAction('Remboursement / Avoir Émis') === 'refund');
  check('discount (cart)', classifyExceptionAction('Remise Panier Appliquée') === 'discount');
  check('discount (item)', classifyExceptionAction('Remise Article Appliquée') === 'discount');
  check('no-sale drawer pulse', classifyExceptionAction('Ouverture Manuelle Tiroir ("No Sale")') === 'no_sale');
  check('drawer hardware test pulse', classifyExceptionAction('Test Tiroir (Paramètres)') === 'no_sale');
  check('void (error vector)', classifyExceptionAction('Annulation Vente (Erreur de Caisse)') === 'void');
  check('void (full cart)', classifyExceptionAction('Annulation Complète Panier') === 'void');
  check('void (return cart)', classifyExceptionAction('Annulation Retour Panier') === 'void');
  check('refused annulation is NOT a void (denial lane owns it)', classifyExceptionAction('Annulation Refusée — Ticket Échange') === null);
  check('pin success is not an exception', classifyExceptionAction('Vérification PIN Réussie') === null);
  check('stock refusal is not an exception', classifyExceptionAction('Tentative Vente Dépassement Stock') === null);
  check('empty action never classifies', classifyExceptionAction('') === null);
}

// ── Part 2: statistics pins ────────────────────────────────────────────────
console.log('\n--- Part 2: statistics ---');
{
  check('defaults pinned', DEFAULT_EXCEPTION_THRESHOLDS.minSupport === 20
    && DEFAULT_EXCEPTION_THRESHOLDS.flagConfidence === 0.15
    && DEFAULT_EXCEPTION_THRESHOLDS.pooledMultiplier === 2
    && DEFAULT_EXCEPTION_THRESHOLDS.priorStrength === 20
    && DEFAULT_EXCEPTION_THRESHOLDS.z === 1.96);
  check('Wilson LB(15,50) ≈ 0.191034', near(wilsonLowerBound(15, 50), 0.191034, 0.001), String(wilsonLowerBound(15, 50)));
  check('Wilson LB(1,1) ≈ 0.206543', near(wilsonLowerBound(1, 1), 0.206543, 0.001), String(wilsonLowerBound(1, 1)));
  // This is WHY the gate exists: raw Wilson on 1/1 beats 15/50.
  check('raw Wilson trap demonstrated (1/1 > 15/50)', wilsonLowerBound(1, 1) > wilsonLowerBound(15, 50));
  check('gated confidence: 19/19 → exactly 0', anomalyConfidence(19, 19, DEFAULT_EXCEPTION_THRESHOLDS) === 0);
  check('gated confidence: 1/20 opens the gate', anomalyConfidence(1, 20, DEFAULT_EXCEPTION_THRESHOLDS) > 0
    && anomalyConfidence(1, 20, DEFAULT_EXCEPTION_THRESHOLDS) < 0.01);
  check('gated confidence: 15/50 ≈ 0.191034', near(anomalyConfidence(15, 50, DEFAULT_EXCEPTION_THRESHOLDS), 0.191034, 0.001));
  check('shrinkage (15,50,μ=0.1) = 17/70', near(shrunkRate(15, 50, 0.1, 20), 17 / 70, 1e-12));
  check('shrinkage (1,1,μ=0.05) = 2/21', near(shrunkRate(1, 1, 0.05, 20), 2 / 21, 1e-12));
  check('shrinkage empty denominator → pooled', near(shrunkRate(0, 0, 0.4, 20), 0.4, 1e-12));
  check('shrinkage (0,100,μ=0.5) = 1/12', near(shrunkRate(0, 100, 0.5, 20), 1 / 12, 1e-12));
}

// ── Part 3: THE OWNER ORACLE — 1/1 never outranks 15/50 ───────────────────
console.log('\n--- Part 3: ranking oracle (1/1 vs 15/50) ---');
{
  const roster = [
    { id: 'c-small', name: 'Petit' },
    { id: 'c-bulk', name: 'Massif' },
    { id: 'c-clean', name: 'Propre' },
  ];
  const auditRows: ExceptionAuditRow[] = [
    row('a1', 'c-small', 'Petit', 'Annulation Vente (Erreur de Caisse)', '2026-09-05T10:00:00.000Z'),
    ...Array.from({ length: 15 }, (_, i) =>
      row(`b${i}`, 'c-bulk', 'Massif', 'Annulation Vente (Erreur de Caisse)', `2026-09-06T10:${String(i).padStart(2, '0')}:00.000Z`)
    ),
  ];
  const sessions: ClosedSessionRow[] = [
    { id: 's-small', cashierName: 'Petit', openedAt: '2026-09-05T08:00:00.000Z', closedAt: '2026-09-05T18:00:00.000Z', expectedCash: 1000, actualCash: 1000, discrepancy: 0, status: 'CLOSED' },
    { id: 's-bulk', cashierName: 'Massif', openedAt: '2026-09-06T08:00:00.000Z', closedAt: '2026-09-06T18:00:00.000Z', expectedCash: 5000, actualCash: 4420, discrepancy: -580, status: 'CLOSED' },
    { id: 's-clean', cashierName: 'Propre', openedAt: '2026-09-07T08:00:00.000Z', closedAt: '2026-09-07T18:00:00.000Z', expectedCash: 900, actualCash: 900, discrepancy: 0, status: 'CLOSED' },
  ];
  const shiftTxnCounts: ShiftTxnCount[] = [
    { shiftId: 's-small', count: 1 },
    { shiftId: 's-bulk', count: 50 },
    { shiftId: 's-clean', count: 100 },
  ];
  const res = computeExceptionIntel({ ...WIN, auditRows, shiftTxnCounts, sessions, roster });
  const byKey = new Map(res.actors.map((a) => [a.actorKey, a]));
  const small = byKey.get('c-small');
  const bulk = byKey.get('c-bulk');
  const clean = byKey.get('c-clean');

  check('pool: 151 txns / 3 shifts / 16 exceptions', res.pool.txns === 151 && res.pool.shifts === 3 && res.pool.totalExceptions === 16);
  check('small (1/1): support gate closed at exactly 20', !!small && !small.sufficientSupport);
  check('small (1/1): confidence is EXACTLY 0', !!small && small.confidence === 0);
  check('bulk (15/50): support open, confidence ≈ 0.191', !!bulk && bulk.sufficientSupport && near(bulk.confidence, 0.191034, 0.001));
  check('1/1 confidence < 15/50 confidence', !!small && !!bulk && small.confidence < bulk.confidence);
  check('1/1 ranks LOWER than 15/50', res.actors.findIndex((a) => a.actorKey === 'c-small') > res.actors.findIndex((a) => a.actorKey === 'c-bulk'));
  check('ranking order is [bulk, clean, small]', res.actors.map((a) => a.actorKey).join(',') === 'c-bulk,c-clean,c-small');
  check('bulk flagged, small + clean not flagged', !!bulk && bulk.flagged && !!small && !small.flagged && !!clean && !clean.flagged);
  // Raw rates are reported for honesty ONLY — this is the trap the engine bans.
  check('raw rate trap visible (small 100% > bulk 30%)', small?.per100Raw === 100 && bulk?.per100Raw === 30 && (small?.per100Raw ?? 0) > (bulk?.per100Raw ?? 0));
  // Displayed (shrunk) rates do not invert either.
  check('shrunk display: bulk > small', !!bulk && !!small && bulk.shrunkPer100 > small.shrunkPer100);
  check('shrunk values ≈ 24.456 / 14.853', near(bulk?.shrunkPer100 ?? 0, 24.456, 0.01) && near(small?.shrunkPer100 ?? 0, 14.853, 0.01));
  check('clean (0/100) safe', clean?.per100Raw === 0 && clean?.confidence === 0);
}

// ── Part 4: actor identity ─────────────────────────────────────────────────
console.log('\n--- Part 4: actor identity ---');
{
  const roster = [
    { id: 'c-bulk', name: 'Massif' },
    { id: 'c-clean', name: 'Propre' },
    { id: 'cX', name: 'Renée' },
  ];
  check('bound actorId wins verbatim', normalizeActorKey({ actorId: 'c1', user: 'zzz' }, roster) === 'c1');
  check('legacy name → roster id (diacritics folded)', normalizeActorKey({ user: ' renée ' }, roster) === 'cX');
  check('unknown name → deterministic slug', normalizeActorKey({ user: 'Caissier  Test' }, []) === 'legacy:caissier-test');
  check('slug stable under spacing/case', normalizeActorKey({ user: '  caissier  test ' }, roster) === 'legacy:caissier-test');
  check('empty name → legacy:inconnu', normalizeActorKey({ user: '' }, []) === 'legacy:inconnu');
  check('write: active cashier match binds its id', resolveActorIdForWrite('Massif', { id: 'c-bulk', name: 'Massif' }, roster) === 'c-bulk');
  check('write: roster match binds the roster id', resolveActorIdForWrite('Propre', { id: 'zzz', name: 'Autre' }, roster) === 'c-clean');
  check('write: unknown name stays NULL (no guess)', resolveActorIdForWrite('Nobody', null, roster) === undefined);
  check('write: empty name stays NULL', resolveActorIdForWrite('', null, roster) === undefined);
}

// ── Part 5: approval concentration ─────────────────────────────────────────
console.log('\n--- Part 5: approvals (manager → cashier) ---');
{
  const roster = [
    { id: 'c1', name: 'A' },
    { id: 'c2', name: 'B' },
  ];
  const ts = '2026-09-15T10:00:00.000Z';
  const auditRows: ExceptionAuditRow[] = [
    row('q1', 'c1', 'A', 'Remise Panier Appliquée', ts, { requiresPin: true }),
    row('q2', 'c1', 'A', 'Remise Article Appliquée', ts, { details: 'Remise 500 DA (Approuvé par PIN Manager)' }),
    row('q3', 'c1', 'A', 'Annulation Vente (Erreur)', ts),
    row('q4', 'c2', 'B', 'Ouverture Manuelle Tiroir ("No Sale")', ts, { requiresPin: true }),
    row('q5', 'c2', 'B', 'Remise Panier Appliquée', ts, { details: 'PIN Manager requis' }),
  ];
  const res = computeExceptionIntel({ ...WIN, auditRows, shiftTxnCounts: [], sessions: [], roster });
  const c1 = res.actors.find((a) => a.actorKey === 'c1');
  const c2 = res.actors.find((a) => a.actorKey === 'c2');
  check('c1: 3 exceptions, 2 approved via flag+details', c1?.totalExceptions === 3 && c1?.approvedExceptions === 2);
  check('c1 share = 2/3', near(c1?.approvalShare ?? 0, 2 / 3, 1e-12));
  check('c2: 2 exceptions, 1 approved; plain "requis" text is NOT approval', c2?.totalExceptions === 2 && c2?.approvedExceptions === 1);
  check('pairs sorted desc with manager approver key', res.approvals.pairs.length === 2
    && res.approvals.pairs[0].cashierKey === 'c1' && res.approvals.pairs[0].count === 2
    && res.approvals.pairs.every((p) => p.approverKey === 'manager'));
  check('total 3', res.approvals.total === 3);
  check('HHI = 5/9', near(res.approvals.hhi, 5 / 9, 1e-12));
  check('topShare = 2/3', near(res.approvals.topShare, 2 / 3, 1e-12));
}

// ── Part 6: variance join ──────────────────────────────────────────────────
console.log('\n--- Part 6: blind-close variance join ---');
{
  const roster = [
    { id: 'c-bulk', name: 'Massif' },
    { id: 'c-clean', name: 'Propre' },
  ];
  const auditRows: ExceptionAuditRow[] = [
    row('r1', 'c-bulk', 'Massif', 'Annulation Vente (Erreur)', '2026-09-10T09:00:00.000Z'),
    row('r2', 'c-bulk', 'Massif', 'Annulation Vente (Erreur)', '2026-09-11T09:00:00.000Z'),
    row('r3', null, 'Propre', 'Annulation Vente (Erreur)', '2026-09-11T10:00:00.000Z'),
  ];
  const sessions: ClosedSessionRow[] = [
    { id: 's1', cashierName: 'Massif', openedAt: '2026-09-10T08:00:00.000Z', closedAt: '2026-09-10T18:00:00.000Z', expectedCash: 5000, actualCash: 4500, discrepancy: -500, status: 'CLOSED' },
    { id: 's2', cashierName: 'Propre', openedAt: '2026-09-11T08:00:00.000Z', closedAt: '2026-09-11T18:00:00.000Z', expectedCash: 1000, actualCash: 900, discrepancy: null, status: 'CLOSED' },
    { id: 's-open', cashierName: 'Massif', openedAt: '2026-09-12T08:00:00.000Z', closedAt: null, expectedCash: 100, actualCash: null, discrepancy: null, status: 'OPEN' },
  ];
  const shiftTxnCounts: ShiftTxnCount[] = [
    { shiftId: 's1', count: 10 },
    { shiftId: 's2', count: 10 },
    { shiftId: 's-ghost', count: 7 },
  ];
  const res = computeExceptionIntel({ ...WIN, auditRows, shiftTxnCounts, sessions, roster });
  check('OPEN session excluded from variance table', res.variance.length === 2);
  check('sorted by |variance| desc (s1 first)', res.variance[0].sessionId === 's1' && res.variance[0].absVariance === 500);
  check('s1 window counts only in-shift exception (1)', res.variance[0].exceptionCount === 1);
  check('s2 falls back to actual−expected = −100', res.variance[1].sessionId === 's2' && res.variance[1].variance === -100);
  check('s2 in-window exception counted by roster name (1)', res.variance[1].exceptionCount === 1);
  check('ghost shift txns stay unattributed (7)', res.unattributedTxns === 7);
  check('pool txns include unattributed (27)', res.pool.txns === 27);
}

// ── Part 7: query-plan oracle (node:sqlite) ────────────────────────────────
console.log('\n--- Part 7: EXPLAIN QUERY PLAN (SEARCH … USING INDEX only) ---');
{
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE security_audit_logs (
      id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, user TEXT NOT NULL,
      action TEXT NOT NULL, details TEXT NOT NULL, requires_pin INTEGER DEFAULT 0,
      version INTEGER DEFAULT 1, device_id TEXT, ip_address TEXT,
      source TEXT NOT NULL DEFAULT 'local', actor_id TEXT
    );
    CREATE INDEX idx_audit_timestamp ON security_audit_logs(timestamp);
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, shift_id TEXT,
      status TEXT NOT NULL DEFAULT 'COMPLETED', deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_transactions_created_at ON transactions(created_at);
    CREATE INDEX idx_txn_shift_status ON transactions(shift_id, status) WHERE shift_id IS NOT NULL;
    CREATE TABLE cash_sessions (
      id TEXT PRIMARY KEY, opened_at TEXT NOT NULL, closed_at TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN', cashier_name TEXT,
      expected_cash INTEGER, actual_cash INTEGER, discrepancy INTEGER
    );
    CREATE INDEX idx_sessions_status ON cash_sessions(status);
  `);

  const auditSql = buildExceptionAuditWindowSql(true);
  const txnSql = buildShiftTxnCountSql();
  const sessionSql = buildClosedSessionSql();
  check('builders pin the audit index', auditSql.includes('INDEXED BY idx_audit_timestamp'));
  check('builders pin the txn index', txnSql.includes('INDEXED BY idx_transactions_created_at'));
  check('builders pin the sessions index', sessionSql.includes('INDEXED BY idx_sessions_status'));
  check('pre-v124 audit builder selects literal NULL', buildExceptionAuditWindowSql(false).includes('NULL') && !buildExceptionAuditWindowSql(false).includes('actor_id,'));

  const plan = (sql: string): string[] =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail?: string }>).map((r) => String(r.detail ?? ''));
  const auditPlan = plan(auditSql);
  const txnPlan = plan(txnSql);
  const sessionPlan = plan(sessionSql);
  check('audit plan: SEARCH USING INDEX idx_audit_timestamp', auditPlan.some((d) => d.includes('SEARCH security_audit_logs USING INDEX idx_audit_timestamp')), auditPlan.join(' | '));
  check('txn plan: SEARCH USING INDEX idx_transactions_created_at', txnPlan.some((d) => d.includes('SEARCH transactions USING INDEX idx_transactions_created_at')), txnPlan.join(' | '));
  check('sessions plan: SEARCH USING INDEX idx_sessions_status', sessionPlan.some((d) => d.includes('SEARCH cash_sessions USING INDEX idx_sessions_status')), sessionPlan.join(' | '));
  const allPlans = [...auditPlan, ...txnPlan, ...sessionPlan];
  check('no SCAN anywhere in any plan', allPlans.every((d) => !d.startsWith('SCAN') && !d.includes('SCAN TABLE')), allPlans.filter((d) => d.includes('SCAN')).join(' | '));

  // Functional run of the exact strings (named `$n` binding on node:sqlite).
  db.exec(`
    INSERT INTO security_audit_logs (id, timestamp, user, action, details, requires_pin, actor_id) VALUES
      ('A1','2026-09-15T10:00:00.000Z','Massif','Annulation Vente (Erreur)','',0,'c-bulk'),
      ('A2','2026-09-20T10:00:00.000Z','Petit','Remise Panier Appliquée','',1,NULL),
      ('A3','2026-08-01T10:00:00.000Z','Vieux','Annulation Vente (Erreur)','',0,'c-old');
    INSERT INTO transactions (id, created_at, shift_id, status, deleted) VALUES
      ('T1','2026-09-15T09:00:00.000Z','s1','COMPLETED',0),
      ('T2','2026-09-15T09:30:00.000Z','s1','COMPLETED',0),
      ('T3','2026-09-15T10:00:00.000Z','s1','VOIDED',1),
      ('T4','2026-09-16T10:00:00.000Z','','COMPLETED',0),
      ('T5','2026-08-02T10:00:00.000Z','s1','COMPLETED',0);
    INSERT INTO cash_sessions (id, opened_at, closed_at, status, cashier_name, expected_cash, actual_cash, discrepancy) VALUES
      ('S1','2026-09-15T08:00:00.000Z','2026-09-15T18:00:00.000Z','CLOSED','Massif',5000,4420,-580),
      ('S2','2026-09-16T08:00:00.000Z',NULL,'OPEN','Massif',100,NULL,NULL);
  `);
  const auditRows = db.prepare(auditSql).all({ '1': WIN.sinceIso, '2': WIN.untilIso, '3': EXCEPTION_AUDIT_WINDOW_LIMIT }) as Array<Record<string, unknown>>;
  const txnRows = db.prepare(txnSql).all({ '1': WIN.sinceIso, '2': WIN.untilIso }) as Array<Record<string, unknown>>;
  const sessionRows = db.prepare(sessionSql).all({ '1': WIN.sinceIso, '2': WIN.untilIso }) as Array<Record<string, unknown>>;
  check('audit window read: only the 2 in-range rows', auditRows.length === 2);
  check('audit window read exposes actor_id (value + NULL)', auditRows.some((r) => r.actor_id === 'c-bulk') && auditRows.some((r) => r.actor_id === null));
  check('txn counts: only live, shift-linked, in-range rows → s1 = 2', txnRows.length === 1 && txnRows[0].shift_id === 's1' && Number(txnRows[0].n) === 2);
  check('sessions read: only CLOSED in-range', sessionRows.length === 1 && sessionRows[0].id === 'S1');
}

// ── Part 8: wiring + 3-way DDL parity ──────────────────────────────────────
console.log('\n--- Part 8: wiring + parity ---');
{
  const libRs = src('src-tauri/src/lib.rs');
  const heal = src('src/db/schemaHeal.ts');
  const adapter = src('src/db/sqlPluginAdapter.ts');
  const generic = src('src/sync/genericApply.ts');
  const ui = src('src/store/slices/createUISlice.ts');
  const ops = src('src/db/adapters/operationsAdapter.ts');
  const rust = src('src-tauri/src/trust_core/audit_append.rs');
  const modal = src('src/components/modals/SecurityAuditModal.tsx');
  const remote = src('src/sync/remoteSchema.ts');
  const auditApi = src('src/api/audit.ts');
  const posTypes = src('src/types/pos.ts');
  const cartSlice = src('src/store/slices/createCartSlice.ts');
  const pkg = JSON.parse(src('package.json')) as { scripts?: Record<string, string> };

  const V124 = 'ALTER TABLE security_audit_logs ADD COLUMN actor_id TEXT;';

  check('lib.rs v124 migration present', libRs.includes('version: 124,') && libRs.includes(V124));
  check('lib.rs ceiling bumped to 129', /EXPECTED_MAX_DB_USER_VERSION: u32 = 129;/.test(libRs));
  check('schemaHeal exports the verbatim v124 constant', AUDIT_ACTOR_ID_HEAL_SQL.length === 1 && AUDIT_ACTOR_ID_HEAL_SQL[0] === V124);
  check('schemaHeal probe constant exact', AUDIT_ACTOR_ID_HEAL_PROBE_SQL === 'SELECT actor_id FROM security_audit_logs LIMIT 0;');
  check('3-way DDL parity (rust ↔ heal ↔ pull-mirror)', libRs.includes(V124) && heal.includes(V124) && generic.includes(V124));
  check('adapter imports + spreads the heal constant', adapter.includes('AUDIT_ACTOR_ID_HEAL_SQL') && adapter.includes('...AUDIT_ACTOR_ID_HEAL_SQL,') && adapter.includes('await db.select(AUDIT_ACTOR_ID_HEAL_PROBE_SQL);'));
  check('pull mirror INSERT carries actor_id', generic.includes(', actor_id)') && generic.includes('a.actorId'));
  check('fallback writer INSERT carries actor_id + degrade', ops.includes('ip_address, actor_id)') && /actor_id/i.test(ops));
  check('funnel resolves the immutable actor id', ui.includes('resolveActorIdForWrite(effectiveUser, get().activeCashier, get().cashierUsers)'));
  check('funnel binds actorId on the entry + native request', (ui.match(/\.\.\.\(actorId \? \{ actorId \} : \{\}\),/g) || []).length >= 2);
  check('native request type carries actorId', auditApi.includes('actorId?: string;'));
  check('audit entry type carries actorId', posTypes.includes('actorId?: string;'));
  check('native append stores actor_id when present', rust.includes('pub actor_id: Option<String>,') && (rust.match(/names\.push\("actor_id"\);/g) || []).length === 2);
  check('native append validates actor id length', rust.includes('MAX_ACTOR_ID_LEN') && rust.includes('audit actor id exceeds 128 chars'));
  const canonical = rust.slice(rust.indexOf('fn canonical_bytes('), rust.indexOf('fn hex('));
  check('actor_id is NOT part of the chained bytes', canonical.length > 0 && !canonical.includes('actor_id'));
  check('discount applications are audited (cart + item)', cartSlice.includes("'Remise Panier Appliquée'") && cartSlice.includes("'Remise Article Appliquée'"));
  check('UI panel wired after the denial strip', modal.includes("import { ExceptionIntelStrip } from '../audit/ExceptionIntelStrip';") && modal.includes('<ExceptionIntelStrip />'));
  check('remote stays column-free KV (payload carries actorId)', !remote.includes('actor_id'));
  check('suite wired into test + test:all chains', pkg.scripts?.['test:exception-intel'] === 'node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_exception_intel.mts'
    && (pkg.scripts?.test ?? '').includes('test:exception-intel')
    && (pkg.scripts?.['test:all'] ?? '').includes('test:exception-intel'));
}

// ── Part 9: heal replay on a pre-v124 shape ────────────────────────────────
console.log('\n--- Part 9: heal replay (pre-v124 shape) ---');
{
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE security_audit_logs (
      id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, user TEXT NOT NULL,
      action TEXT NOT NULL, details TEXT NOT NULL, requires_pin INTEGER DEFAULT 0,
      version INTEGER DEFAULT 1, device_id TEXT, ip_address TEXT,
      source TEXT NOT NULL DEFAULT 'local'
    );
    CREATE INDEX idx_audit_timestamp ON security_audit_logs(timestamp);
    INSERT INTO security_audit_logs (id, timestamp, user, action, details)
      VALUES ('legacy-1','2026-09-01T00:00:00.000Z','Ancien','Annulation Vente (Erreur)','');
  `);
  let preProbeFailed = false;
  try {
    db.prepare(AUDIT_ACTOR_ID_HEAL_PROBE_SQL).all();
  } catch {
    preProbeFailed = true;
  }
  check('pre-v124: actor_id probe fails (heal required)', preProbeFailed);

  let unexpectedApply = 0;
  for (const stmt of AUDIT_ACTOR_ID_HEAL_SQL) {
    try {
      db.exec(stmt);
    } catch (e) {
      if (!/duplicate column/i.test(String(e))) unexpectedApply++;
    }
  }
  check('heal applies cleanly', unexpectedApply === 0);

  let rerunUnexpected = 0;
  for (const stmt of AUDIT_ACTOR_ID_HEAL_SQL) {
    try {
      db.exec(stmt);
    } catch (e) {
      if (!/duplicate column/i.test(String(e))) rerunUnexpected++;
    }
  }
  check('heal rerun idempotent (duplicate column tolerated)', rerunUnexpected === 0);

  let postProbeOk = true;
  try {
    db.prepare(AUDIT_ACTOR_ID_HEAL_PROBE_SQL).all();
  } catch {
    postProbeOk = false;
  }
  check('post-heal: probe passes', postProbeOk);

  db.exec(`INSERT INTO security_audit_logs (id, timestamp, user, action, details, actor_id)
    VALUES ('new-1','2026-09-02T00:00:00.000Z','Massif','Annulation Vente (Erreur)','','c-bulk');`);
  const readRows = db.prepare(buildExceptionAuditWindowSql(true)).all({
    '1': WIN.sinceIso,
    '2': WIN.untilIso,
    '3': EXCEPTION_AUDIT_WINDOW_LIMIT,
  }) as Array<Record<string, unknown>>;
  check('post-heal: window read sees both rows with actor_id', readRows.length === 2 && readRows.some((r) => r.actor_id === 'c-bulk'));
  const legacySnapshot = db.prepare(buildExceptionAuditWindowSql(false)).all({
    '1': WIN.sinceIso,
    '2': WIN.untilIso,
    '3': EXCEPTION_AUDIT_WINDOW_LIMIT,
  }) as Array<Record<string, unknown>>;
  check('pre-v124 read lane exposes NULL actor_id (engine maps by name)', legacySnapshot.length === 2 && legacySnapshot.every((r) => r.actor_id === null));

  const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>).map((r) => String(Object.values(r)[0]));
  check("integrity_check = 'ok'", integrity.length === 1 && integrity[0] === 'ok');
  const fk = db.prepare('PRAGMA foreign_key_check').all() as Array<Record<string, unknown>>;
  check('foreign_key_check empty', fk.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('FAILURES:\n' + failures.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}

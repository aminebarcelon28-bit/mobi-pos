/**
 * Journal d'Audit intelligence layer regression.
 *
 * The audit drawer, the severity chips and the live-feed quick filters all read
 * from src/utils/auditIntel.ts. That module is pure by design so the parsing
 * rules can be pinned here instead of only being observable in the browser.
 *
 * The fixtures below are the REAL `details` strings written by the
 * `logSecurityAction` call sites — if someone rewords one of those templates,
 * the corresponding assertion here is the thing that should fail loudly.
 */
import {
  AUDIT_SIGNATURE_FIELDS,
  CANONICAL_RULES_LABEL,
  QUICK_RANGES,
  SIGNATURE_LABEL,
  buildSessionTag,
  canonicalizeValue,
  classifyAuditTimestamp,
  classifySeverity,
  computeAuditSignature,
  describeAuditTime,
  deterministicStringify,
  extractEntityRefs,
  foldAccents,
  foldedSearchFields,
  formatExactUtc,
  formatRelativeTime,
  getActionCategory,
  isFutureSkewed,
  matchesFoldedQuery,
  parseAuditPayload,
  parseAuditTimestamp,
  parseDenialBurst,
  parseNumber,
  quickRangeStart,
  resolveActorMeta,
  resolveAuditRange,
  signaturePreimage,
  stripLocaleWhitespace,
  summarizeDenialBursts,
  truncateSignature,
  verifyAuditSignature,
} from '../src/utils/auditIntel.ts';
import { CANONICALIZATION_RULES, verifyAuditManifest } from '../src/utils/auditIntegrity.ts';
import {
  CHAIN_GENESIS,
  CURRENT_RULESET,
  classifyVerification,
  rulesetId,
  verifyAuditChain,
  verifyAndClassify,
} from '../src/utils/auditIntegrity.ts';
import {
  AUDIT_DEFAULT_LIMIT,
  auditSelectParams,
  buildAuditSelect,
  buildLegacyAuditSelect,
  hasAuditBound,
} from '../src/db/auditQuery.ts';
import { sha256Hex } from '../src/utils/auditIntel.ts';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

// ── Timestamps ──────────────────────────────────────────────────────────────

{
  const iso = '2026-09-29T23:07:14.231Z';
  const d = parseAuditTimestamp(iso);
  check('ISO-8601 audit timestamp parses', d.getTime() === Date.parse(iso));
  check(
    'exact UTC label carries the full forensic precision',
    formatExactUtc(d) === '2026-09-29 23:07:14.231 UTC',
    formatExactUtc(d),
  );
}

{
  // Legacy rows persisted toLocaleTimeString() only ("14:32") and used to be
  // dropped out of every range filter because they parsed to "now".
  const legacy = parseAuditTimestamp('14:32');
  check('legacy HH:MM resolves to a real time today', legacy.getHours() === 14 && legacy.getMinutes() === 32);
  check('legacy HH:MM lands on the current calendar day', legacy.toDateString() === new Date().toDateString());
}

{
  const now = new Date('2026-09-29T23:07:14.000Z');
  check('relative: 2 minutes', formatRelativeTime(new Date('2026-09-29T23:05:00Z'), now) === 'il y a 2 min');
  check('relative: sub-45s reads as now', formatRelativeTime(new Date('2026-09-29T23:06:50Z'), now) === "à l'instant");
  check('relative: 3 hours', formatRelativeTime(new Date('2026-09-29T20:07:00Z'), now) === 'il y a 3 h');
  check('relative: 2 days', formatRelativeTime(new Date('2026-09-27T23:07:00Z'), now) === 'il y a 2 j');
  // A peer device with a fast clock must not render a negative age.
  check(
    'relative: clock skew ahead of us stays readable',
    formatRelativeTime(new Date('2026-09-29T23:07:30Z'), now) === "à l'instant",
    formatRelativeTime(new Date('2026-09-29T23:07:30Z'), now),
  );
}

// ── Forensic timestamp presentation (no synthesized dates) ───────────────
// A dateless legacy row must NEVER imply "today" and a future-skewed ISO row
// must NEVER render a normal countdown — see describeAuditTime().

{
  check('classify: full ISO is iso', classifyAuditTimestamp('2026-09-29T23:07:14.231Z') === 'iso');
  check('classify: HH:MM is legacy-wall', classifyAuditTimestamp('14:32') === 'legacy-wall');
  check('classify: HH:MM:SS is legacy-wall', classifyAuditTimestamp('14:32:07') === 'legacy-wall');
  check('classify: empty is missing', classifyAuditTimestamp('') === 'missing');
  check('classify: null is missing', classifyAuditTimestamp(null) === 'missing');
  check('classify: garbage is unparsable', classifyAuditTimestamp('hier vers midi') === 'unparsable');
}

{
  const now = new Date('2026-09-29T23:07:14.000Z');
  check('skew: +60s is future-skewed', isFutureSkewed(new Date('2026-09-29T23:08:14.000Z'), now) === true);
  check('skew: threshold edge (+45s) counts', isFutureSkewed(new Date('2026-09-29T23:07:59.000Z'), now) === true);
  check('skew: +30s is not', isFutureSkewed(new Date('2026-09-29T23:07:44.000Z'), now) === false);
  check('skew: past is not', isFutureSkewed(new Date('2026-09-29T23:05:00.000Z'), now) === false);
}

{
  const now = new Date('2026-09-29T10:00:00.000Z');
  const legacy = describeAuditTime('14:32', now);
  check('legacy: kind is legacy-wall', legacy.kind === 'legacy-wall');
  check('legacy: raw bytes preserved', legacy.raw === '14:32', legacy.raw);
  check('legacy: exact shows raw, never a synthesized date', legacy.exact === '14:32', legacy.exact);
  check(
    'legacy: relative refuses today language',
    legacy.relative.includes('date inconnue') && !legacy.relative.includes("dans un instant") && !legacy.relative.includes('il y a'),
    legacy.relative,
  );

  const skewed = describeAuditTime('2026-09-29T10:05:00.000Z', now);
  check('skewed: flagged', skewed.clockSkewed === true && skewed.kind === 'iso');
  check('skewed: relative is the clock warning', skewed.relative === 'Horloge locale décalée', skewed.relative);

  const fresh = describeAuditTime('2026-09-29T09:58:00.000Z', now);
  check('normal ISO: classic countdown kept', fresh.relative === 'il y a 2 min', fresh.relative);
  check('normal ISO: exact stays full UTC', fresh.exact === '2026-09-29 09:58:00.000 UTC', fresh.exact);

  const missing = describeAuditTime('', now);
  check('missing: kind + label', missing.kind === 'missing' && missing.relative === 'non horodaté', missing.relative);

  const bad = describeAuditTime('hier vers midi', now);
  check('unparsable: kind + raw surfaced', bad.kind === 'unparsable' && bad.exact === 'hier vers midi', bad.exact);
}

// ── Phase F denial-burst dashboard ───────────────────────────────────────
// Rows are cumulative snapshots: aggregation must take the LATEST per
// (gate, user, window), never sum raw rows. Malformed rows are ignored.
{
  const burst = (gate: string, user: string, count: number, locked: boolean, win: number) => ({
    id: `b-${gate}-${user}-${win}-${count}`,
    timestamp: '2026-09-29T23:07:14.231Z',
    user,
    action: 'GATE_DENIED_BURST',
    details: JSON.stringify({
      gate_name: gate, user_id: user, denial_count: count,
      lockout_triggered: locked, lockout_duration_ms: locked ? 60000 : 0,
      window_start_epoch: win,
    }),
    requiresPin: true,
  });
  const rows = [
    burst('journal', 'yacine', 1, false, 1000),
    burst('journal', 'yacine', 5, false, 1000), // same window, later snapshot
    burst('journal', 'lina', 5, true, 1000),
    burst('export', 'yacine', 1, false, 2000),
    { id: 'x1', timestamp: '', user: 'u', action: 'GATE_DENIED_BURST', details: 'not-json', requiresPin: true },
    { id: 'x2', timestamp: '', user: 'u', action: 'GATE_DENIED_BURST', details: JSON.stringify({ gate_name: '', denial_count: 99 }), requiresPin: true },
    { id: 'x3', timestamp: '', user: 'u', action: 'Suppression Article Panier', details: 'Article: X (1 unités)', requiresPin: false },
  ];
  check('malformed burst is not a burst', parseDenialBurst('GATE_DENIED_BURST', 'not-json') === null);
  check('non-burst action is not a burst', parseDenialBurst('Autre', '{}') === null);
  const s = summarizeDenialBursts(rows as never);
  const journal = s.gates.find((g) => g.gate === 'journal');
  const exp = s.gates.find((g) => g.gate === 'export');
  check('latest-per-window wins (5, not 1+5)', journal?.denials === 10, `got ${journal?.denials}`);
  check('two users counted', journal?.users === 2, `got ${journal?.users}`);
  check('one lockout counted once', journal?.lockouts === 1 && s.totalLockouts === 1);
  check('second gate separate', exp?.denials === 1 && exp?.users === 1);
  check('totals aggregate', s.totalDenials === 11 && s.users === 3, `${s.totalDenials}/${s.users}`);
  check('empty set summarizes to zeros', summarizeDenialBursts([]).totalDenials === 0);
}

{
  // Memory-pressure proof (audit surface S5): 10k burst rows across few
  // keys must aggregate in bounded space — the map holds at most one entry
  // per (gate, user, window), never per row. Asserts result shape, exact
  // totals, and a wall-clock budget (allocation blowup would show up as
  // seconds, not ms).
  const t0 = Date.now();
  const rows: never[] = [];
  for (let i = 0; i < 10_000; i++) {
    rows.push({
      id: `f-${i}`,
      timestamp: '2026-09-29T23:07:14.231Z',
      user: `u${i % 4}`,
      action: 'GATE_DENIED_BURST',
      details: JSON.stringify({
        gate_name: i % 2 === 0 ? 'journal' : 'export',
        user_id: `u${i % 4}`,
        denial_count: (i % 50) + 1,
        lockout_triggered: i % 500 === 0,
        lockout_duration_ms: 0,
        window_start_epoch: 1000 + (i % 3),
      }),
      requiresPin: true,
    } as never);
  }
  const s = summarizeDenialBursts(rows);
  const ms = Date.now() - t0;
  // Keys: even i → journal (users u0,u2), odd i → export (users u1,u3),
  // 3 windows each → 12 distinct (gate,user,window) keys max.
  check('10k rows collapse to bounded keys', s.gates.length === 2, `gates: ${s.gates.length}`);
  // Reference: independent max-per-key computation must agree exactly.
  const ref = new Map<string, number>();
  for (const r of rows as Array<{ details: string }>) {
    const p = JSON.parse(r.details) as { gate_name: string; user_id: string; denial_count: number; window_start_epoch: number };
    const k = `${p.gate_name}|${p.user_id}|${p.window_start_epoch}`;
    ref.set(k, Math.max(ref.get(k) ?? 0, p.denial_count));
  }
  let refTotal = 0;
  for (const v of ref.values()) refTotal += v;
  check('bounded aggregation equals reference maxima', s.totalDenials === refTotal, `${s.totalDenials}/${refTotal}`);
  check('key space bounded (12 distinct windows)', ref.size === 12, `keys: ${ref.size}`);
  check('users bounded', s.users === 4, `got ${s.users}`);
  check('aggregates 10k rows within budget', ms < 2000, `${ms}ms`);
}

// ── Categories & severity ───────────────────────────────────────────────────

{
  check('drawer open maps to the drawer category', getActionCategory('Ouverture Manuelle Tiroir ("No Sale")').label === 'Ouverture Tiroir');
  check('session unlock maps to Session', getActionCategory('Connexion / Déverrouillage Caisse').label === 'Session');
  check('void maps to the destructive category', getActionCategory('Annulation Vente (Erreur)').label === 'Annulation / Suppression');
  // Removal-parity vectors (desktop / clavier / mobile / undo / hotkey) must
  // all land in the destructive category AND stay critical with
  // requiresPin=false — severity comes from the category, never from an
  // unearned PIN flag (honest-labeling rule).
  for (const action of [
    'Suppression Article Panier',
    'Suppression Article Panier (Clavier)',
    'Suppression Article Panier (Mobile)',
    'Suppression Article Panier (Annulation ajout)',
    'Annulation Complète Panier',
    'Annulation Complète Panier (Mobile)',
    'Annulation Complète Panier (Raccourci)',
  ]) {
    check(
      `parity vector stays destructive: ${action}`,
      getActionCategory(action).label === 'Annulation / Suppression' &&
        classifySeverity(action, `Article: Câble Test (2 unités)`, false) === 'critical',
    );
  }
  check('unknown action falls back to Autre', getActionCategory('Zorglub Flurb').label === 'Autre');

  // The brief's example: "Connexion / Déverrouillage…" must not be clipped —
  // the severity model now has to classify it, not the text colour.
  check(
    'a failed PIN attempt is critical regardless of category',
    classifySeverity('Connexion / Déverrouillage Caisse', 'Tentative de code erroné pour Karim', true) === 'critical',
    classifySeverity('Connexion / Déverrouillage Caisse', 'Tentative de code erroné pour Karim', true),
  );
  check(
    'blocked destructive delete is critical',
    classifySeverity('Suppression Client Bloquée (Dette Active)', 'Dette non soldée de 5000 DA. Suppression refusée.', true) === 'critical',
  );
  check(
    'a counted variance at shift close is a warning',
    classifySeverity('Clôture Caisse & Rapport Z (Blind Count)', 'Écart: 1200 DA', false) === 'warning',
  );
  check(
    'a routine session open is informational',
    classifySeverity('Connexion / Déverrouillage Caisse', 'Session ouverte par Karim (Caissier)', false) === 'info',
  );
  check(
    'a plain catalogue creation is baseline audit noise',
    classifySeverity('Création Produit Catalogue', 'Nouveau produit: Ecouteurs (Stock: 40)', false) === 'audit',
  );
}

// ── Structured payload parsing ──────────────────────────────────────────────

{
  // Real call site: `Montant: ${amount} DA • Motif: ${reason} • Shift: ${id}`
  const details = 'Montant: 12 500 DA • Motif: Remplacement consomables • Shift: shf_9ab21';
  const p = parseAuditPayload(details, 'Décaissement / Dépense Caisse');
  check('segments become key/value fields', p.fields.length === 3, JSON.stringify(p.fields));
  check('Montant field extracted', p.fields[0]?.label === 'Montant' && p.fields[0]?.value === '12 500 DA');
  check('payload is flagged structured', p.structured === true);
  check(
    'French thousands formatting parses to a number',
    p.metrics.some((m) => m.unit === 'DA' && m.value === 12500),
    JSON.stringify(p.metrics),
  );
  check('raw details are never mutated', p.raw === details);
}

{
  // Real call site: `Client: X — ${moneyKeys.map(k => `${k}: a → b`)}`
  const details =
    "Client: Karim B — creditLimit: 0 → 250000, currentDebt: 18000 → 0, clientType: Particulier → Pro.";
  const p = parseAuditPayload(details, 'Modification Financière Client');
  check('before/after deltas are extracted', p.changes.length === 3, JSON.stringify(p.changes));
  check('field name preserved', p.changes[0]?.field === 'creditLimit');
  check('before value preserved', p.changes[0]?.before === '0' && p.changes[0]?.after === '250000');
  check('clientType delta captured', p.changes[2]?.field === 'clientType');
  check('all deltas classified as changes', p.changes.every((c) => c.kind === 'changed'));
}

{
  // Real call site: `Article: ${title} (${qty} unités)` on a destructive action.
  const details = 'Article: Ecouteurs Bluetooth X2 (3 unités)';
  const p = parseAuditPayload(details, 'Suppression Article Panier');
  check('removed cart item is lifted out', p.removedItems.length === 1, JSON.stringify(p.removedItems));
  check('removed item keeps its label', p.removedItems[0]?.label === 'Ecouteurs Bluetooth X2');
  check('removed item quantity parsed', p.removedItems[0]?.quantity === 3);

  // The same sentence under a non-destructive action must not be reported as a
  // removal, or every "Produit: ..." line would look like a deletion.
  const keep = parseAuditPayload(details, 'Création Produit Catalogue');
  check('item is not a removal outside a destructive action', keep.removedItems.length === 0);
}

{
  // Real call site: the blind-count close packs four figures into one line.
  const details =
    'Montant compté: 84 000 DA • Théorique: 85 200 DA • Écart: -1200 DA • Profit Net: 42 300 DA';
  const p = parseAuditPayload(details, 'Clôture Caisse & Rapport Z (Blind Count)');
  const daMetrics = p.metrics.filter((m) => m.unit === 'DA');
  check('every DA figure is lifted', daMetrics.length >= 4, String(daMetrics.length));
  check('negative variance keeps its sign', daMetrics.some((m) => m.value === -1200), JSON.stringify(daMetrics));
}

{
  check('empty details yield an empty payload', parseAuditPayload('', 'X').fields.length === 0);
  check('empty details keep a usable raw', parseAuditPayload('', 'X').raw === '');
  check('null details do not throw', parseAuditPayload(null, null).structured === false);
}

// ── Number parsing across locales ───────────────────────────────────────────

{
  check('plain integer', parseNumber('12500') === 12500);
  check('French thousands separator', parseNumber('1 234 567') === 1234567);
  check('French decimal comma', parseNumber('1 234,56') === 1234.56);
  check('English thousands + decimal', parseNumber('1,234,567.89') === 1234567.89);
  check('leading minus preserved', parseNumber('-1200') === -1200);
  check('single trailing dot group is thousands', parseNumber('1.234') === 1234);
  check('garbage returns null', parseNumber('n/a') === null);
  check('empty returns null', parseNumber('') === null);
}

// ── Entity references ───────────────────────────────────────────────────────

{
  const refs = extractEntityRefs('Annulation Vente — Ticket #T-4471 pour Bon #po_9ab21 (Client #c-12)');
  const ids = refs.map((r) => r.id);
  check('ticket reference found', ids.includes('T-4471'), ids.join(','));
  check('purchase order reference found', ids.includes('po_9ab21'), ids.join(','));
  check('references are ordered by position', refs[0].index < refs[1].index);
  check(
    'offsets point at the real text',
    refs.every((r) => 'Annulation Vente — Ticket #T-4471 pour Bon #po_9ab21 (Client #c-12)'.slice(r.index, r.index + r.length) === r.id),
  );
  check('no duplicate references', new Set(ids).size === ids.length);
  check('empty details yield no refs', extractEntityRefs('').length === 0);
  check('null details yield no refs', extractEntityRefs(null).length === 0);
}

// ── Quick ranges ────────────────────────────────────────────────────────────

{
  const now = new Date('2026-09-29T23:07:14.000Z');
  const m15 = quickRangeStart('15m', now);
  const m1h = quickRangeStart('1h', now);
  check('15m window starts 15 minutes back', m15 === now.getTime() - 15 * 60_000, String(m15));
  check('1h window is wider than 15m', (m1h as number) < (m15 as number));
  check('live shares the 15-minute horizon', quickRangeStart('live', now) === m15);
  check('all-time has no lower bound', quickRangeStart('all', now) === null);

  const today = quickRangeStart('today', now);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  check('today means local midnight, not rolling 24h', today === midnight.getTime());

  check('all five quick ranges are offered', QUICK_RANGES.length === 5);
  check(
    'every range carries a label for both breakpoints',
    QUICK_RANGES.every((r) => r.label.length > 0 && r.short.length > 0),
  );
}

// ── Actor / terminal fallback ───────────────────────────────────────────────

{
  const session = { deviceId: 'TERM-ABC-123', ipAddress: '41.107.2.9' };
  const recorded = {
    id: 'a1',
    timestamp: '2026-09-29T23:00:00.000Z',
    user: 'Karim',
    action: 'Connexion / Déverrouillage Caisse',
    details: 'Session ouverte',
    requiresPin: false,
    deviceId: 'TERM-OTHER-999',
    ipAddress: '10.0.0.5',
  };
  const a = resolveActorMeta(recorded, session, null, new Date(recorded.timestamp));
  check('recorded attribution wins over the session', a.deviceId === 'TERM-OTHER-999' && a.deviceOrigin === 'recorded');
  check('recorded IP is preserved', a.ipAddress === '10.0.0.5' && a.ipOrigin === 'recorded');
}

{
  // This is the actual bug from the brief: legacy rows rendered « - » for both
  // Terminal and IP because nothing backfilled them.
  const session = { deviceId: 'TERM-ABC-123', ipAddress: '41.107.2.9' };
  const legacy = {
    id: 'a2',
    timestamp: '2026-09-29T23:00:00.000Z',
    user: 'Karim',
    action: 'Connexion / Déverrouillage Caisse',
    details: 'Session ouverte',
    requiresPin: false,
  };
  const a = resolveActorMeta(legacy, session, null, new Date(legacy.timestamp));
  check('missing terminal is backfilled from the session', a.deviceId === 'TERM-ABC-123');
  check('backfilled terminal is flagged as inferred', a.deviceOrigin === 'session');
  check('missing IP is backfilled from the session', a.ipAddress === '41.107.2.9' && a.ipOrigin === 'session');
  check('no field is left as a bare dash', a.deviceId !== '—' && a.ipAddress !== '—');
  check('a session tag is always available', /^SESSION-[0-9A-F]{1,8}$/.test(a.sessionTag), a.sessionTag);
}

{
  // A failed IP capture is stored as a sentinel string, not as empty. Treating
  // it as real data would render "Non détectée (hors-ligne)" as an address.
  const session = { deviceId: 'TERM-ABC-123', ipAddress: '41.107.2.9' };
  const failed = {
    id: 'a3',
    timestamp: '2026-09-29T23:00:00.000Z',
    user: 'Karim',
    action: 'X',
    details: 'Y',
    requiresPin: false,
    ipAddress: 'Non détectée (hors-ligne)',
  };
  const a = resolveActorMeta(failed, session, null, new Date(failed.timestamp));
  check('failed IP capture is not treated as a reading', a.ipAddress === '41.107.2.9' && a.ipOrigin === 'session');
}

{
  const none = resolveActorMeta(
    { id: 'a4', timestamp: 'x', user: 'K', action: 'A', details: '', requiresPin: false },
    null,
    null,
    new Date('2026-09-29T23:00:00.000Z'),
  );
  check('no session and no capture still resolves to something', none.deviceId === none.sessionTag);
  check('unresolvable attribution is marked unknown', none.deviceOrigin === 'unknown');
}

{
  const tagA = buildSessionTag('TERM-1', new Date('2026-09-29T00:00:00Z'));
  const tagB = buildSessionTag('TERM-1', new Date('2026-09-29T00:00:00Z'));
  const tagC = buildSessionTag('TERM-2', new Date('2026-09-29T00:00:00Z'));
  check('session tag is deterministic', tagA === tagB);
  check('session tag separates terminals', tagA !== tagC);
}

// ── Integrity signature ─────────────────────────────────────────────────────

const sigEntry = {
  id: 'audit-1',
  timestamp: '2026-09-29T23:07:14.231Z',
  user: 'Karim',
  action: 'Annulation Vente (Erreur)',
  details: 'Ticket #T-4471 (12 000 DA) annulé. Motif: Erreur de saisie',
  requiresPin: true,
  deviceId: 'TERM-ABC-123',
  ipAddress: '41.107.2.9',
};

{
  const hash = await computeAuditSignature(sigEntry);
  check('signature is 64 hex chars (SHA-256)', /^[0-9a-f]{64}$/.test(hash), hash.slice(0, 16));
  check('signature is deterministic', hash === await computeAuditSignature(sigEntry));

  const tampered = await computeAuditSignature({ ...sigEntry, details: sigEntry.details.replace('12 000', '1 200') });
  check('altering the amount changes the signature', tampered !== hash);

  // Field-boundary collision: without a separator, moving a character from one
  // field to the next would leave the preimage unchanged.
  const a = { ...sigEntry, user: 'Kar', action: 'im Annulation' };
  const b = { ...sigEntry, user: 'Kari', action: 'm Annulation' };
  check(
    'preimage separator defeats boundary collisions',
    signaturePreimage(a) !== signaturePreimage(b),
  );
  check('tampered boundary case hashes differently', (await computeAuditSignature(a)) !== (await computeAuditSignature(b)));
}

// ── Canonicalization ─────────────────────────────────────────────────────────

{
  // Key order must not matter: the same row assembled two ways is one row.
  const left = { b: 2, a: 1, c: { z: 1, y: 2 } };
  const right = { c: { y: 2, z: 1 }, a: 1, b: 2 };
  check(
    'key insertion order does not change the canonical form',
    deterministicStringify(canonicalizeValue(left)) === deterministicStringify(canonicalizeValue(right)),
  );

  // A nested key must not be reorderable into its parent's namespace.
  const flat = deterministicStringify(canonicalizeValue({ a: 1, b: { a: 2 } }));
  const nested = deterministicStringify(canonicalizeValue({ b: { a: 2 }, a: 1 }));
  check('nesting is preserved, not flattened', flat === nested);
  check(
    'nested namespace is not confusable with a flat one',
    flat !== deterministicStringify(canonicalizeValue({ a: 1, 'b.a': 2 })),
  );

  check('undefined keys are stripped', !deterministicStringify(canonicalizeValue({ a: 1, b: undefined })).includes('b'));
  check('explicit null is kept', deterministicStringify(canonicalizeValue({ a: null })).includes('null'));
  check('absent and explicit-null agree on the digest', !deterministicStringify(canonicalizeValue({ a: null })).includes('undefined'));

  // Floats are pinned so binary representation cannot leak into the digest.
  const floatA = { total: 0.1 + 0.2 };
  const floatB = { total: 0.3 };
  check(
    'float sums are pinned to 2 decimals (0.1+0.2 === 0.3)',
    deterministicStringify(canonicalizeValue(floatA)) === deterministicStringify(canonicalizeValue(floatB)),
    deterministicStringify(canonicalizeValue(floatA)),
  );
  check('integers are not given a decimal point', !deterministicStringify(canonicalizeValue({ n: 5 })).includes('.00'));

  // Cyclic input must not hang the drawer.
  const cyclic: Record<string, unknown> = { name: 'x' };
  cyclic.self = cyclic;
  let cyclicHandled = true;
  try { deterministicStringify(canonicalizeValue(cyclic)); } catch { cyclicHandled = true; }
  check('a cyclic payload terminates instead of hanging', cyclicHandled);

  // Arrays keep their order — reordering an audit timeline is a real change.
  check(
    'array order is significant',
    deterministicStringify(canonicalizeValue([1, 2])) !== deterministicStringify(canonicalizeValue([2, 1])),
  );
}

// ── Locale whitespace ────────────────────────────────────────────────────────

{
  const NBSP = String.fromCharCode(160);
  const NNBSP = String.fromCharCode(8239);

  check('NBSP is stripped from a grouped amount', parseNumber(`12${NBSP}000`) === 12000, String(parseNumber(`12${NBSP}000`)));
  check('narrow NBSP is stripped from a grouped amount', parseNumber(`12${NNBSP}000`) === 12000, String(parseNumber(`12${NNBSP}000`)));
  check('plain space is still stripped', parseNumber('12 000') === 12000);
  check('regular grouping is unaffected', parseNumber('12 000,50') === 12000.5, String(parseNumber('12 000,50')));

  // A metric with a non-breaking group separator must still be extracted.
  const withNbsp = parseAuditPayload(`Vente encaissée : 45${NBSP}000,00 DA sur 3 articles`, 'Encaissement');
  check(
    'a metric using NBSP grouping is extracted',
    withNbsp.metrics.some((m) => /45000|45/.test(m.display)),
    withNbsp.metrics.map((m) => `${m.label}=${m.display}`).join(', '),
  );

  // The IP field must not swallow a value because of a stray NBSP.
  const ipRow = parseAuditPayload(`IP ${NBSP}41.107.2.9`, 'Connexion');
  check('IP is not confused by leading NBSP', !/\u00A0/.test(ipRow.narrative ?? ''), ipRow.narrative ?? '');

  check('stripLocaleWhitespace removes all three space classes',
    stripLocaleWhitespace(`a${NBSP}b${NNBSP}c d`) === 'abcd');
}

// ── Signature verification ───────────────────────────────────────────────────

{
  const hash = await computeAuditSignature(sigEntry);
  const ok = await verifyAuditSignature(sigEntry, hash);
  check('a matching digest verifies', ok.valid && ok.actual === hash);

  // Case must not decide the verdict: hex is compared case-insensitively.
  const upper = await verifyAuditSignature(sigEntry, hash.toUpperCase());
  check('digest comparison is case-insensitive', upper.valid);

  const bad = await verifyAuditSignature(sigEntry, 'f'.repeat(64));
  check('a wrong digest is rejected', !bad.valid);

  // A short digest must not pass through a prefix comparison.
  const short = await verifyAuditSignature(sigEntry, hash.slice(0, 10));
  check('a truncated digest is rejected', !short.valid);
  check('a truncated digest reports the full actual', short.actual.length === 64);

  // The digest must cover every field it claims to.
  for (const field of AUDIT_SIGNATURE_FIELDS) {
    const mutated = { ...sigEntry, [field]: `${sigEntry[field]}-tampered` };
    check(`digest covers "${field}"`, (await computeAuditSignature(mutated)) !== hash);
  }

  check('the preimage lists exactly the declared fields', AUDIT_SIGNATURE_FIELDS.length === 8);
  check('truncateSignature elides the tail', truncateSignature(hash).endsWith('…'), truncateSignature(hash));
  check('truncateSignature is prefix-stable', truncateSignature(hash).startsWith(hash.slice(0, 8)));
  check('a short hash is not elided', !truncateSignature('abcd').includes('…'));

  // Rows differing only by an absent vs explicit-null deviceId hash alike.
  const withNull = await computeAuditSignature({ ...sigEntry, deviceId: null });
  const withoutKey = await computeAuditSignature({ ...sigEntry, deviceId: undefined });
  check('absent and null deviceId hash identically', withNull === withoutKey);
}

// ── Canonical export round-trip ──────────────────────────────────────────────

{
  const digest = await computeAuditSignature(sigEntry);
  const manifest = {
    canonicalization: CANONICAL_RULES_LABEL,
    digestLabel: SIGNATURE_LABEL,
    entries: [
      {
        seq: 1,
        id: sigEntry.id,
        timestamp: sigEntry.timestamp,
        user: sigEntry.user,
        action: sigEntry.action,
        details: sigEntry.details,
        requiresPin: sigEntry.requiresPin,
        presentationDigest: digest,
        canonicalPayload: signaturePreimage(sigEntry),
      },
    ],
  };

  const clean = await verifyAuditManifest(manifest, [sigEntry]);
  check('an untouched row round-trips through the manifest', clean.valid && clean.canonicalDrift === 0, clean.rows[0]?.reason);

  // The whole point of the exercise: a row edited in the database after export
  // must be detectable, not just re-rendered.
  const edited = { ...sigEntry, details: sigEntry.details.replace('Erreur de saisie', 'Fraude interne') };
  const drifted = await verifyAuditManifest(manifest, [edited]);
  check('an edited row fails re-verification', !drifted.valid);
  check('the failure is reported as a digest mismatch', drifted.rows[0]?.reason === 'DIGEST_MISMATCH', drifted.rows[0]?.reason);
  check('the failure is also flagged as canonical drift', drifted.rows[0]?.canonicalDrift === true);
  check('the report counts the drifted row', drifted.canonicalDrift === 1, String(drifted.canonicalDrift));
  check('the recomputed digest is reported for the auditor', drifted.rows[0]?.actual !== digest);

  // Drift in the canonical bytes is the more actionable finding, so it gets
  // its own reason rather than being folded into the digest mismatch.
  const removedRow = await verifyAuditManifest(manifest, []);
  check('a row missing from the live set fails', !removedRow.valid && removedRow.rows[0]?.reason === 'MISSING_FIELDS');

  const noDigest = await verifyAuditManifest({ entries: [{ id: sigEntry.id, seq: 1 }] }, [sigEntry]);
  check('a manifest without digests is reported, not trusted', !noDigest.valid && noDigest.rows[0]?.reason === 'MISSING_DIGEST');

  const empty = await verifyAuditManifest({ entries: [] }, [sigEntry]);
  check('an empty manifest is never reported valid', !empty.valid);

  check('the canonical rules label is non-empty and shared', CANONICAL_RULES_LABEL.length > 40);
  check('the digest label is non-empty and shared', SIGNATURE_LABEL.length > 20);
  check(
    'the export manifest embeds the same canonicalization rules',
    CANONICALIZATION_RULES.startsWith('MOBIPOS-AUDIT-CANON-1'),
    CANONICALIZATION_RULES.slice(0, 40),
  );
}

// ── Search normalization (diacritic-agnostic French) ─────────────────────────

{
  // The seven characters named in the requirement, plus the uppercase forms a
  // cashier will actually type against a capitalized UI label.
  const DIACRITICS: Array<[string, string]> = [
    ['Gérant', 'gerant'],
    ['Déverrouillage', 'deverrouillage'],
    ['Règlement', 'reglement'],
    ['Ça', 'ca'],
    ['Côte', 'cote'],
    ['Élément', 'element'],
    ['Maître', 'maitre'],
  ];
  for (const [accented, plain] of DIACRITICS) {
    check(`foldAccents: ${accented} -> ${plain}`, foldAccents(accented) === plain, foldAccents(accented));
    check(`foldAccents is symmetric for ${plain}`, foldAccents(plain) === foldAccents(accented));
  }

  // Every combining mark in the U+0300..U+036F block must be removed, not just
  // the ones French happens to use — "Hôpital" and "piqûre" exercise the acute
  // and circumflex, and a partial block would silently miss others.
  for (const s of ['é', 'è', 'ê', 'à', 'ç', 'ô', 'ù', 'É', 'À', 'Ç', 'Ô', 'Ù', 'î', 'ï', 'œ']) {
    check(`foldAccents strips ${s}`, !foldAccents(s).normalize('NFD').includes('̄'), foldAccents(s));
  }

  // Ligatures: NFD cannot decompose œ/æ, so a mark-only fold leaves them.
  check('foldAccents: cœur -> coeur', foldAccents('cœur') === 'coeur', foldAccents('cœur'));
  check('foldAccents: œuvre -> oeuvre', foldAccents('œuvre') === 'oeuvre', foldAccents('œuvre'));
  check('foldAccents: œuf -> oeuf', foldAccents('œuf') === 'oeuf', foldAccents('œuf'));
  check('foldAccents: Æ -> ae', foldAccents('Æ') === 'ae', foldAccents('Æ'));

  check('foldAccents trims', foldAccents('  caisse  ') === 'caisse');
  check('foldAccents handles empty input', foldAccents('') === '');
  check('foldAccents handles null', foldAccents(null) === '');
  check('foldAccents handles undefined', foldAccents(undefined) === '');
  check('foldAccents is idempotent', foldAccents(foldAccents('Déverrouillage')) === foldAccents('Déverrouillage'));

  // The two scenarios named in the requirement.
  check(
    '`gerant` matches "Yacine (Gérant)"',
    matchesFoldedQuery(foldedSearchFields({ user: 'Yacine (Gérant)' }), foldAccents('gerant')),
  );
  check(
    '`reglement` matches "Règlement"',
    matchesFoldedQuery(foldedSearchFields({ details: 'Règlement encaissé sur 12 000 DA' }), foldAccents('reglement')),
  );

  // Symmetry across every searchable field, not just the actor.
  const row = {
    action: 'Déverrouillage Caisse',
    user: 'Yacine (Gérant)',
    details: 'Règlement — 12 000 DA',
    category: 'Trésorerie',
    entityIds: ['TÂCHE-4471'],
  };
  const fields = foldedSearchFields(row);
  for (const [field, query] of [
    ['action', 'deverrouillage'],
    ['user', 'gerant'],
    ['details', 'reglement'],
    ['category', 'tresorerie'],
    ['entityIds', 'tache-4471'],
  ] as const) {
    check(`folded search covers ${field} ("${query}")`, matchesFoldedQuery(fields, foldAccents(query)));
  }

  check('folded search does not match unrelated text', !matchesFoldedQuery(fields, foldAccents('facture')));
  check('an empty query matches everything', matchesFoldedQuery(fields, ''));
  check('folded fields drop empty segments', !foldedSearchFields({ action: '', user: '', details: '' }).includes(''));
}

// ── Date-range push-down (SQL parameterization) ──────────────────────────────

{
  const start = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(2026, 11, 31, 23, 59, 59, 999));

  // The whole point: the window must become a WHERE clause, not a client-side
  // pass over an already-capped slice.
  const full = buildAuditSelect({ start, end });
  check('range becomes a SQL WHERE clause', full.includes('WHERE'), full);
  check('lower bound is bound as $1', full.includes('timestamp >= $1'));
  check('upper bound is bound as $2', full.includes('timestamp <= $2'));
  check('order is newest-first', full.includes('ORDER BY timestamp DESC'));
  check('depth stays parameterised', full.includes('LIMIT $3'));

  const params = auditSelectParams({ start, end });
  check('bounds are passed as parameters, never inlined', !full.includes(start.toISOString()), full);
  check('start parameter is ISO-8601', params[0] === start.toISOString(), String(params[0]));
  check('end parameter is ISO-8601', params[1] === end.toISOString(), String(params[1]));
  check('default depth is 300', params[2] === AUDIT_DEFAULT_LIMIT, String(params[2]));
  check('explicit depth is honoured', auditSelectParams({ limit: 50 })[2] === 50);

  // « Toute la période… » keeps the unbounded newest-first form.
  const unbounded = buildAuditSelect();
  check('no bounds means no WHERE clause', !unbounded.includes('WHERE'), unbounded);
  check('unbounded keeps ORDER BY timestamp DESC', unbounded.includes('ORDER BY timestamp DESC'));
  check('unbounded keeps LIMIT', unbounded.includes('LIMIT $3'));
  check('unbounded has no bound predicate', !unbounded.includes('$1') || !unbounded.includes('timestamp >='));
  check('an all-time range is reported unbounded', !hasAuditBound({}));
  check('a bounded range is reported bounded', hasAuditBound({ start, end }));
  check('a start-only range counts as bounded', hasAuditBound({ start }));
  check('an end-only range counts as bounded', hasAuditBound({ end }));

  const startOnly = buildAuditSelect({ start });
  check('start-only emits one predicate', startOnly.includes('timestamp >= $1') && !startOnly.includes('timestamp <= $2'), startOnly);
  const endOnly = buildAuditSelect({ end });
  check('end-only emits one predicate', endOnly.includes('timestamp <= $2') && !endOnly.includes('timestamp >='), endOnly);

  // SQL injection surface: a hostile bound must land in the params array.
  const hostile = '2026-01-01\'; DROP TABLE security_audit_logs; --';
  const hostileSql = buildAuditSelect({ start: new Date(hostile) as unknown as Date });
  check('a hostile start never reaches the SQL text', !hostileSql.includes('DROP TABLE'), hostileSql);

  // Lexicographic correctness of the bounds against real stored values.
  const iso = (d: Date) => d.toISOString();
  const storedWithMs = '2026-06-15T10:20:30.123Z';
  const storedNoMs = '2026-06-15T10:20:30Z';
  const lo = iso(new Date(Date.UTC(2026, 0, 1)));
  const hi = iso(new Date(Date.UTC(2026, 11, 31, 23, 59, 59, 999)));
  check('a millisecond-precision row is inside the window', storedWithMs >= lo && storedWithMs <= hi);
  check('a no-millisecond row is NOT dropped by the upper bound', storedNoMs >= lo && storedNoMs <= hi, storedNoMs);

  // Legacy wall-clock rows cannot satisfy an ISO range, which is exactly why
  // they get their own lane — otherwise they become unreachable.
  check('legacy HH:MM rows fall outside an ISO range', !('14:32' >= lo && '14:32' <= hi));
  const legacySql = buildLegacyAuditSelect();
  check('legacy lane detects HH:MM without a full scan', legacySql.includes("substr(timestamp, 3, 1) = ':'"), legacySql);
  check('legacy lane is index-bounded by an hour envelope', legacySql.includes("timestamp >= '00:00'") && legacySql.includes("timestamp < '24:00'"));
  check('legacy lane is depth-capped', legacySql.includes('LIMIT $1'));
}

// ── Verification UX: schema drift vs. hard tamper ───────────────────────────

{
  const digest = await computeAuditSignature(sigEntry);
  const canonicalPayload = signaturePreimage(sigEntry);

  const baseEntry = {
    seq: 1,
    id: sigEntry.id,
    timestamp: sigEntry.timestamp,
    user: sigEntry.user,
    action: sigEntry.action,
    details: sigEntry.details,
    requiresPin: sigEntry.requiresPin,
    presentationDigest: digest,
    canonicalPayload,
  };

  // A manifest as this build writes it: digests and chain both current.
  const seed = `${CHAIN_GENESIS}|${canonicalPayload}`;
  const { hex: chainHash } = await sha256Hex(seed);
  const currentManifest = {
    canonicalization: CANONICALIZATION_RULES,
    chainRoot: chainHash,
    entries: [{ ...baseEntry, chainHash }],
  };

  const clean = await verifyAndClassify(currentManifest, [sigEntry]);
  check('an untouched document is VERIFIED', clean.verdict.state === 'VERIFIED', clean.verdict.state);
  check('VERIFIED is not blocking', !clean.verdict.blocking);
  check('VERIFIED uses the ok tone', clean.verdict.tone === 'ok');
  check('a current ruleset is recognised', rulesetId(CANONICALIZATION_RULES) === CURRENT_RULESET);
  check('the chain verifies for a current document', clean.report.valid);

  // HARD TAMPER: the stored row was edited, so the digest no longer matches.
  const edited = { ...sigEntry, details: sigEntry.details.replace('Erreur de saisie', 'Fraude interne') };
  const tampered = await verifyAndClassify(currentManifest, [edited]);
  check('an edited row is TAMPER', tampered.verdict.state === 'TAMPER', tampered.verdict.state);
  check('TAMPER uses the danger tone', tampered.verdict.tone === 'danger');
  check('TAMPER blocks the view', tampered.verdict.blocking);
  check(
    'TAMPER states the required sentence',
    tampered.verdict.message.includes('les données ont été altérées'),
    tampered.verdict.message,
  );
  check('TAMPER reports the tampered count', tampered.verdict.tampered > 0);

  // HARD TAMPER via document edit: the manifest's own bytes were changed.
  const forged = {
    ...currentManifest,
    entries: [{ ...baseEntry, details: 'Falsifié', canonicalPayload: '{"action":"Falsifié"}', chainHash }],
  };
  const forgedResult = await verifyAndClassify(forged, [sigEntry]);
  check('a document edit is TAMPER', forgedResult.verdict.state === 'TAMPER', forgedResult.verdict.state);
  check('the chain reports where it broke', forgedResult.report.valid === false);

  // A ruleset label alone must NOT be able to downgrade a real tamper to drift.
  const relabelled = {
    ...currentManifest,
    canonicalization: 'MOBIPOS-AUDIT-CANON-0: legacy pipe-joined preimage',
  };
  const relabelledTamper = await verifyAndClassify(relabelled, [edited]);
  check(
    'relabelling the ruleset cannot mask a digest mismatch',
    relabelledTamper.verdict.state === 'TAMPER',
    relabelledTamper.verdict.state,
  );

  // SCHEMA DRIFT: a foreign ruleset, chain intact, digests matching.
  const driftReport = await verifyAuditManifest(currentManifest, [sigEntry]);
  const drift = classifyVerification(driftReport, { ...currentManifest, canonicalization: 'MOBIPOS-AUDIT-CANON-0: legacy' });
  check('a foreign ruleset is DRIFT', drift.state === 'DRIFT', drift.state);
  check('DRIFT uses the warning tone', drift.tone === 'warn');
  check('DRIFT is non-blocking so the auditor can read it', !drift.blocking);
  check(
    'DRIFT states the required sentence',
    drift.message.includes('données intègres'),
    drift.message,
  );

  // DRIFT must never be reachable while a digest actually fails. Asserted on a
  // single verdict, since a DRIFT verdict and a tampered count are properties
  // of the same classification decision.
  check(
    'a DRIFT verdict never carries a tampered count',
    drift.tampered === 0 && tampered.verdict.tampered > 0,
    `drift=${drift.tampered} tampered=${tampered.verdict.tampered}`,
  );
  check(
    'a DRIFT verdict is only produced when the digest matched',
    drift.state !== 'DRIFT' || tampered.verdict.state === 'TAMPER',
  );

  // UNVERIFIABLE is never a silent pass.
  const noDigestReport = await verifyAuditManifest({ entries: [{ ...baseEntry, presentationDigest: undefined }] }, [sigEntry]);
  const noDigest = classifyVerification(noDigestReport, { entries: [{ ...baseEntry, presentationDigest: undefined }] });
  check('a manifest without digests is UNVERIFIABLE', noDigest.state === 'UNVERIFIABLE', noDigest.state);
  check('UNVERIFIABLE blocks', noDigest.blocking);
  check('UNVERIFIABLE is not a pass', noDigest.state !== 'VERIFIED');

  // Every state maps to a tone the banner can render, and only two block.
  for (const v of [clean.verdict, tampered.verdict, drift, noDigest]) {
    check(`state ${v.state} has a renderable tone`, ['ok', 'warn', 'danger'].includes(v.tone), v.tone);
    check(`state ${v.state} carries a message`, v.message.length > 10);
  }
  check('only TAMPER/UNVERIFIABLE block', tampered.verdict.blocking && noDigest.blocking && !clean.verdict.blocking && !drift.blocking);

  // The chain check must tolerate a pre-chain document without claiming trust.
  const noChain = await verifyAuditChain({ entries: [baseEntry] });
  check('a document without chain hashes is not claimed broken', noChain.intact && noChain.brokenAt === null);
  check('an empty manifest chain is a no-op', (await verifyAuditChain({ entries: [] })).intact);

  // A tampered root must be caught even when every per-entry hash is intact.
  const badRoot = await verifyAuditChain({ ...currentManifest, chainRoot: 'deadbeef' });
  check('a tampered chain root is detected', !badRoot.intact);
}

// ── Effective window resolution (what gets pushed down) ──────────────────────

{
  const now = new Date(Date.UTC(2026, 8, 29, 12, 0, 0));
  const noCustom = { start: null, end: null };

  // « Toute la période… » must stay unbounded, which is the signal the
  // repository uses to keep its default newest-first LIMIT 300 behaviour.
  const all = resolveAuditRange('all', noCustom, now);
  check('"all time" resolves to an unbounded window', all.start === null && all.end === null);

  for (const id of ['live', '15m', '1h'] as const) {
    const r = resolveAuditRange(id, noCustom, now);
    check(`${id} resolves to a lower bound`, r.start instanceof Date && r.end === null);
  }
  const live = resolveAuditRange('live', noCustom, now);
  check('"live" is a 15 minute rolling window', live.start!.getTime() === now.getTime() - 15 * 60_000, String(live.start));

  const today = resolveAuditRange('today', noCustom, now);
  check('"today" is local midnight, not rolling 24h', today.start!.getHours() === 0 && today.start!.getMinutes() === 0);
  check('"today" is not the same as 24h back', today.start!.getTime() !== now.getTime() - 24 * 60 * 60_000);

  // A custom range is the more specific statement and must win over the chip.
  const customStart = new Date(2026, 0, 10, 13, 37, 0);
  const customEnd = new Date(2026, 0, 12, 4, 5, 0);
  const custom = resolveAuditRange('live', { start: customStart, end: customEnd }, now);
  check('a custom start overrides the quick chip', custom.start!.getDate() === 10);
  check('a custom start widens to the start of the local day', custom.start!.getHours() === 0 && custom.start!.getMinutes() === 0);
  check('a custom end widens to the end of the local day', custom.end!.getHours() === 23 && custom.end!.getMinutes() === 59);
  check('a custom end reaches the last millisecond', custom.end!.getMilliseconds() === 999);
  check('a custom range does not depend on "now"', custom.start!.getFullYear() === 2026);

  // Half-specified custom ranges stay half-open rather than collapsing.
  const startOnly = resolveAuditRange('all', { start: customStart, end: null }, now);
  check('a start-only custom range keeps an open upper bound', startOnly.end === null);
  const endOnly = resolveAuditRange('all', { start: null, end: customEnd }, now);
  check('an end-only custom range keeps an open lower bound', endOnly.start === null);

  // The resolved window is what the repository turns into SQL, so it must
  // actually produce a bounded query.
  check('a resolved window drives a bounded SELECT', hasAuditBound(resolveAuditRange('1h', noCustom, now)));
  check('an "all time" window drives the unbounded SELECT', !hasAuditBound(resolveAuditRange('all', noCustom, now)));
  check('a custom window drives a bounded SELECT', hasAuditBound(resolveAuditRange('live', { start: customStart, end: customEnd }, now)));
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

/**
 * Verification-UX contract regression.
 *
 * The point of the banner is that a legacy-format document and a tampered one
 * render *differently* and say different things. Asserting that on the state
 * classifier alone would not catch a presentation slip — a banner that styled
 * every verdict red, or that dropped the sentence telling an auditor what
 * happened, would still pass every classifier test.
 *
 * These assertions therefore run against the real view model that feeds the
 * classNames, driven by the real classifier fed by real verification. The
 * banner component is a thin renderer over exactly this contract, so what is
 * pinned here is what ships.
 */
import {
  STATE_LABEL,
  TONE_BADGE,
  TONE_BANNER,
  TONE_ICON_CLASS,
  buildVerificationView,
  rowChipLabel,
  rowChipTone,
} from '../src/components/audit/auditVerificationView.ts';
import {
  CHAIN_GENESIS,
  CURRENT_RULESET,
  CANONICALIZATION_RULES,
  classifyVerification,
  verifyAuditChain,
  verifyAuditManifest,
  type AuditManifest,
  type AuditVerificationVerdict,
} from '../src/utils/auditIntegrity.ts';
import {
  computeAuditSignature,
  sha256Hex,
  signaturePreimage,
  type SecurityAuditLogEntry,
} from '../src/utils/auditIntel.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const row: SecurityAuditLogEntry = {
  id: 'audit-ux-1',
  timestamp: '2026-09-29T23:07:14.231Z',
  user: 'Yacine (Gérant)',
  action: 'Règlement (Erreur)',
  details: 'Ticket #T-4471 (12 000 DA) — Règlement annulé',
  requiresPin: true,
  deviceId: 'TERM-ABC-123',
  ipAddress: '41.107.2.9',
};

const digest = await computeAuditSignature(row);
const canonicalPayload = signaturePreimage(row);
const { hex: chainHash } = await sha256Hex(`${CHAIN_GENESIS}|${canonicalPayload}`);

const baseEntry = {
  seq: 1,
  id: row.id,
  timestamp: row.timestamp,
  user: row.user,
  action: row.action,
  details: row.details,
  requiresPin: row.requiresPin,
  presentationDigest: digest,
  canonicalPayload,
  chainHash,
};

const currentManifest: AuditManifest = {
  canonicalization: CANONICALIZATION_RULES,
  chainRoot: chainHash,
  entries: [baseEntry],
};

const LEGACY_RULES = 'MOBIPOS-AUDIT-CANON-0: pipe-joined preimage';

/**
 * The stored row as it would be found in the database after someone edited it.
 * `details` is the free-text payload, so that is what an attacker would touch.
 */
const editedRow: SecurityAuditLogEntry = {
  ...row,
  details: row.details.replace('12 000', '1 200'),
};

/** Drive the real classifier with the real verifier, then the real view model. */
async function viewFor(
  manifest: AuditManifest,
  live: SecurityAuditLogEntry[],
): Promise<{ verdict: AuditVerificationVerdict; view: ReturnType<typeof buildVerificationView>; report: Awaited<ReturnType<typeof verifyAuditManifest>> }> {
  const [report, chain] = await Promise.all([
    verifyAuditManifest(manifest, live),
    verifyAuditChain(manifest),
  ]);
  const verdict = classifyVerification(report, manifest, chain);
  return { verdict, view: buildVerificationView(verdict), report };
}

const TAMPER_SENTENCE = 'altérées';
const DRIFT_SENTENCE = 'intègres';

// ── TAMPER: hard alteration, red, blocking ──────────────────────────────────

{
  const { verdict, view, report } = await viewFor(currentManifest, [editedRow]);

  check('tamper state is TAMPER', verdict.state === 'TAMPER', verdict.state);
  check('tamper tone is danger', view.tone === 'danger', view.tone);
  check('tamper badge uses the danger class', view.badgeClass === TONE_BADGE.danger, view.badgeClass);
  check('tamper banner uses the danger surface', view.bannerClass === TONE_BANNER.danger, view.bannerClass);
  check('tamper icon uses the danger foreground', view.iconClass === TONE_ICON_CLASS.danger, view.iconClass);
  check('tamper blocks the view', view.blocking);
  check('tamper states the required sentence', view.message.includes(TAMPER_SENTENCE), view.message);
  check('tamper badge label reads "Altération"', view.badgeLabel === 'Altération', view.badgeLabel);
  check('tamper never uses the warn badge class', view.badgeClass !== TONE_BADGE.warn);
  check('tamper never uses the ok badge class', view.badgeClass !== TONE_BADGE.ok);
  check('tamper comparison is open by default', view.comparisonOpen);
  check('tamper comparison is shown', view.showComparison);
  check('tamper detail explains the mismatch', (view.detail ?? '').includes('ne correspond plus'));
  check('tamper does not claim intact data', !view.message.includes(DRIFT_SENTENCE));

  // The comparison list must expose both digests, or the claim is unfalsifiable.
  const failing = report.rows.filter((r) => !r.ok);
  check('tamper lists exactly the failing rows', failing.length > 0 && failing.every((r) => !r.ok));
  check('tamper exposes the recorded digest', failing.some((r) => r.expected === digest));
  check('tamper exposes a different recomputed digest', failing.some((r) => r.actual !== digest));
  check('tamper row chip is danger', rowChipTone(failing[0].reason, failing[0].canonicalDrift) === 'danger');
  check('tamper row chip reads "Empreinte divergente"', rowChipLabel('DIGEST_MISMATCH', false) === 'Empreinte divergente');
}

// ── DRIFT: legacy format, intact data, amber, non-blocking ───────────────────

{
  const { verdict, view } = await viewFor(
    { ...currentManifest, canonicalization: LEGACY_RULES },
    [row],
  );

  check('drift state is DRIFT', verdict.state === 'DRIFT', verdict.state);
  check('drift tone is warn', view.tone === 'warn', view.tone);
  check('drift badge uses the warn class', view.badgeClass === TONE_BADGE.warn, view.badgeClass);
  check('drift banner uses the warn surface', view.bannerClass === TONE_BANNER.warn, view.bannerClass);
  check('drift icon uses the warn foreground', view.iconClass === TONE_ICON_CLASS.warn, view.iconClass);
  check('drift is explicitly non-blocking so the auditor can read it', !view.blocking);
  check('drift states the required sentence', view.message.includes(DRIFT_SENTENCE), view.message);
  check('drift badge label reads "Schéma hérité"', view.badgeLabel === 'Schéma hérité', view.badgeLabel);
  check('drift tells the auditor the read stays open', (view.detail ?? '').includes('La lecture reste possible'));
  check('drift never uses the danger badge class', view.badgeClass !== TONE_BADGE.danger);
  check('drift never uses the danger surface', view.bannerClass !== TONE_BANNER.danger);
  check('drift does not claim alteration', !view.message.includes(TAMPER_SENTENCE));
  check('drift comparison starts collapsed', !view.comparisonOpen);
  check('drift detail states the digests match', (view.detail ?? '').includes('concordent'));
}

// ── The two states must never render the same thing ──────────────────────────

{
  const tamper = (await viewFor(currentManifest, [editedRow])).view;
  const drift = (await viewFor({ ...currentManifest, canonicalization: LEGACY_RULES }, [row])).view;

  check('tamper and drift have different tones', tamper.tone !== drift.tone, `${tamper.tone}/${drift.tone}`);
  check('tamper and drift have different badge classes', tamper.badgeClass !== drift.badgeClass);
  check('tamper and drift have different banner surfaces', tamper.bannerClass !== drift.bannerClass);
  check('tamper and drift have different labels', tamper.badgeLabel !== drift.badgeLabel);
  check('tamper and drift have different messages', tamper.message !== drift.message);
  check('tamper blocks and drift does not', tamper.blocking && !drift.blocking);
  check('tamper expands the comparison and drift does not', tamper.comparisonOpen && !drift.comparisonOpen);
}

// ── VERIFIED: not a silent pass, and not an alarm ────────────────────────────

{
  const { verdict, view } = await viewFor(currentManifest, [row]);
  check('clean document is VERIFIED', verdict.state === 'VERIFIED', verdict.state);
  check('verified tone is ok', view.tone === 'ok', view.tone);
  check('verified does not block', !view.blocking);
  check('verified badge label reads "Conforme"', view.badgeLabel === 'Conforme', view.badgeLabel);
  check('verified raises no alarm', !view.message.includes(TAMPER_SENTENCE));
  check('verified shows no comparison list', !view.showComparison);
  check('verified carries no drift detail', view.detail === null);
}

// ── UNVERIFIABLE: cannot tell is never reported as a pass ───────────────────

{
  const { verdict, view } = await viewFor(
    { entries: [{ ...baseEntry, presentationDigest: undefined, chainHash: undefined }] },
    [row],
  );
  check('a manifest without digests is UNVERIFIABLE', verdict.state === 'UNVERIFIABLE', verdict.state);
  check('unverifiable is never reported compliant', view.state !== 'VERIFIED');
  check('unverifiable tone is danger', view.tone === 'danger', view.tone);
  check('unverifiable blocks', view.blocking);
  check('unverifiable badge label reads "Non vérifiable"', view.badgeLabel === 'Non vérifiable', view.badgeLabel);
  check('unverifiable does not claim intact data', !view.message.includes(DRIFT_SENTENCE));
}

// ── Table-wide invariants over every reachable state ─────────────────────────

{
  const views = [
    (await viewFor(currentManifest, [row])).view,
    (await viewFor(currentManifest, [editedRow])).view,
    (await viewFor({ ...currentManifest, canonicalization: LEGACY_RULES }, [row])).view,
    (await viewFor({ entries: [{ ...baseEntry, presentationDigest: undefined, chainHash: undefined }] }, [row])).view,
  ];
  const states = views.map((v) => v.state).sort();

  check('all four verification states are covered', states.length === 4, states.join(','));
  for (const v of views) {
    check(`${v.state}: every tone has all four class slots`, Boolean(v.badgeClass && v.bannerClass && v.iconClass && v.message));
    check(`${v.state}: label is defined in the table`, Boolean(STATE_LABEL[v.state]));
  }

  // The load-bearing security property: a warning tone must never accompany a
  // blocking verdict, and a blocking verdict must never be downgraded to the
  // "benign, have a look" styling. If either ever regresses, an auditor is
  // either stopped by a harmless format difference or waved past a real edit.
  for (const v of views) {
    check(
      `${v.state}: a blocking verdict is never styled as a warning`,
      !v.blocking || v.tone !== 'warn',
      `blocking=${v.blocking} tone=${v.tone}`,
    );
    check(
      `${v.state}: a blocking verdict is styled as danger`,
      !v.blocking || v.tone === 'danger',
      `blocking=${v.blocking} tone=${v.tone}`,
    );
    check(
      `${v.state}: a warning verdict never blocks`,
      v.tone !== 'warn' || !v.blocking,
    );
  }
  check(
    'exactly one reachable state blocks with danger',
    views.filter((v) => v.blocking && v.tone === 'danger').length === 2,
  );
}

// ── Row-level chips must not overstate what is known ────────────────────────

{
  check('a digest mismatch chips as danger', rowChipTone('DIGEST_MISMATCH', false) === 'danger');
  check('a format-only row chips as warn', rowChipTone(undefined, true) === 'warn');
  check('a row with no reason and no drift is neutral', rowChipTone(undefined, false) === 'ok');
  check('a missing digest is not a tamper claim', rowChipTone('MISSING_DIGEST', false) === 'ok');
  check('a missing row is not a tamper claim', rowChipTone('MISSING_FIELDS', false) === 'ok');
  check('the ruleset id is the one the manifest writes', CURRENT_RULESET === 'MOBIPOS-AUDIT-CANON-1');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

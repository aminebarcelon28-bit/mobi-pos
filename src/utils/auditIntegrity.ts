/**
 * Re-import verification for exported audit manifests.
 *
 * Split out of `auditExport` on purpose. Verification is pure data work — it
 * must be importable and testable without pulling in pdf-lib, ExcelJS or a
 * browser `Blob`, and it is needed by a future re-import screen that has no
 * business loading a PDF renderer to check a digest.
 *
 * The counterpart of this module is the digest the journal drawer displays:
 * `presentationDigest` in the manifest, the `canonicalPayload` it was derived
 * from, and the row as it is stored *now*.
 */
import type { SecurityAuditLogEntry } from '../types/pos.ts';
import {
  CANONICAL_RULES_LABEL,
  SIGNATURE_LABEL,
  computeAuditSignature,
  sha256Hex,
  signaturePreimage,
  verifyAuditSignature,
} from './auditIntel.ts';

export { CANONICAL_RULES_LABEL, SIGNATURE_LABEL };

/** Machine id of the canonicalization ruleset this build writes and expects. */
export const CURRENT_RULESET = 'MOBIPOS-AUDIT-CANON-1';

/** Genesis seed of the export chain. */
export const CHAIN_GENESIS = 'MOBIPOS-AUDIT-GENESIS';

/**
 * Rules statement embedded in the manifest so a document can be verified
 * without the app. Kept as a machine-tagged string: the `CANON-1` id pins the
 * ruleset, the rest is prose for the human reading the file.
 */
export const CANONICALIZATION_RULES =
  `${CURRENT_RULESET}: recursive key sort; undefined stripped; null normalized; ` +
  'floats pinned to 2 decimals; ISO-8601 normalized to UTC ms; locale whitespace (U+0020/U+00A0/U+202F) collapsed in numeric strings';

/** Extract the machine-readable ruleset id from a manifest's prose statement. */
export function rulesetId(canonicalization: string | undefined | null): string {
  if (!canonicalization) return '';
  const idx = canonicalization.indexOf(':');
  return (idx === -1 ? canonicalization : canonicalization.slice(0, idx)).trim();
}


export interface AuditManifestEntry {
  seq: number;
  id: string;
  timestamp: string;
  user: string;
  action: string;
  details: string;
  requiresPin: boolean;
  deviceId?: string | null;
  ipAddress?: string | null;
  chainHash?: string;
  presentationDigest?: string;
  canonicalPayload?: string;
}

export interface AuditManifest {
  canonicalization?: string;
  digestLabel?: string;
  chainRoot?: string;
  entries: AuditManifestEntry[];
}

export type AuditVerificationReason =
  | 'DIGEST_MISMATCH'
  | 'MISSING_DIGEST'
  | 'MISSING_FIELDS';

export interface AuditVerificationRow {
  id: string;
  ok: boolean;
  /** Digest recomputed from the row as stored now. */
  actual: string;
  /** Digest recorded in the manifest at export time. */
  expected: string | null;
  /**
   * Whether the row failed only because its canonical bytes changed.
   *
   * Kept separate from `reason` rather than folded into it: an edited row
   * fails *both* the digest and the byte comparison, and collapsing them into
   * one field would hide the fact that the digest check actually ran.
   * `ok` is false whenever this is true.
   */
  canonicalDrift: boolean;
  reason?: AuditVerificationReason;
}

export interface AuditVerificationReport {
  valid: boolean;
  total: number;
  checked: number;
  /** Rows whose recomputed canonical bytes differ from the exported ones. */
  canonicalDrift: number;
  rows: AuditVerificationRow[];
}

/**
 * Re-verify an exported manifest against the rows as they are stored *now*.
 *
 * A row that was edited after export fails here even though its chain hash
 * still looks well-formed — that is the whole reason the per-entry digest and
 * the exact canonical bytes are written alongside the chain.
 *
 * A drifted row is *also* a digest mismatch, so `reason` reports the verdict
 * and `canonicalDrift` reports the cause; an auditor needs both to tell "the
 * bytes moved" from "the digest no longer matches".
 */
export async function verifyAuditManifest(
  manifest: AuditManifest,
  liveEntries: SecurityAuditLogEntry[],
): Promise<AuditVerificationReport> {
  const liveById = new Map(liveEntries.map((e) => [e.id, e]));
  const rows: AuditVerificationRow[] = [];
  let canonicalDrift = 0;

  for (const entry of manifest.entries ?? []) {
    const live = liveById.get(entry?.id);
    if (!live) {
      rows.push({
        id: entry?.id ?? '(inconnu)',
        ok: false,
        actual: '',
        expected: entry?.presentationDigest ?? null,
        canonicalDrift: false,
        reason: 'MISSING_FIELDS',
      });
      continue;
    }

    const expected = entry.presentationDigest ?? null;
    if (!expected) {
      rows.push({
        id: entry.id,
        ok: false,
        actual: await computeAuditSignature(live),
        expected: null,
        canonicalDrift: false,
        reason: 'MISSING_DIGEST',
      });
      continue;
    }

    const { valid, actual } = await verifyAuditSignature(live, expected);

    // Recompute the canonical bytes from the live row and compare with what
    // was written at export time.
    const liveCanonical = signaturePreimage(live);
    const drifted = entry.canonicalPayload !== undefined && entry.canonicalPayload !== liveCanonical;
    if (drifted) canonicalDrift++;

    rows.push({
      id: entry.id,
      ok: valid && !drifted,
      actual,
      expected,
      canonicalDrift: drifted,
      ...(valid ? {} : { reason: 'DIGEST_MISMATCH' as const }),
    });
  }

  const checked = rows.length;
  return {
    // An empty manifest verifies nothing, so it can never be reported valid.
    valid: checked > 0 && rows.every((r) => r.ok),
    total: liveEntries.length,
    checked,
    canonicalDrift,
    rows,
  };
}

// ─── Verification UX: schema drift vs. hard tamper ───────────────────────────

/**
 * Why a document is or is not trustworthy.
 *
 * `DRIFT` and `TAMPER` look identical from the digest alone — a row edited
 * after export and a row exported by an older build both fail to hash the way
 * this build hashes. Collapsing them into one "verification failed" banner
 * trains auditors to ignore it, which is the opposite of what a tamper
 * indicator is for.
 */
export type AuditVerificationState =
  /** Every row matched. */
  | 'VERIFIED'
  /** Cannot be judged (no digest recorded, or rows absent). Never a pass. */
  | 'UNVERIFIABLE'
  /** A foreign ruleset, but the document is internally intact. Non-blocking. */
  | 'DRIFT'
  /** The recorded bytes no longer hash to the recorded digest. Blocking. */
  | 'TAMPER';

export interface AuditVerificationVerdict {
  state: AuditVerificationState;
  /** Semantic colour the UI must use. Never anything else for a given state. */
  tone: 'ok' | 'warn' | 'danger';
  /** Blocks the view. Only TAMPER and UNVERIFIABLE do. */
  blocking: boolean;
  /** Operator-facing sentence, stating the finding rather than the mechanism. */
  message: string;
  /** Count of rows in each failing state, for the summary line. */
  tampered: number;
  drifted: number;
  unverifiable: number;
}

const TAMPER_MESSAGE =
  'Échec de vérification : les données ont été altérées après l’exportation.';
const DRIFT_MESSAGE = 'Schéma antérieur détecté : données intègres mais format hérité.';
const UNVERIFIABLE_MESSAGE =
  'Vérification impossible : ce document ne contient pas les empreintes attendues.';

/**
 * Chain hash for entry `i`, given the previous link.
 *
 * The chain is recomputed from the manifest's OWN recorded canonical payloads.
 * That is what makes the ruleset label trustworthy: an attacker who edits
 * `details` must also recompute every subsequent chain hash and the root, and
 * flipping only the `canonicalization` label leaves the chain intact and the
 * edit exposed.
 */
async function chainHash(prev: string, canonicalPayload: string): Promise<string> {
  const { hex } = await sha256Hex(`${prev}|${canonicalPayload}`);
  return hex;
}

/** Recompute the export chain and compare it with what the document records. */
export async function verifyAuditChain(manifest: AuditManifest): Promise<{
  intact: boolean;
  root: string;
  brokenAt: number | null;
}> {
  const entries = manifest.entries ?? [];
  if (entries.length === 0) return { intact: true, root: CHAIN_GENESIS, brokenAt: null };

  let prev = CHAIN_GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // A document written before the chain embedded per-entry hashes has
    // nothing to check; that is a format fact, not an edit.
    if (!entry.chainHash) return { intact: true, root: prev, brokenAt: null };
    // The recorded canonical payload is the preimage, so an edit anywhere in
    // the entry breaks this link without needing the live row.
    const next = await chainHash(prev, entry.canonicalPayload ?? '');
    if (next !== entry.chainHash) return { intact: false, root: prev, brokenAt: i };
    prev = next;
  }
  if (manifest.chainRoot && manifest.chainRoot !== prev) {
    return { intact: false, root: prev, brokenAt: entries.length };
  }
  return { intact: true, root: prev, brokenAt: null };
}

/**
 * Collapse a verification report into the one state the UI should render.
 *
 * The precedence is the security argument:
 *  1. A broken chain means the *document itself* was edited — nothing else can
 *     be trusted, so it is TAMPER regardless of any other signal.
 *  2. A row whose digest does not match is TAMPER.
 *  3. A foreign ruleset, or a canonical-payload difference under a matching
 *     digest, is DRIFT: the bytes are provably what was exported, only the
 *     serialization is older. Benign, and the view stays open.
 *  4. "Cannot tell" is UNVERIFIABLE, never a pass.
 */
export function classifyVerification(
  report: AuditVerificationReport,
  manifest: AuditManifest,
  chain?: { intact: boolean; brokenAt: number | null },
): AuditVerificationVerdict {
  const rows = report.rows;
  const tampered = rows.filter((r) => r.reason === 'DIGEST_MISMATCH').length;
  const unverifiable = rows.filter(
    (r) => r.reason === 'MISSING_DIGEST' || r.reason === 'MISSING_FIELDS',
  ).length;
  const drifted = rows.filter((r) => r.canonicalDrift).length;

  const foreignRuleset = rulesetId(manifest.canonicalization) !== CURRENT_RULESET;

  if (chain && !chain.intact) {
    return {
      state: 'TAMPER',
      tone: 'danger',
      blocking: true,
      message: TAMPER_MESSAGE,
      tampered: Math.max(tampered, 1),
      drifted,
      unverifiable,
    };
  }
  if (unverifiable > 0) {
    return {
      state: 'UNVERIFIABLE',
      tone: 'danger',
      blocking: true,
      message: UNVERIFIABLE_MESSAGE,
      tampered,
      drifted,
      unverifiable,
    };
  }
  if (tampered > 0) {
    return {
      state: 'TAMPER',
      tone: 'danger',
      blocking: true,
      message: TAMPER_MESSAGE,
      tampered,
      drifted,
      unverifiable,
    };
  }
  if (foreignRuleset || drifted > 0) {
    return {
      state: 'DRIFT',
      tone: 'warn',
      // Deliberately non-blocking: the digest matched, so the content is
      // proven intact and an auditor must be able to read it.
      blocking: false,
      message: DRIFT_MESSAGE,
      tampered: 0,
      drifted,
      unverifiable: 0,
    };
  }
  return {
    state: 'VERIFIED',
    tone: 'ok',
    blocking: false,
    message: 'Document conforme : toutes les empreintes concordent.',
    tampered: 0,
    drifted: 0,
    unverifiable: 0,
  };
}

/** Convenience: verify and classify in one pass. */
export async function verifyAndClassify(
  manifest: AuditManifest,
  liveEntries: SecurityAuditLogEntry[],
): Promise<{ report: AuditVerificationReport; verdict: AuditVerificationVerdict }> {
  const [report, chain] = await Promise.all([
    verifyAuditManifest(manifest, liveEntries),
    verifyAuditChain(manifest),
  ]);
  return { report, verdict: classifyVerification(report, manifest, chain) };
}


/**
 * UPGRADE-08 — Device Trust Pack: pure primitives.
 *
 * Three concerns, all side-effect free so the suites can pin them without a
 * database:
 *
 *  1. Trade-In rubric — deterministic inspection markers (battery / screen /
 *     body / functional / water) → suggested condition grade. ADVISORY by
 *     design: the suggestion never silently overrides the operator's choice;
 *     every disagreement is recorded (`inconsistent`) and printable.
 *  2. Ownership-ledger event ids — deterministic so every lane's appends are
 *     idempotent: a BUSY retry or a recovery replay converges on ONE row
 *     instead of duplicating history.
 *  3. Blocked-device override grants — TTL helpers for the in-memory store map
 *     (a grant is a session thing; nothing is persisted, so a stale override
 *     can never outlive the session that authorized it).
 */
import type { ConditionGrade, TradeInInspectionMarkers } from '../types/pos';

export type { TradeInInspectionMarkers };

// ── 1. Trade-In rubric ──────────────────────────────────────────────────────

/** Rank for "is the chosen grade better than the rubric allows?" comparisons. */
const GRADE_RANK: Record<ConditionGrade, number> = {
  'Grade A (Comme Neuf)': 0,
  'Grade B (Bon État)': 1,
  'Grade C (Usagé)': 2,
  'Grade D (Écran Fissuré)': 3,
};

export interface TradeInGradeVerdict {
  suggestedGrade: ConditionGrade;
  /** Marker-based justification (French, operator-facing), deterministic order. */
  reasons: string[];
  /** True when the operator's grade differs from the suggested one. */
  inconsistent: boolean;
}

/**
 * Deterministic rubric. Hard disqualifiers first (water damage, cracked
 * screen, deformed frame, failed functions, battery under 70%) land on D;
 * otherwise A/B/C are read straight off the markers. Inputs are clamped, not
 * rejected: the rubric must never be the reason an intake form cannot submit.
 */
export function deriveTradeInGrade(
  markers: TradeInInspectionMarkers,
  chosenGrade: ConditionGrade
): TradeInGradeVerdict {
  const battery = Math.max(0, Math.min(100, Math.round(Number(markers.batteryHealthPercent) || 0)));
  const reasons: string[] = [];

  if (markers.water === 'constate') reasons.push('Traces d’eau constatées dans l’appareil');
  if (markers.screen === 'fissure') reasons.push('Écran fissuré');
  if (markers.body === 'deforme') reasons.push('Châssis déformé');
  if (!markers.functionalOk) reasons.push('Fonctions non validées (appel / réseau / capteurs)');
  if (battery < 70) reasons.push(`Batterie ${battery}% inférieure au seuil de 70%`);

  let suggestedGrade: ConditionGrade;
  if (reasons.length > 0) {
    suggestedGrade = 'Grade D (Écran Fissuré)';
  } else if (
    battery >= 90 &&
    markers.screen === 'intact' &&
    markers.body === 'comme_neuf' &&
    markers.water === 'aucun'
  ) {
    suggestedGrade = 'Grade A (Comme Neuf)';
  } else if (
    battery >= 85 &&
    (markers.body === 'comme_neuf' || markers.body === 'bon') &&
    markers.water === 'aucun'
  ) {
    suggestedGrade = 'Grade B (Bon État)';
  } else {
    suggestedGrade = 'Grade C (Usagé)';
    if (battery < 85) reasons.push(`Batterie ${battery}% inférieure au seuil de 85%`);
    if (markers.screen === 'micro_rayures') reasons.push('Micro-rayures sur l’écran');
    if (markers.body === 'marque') reasons.push('Traces d’usure sur le châssis');
    if (markers.water === 'suspecte') reasons.push('Trace d’humidité suspecte');
  }

  const inconsistent = chosenGrade !== suggestedGrade;
  if (inconsistent && GRADE_RANK[chosenGrade] < GRADE_RANK[suggestedGrade]) {
    reasons.push(`Grade retenu (${chosenGrade}) supérieur au référentiel (${suggestedGrade})`);
  }

  return { suggestedGrade, reasons, inconsistent };
}

/**
 * Persisted `trade_ins.inspection_json` envelope. Self-contained (markers +
 * verdict + chosen grade) so a reader never has to re-derive what the
 * operator saw.
 */
export function buildTradeInInspectionJson(
  markers: TradeInInspectionMarkers,
  chosenGrade: ConditionGrade
): string {
  const verdict = deriveTradeInGrade(markers, chosenGrade);
  return JSON.stringify({
    version: 1,
    markers,
    suggestedGrade: verdict.suggestedGrade,
    chosenGrade,
    inconsistent: verdict.inconsistent,
    reasons: verdict.reasons,
  });
}

/** Parse guard for display surfaces; unparseable payloads are `null`. */
export function parseTradeInInspectionJson(raw: unknown): {
  markers: TradeInInspectionMarkers;
  suggestedGrade?: ConditionGrade;
  inconsistent?: boolean;
} | null {
  try {
    const parsed = JSON.parse(String(raw ?? '')) as {
      markers?: TradeInInspectionMarkers;
      suggestedGrade?: ConditionGrade;
      inconsistent?: boolean;
    };
    if (!parsed || typeof parsed !== 'object' || !parsed.markers) return null;
    return {
      markers: parsed.markers,
      suggestedGrade: parsed.suggestedGrade,
      inconsistent: parsed.inconsistent,
    };
  } catch {
    return null;
  }
}

/** Display labels shared by the intake form, the voucher and the inspector. */
export const INSPECTION_SCREEN_LABELS: Record<TradeInInspectionMarkers['screen'], string> = {
  intact: 'Intact',
  micro_rayures: 'Micro-rayures',
  fissure: 'Fissuré',
};

export const INSPECTION_BODY_LABELS: Record<TradeInInspectionMarkers['body'], string> = {
  comme_neuf: 'Comme neuf',
  bon: 'Bon état',
  marque: 'Marqué',
  deforme: 'Déformé',
};

export const INSPECTION_WATER_LABELS: Record<TradeInInspectionMarkers['water'], string> = {
  aucun: 'Aucune trace',
  suspecte: 'Trace suspecte',
  constate: 'Trace constatée',
};

// ── 2. Ownership-ledger event primitives ────────────────────────────────────

export type ImeiTrustEventKind =
  | 'PO_RECEIVE'
  | 'TRADE_IN'
  | 'SALE'
  | 'RETURN_IN'
  | 'RETURN_DEFECTIVE'
  | 'REPAIR_INTAKE';

export const IMEI_TRUST_EVENT_LABELS: Record<ImeiTrustEventKind, string> = {
  PO_RECEIVE: 'Réception fournisseur',
  TRADE_IN: 'Rachat client',
  SALE: 'Vente',
  RETURN_IN: 'Retour boutique',
  // Defective restitution: device re-enters the ledger in quarantine
  // (`imei_records.status = 'defective'`), never sellable stock — mirrors
  // the native `RETURN_DEFECTIVE` event vocabulary byte-for-byte.
  RETURN_DEFECTIVE: 'Retour défectueux (SAV)',
  REPAIR_INTAKE: 'Prise en charge SAV',
};

/**
 * Deterministic ledger id: one row per (event kind, ref document, device).
 * `INSERT OR IGNORE` on this id is what makes retries and replays convergent.
 */
export function imeiTrustEventId(
  kind: ImeiTrustEventKind | string,
  refType: string,
  refId: string,
  canonicalIdentifier: string
): string {
  return `imev|${kind}|${refType}|${refId}|${canonicalIdentifier}`;
}

// ── 3. Blocked-device override grants (in-memory, TTL-bounded) ──────────────

/** How long a manager override stays usable before it must be re-granted. */
export const BLOCKED_DEVICE_OVERRIDE_TTL_MS = 10 * 60 * 1000;

/** Drops expired entries; returns the SAME map when nothing expired. */
export function pruneBlockedDeviceGrants(
  grants: Record<string, number>,
  now = Date.now()
): Record<string, number> {
  let changed = false;
  const next: Record<string, number> = {};
  for (const [key, expiry] of Object.entries(grants || {})) {
    if (Number(expiry) > now) {
      next[key] = Number(expiry);
    } else {
      changed = true;
    }
  }
  return changed ? next : grants;
}

export function hasFreshBlockedDeviceGrant(
  grants: Record<string, number>,
  canonicalKey: string,
  now = Date.now()
): boolean {
  const expiry = grants?.[canonicalKey];
  return Number(expiry) > now;
}

/** One-shot: the returned map no longer carries the consumed key. */
export function consumeBlockedDeviceGrant(
  grants: Record<string, number>,
  canonicalKey: string,
  now = Date.now()
): Record<string, number> {
  const pruned = pruneBlockedDeviceGrants(grants, now);
  const next: Record<string, number> = {};
  for (const [key, expiry] of Object.entries(pruned)) {
    if (key !== canonicalKey) next[key] = Number(expiry);
  }
  return next;
}

// ── 4. Typed error for intake lanes (SAV) ───────────────────────────────────

/**
 * Thrown by intake lanes whose contract is `Promise<void>` / throw-based:
 * the message is operator-readable AND the class lets the form detect the
 * blocked case to offer the audited manager override.
 */
export class BlockedDeviceError extends Error {
  readonly identifier: string;
  readonly blockReason: string;

  constructor(identifier: string, blockReason: string) {
    const cleanReason = String(blockReason ?? '').trim() || 'sans motif précisé';
    super(
      `Appareil bloqué : ${cleanReason} — dérogation gérant requise (identifiant ${identifier}).`
    );
    this.name = 'BlockedDeviceError';
    this.identifier = identifier;
    this.blockReason = String(blockReason ?? '').trim();
  }
}

/** Refusal-reason helpers (slice → surface strings). */
export const DEVICE_BLOCK_REFUSAL_PREFIX = 'DEVICE_BLOQUE:';
export const DEVICE_CHECK_UNAVAILABLE_REASON = 'DEVICE_CHECK_UNAVAILABLE';
export const INTAKE_BLOCK_REFUSAL_PREFIX = 'INTAKE_BLOQUE:';

export function parseBlockedRefusal(
  reason: string,
  prefix: string = DEVICE_BLOCK_REFUSAL_PREFIX
): { identifier: string; reasonText: string } | null {
  if (!reason || !reason.startsWith(prefix)) return null;
  const rest = reason.slice(prefix.length);
  const sep = rest.indexOf(':');
  if (sep < 0) return { identifier: rest, reasonText: '' };
  return { identifier: rest.slice(0, sep), reasonText: rest.slice(sep + 1) };
}

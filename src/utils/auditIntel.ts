/**
 * Security audit "intelligence" layer.
 *
 * The audit store persists a single free-text `details` column
 * (`SecurityAuditLogEntry.details`). The Journal d'Audit needs far more than
 * that string: severity, machine-checkable key/value pairs, before/after diffs,
 * entity references, exact vs relative timestamps and an integrity signature.
 *
 * Everything here is pure and side-effect free (except `computeAuditSignature`
 * and the browser-fingerprint helpers, which are isolated and guarded) so the
 * logic can be unit-tested headlessly from `scripts/test_audit_intel.mts`.
 */

import type { SecurityAuditLogEntry } from '../types/pos';

// ─────────────────────────────────────────────────────────────────────────────
// Search normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * French ligatures that NFD cannot decompose.
 *
 * `œ` (U+0153) and `æ` (U+00E6) are *precomposed* code points with a
 * compatibility decomposition only. `.normalize('NFD')` returns them
 * unchanged, so a purely mark-stripping fold leaves `cœur` and `coeur` as
 * different strings and a cashier typing "coeur" misses the row.
 *
 * This matters in a French POS: « cœur », « œuvre », « manœuvre », « œufs »
 * and store names like « Cœur de Ville » are ordinary audit text.
 */
const LIGATURES: Record<string, string> = {
  'œ': 'oe',
  'Œ': 'oe',
  'æ': 'ae',
  'Æ': 'ae',
  // German ß lowercases to "ss"; it survives NFD and would otherwise be
  // unmatchable from a Latin keyboard.
  'ß': 'ss',
};

/**
 * Case- and accent-insensitive fold for search.
 *
 * The specified contract is
 *   `str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()`
 * which is what the mark-stripping step below does, plus a pre-pass for the
 * ligatures NFD leaves intact. The extension is strictly additive: every input
 * the plain version folds correctly is still folded the same way here.
 *
 * Applied *symmetrically* — to the query and to every searchable field — so
 * `gerant` matches `Yacine (Gérant)` and `reglement` matches `Règlement`.
 * Folding only one side is the classic way this feature silently half-works.
 */
export function foldAccents(value: string | undefined | null): string {
  if (!value) return '';
  return String(value)
    .replace(/[œŒæÆß]/g, (ch) => LIGATURES[ch])
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Fields the journal searches, folded once per row.
 *
 * Declared as a function rather than an array of accessors so the query side
 * and the row side cannot drift apart — a field added here is automatically
 * searched on both ends of the comparison.
 */
export function foldedSearchFields(row: {
  action?: string;
  user?: string;
  details?: string;
  category?: string;
  entityIds?: readonly string[];
}): string[] {
  const parts: string[] = [
    foldAccents(row.action),
    foldAccents(row.user),
    foldAccents(row.details),
    foldAccents(row.category),
  ];
  for (const id of row.entityIds ?? []) parts.push(foldAccents(id));
  return parts.filter((p) => p !== '');
}

/** True when a folded query is a substring of any folded field. */
export function matchesFoldedQuery(foldedFields: readonly string[], foldedQuery: string): boolean {
  if (!foldedQuery) return true;
  return foldedFields.some((field) => field.includes(foldedQuery));
}

// ─────────────────────────────────────────────────────────────────────────────
// Timestamps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Audit rows are written as ISO-8601 since the P11.3 store change, but legacy
 * rows persisted only `toLocaleTimeString()` output ("14:32" / "14:32:07").
 * Returning `new Date()` for those would sort them as "now" and hide them from
 * every range filter, so interpret them as today at that wall-clock time.
 *
 * FORENSIC WARNING: that "today" is a display convention, not evidence — the
 * row carries no date. Presentation MUST go through `describeAuditTime()`,
 * which refuses to synthesize a date and labels these rows explicitly.
 */
export function parseAuditTimestamp(raw: string | undefined | null): Date {
  if (!raw) return new Date();

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;

  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(raw).trim());
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), Number(hm[3] ?? 0), 0);
    return d;
  }
  return new Date();
}

/** `2026-09-29 23:07:14.231 UTC` — the forensic timestamp shown on hover. */
export function formatExactUtc(date: Date): string {
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.` +
    `${pad(date.getUTCMilliseconds(), 3)} UTC`
  );
}

/** `2026-09-29T23:07:14.231Z` — the raw wire value, kept for the copy action. */
export function formatExactIso(date: Date): string {
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Forensic timestamp classification. The stored string — not the parsed Date —
 * is the evidence; anything downstream that renders a calendar date for a
 * `legacy-wall` row is synthesising facts the record does not contain.
 */
export type AuditTimestampKind = 'iso' | 'legacy-wall' | 'missing' | 'unparsable';

const LEGACY_WALL_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

export function classifyAuditTimestamp(raw: string | undefined | null): AuditTimestampKind {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return 'missing';
  if (!Number.isNaN(new Date(text).getTime())) return 'iso';
  if (LEGACY_WALL_RE.test(text)) return 'legacy-wall';
  return 'unparsable';
}

/**
 * Future-skew threshold shared with `formatRelativeTime`: a stored UTC instant
 * at or beyond this distance ahead of the viewing clock cannot have been
 * written "just now" — the device clock moved backward (or was fast at write).
 */
export const FUTURE_SKEW_THRESHOLD_MS = 45_000;

export function isFutureSkewed(
  date: Date,
  now: Date = new Date(),
  thresholdMs: number = FUTURE_SKEW_THRESHOLD_MS,
): boolean {
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() - now.getTime() >= thresholdMs;
}

export interface AuditTimeDescription {
  kind: AuditTimestampKind;
  /** Exact bytes stored in the record ('' when absent). Never synthesized. */
  raw: string;
  /** Parsed instant for sorting/filtering only — NOT evidence for legacy rows. */
  when: Date;
  /** Table-cell label. Never implies "today" for dateless rows. */
  relative: string;
  /** UTC rendering of the parsed instant ('—' when there is nothing to render). */
  exact: string;
  /** Copyable ISO rendering of the parsed instant ('—' when dateless). */
  iso: string;
  /** Stored UTC is ahead of the viewing clock: suspect device clock. */
  clockSkewed: boolean;
  /** Native tooltip: states what is known and what is not. */
  title: string;
}

/**
 * Single presentation authority for audit timestamps. Rules:
 * - `legacy-wall` rows NEVER resolve to "dans un instant" / "il y a X" and
 *   NEVER imply today: the label says the date is unknown and shows the raw
 *   wall-clock value.
 * - ISO rows ≥45s in the future render `Horloge locale décalée` instead of a
 *   normal countdown: the stamp postdates the viewing clock.
 * - `exact`/`iso` for legacy rows are the raw value, never a synthesized date.
 */
export function describeAuditTime(
  raw: string | undefined | null,
  now: Date = new Date(),
): AuditTimeDescription {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const kind = classifyAuditTimestamp(raw);
  const when = parseAuditTimestamp(raw);

  if (kind === 'legacy-wall') {
    return {
      kind,
      raw: text,
      when,
      relative: `date inconnue · ${text}`,
      exact: text,
      iso: text,
      clockSkewed: false,
      title: `Date d'origine inconnue (format hérité "${text}") — heure sans date, ne pas attribuer à aujourd'hui`,
    };
  }
  if (kind === 'missing' || kind === 'unparsable') {
    return {
      kind,
      raw: text,
      when,
      relative: kind === 'missing' ? 'non horodaté' : `format illisible · ${text || '—'}`,
      exact: text || '—',
      iso: text || '—',
      clockSkewed: false,
      title: 'Horodatage absent ou illisible — aucune date ne peut être affirmée',
    };
  }
  const clockSkewed = isFutureSkewed(when, now);
  if (clockSkewed) {
    return {
      kind,
      raw: text,
      when,
      relative: 'Horloge locale décalée',
      exact: formatExactUtc(when),
      iso: formatExactIso(when),
      clockSkewed: true,
      title: `Enregistré à ${formatExactUtc(when)} — postérieur à l'horloge de consultation : horloge de l'appareil suspecte`,
    };
  }
  return {
    kind,
    raw: text,
    when,
    relative: formatRelativeTime(when, now),
    exact: formatExactUtc(when),
    iso: formatExactIso(when),
    clockSkewed: false,
    title: `${formatExactUtc(when)} (${formatExactIso(when)})`,
  };
}

/** French relative label: « à l'instant », « il y a 2 min », « il y a 3 j ». */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  if (Number.isNaN(date.getTime())) return '—';

  const delta = now.getTime() - date.getTime();
  const abs = Math.abs(delta);

  // Clock skew from a peer device can put a row slightly in the future.
  if (abs < 45_000) return "à l'instant";
  if (delta < 0) return "dans un instant";

  if (abs < HOUR) return `il y a ${Math.max(1, Math.round(abs / MINUTE))} min`;
  if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    const m = Math.round((abs % HOUR) / MINUTE);
    return m > 0 ? `il y a ${h} h ${m} min` : `il y a ${h} h`;
  }
  const d = Math.floor(abs / DAY);
  if (d < 7) return `il y a ${d} j`;
  if (d < 31) return `il y a ${Math.floor(d / 7)} sem.`;
  if (d < 365) return `il y a ${Math.floor(d / 30)} mois`;
  return `il y a ${Math.floor(d / 365)} an(s)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Categories & severity
// ─────────────────────────────────────────────────────────────────────────────

export type AuditSeverity = 'critical' | 'warning' | 'info' | 'audit';

export interface AuditCategory {
  label: string;
  severity: AuditSeverity;
  /** Tailwind classes for the category chip (bg/text/border). */
  chip: string;
  /** Tailwind classes for the left severity rail of a table row. */
  rail: string;
}

export const SEVERITY_ORDER: Record<AuditSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  audit: 3,
};

export const SEVERITY_META: Record<
  AuditSeverity,
  { label: string; short: string; chip: string; text: string; dot: string; rail: string; badge: string }
> = {
  critical: {
    label: 'Critique',
    short: 'CRIT',
    chip: 'bg-pos-danger/15 text-pos-danger border-pos-danger/40',
    text: 'text-pos-danger',
    dot: 'bg-pos-danger',
    rail: 'bg-pos-danger',
    badge: 'pos-micro-badge--danger',
  },
  warning: {
    label: 'Avertissement',
    short: 'WARN',
    chip: 'bg-pos-warn/15 text-pos-warn border-pos-warn/40',
    text: 'text-pos-warn',
    dot: 'bg-pos-warn',
    rail: 'bg-pos-warn',
    badge: 'pos-micro-badge--warn',
  },
  info: {
    label: 'Information',
    short: 'INFO',
    chip: 'bg-pos-info/15 text-pos-info border-pos-info/40',
    text: 'text-pos-info',
    dot: 'bg-pos-info',
    rail: 'bg-pos-info',
    badge: 'pos-micro-badge--info',
  },
  audit: {
    label: 'Audit',
    short: 'AUDIT',
    chip: 'bg-pos-neutral/15 text-pos-neutral border-pos-neutral/40',
    text: 'text-pos-neutral',
    dot: 'bg-pos-neutral',
    rail: 'bg-pos-neutral',
    badge: 'pos-micro-badge--neutral',
  },
};

/**
 * Canonical category list. `value` MUST equal `getActionCategory().label` —
 * the multi-select filter compares against these exact strings.
 */
export const AUDIT_CATEGORIES: AuditCategory[] = [
  { label: 'Ouverture Tiroir', severity: 'warning', chip: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40', rail: SEVERITY_META.warning.rail },
  { label: 'Remise / Dérogation', severity: 'warning', chip: 'bg-amber-500/15 text-amber-300 border-amber-500/40', rail: SEVERITY_META.warning.rail },
  { label: 'Annulation / Suppression', severity: 'critical', chip: 'bg-rose-500/15 text-rose-300 border-rose-500/40', rail: SEVERITY_META.critical.rail },
  { label: 'Autorisation PIN', severity: 'info', chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40', rail: SEVERITY_META.info.rail },
  { label: 'Gestion Caisse', severity: 'warning', chip: 'bg-blue-500/15 text-blue-300 border-blue-500/40', rail: SEVERITY_META.warning.rail },
  { label: 'Création / Modification', severity: 'audit', chip: 'bg-violet-500/15 text-violet-300 border-violet-500/40', rail: SEVERITY_META.audit.rail },
  { label: 'Session', severity: 'info', chip: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/40', rail: SEVERITY_META.info.rail },
  { label: 'Accès Rapports', severity: 'info', chip: 'bg-teal-500/15 text-teal-300 border-teal-500/40', rail: SEVERITY_META.info.rail },
  { label: 'Autre', severity: 'audit', chip: 'bg-pos-muted/15 text-pos-muted border-pos-muted/30', rail: SEVERITY_META.audit.rail },
];

const FALLBACK_CATEGORY: AuditCategory = AUDIT_CATEGORIES[AUDIT_CATEGORIES.length - 1];

export function getActionCategory(action: string | undefined | null): AuditCategory {
  const act = (action || '').toLowerCase();
  const find = (needle: string) => act.includes(needle);

  if (find('tiroir') || find('no sale')) return AUDIT_CATEGORIES[0];
  if (find('remise') || find('dérogation') || find('prix') || find('perte') || find('écart')) return AUDIT_CATEGORIES[1];
  if (find('annulation') || find('suppression') || find('annulé') || find('annulée')) return AUDIT_CATEGORIES[2];

  // Session before PIN-authorisation: "Connexion / Déverrouillage Caisse"
  // names a session open, and the PIN keywords below would otherwise claim it
  // purely because it contains "Déverrouillage". "Échec Connexion PIN" still
  // resolves to PIN because "pin" is tested first.
  if (find('connexion') || find('déconnexion') || find('login') || find('écran') || find('déverrouillage') || find('session')) {
    return AUDIT_CATEGORIES[6];
  }

  if (find('pin') || find('sécurité') || find('responsable') || find('manager') || find('confisqué')) return AUDIT_CATEGORIES[3];

  if (find('recomptage') || find('clôture') || find('cloture') || find('caisse') || find('shift') || find('inventaire')) {
    return AUDIT_CATEGORIES[4];
  }
  if (find('création') || find('creation') || find('modification') || find('ajout') || find('mise à jour') || find('import') || find('génération')) return AUDIT_CATEGORIES[5];
  if (find('rapport') || find('consultation')) return AUDIT_CATEGORIES[7];
  return FALLBACK_CATEGORY;
}

/** Signals that raise a category's severity regardless of its default. */
const CRITICAL_SIGNALS = [
  'échec',
  'refus',
  'refusée',
  'bloquée',
  'bloquee',
  'tentative',
  'dépassement',
  'depassement',
  'anomalie',
  'invalide',
  'incorrect',
  'restauration',
  'contrefaçon',
  'inconnue',
];

const WARNING_SIGNALS = ['écart', 'ecart', 'demande', 'autorisation', 'contrainte', 'non soldée', 'non soldé'];

export function classifySeverity(
  action: string | undefined | null,
  details: string | undefined | null,
  requiresPin = false,
): AuditSeverity {
  const cat = getActionCategory(action);
  if (cat.severity === 'critical') return 'critical';

  const haystack = `${action || ''} ${details || ''}`.toLowerCase();
  if (CRITICAL_SIGNALS.some((s) => haystack.includes(s))) return 'critical';
  if (WARNING_SIGNALS.some((s) => haystack.includes(s))) return 'warning';
  // A manager override is an accountability event even when the underlying
  // action is routine: surface it above plain informational noise.
  if (requiresPin && cat.severity === 'audit') return 'info';
  return cat.severity;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity references
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditEntityRef {
  id: string;
  type: string;
  index: number;
  length: number;
}

const ENTITY_PATTERNS: { regex: RegExp; type: string }[] = [
  { regex: /Bon\s*#?\s*([A-Z0-9][A-Z0-9\-_/]{1,})/gi, type: 'Bon de Commande' },
  { regex: /Commande\s*#?\s*([A-Z0-9][A-Z0-9\-_/]{1,})/gi, type: 'Commande' },
  { regex: /Ticket\s*#?\s*([A-Z0-9][A-Z0-9\-_/]{1,})/gi, type: 'Ticket SAV' },
  { regex: /Avoir\s*#?\s*([A-Z0-9][A-Z0-9\-_/]{1,})/gi, type: 'Bon d’Avoir' },
  { regex: /Shift\s*#?\s*([A-Z0-9][A-Z0-9\-_/]{1,})/gi, type: 'Shift / Caisse' },
  { regex: /PO\s*#?\s*([A-Z0-9][A-Z0-9\-_/]{1,})/gi, type: 'Bon de Commande' },
  { regex: /Vente\s*#?\s*([A-Z0-9][A-Z0-9\-_/]{1,})/gi, type: 'Vente' },
  { regex: /Client\s*#?\s*([A-Z0-9][A-Z0-9\-_/]{1,})/gi, type: 'Client' },
  { regex: /Produit\s*#?\s*([A-Z0-9][A-Z0-9\-_/]{1,})/gi, type: 'Produit' },
  { regex: /([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12})/g, type: 'UUID' },
  { regex: /\b(shf_[a-z0-9]+)/g, type: 'Shift' },
  { regex: /\b(po_[a-z0-9]+)/g, type: 'Bon de Commande' },
  { regex: /\b(ord_[a-z0-9]+)/g, type: 'Commande' },
  { regex: /\b(tik_[a-z0-9]+)/g, type: 'Ticket SAV' },
];

/**
 * Single pass over `details`, de-duplicated and ordered by first appearance.
 * Offsets are kept so the table can hyperlink the exact matched span.
 */
export function extractEntityRefs(details: string | undefined | null): AuditEntityRef[] {
  const text = details || '';
  if (!text.trim()) return [];

  const hits: AuditEntityRef[] = [];
  const seen = new Set<string>();

  for (const { regex, type } of ENTITY_PATTERNS) {
    // The patterns are module-level and carry /g, so reset before every use.
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      // Trim trailing punctuation captured by the greedy character class.
      const id = raw.replace(/[.,;:)\]]+$/, '');
      if (id.length < 2) continue;
      const key = `${type}::${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const start = match.index + match[0].lastIndexOf(raw);
      hits.push({ id, type, index: start, length: raw.length });
      if (match[0].length === 0) regex.lastIndex++;
    }
  }

  hits.sort((a, b) => a.index - b.index);
  // Drop spans that overlap an already-accepted (longer, earlier) match.
  const out: AuditEntityRef[] = [];
  let cursor = -1;
  for (const hit of hits) {
    if (hit.index < cursor) continue;
    out.push(hit);
    cursor = hit.index + hit.length;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structured payload parsing
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditField {
  label: string;
  value: string;
}

export interface AuditChange {
  field: string;
  before: string;
  after: string;
  kind: 'changed' | 'added' | 'removed';
}

export type AuditMetricUnit = 'DA' | 'unité' | 'pt' | 'lot' | 'article' | 'variant' | 'saisie';

export interface AuditMetric {
  label: string;
  value: number;
  unit: AuditMetricUnit;
  display: string;
}

export interface AuditItem {
  label: string;
  quantity: number | null;
  unitPrice: number | null;
  total: number | null;
}

export interface AuditPayload {
  /** The raw `details` string, unchanged. */
  raw: string;
  /** Prose left over after fields/diffs/metrics were consumed. */
  narrative: string;
  fields: AuditField[];
  changes: AuditChange[];
  metrics: AuditMetric[];
  /** Lines removed by a destructive action (cart items, bundles, ...). */
  removedItems: AuditItem[];
  /** True when the parser found more structure than a plain sentence. */
  structured: boolean;
}

const SEGMENT_SPLIT = /\s*(?:•|·|\||;|\s-\s)\s*/g;

/** `key: value` where the key is a short human label. */
const FIELD_RE = /^(?:\*\*)?([A-Za-zÀ-ÿ' ]{2,28}?)(?:\*\*)?\s*:\s*(.+)$/;

// The number class must carry every separator a formatted amount can use: a
// plain space, NBSP and U+202F (the narrow no-break space fr-DZ emits for
// thousands). Omitting the plain space makes "12 500 DA" parse as "500".
const NUMBER_CHARS = '[\\d\u0020\u00A0\u202F.,]';
const WS = '[\\s\u00A0\u202F]';

const METRIC_RE = new RegExp(
  `([-+]?${NUMBER_CHARS}+)${WS}*\\b(DA|unités?|unite|pts?|points?|lot\\(s\\)|lots?|articles?|variantes?|entrées?|saisies?)\\b`,
  'gi',
);

// Greedy up to a segment boundary; the label, its optional quantity and its
// trailing quote are carved out in parseRemovedItems. A lazy quantifier here
// truncates every label to its first two characters, because the quantity
// group is optional and the engine takes the shortest acceptable match.
const ITEM_RE = new RegExp(
  `(?:Article|Produit|Pack|Ligne|Item)s?${WS}*:${WS}*([^"”\\n•|;]{2,120})`,
  'gi',
);

const REMOVAL_ACTIONS = /suppression|annulation|retrait|remis|remise|avoir|confisqu/i;

const UNIT_MAP: Record<string, AuditMetricUnit> = {
  da: 'DA',
  unites: 'unité',
  unite: 'unité',
  pt: 'pt',
  pts: 'pt',
  point: 'pt',
  points: 'pt',
  lot: 'lot',
  'lot(s)': 'lot',
  lots: 'lot',
  article: 'article',
  articles: 'article',
  variante: 'variant',
  variantes: 'variant',
  entree: 'saisie',
  entrées: 'saisie',
  saisie: 'saisie',
  saisies: 'saisie',
};

function normalizeUnit(raw: string): AuditMetricUnit {
  // Strip diacritics so « unités » folds onto the `unites` key instead of
  // needing a second entry for the accented spelling.
  const key = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '');
  return UNIT_MAP[key] || 'saisie';
}

export function parseNumber(raw: string): number | null {
  if (!raw) return null;
  // Collapse every separator a locale can inject: the regular space, U+00A0 and
  // U+202F (the narrow no-break space fr-DZ emits for thousands). All three
  // can appear inside a single formatted DZD amount depending on whether the
  // value came from Intl, from Excel, or from a Dexie round-trip.
  const s = stripLocaleWhitespace(raw).replace(/[−–]/g, '-');
  if (!s || !/\d/.test(s)) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  let normalized: string;
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: the rightmost one is the decimal mark, the other groups
    // thousands. (1234.56 / 1.234,56 / 1,234.56 all land here.)
    const decimalAt = Math.max(lastComma, lastDot);
    const groupChar = decimalAt === lastComma ? '.' : ',';
    normalized = s.split(groupChar).join('').replace(',', '.');
  } else if (lastComma !== -1) {
    // Comma only: a single trailing group of exactly 3 digits is thousands
    // (1,234), anything else is a decimal comma (1234,56).
    normalized = s.length - lastComma - 1 === 3 ? s.split(',').join('') : s.replace(',', '.');
  } else if (lastDot !== -1) {
    // Dot only, symmetric with the comma case: "1.234" is one thousand two
    // hundred thirty-four in this codebase, and no DA figure is ever written
    // with three decimal places.
    normalized = s.length - lastDot - 1 === 3 ? s.split('.').join('') : s;
  } else {
    normalized = s;
  }

  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export function formatMetric(value: number, unit: AuditMetricUnit): string {
  const nf = new Intl.NumberFormat('fr-DZ', { maximumFractionDigits: 2 });
  const num = nf.format(value);
  switch (unit) {
    case 'DA':
      return `${num} DA`;
    case 'unité':
      return `${num} u.`;
    case 'pt':
      return `${num} pts`;
    case 'lot':
      return `${num} lot(s)`;
    case 'article':
      return `${num} art.`;
    case 'variant':
      return `${num} variante(s)`;
    default:
      return num;
  }
}

function parseMetrics(text: string): AuditMetric[] {
  const out: AuditMetric[] = [];
  const seen = new Set<string>();
  METRIC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = METRIC_RE.exec(text)) !== null) {
    const value = parseNumber(m[1]);
    if (value === null) continue;
    const unit = normalizeUnit(m[2]);
    // Skip bare "0" counts that carry no forensic weight.
    if (value === 0 && unit !== 'DA') continue;
    const label = contextLabel(text, m.index);
    const key = `${label}:${value}:${unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, value, unit, display: formatMetric(value, unit) });
  }
  return out;
}

/**
 * Walk back from a numeric hit to the label that governs it.
 * Takes only the segment after the last separator, then the part before its
 * trailing colon, so "• Profit Net: 42 300 DA" yields « Profit Net » and not
 * « Profit Net: 42 ».
 */
function contextLabel(text: string, index: number): string {
  const window = text.slice(Math.max(0, index - 60), index);
  const parts = window.split(SEGMENT_SPLIT);
  const tail = (parts[parts.length - 1] || '').trim();

  const colon = tail.lastIndexOf(':');
  if (colon !== -1) {
    const head = tail.slice(0, colon).trim();
    if (head && head.length <= 40) return head;
  }
  if (tail && tail.length <= 40) return tail;
  return 'Valeur';
}

const EMPTY_MARKERS = new Set(['', '-', '—', '∅', 'néant', 'neant', 'null', 'undefined', 'n/a']);

function classifyChange(before: string, after: string): AuditChange['kind'] {
  if (EMPTY_MARKERS.has(before.toLowerCase())) return 'added';
  if (EMPTY_MARKERS.has(after.toLowerCase())) return 'removed';
  return 'changed';
}

function parseChanges(text: string): AuditChange[] {
  const out: AuditChange[] = [];
  const seen = new Set<string>();
  // Matches the two shapes actually written by the call sites:
  //   `creditLimit: 0 → 5000`   (labelled field diff)
  //   `ancien → nouveau`        (bare value diff)
  // The value class excludes whitespace and separators so a labelled field
  // never swallows the segment that precedes it.
  const re =
    /(?:([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9_' ]{1,23}?)\s*:\s*)?([^\s,;•|→<>]{1,40}?)\s*(?:→|->|=>)\s*([^\s,;•|→<>]{1,40}?)(?=\s*[,;.)\]•|]|\s{2,}|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const field = (m[1] || 'Valeur').trim();
    const before = m[2].trim();
    const after = m[3].trim();
    if (!before || !after || before === after) continue;
    const key = `${field}|${before}|${after}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ field, before, after, kind: classifyChange(before, after) });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

function parseRemovedItems(action: string, text: string): AuditItem[] {
  if (!REMOVAL_ACTIONS.test(action || '')) return [];
  const out: AuditItem[] = [];
  const seen = new Set<string>();
  ITEM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ITEM_RE.exec(text)) !== null) {
    // `Article: Ecouteurs X2 (3 unités)` → label + optional quantity.
    const qty = new RegExp(`\\((\\d+)${WS}*unités?\\)`).exec(m[1]);
    const label = m[1]
      .replace(new RegExp(`\\(\\d+${WS}*unités?\\)`), '')
      .replace(/^["“]|["”]$/g, '')
      .trim();
    if (!label) continue;
    const quantity = qty ? Number(qty[1]) : null;

    // A nearby `X DA` in the same region is the line total.
    const tail = text.slice(m.index, m.index + 160);
    const totalMatch = new RegExp('(\\d[\\d\\s.,]*)DA').exec(tail);
    const total = totalMatch ? parseNumber(totalMatch[1]) : null;

    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, quantity, unitPrice: null, total });
  }
  return out;
}

/**
 * Turn the free-text `details` column into structured, renderable parts.
 * Never throws and never returns a partial parse without `raw` intact — the
 * drawer always falls back to the original string.
 */
export function parseAuditPayload(
  details: string | undefined | null,
  action?: string | undefined | null,
): AuditPayload {
  const raw = (details || '').trim();
  const empty: AuditPayload = {
    raw,
    narrative: raw,
    fields: [],
    changes: [],
    metrics: [],
    removedItems: [],
    structured: false,
  };
  if (!raw) return empty;

  const segments = raw
    .split(SEGMENT_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean);

  const fields: AuditField[] = [];
  const consumed = new Set<string>();
  const seenFields = new Set<string>();

  for (const seg of segments) {
    const m = FIELD_RE.exec(seg);
    if (!m) continue;
    const label = m[1].trim();
    const value = m[2].trim();
    if (!label || !value) continue;
    const key = `${label}::${value}`;
    if (seenFields.has(key)) continue;
    seenFields.add(key);
    fields.push({ label, value });
    consumed.add(seg);
  }

  const changes = parseChanges(raw);
  const metrics = parseMetrics(raw);
  const removedItems = parseRemovedItems(action || '', raw);

  const narrative = segments
    .filter((s) => !consumed.has(s))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    raw,
    narrative: narrative || raw,
    fields,
    changes,
    metrics,
    removedItems,
    structured: fields.length + changes.length + metrics.length + removedItems.length >= 2,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Effective search window (pushed down to the repository)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the two range inputs — the quick chip and the custom date picker —
 * into the single window that drives both the SQL range scan and the
 * in-memory narrowing.
 *
 * They are two inputs to one question, so they are resolved in one place: if
 * the query and the client filter each derived the window independently they
 * would eventually disagree about which rows are in scope, and the register
 * would show a mix of both answers.
 *
 * A custom range wins over the quick chip — it is the more specific statement of
 * intent, and leaving the chip active underneath it would be ambiguous.
 * « Toute la période… » resolves to an unbounded window, which is what tells
 * the repository to keep its default newest-first `LIMIT 300` behaviour.
 */
export function resolveAuditRange(
  quickRange: QuickRangeId,
  custom: { start: Date | null; end: Date | null },
  now: Date = new Date(),
): { start: Date | null; end: Date | null } {
  if (custom.start || custom.end) {
    const start = custom.start ? new Date(custom.start) : null;
    const end = custom.end ? new Date(custom.end) : null;
    // The picker is day-granular, so the bounds are widened to the whole local
    // day rather than to midnight and to "now".
    if (start) start.setHours(0, 0, 0, 0);
    if (end) end.setHours(23, 59, 59, 999);
    return { start, end };
  }
  const from = quickRangeStart(quickRange, now);
  return { start: from === null ? null : new Date(from), end: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Relative quick filters
// ─────────────────────────────────────────────────────────────────────────────

export type QuickRangeId = 'live' | '15m' | '1h' | 'today' | 'all';

export interface QuickRange {
  id: QuickRangeId;
  label: string;
  /** Compact label for the chip row on narrow screens. */
  short: string;
  description: string;
  /** Rolling window length in ms; 0 means "whole history". */
  windowMs: number;
}

export const QUICK_RANGES: QuickRange[] = [
  { id: 'live', label: 'Live (Temps réel)', short: 'Live', description: 'Flux temps réel — nouvelle fenêtre à chaque événement', windowMs: 15 * MINUTE },
  { id: '15m', label: 'Dernières 15 min', short: '15 min', description: 'Fenêtre glissante de 15 minutes', windowMs: 15 * MINUTE },
  { id: '1h', label: 'Dernière heure', short: '1 h', description: 'Fenêtre glissante d’une heure', windowMs: HOUR },
  { id: 'today', label: "Aujourd'hui", short: 'JOUR', description: 'Depuis minuit (00:00)', windowMs: 0 },
  { id: 'all', label: 'Tout l’historique', short: 'TOUT', description: 'Aucune limite de période', windowMs: 0 },
];

/**
 * Start instant (ms epoch) for a quick range, or `null` for "no lower bound".
 * `today` is local-midnight, not rolling-24h: that is what a cashier means by
 * « Aujourd'hui » when reconciling a till.
 */
export function quickRangeStart(id: QuickRangeId, now: Date = new Date()): number | null {
  switch (id) {
    case 'live':
    case '15m':
      return now.getTime() - 15 * MINUTE;
    case '1h':
      return now.getTime() - HOUR;
    case 'today': {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case 'all':
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Actor / terminal metadata (IP + device fallback)
// ─────────────────────────────────────────────────────────────────────────────

export interface DeviceFingerprint {
  platform: string;
  userAgent: string;
  language: string;
  timezone: string;
  screen: string;
  hardwareConcurrency: number | null;
  touchPoints: number | null;
}

export type ActorOrigin = 'recorded' | 'session' | 'unknown';

export interface ActorMeta {
  deviceId: string;
  deviceLabel: string;
  deviceOrigin: ActorOrigin;
  ipAddress: string;
  ipLabel: string;
  ipOrigin: ActorOrigin;
  sessionTag: string;
  fingerprint: DeviceFingerprint | null;
}

const UNKNOWN_IP = 'Non renseignée';

/**
 * A stable, non-identifying tag for entries written before device capture
 * existed. Derived from the terminal id + boot date so every legacy row still
 * attributes to *a* session instead of rendering a bare dash.
 */
export function buildSessionTag(deviceId: string, when: Date = new Date()): string {
  const seed = `${deviceId}|${when.toISOString().slice(0, 10)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `SESSION-${hash.toString(16).toUpperCase().padStart(8, '0').slice(0, 8)}`;
}

export function readDeviceFingerprint(): DeviceFingerprint | null {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return null;
  try {
    return {
      platform: navigator.platform || 'inconnue',
      userAgent: navigator.userAgent || 'inconnu',
      language: navigator.language || 'inconnue',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'inconnue',
      screen: typeof window.screen === 'object' && window.screen
        ? `${window.screen.width}x${window.screen.height}`
        : 'inconnue',
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      touchPoints: navigator.maxTouchPoints ?? null,
    };
  } catch {
    return null;
  }
}

export function formatFingerprint(fp: DeviceFingerprint | null): string {
  if (!fp) return 'Indisponible (contexte non-navigateur)';
  return [fp.platform, fp.screen, fp.language, fp.timezone]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Resolve the Terminal / IP columns. Legacy rows were persisted before the
 * device capture landed and stored neither field, which is why the table used
 * to render « - ». Anything missing is backfilled from the current session
 * and flagged so the UI can mark it as inferred rather than recorded.
 */
export function resolveActorMeta(
  entry: SecurityAuditLogEntry,
  session: { deviceId: string; ipAddress: string } | null,
  fingerprint: DeviceFingerprint | null = null,
  when: Date = new Date(),
): ActorMeta {
  const sessionTag = buildSessionTag(session?.deviceId || 'TERM-UNKNOWN', when);

  const rawDevice = (entry.deviceId || '').trim();
  const rawIp = (entry.ipAddress || '').trim();

  // A stored value of "Inconnue" / "Non détectée (hors-ligne)" is a failed
  // capture, not a real reading — treat it as missing.
  const deviceUsable = rawDevice !== '' && !/^inconnue$/i.test(rawDevice);
  const ipUsable = rawIp !== '' && !/^(inconnue|non détectée.*)$/i.test(rawIp);

  const deviceId = deviceUsable ? rawDevice : session?.deviceId || sessionTag;
  const deviceOrigin: ActorOrigin = deviceUsable ? 'recorded' : session?.deviceId ? 'session' : 'unknown';

  const ipAddress = ipUsable ? rawIp : session?.ipAddress || UNKNOWN_IP;
  const ipOrigin: ActorOrigin = ipUsable ? 'recorded' : session?.ipAddress ? 'session' : 'unknown';

  return {
    deviceId,
    deviceLabel: deviceId,
    deviceOrigin,
    ipAddress,
    ipLabel: ipAddress,
    ipOrigin,
    sessionTag,
    fingerprint,
  };
}

export const ORIGIN_LABEL: Record<ActorOrigin, string> = {
  recorded: 'Relevé à l’événement',
  session: 'Repris de la session courante',
  unknown: 'Non déterminable',
};

// ─────────────────────────────────────────────────────────────────────────────
// Integrity signature
// ─────────────────────────────────────────────────────────────────────────────

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** Deterministic FNV-1a fallback for environments without WebCrypto. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').repeat(8);
}

/**
 * FNV-1a 64 x2 with domain separation — the fallback for the *export chain*.
 *
 * Deliberately kept distinct from `fnv1a` above. `fnv1a` backs the
 * per-row presentation digest, which was introduced with the canonical
 * serializer and has no historical documents to stay compatible with. The
 * chain fallback predates it and already appears inside exported documents, so
 * changing its output would silently invalidate every manifest ever written in
 * a WebCrypto-less context. Two fallbacks for two formats is correct here; one
 * fallback for two formats would not be.
 */
function chainFallbackHex(input: string): string {
  let h1 = 0xcbf29ce484222325n;
  let h2 = 0x84222325cbf29ce4n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    const c = BigInt(input.charCodeAt(i));
    h1 = ((h1 ^ c) * prime) & mask;
    h2 = ((h2 ^ (c + 0x9e3779b9n)) * prime) & mask;
  }
  return (
    h1.toString(16).padStart(16, '0') +
    h2.toString(16).padStart(16, '0') +
    h1.toString(16).padStart(16, '0') +
    h2.toString(16).padStart(16, '0')
  );
}

/**
 * SHA-256 of an arbitrary string, with an explicit fallback report.
 *
 * Exposed so the export chain and the re-import verifier hash through ONE
 * primitive. Two implementations of "the hash" is how a document ends up
 * verifiable by the exporter and not by the checker.
 *
 * The `algo` marker matters: when WebCrypto is missing, both sides degrade to
 * the same FNV fallback and the digest still compares equal, but a reader must
 * be able to see that it is not a real SHA-256.
 */
export async function sha256Hex(input: string): Promise<{ hex: string; algo: string }> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return { hex: chainFallbackHex(`FALLBACK:${input}`), algo: 'FNV-FALLBACK (WebCrypto indisponible)' };
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input));
    return { hex: toHex(digest), algo: 'SHA-256' };
  } catch {
    return { hex: chainFallbackHex(`FALLBACK:${input}`), algo: 'FNV-FALLBACK (WebCrypto indisponible)' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical serialization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every whitespace character a fr-DZ / en-DZ formatted number can carry.
 *
 * `Intl.NumberFormat('fr-DZ')` emits U+202F (narrow no-break space) as its
 * thousands separator, and Excel/Dexie round-trips tend to hand back U+00A0.
 * A bare `\s` in JS **does** match both, but matching them in a character
 * *class* alongside a literal space is what `LOCALE_WS` is for: it makes the
 * intent explicit at every call site and gives one constant to audit.
 */
export const LOCALE_WS = '[\\s\u00A0\u202F]';

/** Remove ASCII space, NBSP and NNBSP anywhere in a string. */
export function stripLocaleWhitespace(value: string): string {
  return value.replace(/[\s\u00A0\u202F]/g, '');
}

/** True when the string is a canonical ISO-8601 instant we can re-normalize. */
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function normalizeIsoString(value: string): string {
  // "2026-09-29T23:07:14Z" and "2026-09-29T23:07:14.000Z" are the same instant
  // but hash differently. Collapse every accepted spelling to UTC with
  // millisecond precision so a peer clock reading cannot change the digest.
  const parsed = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString();
}

/** Number of decimals an audit figure is canonically pinned to. */
export const CANONICAL_DECIMALS = 2;

/**
 * Recursively canonicalize a value for hashing.
 *
 * Rules, applied in order:
 *  - `undefined` is dropped from objects and becomes `null` in arrays, so a
 *    missing key and an explicit null never produce different digests.
 *  - `-0` is normalized to `0`.
 *  - Floats are pinned to 2 decimals: `12.500000000000002` and `12.5` are the
 *    same DA figure and must not fork the hash.
 *  - Non-finite numbers become `null` (JSON.stringify would emit `null` too,
 *    but going through here keeps the rule explicit and testable).
 *  - ISO-8601-ish strings are normalized to UTC millisecond precision.
 *  - Locale whitespace inside strings is normalized so a re-import that
 *    round-trips "12 500" through a different NBSP variant still matches.
 */
export function canonicalizeValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (Object.is(value, -0)) return 0;
    // `toFixed` avoids the binary-representation drift of `toPrecision`.
    return Number(value.toFixed(CANONICAL_DECIMALS));
  }

  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (ISO_LIKE.test(trimmed)) return normalizeIsoString(trimmed);
    // Only collapse interior whitespace for strings that look numeric, so
    // prose keeps its meaningful spacing.
    if (/^[\d\u00A0\u202F.,\s-]+$/.test(trimmed)) return stripLocaleWhitespace(trimmed);
    return trimmed;
  }

  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }

  if (Array.isArray(value)) return value.map(canonicalizeValue);

  if (value instanceof Map) {
    return canonicalizeValue(Object.fromEntries(value.entries()));
  }
  if (value instanceof Set) {
    return canonicalizeValue(Array.from(value.values()));
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // Sort keys so property insertion order can never change the digest.
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue; // stripped entirely
      out[key] = canonicalizeValue(source[key]);
    }
    return out;
  }

  // Functions / symbols cannot appear in a persisted audit row; record them as
  // an explicit marker rather than silently dropping the field.
  return null;
}

/**
 * Deterministic JSON: recursively key-sorted, primitive-normalized, and free
 * of the whitespace `JSON.stringify` indents by default.
 *
 * This is the single string that is hashed, embedded in the PDF/A-3 manifest,
 * and re-derived on re-import for verification.
 */
export function deterministicStringify(value: unknown): string {
  const canonical = canonicalizeValue(value);
  if (canonical === null || typeof canonical !== 'object') {
    return JSON.stringify(canonical) ?? 'null';
  }
  return JSON.stringify(canonical);
}

/**
 * The exact set of fields covered by the presentation digest.
 *
 * Declared as an ordered field list rather than a hand-written object so the
 * hashed surface is auditable: anything not in `AUDIT_SIGNATURE_FIELDS`
 * cannot influence the digest, and a new column added to the table is a
 * deliberate decision to include or exclude.
 */
export const AUDIT_SIGNATURE_FIELDS = [
  'id',
  'timestamp',
  'user',
  'action',
  'details',
  'requiresPin',
  'deviceId',
  'ipAddress',
] as const;

/**
 * Canonical preimage for one audit row.
 *
 * `deterministicStringify` over a key-sorted object, so:
 *  - the same row always yields the same string regardless of how the object
 *    was built or which fields happen to be `undefined`;
 *  - no separator collision is possible (the previous pipe/0x1F join could be
 *    defeated by moving a character across a field boundary);
 *  - the exact string is what gets hashed, exported and re-verified.
 */
export function signaturePreimage(entry: SecurityAuditLogEntry): string {
  const payload: Record<string, unknown> = {};
  for (const field of AUDIT_SIGNATURE_FIELDS) {
    const raw = (entry as unknown as Record<string, unknown>)[field];
    // Absent and explicit-null must agree. The adapter writes `null` for an
    // unrecorded deviceId/ipAddress while a freshly built row omits the key;
    // hashing the two differently would make the digest depend on which code
    // path produced the object, not on the audit content.
    if (raw === undefined || raw === null) continue;
    payload[field] = raw;
  }
  return deterministicStringify(payload);
}

/** Verify a row against a digest produced by `computeAuditSignature`. */
export async function verifyAuditSignature(
  entry: SecurityAuditLogEntry,
  expected: string,
): Promise<{ valid: boolean; actual: string }> {
  const actual = await computeAuditSignature(entry);
  return { valid: timingSafeEqualHex(actual, expected), actual };
}

/** Length-independent, value-only hex comparison (no early exit on length). */
function timingSafeEqualHex(a: string, b: string): boolean {
  const x = (a || '').toLowerCase();
  const y = (b || '').toLowerCase();
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * SHA-256 over the canonical audit row.
 *
 * This is a *presentation* integrity digest: it lets an operator re-compute it
 * after a PDF/A-3 export and detect that a row was edited in the database,
 * which a bare row id cannot show. It is client-side and unkeyed — it is NOT a
 * server-side MAC or a qualified signature, and must not be presented as one.
 * The UI labels it accordingly.
 */
export async function computeAuditSignature(entry: SecurityAuditLogEntry): Promise<string> {
  const preimage = signaturePreimage(entry);
  const subtle = typeof globalThis !== 'undefined' ? globalThis.crypto?.subtle : undefined;
  if (!subtle) return fnv1a(preimage);
  try {
    const data = new TextEncoder().encode(preimage);
    const digest = await subtle.digest('SHA-256', data);
    return toHex(digest);
  } catch {
    return fnv1a(preimage);
  }
}

export const SIGNATURE_LABEL = 'Empreinte d’intégrité applicative (vérifiée côté client)';

/**
 * Human-readable statement of the canonicalization rules, shown in the drawer
 * and embedded in export manifests.
 *
 * An auditor who does not have the app cannot recompute the digest from a
 * document alone, so the document must say how the bytes were derived. This
 * string is the single source for that description: `auditExport` embeds it
 * verbatim in the manifest, and the drawer renders it next to the digest.
 */
export const CANONICAL_RULES_LABEL =
  'Clés triées récursivement ; champs absents omis ; flottants arrondis à 2 décimales ; ' +
  'horodatages ISO normalisés en UTC milliseconde ; espaces de locale (espace insécable U+00A0, ' +
  'espace fine U+202F) supprimés des valeurs numériques';

/** Fields covered by the digest, rendered for the "portée" disclosure. */
export const SIGNATURE_SCOPE_LABEL = AUDIT_SIGNATURE_FIELDS.join(', ');

/** Truncated digest for the pill: first 8 groups, with the tail elided. */
export function truncateSignature(hash: string, groups = 4): string {
  const clean = (hash || '').replace(/\s+/g, '');
  if (!clean) return '—';
  const head = clean.slice(0, groups * 8).replace(/(.{8})/g, '$1 ').trim();
  return clean.length > groups * 8 ? `${head}…` : head;
}

export function formatSignature(hash: string): string {
  if (!hash) return '—';
  return hash.replace(/(.{8})/g, '$1 ').trim();
}

// ── Gate-denial bursts (Phase F dashboard) ────────────────────────────────

export const GATE_DENIED_BURST_ACTION = 'GATE_DENIED_BURST';

export interface DenialBurst {
  gateName: string;
  userId: string;
  denialCount: number;
  lockoutTriggered: boolean;
  lockoutDurationMs: number;
  windowStart: number;
}

/**
 * Parse one GATE_DENIED_BURST details payload. Strict shape check: a
 * malformed row is not a burst (never summed, never shown as one).
 */
export function parseDenialBurst(
  action: string | undefined | null,
  details: string | undefined | null,
): DenialBurst | null {
  if ((action || '').trim() !== GATE_DENIED_BURST_ACTION) return null;
  try {
    const p = JSON.parse(String(details || '')) as Record<string, unknown>;
    if (typeof p.gate_name !== 'string' || !p.gate_name.trim()) return null;
    if (typeof p.user_id !== 'string') return null;
    const denialCount = Number(p.denial_count);
    if (!Number.isFinite(denialCount) || denialCount < 0) return null;
    return {
      gateName: p.gate_name.trim(),
      userId: p.user_id,
      denialCount: Math.floor(denialCount),
      lockoutTriggered: p.lockout_triggered === true,
      lockoutDurationMs:
        typeof p.lockout_duration_ms === 'number' && Number.isFinite(p.lockout_duration_ms)
          ? Math.max(0, Math.floor(p.lockout_duration_ms))
          : 0,
      windowStart:
        typeof p.window_start_epoch === 'number' && Number.isFinite(p.window_start_epoch)
          ? p.window_start_epoch
          : 0,
    };
  } catch {
    return null;
  }
}

export interface DenialGateSummary {
  gate: string;
  users: number;
  /** Sum of the LATEST cumulative count per (gate, user, window). */
  denials: number;
  /** Windows that ended in a lockout signal. */
  lockouts: number;
}

export interface DenialSummary {
  gates: DenialGateSummary[];
  totalDenials: number;
  totalLockouts: number;
  users: number;
}

/**
 * Aggregate burst rows for the dashboard strip. Rows are cumulative
 * snapshots per (gate, user, window), so aggregation takes the LATEST row
 * per key (max denial_count); summing raw rows would multiply-count.
 * Malformed rows are ignored (parseDenialBurst is strict).
 */
export function summarizeDenialBursts(entries: SecurityAuditLogEntry[]): DenialSummary {
  const latest = new Map<string, DenialBurst>();
  for (const e of entries) {
    const b = parseDenialBurst(e?.action, e?.details);
    if (!b) continue;
    const key = [b.gateName, b.userId, b.windowStart].join(' | ');
    const prev = latest.get(key);
    if (!prev || b.denialCount >= prev.denialCount) latest.set(key, b);
  }
  const byGate = new Map<string, { users: Set<string>; denials: number; lockouts: number }>();
  const allUsers = new Set<string>();
  let totalLockouts = 0;
  for (const b of latest.values()) {
    let g = byGate.get(b.gateName);
    if (!g) {
      g = { users: new Set(), denials: 0, lockouts: 0 };
      byGate.set(b.gateName, g);
    }
    g.users.add(b.userId);
    allUsers.add(`${b.gateName} | ${b.userId}`);
    g.denials += b.denialCount;
    if (b.lockoutTriggered) {
      g.lockouts += 1;
      totalLockouts += 1;
    }
  }
  const gates = [...byGate.entries()]
    .map(([gate, g]) => ({ gate, users: g.users.size, denials: g.denials, lockouts: g.lockouts }))
    .sort((a, b) => b.denials - a.denials || a.gate.localeCompare(b.gate));
  return {
    gates,
    totalDenials: gates.reduce((a, g) => a + g.denials, 0),
    totalLockouts,
    users: allUsers.size,
  };
}

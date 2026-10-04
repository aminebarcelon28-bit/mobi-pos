/**
 * warrantyResolver — standalone, UI-free warranty resolution.
 * Extracted from ImeiWarrantyInspectorModal to prevent cyclic
 * modal→modal imports and to allow intake (RepairWorkOrderModal)
 * to auto-lookup warranty on IMEI blur.
 */
import type {
  CartItem,
  IntakeDraft,
  Product,
  RepairOrder,
  SaleTransaction,
  IMEIRecord,
  WarrantySnapshot,
  WarrantyTier,
} from '../types/pos';
import { WARRANTY_TIER_DAYS, WARRANTY_TIER_ORDER, computeWarrantyExpiryISO } from '../types/pos';
import type { ImeiLifecycleDossier, WarrantyDossierSnapshot } from '../types/pos';
import { luhnCheckImei } from './savValidation';
import { canonicalDeviceId, normalizeDeviceKey } from './deviceIdCodec';

export const DEFAULT_WARRANTY_MONTHS = 12;

/**
 * Refurb-baseline term for undecided pre-owned stock (Option A, owner-ratified).
 *
 * Measured on the live catalog: **all 252** products in
 * `Téléphones d'Occasion (Reprise)` store NO warranty field at all — they are
 * undecided, not zero. That is why this is a CATEGORY RULE in the resolver and
 * not an intake default in the editor: an intake default only ever touches
 * products created after the change, so the 129 already-sold devices and the
 * in-stock occasion rows would still mint 12 months and the ratified policy
 * would be unenforced exactly where it matters.
 *
 * Precedence is unchanged and explicit-value-first: an owner's explicit term
 * (any positive value) still wins, and `warrantyExplicitlyDisabled` still means
 * zero. This rule only decides what "undecided" resolves to.
 */
export const OCCASION_DEFAULT_WARRANTY_MONTHS = 3;

/**
 * Category fragments that mark pre-owned stock.
 *
 * Substring matching, accent- and case-insensitive, so a future rename
 * (`Téléphones d'Occasion`, `Reprise`, …) cannot silently fall back to the
 * 12-month store default on used hardware. The obligation here is a liability
 * CUT, so the failure mode of a missed match is the expensive one.
 */
const OCCASION_CATEGORY_HINTS = ['occasion', 'reprise'] as const;

/** True when the carrier sits in a pre-owned / trade-in category. */
export function isOccasionCategory(prod?: WarrantyCarrier | null): boolean {
  const cat = prod?.category;
  if (typeof cat !== 'string') return false;
  const norm = cat
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  return OCCASION_CATEGORY_HINTS.some((hint) => norm.includes(hint));
}

/**
 * The term an UNDECIDED product resolves to.
 *
 * Single source of truth for both `resolveWarrantyMonths` and
 * `resolveWarrantyWithFallback` — they must never disagree, or the inspector
 * and the sale again print different terms (the Step B3 defect).
 *
 * UNKNOWN IS NOT 12 (W-22). When NO carrier is known at all — the catalog row
 * was deleted, or the device only ever existed as a registry row — this used to
 * fall through to the 12-month store default, which silently granted a YEAR of
 * warranty on a device whose coverage was never established (the concrete case:
 * a deleted "Grade B" occasion unit, `deleteProduct` orphaning `productId`).
 * A wrong 12 is a confident answer; the honest one is the conservative
 * refurb baseline, so absence of evidence resolves DOWN, never up.
 *
 * A KNOWN non-occasion product with no explicit term still gets the store
 * default: the shop knows what it is, and the term is a commercial promise.
 */
export function defaultWarrantyMonthsFor(
  ...carriers: (WarrantyCarrier | null | undefined)[]
): number {
  // Every carrier absent: the term is UNKNOWN, so resolve to the baseline.
  if (carriers.every((c) => c === null || c === undefined)) {
    return OCCASION_DEFAULT_WARRANTY_MONTHS;
  }
  return carriers.some(isOccasionCategory)
    ? OCCASION_DEFAULT_WARRANTY_MONTHS
    : DEFAULT_WARRANTY_MONTHS;
}

/** Identifier polymorphism for the inspector / intake forms. */
export type DeviceIdentifierMode = 'imei' | 'serial' | 'manual';

/** Normalized result of sanitizing a raw device identifier for lookup. */
export interface SanitizedDeviceId {
  value: string;
  mode: DeviceIdentifierMode;
  /** Digits-only count; drives the Luhn gate (IMEI mode only). */
  digitCount: number;
  luhnOk: boolean;
  /** True when the value is well-formed enough to run a lookup at all. */
  isSearchable: boolean;
  /** Human-readable reason when `isSearchable` is false. */
  note?: string;
}

/** Human warranty duration label, e.g. "Garantie 1 an", "Garantie 6 mois". */
export function formatWarrantyDuration(months: number): string {
  const m = Math.max(0, Math.floor(months || 0));
  if (m <= 0) return 'Sans garantie';
  if (m % 12 === 0) {
    const y = m / 12;
    return `Garantie ${y} an${y > 1 ? 's' : ''}`;
  }
  return `Garantie ${m} mois`;
}

export type WarrantyCarrier = Pick<Product, 'warrantyMonths' | 'warrantyExplicitlyDisabled'> & {
  json_payload?: unknown;
  garantie_magasin?: unknown;
  garantie?: unknown;
  warranty_months?: unknown;
  warranty_explicitly_disabled?: unknown;
  /**
   * Needed by the Option A category rule (`isOccasionCategory`). Declared
   * explicitly rather than cast to at each read site, so a carrier passed with
   * only a category is still type-legal.
   */
  category?: string | null;
} | null | undefined;

/** Coerce a warranty-like value (12, "12", "12 mois", "1 an") to months. */
export function coerceWarrantyMonths(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const direct = Number(value);
  if (Number.isFinite(direct)) return Math.max(0, Math.floor(direct));
  if (typeof value === 'string') {
    const m = value.match(/(\d+)/);
    if (m) return Math.max(0, Math.floor(Number(m[1])));
  }
  return undefined;
}

function readWarrantyField(obj: Record<string, unknown> | null | undefined): number | undefined {
  if (!obj) return undefined;
  const candidates = [
    obj.warrantyMonths,
    obj.garantie_magasin,
    obj.garantie,
    obj.warranty_months,
    (obj as Record<string, unknown>).warranty,
  ];
  for (const c of candidates) {
    const parsed = coerceWarrantyMonths(c);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * Raw included store warranty (months) for a product, or 0 when absent.
 * SQLite carries no warranty_months column — warranty lives on the Dexie
 * product object and inside its nested editor-form blob (json_payload).
 * Explicit 0 ("Sans Garantie") is preserved as 0.
 */
export function extractWarrantyMonths(prod?: WarrantyCarrier): number {
  // A deliberate "no warranty" flag is an explicit zero, full stop.
  if (isWarrantyExplicitlyDisabled(prod)) return 0;

  const w = prod as NonNullable<WarrantyCarrier> | null | undefined;
  const direct = readWarrantyField(w as Record<string, unknown> | null | undefined);
  // A bare `warrantyMonths: 0` is the ProductEditorModal form default, not an
  // owner decision (BUG-WAR-03) — fall through to aliases and the blob.
  if (direct !== undefined && !(w && w.warrantyMonths === 0)) return direct;

  if (w) {
    const alias = readWarrantyField({
      garantie_magasin: w.garantie_magasin,
      garantie: w.garantie,
      warranty_months: w.warranty_months,
    });
    if (alias !== undefined) return alias;
  }

  const inner = readWarrantyBlob(w);
  if (inner) {
    const fromBlob = readWarrantyField(inner);
    if (fromBlob !== undefined && inner.warrantyMonths !== 0) return fromBlob;
    const blobAlias = readWarrantyField({
      garantie_magasin: inner.garantie_magasin,
      garantie: inner.garantie,
      warranty_months: inner.warranty_months,
    });
    if (blobAlias !== undefined) return blobAlias;
  }

  return 0;
}

/** Read the nested editor blob, if any, as a flat record. */
function readWarrantyBlob(obj: WarrantyCarrier | null | undefined): Record<string, unknown> | null {
  const nested = (obj as { json_payload?: unknown } | null | undefined)?.json_payload;
  if (!nested) return null;
  try {
    return typeof nested === 'string'
      ? (JSON.parse(nested) as Record<string, unknown>)
      : (nested as Record<string, unknown>);
  } catch {
    return null; // Unparseable blob — treat as absent.
  }
}

/**
 * True when the owner has DELIBERATELY chosen zero coverage ("as-is",
 * clearance). This — not a bare `warrantyMonths: 0` — is the only representation
 * of that decision.
 *
 * BUG-WAR-03: `ProductEditorModal` used to seed `warrantyMonths: 0` as its
 * untouched form default, which made "undecided" and "no warranty" the same
 * stored value. `resolveWarrantyMonths` then short-circuited on the explicit 0
 * and the 12-month store default became unreachable, so a normally-configured
 * product sold with no coverage at all.
 *
 * Read from the top level AND the nested editor blob, since SQLite persists the
 * product as `json_payload` with no dedicated column.
 */
export function isWarrantyExplicitlyDisabled(prod?: WarrantyCarrier): boolean {
  if (!prod) return false;
  const truthy = (v: unknown) => v === true || v === 1 || v === 'true' || v === '1';
  const w = prod as NonNullable<WarrantyCarrier>;
  if (truthy(w.warrantyExplicitlyDisabled) || truthy(w.warranty_explicitly_disabled)) return true;
  const blob = readWarrantyBlob(w);
  if (blob && (truthy(blob.warrantyExplicitlyDisabled) || truthy(blob.warranty_explicitly_disabled))) return true;
  return false;
}

/**
 * True when the product carries an explicit warranty value that was a real
 * owner decision rather than an untouched form default.
 *
 * The critical rule: a bare `warrantyMonths: 0` is NOT explicit. `0` was the
 * `ProductEditorModal` form default, so it carries no intent — treating it as
 * explicit is exactly what made BUG-WAR-03 void coverage. Use
 * `warrantyExplicitlyDisabled` for a deliberate zero.
 *
 * A `0` under a legacy alias key (`garantie`, `garantie_magasin`,
 * `warranty_months`) IS honoured, because those keys predate the editor default
 * and were only ever written deliberately.
 */
export function hasExplicitWarranty(prod?: WarrantyCarrier): boolean {
  if (isWarrantyExplicitlyDisabled(prod)) return true;
  if (!prod) return false;
  const w = prod as NonNullable<WarrantyCarrier>;

  const direct = readWarrantyField(w as Record<string, unknown>);
  if (direct !== undefined) {
    if (w.warrantyMonths === 0) {
      // Form-default zero — fall through to aliases/blob before deciding.
      const alias = readWarrantyField({
        garantie_magasin: w.garantie_magasin,
        garantie: w.garantie,
        warranty_months: w.warranty_months,
      });
      if (alias !== undefined) return true;
    } else {
      return true;
    }
  }

  const blob = readWarrantyBlob(w);
  if (!blob) return false;
  const fromBlob = readWarrantyField(blob);
  if (fromBlob === undefined) return false;
  // Same rule inside the blob: `warrantyMonths: 0` is the editor default.
  if (blob.warrantyMonths === 0) {
    return readWarrantyField({
      garantie_magasin: blob.garantie_magasin,
      garantie: blob.garantie,
      warranty_months: blob.warranty_months,
    }) !== undefined;
  }
  return true;
}

/**
 * Included warranty with the store-policy default when absent.
 *
 * Undecided resolves to 12 months, EXCEPT pre-owned stock, which resolves to
 * the 3-month refurb baseline (Option A). An explicit value still wins and
 * `warrantyExplicitlyDisabled` still means zero.
 */
export function resolveWarrantyMonths(prod?: WarrantyCarrier): number {
  if (hasExplicitWarranty(prod)) return extractWarrantyMonths(prod);
  const extracted = extractWarrantyMonths(prod);
  return extracted > 0 ? extracted : defaultWarrantyMonthsFor(prod);
}

/**
 * Resolve warranty preferring the catalog record, falling back to the
 * transaction-line snapshot (which may carry the warranty at sale time).
 *
 * When neither carrier carries a term, pre-owned stock resolves to the 3-month
 * refurb baseline rather than the 12-month store default.
 */
export function resolveWarrantyWithFallback(
  primary?: WarrantyCarrier,
  fallback?: WarrantyCarrier
): number {
  // A deliberate zero on EITHER carrier is authoritative and must not be
  // rescued by the other, or by the store default.
  if (isWarrantyExplicitlyDisabled(primary) || isWarrantyExplicitlyDisabled(fallback)) return 0;
  if (hasExplicitWarranty(primary)) return extractWarrantyMonths(primary);
  if (hasExplicitWarranty(fallback)) return extractWarrantyMonths(fallback);
  return (
    extractWarrantyMonths(primary) ||
    extractWarrantyMonths(fallback) ||
    defaultWarrantyMonthsFor(primary, fallback)
  );
}

export interface DeviceWarrantyState {
  warrantyMonths: number;
  warrantyExpiresAt: string;
  daysRemaining: number;
  isWarrantyValid: boolean;
}

/**
 * Warranty state for a device card/dossier. Coverage runs from the sale date
 * for sold devices; in-stock devices carry the included duration (coverage
 * starts at sale, so they are never "valid" yet, never "expired" either).
 *
 * `anchoredExpiresAt` is the point-in-time value minted at sale. When present
 * it is authoritative and `warrantyMonths` is NOT re-applied, so a later catalog
 * edit cannot retroactively shorten or extend coverage a customer already
 * bought. Absent (rows predating anchoring) falls back to the computation.
 */
export function computeDeviceWarranty(args: {
  warrantyMonths: number;
  startIso: string;
  sold: boolean;
  nowIso?: string;
  /** Point-in-time anchor from the sale record; wins over recomputation. */
  anchoredExpiresAt?: string | null;
}): DeviceWarrantyState {
  const months = Math.max(0, Math.floor(args.warrantyMonths || 0));
  const now = new Date(args.nowIso || new Date().toISOString());
  const anchored = args.anchoredExpiresAt ? new Date(args.anchoredExpiresAt) : null;
  const useAnchored = anchored !== null && !Number.isNaN(anchored.getTime());

  // Clamped, UTC. Plain `setMonth` overflowed: Jan 31 + 1 month → Mar 3,
  // granting three extra days of free repair on every month-end sale.
  const expiry = useAnchored ? anchored : new Date(addMonthsClamped(args.startIso, months));
  if (Number.isNaN(expiry.getTime())) {
    return { warrantyMonths: months, warrantyExpiresAt: args.startIso, daysRemaining: 0, isWarrantyValid: false };
  }
  // An anchored expiry is authoritative even when it says "no warranty": a
  // zero-month device anchored at sold_at is expired, not undecided.
  const anchoredMonths = useAnchored && expiry.getTime() <= new Date(args.startIso).getTime() ? 0 : months;
  const daysRemaining = Math.max(0, Math.ceil((expiry.getTime() - now.getTime()) / DAY_MS));
  return {
    warrantyMonths: anchoredMonths,
    warrantyExpiresAt: expiry.toISOString(),
    daysRemaining,
    isWarrantyValid: args.sold && anchoredMonths > 0 && daysRemaining > 0,
  };
}

export interface WarrantyLookupDeps {
  transactions?: SaleTransaction[] | null;
  products?: Product[] | null;
  imeiRecords?: IMEIRecord[] | null;
  repairOrders?: RepairOrder[] | null;
}

// `savCountForImei` / `repairTicketsFor` live further down, next to the unified
// warranty status: the count must exclude cancelled tickets, which is only
// meaningful alongside the status that consumes it.

/**
 * Canonical device-identifier helpers live in `deviceIdCodec` (a leaf module)
 * so that `savValidation` can share them without importing this file — this
 * module already imports `luhnCheckImei` from there, and delegating the other
 * way would form an ESM cycle. Re-exported because the resolver is the warranty
 * authority and existing consumers import them from here.
 */
export { normalizeDeviceKey, canonicalDeviceId };

// ────────────────────────────────────────────────────────────────────────────
// Point-in-time warranty anchoring (Step A)
// ────────────────────────────────────────────────────────────────────────────

const DAY_MS = 1000 * 60 * 60 * 24;

/**
 * Add whole months to an ISO instant, clamping the day-of-month.
 *
 * `Date.prototype.setMonth` OVERFLOWS: Jan 31 + 1 month yields Mar 3, not
 * Feb 28 — silently granting three extra days of free repair coverage on every
 * device sold at a month end. UTC throughout, matching how `sold_at` is stored.
 */
export function addMonthsClamped(iso: string, months: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.getUTCDate();
  const target = new Date(d.getTime());
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + Math.max(0, Math.floor(months || 0)));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString();
}

/**
 * THE point-in-time warranty anchor: what this device's warranty expires at,
 * frozen as of `soldAt`.
 *
 * Minted ONCE, at sale, and persisted. A later catalog edit (24 → 12 months)
 * must NOT retroactively re-date coverage a customer already bought, so reads
 * prefer the stored `warrantyExpiresAt` and only fall back to this computation
 * for rows that predate anchoring.
 *
 * Returns the SOLD-AT instant itself when there is no warranty, so the record
 * still carries a definite (already-elapsed) expiry rather than a null that
 * reads as "not yet sold".
 */
export function warrantyAnchorFor(args: {
  soldAt: string;
  warrantyMonths: number;
}): string {
  const months = Math.max(0, Math.floor(Number(args.warrantyMonths) || 0));
  return months > 0 ? addMonthsClamped(args.soldAt, months) : new Date(args.soldAt).toISOString();
}

// ────────────────────────────────────────────────────────────────────────────
// Unified warranty status — THE single authority (Q1 decoupling, stage 1)
// ────────────────────────────────────────────────────────────────────────────
//
// TWO warranties exist in this app and they were being conflated:
//
//   STORE  — the included shop warranty. Length in MONTHS, anchored at the SALE
//            instant, frozen in `imei_records.warranty_expires_at`.
//   REPAIR — the warranty on parts replaced by SAV. Length in FIXED DAY TIERS
//            (`WarrantyTier`), anchored at RESTITUTION (`RepairOrder.deliveredAt`).
//
// The inspector used to render the STORE term through a REPAIR badge
// (`tier="repair_90d"` hardcoded), so a 12-month shop warranty was labelled
// "Garantie réparation 90 jours", and `warrantyMonthsToTier` was used to turn
// a month count into a day tier — a unit conflation. Every consumer now reads a
// `WarrantyStatus` instead, which carries its own `kind`, so the two can be
// shown side by side and never mistaken for one another.

export type WarrantyKind = 'STORE' | 'REPAIR';

export type WarrantyState =
  /** Coverage is live and more than 30 days remain. */
  | 'ACTIVE'
  /** Coverage is live but expires within 30 days. */
  | 'EXPIRING_SOON'
  /** The coverage window has elapsed. */
  | 'EXPIRED'
  /** Never carried any coverage (deliberate "Sans Garantie", or no term). */
  | 'NEVER_COVERED'
  /**
   * In stock with a term that has not started yet — coverage begins at sale.
   * Distinct from NEVER_COVERED: the device DOES carry coverage, it simply has
   * not started. Collapsing the two is exactly the W-08 defect (an in-stock
   * "Grade B" and a clearance "as-is" unit must never read the same).
   */
  | 'NOT_STARTED'
  /** Coverage terminated by a return / exchange rather than by expiry. */
  | 'VOID'
  /** A repair warranty is live. Only ever emitted with kind === 'REPAIR'. */
  | 'REPAIR_WARRANTY_ACTIVE';

/** Coverage within this many days is escalated to EXPIRING_SOON. */
export const WARRANTY_EXPIRING_SOON_DAYS = 30;

/** Where a status value came from — shown in the UI so nothing is a black box. */
export type WarrantySource =
  /** `imei_records.warranty_expires_at`, frozen at sale. */
  | 'anchor'
  /** Recomputed from the term + start date (no anchor on the record). */
  | 'computed'
  /** `repair_orders.warranty_expires_at`, minted at restitution. */
  | 'repair-anchor'
  /** Recomputed from the repair tier + restitution date. */
  | 'repair-computed'
  /** No term anywhere: an undecided or deliberately zero warranty. */
  | 'none';

export interface WarrantyStatus {
  state: WarrantyState;
  kind: WarrantyKind;
  /** ISO instant the coverage window opens, or null when it has no start yet. */
  startDate: string | null;
  /** ISO instant the coverage window closes, or null when there is no term. */
  endDate: string | null;
  /** Whole days left, ceil-rounded so any remaining coverage reads as >= 1. */
  daysLeft: number;
  source: WarrantySource;
  /** Coverage length in months (STORE) or days (REPAIR); 0 when there is none. */
  term: number;
}

export interface StoreWarrantyInput {
  /** Included term in MONTHS. 0 = deliberately no coverage. */
  months: number;
  /** Sale instant. Null for a device that has never been sold. */
  startIso: string | null;
  /** Point-in-time anchor from the registry row; wins over recomputation. */
  anchoredExpiresAt?: string | null;
  sold: boolean;
  /** Terminated by a return / exchange rather than by running out. */
  voided?: boolean;
  /**
   * Instant the return was recorded. Coverage ENDS here, so it must not be
   * echoed back as the sale date — a dossier claiming a warranty ran "until"
   * the day it was bought reads as a live warranty on paper.
   */
  voidedAtIso?: string | null;
}

export interface RepairWarrantyInput {
  tier: WarrantyTier | null | undefined;
  /** RESTITUE stamp — the repair clock's anchor. */
  startIso: string | null;
  /** Minted at `Livré` by `createRepairSlice`; wins over recomputation. */
  expiresAtIso?: string | null;
  /** Repair status; an `Annulé` ticket carries no live repair warranty. */
  status?: string | null;
}

export interface WarrantyStatusInput {  /**
   * EVERY identifier this device answers to, already in any spelling.
   *
   * A LIST by design (owner decision on dual SIM): when IMEI2 support lands,
   * IMEI1 + IMEI2 + serial can all be passed here and neither this function nor
   * the lookup has to be rewritten. Comparison is by `normalizeDeviceKey`, so
   * `35-209900-176148-1` and `352099001761481` are one device.
   */
  identifiers: string[];
  store?: StoreWarrantyInput | null;
  repair?: RepairWarrantyInput | null;
  /** Injectable clock — boundary behaviour is otherwise untestable. */
  nowIso?: string;
}

const daysBetween = (endMs: number, nowMs: number) => Math.max(0, Math.ceil((endMs - nowMs) / DAY_MS));

/**
 * Store-warranty status. Pure and timezone-safe: every date is an ISO instant
 * and every arithmetic step is UTC (`addMonthsClamped`), so the result does not
 * depend on the terminal's timezone. Only the RENDERING is local.
 */
export function getWarrantyStatus(
  device: WarrantyStatusInput,
  nowIso?: string
): WarrantyStatus {
  const now = new Date(nowIso || device.nowIso || new Date().toISOString());
  const nowMs = now.getTime();
  const s = device.store;

  if (!s) {
    return { state: 'NEVER_COVERED', kind: 'STORE', startDate: null, endDate: null, daysLeft: 0, source: 'none', term: 0 };
  }
  const months = Math.max(0, Math.floor(Number(s.months) || 0));
  const startMs = s.startIso ? new Date(s.startIso).getTime() : NaN;
  const hasStart = !Number.isNaN(startMs);

  // A return / exchange terminates coverage regardless of any remaining term.
  if (s.voided) {
    const voidMs = s.voidedAtIso ? new Date(s.voidedAtIso).getTime() : NaN;
    return {
      state: 'VOID',
      kind: 'STORE',
      startDate: hasStart ? new Date(startMs).toISOString() : null,
      endDate: !Number.isNaN(voidMs)
        ? new Date(voidMs).toISOString()
        : hasStart
          ? new Date(startMs).toISOString()
          : null,
      daysLeft: 0,
      source: 'computed',
      term: months,
    };
  }

  // No term at all. A 0-month device anchored at its own sale date is EXPIRED
  // under `computeDeviceWarranty`, but for the operator "never covered" is the
  // truthful reading and it must not masquerade as an elapsed warranty.
  if (months <= 0) {
    return { state: 'NEVER_COVERED', kind: 'STORE', startDate: hasStart ? new Date(startMs).toISOString() : null, endDate: null, daysLeft: 0, source: 'none', term: 0 };
  }

  // In stock: the term is real but the clock has not started.
  if (!s.sold) {
    return {
      state: 'NOT_STARTED',
      kind: 'STORE',
      startDate: null,
      endDate: null,
      daysLeft: 0,
      source: 'computed',
      term: months,
    };
  }

  const anchoredMs = s.anchoredExpiresAt ? new Date(s.anchoredExpiresAt).getTime() : NaN;
  const useAnchor = !Number.isNaN(anchoredMs);
  const endMs = useAnchor ? anchoredMs : new Date(addMonthsClamped(s.startIso as string, months)).getTime();
  if (Number.isNaN(endMs)) {
    // Fail closed: an unresolvable expiry is never presented as coverage.
    return { state: 'EXPIRED', kind: 'STORE', startDate: new Date(startMs).toISOString(), endDate: null, daysLeft: 0, source: useAnchor ? 'anchor' : 'computed', term: months };
  }

  const daysLeft = daysBetween(endMs, nowMs);
  const state: WarrantyState =
    daysLeft <= 0 ? 'EXPIRED' : daysLeft <= WARRANTY_EXPIRING_SOON_DAYS ? 'EXPIRING_SOON' : 'ACTIVE';

  return {
    state,
    kind: 'STORE',
    startDate: new Date(startMs).toISOString(),
    endDate: new Date(endMs).toISOString(),
    daysLeft,
    source: useAnchor ? 'anchor' : 'computed',
    term: months,
  };
}

/**
 * Repair-warranty status, or null when the device carries no repair warranty
 * (no tier, tier `none`, or no restitution stamp yet).
 */
export function getRepairWarrantyStatus(
  device: WarrantyStatusInput,
  nowIso?: string
): WarrantyStatus | null {
  const r = device.repair;
  if (!r || !r.tier || r.tier === 'none') return null;

  const startMs = r.startIso ? new Date(r.startIso).getTime() : NaN;
  if (Number.isNaN(startMs)) return null;

  const now = new Date(nowIso || device.nowIso || new Date().toISOString());
  const anchoredMs = r.expiresAtIso ? new Date(r.expiresAtIso).getTime() : NaN;
  const useAnchor = !Number.isNaN(anchoredMs);
  const endMs = useAnchor
    ? anchoredMs
    : new Date(computeWarrantyExpiryISO(new Date(startMs).toISOString(), r.tier) + 'T00:00:00.000Z').getTime();
  if (Number.isNaN(endMs)) return null;

  const daysLeft = daysBetween(endMs, now.getTime());
  const cancelled = String(r.status ?? '') === 'Annulé';
  const state: WarrantyState = cancelled ? 'VOID' : daysLeft > 0 ? 'REPAIR_WARRANTY_ACTIVE' : 'EXPIRED';

  return {
    state,
    kind: 'REPAIR',
    startDate: new Date(startMs).toISOString(),
    endDate: new Date(endMs).toISOString(),
    daysLeft,
    source: useAnchor ? 'repair-anchor' : 'repair-computed',
    term: WARRANTY_TIER_DAYS[r.tier] ?? 0,
  };
}

export interface DeviceWarrantyStatus {
  store: WarrantyStatus;
  /** Null when the device carries no repair warranty. */
  repair: WarrantyStatus | null;
  /** What the operator acts on: a live repair warranty wins over a store one. */
  primary: WarrantyStatus;
}

/** Both warranties at once — the only shape the UI needs to render S5. */
export function getDeviceWarrantyStatus(
  device: WarrantyStatusInput,
  nowIso?: string
): DeviceWarrantyStatus {
  const store = getWarrantyStatus(device, nowIso);
  const repair = getRepairWarrantyStatus(device, nowIso);
  const repairIsLive = repair !== null && repair.state === 'REPAIR_WARRANTY_ACTIVE';
  return { store, repair, primary: repairIsLive ? repair : store };
}

/**
 * FRENCH operator-facing label for a status. Single source of UI copy.
 *
 * EXHAUSTIVE by construction: the `never` check makes the compiler fail here
 * whenever a state is added to `WarrantyState`, so a new state can never fall
 * through to a silent `default` and be mislabelled as expired or uncovered.
 */
export function warrantyStateLabel(status: WarrantyStatus): string {
  switch (status.state) {
    case 'ACTIVE':
      return 'Garantie magasin active';
    case 'EXPIRING_SOON':
      return 'Garantie magasin — bientôt expirée';
    case 'EXPIRED':
      return 'Garantie expirée / Hors garantie';
    case 'NEVER_COVERED':
      return 'Aucune garantie enregistrée';
    // NOT_STARTED must never borrow the expired or uncovered wording: this
    // device DOES carry coverage, it has simply not begun. (Owner requirement.)
    case 'NOT_STARTED':
      return 'Garantie non démarrée, débute à la vente';
    case 'VOID':
      return 'Garantie résiliée (retour / échange)';
    case 'REPAIR_WARRANTY_ACTIVE':
      return 'Garantie réparation active';
    default: {
      const exhaustive: never = status.state;
      void exhaustive;
      return 'État de garantie inconnu';
    }
  }
}

/**
 * Short chip label — never states a term the record does not carry.
 * Exhaustive for the same reason as `warrantyStateLabel`.
 */
export function warrantyChipLabel(status: WarrantyStatus): string {
  switch (status.state) {
    case 'ACTIVE':
    case 'EXPIRING_SOON':
    case 'REPAIR_WARRANTY_ACTIVE':
      return status.kind === 'REPAIR'
        ? `Garantie réparation ${status.term}j`
        : formatWarrantyDuration(status.term);
    case 'EXPIRED':
      return 'Garantie expirée';
    case 'NOT_STARTED':
      return `${formatWarrantyDuration(status.term)} — non démarrée`;
    case 'VOID':
      return 'Garantie résiliée';
    case 'NEVER_COVERED':
      return 'Sans garantie';
    default: {
      const exhaustive: never = status.state;
      void exhaustive;
      return 'Sans garantie';
    }
  }
}

/**
 * True when the status grants free repairs right now.
 *
 * `NOT_STARTED` is deliberately absent: coverage has not begun, so nothing is
 * covered yet. It must also never reach the expiring-soon escalation, which is
 * driven exclusively by the states listed here.
 */
/** Marker prefix for the Q-C archive note written into `IMEIRecord.notes`. */
export const PRODUCT_ARCHIVE_MARKER = 'Produit archivé';

/**
 * The note written onto a registry row when its product is deleted.
 *
 * Keeps the model name and SKU readable forever, in a field that already
 * existed, so an archived device still shows what it was instead of the
 * generic "Appareil Enregistré".
 */
export function describeArchivedProduct(
  title: string,
  sku: string | undefined,
  atIso: string
): string {
  const head = sku ? `${title} (${sku})` : title;
  return `${PRODUCT_ARCHIVE_MARKER} : ${head} — supprimé du catalogue le ${String(atIso).slice(0, 10)}`;
}

/** Reads the product name back out of an archived row's note, or null. */
export function archivedProductTitle(notes: string | null | undefined): string | null {
  if (!notes || !notes.startsWith(PRODUCT_ARCHIVE_MARKER)) return null;
  const body = notes.slice(PRODUCT_ARCHIVE_MARKER.length).replace(/^\s*:\s*/, '');
  const cut = body.indexOf(' — ');
  return (cut === -1 ? body : body.slice(0, cut)).trim() || null;
}

/**
 * True when the status grants free repairs right now.
 *
 * `NOT_STARTED` is deliberately absent: coverage has not begun, so nothing is
 * covered yet. It must also never reach the expiring-soon escalation, which is
 * driven exclusively by the states listed here.
 */
export function isWarrantyLive(status: WarrantyStatus): boolean {
  return (
    status.state === 'ACTIVE' ||
    status.state === 'EXPIRING_SOON' ||
    status.state === 'REPAIR_WARRANTY_ACTIVE'
  );
}

/**
 * Render a warranty date WITHOUT touching the timezone.
 *
 * `new Date('2026-12-31T00:00:00.000Z').toLocaleDateString('fr-DZ')` prints
 * 30/12/2026 in any zone west of UTC — the off-by-one-day defect (W-47). The
 * stored anchor is a calendar DAY, so we read the leading `YYYY-MM-DD` straight
 * out of the string and never construct a `Date` from it.
 */
export function formatWarrantyDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return '—';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** One-line, state-specific detail for the inspector banner. Exhaustive. */
export function warrantyHeadline(status: WarrantyStatus | null | undefined): string {
  if (!status) return "Aucune garantie enregistrée sur cet appareil.";
  switch (status.state) {
    case 'ACTIVE':
      return `Valable jusqu'au ${formatWarrantyDate(status.endDate)} (${status.daysLeft} j restants)`;
    case 'EXPIRING_SOON':
      return `Expire le ${formatWarrantyDate(status.endDate)} — ${status.daysLeft} j restants`;
    case 'REPAIR_WARRANTY_ACTIVE':
      return `Pièces remplacées garanties jusqu'au ${formatWarrantyDate(status.endDate)} (${status.daysLeft} j)`;
    case 'EXPIRED':
      return `Expirée le ${formatWarrantyDate(status.endDate)}`;
    case 'NOT_STARTED':
      return `Couverture de ${formatWarrantyDuration(status.term)} incluse — démarre à la vente, rien n'est couvert à ce jour.`;
    case 'VOID':
      return 'Résiliée par un retour ou un échange.';
    case 'NEVER_COVERED':
      return "Aucune garantie enregistrée sur cet appareil.";
    default: {
      const exhaustive: never = status.state;
      void exhaustive;
      return "Aucune garantie enregistrée sur cet appareil.";
    }
  }
}

/**
 * The two dates a warranty certificate prints, from the RESOLVED warranty.
 *
 * Both certificate renderers (80 mm ESC/POS and the 58 mm mobile twin) used to
 * recompute their own expiry with `new Date(start); setMonth(+months)`. That is
 * wrong twice over:
 *
 *  1. `setMonth` OVERFLOWS. 31 January + 1 month silently became 2/3 March, so a
 *     one-month certificate on a January purchase promised nearly two months.
 *  2. It ignored the ANCHOR. The expiry frozen at sale is the authoritative
 *     value; recomputing from today's catalog term can print a different date
 *     than the one the customer was given at the till.
 *
 * `addMonthsClamped` does the arithmetic in UTC with day clamping, and
 * `formatWarrantyDate` renders the calendar day without a timezone shift, so the
 * terminal, the 80 mm roll and the 58 mm phone print the SAME two dates.
 *
 * Layout is untouched — this only supplies the values.
 */
export function warrantyCertificateDates(input: {
  /** Sale instant (or the row's `soldAt`). */
  startIso: string;
  /** Included term in months. */
  months: number;
  /** Frozen expiry from the registry row; wins over recomputation. */
  anchoredExpiresAt?: string | null;
}): { startIso: string; expiryIso: string; start: string; expiry: string; anchored: boolean } {
  const anchor = input.anchoredExpiresAt ? new Date(input.anchoredExpiresAt) : null;
  const useAnchor = anchor !== null && !Number.isNaN(anchor.getTime());
  const expiryIso = useAnchor
    ? (anchor as Date).toISOString()
    : addMonthsClamped(input.startIso, Math.max(0, Math.floor(Number(input.months) || 0)));
  return {
    startIso: new Date(input.startIso).toISOString(),
    expiryIso,
    start: formatWarrantyDate(new Date(input.startIso).toISOString()),
    expiry: formatWarrantyDate(expiryIso),
    anchored: useAnchor,
  };
}

/**
 * Canonical STORAGE forms of every identifier in a (possibly combined) cell.
 *
 * Unlike `identifierKeysOf`, which produces comparison keys, this returns values
 * that can be persisted or re-queried: an IMEI compacts to its 15 digits, a
 * serial keeps its hyphens. Exposing the stripped comparison keys instead meant
 * `dossier.identifiers` was useless to any caller that had to store or re-query
 * it — a serial came back as `SNXZ799213A`.
 */
export function canonicalIdentifiersOf(raw: string | string[] | null | undefined): string[] {
  const cells = Array.isArray(raw) ? raw : [raw as string];
  const out = new Set<string>();
  for (const cell of cells) {
    for (const part of String(cell || '').split(/[/,;|]|\s{2,}|\sAND\s/i)) {
      const value = part.trim();
      if (!value) continue;
      const c = canonicalDeviceId(value);
      if (c) out.add(c);
    }
  }
  return [...out];
}

/** Repair tickets that must never shadow a store warranty or inflate a count. */
const VOID_REPAIR_STATUS = 'Annulé';
export function isLiveRepairOrder(order: { status?: string | null }): boolean {
  return String(order?.status ?? '') !== VOID_REPAIR_STATUS;
}

/** Every canonical identifier a device answers to, de-duplicated, order-stable. */
export function identifierKeysOf(raw: string | string[] | null | undefined): string[] {
  const list = Array.isArray(raw) ? raw : [raw as string];
  const seen = new Set<string>();
  for (const v of list) {
    const key = normalizeDeviceKey(v);
    if (key) seen.add(key);
  }
  return [...seen];
}

/**
 * Keys of every identifier a RECORD knows, not just the ones it was asked for.
 *
 * A registry row predating dual-SIM support stores both IMEIs in one free-text
 * cell ("352099001761481 / 352099001761994", or comma- or semicolon-separated).
 * Comparing that whole cell against a single scanned IMEI never matched, so an
 * operator scanning IMEI2 got "unknown device" for a device they were looking at.
 * Splitting on the usual separators makes those rows resolve today without a
 * schema change.
 */
function recordKeysOf(recordIdentifier: string | null | undefined): string[] {
  const raw = (recordIdentifier || '').trim();
  if (!raw) return [];
  return identifierKeysOf(raw.split(/[/,;|]|\s{2,}|\sAND\s/i));
}

/** True when any identifier on the record matches this device's key set. */
function matchesAnyIdentifier(recordIdentifier: string | null | undefined, keys: string[]): boolean {
  return recordKeysOf(recordIdentifier).some((k) => keys.includes(k));
}

/**
 * Repair tickets for this device, newest first. Cancelled tickets are EXCLUDED:
 * they must neither inflate the "interventions" count nor shadow the store
 * warranty branch (an `Annulé` ticket used to hide a perfectly valid anchored
 * coverage by taking the repair branch first).
 */
export function repairTicketsFor(
  repairOrders: RepairOrder[] | null | undefined,
  keys: string[],
  opts: { includeVoided?: boolean; excludeIds?: string[] } = {}
): RepairOrder[] {
  const exclude = new Set(opts.excludeIds || []);
  return (repairOrders || [])
    .filter((r) => matchesAnyIdentifier(r?.imei, keys))
    .filter((r) => !exclude.has(r.id))
    .filter((r) => opts.includeVoided || isLiveRepairOrder(r))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** Interventions SAV count — live tickets only (owner decision on W-15). */
export function savCountForImei(repairOrders: RepairOrder[] | null | undefined, imei: string | string[]): number {
  const keys = identifierKeysOf(imei);
  if (keys.length === 0) return 0;
  return repairTicketsFor(repairOrders, keys).length;
}

/** Explicit alias: SAV history count for a device identifier. */
export const savCountFor = savCountForImei;

/**
 * Pure device-identifier → dossier lookup (no React, no audio, no setState).
 * Branch order is unchanged (it is the precedence contract):
 *   transactions → repairOrders → imeiRecords → products → fallback
 *
 * `rawImei` accepts a STRING **or a LIST of identifiers** (owner decision on
 * dual SIM): IMEI2 support can be added later by passing `[imei1, imei2]` here
 * without touching a single line of the matching logic.
 */
export function lookupDeviceWarrantyByImei(
  rawImei: string | string[],
  deps: WarrantyLookupDeps,
  /** Injectable clock so boundary behaviour is testable. Defaults to now. */
  clockIso?: string
): ImeiLifecycleDossier {
  const now = new Date(clockIso || new Date().toISOString());
  const nowIso = now.toISOString();
  const transactions = deps.transactions || [];
  const products = deps.products || [];
  const imeiRecords = deps.imeiRecords || [];
  const repairOrders = deps.repairOrders || [];

  const keys = identifierKeysOf(rawImei);
  const q = keys[0] ?? '';

  /**
   * Every identifier this device answers to, in canonical STORAGE form.
   *
   * Collected across all three sources rather than taken from the query, so a
   * device whose registry cell lists IMEI1 + IMEI2 reports both, and a ticket
   * that records a different spelling of the same device still round-trips.
   */
  const deviceIdentifiers = (): string[] => {
    const out = new Set<string>(canonicalIdentifiersOf(rawImei));
    const add = (cell: string | null | undefined) => {
      if (!matchesAnyIdentifier(cell, keys)) return;
      for (const v of canonicalIdentifiersOf(cell)) out.add(v);
    };
    for (const r of imeiRecords) add(r.imei);
    for (const p of products) add(p.imeiNumber);
    for (const t of transactions) for (const li of t.items || []) add(li.imeiNumber);
    return [...out];
  };
  /** Live tickets for this device — computed ONCE and shared by every branch. */
  const tickets = repairTicketsFor(repairOrders, keys);
  const savCount = tickets.length;
  const primaryTicket = tickets[0] ?? null;

  /** Repair warranty for this device, from the newest DELIVERED ticket. */
  const repairWarrantyOf = (): WarrantyStatus | null => {
    const delivered = tickets.find((r) => String(r.status ?? '') === 'Livré' && isLiveRepairOrder(r));
    if (!delivered) return null;
    return getRepairWarrantyStatus({
      identifiers: deviceIdentifiers(),
      repair: {
        tier: delivered.warrantyTier ?? null,
        startIso: delivered.deliveredAt ?? null,
        expiresAtIso: delivered.warrantyExpiresAt ?? null,
        status: delivered.status,
      },
    }, nowIso);
  };

  // Newest-first, like every other timeline in the dossier: the inspector shows
  // the most recent intervention at the top, and a delivered ticket (the only one
  // that carries a repair expiry) is almost never the oldest.
  const ticketSummaries = [...tickets]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((r) => ({
      ticketNumber: r.ticketNumber,
      status: r.status,
      createdAt: r.createdAt,
      deliveredAt: r.deliveredAt ?? null,
    }));

  // 1. Transactions (newest first)
  const sortedSales = [...transactions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const matchingTxns = sortedSales.filter((sale) =>
    (sale.items || []).some(
      (i: CartItem) =>
        matchesAnyIdentifier(i.imeiNumber, keys) || matchesAnyIdentifier(i.serialNumber, keys)
    )
  );
  if (matchingTxns.length > 0 && keys.length > 0) {
    // Q-A FIX: the refund/void test is scoped to the LATEST sale only.
    //
    // It used to be `matchingTxns.some(t => t.isRefund)` over EVERY sale that
    // ever carried the identifier, so one refund voucher permanently marked the
    // device "returned" — a device that was refunded and then legitimately
    // re-sold could never show coverage again, and its title kept the
    // "(Article Retourné / Remboursé)" suffix forever. Returns are per-sale, not
    // per-device: only the CURRENT sale's state decides.
    const latestTxn = matchingTxns[0];
    const latestIsRefund = Boolean(latestTxn.isRefund);
    const latestStatus = (latestTxn as { status?: string }).status;
    const isVoided = latestStatus === 'VOIDED';
    const isRefunded = latestIsRefund || latestStatus === 'REFUNDED';
    // The sale whose terms describe the device's coverage: the latest sale that
    // is not itself a refund voucher or a void.
    const originalSale =
      matchingTxns.find((t) => !t.isRefund && (t as { status?: string }).status !== 'VOIDED') ??
      latestTxn;
    const originalItem = originalSale.items?.find(
      (i: CartItem) =>
        matchesAnyIdentifier(i.imeiNumber, keys) || matchesAnyIdentifier(i.serialNumber, keys)
    );
    const matchedProduct = products.find((p) => p.id === originalItem?.product?.id);
    // THE SALE-TIME SNAPSHOT IS AUTHORITATIVE.
    //
    // Step A mints `warranty_months_at_sale` at checkout. Re-deriving the term
    // from the live catalog here — as this line used to do — makes a later
    // product edit silently re-date a historical sale, and it cannot express a
    // deliberate zero (the product re-resolves to the store default).
    //
    // Fall back to catalog re-derivation ONLY for lines sold before Step A,
    // which carry no snapshot.
    const lineSnapshot = (() => {
      const li = originalItem as
        | (CartItem & { warranty_months_at_sale?: unknown })
        | null
        | undefined;
      if (!li) return undefined;
      return coerceWarrantyMonths(li.warrantyMonthsAtSale ?? li.warranty_months_at_sale);
    })();
    const warrantyMonths =
      lineSnapshot !== undefined
        ? lineSnapshot
        : resolveWarrantyWithFallback(matchedProduct ?? null, originalItem?.product ?? null);

    // Q-A FIX (reader): the stored anchor is honoured ONLY when it belongs to
    // the sale we just resolved. After a refund + resale the registry row still
    // points at the ORIGINAL `sale_transaction_id` with the ORIGINAL expiry, so
    // trusting it handed buyer #2 buyer #1's warranty clock. A mismatched anchor
    // is ignored and the expiry is derived from THIS sale's date instead — no
    // stored data has to change for the read to be correct.
    const anchorRow = imeiRecords.find(
      (r) => matchesAnyIdentifier(r.imei, keys) && r.saleTransactionId === originalSale.id
    );
    const staleAnchorRow = imeiRecords.find(
      (r) => matchesAnyIdentifier(r.imei, keys) && r.saleTransactionId
    );
    const anchorApplies = anchorRow?.warrantyExpiresAt ?? null;
    const storeStatus = getWarrantyStatus({
      identifiers: deviceIdentifiers(),
      store: {
        months: warrantyMonths,
        startIso: originalSale.createdAt,
        anchoredExpiresAt: anchorApplies,
        sold: !isRefunded && !isVoided,
        // Q-B: an exchange/return leg terminates coverage on the outgoing unit.
        // Derived from the existing `isReturn` flag — no new stored field. The
        // transaction's own stamp is when coverage actually ended.
        voided: Boolean((originalItem as { isReturn?: boolean } | undefined)?.isReturn),
        voidedAtIso: (originalItem as { isReturn?: boolean } | undefined)?.isReturn
          ? originalSale.createdAt
          : null,
      },
    }, nowIso);

    let statusSuffix = '';
    if (isVoided) statusSuffix = ' (Vente Annulée)';
    else if (isRefunded) statusSuffix = ' (Article Retourné / Remboursé)';
    const repairWarranty = repairWarrantyOf();
    const dossier: ImeiLifecycleDossier = {
      imei: q,
      identifiers: deviceIdentifiers(),
      productTitle: ((originalItem?.product?.title || matchedProduct?.title || 'Smartphone Vendu') + statusSuffix) as string,
      isSold: !isRefunded && !isVoided,
      warrantyMonths,
      originalReceiptNumber: originalSale.receiptNumber,
      originalCustomerName: originalSale.customer?.name || 'Client Comptoir',
      originalCustomerPhone: originalSale.customer?.phone || '-',
      soldAt: originalSale.createdAt,
      // A VOID / NEVER_COVERED / NOT_STARTED device must NOT carry a fabricated
      // expiry: the UI renders "A expiré le <date>" whenever this is truthy, so
      // an unknown or void device used to claim it expired today.
      warrantyExpiresAt: storeStatus.endDate ?? undefined,
      isWarrantyValid: isWarrantyLive(storeStatus),
      daysRemaining: storeStatus.daysLeft,
      repairHistoryCount: savCount,
      storeWarranty: storeStatus,
      repairWarranty,
      savTickets: ticketSummaries,
      isUnknownDevice: false,
    };
    dossier.primaryWarranty =
      repairWarranty && repairWarranty.state === 'REPAIR_WARRANTY_ACTIVE' ? repairWarranty : storeStatus;
    // Surfaced for diagnostics only — the reader deliberately IGNORES it.
    void staleAnchorRow;
    return dossier;
  }

  // 2. Repair work orders. Only reached when the device has NO sale line at all.
  // W-04 FIX: this branch used to hardcode `warrantyMonths: 12` with
  // `warrantyExpiresAt: nowIso`, so the card asserted "expired today" and
  // "Garantie 1 an (jusqu'au aujourd'hui)" in the same breath. It now reports NO
  // store coverage and exposes whatever repair warranty the ticket carries.
  if (primaryTicket && keys.length > 0) {
    // Prefer the catalog record linked by the REGISTRY row, then by the product's
    // own identifier: the repair branch runs before the registry branch, so
    // without this a stocked device showed the ticket's terse device label
    // instead of its real product title.
    const registryProductId = imeiRecords.find((r) => matchesAnyIdentifier(r.imei, keys))?.productId;
    const catalogProduct =
      products.find((p) => p.id === registryProductId) ??
      products.find((p) => normalizeDeviceKey(p.imeiNumber ?? '') === q) ??
      null;
    const storeStatus = getWarrantyStatus({
      identifiers: deviceIdentifiers(),
      // Never sold, therefore no store coverage exists — not a 12-month guess.
      store: { months: 0, startIso: null, sold: false },
    }, nowIso);
    const repairWarranty = repairWarrantyOf();
    const dossier: ImeiLifecycleDossier = {
      imei: q,
      identifiers: deviceIdentifiers(),
      // The catalog title is more informative than the ticket's device label.
      productTitle: catalogProduct?.title || primaryTicket.deviceModel || 'Appareil SAV',
      isSold: false,
      warrantyMonths: 0,
      originalReceiptNumber: primaryTicket.ticketNumber,
      originalCustomerName: primaryTicket.customerName,
      originalCustomerPhone: primaryTicket.customerPhone,
      soldAt: primaryTicket.createdAt,
      warrantyExpiresAt: storeStatus.endDate ?? undefined,
      // `isWarrantyValid` / `daysRemaining` are STORE mirrors everywhere else,
      // and they sit next to the store `warrantyMonths` / `warrantyExpiresAt`.
      // Letting the repair branch report "valid" here made the same flag mean two
      // different things depending on which record the device happened to live
      // in. Repair coverage is read from `repairWarranty` / `primaryWarranty`.
      isWarrantyValid: isWarrantyLive(storeStatus),
      daysRemaining: storeStatus.daysLeft,
      repairHistoryCount: savCount,
      storeWarranty: storeStatus,
      repairWarranty,
      savTickets: ticketSummaries,
      isUnknownDevice: false,
    };
    dossier.primaryWarranty =
      repairWarranty && repairWarranty.state === 'REPAIR_WARRANTY_ACTIVE' ? repairWarranty : storeStatus;
    return dossier;
  }

  // 3. IMEI registry
  // W-50 FIX (a): duplicates now resolve MOST-RECENT-FIRST instead of by array
  // position. `find()` used to return whichever row happened to be first, so a
  // stale duplicate with an elapsed expiry could make a perfectly live device
  // read EXPIRED depending on insertion order.
  const registryMatches = imeiRecords
    .filter((r) => matchesAnyIdentifier(r.imei, keys))
    .sort((a, b) => {
      const at = new Date(a.soldAt || a.receivedAt || 0).getTime();
      const bt = new Date(b.soldAt || b.receivedAt || 0).getTime();
      if (bt !== at) return bt - at;
      return String(b.imei).length - String(a.imei).length;
    });
  const foundImeiRecord = registryMatches[0];
  if (foundImeiRecord && keys.length > 0) {
    const matchedProd = products.find((p) => p.id === foundImeiRecord.productId);
    const isSold = Boolean(foundImeiRecord.soldAt);
    // W-50 FIX (b): the row's OWN term wins over the live catalog. `warrantyMonths`
    // is written on the registry row at sale precisely so a later catalog edit
    // cannot re-date it; reading the catalog here threw that protection away for
    // every device whose sale line is absent.
    const rowMonths = coerceWarrantyMonths(foundImeiRecord.warrantyMonths);
    const warrantyMonths = rowMonths !== undefined ? rowMonths : resolveWarrantyMonths(matchedProd);
    const baseDate = foundImeiRecord.soldAt || foundImeiRecord.receivedAt || null;
    const storeStatus = getWarrantyStatus({
      identifiers: deviceIdentifiers(),
      store: {
        months: warrantyMonths,
        startIso: baseDate,
        // Anchored expiry wins; otherwise recompute from the term (UTC, clamped).
        anchoredExpiresAt: foundImeiRecord.warrantyExpiresAt ?? null,
        sold: isSold,
      },
    }, nowIso);
    const repairWarranty = repairWarrantyOf();
    const dossier: ImeiLifecycleDossier = {
      imei: q,
      identifiers: deviceIdentifiers(),
      productTitle: matchedProd?.title || archivedProductTitle(foundImeiRecord.notes) || 'Appareil Enregistré',
      isSold,
      warrantyMonths,
      originalReceiptNumber: foundImeiRecord.saleTransactionId ? `TXN-${foundImeiRecord.saleTransactionId.slice(0, 8)}` : 'STOCK',
      originalCustomerName: isSold ? 'Client Enregistré' : 'Article en Stock Magasin',
      originalCustomerPhone: '-',
      soldAt: baseDate ?? undefined,
      warrantyExpiresAt: storeStatus.endDate ?? undefined,
      isWarrantyValid: isSold && isWarrantyLive(storeStatus),
      daysRemaining: isSold ? storeStatus.daysLeft : 0,
      repairHistoryCount: savCount,
      storeWarranty: storeStatus,
      repairWarranty,
      savTickets: ticketSummaries,
      isUnknownDevice: false,
    };
    dossier.primaryWarranty =
      repairWarranty && repairWarranty.state === 'REPAIR_WARRANTY_ACTIVE' ? repairWarranty : storeStatus;
    return dossier;
  }

  // 4. Inventory products
  const foundProduct = products.find(
    (p) =>
      matchesAnyIdentifier(p.imeiNumber, keys) ||
      matchesAnyIdentifier(p.barcode, keys) ||
      // SKU stays on the raw form on purpose: a SKU is a short catalog label,
      // not a device identifier, so it must never collide with the IMEI key space.
      p.sku.toLowerCase() === String(Array.isArray(rawImei) ? rawImei[0] : rawImei).trim().toLowerCase()
  );
  if (foundProduct && keys.length > 0) {
    const warrantyMonths = resolveWarrantyMonths(foundProduct);
    const storeStatus = getWarrantyStatus({
      identifiers: deviceIdentifiers(),
      // In stock: the term is real, the clock has not started. Never "expired".
      store: { months: warrantyMonths, startIso: null, sold: false },
    }, nowIso);
    const repairWarranty = repairWarrantyOf();
    const dossier: ImeiLifecycleDossier = {
      imei: q,
      identifiers: deviceIdentifiers(),
      productTitle: foundProduct.title,
      isSold: false,
      warrantyMonths,
      originalReceiptNumber: 'STOCK-' + foundProduct.sku,
      originalCustomerName: 'Article en Stock Magasin (Non Vendu)',
      originalCustomerPhone: '-',
      // In stock there is no expiry to show; the banner explains it starts at sale.
      soldAt: undefined,
      warrantyExpiresAt: storeStatus.endDate ?? undefined,
      isWarrantyValid: false,
      daysRemaining: 0,
      repairHistoryCount: savCount,
      storeWarranty: storeStatus,
      repairWarranty,
      savTickets: ticketSummaries,
      isUnknownDevice: false,
    };
    dossier.primaryWarranty =
      repairWarranty && repairWarranty.state === 'REPAIR_WARRANTY_ACTIVE' ? repairWarranty : storeStatus;
    return dossier;
  }

  // 5. Fallback — non-registered
  // W-03 FIX: no fabricated `warrantyExpiresAt`. Setting it to `now` made the UI
  // print "A expiré le <today>" for a device the shop has simply never seen,
  // and made the "aucune garantie enregistrée" branch unreachable.
  const unknownStatus = getWarrantyStatus({ identifiers: keys, store: null }, nowIso);
  const dossier: ImeiLifecycleDossier = {
    imei: q,
    identifiers: deviceIdentifiers(),
    productTitle: `Appareil Non Référencé (${q.length >= 8 ? q.slice(0, 8) + '...' : q})`,
    isSold: false,
    warrantyMonths: 0,
    originalReceiptNumber: 'NON ENREGISTRÉ',
    originalCustomerName: 'Appareil Inconnu / Hors Réseau',
    originalCustomerPhone: '-',
    soldAt: undefined,
    warrantyExpiresAt: undefined,
    isWarrantyValid: false,
    daysRemaining: 0,
    repairHistoryCount: savCount,
    storeWarranty: unknownStatus,
    repairWarranty: null,
    savTickets: ticketSummaries,
    isUnknownDevice: true,
  };
  dossier.primaryWarranty = unknownStatus;
  return dossier;
}

// ──────────────────────────────────────────────────────────────────────────────
// Inspector list — the SAME authority as the detail panel
// ──────────────────────────────────────────────────────────────────────────────

export interface WarrantyDeviceListRow {
  /** Display identifier (the first key of `identifiers`). */
  imei: string;
  /** Every identifier this device is known by, for IMEI2-ready matching. */
  identifiers: string[];
  productTitle: string;
  customerName: string;
  saleDate: string;
  receiptNumber: string;
  warrantyMonths: number;
  warrantyExpiresAt: string;
  daysRemaining: number;
  isWarrantyValid: boolean;
  repairHistoryCount: number;
  /** Authoritative status; drives the list badge and the S5 twin chips. */
  status: WarrantyStatus;
  /** Present when SAV replaced parts; rendered as a SECOND, separate chip. */
  repairStatus?: WarrantyStatus | null;
}

/**
 * Enumerate every device the operator can reach, then resolve EACH ONE through
 * `lookupDeviceWarrantyByImei`.
 *
 * This is the W-01/W-02 fix. The list used to re-derive its own warranty inline
 * (`computeDeviceWarranty` + `resolveWarrantyWithFallback` from the *live*
 * catalog), so editing a product in the catalog changed the list while the detail
 * panel kept showing the row's own snapshot — two different answers for one
 * device, and a hardcoded `repair_90d` badge on a 1-year shop warranty. Routing
 * both through one function makes divergence structurally impossible.
 *
 * Order is stable and matches the old list (sales → SAV → registry → catalog) so
 * the first card a user sees does not move.
 */
export function buildWarrantyDeviceList(
  deps: WarrantyLookupDeps,
  /** Shared clock: list and detail must agree even at a boundary instant. */
  clockIso?: string
): WarrantyDeviceListRow[] {
  const { transactions, repairOrders, products, imeiRecords } = deps;
  const candidates: string[] = [];

  const add = (raw: string | null | undefined) => {
    const value = (raw || '').trim();
    if (!value) return;
    const key = normalizeDeviceKey(value);
    if (!key) return;
    if (candidates.some((c) => normalizeDeviceKey(c) === key)) return;
    candidates.push(value);
  };

  for (const sale of transactions || []) {
    if (sale.status === 'VOIDED' || sale.isRefund) continue;
    for (const item of sale.items || []) add(item.imeiNumber);
  }
  for (const order of repairOrders || []) add(order.imei);
  for (const rec of imeiRecords || []) add(rec.imei);
  for (const prod of products || []) {
    const own = (prod.imeiNumber || '').trim();
    if (own) {
      add(own);
      continue;
    }
    const bar = (prod.barcode || '').trim();
    // Only a serialized product may borrow its barcode as a device identifier,
    // and a retail EAN is NOT one: a 13-digit EAN on a boxed handset produced a
    // phantom device card ("Appareil enregistré") for every stock unit.
    if (prod.isSerialized && bar.length >= 10 && !/^\d{8,14}$/.test(bar)) add(bar);
  }

  const rows: WarrantyDeviceListRow[] = [];
  for (const candidate of candidates) {
    let dossier: ImeiLifecycleDossier;
    try {
      dossier = lookupDeviceWarrantyByImei(candidate, deps, clockIso);
    } catch {
      // Fail closed: a device whose state cannot be resolved is listed as
      // uncovered rather than silently rendered as in-warranty.
      continue;
    }
    const status =
      dossier.storeWarranty ?? getWarrantyStatus({ identifiers: [candidate] });
    rows.push({
      imei: candidate,
      identifiers: dossier.identifiers?.length ? dossier.identifiers : [candidate],
      productTitle: dossier.productTitle,
      customerName: dossier.originalCustomerName || 'En Stock Magasin',
      saleDate: dossier.soldAt || '',
      receiptNumber: dossier.originalReceiptNumber || 'STOCK',
      warrantyMonths: dossier.warrantyMonths ?? 0,
      warrantyExpiresAt: dossier.warrantyExpiresAt || '',
      daysRemaining: dossier.daysRemaining ?? 0,
      isWarrantyValid: dossier.isWarrantyValid,
      repairHistoryCount: dossier.repairHistoryCount,
      status,
      repairStatus: dossier.repairWarranty ?? null,
    });
  }
  return rows;
}

// ────────────────────────────────────────────────────────────────────────────
// Unified warranty authority (single source of truth)
// ────────────────────────────────────────────────────────────────────────────

/** Mode-aware sanitization + validation of a raw device identifier. */
export function sanitizeDeviceIdentifier(
  raw: string,
  mode: DeviceIdentifierMode
): SanitizedDeviceId {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return { value: '', mode, digitCount: 0, luhnOk: false, isSearchable: false, note: 'Identifiant vide.' };
  }

  if (mode === 'imei') {
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length !== 15) {
      return {
        value: trimmed.toUpperCase(),
        mode,
        digitCount: digits.length,
        luhnOk: false,
        isSearchable: false,
        note: `IMEI attendu à 15 chiffres (${digits.length} saisi${digits.length > 1 ? 's' : ''}).`,
      };
    }
    const ok = luhnCheckImei(digits);
    return {
      value: digits,
      mode,
      digitCount: digits.length,
      luhnOk: ok,
      // Fail-closed on a failing checksum: a wrong IMEI must never resolve a
      // warranty dossier (it would grant free repairs on the wrong device).
      isSearchable: ok,
      ...(ok ? {} : { note: 'Clé de contrôle IMEI (Luhn) invalide — vérifiez la saisie.' }),
    };
  }

  if (mode === 'serial') {
    const cleaned = trimmed.toUpperCase().replace(/\s+/g, '');
    const ok = cleaned.length >= 4;
    return {
      value: cleaned,
      mode,
      digitCount: 0,
      luhnOk: false,
      isSearchable: ok,
      ...(ok ? {} : { note: 'Numéro de série trop court (4 caractères minimum).' }),
    };
  }

  // manual — no identifier at all: not searchable, but a legal intake value.
  return { value: '', mode: 'manual', digitCount: 0, luhnOk: false, isSearchable: false };
}

export interface WarrantyResolution {
  ok: boolean;
  identifier: SanitizedDeviceId;
  snapshot: WarrantyDossierSnapshot | null;
  /** Set when the identifier was rejected or no dossier could be built. */
  note?: string;
}

/**
 * THE single warranty authority. Both the Inspector and the SAV intake call
 * this — never their own branch order. Removing the divergent inline lookup
 * is what makes the two screens agree for the same identifier.
 */
export function resolveWarrantyDossier(
  rawId: string | string[],
  mode: DeviceIdentifierMode,
  deps: WarrantyLookupDeps
): WarrantyResolution {
  const first = Array.isArray(rawId) ? rawId[0] : rawId;
  const identifier = sanitizeDeviceIdentifier(first, mode);

  if (mode === 'manual') {
    return {
      ok: false,
      identifier,
      snapshot: null,
      note: 'Aucun identifiant saisi — dossier de garantie indisponible (enregistrement anonyme).',
    };
  }

  if (!identifier.isSearchable) {
    return {
      ok: false,
      identifier,
      snapshot: null,
      note: identifier.note || 'Identifiant invalide.',
    };
  }

  // Every identifier the caller knows about (today: the sanitized one; later:
  // IMEI1 + IMEI2 + serial) is matched through the SAME lookup.
  const keys = identifierKeysOf([identifier.value, ...(Array.isArray(rawId) ? rawId.slice(1) : [])]);

  let dossier: ImeiLifecycleDossier;
  try {
    dossier = lookupDeviceWarrantyByImei(keys, deps);
  } catch {
    // Fail closed: an unknown state must never present a warranty.
    return {
      ok: false,
      identifier,
      snapshot: null,
      note: 'Résolution de garantie impossible — dossier traité comme hors garantie.',
    };
  }

  // Q1 FIX: `suggestedTier` is a REPAIR-warranty choice (a fixed day tier minted
  // at restitution). It used to be derived from the STORE term in months, which
  // both mislabelled the inspector badge ("90 jours" on a 1-year shop warranty)
  // and wrote the wrong tier into a fresh SAV ticket — a 12-month store warranty
  // mapped to `repair_180d`, so the repair warranty was silently 180 days
  // instead of anything the operator chose. It is now an explicit, operator-owned
  // default and NEVER derived from the store term; when the store warranty is
  // live the repair work is simply billed as warranty work, not re-tiered.
  const suggestedTier: WarrantyTier =
    dossier.primaryWarranty?.state === 'REPAIR_WARRANTY_ACTIVE' ? 'repair_90d' : 'none';

  return {
    ok: true,
    identifier,
    snapshot: {
      idValue: identifier.value,
      idMode: mode,
      dossier,
      suggestedTier,
      resolvedAt: new Date().toISOString(),
    },
  };
}

/**
 * Build the SAV intake draft from an ALREADY-RESOLVED snapshot.
 *
 * This is the Inspector → SAV handoff, extracted as a pure function so it can be
 * tested directly. It never re-resolves anything: the draft must record exactly
 * what the operator was looking at, and re-resolving is what broke serial
 * devices (W-06/W-07/W-37) — the inspector resolved the dossier in serial mode,
 * then the handoff threw the same identifier at the 15-digit IMEI gate and
 * refused with "le dossier SAV exige un identifiant contrôlé". A serial-number
 * tablet therefore could never have a repair ticket opened from the inspector.
 *
 * `idType` comes from the snapshot's OWN `idMode`, never from the length of the
 * identifier, so a 15-digit serial or a serial that happens to look numeric can
 * never be mislabelled as an IMEI.
 */
export function buildSavIntakeDraft(snapshot: WarrantyDossierSnapshot): IntakeDraft {
  const d = snapshot.dossier;
  const usableName =
    d.originalCustomerName && d.originalCustomerName !== 'Client Comptoir'
      ? d.originalCustomerName
      : undefined;
  const usablePhone =
    d.originalCustomerPhone && d.originalCustomerPhone !== '-' ? d.originalCustomerPhone : undefined;

  return {
    sanitizedId: snapshot.idValue,
    idType: snapshot.idMode === 'serial' ? 'serial' : 'imei',
    deviceTitle: d.productTitle,
    customer: { name: usableName, phone: usablePhone },
    warrantyDossier: snapshot,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Legacy `{ isUnderWarranty, label, expiryDate }` mirror of a frozen dossier.
 *
 * Kept because the SAV banner, the restitution document and the tier derivation
 * all read `RepairOrder.warrantySnapshot`. Deriving it here — rather than leaving
 * it undefined for a dossier-seeded intake — means those three read ONE source
 * instead of a stale boolean alongside a live dossier.
 */
export function legacyWarrantySnapshot(snapshot: WarrantyDossierSnapshot): WarrantySnapshot {
  const store = snapshot.dossier.storeWarranty;
  const repair = snapshot.dossier.repairWarranty;
  const repairLive = repair?.state === 'REPAIR_WARRANTY_ACTIVE';
  const storeLive = store?.state === 'ACTIVE' || store?.state === 'EXPIRING_SOON';
  const live = repairLive || storeLive;

  let label: string;
  if (repairLive) label = 'Garantie réparation active';
  else if (storeLive) label = warrantyStateLabel(store!);
  else if (store?.state === 'NOT_STARTED') label = warrantyStateLabel(store);
  else if (store?.state === 'VOID') label = warrantyStateLabel(store);
  else label = 'Hors garantie';

  return {
    isUnderWarranty: live,
    label,
    expiryDate: (repair?.endDate ?? store?.endDate ?? undefined) as string | undefined,
  };
}

/**
 * Free-text budget for one field of the persisted snapshot. Product titles and
 * invoice numbers are single short lines in this trade; anything longer is not
 * evidence, it is payload.
 */
const TICKET_TEXT_MAX = 120;

const WARRANTY_STATES: ReadonlySet<string> = new Set<WarrantyState>([
  'ACTIVE',
  'EXPIRING_SOON',
  'EXPIRED',
  'NEVER_COVERED',
  'NOT_STARTED',
  'VOID',
  'REPAIR_WARRANTY_ACTIVE',
]);
const WARRANTY_SOURCES: ReadonlySet<string> = new Set<WarrantySource>([
  'anchor',
  'computed',
  'repair-anchor',
  'repair-computed',
  'none',
]);

/** Bounded free text: trimmed, cut at the budget, absent when empty. */
const ticketText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > TICKET_TEXT_MAX ? trimmed.slice(0, TICKET_TEXT_MAX) : trimmed;
};

/** An ISO instant, or undefined. A malformed date is DROPPED, never invented. */
const ticketInstant = (value: unknown): string | undefined =>
  typeof value === 'string' && !Number.isNaN(new Date(value).getTime()) ? value : undefined;

/** A finite count, or undefined. Rejects NaN/Infinity/strings. */
const ticketCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * The MINIMAL frozen dossier a SAV ticket persists (Decision 1, condition 1).
 *
 * The snapshot rides inside `repair_orders.json_payload`, which is a SYNCED
 * blob: `payloadHygiene` blanks image fields over 2 KB, drops blob-like strings
 * over 16 KB, and refuses a whole payload over 64 KB. A full dossier would drag
 * `savTickets` (unbounded), the identifier list and duplicate PII along for a
 * ride, and one oversized free-text field is enough to lose the entire ticket
 * row from the sync. So this projects onto exactly the fields the ticket READS:
 *
 *   - `idValue` / `idMode` — what was resolved and how it must be typed;
 *   - `suggestedTier` — the operator's default repair tier;
 *   - `resolvedAt` — when the evidence was frozen;
 *   - `productTitle`, `originalReceiptNumber`, `originalCustomerName`,
 *     `originalCustomerPhone` — the invoice evidence;
 *   - `warrantyMonths`, `warrantyExpiresAt`, `isWarrantyValid`,
 *     `daysRemaining` — what the banner renders;
 *   - `storeWarranty`, `repairWarranty` — the two statuses `legacyWarrantySnapshot`
 *     reads, so the legacy boolean can never disagree with the dossier.
 *
 * Everything else is dropped: derivable (`repairHistoryCount`, `primaryWarranty`),
 * duplicated (`isSold`, `soldAt`, `isUnknownDevice`), or unbounded (`savTickets`,
 * `identifiers`, `purchasePrice`).
 *
 * It is also the trust boundary for a value that came back from a peer: every
 * field is whitelisted and coerced, and `isWarrantyValid` is `=== true`, so a
 * malformed payload can never render a warranty. Idempotent, so re-projecting a
 * projected snapshot (re-saving an edited ticket) changes nothing.
 *
 * A payload that is not a WELL-FORMED envelope is not evidence at all, so it
 * returns `null` ("nothing was frozen") instead of an empty dossier that merely
 * looks like one:
 *
 *   - the value must be a plain object carrying a plain `dossier` object — an
 *     array, a string or `null` is not a snapshot;
 *   - `idValue` must be a non-empty resolved identifier and `idMode` must say
 *     HOW it was resolved (`imei` or `serial`). `resolveWarrantyDossier` returns
 *     `snapshot: null` for `manual` mode (no identifier) and for any identifier
 *     that is not searchable, so a payload claiming `manual`, or claiming no
 *     identifier at all, cannot have come from the resolver;
 *   - `resolvedAt` must be a parseable instant — the frozen-at proof.
 *
 * This is what stops a hostile or truncated peer payload from asserting a
 * warranty: `{ dossier: { isWarrantyValid: true } }` is exactly the shape that
 * would paint coverage on a device that has none, and it is rejected as
 * structurally impossible rather than projected as "valid".
 */
export function minimalTicketDossierSnapshot(snapshot: unknown): WarrantyDossierSnapshot | null {
  const raw = snapshot as Partial<WarrantyDossierSnapshot> | null | undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = raw.dossier as Partial<ImeiLifecycleDossier> | null | undefined;
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return null;
  const rawIdValue = ticketText(raw.idValue);
  const rawIdMode =
    raw.idMode === 'imei' || raw.idMode === 'serial' ? raw.idMode : null;
  const rawResolvedAt = ticketInstant(raw.resolvedAt);
  if (!rawIdValue || rawIdMode === null || !rawResolvedAt) return null;

  const status = (value: unknown): WarrantyStatus | null => {
    const s = value as WarrantyStatus | null | undefined;
    if (!s || typeof s !== 'object') return null;
    return {
      state: WARRANTY_STATES.has(s.state) ? s.state : 'NEVER_COVERED',
      kind: s.kind === 'REPAIR' ? 'REPAIR' : 'STORE',
      startDate: ticketInstant(s.startDate) ?? null,
      endDate: ticketInstant(s.endDate) ?? null,
      daysLeft: Math.max(0, Math.floor(ticketCount(s.daysLeft) ?? 0)),
      source: WARRANTY_SOURCES.has(s.source) ? s.source : 'none',
      term: Math.max(0, Math.floor(ticketCount(s.term) ?? 0)),
    };
  };

  const dossier: ImeiLifecycleDossier = {
    imei: ticketText(d.imei) ?? '',
    productTitle: ticketText(d.productTitle) ?? '',
    isSold: false,
    isWarrantyValid: d.isWarrantyValid === true,
    repairHistoryCount: 0,
  };

  const months = ticketCount(d.warrantyMonths);
  if (months !== undefined) dossier.warrantyMonths = Math.max(0, Math.floor(months));
  const expiry = ticketInstant(d.warrantyExpiresAt);
  if (expiry) dossier.warrantyExpiresAt = expiry;
  const days = ticketCount(d.daysRemaining);
  if (days !== undefined) dossier.daysRemaining = Math.max(0, Math.floor(days));
  const receipt = ticketText(d.originalReceiptNumber);
  if (receipt) dossier.originalReceiptNumber = receipt;
  const buyer = ticketText(d.originalCustomerName);
  if (buyer) dossier.originalCustomerName = buyer;
  const phone = ticketText(d.originalCustomerPhone);
  if (phone) dossier.originalCustomerPhone = phone;
  // `repairWarranty: null` is meaningful evidence ("no repair warranty on this
  // device"); `storeWarranty` is optional, so it is omitted when absent rather
  // than pinned to null — both re-project to themselves.
  dossier.repairWarranty = status(d.repairWarranty);
  const store = status(d.storeWarranty);
  if (store) dossier.storeWarranty = store;

  const rawTier = raw.suggestedTier;
  const suggestedTier: WarrantyTier =
    rawTier !== undefined && WARRANTY_TIER_ORDER.includes(rawTier) ? rawTier : 'none';

  return {
    idValue: rawIdValue,
    idMode: rawIdMode,
    dossier,
    suggestedTier,
    resolvedAt: rawResolvedAt,
  };
}

/**
 * tradeInOrigin — device ORIGIN (where the phone came from) for the Inspector.
 *
 * Dependency-free (only `deviceIdCodec`) so the scenario suite can import it
 * under plain Node, exactly like `warrantyResolver`.
 *
 * The trade-in form collects the seller's identity document for the police
 * register (Livre de Police), and until now that value was unreachable: it was
 * written to the `trade_in` record and never read again by any screen. This
 * module turns a device identifier into its acquisition record WITHOUT ever
 * inventing one — a device that was not bought in has no origin section at all.
 *
 * Two rules are load-bearing:
 *   - the join runs through `normalizeDeviceKey`, because both `TradeInItem.imei`
 *     and `IMEIRecord.imei` are stored RAW by the intake writers (W-30), so
 *     `35-209900-176148-1` and `352099001761481` must resolve to one device;
 *   - when several acquisitions share an IMEI the MOST RECENT wins and the
 *     others stay in `history`, because intake has no duplicate guard.
 */
import type { TradeInItem } from '../types/pos';
import { normalizeDeviceKey } from './deviceIdCodec';

/** The identity documents this shop accepts (Livre de Police). */
export type NationalIdType = 'CNI' | 'PERMIS' | 'PASSEPORT';

const NATIONAL_ID_TYPES: readonly NationalIdType[] = ['CNI', 'PERMIS', 'PASSEPORT'];

const NATIONAL_ID_TYPE_LABELS: Record<NationalIdType, string> = {
  CNI: 'CNI',
  PERMIS: 'Permis de conduire',
  PASSEPORT: 'Passeport',
};

/**
 * Validate a document type on READ. An illegal value (a peer's payload, an old
 * typo, a hand-edited row) yields `undefined` — never a coerced guess, and
 * never a hard failure that would block the whole record from loading.
 */
export function normalizeNationalIdType(value: unknown): NationalIdType | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toUpperCase();
  return (NATIONAL_ID_TYPES as readonly string[]).includes(v) ? (v as NationalIdType) : undefined;
}

/** "Pièce (type non précisé)" for rows that predate the selector. */
export function nationalIdTypeLabel(value: unknown): string {
  const t = normalizeNationalIdType(value);
  return t ? NATIONAL_ID_TYPE_LABELS[t] : 'Pièce (type non précisé)';
}

export const NATIONAL_ID_TYPE_OPTIONS: ReadonlyArray<{ value: NationalIdType; label: string }> =
  NATIONAL_ID_TYPES.map((value) => ({ value, label: NATIONAL_ID_TYPE_LABELS[value] }));

/**
 * Mask an identity document: the last 4 characters stay legible so an operator
 * can confirm they are looking at the right document, everything before is
 * replaced. A value of 4 characters or fewer is masked entirely — at that
 * length "last 4" IS the whole document, so showing it would show the PII.
 */
export function maskNationalId(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!v) return '';
  if (v.length <= 4) return '•'.repeat(v.length);
  return `${'•'.repeat(v.length - 4)}${v.slice(-4)}`;
}

/** Same rule, for the seller's phone in an audit line. */
export function maskPhone(value: string | null | undefined): string {
  const digits = (value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length <= 4) return '•'.repeat(digits.length);
  return `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/** True when no document number was recorded (the "Pièce manquante" case). */
export function isNationalIdMissing(trade: Partial<TradeInItem> | null | undefined): boolean {
  return !(trade?.nationalIdNumber ?? '').trim();
}

/** Every identifier a device answers to, in any spelling. */
export type OriginIdentifiers = string | readonly string[] | null | undefined;

const keysOf = (identifiers: OriginIdentifiers): string[] => {
  const list = Array.isArray(identifiers)
    ? [...(identifiers as readonly string[])]
    : identifiers
      ? [identifiers as string]
      : [];
  return list.map((v) => normalizeDeviceKey(String(v ?? ''))).filter((k) => k.length > 0);
};

export interface DeviceOriginHistory {
  /** Most recent acquisition, or null when the device was not bought in. */
  latest: TradeInItem | null;
  /** Every acquisition for this device, newest first. */
  history: TradeInItem[];
}

/**
 * Index every acquisition by canonical identifier, newest first per device.
 * The Inspector list needs this for EVERY row on every render, so it is built
 * once per `tradeIns` change instead of re-scanning the array per row (the
 * O(n²) trap the list already fell into once, W-10).
 */
export function originIndexByKey(
  tradeIns: readonly TradeInItem[] | null | undefined
): Map<string, TradeInItem[]> {
  const index = new Map<string, TradeInItem[]>();
  for (const t of tradeIns ?? []) {
    const key = normalizeDeviceKey(String(t?.imei ?? ''));
    if (!key) continue;
    const bucket = index.get(key);
    if (bucket) bucket.push(t);
    else index.set(key, [t]);
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => {
      const at = Date.parse(String(a?.createdAt ?? '')) || 0;
      const bt = Date.parse(String(b?.createdAt ?? '')) || 0;
      if (bt !== at) return bt - at;
      return String(b?.id ?? '').localeCompare(String(a?.id ?? ''));
    });
  }
  return index;
}

/** Join a device to its acquisition record(s) by canonical identifier.
 * Newest first: the trade-in rows carry no `createdAt` guarantee beyond being
 * ISO, so ties fall back to the id to keep the order stable across renders.
 */
export function deviceOriginFor(
  tradeIns: readonly TradeInItem[] | null | undefined,
  identifiers: OriginIdentifiers
): DeviceOriginHistory {
  const keys = new Set(keysOf(identifiers));
  if (!keys.size) return { latest: null, history: [] };

  const history = (tradeIns ?? [])
    .filter((t) => keys.has(normalizeDeviceKey(String(t?.imei ?? ''))))
    .slice()
    .sort((a, b) => {
      const at = Date.parse(String(a?.createdAt ?? '')) || 0;
      const bt = Date.parse(String(b?.createdAt ?? '')) || 0;
      if (bt !== at) return bt - at;
      return String(b?.id ?? '').localeCompare(String(a?.id ?? ''));
    });

  return { latest: history[0] ?? null, history };
}

/** What the "Origine de l'appareil" section renders. No raw document number. */
export interface DeviceOriginView {
  tradeInId: string;
  sellerName: string;
  /** Already masked for display. */
  sellerPhone: string;
  /** Already masked for display. */
  idNumber: string;
  idTypeLabel: string;
  /** No document number on file — the section shows the missing badge. */
  idMissing: boolean;
  /** ISO acquisition date, as stored. */
  acquiredAt: string;
  /** Other acquisitions of the same device, newest first, excluding `latest`. */
  olderCount: number;
}

/**
 * Project an acquisition record into the display view. The document number is
 * MASKED here — the raw value never enters the view model, so a component
 * cannot leak it by accident and the reveal path is the only way to see it.
 */
export function originView(trade: TradeInItem | null | undefined): DeviceOriginView | null {
  if (!trade) return null;
  return {
    tradeInId: String(trade.id ?? ''),
    sellerName: String(trade.customerName ?? '').trim() || 'Client non précisé',
    sellerPhone: maskPhone(trade.customerPhone),
    idNumber: maskNationalId(trade.nationalIdNumber),
    idTypeLabel: nationalIdTypeLabel(trade.nationalIdType),
    idMissing: isNationalIdMissing(trade),
    acquiredAt: String(trade.createdAt ?? ''),
    olderCount: 0,
  };
}

/** The same view with the older-acquisition count attached. */
export function originViewWithHistory(history: DeviceOriginHistory): DeviceOriginView | null {
  const view = originView(history.latest);
  if (!view) return null;
  return { ...view, olderCount: Math.max(0, history.history.length - 1) };
}

/**
 * Only a manager may see the unmasked document. Unknown or empty roles DENY —
 * the same rule the journal launcher uses (`canSeeJournalLauncher`).
 */
export function canRevealSellerId(role: string | null | undefined): boolean {
  return role === 'admin';
}

/**
 * The audit line for a reveal or an edit. Both the old and the new value are
 * MASKED: the audit log is itself a synced, backup-able table, so writing the
 * document number there would defeat the masking entirely.
 */
export function sellerIdAuditDetail(args: {
  action: string;
  deviceKey: string;
  oldValue?: string | null;
  newValue?: string | null;
}): string {
  const parts = [args.action, `Appareil ${args.deviceKey}`];
  if (args.oldValue !== undefined) parts.push(`avant ${maskNationalId(args.oldValue) || '(vide)'}`);
  if (args.newValue !== undefined) parts.push(`après ${maskNationalId(args.newValue) || '(vide)'}`);
  return parts.join(' — ');
}

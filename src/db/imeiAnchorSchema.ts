/**
 * `imei_records` warranty-anchor schema knowledge, shared by BOTH SQLite writers.
 *
 * There is exactly one spelling of "which anchor columns does this database
 * have" in the app, because two divergent spellings is how the sale lane and the
 * pull lane ended up disagreeing about the same table:
 *
 *  - `warranty_expires_at` exists in the BASE schema (migration ≤ 106).
 *  - `warranty_months` exists only from migration 107.
 *
 * A statement that names a missing column throws `no such column: …`. On the
 * SALE path that is not a cosmetic failure: the anchor columns share one INSERT
 * with `sold_at` / `sale_transaction_id`, so naming `warranty_months` on an
 * unmigrated database took the WHOLE registry row down with it — including the
 * base-schema expiry and the sold stamp the re-sale gate reads. On the PULL path
 * it aborted the whole device lane. Both now ask this module first.
 *
 * Keyed by database HANDLE, not a module-level single answer, so two databases in
 * one process (a test double and the real one) cannot inherit each other's
 * answer.
 */
import type Database from '@tauri-apps/plugin-sql';

/**
 * The columns a pre-107 database is guaranteed to have. Used both as the
 * probe-failure fallback and as the lower bound of {@link buildImeiAnchorUpsert}:
 * when the schema cannot be read, assume the base shape and write the columns
 * that have always existed. Losing the term is recoverable (the resolver falls
 * back to the catalog); losing the row is not.
 */
export const IMEI_BASE_ANCHOR_COLUMNS: readonly string[] = [
  'imei',
  'product_id',
  'sale_transaction_id',
  'warranty_expires_at',
  'received_at',
];

const imeiAnchorColumnsByDb = new WeakMap<Database, Promise<Set<string>>>();

/** `imei_records` column names present on THIS database, probed once per handle. */
export function imeiAnchorColumnsPresent(db: Database): Promise<Set<string>> {
  let probed = imeiAnchorColumnsByDb.get(db);
  if (!probed) {
    probed = db
      .select("SELECT name FROM pragma_table_info('imei_records')")
      .then((rows) => {
        const names = new Set((rows as Array<{ name?: string }>).map((r) => String(r?.name ?? '')));
        names.delete('');
        return names;
      })
      .catch(() => new Set(IMEI_BASE_ANCHOR_COLUMNS));
    imeiAnchorColumnsByDb.set(db, probed);
  }
  return probed;
}

/** Test seam: forget a handle's probe so a fake DB can change shape mid-suite. */
export function forgetImeiAnchorColumns(db: Database): void {
  imeiAnchorColumnsByDb.delete(db);
}

export interface ImeiAnchorUpsert {
  /** Column order of the generated INSERT — zip the bind values in this order. */
  columns: string[];
  /** The generated statement, `excluded`-guarded on `version`. */
  sql: string;
}

/**
 * The SALE-lane anchor upsert: INSERT the registry row, and on conflict refresh
 * the sale pointers while letting a frozen anchor stand.
 *
 * Two invariants are baked into the generated SQL rather than left to the caller:
 *
 *  1. The anchor columns are named ONLY when the probed schema has them. This is
 *     what makes the write work unchanged on a database that never applied
 *     migration 107 — no sale-blocking migration dependency.
 *  2. The conflict branch widens nothing: an expiry or term already frozen
 *     locally survives, so re-selling a refunded device cannot be handed a
 *     longer term than the one it was first sold with. `version` is bumped as
 *     `imei_records.version + 1` (not `excluded.version`), which is what the
 *     original statement did and what the pull lane's `excluded.version >=
 *     imei_records.version` guard compares against.
 */
export function buildImeiAnchorUpsert(anchorCols: ReadonlySet<string>): ImeiAnchorUpsert {
  const columns: string[] = ['imei', 'product_id', 'sale_transaction_id', 'sold_at', 'received_at'];
  const sets: string[] = [
    'sale_transaction_id=excluded.sale_transaction_id',
    'sold_at=excluded.sold_at',
    'product_id=excluded.product_id',
  ];
  if (anchorCols.has('warranty_expires_at')) {
    columns.push('warranty_expires_at');
    sets.push(
      'warranty_expires_at=COALESCE(imei_records.warranty_expires_at, excluded.warranty_expires_at)'
    );
  }
  if (anchorCols.has('warranty_months')) {
    columns.push('warranty_months');
    sets.push('warranty_months=COALESCE(imei_records.warranty_months, excluded.warranty_months)');
  }
  columns.push('version');
  sets.push('version=imei_records.version + 1');
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  return {
    columns,
    sql:
      `INSERT INTO imei_records (${columns.join(', ')}) ` +
      `VALUES (${placeholders}) ` +
      `ON CONFLICT(imei) DO UPDATE SET ${sets.join(', ')}`,
  };
}
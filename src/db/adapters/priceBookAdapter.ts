/**
 * UPGRADE-04 — price book adapter (contract pricing).
 *
 * Storage: plain SQLite tables `price_books` + `price_book_items` (migration
 * v119). These are merchant-local configuration (like technicians), NOT trust
 * tables and NOT synced entities — no outbox lane. Reads resolve the single
 * ACTIVE book for a customer; writes back the management UI.
 *
 * Outside Tauri every read degrades to empty/null and every write fails
 * loudly (the WebView preview has no price books — documented residual).
 */
import type { ActivePriceBook } from '../../types/pos';
import { isTauriEnv } from './base';
import { newId } from '../../utils/ids';

export interface PriceBookRecord {
  id: string;
  name: string;
  /** Attached customer, or null for a shared/merchant-wide book. */
  customerId: string | null;
  validFrom: string | null;
  validTo: string | null;
  priority: number;
  status: 'active' | 'inactive';
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PriceBookItemRecord {
  id: string;
  bookId: string;
  productId: string;
  unitPrice: number;
  minQty: number;
}

export interface PriceBookInput {
  id?: string;
  name: string;
  customerId?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  priority?: number;
  status?: 'active' | 'inactive';
  notes?: string | null;
}

export interface PriceBookItemInput {
  id?: string;
  bookId: string;
  productId: string;
  unitPrice: number;
  minQty?: number;
}

async function pluginDb() {
  const { getLocalDb, utcNowIso } = await import('../sqlPluginAdapter');
  const db = await getLocalDb();
  return { db, utcNowIso };
}

interface RawBookRow {
  id: string;
  name: string;
  customer_id: string | null;
  valid_from: string | null;
  valid_to: string | null;
  priority: number | null;
  status: string | null;
  notes: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface RawItemRow {
  id: string;
  book_id: string;
  product_id: string;
  unit_price: number | string | null;
  min_qty: number | string | null;
}

function mapBook(row: RawBookRow): PriceBookRecord {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    customerId: row.customer_id ? String(row.customer_id) : null,
    validFrom: row.valid_from ? String(row.valid_from) : null,
    validTo: row.valid_to ? String(row.valid_to) : null,
    priority: Number(row.priority) || 0,
    status: row.status === 'inactive' ? 'inactive' : 'active',
    notes: row.notes ? String(row.notes) : null,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

function mapItem(row: RawItemRow): PriceBookItemRecord {
  return {
    id: String(row.id),
    bookId: String(row.book_id),
    productId: String(row.product_id),
    unitPrice: Number(row.unit_price) || 0,
    minQty: Math.max(1, Math.round(Number(row.min_qty) || 1)),
  };
}

export function isPriceBookStorageAvailable(): boolean {
  return isTauriEnv();
}

/** All books, newest first — management surface listing. */
export async function listPriceBooks(): Promise<PriceBookRecord[]> {
  if (!isTauriEnv()) return [];
  try {
    const { db } = await pluginDb();
    const rows = (await db.select(
      `SELECT id, name, customer_id, valid_from, valid_to, priority, status, notes, created_at, updated_at
       FROM price_books ORDER BY priority DESC, created_at DESC`
    )) as RawBookRow[];
    return (rows ?? []).map(mapBook);
  } catch (err) {
    console.error('listPriceBooks failed:', err);
    return [];
  }
}

export async function listPriceBookItems(bookId: string): Promise<PriceBookItemRecord[]> {
  if (!isTauriEnv() || !bookId) return [];
  try {
    const { db } = await pluginDb();
    const rows = (await db.select(
      `SELECT id, book_id, product_id, unit_price, min_qty FROM price_book_items
       WHERE book_id = $1 ORDER BY min_qty ASC, product_id ASC`,
      [bookId]
    )) as RawItemRow[];
    return (rows ?? []).map(mapItem);
  } catch (err) {
    console.error(`listPriceBookItems failed [${bookId}]:`, err);
    return [];
  }
}

/**
 * The single ACTIVE book for a customer: explicit customer book first, then a
 * shared book; within each class the highest priority wins. Validity window is
 * inclusive on both ends (date-only strings, UTC date comparison).
 */
export async function getActivePriceBookForCustomer(
  customerId: string | null
): Promise<ActivePriceBook | null> {
  if (!isTauriEnv() || !customerId) return null;
  try {
    const { db } = await pluginDb();
    const rows = (await db.select(
      `SELECT id, name FROM price_books
       WHERE (status IS NULL OR status = 'active')
         AND (customer_id = $1 OR customer_id IS NULL OR customer_id = '')
         AND (valid_from IS NULL OR valid_from = '' OR valid_from <= date('now'))
         AND (valid_to IS NULL OR valid_to = '' OR valid_to >= date('now'))
       ORDER BY CASE WHEN customer_id = $1 THEN 0 ELSE 1 END, priority DESC, created_at DESC
       LIMIT 1`,
      [customerId]
    )) as Array<{ id: string; name: string }>;
    if (!rows || rows.length === 0) return null;
    const book = rows[0];
    const itemRows = (await db.select(
      `SELECT id, book_id, product_id, unit_price, min_qty FROM price_book_items
       WHERE book_id = $1 ORDER BY min_qty ASC`,
      [book.id]
    )) as RawItemRow[];
    return {
      id: String(book.id),
      name: String(book.name ?? ''),
      items: (itemRows ?? []).map((r) => {
        const item = mapItem(r);
        return { productId: item.productId, unitPrice: item.unitPrice, minQty: item.minQty };
      }),
    };
  } catch (err) {
    console.error('getActivePriceBookForCustomer failed:', err);
    return null;
  }
}

/** Upsert one book. Returns the id on success, null on failure. */
export async function savePriceBook(input: PriceBookInput): Promise<string | null> {
  if (!isTauriEnv()) return null;
  try {
    const { db, utcNowIso } = await pluginDb();
    const id = input.id && input.id !== '' ? input.id : newId('pricebook');
    await db.execute(
      `INSERT INTO price_books (id, name, customer_id, valid_from, valid_to, priority, status, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         customer_id = excluded.customer_id,
         valid_from = excluded.valid_from,
         valid_to = excluded.valid_to,
         priority = excluded.priority,
         status = excluded.status,
         notes = excluded.notes,
         updated_at = excluded.updated_at`,
      [
        id,
        input.name,
        input.customerId ?? null,
        input.validFrom ?? null,
        input.validTo ?? null,
        Math.round(input.priority ?? 0),
        input.status === 'inactive' ? 'inactive' : 'active',
        input.notes ?? null,
        utcNowIso(),
      ]
    );
    return id;
  } catch (err) {
    console.error('savePriceBook failed:', err);
    return null;
  }
}

export async function deletePriceBook(id: string): Promise<boolean> {
  if (!isTauriEnv() || !id) return false;
  try {
    const { db } = await pluginDb();
    await db.execute('DELETE FROM price_book_items WHERE book_id = $1', [id]);
    await db.execute('DELETE FROM price_books WHERE id = $1', [id]);
    return true;
  } catch (err) {
    console.error(`deletePriceBook failed [${id}]:`, err);
    return false;
  }
}

/** Upsert one item. Returns the id on success, null on failure. */
export async function savePriceBookItem(input: PriceBookItemInput): Promise<string | null> {
  if (!isTauriEnv()) return null;
  try {
    const { db, utcNowIso } = await pluginDb();
    const id = input.id && input.id !== '' ? input.id : newId('pbitem');
    await db.execute(
      `INSERT INTO price_book_items (id, book_id, product_id, unit_price, min_qty, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT(id) DO UPDATE SET
         product_id = excluded.product_id,
         unit_price = excluded.unit_price,
         min_qty = excluded.min_qty,
         updated_at = excluded.updated_at`,
      [
        id,
        input.bookId,
        input.productId,
        input.unitPrice,
        Math.max(1, Math.round(input.minQty ?? 1)),
        utcNowIso(),
      ]
    );
    return id;
  } catch (err) {
    console.error('savePriceBookItem failed:', err);
    return null;
  }
}

export async function deletePriceBookItem(id: string): Promise<boolean> {
  if (!isTauriEnv() || !id) return false;
  try {
    const { db } = await pluginDb();
    await db.execute('DELETE FROM price_book_items WHERE id = $1', [id]);
    return true;
  } catch (err) {
    console.error(`deletePriceBookItem failed [${id}]:`, err);
    return false;
  }
}

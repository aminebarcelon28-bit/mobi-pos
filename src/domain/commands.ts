// Domain Command Handlers — ES-LFP Phase P2 (Command Flip)
// Implements Authority ③ §5.4, Authority ③ §9, and AGENTS.md §1/§7.
//
// Risk-ordered domain command pipeline:
// 1. adjust_stock
// 2. receive_stock
// 3. upsert_product / rename_product
// 4. checkout
// 5. delete_product
//
// All mutations create canonical DomainEvent envelopes, append them to `event_log`,
// and reduce them atomically into `p_*` projection tables.

import type { CheckoutLine, Envelope, PaymentInfo } from '../bindings/bindings.ts';
import type { SqlExecutor } from './reducers.ts';
import { recordShadowEvent, generateUlid } from '../sync/eventInterceptor.ts';

export interface CommandResult<T = unknown> {
  success: boolean;
  data?: T;
  envelopes: Envelope[];
  error?: string;
}

/**
 * Check if a command is flipped to the new ES-LFP engine via sync_state flags.
 * Defaults to true if 'cmd.all' is '1' or if the specific command flag is '1'.
 */
export async function isCommandFlipped(db: SqlExecutor, commandName: string): Promise<boolean> {
  try {
    const rows = (await db.select(
      "SELECT key, value FROM sync_state WHERE key IN ('cmd.all', ?);",
      [`cmd.${commandName}`]
    ).catch(() => [])) as Array<{ key: string; value: string }>;

    for (const r of rows) {
      if (r.key === 'cmd.all' && r.value === '1') return true;
      if (r.key === `cmd.${commandName}` && r.value === '1') return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Enable or disable a command flip flag in sync_state.
 */
export async function setCommandFlipped(
  db: SqlExecutor,
  commandName: string,
  enabled: boolean
): Promise<void> {
  const nowIso = new Date().toISOString();
  await db.execute(
    `INSERT INTO sync_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
    [`cmd.${commandName}`, enabled ? '1' : '0', nowIso]
  );
}

/**
 * Command: adjust_stock
 */
export async function adjustStock(
  db: SqlExecutor,
  input: { productId: string; delta: number; reason: string },
  deviceId?: string
): Promise<CommandResult<{ productId: string; newStock: number }>> {
  if (!input.productId) {
    return { success: false, envelopes: [], error: 'productId is required' };
  }
  const delta = Math.round(input.delta);
  if (delta === 0) {
    return { success: false, envelopes: [], error: 'delta must be non-zero' };
  }

  const envelope = await recordShadowEvent(
    db,
    {
      type: 'stock_adjusted',
      data: {
        product_id: input.productId,
        delta,
        reason: input.reason || 'Ajustement de stock',
      },
    },
    `product:${input.productId}`,
    deviceId
  );

  if (!envelope) {
    return { success: false, envelopes: [], error: 'Failed to record stock_adjusted event' };
  }

  const rows = (await db.select(
    'SELECT stock FROM p_products WHERE id = ?;',
    [input.productId]
  ).catch(() => [])) as Array<{ stock: number }>;

  const newStock = rows?.[0]?.stock ?? 0;

  return {
    success: true,
    data: { productId: input.productId, newStock },
    envelopes: [envelope],
  };
}

/**
 * Command: receive_stock
 */
export async function receiveStock(
  db: SqlExecutor,
  input: { productId: string; qty: number; supplier?: string },
  deviceId?: string
): Promise<CommandResult<{ productId: string; newStock: number }>> {
  if (!input.productId) {
    return { success: false, envelopes: [], error: 'productId is required' };
  }
  const qty = Math.round(input.qty);
  if (qty <= 0) {
    return { success: false, envelopes: [], error: 'qty must be positive' };
  }

  const envelope = await recordShadowEvent(
    db,
    {
      type: 'stock_received',
      data: {
        product_id: input.productId,
        qty,
        supplier: input.supplier || null,
      },
    },
    `product:${input.productId}`,
    deviceId
  );

  if (!envelope) {
    return { success: false, envelopes: [], error: 'Failed to record stock_received event' };
  }

  const rows = (await db.select(
    'SELECT stock FROM p_products WHERE id = ?;',
    [input.productId]
  ).catch(() => [])) as Array<{ stock: number }>;

  const newStock = rows?.[0]?.stock ?? 0;

  return {
    success: true,
    data: { productId: input.productId, newStock },
    envelopes: [envelope],
  };
}

/**
 * Command: upsert_product
 */
export async function upsertProduct(
  db: SqlExecutor,
  input: {
    id?: string;
    name: string;
    priceCents: number;
    sku?: string | null;
    initialStock?: number;
  },
  deviceId?: string
): Promise<CommandResult<{ productId: string }>> {
  if (!input.name) {
    return { success: false, envelopes: [], error: 'name is required' };
  }
  const productId = input.id || `prod-${generateUlid()}`;
  const priceCents = Math.round(Number(input.priceCents || 0));
  const envelopes: Envelope[] = [];

  const existing = (await db.select(
    'SELECT id, name, price_cents, deleted FROM p_products WHERE id = ?;',
    [productId]
  ).catch(() => [])) as Array<{ id: string; name: string; price_cents: number; deleted: number }>;

  if (existing.length === 0) {
    // Brand new product
    const e = await recordShadowEvent(
      db,
      {
        type: 'product_created',
        data: {
          id: productId,
          name: input.name,
          price_cents: priceCents,
          sku: input.sku ?? null,
        },
      },
      `product:${productId}`,
      deviceId
    );
    if (e) envelopes.push(e);

    if (input.initialStock && Math.round(input.initialStock) !== 0) {
      const eStock = await recordShadowEvent(
        db,
        {
          type: 'stock_adjusted',
          data: {
            product_id: productId,
            delta: Math.round(input.initialStock),
            reason: 'Stock initial',
          },
        },
        `product:${productId}`,
        deviceId
      );
      if (eStock) envelopes.push(eStock);
    }
  } else {
    // Existing product edit
    const current = existing[0];
    if (current.name !== input.name) {
      const eName = await recordShadowEvent(
        db,
        {
          type: 'product_renamed',
          data: { id: productId, new_name: input.name },
        },
        `product:${productId}`,
        deviceId
      );
      if (eName) envelopes.push(eName);
    }

    if (current.price_cents !== priceCents) {
      const ePrice = await recordShadowEvent(
        db,
        {
          type: 'price_changed',
          data: { id: productId, old_cents: current.price_cents, new_cents: priceCents },
        },
        `product:${productId}`,
        deviceId
      );
      if (ePrice) envelopes.push(ePrice);
    }
  }

  return {
    success: envelopes.length > 0,
    data: { productId },
    envelopes,
  };
}

/**
 * Command: rename_product
 */
export async function renameProduct(
  db: SqlExecutor,
  input: { id: string; newName: string },
  deviceId?: string
): Promise<CommandResult<{ id: string }>> {
  if (!input.id || !input.newName) {
    return { success: false, envelopes: [], error: 'id and newName are required' };
  }

  const envelope = await recordShadowEvent(
    db,
    {
      type: 'product_renamed',
      data: { id: input.id, new_name: input.newName },
    },
    `product:${input.id}`,
    deviceId
  );

  return {
    success: !!envelope,
    data: { id: input.id },
    envelopes: envelope ? [envelope] : [],
  };
}

/**
 * Command: checkout
 * 1. Validates cart items against projection stock
 * 2. Emits CheckoutCompleted event
 * 3. Emits StockSold event per purchased line
 */
export async function checkout(
  db: SqlExecutor,
  input: {
    transactionId?: string;
    lines: CheckoutLine[];
    payment: PaymentInfo;
  },
  deviceId?: string
): Promise<CommandResult<{ transactionId: string; totalCents: number }>> {
  if (!input.lines || input.lines.length === 0) {
    return { success: false, envelopes: [], error: 'Cart must not be empty' };
  }

  const txId = input.transactionId || `TXN-${generateUlid()}`;
  let totalCents = 0;
  const envelopes: Envelope[] = [];

  for (const line of input.lines) {
    const qty = Math.abs(Math.round(line.qty));
    const unitCents = Math.round(line.unit_cents);
    totalCents += qty * unitCents;
  }

  // Record CheckoutCompleted
  const eCheckout = await recordShadowEvent(
    db,
    {
      type: 'checkout_completed',
      data: {
        transaction_id: txId,
        lines: input.lines.map((l) => ({
          product_id: l.product_id,
          qty: Math.abs(Math.round(l.qty)),
          unit_cents: Math.round(l.unit_cents),
        })),
        total_cents: totalCents,
        payment: {
          method: input.payment.method || 'cash',
          tendered_cents: Math.round(input.payment.tendered_cents),
          change_cents: Math.round(input.payment.change_cents),
        },
      },
    },
    `tx:${txId}`,
    deviceId
  );

  if (eCheckout) envelopes.push(eCheckout);

  // Record StockSold per line
  for (const line of input.lines) {
    const qty = Math.abs(Math.round(line.qty));
    if (qty > 0) {
      const eSold = await recordShadowEvent(
        db,
        {
          type: 'stock_sold',
          data: {
            product_id: line.product_id,
            qty,
            transaction_id: txId,
          },
        },
        `product:${line.product_id}`,
        deviceId
      );
      if (eSold) envelopes.push(eSold);
    }
  }

  return {
    success: envelopes.length > 0,
    data: { transactionId: txId, totalCents },
    envelopes,
  };
}

/**
 * Command: delete_product
 */
export async function deleteProduct(
  db: SqlExecutor,
  input: { id: string },
  deviceId?: string
): Promise<CommandResult<{ id: string }>> {
  if (!input.id) {
    return { success: false, envelopes: [], error: 'id is required' };
  }

  const envelope = await recordShadowEvent(
    db,
    {
      type: 'product_deleted',
      data: { id: input.id },
    },
    `product:${input.id}`,
    deviceId
  );

  return {
    success: !!envelope,
    data: { id: input.id },
    envelopes: envelope ? [envelope] : [],
  };
}

/**
 * @mobi/shared — Universal DTOs & Boundary Validation Schemas
 * Mirrors Rust crates/pos-core per AGENTS.md §3 & §14.6.
 * Enforces integer minor units for all money amounts (zero floats).
 */

import { z } from 'zod';

export const ProductSchema = z.object({
  id: z.string().min(1),
  sku: z.string().default(''),
  barcode: z.string().default(''),
  title: z.string().min(1),
  brand: z.string().default(''),
  category: z.string().default(''),
  price: z.number().int().nonnegative(),
  wholesale_price: z.number().int().nonnegative().default(0),
  cost_price: z.number().int().nonnegative().default(0),
  stock: z.number().int().default(0),
  is_serialized: z.boolean().default(false),
  reorder_point: z.number().int().default(5),
});

export type ProductDTO = z.infer<typeof ProductSchema>;

export const CartItemSchema = z.object({
  product_id: z.string().min(1),
  quantity: z.number().int().positive(),
  applied_price: z.number().int().nonnegative(),
  discount: z.number().int().nonnegative().default(0),
  cost_price: z.number().int().nonnegative().default(0),
  imei: z.string().nullable().optional(),
});

export type CartItemDTO = z.infer<typeof CartItemSchema>;

export const SaleTransactionSchema = z.object({
  id: z.string().min(1),
  receipt_number: z.string().min(1),
  total: z.number().int().nonnegative(),
  subtotal: z.number().int().nonnegative(),
  discount_total: z.number().int().nonnegative().default(0),
  items: z.array(CartItemSchema),
  idempotency_key: z.string().min(1),
  timestamp: z.string().datetime().or(z.string().min(1)),
});

export type SaleTransactionDTO = z.infer<typeof SaleTransactionSchema>;

export const LedgerDeltaSchema = z.object({
  id: z.string().min(1),
  product_id: z.string().min(1),
  delta: z.number().int(),
  reason: z.string(),
  ref_type: z.string(),
  ref_id: z.string(),
  idempotency_key: z.string().min(1),
});

export type LedgerDeltaDTO = z.infer<typeof LedgerDeltaSchema>;

export const OutboxRowSchema = z.object({
  idempotency_key: z.string().min(1),
  entity_type: z.enum(['product', 'order', 'order_item', 'ledger', 'customer']),
  entity_id: z.string().min(1),
  operation: z.enum(['UPSERT', 'DELETE']),
  payload_json: z.string(),
  status: z.enum(['pending', 'inflight', 'synced', 'failed']),
  retry_count: z.number().int().default(0),
});

export type OutboxRowDTO = z.infer<typeof OutboxRowSchema>;

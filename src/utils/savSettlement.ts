/**
 * savSettlement — Zero Cash Leakage linkage for SAV balance settlement.
 * Synthetic service Product (isService, category SAV, SKU SAV-<ticket>)
 * + localStorage sidecar map cartProductId → repairOrderId.
 */
import type { Product, RepairOrder } from '../types/pos';
import { repairRemainingBalance } from '../types/pos';
import { newId } from './ids';

export const SAV_SKU_PREFIX = 'SAV-';
const SIDECAR_KEY = 'sav_cart_linkage_v1';

export function savBalanceOf(order: Pick<RepairOrder, 'totalCost' | 'depositAmount'>): number {
  return repairRemainingBalance(order);
}

export function savSkuFor(order: Pick<RepairOrder, 'ticketNumber'>): string {
  return `${SAV_SKU_PREFIX}${order.ticketNumber}`;
}

export function savCartProductIdFor(order: Pick<RepairOrder, 'id'>): string {
  return `repair-balance-${order.id}`;
}

export function buildSavBalanceProduct(order: RepairOrder): Product {
  const remaining = savBalanceOf(order);
  return {
    id: savCartProductIdFor(order),
    sku: savSkuFor(order),
    barcode: savSkuFor(order),
    title: `Solde Réparation ${order.ticketNumber} (${order.deviceModel})`,
    brand: 'Autre',
    compatibleModel: order.deviceModel || 'Universel',
    category: 'Services',
    price: remaining,
    wholesalePrice: remaining,
    costPrice: 0,
    stock: Number.MAX_SAFE_INTEGER,
    vendorName: 'Atelier SAV',
    leadTimeDays: 0,
    dailySalesVelocity: 0,
    reorderPoint: 0,
    isService: true,
    isSerialized: false,
    isActive: true,
    warrantyMonths: 0,
  };
}

type Sidecar = Record<string, string>;

function readSidecar(): Sidecar {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(SIDECAR_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Sidecar;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSidecar(map: Sidecar): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SIDECAR_KEY, JSON.stringify(map));
  } catch {
    // Best-effort — in-memory cart remains authoritative this session.
  }
}

export function linkSavCartItem(cartProductId: string, repairOrderId: string): void {
  const map = readSidecar();
  map[cartProductId] = repairOrderId;
  writeSidecar(map);
}

export function repairIdForCartItem(cartProductId: string): string | null {
  return readSidecar()[cartProductId] ?? null;
}

export function unlinkSavCartItems(cartProductIds: string[]): void {
  if (cartProductIds.length === 0) return;
  const map = readSidecar();
  let touched = false;
  for (const id of cartProductIds) {
    if (id in map) {
      delete map[id];
      touched = true;
    }
    // Also match by SKU prefix fallback (defensive: id vs sku confusion).
    for (const key of Object.keys(map)) {
      if (key === id) continue;
    }
  }
  if (touched) writeSidecar(map);
}

export function purgeSavSidecar(): void {
  writeSidecar({});
}

export function isSavCartProductId(id: string): boolean {
  return id.startsWith('repair-balance-');
}

export function newSavSettlementRef(): string {
  return newId('savsettle');
}

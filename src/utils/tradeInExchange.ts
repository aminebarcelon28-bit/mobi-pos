import type { CartItem } from '../types/pos';
import { sanitizeImeiInput } from './savValidation';

/** Exact hard-block copy for the S1 paradox (modal + slice share it). */
export const CART_IMEI_COLLISION_MESSAGE =
  'Impossible d’échanger un appareil présent dans le panier actif';

/**
 * Chaos S1: true when the inbound IMEI is already allocated on a cart line
 * (line-level scanned IMEI or the catalog product's serialized IMEI).
 * Comparison is sanitized + case-insensitive on both sides.
 */
export function isImeiAllocatedInCart(
  cart: Array<Pick<CartItem, 'imeiNumber' | 'product'>> | null | undefined,
  imeiRaw: string
): boolean {
  const norm = sanitizeImeiInput(imeiRaw).toUpperCase();
  if (!norm) return false;
  return (cart || []).some((line) =>
    [line.imeiNumber, line.product?.imeiNumber]
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .some((v) => v.toUpperCase().trim() === norm)
  );
}

import type { StateCreator } from 'zustand';
import type { PosState, CartSlice } from '../types';
import type { CartItem, HeldSale, PricingTier } from '../../types/pos';
import { audioBus } from '../../utils/audioEvents';
import { getProductPriceForTier, computeEffectiveUnitPrice } from '../../utils/pricingEngine';
import { clampStoreCreditAmount } from '../../utils/loyaltyEngine';
import { computeCartTotals } from '../../utils/receiptMath';
import { newId } from '../../utils/ids';

// Holds reserve NO stock: a held sale is a cart snapshot only (customer +
// items + prices). Stock is checked at payment time against the live ledger,
// so two holds on the last unit resolve at the till, not at suspend time.
const HOLD_TTL_MS = 48 * 60 * 60 * 1000; // 48 h default hold lifetime

// A hold id restores exactly once per session: blocks double-restore when a
// stale modal button or a double-tap replays retrieveSale for the same ticket.
const consumedHoldIds = new Set<string>();

function holdExpiryOf(h: HeldSale): number | null {
  const raw = (h as unknown as { expiresAt?: unknown }).expiresAt;
  // Absent expiry (legacy holds predating the TTL) means "no TTL known".
  // A PRESENT-but-malformed value fails CLOSED: 0 (the epoch) is always past,
  // so the hold is treated as EXPIRED and purged instead of living forever.
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return 0;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Durable mirror of the in-memory held-sales list. Another agent owns loading
 * this key at boot; this slice only persists on every hold/retrieve/delete so
 * a killed process never loses suspended tickets. Best-effort: quota or
 * private-mode failures keep the in-memory state authoritative.
 *
 * F5-coverage: holds are explicitly SINGLE-DEVICE (localStorage only, never
 * synced). Resuming a hold on a second till while the first still holds it
 * would double-sell the same cart — cross-device holds need a claim protocol
 * (deterministic claim ids like VOID/REFUND) before they can exist safely.
 */
const HELD_SALES_STORAGE_KEY = 'mobi_held_sales_v1';

function persistHeldSales(held: HeldSale[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(HELD_SALES_STORAGE_KEY, JSON.stringify(held ?? []));
    }
  } catch {
    // Ignore — the Zustand list remains the source of truth for this session.
  }
}

function newHoldExpiryIso(): string {
  return new Date(Date.now() + HOLD_TTL_MS).toISOString();
}

/** Defensive read of the staged voucher credit (another agent may own its type). */
export function readVoucherStaging(s: PosState): { voucherCreditApplied: number; voucherCode: string | null } {
  const r = s as unknown as Record<string, unknown>;
  const amount = Number(r.voucherCreditApplied) || 0;
  const code = typeof r.voucherCode === 'string' ? (r.voucherCode as string) : null;
  return { voucherCreditApplied: Math.max(0, Math.round(amount)), voucherCode: code };
}

/**
 * DEPRECATED (no-TVA product, Gate Addendum A): always returns 0. The
 * `vatRate` receipt setting is ignored — every sale is HT-only. Kept so
 * existing call sites compile until Phase 1b removes the plumbing.
 */
export function readVatRate(_s: PosState): number {
  return 0;
}

function refreshCartItemPricing(item: CartItem, newQty: number, pricingTier?: PricingTier): CartItem {
  // If the price was manually overridden by cashier/manager, keep the override
  const isManualPriceOverride =
    item.defaultPrice !== undefined &&
    item.appliedPrice !== item.defaultPrice &&
    !item.volumeTierApplied;

  if (isManualPriceOverride && item.defaultPrice !== undefined) {
    const discountAmount = Math.max(0, item.defaultPrice - item.appliedPrice);
    return {
      ...item,
      quantity: newQty,
      // B-025: net appliedPrice already encodes the override — do not also
      // write line.discount (that double-subtracted on receiptMath).
      discount: 0,
      discountAmount,
    };
  }

  const effective = computeEffectiveUnitPrice(item.product, newQty, pricingTier);
  if (effective.isVolumeDiscount) {
    return {
      ...item,
      quantity: newQty,
      appliedPrice: effective.basePrice,
      unitPriceCharged: effective.unitPrice,
      defaultPrice: effective.basePrice,
      discountAmount: effective.discountPerUnit,
      discount: effective.discountPerUnit * newQty,
      volumeTierApplied: true,
    };
  } else {
    // If was previously volume discounted, revert back to normal tier price
    const basePrice = effective.basePrice;
    return {
      ...item,
      quantity: newQty,
      appliedPrice: basePrice,
      unitPriceCharged: basePrice,
      defaultPrice: basePrice,
      discountAmount: item.volumeTierApplied ? 0 : item.discountAmount,
      discount: item.volumeTierApplied ? 0 : item.discount,
      volumeTierApplied: false,
    };
  }
}

export const createCartSlice: StateCreator<PosState, [], [], CartSlice> = (set, get) => {
  // `set` cast for staging keys owned at runtime (voucher code/amount):
  // CartSlice's static type is owned by another agent, so runtime-only keys
  // bypass it through this narrow alias instead of widening shared types.
  const setAny = set as unknown as (p: Record<string, unknown>) => void;

  // Runtime-only staging actions (spread into the slice below so the static
  // CartSlice literal stays untouched — no excess-property churn).
  const stagingExtras = {
    voucherCreditApplied: 0,
    voucherCode: null as string | null,
  };
  const stagingActions = {
    redeemVoucherInCart: async (code: string) => {
      const clean = String(code || '').trim().toUpperCase();
      if (!clean) return { success: false, reason: 'Saisissez un code de bon.' };
      try {
        const { voucherAdapter } = await import('../../db/adapters/voucherAdapter');
        const voucher = await voucherAdapter.findCreditVoucherByCode(clean);
        if (!voucher) return { success: false, reason: "Bon d'avoir introuvable." };
        if (voucher.status !== 'ACTIVE' || voucher.remainingAmount <= 0) {
          return { success: false, reason: "Ce bon d'avoir est épuisé ou inactif." };
        }
        if (voucher.expiresAt && new Date(voucher.expiresAt).getTime() < Date.now()) {
          return { success: false, reason: "Ce bon d'avoir a expiré." };
        }
        // STAGE only — capture (balance decrement) happens inside
        // processPayment after the order row is durable, never here.
        const { cart, pricingTier, storeCreditApplied } = get();
        const base = computeCartTotals(cart, {
          pricingTier,
          storeCreditApplied,
          voucherCreditApplied: 0,
          vatRate: readVatRate(get()),
        });
        const capacity = Math.max(
          0,
          base.subtotalAfterDiscount - Math.max(0, Math.round(Number(storeCreditApplied) || 0))
        );
        const amount = Math.max(0, Math.min(Math.round(voucher.remainingAmount), capacity));
        if (amount <= 0) {
          return { success: false, reason: 'Panier net nul — bon inutilisable sur cette vente.' };
        }
        setAny({ voucherCreditApplied: amount, voucherCode: voucher.code });
        return { success: true, amount, remaining: voucher.remainingAmount - amount };
      } catch {
        return { success: false, reason: 'Vérification du bon impossible (base locale indisponible).' };
      }
    },
    clearVoucherCredit: () => {
      setAny({ voucherCreditApplied: 0, voucherCode: null });
    },
  };

  return {
  cart: [],
  storeCreditApplied: 0,
  heldSales: [],
  ...stagingExtras,
  ...stagingActions,

  addToCart: (product, overridePin = false, quantity = 1, isReturn = false) => {
    const { cart, pricingTier, logSecurityAction } = get();

    // Serialized products are locked to 1 per item row
    const addQty = product.isSerialized ? 1 : Math.max(1, isNaN(quantity) ? 1 : Math.floor(quantity));

    const existingIndex = cart.findIndex((item) => item.product.id === product.id && Boolean(item.isReturn) === Boolean(isReturn));
    const currentQtyInCart = existingIndex >= 0 ? cart[existingIndex].quantity : 0;

    // Block zero-stock or exceeding stock unless overridden by PIN, customer return, or intangible service
    const isServiceItem = Boolean(product.isService || product.category === 'Services' || product.id?.startsWith('qt-') || product.id?.startsWith('prod-misc-'));
    if (!isReturn && !isServiceItem && currentQtyInCart + addQty > product.stock && !overridePin) {
      audioBus.emit('error');
      logSecurityAction(
        'Tentative Vente Dépassement Stock',
        `Produit: ${product.title} (Demandé: ${currentQtyInCart + addQty}, Stock: ${product.stock})`,
        'Caissier',
        true
      );
      return { success: false, reason: 'STOCK_EMPTY' };
    }

    if (existingIndex >= 0) {
      if (product.isSerialized) {
        // Serialized product already in cart
        audioBus.emit('scan');
        return { success: true };
      }
      const updated = [...cart];
      const targetItem = updated[existingIndex];
      const newQty = targetItem.quantity + addQty;
      updated[existingIndex] = refreshCartItemPricing(targetItem, newQty, pricingTier);
      set({ cart: updated });
    } else {
      const effective = computeEffectiveUnitPrice(product, addQty, pricingTier);
      set({
        cart: [
          ...cart,
          {
            product,
            quantity: addQty,
            discount: effective.isVolumeDiscount ? effective.discountPerUnit * addQty : 0,
            discountAmount: effective.isVolumeDiscount ? effective.discountPerUnit : 0,
            appliedPrice: effective.basePrice,
            unitPriceCharged: effective.unitPrice,
            defaultPrice: effective.basePrice,
            volumeTierApplied: effective.isVolumeDiscount,
            imeiNumber: product.isSerialized ? (product.imeiNumber || '') : undefined,
            isReturn: Boolean(isReturn),
          },
        ],
      });
    }
    audioBus.emit('scan');
    return { success: true };
  },

  toggleCartItemReturn: (productId) => {
    const { cart } = get();
    const updated = cart.map((item) => {
      if (item.product.id === productId) {
        return { ...item, isReturn: !item.isReturn };
      }
      return item;
    });
    set({ cart: updated });
    audioBus.emit('scan');
  },

  updateCartQty: (productId, delta) => {
    const { cart, pricingTier } = get();
    const updated = cart
      .map((item) => {
        if (item.product.id === productId) {
          if (item.product.isSerialized && delta > 0) {
            return item; // Serialized items represent 1 device per IMEI; add distinct units individually
          }
          const newQty = item.quantity + delta;
          if (newQty <= 0) {
            return null; // Decrement to 0 removes line cleanly
          }
          if (
            !item.isReturn &&
            delta > 0 &&
            typeof item.product.stock === 'number' &&
            item.product.stock > 0 &&
            newQty > item.product.stock
          ) {
            return item; // Do not exceed available physical stock on sales
          }
          return refreshCartItemPricing(item, newQty, pricingTier);
        }
        return item;
      })
      .filter((item): item is CartItem => item !== null);
    set({ cart: updated });
  },

  setCartItemQty: (productId, quantity) => {
    const { cart, pricingTier } = get();
    const safeQty = Math.max(1, isNaN(quantity) ? 1 : Math.floor(quantity));
    const updated = cart.map((item) => {
      if (item.product.id === productId) {
        if (item.product.isSerialized) {
          return item; // Serialized items stay 1
        }
        const clampedQty = item.isReturn ? safeQty : Math.min(item.product.stock, safeQty);
        return refreshCartItemPricing(item, clampedQty, pricingTier);
      }
      return item;
    });
    set({ cart: updated });
  },

  removeFromCart: (productId) => {
    const { cart } = get();
    set({ cart: cart.filter((item) => item.product.id !== productId) });
  },

  clearCart: () => setAny({ cart: [], storeCreditApplied: 0, voucherCreditApplied: 0, voucherCode: null }),

  setCartItemDiscount: (productId, discount, managerApproved = false) => {
    // Any per-item discount needs a manager PIN (same override-PIN pattern as
    // overrideCartItemPrice): silent per-line markdowns are a classic
    // skimming lane, so the slice refuses them without approval.
    const safeDiscount = Math.max(0, isNaN(discount) ? 0 : Math.round(discount));
    if (safeDiscount > 0 && !managerApproved) {
      return { success: false, requiresPin: true, reason: 'Remise article : PIN Manager requis.' };
    }
    const { cart, pricingTier } = get();
    set({
      cart: cart.map((item) => {
        if (item.product.id !== productId) return item;
        const itemPrice =
          item.appliedPrice !== undefined
            ? item.appliedPrice
            : getProductPriceForTier(item.product, pricingTier);
        const lineGrossTotal = itemPrice * Math.abs(item.quantity);
        return { ...item, discount: Math.min(lineGrossTotal, safeDiscount) };
      }),
    });
    return { success: true };
  },

  applyCartDiscountPercent: (percent, managerApproved = false) => {
    const safePercent = Math.max(0, Math.min(100, isNaN(percent) ? 0 : percent));
    // Cart discounts above 10 % need a manager PIN.
    if (safePercent > 10 && !managerApproved) {
      return { success: false, requiresPin: true, reason: 'Remise panier > 10 % : PIN Manager requis.' };
    }
    const { cart, pricingTier } = get();
    set({
      cart: cart.map((item) => {
        const tierPrice = getProductPriceForTier(item.product, pricingTier);
        // Preserve manager-approved appliedPrice overrides: the percent is
        // layered on top of the override price instead of resetting the line
        // to the tier price (which silently wiped approved markdowns).
        const isOverride =
          item.defaultPrice !== undefined &&
          item.appliedPrice !== undefined &&
          item.appliedPrice !== item.defaultPrice &&
          !item.volumeTierApplied;
        const base = isOverride ? item.appliedPrice ?? tierPrice : tierPrice;
        const lineGross = base * Math.abs(item.quantity);
        const extra = Math.round((lineGross * safePercent) / 100);
        if (isOverride) {
          // Cap at line gross: repeated applies accumulate onto override
          // lines, and without this bound re-applying piles discount past
          // the gross into negative-subtotal / cash-out territory. Single
          // applies are unaffected (extra <= gross by construction).
          return { ...item, discount: Math.min(lineGross, (item.discount || 0) + extra) };
        }
        return { ...item, discount: extra, appliedPrice: tierPrice };
      }),
    });
    return { success: true };
  },

  setStoreCreditApplied: (amount) => set({ storeCreditApplied: clampStoreCreditAmount(amount) }),

  setCartItemIMEI: (productId, imei) => {
    const { cart } = get();
    const cleanImei = (imei || '').trim().replace(/[^a-zA-Z0-9-]/g, '').toUpperCase();
    set({
      cart: cart.map((item) => (item.product.id === productId ? { ...item, imeiNumber: cleanImei } : item)),
    });
  },

  overrideCartItemPrice: (productId, newUnitPrice, managerApproved = false) => {
    const { cart, logSecurityAction } = get();
    const item = cart.find((i) => i.product.id === productId);
    if (!item) {
      return { success: false, reason: 'ITEM_NOT_IN_CART' };
    }

    const cleanPrice = Math.max(0, isNaN(newUnitPrice) ? 0 : Math.round(newUnitPrice));
    const defaultPrice = item.defaultPrice ?? item.product.price ?? item.appliedPrice;
    const unitCost = item.unitCostPrice ?? item.product.costPrice ?? 0;

    // A 0 DA price is a full gratuity — never allowed without a manager PIN,
    // even when cost/price metadata is missing (which would otherwise skip
    // both the below-cost and the high-discount gates below).
    if (cleanPrice === 0 && !managerApproved) {
      return {
        success: false,
        requiresPin: true,
        reason: 'Prix à 0 DA (gratuité totale). Validation Manager requise.',
      };
    }

    const isBelowCost = cleanPrice < unitCost;
    const discountPercent = defaultPrice > 0 ? ((defaultPrice - cleanPrice) / defaultPrice) * 100 : 0;
    const isHighDiscount = discountPercent > 20;

    if ((isBelowCost || isHighDiscount) && !managerApproved) {
      return {
        success: false,
        requiresPin: true,
        reason: isBelowCost
          ? `Vente à perte détectée (Prix: ${cleanPrice} DA < Coût: ${unitCost} DA). Validation Manager requise.`
          : `Remise exceptionnelle (${discountPercent.toFixed(0)}%) supérieure à 20%. Validation Manager requise.`,
      };
    }

    const discountAmount = Math.max(0, defaultPrice - cleanPrice);
    const lineProfit = (cleanPrice - unitCost) * item.quantity;

      const updated = cart.map((ci) => {
      if (ci.product.id !== productId) return ci;
      return {
        ...ci,
        appliedPrice: cleanPrice,
        unitPriceCharged: cleanPrice,
        defaultPrice,
        discountAmount,
        // B-025: override is already encoded in appliedPrice (net).
        // Writing discount as well made receiptMath subtract the markdown twice
        // (charged = 2×clean − default). Keep discount 0; discountAmount stays
        // for per-unit REMISE display; cart-% path adds into discount later.
        discount: 0,
        // STRICT FIFO: do not freeze catalog cost onto cart lines.
        // Historical cost is only kept for explicit returns.
        ...(ci.isReturn ? { unitCostAtSale: ci.unitCostAtSale, lineProfit: ci.lineProfit } : {}),
      };
    });

    set({ cart: updated });

    if (managerApproved || isBelowCost || isHighDiscount) {
      void logSecurityAction?.(
        'Dérogation Prix / Remise Manuelle',
        `Article: ${item.product.title} - Défaut: ${defaultPrice} DA -> Appliqué: ${cleanPrice} DA (Remise: ${discountAmount} DA/u, Marge: ${lineProfit} DA)`,
        managerApproved ? 'Manager' : 'Caissier',
        false
      );
    }

    return { success: true };
  },

  holdSale: () => {
    const { cart, currentCustomer, heldSales } = get();
    if (cart.length === 0) {
      audioBus.emit('error');
      return { success: false, reason: 'EMPTY_CART' };
    }
    const newHold = {
       id: newId('hold'),
      customer: currentCustomer,
      items: [...cart],
      timestamp: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
      expiresAt: newHoldExpiryIso(),
    } as HeldSale & { expiresAt: string };
    audioBus.emit('keyBeep');
    const nextHolds = [...heldSales, newHold];
    persistHeldSales(nextHolds);
    setAny({ heldSales: nextHolds, cart: [], storeCreditApplied: 0, voucherCreditApplied: 0, voucherCode: null });
    return { success: true };
  },

  retrieveSale: (saleId) => {
    const { heldSales, cart, currentCustomer, products } = get();
    const now = Date.now();
    // Auto-purge expired holds on every retrieve (default 48 h TTL).
    const liveHolds = heldSales.filter((h) => {
      const exp = holdExpiryOf(h);
      return exp === null || exp > now;
    });
    if (liveHolds.length !== heldSales.length) {
      persistHeldSales(liveHolds);
      set({ heldSales: liveHolds });
    }
    // Double-restore guard: each hold id restores at most once per session.
    if (consumedHoldIds.has(saleId)) {
      audioBus.emit('error');
      return { success: false, reason: 'ALREADY_RESTORED' };
    }
    const target = liveHolds.find((h) => h.id === saleId);
    if (!target) {
      audioBus.emit('error');
      const wasExpired = heldSales.some((h) => h.id === saleId);
      return { success: false, reason: wasExpired ? 'HOLD_EXPIRED' : 'HOLD_NOT_FOUND' };
    }
    consumedHoldIds.add(saleId);
    let updatedHeldSales = liveHolds.filter((h) => h.id !== saleId);
      if (cart.length > 0) {
        updatedHeldSales.push({
           id: newId('hold'),
          customer: currentCustomer,
          items: [...cart],
          timestamp: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
          expiresAt: newHoldExpiryIso(),
        } as HeldSale & { expiresAt: string });
      }
      persistHeldSales(updatedHeldSales);
      const activeTier = target.customer ? target.customer.pricingTier : 'Retail';
      // Revalidate hold prices against the CURRENT tier price: the hold price
      // is kept (merchant promise) but any catalog move is surfaced so the
      // cashier sees it instead of silently selling at a stale price.
      const warnings: string[] = [];
      const refreshedItems = target.items.map((cartItem) => {
        const currentProd = products.find((p) => p.id === cartItem.product.id);
        // Deleted products must NOT resuscitate as stale snapshots: the
        // payment gates deliberately allow stub rows (offline peer sales),
        // so a resumed hold would sell a catalog-deleted item at a frozen
        // price with phantom revenue. Drop the line loudly instead — the
        // cashier re-adds it deliberately if the deletion was a mistake
        // (mirror lag is the only false-drop vector, and re-adding is cheap).
        if (!currentProd) {
          warnings.push(
            `Article retiré du ticket : ${cartItem.product?.title || cartItem.product?.id} (retiré du catalogue entre-temps).`
          );
          return null;
        }
        const merged = { ...cartItem, product: currentProd };
        const currentTierPrice = getProductPriceForTier(currentProd, activeTier);
        const holdPrice = cartItem.appliedPrice ?? getProductPriceForTier(cartItem.product, activeTier);
        if (!cartItem.volumeTierApplied && holdPrice !== currentTierPrice) {
          warnings.push(
            `Prix catalogue modifié pour ${currentProd.title} : tenu à ${holdPrice} DA (actuel ${currentTierPrice} DA).`
          );
        }
        return merged;
      }).filter((i): i is NonNullable<typeof i> => i !== null);
      // Every line was catalog-deleted: refuse the resume instead of
      // presenting an empty ticket (the hold stays listed for inspection).
      if (refreshedItems.length === 0 && target.items.length > 0) {
        consumedHoldIds.delete(saleId);
        audioBus.emit('error');
        return { success: false, reason: 'HOLD_ALL_LINES_REMOVED', warnings };
      }
      set({
        cart: refreshedItems,
        currentCustomer: target.customer,
        pricingTier: activeTier,
        heldSales: updatedHeldSales,
        activeModal: null,
      });
      return { success: true, warnings };
  },

  deleteHeldSale: (saleId) => {
    const { heldSales } = get();
    const next = heldSales.filter((h) => h.id !== saleId);
    persistHeldSales(next);
    set({ heldSales: next });
  },
  };
};

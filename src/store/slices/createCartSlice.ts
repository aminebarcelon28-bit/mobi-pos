import type { StateCreator } from 'zustand';
import type { PosState, CartSlice } from '../types';
import { refundDiag } from '../../utils/refundDiag';
import type { CartItem, HeldSale, PricingTier, ActivePriceBook, ActivePriceBookItem } from '../../types/pos';
import { audioBus } from '../../utils/audioEvents';
import { computeEffectiveUnitPrice, resolveBaseUnitPrice } from '../../utils/pricingEngine';
import { clampStoreCreditAmount } from '../../utils/loyaltyEngine';
import { computeCartTotals } from '../../utils/receiptMath';
import { newId } from '../../utils/ids';
import { canonicalDeviceId } from '../../utils/warrantyResolver';

// Holds reserve NO stock: a held sale is a cart snapshot only (customer +
// items + prices). Stock is checked at payment time against the live ledger,
// so two holds on the last unit resolve at the till, not at suspend time.
const HOLD_TTL_MS = 48 * 60 * 60 * 1000; // 48 h default hold lifetime

// A hold id restores exactly once per session: blocks double-restore when a
// stale modal button or a double-tap replays retrieveSale for the same ticket.
// UPGRADE-12: the durable single-claim (`claimHeldOrder`) is the primary
// arbiter across windows; this Set remains the in-session/web-mode guard.
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

function refreshCartItemPricing(
  item: CartItem,
  newQty: number,
  pricingTier?: PricingTier,
  priceBookItems?: readonly ActivePriceBookItem[] | null
): CartItem {
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

  const effective = computeEffectiveUnitPrice(item.product, newQty, pricingTier, undefined, priceBookItems);
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
    const { cart, pricingTier, logSecurityAction, customerPriceBook } = get();

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
      updated[existingIndex] = refreshCartItemPricing(
        targetItem,
        newQty,
        pricingTier,
        customerPriceBook?.items ?? null
      );
      set({ cart: updated });
    } else {
      const effective = computeEffectiveUnitPrice(
        product,
        addQty,
        pricingTier,
        undefined,
        customerPriceBook?.items ?? null
      );
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

  toggleCartItemReturn: (productId, managerApproved = false) => {
    const { cart, logSecurityAction, activeShift } = get();
    const target = cart.find((item) => item.product.id === productId);
    if (!target) return { success: false, reason: 'ITEM_NOT_FOUND' };

    // Anti-theft gate: switching an item to return mode (cashout / credit liability)
    // strictly requires an active shift and manager PIN authorization.
    if (!target.isReturn) {
      if (!activeShift) {
        return { success: false, reason: 'SHIFT_NOT_ACTIVE' };
      }
      if (!managerApproved) {
        return { success: false, reason: 'MANAGER_PIN_REQUIRED' };
      }
    }

    const updated = cart.map((item) => {
      if (item.product.id === productId) {
        return { ...item, isReturn: !item.isReturn };
      }
      return item;
    });
    set({ cart: updated });
    logSecurityAction(
      target.isReturn ? 'Annulation Retour Panier' : 'Autorisation Retour Panier (isReturn)',
      `Article: ${target.product.title} • Qty: ${target.quantity}`,
      'Manager',
      false
    );
    audioBus.emit('scan');
    return { success: true };
  },

  updateCartQty: (productId, delta) => {
    const { cart, pricingTier, customerPriceBook } = get();
    const targetItem = cart.find((item) => item.product.id === productId);
    const bundleGroupId = targetItem?.bundleGroupId;

    let updated = cart
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
          const refreshed = refreshCartItemPricing(item, newQty, pricingTier, customerPriceBook?.items ?? null);
          // Modifying a bundle item's quantity breaks the preset ratio
          if (bundleGroupId) {
            return { ...refreshed, bundleGroupId: undefined, discount: 0 };
          }
          return refreshed;
        }
        return item;
      })
      .filter((item): item is CartItem => item !== null);

    // If a bundle was broken by quantity adjustment, clear bundle discount on remaining members
    if (bundleGroupId) {
      updated = updated.map((item) => {
        if (item.bundleGroupId === bundleGroupId) {
          return { ...item, bundleGroupId: undefined, discount: 0 };
        }
        return item;
      });
    }

    set({ cart: updated });
  },

  setCartItemQty: (productId, quantity) => {
    const { cart, pricingTier, customerPriceBook } = get();
    const targetItem = cart.find((item) => item.product.id === productId);
    const bundleGroupId = targetItem?.bundleGroupId;
    const safeQty = Math.max(1, isNaN(quantity) ? 1 : Math.floor(quantity));

    let updated = cart.map((item) => {
      if (item.product.id === productId) {
        if (item.product.isSerialized) {
          return item; // Serialized items stay 1
        }
        const clampedQty = item.isReturn ? safeQty : Math.min(item.product.stock, safeQty);
        const refreshed = refreshCartItemPricing(item, clampedQty, pricingTier, customerPriceBook?.items ?? null);
        if (bundleGroupId) {
          return { ...refreshed, bundleGroupId: undefined, discount: 0 };
        }
        return refreshed;
      }
      return item;
    });

    if (bundleGroupId) {
      updated = updated.map((item) => {
        if (item.bundleGroupId === bundleGroupId) {
          return { ...item, bundleGroupId: undefined, discount: 0 };
        }
        return item;
      });
    }

    set({ cart: updated });
  },

  removeFromCart: (productId) => {
    const { cart } = get();
    const removedItem = cart.find((item) => item.product.id === productId);
    const bundleGroupId = removedItem?.bundleGroupId;

    let updated = cart.filter((item) => item.product.id !== productId);
    if (bundleGroupId) {
      // Removing one member revokes the bundle discount on the remaining items of that bundle
      updated = updated.map((item) => {
        if (item.bundleGroupId === bundleGroupId) {
          return {
            ...item,
            discount: 0,
            bundleGroupId: undefined,
          };
        }
        return item;
      });
    }

    set({ cart: updated });
    // Cart discard safety: dropping a SAV line purges its linkage —
    // the repair stays 'Prêt / Terminé', never auto-delivers.
    if (productId.startsWith('repair-balance-')) {
      void import('../../utils/savSettlement').then(({ unlinkSavCartItems }) =>
        unlinkSavCartItems([productId])
      );
    }
  },

  clearCart: () => {
    const { cart } = get();
    const savIds = (cart || [])
      .map((ci) => ci.product.id)
      .filter((id) => id.startsWith('repair-balance-'));
    setAny({ cart: [], storeCreditApplied: 0, voucherCreditApplied: 0, voucherCode: null });
    if (savIds.length > 0) {
      void import('../../utils/savSettlement').then(({ unlinkSavCartItems }) =>
        unlinkSavCartItems(savIds)
      );
    }
  },

  setCartItemDiscount: (productId, discount, managerApproved = false) => {
    // Any per-item discount needs a manager PIN (same override-PIN pattern as
    // overrideCartItemPrice): silent per-line markdowns are a classic
    // skimming lane, so the slice refuses them without approval.
    const safeDiscount = Math.max(0, isNaN(discount) ? 0 : Math.round(discount));
    if (safeDiscount > 0 && !managerApproved) {
      return { success: false, requiresPin: true, reason: 'Remise article : PIN Manager requis.' };
    }
    const { cart, pricingTier, customerPriceBook, logSecurityAction } = get();
    const itemBefore = cart.find((item) => item.product.id === productId);
    const beforePrice = itemBefore
      ? itemBefore.appliedPrice !== undefined
        ? itemBefore.appliedPrice
        : resolveBaseUnitPrice(itemBefore.product, pricingTier, itemBefore.quantity, customerPriceBook?.items ?? null)
      : 0;
    const lineGross = beforePrice * Math.abs(itemBefore?.quantity ?? 0);
    const effectiveDiscount = Math.min(lineGross, safeDiscount);
    set({
      cart: cart.map((item) => {
        if (item.product.id !== productId) return item;
        const itemPrice =
          item.appliedPrice !== undefined
            ? item.appliedPrice
            : resolveBaseUnitPrice(item.product, pricingTier, item.quantity, customerPriceBook?.items ?? null);
        const lineGrossTotal = itemPrice * Math.abs(item.quantity);
        return { ...item, discount: Math.min(lineGrossTotal, safeDiscount) };
      }),
    });
    if (effectiveDiscount > 0) {
      // UPGRADE-09: every APPLIED discount lands in the accountability ledger
      // (the funnel binds the immutable actor id). Silent markdowns are a
      // classic skimming lane — the exception analytics needs the signal.
      logSecurityAction(
        'Remise Article Appliquée',
        `Article: ${itemBefore?.product.title ?? productId} — remise ${effectiveDiscount} DA sur ligne de ${lineGross} DA${managerApproved ? ' (Approuvé par PIN Manager)' : ''}`,
        undefined,
        managerApproved
      );
    }
    return { success: true };
  },

  applyCartDiscountPercent: (percent, managerApproved = false) => {
    // A percent is a BOUNDED input, never a clamped one: clamping a typo
    // ("33333" from "33.333") silently applied a 100 % discount and gave the
    // cart away ([MNY-18]). Out-of-range changes nothing and says why.
    const safePercent = Number(percent);
    if (!Number.isFinite(safePercent) || safePercent < 0 || safePercent > 100) {
      return {
        success: false,
        reason: `Remise invalide : ${String(percent)} % (0-100 attendu).`,
      };
    }
    // Cart discounts above 10 % need a manager PIN.
    if (safePercent > 10 && !managerApproved) {
      return { success: false, requiresPin: true, reason: 'Remise panier > 10 % : PIN Manager requis.' };
    }
    const { cart, pricingTier, customerPriceBook, logSecurityAction } = get();
    const lineCountBefore = cart.length;
    set({
      cart: cart.map((item) => {
        // UPGRADE-04: the line base is the contract price when a price book
        // applies, else the tier price. Never resets a contract line to the
        // tier price (that would silently renegotiate the customer's deal).
        const tierPrice = resolveBaseUnitPrice(
          item.product,
          pricingTier,
          item.quantity,
          customerPriceBook?.items ?? null
        );
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
    if (safePercent > 0 && lineCountBefore > 0) {
      // UPGRADE-09: see setCartItemDiscount — one row per APPLIED discount.
      logSecurityAction(
        'Remise Panier Appliquée',
        `Remise globale ${safePercent} % appliquée sur ${lineCountBefore} ligne(s)${managerApproved ? ' (Approuvé par PIN Manager)' : ''}`,
        undefined,
        managerApproved
      );
    }
    return { success: true };
  },

  setStoreCreditApplied: (amount) => set({ storeCreditApplied: clampStoreCreditAmount(amount) }),

  setCartItemIMEI: (productId, imei) => {
    const { cart } = get();
    // Canonicalize at INGESTION so the stored form matches what the warranty
    // resolver queries with. Previously this kept hyphens, while
    // `sanitizeDeviceIdentifier` stripped to digits before lookup — the two
    // halves of the lifecycle disagreed and every hyphenated IMEI (the standard
    // GSMA label, i.e. most scanned phones) resolved as "non enregistré".
    //
    // Normalization only, never validation: `canonicalDeviceId` makes no length
    // or Luhn claim, so alphanumeric serials for dead devices survive. IMEI
    // length + Luhn stay enforced at the lookup gate
    // (`sanitizeDeviceIdentifier`), which is where a wrong device must be
    // refused rather than silently accepted at the till.
    const cleanImei = canonicalDeviceId(imei);
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
    const stagedTradeIn = (get() as unknown as { stagedTradeIn?: unknown }).stagedTradeIn ?? null;
    const { voucherCode, voucherCreditApplied } = readVoucherStaging(get());
    const newHold = {
      id: newId('hold'),
      customer: currentCustomer,
      items: [...cart],
      timestamp: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
      expiresAt: newHoldExpiryIso(),
      stagedTradeIn,
      voucherCode,
      voucherCreditApplied,
    } as HeldSale & { expiresAt: string };
    audioBus.emit('keyBeep');
    const nextHolds = [...heldSales, newHold];
    persistHeldSales(nextHolds);
    void import('../../db/sqlPluginAdapter').then(({ saveHeldOrder }) => saveHeldOrder(newHold));
    setAny({
      heldSales: nextHolds,
      cart: [],
      currentCustomer: null,
      customerPriceBook: null,
      storeCreditApplied: 0,
      voucherCreditApplied: 0,
      voucherCode: null,
      stagedTradeIn: null,
    });
    return { success: true };
  },

  retrieveSale: async (saleId) => {
    const { heldSales, cart, currentCustomer, products } = get();
    const now = Date.now();
    // Auto-purge expired holds on every retrieve (default 48 h TTL).
    const liveHolds = heldSales.filter((h) => {
      const exp = holdExpiryOf(h);
      return exp === null || exp > now;
    });
    if (liveHolds.length !== heldSales.length) {
      persistHeldSales(liveHolds);
      const purged = heldSales.filter((h) => !liveHolds.some((lh) => lh.id === h.id));
      void import('../../db/sqlPluginAdapter').then(({ deleteHeldOrder }) => {
        for (const p of purged) deleteHeldOrder(p.id);
      });
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
    // UPGRADE-12 — atomic single-claim BEFORE the cart loads: exactly one
    // caller flips a live row (`deleted 0 → 1`). A concurrent recall (second
    // window on the same store, double click, stale button) is refused with
    // HOLD_ALREADY_CLAIMED instead of double-loading the same cart; a claim
    // that cannot run fails closed as HOLD_CLAIM_FAILED.
    const claim = await import('../../db/sqlPluginAdapter').then(({ claimHeldOrder }) =>
      claimHeldOrder(saleId)
    );
    if (claim !== 'claimed') {
      audioBus.emit('error');
      return {
        success: false,
        reason: claim === 'already_claimed' ? 'HOLD_ALREADY_CLAIMED' : 'HOLD_CLAIM_FAILED',
      };
    }
    consumedHoldIds.add(saleId);
    let updatedHeldSales = liveHolds.filter((h) => h.id !== saleId);
      if (cart.length > 0) {
        const currentStagedTradeIn = (get() as unknown as { stagedTradeIn?: unknown }).stagedTradeIn ?? null;
        const currentVoucher = readVoucherStaging(get());
        const replacementHold = {
          id: newId('hold'),
          customer: currentCustomer,
          items: [...cart],
          timestamp: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
          expiresAt: newHoldExpiryIso(),
          stagedTradeIn: currentStagedTradeIn,
          voucherCode: currentVoucher.voucherCode,
          voucherCreditApplied: currentVoucher.voucherCreditApplied,
        } as HeldSale & { expiresAt: string };
        updatedHeldSales.push(replacementHold);
        void import('../../db/sqlPluginAdapter').then(({ saveHeldOrder }) => saveHeldOrder(replacementHold));
      }
      persistHeldSales(updatedHeldSales);
      const activeTier = target.customer ? target.customer.pricingTier : 'Retail';
      // UPGRADE-04: resolve the held customer's contract price book BEFORE
      // revalidation so the warning compares against the price that will
      // actually apply (contract first, tier fallback) — a contract customer
      // must not see a false "prix catalogue modifié" on every line.
      let resumeBook: ActivePriceBook | null = null;
      if (target.customer?.id) {
        try {
          const { getActivePriceBookForCustomer } = await import('../../db/adapters/priceBookAdapter');
          resumeBook = await getActivePriceBookForCustomer(target.customer.id);
        } catch {
          resumeBook = null;
        }
      }
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
        const currentTierPrice = resolveBaseUnitPrice(
          currentProd,
          activeTier,
          cartItem.quantity,
          resumeBook?.items ?? null
        );
        const holdPrice =
          cartItem.appliedPrice ??
          resolveBaseUnitPrice(cartItem.product, activeTier, cartItem.quantity, resumeBook?.items ?? null);
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
        // The hold was CLAIMED but no cart ever loaded: release it so it
        // stays recallable. Before UPGRADE-12 the row was consumed even when
        // the restore was refused, silently losing the ticket.
        await import('../../db/sqlPluginAdapter').then(({ releaseHeldOrderClaim }) =>
          releaseHeldOrderClaim(saleId)
        );
        consumedHoldIds.delete(saleId);
        audioBus.emit('error');
        return { success: false, reason: 'HOLD_ALL_LINES_REMOVED', warnings };
      }
      refundDiag('store:close', { site: 'createCartSlice.resumeHold' });
      setAny({
        cart: refreshedItems,
        currentCustomer: target.customer,
        customerPriceBook: resumeBook,
        pricingTier: activeTier,
        heldSales: updatedHeldSales,
        activeModal: null,
        stagedTradeIn: target.stagedTradeIn ?? null,
        voucherCode: target.voucherCode ?? null,
        voucherCreditApplied: target.voucherCreditApplied || 0,
      });
      return { success: true, warnings };
  },

  deleteHeldSale: (saleId) => {
    const { heldSales } = get();
    const target = heldSales.find((h) => h.id === saleId);
    const next = heldSales.filter((h) => h.id !== saleId);
    persistHeldSales(next);
    void import('../../db/sqlPluginAdapter').then(({ deleteHeldOrder }) => deleteHeldOrder(saleId));
    set({ heldSales: next });
    // Discarding a held cart with SAV lines purges linkage (stays Prêt).
    const savIds = ((target?.items || []) as Array<{ product?: { id?: string } }>)
      .map((ci) => ci.product?.id || '')
      .filter((id) => id.startsWith('repair-balance-'));
    if (savIds.length > 0) {
      void import('../../utils/savSettlement').then(({ unlinkSavCartItems }) =>
        unlinkSavCartItems(savIds)
      );
    }
  },

  clearVoucherCredit: () => {
    setAny({
      voucherCreditApplied: 0,
      voucherCode: null,
    });
  },

  redeemVoucherInCart: async (code: string) => {
    const cleanCode = (code || '').trim().toUpperCase();
    if (!cleanCode) return { success: false, reason: "Code bon d'avoir manquant" };
    try {
      const { voucherAdapter } = await import('../../db/adapters/voucherAdapter');
      const voucher = await voucherAdapter.findCreditVoucherByCode(cleanCode);
      if (!voucher) {
        return { success: false, reason: "Bon d'avoir introuvable" };
      }
      if (voucher.status !== 'ACTIVE' || voucher.remainingAmount <= 0) {
        return { success: false, reason: "Ce bon d'avoir est déjà épuisé ou inactif" };
      }
      if (voucher.expiresAt && new Date(voucher.expiresAt).getTime() < Date.now()) {
        return { success: false, reason: "Ce bon d'avoir a expiré" };
      }
      const { cart, pricingTier, storeCreditApplied } = get();
      const totals = computeCartTotals(cart, {
        pricingTier,
        storeCreditApplied,
        voucherCreditApplied: 0,
      });
      const maxApplicable = Math.max(0, totals.total);
      if (maxApplicable <= 0) {
        return { success: false, reason: "Le panier n'a pas de solde à payer" };
      }
      const applied = Math.min(voucher.remainingAmount, maxApplicable);
      setAny({
        voucherCode: voucher.code,
        voucherCreditApplied: applied,
      });
      return { success: true, amount: applied };
    } catch (e) {
      console.error('[voucher] Error redeeming voucher in cart:', e);
      return { success: false, reason: "Erreur lors de la validation du bon d'avoir" };
    }
  },
  };
};

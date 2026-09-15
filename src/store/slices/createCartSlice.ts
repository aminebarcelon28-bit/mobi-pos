import type { StateCreator } from 'zustand';
import type { PosState, CartSlice } from '../types';
import type { CartItem, HeldSale } from '../../types/pos';
import { audioBus } from '../../utils/audioEvents';
import { getProductPriceForTier } from '../../utils/pricingEngine';

export const createCartSlice: StateCreator<PosState, [], [], CartSlice> = (set, get) => ({
  cart: [],
  storeCreditApplied: 0,
  heldSales: [],

  addToCart: (product, overridePin = false, quantity = 1) => {
    const { cart, pricingTier, logSecurityAction } = get();

    // Serialized products are locked to 1 per item row
    const addQty = product.isSerialized ? 1 : Math.max(1, isNaN(quantity) ? 1 : Math.floor(quantity));

    const existingIndex = cart.findIndex((item) => item.product.id === product.id);
    const currentQtyInCart = existingIndex >= 0 ? cart[existingIndex].quantity : 0;

    // Block zero-stock or exceeding stock unless overridden by PIN
    if (currentQtyInCart + addQty > product.stock && !overridePin) {
      audioBus.emit('error');
      logSecurityAction(
        'Tentative Vente Dépassement Stock',
        `Produit: ${product.title} (Demandé: ${currentQtyInCart + addQty}, Stock: ${product.stock})`,
        'Caissier',
        true
      );
      return { success: false, reason: 'STOCK_EMPTY' };
    }

    const activePrice = getProductPriceForTier(product, pricingTier);

    if (existingIndex >= 0) {
      if (product.isSerialized) {
        // Serialized product already in cart
        audioBus.emit('scan');
        return { success: true };
      }
      const updated = [...cart];
      updated[existingIndex] = { ...updated[existingIndex], quantity: updated[existingIndex].quantity + addQty };
      set({ cart: updated });
    } else {
      set({
        cart: [
          ...cart,
          {
            product,
            quantity: addQty,
            discount: 0,
            appliedPrice: activePrice,
            imeiNumber: product.isSerialized ? '' : undefined,
          },
        ],
      });
    }
    audioBus.emit('scan');
    return { success: true };
  },

  updateCartQty: (productId, delta) => {
    const { cart } = get();
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
            delta > 0 &&
            typeof item.product.stock === 'number' &&
            item.product.stock > 0 &&
            newQty > item.product.stock
          ) {
            return item; // Do not exceed available physical stock
          }
          return { ...item, quantity: newQty };
        }
        return item;
      })
      .filter((item): item is CartItem => item !== null);
    set({ cart: updated });
  },

  setCartItemQty: (productId, quantity) => {
    const { cart } = get();
    const safeQty = Math.max(1, isNaN(quantity) ? 1 : Math.floor(quantity));
    const updated = cart.map((item) => {
      if (item.product.id === productId) {
        if (item.product.isSerialized) {
          return item; // Serialized items stay 1
        }
        const clampedQty = Math.min(item.product.stock, safeQty);
        return { ...item, quantity: clampedQty };
      }
      return item;
    });
    set({ cart: updated });
  },

  removeFromCart: (productId) => {
    const { cart } = get();
    set({ cart: cart.filter((item) => item.product.id !== productId) });
  },

  clearCart: () => set({ cart: [], storeCreditApplied: 0 }),

  setCartItemDiscount: (productId, discount) => {
    const { cart, pricingTier } = get();
    const safeDiscount = Math.max(0, isNaN(discount) ? 0 : discount);
    set({
      cart: cart.map((item) => {
        if (item.product.id !== productId) return item;
        const itemPrice =
          item.appliedPrice !== undefined
            ? item.appliedPrice
            : getProductPriceForTier(item.product, pricingTier);
        const lineGrossTotal = itemPrice * item.quantity;
        return { ...item, discount: Math.min(lineGrossTotal, safeDiscount) };
      }),
    });
  },

  applyCartDiscountPercent: (percent) => {
    const { cart, pricingTier } = get();
    const safePercent = Math.max(0, Math.min(100, isNaN(percent) ? 0 : percent));
    set({
      cart: cart.map((item) => {
        const itemPrice = getProductPriceForTier(item.product, pricingTier);
        const itemTotal = itemPrice * item.quantity;
        const discountAmount = Math.round((itemTotal * safePercent) / 100);
        return { ...item, discount: discountAmount, appliedPrice: itemPrice };
      }),
    });
  },

  setStoreCreditApplied: (amount) => set({ storeCreditApplied: amount }),

  setCartItemIMEI: (productId, imei) => {
    const { cart } = get();
    const cleanImei = (imei || '').trim().replace(/[^a-zA-Z0-9-]/g, '').toUpperCase();
    set({
      cart: cart.map((item) => (item.product.id === productId ? { ...item, imeiNumber: cleanImei } : item)),
    });
  },

  holdSale: () => {
    const { cart, currentCustomer, heldSales } = get();
    if (cart.length === 0) {
      audioBus.emit('error');
      return { success: false, reason: 'EMPTY_CART' };
    }
    const newHold: HeldSale = {
      id: `hold-${Date.now()}`,
      customer: currentCustomer,
      items: [...cart],
      timestamp: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    };
    audioBus.emit('keyBeep');
    set({ heldSales: [...heldSales, newHold], cart: [], storeCreditApplied: 0 });
    return { success: true };
  },

  retrieveSale: (saleId) => {
    const { heldSales, cart, currentCustomer, products } = get();
    const target = heldSales.find((h) => h.id === saleId);
    if (target) {
      let updatedHeldSales = heldSales.filter((h) => h.id !== saleId);
      if (cart.length > 0) {
        updatedHeldSales.push({
          id: `hold-${Date.now()}`,
          customer: currentCustomer,
          items: [...cart],
          timestamp: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
        });
      }
      const refreshedItems = target.items.map((cartItem) => {
        const currentProd = products.find((p) => p.id === cartItem.product.id);
        return currentProd ? { ...cartItem, product: currentProd } : cartItem;
      });
      const activeTier = target.customer ? target.customer.pricingTier : 'Retail';
      set({
        cart: refreshedItems,
        currentCustomer: target.customer,
        pricingTier: activeTier,
        heldSales: updatedHeldSales,
        activeModal: null,
      });
    }
  },

  deleteHeldSale: (saleId) => {
    const { heldSales } = get();
    set({ heldSales: heldSales.filter((h) => h.id !== saleId) });
  },
});

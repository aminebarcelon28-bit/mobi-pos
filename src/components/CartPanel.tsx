import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Trash2, Plus, Minus, Tag, Banknote, Percent, ChevronDown, ChevronUp, Sparkles, Gift, Star, User, UserCheck, X, ShoppingBag, AlertTriangle, ArrowLeftRight, RotateCcw, Layers, RefreshCw, Pencil, Barcode, ShieldAlert } from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import { formatDZD } from '../types/pos';
import type { PricingTier } from '../types/pos';
import { useToast } from './ui/Toast';
import { canRedeemPoints, normalizeLoyaltyConfig, isEarnAllowed, isRedeemAllowed, calculateMaxAllowedCredit } from '../utils/loyaltyEngine';
import { soundEngine } from '../utils/audioFeedback';
import { getProductPriceForTier } from '../utils/pricingEngine';
import { computeCartTotals, computeTradeInSettlement } from '../utils/receiptMath';
import { toLegacyReal, dinarsToMinor } from '../utils/money';
import { MoneyInput } from './ui/MoneyInput';
import { useFifoPreviewCosts } from '../hooks/useFifoPreviewCosts';
import { verifyManagerGate } from '../utils/pinGate';
import { Kbd } from '../design-system/desktop/Kbd';

/** A cart line is never 0 units: the committed fallback for a pending field. */
const QTY_FALLBACK = 1;
/** Typed-digit ceiling. 9 digits is already 999 999 999 units — a mistype rail. */
const QTY_MAX_DIGITS = 9;
/** Ceiling for a line the store does not stock-bound (returns, stock 0). */
const QTY_UNTRACKED_MAX = 9999;

/**
 * Quantity masking: digits only, leading zeros stripped ("0005" → 5). An
 * all-zero string collapses to "" — "nothing typed yet", NOT a zero quantity,
 * so it must never be committed as one.
 */
function qtyDigitsOf(raw: string): string {
  if (/[.,]/.test(raw)) return '';
  return raw.replace(/[^0-9]/g, '').replace(/^0+/, '');
}

/**
 * The upper bound `setCartItemQty` enforces on this line, mirrored so the
 * field can never SHOW a quantity the cart does not hold (createCartSlice
 * clamps silently — the field used to keep the typed digits on screen).
 */
function qtyCapOf(item: { product: { isSerialized?: boolean; stock: number }; isReturn?: boolean }): number {
  if (item.product.isSerialized) return 1;
  if (item.isReturn) return QTY_UNTRACKED_MAX;
  return item.product.stock > 0 ? item.product.stock : QTY_UNTRACKED_MAX;
}

/**
 * CartQtyInput — the cart line quantity field.
 *
 * BUG-CART-QTY-01: this used to be a controlled `type="number"` bound straight
 * to `item.quantity`. Every keystroke the store refused (anything < 1) was
 * written back by React on the next render, so select-all + "0005" walked
 * "1" → "10" → "100" → "1005": 1005 units instead of 5, a phantom
 * 1 809 000 DA subtotal on a 1 800 DA line.
 *
 * The field now owns its text and treats a pending value as pending:
 *  - digits only, leading zeros stripped on parse;
 *  - "" / "0" / "00" are NOT rejected — the cashier keeps typing, the last
 *    committed quantity stays untouched;
 *  - a value above `maxQty` is clamped to it, the same bound the store
 *    applies, so the field and the cart can never disagree;
 *  - the pending state resolves to QTY_FALLBACK on blur / Enter (and Escape
 *    abandons the edit), never mid-keystroke;
 *  - store-driven changes (stepper, scan multiplier) still resync the text,
 *    because our own commits leave `quantity === committedRef`.
 */
interface CartQtyInputProps {
  productId: string;
  quantity: number;
  maxQty: number;
  disabled: boolean;
  label: string;
  title: string;
  onCommit: (productId: string, quantity: number) => void;
}

const CartQtyInput: React.FC<CartQtyInputProps> = ({
  productId,
  quantity,
  maxQty,
  disabled,
  label,
  title,
  onCommit,
}) => {
  const [text, setText] = useState<string>(() => String(quantity));
  const committedRef = useRef<number>(quantity);

  useEffect(() => {
    if (quantity === committedRef.current) return;
    committedRef.current = quantity;
    setText(String(quantity));
  }, [quantity]);

  const commit = (next: number) => {
    if (next === committedRef.current) return;
    committedRef.current = next;
    onCommit(productId, next);
  };

  /** Blur / Enter: resolve a pending field instead of leaving it half-typed. */
  const settle = () => {
    if (/[.,]/.test(text)) {
      setText(String(committedRef.current));
      return;
    }
    const digits = qtyDigitsOf(text);
    const next = digits ? parseInt(digits, 10) : QTY_FALLBACK;
    if (!Number.isSafeInteger(next) || next < 1) return;
    commit(next);
    setText(String(next));
  };

  return (
    <input
      type="text"
      data-testid="cart-qty-input"
      inputMode="numeric"
      autoComplete="off"
      id={`cart-qty-${productId}`}
      name={`cart-qty-${productId}`}
      maxLength={QTY_MAX_DIGITS}
      value={text}
      disabled={disabled}
      // Bare-digit field (glyph-only): descriptive name only, no visible label
      // text to shadow, so WCAG 2.5.3 does not apply.
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        if (/[.,]/.test(e.target.value)) {
          setText(e.target.value);
          return;
        }
        const digits = qtyDigitsOf(e.target.value);
        // Pending (empty / all zeros): keep typing, commit nothing yet.
        if (!digits) {
          setText(e.target.value.replace(/[^0-9]/g, ''));
          return;
        }
        const next = parseInt(digits, 10);
        if (!Number.isSafeInteger(next)) return;
        if (next > maxQty) {
          // Same bound the store clamps to — display and model stay in step.
          setText(String(maxQty));
          commit(maxQty);
          return;
        }
        setText(String(next));
        commit(next);
      }}
      onBlur={settle}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          settle();
          (e.target as HTMLInputElement).blur();
          return;
        }
        if (e.key === 'Escape') {
          setText(String(committedRef.current));
          return;
        }
        // The old `type="number"` field stepped on ArrowUp/ArrowDown via the
        // native spinner; a text field has none, and the cart key-nav handler
        // bails out while an input holds focus (CartPanel:368). Without this,
        // arrow keys on the quantity field would go dead — restore the step,
        // clamped to the same bounds (1 … maxQty) the field already enforces.
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const digits = qtyDigitsOf(text);
          const from = digits ? parseInt(digits, 10) : committedRef.current;
          if (!Number.isSafeInteger(from)) return;
          const next = Math.min(Math.max(from + (e.key === 'ArrowUp' ? 1 : -1), 1), maxQty);
          commit(next);
          setText(String(next));
        }
      }}
      className="w-10 text-center text-xs font-black text-pos-text bg-transparent focus:bg-pos-card rounded-md border-none focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono py-0.5"
      title={title}
    />
  );
};

export const CartPanel: React.FC = () => {
  // Selective subscriptions: whole-store spread re-rendered the cart on every
  // unrelated slice change (sync ticks, catalog edits) — visible input lag.
  const cart = usePosStore((s) => s.cart);
  const updateCartQty = usePosStore((s) => s.updateCartQty);
  const setCartItemQty = usePosStore((s) => s.setCartItemQty);
  const removeFromCart = usePosStore((s) => s.removeFromCart);
  const clearCart = usePosStore((s) => s.clearCart);
  const openModal = usePosStore((s) => s.openModal);
  const pricingTier = usePosStore((s) => s.pricingTier);
  const setPricingTier = usePosStore((s) => s.setPricingTier);
  const products = usePosStore((s) => s.products);
  const toggleCartItemReturn = usePosStore((s) => s.toggleCartItemReturn);
  const currentCustomer = usePosStore((s) => s.currentCustomer);
  const setCurrentCustomer = usePosStore((s) => s.setCurrentCustomer);
  const redeemLoyaltyPoints = usePosStore((s) => s.redeemLoyaltyPoints);
  const processPayment = usePosStore((s) => s.processPayment);
  const applyCartDiscountPercent = usePosStore((s) => s.applyCartDiscountPercent);
  const storeCreditApplied = usePosStore((s) => s.storeCreditApplied);
  const setStoreCreditApplied = usePosStore((s) => s.setStoreCreditApplied);
  const logSecurityAction = usePosStore((s) => s.logSecurityAction);
  const overrideCartItemPrice = usePosStore((s) => s.overrideCartItemPrice);
  // Phase 1: manager checks route through the native gate (no local
  // verifyManagerPin reads here — see utils/pinGate).
  const addToCart = usePosStore((s) => s.addToCart);
  // Phase 2: two-way exchange staging (memory-only until atomic checkout).
  const stagedTradeIn = usePosStore((s) => s.stagedTradeIn);
  const clearStagedTradeIn = usePosStore((s) => s.clearStagedTradeIn);
  const openTradeInExchange = usePosStore((s) => s.openTradeInExchange);
  const imeiRecords = usePosStore((s) => s.imeiRecords);
  const setCartItemIMEI = usePosStore((s) => s.setCartItemIMEI);

  const [isDiscountOpen, setIsDiscountOpen] = useState(false);
  const [isHeaderCollapsed, setIsHeaderCollapsed] = useState(false);
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [selectedCartIndex, setSelectedCartIndex] = useState<number | null>(null);
  // Explicit-focus guard for cart keyboard shortcuts (Delete/Backspace/arrows):
  // destructive keys fire ONLY while focus sits inside the cart list itself.
  // Loose focus on body, toolbar buttons or unrelated selects must never
  // delete a line. Rows are focusable (tabIndex) and focus selects, so Tab /
  // click-then-key flows keep working; stray keypresses elsewhere are ignored.
  const cartListRef = useRef<HTMLDivElement>(null);
  // Forensic attribution: removal rows carry the signed-in operator's name,
  // not a hardcoded role — "Caissier" is the fallback, never the default.
  // Read at event time (not subscribed) so it is always the current operator.
  const operatorName = () => usePosStore.getState().activeCashier?.name?.trim() || 'Caissier';
  // Undo-removal: single-line removals stash a restorable snapshot + a
  // 10 s strip. Misclicks get recovered instead of minting noise CRIT rows;
  // the original removal row stands (evidence is never rewritten).
  type RemovedSnapshot = { product: (typeof cart)[number]['product']; quantity: number; isReturn: boolean };
  const [lastRemoved, setLastRemoved] = useState<RemovedSnapshot | null>(null);
  const lastRemovedTimer = useRef<number | null>(null);
  const rememberRemoved = (item: (typeof cart)[number]) => {
    if (lastRemovedTimer.current !== null) window.clearTimeout(lastRemovedTimer.current);
    setLastRemoved({ product: item.product, quantity: item.quantity, isReturn: !!item.isReturn });
    lastRemovedTimer.current = window.setTimeout(() => {
      setLastRemoved(null);
      lastRemovedTimer.current = null;
    }, 10_000);
  };
  const restoreRemoved = () => {
    if (!lastRemoved) return;
    addToCart(lastRemoved.product, false, lastRemoved.quantity, lastRemoved.isReturn);
    if (lastRemovedTimer.current !== null) window.clearTimeout(lastRemovedTimer.current);
    lastRemovedTimer.current = null;
    setLastRemoved(null);
    showToast('Article restauré dans le panier.', 'success');
  };
  useEffect(
    () => () => {
      if (lastRemovedTimer.current !== null) window.clearTimeout(lastRemovedTimer.current);
    },
    [],
  );

  const [editingPriceProductId, setEditingPriceProductId] = useState<string | null>(null);
  const [overridePriceInput, setOverridePriceInput] = useState<number>(0);
  const [managerPinInput, setManagerPinInput] = useState<string>('');
  const [overrideReason, setOverrideReason] = useState<string>('PROMO');
  const [overrideCustomReason, setOverrideCustomReason] = useState<string>('');
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const [returnPinPromptProductId, setReturnPinPromptProductId] = useState<string | null>(null);
  const [returnManagerPin, setReturnManagerPin] = useState<string>('');
  const [returnPinError, setReturnPinError] = useState<string | null>(null);
  // Double-submit guard: quick-cash + Encaisser stay disabled while a payment
  // is in flight so a double-tap cannot fire processPayment twice.
  const [isProcessing, setIsProcessing] = useState(false);

  // Dernier ajout — quick-undo local (Ctrl+Z) : présentation/interaction seule,
  // réutilise removeFromCart. Écouteur propre au panneau (useKeyboardHotkeys
  // appartient à un autre agent) avec cleanup ; ignoré dans les champs et les
  // modales pour préserver l'annuler-frappe natif.
  const [lastAddedId, setLastAddedId] = useState<string | null>(null);
  const prevCartIdsRef = useRef<string[]>([]);

  // FIFO COGS preview (index-aligned with cart): margin badges must use the
  // oldest-first batch costs the checkout will store, not product.costPrice
  // (latest cost). Entries are undefined while loading/failed — badges render
  // a pending state, never a costPrice-derived margin (which printed
  // 6,000/6,200 for a 6,100 cart).
  const fifoPreviewCosts = useFifoPreviewCosts(cart);

  const { showToast } = useToast();
  const receiptSettings = usePosStore((s) => s.receiptSettings);
  const loyaltyCfg = normalizeLoyaltyConfig(receiptSettings?.loyaltyConfig);
  const loyaltyRedeemAllowed = isRedeemAllowed(loyaltyCfg);
  const loyaltyEarnAllowed = isEarnAllowed(loyaltyCfg);
  const loyaltyVisible = loyaltyRedeemAllowed || loyaltyEarnAllowed;
  // Quick-convert preset honors the merchant-configured minimum.
  const pointConvertPreset = loyaltyCfg.minimumRedemptionPoints;
  const pointConvertCredit = pointConvertPreset * loyaltyCfg.pointRedemptionRate;

  const handleConvertPresetPoints = async () => {
    if (!currentCustomer) return;
    // B-030: pass saleTotal so maximumRedemptionPercentPerSale actually
    // enforces — omitting it only checked the minimum.
    const liveTotals = computeCartTotals(cart, {
      pricingTier,
      storeCreditApplied: storeCreditApplied || 0,
      voucherCreditApplied,
    });
    const saleTotalForCap = Math.max(0, liveTotals.subtotalAfterDiscount - voucherCreditApplied);
    const check = canRedeemPoints(currentCustomer.loyaltyPoints ?? 0, pointConvertPreset, saleTotalForCap, loyaltyCfg);
    if (!check.allowed) {
      soundEngine.playError?.();
      const reasonMsg =
        check.reason === 'BELOW_MINIMUM'
          ? `Conversion minimale : ${pointConvertPreset} pts requis (solde : ${currentCustomer.loyaltyPoints ?? 0} pts).`
          : check.reason === 'INSUFFICIENT_POINTS'
          ? `Solde insuffisant : ${currentCustomer.loyaltyPoints ?? 0} pts disponibles.`
          : check.reason === 'EXCEEDS_SALE_PERCENT'
          ? `Plafond de conversion dépassé — maximum ${check.maxRedeemablePoints ?? 0} pts sur ce panier.`
          : `Conversion impossible (${check.reason || 'erreur'}).`;
      showToast(reasonMsg, 'warning');
      return;
    }
    const res = await redeemLoyaltyPoints(currentCustomer.id, pointConvertPreset, saleTotalForCap);
    if (!res.success) {
      soundEngine.playError?.();
      showToast(`Conversion refusée (${res.reason || 'erreur'}).`, 'error');
    } else {
      soundEngine.playSuccess?.();
      showToast(`+${formatDZD(res.creditAdded || 0)} d'Avoir (${pointConvertPreset} pts convertis).`, 'success');
    }
  };

  // Global-discount PIN flow: cart discounts above 10 % are refused by the
  // slice without manager approval — this holds the pending percent + PIN.
  const [discountPinFor, setDiscountPinFor] = useState<number | null>(null);
  const [discountPinInput, setDiscountPinInput] = useState('');
  const [discountPinError, setDiscountPinError] = useState<string | null>(null);

  // Runtime-staged voucher credit + VAT rate (owned by other agents' types).
  const voucherCreditApplied =
    usePosStore((s) => (s as unknown as { voucherCreditApplied?: number }).voucherCreditApplied ?? 0) || 0;
  const voucherCode =
    usePosStore((s) => (s as unknown as { voucherCode?: string | null }).voucherCode ?? null);

  const handleOpenPriceOverride = (item: typeof cart[0], e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingPriceProductId(item.product.id);
    const initialPrice = item.unitPriceCharged ?? item.appliedPrice ?? getItemPrice(item);
    setOverridePriceInput(initialPrice);
    setManagerPinInput('');
    setOverrideReason('PROMO');
    setOverrideCustomReason('');
    setOverrideError(null);
  };

  const handleApplyPriceOverride = async (item: typeof cart[0], e: React.MouseEvent) => {
    e.stopPropagation();
    const newPrice = overridePriceInput;
    if (isNaN(newPrice) || newPrice < 0) {
      setOverrideError('Prix unitaire invalide.');
      return;
    }

    const defaultPrice = item.defaultPrice ?? item.product.price ?? item.appliedPrice;
    const unitCost = item.unitCostAtSale ?? item.unitCostPrice ?? item.product.costPrice ?? 0;
    const isBelowCost = newPrice < unitCost;
    const discountPercent = defaultPrice > 0 ? ((defaultPrice - newPrice) / defaultPrice) * 100 : 0;
    const isHighDiscount = discountPercent > 20;

    let managerApproved = false;
    if (isBelowCost || isHighDiscount) {
      if (!managerPinInput) {
        setOverrideError(isBelowCost ? 'Vente à perte : PIN Manager requis' : 'Remise > 20% : PIN Manager requis');
        return;
      }
      const gate = await verifyManagerGate(managerPinInput);
      if (!gate.ok) {
        setOverrideError(
          gate.locked
            ? `Verrouillé — réessayez dans ${Math.max(1, Math.ceil(gate.remainingMs / 1000))}s.`
            : 'Code PIN Manager incorrect.'
        );
        return;
      }
      managerApproved = true;
    }

    const res = overrideCartItemPrice(item.product.id, newPrice, managerApproved);
    if (!res.success) {
      setOverrideError(res.reason || 'Erreur modification');
      return;
    }

    const effectiveReason = overrideReason === 'AUTRE' && overrideCustomReason.trim()
      ? overrideCustomReason.trim()
      : overrideReason;
    await logSecurityAction(
      'Dérogation Prix Manuel',
      `Article: ${item.product.title} | Ancien prix: ${defaultPrice} DA | Nouveau: ${newPrice} DA | Motif: ${effectiveReason}${managerApproved ? ' (Approuvé par PIN Manager)' : ''}`,
      operatorName(),
      false
    );

    soundEngine.playSuccess?.();
    setEditingPriceProductId(null);
    setOverridePriceInput(0);
    setManagerPinInput('');
    setOverrideError(null);
  };

  const handleConfirmReturnPin = async () => {
    if (!returnManagerPin.trim()) {
      setReturnPinError('Code PIN Manager requis');
      return;
    }
    const gate = await verifyManagerGate(returnManagerPin, { allowWeakFallback: true });
    if (!gate.ok) {
      setReturnPinError(
        gate.locked
          ? `Verrouillé — réessayez dans ${Math.max(1, Math.ceil(gate.remainingMs / 1000))}s.`
          : 'Code PIN Manager incorrect.'
      );
      return;
    }
    if (returnPinPromptProductId) {
      const res = toggleCartItemReturn(returnPinPromptProductId, true);
      if (!res.success) {
        setReturnPinError(res.reason === 'SHIFT_NOT_ACTIVE' ? 'Aucune session de caisse active' : 'Erreur autorisation');
        return;
      }
    }
    setReturnPinPromptProductId(null);
    setReturnManagerPin('');
    setReturnPinError(null);
    soundEngine.playSuccess?.();
  };

  // Keyboard navigation for cart items (ArrowUp / ArrowDown / + / - / Delete).
  // Explicit-focus gate: the whole handler — including destructive Delete /
  // Backspace — runs only when focus is inside the cart list. Typing Delete in
  // a select, a button-focused toolbar, or bare body must never remove a line.
  useEffect(() => {
    const handleCartKeyNav = (e: KeyboardEvent) => {
      const activeModal = usePosStore.getState().activeModal;
      if (activeModal !== null) return;
      if (!cartListRef.current?.contains(document.activeElement)) return;
      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) return;

      const currentCart = usePosStore.getState().cart;
      if (currentCart.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedCartIndex((prev) => (prev === null ? 0 : (prev + 1) % currentCart.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedCartIndex((prev) => (prev === null ? currentCart.length - 1 : (prev - 1 + currentCart.length) % currentCart.length));
      } else if (e.key === '+' || e.key === '=') {
        if (selectedCartIndex !== null && currentCart[selectedCartIndex]) {
          e.preventDefault();
          soundEngine.playScan();
          updateCartQty(currentCart[selectedCartIndex].product.id, 1);
        }
      } else if (e.key === '-') {
        if (selectedCartIndex !== null && currentCart[selectedCartIndex]) {
          e.preventDefault();
          soundEngine.playScan();
          const stepped = currentCart[selectedCartIndex];
          // Decrement-to-zero removes the line: audit parity with the trash
          // button — a removal is a removal regardless of the vector.
          if (stepped.quantity <= 1) {
            logSecurityAction(
              'Suppression Article Panier (Clavier)',
              `Article: ${stepped.product.title} (${stepped.quantity} unités)`,
              operatorName(),
              false
            );
            rememberRemoved(stepped);
          }
          updateCartQty(stepped.product.id, -1);
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedCartIndex !== null && currentCart[selectedCartIndex]) {
          e.preventDefault();
          const itemToRemove = currentCart[selectedCartIndex];
          soundEngine.playKeyBeep?.();
          logSecurityAction(
            'Suppression Article Panier (Clavier)',
            `Article: ${itemToRemove.product.title} (${itemToRemove.quantity} unités)`,
            operatorName(),
            false
          );
          rememberRemoved(itemToRemove);
          removeFromCart(itemToRemove.product.id);
          setSelectedCartIndex((prev) =>
            prev !== null && prev >= currentCart.length - 1 ? Math.max(0, currentCart.length - 2) : prev
          );
        }
      }
    };

    window.addEventListener('keydown', handleCartKeyNav);
    return () => window.removeEventListener('keydown', handleCartKeyNav);
  }, [selectedCartIndex, updateCartQty, removeFromCart, logSecurityAction]);

  // Suit le dernier article apparu dans le panier (ajouts seuls, même valeur affichée).
  useEffect(() => {
    const ids = cart.map((i) => i.product.id);
    const added = ids.find((id) => !prevCartIdsRef.current.includes(id));
    if (added !== undefined) {
      setLastAddedId(added);
    } else if (lastAddedId !== null && !ids.includes(lastAddedId)) {
      setLastAddedId(null);
    }
    prevCartIdsRef.current = ids;
  }, [cart, lastAddedId]);

  const handleUndoLastAdded = useCallback(() => {
    if (!lastAddedId) return;
    const current = usePosStore.getState().cart.find((i) => i.product.id === lastAddedId);
    if (!current) {
      setLastAddedId(null);
      return;
    }
    soundEngine.playKeyBeep?.();
    // Audit parity: quick-undo removes a line like any other vector.
    void usePosStore.getState().logSecurityAction(
      'Suppression Article Panier (Annulation ajout)',
      `Article: ${current.product.title} (${current.quantity} unités)`,
      operatorName(),
      false
    );
    removeFromCart(current.product.id);
    showToast(`« ${current.product.title} » retiré du panier (annulation).`, 'info');
    setLastAddedId(null);
  }, [lastAddedId, removeFromCart, showToast]);

  // Ctrl+Z (ou Cmd+Z) local au panneau : retire le dernier ajout, avec cleanup.
  useEffect(() => {
    if (!lastAddedId) return;
    const handleUndoKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return;
      if (e.key !== 'z' && e.key !== 'Z') return;
      const activeEl = document.activeElement;
      if (
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement
      )
        return;
      if (activeEl instanceof HTMLElement && activeEl.isContentEditable) return;
      if (usePosStore.getState().activeModal !== null) return;
      e.preventDefault();
      handleUndoLastAdded();
    };
    window.addEventListener('keydown', handleUndoKey);
    return () => window.removeEventListener('keydown', handleUndoKey);
  }, [lastAddedId, handleUndoLastAdded]);

  // Calculate gross total based on active pricing tier
  const getItemPrice = (item: typeof cart[0]) => {
    if (item.appliedPrice !== undefined) return item.appliedPrice;
    return getProductPriceForTier(item.product, pricingTier);
  };

  // Canonical totals — the same computeCartTotals() base as PaymentModal,
  // MobileCheckoutTab and processPayment (signed returns, credits, VAT).
  // Exchange credit (1:1 buyback) rides as a payment credit — never a
  // negative cart line (that would corrupt gross + FIFO).
  const tradeInCredit = Math.max(0, Math.round(Number(stagedTradeIn?.buybackValue) || 0));
  const totals = computeCartTotals(cart, {
    pricingTier,
    storeCreditApplied,
    voucherCreditApplied,
    tradeInCredit,
  });
  const grossTotal = totals.grossSubtotal;
  const totalDiscount = totals.discountTotal;
  const subtotal = totals.subtotalAfterDiscount;
  const total = totals.total;
  const tradeInCreditApplied = totals.tradeInCreditApplied;
  // Settlement uses the TRUE buyback (unclamped) against the payable base
  // (post-discount) so a soulte (Net<0) still surfaces when buyback exceeds
  // what the totals clamp can absorb.
  const tradeInSettlement = computeTradeInSettlement(subtotal, tradeInCredit);
  // B-026: `total`/`ttc` is clamped to 0 for net-negative carts — branch the
  // refund UI on refundDue (or signed net), never on `total < 0` (dead code).
  const refundDue = totals.refundDue;
  const isRefundDue = refundDue > 0;

  const lastAddedItem = lastAddedId !== null ? cart.find((i) => i.product.id === lastAddedId) ?? null : null;

  // Smart Algerian Cash Denominations (only tenders >= total; round tenders for high totals)
  const applicableQuickBills = useMemo(() => {
    if (total <= 0) return [];
    if (total <= 5000) {
      const standard = [500, 1000, 2000, 3000, 4000, 5000].filter((b) => b >= total);
      return standard.length > 0 ? standard : [5000];
    }
    const next1k = Math.ceil(total / 1000) * 1000;
    const next2k = Math.ceil(total / 2000) * 2000;
    const next5k = Math.ceil(total / 5000) * 5000;
    const candidates = [next1k, next2k, next5k].filter((b) => b >= total);
    return Array.from(new Set(candidates)).slice(0, 3);
  }, [total]);

  const handleClearCart = () => {
    if (cart.length === 0) return;
    const totalItems = cart.reduce((acc, i) => acc + i.quantity, 0);
    if (totalItems > 1) {
      const ok = window.confirm(`Voulez-vous vraiment vider les ${totalItems} articles de la vente en cours ?`);
      if (!ok) return;
    }
    // Full-clear honesty: no PIN is verified on this path (deliberate — a
    // routine cart reset must not block the cashier), so the row MUST NOT
    // carry requiresPin=true: the drawer renders that flag as "PIN validé".
    // The vector suffix + CRIT category carry the accountability instead.
    logSecurityAction(
      'Annulation Complète Panier',
      `Panier vidé (${totalItems} unités, montant: ${grossTotal} DA)`,
      operatorName(),
      false
    );
    soundEngine.playKeyBeep?.();
    clearCart();
    setSelectedCartIndex(null);
  };

  // Determine primary device model & recommended products with useMemo
  const { primaryModel, recommendedProducts } = useMemo(() => {
    const deviceModelCounts: Record<string, number> = {};
    cart.forEach(item => {
      const model = item.product.compatibleModel;
      if (model && model !== 'Universel' && model !== 'N/A') {
        deviceModelCounts[model] = (deviceModelCounts[model] || 0) + item.quantity;
      }
    });

    let mainModel = '';
    let maxCount = 0;
    for (const [model, count] of Object.entries(deviceModelCounts)) {
      if (count > maxCount) {
        maxCount = count;
        mainModel = model;
      }
    }

    const cartProductIds = new Set(cart.map(item => item.product.id));
    const recs = mainModel
      ? products.filter(p => p.compatibleModel === mainModel && !cartProductIds.has(p.id) && p.stock > 0).slice(0, 4)
      : [];

    return { primaryModel: mainModel, recommendedProducts: recs };
  }, [cart, products]);

  const runGlobalDiscount = (pct: number, approved = false) => {
    const fn = applyCartDiscountPercent as unknown as (
      p: number,
      a?: boolean
    ) => { success: boolean; requiresPin?: boolean; reason?: string } | void;
    const res = fn(pct, approved);
    if (res && res.requiresPin) {
      setDiscountPinFor(pct);
      setDiscountPinInput('');
      setDiscountPinError(null);
      return;
    }
    setDiscountPinFor(null);
    setDiscountPinInput('');
    setIsDiscountOpen(false);
  };

  const handleQuickCashWithBill = async (billAmount: number) => {
    if (cart.length === 0 || isProcessing) return;
    const hasMissingIMEI = cart.some((item) => item.product.isSerialized && (!item.imeiNumber || !item.imeiNumber.trim()));
    if (hasMissingIMEI) {
      openModal('payment');
      return;
    }
    setIsProcessing(true);
    try {
      // Carry staged wallet credit as an explicit tender leg (mirrors
      // PaymentModal): the totals above are net of it, and the slice drops
      // tender-less staging loudly (AVOIR_STAGING_DROPPED) instead of
      // charging past the displayed net. Same for a staged trade-in
      // (Reprise leg) — totals above are already net of it.
      const avoirAmount = Math.max(0, Math.round(Number(storeCreditApplied) || 0));
      const stagedReprise = usePosStore.getState().stagedTradeIn;
      const repriseAmount = Math.max(0, Math.round(Number(stagedReprise?.buybackValue) || 0));
      const res = (await processPayment([
        { method: 'Espèces', amount: billAmount },
        ...(avoirAmount > 0 ? [{ method: 'Avoir Client' as const, amount: avoirAmount }] : []),
        ...(repriseAmount > 0 ? [{ method: 'Reprise' as const, amount: repriseAmount }] : []),
      ])) as unknown as {
        success: boolean;
        reason?: string;
        warnings?: string[];
        recoveryQueued?: boolean;
      };
      if (!res || !res.success) {
        const reason = res?.reason;
        soundEngine.playError?.();
        if (res?.recoveryQueued && reason?.startsWith('PERSISTENCE_FAILED')) {
          const detail = reason.includes(':') ? reason.slice('PERSISTENCE_FAILED:'.length) : '';
          for (const w of res.warnings ?? []) showToast(w, 'warning', 6000);
          showToast(
            `Écriture SQLite en échec — panier conservé. La vente sera reprise au démarrage.${detail ? ` (${detail})` : ''}`,
            'warning',
            6000
          );
          return;
        }
        showToast(
          reason === 'NO_ACTIVE_SHIFT'
            ? "Aucun shift ouvert — ouvrez un shift avant d'encaisser."
            : reason && reason.startsWith('INSUFFICIENT_STOCK')
              ? `Stock insuffisant : ${reason.slice('INSUFFICIENT_STOCK:'.length)}`
              : reason && reason.startsWith('IMEI_ALREADY_SOLD')
                ? `IMEI déjà vendu : ${reason.slice('IMEI_ALREADY_SOLD:'.length)}`
                : reason === 'PERSISTENCE_FAILED' || (reason && reason.startsWith('PERSISTENCE_FAILED'))
                  ? `Erreur d'écriture base de données. Vente non enregistrée — panier conservé.${reason.includes(':') ? ` (${reason.slice('PERSISTENCE_FAILED:'.length, 'PERSISTENCE_FAILED:'.length + 120)})` : ''}`
                  : `Échec de l'encaissement rapide${reason ? ` (${reason})` : ''} — panier conservé.`,
          'error'
        );
        return;
      }
      soundEngine.playSuccess?.();
      for (const w of res.warnings ?? []) {
        showToast(w, 'warning', 5000);
      }
      showToast('✅ Vente encaissée • Reçu imprimé', 'success');
    } catch (err) {
      console.error('[cart] quick-cash payment failed:', err);
      soundEngine.playError?.();
      showToast("Erreur d'encaissement rapide. Vente non enregistrée — panier conservé.", 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div data-testid="cart-panel" className="w-[340px] sm:w-[380px] md:w-[390px] max-w-[48vw] shrink-0 bg-pos-panel border-r border-pos-border flex flex-col h-full select-none transition-colors duration-200">
      {/* Cart Header & Pricing Tier Selector */}
      <div className="p-2 sm:p-2.5 border-b border-pos-border space-y-1.5 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <h2 className="font-bold text-sm text-pos-text tracking-wider uppercase truncate">Vente en Cours</h2>
            <span className="bg-pos-card border border-pos-border text-emerald-500 text-xs font-bold px-2 py-0.5 rounded-full shrink-0">
              {cart.reduce((acc, i) => acc + i.quantity, 0)} {cart.reduce((acc, i) => acc + i.quantity, 0) > 1 ? 'Articles' : 'Article'}
            </span>
            <button
              type="button"
              onClick={() => setIsHeaderCollapsed(!isHeaderCollapsed)}
              className="p-1 rounded-lg bg-pos-card hover:bg-pos-hover text-pos-muted hover:text-pos-text border border-pos-border transition cursor-pointer shrink-0"
              title={isHeaderCollapsed ? "Afficher les détails de la vente (Client, Reprise, Tarif)" : "Masquer les détails pour afficher plus d'articles"}
              aria-label={isHeaderCollapsed ? "Afficher les détails" : "Masquer les détails"}
            >
              {isHeaderCollapsed ? (
                <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
              )}
            </button>
          </div>
          {cart.length > 0 && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => setIsDiscountOpen(!isDiscountOpen)}
                className={`p-1.5 rounded-lg border transition text-xs font-bold flex items-center gap-1 cursor-pointer ${
                  isDiscountOpen ? 'bg-purple-500/20 text-purple-300 border-purple-500/50' : 'bg-pos-card text-pos-muted hover:text-pos-text border-pos-border'
                }`}
                title="Appliquer une remise globale"
              >
                <Percent className="w-3.5 h-3.5" />
              </button>
              <button
                data-testid="cart-clear"
                onClick={handleClearCart}
                className="p-1.5 hover:bg-red-500/10 text-pos-muted hover:text-red-400 rounded-lg transition cursor-pointer"
                title="Vider le panier (Confirmation requise)"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* Global Discount Quick Strip */}
        {isDiscountOpen && cart.length > 0 && (
          <div className="bg-purple-950/40 border border-purple-500/40 rounded-xl p-2.5 space-y-2 animate-in fade-in slide-in-from-top-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-purple-300 flex items-center gap-1">
                <Percent className="w-3.5 h-3.5" /> Remise Globale Panier
              </span>
              <span className="text-[10px] text-purple-200">Applicable immédiatement</span>
            </div>
            <div className="flex items-center gap-1.5">
              {[5, 10, 15, 20].map((pct) => (
                <button
                  key={pct}
                  onClick={() => {
                    runGlobalDiscount(pct);
                  }}
                  className="flex-1 py-1 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/40 text-xs font-black transition cursor-pointer"
                >
                  -{pct}%
                </button>
              ))}
            </div>
            {discountPinFor !== null && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-2 space-y-1.5">
                <p className="text-[10px] font-bold text-red-300">
                  Remise -{discountPinFor}% &gt; 10% : PIN Manager requis
                </p>
                <div className="flex items-center gap-1.5">
                  <input
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="current-password"
                    value={discountPinInput}
                    onChange={(e) => {
                      setDiscountPinInput(e.target.value);
                      setDiscountPinError(null);
                    }}
                    placeholder="PIN Manager"
                    className="flex-1 min-w-0 bg-pos-card border border-red-500/40 rounded-lg px-2 py-1 text-xs text-pos-text focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const gate = await verifyManagerGate(discountPinInput);
                      if (!gate.ok) {
                        setDiscountPinError(
                          gate.locked
                            ? `Verrouillé — réessayez dans ${Math.max(1, Math.ceil(gate.remainingMs / 1000))}s.`
                            : 'Code PIN Manager incorrect.'
                        );
                        return;
                      }
                      runGlobalDiscount(discountPinFor, true);
                    }}
                    className="px-2.5 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-[10px] font-black transition cursor-pointer"
                  >
                    Valider
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDiscountPinFor(null);
                      setDiscountPinInput('');
                      setDiscountPinError(null);
                    }}
                    className="px-2 py-1 text-[10px] font-bold text-pos-muted hover:text-pos-text cursor-pointer"
                  >
                    Annuler
                  </button>
                </div>
                {discountPinError && (
                  <p className="text-[10px] text-red-400 font-bold">{discountPinError}</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Collapsible details vs compact summary bar */}
        {isHeaderCollapsed ? (
          <div className="flex items-center justify-between gap-1.5 bg-pos-card border border-pos-border rounded-lg px-2 py-1 text-xs shadow-sm">
            <div className="flex items-center gap-1.5 min-w-0 flex-1 text-[11px] font-medium text-pos-muted truncate">
              {currentCustomer ? (
                <span className="text-pos-text font-bold truncate flex items-center gap-1">
                  <User className="w-3 h-3 text-emerald-400 shrink-0" aria-hidden="true" />
                  <span className="truncate">{currentCustomer.name}</span>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => openModal('customers')}
                  className="text-emerald-400 hover:underline flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  <UserCheck className="w-3 h-3" aria-hidden="true" />
                  <span>+ Client (F3)</span>
                </button>
              )}

              {stagedTradeIn && (
                <span className="text-emerald-400 font-bold truncate flex items-center gap-1 shrink-0 border-l border-pos-border/60 pl-1.5">
                  <RefreshCw className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
                  <span>−{formatDZD(tradeInCredit)}</span>
                </span>
              )}

              <span className="text-[10px] px-1.5 py-0.2 rounded bg-pos-bg border border-pos-border font-bold text-pos-text shrink-0 ml-auto">
                {pricingTier === 'Retail' ? 'Détail' : pricingTier === 'VIP' ? 'Demi-Gros' : 'Gros B2B'}
              </span>
            </div>

            <button
              type="button"
              onClick={() => setIsHeaderCollapsed(false)}
              className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded transition shrink-0 cursor-pointer"
              title="Afficher les détails de la vente"
              aria-label="Afficher les détails"
            >
              <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <>
            {/* Two-Way Exchange trigger / staged chip (Phase 2) */}
            {!stagedTradeIn ? (
              <button
                type="button"
                onClick={() => openTradeInExchange()}
                className="w-full py-1.5 px-2.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer active:scale-[0.99]"
              >
                <RefreshCw className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Échanger un appareil (Trade-In)</span>
              </button>
            ) : (
              <div className="bg-emerald-500/10 border border-emerald-500/40 rounded-lg p-2 space-y-1 text-xs">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="text-[10.5px] font-extrabold uppercase tracking-wide text-emerald-300 flex items-center gap-1.5 min-w-0">
                    <RefreshCw className="w-3 h-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">Reprise : {stagedTradeIn.deviceModel}</span>
                  </span>
                  <span className="text-xs font-black text-emerald-300 whitespace-nowrap font-mono">−{formatDZD(tradeInCredit)}</span>
                </div>
                <div className="flex items-center justify-between gap-1.5 pt-0.5">
                  <span className="text-[9.5px] text-pos-muted font-mono truncate">IMEI: {stagedTradeIn.imei}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => openTradeInExchange({ ...stagedTradeIn })}
                      className="px-2 py-0.5 rounded bg-pos-card border border-pos-border text-pos-text text-[10px] font-bold flex items-center gap-1 hover:border-emerald-500/50 transition cursor-pointer"
                      title="Modifier l’évaluation de reprise"
                      aria-label="Modifier l’évaluation"
                    >
                      <Pencil className="w-2.5 h-2.5 text-emerald-400" aria-hidden="true" />
                      <span>Modifier</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        clearStagedTradeIn();
                        showToast('Reprise retirée du panier.', 'info');
                      }}
                      className="px-2 py-0.5 rounded bg-pos-card border border-pos-border text-pos-muted hover:text-red-400 text-[10px] font-bold flex items-center gap-1 transition cursor-pointer"
                      title="Retirer la reprise"
                      aria-label="Retirer"
                    >
                      <X className="w-2.5 h-2.5" aria-hidden="true" />
                      <span>Retirer</span>
                    </button>
                  </div>
                </div>
                {tradeInSettlement.direction === 'SOULTE_SHOP_PAYS' && (
                  <p className="text-[9.5px] font-bold text-amber-300">
                    Soulte boutique : {formatDZD(tradeInSettlement.shopOwes)} à verser au client
                  </p>
                )}
              </div>
            )}

            {/* Customer Badge & Loyalty Points Widget */}
            {currentCustomer ? (
              <div className="bg-pos-card border border-pos-border rounded-lg p-2 space-y-1 text-xs shadow-sm">
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    {currentCustomer.avatarUrl ? (
                      <img
                        src={currentCustomer.avatarUrl}
                        alt={currentCustomer.name}
                        className="w-5 h-5 rounded-full object-cover border border-emerald-500/40 shrink-0"
                      />
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 text-slate-950 font-black text-[10px] flex items-center justify-center shrink-0">
                        {currentCustomer.name.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-pos-text truncate text-xs leading-tight">{currentCustomer.name}</p>
                      <p className="text-[9.5px] text-pos-muted truncate font-mono">
                        {currentCustomer.phone || currentCustomer.registeredDevice || 'Client Enregistré'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => openModal('customers')}
                      className="p-1 hover:bg-pos-hover text-pos-muted hover:text-cyan-400 rounded transition cursor-pointer"
                      title="Changer de Client (F3)"
                      aria-label="Changer de Client"
                    >
                      <User className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setCurrentCustomer(null)}
                      className="p-1 hover:bg-red-500/10 text-pos-muted hover:text-red-400 rounded transition cursor-pointer"
                      title="Détacher le client du panier"
                      aria-label="Détacher le client du panier"
                    >
                      <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {/* Financial & Loyalty Pills */}
                <div className="flex items-center gap-1 flex-wrap text-[9.5px]">
                  {loyaltyVisible && (
                    <span className="px-1.5 py-0.2 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 font-bold flex items-center gap-0.5">
                      <Star className="w-2.5 h-2.5 fill-amber-400 text-amber-400" aria-hidden="true" />
                      {currentCustomer.loyaltyPoints} pts
                    </span>
                  )}

                  {(currentCustomer.storeCredit || 0) > 0 && (
                    <span className="px-1.5 py-0.2 rounded bg-purple-500/15 border border-purple-500/30 text-purple-300 font-bold font-mono">
                      Avoir: {formatDZD(currentCustomer.storeCredit)}
                    </span>
                  )}

                  {(currentCustomer.storeCredit || 0) < 0 && (
                    <span className="px-1.5 py-0.2 rounded bg-orange-500/15 border border-orange-500/30 text-orange-300 font-bold font-mono" title="Avoir consommé puis annulé — les prochains remboursements le comblent avant tout versement">
                      Solde: {formatDZD(currentCustomer.storeCredit)}
                    </span>
                  )}

                  {(currentCustomer.currentDebt || 0) > 0 && (
                    <span className="px-1.5 py-0.2 rounded bg-rose-500/15 border border-rose-500/30 text-rose-300 font-bold font-mono">
                      Dette: {formatDZD(currentCustomer.currentDebt || 0)}
                    </span>
                  )}
                </div>

                {/* Point Conversion Button (compact) */}
                {loyaltyRedeemAllowed && loyaltyCfg.pointsEnabled !== false && currentCustomer.loyaltyPoints >= 10 && (
                  <button
                    type="button"
                    onClick={() => void handleConvertPresetPoints()}
                    className="w-full py-0.5 bg-gradient-to-r from-amber-500/20 to-yellow-500/20 hover:from-amber-500/30 hover:to-yellow-500/30 border border-amber-500/40 text-amber-300 font-bold text-[10px] rounded transition flex items-center justify-center gap-1 shadow-sm cursor-pointer"
                  >
                    <Sparkles className="w-3 h-3 text-amber-400" aria-hidden="true" />
                    <span>Convertir {pointConvertPreset} pts (+{formatDZD(pointConvertCredit)} d'Avoir)</span>
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => openModal('customers')}
                className="w-full py-1.5 bg-pos-card hover:bg-pos-hover border border-dashed border-pos-border hover:border-emerald-500/50 rounded-lg text-xs font-bold text-pos-muted hover:text-pos-text flex items-center justify-center gap-1.5 transition cursor-pointer"
              >
                <UserCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                <span>+ Assigner un Client (F3)</span>
              </button>
            )}

            {/* Pricing Tier Selector (Retail / Demi-Gros / Wholesale) */}
            <div className="flex items-center gap-1 bg-pos-bg p-0.5 rounded-lg border border-pos-border">
              <Tag className="w-3 h-3 text-emerald-500 ml-1 shrink-0" aria-hidden="true" />
              <span className="text-[9.5px] font-bold text-pos-muted uppercase mr-0.5 shrink-0">Tarif:</span>
              {(['Retail', 'VIP', 'Wholesale'] as PricingTier[]).map((tier) => (
                <button
                  key={tier}
                  type="button"
                  onClick={() => setPricingTier(tier)}
                  className={`flex-1 py-0.5 rounded text-[11px] font-bold transition cursor-pointer ${
                    pricingTier === tier
                      ? tier === 'VIP'
                        ? 'bg-cyan-500 text-slate-950 font-black shadow-sm'
                        : tier === 'Wholesale'
                        ? 'bg-amber-500 text-slate-950 font-black shadow-sm'
                        : 'bg-emerald-500 text-slate-950 font-black shadow-sm'
                      : 'text-pos-muted hover:text-pos-text'
                  }`}
                >
                  {tier === 'Retail' ? 'Détail' : tier === 'VIP' ? 'Demi-Gros' : 'Gros B2B'}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Cart Items List */}
      <div
        ref={cartListRef}
        role="listbox"
        aria-label="Lignes du panier — les raccourcis clavier agissent ici uniquement"
        className="flex-1 min-h-[180px] sm:min-h-[220px] overflow-y-auto p-1.5 sm:p-2 space-y-1 sm:space-y-1.5 overscroll-contain [&_button]:focus-visible:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-emerald-500"
      >
        {/* Undo-removal: a misclicked line comes back in one tap. The removal
            audit row stands — restoration is an addition, never an edit. */}
        {lastRemoved && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/40 rounded-xl px-2.5 py-2 text-[11px]"
          >
            <RotateCcw className="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true" />
            <span className="flex-1 min-w-0 text-pos-text truncate">
              « {lastRemoved.product.title} » retiré
              <span className="text-pos-muted"> ({lastRemoved.quantity} u.)</span>
            </span>
            <button
              type="button"
              onClick={restoreRemoved}
              className="shrink-0 px-2.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 font-bold border border-amber-500/40 transition cursor-pointer"
            >
              Restaurer
            </button>
            <button
              type="button"
              onClick={() => setLastRemoved(null)}
              aria-label="Masquer"
              className="shrink-0 p-1.5 rounded-lg text-pos-muted hover:text-pos-text hover:bg-pos-hover transition cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {cart.length === 0 ? (
          <div role="status" aria-live="polite" className="h-full flex flex-col items-center justify-center p-3 text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-inner">
              <ShoppingBag className="w-6 h-6 stroke-[2.2]" />
            </div>
            <div className="space-y-1 max-w-[280px]">
              <p className="text-xs font-black text-pos-text uppercase tracking-wider">Caisse Prête à Vendre</p>
              <p className="text-[11px] text-pos-muted">Scannez un article ou appuyez sur <span className="font-mono font-bold text-pos-accent">F1</span> — raccourcis ci-dessous :</p>
            </div>
            <div className="w-full bg-surface-card border border-line-subtle rounded-ui-md p-2.5 space-y-1.5 text-left text-ui-2xs shadow-xs">
              <div className="flex justify-between items-center py-0.5 border-b border-line-subtle/40">
                <span className="text-fg-muted">Palette de commandes</span>
                <Kbd size="sm">Ctrl+K</Kbd>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-line-subtle/40">
                <span className="text-fg-muted">Rechercher catalogue</span>
                <Kbd size="sm">F1 ou /</Kbd>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-line-subtle/40">
                <span className="text-fg-muted">Encaisser Espèces</span>
                <Kbd size="sm" variant="accent">F2</Kbd>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-line-subtle/40">
                <span className="text-fg-muted">Client / Dette / Fidélité</span>
                <Kbd size="sm">F3</Kbd>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-line-subtle/40">
                <span className="text-fg-muted">Remise globale panier</span>
                <Kbd size="sm">F4</Kbd>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-line-subtle/40">
                <span className="text-fg-muted">Mettre la vente en attente</span>
                <Kbd size="sm">F6</Kbd>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-line-subtle/40">
                <span className="text-fg-muted">Réimprimer dernier ticket</span>
                <Kbd size="sm">F7</Kbd>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-line-subtle/40">
                <span className="text-fg-muted">Guide des raccourcis</span>
                <Kbd size="sm">F8</Kbd>
              </div>
              <div className="flex justify-between items-center py-0.5">
                <span className="text-fg-muted">Quantité multiple au scan</span>
                <Kbd size="sm">5*CODE</Kbd>
              </div>
            </div>
          </div>
        ) : (
          cart.map((item, idx) => {
            const unitPrice = getItemPrice(item);
            const isSelected = selectedCartIndex === idx;
            return (
              <div
                key={item.product.id}
                data-testid="cart-line"
                role="option"
                aria-selected={isSelected}
                tabIndex={0}
                onClick={(e) => {
                  setSelectedCartIndex(idx);
                  e.currentTarget.focus({ preventScroll: true });
                }}
                onFocus={() => setSelectedCartIndex(idx)}
                className={`bg-pos-card border rounded-lg p-1.5 sm:p-2 flex flex-col gap-1 transition motion-reduce:transition-none group cursor-pointer animate-in fade-in slide-in-from-top-2 motion-reduce:animate-none ${
                  isSelected
                    ? 'border-emerald-500 ring-2 ring-emerald-500/40 bg-emerald-500/[0.04]'
                    : item.isReturn
                    ? 'border-rose-500/40 bg-rose-500/[0.03] hover:border-rose-500/60'
                    : 'border-pos-border/80 hover:border-emerald-500/40'
                }`}
              >
                <div className="flex-1 min-w-0">
                  {/* Row 1: Title, Badges, and Total Price */}
                  <div className="flex items-center justify-between gap-1.5 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <h3
                        className="text-xs font-bold text-pos-text truncate leading-tight"
                        title={`${item.product.title}${item.product.brand ? ` • ${item.product.brand}` : ''} (Réf: ${item.product.sku})`}
                      >
                        {item.product.title}
                      </h3>
                      {item.isReturn && (
                        <span className="text-[9px] bg-rose-500/20 text-rose-300 font-black px-1 rounded border border-rose-500/40 shrink-0 animate-pulse">
                          RETOUR
                        </span>
                      )}
                      {item.volumeTierApplied && (
                        <span className="text-[9px] bg-cyan-500/20 text-cyan-300 font-bold px-1 rounded border border-cyan-500/40 shrink-0 flex items-center gap-0.5">
                          <Layers className="w-2.5 h-2.5" aria-hidden="true" />
                          <span>Lot</span>
                        </span>
                      )}
                      {item.discountAmount !== undefined && item.discountAmount > 0 && !item.volumeTierApplied && (
                        <span className="text-[9px] bg-purple-500/15 text-purple-300 font-bold px-1 rounded border border-purple-500/30 shrink-0">
                          -{formatDZD(item.discountAmount)}/u
                        </span>
                      )}
                    </div>

                    <div className="text-right shrink-0 flex items-baseline gap-1">
                      {item.defaultPrice && item.unitPriceCharged !== undefined && item.unitPriceCharged < item.defaultPrice && (
                        <span className="text-[10px] text-pos-muted line-through font-mono">
                          {formatDZD(item.defaultPrice * item.quantity)}
                        </span>
                      )}
                      <span className={`text-xs font-black font-mono pl-0.5 ${item.isReturn ? 'text-rose-400' : 'text-pos-text'}`}>
                        {item.isReturn ? '-' : ''}{formatDZD(unitPrice * item.quantity - item.discount)}
                      </span>
                    </div>
                  </div>

                  {/* Row 2: Stepper, Unit Price, Margin, Actions */}
                  <div className="flex items-center justify-between gap-1 mt-0.5">
                    {/* Left: Stepper + Unit Price + Margin */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      <div className="flex items-center bg-pos-bg border border-pos-border rounded-lg p-0.5 shadow-inner shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            soundEngine.playScan();
                            // Stepper-to-zero removes the line: same audit row as
                            // every other removal vector.
                            if (item.quantity <= 1) {
                              logSecurityAction(
                                'Suppression Article Panier',
                                `Article: ${item.product.title} (${item.quantity} unités)`,
                                operatorName(),
                                false
                              );
                              rememberRemoved(item);
                            }
                            updateCartQty(item.product.id, -1);
                          }}
                          className="w-5 h-5 rounded bg-pos-card hover:bg-pos-hover active:scale-95 text-pos-muted hover:text-pos-text border border-pos-border/60 flex items-center justify-center transition cursor-pointer"
                          title="Diminuer quantité (-1)"
                          aria-label="Diminuer quantité"
                        >
                          <Minus className="w-3 h-3 stroke-[2.5]" aria-hidden="true" />
                        </button>
                        <CartQtyInput
                          productId={item.product.id}
                          quantity={item.quantity}
                          maxQty={qtyCapOf(item)}
                          disabled={!!item.product.isSerialized}
                          label={`Quantité ${item.product.title}`}
                          title={item.product.isSerialized ? '1 appareil par IMEI' : `Saisir quantité directement (Stock dispo: ${item.product.stock})`}
                          onCommit={setCartItemQty}
                        />
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            soundEngine.playScan();
                            updateCartQty(item.product.id, 1);
                          }}
                          disabled={item.product.isSerialized}
                          className="w-5 h-5 rounded bg-pos-card hover:bg-emerald-500/20 active:scale-95 text-pos-muted hover:text-emerald-400 border border-pos-border/60 flex items-center justify-center transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Augmenter quantité (+1)"
                          aria-label="Augmenter quantité"
                        >
                          <Plus className="w-3 h-3 stroke-[2.5]" aria-hidden="true" />
                        </button>
                      </div>

                      <span className="text-[10px] font-mono text-pos-muted shrink-0" title={`Prix unitaire: ${formatDZD(unitPrice)}`}>
                        × {formatDZD(unitPrice)}
                      </span>

                      {(() => {
                        // STRICT LEDGER: fresh lines show the FIFO preview only.
                        const previewCost = fifoPreviewCosts[idx];
                        const frozenCost = item.isReturn ? (item.unitCostAtSale ?? item.unitCostPrice) : undefined;
                        if (previewCost === undefined && frozenCost === undefined) {
                          return null;
                        }
                        const cost = previewCost ?? frozenCost ?? 0;
                        const profit = (unitPrice - cost) * item.quantity;
                        const isLoss = profit < 0;
                        return (
                          <span
                            className={`text-[9px] font-mono px-1 py-0.2 rounded border font-bold shrink-0 hidden sm:inline-block ${
                              isLoss
                                ? 'bg-red-500/15 text-red-400 border-red-500/30'
                                : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            }`}
                            title={`Marge: ${isLoss ? '' : '+'}${formatDZD(profit)}`}
                          >
                            {isLoss ? '' : '+'}{formatDZD(profit)}
                          </span>
                        );
                      })()}
                    </div>

                    {/* Right: Actions (Prix, Échange, Supprimer) */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        data-testid="price-override-open"
                        onClick={(e) => handleOpenPriceOverride(item, e)}
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold transition cursor-pointer border ${
                          item.discountAmount && item.discountAmount > 0
                            ? 'bg-purple-500/20 text-purple-300 border-purple-500/40'
                            : 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 hover:text-amber-300 border-amber-500/30'
                        }`}
                        title="Modifier le prix de la ligne (Dérogation / Remise manuelle)"
                      >
                        <Tag className="w-2.5 h-2.5" aria-hidden="true" />
                        <span>Prix</span>
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (item.isReturn) {
                            toggleCartItemReturn(item.product.id, true);
                          } else {
                            setReturnPinPromptProductId(item.product.id);
                            setReturnManagerPin('');
                            setReturnPinError(null);
                          }
                        }}
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold transition cursor-pointer border ${
                          item.isReturn
                            ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                            : 'bg-pos-card hover:bg-pos-hover text-pos-muted hover:text-pos-text border-pos-border/60'
                        }`}
                        title={item.isReturn ? 'Annuler le mode retour' : 'Passer cet article en retour / échange client (PIN Manager)'}
                      >
                        <ArrowLeftRight className="w-2.5 h-2.5" aria-hidden="true" />
                        <span>{item.isReturn ? 'Retour' : 'Échange'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          soundEngine.playKeyBeep?.();
                          logSecurityAction(
                            'Suppression Article Panier',
                            `Article: ${item.product.title} (${item.quantity} unités)`,
                            operatorName(),
                            false
                          );
                          rememberRemoved(item);
                          removeFromCart(item.product.id);
                          setSelectedCartIndex(null);
                        }}
                        className="flex items-center justify-center p-1 rounded text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 hover:border-red-500/40 transition cursor-pointer shrink-0 active:scale-95"
                        data-testid="cart-line-remove"
                        title="Supprimer cet article de la vente"
                        aria-label="Supprimer cet article"
                      >
                        <Trash2 className="w-3 h-3" aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  {/* Serialized Device Stock-IMEI Selector */}
                  {item.product.isSerialized && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="mt-1.5 pt-1.5 border-t border-pos-border/40 flex flex-wrap items-center justify-between gap-1.5 text-xs"
                    >
                      <span className="text-[10px] font-bold text-amber-400 flex items-center gap-1 shrink-0">
                        <Barcode className="w-3 h-3" /> IMEI Appareil :
                      </span>
                      {(() => {
                        const availableImeis = (imeiRecords || []).filter(
                          (r) => r.productId === item.product.id && !r.saleTransactionId && !r.soldAt
                        );
                        const enteredImei = (item.imeiNumber || '').trim();
                        const isUntracked =
                          enteredImei.length > 0 &&
                          !availableImeis.some((r) => r.imei.trim() === enteredImei);
                        return (
                          <div className="flex items-center gap-1.5 flex-1 min-w-[200px] justify-end flex-wrap">
                            {isUntracked && (
                              <span
                                className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 font-semibold flex items-center gap-1 shrink-0"
                                title="Cet IMEI n'est pas répertorié dans les stocks actifs de cet article"
                              >
                                <AlertTriangle className="w-2.5 h-2.5 text-amber-400" />
                                Hors stock
                              </span>
                            )}
                            {availableImeis.length > 0 ? (
                              <select
                                value={item.imeiNumber || ''}
                                onChange={(e) => setCartItemIMEI(item.product.id, e.target.value)}
                                className={`text-[10px] font-mono font-bold bg-pos-bg border ${
                                  !item.imeiNumber ? 'border-amber-500 text-amber-300' : 'border-pos-border text-pos-text'
                                } rounded px-2 py-1 focus:outline-none focus:border-emerald-500 max-w-[190px]`}
                              >
                                <option value="">-- Choisir IMEI en Stock ({availableImeis.length}) --</option>
                                {availableImeis.map((r) => (
                                  <option key={r.imei} value={r.imei}>
                                    {r.imei}
                                  </option>
                                ))}
                              </select>
                            ) : null}
                            <input
                              type="text"
                              placeholder="Ou saisir/scanner IMEI..."
                              value={item.imeiNumber || ''}
                              onChange={(e) => setCartItemIMEI(item.product.id, e.target.value)}
                              className={`text-[10px] font-mono bg-pos-bg border ${
                                !item.imeiNumber
                                  ? 'border-amber-500/60 bg-amber-500/10'
                                  : isUntracked
                                  ? 'border-amber-500/80 bg-pos-card text-amber-200'
                                  : 'border-pos-border bg-pos-card'
                              } rounded px-2 py-1 text-pos-text focus:outline-none focus:border-emerald-500 w-36`}
                            />
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* Inline Price Override Popover */}
                  {editingPriceProductId === item.product.id && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="mt-2.5 p-3 bg-pos-panel border border-amber-500/40 rounded-xl space-y-2 text-xs shadow-xl animate-in fade-in"
                    >
                      <div className="flex justify-between items-center text-[10px] font-bold text-pos-muted">
                        <span>Prix Normal: <strong className="text-pos-text">{formatDZD(item.defaultPrice ?? item.product.price)}</strong></span>
                        <span>Coût FIFO: <strong className="text-cyan-400">{(() => {
                          const pc = fifoPreviewCosts[idx];
                          const fc = item.isReturn ? (item.unitCostAtSale ?? item.unitCostPrice) : undefined;
                          const cost = pc ?? fc;
                          // Pending (…) until the FIFO preview resolves — never
                          // flash a costPrice-derived cost for fresh lines.
                          return cost === undefined
                            ? '…'
                            : formatDZD(cost);
                        })()}</strong></span>
                      </div>

                      <div>
                        <label htmlFor={`price-override-${item.product.id}`} className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                          Nouveau Prix Vendu (DA/unité) :
                        </label>
                        <MoneyInput
                          label="Nouveau Prix Vendu (DA/unité)"
                          id={`price-override-${item.product.id}`}
                          data-testid="price-override-input"
                          valueMinor={dinarsToMinor(overridePriceInput || 0)}
                          onChangeMinor={(minor) => setOverridePriceInput(toLegacyReal(minor))}
                          className="w-full bg-pos-card border border-pos-border rounded-lg px-2.5 py-1.5 font-mono font-bold text-pos-text text-xs focus:outline-none focus:border-amber-400"
                          placeholder="Ex: 3500"
                        />
                      </div>

                      {/* Live Margin & Discount Calculation */}
                      {(() => {
                        const p = overridePriceInput || 0;
                        const previewCost = fifoPreviewCosts[idx];
                        const frozenCost = item.isReturn ? (item.unitCostAtSale ?? item.unitCostPrice) : undefined;
                        // Displayed margin is FIFO-or-pending (never a
                        // costPrice-derived number); the below-cost gate below
                        // keeps the conservative fallback chain so protection
                        // never sleeps while the preview resolves.
                        const costKnown = previewCost !== undefined || frozenCost !== undefined;
                        const c = previewCost ?? frozenCost ?? item.product.costPrice ?? 0;
                        const def = item.defaultPrice ?? item.product.price;
                        const pr = (p - c) * item.quantity;
                        const disc = Math.max(0, def - p);
                        const discPct = def > 0 ? ((disc / def) * 100).toFixed(0) : '0';
                        const isLoss = p < c;
                        const isHighDisc = Number(discPct) > 20;

                        return (
                          <div className="space-y-1.5">
                            <div className="flex justify-between items-center text-[10px] font-mono">
                              <span className="text-pos-muted">Remise: -{formatDZD(disc)} ({discPct}%)</span>
                              <span className={isLoss ? 'text-red-400 font-bold' : 'text-emerald-400 font-bold'}>
                                Marge: {costKnown ? `${isLoss ? '' : '+'}` : ''}{costKnown ? formatDZD(pr) : '…'}
                              </span>
                            </div>

                            {(isLoss || isHighDisc) && (
                              <div className="p-2 bg-red-500/10 border border-red-500/30 rounded-lg space-y-1">
                                <div className="flex items-center gap-1.5 text-red-400 text-[10px] font-bold">
                                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                  <span>{isLoss ? 'Vente à perte (Marge négative)' : 'Remise > 20%'} — PIN Requis</span>
                                </div>
                                <input
                                  type="password"
                                  data-testid="price-override-pin"
                                  inputMode="numeric"
                                  pattern="[0-9]*"
                                  autoComplete="current-password"
                                  value={managerPinInput}
                                  onChange={(e) => setManagerPinInput(e.target.value)}
                                  placeholder="Code PIN Manager"
                                  className="w-full bg-pos-card border border-red-500/40 rounded px-2 py-1 text-xs text-pos-text focus:outline-none"
                                />
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {overrideError && (
                        <p className="text-[10px] text-red-400 font-bold">{overrideError}</p>
                      )}

                      <div>
                        <span className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                          Motif de Dérogation :
                        </span>
                        <div className="flex gap-1 flex-wrap">
                          {([
                            { key: 'PROMO', label: 'Promo' },
                            { key: 'CLIENT_FIDELE', label: 'Fidélité' },
                            { key: 'DEFAUT_MINEUR', label: 'Défaut' },
                            { key: 'NEGOCIATION', label: 'Négociation' },
                            { key: 'AUTRE', label: 'Autre' },
                          ] as const).map(({ key, label }) => (
                            <button
                              key={key}
                              type="button"
                              onClick={() => setOverrideReason(key)}
                              className={`px-2 py-0.5 rounded text-[10px] font-semibold transition cursor-pointer ${
                                overrideReason === key
                                  ? 'bg-amber-500 text-slate-950 font-bold'
                                  : 'bg-pos-card border border-pos-border text-pos-muted hover:text-pos-text'
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        {overrideReason === 'AUTRE' && (
                          <input
                            type="text"
                            placeholder="Préciser le motif de la dérogation..."
                            value={overrideCustomReason}
                            onChange={(e) => setOverrideCustomReason(e.target.value)}
                            className="mt-1.5 w-full bg-pos-card border border-pos-border rounded px-2 py-1 text-xs text-pos-text focus:outline-none focus:border-amber-400"
                          />
                        )}
                      </div>

                      <div className="flex justify-end gap-1.5 pt-1">
                        <button
                          type="button"
                          onClick={() => setEditingPriceProductId(null)}
                          className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-pos-muted hover:text-pos-text cursor-pointer"
                        >
                          Annuler
                        </button>
                        <button
                          type="button"
                          data-testid="price-override-apply"
                          onClick={(e) => handleApplyPriceOverride(item, e)}
                          className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-[11px] rounded-lg transition cursor-pointer"
                        >
                          Valider
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Dernier ajout — annulation rapide locale (Ctrl+Z), réutilise removeFromCart */}
      {lastAddedItem && (
        <div className="px-2 pt-1 shrink-0" role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-1.5 bg-cyan-500/10 border border-cyan-500/30 rounded-lg px-2.5 py-1 text-[11px] animate-in fade-in motion-reduce:animate-none">
            <span className="min-w-0 truncate text-cyan-200">
              <span className="font-bold">Ajouté : </span>
              <span className="truncate" title={lastAddedItem.product.title}>
                {lastAddedItem.product.title} × {lastAddedItem.quantity}
              </span>
            </span>
            <button
              type="button"
              onClick={handleUndoLastAdded}
              title="Retirer le dernier article ajouté (Ctrl+Z)"
              className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-cyan-500/20 hover:bg-cyan-500/30 active:scale-95 text-cyan-200 text-[10px] font-bold border border-cyan-500/40 transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
            >
              <RotateCcw className="w-2.5 h-2.5" />
              <span>Annuler</span>
              <kbd className="hidden sm:inline font-mono text-[8.5px] bg-black/40 px-1 py-0.2 rounded border border-cyan-500/30">Ctrl+Z</kbd>
            </button>
          </div>
        </div>
      )}

      {/* Totals Summary & Compact Payment Controls — pied sticky : total toujours visible */}
      <div className="p-2 border-t border-pos-border bg-pos-panel space-y-1 shrink-0 sticky bottom-0 z-10 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.45)] [&_button]:focus-visible:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-emerald-500">
        {/* Customer Available Store Credit Quick Bar */}
        {currentCustomer && (currentCustomer.storeCredit || 0) > 0 && storeCreditApplied === 0 && total > 0 && !isRefundDue && (
          <div className="bg-purple-950/40 border border-purple-500/40 rounded-lg px-2 py-1 flex items-center justify-between text-xs animate-in fade-in">
            <div className="flex items-center gap-1.5 text-purple-200">
              <Gift className="w-3.5 h-3.5 text-purple-300 shrink-0" />
              <span className="text-[10px] font-bold">Avoir Dispo : <span className="font-mono text-purple-300 font-extrabold">{formatDZD(currentCustomer.storeCredit)}</span></span>
            </div>
            <button
              type="button"
              onClick={() => {
                const cartCogs = cart.reduce((acc, item) => {
                  const unitCost = item.unitCostAtSale ?? item.unitCostPrice ?? item.product?.costPrice ?? 0;
                  return acc + Math.max(0, Number(unitCost) || 0) * Math.abs(Number(item.quantity) || 0);
                }, 0);
                const { maxAllowedCredit } = calculateMaxAllowedCredit(
                  Math.max(0, subtotal - voucherCreditApplied),
                  cartCogs,
                  currentCustomer.storeCredit,
                  50
                );
                setStoreCreditApplied(maxAllowedCredit);
                if (maxAllowedCredit > 0) {
                  soundEngine.playSuccess();
                }
              }}
              className="px-2 py-0.5 bg-purple-600 hover:bg-purple-500 text-white rounded-md text-[9.5px] font-extrabold transition cursor-pointer"
            >
              Appliquer Avoir
            </button>
          </div>
        )}

        {/* Breakdown of Subtotal, Discounts and Store Credit if active */}
        {(totalDiscount > 0 || (storeCreditApplied || 0) > 0 || voucherCreditApplied > 0 || tradeInCreditApplied > 0) && (
          <div className="space-y-0.5 pb-1 border-b border-pos-border/40 text-[11px] font-mono">
            <div className="flex justify-between items-center text-pos-muted">
              <span className="text-[10.5px] font-sans font-semibold">Sous-Total Brut :</span>
              <span className="font-bold">{formatDZD(grossTotal)}</span>
            </div>
            {totalDiscount > 0 && (
              <div className="flex justify-between items-center text-purple-400 font-bold">
                <span className="text-[10.5px] font-sans flex items-center gap-1">
                  <Percent className="w-3 h-3" /> Remise Accordée :
                </span>
                <span>-{formatDZD(totalDiscount)}</span>
              </div>
            )}
            {(storeCreditApplied || 0) > 0 && (
              <div className="flex justify-between items-center text-emerald-400 font-bold">
                <span className="text-[10.5px] font-sans flex items-center gap-1">
                  <Gift className="w-3 h-3 text-purple-300" /> Avoir Client Déduit :
                </span>
                <span className="text-purple-300">-{formatDZD(storeCreditApplied)}</span>
              </div>
            )}
            {voucherCreditApplied > 0 && (
              <div className="flex justify-between items-center text-emerald-400 font-bold">
                <span className="text-[10.5px] font-sans flex items-center gap-1">
                  <Gift className="w-3 h-3 text-purple-300" /> Bon d&apos;Avoir{voucherCode ? ` (${voucherCode})` : ''} :
                </span>
                <span className="text-purple-300">-{formatDZD(voucherCreditApplied)}</span>
              </div>
            )}
            {tradeInCreditApplied > 0 && (
              <div className="flex justify-between items-center text-emerald-400 font-bold">
                <span className="text-[10.5px] font-sans flex items-center gap-1">
                  <RefreshCw className="w-3 h-3 text-emerald-300" /> Reprise Déduite :
                </span>
                <span className="text-emerald-300">-{formatDZD(tradeInCreditApplied)}</span>
              </div>
            )}
          </div>
        )}

        {/* Total Net Header — compact, prominent & single-line aligned */}
        <div className="flex justify-between items-center py-0.5">
          <div className="min-w-0 flex items-baseline gap-1.5">
            <span className={`text-xs font-black tracking-wider uppercase truncate ${isRefundDue ? 'text-rose-400' : 'text-pos-text'}`}>
              {isRefundDue
                ? 'Remboursement Dû'
                : (storeCreditApplied || 0) > 0 || tradeInCreditApplied > 0
                ? 'Net Restant'
                : 'Total Net'}
            </span>
            <span className="text-[9px] text-pos-muted font-mono shrink-0">
              {isRefundDue ? '(Espèces)' : '(TTC)'}
            </span>
          </div>
          <span
            data-testid="cart-total"
            aria-live="polite"
            aria-atomic="true"
            title={`Total net : ${isRefundDue ? `-${formatDZD(refundDue)}` : formatDZD(total)}`}
            className={`text-xl sm:text-2xl font-black tracking-tight font-mono shrink-0 ${isRefundDue ? 'text-rose-400' : 'text-emerald-400'}`}
          >
            {isRefundDue ? `-${formatDZD(refundDue)}` : formatDZD(total)}
          </span>
        </div>

        {/* Compact Quick Cash Denominations (Only active / relevant tenders) */}
        {cart.length > 0 && total > 0 && !isRefundDue && applicableQuickBills.length > 0 && (
          <div className="flex items-center gap-1.5 pt-0.5">
            <span className="text-[8.5px] text-pos-muted uppercase font-bold tracking-wider shrink-0">
              Espèces :
            </span>
            <div className="flex items-center gap-1 flex-1 overflow-x-auto hide-scrollbar">
              {applicableQuickBills.map((bill) => (
                <button
                  key={bill}
                  disabled={isProcessing}
                  onClick={() => handleQuickCashWithBill(bill)}
                  className="flex-1 py-0.5 px-1 rounded bg-pos-card hover:bg-emerald-500/20 border border-pos-border hover:border-emerald-500/50 text-pos-text hover:text-emerald-300 font-mono text-[9px] font-extrabold transition active:scale-95 cursor-pointer flex items-center justify-center gap-1"
                  title={`Encaisser ${bill} DA (Rendu: ${bill - total} DA)`}
                >
                  <span>{bill.toLocaleString('fr-DZ')}</span>
                  {bill > total && (
                    <span className="text-[7.5px] text-emerald-400 font-bold leading-none">+{bill - total}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Primary Cash Payment Button — compact, sleek enterprise UI */}
        <div className="pt-0.5">
          <button
            data-testid="checkout-button"
            onClick={() => openModal('payment')}
            disabled={cart.length === 0 || isProcessing}
            className={`w-full glow-btn disabled:opacity-40 text-white rounded-lg py-2 px-2.5 flex items-center justify-between shadow-sm group cursor-pointer transition active:scale-[0.98] ${
              isRefundDue
                ? 'bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 shadow-rose-600/20'
                : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-emerald-600/20'
            }`}
            title="Encaisser ou Rembourser en Espèces — F2 / Espace"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              {isRefundDue ? (
                <RotateCcw className="w-4 h-4 text-rose-200 shrink-0 animate-spin-reverse" />
              ) : (
                <Banknote className="w-4 h-4 text-emerald-200 shrink-0" />
              )}
              <span className="text-xs font-bold tracking-wide truncate">
                {isRefundDue ? `Rembourser Espèces (${formatDZD(refundDue)})` : 'Encaisser en Espèces'}
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <span className={`text-[8.5px] font-bold uppercase tracking-wider bg-black/25 px-1.5 py-0.5 rounded border border-white/10 ${isRefundDue ? 'text-rose-200' : 'text-emerald-200'}`}>
                {isRefundDue ? 'Rendu' : 'Cash Only'}
              </span>
              <Kbd size="sm" variant="accent" className="font-mono text-ui-2xs px-1.5 py-0.5 rounded-ui-xs font-black shrink-0">
                F2
              </Kbd>
            </div>
          </button>
        </div>
      </div>

      {/* Suggested Products Drawer (Collapsible) */}
      {recommendedProducts.length > 0 && (
        <div className="border-t border-pos-border bg-pos-panel/60 shrink-0">
          <button
            onClick={() => setIsSuggestionsOpen(!isSuggestionsOpen)}
            className="w-full px-3 py-1.5 flex items-center justify-between text-xs font-bold text-emerald-500 hover:bg-pos-card transition cursor-pointer"
          >
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              <span className="text-[10.5px] uppercase tracking-wide">Suggérés ({primaryModel})</span>
              <span className="bg-emerald-500/20 text-emerald-400 text-[10px] px-1.5 py-0.2 rounded-full font-bold">
                {recommendedProducts.length}
              </span>
            </div>
            {isSuggestionsOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>

          {isSuggestionsOpen && (
            <div className="p-2 pt-0 flex gap-2 overflow-x-auto pb-1.5 hide-scrollbar animate-in fade-in slide-in-from-bottom-2">
              {recommendedProducts.map((prod) => (
                <div
                  key={prod.id}
                  className="min-w-[130px] bg-pos-card border border-pos-border rounded-lg p-1.5 flex flex-col gap-1 shrink-0 hover:border-emerald-500/50 transition"
                >
                  <div className="flex items-start gap-1.5">
                    <div className="w-7 h-7 rounded bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0 text-emerald-400">
                      <Tag className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[9.5px] font-semibold text-pos-text truncate" title={prod.title}>
                        {prod.title}
                      </p>
                      <p className="text-[9.5px] font-bold text-pos-muted">{formatDZD(prod.price)}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => addToCart(prod)}
                    className="w-full py-0.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 text-[9.5px] font-bold rounded flex items-center justify-center gap-1 transition cursor-pointer"
                  >
                    <Plus className="w-2.5 h-2.5" /> Ajouter
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Return Manager PIN Gate Modal */}
      {returnPinPromptProductId && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-pos-card border border-pos-border rounded-2xl p-5 max-w-sm w-full space-y-4 shadow-2xl animate-in zoom-in-95">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-black text-pos-text flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-amber-400" />
                <span>Autorisation Retour / Échange</span>
              </h4>
              <button
                type="button"
                onClick={() => setReturnPinPromptProductId(null)}
                className="text-pos-muted hover:text-pos-text p-1 cursor-pointer"
                aria-label="Fermer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-pos-muted">
              Le basculement d'un article en mode Retour / Avoir client nécessite la validation par code PIN Manager.
            </p>
            {returnPinError && (
              <div className="p-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-bold">
                {returnPinError}
              </div>
            )}
            <div>
              <label className="text-[10px] font-bold uppercase text-pos-muted block mb-1">
                Code PIN Manager
              </label>
              <input
                type="password"
                autoFocus
                value={returnManagerPin}
                onChange={(e) => setReturnManagerPin(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void handleConfirmReturnPin();
                  }
                }}
                placeholder="••••"
                className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-center text-lg font-mono font-black text-pos-text focus:outline-none focus:border-amber-400"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setReturnPinPromptProductId(null)}
                className="flex-1 py-2 rounded-xl bg-pos-bg hover:bg-pos-hover text-pos-muted font-bold text-xs cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmReturnPin()}
                className="flex-1 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs cursor-pointer"
              >
                Autoriser
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Trash2, Plus, Minus, Tag, Banknote, Percent, ChevronDown, ChevronUp, Sparkles, Gift, Star, User, UserCheck, X, ShoppingBag, AlertTriangle, ArrowLeftRight, RotateCcw, Layers, RefreshCw, Pencil } from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import { formatDZD } from '../types/pos';
import type { PricingTier } from '../types/pos';
import { useToast } from './ui/Toast';
import { canRedeemPoints, normalizeLoyaltyConfig, isEarnAllowed, isRedeemAllowed } from '../utils/loyaltyEngine';
import { soundEngine } from '../utils/audioFeedback';
import { getProductPriceForTier } from '../utils/pricingEngine';
import { computeCartTotals, computeTradeInSettlement } from '../utils/receiptMath';
import { parseLocalizedAmount } from '../utils/moneyInput';
import { useFifoPreviewCosts } from '../hooks/useFifoPreviewCosts';
import { verifyManagerGate } from '../utils/pinGate';

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

  const [isDiscountOpen, setIsDiscountOpen] = useState(false);
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
  const [overridePriceInput, setOverridePriceInput] = useState<string>('');
  const [managerPinInput, setManagerPinInput] = useState<string>('');
  const [overrideError, setOverrideError] = useState<string | null>(null);
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
      vatRate,
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
  const vatRate =
    usePosStore((s) => (s.receiptSettings as unknown as { vatRate?: number } | undefined)?.vatRate ?? 0) || 0;

  const handleOpenPriceOverride = (item: typeof cart[0], e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingPriceProductId(item.product.id);
    const initialPrice = item.unitPriceCharged ?? item.appliedPrice ?? getItemPrice(item);
    setOverridePriceInput(String(initialPrice));
    setManagerPinInput('');
    setOverrideError(null);
  };

  const handleApplyPriceOverride = async (item: typeof cart[0], e: React.MouseEvent) => {
    e.stopPropagation();
    const newPrice = parseLocalizedAmount(overridePriceInput);
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

    soundEngine.playSuccess?.();
    setEditingPriceProductId(null);
    setOverridePriceInput('');
    setManagerPinInput('');
    setOverrideError(null);
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
    vatRate,
  });
  const grossTotal = totals.grossSubtotal;
  const totalDiscount = totals.discountTotal;
  const subtotal = totals.subtotalAfterDiscount;
  const total = totals.total;
  const taxTotal = totals.tax;
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

  // Realistic Algerian Cash Denominations (no 10,000 DA bill exists)
  const quickBills = [500, 1000, 2000, 3000, 4000, 5000];

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
    <div className="w-[340px] sm:w-[380px] md:w-[390px] max-w-[48vw] shrink-0 bg-pos-panel border-r border-pos-border flex flex-col h-full select-none transition-colors duration-200">
      {/* Cart Header & Pricing Tier Selector */}
      <div className="p-3 border-b border-pos-border space-y-2 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="font-bold text-sm text-pos-text tracking-wider uppercase">Vente en Cours</h2>
            <span className="bg-pos-card border border-pos-border text-emerald-500 text-xs font-bold px-2 py-0.5 rounded-full">
              {cart.reduce((acc, i) => acc + i.quantity, 0)} Articles
            </span>
          </div>
          {cart.length > 0 && (
            <div className="flex items-center gap-1">
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

        {/* Two-Way Exchange trigger / staged chip (Phase 2) */}
        {!stagedTradeIn ? (
          <button
            type="button"
            onClick={() => openTradeInExchange()}
            className="w-full min-h-[44px] px-3 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer active:scale-[0.99]"
          >
            <RefreshCw className="w-4 h-4 shrink-0" />
            Échanger un appareil (Trade-In)
          </button>
        ) : (
          <div className="bg-emerald-500/10 border border-emerald-500/40 rounded-xl p-2.5 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-extrabold uppercase tracking-wide text-emerald-300 flex items-center gap-1.5 min-w-0">
                <RefreshCw className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">Reprise : {stagedTradeIn.deviceModel}</span>
              </span>
              <span className="text-xs font-black text-emerald-300 whitespace-nowrap">−{formatDZD(tradeInCredit)}</span>
            </div>
            <p className="text-[10px] text-pos-muted font-mono truncate">IMEI/SN : {stagedTradeIn.imei}</p>
            {tradeInSettlement.direction === 'SOULTE_SHOP_PAYS' ? (
              <p className="text-[10px] font-bold text-amber-300">Soulte boutique : {formatDZD(tradeInSettlement.shopOwes)} à verser au client</p>
            ) : (
              // True totals net (all credits) — the trade-only delta would
              // disagree under stacked avoir/bon (same rule as PaymentModal).
              <p className="text-[10px] text-pos-muted">Reste à payer : {formatDZD(total)}</p>
            )}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => openTradeInExchange({ ...stagedTradeIn })}
                className="flex-1 min-h-[36px] px-2 rounded-lg bg-pos-card border border-pos-border text-pos-text text-[11px] font-bold flex items-center justify-center gap-1 hover:border-emerald-500/50 transition cursor-pointer"
              >
                <Pencil className="w-3 h-3" /> Modifier l’évaluation
              </button>
              <button
                type="button"
                onClick={() => {
                  clearStagedTradeIn();
                  showToast('Reprise retirée du panier.', 'info');
                }}
                className="flex-1 min-h-[36px] px-2 rounded-lg bg-pos-card border border-pos-border text-pos-muted hover:text-red-400 text-[11px] font-bold flex items-center justify-center gap-1 transition cursor-pointer"
              >
                <X className="w-3 h-3" /> Retirer
              </button>
            </div>
          </div>
        )}

        {/* Customer Badge & Loyalty Points Widget */}
        {currentCustomer ? (
          <div className="bg-pos-card border border-pos-border rounded-xl p-2.5 space-y-2 text-xs shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                {currentCustomer.avatarUrl ? (
                  <img
                    src={currentCustomer.avatarUrl}
                    alt={currentCustomer.name}
                    className="w-7 h-7 rounded-full object-cover border border-emerald-500/40 shrink-0"
                  />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 text-slate-950 font-black text-xs flex items-center justify-center shrink-0">
                    {currentCustomer.name.slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="font-black text-pos-text truncate text-xs">{currentCustomer.name}</p>
                  <p className="text-[10px] text-pos-muted truncate">
                    {currentCustomer.phone || currentCustomer.registeredDevice || 'Client Enregistré'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => openModal('customers')}
                  className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-md transition cursor-pointer"
                  title="Changer de Client (F3)"
                >
                  <User className="w-3.5 h-3.5 text-cyan-400" />
                </button>
                <button
                  type="button"
                  onClick={() => setCurrentCustomer(null)}
                  className="p-1 hover:bg-red-500/10 text-pos-muted hover:text-red-400 rounded-md transition cursor-pointer"
                  title="Détacher le client du panier"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Financial & Loyalty Pills (hidden when the program is fully off) */}
            <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
              {loyaltyVisible && (
                <span className="px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 font-bold flex items-center gap-1">
                  <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                  {currentCustomer.loyaltyPoints} pts
                </span>
              )}

              {(currentCustomer.storeCredit || 0) > 0 && (
                <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-bold font-mono">
                  Avoir: {formatDZD(currentCustomer.storeCredit)}
                </span>
              )}

              {(currentCustomer.storeCredit || 0) < 0 && (
                <span className="px-2 py-0.5 rounded-md bg-orange-500/15 border border-orange-500/30 text-orange-300 font-bold font-mono" title="Avoir consommé puis annulé — les prochains remboursements le comblent avant tout versement">
                  Solde à récupérer: {formatDZD(currentCustomer.storeCredit)}
                </span>
              )}

              {(currentCustomer.currentDebt || 0) > 0 && (
                <span className="px-2 py-0.5 rounded-md bg-rose-500/15 border border-rose-500/30 text-rose-300 font-bold font-mono">
                  Dette: {formatDZD(currentCustomer.currentDebt || 0)}
                </span>
              )}
            </div>

            {/* Point Conversion Button (hidden when redeem is off or points are cut) */}
            {loyaltyRedeemAllowed && loyaltyCfg.pointsEnabled !== false && currentCustomer.loyaltyPoints >= 10 && (
              <button
                type="button"
                onClick={() => void handleConvertPresetPoints()}
                className="w-full py-1 bg-gradient-to-r from-amber-500/20 to-yellow-500/20 hover:from-amber-500/30 hover:to-yellow-500/30 border border-amber-500/50 text-amber-300 font-black text-[11px] rounded-lg transition flex items-center justify-center gap-1.5 shadow-sm cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                <span>Convertir {pointConvertPreset} pts (+{formatDZD(pointConvertCredit)} d'Avoir)</span>
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => openModal('customers')}
            className="w-full py-2 bg-pos-card hover:bg-pos-hover border border-dashed border-pos-border hover:border-emerald-500/50 rounded-xl text-xs font-bold text-pos-muted hover:text-pos-text flex items-center justify-center gap-2 transition cursor-pointer"
          >
            <UserCheck className="w-4 h-4 text-emerald-400" />
            <span>+ Assigner un Client (F3)</span>
          </button>
        )}

        {/* Pricing Tier Selector (Retail / Demi-Gros / Wholesale) */}
        <div className="flex items-center gap-1.5 bg-pos-bg p-1 rounded-xl border border-pos-border">
          <Tag className="w-3.5 h-3.5 text-emerald-500 ml-1.5 shrink-0" />
          <span className="text-[10px] font-bold text-pos-muted uppercase">Tarif:</span>
          {(['Retail', 'VIP', 'Wholesale'] as PricingTier[]).map((tier) => (
            <button
              key={tier}
              type="button"
              onClick={() => setPricingTier(tier)}
              className={`flex-1 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
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
      </div>

      {/* Cart Items List */}
      <div
        ref={cartListRef}
        role="listbox"
        aria-label="Lignes du panier — les raccourcis clavier agissent ici uniquement"
        className="flex-1 overflow-y-auto p-2.5 space-y-2 [&_button]:focus-visible:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-emerald-500"
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
            <div className="w-full bg-pos-card border border-pos-border rounded-xl p-2.5 space-y-1.5 text-left text-[10.5px] shadow-sm">
              <div className="flex justify-between items-center py-0.5 border-b border-pos-border/40">
                <span className="text-pos-muted">Rechercher catalogue</span>
                <span className="font-mono font-bold text-pos-accent bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">F1 ou /</span>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-pos-border/40">
                <span className="text-pos-muted">Encaisser Espèces</span>
                <span className="font-mono font-bold text-pos-accent bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">F2 ou Espace</span>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-pos-border/40">
                <span className="text-pos-muted">Client / Dette / Fidélité</span>
                <span className="font-mono font-bold text-pos-accent-amber bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">F3</span>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-pos-border/40">
                <span className="text-pos-muted">Remise globale panier</span>
                <span className="font-mono font-bold text-pos-accent-purple bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">F4</span>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-pos-border/40">
                <span className="text-pos-muted">Mettre la vente en attente</span>
                <span className="font-mono font-bold text-pos-accent-cyan bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">F6</span>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-pos-border/40">
                <span className="text-pos-muted">Réimprimer dernier ticket</span>
                <span className="font-mono font-bold text-pos-accent-indigo bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">F7</span>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-pos-border/40">
                <span className="text-pos-muted">Guide des raccourcis</span>
                <span className="font-mono font-bold text-pos-accent-amber bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">F8</span>
              </div>
              <div className="flex justify-between items-center py-0.5">
                <span className="text-pos-muted">Quantité multiple au scan</span>
                <span className="font-mono font-bold text-pos-text bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">5*CODE</span>
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
                role="option"
                aria-selected={isSelected}
                tabIndex={0}
                onClick={(e) => {
                  setSelectedCartIndex(idx);
                  e.currentTarget.focus({ preventScroll: true });
                }}
                onFocus={() => setSelectedCartIndex(idx)}
                className={`bg-pos-card border rounded-xl p-2.5 flex items-start gap-2.5 transition motion-reduce:transition-none group cursor-pointer animate-in fade-in slide-in-from-top-2 motion-reduce:animate-none ${
                  isSelected
                    ? 'border-emerald-500 ring-2 ring-emerald-500/40 bg-emerald-500/[0.04]'
                    : item.isReturn
                    ? 'border-rose-500/40 bg-rose-500/[0.03] hover:border-rose-500/60'
                    : 'border-pos-border/80 hover:border-emerald-500/40'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-start gap-1">
                    <h3 className="text-xs font-semibold text-pos-text truncate leading-tight min-h-[1rem]" title={item.product.title}>
                      {item.product.title}
                    </h3>
                    <div className="text-right shrink-0">
                      {item.defaultPrice && item.unitPriceCharged !== undefined && item.unitPriceCharged < item.defaultPrice && (
                        <span className="text-[10px] text-pos-muted line-through mr-1 font-mono">
                          {formatDZD(item.defaultPrice * item.quantity)}
                        </span>
                      )}
                      <span className={`text-xs font-black pl-1 font-mono ${item.isReturn ? 'text-rose-400 font-bold' : 'text-pos-text'}`}>
                        {item.isReturn ? '-' : ''}{formatDZD(unitPrice * item.quantity - item.discount)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    {item.isReturn && (
                      <span className="text-[9px] bg-rose-500/20 text-rose-300 font-black px-1.5 py-0.5 rounded border border-rose-500/40 shrink-0 animate-pulse">
                        RETOUR / ÉCHANGE
                      </span>
                    )}
                    <span className="text-[10px] text-pos-muted truncate font-bold">{item.product.brand}</span>
                    {pricingTier === 'VIP' && (
                      <span className="text-[9px] bg-cyan-500/10 text-cyan-400 font-bold px-1 rounded border border-cyan-500/30 shrink-0">
                        Demi-Gros
                      </span>
                    )}
                    {pricingTier === 'Wholesale' && (
                      <span className="text-[9px] bg-amber-500/10 text-amber-500 font-bold px-1 rounded border border-amber-500/30 shrink-0">
                        Gros
                      </span>
                    )}
                    <span className="text-[9.5px] text-pos-muted font-mono truncate">Réf: {item.product.sku}</span>
                    {item.volumeTierApplied && (
                      <span className="text-[9px] bg-cyan-500/20 text-cyan-300 font-bold px-1.5 py-0.5 rounded border border-cyan-500/40 shrink-0 flex items-center gap-1 animate-in fade-in">
                        <Layers className="w-2.5 h-2.5" />
                        Offre Lot ({formatDZD(item.unitPriceCharged ?? unitPrice)}/u)
                      </span>
                    )}
                    {item.discountAmount !== undefined && item.discountAmount > 0 && !item.volumeTierApplied && (
                      <span className="text-[9px] bg-purple-500/15 text-purple-300 font-bold px-1 rounded border border-purple-500/30">
                        -{formatDZD(item.discountAmount)}/u
                      </span>
                    )}
                    {(() => {
                      // STRICT LEDGER: fresh lines show the FIFO preview only.
                      // A costPrice-derived badge printed 6,000/6,200 for a
                      // 6,100 cart — render pending (…) while unresolved.
                      // Lines with frozen checkout costs stay exact.
                      const previewCost = fifoPreviewCosts[idx];
                      const frozenCost = item.isReturn ? (item.unitCostAtSale ?? item.unitCostPrice) : undefined;
                      if (previewCost === undefined && frozenCost === undefined) {
                        return (
                          <span className="text-[9px] font-mono px-1 rounded border font-bold bg-pos-card text-pos-muted border-pos-border/60">
                            Marge: …
                          </span>
                        );
                      }
                      const cost = previewCost ?? frozenCost ?? 0;
                      const profit = (unitPrice - cost) * item.quantity;
                      const isLoss = profit < 0;
                      return (
                        <span
                          className={`text-[9px] font-mono px-1 rounded border font-bold ${
                            isLoss
                              ? 'bg-red-500/15 text-red-400 border-red-500/30'
                              : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          }`}
                        >
                          Marge: {isLoss ? '' : '+'}{formatDZD(profit)}
                        </span>
                      );
                    })()}
                  </div>

                  {/* Quantity Stepper & Actions */}
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-pos-border/40 gap-2">
                    <div className="flex items-center gap-1 bg-pos-bg border border-pos-border rounded-xl p-1 shadow-inner">
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
                        className="w-7 h-7 rounded-lg bg-pos-card hover:bg-pos-hover active:scale-95 text-pos-muted hover:text-pos-text border border-pos-border/60 flex items-center justify-center transition cursor-pointer"
                        title="Diminuer quantité (-1)"
                      >
                        <Minus className="w-3.5 h-3.5 stroke-[2.5]" />
                      </button>
                      <input
                        type="number"
                        id={`cart-qty-${item.product.id}`}
                        name={`cart-qty-${item.product.id}`}
                        min="1"
                        max={item.product.stock > 0 ? item.product.stock : 9999}
                        value={item.quantity}
                        disabled={item.product.isSerialized}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10);
                          if (!isNaN(val) && val >= 1) {
                            setCartItemQty(item.product.id, val);
                          }
                        }}
                        className="w-10 text-center text-xs font-black text-pos-text bg-transparent focus:bg-pos-card rounded-md border-none focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono py-0.5"
                        title={item.product.isSerialized ? '1 appareil par IMEI' : `Saisir quantité directement (Stock dispo: ${item.product.stock})`}
                      />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          soundEngine.playScan();
                          updateCartQty(item.product.id, 1);
                        }}
                        disabled={item.product.isSerialized}
                        className="w-7 h-7 rounded-lg bg-pos-card hover:bg-emerald-500/20 active:scale-95 text-pos-muted hover:text-emerald-400 border border-pos-border/60 flex items-center justify-center transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Augmenter quantité (+1)"
                      >
                        <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                      </button>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={(e) => handleOpenPriceOverride(item, e)}
                        className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer border ${
                          item.discountAmount && item.discountAmount > 0
                            ? 'bg-purple-500/20 text-purple-300 border-purple-500/40'
                            : 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 hover:text-amber-300 border-amber-500/30'
                        }`}
                        title="Modifier le prix de la ligne (Dérogation / Remise manuelle)"
                      >
                        <Tag className="w-3 h-3" />
                        <span>Prix</span>
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleCartItemReturn(item.product.id);
                        }}
                        className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer border ${
                          item.isReturn
                            ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                            : 'bg-pos-card hover:bg-pos-hover text-pos-muted hover:text-pos-text border-pos-border/60'
                        }`}
                        title={item.isReturn ? 'Annuler le mode retour' : 'Passer cet article en retour / échange client'}
                      >
                        <ArrowLeftRight className="w-3 h-3" />
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
                        className="flex items-center justify-center p-1.5 rounded-lg text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 hover:border-red-500/40 transition cursor-pointer shrink-0 active:scale-95"
                        title="Supprimer cet article de la vente"
                        aria-label="Supprimer cet article"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

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
                        <input
                          id={`price-override-${item.product.id}`}
                          type="number"
                          min="0"
                          value={overridePriceInput}
                          onChange={(e) => setOverridePriceInput(e.target.value)}
                          className="w-full bg-pos-card border border-pos-border rounded-lg px-2.5 py-1.5 font-mono font-bold text-pos-text text-xs focus:outline-none focus:border-amber-400"
                          placeholder="Ex: 3500"
                          autoFocus
                        />
                      </div>

                      {/* Live Margin & Discount Calculation */}
                      {(() => {
                        const p = parseLocalizedAmount(overridePriceInput) || 0;
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
        <div className="px-3 pt-2 shrink-0" role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-2 bg-cyan-500/10 border border-cyan-500/30 rounded-xl px-2.5 py-1.5 text-xs animate-in fade-in motion-reduce:animate-none">
            <span className="min-w-0 truncate text-cyan-200">
              <span className="font-bold">Dernier ajout : </span>
              <span className="truncate" title={lastAddedItem.product.title}>
                {lastAddedItem.product.title} × {lastAddedItem.quantity}
              </span>
            </span>
            <button
              type="button"
              onClick={handleUndoLastAdded}
              title="Retirer le dernier article ajouté (Ctrl+Z)"
              className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 active:scale-95 text-cyan-200 text-[11px] font-bold border border-cyan-500/40 transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Annuler</span>
              <kbd className="hidden sm:inline font-mono text-[9px] bg-black/40 px-1 py-0.2 rounded border border-cyan-500/30">Ctrl+Z</kbd>
            </button>
          </div>
        </div>
      )}

      {/* Totals Summary & Compact Payment Controls — pied sticky : total toujours visible */}
      <div className="p-3 border-t border-pos-border bg-pos-panel space-y-2 shrink-0 sticky bottom-0 z-10 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.45)] [&_button]:focus-visible:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-emerald-500">
        {/* Customer Available Store Credit Quick Bar */}
        {currentCustomer && (currentCustomer.storeCredit || 0) > 0 && storeCreditApplied === 0 && (
          <div className="bg-purple-950/40 border border-purple-500/40 rounded-xl px-2.5 py-1.5 flex items-center justify-between text-xs animate-in fade-in">
            <div className="flex items-center gap-1.5 text-purple-200">
              <Gift className="w-3.5 h-3.5 text-purple-300 shrink-0" />
              <span className="text-[10px] font-bold">Avoir Dispo : <span className="font-mono text-purple-300 font-extrabold">{formatDZD(currentCustomer.storeCredit)}</span></span>
            </div>
            <button
              type="button"
              onClick={() => {
                const maxCredit = Math.min(
                  currentCustomer.storeCredit,
                  Math.max(0, subtotal - voucherCreditApplied)
                );
                setStoreCreditApplied(maxCredit);
                soundEngine.playSuccess();
              }}
              className="px-2 py-0.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-[9.5px] font-extrabold transition cursor-pointer"
            >
              Appliquer Avoir
            </button>
          </div>
        )}

        {/* Breakdown of Subtotal, Discounts and Store Credit if active */}
        {(totalDiscount > 0 || (storeCreditApplied || 0) > 0 || voucherCreditApplied > 0 || tradeInCreditApplied > 0 || taxTotal > 0) && (
          <div className="space-y-1 pb-1.5 border-b border-pos-border/40 text-xs font-mono">
            <div className="flex justify-between items-center text-pos-muted">
              <span className="text-[11px] font-sans font-semibold">Sous-Total Brut :</span>
              <span className="font-bold">{formatDZD(grossTotal)}</span>
            </div>
            {totalDiscount > 0 && (
              <div className="flex justify-between items-center text-purple-400 font-bold">
                <span className="text-[11px] font-sans flex items-center gap-1">
                  <Percent className="w-3 h-3" /> Remise Accordée :
                </span>
                <span>-{formatDZD(totalDiscount)}</span>
              </div>
            )}
            {(storeCreditApplied || 0) > 0 && (
              <div className="flex justify-between items-center text-emerald-400 font-bold">
                <span className="text-[11px] font-sans flex items-center gap-1">
                  <Gift className="w-3 h-3 text-purple-300" /> Avoir Client Déduit :
                </span>
                <span className="text-purple-300">-{formatDZD(storeCreditApplied)}</span>
              </div>
            )}
            {voucherCreditApplied > 0 && (
              <div className="flex justify-between items-center text-emerald-400 font-bold">
                <span className="text-[11px] font-sans flex items-center gap-1">
                  <Gift className="w-3 h-3 text-purple-300" /> Bon d&apos;Avoir{voucherCode ? ` (${voucherCode})` : ''} :
                </span>
                <span className="text-purple-300">-{formatDZD(voucherCreditApplied)}</span>
              </div>
            )}
            {tradeInCreditApplied > 0 && (
              <div className="flex justify-between items-center text-emerald-400 font-bold">
                <span className="text-[11px] font-sans flex items-center gap-1">
                  <RefreshCw className="w-3 h-3 text-emerald-300" /> Reprise Déduite :
                </span>
                <span className="text-emerald-300">-{formatDZD(tradeInCreditApplied)}</span>
              </div>
            )}
            {taxTotal > 0 && (
              <div className="flex justify-between items-center text-cyan-300 font-bold">
                <span className="text-[11px] font-sans">TVA ({vatRate}%) :</span>
                <span>+{formatDZD(taxTotal)}</span>
              </div>
            )}
          </div>
        )}

        {/* Total Net Header - 1-Second Glance Dominance */}
        <div className="flex justify-between items-baseline pt-0.5">
          <div>
            <span className={`text-xs font-black tracking-wider uppercase block ${isRefundDue ? 'text-rose-400' : 'text-pos-text'}`}>
              {isRefundDue
                ? 'Remboursement Dû au Client'
                : (storeCreditApplied || 0) > 0 || tradeInCreditApplied > 0
                ? 'Net Restant à Payer'
                : 'Total Net à Payer'}
            </span>
            <span className="text-[10px] text-pos-muted font-medium">
              {isRefundDue ? 'Échange d\'articles • Espèces à rendre' : 'TTC • Rendu auto'}
            </span>
          </div>
          <span aria-live="polite" aria-atomic="true" title={`Total net : ${isRefundDue ? `-${formatDZD(refundDue)}` : formatDZD(total)}`} className={`text-2xl md:text-3xl font-black tracking-tight font-mono ${isRefundDue ? 'text-rose-400' : 'text-emerald-400'}`}>
            {isRefundDue ? `-${formatDZD(refundDue)}` : formatDZD(total)}
          </span>
        </div>

        {/* Compact Quick Cash Denominations (1-Click Change Calculator) */}
        {cart.length > 0 && total > 0 && !isRefundDue && (
          <div className="space-y-1">
            <span className="text-[9px] text-pos-muted uppercase font-bold tracking-wider block">
              Coupures Rapides (Espèces) :
            </span>
            <div className="grid grid-cols-6 gap-1">
              {quickBills.map((bill) => {
                const isUnder = bill < total;
                return (
                  <button
                    key={bill}
                    disabled={isUnder || isProcessing}
                    onClick={() => handleQuickCashWithBill(bill)}
                    className={`py-1.5 px-1 rounded-lg text-[9.5px] font-extrabold border transition active:scale-95 cursor-pointer flex flex-col items-center justify-center font-mono ${
                      isUnder
                        ? 'opacity-30 bg-pos-bg border-pos-border text-pos-muted cursor-not-allowed'
                        : 'bg-pos-card hover:bg-emerald-500/20 border-pos-border hover:border-emerald-500/50 text-pos-text hover:text-emerald-300'
                    }`}
                    title={isUnder ? 'Montant inférieur au total' : `Encaisser ${bill} DA (Rendu: ${bill - total} DA)`}
                  >
                    <span>{bill.toLocaleString('fr-DZ')}</span>
                    {!isUnder && bill > total && (
                      <span className="text-[8px] text-emerald-400 font-bold leading-none" title={`Rendu : ${bill - total} DA`}>+{bill - total}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Primary Cash Payment Button */}
        <div className="pt-0.5">
          <button
            onClick={() => openModal('payment')}
            disabled={cart.length === 0 || isProcessing}
            className={`w-full glow-btn disabled:opacity-40 text-white rounded-xl py-3 px-3 flex items-center justify-between shadow-md group cursor-pointer transition active:scale-[0.98] ${
              isRefundDue
                ? 'bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 shadow-rose-600/25'
                : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-emerald-600/25'
            }`}
            title="Encaisser ou Rembourser en Espèces - F2 / Espace"
          >
            <div className="flex items-center gap-2 min-w-0">
              {isRefundDue ? (
                <RotateCcw className="w-5 h-5 text-rose-200 shrink-0 animate-spin-reverse" />
              ) : (
                <Banknote className="w-5 h-5 text-emerald-200 shrink-0" />
              )}
              <span className="text-xs font-black tracking-wide truncate">
                {isRefundDue ? `Rembourser Espèces (${formatDZD(refundDue)})` : 'Encaisser en Espèces'}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className={`text-[9px] font-bold uppercase tracking-wider bg-black/30 px-1.5 py-0.5 rounded border border-white/10 ${isRefundDue ? 'text-rose-200' : 'text-emerald-200'}`}>
                {isRefundDue ? 'Rendu Espèces' : 'Cash Only'}
              </span>
              <span className="hotkey-badge bg-black/50 text-white border-white/20 px-2 py-0.5 text-[10px] font-black shrink-0">
                F2
              </span>
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
    </div>
  );
};

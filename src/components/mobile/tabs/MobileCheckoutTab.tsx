import React, { useState, useMemo } from 'react';
import {
  ShoppingBag,
  Trash2,
  Plus,
  Minus,
  User,
  CheckCircle2,
  Smartphone,
  Coins,
  CreditCard,
  X,
  Camera,
  Search,
  ArrowRight,
  Tag,
  Percent,
  AlertTriangle,
  PauseCircle,
  UserPlus,
  Printer,
  MessageSquare,
  Banknote,
  Delete,
  Check,
  RotateCcw,
  FileText,
  RefreshCw,
  Wallet,
  Pencil,
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import { AppTabContent } from '../AppScreenLayout';
import type { CartItem, Customer, PricingTier } from '../../../types/pos';
import { formatDZD } from '../../../types/pos';
import { getProductPriceForTier } from '../../../utils/pricingEngine';
import { computeCartTotals, computeTradeInSettlement } from '../../../utils/receiptMath';
import { toLegacyReal, dinarsToMinor } from '../../../utils/money';
import { MoneyInput } from '../../ui/MoneyInput';
import { DzPhoneInput } from '../../ui/DzPhoneInput';
import { useFifoPreviewCosts } from '../../../hooks/useFifoPreviewCosts';
import { soundEngine } from '../../../utils/audioFeedback';
import { useToast } from '../../ui/Toast';
import { MobileCameraScanner } from '../MobileCameraScanner';
import { getEffectiveDebtLimit } from '../../../store/slices/createCustomerSlice';
import { openWhatsApp } from '../../../utils/phoneUtils';
import { verifyManagerGate } from '../../../utils/pinGate';

interface MobileCheckoutTabProps {
  onNavigateToCatalog?: () => void;
}

export const MobileCheckoutTab: React.FC<MobileCheckoutTabProps> = ({ onNavigateToCatalog }) => {
  const {
    cart,
    removeFromCart,
    setCartItemQty,
    clearCart,
    pricingTier,
    setPricingTier,
    currentCustomer,
    setCurrentCustomer,
    customers,
    products,
    addToCart,
    processPayment,
    openModal,
    overrideCartItemPrice,
    // Phase 1: manager checks route through the native gate (no local
    // verifyManagerPin reads here — see utils/pinGate).
    heldSales,
    holdSale,
    storeCreditApplied,
    logSecurityAction,
    activeCashier,
    // Phase 2/3: two-way exchange staging (memory-only until checkout).
    stagedTradeIn,
    clearStagedTradeIn,
    openTradeInExchange,
    exchangeSoultePayout,
    setExchangeSoultePayout,
  } = usePosStore();
  // Same forensic rule as desktop: the signed-in operator's name, never a
  // hardcoded role; no unearned PIN flag on paths that verify nothing.
  const operatorName = activeCashier?.name?.trim() || 'Caissier';

  const { showToast } = useToast();
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Cash Tender Number Pad Sheet states
  const [isCashTenderOpen, setIsCashTenderOpen] = useState(false);
  const [tenderedStr, setTenderedStr] = useState<number>(0);
  const [isTenderDirty, setIsTenderDirty] = useState(false);

  // Post-Checkout Celebration & WhatsApp Receipt Sheet
  const [saleCelebrationData, setSaleCelebrationData] = useState<{
    receiptNumber: string;
    netTotal: number;
    tendered: number;
    changeDue: number;
    customerName?: string;
    customerPhone?: string;
    items: CartItem[];
  } | null>(null);
  const [whatsAppPhoneInput, setWhatsAppPhoneInput] = useState('');

  // Direct Quantity edit sheet
  const [editingQtyItem, setEditingQtyItem] = useState<CartItem | null>(null);
  const [customQtyInput, setCustomQtyInput] = useState('');

  // Line item price override & discount bottom sheet states
  const [editingItem, setEditingItem] = useState<CartItem | null>(null);
  const [overridePriceInput, setOverridePriceInput] = useState<number>(0);
  const [managerPinInput, setManagerPinInput] = useState<string>('');
  const [overrideError, setOverrideError] = useState<string | null>(null);

  // FIFO COGS preview (index-aligned with cart): the editor's cost/margin
  // must use oldest-first batch costs, not product.costPrice (latest cost).
  // Undefined while loading/failed → pending display, never a
  // costPrice-derived margin.
  const fifoPreviewCosts = useFifoPreviewCosts(cart);
  const editingCartIdx = editingItem
    ? cart.findIndex(
        (ci) => ci.product.id === editingItem.product.id && Boolean(ci.isReturn) === Boolean(editingItem.isReturn),
      )
    : -1;
  const editingFifoCost = editingCartIdx >= 0 ? fifoPreviewCosts[editingCartIdx] : undefined;

  // Cart Calculations — canonical computeCartTotals() base, shared with
  // CartPanel, PaymentModal and processPayment: signed return quantities,
  // store/voucher credits and VAT (no clamping of refunds to 0 here — a
  // negative net is a refund due, displayed as such below).
  const voucherCreditApplied =
    usePosStore((s) => (s as unknown as { voucherCreditApplied?: number }).voucherCreditApplied ?? 0) || 0;
  const vatRate =
    usePosStore((s) => (s.receiptSettings as unknown as { vatRate?: number } | undefined)?.vatRate ?? 0) || 0;
  // Exchange credit (1:1 buyback) as payment credit — never a cart line.
  const tradeInCredit = Math.max(0, Math.round(Number(stagedTradeIn?.buybackValue) || 0));
  const totals = computeCartTotals(cart, {
    pricingTier,
    storeCreditApplied,
    voucherCreditApplied,
    tradeInCredit,
    vatRate,
  });
  const grossSubtotal = totals.grossSubtotal;
  const totalDiscount = totals.discountTotal;
  const netTotal = totals.total;
  const taxTotal = totals.tax;
  const tradeInCreditApplied = totals.tradeInCreditApplied;
  const tradeSettlement = stagedTradeIn
    ? computeTradeInSettlement(totals.subtotalAfterDiscount, tradeInCredit)
    : null;
  const isSoulte = !!tradeSettlement && tradeSettlement.direction === 'SOULTE_SHOP_PAYS';
  const soulteDue = isSoulte && tradeSettlement ? tradeSettlement.shopOwes : 0;
  // Signed net (may be negative when returns dominate): shown as a refund
  // due instead of being clamped to 0. Tender logic still floors at 0.
  const signedNet = totals.net;
  // B-026: cash-out owed on net-negative carts; total/ttc is clamped to 0.
  const refundDue = totals.refundDue;

  // Smart Algerian Banknote Presets (500 DA, 1000 DA, 2000 DA, etc.)
  const smartBanknotes = useMemo(() => {
    if (netTotal <= 0) return [500, 1000, 2000, 5000];
    const presets = new Set<number>();
    presets.add(netTotal); // Exact

    const r500 = Math.ceil(netTotal / 500) * 500;
    if (r500 > netTotal) presets.add(r500);

    const r1000 = Math.ceil(netTotal / 1000) * 1000;
    if (r1000 > netTotal) presets.add(r1000);

    const r2000 = Math.ceil(netTotal / 2000) * 2000;
    if (r2000 > netTotal) presets.add(r2000);

    if (netTotal > 2000) {
      const r5000 = Math.ceil(netTotal / 5000) * 5000;
      if (r5000 > netTotal) presets.add(r5000);
    }

    [1000, 2000, 5000, 10000].forEach((n) => {
      if (n > netTotal) presets.add(n);
    });

    return Array.from(presets).sort((a, b) => a - b).slice(0, 5);
  }, [netTotal]);

  const handleQtyChange = (productId: string, newQty: number) => {
    soundEngine.playKeyBeep?.();
    if (newQty <= 0) {
      // Qty-to-zero removes the line: audit parity with desktop removal.
      const doomed = cart.find((i) => i.product.id === productId);
      if (doomed) {
        void logSecurityAction(
          'Suppression Article Panier (Mobile)',
          `Article: ${doomed.product.title} (${doomed.quantity} unités)`,
          operatorName,
          false,
        );
      }
      removeFromCart(productId);
    } else {
      setCartItemQty(productId, newQty);
    }
  };

  const handleRemove = (productId: string) => {
    soundEngine.playKeyBeep?.();
    const doomed = cart.find((i) => i.product.id === productId);
    if (doomed) {
      void logSecurityAction(
        'Suppression Article Panier (Mobile)',
        `Article: ${doomed.product.title} (${doomed.quantity} unités)`,
        operatorName,
        false,
      );
    }
    removeFromCart(productId);
  };

  const handleBarcodeScanned = (scannedCode: string) => {
    const raw = (scannedCode || '').trim();
    if (!raw) return;
    const code = raw.toLowerCase();
    const clean = raw.replace(/^\][A-Za-z0-9]{2}/, '').toLowerCase();
    const noLeadingZeros = clean.replace(/^0+/, '');

    const found = products.find((p) => {
      const b = (p.barcode || '').trim().toLowerCase();
      const s = (p.sku || '').trim().toLowerCase();
      return (
        b === code ||
        b === clean ||
        (noLeadingZeros.length > 0 && b === noLeadingZeros) ||
        s === code ||
        s === clean ||
        (noLeadingZeros.length > 0 && s === noLeadingZeros)
      );
    });

    if (found) {
      addToCart(found);
      soundEngine.playScan?.();
      showToast(`+ "${found.title}" ajouté`, 'success', 2000);
      setIsScannerOpen(false);
    } else {
      soundEngine.playError?.();
      showToast(`Article introuvable pour : ${scannedCode}`, 'warning');
    }
  };

  const handleOpenPriceOverride = (item: CartItem) => {
    soundEngine.playKeyBeep?.();
    const currentPrice = item.appliedPrice !== undefined ? item.appliedPrice : getProductPriceForTier(item.product, pricingTier);
    setEditingItem(item);
    setOverridePriceInput(currentPrice);
    setManagerPinInput('');
    setOverrideError(null);
  };

  const handleApplyPriceOverride = async () => {
    if (!editingItem) return;
    const newPrice = overridePriceInput;
    if (!Number.isFinite(newPrice) || newPrice < 0) {
      setOverrideError('Veuillez saisir un montant valide');
      soundEngine.playError?.();
      return;
    }

    const defaultPrice = editingItem.defaultPrice ?? editingItem.product.price ?? editingItem.appliedPrice;
    const unitCost = editingItem.unitCostAtSale ?? editingItem.unitCostPrice ?? editingItem.product.costPrice ?? 0;
    const isBelowCost = newPrice < unitCost;
    const discountPercent = defaultPrice > 0 ? ((defaultPrice - newPrice) / defaultPrice) * 100 : 0;
    const isHighDiscount = discountPercent > 20;

    let managerApproved = false;
    if (isBelowCost || isHighDiscount) {
      if (!managerPinInput) {
        setOverrideError(isBelowCost ? 'Vente à perte : Code PIN Manager requis' : 'Remise > 20% : Code PIN Manager requis');
        soundEngine.playError?.();
        return;
      }
      const gate = await verifyManagerGate(managerPinInput);
      if (!gate.ok) {
        setOverrideError(
          gate.locked
            ? `Verrouillé — réessayez dans ${Math.max(1, Math.ceil(gate.remainingMs / 1000))}s.`
            : 'Code PIN Manager incorrect.'
        );
        soundEngine.playError?.();
        return;
      }
      managerApproved = true;
    }

    const res = overrideCartItemPrice(editingItem.product.id, newPrice, managerApproved);
    if (!res.success) {
      setOverrideError(res.reason || 'Erreur lors de la modification du prix');
      soundEngine.playError?.();
      return;
    }

    soundEngine.playSuccess?.();
    showToast(`Prix mis à jour : ${formatDZD(newPrice)}`, 'success');
    setEditingItem(null);
    setOverridePriceInput(0);
    setManagerPinInput('');
    setOverrideError(null);
  };

  const handleOpenCashTender = () => {
    if (cart.length === 0 || isSubmitting) return;
    soundEngine.playKeyBeep?.();
    setTenderedStr(netTotal);
    setIsTenderDirty(false);
    setIsCashTenderOpen(true);
  };

  const handleConfirmCashTender = async () => {
    if (cart.length === 0 || isSubmitting) return;
    // Serialized units need their IMEI before any tender: without it
    // processPayment rejects deep in the lane. Per-line IMEI entry is
    // desktop-only for now — block here with an actionable message.
    const missingImei = cart.find((i) => i.product?.isSerialized && !(i.imeiNumber || '').trim());
    if (missingImei) {
      soundEngine.playError?.();
      showToast(
        `IMEI manquant : "${missingImei.product?.title || 'article sérialisé'}" exige son IMEI (saisie sur le terminal principal).`,
        'warning'
      );
      return;
    }
    // Tender-skew guard: rebuild the canonical net from LIVE store state at
    // submit time instead of trusting the render-time netTotal (paint can lag
    // the store between render and tap). Behavior otherwise unchanged.
    const live = usePosStore.getState();
    const liveVoucherCredit = Math.max(
      0,
      Math.round(Number((live as unknown as { voucherCreditApplied?: number }).voucherCreditApplied) || 0)
    );
    const liveVat = Math.max(
      0,
      Number((live.receiptSettings as unknown as { vatRate?: number } | undefined)?.vatRate) || 0
    );
    const liveStaged = live.stagedTradeIn;
    const liveTradeInCredit = Math.max(0, Math.round(Number(liveStaged?.buybackValue) || 0));
    const submitTotals = computeCartTotals(live.cart, {
      pricingTier: live.pricingTier,
      storeCreditApplied: live.storeCreditApplied,
      voucherCreditApplied: liveVoucherCredit,
      tradeInCredit: liveTradeInCredit,
      vatRate: liveVat,
    });
    const submitNet = submitTotals.total;
    const submitRefundDue = submitTotals.refundDue;
    const tendered = tenderedStr;
    // Soulte gate (slice enforces too): explicit payout choice required.
    const liveSettlement = liveStaged
      ? computeTradeInSettlement(submitTotals.subtotalAfterDiscount, liveTradeInCredit)
      : null;
    if (liveSettlement?.direction === 'SOULTE_SHOP_PAYS' && !live.exchangeSoultePayout) {
      soundEngine.playError?.();
      showToast('Soulte boutique : choisissez Décaisser Espèces ou Créditer Avoir.', 'error');
      return;
    }
    if (
      liveSettlement?.direction === 'SOULTE_SHOP_PAYS' &&
      live.exchangeSoultePayout === 'wallet' &&
      !live.currentCustomer
    ) {
      soundEngine.playError?.();
      showToast('Soulte vers Avoir : sélectionnez d’abord un client.', 'error');
      return;
    }

    // B-026: refund-due carts disburse cash-out with a zero cash-in tender.
    if (submitRefundDue > 0) {
      if (tendered > 0) {
        soundEngine.playError?.();
        showToast('Remboursement dû — aucun encaissement espèces requis.', 'warning');
        return;
      }
      setIsSubmitting(true);
      soundEngine.playKeyBeep?.();
      try {
        // Staged wallet credit rides as an explicit leg so the slice-side
        // refund math matches the displayed submitRefundDue (net of credit).
        // (A staged trade-in cannot produce refundDue — its leg is clamped —
        // so no Reprise leg rides here by design.)
        const mobileAvoirRefund = Math.max(0, Math.round(Number(live.storeCreditApplied) || 0));
        const res = (await processPayment([
          { method: 'Espèces', amount: 0 },
          ...(mobileAvoirRefund > 0 ? [{ method: 'Avoir Client' as const, amount: mobileAvoirRefund }] : []),
        ])) as unknown as { success: boolean; reason?: string; warnings?: string[] };
        if (res && res.success) {
          soundEngine.playSuccess?.();
          for (const w of res.warnings ?? []) showToast(w, 'warning', 5000);
          const lastTx = usePosStore.getState().lastTransaction;
          setSaleCelebrationData({
            receiptNumber: lastTx?.receiptNumber || 'OK',
            netTotal: submitNet,
            tendered: 0,
            changeDue: 0,
            customerName: currentCustomer?.name,
            customerPhone: currentCustomer?.phone,
            items: [...cart],
          });
          setWhatsAppPhoneInput(currentCustomer?.phone || '');
          setIsCashTenderOpen(false);
          showToast(`💵 Remboursement ${formatDZD(submitRefundDue)} effectué`, 'success');
        } else {
          soundEngine.playError?.();
          showToast(res?.reason || 'Échec du remboursement.', 'error');
        }
      } catch (e) {
        soundEngine.playError?.();
        showToast(e instanceof Error ? e.message : 'Erreur remboursement.', 'error');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (tendered < submitNet) {
      soundEngine.playError?.();
      showToast(`Montant insuffisant (${formatDZD(tendered)} < ${formatDZD(submitNet)})`, 'warning');
      return;
    }

    setIsSubmitting(true);
    soundEngine.playKeyBeep?.();

    try {
      // Persist the ACTUAL tendered amount (not the net): processPayment
      // derives and stores changeDue from it instead of dropping the change.
      // Staged wallet credit rides as an explicit leg (mirrors PaymentModal):
      // submitNet above is net of it, and tender-less staging aborts loudly
      // slice-side instead of charging past the displayed net. Reprise leg
      // LAST so paymentMethod keeps the money-leg semantics.
      const mobileAvoir = Math.max(0, Math.round(Number(live.storeCreditApplied) || 0));
      const res = (await processPayment([
        { method: 'Espèces', amount: tendered },
        ...(mobileAvoir > 0 ? [{ method: 'Avoir Client' as const, amount: mobileAvoir }] : []),
        ...(liveTradeInCredit > 0 ? [{ method: 'Reprise' as const, amount: liveTradeInCredit }] : []),
      ])) as unknown as { success: boolean; reason?: string; warnings?: string[]; recoveryQueued?: boolean };
      if (res && res.success) {
        soundEngine.playSuccess?.();
        for (const w of res.warnings ?? []) {
          showToast(w, 'warning', 5000);
        }
        const lastTx = usePosStore.getState().lastTransaction;
        // Prefer the persisted changeDue (covers credits/VAT rounding);
        // fall back to the local tendered − net difference.
        const persistedChange = lastTx ? lastTx.changeDue : undefined;
        const change = typeof persistedChange === 'number' ? persistedChange : Math.max(0, tendered - submitNet);
        setSaleCelebrationData({
          receiptNumber: lastTx?.receiptNumber || 'OK',
          netTotal: submitNet,
          tendered,
          changeDue: change,
          customerName: currentCustomer?.name,
          customerPhone: currentCustomer?.phone,
          items: [...cart],
        });
        setWhatsAppPhoneInput(currentCustomer?.phone || '');
        setIsCashTenderOpen(false);
      } else {
        soundEngine.playError?.();
        const reason = (res as unknown as { reason?: string } | undefined)?.reason;
        const recoveryQueued = (res as unknown as { recoveryQueued?: boolean }).recoveryQueued;
        if (reason === 'PERSISTENCE_FAILED' || (reason && reason.startsWith('PERSISTENCE_FAILED'))) {
          const detail = reason.includes(':') ? reason.slice('PERSISTENCE_FAILED:'.length) : '';
          console.error('[mobile checkout] persistence failed:', detail || reason);
          if (recoveryQueued) {
            for (const w of res.warnings ?? []) showToast(w, 'warning', 6000);
            showToast(
              `Écriture SQLite en échec — panier conservé. La vente sera reprise au démarrage.${detail ? ` (${detail})` : ''}`,
              'warning',
              6000
            );
          } else {
            showToast(
              `Erreur d'écriture base de données. Vente non enregistrée — panier conservé.${detail ? ` (${detail})` : ''}`,
              'error'
            );
          }
        } else {
          showToast(
            reason === 'NO_ACTIVE_SHIFT'
              ? "Aucun shift ouvert — ouvrez un shift avant d'encaisser."
              : reason && reason.startsWith('INSUFFICIENT_STOCK')
              ? `Stock insuffisant : ${reason.slice('INSUFFICIENT_STOCK:'.length)}`
              : reason && reason.startsWith('IMEI_ALREADY_SOLD')
              ? `IMEI déjà vendu : ${reason.slice('IMEI_ALREADY_SOLD:'.length)}`
              : reason === 'IMEI_REQUIRED' || reason === 'DUPLICATE_IMEI'
              ? 'IMEI invalide ou en double — vérifiez la saisie (terminal principal).'
              : reason === 'INSUFFICIENT_CASH'
              ? 'Encaissement insuffisant pour ce panier.'
              : reason === 'AVOIR_STAGING_DROPPED'
              ? "Avoir staged ignoré par sécurité — finalisez via l'écran d'encaissement principal."
              : reason === 'CREDIT_LIMIT_EXCEEDED'
              ? 'Plafond de crédit client dépassé.'
              : reason === 'LICENSE_SALE_BLOCKED'
              ? 'Licence expirée — nouvelles ventes bloquées (remboursements et rapports disponibles).'
              : reason && reason.startsWith('VOUCHER_')
              ? "Bon d'avoir invalide, expiré ou épuisé."
              : 'Erreur lors du paiement.',
            'error'
          );
        }
      }
    } catch (err) {
      console.error('Mobile checkout cash tender error:', err);
      soundEngine.playError?.();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCheckoutCredit = async () => {
    if (cart.length === 0 || isSubmitting) return;

    if (!currentCustomer) {
      setCustomerModalOpen(true);
      return;
    }

    const missingImeiCredit = cart.find((i) => i.product?.isSerialized && !(i.imeiNumber || '').trim());
    if (missingImeiCredit) {
      soundEngine.playError?.();
      showToast(
        `IMEI manquant : "${missingImeiCredit.product?.title || 'article sérialisé'}" exige son IMEI (saisie sur le terminal principal).`,
        'warning'
      );
      return;
    }

    // Same submit-time rebuild as the cash path: the credit tender must cover
    // the live net, not the painted one.
    const live = usePosStore.getState();
    const liveVoucherCredit = Math.max(
      0,
      Math.round(Number((live as unknown as { voucherCreditApplied?: number }).voucherCreditApplied) || 0)
    );
    const liveVat = Math.max(
      0,
      Number((live.receiptSettings as unknown as { vatRate?: number } | undefined)?.vatRate) || 0
    );
    const liveTradeInForCredit = Math.max(0, Math.round(Number(live.stagedTradeIn?.buybackValue) || 0));
    const submitNet = computeCartTotals(live.cart, {
      pricingTier: live.pricingTier,
      storeCreditApplied: live.storeCreditApplied,
      voucherCreditApplied: liveVoucherCredit,
      tradeInCredit: liveTradeInForCredit,
      vatRate: liveVat,
    }).total;

    const currentDebt = currentCustomer.currentDebt || 0;
    // Real ceiling: an absent per-customer limit resolves to the unified
    // default (never Infinity — an unbounded mobile credit sale is a hole).
    const debtLimit = getEffectiveDebtLimit(currentCustomer);
    if (currentDebt + submitNet > debtLimit) {
      alert(
        `Plafond de crédit dépassé pour ${currentCustomer.name} ! Dette actuelle : ${formatDZD(
          currentDebt
        )}, Plafond max : ${formatDZD(debtLimit)}`
      );
      soundEngine.playError?.();
      return;
    }

    setIsSubmitting(true);
    try {
      // Staged wallet credit rides as an explicit leg (mirrors PaymentModal):
      // submitNet above is net of it. Reprise leg LAST (linkage only).
      const mobileAvoirCredit = Math.max(0, Math.round(Number(live.storeCreditApplied) || 0));
      const res = (await processPayment([
        { method: 'Crédit Client', amount: submitNet },
        ...(mobileAvoirCredit > 0 ? [{ method: 'Avoir Client' as const, amount: mobileAvoirCredit }] : []),
        ...(liveTradeInForCredit > 0 ? [{ method: 'Reprise' as const, amount: liveTradeInForCredit }] : []),
      ])) as unknown as { success: boolean; reason?: string; warnings?: string[]; recoveryQueued?: boolean };
      if (res && res.success) {
        soundEngine.playSuccess?.();
        for (const w of res.warnings ?? []) {
          showToast(w, 'warning', 5000);
        }
        const lastTx = usePosStore.getState().lastTransaction;
        setSaleCelebrationData({
          receiptNumber: lastTx?.receiptNumber || 'OK',
          netTotal: submitNet,
          tendered: submitNet,
          changeDue: 0,
          customerName: currentCustomer.name,
          customerPhone: currentCustomer.phone,
          items: [...cart],
        });
        setWhatsAppPhoneInput(currentCustomer.phone || '');
      } else {
        soundEngine.playError?.();
        const reason = (res as unknown as { reason?: string } | undefined)?.reason;
        const recoveryQueued = (res as unknown as { recoveryQueued?: boolean }).recoveryQueued;
        if (reason === 'PERSISTENCE_FAILED' || (reason && reason.startsWith('PERSISTENCE_FAILED'))) {
          const detail = reason.includes(':') ? reason.slice('PERSISTENCE_FAILED:'.length) : '';
          console.error('[mobile credit] persistence failed:', detail || reason);
          if (recoveryQueued) {
            for (const w of res.warnings ?? []) showToast(w, 'warning', 6000);
            showToast(
              `Écriture SQLite en échec — panier conservé. La vente sera reprise au démarrage.${detail ? ` (${detail})` : ''}`,
              'warning',
              6000
            );
          } else {
            showToast(
              `Erreur d'écriture base de données. Vente non enregistrée — panier conservé.${detail ? ` (${detail})` : ''}`,
              'error'
            );
          }
        } else {
          showToast(
            reason === 'NO_ACTIVE_SHIFT'
              ? "Aucun shift ouvert — ouvrez un shift avant d'encaisser."
              : reason && reason.startsWith('INSUFFICIENT_STOCK')
              ? `Stock insuffisant : ${reason.slice('INSUFFICIENT_STOCK:'.length)}`
              : reason && reason.startsWith('IMEI_ALREADY_SOLD')
              ? `IMEI déjà vendu : ${reason.slice('IMEI_ALREADY_SOLD:'.length)}`
              : reason === 'IMEI_REQUIRED' || reason === 'DUPLICATE_IMEI'
              ? 'IMEI invalide ou en double — vérifiez la saisie (terminal principal).'
              : reason === 'CREDIT_LIMIT_EXCEEDED'
              ? 'Plafond de crédit client dépassé.'
              : reason === 'LICENSE_SALE_BLOCKED'
              ? 'Licence expirée — nouvelles ventes bloquées.'
              : reason && reason.startsWith('VOUCHER_')
              ? "Bon d'avoir invalide, expiré ou épuisé."
              : 'Erreur lors de la vente à crédit.',
            'error'
          );
        }
      }
    } catch (err) {
      console.error('Mobile credit sale error:', err);
      soundEngine.playError?.();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSendWhatsAppReceipt = async () => {
    if (!saleCelebrationData) return;
    const phone = whatsAppPhoneInput.trim();
    if (!phone) {
      showToast('Veuillez saisir un numéro de téléphone', 'warning');
      return;
    }
    const dateStr = new Date().toLocaleDateString('fr-DZ', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const itemsList = saleCelebrationData.items
      .map((i) => {
        // Charged line total from the frozen checkout fields — NOT a
        // recompute from catalog price (which ignores tier, per-line and
        // cart discounts, credits and VAT and would not reconcile with the
        // collected total below).
        const chargedUnit = i.unitPriceCharged ?? i.appliedPrice ?? i.product.price;
        const lineDiscount = i.discountAmount ?? i.discount ?? 0;
        return `• ${i.product.title} x${i.quantity} = ${formatDZD(
          Math.max(0, chargedUnit * i.quantity - lineDiscount)
        )}`;
      })
      .join('\n');

    const message = `🧾 *TICKET DE CAISSE - MOBIPOS*\n📅 Date: ${dateStr}\n🎫 Ticket N°: #${saleCelebrationData.receiptNumber}${
      saleCelebrationData.customerName ? `\n👤 Client: ${saleCelebrationData.customerName}` : ''
    }\n--------------------------------\n${itemsList}\n--------------------------------\n💰 *Total Payé: ${formatDZD(
      saleCelebrationData.netTotal
    )}*${
      saleCelebrationData.changeDue > 0
        ? `\n💵 Monnaie Rendue: ${formatDZD(saleCelebrationData.changeDue)}`
        : ''
    }\n\nMerci pour votre confiance ! 🙏`;

    soundEngine.playSuccess?.();
    await openWhatsApp(phone, message);
  };

  const handleApplyCustomQty = () => {
    if (!editingQtyItem) return;
    const parsed = parseInt(customQtyInput, 10);
    if (isNaN(parsed) || parsed < 0) {
      showToast('Quantité invalide', 'warning');
      return;
    }
    soundEngine.playKeyBeep?.();
    handleQtyChange(editingQtyItem.product.id, parsed);
    setEditingQtyItem(null);
    setCustomQtyInput('');
  };

  // Filtered customer list for modal
  const filteredCustomers = useMemo(() => {
    const q = customerSearch.trim().toLowerCase();
    if (!q) return customers || [];
    return (customers || []).filter(
      (c) => (c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(q)
    );
  }, [customers, customerSearch]);

  return (
    <>
      <AppTabContent
        pinnedTop={
          <div className="px-3.5 pt-3 pb-2.5 space-y-2.5 bg-pos-bg">
            {/* iOS-Style Segmented Pricing Tier Control */}
            <div className="flex items-center gap-1 bg-pos-panel/90 p-1 rounded-2xl border border-pos-border shadow-xs">
              {(['Retail', 'VIP', 'Wholesale'] as PricingTier[]).map((tier) => (
                <button
                  key={tier}
                  type="button"
                  onClick={() => setPricingTier(tier)}
                  className={`flex-1 py-1.5 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer min-h-[38px] ${
                    pricingTier === tier
                      ? 'bg-emerald-500 text-slate-950 font-black shadow-sm'
                      : 'text-pos-muted hover:text-pos-text'
                  }`}
                >
                  {tier === 'Retail' ? 'Détail' : tier === 'VIP' ? 'Demi-Gros' : 'Gros'}
                </button>
              ))}
            </div>

            {/* Customer Pill Card with One-Tap Selection & Clear */}
            <div className="bg-pos-card border border-pos-border rounded-2xl p-3 flex items-center justify-between gap-3 shadow-xs">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500/20 to-teal-500/10 border border-cyan-500/30 text-cyan-400 flex items-center justify-center shrink-0 font-bold text-xs">
                  {currentCustomer ? (
                    currentCustomer.name.slice(0, 2).toUpperCase()
                  ) : (
                    <User className="w-4 h-4" />
                  )}
                </div>
                <div className="min-w-0">
                  <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider block leading-none">
                    Client Assigné
                  </span>
                  <span className="text-xs font-black text-pos-text mt-1 block leading-tight truncate">
                    {currentCustomer ? currentCustomer.name : 'Client Comptoir (Anonyme)'}
                  </span>
                  {currentCustomer?.currentDebt ? (
                    <span className="text-[10px] font-bold text-amber-400 font-mono">
                      Créance : {formatDZD(currentCustomer.currentDebt)}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {currentCustomer && (
                  <button
                    type="button"
                    onClick={() => setCurrentCustomer(null)}
                    className="p-1.5 rounded-lg text-pos-muted hover:text-rose-400 transition cursor-pointer min-h-[36px] min-w-[36px] flex items-center justify-center"
                    title="Détacher le client"
                    aria-label="Détacher le client"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setCustomerSearch('');
                    setCustomerModalOpen(true);
                  }}
                  className="text-xs font-bold px-3 py-1.5 rounded-xl bg-pos-panel border border-pos-border text-cyan-400 hover:border-cyan-500 cursor-pointer min-h-[36px] transition active:scale-95"
                >
                  {currentCustomer ? 'Changer' : 'Sélectionner'}
                </button>
              </div>
            </div>
          </div>
        }
        pinnedBottom={
          cart.length > 0 ? (
            <div className="px-3.5 pb-2.5 pt-2 bg-pos-bg">
              <div
                className="bg-pos-card/95 backdrop-blur-md border border-pos-border rounded-2xl p-4 space-y-3 shadow-xl"
                aria-busy={isSubmitting}
              >
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between text-pos-muted">
                    <span>Sous-total Brut</span>
                    <span className="font-mono">{formatDZD(grossSubtotal)}</span>
                  </div>
                  {totalDiscount > 0 && (
                    <div className="flex justify-between text-emerald-400 font-medium">
                      <span>Remise Accordée</span>
                      <span className="font-mono">-{formatDZD(totalDiscount)}</span>
                    </div>
                  )}
                  {(storeCreditApplied || 0) > 0 && (
                    <div className="flex justify-between text-purple-300 font-medium">
                      <span>Avoir Client</span>
                      <span className="font-mono">-{formatDZD(storeCreditApplied)}</span>
                    </div>
                  )}
                  {voucherCreditApplied > 0 && (
                    <div className="flex justify-between text-purple-300 font-medium">
                      <span>Bon d&apos;Avoir</span>
                      <span className="font-mono">-{formatDZD(voucherCreditApplied)}</span>
                    </div>
                  )}
                  {tradeInCreditApplied > 0 && (
                    <div className="flex justify-between text-emerald-300 font-medium">
                      <span>Reprise Déduite</span>
                      <span className="font-mono">-{formatDZD(tradeInCreditApplied)}</span>
                    </div>
                  )}
                  {taxTotal > 0 && (
                    <div className="flex justify-between text-cyan-300 font-medium">
                      <span>TVA ({vatRate}%)</span>
                      <span className="font-mono">+{formatDZD(taxTotal)}</span>
                    </div>
                  )}
                  <div className="flex justify-between items-baseline pt-2 border-t border-pos-border text-pos-text">
                    <span className="text-xs font-black uppercase tracking-wider">
                      {refundDue > 0 || signedNet < 0 ? 'Remboursement Dû' : 'Total Net'}
                    </span>
                    {isSubmitting ? (
                      <span
                        aria-hidden="true"
                        className="inline-block h-8 w-28 rounded-lg bg-pos-panel border border-pos-border animate-pulse"
                      />
                    ) : (
                      <span
                        className={`text-2xl font-black font-mono tracking-tight ${
                          refundDue > 0 || signedNet < 0 ? 'text-rose-400' : 'text-emerald-400'
                        }`}
                      >
                        {refundDue > 0 || signedNet < 0
                          ? `-${formatDZD(refundDue > 0 ? refundDue : Math.abs(signedNet))}`
                          : formatDZD(netTotal)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Checkout Action Buttons — Ergonomic Bottom Dock */}
                <div className="grid grid-cols-2 gap-2.5 pt-1">
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={handleOpenCashTender}
                    className="py-3 px-3 min-h-[52px] rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 active-press text-slate-950 font-black text-xs sm:text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/25 transition cursor-pointer disabled:opacity-50"
                  >
                    <Coins className="w-4 h-4" />
                    <span>Espèces</span>
                  </button>

                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={handleCheckoutCredit}
                    className="py-3 px-3 min-h-[52px] rounded-xl bg-amber-500/15 border border-amber-500/30 hover:bg-amber-500/25 active-press text-amber-400 font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50 shadow-xs"
                  >
                    <CreditCard className="w-4 h-4" />
                    <span>Crédit Kredy</span>
                  </button>
                </div>
              </div>
            </div>
          ) : undefined
        }
        contentClassName="px-3.5 pb-4 select-none"
      >
        {/* Cart Header & Quick Action Bar */}
        <div className="space-y-2">
          {/* Résumé du total collant : reste visible au-dessus de la ligne de flottaison */}
          {/* Active exchange chip — compact swipeable, high-contrast delta */}
          {stagedTradeIn && (
            <div className="overflow-x-auto no-scrollbar -mx-0.5 px-0.5">
              <div className="bg-emerald-500/10 border border-emerald-500/40 rounded-xl px-3 py-2 flex items-center gap-2 min-w-max shadow-xs">
                <RefreshCw className="w-4 h-4 text-emerald-300 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] font-black text-emerald-200 truncate">
                    {stagedTradeIn.deviceModel} <span className="font-mono font-bold text-emerald-300/80">· {stagedTradeIn.imei}</span>
                  </p>
                  <p className="text-sm font-mono font-black text-emerald-300 tabular-nums leading-tight">
                    −{formatDZD(tradeInCredit)}
                    <span className="text-[10px] font-sans font-bold text-pos-muted"> → Reste {formatDZD(tradeSettlement ? (isSoulte ? 0 : tradeSettlement.customerOwes) : netTotal)}</span>
                    {isSoulte && tradeSettlement && (
                      <span className="text-[10px] font-sans font-bold text-amber-300"> · Soulte {formatDZD(tradeSettlement.shopOwes)} à verser</span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openTradeInExchange({ ...stagedTradeIn })}
                  className="ml-1 shrink-0 w-9 h-9 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg bg-pos-card border border-pos-border text-pos-text"
                  aria-label="Modifier l’évaluation"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    clearStagedTradeIn();
                    setExchangeSoultePayout(null);
                    showToast('Reprise retirée du panier.', 'info');
                  }}
                  className="shrink-0 w-9 h-9 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg bg-pos-card border border-pos-border text-pos-muted"
                  aria-label="Retirer la reprise"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
          {cart.length > 0 && (
            <div className="sticky top-0 z-10 bg-pos-bg/95 backdrop-blur-sm py-1.5 -mx-0.5 px-0.5">
              <div
                className="bg-pos-card border border-pos-border rounded-xl px-3 py-2 flex items-center justify-between shadow-xs"
                aria-live="polite"
              >
                <span className="text-[10px] font-black uppercase tracking-wider text-pos-muted">
                  {refundDue > 0 || signedNet < 0 ? 'Remboursement Dû' : 'Total Net'}
                </span>
                <span
                  className={`font-mono text-base font-black tabular-nums ${
                    refundDue > 0 || signedNet < 0 ? 'text-rose-400' : 'text-emerald-400'
                  }`}
                >
                  {refundDue > 0 || signedNet < 0
                    ? `-${formatDZD(refundDue > 0 ? refundDue : Math.abs(signedNet))}`
                    : formatDZD(netTotal)}
                </span>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between px-1 text-xs font-bold text-pos-muted">
            <span>Articles au Panier ({cart.length})</span>
            <div className="flex items-center gap-1.5 flex-wrap justify-end">
              {/* Recall Held Sales Button */}
              {heldSales.length > 0 && (
                <button
                  type="button"
                  onClick={() => openModal('hold')}
                  className="text-[11px] text-amber-400 hover:text-amber-300 font-bold flex items-center gap-1.5 cursor-pointer py-1 px-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 active:scale-95 transition min-h-[36px]"
                  title="Voir et reprendre les ventes en attente"
                >
                  <PauseCircle className="w-3.5 h-3.5" />
                  <span>En Attente</span>
                  <span className="w-4 h-4 rounded-full bg-amber-500 text-slate-950 text-[10px] font-black flex items-center justify-center">
                    {heldSales.length}
                  </span>
                </button>
              )}

              {/* Suspend Current Cart Button */}
              {cart.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const res = holdSale();
                    if (res && res.success) {
                      showToast('Vente mise en attente avec succès ! (Ticket sauvegardé)', 'success');
                    } else {
                      showToast('Impossible de suspendre la vente.', 'warning');
                    }
                  }}
                  className="text-[11px] text-amber-400 hover:text-amber-300 font-bold flex items-center gap-1 cursor-pointer py-1 px-2 rounded-xl bg-amber-500/10 border border-amber-500/20 active:scale-95 transition min-h-[36px]"
                  title="Suspendre le ticket actuel pour servir un autre client"
                >
                  <PauseCircle className="w-3.5 h-3.5" />
                  <span className="hidden xs:inline">Attente</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setIsScannerOpen(true)}
                className="text-[11px] text-cyan-400 hover:text-cyan-300 font-bold flex items-center gap-1 cursor-pointer py-1 px-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20 active:scale-95 transition min-h-[36px]"
              >
                <Camera className="w-3.5 h-3.5" /> Scanner
              </button>

              <button
                type="button"
                onClick={() => openModal('invoice_ingestion')}
                className="text-[11px] text-teal-400 hover:text-teal-300 font-bold flex items-center gap-1 cursor-pointer py-1 px-2.5 rounded-xl bg-teal-500/10 border border-teal-500/20 active:scale-95 transition min-h-[36px]"
                title="Scanner ou importer une facture fournisseur (Entrée en stock)"
              >
                <FileText className="w-3.5 h-3.5" /> Facture
              </button>

              {cart.length > 0 && (
                <button
                  type="button"
                  onClick={() => openModal('discount')}
                  className="text-[11px] text-purple-400 hover:text-purple-300 font-bold flex items-center gap-1 cursor-pointer py-1 px-2.5 rounded-xl bg-purple-500/10 border border-purple-500/20 active:scale-95 transition min-h-[36px]"
                  title="Appliquer une remise globale sur le panier"
                >
                  <Percent className="w-3.5 h-3.5" /> Remise
                </button>
              )}

              <button
                type="button"
                onClick={() => openTradeInExchange()}
                className="text-[11px] text-emerald-300 hover:text-emerald-200 font-bold flex items-center gap-1 cursor-pointer py-1 px-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 active:scale-95 transition min-h-[36px]"
                title="Échanger un appareil (Trade-In) — déduit du panier"
              >
                <RefreshCw className="w-3.5 h-3.5" /> + Ajouter Reprise
              </button>

              {cart.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const n = cart.reduce((a, i) => a + i.quantity, 0);
                    if (window.confirm(`Vider le panier (${n} article${n > 1 ? 's' : ''}) ? Cette action est irréversible.`)) {
                      // Audit parity with desktop full-clear ('Annulation
                      // Complète Panier'): honest operator + no PIN flag.
                      void logSecurityAction(
                        'Annulation Complète Panier (Mobile)',
                        `Panier vidé (${n} unités)`,
                        operatorName,
                        false,
                      );
                      clearCart();
                    }
                  }}
                  className="text-[11px] text-rose-400 hover:text-rose-300 flex items-center gap-1 cursor-pointer py-1 px-2 rounded-xl hover:bg-rose-500/10 transition min-h-[36px]"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Vider
                </button>
              )}
            </div>
          </div>

          {/* Empty Cart POS Onboarding Hero */}
          {cart.length === 0 ? (
            <div className="p-8 my-4 text-center bg-pos-panel/60 border border-dashed border-pos-border rounded-2xl flex flex-col items-center justify-center space-y-3">
              <div className="w-14 h-14 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center justify-center shadow-xs">
                <ShoppingBag className="w-7 h-7" />
              </div>
              <div>
                <h4 className="text-sm font-black text-pos-text">Votre panier est vide</h4>
                <p className="text-xs text-pos-muted mt-1">
                  Scannez un article ou ouvrez le catalogue pour commencer.
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-2 w-full max-w-xs pt-2">
                <button
                  type="button"
                  onClick={() => setIsScannerOpen(true)}
                  className="w-full min-h-[44px] px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:scale-95 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer shadow-md shadow-emerald-500/20"
                >
                  <Camera className="w-4 h-4" />
                  <span>Scanner un Code-Barres</span>
                </button>

                {onNavigateToCatalog && (
                  <button
                    type="button"
                    onClick={onNavigateToCatalog}
                    className="w-full min-h-[44px] px-4 py-2 rounded-xl bg-pos-card border border-pos-border hover:border-cyan-400 text-pos-text font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer"
                  >
                    <Search className="w-4 h-4 text-cyan-400" />
                    <span>Catalogue Articles</span>
                  </button>
                )}
              </div>
            </div>
          ) : (
            /* Cart Items Cards */
            cart.map((item: CartItem) => {
              const defaultPrice = item.defaultPrice ?? item.product.price;
              const unitPrice = item.appliedPrice !== undefined ? item.appliedPrice : getProductPriceForTier(item.product, pricingTier);
              const isOverridden = item.appliedPrice !== undefined && item.appliedPrice !== defaultPrice;
              const hasDiscount = (item.discount || 0) > 0;
              const itemTotal = unitPrice * item.quantity - (item.discount || 0);

              return (
                <div
                  key={item.product.id}
                  className="bg-pos-card border border-pos-border rounded-2xl p-3 flex items-center justify-between gap-3 shadow-xs hover:border-emerald-500/30 transition"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      {item.imeiNumber && (
                        <span className="p-0.5 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 shrink-0">
                          <Smartphone className="w-3 h-3" />
                        </span>
                      )}
                      <h4 className="text-xs font-bold text-pos-text truncate">
                        {item.product.title}
                      </h4>
                    </div>

                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <button
                        type="button"
                        onClick={() => handleOpenPriceOverride(item)}
                        className={`flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[11px] font-mono font-bold transition active:scale-95 cursor-pointer ${
                          isOverridden
                            ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                            : 'bg-pos-panel text-pos-text border-pos-border hover:border-amber-500/40'
                        }`}
                        title="Modifier le prix / accorder une remise"
                      >
                        <Tag className="w-3 h-3 text-amber-400 shrink-0" />
                        <span>{formatDZD(unitPrice)}</span>
                        {isOverridden && (
                          <span className="text-[9px] bg-amber-500/20 text-amber-300 font-bold px-1 rounded ml-0.5">
                            Modifié
                          </span>
                        )}
                      </button>

                      <span className="text-[10px] text-pos-muted font-mono">
                        × {item.quantity} = <strong className="text-pos-text font-black">{formatDZD(itemTotal)}</strong>
                      </span>

                      {hasDiscount && (
                        <span className="text-[9px] text-emerald-400 font-mono font-bold bg-emerald-500/10 px-1 rounded border border-emerald-500/20">
                          -{formatDZD(item.discount || 0)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Quantity Stepper with 40px hitboxes & Direct Qty Tap */}
                  <div className="flex items-center gap-1 shrink-0 bg-pos-panel border border-pos-border rounded-xl p-1">
                    <button
                      type="button"
                      onClick={() => handleQtyChange(item.product.id, item.quantity - 1)}
                      className="w-9 h-9 min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg bg-pos-card text-pos-muted hover:text-pos-text active-press cursor-pointer"
                      aria-label="Diminuer la quantité"
                    >
                      <Minus className="w-4 h-4" />
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        soundEngine.playKeyBeep?.();
                        setEditingQtyItem(item);
                        setCustomQtyInput(String(item.quantity));
                      }}
                      className="w-8 min-h-[40px] flex items-center justify-center text-center font-mono text-xs font-black text-pos-text hover:bg-pos-card rounded-lg transition active-press cursor-pointer tabular-nums"
                      title="Modifier la quantité directement"
                    >
                      {item.quantity}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleQtyChange(item.product.id, item.quantity + 1)}
                      className="w-9 h-9 min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg bg-pos-card text-emerald-400 hover:text-emerald-300 active-press cursor-pointer"
                      aria-label="Augmenter la quantité"
                    >
                      <Plus className="w-4 h-4" />
                    </button>

                    <button
                      type="button"
                      onClick={() => handleRemove(item.product.id)}
                      className="w-9 h-9 min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 active-press cursor-pointer ml-0.5"
                      title="Supprimer la ligne"
                      aria-label="Supprimer la ligne"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </AppTabContent>

      {/* Camera Barcode Scanner Modal */}
      {isScannerOpen && (
        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex flex-col p-3 pt-[max(0.75rem,var(--safe-top))] pb-[max(0.75rem,var(--safe-bottom))] animate-in fade-in">
          <div className="flex items-center justify-between pb-2 border-b border-white/10 text-white">
            <div className="flex items-center gap-2">
              <Camera className="w-5 h-5 text-emerald-400" />
              <h3 className="text-sm font-bold">Scanner un Article</h3>
            </div>
            <button
              type="button"
              onClick={() => setIsScannerOpen(false)}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-white/10 hover:bg-white/20 text-white transition cursor-pointer"
              aria-label="Fermer la caméra"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 my-2 overflow-hidden rounded-2xl relative">
            <MobileCameraScanner
              isActive={isScannerOpen}
              onScan={handleBarcodeScanned}
              mode="barcode"
            />
          </div>
        </div>
      )}

      {/* Bottom Sheet Customer Selection Modal */}
      {customerModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(1rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))]">
          <div className="bg-pos-panel border border-pos-border rounded-t-3xl sm:rounded-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[85vh] animate-in slide-in-from-bottom-5">
            {/* Sheet Handle */}
            <div className="w-12 h-1.5 bg-pos-border rounded-full mx-auto mt-2 sm:hidden" />

            <div className="p-3.5 border-b border-pos-border flex items-center justify-between gap-2">
              <h3 className="text-xs sm:text-sm font-black text-pos-text truncate min-w-0">
                Sélectionner un Client
              </h3>
              <button
                type="button"
                onClick={() => setCustomerModalOpen(false)}
                className="p-1 text-pos-muted hover:text-pos-text min-h-[40px] min-w-[40px] flex items-center justify-center shrink-0 rounded-lg hover:bg-pos-card cursor-pointer"
                aria-label="Fermer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Customer Search Bar & New Customer Action */}
            <div className="p-3 border-b border-pos-border bg-pos-card/50 flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                <input
                  type="text"
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="Rechercher par nom ou numéro..."
                  className="w-full min-h-[40px] bg-pos-card border border-pos-border rounded-xl pl-9 pr-8 py-1.5 text-xs text-pos-text placeholder-pos-muted focus:border-cyan-400 focus:outline-none"
                  autoFocus
                />
                {customerSearch && (
                  <button
                    type="button"
                    onClick={() => setCustomerSearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text text-xs p-1"
                  >
                    ✕
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setCustomerModalOpen(false);
                  openModal('customers');
                }}
                className="min-h-[40px] px-3 rounded-xl bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/25 font-bold text-xs flex items-center gap-1.5 shrink-0 transition active:scale-95 cursor-pointer"
                title="Créer un nouveau client (Fichier CRM)"
              >
                <UserPlus className="w-3.5 h-3.5" />
                <span className="hidden xs:inline">+ Nouveau</span>
              </button>
            </div>

            <div className="p-3 overflow-y-auto overscroll-contain space-y-1.5 flex-1 max-h-72">
              <button
                type="button"
                onClick={() => {
                  setCurrentCustomer(null);
                  setCustomerModalOpen(false);
                }}
                className="w-full min-h-[48px] text-left p-3 rounded-xl bg-pos-card border border-pos-border text-xs font-bold text-pos-muted hover:text-pos-text transition cursor-pointer flex items-center justify-between"
              >
                <span>Client Comptoir (Anonyme)</span>
                <ArrowRight className="w-3.5 h-3.5 text-pos-muted" />
              </button>

              {filteredCustomers.length === 0 ? (
                <div className="py-6 text-center text-xs text-pos-muted">
                  Aucun client trouvé pour "{customerSearch}".
                </div>
              ) : (
                filteredCustomers.map((c: Customer) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setCurrentCustomer(c);
                      setCustomerModalOpen(false);
                    }}
                    className="w-full min-h-[50px] text-left p-3 rounded-xl bg-pos-card border border-pos-border hover:border-cyan-400 flex items-center justify-between transition cursor-pointer"
                  >
                    <div className="min-w-0">
                      <span className="text-xs font-black text-pos-text block truncate">{c.name}</span>
                      <span className="text-[10px] text-pos-muted font-mono">{c.phone || 'Pas de numéro'}</span>
                    </div>
                    {c.currentDebt ? (
                      <span className="text-[11px] font-black text-amber-400 font-mono shrink-0 ml-2">
                        {formatDZD(c.currentDebt)}
                      </span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bottom Sheet Price Override & Line Discount Modal */}
      {editingItem && (
        <div 
          onClick={() => setEditingItem(null)}
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(1rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="bg-pos-panel border border-pos-border rounded-t-3xl sm:rounded-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh] shadow-2xl animate-in slide-in-from-bottom-5"
          >
            {/* Sheet Handle */}
            <div className="w-12 h-1.5 bg-pos-border rounded-full mx-auto my-2 sm:hidden shrink-0" />

            <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-amber-500/20 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0">
                  <Tag className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-xs sm:text-sm font-black text-pos-text truncate">
                    Modifier le Prix Unitaire
                  </h3>
                  <p className="text-[11px] text-pos-muted truncate">
                    {editingItem.product.title}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditingItem(null)}
                className="p-1.5 text-pos-muted hover:text-pos-text min-h-[40px] min-w-[40px] flex items-center justify-center shrink-0 rounded-lg hover:bg-pos-card cursor-pointer"
                aria-label="Fermer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3.5 overflow-y-auto overscroll-contain">
              {/* Product Info Pills */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border">
                  <span className="text-[10px] text-pos-muted uppercase font-bold block">Prix Standard</span>
                  <span className="font-mono font-black text-pos-text text-sm block mt-0.5">
                    {formatDZD(editingItem.defaultPrice ?? editingItem.product.price)}
                  </span>
                </div>
                <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border">
                  <span className="text-[10px] text-cyan-400 uppercase font-bold block">Coût FIFO Stock</span>
                  <span className="font-mono font-black text-cyan-300 text-sm block mt-0.5">
                    {(() => {
                      // Pending (…) until the FIFO preview resolves — never
                      // flash a costPrice-derived cost for fresh lines.
                      const known = editingFifoCost ?? editingItem.unitCostAtSale ?? editingItem.unitCostPrice;
                      return known === undefined ? '…' : formatDZD(known ?? editingItem.product.costPrice ?? 0);
                    })()}
                  </span>
                </div>
              </div>

              {/* Price Input Field */}
              <div>
                <label className="text-xs font-bold text-pos-text block mb-1">
                  Nouveau Prix Vendu (DA / unité) :
                </label>
                <div>
                  <MoneyInput
                    label="Nouveau Prix Vendu (DA / unité)"
                    valueMinor={dinarsToMinor(overridePriceInput || 0)}
                    onChangeMinor={(minor) => {
                      setOverridePriceInput(toLegacyReal(minor));
                      setOverrideError(null);
                    }}
                    placeholder="Saisir montant..."
                    className="w-full min-h-[48px] bg-pos-card border border-pos-border focus:border-amber-400 rounded-xl px-3 py-2 text-base font-mono font-black text-pos-text focus:outline-none shadow-xs"
                  />
                </div>
              </div>

              {/* Quick Discount Shortcut Chips */}
              <div className="space-y-1">
                <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider block">
                  Raccourcis Remise Rapide
                </span>
                <div className="grid grid-cols-5 gap-1.5">
                  {[5, 10, 15, 20].map((pct) => {
                    const def = editingItem.defaultPrice ?? editingItem.product.price;
                    const discounted = Math.round(def * (1 - pct / 100));
                    return (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => {
                          soundEngine.playKeyBeep?.();
                          setOverridePriceInput(discounted);
                          setOverrideError(null);
                        }}
                        className="py-2 rounded-xl bg-pos-card border border-pos-border hover:border-amber-500/40 text-amber-400 font-black text-[11px] min-h-[42px] transition cursor-pointer active:scale-95"
                      >
                        -{pct}%
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.playKeyBeep?.();
                      const def = editingItem.defaultPrice ?? editingItem.product.price;
                      setOverridePriceInput(def);
                      setOverrideError(null);
                    }}
                    className="py-2 rounded-xl bg-pos-card border border-pos-border hover:border-pos-text text-pos-muted hover:text-pos-text font-bold text-[10px] min-h-[42px] transition cursor-pointer active:scale-95"
                  >
                    Reset
                  </button>
                </div>
              </div>

              {/* Live Margin and Loss Calculations */}
              {(() => {
                const newPrice = overridePriceInput || 0;
                // STRICT LEDGER: displayed margin is FIFO-or-pending (never a
                // costPrice-derived number); the below-cost gate keeps the
                // conservative fallback so protection never sleeps.
                const costKnown = editingFifoCost !== undefined
                  || editingItem.unitCostAtSale !== undefined
                  || editingItem.unitCostPrice !== undefined;
                const cost = editingFifoCost ?? editingItem.unitCostAtSale ?? editingItem.unitCostPrice ?? editingItem.product.costPrice ?? 0;
                const def = editingItem.defaultPrice ?? editingItem.product.price;
                const profit = (newPrice - cost) * editingItem.quantity;
                const discount = Math.max(0, def - newPrice);
                const discountPct = def > 0 ? ((discount / def) * 100).toFixed(0) : '0';
                const isLoss = newPrice < cost;
                const isHighDisc = Number(discountPct) > 20;

                return (
                  <div className="space-y-2 pt-1">
                    <div className="flex justify-between items-center text-xs bg-pos-card p-2.5 rounded-xl border border-pos-border font-mono">
                      <span className="text-pos-muted">
                        Remise : -{formatDZD(discount)} ({discountPct}%)
                      </span>
                      <span className={isLoss ? 'text-rose-400 font-black' : 'text-emerald-400 font-black'}>
                        Marge : {costKnown ? (isLoss ? '' : '+') : ''}{costKnown ? formatDZD(profit) : '…'}
                      </span>
                    </div>

                    {(isLoss || isHighDisc) && (
                      <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl space-y-2">
                        <div className="flex items-center gap-2 text-rose-400 text-xs font-bold">
                          <AlertTriangle className="w-4 h-4 shrink-0" />
                          <span>
                            {isLoss ? 'Vente à perte (Marge négative)' : 'Remise exceptionnelle > 20%'} — PIN Requis
                          </span>
                        </div>
                        <input
                          type="password"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          autoComplete="current-password"
                          maxLength={8}
                          value={managerPinInput}
                          onChange={(e) => {
                            setManagerPinInput(e.target.value);
                            setOverrideError(null);
                          }}
                          placeholder="Code PIN Manager (ex: 1234)"
                          className="w-full min-h-[44px] bg-pos-card border border-rose-500/40 rounded-xl px-3 py-2 text-sm text-pos-text focus:outline-none text-center font-mono tracking-widest"
                        />
                      </div>
                    )}
                  </div>
                );
              })()}

              {overrideError && (
                <p className="text-xs text-rose-400 font-bold bg-rose-500/10 p-2.5 rounded-xl border border-rose-500/20">
                  {overrideError}
                </p>
              )}

              {/* Action Buttons */}
              <div className="grid grid-cols-2 gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingItem(null)}
                  className="min-h-[48px] rounded-xl bg-pos-card border border-pos-border text-pos-muted hover:text-pos-text font-bold text-xs active:scale-95 transition cursor-pointer"
                >
                  Annuler
                </button>
                <button
                  type="button"
                  onClick={handleApplyPriceOverride}
                  className="min-h-[48px] rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs active:scale-95 transition cursor-pointer shadow-md shadow-amber-500/20"
                >
                  Appliquer le Prix
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cash Tender & Change Due Number Pad Bottom Sheet */}
      {isCashTenderOpen && (
        <div
          onClick={() => setIsCashTenderOpen(false)}
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(1rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-pos-panel border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[92vh] shadow-2xl animate-in slide-in-from-bottom-5"
          >
            {/* Sheet Handle */}
            <div className="sheet-handle sm:hidden" />

            {/* Header */}
            <div className="px-4 py-3 border-b border-pos-border flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center justify-center">
                  <Banknote className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-pos-text">Encaissement Espèces</h3>
                  <p className="text-[11px] text-pos-muted">Calcul instantané de la monnaie à rendre</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsCashTenderOpen(false)}
                className="w-9 h-9 min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl bg-pos-card text-pos-muted hover:text-pos-text cursor-pointer"
                aria-label="Fermer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3 overflow-y-auto overscroll-contain">
              {/* Total Net & Change Due Display Card */}
              {(() => {
                const tenderedNum = tenderedStr;
                const changeDue = Math.max(0, tenderedNum - netTotal);
                const remainingDue = Math.max(0, netTotal - tenderedNum);
                const isExact = tenderedNum === netTotal;
                const isOver = tenderedNum > netTotal;

                return (
                  <div className="space-y-2">
                    {/* Primary Display */}
                    <div className="bg-pos-card border border-pos-border rounded-2xl p-3.5 space-y-2">
                      <div className="flex justify-between items-baseline text-xs text-pos-muted">
                        <span className="font-bold uppercase tracking-wider">Total Net à Payer</span>
                        <span className="text-lg font-mono font-black text-pos-text tabular-nums">
                          {formatDZD(netTotal)}
                        </span>
                      </div>

                      <div className="flex justify-between items-baseline pt-2 border-t border-pos-border">
                        <span className="text-xs font-bold text-pos-muted uppercase tracking-wider">Montant Reçu</span>
                        <span className="text-2xl font-mono font-black text-emerald-400 tabular-nums">
                          {formatDZD(tenderedNum)}
                        </span>
                      </div>
                    </div>

                    {/* Change Due or Remaining Due Banner */}
                    {isOver ? (
                      <div className="bg-emerald-500/15 border border-emerald-500/40 rounded-2xl p-3 flex items-center justify-between animate-in zoom-in-95">
                        <div className="flex items-center gap-2">
                          <Coins className="w-5 h-5 text-emerald-400 shrink-0" />
                          <div>
                            <span className="text-[10px] text-emerald-300 uppercase font-black tracking-wider block">
                              Monnaie à Rendre
                            </span>
                            <span className="text-xl font-mono font-black text-emerald-400 tabular-nums">
                              +{formatDZD(changeDue)}
                            </span>
                          </div>
                        </div>
                        <span className="text-[10px] bg-emerald-500/20 text-emerald-300 font-bold px-2 py-0.5 rounded-full">
                          Billet supérieur
                        </span>
                      </div>
                    ) : isExact ? (
                      <div className="bg-cyan-500/15 border border-cyan-500/40 rounded-2xl p-2.5 text-center text-xs font-bold text-cyan-300 animate-in zoom-in-95">
                        ✨ Compte Exact (Aucune monnaie à rendre)
                      </div>
                    ) : (
                      <div className="bg-amber-500/15 border border-amber-500/40 rounded-2xl p-3 flex items-center justify-between animate-in zoom-in-95">
                        <div>
                          <span className="text-[10px] text-amber-300 uppercase font-bold tracking-wider block">
                            Reste à Recevoir
                          </span>
                          <span className="text-lg font-mono font-black text-amber-400 tabular-nums">
                            {formatDZD(remainingDue)}
                          </span>
                        </div>
                        <span className="text-[10px] bg-amber-500/20 text-amber-300 font-bold px-2 py-0.5 rounded-full">
                          Insuffisant
                        </span>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Soulte Boutique selector (Net<0 exchange): explicit choice only */}
              {isSoulte && (
                <div className="bg-amber-500/10 border border-amber-500/40 rounded-2xl p-3 space-y-2">
                  <p className="text-xs font-black text-amber-200">
                    Soulte à verser : {formatDZD(soulteDue)} — choisissez le mode :
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={exchangeSoultePayout === 'cash'}
                      onClick={() => setExchangeSoultePayout('cash')}
                      className={`min-h-[48px] px-2 rounded-xl border text-[11px] font-black flex items-center justify-center gap-1.5 transition active:scale-[0.98] cursor-pointer ${
                        exchangeSoultePayout === 'cash'
                          ? 'bg-emerald-500 text-slate-950 border-emerald-400'
                          : 'bg-pos-card text-pos-text border-pos-border'
                      }`}
                    >
                      <Banknote className="w-4 h-4 shrink-0" /> Décaisser Espèces
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={exchangeSoultePayout === 'wallet'}
                      onClick={() => setExchangeSoultePayout('wallet')}
                      className={`min-h-[48px] px-2 rounded-xl border text-[11px] font-black flex items-center justify-center gap-1.5 transition active:scale-[0.98] cursor-pointer ${
                        exchangeSoultePayout === 'wallet'
                          ? 'bg-purple-500 text-white border-purple-400'
                          : 'bg-pos-card text-pos-text border-pos-border'
                      }`}
                    >
                      <Wallet className="w-4 h-4 shrink-0" /> Créditer Avoir
                    </button>
                  </div>
                </div>
              )}

              {/* Algerian Banknote Preset Quick-Chips */}
              <div className="space-y-1">
                <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider block">
                  Coupures & Billets Rapides (Dinar Algérien)
                </span>
                <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-1">
                  {smartBanknotes.map((preset) => {
                    const isSelected = tenderedStr === preset;
                    const isExact = preset === netTotal;

                    return (
                      <button
                        key={preset}
                        type="button"
                        aria-pressed={isSelected}
                        aria-label={isExact ? `Exact (${formatDZD(preset)}) — Montant exact` : `${formatDZD(preset)} — Encaisser`}
                        onClick={() => {
                          soundEngine.playKeyBeep?.();
                          setTenderedStr(preset);
                          setIsTenderDirty(true);
                        }}
                        className={`px-3 py-2 rounded-xl text-xs font-mono font-black shrink-0 transition active-press cursor-pointer border min-h-[44px] ${
                          isSelected
                            ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-md shadow-emerald-500/20'
                            : isExact
                            ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30 hover:bg-cyan-500/25'
                            : 'bg-pos-card text-pos-text border-pos-border hover:border-emerald-500/40'
                        }`}
                      >
                        {isExact ? `Exact (${formatDZD(preset)})` : formatDZD(preset)}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Touch Keypad (3x4 Grid) with >= 52px Hitboxes */}
              <div className="grid grid-cols-3 gap-2 pt-1">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      soundEngine.playKeyBeep?.();
                      const dNum = Number(d);
                      if (!isTenderDirty) {
                        setTenderedStr(dNum);
                        setIsTenderDirty(true);
                      } else {
                        setTenderedStr((prev) => (prev === 0 ? dNum : prev * 10 + dNum));
                      }
                    }}
                    className="min-h-[52px] rounded-2xl bg-pos-card border border-pos-border hover:border-pos-text/30 active-press text-lg font-mono font-bold text-pos-text flex items-center justify-center cursor-pointer shadow-xs"
                  >
                    {d}
                  </button>
                ))}

                {/* Row 4: Clear, 0, Backspace */}
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playKeyBeep?.();
                    setTenderedStr(0);
                    setIsTenderDirty(true);
                  }}
                  className="min-h-[52px] rounded-2xl bg-rose-500/10 border border-rose-500/20 hover:bg-rose-500/20 active-press text-rose-400 font-black text-sm flex items-center justify-center cursor-pointer"
                  title="Effacer"
                >
                  C
                </button>

                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playKeyBeep?.();
                    if (!isTenderDirty) {
                      setTenderedStr(0);
                      setIsTenderDirty(true);
                    } else {
                      setTenderedStr((prev) => (prev === 0 ? 0 : prev * 10));
                    }
                  }}
                  className="min-h-[52px] rounded-2xl bg-pos-card border border-pos-border hover:border-pos-text/30 active-press text-lg font-mono font-bold text-pos-text flex items-center justify-center cursor-pointer shadow-xs"
                >
                  0
                </button>

                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playKeyBeep?.();
                    setTenderedStr((prev) => Math.floor(prev / 10));
                    setIsTenderDirty(true);
                  }}
                  className="min-h-[52px] rounded-2xl bg-pos-card border border-pos-border hover:border-pos-text/30 active-press text-pos-muted hover:text-pos-text flex items-center justify-center cursor-pointer"
                  aria-label="Effacer un chiffre"
                >
                  <Delete className="w-5 h-5" />
                </button>
              </div>

              {/* Confirm Cash Tender Button */}
              <button
                type="button"
                disabled={isSubmitting || tenderedStr < netTotal}
                onClick={handleConfirmCashTender}
                className="w-full min-h-[54px] rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 active-press text-slate-950 font-black text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/25 transition cursor-pointer disabled:opacity-50 disabled:pointer-events-none mt-2"
              >
                <Check className="w-5 h-5 stroke-[2.5]" />
                <span>Confirmer l'Encaissement</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Post-Checkout Celebration & WhatsApp Share Sheet */}
      {saleCelebrationData && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(1rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none">
          <div className="bg-pos-panel border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[92vh] shadow-2xl animate-in slide-in-from-bottom-5">
            {/* Sheet Handle */}
            <div className="sheet-handle sm:hidden" />

            <div className="p-5 text-center space-y-3 overflow-y-auto overscroll-contain">
              {/* Success Icon */}
              <div className="w-16 h-16 rounded-3xl bg-emerald-500/15 border-2 border-emerald-500/30 text-emerald-400 flex items-center justify-center mx-auto shadow-md shadow-emerald-500/20">
                <CheckCircle2 className="w-9 h-9" />
              </div>

              <div>
                <h3 className="text-base font-black text-pos-text">Vente Encaissée avec Succès !</h3>
                <p className="text-xs text-pos-muted mt-0.5">
                  Ticket <strong className="text-pos-text font-mono">#{saleCelebrationData.receiptNumber}</strong>
                  {saleCelebrationData.customerName ? ` • ${saleCelebrationData.customerName}` : ''}
                </p>
              </div>

              {/* Monnaie Rendue HUD */}
              {saleCelebrationData.changeDue > 0 ? (
                <div className="bg-emerald-500/15 border border-emerald-500/40 rounded-2xl p-4 space-y-1">
                  <span className="text-[11px] font-black uppercase text-emerald-300 tracking-wider block">
                    Monnaie à Rendre au Client
                  </span>
                  <span className="text-3xl font-mono font-black text-emerald-400 tabular-nums block">
                    +{formatDZD(saleCelebrationData.changeDue)}
                  </span>
                  <span className="text-[11px] text-emerald-200/80">
                    Reçu {formatDZD(saleCelebrationData.tendered)} sur {formatDZD(saleCelebrationData.netTotal)}
                  </span>
                </div>
              ) : (
                <div className="bg-pos-card border border-pos-border rounded-2xl p-3 flex justify-between items-center text-xs">
                  <span className="text-pos-muted font-bold">Total Payé</span>
                  <span className="text-base font-mono font-black text-emerald-400">
                    {formatDZD(saleCelebrationData.netTotal)}
                  </span>
                </div>
              )}

              {/* WhatsApp Receipt Section */}
              <div className="bg-pos-card border border-pos-border rounded-2xl p-3.5 space-y-2.5 text-left">
                <div className="flex items-center gap-2 text-xs font-bold text-pos-text">
                  <MessageSquare className="w-4 h-4 text-emerald-400" />
                  <span>Envoyer le Ticket par WhatsApp</span>
                </div>

                <div className="relative">
                  <DzPhoneInput
                    value={whatsAppPhoneInput}
                    onChange={setWhatsAppPhoneInput}
                    placeholder="0550 12 34 56 ou +213..."
                    inputClassName="w-full min-h-[46px] bg-pos-panel border border-pos-border focus:border-emerald-400 rounded-xl px-3 py-2 text-xs font-mono text-pos-text focus:outline-none"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleSendWhatsAppReceipt}
                  className="w-full min-h-[46px] rounded-xl bg-emerald-600 hover:bg-emerald-500 active-press text-white font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer shadow-xs"
                >
                  <MessageSquare className="w-4 h-4" />
                  <span>Envoyer via WhatsApp</span>
                </button>
              </div>

              {/* Print & Reset Buttons */}
              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => openModal('receipt')}
                  className="min-h-[48px] rounded-xl bg-pos-card border border-pos-border hover:border-cyan-400 text-pos-text font-bold text-xs flex items-center justify-center gap-2 active-press transition cursor-pointer"
                >
                  <Printer className="w-4 h-4 text-cyan-400" />
                  <span>Imprimer Ticket</span>
                </button>

                <button
                  type="button"
                  onClick={() => setSaleCelebrationData(null)}
                  className="min-h-[48px] rounded-xl bg-cyan-500 hover:bg-cyan-400 active-press text-slate-950 font-black text-xs flex items-center justify-center gap-2 transition cursor-pointer shadow-md shadow-cyan-500/20"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>Nouvelle Vente</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quick Direct Quantity Modification Sheet */}
      {editingQtyItem && (
        <div
          onClick={() => setEditingQtyItem(null)}
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(1rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-pos-panel border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[85vh] shadow-2xl animate-in slide-in-from-bottom-5"
          >
            {/* Sheet Handle */}
            <div className="sheet-handle sm:hidden" />

            <div className="p-3.5 border-b border-pos-border flex items-center justify-between">
              <div>
                <h3 className="text-xs sm:text-sm font-black text-pos-text truncate max-w-[280px]">
                  Modifier la Quantité
                </h3>
                <p className="text-[11px] text-pos-muted truncate max-w-[280px]">
                  {editingQtyItem.product.title}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingQtyItem(null)}
                className="w-8 h-8 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg bg-pos-card text-pos-muted hover:text-pos-text cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3.5">
              {/* Numeric Input & Stepper Controls */}
              <div className="flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playKeyBeep?.();
                    setCustomQtyInput((prev) => String(Math.max(1, (parseInt(prev, 10) || 1) - 1)));
                  }}
                  className="w-12 h-12 rounded-2xl bg-pos-card border border-pos-border text-pos-text hover:border-pos-text active-press flex items-center justify-center cursor-pointer"
                  aria-label="Moins un"
                >
                  <Minus className="w-5 h-5" />
                </button>

                <div className="w-32">
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    value={customQtyInput}
                    onChange={(e) => setCustomQtyInput(e.target.value)}
                    className="w-full min-h-[52px] text-center font-mono font-black text-2xl bg-pos-card border-2 border-emerald-500/50 rounded-2xl text-pos-text focus:outline-none"
                    autoFocus
                  />
                </div>

                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playKeyBeep?.();
                    setCustomQtyInput((prev) => String((parseInt(prev, 10) || 0) + 1));
                  }}
                  className="w-12 h-12 rounded-2xl bg-pos-card border border-pos-border text-emerald-400 hover:border-emerald-400 active-press flex items-center justify-center cursor-pointer"
                  aria-label="Plus un"
                >
                  <Plus className="w-5 h-5" />
                </button>
              </div>

              {/* Quick Presets (+1, +5, +10, +25, +50, +100) */}
              <div className="space-y-1">
                <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider block">
                  Paliers Rapides
                </span>
                <div className="grid grid-cols-6 gap-1.5">
                  {[1, 5, 10, 20, 50, 100].map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => {
                        soundEngine.playKeyBeep?.();
                        setCustomQtyInput(String(val));
                      }}
                      className="py-2 rounded-xl bg-pos-card border border-pos-border hover:border-cyan-400 text-cyan-300 font-mono font-bold text-xs min-h-[40px] active-press cursor-pointer"
                    >
                      {val}
                    </button>
                  ))}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => setEditingQtyItem(null)}
                  className="min-h-[48px] rounded-xl bg-pos-card border border-pos-border text-pos-muted hover:text-pos-text font-bold text-xs active-press transition cursor-pointer"
                >
                  Annuler
                </button>
                <button
                  type="button"
                  onClick={handleApplyCustomQty}
                  className="min-h-[48px] rounded-xl bg-emerald-500 hover:bg-emerald-400 active-press text-slate-950 font-black text-xs transition cursor-pointer shadow-md shadow-emerald-500/20"
                >
                  Valider
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

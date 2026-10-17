import React, { useState, useMemo } from 'react';
import {
  ShoppingBag,
  Trash2,
  Plus,
  Minus,
  User,
  Smartphone,
  Coins,
  CreditCard,
  X,
  Camera,
  Search,
  Tag,
  Percent,
  AlertTriangle,
  PauseCircle,
  FileText,
  RefreshCw,
  Pencil,
  Gift,
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import { AppTabContent } from '../AppScreenLayout';
import { AccessorySuggestions } from '../../AccessorySuggestions';
import type { CartItem, Customer, PricingTier } from '../../../types/pos';
import { formatDZD } from '../../../types/pos';
import { resolveBaseUnitPrice, getVolumeBreakNudge } from '../../../utils/pricingEngine';
import { computeCartTotals, computeTradeInSettlement } from '../../../utils/receiptMath';
import { toLegacyReal, dinarsToMinor } from '../../../utils/money';
import { MoneyInput } from '../../ui/MoneyInput';
import { PinDialog } from '../../ui/PinDialog';
import { useTranslation, Bdi } from '../../../i18n';
import { useFifoPreviewCosts } from '../../../hooks/useFifoPreviewCosts';
import { useRegisterMobileBackHandler } from '../../../hooks/useMobileBackNavigation';
import { soundEngine } from '../../../utils/audioFeedback';
import { useToast } from '../../ui/Toast';
import { MobileCameraScanner } from '../MobileCameraScanner';
import { getEffectiveDebtLimit } from '../../../store/slices/createCustomerSlice';
import { calculateMaxAllowedCredit } from '../../../utils/loyaltyEngine';
import { openWhatsApp } from '../../../utils/phoneUtils';
import { verifyManagerGate } from '../../../utils/pinGate';
import { CustomerPickerSheet } from '../checkout/CustomerPickerSheet';
import { PriceOverrideSheet } from '../checkout/PriceOverrideSheet';
import { QuantityEditSheet } from '../checkout/QuantityEditSheet';
import { CashTenderSheet } from '../checkout/CashTenderSheet';
import { SaleCelebrationSheet, type SaleCelebrationData } from '../checkout/SaleCelebrationSheet';

interface MobileCheckoutTabProps {
  onNavigateToCatalog?: () => void;
}

export const MobileCheckoutTab: React.FC<MobileCheckoutTabProps> = ({ onNavigateToCatalog }) => {
  const { t } = useTranslation();
  const {
    cart,
    removeFromCart,
    setCartItemQty,
    clearCart,
    pricingTier,
    setPricingTier,
    currentCustomer,
    setCurrentCustomer,
    customerPriceBook,
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
    setStoreCreditApplied,
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
  // UPGRADE-04: manual pricing-tier switching is manager-gated — holds the
  // requested tier while the PIN dialog is open (null = closed).
  const [tierGateTarget, setTierGateTarget] = useState<PricingTier | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isClearCartConfirmOpen, setIsClearCartConfirmOpen] = useState(false);
  const [creditCeilingAlert, setCreditCeilingAlert] = useState<{
    customerName: string;
    currentDebt: number;
    debtLimit: number;
  } | null>(null);

  // Cash Tender Number Pad Sheet states
  const [isCashTenderOpen, setIsCashTenderOpen] = useState(false);
  const [tenderedStr, setTenderedStr] = useState<number>(0);
  const [isTenderDirty, setIsTenderDirty] = useState(false);

  // Cart Item Row Swipe Action State
  const [swipedItemId, setSwipedItemId] = useState<string | null>(null);

  // Post-Checkout Celebration & WhatsApp Receipt Sheet
  const [saleCelebrationData, setSaleCelebrationData] = useState<SaleCelebrationData | null>(null);
  const [whatsAppPhoneInput, setWhatsAppPhoneInput] = useState('');

  // Direct Quantity edit sheet
  const [editingQtyItem, setEditingQtyItem] = useState<CartItem | null>(null);
  const [customQtyInput, setCustomQtyInput] = useState('');

  // Line item price override & discount bottom sheet states
  const [editingItem, setEditingItem] = useState<CartItem | null>(null);
  const [overridePriceInput, setOverridePriceInput] = useState<number>(0);
  const [managerPinInput, setManagerPinInput] = useState<string>('');
  const [overrideError, setOverrideError] = useState<string | null>(null);

  // Register Android back button handlers for overlays managed directly here
  useRegisterMobileBackHandler(isScannerOpen, () => setIsScannerOpen(false), 'checkout-barcode-scanner');
  useRegisterMobileBackHandler(
    isClearCartConfirmOpen,
    () => setIsClearCartConfirmOpen(false),
    'checkout-clear-cart-confirm',
  );
  useRegisterMobileBackHandler(
    creditCeilingAlert !== null,
    () => setCreditCeilingAlert(null),
    'checkout-credit-ceiling-alert',
  );

  // FIFO COGS preview (index-aligned with cart): the editor's cost/margin
  // must use oldest-first batch costs, not product.costPrice (latest cost).
  // Undefined while loading/failed → pending display, never a
  // costPrice-derived margin.
  const fifoPreviewCosts = useFifoPreviewCosts(cart);
  const editingCartIdx = editingItem
    ? cart.findIndex(
        (ci) =>
          ci.product.id === editingItem.product.id &&
          Boolean(ci.isReturn) === Boolean(editingItem.isReturn),
      )
    : -1;
  const editingFifoCost = editingCartIdx >= 0 ? fifoPreviewCosts[editingCartIdx] : undefined;

  // Cart Calculations — canonical computeCartTotals() base, shared with
  // CartPanel, PaymentModal and processPayment: signed return quantities,
  // store/voucher credits and VAT (no clamping of refunds to 0 here — a
  // negative net is a refund due, displayed as such below).
  const voucherCreditApplied =
    usePosStore((s) => (s as unknown as { voucherCreditApplied?: number }).voucherCreditApplied ?? 0) || 0;
  // Exchange credit (1:1 buyback) as payment credit — never a cart line.
  const tradeInCredit = Math.max(0, Math.round(Number(stagedTradeIn?.buybackValue) || 0));
  const totals = computeCartTotals(cart, {
    pricingTier,
    storeCreditApplied,
    voucherCreditApplied,
    tradeInCredit,
    priceBookItems: customerPriceBook?.items ?? null,
  });
  const grossSubtotal = totals.grossSubtotal;
  const totalDiscount = totals.discountTotal;
  const netTotal = totals.total;
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

  // Smart Algerian Banknote Presets (200 DA, 500 DA, 1000 DA, 2000 DA, etc.)
  const smartBanknotes = useMemo(() => {
    if (netTotal <= 0) return [200, 500, 1000, 2000];
    const presets = new Set<number>();
    presets.add(netTotal); // Exact

    const r200 = Math.ceil(netTotal / 200) * 200;
    if (r200 > netTotal) presets.add(r200);

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

    [200, 500, 1000, 2000, 5000, 10000].forEach((n) => {
      if (n >= netTotal) presets.add(n);
    });

    return Array.from(presets)
      .sort((a, b) => a - b)
      .slice(0, 6);
  }, [netTotal]);

  const handleQtyChange = (productId: string, newQty: number) => {
    soundEngine.playKeyBeep?.();
    const targetItem = cart.find((i) => i.product.id === productId);
    if (newQty > (targetItem?.quantity ?? 0) && targetItem?.product?.isSerialized) {
      soundEngine.playError?.();
      showToast('Appareil sérialisé : limité à 1 unité par IMEI', 'warning');
      return;
    }
    if (newQty <= 0) {
      if (targetItem) {
        void logSecurityAction(
          'Suppression Article Panier (Mobile)',
          `Article: ${targetItem.product.title} (${targetItem.quantity} unités)`,
          operatorName,
          false,
        );
      }
      if (swipedItemId === productId) setSwipedItemId(null);
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
    if (swipedItemId === productId) setSwipedItemId(null);
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
    const currentPrice =
      item.appliedPrice !== undefined
        ? item.appliedPrice
        : resolveBaseUnitPrice(item.product, pricingTier, item.quantity, customerPriceBook?.items ?? null);
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

    const defaultPrice =
      editingItem.defaultPrice ?? editingItem.product.price ?? editingItem.appliedPrice;
    const unitCost =
      editingItem.unitCostAtSale ?? editingItem.unitCostPrice ?? editingItem.product.costPrice ?? 0;
    const isBelowCost = newPrice < unitCost;
    const discountPercent = defaultPrice > 0 ? ((defaultPrice - newPrice) / defaultPrice) * 100 : 0;
    const isHighDiscount = discountPercent > 20;

    let managerApproved = false;
    if (isBelowCost || isHighDiscount) {
      if (!managerPinInput) {
        setOverrideError(
          isBelowCost
            ? 'Vente à perte : Code PIN Manager requis'
            : 'Remise > 20% : Code PIN Manager requis',
        );
        soundEngine.playError?.();
        return;
      }
      const gate = await verifyManagerGate(managerPinInput);
      if (!gate.ok) {
        setOverrideError(
          gate.locked
            ? `Verrouillé — réessayez dans ${Math.max(1, Math.ceil(gate.remainingMs / 1000))}s.`
            : 'Code PIN Manager incorrect.',
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
    const missingImei = cart.find((i) => i.product?.isSerialized && !(i.imeiNumber || '').trim());
    if (missingImei) {
      soundEngine.playError?.();
      showToast(
        `IMEI manquant : "${missingImei.product?.title || 'article sérialisé'}" exige son IMEI (saisie sur le terminal principal).`,
        'warning',
      );
      return;
    }
    const live = usePosStore.getState();
    const liveVoucherCredit = Math.max(
      0,
      Math.round(Number((live as unknown as { voucherCreditApplied?: number }).voucherCreditApplied) || 0),
    );
    const liveStaged = live.stagedTradeIn;
    const liveTradeInCredit = Math.max(0, Math.round(Number(liveStaged?.buybackValue) || 0));
    const submitTotals = computeCartTotals(live.cart, {
      pricingTier: live.pricingTier,
      storeCreditApplied: live.storeCreditApplied,
      voucherCreditApplied: liveVoucherCredit,
      tradeInCredit: liveTradeInCredit,
    });
    const submitNet = submitTotals.total;
    const submitRefundDue = submitTotals.refundDue;
    const tendered = tenderedStr;
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

    if (submitRefundDue > 0) {
      if (tendered > 0) {
        soundEngine.playError?.();
        showToast('Remboursement dû — aucun encaissement espèces requis.', 'warning');
        return;
      }
      setIsSubmitting(true);
      soundEngine.playKeyBeep?.();
      try {
        const mobileAvoirRefund = Math.max(0, Math.round(Number(live.storeCreditApplied) || 0));
        const res = (await processPayment([
          { method: 'Espèces', amount: 0 },
          ...(mobileAvoirRefund > 0
            ? [{ method: 'Avoir Client' as const, amount: mobileAvoirRefund }]
            : []),
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
      const mobileAvoir = Math.max(0, Math.round(Number(live.storeCreditApplied) || 0));
      const res = (await processPayment([
        { method: 'Espèces', amount: tendered },
        ...(mobileAvoir > 0 ? [{ method: 'Avoir Client' as const, amount: mobileAvoir }] : []),
        ...(liveTradeInCredit > 0 ? [{ method: 'Reprise' as const, amount: liveTradeInCredit }] : []),
      ])) as unknown as {
        success: boolean;
        reason?: string;
        warnings?: string[];
        recoveryQueued?: boolean;
      };
      if (res && res.success) {
        soundEngine.playSuccess?.();
        for (const w of res.warnings ?? []) {
          showToast(w, 'warning', 5000);
        }
        const lastTx = usePosStore.getState().lastTransaction;
        const persistedChange = lastTx ? lastTx.changeDue : undefined;
        const change =
          typeof persistedChange === 'number' ? persistedChange : Math.max(0, tendered - submitNet);
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
              6000,
            );
          } else {
            showToast(
              `Erreur d'écriture base de données. Vente non enregistrée — panier conservé.${detail ? ` (${detail})` : ''}`,
              'error',
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
              : reason && (reason.startsWith('DEVICE_BLOQUE') || reason.startsWith('INTAKE_BLOQUE'))
              ? `Appareil bloqué — vente refusée. Débloquez depuis l'Inspecteur IMEI.`
              : reason && reason.startsWith('DEVICE_CHECK_UNAVAILABLE')
              ? 'Vérification appareil indisponible — vente refusée.'
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
            'error',
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
        'warning',
      );
      return;
    }

    const live = usePosStore.getState();
    const liveVoucherCredit = Math.max(
      0,
      Math.round(Number((live as unknown as { voucherCreditApplied?: number }).voucherCreditApplied) || 0),
    );
    const liveTradeInForCredit = Math.max(0, Math.round(Number(live.stagedTradeIn?.buybackValue) || 0));
    const submitNet = computeCartTotals(live.cart, {
      pricingTier: live.pricingTier,
      storeCreditApplied: live.storeCreditApplied,
      voucherCreditApplied: liveVoucherCredit,
      tradeInCredit: liveTradeInForCredit,
    }).total;

    const currentDebt = currentCustomer.currentDebt || 0;
    const debtLimit = getEffectiveDebtLimit(currentCustomer);
    if (currentDebt + submitNet > debtLimit) {
      setCreditCeilingAlert({
        customerName: currentCustomer.name,
        currentDebt,
        debtLimit,
      });
      showToast(
        `Plafond de crédit dépassé pour ${currentCustomer.name} ! Dette actuelle : ${formatDZD(
          currentDebt,
        )}, Plafond max : ${formatDZD(debtLimit)}`,
        'error',
        5000,
      );
      soundEngine.playError?.();
      return;
    }

    setIsSubmitting(true);
    try {
      const mobileAvoirCredit = Math.max(0, Math.round(Number(live.storeCreditApplied) || 0));
      const res = (await processPayment([
        { method: 'Crédit Client', amount: submitNet },
        ...(mobileAvoirCredit > 0 ? [{ method: 'Avoir Client' as const, amount: mobileAvoirCredit }] : []),
        ...(liveTradeInForCredit > 0 ? [{ method: 'Reprise' as const, amount: liveTradeInForCredit }] : []),
      ])) as unknown as {
        success: boolean;
        reason?: string;
        warnings?: string[];
        recoveryQueued?: boolean;
      };
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
              6000,
            );
          } else {
            showToast(
              `Erreur d'écriture base de données. Vente non enregistrée — panier conservé.${detail ? ` (${detail})` : ''}`,
              'error',
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
              : reason && (reason.startsWith('DEVICE_BLOQUE') || reason.startsWith('INTAKE_BLOQUE'))
              ? `Appareil bloqué — vente refusée. Débloquez depuis l'Inspecteur IMEI.`
              : reason && reason.startsWith('DEVICE_CHECK_UNAVAILABLE')
              ? 'Vérification appareil indisponible — vente refusée.'
              : reason === 'IMEI_REQUIRED' || reason === 'DUPLICATE_IMEI'
              ? 'IMEI invalide ou en double — vérifiez la saisie (terminal principal).'
              : reason === 'CREDIT_LIMIT_EXCEEDED'
              ? 'Plafond de crédit client dépassé.'
              : reason === 'LICENSE_SALE_BLOCKED'
              ? 'Licence expirée — nouvelles ventes bloquées.'
              : reason && reason.startsWith('VOUCHER_')
              ? "Bon d'avoir invalide, expiré ou épuisé."
              : 'Erreur lors de la vente à crédit.',
            'error',
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

  const handleCheckoutTender = async (method: 'CIB / Edahabia' | 'BaridiMob' | 'Chèque') => {
    if (cart.length === 0 || isSubmitting) return;

    const missingImei = cart.find((i) => i.product?.isSerialized && !(i.imeiNumber || '').trim());
    if (missingImei) {
      soundEngine.playError?.();
      showToast(
        `IMEI manquant : "${missingImei.product?.title || 'article sérialisé'}" exige son IMEI.`,
        'warning',
      );
      return;
    }

    const live = usePosStore.getState();
    const liveVoucherCredit = Math.max(
      0,
      Math.round(Number((live as unknown as { voucherCreditApplied?: number }).voucherCreditApplied) || 0),
    );
    const liveTradeInForCredit = Math.max(0, Math.round(Number(live.stagedTradeIn?.buybackValue) || 0));
    const mobileAvoirCredit = Math.max(0, Math.round(Number(live.storeCreditApplied) || 0));
    const submitNet = computeCartTotals(live.cart, {
      pricingTier: live.pricingTier,
      storeCreditApplied: live.storeCreditApplied,
      voucherCreditApplied: liveVoucherCredit,
      tradeInCredit: liveTradeInForCredit,
    }).total;

    setIsSubmitting(true);
    try {
      const res = (await processPayment([
        { method, amount: submitNet },
        ...(mobileAvoirCredit > 0 ? [{ method: 'Avoir Client' as const, amount: mobileAvoirCredit }] : []),
        ...(liveTradeInForCredit > 0 ? [{ method: 'Reprise' as const, amount: liveTradeInForCredit }] : []),
      ])) as unknown as {
        success: boolean;
        reason?: string;
        warnings?: string[];
        recoveryQueued?: boolean;
      };
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
          customerName: currentCustomer?.name,
          customerPhone: currentCustomer?.phone,
          items: [...cart],
        });
        setWhatsAppPhoneInput(currentCustomer?.phone || '');
      } else {
        soundEngine.playError?.();
        const reason = (res as unknown as { reason?: string } | undefined)?.reason;
        showToast(reason || 'Erreur lors du paiement.', 'error');
      }
    } catch (err) {
      console.error(`Mobile checkout ${method} error:`, err);
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
        const chargedUnit = i.unitPriceCharged ?? i.appliedPrice ?? i.product.price;
        const lineDiscount = i.discountAmount ?? i.discount ?? 0;
        return `• ${i.product.title} x${i.quantity} = ${formatDZD(
          Math.max(0, chargedUnit * i.quantity - lineDiscount),
        )}`;
      })
      .join('\n');

    const message = `🧾 *TICKET DE CAISSE - MOBIPOS*\n📅 Date: ${dateStr}\n🎫 Ticket N°: #${saleCelebrationData.receiptNumber}${
      saleCelebrationData.customerName ? `\n👤 Client: ${saleCelebrationData.customerName}` : ''
    }\n--------------------------------\n${itemsList}\n--------------------------------\n💰 *Total Payé: ${formatDZD(
      saleCelebrationData.netTotal,
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
    if (/[.,]/.test(customQtyInput)) {
      soundEngine.playError?.();
      showToast('Quantité invalide : entier uniquement', 'warning');
      return;
    }
    const parsed = parseInt(customQtyInput, 10);
    if (isNaN(parsed) || parsed < 0) {
      soundEngine.playError?.();
      showToast('Quantité invalide', 'warning');
      return;
    }
    if (editingQtyItem.product?.isSerialized && parsed > 1) {
      soundEngine.playError?.();
      showToast('Appareil sérialisé : limité à 1 unité par IMEI', 'warning');
      handleQtyChange(editingQtyItem.product.id, 1);
      setEditingQtyItem(null);
      setCustomQtyInput('');
      return;
    }
    soundEngine.playKeyBeep?.();
    handleQtyChange(editingQtyItem.product.id, parsed);
    setEditingQtyItem(null);
    setCustomQtyInput('');
  };

  const filteredCustomers = useMemo(() => {
    const q = customerSearch.trim().toLowerCase();
    if (!q) return customers || [];
    return (customers || []).filter(
      (c) => (c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(q),
    );
  }, [customers, customerSearch]);

  // Margin node for PriceOverrideSheet — STRICT LEDGER: displayed margin is FIFO-or-pending
  const marginSummaryNode = useMemo(() => {
    if (!editingItem) return undefined;
    const newPrice = overridePriceInput || 0;
    const costKnown =
      editingFifoCost !== undefined ||
      editingItem.unitCostAtSale !== undefined ||
      editingItem.unitCostPrice !== undefined;
    const cost =
      editingFifoCost ??
      editingItem.unitCostAtSale ??
      editingItem.unitCostPrice ??
      editingItem.product.costPrice ??
      0;
    const profit = (newPrice - cost) * editingItem.quantity;
    const isLoss = newPrice < cost;
    return (
      <Bdi mono>
        Marge : {costKnown ? (isLoss ? '' : '+') : ''}{costKnown ? formatDZD(profit) : '…'}
      </Bdi>
    );
  }, [editingItem, overridePriceInput, editingFifoCost]);

  return (
    <>
      <AppTabContent
        pinnedTop={
          <div className="px-3.5 pt-3 pb-2.5 space-y-2.5 bg-pos-bg">
            {/* iOS-Style Segmented Pricing Tier Control */}
            <div
              role="radiogroup"
              aria-label={t.checkout.pricingTierAria}
              className="flex items-center gap-1 bg-pos-panel/90 p-1 rounded-2xl border border-pos-border shadow-xs"
            >
              {(['Retail', 'VIP', 'Wholesale'] as PricingTier[]).map((tier) => (
                <button
                  key={tier}
                  type="button"
                  role="radio"
                  aria-checked={pricingTier === tier}
                  onClick={() => {
                    if (pricingTier === tier) return;
                    // UPGRADE-04: manual tier switches manipulate every line
                    // price silently — manager PIN + audit row required.
                    soundEngine.playKeyBeep?.();
                    setTierGateTarget(tier);
                  }}
                  className={`flex-1 py-2 px-2 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer min-h-[48px] flex items-center justify-center active:scale-[0.98] ${
                    pricingTier === tier
                      ? 'bg-emerald-500 text-slate-950 font-black shadow-sm shadow-emerald-500/20'
                      : 'text-pos-muted hover:text-pos-text hover:bg-pos-card/40'
                  }`}
                >
                  {tier === 'Retail' ? t.checkout.tierRetail : tier === 'VIP' ? t.checkout.tierSemiWholesale : t.checkout.tierWholesale}
                </button>
              ))}
            </div>

            {/* Customer Pill Card with One-Tap Selection & Clear */}
            <div className="bg-pos-card border border-pos-border rounded-2xl p-3 flex items-center justify-between gap-3 shadow-xs">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500/20 to-teal-500/10 border border-cyan-500/30 text-cyan-700 dark:text-cyan-400 flex items-center justify-center shrink-0 font-bold text-xs">
                  {currentCustomer ? (
                    currentCustomer.name.slice(0, 2).toUpperCase()
                  ) : (
                    <User className="w-4 h-4" aria-hidden="true" />
                  )}
                </div>
                <div className="min-w-0">
                  <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider block leading-none">
                    {t.checkout.assignedCustomerLabel}
                  </span>
                  <span className="text-xs font-black text-pos-text mt-1 block leading-tight truncate">
                    {currentCustomer ? currentCustomer.name : t.checkout.walkInCustomer}
                  </span>
                  {currentCustomer?.currentDebt ? (
                    <span className="text-[10px] font-bold text-amber-700 dark:text-amber-400 font-mono">
                      {t.checkout.debtPrefix} <Bdi mono>{formatDZD(currentCustomer.currentDebt)}</Bdi>
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {currentCustomer && (
                  <button
                    type="button"
                    onClick={() => setCurrentCustomer(null)}
                    className="p-2 rounded-xl text-pos-muted hover:text-rose-700 dark:hover:text-rose-400 transition cursor-pointer min-h-[48px] min-w-[48px] flex items-center justify-center"
                    title={t.checkout.detachCustomerAria}
                    aria-label={t.checkout.detachCustomerAria}
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setCustomerSearch('');
                    setCustomerModalOpen(true);
                  }}
                  className="text-xs font-bold px-3.5 py-2 rounded-xl bg-pos-panel border border-pos-border text-cyan-700 dark:text-cyan-400 hover:border-cyan-500 cursor-pointer min-h-[48px] transition active:scale-95"
                >
                  {currentCustomer ? t.checkout.changeCustomerButton : t.checkout.selectCustomerButton}
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
                    <span>{t.checkout.grossSubtotal}</span>
                    <span className="font-mono tabular-nums">
                      <Bdi mono>{formatDZD(grossSubtotal)}</Bdi>
                    </span>
                  </div>
                  {totalDiscount > 0 && (
                    <div className="flex justify-between text-emerald-700 dark:text-emerald-400 font-medium">
                      <span>{t.checkout.discountGranted}</span>
                      <span className="font-mono tabular-nums">
                        <Bdi mono>-{formatDZD(totalDiscount)}</Bdi>
                      </span>
                    </div>
                  )}
                  {/* Interactive Store Credit, Voucher & Trade-In Quick Controls */}
                  <div className="flex flex-wrap gap-1.5 py-1.5 border-t border-pos-border/40">
                    {currentCustomer && (currentCustomer.storeCredit || 0) > 0 && (
                      (storeCreditApplied || 0) > 0 ? (
                        <button
                          type="button"
                          onClick={() => setStoreCreditApplied(0)}
                          className="px-2 py-1 rounded-lg bg-purple-500/20 text-purple-700 dark:text-purple-300 border border-purple-500/30 text-[10.5px] font-bold flex items-center gap-1 cursor-pointer"
                        >
                          <span>Avoir : -{formatDZD(storeCreditApplied)}</span>
                          <X className="w-3 h-3 text-rose-500" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            const cartCogs = cart.reduce((acc, item) => {
                              const unitCost = item.unitCostAtSale ?? item.unitCostPrice ?? item.product?.costPrice ?? 0;
                              return acc + Math.max(0, Number(unitCost) || 0) * Math.abs(Number(item.quantity) || 0);
                            }, 0);
                            const { maxAllowedCredit } = calculateMaxAllowedCredit(
                              Math.max(0, totals.subtotalAfterDiscount - voucherCreditApplied),
                              cartCogs,
                              currentCustomer.storeCredit,
                              50
                            );
                            setStoreCreditApplied(maxAllowedCredit);
                          }}
                          className="px-2 py-1 rounded-lg bg-purple-500/15 text-purple-700 dark:text-purple-300 border border-purple-500/30 text-[10.5px] font-bold flex items-center gap-1 cursor-pointer"
                        >
                          <Gift className="w-3 h-3" />
                          <span>Appliquer Avoir ({formatDZD(currentCustomer.storeCredit)})</span>
                        </button>
                      )
                    )}

                    {voucherCreditApplied > 0 ? (
                      <button
                        type="button"
                        onClick={() => {
                          usePosStore.getState().clearVoucherCredit?.() ?? usePosStore.setState({ voucherCreditApplied: 0, voucherCode: null });
                        }}
                        className="px-2 py-1 rounded-lg bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30 text-[10.5px] font-bold flex items-center gap-1 cursor-pointer"
                      >
                        <span>Bon : -{formatDZD(voucherCreditApplied)}</span>
                        <X className="w-3 h-3 text-rose-500" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => openModal('credit_voucher')}
                        className="px-2 py-1 rounded-lg bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border border-indigo-500/20 text-[10.5px] font-bold flex items-center gap-1 cursor-pointer"
                      >
                        <Tag className="w-3 h-3" />
                        <span>+ Bon d&apos;Avoir</span>
                      </button>
                    )}

                    {stagedTradeIn ? (
                      <button
                        type="button"
                        onClick={() => clearStagedTradeIn()}
                        className="px-2 py-1 rounded-lg bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 text-[10.5px] font-bold flex items-center gap-1 cursor-pointer"
                      >
                        <span>Reprise : -{formatDZD(stagedTradeIn.buybackValue)}</span>
                        <X className="w-3 h-3 text-rose-500" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => openTradeInExchange()}
                        className="px-2 py-1 rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 text-[10.5px] font-bold flex items-center gap-1 cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>+ Reprise Appareil</span>
                      </button>
                    )}
                  </div>

                  {(storeCreditApplied || 0) > 0 && (
                    <div className="flex justify-between text-purple-800 dark:text-purple-300 font-medium">
                      <span>{t.checkout.storeCreditApplied}</span>
                      <span className="font-mono tabular-nums">
                        <Bdi mono>-{formatDZD(storeCreditApplied)}</Bdi>
                      </span>
                    </div>
                  )}
                  {voucherCreditApplied > 0 && (
                    <div className="flex justify-between text-purple-800 dark:text-purple-300 font-medium">
                      <span>{t.checkout.voucherCreditApplied}</span>
                      <span className="font-mono tabular-nums">
                        <Bdi mono>-{formatDZD(voucherCreditApplied)}</Bdi>
                      </span>
                    </div>
                  )}
                  {tradeInCreditApplied > 0 && (
                    <div className="flex justify-between text-emerald-700 dark:text-emerald-300 font-medium">
                      <span>{t.checkout.tradeInDeducted}</span>
                      <span className="font-mono tabular-nums">
                        <Bdi mono>-{formatDZD(tradeInCreditApplied)}</Bdi>
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between items-baseline pt-2 border-t border-pos-border text-pos-text">
                    <span className="text-xs font-black uppercase tracking-wider">
                      {refundDue > 0 || signedNet < 0 ? t.checkout.refundDue : t.checkout.netTotal}
                    </span>
                    {isSubmitting ? (
                      <span
                        aria-hidden="true"
                        className="inline-block h-8 w-28 rounded-lg bg-pos-panel border border-pos-border animate-pulse"
                      />
                    ) : (
                      <span
                        className={`text-2xl font-black font-mono tabular-nums tracking-tight ${
                          refundDue > 0 || signedNet < 0
                            ? 'text-rose-700 dark:text-rose-400'
                            : 'text-emerald-700 dark:text-emerald-400'
                        }`}
                      >
                        <Bdi mono>
                          {refundDue > 0 || signedNet < 0
                            ? `-${formatDZD(refundDue > 0 ? refundDue : Math.abs(signedNet))}`
                            : formatDZD(netTotal)}
                        </Bdi>
                      </span>
                    )}
                  </div>
                </div>

                {/* Checkout Action Buttons — Ergonomic Multi-Tender Dock */}
                <div className="space-y-1.5 pt-1">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={handleOpenCashTender}
                      className="py-3 px-3 min-h-[50px] rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 active-press text-slate-950 font-black text-xs sm:text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/25 transition cursor-pointer disabled:opacity-50"
                    >
                      <Coins className="w-4 h-4" aria-hidden="true" />
                      <span>{t.checkout.payCashButton}</span>
                    </button>

                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={handleCheckoutCredit}
                      className="py-3 px-3 min-h-[50px] rounded-xl bg-amber-500/15 border border-amber-500/30 hover:bg-amber-500/25 active-press text-amber-800 dark:text-amber-400 font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50 shadow-xs"
                    >
                      <CreditCard className="w-4 h-4" aria-hidden="true" />
                      <span>{t.checkout.payKredyButton}</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-3 gap-1.5">
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => handleCheckoutTender('CIB / Edahabia')}
                      className="py-2.5 px-1.5 min-h-[44px] rounded-xl bg-blue-500/15 border border-blue-500/30 hover:bg-blue-500/25 active-press text-blue-700 dark:text-blue-300 font-bold text-[11px] flex items-center justify-center gap-1 transition cursor-pointer disabled:opacity-50 shadow-xs"
                    >
                      <CreditCard className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Carte CIB</span>
                    </button>
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => handleCheckoutTender('BaridiMob')}
                      className="py-2.5 px-1.5 min-h-[44px] rounded-xl bg-amber-500/15 border border-amber-500/30 hover:bg-amber-500/25 active-press text-amber-700 dark:text-amber-300 font-bold text-[11px] flex items-center justify-center gap-1 transition cursor-pointer disabled:opacity-50 shadow-xs"
                    >
                      <Smartphone className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>BaridiMob</span>
                    </button>
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => handleCheckoutTender('Chèque')}
                      className="py-2.5 px-1.5 min-h-[44px] rounded-xl bg-indigo-500/15 border border-indigo-500/30 hover:bg-indigo-500/25 active-press text-indigo-700 dark:text-indigo-300 font-bold text-[11px] flex items-center justify-center gap-1 transition cursor-pointer disabled:opacity-50 shadow-xs"
                    >
                      <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Chèque</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : undefined
        }
        contentClassName="px-3.5 pb-4 select-none"
      >
        {/* Cart Header & Quick Action Bar */}
        <div className="space-y-2">
          {/* Inline Credit Ceiling Alert Banner */}
          {creditCeilingAlert && (
            <div
              role="alert"
              className="pos-status-danger rounded-2xl p-3 flex items-start justify-between gap-2.5 shadow-xs"
            >
              <div className="flex items-start gap-2 min-w-0">
                <AlertTriangle className="w-4 h-4 text-rose-700 dark:text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="text-xs text-rose-800 dark:text-rose-200 min-w-0">
                  <p className="font-black">
                    {t('checkout.creditCeilingExceededFor', { name: creditCeilingAlert.customerName })}
                  </p>
                  <p className="text-[11px] font-mono mt-0.5">
                    {t.checkout.currentDebtPrefix} <Bdi mono>{formatDZD(creditCeilingAlert.currentDebt)}</Bdi> • {t.checkout.maxCeilingPrefix}{' '}
                    <Bdi mono>{formatDZD(creditCeilingAlert.debtLimit)}</Bdi>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setCreditCeilingAlert(null)}
                className="min-h-[48px] min-w-[48px] -m-1.5 flex items-center justify-center rounded-xl text-rose-700 dark:text-rose-300 hover:bg-rose-500/15 cursor-pointer shrink-0"
                aria-label={t.checkout.dismissCeilingAlertAria}
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          )}

          {/* Active exchange chip — compact swipeable, high-contrast delta */}
          {stagedTradeIn && (
            <div className="overflow-x-auto no-scrollbar -mx-0.5 px-0.5">
              <div className="pos-status-ok rounded-xl px-3 py-2 flex items-center gap-2 min-w-max shadow-xs">
                <RefreshCw className="w-4 h-4 text-emerald-700 dark:text-emerald-300 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-[11px] font-black text-emerald-900 dark:text-emerald-200 truncate">
                    {stagedTradeIn.deviceModel}{' '}
                    <span className="font-mono font-bold text-emerald-700 dark:text-emerald-300/80">
                      · <Bdi mono>{stagedTradeIn.imei}</Bdi>
                    </span>
                  </p>
                  <p className="text-sm font-mono font-black text-emerald-800 dark:text-emerald-300 tabular-nums leading-tight">
                    <Bdi mono>−{formatDZD(tradeInCredit)}</Bdi>
                    <span className="text-[10px] font-sans font-bold text-pos-muted">
                      {' '}
                      → {t.checkout.remainingPrefix}{' '}
                      <Bdi mono>
                        {formatDZD(
                          tradeSettlement ? (isSoulte ? 0 : tradeSettlement.customerOwes) : netTotal,
                        )}
                      </Bdi>
                    </span>
                    {isSoulte && tradeSettlement && (
                      <span className="text-[10px] font-sans font-bold text-amber-800 dark:text-amber-300">
                        {' '}
                        · Soulte <Bdi mono>{formatDZD(tradeSettlement.shopOwes)}</Bdi> {t.checkout.soulteToPaySuffix}
                      </span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openTradeInExchange({ ...stagedTradeIn })}
                  className="ms-1 shrink-0 w-12 h-12 min-h-[48px] min-w-[48px] flex items-center justify-center rounded-xl bg-pos-card border border-pos-border text-pos-text cursor-pointer"
                  aria-label={t.checkout.editTradeInAria}
                >
                  <Pencil className="w-4 h-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    clearStagedTradeIn();
                    setExchangeSoultePayout(null);
                    showToast('Reprise retirée du panier.', 'info');
                  }}
                  className="shrink-0 w-12 h-12 min-h-[48px] min-w-[48px] flex items-center justify-center rounded-xl bg-pos-card border border-pos-border text-pos-muted cursor-pointer"
                  aria-label={t.checkout.removeTradeInAria}
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between px-1 text-xs font-bold text-pos-muted gap-2 flex-wrap">
            <span>
              {t('checkout.cartItemsHeader', { count: cart.length })}
            </span>
            <div className="flex items-center gap-1.5 flex-wrap justify-end">
              {heldSales.length > 0 && (
                <button
                  type="button"
                  onClick={() => openModal('hold')}
                  className="text-[11px] text-amber-800 dark:text-amber-400 hover:text-amber-600 dark:hover:text-amber-300 font-bold flex items-center gap-1.5 cursor-pointer py-2 px-3 rounded-xl bg-amber-500/10 border border-amber-500/30 active:scale-95 transition min-h-[48px]"
                  title="Voir et reprendre les ventes en attente"
                >
                  <PauseCircle className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t.checkout.heldSalesButton}</span>
                  <span className="w-5 h-5 rounded-full bg-amber-500 text-slate-950 text-[10px] font-black flex items-center justify-center">
                    <Bdi mono>{heldSales.length}</Bdi>
                  </span>
                </button>
              )}

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
                  className="text-[11px] text-amber-800 dark:text-amber-400 hover:text-amber-600 dark:hover:text-amber-300 font-bold flex items-center gap-1 cursor-pointer py-2 px-3 rounded-xl bg-amber-500/10 border border-amber-500/20 active:scale-95 transition min-h-[48px]"
                  title="Suspendre le ticket actuel pour servir un autre client"
                >
                  <PauseCircle className="w-3.5 h-3.5" aria-hidden="true" />
                  <span className="hidden xs:inline">{t.checkout.holdCurrentSaleButton}</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setIsScannerOpen(true)}
                className="text-[11px] text-cyan-800 dark:text-cyan-400 hover:text-cyan-600 dark:hover:text-cyan-300 font-bold flex items-center gap-1 cursor-pointer py-2 px-3 rounded-xl bg-cyan-500/10 border border-cyan-500/20 active:scale-95 transition min-h-[48px]"
              >
                <Camera className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t.checkout.scannerButton}</span>
              </button>

              <button
                type="button"
                onClick={() => openModal('invoice_ingestion')}
                className="text-[11px] text-teal-800 dark:text-teal-400 hover:text-teal-600 dark:hover:text-teal-300 font-bold flex items-center gap-1 cursor-pointer py-2 px-3 rounded-xl bg-teal-500/10 border border-teal-500/20 active:scale-95 transition min-h-[48px]"
                title="Scanner ou importer une facture fournisseur (Entrée en stock)"
              >
                <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t.checkout.invoiceButton}</span>
              </button>

              {cart.length > 0 && (
                <button
                  type="button"
                  onClick={() => openModal('discount')}
                  className="text-[11px] text-purple-800 dark:text-purple-400 hover:text-purple-600 dark:hover:text-purple-300 font-bold flex items-center gap-1 cursor-pointer py-2 px-3 rounded-xl bg-purple-500/10 border border-purple-500/20 active:scale-95 transition min-h-[48px]"
                  title="Appliquer une remise globale sur le panier"
                >
                  <Percent className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t.checkout.discountButton}</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => openTradeInExchange()}
                className="text-[11px] text-emerald-800 dark:text-emerald-300 hover:text-emerald-600 dark:hover:text-emerald-200 font-bold flex items-center gap-1 cursor-pointer py-2 px-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 active:scale-95 transition min-h-[48px]"
                title="Échanger un appareil (Trade-In) — déduit du panier"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t('checkout.addTradeInButton', '+ Ajouter Reprise')}</span>
              </button>

              {cart.length > 0 && (
                <button
                  type="button"
                  onClick={() => setIsClearCartConfirmOpen(true)}
                  className="text-[11px] text-rose-700 dark:text-rose-400 hover:text-rose-600 dark:hover:text-rose-300 flex items-center gap-1 cursor-pointer py-2 px-3 rounded-xl hover:bg-rose-500/10 transition min-h-[48px]"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t.checkout.clearCartShortButton}</span>
                </button>
              )}
            </div>
          </div>

          {/* Empty Cart POS Onboarding Hero */}
          {cart.length === 0 ? (
            <div className="p-8 my-4 text-center bg-pos-panel/60 border border-dashed border-pos-border rounded-2xl flex flex-col items-center justify-center space-y-3">
              <div className="w-14 h-14 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shadow-xs">
                <ShoppingBag className="w-7 h-7" aria-hidden="true" />
              </div>
              <div>
                <h4 className="text-sm font-black text-pos-text">{t.checkout.emptyCartTitle}</h4>
                <p className="text-xs text-pos-muted mt-1">
                  {t.checkout.emptyCartSubtitle}
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-2 w-full max-w-xs pt-2">
                <button
                  type="button"
                  onClick={() => setIsScannerOpen(true)}
                  className="w-full min-h-[48px] px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:scale-95 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer shadow-md shadow-emerald-500/20"
                >
                  <Camera className="w-4 h-4" aria-hidden="true" />
                  <span>{t.checkout.scanBarcodeCta}</span>
                </button>

                {onNavigateToCatalog && (
                  <button
                    type="button"
                    onClick={onNavigateToCatalog}
                    className="w-full min-h-[48px] px-4 py-2 rounded-xl bg-pos-card border border-pos-border hover:border-cyan-400 text-pos-text font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer"
                  >
                    <Search className="w-4 h-4 text-cyan-700 dark:text-cyan-400" aria-hidden="true" />
                    <span>{t.checkout.browseCatalogCta}</span>
                  </button>
                )}
              </div>
            </div>
          ) : (
            /* Cart Items Cards */
            cart.map((item: CartItem) => {
              const defaultPrice = item.defaultPrice ?? item.product.price;
              const unitPrice =
                item.appliedPrice !== undefined
                  ? item.appliedPrice
                  : resolveBaseUnitPrice(item.product, pricingTier, item.quantity, customerPriceBook?.items ?? null);
              // UPGRADE-04: advisory volume-break nudge (never blocking).
              const volumeNudge = getVolumeBreakNudge(item.product, item.quantity, unitPrice);
              const isOverridden = item.appliedPrice !== undefined && item.appliedPrice !== defaultPrice;
              const hasDiscount = (item.discount || 0) > 0;
              const itemTotal = unitPrice * item.quantity - (item.discount || 0);

              return (
                <div
                  key={item.product.id}
                  className="bg-pos-card border border-pos-border rounded-2xl p-3 flex flex-col gap-2.5 shadow-xs hover:border-emerald-500/30 transition"
                >
                  {/* Row 1: Product title + IMEI + Subtotal */}
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      {item.imeiNumber && (
                        <span className="p-0.5 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-700 dark:text-cyan-400 shrink-0">
                          <Smartphone className="w-3 h-3" aria-hidden="true" />
                        </span>
                      )}
                      <h4 className="text-xs font-bold text-pos-text truncate" title={item.product.title}>
                        {item.product.title}
                      </h4>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {hasDiscount && (
                        <span className="text-[9px] text-emerald-700 dark:text-emerald-400 font-mono font-bold bg-emerald-500/10 px-1 rounded border border-emerald-500/20">
                          <Bdi mono>-{formatDZD(item.discount || 0)}</Bdi>
                        </span>
                      )}
                      <span className="text-xs font-mono font-black text-pos-text tabular-nums">
                        <Bdi mono>{formatDZD(itemTotal)}</Bdi>
                      </span>
                    </div>
                  </div>

                  {/* Row 2: Price Override Pill + Stepper Cluster */}
                  <div className="flex items-center justify-between gap-2 pt-1 border-t border-pos-border/40 flex-wrap">
                    <button
                      type="button"
                      onClick={() => handleOpenPriceOverride(item)}
                      className={`flex items-center gap-1 px-2.5 py-1.5 min-h-[48px] rounded-xl border text-[11px] font-mono tabular-nums font-bold transition active:scale-95 cursor-pointer ${
                        isOverridden
                          ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/30'
                          : 'bg-pos-panel text-pos-text border-pos-border hover:border-amber-500/40'
                      }`}
                      title="Modifier le prix / accorder une remise"
                    >
                      <Tag className="w-3 h-3 text-amber-600 dark:text-amber-400 shrink-0" aria-hidden="true" />
                      <span>
                        <Bdi mono>{formatDZD(unitPrice)}</Bdi>
                      </span>
                      {isOverridden && (
                        <span className="text-[9px] bg-amber-500/20 text-amber-800 dark:text-amber-300 font-bold px-1 rounded ms-0.5">
                          {t.checkout.priceOverriddenBadge}
                        </span>
                      )}
                    </button>

                    {/* UPGRADE-04: volume-break nudge — more units unlock a
                        lower unit price (advisory chip, never blocking). */}
                    {volumeNudge && (
                      <span
                        className="inline-flex items-center px-2 py-1 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300 text-[9.5px] font-bold tabular-nums whitespace-nowrap"
                        title={`Ajouter ${volumeNudge.missing} unité(s) pour atteindre ${volumeNudge.minQty} u. à ${formatDZD(volumeNudge.unitPrice)}/u`}
                      >
                        +{volumeNudge.missing} → <Bdi mono>{formatDZD(volumeNudge.unitPrice)}</Bdi>/u
                      </span>
                    )}

                    {/* Quantity Stepper with 48x48dp hitboxes & Direct Qty Tap */}
                    <div className="flex items-center gap-1 shrink-0 bg-pos-panel border border-pos-border rounded-xl p-1 ms-auto">
                      <button
                        type="button"
                        onClick={() => handleQtyChange(item.product.id, item.quantity - 1)}
                        className="w-12 h-12 min-h-[48px] min-w-[48px] flex items-center justify-center rounded-lg bg-pos-card text-pos-muted hover:text-pos-text active-press cursor-pointer"
                        aria-label={t('checkout.decreaseQtyAria', { title: item.product.title })}
                      >
                        <Minus className="w-4 h-4" aria-hidden="true" />
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          soundEngine.playKeyBeep?.();
                          setEditingQtyItem(item);
                          setCustomQtyInput(String(item.quantity));
                        }}
                        className="min-w-[48px] min-h-[48px] px-1.5 flex items-center justify-center text-center font-mono text-xs font-black text-pos-text hover:bg-pos-card rounded-lg transition active-press cursor-pointer tabular-nums"
                        title="Modifier la quantité directement"
                      >
                        <Bdi mono>{item.quantity}</Bdi>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleQtyChange(item.product.id, item.quantity + 1)}
                        className="w-12 h-12 min-h-[48px] min-w-[48px] flex items-center justify-center rounded-lg bg-pos-card text-emerald-700 dark:text-emerald-400 hover:text-emerald-500 active-press cursor-pointer"
                        aria-label={t('checkout.increaseQtyAria', { title: item.product.title })}
                      >
                        <Plus className="w-4 h-4" aria-hidden="true" />
                      </button>

                      <button
                        type="button"
                        onClick={() => handleRemove(item.product.id)}
                        className="w-12 h-12 min-h-[48px] min-w-[48px] flex items-center justify-center rounded-lg bg-rose-500/10 text-rose-700 dark:text-rose-400 hover:bg-rose-500/20 active-press cursor-pointer ms-0.5"
                        title={t.checkout.removeLineAria}
                        aria-label={t('checkout.removeLineAria', { title: item.product.title })}
                      >
                        <Trash2 className="w-4 h-4" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {/* UPGRADE-03 — suggestions accessoires (advisory, tap = add) */}
          <AccessorySuggestions />
        </div>
      </AppTabContent>

      {/* Camera Barcode Scanner Modal */}
      {isScannerOpen && (
        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex flex-col p-3 pt-[max(0.75rem,var(--safe-top))] pb-[max(0.75rem,var(--safe-bottom))] animate-in fade-in">
          <div className="flex items-center justify-between pb-2 border-b border-white/10 text-white">
            <div className="flex items-center gap-2">
              <Camera className="w-5 h-5 text-emerald-400" aria-hidden="true" />
              <h3 className="text-sm font-bold">{t.checkout.scanItemModalTitle}</h3>
            </div>
            <button
              type="button"
              onClick={() => setIsScannerOpen(false)}
              className="min-h-[48px] min-w-[48px] flex items-center justify-center rounded-xl bg-white/10 hover:bg-white/20 text-white transition cursor-pointer"
              aria-label={t.checkout.closeCameraAria}
            >
              <X className="w-5 h-5" aria-hidden="true" />
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

      {/* Inline Clear Cart Confirmation Sheet (replaces native window.confirm) */}
      {isClearCartConfirmOpen && (
        <div
          onClick={() => setIsClearCartConfirmOpen(false)}
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 select-none"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="clear-cart-sheet-title"
            className="pos-bottom-sheet bg-pos-panel border-t sm:border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-md p-5 space-y-4 shadow-2xl animate-in slide-in-from-bottom-5 pb-[max(1.25rem,var(--safe-bottom))] sm:pb-5"
          >
            <div
              className="sheet-handle w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto -mt-2 mb-1 sm:hidden shrink-0"
              aria-hidden="true"
            />
            <div className="flex items-start gap-3">
              <div className="w-11 h-11 rounded-2xl bg-rose-500/15 border border-rose-500/30 text-rose-700 dark:text-rose-400 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5" aria-hidden="true" />
              </div>
              <div>
                <h3 id="clear-cart-sheet-title" className="text-sm font-black text-pos-text">
                  {t.checkout.clearCartConfirmTitle}
                </h3>
                <p className="text-xs text-pos-muted mt-1">
                  {t('checkout.clearCartConfirmBody', { count: cart.reduce((a, i) => a + i.quantity, 0) })}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => setIsClearCartConfirmOpen(false)}
                className="min-h-[48px] rounded-xl bg-pos-card border border-pos-border text-pos-muted hover:text-pos-text font-bold text-xs cursor-pointer"
              >
                {t.common.cancel}
              </button>
              <button
                type="button"
                onClick={() => {
                  const n = cart.reduce((a, i) => a + i.quantity, 0);
                  void logSecurityAction(
                    'Annulation Complète Panier (Mobile)',
                    `Panier vidé (${n} unités)`,
                    operatorName,
                    false,
                  );
                  clearCart();
                  setIsClearCartConfirmOpen(false);
                }}
                className="min-h-[48px] rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-black text-xs cursor-pointer shadow-md shadow-rose-600/20"
              >
                {t.checkout.clearCartConfirmAction}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Customer Picker Bottom Sheet */}
      <CustomerPickerSheet
        isOpen={customerModalOpen}
        onClose={() => setCustomerModalOpen(false)}
        customerSearch={customerSearch}
        onCustomerSearchChange={setCustomerSearch}
        filteredCustomers={filteredCustomers}
        onSelectCustomer={(c: Customer | null) => setCurrentCustomer(c)}
        onOpenNewCustomerModal={() => {
          setCustomerModalOpen(false);
          openModal('customers');
        }}
      />

      {/* Price Override & Line Discount Bottom Sheet */}
      <PriceOverrideSheet
        editingItem={editingItem}
        onClose={() => setEditingItem(null)}
        overridePriceInput={overridePriceInput}
        onOverridePriceChange={(price) => {
          setOverridePriceInput(price);
          setOverrideError(null);
        }}
        editingFifoCost={editingFifoCost}
        managerPinInput={managerPinInput}
        onManagerPinChange={(pin) => {
          setManagerPinInput(pin);
          setOverrideError(null);
        }}
        overrideError={overrideError}
        onApplyPriceOverride={handleApplyPriceOverride}
        marginSummaryNode={marginSummaryNode}
        moneyInputSlot={
          <MoneyInput
            label={t.checkout.newSoldPriceLabel}
            valueMinor={dinarsToMinor(overridePriceInput || 0)}
            onChangeMinor={(minor) => {
              setOverridePriceInput(toLegacyReal(minor));
              setOverrideError(null);
            }}
            placeholder={t.checkout.enterAmountPlaceholder}
            className="w-full min-h-[48px] bg-pos-card border border-pos-border focus:border-amber-400 rounded-xl px-3 py-2 text-base font-mono font-black text-pos-text focus:outline-none shadow-xs"
          />
        }
      />

      {/* Cash Tender & Change Due Number Pad Bottom Sheet */}
      <CashTenderSheet
        isOpen={isCashTenderOpen}
        onClose={() => setIsCashTenderOpen(false)}
        netTotal={netTotal}
        tenderedStr={tenderedStr}
        onSelectPreset={(preset) => {
          setTenderedStr(preset);
          setIsTenderDirty(true);
        }}
        onDigitPress={(dNum) => {
          if (!isTenderDirty) {
            setTenderedStr(dNum);
            setIsTenderDirty(true);
          } else {
            setTenderedStr((prev) => (prev === 0 ? dNum : prev * 10 + dNum));
          }
        }}
        onDoubleZeroPress={() => {
          if (!isTenderDirty) {
            setTenderedStr(0);
            setIsTenderDirty(true);
          } else {
            setTenderedStr((prev) => prev * 100);
          }
        }}
        onTripleZeroPress={() => {
          if (!isTenderDirty) {
            setTenderedStr(0);
            setIsTenderDirty(true);
          } else {
            setTenderedStr((prev) => prev * 1000);
          }
        }}
        onClear={() => {
          setTenderedStr(0);
          setIsTenderDirty(true);
        }}
        onBackspace={() => {
          setTenderedStr((prev) => Math.floor(prev / 10));
          setIsTenderDirty(true);
        }}
        smartBanknotes={smartBanknotes}
        isSoulte={isSoulte}
        soulteDue={soulteDue}
        soulteHeadingText={t('checkout.soulteHeading', 'Soulte à verser')}
        exchangeSoultePayout={exchangeSoultePayout}
        onSelectSoultePayout={setExchangeSoultePayout}
        isSubmitting={isSubmitting}
        onConfirmCashTender={handleConfirmCashTender}
      />

      {/* Post-Checkout Celebration & WhatsApp Share Sheet */}
      <SaleCelebrationSheet
        saleCelebrationData={saleCelebrationData}
        onClose={() => setSaleCelebrationData(null)}
        whatsAppPhoneInput={whatsAppPhoneInput}
        onWhatsAppPhoneChange={setWhatsAppPhoneInput}
        onSendWhatsAppReceipt={handleSendWhatsAppReceipt}
        onOpenPrintReceipt={() => openModal('receipt')}
      />

      {/* Quick Direct Quantity Modification Sheet */}
      <QuantityEditSheet
        editingQtyItem={editingQtyItem}
        onClose={() => setEditingQtyItem(null)}
        customQtyInput={customQtyInput}
        onCustomQtyChange={setCustomQtyInput}
        onApplyCustomQty={handleApplyCustomQty}
      />

      {/* UPGRADE-04: Manager PIN gate for manual pricing-tier switches.
          Verification routes through PinDialog → native `pin_verify`. */}
      <PinDialog
        isOpen={tierGateTarget !== null}
        title={t.checkout.tierGateTitle}
        description={
          tierGateTarget
            ? `${t.checkout.tierGateDescription} ${tierGateTarget === 'Retail' ? t.checkout.tierRetail : tierGateTarget === 'VIP' ? t.checkout.tierSemiWholesale : t.checkout.tierWholesale}`
            : undefined
        }
        onSuccess={() => {
          const target = tierGateTarget;
          setTierGateTarget(null);
          if (!target || target === pricingTier) return;
          const labelOf = (tier: PricingTier) =>
            tier === 'Retail' ? t.checkout.tierRetail : tier === 'VIP' ? t.checkout.tierSemiWholesale : t.checkout.tierWholesale;
          void logSecurityAction(
            'Changement Tarif',
            `Tarif ${labelOf(pricingTier)} → ${labelOf(target)} (${cart.length} ligne(s))`,
            operatorName,
            true
          );
          setPricingTier(target);
          soundEngine.playSuccess?.();
        }}
        onCancel={() => setTierGateTarget(null)}
      />
    </>
  );
};

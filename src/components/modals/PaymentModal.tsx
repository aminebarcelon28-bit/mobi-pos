import React, { useState, useEffect, useLayoutEffect } from 'react';
import {
  X,
  Banknote,
  CheckCircle2,
  AlertCircle,
  FileText,
  UserCheck,
  ShieldCheck,
  Gift,
  Sparkles,
  Star,
  Check,
  Search,
  RotateCcw,
  RefreshCw,
  Wallet,
  CreditCard,
  Smartphone,
  Receipt,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import type { PaymentTender, PaymentMethodType } from '../../types/pos';
import { useToast } from '../../components/ui/Toast';
import { getEffectiveDebtLimit } from '../../store/slices/createCustomerSlice';
import { soundEngine } from '../../utils/audioFeedback';
import { computeCartTotals, computeTradeInSettlement } from '../../utils/receiptMath';
import { toLegacyReal, dinarsToMinor } from '../../utils/money';
import { isFatFingerTender } from '../../utils/tenderGuard';
import { MoneyInput } from '../ui/MoneyInput';
import { calculateMaxAllowedCredit, calculateCustomerTier, normalizeLoyaltyConfig } from '../../utils/loyaltyEngine';
import { Kbd } from '../../design-system/desktop/Kbd';

/** Display-only tier resolution — the cached loyaltyTier string may be stale after renames. */
const resolveTierName = (totalSpent?: number): string => {
  try {
    return calculateCustomerTier(
      totalSpent || 0,
      normalizeLoyaltyConfig(usePosStore.getState().receiptSettings?.loyaltyConfig)
    ).name;
  } catch {
    return 'Bronze';
  }
};

export const PaymentModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    cart,
    processPayment,
    pricingTier,
    currentCustomer,
    openModal,
    setCartItemIMEI,
    imeiRecords,
    storeCreditApplied,
    setStoreCreditApplied,
  } = usePosStore();

  const { showToast } = useToast();
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethodType>('Espèces');
  const [cashTenderAmount, setCashTenderAmount] = useState<number>(0);
  const [appliedCredit, setAppliedCredit] = useState<number>(0);
  const [isCustomCreditOpen, setIsCustomCreditOpen] = useState(false);
  const [customCreditInput, setCustomCreditInput] = useState<number>(0);
  const [isProcessing, setIsProcessing] = useState(false);
  // Fat-finger confirmation ([MNY-29]): set when the cash tender is far above
  // the ticket; holds the numbers the cashier must see before committing.
  const [fatFinger, setFatFinger] = useState<{
    tendered: number;
    total: number;
    change: number;
    isCreditSplit: boolean;
  } | null>(null);
  const [voucherInput, setVoucherInput] = useState('');
  const [voucherBusy, setVoucherBusy] = useState(false);
  const [voucherError, setVoucherError] = useState<string | null>(null);
  const [transactionRef, setTransactionRef] = useState('');

  // Runtime-staged voucher credit + VAT rate (owned by other agents' types).
  const voucherCreditApplied =
    usePosStore((s) => (s as unknown as { voucherCreditApplied?: number }).voucherCreditApplied ?? 0) || 0;
  const voucherCode =
    usePosStore((s) => (s as unknown as { voucherCode?: string | null }).voucherCode ?? null);
  // Phase 3: staged two-way exchange (memory-only until checkout commits).
  const stagedTradeIn = usePosStore((s) => s.stagedTradeIn);
  const exchangeSoultePayout = usePosStore((s) => s.exchangeSoultePayout);
  const setExchangeSoultePayout = usePosStore((s) => s.setExchangeSoultePayout);
  const clearStagedTradeIn = usePosStore((s) => s.clearStagedTradeIn);
  const tradeInCredit = Math.max(0, Math.round(Number(stagedTradeIn?.buybackValue) || 0));

  // Canonical totals — the same computeCartTotals() base as CartPanel,
  // MobileCheckoutTab and processPayment (signed returns, credits). HT-only:
  // there is no VAT term in the base (Phase 1b-i).
  // grossSubtotal = signed catalog value ("SOUS-TOTAL BRUT" on the ticket);
  // netToPay = amount the tender must cover (net of credits).
  const totals = computeCartTotals(cart, {
    pricingTier,
    storeCreditApplied: appliedCredit,
    voucherCreditApplied,
    tradeInCredit,
  });
  const grossSubtotal = totals.grossSubtotal;
  const cartDiscount = totals.discountTotal;
  const netSubtotal = totals.subtotalAfterDiscount;
  const netToPay = totals.total;
  const tradeInCreditApplied = totals.tradeInCreditApplied;
  // Settlement on the TRUE buyback (unclamped) vs the payable base so the
  // soulte direction survives the totals clamp.
  const tradeSettlement = stagedTradeIn ? computeTradeInSettlement(netSubtotal, tradeInCredit) : null;
  const isSoulte = !!tradeSettlement && tradeSettlement.direction === 'SOULTE_SHOP_PAYS';
  const soulteDue = isSoulte && tradeSettlement ? tradeSettlement.shopOwes : 0;
  // B-026: net-negative cart → cash owed back; netToPay/ttc is clamped to 0.
  const refundDue = totals.refundDue;
  const isRefundDue = refundDue > 0;

  // Render-time state synchronization when modal opens
  const [prevPaymentModalSync, setPrevPaymentModalSync] = useState<string | null>(null);
  const paymentModalSyncKey = activeModal === 'payment' ? `${activeModal}_${cart.length}_${currentCustomer?.id ?? 'none'}` : null;
  if (paymentModalSyncKey !== prevPaymentModalSync) {
    setPrevPaymentModalSync(paymentModalSyncKey);
    if (activeModal === 'payment' && cart.length > 0) {
      setSelectedMethod('Espèces');
      setIsProcessing(false);
      setIsCustomCreditOpen(false);
      const initialCredit = Math.min(
        currentCustomer?.storeCredit || 0,
        storeCreditApplied || 0,
        netSubtotal
      );
      setAppliedCredit(initialCredit);
      const initialNet = Math.max(0, netToPay - initialCredit);
      setCashTenderAmount(initialNet > 0 ? initialNet : 0);
    }
  }

  // Soulte payout is a STORE write, so it must not run during render: Zustand
  // notifies every subscriber mid-render (React: "Cannot update a component
  // (`ThemeToggle`) while rendering a different component (`PaymentModal`)").
  // Same open/cart/customer signal as the render block above, before paint.
  useLayoutEffect(() => {
    if (paymentModalSyncKey && cart.length > 0 && usePosStore.getState().exchangeSoultePayout) {
      setExchangeSoultePayout(null);
    }
  }, [paymentModalSyncKey, cart.length, setExchangeSoultePayout]);

  // External side-effects: empty cart guardrail and input autofocus
  useEffect(() => {
    if (activeModal === 'payment') {
      if (cart.length === 0) {
        closeModal();
        showToast('Panier vide — Ajoutez des articles au panier avant d\'encaisser.', 'warning');
        return;
      }
      const t = setTimeout(() => {
        const el = document.getElementById('payment-cash-input') as HTMLInputElement | null;
        el?.focus();
        el?.select();
      }, 50);
      return () => clearTimeout(t);
    }
  }, [activeModal, cart.length, closeModal, showToast]);

  useEffect(() => { if (activeModal !== 'payment') return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [activeModal, closeModal]);

  if (activeModal !== 'payment') return null;

  // B-030: wire the COGS margin-floor + 50% cap guardrail — balance-only
  // clamping let credit cover 100% of the basket (anti-bankruptcy path).
  const cartCogs = cart.reduce((acc, item) => {
    const unitCost = item.unitCostAtSale ?? item.unitCostPrice ?? item.product.costPrice ?? 0;
    return acc + unitCost * item.quantity;
  }, 0);
  const creditGuardrail = calculateMaxAllowedCredit(
    Math.max(0, grossSubtotal - cartDiscount),
    cartCogs,
    currentCustomer?.storeCredit || 0,
    50
  );

  // Store credit can never exceed the net due after the staged voucher AND
  // the staged trade-in (gross − discounts − voucher − reprise already
  // granted), otherwise a discounted sale would over-apply customer credit —
  // and never past the guardrail.
  const maxAvailableCredit = currentCustomer
    ? Math.min(
        creditGuardrail.maxAllowedCredit,
        Math.max(0, netSubtotal - voucherCreditApplied - tradeInCreditApplied)
      )
    : 0;
  const currentCashGiven = cashTenderAmount;

  const resteAPayer = Math.max(0, netToPay - currentCashGiven);
  const changeDue = Math.min(currentCashGiven, Math.max(0, currentCashGiven - netToPay));

  const quickBillsDZD = [500, 1000, 2000, 3000, 4000, 5000];

  const serializedItems = cart.filter((item) => item.product.isSerialized);

  // Credit limits & calculations
  const customerCurrentDebt = currentCustomer?.currentDebt || 0;
  const customerDebtLimit = getEffectiveDebtLimit(currentCustomer);
  const projectedDebtOnCredit = customerCurrentDebt + (selectedMethod === 'Crédit Client' ? netToPay : resteAPayer);
  const isOverDebtLimit = currentCustomer ? projectedDebtOnCredit > customerDebtLimit : false;

  /**
   * C90: THE derivation of "what the tender must cover" after credits. The
   * quick-tender button and the credit handlers used two different expressions
   * (netSubtotal - voucher - trade - credit vs totals.total); when they disagree
   * the drawer records the pre-credit amount and returns the difference as
   * change, which is a 100 DA overage on a credit-covered ticket (REF-28,
   * E-0012). One expression, every call site.
   */
  const netAfterCredits = (base: number, c: { voucher: number; trade: number; credit: number }): number =>
    Math.max(0, Math.round((base - (c.voucher || 0) - (c.trade || 0) - (c.credit || 0)) * 100) / 100);  // Handlers for Store Credit / Loyalty application
  const handleApplyFullCredit = () => {
    if (!currentCustomer || maxAvailableCredit <= 0) return;
    setAppliedCredit(maxAvailableCredit);
    setStoreCreditApplied(maxAvailableCredit);
      const newNet = netAfterCredits(netSubtotal, { voucher: voucherCreditApplied, trade: tradeInCreditApplied, credit: maxAvailableCredit });
    setCashTenderAmount(newNet > 0 ? newNet : 0);
    soundEngine.playSuccess();
    showToast(`🎁 Avoir Client appliqué : -${formatDZD(maxAvailableCredit)}`, 'success');
  };

  const handleApplyCustomCredit = (amount: number) => {
    if (!currentCustomer) return;
    const clamped = Math.max(
      0,
      Math.min(amount, maxAvailableCredit, Math.max(0, netSubtotal - voucherCreditApplied - tradeInCreditApplied))
    );
    setAppliedCredit(clamped);
    setStoreCreditApplied(clamped);
    const newNet = netAfterCredits(netSubtotal, { voucher: voucherCreditApplied, trade: tradeInCreditApplied, credit: clamped });
    setCashTenderAmount(newNet > 0 ? newNet : 0);
    setIsCustomCreditOpen(false);
    soundEngine.playKeyBeep?.();
    if (clamped > 0) {
      showToast(`🎁 Avoir Client partiel appliqué : -${formatDZD(clamped)}`, 'info');
    } else {
      showToast('Avoir Client retiré.', 'info');
    }
  };

  const handleRemoveCredit = () => {
    setAppliedCredit(0);
    setStoreCreditApplied(0);
      const resetNet = netAfterCredits(netSubtotal, { voucher: voucherCreditApplied, trade: tradeInCreditApplied, credit: 0 });
      setCashTenderAmount(resetNet > 0 ? resetNet : 0);
    soundEngine.playKeyBeep?.();
    showToast('Avoir Client retiré de la vente.', 'info');
  };

  // Voucher code entry: STAGES the credit on the cart (validated against the
  // durable voucher lane, never captured here). Capture happens only inside
  // processPayment after the order row is durable.
  const handleApplyVoucher = async () => {
    const code = voucherInput.trim().toUpperCase();
    if (!code || voucherBusy) return;
    setVoucherBusy(true);
    setVoucherError(null);
    try {
      const st = usePosStore.getState() as unknown as {
        redeemVoucherInCart: (c: string) => Promise<{ success: boolean; reason?: string; amount?: number }>;
      };
      const res = await st.redeemVoucherInCart(code);
      if (!res.success) {
        setVoucherError(res.reason || 'Bon refusé.');
        soundEngine.playError?.();
      } else {
        soundEngine.playSuccess?.();
        showToast(`Bon d'avoir appliqué : -${formatDZD(res.amount || 0)}`, 'success');
        setVoucherInput('');
      }
    } catch {
      setVoucherError('Vérification du bon impossible.');
    } finally {
      setVoucherBusy(false);
    }
  };

  const handleRemoveVoucher = () => {
    const st = usePosStore.getState() as unknown as { clearVoucherCredit?: () => void };
    st.clearVoucherCredit?.();
    soundEngine.playKeyBeep?.();
    showToast("Bon d'avoir retiré de la vente.", 'info');
  };

  const handleProcessPayment = async (
    isCreditSplit: boolean = false,
    opts: { skipFatFinger?: boolean } = {},
  ) => {
    if (isProcessing) return;

    // Tender-skew guard: rebuild the canonical totals from LIVE store state at
    // submit time instead of trusting render-time values (paint can lag the
    // store between render and click). Tender + change below derive from
    // submitNet/submitCash only.
    const live = usePosStore.getState();
    const liveCart = live.cart;
    const liveVoucherCredit = Math.max(
      0,
      Math.round(Number((live as unknown as { voucherCreditApplied?: number }).voucherCreditApplied) || 0)
    );
    const liveStaged = live.stagedTradeIn;
    const liveTradeInCredit = Math.max(0, Math.round(Number(liveStaged?.buybackValue) || 0));
    const submitTotals = computeCartTotals(liveCart, {
      pricingTier: live.pricingTier,
      storeCreditApplied: appliedCredit,
      voucherCreditApplied: liveVoucherCredit,
      tradeInCredit: liveTradeInCredit,
    });
    const submitNet = submitTotals.total;
    // B-026: refund-due carts submit as a pure disbursement — tender covers 0
    // and processPayment uses refundDue for the cash-out path.
    const submitRefundDue = submitTotals.refundDue;
    const submitCash = submitRefundDue > 0 ? 0 : cashTenderAmount;
    const submitReste = Math.max(0, submitNet - submitCash);
    const liveHasMissingImei = liveCart.some(
      (item) => item.product.isSerialized && (!item.imeiNumber || !item.imeiNumber.trim())
    );

    if (liveCart.length === 0) {
      showToast('Panier vide — Veuillez ajouter des articles au panier.', 'warning');
      closeModal();
      return;
    }

    if (liveHasMissingImei) {
      showToast('Veuillez saisir les numéros IMEI pour tous les articles sérialisés.', 'warning');
      return;
    }

    // Fat-finger guard ([MNY-29]): a tender far above the ticket is almost
    // always a slipped digit. Confirm once before committing; the numbers are
    // re-derived from LIVE state above, so the dialog quotes what will actually
    // be written. Skipped for a refund-due cart (its own disbursement branch)
    // and after the cashier has confirmed.
    if (!opts.skipFatFinger && submitRefundDue === 0 && isFatFingerTender(submitCash, submitNet)) {
      setFatFinger({
        tendered: submitCash,
        total: submitNet,
        change: Math.max(0, submitCash - submitNet),
        isCreditSplit,
      });
      return;
    }

    setIsProcessing(true);

    const finalTenders: PaymentTender[] = [];

    // B-026: pure refund-due cart — no cash-in tender; processPayment logs
    // the cash-out from refundDue. Skip credit/stock payment branches.
    // Staged wallet credit still rides as a leg so slice-side refund math
    // matches the displayed submitRefundDue (net of credit).
    // Soulte UX gate (slice enforces too): no payout choice, no submit.
    const liveSettlement = liveStaged
      ? computeTradeInSettlement(submitTotals.subtotalAfterDiscount, liveTradeInCredit)
      : null;
    if (liveSettlement?.direction === 'SOULTE_SHOP_PAYS' && !live.exchangeSoultePayout) {
      showToast('Soulte boutique : choisissez Décaisser Espèces ou Créditer Avoir.', 'error');
      setIsProcessing(false);
      return;
    }
    if (submitRefundDue > 0) {
      const refundAvoirLeg =
        appliedCredit > 0 ? [{ method: 'Avoir Client' as const, amount: appliedCredit }] : [];
      const refundRepriseLeg =
        liveTradeInCredit > 0 ? [{ method: 'Reprise' as const, amount: liveTradeInCredit }] : [];
      const result = (await processPayment([{ method: 'Espèces', amount: 0 }, ...refundAvoirLeg, ...refundRepriseLeg])) as unknown as {
        success: boolean;
        reason?: string;
        warnings?: string[];
      };
      if (result && !result.success) {
        setIsProcessing(false);
        if (result.reason === 'NO_ACTIVE_SHIFT') {
          showToast("Aucun shift ouvert — ouvrez un shift avant de rembourser.", 'error');
        } else if (result.reason?.startsWith('INSUFFICIENT_STOCK')) {
          showToast(`Stock insuffisant : ${result.reason.slice('INSUFFICIENT_STOCK:'.length)}`, 'error');
        } else if (result.reason === 'PERSISTENCE_FAILED' || result.reason?.startsWith('PERSISTENCE_FAILED')) {
          showToast("Erreur d'écriture base de données. Remboursement non enregistré.", 'error');
        } else {
          showToast(`Échec du remboursement (${result.reason || 'inconnu'}).`, 'error');
        }
        return;
      }
      setIsProcessing(false);
      closeModal();
      for (const w of result?.warnings ?? []) showToast(w, 'warning', 5000);
      showToast(`💵 Remboursement espèces ${formatDZD(submitRefundDue)} • Reçu imprimé`, 'success');
      return;
    }

    // 1. Add Store Credit tender if applied
    if (appliedCredit > 0) {
      finalTenders.push({ method: 'Avoir Client', amount: appliedCredit });
    }

    // 1b. Soulte-to-wallet needs an identified customer (slice guards too).
    if (
      liveSettlement?.direction === 'SOULTE_SHOP_PAYS' &&
      live.exchangeSoultePayout === 'wallet' &&
      !currentCustomer
    ) {
      showToast('Soulte vers Avoir : sélectionnez d’abord un client.', 'error');
      setIsProcessing(false);
      return;
    }

    // 2. Handle remaining balance
    if (submitNet === 0) {
      // 100% paid by Store Credit!
    } else if (selectedMethod === 'Crédit Client' || isCreditSplit) {
      if (!currentCustomer) {
        showToast('Client non identifié ! Sélectionnez un client pour autoriser le crédit.', 'error');
        setIsProcessing(false);
        return;
      }

      if (isCreditSplit) {
        // Split: Part paid in cash, remaining placed on credit
        if (submitCash > 0) {
          finalTenders.push({ method: 'Espèces', amount: submitCash });
        }
        if (submitReste > 0) {
          finalTenders.push({ method: 'Crédit Client', amount: submitReste });
        }
      } else {
        // 100% Credit sale for remaining net
        finalTenders.push({ method: 'Crédit Client', amount: submitNet });
      }
    } else if (
      selectedMethod === 'CIB / Edahabia' ||
      selectedMethod === 'BaridiMob' ||
      selectedMethod === 'Chèque'
    ) {
      finalTenders.push({
        method: selectedMethod,
        amount: submitNet,
        reference: transactionRef.trim() || undefined,
      });
    } else {
      // Cash payment
      const cashAmount = submitCash > 0 ? submitCash : submitNet;
      if (cashAmount < submitNet) {
        showToast(`Montant espèces insuffisant — Il manque ${formatDZD(submitNet - cashAmount)}`, 'error');
        setIsProcessing(false);
        return;
      }
      finalTenders.push({ method: 'Espèces', amount: cashAmount });
    }

    // 3. Reprise leg LAST (informational linkage — already netted in
    // submitNet). Last position keeps paymentMethod = the money leg, so
    // cash-sale reporting semantics are unchanged.
    if (liveTradeInCredit > 0) {
      finalTenders.push({ method: 'Reprise', amount: liveTradeInCredit });
    }

    // Non-cash tenders (Card, BaridiMob, Debt, etc.) cannot exceed the balance due
    const nonCashTenders = finalTenders.filter((t) => t.method !== 'Espèces' && t.method !== 'Reprise');
    for (const nct of nonCashTenders) {
      if (nct.amount > submitNet) {
        showToast(
          `Règlement ${nct.method} supérieur au montant dû (${formatDZD(nct.amount)} > ${formatDZD(submitNet)}) — monnaie impossible sur paiement électronique.`,
          'error'
        );
        setIsProcessing(false);
        return;
      }
    }

    // Change counts money handed (Reprise value is not cash tendered).
    // Multi-tender change cap: change returned cannot exceed physical cash received.
    const totalTendered = finalTenders
      .filter((t) => t.method !== 'Reprise')
      .reduce((acc, t) => acc + t.amount, 0);
    const cashTender = finalTenders.find((t) => t.method === 'Espèces')?.amount || 0;
    const calculatedChange = Math.min(cashTender, Math.max(0, totalTendered - submitNet));

    const result = (await processPayment(finalTenders)) as unknown as {
      success: boolean;
      reason?: string;
      warnings?: string[];
      recoveryQueued?: boolean;
    };
    if (result && !result.success) {
      setIsProcessing(false);
      if (result.reason === 'LICENSE_SALE_BLOCKED') {
        showToast('Licence expirée — nouvelles ventes bloquées (remboursements et rapports disponibles).', 'error');
      } else if (result.reason === 'INSUFFICIENT_CASH') {
        showToast('Montant insuffisant pour valider la vente.', 'error');
      } else if (result.reason === 'NO_ACTIVE_SHIFT') {
        showToast("Aucun shift ouvert — ouvrez un shift avant d'encaisser.", 'error');
      } else if (result.reason?.startsWith('INSUFFICIENT_STOCK')) {
        showToast(`Stock insuffisant : ${result.reason.slice('INSUFFICIENT_STOCK:'.length)}`, 'error');
      } else if (result.reason?.startsWith('IMEI_ALREADY_SOLD')) {
        showToast(`IMEI déjà vendu : ${result.reason.slice('IMEI_ALREADY_SOLD:'.length)}`, 'error');
      } else if (result.reason?.startsWith('VOUCHER')) {
        showToast(`Bon d'avoir refusé (${result.reason}).`, 'error');
      } else if (result.reason === 'TRADE_STAGING_DROPPED') {
        showToast('Reprise attachée mais absente des tenders — re-validez le paiement.', 'error');
      } else if (result.reason === 'TRADE_WITHOUT_STAGING') {
        showToast('Tender Reprise sans reprise attachée — retirez le tender.', 'error');
      } else if (result.reason === 'SOULTE_CHOICE_REQUIRED') {
        showToast('Soulte boutique : choisissez Décaisser Espèces ou Créditer Avoir.', 'error');
      } else if (result.reason === 'SOULTE_WALLET_NO_CUSTOMER') {
        showToast('Soulte vers Avoir : sélectionnez d’abord un client.', 'error');
      } else if (result.reason?.startsWith('SOULTE_DRAWER_INSUFFICIENT')) {
        const avail = result.reason.includes(':') ? result.reason.slice('SOULTE_DRAWER_INSUFFICIENT:'.length) : '';
        showToast(
          `Tiroir insuffisant pour la soulte${avail ? ` (dispo ≈ ${formatDZD(Number(avail) || 0)})` : ''} — choisissez Créditer Avoir ou alimentez la caisse.`,
          'error'
        );
      } else if (result.reason?.startsWith('INTAKE_FAILED')) {
        showToast(`Échec d’enregistrement de la reprise (${result.reason}) — vente annulée, panier conservé.`, 'error');
      } else if (result.reason?.startsWith('DEVICE_BLOQUE') || result.reason?.startsWith('INTAKE_BLOQUE')) {
        // UPGRADE-08 — blocked-device screen (fail-closed). Sale units have no
        // per-sale override; the audited manager path is the Inspector unblock.
        // A blocked exchange intake needs a one-shot grant from the Reprise
        // screen and then simply re-submitting the payment.
        const parts = result.reason.split(':');
        const imei = parts[1] || '';
        const why = parts.slice(2).join(':');
        showToast(
          `${result.reason.startsWith('INTAKE_BLOQUE') ? 'Reprise refusée' : 'Vente refusée'} : appareil bloqué${imei ? ` (IMEI ${imei})` : ''}${why ? ` — ${why}` : ''}. ${
            result.reason.startsWith('INTAKE_BLOQUE')
              ? 'Accordez une dérogation gérant depuis la fenêtre Reprise puis re-validez.'
              : 'Débloquez-le depuis l’Inspecteur IMEI.'
          }`,
          'error',
          12000
        );
      } else if (result.reason?.startsWith('DEVICE_CHECK_UNAVAILABLE')) {
        showToast(
          'Vérification appareil indisponible (liste de blocage illisible) — vente refusée.',
          'error',
          9000
        );
      } else if (result.reason?.startsWith('IMEI_REQUIRED')) {
        showToast('Veuillez saisir les numéros IMEI pour tous les articles sérialisés.', 'warning');
      } else if (result.reason === 'PERSISTENCE_FAILED' || result.reason?.startsWith('PERSISTENCE_FAILED')) {
        const detail = result.reason.includes(':') ? result.reason.slice('PERSISTENCE_FAILED:'.length) : '';
        console.error('[checkout] persistence failed:', detail || result.reason);
        // B-004/B-005 FIX-4: recovery intent is durable in Dexie — soft warn,
        // keep cart for reversible cash path, do NOT claim the sale is lost.
        if (result.recoveryQueued) {
          for (const w of result.warnings ?? []) showToast(w, 'warning', 6000);
          showToast(
            `Écriture SQLite en échec — panier conservé. La vente sera reprise au démarrage.${detail ? ` (${detail})` : ''}`,
            'warning',
            6000
          );
        } else {
          showToast(`Erreur d'écriture base de données. Vente non enregistrée.${detail ? ` (${detail})` : ''}`, 'error');
        }
      } else {
        showToast('Échec de validation de la vente.', 'error');
      }
    } else {
      setIsProcessing(false);
      closeModal();

      for (const w of result?.warnings ?? []) {
        showToast(w, 'warning', 5000);
      }
      // Milestone unlock celebration: the just-completed ticket is head of
      // the transactions list and carries its immutable award snapshots.
      try {
        const latest = usePosStore.getState().transactions?.[0];
        const awards = latest?.milestoneAwards || [];
        if (awards.length > 0) {
          const total = awards.reduce((acc, a) => acc + (a.rewardAmount || 0), 0);
          showToast(`🎉 Palier fidélité débloqué : +${formatDZD(total)} d'Avoir Client !`, 'success', 6000);
        }
      } catch {
        // Celebration must never break checkout UX.
      }
      if ((appliedCredit > 0 || voucherCreditApplied > 0) && submitNet === 0) {
        showToast(`Vente 100% couverte (avoir client / bon d'avoir${voucherCode ? ` ${voucherCode}` : ''}) • Reçu imprimé`, 'success');
      } else if (selectedMethod === 'Crédit Client' || isCreditSplit) {
        showToast(`📋 Vente enregistrée avec solde Crédit pour ${currentCustomer?.name} • Reçu imprimé`, 'success');
      } else if (calculatedChange > 0) {
        showToast(`✅ Vente validée • Rendu : ${formatDZD(calculatedChange)} • Reçu imprimé`, 'success');
      } else {
        showToast('✅ Vente validée avec succès • Reçu imprimé', 'success');
      }
    }
  };

  return (
    <div 
      role="dialog"
      data-testid="pay-dialog"
      aria-modal="true"
      aria-label="Encaissement et règlement"
      className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 select-none"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          // While the fat-finger confirmation is up, Enter is NOT a commit —
          // a habitual Enter right after typing the tender must never accept a
          // 100× typo ([MNY-29]). It dismisses the warning so the amount can be
          // corrected; only the explicit confirm button commits.
          if (fatFinger) {
            setFatFinger(null);
            return;
          }
          handleProcessPayment();
        }
      }}
    >
      <div className="relative bg-pos-panel border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:fade-in sm:zoom-in-95 flex flex-col max-h-[94dvh] sm:max-h-[90dvh]">
        {fatFinger && (
          <div
            data-testid="pay-fatfinger"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="pay-fatfinger-title"
            aria-describedby="pay-fatfinger-detail"
            className="absolute inset-0 z-30 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <div className="w-full max-w-sm bg-pos-panel border border-amber-500/50 rounded-2xl p-4 shadow-2xl">
              <div className="flex items-center gap-2 text-amber-400">
                <AlertCircle className="w-5 h-5 shrink-0" aria-hidden="true" />
                <h3 id="pay-fatfinger-title" className="text-sm font-black">
                  Montant encaissé inhabituel
                </h3>
              </div>
              <p id="pay-fatfinger-detail" className="mt-2 text-xs text-pos-muted">
                Montant saisi{' '}
                <strong className="text-pos-text font-mono">{formatDZD(fatFinger.tendered)}</strong> pour un
                ticket de{' '}
                <strong className="text-pos-text font-mono">{formatDZD(fatFinger.total)}</strong>.
              </p>
              {/* The change due is the number that exposes the typo. */}
              <div className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 flex items-center justify-between">
                <span className="text-[11px] font-bold text-emerald-300">Monnaie à rendre</span>
                <span
                  data-testid="pay-fatfinger-change"
                  className="text-base font-black font-mono text-emerald-300"
                >
                  {formatDZD(fatFinger.change)}
                </span>
              </div>
              <div className="mt-3 flex flex-col-reverse sm:flex-row gap-2">
                <button
                  type="button"
                  data-testid="pay-fatfinger-edit"
                  autoFocus
                  onClick={() => setFatFinger(null)}
                  className="w-full sm:flex-1 min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-bold text-pos-text bg-pos-card border border-pos-border hover:bg-pos-hover transition cursor-pointer"
                >
                  Modifier le montant
                </button>
                <button
                  type="button"
                  data-testid="pay-fatfinger-confirm"
                  onClick={() => {
                    const pending = fatFinger;
                    setFatFinger(null);
                    void handleProcessPayment(pending.isCreditSplit, { skipFatFinger: true });
                  }}
                  className="w-full sm:flex-1 min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-black text-amber-950 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 shadow-lg shadow-amber-500/20 transition cursor-pointer"
                >
                  Confirmer {formatDZD(fatFinger.tendered)}
                </button>
              </div>
            </div>
          </div>
        )}
        {/* Mobile Pull Handle */}
        <div className="w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" aria-hidden="true" />

        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold shrink-0">
              <Banknote className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-sm sm:text-base font-black text-pos-text truncate">
                  Encaissement & Règlement
                </h2>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-bold text-[10px] shrink-0">
                  Caisse Active
                </span>
              </div>
              <p className="text-[10px] text-pos-muted truncate">Encaissement Espèces & Gestion Rigoureuse des Dettes Clients</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="hidden sm:inline-flex">
              <Kbd size="sm">Esc</Kbd>
            </span>
            <button
              onClick={closeModal}
              className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
              aria-label="Fermer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-3.5 sm:p-5 overflow-y-auto overscroll-contain space-y-3.5 sm:space-y-4 flex-1">
          {/* Total Net Banner & Breakdown */}
          <div className="bg-pos-card border border-pos-border rounded-2xl p-4 shadow-sm space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[11px] uppercase tracking-wider text-pos-muted font-bold block">
                  {appliedCredit > 0 ? 'Net Restant à Encaisser' : 'Total Net à Régler'}
                </span>
                <span className="text-xs text-pos-muted">
                  {currentCustomer ? `Client : ${currentCustomer.name}` : 'Client de passage (Comptant)'} •{' '}
                  {pricingTier === 'Wholesale' ? 'Tarif Gros' : 'Tarif Détail'}
                </span>
              </div>
              <div className="text-right">
                <span data-testid="pay-net" className={`text-3xl font-black tracking-tight font-mono num ${isRefundDue ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {isRefundDue ? `-${formatDZD(refundDue)}` : formatDZD(netToPay)}
                </span>
                {isRefundDue && (
                  <span className="text-[10px] text-rose-300 font-bold block uppercase tracking-wider">
                    Remboursement dû au client
                  </span>
                )}
              </div>
            </div>

            {/* Subtotal & Store Credit breakdown pill */}
              {(cartDiscount > 0 || appliedCredit > 0 || voucherCreditApplied > 0 || tradeInCreditApplied > 0) && (
              <div className="pt-2 border-t border-pos-border/60 flex items-center justify-between text-xs font-mono">
                <div className="flex items-center gap-2 text-pos-muted flex-wrap">
                  <span>Sous-total: {formatDZD(grossSubtotal)}</span>
                    {cartDiscount > 0 && (
                      <span className="text-purple-400 font-bold">Remise: -{formatDZD(cartDiscount)}</span>
                    )}
                  {appliedCredit > 0 && (
                  <span className="text-purple-400 font-bold flex items-center gap-1">
                    <Gift className="w-3.5 h-3.5" /> Avoir Déduit: -{formatDZD(appliedCredit)}
                  </span>
                  )}
                  {voucherCreditApplied > 0 && (
                    <span className="text-purple-400 font-bold">
                      Bon{voucherCode ? ` ${voucherCode}` : ''}: -{formatDZD(voucherCreditApplied)}
                    </span>
                  )}
                  {tradeInCreditApplied > 0 && (
                    <span className="text-emerald-400 font-bold flex items-center gap-1">
                      <RefreshCw className="w-3.5 h-3.5" /> Reprise: -{formatDZD(tradeInCreditApplied)}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleRemoveCredit}
                  className="text-[10px] text-red-400 hover:text-red-300 font-sans font-bold transition cursor-pointer underline"
                >
                  Annuler Avoir
                </button>
              </div>
            )}
          </div>

          {/* ══════════════════════════════════════════════════════════════ */}
          {/* TWO-WAY EXCHANGE DELTA / SOULTE BOUTIQUE (Phase 3) */}
          {/* ══════════════════════════════════════════════════════════════ */}
          {stagedTradeIn && tradeSettlement && !isRefundDue && (
            <div className="rounded-2xl p-4 space-y-2 border bg-emerald-500/10 border-emerald-500/40">
              <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wide text-emerald-300">
                <RefreshCw className="w-4 h-4 shrink-0" />
                <span>Échange : {stagedTradeIn.deviceModel}</span>
                <button
                  type="button"
                  onClick={() => {
                    clearStagedTradeIn();
                    setExchangeSoultePayout(null);
                    showToast('Reprise retirée de la vente.', 'info');
                  }}
                  className="ml-auto text-[10px] font-bold text-pos-muted hover:text-red-400 underline cursor-pointer"
                >
                  Retirer
                </button>
              </div>
              {tradeSettlement.direction === 'CUSTOMER_PAYS' || tradeSettlement.direction === 'EVEN' ? (
                <p className="text-sm font-bold text-pos-text">
                  Total Panier : {formatDZD(netSubtotal)} — Valeur Reprise : {formatDZD(tradeInCredit)} ={' '}
                  {/* Reste = true totals net (all credits), NOT the trade-only
                      delta — stacked avoir/bon would otherwise disagree. */}
                  <span className="text-emerald-300 font-black">Reste à Encaisser : {formatDZD(netToPay)}</span>
                </p>
              ) : (
                <div className="space-y-2.5">
                  <p className="text-sm font-bold text-pos-text">
                    Valeur Reprise : {formatDZD(tradeInCredit)} — Total Panier : {formatDZD(netSubtotal)} ={' '}
                    <span className="text-amber-300 font-black">Montant à Verser au Client : {formatDZD(soulteDue)}</span>
                  </p>
                  <p className="text-[11px] text-pos-muted font-semibold">Soulte Boutique — choix obligatoire du caissier :</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={exchangeSoultePayout === 'cash'}
                      onClick={() => setExchangeSoultePayout('cash')}
                      className={`min-h-[48px] px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer active:scale-[0.98] ${
                        exchangeSoultePayout === 'cash'
                          ? 'bg-emerald-500 text-slate-950 border-emerald-400'
                          : 'bg-pos-card text-pos-text border-pos-border hover:border-emerald-500/50'
                      }`}
                    >
                      <Banknote className="w-4 h-4 shrink-0" /> Décaisser Espèces (Tiroir)
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={exchangeSoultePayout === 'wallet'}
                      onClick={() => setExchangeSoultePayout('wallet')}
                      className={`min-h-[48px] px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer active:scale-[0.98] ${
                        exchangeSoultePayout === 'wallet'
                          ? 'bg-purple-500 text-white border-purple-400'
                          : 'bg-pos-card text-pos-text border-pos-border hover:border-purple-500/50'
                      }`}
                    >
                      <Wallet className="w-4 h-4 shrink-0" /> Créditer Portefeuille Avoir
                    </button>
                  </div>
                  {!exchangeSoultePayout && (
                    <p className="text-[11px] font-bold text-amber-300">Sélectionnez un mode de versement pour valider.</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════ */}
          {/* LOYALTY & STORE CREDIT DEDUCTION CARD */}
          {/* ══════════════════════════════════════════════════════════════ */}
          {currentCustomer ? (
            <div className="bg-gradient-to-br from-purple-950/30 to-indigo-950/30 border border-purple-500/40 rounded-2xl p-3.5 space-y-2.5 animate-in fade-in">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-purple-500/20 text-purple-300 flex items-center justify-center font-bold">
                    <Gift className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-purple-200">Avoir & Crédit Fidélité Disponible</span>
                      <span className="bg-purple-500/20 text-purple-300 text-[10px] font-mono font-black px-2 py-0.5 rounded-full border border-purple-500/30">
                        {formatDZD(currentCustomer.storeCredit || 0)}
                      </span>
                    </div>
                    <span className="text-[10px] text-pos-muted flex items-center gap-1">
                      <Star className="w-3 h-3 text-amber-400 fill-amber-400" />
                      {currentCustomer.loyaltyPoints || 0} Points accumulés • Palier {resolveTierName(currentCustomer.totalSpent)}
                      {(currentCustomer.storeCredit || 0) < 0 && (
                        <span className="text-orange-300 font-bold"> • Solde à récupérer: {formatDZD(currentCustomer.storeCredit)}</span>
                      )}
                    </span>
                  </div>
                </div>

                {/* Quick Action Button */}
                {(currentCustomer.storeCredit || 0) > 0 && appliedCredit === 0 && (
                  <button
                    type="button"
                    onClick={handleApplyFullCredit}
                    className="px-3 py-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl text-xs font-black flex items-center gap-1.5 shadow-md shadow-purple-900/30 transition cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-purple-200" />
                    <span>Appliquer Tout ({formatDZD(maxAvailableCredit)})</span>
                  </button>
                )}

                {appliedCredit > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[11px] font-bold px-2.5 py-1 rounded-xl flex items-center gap-1">
                      <Check className="w-3.5 h-3.5" /> Appliqué (-{formatDZD(appliedCredit)})
                    </span>
                    <button
                      type="button"
                      onClick={handleRemoveCredit}
                      className="p-1 hover:bg-red-500/20 text-pos-muted hover:text-red-400 rounded-lg transition cursor-pointer"
                      title="Retirer l'avoir"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>

              {/* Partial / Custom Credit Presets */}
              {(currentCustomer.storeCredit || 0) > 0 && (
                <div className="flex items-center gap-1.5 pt-1 border-t border-purple-500/20 text-xs">
                  <span className="text-[10px] text-purple-300 font-bold uppercase tracking-wider">Montants Rapides :</span>
                  {[500, 1000, 2000, 5000].map((amt) => {
                    if (amt > maxAvailableCredit || amt > Math.max(0, netSubtotal - voucherCreditApplied)) return null;
                    const isSelected = appliedCredit === amt;
                    return (
                      <button
                        key={amt}
                        type="button"
                        onClick={() => handleApplyCustomCredit(amt)}
                        className={`px-2 py-1 rounded-lg text-[10.5px] font-mono font-bold border transition cursor-pointer ${
                          isSelected
                            ? 'bg-purple-500 text-white border-purple-400 shadow-sm'
                            : 'bg-purple-950/40 hover:bg-purple-500/20 text-purple-200 border-purple-500/30'
                        }`}
                      >
                        {amt.toLocaleString('fr-DZ')} DA
                      </button>
                    );
                  })}

                  <button
                    type="button"
                    onClick={() => setIsCustomCreditOpen(!isCustomCreditOpen)}
                    className="ml-auto text-[10px] text-purple-300 hover:text-purple-200 underline font-semibold transition cursor-pointer"
                  >
                    {isCustomCreditOpen ? 'Fermer' : 'Autre montant...'}
                  </button>
                </div>
              )}

              {/* Custom Credit Amount Input */}
              {isCustomCreditOpen && (
                <div className="flex items-center gap-2 pt-1 animate-in fade-in slide-in-from-top-1">
                  <MoneyInput
                    label="Montant avoir personnalisé (DA)"
                    valueMinor={dinarsToMinor(customCreditInput || 0)}
                    onChangeMinor={(minor) => setCustomCreditInput(toLegacyReal(minor))}
                    placeholder={`Max ${maxAvailableCredit} DA`}
                    className="flex-1 bg-pos-bg border border-purple-500/50 rounded-xl px-3 py-1.5 text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-purple-400"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      handleApplyCustomCredit(customCreditInput);
                    }}
                    className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-xs font-bold transition cursor-pointer"
                  >
                    Valider Avoir
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-pos-muted">
                <UserCheck className="w-4 h-4 text-emerald-400" />
                <span className="text-[11px]">Client Comptant de Passage</span>
              </div>
              <button
                type="button"
                onClick={() => openModal('customers')}
                className="px-2.5 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg text-[11px] font-bold flex items-center gap-1 transition cursor-pointer"
              >
                <Search className="w-3 h-3" />
                <span>Identifier Client (Avoir / Dette)</span>
              </button>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════ */}
          {/* VOUCHER CODE ENTRY (staged credit, captured at payment only) */}
          {/* ══════════════════════════════════════════════════════════════ */}
          <div className="bg-pos-card border border-pos-border rounded-2xl p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                <Gift className="w-4 h-4 text-purple-400" /> Bon d&apos;Avoir (code AV-...)
              </span>
              {voucherCreditApplied > 0 && (
                <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[11px] font-bold px-2.5 py-1 rounded-xl">
                  Appliqué (-{formatDZD(voucherCreditApplied)})
                </span>
              )}
            </div>
            {voucherCreditApplied > 0 ? (
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono font-bold text-purple-300">{voucherCode}</span>
                <button
                  type="button"
                  onClick={handleRemoveVoucher}
                  className="text-[10px] text-red-400 hover:text-red-300 font-bold underline transition cursor-pointer"
                >
                  Retirer le bon
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={voucherInput}
                    onChange={(e) => {
                      setVoucherInput(e.target.value.toUpperCase());
                      setVoucherError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleApplyVoucher();
                      }
                    }}
                    placeholder="Ex : AV-123456"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck="false"
                    className="flex-1 min-w-0 bg-pos-bg border border-pos-border focus:border-purple-400 rounded-xl px-3 py-1.5 text-xs font-mono font-bold text-pos-text focus:outline-none uppercase"
                  />
                  <button
                    type="button"
                    onClick={() => void handleApplyVoucher()}
                    disabled={voucherBusy || !voucherInput.trim()}
                    className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white rounded-xl text-xs font-bold transition cursor-pointer"
                  >
                    {voucherBusy ? '...' : 'Appliquer'}
                  </button>
                </div>
                {voucherError && (
                  <p className="text-[11px] text-red-400 font-bold">{voucherError}</p>
                )}
                <p className="text-[10px] text-pos-muted">
                  Le solde est vérifié puis déduit uniquement à la validation de la vente.
                </p>
              </div>
            )}
          </div>

          {/* ══════════════════════════════════════════════════════════════ */}
          {/* 100% STORE CREDIT COVERAGE NOTIFICATION */}
          {/* ══════════════════════════════════════════════════════════════ */}
          {/* ══════════════════════════════════════════════════════════════ */}
          {/* REFUND DUE NOTIFICATION (B-026) */}
          {/* ══════════════════════════════════════════════════════════════ */}
          {isRefundDue ? (
            <div className="p-4 rounded-2xl bg-gradient-to-br from-rose-950/80 to-red-950/80 border border-rose-500 text-rose-300 shadow-lg space-y-1.5 animate-in fade-in">
              <div className="flex items-center gap-2 font-black text-sm text-rose-300">
                <RotateCcw className="w-5 h-5" />
                <span>Remboursement espèces dû : {formatDZD(refundDue)}</span>
              </div>
              <p className="text-xs text-rose-200/80">
                Les retours dépassent le panier — la caisse doit rembourser{' '}
                {formatDZD(refundDue)} au client. Aucun encaissement n&apos;est requis.
              </p>
            </div>
          ) : netToPay === 0 && (appliedCredit > 0 || voucherCreditApplied > 0) ? (
            <div className="p-4 rounded-2xl bg-gradient-to-br from-purple-950/80 to-emerald-950/80 border border-emerald-500 text-emerald-300 shadow-lg space-y-1.5 animate-in fade-in">
              <div className="flex items-center gap-2 font-black text-sm text-emerald-300">
                <Sparkles className="w-5 h-5 text-purple-300" />
                <span>Panier 100% Couvert (Avoir / Bon) !</span>
              </div>
              <p className="text-xs text-emerald-200/80">
                Le montant total de {formatDZD(netSubtotal)} est intégralement couvert
                {appliedCredit > 0 && currentCustomer ? ` (avoir ${currentCustomer.name})` : ''}
                {voucherCreditApplied > 0 ? ` (bon ${voucherCode})` : ''}. Aucun encaissement en espèces n&apos;est requis.
              </p>
            </div>
          ) : (
            <>
              {/* Payment Method Selector Tabs */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 bg-pos-bg p-1 rounded-xl border border-pos-border">
                <button
                  type="button"
                  onClick={() => setSelectedMethod('Espèces')}
                  className={`py-2 px-2 rounded-lg text-[11px] font-black flex items-center justify-center gap-1.5 transition cursor-pointer ${
                    selectedMethod === 'Espèces'
                      ? 'bg-emerald-500 text-slate-950 shadow-md'
                      : 'text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <Banknote className="w-3.5 h-3.5" />
                  <span>Espèces</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedMethod('CIB / Edahabia')}
                  className={`py-2 px-2 rounded-lg text-[11px] font-black flex items-center justify-center gap-1.5 transition cursor-pointer ${
                    selectedMethod === 'CIB / Edahabia'
                      ? 'bg-blue-500 text-white shadow-md'
                      : 'text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <CreditCard className="w-3.5 h-3.5" />
                  <span>CIB / Carte</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedMethod('BaridiMob')}
                  className={`py-2 px-2 rounded-lg text-[11px] font-black flex items-center justify-center gap-1.5 transition cursor-pointer ${
                    selectedMethod === 'BaridiMob'
                      ? 'bg-amber-400 text-slate-950 shadow-md'
                      : 'text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <Smartphone className="w-3.5 h-3.5" />
                  <span>BaridiMob</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedMethod('Chèque')}
                  className={`py-2 px-2 rounded-lg text-[11px] font-black flex items-center justify-center gap-1.5 transition cursor-pointer ${
                    selectedMethod === 'Chèque'
                      ? 'bg-indigo-500 text-white shadow-md'
                      : 'text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <Receipt className="w-3.5 h-3.5" />
                  <span>Chèque</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedMethod('Crédit Client')}
                  className={`py-2 px-2 rounded-lg text-[11px] font-black flex items-center justify-center gap-1.5 transition cursor-pointer ${
                    selectedMethod === 'Crédit Client'
                      ? 'bg-amber-500 text-slate-950 shadow-md'
                      : 'text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>Crédit</span>
                </button>
              </div>

              {/* Mode 1: Cash Payment View */}
              {selectedMethod === 'Espèces' && (
                <div className="space-y-4 animate-in fade-in">
                  {/* Real-time Change Due / Remaining Box */}
                  <div
                    className={`p-4 rounded-2xl border transition-all duration-150 shadow-lg ${
                      currentCashGiven >= netToPay
                        ? 'bg-gradient-to-br from-emerald-950/80 to-teal-950/80 border-emerald-500 text-emerald-300 shadow-emerald-950/50'
                        : 'bg-red-950/30 border-red-500/60 text-red-300 shadow-red-950/40'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-xs font-black uppercase tracking-wider block">
                          {currentCashGiven >= netToPay
                            ? '⚡ À Rendre au Client (Rendu Monnaie)'
                            : '⚠️ Reste à Encaisser en Espèces'}
                        </span>
                        <span className="text-[10px] opacity-80">
                          {currentCashGiven >= netToPay
                            ? 'Calculé automatiquement en temps réel'
                            : 'Espèces reçues insuffisantes'}
                        </span>
                      </div>
                      <div className="text-right">
                        <span
                          data-testid="pay-change"
                          className={`text-3xl font-black tracking-tight font-mono ${
                            currentCashGiven >= netToPay ? 'text-emerald-300' : 'text-red-400'
                          }`}
                        >
                          {currentCashGiven >= netToPay ? formatDZD(changeDue) : formatDZD(resteAPayer)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Cash Input */}
                  <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3">
                    <label className="text-xs font-extrabold text-pos-text uppercase tracking-wide flex items-center gap-1.5">
                      <Banknote className="w-4 h-4 text-emerald-400" />
                      Espèces Reçues du Client (DA) :
                    </label>

                    <div>
                      <MoneyInput
                        label="Espèces Reçues du Client (DA)"
                        id="payment-cash-input"
                        data-testid="tendered-input"
                        valueMinor={dinarsToMinor(cashTenderAmount || 0)}
                        onChangeMinor={(minor) => setCashTenderAmount(toLegacyReal(minor))}
                        placeholder={netToPay.toString()}
                        className="w-full bg-pos-bg border border-pos-border focus:border-emerald-400 rounded-xl px-4 py-3 text-3xl font-black font-mono text-pos-text focus:outline-none transition"
                      />
                    </div>

                    {/* Quick Bill Tap Buttons */}
                    <div className="space-y-1.5 pt-1">
                      <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider block">
                        Coupures Rapides (1-Clic) :
                      </span>
                      <div className="grid grid-cols-4 sm:grid-cols-7 gap-1.5">
                        <button
                          type="button"
                          data-testid="pay-exact"
                          onClick={() => {
                            setCashTenderAmount(netAfterCredits(netSubtotal, { voucher: voucherCreditApplied, trade: tradeInCreditApplied, credit: appliedCredit }));
                            document.getElementById('payment-cash-input')?.focus();
                          }}
                          className="py-2.5 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 rounded-xl text-xs font-black text-emerald-300 transition cursor-pointer"
                          title="Montant exact net"
                        >
                          Exact
                        </button>
                        {quickBillsDZD.map((bill) => (
                          <button
                            key={bill}
                            type="button"
                            onClick={() => {
                              setCashTenderAmount(bill);
                              document.getElementById('payment-cash-input')?.focus();
                            }}
                            className={`py-2.5 rounded-xl text-xs font-black border transition cursor-pointer font-mono ${
                              bill >= netToPay
                                ? 'bg-pos-bg hover:bg-emerald-500/20 border-pos-border hover:border-emerald-500/50 text-pos-text hover:text-emerald-300'
                                : 'bg-pos-bg border-pos-border opacity-40 text-pos-muted'
                            }`}
                          >
                            {bill.toLocaleString('fr-DZ')}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Partial Payment: Put Remaining Balance on Credit */}
                  {currentCustomer && resteAPayer > 0 && currentCashGiven > 0 && (
                    <div className="bg-amber-950/30 border border-amber-500/40 p-3.5 rounded-xl flex items-center justify-between text-xs animate-in fade-in">
                      <div>
                        <p className="font-bold text-amber-300">Paiement Partiel pour {currentCustomer.name}</p>
                        <p className="text-[10px] text-amber-200/80">
                          Encaisser {formatDZD(currentCashGiven)} en espèces + ajouter le reste ({formatDZD(resteAPayer)}) en dette
                        </p>
                      </div>
                      <button
                        type="button"
                        data-testid="pay-mixed-confirm"
                        onClick={() => handleProcessPayment(true)}
                        className="px-3.5 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs rounded-xl transition cursor-pointer shadow-md"
                      >
                        + Valider Vente Mixte
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Mode 3: Electronic & Cheque Payments */}
              {['CIB / Edahabia', 'BaridiMob', 'Chèque'].includes(selectedMethod) && (
                <div className="space-y-4 animate-in fade-in">
                  <div className="p-4 rounded-2xl border bg-gradient-to-br from-indigo-950/60 to-blue-950/60 border-indigo-500/50 text-indigo-200 shadow-lg">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-xs font-black uppercase tracking-wider block">
                          Règlement {selectedMethod}
                        </span>
                        <span className="text-[11px] opacity-80">
                          {selectedMethod === 'Chèque'
                            ? 'Paiement par chèque bancaire'
                            : selectedMethod === 'BaridiMob'
                            ? 'Virement postal BaridiMob'
                            : 'Paiement TPE par Carte CIB / Edahabia'}
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="text-2xl font-black font-mono text-indigo-300">
                          {formatDZD(netToPay)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="p-4 rounded-xl border border-pos-border bg-pos-card space-y-3">
                    <label className="text-xs font-bold text-pos-text block">
                      {selectedMethod === 'Chèque'
                        ? 'N° de Chèque & Banque Émettrice (optionnel)'
                        : selectedMethod === 'BaridiMob'
                        ? 'Réf. Transaction / RIP BaridiMob (optionnel)'
                        : 'N° Autorisation TPE / Réf. Ticket (optionnel)'}
                    </label>
                    <input
                      type="text"
                      value={transactionRef}
                      onChange={(e) => setTransactionRef(e.target.value)}
                      placeholder={
                        selectedMethod === 'Chèque'
                          ? 'Ex: CHQ-984210 / BNA'
                          : selectedMethod === 'BaridiMob'
                          ? 'Ex: Réf 12948271'
                          : 'Ex: TPE-0042918'
                      }
                      className="w-full px-3 py-2.5 rounded-lg bg-pos-bg border border-pos-border text-sm text-pos-text focus:outline-none focus:border-indigo-500 transition font-mono"
                    />
                    <p className="text-[11px] text-pos-muted">
                      Le montant intégral de <strong className="text-pos-text font-mono">{formatDZD(netToPay)}</strong> sera enregistré sous le tender <strong className="text-pos-text">{selectedMethod}</strong>.
                    </p>
                  </div>
                </div>
              )}

              {/* Mode 2: Strict Customer Credit View */}
              {selectedMethod === 'Crédit Client' && (
                <div className="space-y-4 animate-in fade-in">
                  {currentCustomer ? (
                    <div className="bg-amber-950/20 border border-amber-500/40 rounded-2xl p-4 space-y-3">
                      <div className="flex items-center justify-between pb-3 border-b border-amber-500/20">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center font-black">
                            <UserCheck className="w-4 h-4" />
                          </div>
                          <div>
                            <h4 className="font-black text-amber-300 text-sm">{currentCustomer.name}</h4>
                            <p className="text-[10px] text-amber-200/70">
                              Tél: {currentCustomer.phone} • Réf: {currentCustomer.id.slice(0, 8)}
                            </p>
                          </div>
                        </div>
                        <span className="px-2.5 py-1 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-black">
                          Vente à Crédit
                        </span>
                      </div>

                      {/* Debt Status Grid */}
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-center text-xs">
                        <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border">
                          <span className="text-[9px] uppercase font-bold text-pos-muted block">Dette Actuelle</span>
                          <span className="font-black text-amber-400 font-mono text-sm">{formatDZD(customerCurrentDebt)}</span>
                        </div>
                        <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border">
                          <span className="text-[9px] uppercase font-bold text-pos-muted block">Montant Net Vente</span>
                          <span className="font-black text-pos-text font-mono text-sm">+{formatDZD(netToPay)}</span>
                        </div>
                        <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border">
                          <span className="text-[9px] uppercase font-bold text-pos-muted block">Nouveau Solde</span>
                          <span className="font-black text-red-400 font-mono text-sm">{formatDZD(projectedDebtOnCredit)}</span>
                        </div>
                      </div>

                      {/* Credit Ceiling Guardrail */}
                      {isOverDebtLimit && (
                        <div className="p-2.5 rounded-xl bg-red-950/40 border border-red-500/50 text-red-300 text-xs flex items-center gap-2">
                          <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                          <span>⚠️ Attention : Le solde projeté dépasse le plafond autorisé de {formatDZD(customerDebtLimit)}.</span>
                        </div>
                      )}

                      <p className="text-[10px] text-pos-muted italic">
                        • L'enregistrement ajoutera cette créance dans le Grand Livre des Dettes et sur le ticket imprimé.
                      </p>
                    </div>
                  ) : (
                    <div className="p-6 bg-red-950/20 border border-red-500/40 rounded-2xl text-center space-y-3">
                      <AlertCircle className="w-8 h-8 text-red-400 mx-auto" />
                      <div>
                        <h4 className="font-bold text-red-300 text-sm">Client Non Identifié</h4>
                        <p className="text-xs text-pos-muted mt-1 max-w-sm mx-auto">
                          Les ventes à crédit nécessitent obligatoirement un compte client enregistré pour la traçabilité des créances.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => openModal('customers')}
                        className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl transition cursor-pointer"
                      >
                        🔍 Sélectionner un Client
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Serialized Items IMEI Gate */}
          {serializedItems.length > 0 && (
            <div className="bg-amber-950/30 border border-amber-500/30 rounded-xl p-3 space-y-2">
              <h4 className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4" /> Numéros IMEI requis pour validation
              </h4>
              <div className="space-y-2">
                {serializedItems.map((item) => {
                  const availableImeis = (imeiRecords || []).filter(
                    (r) => r.productId === item.product.id && !r.saleTransactionId && !r.soldAt
                  );
                  return (
                    <div key={item.product.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-pos-bg p-2.5 rounded-lg border border-pos-border">
                      <span className="text-xs text-pos-text flex-1 truncate font-bold">{item.product.title}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {availableImeis.length > 0 ? (
                          <select
                            value={item.imeiNumber || ''}
                            onChange={(e) => setCartItemIMEI(item.product.id, e.target.value)}
                            className={`text-xs px-2 py-1.5 rounded-lg border ${
                              !item.imeiNumber ? 'border-amber-500 bg-amber-500/10 text-amber-300' : 'border-pos-border bg-pos-card text-pos-text'
                            } focus:outline-none focus:border-emerald-500 font-mono`}
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
                          placeholder="Saisir ou scanner IMEI..."
                          value={item.imeiNumber || ''}
                          onChange={(e) => setCartItemIMEI(item.product.id, e.target.value)}
                          className={`text-xs px-2.5 py-1.5 rounded-lg border ${
                            !item.imeiNumber ? 'border-amber-500 bg-amber-500/10' : 'border-pos-border bg-pos-card'
                          } text-pos-text focus:outline-none focus:border-emerald-500 w-44 font-mono`}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Legal / Policy Indicator */}
          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between text-xs text-pos-muted">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span className="text-[11px] font-semibold text-pos-text">Traçabilité & Impression Thermique Automatique</span>
            </div>
            <span className="text-[10px] text-emerald-400 font-bold">Routage 80mm</span>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3.5 sm:p-4 pb-[max(1rem,var(--safe-bottom))] sm:pb-4 border-t border-pos-border bg-pos-card flex flex-col-reverse sm:flex-row items-center justify-between gap-2 shrink-0">
          <button
            data-testid="pay-cancel"
            onClick={closeModal}
            className="w-full sm:w-auto min-h-[42px] px-4 py-2.5 rounded-xl text-xs font-bold text-pos-muted hover:text-pos-text hover:bg-pos-hover transition cursor-pointer text-center"
          >
            Annuler (Échap)
          </button>
          <button
            type="button"
            data-testid="pay-confirm"
            onClick={() => handleProcessPayment(false)}
            disabled={
              isProcessing ||
              (selectedMethod === 'Crédit Client' && !currentCustomer && netToPay > 0) ||
              (isSoulte && !exchangeSoultePayout)
            }
            className={`w-full sm:w-auto min-h-[48px] glow-btn px-6 sm:px-8 py-3 rounded-xl text-white font-black text-sm shadow-xl flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 ${
              isRefundDue
                ? 'bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 shadow-rose-600/25'
                : netToPay === 0 && appliedCredit > 0
                ? 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 shadow-purple-600/25'
                : selectedMethod === 'Crédit Client'
                ? 'bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 shadow-amber-600/25'
                : selectedMethod === 'CIB / Edahabia'
                ? 'bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 shadow-blue-600/25'
                : selectedMethod === 'BaridiMob'
                ? 'bg-gradient-to-r from-amber-500 to-yellow-500 text-slate-950 hover:from-amber-400 hover:to-yellow-400 shadow-amber-500/25'
                : selectedMethod === 'Chèque'
                ? 'bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 shadow-indigo-600/25'
                : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-emerald-600/25'
            }`}
          >
            <CheckCircle2 className="w-5 h-5 shrink-0 stroke-[2.5]" />
            <span className="truncate">
              {isRefundDue
                ? `Rembourser ${formatDZD(refundDue)}`
                : netToPay === 0 && appliedCredit > 0
                ? 'Valider Paiement Avoir (100%)'
                : selectedMethod === 'Crédit Client'
                ? 'Valider Vente à Crédit'
                : selectedMethod === 'CIB / Edahabia'
                ? `Valider Carte CIB (${formatDZD(netToPay)})`
                : selectedMethod === 'BaridiMob'
                ? `Valider BaridiMob (${formatDZD(netToPay)})`
                : selectedMethod === 'Chèque'
                ? `Valider Chèque (${formatDZD(netToPay)})`
                : 'Valider & Imprimer Reçu'}
            </span>
            <span className="hidden sm:inline bg-black/40 text-emerald-200 border border-white/20 px-2 py-0.5 rounded text-xs font-mono">
              Entrée ↵
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};



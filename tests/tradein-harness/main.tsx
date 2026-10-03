/**
 * ISOLATED UI HARNESS — Trade-In / Reprise modal. Test scaffolding only,
 * never imported by src/. Same pattern as tests/harness (SAV/inspector):
 * the modal is prop-less, reads all state from usePosStore(), and
 * self-gates on activeModal === 'trade_in_buyback'. Mounted against the
 * real store + real Tailwind pipeline so computed styles are production.
 *
 * Reachable only at /tests/tradein-harness/index.html (?modal=tradein).
 * Excluded from `tsc -b` because tsconfig.app.json includes only "src".
 */
import { Component, StrictMode, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { usePosStore } from '../../src/store/usePosStore';
import { ToastProvider } from '../../src/components/ui/Toast';
import { TradeInBuybackModal } from '../../src/components/modals/TradeInBuybackModal';
import { CartPanel } from '../../src/components/CartPanel';
import { PaymentModal } from '../../src/components/modals/PaymentModal';
import { RefundModal } from '../../src/components/modals/RefundModal';
import { ProductMatrixModal } from '../../src/components/modals/ProductMatrixModal';
import type { CartItem, Product } from '../../src/types/pos';
import '../../src/index.css';

declare global {
  interface Window {
    __harnessReady: boolean;
    __harnessError: string | null;
    __harnessOpenTradeIn: () => void;
    /** Store-level counts for zero-orphan assertions (Suite 4). */
    __harnessSnapshot: () => { tradeIns: number; products: number; staged: unknown };
    /** Seed one cart line + open a modal (flow tests, no DB writes). */
    __harnessSeedCart: (unitPrice: number) => void;
    __harnessOpenPayment: () => void;
    __harnessStageTradeIn: (buybackValue: number) => void;
    __harnessSetShift: (openingFloat: number) => void;
    __harnessSeedCartLines: (lines: Array<{ price: number; discount?: number; title?: string }>) => void;
    __harnessSetAvoirAndVoucher: (storeCredit: number, voucherCredit: number) => void;
    __harnessSetVatRate: (rate: number) => void;
    __harnessDexie: (table: string) => Promise<Array<Record<string, unknown>>>;
    __harnessBlastPayment: (n: number) => Promise<Array<string>>;
    __harnessOpenRefund: (txn: Record<string, unknown>) => void;
    __harnessProcessRefund: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
    __harnessOpenMatrix: () => void;
  }
}

const SEED_PRODUCT = (unitPrice: number): Product =>
  ({
    id: 'harness-phone-neuf',
    sku: 'HARNESS-NEUF-001',
    barcode: '6130000000016',
    title: 'Galaxy S24 Neuf (Harness)',
    brand: 'Samsung',
    compatibleModel: 'Galaxy S24',
    category: 'Smartphones Neufs',
    price: unitPrice,
    wholesalePrice: Math.round(unitPrice * 0.8),
    costPrice: Math.round(unitPrice * 0.7),
    stock: 10,
    isSerialized: false,
    vendorName: 'Harness',
    leadTimeDays: 0,
    dailySalesVelocity: 1,
    reorderPoint: 0,
  }) as unknown as Product;

window.__harnessReady = false;
window.__harnessError = null;
window.__harnessOpenTradeIn = () => {
  usePosStore.getState().openModal('trade_in_buyback');
};
(window as unknown as { __harnessOpenExchange: () => void }).__harnessOpenExchange = () => {
  usePosStore.getState().openTradeInExchange();
};
type W = Window & {
  __harnessSetShift: (openingFloat: number) => void;
  __harnessSeedCartLines: (lines: Array<{ price: number; discount?: number; title?: string }>) => void;
  __harnessSetAvoirAndVoucher: (storeCredit: number, voucherCredit: number) => void;
  __harnessSetVatRate: (rate: number) => void;
  __harnessDexie: (table: string) => Promise<Array<Record<string, unknown>>>;
  __harnessBlastPayment: (n: number) => Promise<Array<string>>;
  __harnessOpenRefund: (txn: Record<string, unknown>) => void;
  __harnessProcessRefund: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  __harnessOpenMatrix: () => void;
};
const W = window as unknown as W;
W.__harnessSetShift = (openingFloat: number) => {
  // Fake OPEN shift (memory only): enough to pass the NO_ACTIVE_SHIFT gate
  // so pre-write guards (soulte, staging) execute for real in the harness.
  usePosStore.setState({
    activeShift: {
      id: 'shift-harness',
      openedAt: new Date(Date.now() - 3600_000).toISOString(),
      openingFloat,
      cashierName: 'Harness',
      status: 'OPEN',
      movements: [],
    } as unknown as never,
  });
};
W.__harnessSeedCartLines = (lines) => {
  usePosStore.setState({
    cart: lines.map((l, i) => ({
      product: { ...SEED_PRODUCT(l.price), id: `harness-prod-${i}`, title: l.title || `Article ${i + 1}` },
      quantity: 1,
      appliedPrice: l.price,
      discount: l.discount || 0,
    })),
  });
};
W.__harnessSetAvoirAndVoucher = (storeCredit: number, voucherCredit: number) => {
  usePosStore.getState().setStoreCreditApplied(storeCredit);
  usePosStore.setState({ voucherCreditApplied: voucherCredit } as unknown as never);
};
W.__harnessSetVatRate = (rate: number) => {
  const s = usePosStore.getState();
  usePosStore.setState({
    receiptSettings: { ...(s.receiptSettings || {}), vatRate: rate },
  } as unknown as never);
};
W.__harnessDexie = async (table: string) => {
  const { db } = await import('../../src/db/database');
  const t = (db as unknown as Record<string, { toArray: () => Promise<Array<Record<string, unknown>>> }>)[table];
  if (!t) throw new Error(`unknown dexie table ${table}`);
  return t.toArray();
};
W.__harnessBlastPayment = async (n: number) => {
  const st = usePosStore.getState();
  const calls = Array.from({ length: n }, () =>
    st
      .processPayment()
      .then((r) => String((r as { reason?: string }).reason || 'ok'))
      .catch((e: unknown) => `threw:${e instanceof Error ? e.message : String(e)}`)
  );
  return Promise.all(calls);
};
type W5 = Window & { __harnessPayCash: (amount: number) => Promise<string> };
const W5 = window as unknown as W5;
// Full-tender solo payment: reaches the durable write lane (fails closed
// without the native lane — the point is the reason code, not success).
W5.__harnessPayCash = async (amount: number) => {
  const st = usePosStore.getState();
  try {
    const r = (await st.processPayment([{ method: 'Espèces', amount }])) as unknown as {
      success?: boolean;
      reason?: string;
    };
    return String(r?.reason || (r?.success ? 'ok' : 'unknown'));
  } catch (e: unknown) {
    return `threw:${e instanceof Error ? e.message : String(e)}`;
  }
};
W.__harnessOpenRefund = (txn: Record<string, unknown>) => {
  const st = usePosStore.getState();
  st.setSelectedTransactionForRefund(txn as never);
  st.openModal('refund');
};
W.__harnessProcessRefund = async (payload: Record<string, unknown>) => {
  const st = usePosStore.getState();
  const res = (await st.processRefund(payload as never)) as unknown as Record<string, unknown>;
  return res;
};
W.__harnessOpenMatrix = () => {
  usePosStore.getState().openModal('product_matrix');
};
type W2 = Window & {
  __harnessAddProductToCart: (productId: string, imei?: string) => boolean;
  __harnessApplyCartDiscount: (pct: number) => void;
};
const W2 = window as unknown as W2;
W2.__harnessAddProductToCart = (productId: string, imei?: string) => {
  const st = usePosStore.getState();
  const product = (st.products || []).find((p) => p.id === productId);
  if (!product) return false;
  st.addToCart(product, false, 1);
  if (imei) st.setCartItemIMEI(productId, imei);
  return true;
};
W2.__harnessApplyCartDiscount = (pct: number) => {
  (usePosStore.getState().applyCartDiscountPercent as (p: number) => void)(pct);
};
type W4 = Window & {
  __harnessHoldFlight: () => Promise<boolean>;
  __harnessReleaseFlight: () => Promise<void>;
};
const W4 = window as unknown as W4;
// Deterministic contention: hold the checkout mutex externally so the blast
// below is guaranteed to collide (UI double-taps interleave nondeterministically).
W4.__harnessHoldFlight = async () => {
  const { tryAcquireCheckoutFlight } = await import('../../src/db/checkoutFlight');
  return tryAcquireCheckoutFlight('chaos-harness');
};
W4.__harnessReleaseFlight = async () => {
  const { releaseCheckoutFlight } = await import('../../src/db/checkoutFlight');
  releaseCheckoutFlight('chaos-harness');
};
type W3 = Window & { __harnessSeedCustomer: (storeCredit: number) => void };
const W3 = window as unknown as W3;
W3.__harnessSeedCustomer = (storeCredit: number) => {
  const cust = {
    id: 'cust-harness',
    name: 'Client Harness',
    phone: '0550000000',
    storeCredit,
    loyaltyPoints: 0,
    totalSpent: 0,
    currentDebt: 0,
  };
  usePosStore.setState({ customers: [cust], currentCustomer: cust } as unknown as never);
};
window.__harnessSnapshot = () => {
  const s = usePosStore.getState();
  return { tradeIns: (s.tradeIns || []).length, products: (s.products || []).length, staged: s.stagedTradeIn };
};
window.__harnessSeedCart = (unitPrice: number) => {
  const product = SEED_PRODUCT(unitPrice);
  const line: CartItem = {
    product,
    quantity: 1,
    appliedPrice: unitPrice,
  } as unknown as CartItem;
  usePosStore.setState({ cart: [line] });
};
(window as unknown as { __harnessSeedSerializedCart: (imei: string) => void }).__harnessSeedSerializedCart = (
  imei: string
) => {
  const product = { ...SEED_PRODUCT(80000), isSerialized: true };
  const line = { product, quantity: 1, appliedPrice: 80000, imeiNumber: imei } as unknown as CartItem;
  usePosStore.setState({ cart: [line] });
};
window.__harnessOpenPayment = () => {
  usePosStore.getState().openModal('payment');
};
window.__harnessStageTradeIn = (buybackValue: number) => {
  usePosStore.getState().setStagedTradeIn({
    stagedId: 'harness-staged-1',
    customerName: 'Karim Hadj',
    deviceModel: 'iPhone 13 Pro',
    imei: '490154203237518',
    brand: 'Apple',
    conditionGrade: 'Grade B (Bon État)',
    buybackValue,
    resaleMarginPercent: 30,
    creditToWallet: false,
  });
};

async function whenStoreHydrated(): Promise<void> {
  const p = (
    usePosStore as unknown as {
      persist?: { hasHydrated?: () => boolean; onFinishHydration?: (fn: () => void) => void };
    }
  ).persist;
  if (!p?.hasHydrated || !p.onFinishHydration) return;
  if (p.hasHydrated()) return;
  await new Promise<void>((resolve) => p.onFinishHydration!(() => resolve()));
}

function Harness() {
  useEffect(() => {
    void (async () => {
      try {
        await whenStoreHydrated();
        window.__harnessOpenTradeIn();
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        window.__harnessReady = true;
      } catch (e) {
        window.__harnessError = String((e as Error)?.message ?? e);
        window.__harnessReady = true;
      }
    })();
  }, []);

  return (
    <ToastProvider>
      {/* CartPanel always renders (cart-gated sections inside); the modals
          self-gate on activeModal. */}
      <div style={{ display: 'flex', height: '100vh' }}>
        <CartPanel />
      </div>
      <TradeInBuybackModal />
      <PaymentModal />
      <RefundModal />
      <ProductMatrixModal />
    </ToastProvider>
  );
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    window.__harnessError = String(error?.message ?? error);
  }
  render() {
    if (this.state.error) {
      return <pre data-harness-error="true">{this.state.error.message}</pre>;
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('harness-root')!).render(
  <StrictMode>
    <Boundary>
      <Harness />
    </Boundary>
  </StrictMode>
);

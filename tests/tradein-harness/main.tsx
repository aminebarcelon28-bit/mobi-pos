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

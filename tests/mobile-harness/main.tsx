/**
 * ISOLATED MOBILE VISUAL HARNESS — Phase P3/P5 (UI/UX Strike Team)
 *
 * Mounts mobile screens and modals directly at `/tests/mobile-harness/index.html`
 * with deterministic Algerian phone-shop fixture data, theme, platform, and locale
 * controls. Bypasses full App boot / license gate / PIN gate (except when
 * `?screen=lock-screen` is explicitly requested).
 *
 * Query params (and runtime `window.__setHarnessConfig(cfg)`):
 *   ?screen=activity|checkout|catalog|kredy|management|diagnostics|pairing|printer|scanner|cart-protection|lock-screen
 *   ?state=populated|empty|loading|error|offline|sync-pending|degraded-tamper|degraded-unauthenticated|degraded-clock
 *   ?theme=light|dark
 *   ?platform=android|ios
 *   ?lang=fr|ar
 *
 * Signals readiness via `window.__harnessReady = true` after store seeding,
 * tab selection, lazy-chunk resolution, and 2 animation frames. Any uncaught
 * error is written to `window.__harnessError` so Playwright fails fast.
 */

import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../../src/index.css';
import { usePosStore } from '../../src/store/usePosStore';
import { db as dexieDb } from '../../src/db/database';
import { setLocale } from '../../src/i18n';
import { ToastProvider } from '../../src/components/ui/Toast';
import { CompanionShell } from '../../src/components/mobile/CompanionShell';
import { MobilePairingWizard } from '../../src/components/mobile/MobilePairingWizard';
import { MobilePrinterModal } from '../../src/components/mobile/MobilePrinterModal';
import { MobileCameraScanner } from '../../src/components/mobile/MobileCameraScanner';
import { M3CartProtectionModal } from '../../src/components/mobile/M3CartProtectionModal';
import { LockScreenOverlay } from '../../src/components/LockScreenOverlay';
// Preload lazy-loaded tab modules so CompanionShell Suspense boundaries resolve deterministically
import '../../src/components/mobile/tabs/CatalogSearchTab';
import '../../src/components/mobile/tabs/MobileCheckoutTab';
import '../../src/components/mobile/tabs/KredyTab';
import '../../src/components/mobile/tabs/ManagementTab';
import '../../src/components/mobile/tabs/SyncDiagnosticsTab';
import type {
  CartItem,
  Customer,
  CustomerDebtEntry,
  Product,
  SaleTransaction,
} from '../../src/types/pos';

export type HarnessScreen =
  | 'activity'
  | 'checkout'
  | 'catalog'
  | 'kredy'
  | 'management'
  | 'diagnostics'
  | 'pairing'
  | 'printer'
  | 'scanner'
  | 'cart-protection'
  | 'lock-screen';

export type HarnessState =
  | 'populated'
  | 'empty'
  | 'loading'
  | 'error'
  | 'offline'
  | 'sync-pending'
  | 'degraded-tamper'
  | 'degraded-unauthenticated'
  | 'degraded-clock';

export interface HarnessConfig {
  screen: HarnessScreen;
  state: HarnessState;
  theme: 'light' | 'dark';
  platform: 'android' | 'ios';
  lang: 'fr' | 'ar';
}

declare global {
  interface Window {
    __harnessReady?: boolean;
    __harnessError?: string | null;
    __setHarnessConfig?: (cfg: Partial<HarnessConfig>) => Promise<void>;
  }
}

window.__harnessReady = false;
window.__harnessError = null;

window.addEventListener('error', (e) => {
  window.__harnessError = e.error ? `${e.error.name}: ${e.error.message}` : e.message;
});
window.addEventListener('unhandledrejection', (e) => {
  window.__harnessError = String(e.reason);
});

function readConfigFromUrl(): HarnessConfig {
  const params = new URLSearchParams(window.location.search);
  return {
    screen: (params.get('screen') ?? 'activity') as HarnessScreen,
    state: (params.get('state') ?? 'populated') as HarnessState,
    theme: (params.get('theme') ?? 'dark') as 'light' | 'dark',
    platform: (params.get('platform') ?? 'android') as 'android' | 'ios',
    lang: (params.get('lang') ?? 'fr') as 'fr' | 'ar',
  };
}

function applyRootAndStorageConfig(cfg: HarnessConfig): void {
  const rootEl = document.documentElement;
  if (cfg.theme === 'light') {
    rootEl.classList.add('light');
    rootEl.classList.remove('dark');
  } else {
    rootEl.classList.add('dark');
    rootEl.classList.remove('light');
  }
  rootEl.dataset.platform = cfg.platform;
  rootEl.dataset.harnessScreen = cfg.screen;
  rootEl.dataset.harnessState = cfg.state;

  try {
    localStorage.setItem('mobi_pos_device_mode_override', 'companion_mobile');
    localStorage.setItem('mobi_pos_platform', cfg.platform);
    localStorage.setItem('mobi_pos_locale', cfg.lang);
    localStorage.setItem('mobi_locale', cfg.lang);
    if (cfg.screen === 'lock-screen') {
      localStorage.removeItem('mobi_pos_companion_trusted');
    } else {
      localStorage.setItem('mobi_pos_companion_trusted', '1');
    }
    if (cfg.state === 'empty' && cfg.screen === 'pairing') {
      localStorage.removeItem('mobi_pos_web_turso_creds');
    } else {
      localStorage.setItem(
        'mobi_pos_web_turso_creds',
        JSON.stringify({
          url: 'libsql://mobi-demo-alger.turso.io',
          token: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.demo-token',
        }),
      );
    }
  } catch {
    // Ignore storage restrictions in headless contexts
  }

  setLocale(cfg.lang);
}

// ── Deterministic Algerian Phone-Shop Fixtures ───────────────────────────
const NOW_ISO = new Date().toISOString();
const ONE_HOUR_AGO_ISO = new Date(Date.now() - 3600_000).toISOString();
const TWO_HOURS_AGO_ISO = new Date(Date.now() - 7200_000).toISOString();
const FIVE_DAYS_AGO_ISO = new Date(Date.now() - 5 * 86400_000).toISOString();

const FIXTURE_PRODUCTS: Product[] = [
  {
    id: 'prod-a55-256',
    sku: 'SAM-A55-256-BLK',
    barcode: '6291108710012',
    title: 'Samsung Galaxy A55 5G 256GB Awesome Navy',
    brand: 'Samsung',
    compatibleModel: 'Galaxy A55 5G',
    category: 'Tous les produits',
    price: 68500,
    wholesalePrice: 64000,
    costPrice: 59000,
    stock: 4,
    vendorName: 'Alger Mobile Distribution',
    leadTimeDays: 2,
    dailySalesVelocity: 1.2,
    reorderPoint: 2,
    warrantyMonths: 12,
    isSerialized: true,
    imeiNumber: '358291104820194',
    isActive: true,
  },
  {
    id: 'prod-ip15pm-256',
    sku: 'APL-15PM-256-NAT',
    barcode: '0195949048012',
    title: 'iPhone 15 Pro Max 256GB Natural Titanium',
    brand: 'Apple',
    compatibleModel: 'iPhone 15 Pro Max',
    category: 'Tous les produits',
    price: 245000,
    wholesalePrice: 236000,
    costPrice: 222000,
    stock: 2,
    vendorName: 'El Djazair Telecom Import',
    leadTimeDays: 3,
    dailySalesVelocity: 0.5,
    reorderPoint: 1,
    warrantyMonths: 12,
    isSerialized: true,
    isActive: true,
  },
  {
    id: 'prod-anker-20w',
    sku: 'ANK-20W-USBC',
    barcode: '0848061059120',
    title: 'Chargeur Rapide Anker PowerPort III 20W USB-C',
    brand: 'Anker',
    compatibleModel: 'Universel USB-C',
    category: 'Chargeurs',
    price: 2800,
    wholesalePrice: 2200,
    costPrice: 1750,
    stock: 15,
    vendorName: 'Accessoires Bab Ezzouar',
    leadTimeDays: 1,
    dailySalesVelocity: 3.5,
    reorderPoint: 5,
    warrantyMonths: 6,
    isActive: true,
  },
  {
    id: 'prod-coque-magsafe-15',
    sku: 'COQ-IP15-MAG',
    barcode: '6291108790051',
    title: 'Coque Silicone MagSafe iPhone 15 Pro',
    brand: 'Apple',
    compatibleModel: 'iPhone 15 Pro',
    category: 'Coques iPhone',
    price: 1800,
    wholesalePrice: 1300,
    costPrice: 900,
    stock: 9,
    vendorName: 'Accessoires Bab Ezzouar',
    leadTimeDays: 1,
    dailySalesVelocity: 2.0,
    reorderPoint: 4,
    isMagSafe: true,
    isActive: true,
  },
  {
    id: 'prod-verre-9h',
    sku: 'ZAG-9H-IP15',
    barcode: '0840056180215',
    title: 'Protège-Écran Verre Trempé 9H Anti-Espion',
    brand: 'ZAGG',
    compatibleModel: 'iPhone 15 / 15 Pro',
    category: 'Protège-Écran',
    price: 900,
    wholesalePrice: 600,
    costPrice: 300,
    stock: 1,
    vendorName: 'Accessoires Bab Ezzouar',
    leadTimeDays: 1,
    dailySalesVelocity: 4.0,
    reorderPoint: 10,
    isActive: true,
  },
];

const FIXTURE_CUSTOMERS: Customer[] = [
  {
    id: 'cust-karim-benali',
    name: 'Salma Benali',
    phone: '0550 00 22 22',
    email: 'karim.benali@example.dz',
    registeredDevice: 'Samsung Galaxy A55 5G',
    loyaltyPoints: 340,
    storeCredit: 0,
    pricingTier: 'Retail',
    loyaltyTier: 'Silver',
    totalSpent: 94000,
    currentDebt: 24500,
    debtLimit: 50000,
  },
  {
    id: 'cust-amira-bouzid',
    name: 'Leila Bouzid',
    phone: '0661 98 76 54',
    email: 'amira.bouzid@example.dz',
    registeredDevice: 'iPhone 15 Pro Max',
    loyaltyPoints: 1200,
    storeCredit: 1500,
    pricingTier: 'VIP',
    loyaltyTier: 'Gold',
    totalSpent: 310000,
    currentDebt: 38000,
    debtLimit: 30000,
  },
  {
    id: 'cust-yasmine-mansouri',
    name: 'Yasmine Mansouri',
    phone: '0770 45 67 89',
    email: 'yasmine.m@example.dz',
    registeredDevice: 'iPhone 14',
    loyaltyPoints: 80,
    storeCredit: 0,
    pricingTier: 'Retail',
    loyaltyTier: 'Bronze',
    totalSpent: 18500,
    currentDebt: 0,
    debtLimit: 40000,
  },
];

const FIXTURE_DEBTS: CustomerDebtEntry[] = [
  {
    id: 'debt-entry-001',
    customerId: 'cust-karim-benali',
    customerName: 'Salma Benali',
    type: 'DEBT_ACQUIRED',
    amount: 24500,
    balanceAfter: 24500,
    receiptNumber: 'REC-2026-0102',
    paymentMethod: 'Crédit Client',
    notes: 'Reste sur Samsung Galaxy A55 5G',
    createdAt: ONE_HOUR_AGO_ISO,
    recordedBy: 'Farida (Gérant)',
  },
  {
    id: 'debt-entry-002',
    customerId: 'cust-amira-bouzid',
    customerName: 'Leila Bouzid',
    type: 'DEBT_ACQUIRED',
    amount: 38000,
    balanceAfter: 38000,
    receiptNumber: 'REC-2026-0088',
    paymentMethod: 'Crédit Client',
    notes: 'Échéance fin de mois',
    createdAt: FIVE_DAYS_AGO_ISO,
    recordedBy: 'Farida (Gérant)',
  },
];

const FIXTURE_CART: CartItem[] = [
  {
    product: FIXTURE_PRODUCTS[0],
    quantity: 1,
    discount: 0,
    appliedPrice: 68500,
    unitCostPrice: 59000,
    unitCostAtSale: 59000,
    warrantyMonthsAtSale: 12,
    imeiNumber: '358291104820194',
  },
  {
    product: FIXTURE_PRODUCTS[2],
    quantity: 1,
    discount: 0,
    appliedPrice: 2800,
    unitCostPrice: 1750,
    unitCostAtSale: 1750,
    warrantyMonthsAtSale: 6,
  },
];

const FIXTURE_TRANSACTIONS: SaleTransaction[] = [
  {
    id: 'tx-2026-0101',
    receiptNumber: 'REC-2026-0101',
    status: 'COMPLETED',
    customer: FIXTURE_CUSTOMERS[2],
    items: [
      {
        product: FIXTURE_PRODUCTS[2],
        quantity: 1,
        discount: 0,
        appliedPrice: 2800,
        unitCostPrice: 1750,
        unitCostAtSale: 1750,
      },
      {
        product: FIXTURE_PRODUCTS[3],
        quantity: 1,
        discount: 0,
        appliedPrice: 1800,
        unitCostPrice: 900,
        unitCostAtSale: 900,
      },
    ],
    subtotal: 4600,
    discountTotal: 0,
    total: 4600,
    costTotal: 2650,
    ledgerCogsTotal: 2650,
    profit: 1950,
    profitMargin: 42.39,
    pricingTier: 'Retail',
    paymentMethod: 'Espèces',
    cashTendered: 5000,
    changeDue: 400,
    createdAt: TWO_HOURS_AGO_ISO,
    cashierName: 'Farida (Gérant)',
  },
  {
    id: 'tx-2026-0102',
    receiptNumber: 'REC-2026-0102',
    status: 'COMPLETED',
    customer: FIXTURE_CUSTOMERS[0],
    items: [
      {
        product: FIXTURE_PRODUCTS[0],
        quantity: 1,
        discount: 0,
        appliedPrice: 68500,
        unitCostPrice: 59000,
        unitCostAtSale: 59000,
        imeiNumber: '354891092837465',
      },
    ],
    subtotal: 68500,
    discountTotal: 0,
    total: 68500,
    costTotal: 59000,
    ledgerCogsTotal: 59000,
    profit: 9500,
    profitMargin: 13.87,
    pricingTier: 'Retail',
    paymentMethod: 'Crédit Client',
    tenders: [
      { method: 'Espèces', amount: 44000 },
      { method: 'Crédit Client', amount: 24500 },
    ],
    cashTendered: 44000,
    changeDue: 0,
    debtAdded: 24500,
    debtRemainingTotal: 24500,
    createdAt: ONE_HOUR_AGO_ISO,
    cashierName: 'Farida (Gérant)',
  },
];

async function seedHarnessState(cfg: HarnessConfig): Promise<void> {
  applyRootAndStorageConfig(cfg);

  const isEmpty = cfg.state === 'empty' || cfg.state === 'loading';
  const shouldPopulateCart =
    !isEmpty && (cfg.screen === 'checkout' || cfg.screen === 'cart-protection');

  try {
    await dexieDb.open();
    if (cfg.state === 'sync-pending') {
      await dexieDb.syncOutbox.clear();
      await dexieDb.syncOutbox.bulkPut([
        {
          id: 1,
          entity_type: 'sales',
          entity_id: 'tx-2026-0101',
          operation: 'UPSERT',
          payload: JSON.stringify({ id: 'tx-2026-0101', total: 4600 }),
          created_at: TWO_HOURS_AGO_ISO,
          attempts: 0,
        },
        {
          id: 2,
          entity_type: 'sales',
          entity_id: 'tx-2026-0102',
          operation: 'UPSERT',
          payload: JSON.stringify({ id: 'tx-2026-0102', total: 68500 }),
          created_at: ONE_HOUR_AGO_ISO,
          attempts: 1,
        },
        {
          id: 3,
          entity_type: 'customer_debts',
          entity_id: 'debt-entry-001',
          operation: 'UPSERT',
          payload: JSON.stringify({ id: 'debt-entry-001', amount: 24500 }),
          created_at: NOW_ISO,
          attempts: 0,
        },
      ]);
    } else {
      await dexieDb.syncOutbox.clear();
    }
  } catch {
    // Ignore Dexie indexing errors in non-IDB environments
  }

  usePosStore.setState({
    isDbInitialized: cfg.state !== 'loading',
    themeMode: cfg.theme,
    activeModal: null,
    products: isEmpty ? [] : FIXTURE_PRODUCTS,
    customers: isEmpty ? [] : FIXTURE_CUSTOMERS,
    customerDebts: isEmpty ? [] : FIXTURE_DEBTS,
    transactions: isEmpty ? [] : FIXTURE_TRANSACTIONS,
    cart: shouldPopulateCart ? FIXTURE_CART : [],
    currentCustomer: shouldPopulateCart ? FIXTURE_CUSTOMERS[0] : null,
    isScreenLocked: cfg.screen === 'lock-screen',
    sessionLockRequested: cfg.screen === 'lock-screen',
    outboxPendingCount: cfg.state === 'sync-pending' ? 3 : 0,
    outboxInFlightCount: cfg.state === 'sync-pending' ? 1 : 0,
    isSyncing: cfg.state === 'loading',
    drainArmed: cfg.state !== 'offline' && cfg.state !== 'empty',
    lastDrainAt: cfg.state === 'populated' ? ONE_HOUR_AGO_ISO : null,
    lastDrainError:
      cfg.state === 'error'
        ? 'Hrana WebSocket timeout (504 Gateway)'
        : cfg.state === 'degraded-tamper'
          ? 'INTEGRITY_TAMPER_SUSPECTED: MAC mismatch on audit_log seq #412'
          : cfg.state === 'degraded-unauthenticated'
            ? 'MANIFEST_UNAUTHENTICATED: export recovery mode only'
            : cfg.state === 'degraded-clock'
              ? 'SYSTEM_CLOCK_REGRESSION: wall clock behind monotonic anchor (+412s)'
              : null,
  });
}

const STATE_BANNER_CONFIG: Partial<
  Record<
    HarnessState,
    { toneClass: string; titleFr: string; titleAr: string; detail: string }
  >
> = {
  loading: {
    toneClass: 'bg-sky-500/15 border-sky-500/40 text-sky-300',
    titleFr: 'Synchronisation et hydratation en cours…',
    titleAr: 'جاري المزامنة وتحميل البيانات…',
    detail: 'SYNC_HYDRATING',
  },
  error: {
    toneClass: 'bg-rose-500/15 border-rose-500/40 text-rose-300',
    titleFr: 'Erreur réseau passerelle Turso — Nouvelle tentative auto',
    titleAr: 'خطأ في الاتصال بالسحابة — إعادة المحاولة تلقائياً',
    detail: 'GATEWAY_TIMEOUT_504',
  },
  offline: {
    toneClass: 'bg-amber-500/15 border-amber-500/40 text-amber-300',
    titleFr: 'Mode Hors-Ligne actif — File locale sécurisée (SQLite/Dexie)',
    titleAr: 'وضع عدم الاتصال نشط — الحفظ المحلي مؤمن',
    detail: 'OFFLINE_QUEUE_ACTIVE',
  },
  'sync-pending': {
    toneClass: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
    titleFr: '3 opérations en attente d’envoi vers la passerelle',
    titleAr: '3 عمليات بانتظار الإرسال إلى الخادم',
    detail: 'OUTBOX_PENDING_3',
  },
  'degraded-tamper': {
    toneClass: 'bg-rose-600/20 border-rose-500/60 text-rose-200',
    titleFr: 'Intégrité compromise (TAMPER_SUSPECTED) — Export d’urgence uniquement',
    titleAr: 'اشتباه تلاعب في السجل — التصدير الطارئ فقط متاح',
    detail: 'TAMPER_SUSPECTED',
  },
  'degraded-unauthenticated': {
    toneClass: 'bg-amber-600/20 border-amber-500/60 text-amber-200',
    titleFr: 'Manifeste non authentifié (UNAUTHENTICATED) — Récupération seule',
    titleAr: 'بيان غير موثق — وضع الاسترداد فقط',
    detail: 'UNAUTHENTICATED',
  },
  'degraded-clock': {
    toneClass: 'bg-orange-600/20 border-orange-500/60 text-orange-200',
    titleFr: 'Horloge système incohérente (CLOCK_RESET_REQUIRED) — Ventes bloquées',
    titleAr: 'تراجع ساعة النظام — يلزم إعادة ضبط الوقت',
    detail: 'CLOCK_RESET_REQUIRED',
  },
};

const SHELL_TAB_SCREENS = new Set<HarnessScreen>([
  'activity',
  'checkout',
  'catalog',
  'kredy',
  'management',
  'diagnostics',
]);

const HarnessApp: React.FC<{ initialConfig: HarnessConfig }> = ({ initialConfig }) => {
  const [cfg, setCfg] = useState<HarnessConfig>(initialConfig);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    window.__setHarnessConfig = async (nextPartial: Partial<HarnessConfig>) => {
      window.__harnessReady = false;
      window.__harnessError = null;
      const merged: HarnessConfig = {
        ...cfg,
        ...nextPartial,
      };
      const search = new URLSearchParams({
        screen: merged.screen,
        state: merged.state,
        theme: merged.theme,
        platform: merged.platform,
        lang: merged.lang,
      });
      window.history.replaceState({ mobiRoot: true }, '', `?${search.toString()}`);
      await seedHarnessState(merged);
      setCfg(merged);
      setNonce((n) => n + 1);
    };
  }, [cfg]);

  useEffect(() => {
    let cancelled = false;

    const finalizeReady = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!cancelled) {
            window.__harnessReady = true;
          }
        });
      });
    };

    if (SHELL_TAB_SCREENS.has(cfg.screen)) {
      const timer = window.setTimeout(() => {
        if (cancelled) return;
        window.dispatchEvent(
          new CustomEvent('mobi:navigate-tab', { detail: cfg.screen }),
        );
        window.setTimeout(finalizeReady, 70);
      }, 25);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }

    finalizeReady();
    return () => {
      cancelled = true;
    };
  }, [cfg, nonce]);

  const banner = STATE_BANNER_CONFIG[cfg.state];

  const renderScreenContent = () => {
    if (cfg.screen === 'pairing') {
      return (
        <div className="min-h-[100dvh] w-full bg-pos-bg flex flex-col justify-center">
          <MobilePairingWizard
            onPaired={() => {}}
            onSkipDemo={() => {}}
            onClose={() => {}}
          />
        </div>
      );
    }

    if (cfg.screen === 'printer') {
      return (
        <div className="min-h-[100dvh] w-full bg-pos-bg">
          <CompanionShell onOpenPairingWizard={() => {}} fill="viewport" />
          <MobilePrinterModal isOpen={true} onClose={() => {}} />
        </div>
      );
    }

    if (cfg.screen === 'scanner') {
      return (
        <div className="min-h-[100dvh] w-full bg-pos-bg p-3 flex flex-col justify-center">
          <MobileCameraScanner onScan={() => {}} isActive={true} mode="barcode" />
        </div>
      );
    }

    if (cfg.screen === 'cart-protection') {
      return (
        <div className="min-h-[100dvh] w-full bg-pos-bg">
          <CompanionShell onOpenPairingWizard={() => {}} fill="viewport" />
          <M3CartProtectionModal
            isOpen={true}
            onContinueSale={() => {}}
            onHoldAndExit={() => {}}
            onDiscardAndExit={() => {}}
          />
        </div>
      );
    }

    if (cfg.screen === 'lock-screen') {
      return (
        <div className="min-h-[100dvh] w-full bg-pos-bg">
          <LockScreenOverlay />
        </div>
      );
    }

    return (
      <CompanionShell
        onOpenPairingWizard={() => {}}
        fill="viewport"
        initialTab={SHELL_TAB_SCREENS.has(cfg.screen) ? (cfg.screen as any) : undefined}
      />
    );
  };

  return (
    <ToastProvider>
      <div
        key={nonce}
        data-testid="mobile-harness-shell"
        data-screen={cfg.screen}
        data-state={cfg.state}
        data-platform={cfg.platform}
        data-lang={cfg.lang}
        className="relative w-full max-w-full overflow-x-hidden"
      >
        {banner && (
          <div
            role="status"
            data-testid="harness-state-banner"
            className={`w-full border-b px-3 py-1.5 text-xs font-semibold flex items-center justify-between gap-2 ${banner.toneClass}`}
          >
            <span className="truncate">
              {cfg.lang === 'ar' ? banner.titleAr : banner.titleFr}
            </span>
            <span className="font-mono text-[10px] opacity-80 shrink-0">
              {banner.detail}
            </span>
          </div>
        )}
        {renderScreenContent()}
      </div>
    </ToastProvider>
  );
};

async function mount() {
  try {
    const initialConfig = readConfigFromUrl();
    await seedHarnessState(initialConfig);
    const container = document.getElementById('harness-root');
    if (!container) {
      throw new Error('#harness-root element missing in index.html');
    }
    ReactDOM.createRoot(container).render(<HarnessApp initialConfig={initialConfig} />);
  } catch (err) {
    window.__harnessError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
}

void mount();

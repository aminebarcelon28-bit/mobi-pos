import type { StateCreator } from 'zustand';
import type { PosState, UISlice } from '../types';
import type {
  Product,
  ProductBundle,
  TradeInItem,
  StoreExpense,
  ReceiptSettings,
  LicenseDetails,
  HardwareStatus,
  SecurityAuditLogEntry,
  CashierUser,
  HeldSale,
  IMEIRecord,
} from '../../types/pos';
import { INITIAL_PRODUCTS, INITIAL_CUSTOMERS } from '../../data/mockData';
import { newId } from '../../utils/ids';
import { markBoot, printBootSummary } from '../../utils/bootTimings';
import { checkPinLockout, recordPinFailure, resetPinLockout } from '../../utils/security';
import { computeEffectiveUnitPrice } from '../../utils/pricingEngine';
import { generateUniqueEan13Barcode } from '../../utils/barcodeGenerator';
// P11.3: sqliteAdapter -> adapters -> dexie + libsql is the heaviest static chain
// left in the entry. initDatabase() runs from a useEffect, so load it on demand.
// P11.3: repositories each pull sqliteAdapter -> dexie + libsql; all four are only
// reached from async user/init actions, never during cold start.
async function getProductRepo() {
  const { productRepository } = await import('../../db/repositories/productRepository');
  return productRepository;
}
async function getCustomerRepo() {
  const { customerRepository } = await import('../../db/repositories/customerRepository');
  return customerRepository;
}
async function getSettingsRepo() {
  const { settingsRepository } = await import('../../db/repositories/settingsRepository');
  return settingsRepository;
}
async function getBackupRepo() {
  const { backupRepository } = await import('../../db/repositories/backupRepository');
  return backupRepository;
}
import { hashPin, verifyPin } from '../../utils/security';
import { STORAGE_KEYS } from '../../constants';
import { usePosStore } from '../usePosStore';

// P11.3: memo for the in-flight initDatabase promise (see initDatabase below).
let initDatabaseInFlight: Promise<void> | null = null;

const HELD_SALES_STORAGE_KEY = 'mobi_held_sales_v1';

/** Read Wave-B persisted holds; validate array shape, fail silent to []. */
function loadHeldSalesFromStorage(): HeldSale[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(HELD_SALES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = (parsed as unknown[]).filter(
      (h): h is HeldSale =>
        typeof h === 'object' &&
        h !== null &&
        typeof (h as { id?: unknown }).id === 'string' &&
        Array.isArray((h as { items?: unknown }).items),
    );
    // If the stored shape is entirely invalid, fail silent to [].
    if (valid.length === 0 && parsed.length > 0) return [];
    return valid;
  } catch {
    return [];
  }
}

const initialTheme =
  typeof localStorage !== 'undefined'
    ? ((localStorage.getItem('mobi_pos_theme') as 'dark' | 'light') || 'dark')
    : 'dark';

if (typeof document !== 'undefined') {
  if (initialTheme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

const DEFAULT_RECEIPT_SETTINGS: ReceiptSettings = {
  storeName: 'ACCESSOIRES MOBI',
  storeSubheader: 'Vente Accessoires & Téléphonie',
  logoUrl: '',
  address: 'Boulevard Mohamed V, Alger Centre',
  phone: '021 65 43 21 / 0550 00 11 22',
  email: 'contact@mobi-accessories.dz',
  customHeaderMsg: 'Bienvenue chez MOBI ACCESSORIES',
  customFooterMsg:
    'Paiement comptant en espèces uniquement. Les articles ne sont ni repris ni échangés sans ticket de caisse. Garantie 12 mois SAV.',
  showBarcode: true,
  autoPrintEnabled: true,
  printerRouting: {
    receiptPrinterId: 'rp-1',
    receiptPrinterName: 'Imprimante Thermique Tickets (Epson TM-T88VI)',
    labelPrinterId: 'lp-1',
    labelPrinterName: 'Imprimante Étiquettes Code-Barres (Zebra ZD421)',
    reportPrinterId: 'sys-1',
    reportPrinterName: 'Imprimante Système Windows / PDF A4',
    autoRoutingEnabled: true,
  },
};

// Hydrate receipt settings from the synced app_settings lane. Stored rows may
// be partial (older schema) or absent (fresh install), so defaults always
// provide the base and stored values override field-by-field.
async function loadReceiptSettings(): Promise<ReceiptSettings> {
  const stored = await (await getSettingsRepo()).get<Partial<ReceiptSettings> | null>(
    STORAGE_KEYS.RECEIPT_SETTINGS,
    null,
  );
  return { ...DEFAULT_RECEIPT_SETTINGS, ...(stored ?? {}) };
}

// SECURITY: placeholder license values must never present as a valid enterprise
// license. Status stays 'Unlicensed' until a real activation flow lands.
const DEFAULT_LICENSE_DETAILS: LicenseDetails = {
  machineFingerprint: 'DEMO-UNLICENSED-PLACEHOLDER',
  status: 'Unlicensed',
  licenseKey: 'DEMO-UNLICENSED-PLACEHOLDER',
  maxTerminals: 5,
  activatedAt: '—',
};

const DEFAULT_HARDWARE_STATUS: HardwareStatus = {
  printerConnected: true,
  scannerConnected: true,
  cashDrawerOpen: false,
  customerDisplayConnected: true,
};

// P11.3: resolves the SQLite adapter on first use; keeps the dexie/libsql graph
// out of the entry chunk (cold start) without changing call-site semantics.
// Type alias so `typeof sqliteAdapter.X` refs keep working without a static import.
import type { sqliteAdapter as SqliteAdapterInstance } from '../../db/sqliteAdapter';
type SqliteAdapter = typeof SqliteAdapterInstance;

async function getSqlite() {
  const { sqliteAdapter } = await import('../../db/sqliteAdapter');
  return sqliteAdapter;
}

// SECURITY: demo cashier PINs are UNSET. First boot forces PIN creation via the
// blocking setup step in App.tsx. An empty PIN can never authenticate:
// verifyPin('' stored) fails closed and the lock screen rejects empty input.
export const DEFAULT_CASHIERS: CashierUser[] = [
  { id: 'usr-admin', name: 'Yacine (Gérant)', pin: '', role: 'admin', avatarColor: '#3b82f6' },
  { id: 'usr-amine', name: 'Amine', pin: '', role: 'cashier', avatarColor: '#10b981' },
  { id: 'usr-karim', name: 'Karim', pin: '', role: 'cashier', avatarColor: '#f59e0b' },
];

export const createUISlice: StateCreator<PosState, [], [], UISlice> = (set, get) => ({
  isDbInitialized: false,
  themeMode: initialTheme,
  pricingTier: 'Retail',
  activeModal: null,
  pendingPinAction: null,
  hardwareStatus: DEFAULT_HARDWARE_STATUS,
  receiptSettings: DEFAULT_RECEIPT_SETTINGS,
  licenseDetails: DEFAULT_LICENSE_DETAILS,
  bundles: [],
  tradeIns: [],
  imeiRecords: [],
  activeImeiDossier: null,
  // SECURITY: unset until first-boot setup (App.tsx blocks the till until set).
  // Never restore a hardcoded default here.
  managerPin: '',
  securityAuditLog: [
    {
      id: 'log-1',
      timestamp: new Date().toISOString(),
      user: 'Yacine (Admin)',
      action: 'Initialisation Système POS',
      details: 'Moteur de base de données IndexedDB activé',
      requiresPin: false,
    },
  ],
  storeExpenses: [],
  activeCashier: DEFAULT_CASHIERS[0],
  cashierUsers: DEFAULT_CASHIERS,
  isScreenLocked: true,
  sessionLockRequested: false,
  creditVouchers: [],

  toggleTheme: () => {
    const nextTheme = get().themeMode === 'dark' ? 'light' : 'dark';
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('mobi_pos_theme', nextTheme);
    }
    if (typeof document !== 'undefined') {
      if (nextTheme === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    }
    set({ themeMode: nextTheme });
  },

  setPricingTier: (tier) => {
    const { cart } = get();
    const updatedCart = cart.map((item) => {
      // If the cashier manually overridden the item's price (custom discount/override), keep it
      const isManualPriceOverride =
        item.defaultPrice !== undefined &&
        item.appliedPrice !== item.defaultPrice &&
        !item.volumeTierApplied;

      if (isManualPriceOverride) {
        return item;
      }

      const effective = computeEffectiveUnitPrice(item.product, item.quantity, tier);
      return {
        ...item,
        appliedPrice: effective.basePrice,
        unitPriceCharged: effective.unitPrice,
        defaultPrice: effective.basePrice,
        discountAmount: effective.isVolumeDiscount ? effective.discountPerUnit : 0,
        discount: effective.isVolumeDiscount ? effective.discountPerUnit * item.quantity : 0,
        volumeTierApplied: effective.isVolumeDiscount,
      };
    });
    set({ pricingTier: tier, cart: updatedCart });
  },

  openModal: (modal) => {
    if (modal === 'payment' && get().cart.length === 0) {
      return;
    }
    set({ activeModal: modal });
  },

  closeModal: () =>
    set({
      activeModal: null,
      editingProduct: null,
      selectedTransactionForRefund: null,
      selectedRepairOrderForNotification: null,
      activeImeiDossier: null,
    }),

  setPendingPinAction: (action) => set({ pendingPinAction: action }),

  setActiveImeiDossier: (dossier) => set({ activeImeiDossier: dossier }),

  setReceiptSettings: async (settings) => {
    try {
      await (await getSettingsRepo()).set('mobi_pos_receipt_settings', settings);
      set({ receiptSettings: settings });
    } catch (error) {
      console.error('Failed to save receipt settings:', error);
    }
  },

  setManagerPin: async (newPin) => {
    if (!newPin || newPin.length < 4) return;
    try {
      const hashedPin = hashPin(newPin);
      await (await getSettingsRepo()).set('manager_pin', hashedPin);
      set({ managerPin: hashedPin });
      // Single-PIN contract: the primary admin (first role==='admin' in the
      // roster) IS the manager. Mirror the hash onto their user row so the
      // manager never ends up with two diverging PINs (master PIN vs
      // lock-screen PIN). setCashierUsers persists + refreshes activeCashier.
      const primary = (get().cashierUsers || []).find((u) => u.role === 'admin');
      if (primary && primary.pin !== hashedPin) {
        await get().setCashierUsers(
          get().cashierUsers.map((u) => (u.id === primary.id ? { ...u, pin: hashedPin } : u))
        );
      }
      await get().logSecurityAction(
        'Mise à Jour Code PIN Gérant',
        'Le code PIN administrateur a été chiffré et modifié avec succès (SHA-256/Salt)',
        'Manager',
        true
      );
    } catch (error) {
      // B-043: rethrow — App first-boot catch must report the failure, not
      // toast success after a silent settings-repo write error.
      console.error('Failed to update manager PIN:', error);
      throw error instanceof Error ? error : new Error('MANAGER_PIN_SAVE_FAILED');
    }
  },

  logSecurityAction: async (action, details, user = 'Yacine (Admin)', requiresPin = false) => {
    const { securityAuditLog } = get();
    // Enterprise audit telemetry: every entry carries an ISO-8601 creation
    // timestamp (sortable + range-filterable) plus the originating
    // Device/Terminal ID and IP address. The ISO format is load-bearing —
    // the legacy toLocaleTimeString dropped the calendar date and broke
    // chronological sorting, date-range queries and PDF/A-3 horodatage.
    let deviceId: string | undefined;
    let ipAddress: string | undefined;
    try {
      const { getDeviceId, getIpAddress } = await import('../../utils/deviceInfo');
      deviceId = getDeviceId();
      try {
        ipAddress = await getIpAddress();
      } catch {
        ipAddress = 'Non détectée (hors-ligne)';
      }
    } catch {
      // deviceInfo unavailable (tests/SSR) — persistence layer backfills.
    }
    const newEntry: SecurityAuditLogEntry = {
      id: newId('audit'),
      timestamp: new Date().toISOString(),
      user,
      action,
      details,
      requiresPin,
      ...(deviceId ? { deviceId } : {}),
      ...(ipAddress ? { ipAddress } : {}),
    };
    // P6/C6: persist BEFORE the in-memory append. saveAuditLog is an upsert,
    // so a same-ms duplicate id would silently overwrite the earlier audit
    // row and an accountability event would vanish without an error. The
    // collision-safe id (utils/ids) prevents that; persisting first keeps
    // state and DB consistent when the write fails.
    //
    // The failure is logged loudly, NOT re-thrown: audit logging is a
    // side-effect of the primary action, and ~30 call sites invoke it after a
    // sale/void/refund has already committed. Throwing here would make the UI
    // report a failed void that actually succeeded, and could break the
    // offline checkout contract (C2) over a bookkeeping side-effect. The
    // persist-first ordering is the real protection: on failure the UI never
    // shows an audit row the database rejected.
    try {
      await (await getSqlite()).saveAuditLog(newEntry);
    } catch (err) {
      console.error('[audit] Failed to persist security audit log:', err);
      return;
    }
    // Cap the in-memory ring at the last 200 entries; the DB remains the archive.
    set({ securityAuditLog: [newEntry, ...securityAuditLog].slice(0, 200) });
  },

  verifyManagerPin: (pin) => {
    // B-039: lockout before any verify — unlimited guessing is the bug.
    const lock = checkPinLockout();
    if (lock.isLocked) return false;
    const currentPin = get().managerPin;
    if (!currentPin) return false;
    if (verifyPin(pin, currentPin)) {
      resetPinLockout();
      return true;
    }
    recordPinFailure();
    return false;
  },

  lockScreen: () => {
    set({ isScreenLocked: true, sessionLockRequested: true });
  },

  unlockScreen: (enteredPin: string) => {
    const clean = enteredPin.trim();
    const { cashierUsers, managerPin } = get();

    const lock = checkPinLockout();
    if (lock.isLocked) {
      return { success: false, reason: `Trop de tentatives — réessayez dans ${lock.remainingSeconds}s` };
    }

    if (clean && verifyPin(clean, managerPin)) {
      resetPinLockout();
      const adminCashier = cashierUsers.find((u) => u.role === 'admin') || cashierUsers[0];
      set({ isScreenLocked: false, sessionLockRequested: false, activeCashier: adminCashier });
      void get().logSecurityAction(
        'Déverrouillage Écran',
        `Session déverrouillée via PIN Manager (${adminCashier.name})`,
        adminCashier.name,
        true
      );
      return { success: true, cashier: adminCashier };
    }

    const matched = cashierUsers.find((u) => verifyPin(clean, u.pin));
    if (matched) {
      resetPinLockout();
      set({ isScreenLocked: false, sessionLockRequested: false, activeCashier: matched });
      void get().logSecurityAction(
        'Déverrouillage Écran',
        `Session déverrouillée par ${matched.name} (${matched.role})`,
        matched.name,
        false
      );
      return { success: true, cashier: matched };
    }

    const after = recordPinFailure();
    return {
      success: false,
      reason: after.isLocked
        ? `Trop de tentatives — verrouillé ${after.remainingSeconds}s`
        : `Code PIN incorrect (${after.attemptsLeft} restantes)`,
    };
  },

  switchCashier: (cashierId: string, enteredPin: string) => {
    const { cashierUsers } = get();
    const target = cashierUsers.find((u) => u.id === cashierId);
    if (!target) return { success: false, reason: 'Caissier introuvable' };

    const lock = checkPinLockout();
    if (lock.isLocked) {
      return { success: false, reason: `Trop de tentatives — réessayez dans ${lock.remainingSeconds}s` };
    }

    const clean = enteredPin.trim();
    // Strict per-profile PIN: switching to a profile requires THAT profile's
    // PIN. No manager bypass (the manager switches by selecting their own
    // profile — single-PIN contract keeps admin.pin == managerPin).
    const isAuthorized = verifyPin(clean, target.pin);
    if (!isAuthorized) {
      const after = recordPinFailure();
      return {
        success: false,
        reason: after.isLocked
          ? `Trop de tentatives — verrouillé ${after.remainingSeconds}s`
          : `Code PIN incorrect (${after.attemptsLeft} restantes)`,
      };
    }
    resetPinLockout();

    set({ activeCashier: target, isScreenLocked: false, sessionLockRequested: false });
    // Drawer attribution follows the current user: re-point the OPEN shift's
    // currentCashier at the incoming cashier (fire-and-forget — rejects when
    // no shift is open, which is the normal no-drawer case, not an error).
    try {
      const setShiftCashier = (
        usePosStore.getState() as unknown as {
          setShiftCashier?: (name: string) => Promise<{ success: boolean; reason?: string }>;
        }
      ).setShiftCashier;
      if (typeof setShiftCashier === 'function') {
        void setShiftCashier(target.name).catch(() => undefined);
      }
    } catch {
      // Shift slice unavailable (e.g. partial store) — nothing to hand over.
    }
    void get().logSecurityAction(
      'Changement Caissier Actif',
      `Passation de caisse vers : ${target.name} (${target.role})`,
      target.name,
      false
    );
    return { success: true };
  },

  setCashierUsers: async (users: CashierUser[]) => {
    try {
      await (await getSettingsRepo()).set('cashier_users', users);
      const currentActive = get().activeCashier;
      const refreshedActive = users.find((u) => u.id === currentActive?.id) || users[0] || null;
      set({ cashierUsers: users, activeCashier: refreshedActive });
      await get().logSecurityAction(
        'Mise à Jour Équipe & Caissiers',
        `Liste de ${users.length} caissiers mise à jour`,
        get().activeCashier?.name || 'Manager',
        true
      );
    } catch (err) {
      // B-043: rethrow so first-boot / Settings callers surface the failure
      // instead of reporting a team save that never landed.
      console.error('Failed to save cashier users:', err);
      throw err instanceof Error ? err : new Error('CASHIER_USERS_SAVE_FAILED');
    }
  },

  createCreditVoucher: async (input) => {
    const voucher = await (await getSqlite()).createCreditVoucher(input);
    const { creditVouchers } = get();
    set({ creditVouchers: [voucher, ...creditVouchers] });
    await get().logSecurityAction(
      "Émission Bon d'Avoir",
      `Code: ${voucher.code} • Montant: ${voucher.initialAmount} DA • Client: ${voucher.customerName || 'Anonyme'}`,
      get().activeCashier?.name || 'Caisse',
      false
    );
    return voucher;
  },

  redeemCreditVoucher: async (code: string, amount: number) => {
    const res = await (await getSqlite()).redeemCreditVoucher(code, amount);
    if (res.success && res.voucher) {
      const { creditVouchers } = get();
      set({
        creditVouchers: creditVouchers.map((v) => (v.id === res.voucher?.id ? res.voucher! : v)),
      });
      await get().logSecurityAction(
        "Utilisation Bon d'Avoir",
        `Code: ${code} • Déduit: ${res.deducted} DA • Solde restant: ${res.remaining} DA`,
        get().activeCashier?.name || 'Caisse',
        false
      );
    }
    return res;
  },

  fetchCreditVouchers: async () => {
    try {
      const list = await (await getSqlite()).getAllCreditVouchers();
      set({ creditVouchers: list });
    } catch (err) {
      console.warn('Failed to fetch credit vouchers:', err);
    }
  },

  createBundle: async (bundleInput) => {
    try {
      const { bundles, logSecurityAction } = get();
      const newBundle: ProductBundle = {
        ...bundleInput,
        id: newId('bndl'),
      };
      const updated = [newBundle, ...bundles];
      await (await getSqlite()).saveBundle(newBundle);
      await logSecurityAction(
        'Création Pack / Bundle',
        `Pack "${newBundle.bundleTitle}" créé — prix pack ${newBundle.bundlePrice} DA (${newBundle.childSkus?.length ?? 0} articles).`,
        'Admin',
        false
      );
      set({ bundles: updated });
    } catch (error) {
      console.error('Failed to create bundle:', error);
    }
  },

  deleteBundle: async (bundleId) => {
    try {
      const { bundles, logSecurityAction } = get();
      const target = bundles.find((b) => b.id === bundleId);
      const updated = bundles.filter((b) => b.id !== bundleId);
      await (await getSqlite()).deleteBundle(bundleId);
      if (target) {
        await logSecurityAction(
          'Suppression Pack / Bundle',
          `Pack "${target.bundleTitle}" supprimé (prix pack ${target.bundlePrice} DA).`,
          'Admin',
          false
        );
      }
      set({ bundles: updated });
    } catch (error) {
      console.error('Failed to delete bundle:', error);
    }
  },

  addBundleToCart: (bundleId) => {
    const { bundles, products, cart } = get();
    const bundle = bundles.find((b) => b.id === bundleId);
    if (!bundle) return { success: false, reason: 'BUNDLE_NOT_FOUND' };

    const outOfStock = bundle.childSkus.filter((sku) => {
      const product = products.find((p) => p.sku === sku);
      if (!product) return true;
      const existingInCart = cart.find((item) => item.product.id === product.id);
      const currentQty = existingInCart ? existingInCart.quantity : 0;
      return currentQty + 1 > product.stock;
    });

    if (outOfStock.length > 0) {
      return { success: false, reason: `CHILD_OUT_OF_STOCK:${outOfStock.join(',')}` };
    }

    const childProducts = bundle.childSkus
      .map((sku) => products.find((p) => p.sku === sku))
      .filter((p): p is Product => p !== undefined);

    const regularSum = childProducts.reduce((sum, p) => sum + p.price, 0);
    const bundleDiscountTotal = Math.max(0, regularSum - bundle.bundlePrice);

    const updatedCart = [...cart];

    // B-038: last line absorbs the rounding residue so the charged total
    // equals bundle.bundlePrice exactly (249 vs 250 class of drift).
    let assignedDiscount = 0;
    childProducts.forEach((childProd, idx) => {
      const isLast = idx === childProducts.length - 1;
      const itemRatio = regularSum > 0 ? childProd.price / regularSum : 1 / childProducts.length;
      const itemDiscount = isLast
        ? Math.max(0, bundleDiscountTotal - assignedDiscount)
        : Math.round(bundleDiscountTotal * itemRatio);
      if (!isLast) assignedDiscount += itemDiscount;

      const existingIndex = updatedCart.findIndex((item) => item.product.id === childProd.id);
      if (existingIndex >= 0) {
        updatedCart[existingIndex] = {
          ...updatedCart[existingIndex],
          quantity: updatedCart[existingIndex].quantity + 1,
          discount: updatedCart[existingIndex].discount + itemDiscount,
        };
      } else {
        updatedCart.push({
          product: childProd,
          quantity: 1,
          discount: itemDiscount,
          appliedPrice: childProd.price,
          imeiNumber: childProd.isSerialized ? '' : undefined,
        });
      }
    });

    set({ cart: updatedCart });
    return { success: true };
  },

  processTradeIn: async (tradeInput) => {
    try {
      const { tradeIns, products, customers, currentCustomer, imeiRecords } = get();

      const resalePrice = Math.round(tradeInput.buybackValue * (1 + tradeInput.resaleMarginPercent / 100));

      // Generate genuine product barcode:
      // If user scanned/entered a real packaging/product barcode, use it.
      // Otherwise, generate a certified unique EAN-13 (prefix 613) so it never masquerades as an IMEI.
      const realBarcode = tradeInput.barcode?.trim()
        ? tradeInput.barcode.trim()
        : generateUniqueEan13Barcode(products, '613');

      const newTradeIn: TradeInItem = {
        ...tradeInput,
        barcode: realBarcode,
        resalePrice,
        id: newId('trade'),
        createdAt: new Date().toISOString(),
      };

      const convertedProduct: Product = {
        id: newId('prod-trade'),
        sku: `TRD-${tradeInput.imei.slice(-6)}`,
        barcode: realBarcode,
        title: `${tradeInput.deviceModel} (${tradeInput.conditionGrade})`,
        brand: tradeInput.brand,
        compatibleModel: tradeInput.deviceModel,
        category: "Téléphones d'Occasion (Reprise)",
        price: resalePrice,
        wholesalePrice: Math.round(tradeInput.buybackValue * 1.15),
        costPrice: Math.round(tradeInput.buybackValue),
        stock: 1,
        imageUrl:
          'https://images.unsplash.com/photo-1592899677977-9c10ca588bbd?w=300&auto=format&fit=crop&q=80',
        isSerialized: true,
        imeiNumber: tradeInput.imei.trim(),
        vendorName: 'Client Buyback',
        leadTimeDays: 0,
        dailySalesVelocity: 0.5,
        reorderPoint: 0,
      };

      const imeiRecord: IMEIRecord = {
        imei: tradeInput.imei.trim(),
        productId: convertedProduct.id,
        receivedAt: new Date().toISOString(),
        notes: `Rachat d'occasion: ${tradeInput.deviceModel} - Client: ${newTradeIn.customerName}`,
        version: 1,
      };

      const updatedProducts = [convertedProduct, ...products];
      const updatedTradeIns = [newTradeIn, ...tradeIns];
      const currentImeis = imeiRecords || [];
      const updatedImeiRecords = [imeiRecord, ...currentImeis.filter((r) => r.imei !== imeiRecord.imei)];

      await (await getProductRepo()).save(convertedProduct);
      await (await getSqlite()).saveTradeIn(newTradeIn);
      try {
        await (await getSqlite()).saveIMEIRecord(imeiRecord);
      } catch (err) {
        console.warn('[processTradeIn] Failed to persist IMEI record:', err);
      }

      if (!tradeInput.creditToWallet && get().activeShift) {
        // B-033: integer DZD at drawer — unrounded buybackValue drifts.
        const buybackCash = Math.max(0, Math.round(Number(tradeInput.buybackValue) || 0));
        const drawerRes = await get().logCashMovement(
          buybackCash,
          'EXPENSE',
          `Décaissement Rachat Occasion: ${newTradeIn.deviceModel} (IMEI: ${newTradeIn.imei})`
        );
        // B-036: a failed drawer deposit after a successful trade-in must not
        // report pure success — the books are now short cash with no movement.
        if (drawerRes && typeof drawerRes === 'object' && 'success' in drawerRes && !drawerRes.success) {
          console.error('[processTradeIn] Drawer deposit failed after trade-in save:', drawerRes);
          set({
            products: updatedProducts,
            tradeIns: updatedTradeIns,
            imeiRecords: updatedImeiRecords,
            activeModal: null,
          });
          return {
            success: false as const,
            reason: `DRAWER_DEPOSIT_FAILED:${String((drawerRes as { reason?: string }).reason || '')}`,
          };
        }
      }

      let updatedCustomers = customers;
      let updatedCurrentCustomer = currentCustomer;
      if (tradeInput.creditToWallet) {
        // B-036: resolve the trade-in form customer — never silently credit
        // the wrong wallet. Each fallback triggers only when the operator
        // gave LESS identity: an explicit id or phone that matches nothing
        // fails loud (NO_CREDIT_TARGET) instead of falling through to
        // whoever happens to be selected (a mistyped phone must never mint
        // liability into a stranger's wallet).
        const failNoTarget = () => {
          set({
            products: updatedProducts,
            tradeIns: updatedTradeIns,
            imeiRecords: updatedImeiRecords,
            activeModal: null,
          });
          return { success: false as const, reason: 'NO_CREDIT_TARGET' };
        };
        const explicitId = (tradeInput as { customerId?: string }).customerId;
        const formPhone = tradeInput.customerPhone?.replace(/\D/g, '');
        let creditTarget;
        if (explicitId) {
          creditTarget = customers.find((c) => c.id === explicitId);
          if (!creditTarget) return failNoTarget();
        } else if (formPhone) {
          creditTarget = customers.find((c) => (c.phone || '').replace(/\D/g, '') === formPhone);
          if (!creditTarget) return failNoTarget();
        } else {
          creditTarget = currentCustomer;
          if (!creditTarget) return failNoTarget();
        }
        // Integer DZD like every other credit mutation (a raw float here
        // minted fractional liabilities no report ever reconciled).
        const buybackCredit = Math.max(0, Math.round(Number(tradeInput.buybackValue) || 0));
        const credited = {
          ...creditTarget,
          storeCredit: (creditTarget.storeCredit || 0) + buybackCredit,
        };
        updatedCustomers = customers.map((c) => (c.id === creditTarget.id ? credited : c));
        updatedCurrentCustomer =
          currentCustomer?.id === creditTarget.id ? credited : currentCustomer;
        await (await getCustomerRepo()).save(credited);
        get().logSecurityAction(
          'Avoir Reprise Occasion Émis',
          `Client: ${creditTarget.name} — avoir de ${buybackCredit} DA émis (rachat ${newTradeIn.deviceModel}, IMEI: ${newTradeIn.imei}).`,
          'Système (Reprise)',
          false
        );
      }

      set({
        products: updatedProducts,
        tradeIns: updatedTradeIns,
        imeiRecords: updatedImeiRecords,
        customers: updatedCustomers,
        currentCustomer: updatedCurrentCustomer,
        activeModal: null,
      });
      // Backward compatible: historic callers ignore the return value (the
      // declared type stays Promise<void>, and any value is assignable to void).
      return { success: true as const };
    } catch (error) {
      console.error('Failed to process trade-in:', error);
      return { success: false as const, reason: 'TRADE_IN_FAILED' };
    }
  },

  addStoreExpense: async (expenseInput) => {
    try {
      const { storeExpenses, logSecurityAction } = get();
      // B-033: integer DZD at the write boundary — drawer movements round,
      // so an unrounded expense amount drifts report vs drawer.
      const validAmount = Math.max(0, Math.round(isNaN(expenseInput.amount) ? 0 : expenseInput.amount));
      if (!expenseInput.title || !expenseInput.title.trim() || validAmount <= 0) {
        return;
      }
      const newExpense: StoreExpense = {
        ...expenseInput,
        title: expenseInput.title.trim(),
        amount: validAmount,
         id: newId('EXP'),
        createdAt: new Date().toISOString(),
      };
      const updated = [newExpense, ...storeExpenses];
      await (await getSqlite()).saveStoreExpense(newExpense);

      // Deduct from drawer balance ONLY if paid in physical cash
      if (get().activeShift && newExpense.paymentMethod === 'Espèces') {
        await get().logCashMovement(
          validAmount,
          'EXPENSE',
          `Dépense d'exploitation espèces (${newExpense.category}): ${newExpense.title}`
        );
      }

      logSecurityAction(
        'Enregistrement Charge d\'Exploitation',
        `${newExpense.category}: ${newExpense.title} (${validAmount} DA)`,
        newExpense.recordedBy || 'Admin',
        false
      );
      set({ storeExpenses: updated });
    } catch (error) {
      console.error('Failed to add store expense:', error);
    }
  },

  deleteStoreExpense: async (id) => {
    try {
      const { storeExpenses, activeShift, allShifts, logSecurityAction, logCashMovement } = get();
      const target = (storeExpenses || []).find((e) => e.id === id);
      if (!target) return { success: false as const, reason: 'NOT_FOUND' };
      let compensated = false;
      // Cash expenses moved real drawer money: addStoreExpense writes an
      // EXPENSE movement twin. Deleting the source row without reversing the
      // movement leaves booking subtracting money Reports no longer shows —
      // a permanent false surplus. Reverse with a compensating deposit, but
      // ONLY when the expense belongs to the currently open session: books
      // of a closed session are immutable, and compensating there would plant
      // a phantom deposit in today's drawer. The original movement stays
      // (immutable history — outflow + reversal both remain auditable).
      if (target.paymentMethod === 'Espèces') {
        const createdAt = target.createdAt || '';
        const sessions = [...(allShifts || [])];
        if (activeShift && !sessions.some((s) => s.id === activeShift.id)) sessions.push(activeShift);
        const inWindow = (s: { openedAt?: string; closedAt?: string | null }) =>
          createdAt >= (s.openedAt || '') && (!s.closedAt || createdAt < s.closedAt);
        const container = sessions.find(inWindow);
        const isCurrentOpen = Boolean(
          activeShift && container && container.id === activeShift.id && (activeShift.status || 'OPEN') === 'OPEN'
        );
        if (!isCurrentOpen) {
          return { success: false as const, reason: 'CLOSED_SESSION_IMMUTABLE' };
        }
        const expenseAmount = Math.max(0, Math.round(target.amount || 0));
        // Preserve the operator's modal: logCashMovement closes it (sets
        // activeModal null) as a side effect.
        const prevModal = get().activeModal;
        const comp = await logCashMovement(
          expenseAmount,
          'MANUAL_DEPOSIT',
          `Contre-passation suppression charge espèces: ${target.title} (${expenseAmount} DA)`
        );
        if (prevModal) set({ activeModal: prevModal });
        if (!comp.success) return { success: false as const, reason: 'COMPENSATION_FAILED' };
        compensated = true;
      }
      const updated = (storeExpenses || []).filter((e) => e.id !== id);
      await (await getSqlite()).deleteStoreExpense(id);
      // Deletes were previously silent — an EBITDA alteration with no audit
      // trail. Now every delete is logged, with compensation noted.
      logSecurityAction(
        "Suppression Charge d'Exploitation",
        `${target.category}: ${target.title} (${target.amount} DA, ${target.paymentMethod})${compensated ? ' — caisse contre-passée (dépôt manuel)' : ''}`,
        target.recordedBy || 'Admin',
        false
      );
      set({ storeExpenses: updated });
      return { success: true as const, compensated };
    } catch (error) {
      console.error('Failed to delete store expense:', error);
      return { success: false as const, reason: 'DB_SAVE_FAILED' };
    }
  },

  validateIMEI: (imei) => {
    if (!/^\d{15}$/.test(imei)) {
      return { valid: false, reason: 'L\'IMEI doit contenir exactement 15 chiffres.' };
    }
    const { imeiRecords } = get();
    const duplicate = imeiRecords.find((r) => r.imei === imei);
    if (duplicate) {
      return { valid: false, reason: 'Cet IMEI existe déjà dans le système.' };
    }
    return { valid: true };
  },

  searchByIMEI: (imei) => {
    const { products, purchaseOrders, transactions } = get();
    const product = products.find((p) => p.imeiNumber === imei);
    if (!product) return null;

    const po = product.purchaseOrderId
      ? purchaseOrders.find((p) => p.id === product.purchaseOrderId)
      : undefined;

    const transaction = transactions.find((t) =>
      t.items.some((item) => item.imeiNumber === imei)
    );

    return { product, po, transaction };
  },

  initDatabase: async () => {
      // P11.3: initDatabase is called from App boot, the mobile pairing wizard, and
      // importDatabase. Without sharing, concurrent callers each fire 16 parallel
      // loads and race on set() — the last writer wins, and the DB graph module
      // gets imported twice. Memoize the in-flight promise; all callers await it.
      if (initDatabaseInFlight) return initDatabaseInFlight;
      initDatabaseInFlight = (async () => {
        markBoot('init:start');
        try {
          const sqlite = await getSqlite();
          // LCP: two waves. Wave 1 is the till-critical minimum that gates the
          // splash (products grid, shift, PINs, receipt settings) — paint ASAP.
          // Wave 2 is history/deferred lanes (customers, transactions, repairs,
          // ledgers, valuation, audit) that the same promise resolves after
          // paint. Components already tolerate empty arrays (the catch path
          // below boots that way), and every set() re-renders subscribers.
          // P3.3: loads within a wave are independent — one parallel wave
          // (latency = max, not sum).
          const [products, activeShift] = await Promise.all([
            sqlite.getAllProducts(),
            sqlite.getActiveShift(),
          ]);
          markBoot('init:wave1-data');

          if (typeof localStorage !== 'undefined') {
            localStorage.removeItem('mobi_pos_products');
            localStorage.removeItem('mobi_pos_customers');
            localStorage.removeItem('mobi_pos_transactions');
          }

          // SECURITY: no hardcoded fallback. Fresh installs get '' (unset → the
          // App.tsx setup gate forces PIN creation); upgrades keep their stored
          // value, and a stored default '1234' is caught by that same gate.
          const managerPin = await (await getSettingsRepo()).get('manager_pin', '');
          const receiptSettings = await loadReceiptSettings();
          const savedCashiers = await (await getSettingsRepo()).get<CashierUser[]>('cashier_users', DEFAULT_CASHIERS);
          const creditVouchers = await sqlite.getAllCreditVouchers().catch(() => []);
        const loadedUsers = Array.isArray(savedCashiers) && savedCashiers.length > 0 ? savedCashiers : DEFAULT_CASHIERS;
        // Self-heal for installs that drifted before the single-PIN contract:
        // if a real manager PIN exists but the primary admin row holds a
        // different one, the master wins and is persisted back.
        const cleanManagerPin = typeof managerPin === 'string' && managerPin.length >= 4 ? managerPin : '';
        const primaryAdmin = loadedUsers.find((u) => u.role === 'admin');
        const healedUsers =
          cleanManagerPin && primaryAdmin && primaryAdmin.pin !== cleanManagerPin
            ? loadedUsers.map((u) => (u.id === primaryAdmin.id ? { ...u, pin: cleanManagerPin } : u))
            : loadedUsers;
        // Plaintext-PIN migration (fail-closed hardening): any cashier PIN or
        // manager PIN stored pre-hash (ancient installs) is hashed in place at
        // boot. After this, stored PINs are always `v1$` hashes — hashes are
        // what sync to peer devices, plaintext never rests or travels.
        let pinRow = { users: healedUsers, managerPin: cleanManagerPin, dirty: healedUsers !== loadedUsers };
        const needsHash = (p: unknown) => typeof p === 'string' && p.length > 0 && !p.startsWith('v1$');
        if (pinRow.managerPin && needsHash(pinRow.managerPin)) {
          pinRow = { ...pinRow, managerPin: hashPin(pinRow.managerPin), dirty: true };
          await (await getSettingsRepo()).set('manager_pin', pinRow.managerPin).catch((err: unknown) => {
            console.warn('[boot] Failed to persist migrated manager PIN:', err);
          });
        }
        if (pinRow.users.some((u) => needsHash(u.pin))) {
          pinRow = {
            ...pinRow,
            users: pinRow.users.map((u) => (needsHash(u.pin) ? { ...u, pin: hashPin(String(u.pin)) } : u)),
            dirty: true,
          };
        }
        const finalUsers = pinRow.users;
        const finalManagerPin = pinRow.managerPin;
        if (pinRow.dirty) {
          await (await getSettingsRepo()).set('cashier_users', finalUsers).catch((err: unknown) => {
            console.warn('[boot] Failed to persist migrated/healed cashier PINs:', err);
          });
        }

        set({
          products,
          activeShift,
          managerPin: finalManagerPin,
          receiptSettings,
          shiftFloat: activeShift?.openingFloat || 20000,
          cashierUsers: finalUsers,
          activeCashier: finalUsers[0] || DEFAULT_CASHIERS[0],
          creditVouchers,
          // Wave-B persists holds to localStorage; hydrate here (fail silent to []).
          heldSales: loadHeldSalesFromStorage(),
          isDbInitialized: true,
        });
        markBoot('init:paint');
        // Wave 2 — history lanes resolve after paint (same promise, so
        // importDatabase/pairing callers still await the full load). A wave-2
        // failure keeps the painted till and warns; it never returns the
        // splash (today a single failed table empties the whole store).
        try {
          const [
            customers,
            transactions,
            repairOrders,
            purchaseOrders,
            tradeIns,
            imeiRecords,
            cashDrops,
            payouts,
            bundles,
            customerDebts,
            storeExpenses,
            allShifts,
            inventoryValuation,
            auditLogs,
          ] = await Promise.all([
            sqlite.getAllCustomers(),
            sqlite.getAllTransactions(),
            sqlite.getAllRepairOrders(),
            sqlite.getAllPurchaseOrders(),
            sqlite.getAllTradeIns(),
            sqlite.getAllIMEIRecords(),
            sqlite.getCashDrops(false),
            sqlite.getCashDrops(true),
            sqlite.getAllBundles(),
            sqlite.getAllCustomerDebts(),
            sqlite.getAllStoreExpenses(),
            sqlite.getAllShifts(),
            sqlite.getInventoryValuation(),
            sqlite.getAllAuditLogs(),
          ]);
          set({
            customers,
            transactions,
            repairOrders,
            purchaseOrders,
            tradeIns,
            imeiRecords,
            cashDrops,
            payouts,
            bundles,
            customerDebts,
            storeExpenses,
            allShifts,
            inventoryValuation,
            securityAuditLog: auditLogs && auditLogs.length > 0 ? auditLogs : get().securityAuditLog,
          });
          markBoot('init:wave2-data');
        } catch (e) {
          console.warn('[boot] Deferred history load skipped:', e);
        }
        printBootSummary();
      } catch (e) {
        console.error('Failed to initialize SQLite Database:', e);
        const { products, customers } = get();
        set({
          products: products.length > 0 ? products : [],
          customers: customers.length > 0 ? customers : [],
          isDbInitialized: true,
        });
        printBootSummary();
      }
    })()
      .finally(() => {
        initDatabaseInFlight = null;
      });
    return initDatabaseInFlight;
  },

  seedDemoData: async () => {
    try {
      await (await getBackupRepo()).seedDemoData(INITIAL_PRODUCTS, INITIAL_CUSTOMERS);
      const products = await (await getProductRepo()).getAll();
      const customers = await (await getCustomerRepo()).getAll();
      set({ products, customers });
    } catch (error) {
      console.error('Failed to seed demo data:', error);
    }
  },

  refreshAfterPull: async () => {
    try {
      const [
        products,
        customers,
        transactions,
        repairOrders,
        purchaseOrders,
        tradeIns,
        imeiRecords,
        cashDrops,
        payouts,
        bundles,
        customerDebts,
        storeExpenses,
        activeShift,
        allShifts,
        inventoryValuation,
        auditLogs,
      ] = await Promise.all([
        (await getSqlite()).getAllProducts(),
        (await getSqlite()).getAllCustomers(),
        (await getSqlite()).getAllTransactions(),
        (await getSqlite()).getAllRepairOrders(),
        (await getSqlite()).getAllPurchaseOrders(),
        (await getSqlite()).getAllTradeIns(),
        (await getSqlite()).getAllIMEIRecords(),
        (await getSqlite()).getCashDrops(false),
        (await getSqlite()).getCashDrops(true),
        (await getSqlite()).getAllBundles(),
        (await getSqlite()).getAllCustomerDebts(),
        (await getSqlite()).getAllStoreExpenses(),
        (await getSqlite()).getActiveShift(),
        (await getSqlite()).getAllShifts(),
        (await getSqlite()).getInventoryValuation(),
        (await getSqlite()).getAllAuditLogs(),
      ]);
      const receiptSettings = await loadReceiptSettings();
      // Team precision: cashier roster + manager PIN arrive via the settings
      // lane (a hire on desktop must unlock the phone). Reload them with every
      // pull refresh so peer edits converge without a restart.
      const savedCashiers = await (await getSettingsRepo()).get<CashierUser[]>('cashier_users', get().cashierUsers);
      const roster = Array.isArray(savedCashiers) && savedCashiers.length > 0 ? savedCashiers : get().cashierUsers;
      const pulledManagerPin = await (await getSettingsRepo()).get<string>('manager_pin', get().managerPin);
      const activeCashier = roster.find((u) => u.id === get().activeCashier?.id) || roster[0] || get().activeCashier;
      // Precision: a debt paid (or credit granted) on a peer device refreshes
      // the customer list below, but the cart's SELECTED customer object would
      // keep showing the stale debt/credit until reselected. Rebase it.
      const currentCustomer = get().currentCustomer
        ? customers.find((c) => c.id === get().currentCustomer?.id) ?? get().currentCustomer
        : get().currentCustomer;
      set({
        products,
        customers,
        transactions,
        repairOrders,
        purchaseOrders,
        tradeIns,
        imeiRecords,
        cashDrops,
        payouts,
        bundles,
        customerDebts,
        storeExpenses,
        activeShift,
        allShifts,
        inventoryValuation,
        securityAuditLog: auditLogs && auditLogs.length > 0 ? auditLogs : get().securityAuditLog,
        receiptSettings,
        currentCustomer,
        cashierUsers: roster,
        activeCashier,
        managerPin: typeof pulledManagerPin === 'string' ? pulledManagerPin : get().managerPin,
      });
    } catch (e) {
      console.warn('Post-pull refresh skipped:', e);
    }
  },

  refreshPullTargets: async (summary) => {
    // P1 targeted refresh: reload only slices the last pull touched.
    // Falls back to the full 16-table reload for anything unmapped so the UI
    // can never go stale — correctness first, speed second.
    try {
      const tables = new Set(summary.tables ?? []);
      const productIds = [...new Set((summary.productIds ?? []).map((id) => String(id || '')).filter(Boolean))];
      const wantsProducts = productIds.length > 0 || tables.has('products') || tables.has('inventory_ledger');
      const wantsTransactions = summary.transactions || tables.has('transactions')
        || tables.has('transaction_items') || tables.has('customers');
      const handledTables = new Set(['products', 'inventory_ledger', 'transactions', 'transaction_items', 'customers']);
      const wantsSettings = tables.has('app_settings');
      const hasUnmapped = [...tables].some((t) => !handledTables.has(t) && t !== 'app_settings');
      if (hasUnmapped || (!wantsProducts && !wantsTransactions && !wantsSettings && tables.size > 0)) {
        await get().refreshAfterPull();
        return;
      }
      if (!wantsProducts && !wantsTransactions && !wantsSettings) return;
      if (!wantsProducts && !wantsTransactions && wantsSettings) {
        // Settings-only pull: refresh the settings lane (store profile) plus
        // the team lane that rides it (roster/PIN), not all 16 tables.
        const [freshSettings, freshRoster, freshPin] = await Promise.all([
          loadReceiptSettings(),
          (await getSettingsRepo()).get<CashierUser[]>('cashier_users', get().cashierUsers),
          (await getSettingsRepo()).get<string>('manager_pin', get().managerPin),
        ]);
        const roster2 = Array.isArray(freshRoster) && freshRoster.length > 0 ? freshRoster : get().cashierUsers;
        set({
          receiptSettings: freshSettings,
          cashierUsers: roster2,
          activeCashier: roster2.find((u) => u.id === get().activeCashier?.id) || roster2[0] || get().activeCashier,
          managerPin: typeof freshPin === 'string' ? freshPin : get().managerPin,
        });
        return;
      }
      const next: { products?: Product[]; transactions?: Awaited<ReturnType<SqliteAdapter['getAllTransactions']>>; customers?: Awaited<ReturnType<SqliteAdapter['getAllCustomers']>>; currentCustomer?: Awaited<ReturnType<SqliteAdapter['getAllCustomers']>>[number] } = {};
      if (wantsProducts) {
        if (productIds.length > 0 && productIds.length <= 200) {
          const subset = await (await getSqlite()).getProductsByIds(productIds);
          const requested = new Set(productIds);
          const returned = new Set(subset.map((p) => p.id));
          const merged = new Map(get().products.map((p) => [p.id, p]));
          // B-037: drop requested keys missing from the subset — peer-deleted
          // products must leave the store (upsert-only left ghost catalog rows).
          for (const id of requested) {
            if (!returned.has(id)) merged.delete(id);
          }
          for (const p of subset) merged.set(p.id, p);
          next.products = [...merged.values()];
        } else {
          next.products = await (await getSqlite()).getAllProducts();
        }
      }
      if (wantsTransactions) {
        const [transactions, customers] = await Promise.all([
          (await getSqlite()).getAllTransactions(),
          (await getSqlite()).getAllCustomers(),
        ]);
        next.transactions = transactions;
        next.customers = customers;
        const selected = get().currentCustomer;
        if (selected) {
          const rebased = customers.find((c) => c.id === selected.id);
          if (rebased) next.currentCustomer = rebased;
        }
      }
      if (Object.keys(next).length > 0) set(next as Partial<PosState>);
    } catch (e) {
      console.warn('Targeted post-pull refresh failed, falling back to full reload:', e);
      try {
        await get().refreshAfterPull();
      } catch (fallbackErr) {
        console.warn('Post-pull refresh skipped:', fallbackErr);
      }
    }
  },

  exportDatabase: async () => {
    try {
      const jsonString = await (await getBackupRepo()).exportJSON();
      if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof document !== 'undefined') {
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `MOBI_POS_INDEXEDDB_BACKUP_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      console.error('Export failed:', e);
    }
  },

  importDatabase: async (jsonString: string) => {
    try {
      const importResult = await (await getBackupRepo()).importJSON(jsonString);
      // A restore replaces live books (transactions, audit, vouchers) — it
      // must itself be auditable, or a tamper-restore erases its own trace.
      // Best-effort AFTER the outcome is known; never fails the restore.
      try {
        get().logSecurityAction(
          'Restauration Base de Données',
          importResult.success
            ? 'Sauvegarde JSON importée — données actuelles remplacées.'
            : `Tentative de restauration échouée (${importResult.reason || 'IMPORT_FAILED'}).`,
          'Manager',
          true
        );
      } catch {
        // Audit lane trouble must not mask the restore outcome.
      }
      if (importResult.success) {
        await get().initDatabase();
      }
      return importResult;
    } catch (error) {
      console.error('Import database failed:', error);
      return { success: false, reason: 'IMPORT_FAILED' };
    }
  },
});

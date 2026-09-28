import { useState, useEffect, useRef, useCallback } from 'react';
import { usePosStore } from '../store/usePosStore';
import { soundEngine } from '../utils/audioFeedback';
import type { Product, Customer, ProductBundle } from '../types/pos';

const lowerKey = (s: string | undefined | null): string => (s || '').trim().toLowerCase();
const alnumUpper = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

interface CustomerScanEntry {
  customer: Customer;
  cleanId: string;
}

function buildProductMap(list: Product[]): Map<string, Product> {
  const map = new Map<string, Product>();
  for (const p of list) {
    // First row wins, mirroring Array.find order over the same key set.
    const keys = [lowerKey(p.barcode), lowerKey(p.sku), lowerKey(p.id)];
    for (const k of keys) {
      if (k && !map.has(k)) map.set(k, p);
    }
  }
  return map;
}

function buildBundleMap(list: ProductBundle[]): Map<string, ProductBundle> {
  const map = new Map<string, ProductBundle>();
  for (const b of list) {
    const keys = [lowerKey(b.barcode), lowerKey(b.id)];
    for (const k of keys) {
      if (k && !map.has(k)) map.set(k, b);
    }
  }
  return map;
}

function buildCustomerIndex(list: Customer[]): { exact: Map<string, Customer>; entries: CustomerScanEntry[] } {
  const exact = new Map<string, Customer>();
  const entries: CustomerScanEntry[] = [];
  const addExact = (key: string, c: Customer) => {
    const k = key.trim();
    if (!k) return;
    const lk = k.toLowerCase();
    if (!exact.has(lk)) exact.set(lk, c);
    const digits = k.replace(/[^0-9]/g, '');
    if (digits && !exact.has(digits)) exact.set(digits, c);
  };
  for (const c of list) {
    addExact(c.id, c);
    addExact(c.phone || '', c);
    addExact(c.loyaltyCardCode || '', c);
    addExact(c.barcode || '', c);
    if (c.id) {
      const upper = c.id.toUpperCase();
      addExact(`LOY-${upper}`, c);
      addExact(`LOYALTY-${upper}`, c);
      addExact(`CUST-${upper}`, c);
    }
    entries.push({ customer: c, cleanId: alnumUpper(c.id || '') });
  }
  return { exact, entries };
}

/**
 * Hook global pour détecter la saisie d'un lecteur de code-barres USB (HID).
 * 
 * Algorithme de détection :
 * - Les douchettes USB simulent un clavier.
 * - Le délai entre deux touches est très court (< 30ms).
 * - La saisie se termine toujours par la touche Entrée (keyCode 13).
 * - On ignore les saisies lentes humaines (> 50ms) pour ne pas interférer avec la saisie normale au clavier.
 */
export function useBarcodeScanner(): { lastScannedCode: string | null; scannerActive: boolean } {
  const [lastScannedCode, setLastScannedCode] = useState<string | null>(null);
  const [scannerActive, setScannerActive] = useState<boolean>(false);
  
  const buffer = useRef<string>('');
  const lastKeyTime = useRef<number>(0);
  const lastScanTimestamp = useRef<number>(0);
  const lastScanCode = useRef<string>('');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Memoized scan indexes, rebuilt only when the underlying list identity
  // changes — not per item per scan. The previous code ran trim()/regex over
  // every product/customer on every wedge scan.
  // NOTE on productAdapter: its indexed Dexie lookup
  // (findProductByBarcodeOrSku: barcode equalsIgnoreCase -> sku
  // equalsIgnoreCase) is the DB-layer equivalent of the map below. The wedge
  // path must stay synchronous (keydown timing), so it reads the in-memory
  // store mirror through the same key semantics instead of awaiting Dexie.
  const productCache = useRef<{ list: Product[] | null; map: Map<string, Product> }>({ list: null, map: new Map() });
  const bundleCache = useRef<{ list: ProductBundle[] | null; map: Map<string, ProductBundle> }>({ list: null, map: new Map() });
  const customerCache = useRef<{ list: Customer[] | null; exact: Map<string, Customer>; entries: CustomerScanEntry[] }>({
    list: null,
    exact: new Map(),
    entries: [],
  });

  const processScan = useCallback((rawCode: string) => {
    const code = rawCode.trim();
    if (!code) return;

    // Debounce rapid duplicate scans within 400ms to prevent double-adding from laser reflections
    const now = Date.now();
    if (code === lastScanCode.current && now - lastScanTimestamp.current < 400) {
      return;
    }
    lastScanCode.current = code;
    lastScanTimestamp.current = now;

    // 1. Parse multiplier syntax (e.g. 5*BARCODE, 12xBARCODE)
    let multiplier = 1;
    let effectiveCode = code;
    const multiplierMatch = code.match(/^(\d{1,3})\s*[*xX]\s*(.+)$/);
    if (multiplierMatch && multiplierMatch[1] && multiplierMatch[2]) {
      multiplier = Math.max(1, parseInt(multiplierMatch[1], 10));
      effectiveCode = multiplierMatch[2].trim();
    }

    // 2. Strip AIM symbology prefix if scanner outputs it (e.g. "]C1", "]E0", "]d2")
    effectiveCode = effectiveCode.replace(/^\][A-Za-z0-9]{2}/, '');

    const store = usePosStore.getState();
    const activeModal = store.activeModal;

    // Guard: If editor or label printer is open, expose code for auto-fill and dispatch event
    if (activeModal === 'product_editor' || activeModal === 'label_printer') {
      setLastScannedCode(effectiveCode);
      soundEngine.playScan();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('pos:barcode-scanned', { detail: { code: effectiveCode, multiplier: 1 } }));
      }
      return;
    }

    // Guard: If payment modal is open, dispatch voucher scan event
    if (activeModal === 'payment') {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('pos:payment-voucher-scanned', { detail: { code: effectiveCode } }));
      }
      return;
    }

    // Guard: If any other modal is open (e.g. settings, security audit, pin prompt, reports, refund), ignore scan
    if (activeModal !== null) {
      return;
    }

    setScannerActive(true);

    const products = store.products || [];
    const bundles = store.bundles || [];
    const customers = store.customers || [];

    if (productCache.current.list !== products) {
      productCache.current = { list: products, map: buildProductMap(products) };
    }
    if (bundleCache.current.list !== bundles) {
      bundleCache.current = { list: bundles, map: buildBundleMap(bundles) };
    }
    if (customerCache.current.list !== customers) {
      const built = buildCustomerIndex(customers);
      customerCache.current = { list: customers, exact: built.exact, entries: built.entries };
    }

    const cleanCode = alnumUpper(effectiveCode);
    const effectiveLower = effectiveCode.toLowerCase();
    const effectiveDigits = effectiveCode.replace(/[^0-9]/g, '');

    // Check if code matches a Customer Loyalty Card Barcode (PVC / Digital Pass)
    // Exact keys hit the prebuilt map; only the substring fallback scans entries
    // (over precomputed cleanIds, no per-item regex).
    let customerMatch: Customer | undefined;
    customerMatch =
      customerCache.current.exact.get(effectiveCode) ||
      customerCache.current.exact.get(effectiveLower) ||
      (effectiveDigits ? customerCache.current.exact.get(effectiveDigits) : undefined);
    if (!customerMatch && cleanCode.length >= 3) {
      const hit = customerCache.current.entries.find(
        (e) => e.cleanId.length >= 3 && cleanCode.includes(e.cleanId)
      );
      customerMatch = hit?.customer;
    }

    if (customerMatch) {
      soundEngine.playScan();
      store.setCurrentCustomer(customerMatch);
      store.logSecurityAction(
        `Identification Carte PVC Scannée: ${customerMatch.name}`,
        `Code Scanné: ${effectiveCode} - Avoir Client: ${customerMatch.storeCredit} DA - Points: ${customerMatch.loyaltyPoints}`,
        'Lecteur Code-barres USB HID',
        true
      );
      setLastScannedCode(null);
    } else {
      const targetCode = lowerKey(effectiveCode);
      const productMatch = productCache.current.map.get(targetCode);

      if (productMatch) {
        soundEngine.playScan();
        store.addToCart(productMatch, false, multiplier);
        setLastScannedCode(null);
      } else {
        const bundleMatch = bundleCache.current.map.get(targetCode);

        if (bundleMatch) {
          soundEngine.playScan();
          for (let i = 0; i < multiplier; i++) {
            store.addBundleToCart(bundleMatch.id);
          }
          setLastScannedCode(null);
        } else {
          // Unrecognized scan: trigger audible error feedback for the cashier
          soundEngine.playError();
          setLastScannedCode(effectiveCode);
        }
      }
    }
    
    // Dispatch global event for other components if needed
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('pos:barcode-scanned', { detail: { code: effectiveCode, multiplier } }));
    }

    // Reset active scanner feedback
    setTimeout(() => {
      setScannerActive(false);
    }, 300);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const now = Date.now();
      const timeDiff = now - lastKeyTime.current;
      
      const activeElement = document.activeElement;
      const isInputFocused = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement;
      
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      if (e.key === 'Enter') {
        if (buffer.current.length >= 3) {
          // Code-barres valide détecté (3+ caractères)
          processScan(buffer.current);
          
          // If the user was focused on the search input, clean it up and blur so the grid is not filtered
          if (isInputFocused && activeElement instanceof HTMLInputElement) {
            const isSearchBar = 
              activeElement.placeholder?.toLowerCase().includes('scanner') ||
              activeElement.placeholder?.toLowerCase().includes('rechercher') ||
              activeElement.type === 'search';

            if (isSearchBar) {
              activeElement.value = '';
              activeElement.blur();
              usePosStore.getState().setSearchQuery('');
            }
          }
          
          e.preventDefault();
        }
        buffer.current = '';
      } else if (e.key.length === 1) { // Touche de caractère imprimable
        // Si le délai est long (> 50ms), c'est une frappe humaine lente ou la toute première touche.
        // On réinitialise le buffer avec la touche actuelle si le buffer n'est pas vide
        // pour ne pas accumuler des frappes manuelles.
        if (timeDiff > 50 && buffer.current.length > 0) {
          buffer.current = e.key;
        } else {
          buffer.current += e.key;
        }
      }
      
      lastKeyTime.current = now;
      
      // Réinitialiser le buffer si aucun caractère n'est reçu pendant 200ms
      timeoutRef.current = setTimeout(() => {
        buffer.current = '';
      }, 200);
    };

    window.addEventListener('keydown', handleKeyDown);
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [processScan]);

  return { lastScannedCode, scannerActive };
}

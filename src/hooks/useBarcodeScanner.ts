import { useState, useEffect, useRef, useCallback } from 'react';
import { usePosStore } from '../store/usePosStore';
import { soundEngine } from '../utils/audioFeedback';
import {
  createWedgeBurst,
  pushWedgeKey,
  resetWedgeBurst,
  takeWedgeBurst,
  WEDGE_GAP_LOOSE_MS,
  WEDGE_GAP_TEXT_MS,
  WEDGE_IDLE_MS,
  type ScanTarget,
  type WedgeBurstState,
} from '../utils/wedgeBurst';
import type { Product, Customer, ProductBundle } from '../types/pos';

const lowerKey = (s: string | undefined | null): string => (s || '').trim().toLowerCase();
const alnumUpper = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Input types that never receive typed text (buttons, pickers, …). */
const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden',
]);

/** True when keystrokes land as editable text in `el` (readOnly/disabled excluded). */
function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    if (NON_TEXT_INPUT_TYPES.has(el.type)) return false;
    return !el.disabled && !el.readOnly;
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

/** Explicit scan destination of `el`, or null when it is a manual-entry field. */
function scanTargetOf(el: Element | null): ScanTarget {
  if (!el) return null;
  const value = el.closest('[data-barcode-scan-target]')?.getAttribute('data-barcode-scan-target');
  return value === 'search' || value === 'field' ? value : null;
}

/**
 * Clear a controlled React input from outside React: the native value setter
 * bypasses React's value tracker, and the synthetic `input` event feeds the
 * field's own onChange so its state follows.
 *
 * Why both halves are load-bearing (measured in Chromium on a controlled
 * input — value → React state → what onChange saw):
 *   `el.value = ''`            → DOM "", React state STALE (onChange silent)
 *   native setter only         → DOM "", React state STALE
 *   native setter + `input`    → DOM "", React state ""  ✅ onChange saw ""
 * React patches `value` with a tracker-aware setter that updates its record,
 * so a plain assignment looks like a real edit to the next event. Never mix
 * the two styles: one plain assignment poisons the record and the following
 * native-setter + event is then deduped away.
 */
function clearInputValue(el: HTMLInputElement): void {
  try {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } catch {
    el.value = '';
  }
}

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
 * - La frappe manuelle dans un champ de saisie n'est JAMAIS décodée, et un
 *   envoi vers un champ de texte exige une cadence machine continue : voir
 *   src/utils/wedgeBurst.ts (« Wedge-burst guard »), seule façon de distinguer
 *   « chargeur » d'un code-barres.
 */
export function useBarcodeScanner(): { lastScannedCode: string | null; scannerActive: boolean } {
  const [lastScannedCode, setLastScannedCode] = useState<string | null>(null);
  const [scannerActive, setScannerActive] = useState<boolean>(false);
  
  const burstRef = useRef<WedgeBurstState>(createWedgeBurst());
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
      const burst = burstRef.current;
      const activeElement = document.activeElement;
      const target = scanTargetOf(activeElement);

      // (1) TARGET GUARD — manual-entry field (input / textarea /
      // contenteditable that is not a sanctioned scan destination): the
      // decoder stands down and drops any in-flight run, so nothing typed here
      // can be mistaken for a barcode and nothing here is ever cleared by one.
      // Enter is left to the field's own handler.
      if (isEditableTarget(activeElement) && target === null) {
        resetWedgeBurst(burst);
        lastKeyTime.current = now;
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        return;
      }

      const maxGap = target !== null ? WEDGE_GAP_TEXT_MS : WEDGE_GAP_LOOSE_MS;
      const timeDiff = now - lastKeyTime.current;

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      if (e.key === 'Enter') {
        // (2) Only an unbroken machine-grade run decodes (see utils/wedgeBurst).
        const code = takeWedgeBurst(burst);
        if (code) {
          processScan(code);

          // Sanctioned search target: drop the scanned code from the field and
          // the catalog filter so the grid is not left filtered by a barcode.
          // ("field" targets keep their value — the component owns it.)
          if (target === 'search' && activeElement instanceof HTMLInputElement) {
            clearInputValue(activeElement);
            activeElement.blur();
            usePosStore.getState().setSearchQuery('');
          }

          e.preventDefault();
        }
      } else if (e.key.length === 1) { // Touche de caractère imprimable
        pushWedgeKey(burst, e.key, timeDiff, maxGap);
      }

      lastKeyTime.current = now;

      // Réinitialiser le buffer si aucun caractère n'est reçu pendant 200ms
      timeoutRef.current = setTimeout(() => {
        resetWedgeBurst(burst);
      }, WEDGE_IDLE_MS);
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

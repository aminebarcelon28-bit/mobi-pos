import { useState, useEffect, useRef, useCallback } from 'react';
import { usePosStore } from '../store/usePosStore';
import { soundEngine } from '../utils/audioFeedback';

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

    const store = usePosStore.getState();
    const activeModal = store.activeModal;

    // Guard: If editor or label printer is open, only expose lastScannedCode for barcode field auto-fill
    if (activeModal === 'product_editor' || activeModal === 'label_printer') {
      setLastScannedCode(code);
      soundEngine.playScan();
      return;
    }

    // Guard: If any other modal is open (e.g. payment, settings, security audit, pin prompt, reports, refund), ignore scan
    if (activeModal !== null) {
      return;
    }

    setScannerActive(true);

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

    const products = store.products || [];
    const bundles = store.bundles || [];
    const customers = store.customers || [];
    
    const cleanCode = effectiveCode.toUpperCase().replace(/[^A-Z0-9]/g, '');

    // Check if code matches a Customer Loyalty Card Barcode (PVC / Digital Pass)
    const customerMatch = customers.find(c => {
      const cleanId = c.id.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const cleanPhone = (c.phone || '').replace(/[^0-9]/g, '');
      const rawPhone = (c.phone || '').trim();
      const cardCode = (c.loyaltyCardCode || '').toUpperCase().trim();
      const barcode = (c.barcode || '').toUpperCase().trim();

      return (
        c.id === effectiveCode ||
        c.id.toUpperCase() === effectiveCode.toUpperCase() ||
        rawPhone === effectiveCode ||
        cleanPhone === effectiveCode ||
        cardCode === effectiveCode.toUpperCase() ||
        barcode === effectiveCode.toUpperCase() ||
        `LOY-${c.id.toUpperCase()}` === effectiveCode.toUpperCase() ||
        `LOYALTY-${c.id.toUpperCase()}` === effectiveCode.toUpperCase() ||
        `CUST-${c.id.toUpperCase()}` === effectiveCode.toUpperCase() ||
        (cleanCode.length >= 3 && cleanCode.includes(cleanId))
      );
    });

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
      const productMatch = products.find(p => p.barcode === effectiveCode || p.sku === effectiveCode || p.id === effectiveCode);
      if (productMatch) {
        soundEngine.playScan();
        store.addToCart(productMatch, false, multiplier);
        setLastScannedCode(null);
      } else {
        const bundleMatch = bundles.find(b => b.barcode === effectiveCode || b.id === effectiveCode);
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
        if (buffer.current.length >= 5) {
          // Code-barres valide détecté (5+ caractères)
          processScan(buffer.current);
          
          if (!isInputFocused) {
            e.preventDefault();
          }
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

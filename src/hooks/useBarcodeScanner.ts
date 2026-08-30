import { useState, useEffect, useRef, useCallback } from 'react';
import { usePosStore } from '../store/usePosStore';

/**
 * Hook global pour détecter la saisie d'un lecteur de code-barres USB (HID).
 * 
 * Algorithme de détection :
 * - Les douchettes USB simulent un clavier.
 * - Le délai entre deux touches est très court (< 30ms).
 * - La saisie se termine toujours par la touche Entrée (keyCode 13).
 * - On ignore les saisies lentes humaines (> 50ms) pour ne pas interférer avec la saisie normale au clavier.
 */
function playScannerBeep(isSuccess: boolean = true) {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(isSuccess ? 1046.5 : 300, ctx.currentTime); // High C pitch for scan beep
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
  } catch {
    // Ignore audio autoplay restrictions
  }
}

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

    // Guard: Ignore scanner if an unrelated modal is open (e.g. settings, security audit, pin prompt, reports)
    if (activeModal && activeModal !== 'payment' && activeModal !== 'product_editor' && activeModal !== 'label_printer') {
      return;
    }

    setScannerActive(true);
    playScannerBeep(true);
    
    const products = store.products || [];
    const bundles = store.bundles || [];
    const customers = store.customers || [];
    
    const cleanCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '');

    // Check if code matches a Customer Loyalty Card Barcode (PVC / Digital Pass)
    const customerMatch = customers.find(c => {
      const cleanId = c.id.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const cleanPhone = (c.phone || '').replace(/[^0-9]/g, '');
      const rawPhone = (c.phone || '').trim();
      const cardCode = (c.loyaltyCardCode || '').toUpperCase().trim();
      const barcode = (c.barcode || '').toUpperCase().trim();

      return (
        c.id === code ||
        c.id.toUpperCase() === code.toUpperCase() ||
        rawPhone === code ||
        cleanPhone === code ||
        cardCode === code.toUpperCase() ||
        barcode === code.toUpperCase() ||
        `LOY-${c.id.toUpperCase()}` === code.toUpperCase() ||
        `LOYALTY-${c.id.toUpperCase()}` === code.toUpperCase() ||
        `CUST-${c.id.toUpperCase()}` === code.toUpperCase() ||
        (cleanCode.length >= 3 && cleanCode.includes(cleanId))
      );
    });

    if (customerMatch) {
      store.setCurrentCustomer(customerMatch);
      store.logSecurityAction(
        `Identification Carte PVC Scannée: ${customerMatch.name}`,
        `Code Scanné: ${code} - Avoir Client: ${customerMatch.storeCredit} DA - Points: ${customerMatch.loyaltyPoints}`,
        'Lecteur Code-barres USB HID',
        true
      );
      setLastScannedCode(null);
    } else {
      const productMatch = products.find(p => p.barcode === code || p.sku === code || p.id === code);
      if (productMatch) {
        store.addToCart(productMatch);
        setLastScannedCode(null);
      } else {
        const bundleMatch = bundles.find(b => b.barcode === code || b.id === code);
        if (bundleMatch) {
          store.addBundleToCart(bundleMatch.id);
          setLastScannedCode(null);
        } else {
          setLastScannedCode(code);
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

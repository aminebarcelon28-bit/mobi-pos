/**
 * Automated Simulation of Physical USB Barcode Scanner (Douchette HID)
 * 
 * Verifies:
 * 1. Physical Keystroke Inter-Arrival Timing (Hardware 8ms vs Human 120ms)
 * 2. Rapid Keystroke Buffering & Enter Termination
 * 3. Multiplier Syntax (e.g. 5*CODE, 10xCODE)
 * 4. AIM Symbology Prefix Stripping (]C1, ]E0, ]d2)
 * 5. Optical Bounce / Rapid Laser Reflection Debounce (400ms threshold)
 * 6. Customer PVC Loyalty Card Detection (Phone, LOY-xxx, CUST-xxx)
 * 7. Product & Bundle Barcode Matching (Case-insensitive & whitespace trimmed)
 * 8. Search Input Focus Auto-Clearing & Blur
 * 9. Modal Awareness (Payment voucher routing & Product Editor auto-fill)
 */

let passedCount = 0;
let failedCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`[PASS] ${message}`);
    passedCount++;
  } else {
    console.error(`[FAIL] ${message}`);
    failedCount++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Hardware Scanner Engine Simulator
// ─────────────────────────────────────────────────────────────────────────────
class MockBarcodeScannerEngine {
  constructor(initialState = {}) {
    this.buffer = '';
    this.lastKeyTime = 0;
    this.lastScanTimestamp = 0;
    this.lastScanCode = '';
    this.scannerActive = false;
    this.lastScannedCode = null;
    this.dispatchedEvents = [];
    
    // POS State
    this.products = initialState.products || [];
    this.bundles = initialState.bundles || [];
    this.customers = initialState.customers || [];
    this.activeModal = initialState.activeModal || null;
    this.cart = [];
    this.currentCustomer = null;
    this.securityLogs = [];
    this.searchQuery = initialState.searchQuery || '';
  }

  processScan(rawCode, currentTime = Date.now()) {
    const code = rawCode.trim();
    if (!code) return;

    // Debounce rapid duplicate scans within 400ms (optical laser reflection guard)
    if (code === this.lastScanCode && currentTime - this.lastScanTimestamp < 400) {
      return;
    }
    this.lastScanCode = code;
    this.lastScanTimestamp = currentTime;

    // Guard: Product Editor Modal -> auto-fill barcode
    if (this.activeModal === 'product_editor' || this.activeModal === 'label_printer') {
      this.lastScannedCode = code;
      this.dispatchedEvents.push({ type: 'pos:barcode-scanned', code });
      return;
    }

    // Guard: Payment Modal -> dispatch voucher scan
    if (this.activeModal === 'payment') {
      this.dispatchedEvents.push({ type: 'pos:payment-voucher-scanned', code });
      return;
    }

    // Guard: Other sensitive modals (pin, reports, refund, etc.) -> ignore
    if (this.activeModal !== null) {
      return;
    }

    this.scannerActive = true;

    // 1. Parse multiplier (e.g. 5*BARCODE, 12xBARCODE)
    let multiplier = 1;
    let effectiveCode = code;
    const multiplierMatch = code.match(/^(\d{1,3})\s*[*xX]\s*(.+)$/);
    if (multiplierMatch && multiplierMatch[1] && multiplierMatch[2]) {
      multiplier = Math.max(1, parseInt(multiplierMatch[1], 10));
      effectiveCode = multiplierMatch[2].trim();
    }

    // 2. Strip AIM symbology prefix (e.g. "]C1", "]E0", "]d2")
    effectiveCode = effectiveCode.replace(/^\][A-Za-z0-9]{2}/, '');

    const cleanCode = effectiveCode.toUpperCase().replace(/[^A-Z0-9]/g, '');

    // 3. Customer Loyalty Card Scan Check
    const customerMatch = this.customers.find(c => {
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
      this.currentCustomer = customerMatch;
      this.securityLogs.push(`Customer identified: ${customerMatch.name}`);
      this.lastScannedCode = null;
      return;
    }

    // 4. Product Matching (Trimmed, case-insensitive)
    const targetCode = effectiveCode.trim().toLowerCase();
    const productMatch = this.products.find(p =>
      (p.barcode && p.barcode.trim().toLowerCase() === targetCode) ||
      (p.sku && p.sku.trim().toLowerCase() === targetCode) ||
      (p.id && p.id.trim().toLowerCase() === targetCode)
    );

    if (productMatch) {
      const existing = this.cart.find(item => item.product.id === productMatch.id);
      if (existing) {
        existing.quantity += multiplier;
      } else {
        this.cart.push({ product: productMatch, quantity: multiplier });
      }
      this.lastScannedCode = null;
      return;
    }

    // 5. Bundle Matching
    const bundleMatch = this.bundles.find(b =>
      (b.barcode && b.barcode.trim().toLowerCase() === targetCode) ||
      (b.id && b.id.trim().toLowerCase() === targetCode)
    );

    if (bundleMatch) {
      this.cart.push({ bundle: bundleMatch, quantity: multiplier });
      this.lastScannedCode = null;
      return;
    }

    // 6. Unrecognized
    this.lastScannedCode = effectiveCode;
  }

  /**
   * Simulate a physical keystroke arrival from USB keyboard or Human typist
   */
  simulateKeyPress(key, timestamp, isInputFocused = false, inputElement = null) {
    const timeDiff = timestamp - this.lastKeyTime;

    if (key === 'Enter') {
      if (this.buffer.length >= 3) {
        this.processScan(this.buffer, timestamp);

        if (isInputFocused && inputElement) {
          if (inputElement.isSearchBar) {
            inputElement.value = '';
            this.searchQuery = '';
          }
        }
      }
      this.buffer = '';
    } else if (key.length === 1) {
      // If timeDiff > 50ms, human typing resets buffer
      if (timeDiff > 50 && this.buffer.length > 0) {
        this.buffer = key;
      } else {
        this.buffer += key;
      }
    }

    this.lastKeyTime = timestamp;
  }

  /**
   * Simulate a burst of keystrokes as emitted by a physical barcode scanner
   * Default scanner inter-keystroke interval = 10ms
   */
  simulateScannerBurst(barcodeString, startTime = Date.now(), intervalMs = 10, isInputFocused = false, inputElement = null) {
    let t = startTime;
    for (const char of barcodeString) {
      this.simulateKeyPress(char, t, isInputFocused, inputElement);
      t += intervalMs;
    }
    this.simulateKeyPress('Enter', t, isInputFocused, inputElement);
    return t;
  }

  /**
   * Simulate human typing at 120ms intervals
   */
  simulateHumanTyping(textString, startTime = Date.now(), intervalMs = 120, isInputFocused = true, inputElement = null) {
    let t = startTime;
    for (const char of textString) {
      this.simulateKeyPress(char, t, isInputFocused, inputElement);
      t += intervalMs;
    }
    this.simulateKeyPress('Enter', t, isInputFocused, inputElement);
    return t;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. RUN TEST SUITE
// ─────────────────────────────────────────────────────────────────────────────
console.log('====================================================');
console.log('STARTING USB BARCODE SCANNER (DOUCHETTE) HARDWARE TESTS');
console.log('====================================================\n');

const testCatalog = [
  { id: 'prod_1', title: 'Coque Silicone iPhone 15', barcode: '6138318449885', sku: 'COQ-IP15-BLK', price: 3500 },
  { id: 'prod_2', title: 'Chargeur Rapide 25W Samsung', barcode: '8806091234567', sku: 'CHG-SAM-25W', price: 2800 },
  { id: 'prod_3', title: 'Verre Trempé 9H Universel', barcode: '999', sku: 'VT-999', price: 500 },
];

const testBundles = [
  { id: 'bundle_1', title: 'Pack Protection iPhone (Coque + Verre)', barcode: 'BND-IP15-FULL' }
];

const testCustomers = [
  { id: 'cust_101', name: 'Karim Bouzid', phone: '0555123456', loyaltyCardCode: 'LOY-KB101', barcode: 'CARD-KB-101', storeCredit: 1500, loyaltyPoints: 340 }
];

// TEST 1: Rapid 10ms USB Scanner Burst -> Successfully added to cart
{
  const sim = new MockBarcodeScannerEngine({ products: testCatalog });
  sim.simulateScannerBurst('6138318449885');
  assert(sim.cart.length === 1, 'Single item scan: Item added to cart');
  assert(sim.cart[0].product.id === 'prod_1', 'Single item scan: Correct product resolved (iPhone 15 Case)');
  assert(sim.cart[0].quantity === 1, 'Single item scan: Quantity is 1');
}

// TEST 2: Slow Human Typing (120ms) -> Ignored by scanner engine
{
  const sim = new MockBarcodeScannerEngine({ products: testCatalog });
  sim.simulateHumanTyping('6138318449885');
  assert(sim.cart.length === 0, 'Human typing detection: Slow keystrokes (>50ms) do NOT add to cart');
}

// TEST 3: Multiplier syntax "5*BARCODE"
{
  const sim = new MockBarcodeScannerEngine({ products: testCatalog });
  sim.simulateScannerBurst('5*6138318449885');
  assert(sim.cart.length === 1 && sim.cart[0].quantity === 5, 'Multiplier 5*: 5 units added to cart at once');
}

// TEST 4: Multiplier syntax "12xBARCODE"
{
  const sim = new MockBarcodeScannerEngine({ products: testCatalog });
  sim.simulateScannerBurst('12x8806091234567');
  assert(sim.cart.length === 1 && sim.cart[0].quantity === 12, 'Multiplier 12x: 12 units added to cart at once');
}

// TEST 5: Short Barcode / SKU support (3 characters)
{
  const sim = new MockBarcodeScannerEngine({ products: testCatalog });
  sim.simulateScannerBurst('999');
  assert(sim.cart.length === 1 && sim.cart[0].product.id === 'prod_3', 'Short barcode (3 chars): Accepted and added to cart');
}

// TEST 6: Accidental 1-2 character keypress + Enter -> Ignored
{
  const sim = new MockBarcodeScannerEngine({ products: testCatalog });
  sim.simulateScannerBurst('12');
  assert(sim.cart.length === 0, 'Accidental short keypress (2 chars): Dropped, cart untouched');
}

// TEST 7: AIM Symbology Prefix Stripping (]C1 for Code 128, ]E0 for EAN-13)
{
  const sim = new MockBarcodeScannerEngine({ products: testCatalog });
  sim.simulateScannerBurst(']E06138318449885');
  assert(sim.cart.length === 1 && sim.cart[0].product.id === 'prod_1', 'AIM prefix ]E0 stripped: Matched EAN-13 cleanly');

  const sim2 = new MockBarcodeScannerEngine({ products: testCatalog });
  sim2.simulateScannerBurst(']C1COQ-IP15-BLK');
  assert(sim2.cart.length === 1 && sim2.cart[0].product.id === 'prod_1', 'AIM prefix ]C1 stripped: Matched SKU cleanly');
}

// TEST 8: Laser Bounce Debounce Guard (< 400ms duplicate scan)
{
  const sim = new MockBarcodeScannerEngine({ products: testCatalog });
  const t1 = 1000;
  sim.simulateScannerBurst('6138318449885', t1);
  // Optical bounce 150ms later:
  sim.simulateScannerBurst('6138318449885', t1 + 150);
  assert(sim.cart[0].quantity === 1, 'Laser reflection debounce: 2nd scan within 150ms ignored');

  // Intentional second scan 600ms later:
  sim.simulateScannerBurst('6138318449885', t1 + 600);
  assert(sim.cart[0].quantity === 2, 'Laser reflection debounce: 2nd scan after 600ms incremented quantity to 2');
}

// TEST 9: Customer PVC Loyalty Card Detection via Phone
{
  const sim = new MockBarcodeScannerEngine({ customers: testCustomers });
  sim.simulateScannerBurst('0555123456');
  assert(sim.currentCustomer && sim.currentCustomer.id === 'cust_101', 'Customer PVC Scan (Phone): Customer Karim Bouzid identified');
  assert(sim.securityLogs.length === 1, 'Customer PVC Scan: Security audit log entry created');
}

// TEST 10: Customer PVC Loyalty Card Detection via Card Code
{
  const sim = new MockBarcodeScannerEngine({ customers: testCustomers });
  sim.simulateScannerBurst('LOY-KB101');
  assert(sim.currentCustomer && sim.currentCustomer.id === 'cust_101', 'Customer PVC Scan (LOY-xxx): Customer identified');
}

// TEST 11: Bundle Barcode Scan
{
  const sim = new MockBarcodeScannerEngine({ bundles: testBundles });
  sim.simulateScannerBurst('BND-IP15-FULL');
  assert(sim.cart.length === 1 && sim.cart[0].bundle.id === 'bundle_1', 'Bundle scan: Pack Protection added to cart');
}

// TEST 12: Search Bar Focused when Scanning -> Clears search bar & blurs
{
  const sim = new MockBarcodeScannerEngine({ products: testCatalog, searchQuery: 'old_text' });
  const searchInputMock = { isSearchBar: true, value: '6138318449885' };
  sim.simulateScannerBurst('6138318449885', Date.now(), 10, true, searchInputMock);
  assert(sim.cart.length === 1, 'Scan with search focused: Product added to cart');
  assert(searchInputMock.value === '', 'Scan with search focused: Search bar input cleared');
  assert(sim.searchQuery === '', 'Scan with search focused: Global searchQuery reset');
}

// TEST 13: Product Editor Modal Open -> Auto-fills barcode field without adding to cart
{
  const sim = new MockBarcodeScannerEngine({ products: testCatalog, activeModal: 'product_editor' });
  sim.simulateScannerBurst('6138318449885');
  assert(sim.cart.length === 0, 'Product editor active: Cart NOT modified');
  assert(sim.lastScannedCode === '6138318449885', 'Product editor active: lastScannedCode populated for auto-fill');
  assert(sim.dispatchedEvents.some(e => e.type === 'pos:barcode-scanned' && e.code === '6138318449885'), 'Product editor active: pos:barcode-scanned event dispatched');
}

// TEST 14: Payment Modal Open -> Routes voucher scan
{
  const sim = new MockBarcodeScannerEngine({ activeModal: 'payment' });
  sim.simulateScannerBurst('AV-789012');
  assert(sim.cart.length === 0, 'Payment modal active: Cart untouched');
  assert(sim.dispatchedEvents.some(e => e.type === 'pos:payment-voucher-scanned' && e.code === 'AV-789012'), 'Payment modal active: pos:payment-voucher-scanned event dispatched for voucher redemption');
}

// TEST 15: Sensitive Admin PIN Modal Open -> Drops barcode scan
{
  const sim = new MockBarcodeScannerEngine({ products: testCatalog, activeModal: 'pin_prompt' });
  sim.simulateScannerBurst('6138318449885');
  assert(sim.cart.length === 0, 'Security PIN modal active: Barcode scan completely blocked');
}

// TEST 16: Case-insensitivity and Whitespace Trimming
{
  const sim = new MockBarcodeScannerEngine({ products: testCatalog });
  sim.simulateScannerBurst('  coq-ip15-blk  ');
  assert(sim.cart.length === 1 && sim.cart[0].product.id === 'prod_1', 'Case-insensitive & whitespace trimmed SKU scan: Successfully added');
}

console.log('\n====================================================');
console.log(`SCANNER TEST SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
console.log('====================================================');

if (failedCount > 0) {
  process.exit(1);
}


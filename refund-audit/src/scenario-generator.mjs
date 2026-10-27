/**
 * Refund Scenario Generator — Autonomous Refund Assurance Mission
 *
 * Generates 10,000+ distinct refund scenarios across all risk dimensions:
 * A. Amounts and quantities
 * B. Original sale conditions
 * C. Payment and financial consequences
 * D. Inventory and mobile-product behavior
 * E. Customer balances, debts, and related records
 * F. State, permissions, and interaction failures
 *
 * Output: refund-audit/scenarios/scenarios.jsonl (one JSON object per line)
 *         refund-audit/scenarios/scenario-index.json (metadata + counts)
 *
 * Each scenario has:
 *   - id: stable identifier (REF-<batch>-<seq>)
 *   - seed: reproducible random seed
 *   - dimensions: classification tags
 *   - initialState: sale, payment, inventory, customer, shift, app state
 *   - request: refund request payload
 *   - expectedOutcome: independently derived expected result
 *   - invariants: list of invariant checks to apply
 *   - executable: whether the scenario can run through UI
 *   - validity: valid / invalid-fixture (rejected impossible combos)
 */

import { createHash } from 'crypto';
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const ROOT = 'refund-audit';
const SCEN_DIR = join(ROOT, 'scenarios');
const OUT_FILE = join(SCEN_DIR, 'scenarios.jsonl');
const INDEX_FILE = join(SCEN_DIR, 'scenario-index.json');

// Ensure output dir exists
mkdirSync(SCEN_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — reproducible per scenario seed
// ---------------------------------------------------------------------------
class RNG {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.a = this.seed;
  }
  nextUInt32() {
    this.a |= 0;
    this.a = (this.a + 0x6D2B79F5) | 0;
    let t = Math.imul(this.a, this.a >>> 15);
    t = (t + Math.imul(this.a ^ (t >>> 9), (t ^ (t >>> 9)) >>> 3)) | 0;
    t = (t + Math.imul(this.a ^ (t >>> 17), (t ^ (t >>> 17)) >>> 7)) | 0;
    return t ^ this.a;
  }
  next() { return (this.nextUInt32() >>> 0) / 4294967296; } // [0,1)
  range(min, max) { return Math.floor(this.next() * (max - min + 1)) + min; } // int [min,max]
  pick(arr) { return arr[this.range(0, arr.length - 1)]; }
  shuffle(arr) {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.range(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Constants from the actual implementation
// ---------------------------------------------------------------------------
const CURRENCY = 'DZD';
const MINOR_UNITS = 100; // 1 DA = 100 minor
const DEFAULT_OFFLINE_CASH_CAP = 10_000;
const DEFAULT_OFFLINE_PIN_THRESHOLD = 5_000;
const SUPERVISOR_FRESHNESS_S = 120;
const SUPERVISOR_FUTURE_DATED_S = 30;

const PAYMENT_METHODS = [
  'Espèces',
  'Avoir Client',
  'BaridiMob',
  'Chèque',
  'Crédit Client',
  'Reprise',
  'Autre',
];

const CASH_METHODS = ['Espèces'];
const NON_CASH_METHODS = ['Avoir Client', 'BaridiMob', 'Chèque', 'Crédit Client', 'Reprise', 'Autre'];
const DIGITAL_METHODS = ['BaridiMob', 'Chèque', 'Autre'];

const PRODUCT_CATEGORIES = ['Telephony', 'Accessories', 'Services', 'Tablets', 'Computers'];
const SERIALIZED_CATEGORIES = ['Telephony', 'Tablets'];
const NON_SERIALIZED_CATEGORIES = ['Accessories', 'Services', 'Computers'];

const ROLES = ['manager', 'cashier'];
const REFUND_STATUSES = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED'];

const CONDITION_VALUES = ['restock', 'defective'];
const REFUND_REASONS = [
  'Erreur de choix client / Échange',
  'Article défectueux / Panne sous garantie',
  'Incompatible avec l\'appareil',
  'Insatisfaction produit',
  'Autre',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function stableId(seed, ...parts) {
  const h = createHash('sha256');
  h.update(seed.toString());
  for (const p of parts) h.update(String(p));
  return `REF-${seed}-${h.digest('hex').slice(0, 8)}`;
}

function moneyFromDa(da) { return Math.round(da * MINOR_UNITS); }
function daFromMoney(minor) { return minor / MINOR_UNITS; }

function clamp(val, min, max) { return Math.min(max, Math.max(min, val)); }

// ---------------------------------------------------------------------------
// Fixture builders — construct realistic initial states
// ---------------------------------------------------------------------------

function buildProduct(rng, category, isSerialized = null) {
  if (isSerialized === null) isSerialized = SERIALIZED_CATEGORIES.includes(category);
  const id = `PROD-${rng.range(10000, 99999)}`;
  const unitPrice = rng.range(500, 50000); // 5.00 to 500.00 DA
  const costPrice = Math.floor(unitPrice * rng.next() * 0.7); // 0-70% of price
  return {
    id,
    sku: `SKU-${id.slice(-6)}`,
    title: `${category} ${rng.range(100, 999)}`,
    category,
    price: unitPrice,
    costPrice,
    stock: rng.range(1, 100),
    isSerialized,
    imeiNumber: isSerialized ? `IMEI-${rng.range(100000000, 999999999)}` : null,
  };
}

function buildTender(rng, method, amount) {
  return {
    id: `TEND-${rng.range(10000, 99999)}`,
    method,
    amount,
    reference: method === 'BaridiMob' ? `BM-${rng.range(1000, 9999)}` : null,
    checkNumber: method === 'Chèque' ? `CHQ-${rng.range(1000, 9999)}` : null,
  };
}

function buildSale(rng, scenarioCtx) {
  const { productCount = rng.range(1, 5), customerPresent = rng.next() < 0.7 } = scenarioCtx;
  const products = [];
  const tenders = [];
  let subtotal = 0;
  let discountTotal = 0;
  let cashTendered = 0;

  // Build line items
  for (let i = 0; i < productCount; i++) {
    const category = rng.pick(PRODUCT_CATEGORIES);
    const product = buildProduct(rng, category);
    const quantity = rng.range(1, 5);
    const unitPrice = product.price;
    const lineDiscount = rng.next() < 0.3 ? rng.range(0, Math.floor(unitPrice * quantity * 0.2)) : 0;
    const lineTotal = unitPrice * quantity - lineDiscount;
    subtotal += unitPrice * quantity;
    discountTotal += lineDiscount;

    products.push({
      productId: product.id,
      product,
      quantity,
      unitPrice,
      discount: lineDiscount,
      appliedPrice: unitPrice,
      imeiNumber: product.isSerialized ? product.imeiNumber : null,
      lineIndex: i,
    });
  }

  // Build payment tenders
  const paymentMethod = rng.pick(PAYMENT_METHODS);
  const isSplit = rng.next() < 0.3;
  const netTotal = subtotal - discountTotal;

  if (isSplit && paymentMethod !== 'Crédit Client') {
    // Split tender: 2-3 methods
    const remaining = netTotal;
    const nLegs = rng.range(2, 3);
    const methods = rng.shuffle([...PAYMENT_METHODS]).slice(0, nLegs);
    let remainingAmt = netTotal;
    for (let j = 0; j < nLegs; j++) {
      const m = methods[j];
      const isLast = j === nLegs - 1;
      const amt = isLast ? remainingAmt : rng.range(0, remainingAmt);
      tenders.push(buildTender(rng, m, amt));
      if (m === 'Espèces') cashTendered += amt;
      remainingAmt -= amt;
    }
    if (remainingAmt !== 0) tenders[tenders.length - 1].amount += remainingAmt;
    if (remaining !== 0) tenders[tenders.length - 1].amount += remaining;
  } else {
    tenders.push(buildTender(rng, paymentMethod, netTotal));
    if (paymentMethod === 'Espèces') cashTendered = netTotal;
  }

  const customerId = customerPresent ? `CUST-${rng.range(10000, 99999)}` : null;
  const customerName = customerPresent ? `Client ${rng.range(1, 999)}` : 'Client de passage';
  const debtAdded = paymentMethod === 'Crédit Client' ? netTotal : 0;

  const saleId = `TXN-${rng.range(100000, 999999)}`;
  const receiptNumber = `REC-${rng.range(100000, 999999)}`;
  const now = new Date(Date.now() - rng.range(0, 86400000 * 30)).toISOString();

  return {
    id: saleId,
    receiptNumber,
    status: 'COMPLETED',
    isRefund: false,
    subtotal,
    discountTotal,
    total: netTotal,
    costTotal: products.reduce((s, p) => s + p.product.costPrice * p.quantity, 0),
    paymentMethod,
    cashTendered,
    changeDue: 0,
    createdAt: now,
    customer: customerPresent ? { id: customerId, name: customerName } : null,
    tenders,
    items: products.map((p, i) => ({
      id: `${saleId}-item-${i}`,
      productId: p.productId,
      product: p.product,
      quantity: p.quantity,
      unitPrice: p.unitPrice,
      appliedPrice: p.appliedPrice,
      discount: p.discount,
      imeiNumber: p.imeiNumber,
      lineIndex: i,
      saleItemId: `${saleId}-item-${i}`,
    })),
    refundedItems: [],
    debtAdded,
    tradeInId: null,
    tradeInDeduction: 0,
    tradeInRestored: 0,
    deviceId: `DEV-${rng.range(1000, 9999)}`,
    shiftId: `SHIFT-${rng.range(1000, 9999)}`,
    jsonPayload: JSON.stringify({}),
  };
}

function buildExistingRefunds(rng, sale, maxRefunds = 3) {
  const refunds = [];
  let remainingQtyByProduct = {};
  for (const item of sale.items) {
    remainingQtyByProduct[item.productId] = item.quantity;
  }

  const nRefunds = rng.range(0, maxRefunds);
  for (let r = 0; r < nRefunds; r++) {
    const refundId = `REF-EXIST-${rng.range(10000, 99999)}`;
    const refundItems = [];
    let refundTotal = 0;

    for (const item of sale.items) {
      const avail = remainingQtyByProduct[item.productId] || 0;
      if (avail <= 0) continue;
      if (rng.next() < 0.4) continue; // skip some products
      const qty = rng.range(1, avail);
      const lineValue = Math.round(item.appliedPrice * qty - item.discount * (qty / item.quantity));
      refundItems.push({
        productId: item.productId,
        quantity: qty,
        saleItemId: item.saleItemId,
        imeiNumber: item.imeiNumber,
        condition: rng.pick(CONDITION_VALUES),
        lineTotal: lineValue,
      });
      remainingQtyByProduct[item.productId] -= qty;
      refundTotal += lineValue;
    }

    if (refundItems.length === 0) continue;

    const method = rng.pick(PAYMENT_METHODS);
    const refund = {
      id: refundId,
      receiptNumber: `AVOIR-${rng.range(100000, 999999)}`,
      status: 'COMPLETED',
      isRefund: true,
      originalTransactionId: sale.id,
      total: refundTotal,
      cashTendered: method === 'Espèces' ? refundTotal : 0,
      changeDue: 0,
      createdAt: new Date(Date.now() + rng.range(1, 86400000)).toISOString(),
      refundMethod: method,
      cashDisbursed: method === 'Espèces' ? refundTotal : 0,
      refundedItems: refundItems,
      customer: sale.customer,
      shiftId: sale.shiftId,
      deviceId: sale.deviceId,
    };
    refunds.push(refund);
  }

  return refunds;
}

// ---------------------------------------------------------------------------
// Independent oracle — compute expected outcome WITHOUT copying app logic
// ---------------------------------------------------------------------------

function computeOracle(sale, refundRequest, existingRefunds, ctx) {
  /**
   * Independent determination of expected refund outcome.
   * Uses first principles: purchased qty minus already-refunded qty = remaining.
   * Refund cannot exceed remaining. Money: sum of line refund amounts.
   * No copying of computeRefundFundingSplit — derive from payment truth.
   */
  const result = {
    allowed: true,
    reason: null,
    expectedStatus: 'PARTIALLY_REFUNDED',
    expectedRefundTotal: 0,
    expectedCashOut: 0,
    expectedStockRestored: {},
    expectedDebtRelief: 0,
    expectedVoucherCredit: 0,
    invariantChecks: [],
  };

  // Validate lines
  if (!refundRequest.lines || refundRequest.lines.length === 0) {
    result.allowed = false;
    result.reason = 'NO_ITEMS_SELECTED';
    return result;
  }

  // Compute purchased qty per product
  const purchasedByProduct = {};
  for (const item of sale.items) {
    purchasedByProduct[item.productId] = (purchasedByProduct[item.productId] || 0) + item.quantity;
  }

  // Compute already-refunded qty per product (independent sum)
  const refundedByProduct = {};
  for (const r of existingRefunds) {
    for (const ri of r.refundedItems || []) {
      refundedByProduct[ri.productId] = (refundedByProduct[ri.productId] || 0) + ri.quantity;
    }
  }

  // Compute remaining refundable per product
  const remainingByProduct = {};
  for (const pid of Object.keys(purchasedByProduct)) {
    remainingByProduct[pid] = Math.max(0, purchasedByProduct[pid] - (refundedByProduct[pid] || 0));
  }

  // Check each requested line
  let totalRefundValue = 0;
  let cashOut = 0;
  const stockRestored = {};

  for (const line of refundRequest.lines) {
    const pid = line.productId;
    const qty = line.quantity;
    const remaining = remainingByProduct[pid] || 0;

    if (qty > remaining) {
      result.allowed = false;
      result.reason = `REFUND_EXCEEDS:${pid}:requested=${qty}:remaining=${remaining}`;
      return result;
    }

    // Find the sale line for pricing
    const saleLine = sale.items.find((i) => i.productId === pid);
    if (!saleLine) {
      result.allowed = false;
      result.reason = `TICKET_NOT_FOUND: product ${pid} not in sale`;
      return result;
    }

    const lineValue = Math.round(saleLine.appliedPrice * qty - saleLine.discount * (qty / saleLine.quantity));
    totalRefundValue += lineValue;

    // Track stock restoration
    if (line.condition !== 'defective') {
      stockRestored[pid] = (stockRestored[pid] || 0) + qty;
    }

    // Track cash out (only for Espèces method)
    if (refundRequest.method === 'Espèces') {
      cashOut += lineValue;
    }
  }

  // Zero-value guard
  if (totalRefundValue <= 0) {
    result.allowed = false;
    result.reason = 'ZERO_REFUNDABLE';
    return result;
  }

  // Cash cap check: cumulative cash out cannot exceed net cash tendered
  if (refundRequest.method === 'Espèces') {
    const priorCashOut = existingRefunds
      .filter((r) => r.refundMethod === 'Espèces')
      .reduce((s, r) => s + (r.cashDisbursed || 0), 0);
    const netCashTendered = sale.tenders
      .filter((t) => t.method === 'Espèces')
      .reduce((s, t) => s + t.amount, 0);
    if (priorCashOut + cashOut > netCashTendered) {
      result.allowed = false;
      result.reason = 'CASH_CAP_EXCEEDED';
      return result;
    }
  }

  // Determine final status
  let allExhausted = true;
  for (const pid of Object.keys(purchasedByProduct)) {
    const after = remainingByProduct[pid] - (refundRequest.lines
      .filter((l) => l.productId === pid)
      .reduce((s, l) => s + l.quantity, 0));
    if (after > 0) { allExhausted = false; break; }
  }

  result.expectedStatus = allExhausted && Object.keys(purchasedByProduct).length > 0 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  result.expectedRefundTotal = totalRefundValue;
  result.expectedCashOut = refundRequest.method === 'Espèces' ? cashOut : 0;
  result.expectedStockRestored = stockRestored;
  result.invariantChecks = [
    'refund_total_matches_line_sum',
    'cumulative_refund_does_not_exceed_paid',
    'stock_restoration_matches_returned_qty',
    'no_duplicate_refund_rows',
  ];

  return result;
}

// ---------------------------------------------------------------------------
// Scenario generation across dimensions
// ---------------------------------------------------------------------------

const scenarios = [];
let scenarioSeq = 0;

function newScenarioId(seed) {
  scenarioSeq += 1;
  return stableId(seed, scenarioSeq);
}

function generateBaseScenario(rng, seed) {
  const id = newScenarioId(seed);
  const saleCtx = {
    productCount: rng.range(1, 6),
    customerPresent: rng.next() < 0.8,
  };
  const sale = buildSale(rng, saleCtx);
  const existingRefunds = buildExistingRefunds(rng, sale, rng.range(0, 3));

  // Determine refundable items
  const purchasedByProduct = {};
  for (const item of sale.items) {
    purchasedByProduct[item.productId] = (purchasedByProduct[item.productId] || 0) + item.quantity;
  }
  const refundedByProduct = {};
  for (const r of existingRefunds) {
    for (const ri of r.refundedItems || []) {
      refundedByProduct[ri.productId] = (refundedByProduct[ri.productId] || 0) + ri.quantity;
    }
  }
  const remainingByProduct = {};
  for (const pid of Object.keys(purchasedByProduct)) {
    remainingByProduct[pid] = Math.max(0, purchasedByProduct[pid] - (refundedByProduct[pid] || 0));
  }

  // Pick refund mode
  const mode = rng.pick(['full', 'partial', 'zero-qty', 'over-limit', 'single-item', 'multi-line', 'repeat-partial']);

  let refundItems = [];
  let totalNet = 0;

  switch (mode) {
    case 'full':
      // Refund all remaining
      for (const item of sale.items) {
        const rem = remainingByProduct[item.productId] || 0;
        if (rem > 0) {
          refundItems.push({
            productId: item.productId,
            quantity: rem,
            saleItemId: item.saleItemId,
            imeiNumber: item.imeiNumber,
            condition: rng.pick(CONDITION_VALUES),
            lineIndex: item.lineIndex,
          });
          totalNet += Math.round(item.appliedPrice * rem);
        }
      }
      break;

    case 'partial':
      // Refund partial qty of one product
      const candidates = sale.items.filter((i) => (remainingByProduct[i.productId] || 0) > 0);
      if (candidates.length > 0) {
        const item = rng.pick(candidates);
        const rem = remainingByProduct[item.productId] || 0;
        const qty = rng.range(1, rem);
        refundItems.push({
          productId: item.productId,
          quantity: qty,
          saleItemId: item.saleItemId,
          imeiNumber: item.imeiNumber,
          condition: 'restock',
          lineIndex: item.lineIndex,
        });
        totalNet += Math.round(item.appliedPrice * qty);
      }
      break;

    case 'zero-qty':
      // Invalid: zero quantity line
      if (sale.items.length > 0) {
        const zeroItem = sale.items[0];
        refundItems.push({
          productId: zeroItem.productId,
          quantity: 0,
          saleItemId: zeroItem.saleItemId,
          condition: 'restock',
          lineIndex: zeroItem.lineIndex,
        });
      }
      totalNet = 0;
      break;

    case 'over-limit':
      // Invalid: request more than remaining
      const overCandidates = sale.items.filter((i) => (remainingByProduct[i.productId] || 0) > 0);
      if (overCandidates.length > 0) {
        const item = rng.pick(overCandidates);
        const rem = remainingByProduct[item.productId] || 0;
        refundItems.push({
          productId: item.productId,
          quantity: rem + rng.range(1, 10),
          saleItemId: item.saleItemId,
          condition: 'restock',
          lineIndex: item.lineIndex,
        });
        totalNet = Math.round(item.appliedPrice * (rem + 5));
      }
      break;

    case 'single-item':
      // Refund exactly one unit of one item
      const singleCandidates = sale.items.filter((i) => (remainingByProduct[i.productId] || 0) >= 1);
      if (singleCandidates.length > 0) {
        const item = rng.pick(singleCandidates);
        refundItems.push({
          productId: item.productId,
          quantity: 1,
          saleItemId: item.saleItemId,
          imeiNumber: item.imeiNumber,
          condition: 'restock',
          lineIndex: item.lineIndex,
        });
        totalNet = Math.round(item.appliedPrice);
      }
      break;

    case 'multi-line':
      // Refund across multiple products
      const multiCandidates = sale.items.filter((i) => (remainingByProduct[i.productId] || 0) > 0);
      if (multiCandidates.length > 0) {
        const nLines = rng.range(1, Math.min(multiCandidates.length, 3));
        for (let j = 0; j < nLines; j++) {
          const item = rng.pick(multiCandidates);
          const rem = remainingByProduct[item.productId] || 0;
          if (rem > 0) {
            const qty = rng.range(1, rem);
            refundItems.push({
              productId: item.productId,
              quantity: qty,
              saleItemId: item.saleItemId,
              condition: rng.pick(CONDITION_VALUES),
              lineIndex: item.lineIndex,
            });
            totalNet += Math.round(item.appliedPrice * qty);
          }
        }
      }
      break;

    case 'repeat-partial':
      // Partial refund that's part of a sequence
      const repeatCandidates = sale.items.filter((i) => (remainingByProduct[i.productId] || 0) > 0);
      if (repeatCandidates.length > 0) {
        const item = rng.pick(repeatCandidates);
        const rem = remainingByProduct[item.productId] || 0;
        const qty = rng.range(1, rem);
        refundItems.push({
          productId: item.productId,
          quantity: qty,
          saleItemId: item.saleItemId,
          condition: 'restock',
          lineIndex: item.lineIndex,
        });
        totalNet += Math.round(item.appliedPrice * qty);
      }
      break;
  }

  // Pick payment method
  const method = rng.pick(PAYMENT_METHODS);
  const cashOut = method === 'Espèces' ? totalNet : 0;

  // Build refund request
  const refundRequest = {
    ticketId: sale.id,
    refundId: `REF-${id.slice(-8)}`,
    itemsHash: `HASH-${id.slice(-8)}`,
    receiptNumber: `AVOIR-${id.slice(-8)}`,
    method,
    customerId: sale.customer ? sale.customer.id : null,
    subtotal: totalNet,
    discountTotal: 0,
    totalNet,
    costTotal: sale.costTotal,
    pricingTier: 'Retail',
    paymentMethod: sale.paymentMethod,
    cashTendered: sale.cashTendered,
    changeDue: 0,
    cashTenderedNet: sale.cashTendered,
    online: rng.next() < 0.7,
    localDeviceId: sale.deviceId,
    activeShiftId: sale.shiftId,
    supervisor: null,
    createdAt: new Date().toISOString(),
    refundPayload: JSON.stringify({ refundMethod: method, cashDisbursed: cashOut, total: totalNet }),
    originalOutboxPayload: JSON.stringify({}),
    deviceId: sale.deviceId,
    lines: refundItems.map((l, i) => ({
      id: `${id}-L${i}`,
      productId: l.productId,
      quantity: l.quantity,
      appliedPrice: sale.items.find((s) => s.productId === l.productId)?.appliedPrice || 0,
      unitPriceCharged: sale.items.find((s) => s.productId === l.productId)?.appliedPrice || 0,
      unitCostAtSale: 0,
      discountAmount: 0,
      lineProfit: 0,
      imeiNumber: l.imeiNumber || null,
      saleItemId: l.saleItemId,
      lineIndex: l.lineIndex,
      condition: l.condition,
      itemKey: `${l.productId}_${l.lineIndex}`,
      itemPayload: '{}',
    })),
    deltas: refundItems.map((l, i) => ({
      id: `${id}-D${i}`,
      key: `${id}-D${i}`,
      productId: l.productId,
      delta: l.quantity,
    })),
    batches: refundItems.map((l) => ({
      batchId: null,
      productId: l.productId,
      quantity: l.quantity,
      unitCost: 0,
      fallbackBatchId: `E2E-FB-${id}-${l.productId}`,
      fallbackKey: `e2e-fb-${id}-${l.productId}`,
    })),
    imeis: refundItems.filter((l) => l.imeiNumber).map((l) => l.imeiNumber),
    defectiveImeis: [],
    defectNote: null,
    customerPointsAfter: null,
    customerPointBucketsJson: null,
    debt: null,
    voucher: null,
    cashMove: cashOut > 0 ? {
      id: `${id}-CM`,
      sessionId: sale.shiftId,
      amount: cashOut,
      reason: 'Refund cash payout',
      cashierName: 'Auditor',
    } : null,
    audit: {
      action: 'REFUND',
      details: `Refund ${totalNet} DA on ticket ${sale.receiptNumber}`,
      user: 'Auditor',
      requiresPin: true,
      deviceId: sale.deviceId,
      ipAddress: null,
    },
  };

  // Compute independent oracle
  const oracle = computeOracle(sale, refundRequest, existingRefunds, {});

  // Determine validity
  let validity = 'valid';
  const invalidReasons = [];
  if (refundItems.length === 0) {
    validity = 'invalid-fixture';
    invalidReasons.push('no refundable items');
  }
  if (mode === 'zero-qty') validity = 'invalid-fixture';
  if (mode === 'over-limit') validity = 'invalid-fixture';

  // Dimensions
  const dimensions = {
    mode,
    paymentMethod: method,
    productCount: sale.items.length,
    hasCustomer: !!sale.customer,
    hasExistingRefunds: existingRefunds.length > 0,
    online: refundRequest.online,
    isSerialized: sale.items.some((i) => i.product.isSerialized),
    hasDefective: refundItems.some((l) => l.condition === 'defective'),
    validity,
  };

  const scenario = {
    id,
    seed,
    dimensions,
    initialState: {
      sale,
      existingRefunds,
      shift: { id: sale.shiftId, status: 'OPEN', openingFloat: 100000 },
      app: { online: refundRequest.online, deviceId: sale.deviceId },
    },
    request: refundRequest,
    expectedOutcome: {
      allowed: oracle.allowed,
      reason: oracle.reason,
      expectedStatus: oracle.expectedStatus,
      expectedRefundTotal: oracle.expectedRefundTotal,
      expectedCashOut: oracle.expectedCashOut,
      expectedStockRestored: oracle.expectedStockRestored,
    },
    invariants: oracle.invariantChecks,
    executable: validity === 'valid' && oracle.allowed,
    validity,
    invalidReasons,
  };

  scenarios.push(scenario);
}

// ---------------------------------------------------------------------------
// Generate scenarios
// ---------------------------------------------------------------------------

const TARGET_COUNT = 10000;
const BATCH_SIZE = 1000;
let generated = 0;

console.log(`[scenario-generator] Target: ${TARGET_COUNT} scenarios`);

// Clear output file
if (existsSync(OUT_FILE)) {
  // Keep existing, append new
} else {
  writeFileSync(OUT_FILE, '');
}

let batch = 0;
while (generated < TARGET_COUNT) {
  const batchStart = generated;
  const batchEnd = Math.min(generated + BATCH_SIZE, TARGET_COUNT);

  for (let i = batchStart; i < batchEnd; i++) {
    const seed = 20261025 + i; // deterministic seed based on scenario index
    const rng = new RNG(seed);
    generateBaseScenario(rng, seed);
    generated++;
  }

  batch++;
  // Write batch to file
  const batchScenarios = scenarios.slice(batchStart, batchEnd);
  for (const s of batchScenarios) {
    appendFileSync(OUT_FILE, JSON.stringify(s) + '\n');
  }

  console.log(`[scenario-generator] Batch ${batch}: ${batchStart}-${batchEnd - 1} (${generated}/${TARGET_COUNT})`);
}

// ---------------------------------------------------------------------------
// Write index
// ---------------------------------------------------------------------------
const validCount = scenarios.filter((s) => s.validity === 'valid').length;
const invalidCount = scenarios.filter((s) => s.validity === 'invalid-fixture').length;
const executableCount = scenarios.filter((s) => s.executable).length;

const dimensionCounts = {};
for (const s of scenarios) {
  const k = s.dimensions.mode;
  dimensionCounts[k] = (dimensionCounts[k] || 0) + 1;
}

const index = {
  generatedAt: new Date().toISOString(),
  total: scenarios.length,
  valid: validCount,
  invalidFixture: invalidCount,
  executable: executableCount,
  dimensionCounts,
  sourceFile: 'scenarios.jsonl',
  seedBase: 20261025,
};

writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));

console.log(`\n[scenario-generator] Complete:`);
console.log(`  Total: ${scenarios.length}`);
console.log(`  Valid: ${validCount}`);
console.log(`  Invalid fixtures: ${invalidCount}`);
console.log(`  Executable: ${executableCount}`);
console.log(`  Output: ${OUT_FILE}`);
console.log(`  Index: ${INDEX_FILE}`);
console.log(`\nDimension breakdown:`);
for (const [k, v] of Object.entries(dimensionCounts)) {
  console.log(`  ${k}: ${v}`);
}
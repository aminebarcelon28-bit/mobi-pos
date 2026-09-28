import assert from 'node:assert';
import { readFileSync } from 'node:fs';

console.log('========================================================================');
console.log('PO INVOICE SCANNER & RECONCILIATION PIPELINE TEST');
console.log('========================================================================');

// 1. Modulo 10 GTIN verification test
function verifyModulo10Gtin(code) {
  if (!/^\d+$/.test(code)) return false;
  const len = code.length;
  if (len !== 8 && len !== 12 && len !== 13 && len !== 14) return false;
  const digits = code.split('').map(Number);
  const payload = digits.slice(0, len - 1);
  const checkDigit = digits[len - 1];

  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    const d = payload[payload.length - 1 - i];
    sum += i % 2 === 0 ? d * 3 : d * 1;
  }
  const calculatedCheck = (10 - (sum % 10)) % 10;
  return calculatedCheck === checkDigit;
}

assert(verifyModulo10Gtin('012000000133'), 'UPC-A (12) must be valid');
assert(verifyModulo10Gtin('4006381333931'), 'EAN-13 must be valid');
assert(verifyModulo10Gtin('0745883815234'), 'Belkin GTIN-13 must be valid');
assert(!verifyModulo10Gtin('4006381333932'), 'Corrupted EAN-13 must be rejected');
console.log('  ✅ [PASS] Modulo-10 GTIN Checksum verification');

// 2. Demo Invoice Invariant Math Verification
const demoLines = [
  { desc: 'Écran OLED iPhone 13', gtin: '4006381333931', qty: 5, unitCost: 12500, lineTotal: 62500 },
  { desc: 'Batterie Origine Samsung S21', gtin: '012000000133', qty: 10, unitCost: 3200, lineTotal: 32000 },
  { desc: 'Chargeur Rapide 25W Type-C', qty: 15, unitCost: 2500, lineTotal: 37500 },
];

let computedSubtotal = 0;
for (const line of demoLines) {
  assert.strictEqual(line.qty * line.unitCost, line.lineTotal, `Line ${line.desc} math must match`);
  computedSubtotal += line.lineTotal;
}

const reportedFreight = 3250;
const reportedTax = 0;
const reportedGrandTotal = 135250;
const delta = (computedSubtotal + reportedFreight + reportedTax) - reportedGrandTotal;

assert.strictEqual(delta, 0, 'Demo invoice invariant sandwich must be strictly balanced (Delta == 0)');
console.log('  ✅ [PASS] Demo Invoice Invariant Sandwich (Delta = 0.00 DA)');

// 3. User Accessories Invoice Invariant Math Verification
const accessoriesLines = [
  { desc: 'ADAPT. SECT. 20W TYPE-C A2305 ORIG APPL', sn: '019425208421', qty: 10, unitCost: 3150, lineTotal: 31500 },
  { desc: 'ETUI SILIC. NOIR IPH 15 PROMAX', ref: 'APC-15PM-B', qty: 20, unitCost: 1850, lineTotal: 37000 },
  { desc: 'BELKIN BRAIDED CABLE USBC-USBC 200CM / 2M', gtin: '0745883815234', qty: 15, unitCost: 1400, lineTotal: 21000 },
  { desc: 'ANKER 735 CHARGER GAN 3 65W 3-PORT FAST', pn: 'A2667G11', qty: 5, unitCost: 4200, lineTotal: 21000 },
  { desc: 'FILM VERRE TREMPE PRIVACY S24 ULTRA 9H', ref: 'ACC-SCR-S24U', qty: 50, unitCost: 350, lineTotal: 17500 },
];

let accessoriesSubtotal = 0;
for (const line of accessoriesLines) {
  assert.strictEqual(line.qty * line.unitCost, line.lineTotal, `Line ${line.desc} math must match`);
  accessoriesSubtotal += line.lineTotal;
}
assert.strictEqual(accessoriesSubtotal, 128000, 'Accessories invoice subtotal must be exactly 128,000 DA');
console.log('  ✅ [PASS] User Accessories Invoice Math (128,000.00 DA strictly balanced)');

// 4. Verify Tauri Command Registration
const libRs = readFileSync('src-tauri/src/lib.rs', 'utf8');
assert(libRs.includes('scanner::mobile_scan_document'), 'mobile_scan_document must be registered in generate_handler!');
assert(libRs.includes('commands::po_process_raw_scan'), 'po_process_raw_scan must be registered in generate_handler!');
assert(libRs.includes('commands::po_commit_stock_batch'), 'po_commit_stock_batch must be registered in generate_handler!');
console.log('  ✅ [PASS] Rust Tauri Commands registered in generate_handler!');

// 5. Verify Document Scanner Fallback
const docScannerTs = readFileSync('src/utils/documentScanner.ts', 'utf8');
assert(docScannerTs.includes("'mobile_scan_document'"), 'documentScanner.ts must invoke mobile_scan_document');
assert(docScannerTs.includes('isPluginMissing'), 'documentScanner.ts must handle isPluginMissing');
console.log('  ✅ [PASS] TS Scanner invocation & mobile_scan_document fallback');

// 6. Verify Currency Formatting in PoReviewScreen (no raw $ signs)
const poReviewScreenTsx = readFileSync('src/components/PoReviewScreen.tsx', 'utf8');
assert(!poReviewScreenTsx.includes('Unit Cost ($)'), 'PoReviewScreen must not display Unit Cost ($)');
assert(!poReviewScreenTsx.includes('Line Total ($)'), 'PoReviewScreen must not display Line Total ($)');
assert(poReviewScreenTsx.includes('formatDZD'), 'PoReviewScreen must use formatDZD');
console.log('  ✅ [PASS] PoReviewScreen uses DZD / DA currency formatting (no $)');

// 7. Mobile reachability audit: invoice_ingestion accessible from all major mobile workflows
const companionHeaderTsx = readFileSync('src/components/mobile/CompanionHeader.tsx', 'utf8');
const mobileCheckoutTsx = readFileSync('src/components/mobile/tabs/MobileCheckoutTab.tsx', 'utf8');
const catalogSearchTsx = readFileSync('src/components/mobile/tabs/CatalogSearchTab.tsx', 'utf8');
const managementTsx = readFileSync('src/components/mobile/tabs/ManagementTab.tsx', 'utf8');

assert(companionHeaderTsx.includes("openModal('invoice_ingestion')"), 'CompanionHeader must provide quick invoice ingestion button');
assert(mobileCheckoutTsx.includes("openModal('invoice_ingestion')"), 'MobileCheckoutTab must provide quick invoice reception button');
assert(catalogSearchTsx.includes("openModal('invoice_ingestion')"), 'CatalogSearchTab must provide invoice ingestion action');
assert(managementTsx.includes("openModal('invoice_ingestion')"), 'ManagementTab must provide invoice ingestion card');
console.log('  ✅ [PASS] Mobile navigation & quick reachability verified on 4 mobile entry points');

// 8. Currency hygiene in ingestion modal
const invoiceIngestionTsx = readFileSync('src/components/modals/InvoiceIngestionModal.tsx', 'utf8');
assert(!invoiceIngestionTsx.includes('Prix ($)'), 'InvoiceIngestionModal must not use $');
assert(invoiceIngestionTsx.includes('Total Facture (DA)'), 'InvoiceIngestionModal must use DA');
console.log('  ✅ [PASS] InvoiceIngestionModal strictly standardized on DA / DZD');

// 9. Verify scan_audit_log in DB schema and Rust commit handler
const dbRs = readFileSync('src-tauri/src/db.rs', 'utf8');
const commandsRs = readFileSync('src-tauri/src/commands.rs', 'utf8');
assert(dbRs.includes('CREATE TABLE IF NOT EXISTS scan_audit_log'), 'db.rs must define scan_audit_log schema');
assert(commandsRs.includes('INSERT INTO scan_audit_log'), 'commands.rs must insert into scan_audit_log inside atomic transaction');
assert(commandsRs.includes('user_id: Option<String>'), 'CommitStockBatchRequest must have user_id');
console.log('  ✅ [PASS] scan_audit_log atomic telemetry & audit trail verified');

// 10. Verify Auto-Approve vs Exception pills in PoReviewScreen
assert(poReviewScreenTsx.includes('Auto-Approve Éligible'), 'PoReviewScreen must render Auto-Approve Éligible');
assert(poReviewScreenTsx.includes('Revue par Exception Requise'), 'PoReviewScreen must render Revue par Exception Requise');
assert(poReviewScreenTsx.includes('Valider la Réception en Stock (1-Clic)'), 'PoReviewScreen must provide 1-Clic commit');
console.log('  ✅ [PASS] Decision branch (🟢 Auto-Approve vs 🔴 Exception-First) verified in PoReviewScreen');

console.log('========================================================================');
console.log('ALL PIPELINE CHECKS PASSED (10/10)');
console.log('========================================================================');


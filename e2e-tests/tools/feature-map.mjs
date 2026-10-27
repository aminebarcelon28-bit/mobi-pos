/**
 * Feature-existence map for the coverage report: for each claim of the form
 * "feature X exists / does not exist", find supporting evidence (file:line of
 * first hit) by scanning src/ and src-tauri/. Output: fixtures/feature-map.json
 * plus a readable summary. Read-only.
 *
 * Usage: node e2e-tests/tools/feature-map.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', 'fixtures', 'feature-map.json');

const EXTS = new Set(['.ts', '.tsx', '.rs', '.sql', '.mjs', '.js']);
const SKIP_DIRS = new Set(['node_modules', 'target', 'target-e2e', 'dist', '.git', 'e2e-tests', 'test', 'tests', 'coverage', 'src-tauri/gen']);

/** feature -> list of regexes (any hit wins; first hit recorded with file:line). */
const FEATURES = {
  'loyalty points': [/loyaltyPoints/, /loyalty_points/],
  'store credit / avoir client': [/storeCredit/, /store_credit/, /Avoir Client/i],
  'voucher / bon achat': [/voucherCreditApplied/, /VoucherModal/, /voucher/],
  'credit sales / debt': [/debtPlan/i, /debt_plan/, /creditSale/i, /CreditSale/i],
  'repair module': [/RepairDashboard|repair_sales|RepairModal|repairTicket/i],
  'trade-in module': [/tradeIn|TradeIn|tradein/],
  'warranty inspector': [/warranty/i],
  'label printing': [/printLabel|BarcodeLabel|barcode-label|labelPrint/i],
  'receipt printing': [/PrinterService|printReceipt|ReceiptPaper|escpos/i],
  'email receipt': [/email.*receipt|sendReceiptEmail/i],
  'SMS receipt': [/sms.*receipt|Twilio|twilio/i],
  'cash rounding': [/rounding|arrondi/i],
  'foreign currency': [/multiCurrency|foreignCurrency|exchangeRate|taux de change/i],
  'card payment gateway (CIB/SATIM)': [/CIB|SATIM|cardGateway|terminal.*payment.*gateway/i],
  'mobile app (separate)': [/MobileCheckoutTab|mobile\/tabs/i],
  'scale/weight input': [/weightBarcode|pese|scaleBarcode/i],
  'cash drawer hardware (kick)': [/openDrawer|kickDrawer|cashDrawer/i],
  'returns / refunds native kernel': [/refund_sale_atomic/],
  'void sale': [/voidSale|void_sale|voidCompleteSale/i],
  'held sales (park)': [/heldSales|holdSale|resumeSale/i],
  'customer display': [/CustomerDisplayScreen/],
  'kitchen/printing multiple': [/kitchenPrint|kitchen.*printer/i],
  'backup / restore': [/backupDatabase|restoreDatabase|backup_db|restore_db/i],
  'audit log hash chain': [/audit_log|auditLog.*hash|prev_hash|hash_chain/i],
  'sync outbox': [/sync_outbox/],
  'turso sync transport': [/libsql|turso/i],
  'purchase orders (PO)': [/purchaseOrder|create_po|PoReviewScreen|replenishment/i],
  'IMEI / serialized stock': [/imei/i],
  'G-33 type discipline (STRICT)': [/STRICT/i],
  'FTS search': [/fts5|CREATE VIRTUAL TABLE.*fts/i],
  'sqlite-vec (vec0)': [/vec0/i],
  'i18n / RTL': [/useLocale|rtl|RTL|locale/i],
  'theme light/dark': [/theme|darkMode|data-theme/i],
  'manager PIN / roles': [/manager_pin|MANAGER_PIN|role.*manager/i],
  'reports dashboard': [/ReportsDashboard|reports\//i],
};

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(path.join(dir, e.name));
    } else if (EXTS.has(path.extname(e.name))) {
      yield path.join(dir, e.name);
    }
  }
}

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'src-tauri', 'src'))];
const map = {};
for (const [feature, patterns] of Object.entries(FEATURES)) {
  const hits = [];
  for (const file of files) {
    if (hits.length >= 3) break;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (patterns.some((re) => re.test(lines[i]))) {
        hits.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${i + 1}`);
        break;
      }
    }
  }
  map[feature] = { exists: hits.length > 0, evidence: hits };
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), scannedFiles: files.length, features: map }, null, 1));
console.log(`[feature-map] scanned ${files.length} files -> ${OUT}`);
for (const [k, v] of Object.entries(map)) {
  console.log(`  ${v.exists ? 'YES' : 'NO '} ${k}${v.exists ? '  ' + v.evidence.join('  ') : ''}`);
}

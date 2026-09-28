import { receiptText, xReportText, zReportText, purchaseOrderText, repairTicketText, tradeInText, voucherText } from '../src/utils/mobileDocPrint.ts';

const tx = { receiptNumber: 'R-001', createdAt: '2026-09-22T10:00:00', customer: { name: 'Yacine Benali' },
  items: [{ quantity: 2, appliedPrice: 1500, discount: 200, product: { title: 'Coque Silicone MagSafe iPhone 15 Pro Max Noir Titane', price: 1500 } }],
  total: 2800, discountTotal: 200, paymentMethod: 'Espèces', cashTendered: 3000, changeDue: 200, cashierName: 'Amine', isRefund: false };
const docs: Array<[string, string]> = [
  ['receipt', receiptText(tx, { storeName: 'ACCESSOIRES MOBI', address: 'Alger', phone: '0550' })],
  ['x', xReportText({ sessionId: 'S1', cashierName: 'Amine', dateStr: 'd', openingFloat: 20000, cashSales: 55000, deposits: 0, expenses: 1500, refunds: 0, expectedCash: 73500, salesCount: 12, totalRevenue: 60000 }, 'STORE')],
  ['z', zReportText({ cashierName: 'Amine', dateStr: 'd', openingFloat: 20000, cashSales: 55000, debtSettlements: 8000, refunds: 0, expenses: 1500, drops: 20000, payouts: 0, expectedCash: 61500, countedCash: 61500, variance: 0 })],
  ['po', purchaseOrderText({ poNumber: 'PO-1', createdAt: '2026-09-22', vendorName: 'Grossiste', items: Array.from({ length: 30 }, (_, i) => ({ title: `Article ${i} avec un nom très long pour tester`, sku: 'S', suggestedQty: 5, unitCost: 800, totalCost: 4000 })), totalAmount: 120000 }, null)],
  ['repair', repairTicketText({ ticketNumber: 'SAV-1', customerName: 'Karim', customerPhone: '0661', deviceModel: 'iPhone 14', imei: '3589', problemDescription: 'Écran fissuré', diagnosticNotes: 'Afficheur HS', conditionChecklist: { screenOk: false, faceIdOk: true, cameraOk: true, chargingOk: true, bodyOk: true, batteryOk: true, audioOk: true }, totalCost: 8000, depositAmount: 3000, createdAt: '2026-09-22' }, null)],
  ['tradein', tradeInText({ id: 'T1', customerName: 'Samir', deviceModel: 'iPhone 13', brand: 'Apple', imei: '3589', conditionGrade: 'Grade B (Bon État)', buybackValue: 45000, creditToWallet: false, createdAt: '2026-09-22' }, null)],
  ['voucher', voucherText({ code: 'AV-ABC123', initialAmount: 2000, customerName: 'Lina', createdAt: '2026-09-22', expiresAt: '2026-11-22' }, null)],
];
let ok = true;
for (const [name, doc] of docs) {
  const lines = doc.split('\n');
  const wide = lines.filter((l) => l.length > 42);
  console.log(`${name}: ${lines.length} lines, max width ${Math.max(...lines.map((l) => l.length))}`);
  if (lines.length > 52 || wide.length > 0) { console.log(`  VIOLATION in ${name}:`, wide.slice(0, 3)); ok = false; }
}
console.log(ok ? 'DOC VERIFY: ALL PASS' : 'DOC VERIFY: FAILURES');
if (!ok) process.exit(1);

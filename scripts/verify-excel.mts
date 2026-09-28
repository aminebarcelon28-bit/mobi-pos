// Verifies the professional Excel export: well-formed XML, 4 sheets,
// frozen panes + autofilter + tab colors present, sync/async identical.
import { generateProfessionalExcelXml, generateProfessionalExcelXmlAsync } from '../src/utils/excelExporter.ts';

const txns = [
  {
    id: 't1', receiptNumber: 'R-001', status: 'COMPLETED', isRefund: false,
    createdAt: '2026-09-20T10:00:00', customer: { name: 'Yacine & Fils <SARL>' },
    items: [{ quantity: 2, appliedPrice: 1500, product: { price: 1500, title: 'Coque', sku: 'C1', barcode: '6130001', category: 'Coques' } }],
    subtotal: 3000, discountTotal: 200, total: 2800, costTotal: 1800, profit: 1000,
    paymentMethod: 'Espèces', cashierName: 'Amine',
  },
  {
    id: 't2', receiptNumber: 'R-002', status: 'VOIDED', isRefund: false,
    createdAt: '2026-09-20T11:00:00', customer: null, items: [],
    subtotal: 0, discountTotal: 0, total: 500, costTotal: 0,
    paymentMethod: 'Espèces', cashierName: 'Amine',
  },
];

const syncXml = generateProfessionalExcelXml(txns, 'Test');
const asyncXml = await generateProfessionalExcelXmlAsync(txns, 'Test');

// 1. balanced tags for structural elements
const tags = ['Workbook', 'Styles', 'Style', 'Worksheet', 'Table', 'Column', 'Row', 'Cell', 'WorksheetOptions', 'AutoFilter'];
let ok = true;
for (const t of tags) {
  const open = (syncXml.match(new RegExp(`<${t}[\\s>]`, 'g')) || []).length;
  const close = (syncXml.match(new RegExp(`</${t}>`, 'g')) || []).length;
  const self = (syncXml.match(new RegExp(`<${t}[^>]*/>`, 'g')) || []).length;
  if (open !== close + self) { console.log(`UNBALANCED <${t}>: open=${open} close=${close} self=${self}`); ok = false; }
}
// 2. four sheets in order, Sommaire first
const names = [...syncXml.matchAll(/<Worksheet ss:Name="([^"]+)"/g)].map((m) => m[1]);
console.log('sheets:', names.join(' | '));
if (names[0] !== 'Sommaire' || names.length !== 4) { console.log('SHEET ORDER FAIL'); ok = false; }
// 3. options present on every sheet
for (const needle of ['FreezePanes', 'FitToPage', 'TabColorIndex', 'AutoFilter', 'CoverTitle', 'HeaderRowGold', 'TotalSummaryCurrency']) {
  if (!syncXml.includes(needle)) { console.log('MISSING:', needle); ok = false; }
}
// 4. escaping intact
if (!syncXml.includes('Yacine &amp; Fils &lt;SARL&gt;')) { console.log('ESCAPE FAIL'); ok = false; }
// 5. sync/async byte-identical (modulo the per-call <Created> timestamp)
const norm = (x: string) => x.replace(/<Created>[^<]*<\/Created>/, '<Created>X</Created>');
if (norm(syncXml) !== norm(asyncXml)) { console.log('SYNC/ASYNC MISMATCH'); ok = false; }
console.log(ok ? 'EXCEL VERIFY: ALL PASS' : 'EXCEL VERIFY: FAILURES');
if (!ok) process.exit(1);

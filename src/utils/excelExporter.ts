import type { SaleTransaction } from '../types/pos';
import { buildExcelStyles } from './excel/styles';
import {
  buildCoverWorksheet,
  buildSalesWorksheet,
  buildItemsWorksheet,
  buildSalesWorksheetAsync,
  buildItemsWorksheetAsync,
  buildPaymentsWorksheet,
  MAX_EXCEL_ROWS,
  type ExcelMetrics,
} from './excel/sheets';

export { MAX_EXCEL_ROWS };
import { computeSalesMetrics, type AllocCogsLookup } from './receiptMath';

export { escapeXml } from './excel/sheets';

function computeMetrics(
  transactions: SaleTransaction[],
  periodLabel: string,
  allocCogsBySaleId?: AllocCogsLookup
): {
  metrics: ExcelMetrics;
  paymentBreakdown: Record<string, { count: number; total: number }>;
} {
  const exportDate = new Date().toLocaleDateString('fr-DZ', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  // Single source of truth: the SAME canonical computeSalesMetrics() formula
  // the Desktop ReportsModal and the Mobile LiveActivityTab/ManagementTab use,
  // so the export can never diverge from the on-screen KPIs (CA Net, profit,
  // basket, discounts, refunds). STRICT FIFO LEDGER (v104): theUI passes its
  // frozen allocation map so the export sums ledger COGS (900) instead of a
  // stale stored costTotal (1000) — 6,100, not 6,000.
  const sales = computeSalesMetrics(transactions, { allocCogsBySaleId });
  const totalGrossRevenue = sales.grossRevenue;
  const totalRefundsValue = sales.refundsTotal;
  const totalNetRevenue = sales.netRevenue;
  const totalCost = sales.costTotal;
  const totalProfit = sales.profitTotal;
  const avgMargin = sales.marginPct;
  const validSalesCount = sales.validCount;
  const averageBasket = sales.averageBasket;

  const paymentBreakdown: Record<string, { count: number; total: number }> = {};
  transactions.forEach((t) => {
    if (t.status === 'VOIDED') return;
    const method = t.paymentMethod || 'Espèces';
    if (!paymentBreakdown[method]) {
      paymentBreakdown[method] = { count: 0, total: 0 };
    }
    const val = t.isRefund ? -t.total : t.total;
    paymentBreakdown[method].count += 1;
    paymentBreakdown[method].total += val;
  });

  return {
    metrics: {
      exportDate,
      periodLabel,
      totalGrossRevenue,
      totalRefundsValue,
      totalNetRevenue,
      totalCost,
      totalProfit,
      avgMargin,
      validSalesCount,
      averageBasket,
    },
    paymentBreakdown,
  };
}

function workbookXml(
  styles: string,
  coverSheet: string,
  salesSheet: string,
  itemsSheet: string,
  paymentsSheet: string
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
  <Author>Mobi-POS Enterprise</Author>
  <LastAuthor>Mobi-POS Enterprise</LastAuthor>
  <Created>${new Date().toISOString()}</Created>
  <Company>Mobi-POS Algérie</Company>
  <Version>16.00</Version>
 </DocumentProperties>
${styles}
${coverSheet}
${salesSheet}
${itemsSheet}
${paymentsSheet}
</Workbook>`;
}

/**
 * Generates an ultra-professional, multi-sheet, color-coded Microsoft Excel XML (SpreadsheetML) file.
 * Compatible with Microsoft Excel (all versions), Apple Numbers, LibreOffice Calc, and Google Sheets.
 * Throws `{code:'TOO_LARGE'}` past MAX_EXCEL_ROWS (row cap lives in ./excel/sheets).
 */
export function generateProfessionalExcelXml(
  transactions: SaleTransaction[],
  periodLabel: string = 'Toutes les dates',
  allocCogsBySaleId?: AllocCogsLookup
): string {
  const { metrics, paymentBreakdown } = computeMetrics(transactions, periodLabel, allocCogsBySaleId);

  return workbookXml(
    buildExcelStyles(),
    buildCoverWorksheet(metrics, paymentBreakdown, transactions.length),
    buildSalesWorksheet(transactions, metrics, allocCogsBySaleId),
    buildItemsWorksheet(transactions),
    buildPaymentsWorksheet(paymentBreakdown, metrics.totalNetRevenue, metrics.validSalesCount)
  );
}

/**
 * Chunked async variant: row generation yields to the UI every ~1000 rows.
 * Byte-identical output to the sync version for the same input.
 */
export async function generateProfessionalExcelXmlAsync(
  transactions: SaleTransaction[],
  periodLabel: string = 'Toutes les dates',
  allocCogsBySaleId?: AllocCogsLookup
): Promise<string> {
  const { metrics, paymentBreakdown } = computeMetrics(transactions, periodLabel, allocCogsBySaleId);
  const [salesSheet, itemsSheet] = await Promise.all([
    buildSalesWorksheetAsync(transactions, metrics, allocCogsBySaleId),
    buildItemsWorksheetAsync(transactions),
  ]);

  return workbookXml(
    buildExcelStyles(),
    buildCoverWorksheet(metrics, paymentBreakdown, transactions.length),
    salesSheet,
    itemsSheet,
    buildPaymentsWorksheet(paymentBreakdown, metrics.totalNetRevenue, metrics.validSalesCount)
  );
}

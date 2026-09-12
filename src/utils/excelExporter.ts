import type { SaleTransaction } from '../types/pos';
import { buildExcelStyles } from './excel/styles';
import {
  buildSalesWorksheet,
  buildItemsWorksheet,
  buildPaymentsWorksheet,
  type ExcelMetrics,
} from './excel/sheets';
import { getEffectiveCostPrice } from './pricingEngine';

export { escapeXml } from './excel/sheets';

function computeMetrics(transactions: SaleTransaction[], periodLabel: string): {
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

  const validSales = transactions.filter((t) => t.status !== 'VOIDED' && !t.isRefund);
  const totalGrossRevenue = validSales.reduce((acc, t) => acc + t.total, 0);
  const totalRefundsValue = transactions.filter((t) => t.isRefund).reduce((acc, t) => acc + t.total, 0);
  const totalNetRevenue = Math.max(0, totalGrossRevenue - totalRefundsValue);
  const totalCost = validSales.reduce((acc, t) => acc + (t.costTotal || getEffectiveCostPrice({ price: t.total })), 0);
  const totalProfit = totalNetRevenue - totalCost;
  const avgMargin = totalNetRevenue > 0 ? ((totalProfit / totalNetRevenue) * 100).toFixed(1) : '0';

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
      validSalesCount: validSales.length,
    },
    paymentBreakdown,
  };
}

/**
 * Generates an ultra-professional, multi-sheet, color-coded Microsoft Excel XML (SpreadsheetML) file.
 * Compatible with Microsoft Excel (all versions), Apple Numbers, LibreOffice Calc, and Google Sheets.
 */
export function generateProfessionalExcelXml(
  transactions: SaleTransaction[],
  periodLabel: string = 'Toutes les dates'
): string {
  const { metrics, paymentBreakdown } = computeMetrics(transactions, periodLabel);

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
${buildExcelStyles()}
${buildSalesWorksheet(transactions, metrics)}
${buildItemsWorksheet(transactions)}
${buildPaymentsWorksheet(paymentBreakdown, metrics.totalNetRevenue, metrics.validSalesCount)}
</Workbook>`;
}

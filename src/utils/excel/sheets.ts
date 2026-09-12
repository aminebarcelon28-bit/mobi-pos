import type { SaleTransaction } from '../../types/pos';
import { formatDateTime } from '../../types/pos';
import { getEffectiveCostPrice } from '../pricingEngine';

export function escapeXml(unsafe?: string): string {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface ExcelMetrics {
  exportDate: string;
  periodLabel: string;
  totalGrossRevenue: number;
  totalRefundsValue: number;
  totalNetRevenue: number;
  totalCost: number;
  totalProfit: number;
  avgMargin: string;
  validSalesCount: number;
}

export function buildSalesWorksheet(
  transactions: SaleTransaction[],
  metrics: ExcelMetrics
): string {
  const dataRows = transactions.map((t, index) => {
    const isVoided = t.status === 'VOIDED';
    const isRefund = Boolean(t.isRefund);
    const isZebra = index % 2 === 1;

    let statusLabel = 'VALIDÉ';
    let rowStyleLeft = isZebra ? 'RowZebraLeft' : 'RowLeft';
    let rowStyleCenter = isZebra ? 'RowZebraCenter' : 'RowCenter';
    let rowStyleCurrency = isZebra ? 'RowZebraCurrency' : 'RowCurrency';
    let rowStyleProfit = isZebra ? 'RowZebraProfit' : 'RowProfit';

    if (isVoided) {
      statusLabel = 'ANNULÉ (VOID)';
      rowStyleLeft = 'RowVoided';
      rowStyleCenter = 'RowVoided';
      rowStyleCurrency = 'RowVoidedCurrency';
      rowStyleProfit = 'RowVoidedCurrency';
    } else if (isRefund) {
      statusLabel = 'AVOIR ÉMIS';
      rowStyleLeft = 'RowRefund';
      rowStyleCenter = 'RowRefund';
      rowStyleCurrency = 'RowRefundCurrency';
      rowStyleProfit = 'RowRefundCurrency';
    }

    const customerName = escapeXml(t.customer?.name || 'Client de passage');
    const itemCount = (t.items || []).reduce((acc, item) => acc + item.quantity, 0);
    const subtotal = t.subtotal || t.total;
    const discount = t.discountTotal || 0;
    const cost = isVoided ? 0 : t.costTotal || getEffectiveCostPrice({ price: t.total });
    const netTotal = isVoided ? 0 : isRefund ? -t.total : t.total;
    const profit = isVoided || isRefund ? 0 : t.profit || netTotal - cost;
    const margin = netTotal > 0 ? ((profit / netTotal) * 100).toFixed(1) : '0';

    return `<Row ss:Height="22">
    <Cell ss:StyleID="${rowStyleCenter}"><Data ss:Type="String">${escapeXml(t.receiptNumber)}</Data></Cell>
    <Cell ss:StyleID="${rowStyleCenter}"><Data ss:Type="String">${statusLabel}</Data></Cell>
    <Cell ss:StyleID="${rowStyleCenter}"><Data ss:Type="String">${escapeXml(formatDateTime(t.createdAt))}</Data></Cell>
    <Cell ss:StyleID="${rowStyleLeft}"><Data ss:Type="String">${customerName}</Data></Cell>
    <Cell ss:StyleID="${rowStyleCenter}"><Data ss:Type="Number">${itemCount}</Data></Cell>
    <Cell ss:StyleID="${rowStyleCurrency}"><Data ss:Type="Number">${subtotal}</Data></Cell>
    <Cell ss:StyleID="${rowStyleCurrency}"><Data ss:Type="Number">${discount}</Data></Cell>
    <Cell ss:StyleID="${rowStyleCurrency}"><Data ss:Type="Number">${netTotal}</Data></Cell>
    <Cell ss:StyleID="${rowStyleCurrency}"><Data ss:Type="Number">${cost}</Data></Cell>
    <Cell ss:StyleID="${rowStyleProfit}"><Data ss:Type="Number">${profit}</Data></Cell>
    <Cell ss:StyleID="${rowStyleCenter}"><Data ss:Type="String">${margin}%</Data></Cell>
    <Cell ss:StyleID="${rowStyleCenter}"><Data ss:Type="String">${escapeXml(t.paymentMethod || 'Espèces')}</Data></Cell>
    <Cell ss:StyleID="${rowStyleCenter}"><Data ss:Type="String">${escapeXml(t.cashierName || 'Yacine (Caisse 1)')}</Data></Cell>
   </Row>`;
  }).join('\n');

  return ` <Worksheet ss:Name="Journal des Ventes">
  <Table ss:ExpandedColumnCount="13" x:FullColumns="1" x:FullRows="1" ss:DefaultRowHeight="20">
   <Column ss:Width="110"/><Column ss:Width="95"/><Column ss:Width="130"/><Column ss:Width="140"/><Column ss:Width="70"/>
   <Column ss:Width="95"/><Column ss:Width="85"/><Column ss:Width="105"/><Column ss:Width="95"/><Column ss:Width="100"/>
   <Column ss:Width="75"/><Column ss:Width="105"/><Column ss:Width="100"/>
   <Row ss:Height="30"><Cell ss:MergeAcross="12" ss:StyleID="TitleBanner"><Data ss:Type="String">  MOBI-POS ENTERPRISE — JOURNAL GÉNÉRAL DES VENTES ET REÇUS</Data></Cell></Row>
   <Row ss:Height="20"><Cell ss:MergeAcross="12" ss:StyleID="Subtitle"><Data ss:Type="String">  Export généré le : ${escapeXml(metrics.exportDate)}  |  Période : ${escapeXml(metrics.periodLabel)}  |  Total Transactions : ${transactions.length}</Data></Cell></Row>
   <Row ss:Height="10"/>
   <Row ss:Height="18">
    <Cell ss:MergeAcross="1" ss:StyleID="KpiHeader"><Data ss:Type="String">TOTAL TRANSACTIONS</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiHeader"><Data ss:Type="String">CHIFFRE D'AFFAIRES NET</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiHeader"><Data ss:Type="String">BÉNÉFICE COMMERCIAL NET</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiHeader"><Data ss:Type="String">PANIER MOYEN CLIENT</Data></Cell>
    <Cell ss:MergeAcross="1" ss:StyleID="KpiHeader"><Data ss:Type="String">MARGE MOYENNE %</Data></Cell>
   </Row>
   <Row ss:Height="25">
    <Cell ss:MergeAcross="1" ss:StyleID="KpiValue"><Data ss:Type="Number">${transactions.length}</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiValue"><Data ss:Type="String">${metrics.totalNetRevenue.toLocaleString('fr-DZ')} DA</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiValue"><Data ss:Type="String">${metrics.totalProfit.toLocaleString('fr-DZ')} DA</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiValue"><Data ss:Type="String">${Math.round(metrics.totalNetRevenue / Math.max(1, metrics.validSalesCount)).toLocaleString('fr-DZ')} DA</Data></Cell>
    <Cell ss:MergeAcross="1" ss:StyleID="KpiValue"><Data ss:Type="String">${metrics.avgMargin}%</Data></Cell>
   </Row>
   <Row ss:Height="15"/>
   <Row ss:Height="26">
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">N° Reçu / Ticket</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Statut Vente</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Date &amp; Heure</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Client</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Articles</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Sous-Total (DA)</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Remise (DA)</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Total Net (DA)</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Coût Achat (DA)</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Bénéfice Net (DA)</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Marge %</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Mode Paiement</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Vendeur / Caisse</Data></Cell>
   </Row>
   ${dataRows}
   <Row ss:Height="26">
    <Cell ss:MergeAcross="6" ss:StyleID="TotalSummaryRow"><Data ss:Type="String">TOTAL GÉNÉRAL COMPTABLE (DA)</Data></Cell>
    <Cell ss:StyleID="TotalSummaryCurrency"><Data ss:Type="Number">${metrics.totalNetRevenue}</Data></Cell>
    <Cell ss:StyleID="TotalSummaryCurrency"><Data ss:Type="Number">${metrics.totalCost}</Data></Cell>
    <Cell ss:StyleID="TotalSummaryCurrency"><Data ss:Type="Number">${metrics.totalProfit}</Data></Cell>
    <Cell ss:StyleID="TotalSummaryRow"><Data ss:Type="String">${metrics.avgMargin}%</Data></Cell>
    <Cell ss:MergeAcross="1" ss:StyleID="TotalSummaryRow"><Data ss:Type="String">—</Data></Cell>
   </Row>
  </Table>
 </Worksheet>`;
}

export function buildItemsWorksheet(transactions: SaleTransaction[]): string {
  const itemRows = transactions
    .flatMap((t) => {
      if (t.status === 'VOIDED') return [];
      return (t.items || []).map((item, idx) => {
        const p = item.product;
        const isZebra = idx % 2 === 1;
        const unitPrice = item.appliedPrice || p?.price || 0;
        const costPrice = p ? getEffectiveCostPrice(p) : getEffectiveCostPrice({ price: unitPrice });
        const lineTotal = unitPrice * item.quantity;

        return `<Row ss:Height="20">
    <Cell ss:StyleID="${isZebra ? 'RowZebraCenter' : 'RowCenter'}"><Data ss:Type="String">${escapeXml(t.receiptNumber)}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraCenter' : 'RowCenter'}"><Data ss:Type="String">${escapeXml(formatDateTime(t.createdAt))}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraCenter' : 'RowCenter'}"><Data ss:Type="String">${escapeXml(p?.sku || 'N/A')}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraCenter' : 'RowCenter'}"><Data ss:Type="String">${escapeXml(p?.barcode || 'N/A')}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraLeft' : 'RowLeft'}"><Data ss:Type="String">${escapeXml(p?.title || 'Article')}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraLeft' : 'RowLeft'}"><Data ss:Type="String">${escapeXml(p?.category || 'Accessoires')}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraCenter' : 'RowCenter'}"><Data ss:Type="Number">${item.quantity}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraCurrency' : 'RowCurrency'}"><Data ss:Type="Number">${unitPrice}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraCurrency' : 'RowCurrency'}"><Data ss:Type="Number">${costPrice}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraCurrency' : 'RowCurrency'}"><Data ss:Type="Number">${lineTotal}</Data></Cell>
   </Row>`;
      });
    })
    .join('\n');

  return ` <Worksheet ss:Name="Détail des Articles">
  <Table ss:ExpandedColumnCount="10" x:FullColumns="1" x:FullRows="1" ss:DefaultRowHeight="20">
   <Column ss:Width="110"/><Column ss:Width="100"/><Column ss:Width="100"/><Column ss:Width="120"/><Column ss:Width="230"/>
   <Column ss:Width="120"/><Column ss:Width="65"/><Column ss:Width="105"/><Column ss:Width="105"/><Column ss:Width="115"/>
   <Row ss:Height="28"><Cell ss:MergeAcross="9" ss:StyleID="TitleBanner"><Data ss:Type="String">  MOBI-POS — EXTRACTION DÉTAILLÉE DES LIGNES D'ARTICLES VENDUS</Data></Cell></Row>
   <Row ss:Height="26">
    <Cell ss:StyleID="HeaderRowSky"><Data ss:Type="String">N° Reçu</Data></Cell>
    <Cell ss:StyleID="HeaderRowSky"><Data ss:Type="String">Date Vente</Data></Cell>
    <Cell ss:StyleID="HeaderRowSky"><Data ss:Type="String">SKU</Data></Cell>
    <Cell ss:StyleID="HeaderRowSky"><Data ss:Type="String">Code-Barres EAN</Data></Cell>
    <Cell ss:StyleID="HeaderRowSky"><Data ss:Type="String">Désignation Produit</Data></Cell>
    <Cell ss:StyleID="HeaderRowSky"><Data ss:Type="String">Catégorie</Data></Cell>
    <Cell ss:StyleID="HeaderRowSky"><Data ss:Type="String">Quantité</Data></Cell>
    <Cell ss:StyleID="HeaderRowSky"><Data ss:Type="String">Prix Vente Unitaire</Data></Cell>
    <Cell ss:StyleID="HeaderRowSky"><Data ss:Type="String">Prix Achat Cost</Data></Cell>
    <Cell ss:StyleID="HeaderRowSky"><Data ss:Type="String">Total Ligne (DA)</Data></Cell>
   </Row>
   ${itemRows}
  </Table>
 </Worksheet>`;
}

export function buildPaymentsWorksheet(
  breakdown: Record<string, { count: number; total: number }>,
  totalNetRevenue: number,
  validSalesCount: number
): string {
  const rows = Object.entries(breakdown)
    .map(([method, item]) => {
      const share = totalNetRevenue > 0 ? ((item.total / totalNetRevenue) * 100).toFixed(1) : '0';
      return `<Row ss:Height="22">
    <Cell ss:StyleID="RowLeft"><Data ss:Type="String">${escapeXml(method)}</Data></Cell>
    <Cell ss:StyleID="RowCenter"><Data ss:Type="Number">${item.count}</Data></Cell>
    <Cell ss:StyleID="RowCurrency"><Data ss:Type="Number">${item.total}</Data></Cell>
    <Cell ss:StyleID="RowCenter"><Data ss:Type="String">${share}%</Data></Cell>
   </Row>`;
    })
    .join('\n');

  return ` <Worksheet ss:Name="Synthèse Règlements">
  <Table ss:ExpandedColumnCount="4" x:FullColumns="1" x:FullRows="1" ss:DefaultRowHeight="22">
   <Column ss:Width="160"/><Column ss:Width="120"/><Column ss:Width="140"/><Column ss:Width="100"/>
   <Row ss:Height="28"><Cell ss:MergeAcross="3" ss:StyleID="TitleBanner"><Data ss:Type="String">  MOBI-POS — SYNTHÈSE DES ENCAISSEMENTS PAR MODE DE RÈGLEMENT</Data></Cell></Row>
   <Row ss:Height="26">
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Mode de Paiement</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Nb Transactions</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Montant Total Encaissé</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Part du CA %</Data></Cell>
   </Row>
   ${rows}
   <Row ss:Height="26">
    <Cell ss:StyleID="TotalSummaryRow"><Data ss:Type="String">TOTAL TOUS MODES</Data></Cell>
    <Cell ss:StyleID="TotalSummaryRow"><Data ss:Type="Number">${validSalesCount}</Data></Cell>
    <Cell ss:StyleID="TotalSummaryCurrency"><Data ss:Type="Number">${totalNetRevenue}</Data></Cell>
    <Cell ss:StyleID="TotalSummaryRow"><Data ss:Type="String">100.0%</Data></Cell>
   </Row>
  </Table>
 </Worksheet>`;
}

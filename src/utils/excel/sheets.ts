import type { SaleTransaction } from '../../types/pos';
import { formatDateTime } from '../../types/pos';
import { getEffectiveCostPrice } from '../pricingEngine';
import { grossFromTransaction, netFromTransaction, type AllocCogsLookup } from '../receiptMath';
import { neutralizeSpreadsheetFormula } from '../spreadsheetSafe';

export function escapeXml(unsafe?: string): string {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * SpreadsheetML string-cell writer: XML-escape + formula-neutralize. A cell
 * whose text starts with =,+,-,@ runs as a formula when the export opens in
 * Excel — and cell text here is attacker-influenced (customer names, titles,
 * SKUs, cashier names). Numbers/dates never pass through this.
 */
function cellStr(value: unknown): string {
  return escapeXml(neutralizeSpreadsheetFormula(value));
}

/** Hard export ceiling: callers catch `{code:'TOO_LARGE'}` and fall back to CSV/date slicing. */
export const MAX_EXCEL_ROWS = 200000;
export interface ExcelTooLargeError {
  code: 'TOO_LARGE';
  rowCount: number;
  limit: number;
}

function assertRowCap(rowCount: number): void {
  if (rowCount > MAX_EXCEL_ROWS) {
    const err: ExcelTooLargeError = { code: 'TOO_LARGE', rowCount, limit: MAX_EXCEL_ROWS };
    throw err;
  }
}

/** Yield to the UI thread between chunks so huge exports don't freeze the till. */
const yieldToUI = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

const SALES_ROW_CHUNK = 1000;

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
  /**
   * Average net ticket (round(Σ net(valid) / validCount), refunds excluded
   * from the denominator). Same definition as receiptMath.computeSalesMetrics.
   */
  averageBasket: number;
}

/**
 * Per-sheet print/freeze/tab polish: frozen header rows, landscape A4
 * fit-to-page, branded running header + page numbers, colored sheet tab.
 * `frozenRows` = number of top rows to lock (0 = none).
 * `filterRange` = AutoFilter range over the header row (e.g. "R7C1:R7C13").
 */
function worksheetOptionsXml(opts: {
  frozenRows: number;
  tabColorIndex: number;
  headerText: string;
  filterRange?: string;
}): string {
  const header = escapeXml(opts.headerText);
  const freeze =
    opts.frozenRows > 0
      ? `   <FreezePanes/>
   <FrozenNoSplit/>
   <SplitHorizontal>${opts.frozenRows}</SplitHorizontal>
   <TopRowBottomPane>${opts.frozenRows}</TopRowBottomPane>
   <ActivePane>2</ActivePane>`
      : `   <ActivePane>3</ActivePane>`;
  const filter = opts.filterRange
    ? `\n  <AutoFilter x:Range="${opts.filterRange}" xmlns="urn:schemas-microsoft-com:office:excel"/>`
    : '';
  return `  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <PageSetup>
    <Layout x:Orientation="Landscape" x:CenterHorizontal="1"/>
    <Header x:Data="&amp;C${header}"/>
    <Footer x:Data="&amp;LPage &amp;P / &amp;N&amp;R&amp;D — MOBI-POS"/>
    <PageMargins x:Bottom="0.5" x:Left="0.4" x:Right="0.4" x:Top="0.5" x:Header="0.3" x:Footer="0.3"/>
   </PageSetup>
   <FitToPage/>
   <Print>
    <FitWidth>1</FitWidth>
    <FitHeight>0</FitHeight>
    <ValidPrinterInfo/>
    <PaperSizeIndex>9</PaperSizeIndex>
    <HorizontalResolution>600</HorizontalResolution>
    <VerticalResolution>600</VerticalResolution>
   </Print>
${freeze}
   <TabColorIndex>${opts.tabColorIndex}</TabColorIndex>
   <ProtectObjects>False</ProtectObjects>
   <ProtectScenarios>False</ProtectScenarios>
  </WorksheetOptions>${filter}`;
}

function salesRowXml(
  t: SaleTransaction,
  index: number,
  allocCogsBySaleId?: AllocCogsLookup
): string {
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

    const customerName = cellStr(t.customer?.name || 'Client de passage');
    const itemCount = (t.items || []).reduce((acc, item) => acc + item.quantity, 0);
      const subtotal = grossFromTransaction(t);
    const discount = t.discountTotal || 0;
    // Canonical row policy (mirrors receiptMath.computeSalesMetrics):
    // STRICT FIFO LEDGER (v104) — the frozen allocation sum for this sale
    // wins, then the stored finite costTotal, otherwise 0 (never a
    // live-catalog estimate; the SQLite authority
    // getSalesProfitTotalsFromAllocations() sums the frozen ledger).
    // Net honours discounts/store-credit via netFromTransaction; profit is
    // always recomputed (net − cost) so rows sum to headline totals.
    const allocCost = (() => {
      if (!allocCogsBySaleId || !t.id) return undefined;
      const raw = allocCogsBySaleId instanceof Map ? allocCogsBySaleId.get(t.id) : allocCogsBySaleId[t.id];
      const v = Number(raw);
      return Number.isFinite(v) && v >= 0 ? v : undefined;
    })();
    const storedCost =
      typeof t.costTotal === 'number' && Number.isFinite(t.costTotal) ? t.costTotal : undefined;
    const cost = isVoided ? 0 : allocCost ?? storedCost ?? 0;
    const netTotal = isVoided ? 0 : isRefund ? -netFromTransaction(t) : netFromTransaction(t);
    const profit = isVoided || isRefund ? 0 : netTotal - cost;
    const margin = netTotal > 0 ? ((profit / netTotal) * 100).toFixed(1) : '0';

    return `<Row ss:Height="22">
    <Cell ss:StyleID="${rowStyleCenter}"><Data ss:Type="String">${cellStr(t.receiptNumber)}</Data></Cell>
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
    <Cell ss:StyleID="${rowStyleCenter}"><Data ss:Type="String">${cellStr(t.paymentMethod || 'Espèces')}</Data></Cell>
    <Cell ss:StyleID="${rowStyleCenter}"><Data ss:Type="String">${cellStr(t.cashierName || 'Yacine (Caisse 1)')}</Data></Cell>
   </Row>`;
}

function salesTableXml(dataRows: string, transactions: SaleTransaction[], metrics: ExcelMetrics): string {
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
     <Cell ss:MergeAcross="2" ss:StyleID="KpiValue"><Data ss:Type="String">${metrics.averageBasket.toLocaleString('fr-DZ')} DA</Data></Cell>
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
  ${worksheetOptionsXml({
    frozenRows: 7,
    tabColorIndex: 4,
    headerText: "MOBI-POS — Journal des Ventes",
    filterRange: 'R7C1:R7C13',
  })}
 </Worksheet>`;
}

export function buildSalesWorksheet(
  transactions: SaleTransaction[],
  metrics: ExcelMetrics,
  allocCogsBySaleId?: AllocCogsLookup
): string {
  assertRowCap(transactions.length);
  const dataRows = transactions.map((t, index) => salesRowXml(t, index, allocCogsBySaleId)).join('\n');
  return salesTableXml(dataRows, transactions, metrics);
}

/** Chunked async variant: yields to the UI every chunk, byte-identical output. */
export async function buildSalesWorksheetAsync(
  transactions: SaleTransaction[],
  metrics: ExcelMetrics,
  allocCogsBySaleId?: AllocCogsLookup
): Promise<string> {
  assertRowCap(transactions.length);
  const parts: string[] = [];
  for (let i = 0; i < transactions.length; i += SALES_ROW_CHUNK) {
    const chunk = transactions.slice(i, i + SALES_ROW_CHUNK);
    parts.push(chunk.map((t, j) => salesRowXml(t, i + j, allocCogsBySaleId)).join('\n'));
    await yieldToUI();
  }
  return salesTableXml(parts.join('\n'), transactions, metrics);
}

function itemRowXml(
  t: SaleTransaction,
  item: NonNullable<SaleTransaction['items']>[number],
  idx: number
): string {
  const p = item.product;
  const isZebra = idx % 2 === 1;
  const unitPrice = item.appliedPrice || p?.price || 0;
  // STRICT FIFO LEDGER (v104): display the frozen checkout cost when present
  // (unitCostAtSale == ledger unit_cost), catalog reference only as display
  // fallback for pre-ledger rows — never aggregated as COGS.
  const frozenUnit = Number(item.unitCostAtSale ?? item.unitCostPrice ?? NaN);
  const costPrice = Number.isFinite(frozenUnit) && frozenUnit >= 0
    ? frozenUnit
    : (p ? getEffectiveCostPrice(p) : getEffectiveCostPrice({ price: unitPrice }));
  const lineTotal = unitPrice * item.quantity;

  return `<Row ss:Height="20">
    <Cell ss:StyleID="${isZebra ? 'RowZebraCenter' : 'RowCenter'}"><Data ss:Type="String">${cellStr(t.receiptNumber)}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraCenter' : 'RowCenter'}"><Data ss:Type="String">${escapeXml(formatDateTime(t.createdAt))}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraCenter' : 'RowCenter'}"><Data ss:Type="String">${cellStr(p?.sku || 'N/A')}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraCenter' : 'RowCenter'}"><Data ss:Type="String">${cellStr(p?.barcode || 'N/A')}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraLeft' : 'RowLeft'}"><Data ss:Type="String">${cellStr(p?.title || 'Article')}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraLeft' : 'RowLeft'}"><Data ss:Type="String">${cellStr(p?.category || 'Accessoires')}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraCenter' : 'RowCenter'}"><Data ss:Type="Number">${item.quantity}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraCurrency' : 'RowCurrency'}"><Data ss:Type="Number">${unitPrice}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraCurrency' : 'RowCurrency'}"><Data ss:Type="Number">${costPrice}</Data></Cell>
    <Cell ss:StyleID="${isZebra ? 'RowZebraCurrency' : 'RowCurrency'}"><Data ss:Type="Number">${lineTotal}</Data></Cell>
   </Row>`;
}

function countItemRows(transactions: SaleTransaction[]): number {
  let n = 0;
  for (const t of transactions) {
    if (t.status === 'VOIDED') continue;
    n += (t.items || []).length;
  }
  return n;
}

export function buildItemsWorksheet(transactions: SaleTransaction[]): string {
  assertRowCap(countItemRows(transactions));
  const itemRows = transactions
    .flatMap((t) => {
      if (t.status === 'VOIDED') return [];
      return (t.items || []).map((item, idx) => itemRowXml(t, item, idx));
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
  ${worksheetOptionsXml({
    frozenRows: 2,
    tabColorIndex: 8,
    headerText: "MOBI-POS — Détail des Articles",
    filterRange: 'R2C1:R2C10',
  })}
 </Worksheet>`;
}

 /** Chunked async variant: chunked per transaction (zebra parity preserved), byte-identical output. */
export async function buildItemsWorksheetAsync(transactions: SaleTransaction[]): Promise<string> {
  assertRowCap(countItemRows(transactions));
  const parts: string[] = [];
  for (let i = 0; i < transactions.length; i += SALES_ROW_CHUNK) {
    const chunk = transactions.slice(i, i + SALES_ROW_CHUNK);
    parts.push(
      chunk
        .flatMap((t) => {
          if (t.status === 'VOIDED') return [];
          return (t.items || []).map((item, idx) => itemRowXml(t, item, idx));
        })
        .join('\n')
    );
    await yieldToUI();
  }
  const itemRows = parts.filter((p) => p.length > 0).join('\n');
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
  ${worksheetOptionsXml({
    frozenRows: 2,
    tabColorIndex: 8,
    headerText: "MOBI-POS — Détail des Articles",
    filterRange: 'R2C1:R2C10',
  })}
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
    <Cell ss:StyleID="RowLeft"><Data ss:Type="String">${cellStr(method)}</Data></Cell>
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
    <Cell ss:StyleID="HeaderRowGold"><Data ss:Type="String">Mode de Paiement</Data></Cell>
    <Cell ss:StyleID="HeaderRowGold"><Data ss:Type="String">Nb Transactions</Data></Cell>
    <Cell ss:StyleID="HeaderRowGold"><Data ss:Type="String">Montant Total Encaissé</Data></Cell>
    <Cell ss:StyleID="HeaderRowGold"><Data ss:Type="String">Part du CA %</Data></Cell>
   </Row>
   ${rows}
   <Row ss:Height="26">
    <Cell ss:StyleID="TotalSummaryRow"><Data ss:Type="String">TOTAL TOUS MODES</Data></Cell>
    <Cell ss:StyleID="TotalSummaryRow"><Data ss:Type="Number">${validSalesCount}</Data></Cell>
    <Cell ss:StyleID="TotalSummaryCurrency"><Data ss:Type="Number">${totalNetRevenue}</Data></Cell>
    <Cell ss:StyleID="TotalSummaryRow"><Data ss:Type="String">100.0%</Data></Cell>
   </Row>
  </Table>
  ${worksheetOptionsXml({
    frozenRows: 2,
    tabColorIndex: 6,
    headerText: 'MOBI-POS — Synthèse Règlements',
  })}
 </Worksheet>`;
}

/**
 * Cover dashboard ("Sommaire"): branded title, export context, KPI cards and
 * the payment-mix mini table. Always the first (active) worksheet.
 */
export function buildCoverWorksheet(
  metrics: ExcelMetrics,
  paymentBreakdown: Record<string, { count: number; total: number }>,
  transactionCount: number
): string {
  const avgBasket = metrics.averageBasket;
  const mixRows = Object.entries(paymentBreakdown)
    .map(([method, item]) => {
      const share = metrics.totalNetRevenue > 0 ? ((item.total / metrics.totalNetRevenue) * 100).toFixed(1) : '0';
      return `<Row ss:Height="22">
    <Cell ss:StyleID="RowLeft"><Data ss:Type="String">${cellStr(method)}</Data></Cell>
    <Cell ss:StyleID="RowCenter"><Data ss:Type="Number">${item.count}</Data></Cell>
    <Cell ss:StyleID="RowCurrency"><Data ss:Type="Number">${item.total}</Data></Cell>
    <Cell ss:StyleID="RowCenter"><Data ss:Type="String">${share}%</Data></Cell>
   </Row>`;
    })
    .join('\n');

  return ` <Worksheet ss:Name="Sommaire">
  <Table ss:ExpandedColumnCount="4" x:FullColumns="1" x:FullRows="1" ss:DefaultRowHeight="20">
   <Column ss:Width="220"/><Column ss:Width="150"/><Column ss:Width="170"/><Column ss:Width="130"/>
   <Row ss:Height="38"><Cell ss:MergeAcross="3" ss:StyleID="CoverTitle"><Data ss:Type="String">  MOBI-POS ENTERPRISE — RAPPORT COMMERCIAL</Data></Cell></Row>
   <Row ss:Height="22"><Cell ss:MergeAcross="3" ss:StyleID="CoverSub"><Data ss:Type="String">  Export généré le : ${escapeXml(metrics.exportDate)}  |  Période : ${escapeXml(metrics.periodLabel)}  |  Transactions : ${transactionCount}</Data></Cell></Row>
   <Row ss:Height="12"/>
   <Row ss:Height="20">
    <Cell ss:StyleID="CoverKpiLabel"><Data ss:Type="String">CHIFFRE D'AFFAIRES NET</Data></Cell>
    <Cell ss:StyleID="CoverKpiLabel"><Data ss:Type="String">BÉNÉFICE COMMERCIAL</Data></Cell>
    <Cell ss:StyleID="CoverKpiLabel"><Data ss:Type="String">PANIER MOYEN CLIENT</Data></Cell>
    <Cell ss:StyleID="CoverKpiLabel"><Data ss:Type="String">MARGE MOYENNE</Data></Cell>
   </Row>
   <Row ss:Height="30">
    <Cell ss:StyleID="CoverKpiValue"><Data ss:Type="String">${metrics.totalNetRevenue.toLocaleString('fr-DZ')} DA</Data></Cell>
    <Cell ss:StyleID="CoverKpiValue"><Data ss:Type="String">${metrics.totalProfit.toLocaleString('fr-DZ')} DA</Data></Cell>
    <Cell ss:StyleID="CoverKpiValue"><Data ss:Type="String">${avgBasket.toLocaleString('fr-DZ')} DA</Data></Cell>
    <Cell ss:StyleID="CoverKpiValue"><Data ss:Type="String">${metrics.avgMargin} %</Data></Cell>
   </Row>
   <Row ss:Height="12"/>
   <Row ss:Height="26"><Cell ss:MergeAcross="3" ss:StyleID="HeaderRowGold"><Data ss:Type="String">ENCAISSEMENTS PAR MODE DE RÈGLEMENT</Data></Cell></Row>
   <Row ss:Height="24">
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Mode de Paiement</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Nb Transactions</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Montant Encaissé</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Part du CA</Data></Cell>
   </Row>
   ${mixRows}
   <Row ss:Height="12"/>
   <Row ss:Height="30"><Cell ss:MergeAcross="3" ss:StyleID="CoverNote"><Data ss:Type="String">Contenu du classeur — Journal des Ventes : chaque ticket avec statuts, remises, coûts et marges • Détail des Articles : lignes produits, SKU et codes-barres • Synthèse Règlements : encaissements par mode de paiement. Montants en Dinars Algériens (DA). Document généré automatiquement par Mobi-POS.</Data></Cell></Row>
  </Table>
  ${worksheetOptionsXml({
    frozenRows: 0,
    tabColorIndex: 5,
    headerText: 'MOBI-POS — Sommaire',
  })}
 </Worksheet>`;
}

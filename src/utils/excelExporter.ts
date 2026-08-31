import type { SaleTransaction } from '../types/pos';
import { formatDateTime } from '../types/pos';

/**
 * Generates an ultra-professional, multi-sheet, color-coded Microsoft Excel XML (SpreadsheetML) file.
 * Compatible with Microsoft Excel (all versions), Apple Numbers, LibreOffice Calc, and Google Sheets.
 */
export function generateProfessionalExcelXml(
  transactions: SaleTransaction[],
  periodLabel: string = "Toutes les dates"
): string {
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
  const totalCost = validSales.reduce((acc, t) => acc + (t.costTotal || t.total * 0.5), 0);
  const totalProfit = totalNetRevenue - totalCost;
  const avgMargin = totalNetRevenue > 0 ? ((totalProfit / totalNetRevenue) * 100).toFixed(1) : '0';

  // Group by payment method for Sheet 3
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
 <Styles>
  <!-- Default Normal Style -->
  <Style ss:ID="Default" ss:Name="Normal">
   <Alignment ss:Vertical="Center"/>
   <Borders/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="11" ss:Color="#0F172A"/>
   <Interior/>
   <NumberFormat/>
   <Protection/>
  </Style>

  <!-- Big Title Banner -->
  <Style ss:ID="TitleBanner">
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="16" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#064E3B" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#047857"/>
   </Borders>
  </Style>

  <!-- Subtitle Info -->
  <Style ss:ID="Subtitle">
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="10" ss:Italic="1" ss:Color="#D1FAE5"/>
   <Interior ss:Color="#064E3B" ss:Pattern="Solid"/>
  </Style>

  <!-- KPI Box Header -->
  <Style ss:ID="KpiHeader">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="9" ss:Bold="1" ss:Color="#475569"/>
   <Interior ss:Color="#F1F5F9" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
   </Borders>
  </Style>

  <!-- KPI Box Value -->
  <Style ss:ID="KpiValue">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="13" ss:Bold="1" ss:Color="#065F46"/>
   <Interior ss:Color="#ECFDF5" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
   </Borders>
  </Style>

  <!-- Main Table Header (Emerald) -->
  <Style ss:ID="HeaderRow">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#047857" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#064E3B"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#064E3B"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#059669"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#059669"/>
   </Borders>
  </Style>

  <!-- Secondary Table Header (Sky Blue) -->
  <Style ss:ID="HeaderRowSky">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#0284C7" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#0369A1"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#0369A1"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#38BDF8"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#38BDF8"/>
   </Borders>
  </Style>

  <!-- Standard Row Left -->
  <Style ss:ID="RowLeft">
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>

  <!-- Standard Row Center -->
  <Style ss:ID="RowCenter">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>

  <!-- Standard Row Currency (DZD) -->
  <Style ss:ID="RowCurrency">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="11" ss:Bold="1" ss:Color="#0F172A"/>
   <NumberFormat ss:Format="#,##0 &quot;DA&quot;"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>

  <!-- Profit Currency (Cyan / Emerald) -->
  <Style ss:ID="RowProfit">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="11" ss:Bold="1" ss:Color="#059669"/>
   <NumberFormat ss:Format="#,##0 &quot;DA&quot;"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>

  <!-- Alternate Zebra Row Left -->
  <Style ss:ID="RowZebraLeft">
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>
   <Interior ss:Color="#F8FAFC" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>

  <!-- Alternate Zebra Row Center -->
  <Style ss:ID="RowZebraCenter">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Interior ss:Color="#F8FAFC" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>

  <!-- Alternate Zebra Row Currency -->
  <Style ss:ID="RowZebraCurrency">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="11" ss:Bold="1" ss:Color="#0F172A"/>
   <Interior ss:Color="#F8FAFC" ss:Pattern="Solid"/>
   <NumberFormat ss:Format="#,##0 &quot;DA&quot;"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>

  <!-- Alternate Zebra Row Profit -->
  <Style ss:ID="RowZebraProfit">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="11" ss:Bold="1" ss:Color="#059669"/>
   <Interior ss:Color="#F8FAFC" ss:Pattern="Solid"/>
   <NumberFormat ss:Format="#,##0 &quot;DA&quot;"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>

  <!-- Voided / Annulé Row Style (Rose/Red) -->
  <Style ss:ID="RowVoided">
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="10" ss:StrikeThrough="1" ss:Color="#991B1B"/>
   <Interior ss:Color="#FEE2E2" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FCA5A5"/>
   </Borders>
  </Style>

  <Style ss:ID="RowVoidedCurrency">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="10" ss:StrikeThrough="1" ss:Color="#991B1B"/>
   <Interior ss:Color="#FEE2E2" ss:Pattern="Solid"/>
   <NumberFormat ss:Format="#,##0 &quot;DA&quot;"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FCA5A5"/>
   </Borders>
  </Style>

  <!-- Refunded / Avoir Row Style (Purple) -->
  <Style ss:ID="RowRefund">
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="10" ss:Bold="1" ss:Color="#6B21A8"/>
   <Interior ss:Color="#F3E8FF" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D8B4FE"/>
   </Borders>
  </Style>

  <Style ss:ID="RowRefundCurrency">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="10" ss:Bold="1" ss:Color="#6B21A8"/>
   <Interior ss:Color="#F3E8FF" ss:Pattern="Solid"/>
   <NumberFormat ss:Format="#,##0 &quot;DA&quot;"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D8B4FE"/>
   </Borders>
  </Style>

  <!-- Grand Total Summary Row (Dark Emerald) -->
  <Style ss:ID="TotalSummaryRow">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="12" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#064E3B" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#047857"/>
    <Border ss:Position="Bottom" ss:LineStyle="Double" ss:Weight="3" ss:Color="#047857"/>
   </Borders>
  </Style>

  <Style ss:ID="TotalSummaryCurrency">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="12" ss:Bold="1" ss:Color="#34D399"/>
   <Interior ss:Color="#064E3B" ss:Pattern="Solid"/>
   <NumberFormat ss:Format="#,##0 &quot;DA&quot;"/>
   <Borders>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#047857"/>
    <Border ss:Position="Bottom" ss:LineStyle="Double" ss:Weight="3" ss:Color="#047857"/>
   </Borders>
  </Style>
 </Styles>

 <!-- ══════════════════════════════════════════════════════════ -->
 <!-- WORKSHEET 1: JOURNAL DES VENTES & REÇUS                   -->
 <!-- ══════════════════════════════════════════════════════════ -->
 <Worksheet ss:Name="Journal des Ventes">
  <Table ss:ExpandedColumnCount="13" x:FullColumns="1" x:FullRows="1" ss:DefaultRowHeight="20">
   <Column ss:Width="110"/>
   <Column ss:Width="95"/>
   <Column ss:Width="130"/>
   <Column ss:Width="140"/>
   <Column ss:Width="70"/>
   <Column ss:Width="95"/>
   <Column ss:Width="85"/>
   <Column ss:Width="105"/>
   <Column ss:Width="95"/>
   <Column ss:Width="100"/>
   <Column ss:Width="75"/>
   <Column ss:Width="105"/>
   <Column ss:Width="100"/>

   <!-- Row 1: Title Banner -->
   <Row ss:Height="30">
    <Cell ss:MergeAcross="12" ss:StyleID="TitleBanner">
     <Data ss:Type="String">  MOBI-POS ENTERPRISE — JOURNAL GÉNÉRAL DES VENTES ET REÇUS</Data>
    </Cell>
   </Row>

   <!-- Row 2: Subtitle Info -->
   <Row ss:Height="20">
    <Cell ss:MergeAcross="12" ss:StyleID="Subtitle">
     <Data ss:Type="String">  Export généré le : ${escapeXml(exportDate)}  |  Période : ${escapeXml(periodLabel)}  |  Total Transactions : ${transactions.length}</Data>
    </Cell>
   </Row>

   <!-- Row 3: Blank Spacer -->
   <Row ss:Height="10"/>

   <!-- Row 4: KPI Headers -->
   <Row ss:Height="18">
    <Cell ss:MergeAcross="1" ss:StyleID="KpiHeader"><Data ss:Type="String">TOTAL TRANSACTIONS</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiHeader"><Data ss:Type="String">CHIFFRE D'AFFAIRES NET</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiHeader"><Data ss:Type="String">BÉNÉFICE COMMERCIAL NET</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiHeader"><Data ss:Type="String">PANIER MOYEN CLIENT</Data></Cell>
    <Cell ss:MergeAcross="1" ss:StyleID="KpiHeader"><Data ss:Type="String">MARGE MOYENNE %</Data></Cell>
   </Row>

   <!-- Row 5: KPI Values -->
   <Row ss:Height="25">
    <Cell ss:MergeAcross="1" ss:StyleID="KpiValue"><Data ss:Type="Number">${transactions.length}</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiValue"><Data ss:Type="String">${totalNetRevenue.toLocaleString('fr-DZ')} DA</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiValue"><Data ss:Type="String">${totalProfit.toLocaleString('fr-DZ')} DA</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiValue"><Data ss:Type="String">${Math.round(totalNetRevenue / Math.max(1, validSales.length)).toLocaleString('fr-DZ')} DA</Data></Cell>
    <Cell ss:MergeAcross="1" ss:StyleID="KpiValue"><Data ss:Type="String">${avgMargin}%</Data></Cell>
   </Row>

   <!-- Row 6: Blank Spacer -->
   <Row ss:Height="15"/>

   <!-- Row 7: Main Table Headers -->
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

   <!-- Dynamic Transaction Data Rows -->
   ${transactions
     .map((t, index) => {
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
       const itemCount = t.items.reduce((acc, item) => acc + item.quantity, 0);
       const subtotal = t.subtotal || t.total;
       const discount = t.discountTotal || 0;
       const cost = isVoided ? 0 : t.costTotal || t.total * 0.5;
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
     })
     .join('\n')}

   <!-- Grand Total Summary Row -->
   <Row ss:Height="26">
    <Cell ss:MergeAcross="6" ss:StyleID="TotalSummaryRow"><Data ss:Type="String">TOTAL GÉNÉRAL COMPTABLE (DA)</Data></Cell>
    <Cell ss:StyleID="TotalSummaryCurrency"><Data ss:Type="Number">${totalNetRevenue}</Data></Cell>
    <Cell ss:StyleID="TotalSummaryCurrency"><Data ss:Type="Number">${totalCost}</Data></Cell>
    <Cell ss:StyleID="TotalSummaryCurrency"><Data ss:Type="Number">${totalProfit}</Data></Cell>
    <Cell ss:StyleID="TotalSummaryRow"><Data ss:Type="String">${avgMargin}%</Data></Cell>
    <Cell ss:MergeAcross="1" ss:StyleID="TotalSummaryRow"><Data ss:Type="String">—</Data></Cell>
   </Row>
  </Table>
 </Worksheet>

 <!-- ══════════════════════════════════════════════════════════ -->
 <!-- WORKSHEET 2: DÉTAIL DES ARTICLES VENDUS                   -->
 <!-- ══════════════════════════════════════════════════════════ -->
 <Worksheet ss:Name="Détail des Articles">
  <Table ss:ExpandedColumnCount="10" x:FullColumns="1" x:FullRows="1" ss:DefaultRowHeight="20">
   <Column ss:Width="110"/>
   <Column ss:Width="100"/>
   <Column ss:Width="100"/>
   <Column ss:Width="120"/>
   <Column ss:Width="230"/>
   <Column ss:Width="120"/>
   <Column ss:Width="65"/>
   <Column ss:Width="105"/>
   <Column ss:Width="105"/>
   <Column ss:Width="115"/>

   <Row ss:Height="28">
    <Cell ss:MergeAcross="9" ss:StyleID="TitleBanner">
     <Data ss:Type="String">  MOBI-POS — EXTRACTION DÉTAILLÉE DES LIGNES D'ARTICLES VENDUS</Data>
    </Cell>
   </Row>

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

   ${transactions
     .flatMap((t) => {
       if (t.status === 'VOIDED') return [];
       return (t.items || []).map((item, idx) => {
         const p = item.product;
         const isZebra = idx % 2 === 1;
         const unitPrice = item.appliedPrice || p?.price || 0;
         const costPrice = p?.costPrice || Math.round(unitPrice * 0.5);
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
     .join('\n')}
  </Table>
 </Worksheet>

 <!-- ══════════════════════════════════════════════════════════ -->
 <!-- WORKSHEET 3: SYNTHÈSE DES MODES DE PAIEMENT               -->
 <!-- ══════════════════════════════════════════════════════════ -->
 <Worksheet ss:Name="Synthèse Règlements">
  <Table ss:ExpandedColumnCount="4" x:FullColumns="1" x:FullRows="1" ss:DefaultRowHeight="22">
   <Column ss:Width="160"/>
   <Column ss:Width="120"/>
   <Column ss:Width="140"/>
   <Column ss:Width="100"/>

   <Row ss:Height="28">
    <Cell ss:MergeAcross="3" ss:StyleID="TitleBanner">
     <Data ss:Type="String">  MOBI-POS — SYNTHÈSE DES ENCAISSEMENTS PAR MODE DE RÈGLEMENT</Data>
    </Cell>
   </Row>

   <Row ss:Height="26">
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Mode de Paiement</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Nb Transactions</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Montant Total Encaissé</Data></Cell>
    <Cell ss:StyleID="HeaderRow"><Data ss:Type="String">Part du CA %</Data></Cell>
   </Row>

   ${Object.entries(paymentBreakdown)
     .map(([method, data]) => {
       const share = totalNetRevenue > 0 ? ((data.total / totalNetRevenue) * 100).toFixed(1) : '0';
       return `<Row ss:Height="22">
    <Cell ss:StyleID="RowLeft"><Data ss:Type="String">${escapeXml(method)}</Data></Cell>
    <Cell ss:StyleID="RowCenter"><Data ss:Type="Number">${data.count}</Data></Cell>
    <Cell ss:StyleID="RowCurrency"><Data ss:Type="Number">${data.total}</Data></Cell>
    <Cell ss:StyleID="RowCenter"><Data ss:Type="String">${share}%</Data></Cell>
   </Row>`;
     })
     .join('\n')}

   <Row ss:Height="26">
    <Cell ss:StyleID="TotalSummaryRow"><Data ss:Type="String">TOTAL TOUS MODES</Data></Cell>
    <Cell ss:StyleID="TotalSummaryRow"><Data ss:Type="Number">${validSales.length}</Data></Cell>
    <Cell ss:StyleID="TotalSummaryCurrency"><Data ss:Type="Number">${totalNetRevenue}</Data></Cell>
    <Cell ss:StyleID="TotalSummaryRow"><Data ss:Type="String">100.0%</Data></Cell>
   </Row>
  </Table>
 </Worksheet>
</Workbook>`;
}

function escapeXml(unsafe?: string): string {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

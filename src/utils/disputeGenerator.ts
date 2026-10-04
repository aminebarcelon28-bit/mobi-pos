import { formatDZD } from '../types/pos';
import { buildWhatsAppUrl, normalizeAlgerianPhone } from './phoneUtils';
import type { EditableReviewLine } from '../types/po';

export type DisputeType =
  | 'MATH_DISCREPANCY'
  | 'PRICE_INFLATION'
  | 'QUANTITY_MISMATCH'
  | 'UNASSIGNED_LINE';

export interface DisputeItem {
  id: string;
  lineIndex: number;
  type: DisputeType;
  description: string;
  invoicedQuantity: number;
  invoicedUnitCost: number;
  expectedUnitCost: number;
  unitCostDelta: number;
  invoicedLineTotal: number;
  expectedLineTotal: number;
  claimAmount: number;
  reason: string;
}

export interface DisputeBrief {
  supplierName: string;
  supplierPhone: string;
  invoiceDate: string;
  invoiceNumber: string;
  totalLinesCount: number;
  disputedLinesCount: number;
  mathDelta: number;
  priceInflationDelta: number;
  totalClaimAmount: number;
  originalReportedTotal: number;
  adjustedPayableTotal: number;
  items: DisputeItem[];
  whatsAppTextFr: string;
  whatsAppTextAr: string;
  whatsAppUrlFr: string;
}

export interface CatalogReferenceItem {
  id: string;
  cost: number;
  price: number;
  name: string;
}

/**
 * Builds an enterprise-grade Vendor Dispute Brief from reviewed PO lines,
 * math state, and catalog reference prices.
 */
export function generateVendorDisputeBrief(params: {
  supplierName: string;
  supplierPhone?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  reportedGrandTotal: number;
  subtotal: number;
  mathDelta: number;
  faultyRows: Map<string, { expected: number; actual: number }>;
  lines: EditableReviewLine[];
  catalogMap: Map<string, CatalogReferenceItem>;
}): DisputeBrief {
  const {
    supplierName,
    supplierPhone = '',
    invoiceNumber = 'BL-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    invoiceDate = new Date().toLocaleDateString('fr-DZ', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }),
    reportedGrandTotal,
    mathDelta,
    faultyRows,
    lines,
    catalogMap,
  } = params;

  const items: DisputeItem[] = [];
  let priceInflationDelta = 0;

  lines.forEach((line, idx) => {
    const isFaulty = faultyRows.has(line.client_id);
    const catProd = line.selected_product_id ? catalogMap.get(line.selected_product_id) : undefined;
    const catCost = catProd && catProd.cost > 0 ? catProd.cost : line.unit_cost;
    const isInflated = catProd && catProd.cost > 0 && line.unit_cost > catProd.cost + 0.01;

    // 1. Math calculation discrepancy
    if (isFaulty) {
      const fault = faultyRows.get(line.client_id)!;
      const discrepancy = Math.round((fault.actual - fault.expected) * 100) / 100;
      items.push({
        id: `disp_math_${line.client_id}`,
        lineIndex: idx + 1,
        type: 'MATH_DISCREPANCY',
        description: line.raw_description,
        invoicedQuantity: line.quantity,
        invoicedUnitCost: line.unit_cost,
        expectedUnitCost: line.unit_cost,
        unitCostDelta: 0,
        invoicedLineTotal: fault.actual,
        expectedLineTotal: fault.expected,
        claimAmount: Math.abs(discrepancy),
        reason: `Erreur calcul ligne : ${line.quantity} pcs × ${formatDZD(line.unit_cost)} = ${formatDZD(fault.expected)} (facturé ${formatDZD(fault.actual)})`,
      });
    }

    // 2. Unit cost inflation over catalog purchase reference
    if (isInflated) {
      const unitDelta = Math.round((line.unit_cost - catCost) * 100) / 100;
      const totalLineClaim = Math.round(unitDelta * line.quantity * 100) / 100;
      priceInflationDelta += totalLineClaim;

      items.push({
        id: `disp_inf_${line.client_id}`,
        lineIndex: idx + 1,
        type: 'PRICE_INFLATION',
        description: line.raw_description,
        invoicedQuantity: line.quantity,
        invoicedUnitCost: line.unit_cost,
        expectedUnitCost: catCost,
        unitCostDelta: unitDelta,
        invoicedLineTotal: line.line_total,
        expectedLineTotal: Math.round(line.quantity * catCost * 100) / 100,
        claimAmount: totalLineClaim,
        reason: `Prix unitaire supérieur au tarif convenu : facturé à ${formatDZD(line.unit_cost)} au lieu de ${formatDZD(catCost)} (+${formatDZD(unitDelta)}/u)`,
      });
    }
  });

  // Total credit claim is sum of price inflation plus absolute document math delta
  const docMathDiscrepancy = Math.abs(mathDelta) > 0.01 ? Math.abs(mathDelta) : 0;
  const totalClaimAmount = Math.round((priceInflationDelta + docMathDiscrepancy) * 100) / 100;
  const adjustedPayableTotal = Math.max(0, Math.round((reportedGrandTotal - totalClaimAmount) * 100) / 100);

  // Compose French WhatsApp Message
  const linesBulletListFr = items.length > 0
    ? items.map((it) => `• *${it.description}* (x${it.invoicedQuantity}) : ${it.reason} → *Écart : ${formatDZD(it.claimAmount)}*`).join('\n')
    : `• *Écart arithmétique global du document :* ${formatDZD(docMathDiscrepancy)}`;

  const whatsAppTextFr = `*⚠️ RÉCLAMATION & CONTESTATION FACTURE*
📦 *Fournisseur :* ${supplierName}
📄 *N° Document :* ${invoiceNumber}
📅 *Date de réception :* ${invoiceDate}

Bonjour, suite au contrôle contradictoire automatisé de la facture à la réception du stock, nous relevons les anomalies suivantes :

${linesBulletListFr}

📊 *BILAN FINANCIER DU LITIGE :*
• Montant Facture initiale : *${formatDZD(reportedGrandTotal)}*
• Surfacturation / Écarts constatés : *${formatDZD(totalClaimAmount)}*
• *Montant de l'AVOIR (Note de Crédit) Réclamé : ${formatDZD(totalClaimAmount)}*
• *Net à payer après déduction : ${formatDZD(adjustedPayableTotal)}*

Merci d'établir l'avoir correspondant ou de nous renvoyer le bon rectifié afin de valider le règlement.
Cordialement,
_Service Achats & Réception Stock_`;

  // Compose Algerian Arabic WhatsApp Message
  const whatsAppTextAr = `*⚠️ إشعار اعتراض ومراجعة فاتورة المورد*
📦 *المورد :* ${supplierName}
📄 *رقم الوثيقة :* ${invoiceNumber}
📅 *تاريخ الاستلام :* ${invoiceDate}

السلام عليكم، بعد المراقبة الآلية لفاتورة استلام السلع، تم تسجيل الفروقات التالية :

${items.length > 0 ? items.map((it) => `• *${it.description}* (الكمية ${it.invoicedQuantity}) : ${it.reason}`).join('\n') : `• فارق حسابي إجمالي قدره : ${formatDZD(docMathDiscrepancy)}`}

📊 *الخلاصة المالية للطعن :*
• إجمالي الفاتورة المسجلة : *${formatDZD(reportedGrandTotal)}*
• قيمة الفارق المطلوب خصمه (Avoir) : *${formatDZD(totalClaimAmount)}*
• *المبلغ الصافي المستحق بعد الخصم : ${formatDZD(adjustedPayableTotal)}*

يرجى إرسال وصل التخفيض (Avoir) أو تعديل الفاتورة لإتمام الدفع.
شكراً.`;

  const cleanPhone = normalizeAlgerianPhone(supplierPhone).whatsAppFormat || supplierPhone.replace(/\D/g, '');
  const whatsAppUrlFr = buildWhatsAppUrl(cleanPhone, whatsAppTextFr);

  return {
    supplierName,
    supplierPhone,
    invoiceDate,
    invoiceNumber,
    totalLinesCount: lines.length,
    disputedLinesCount: items.length,
    mathDelta,
    priceInflationDelta,
    totalClaimAmount,
    originalReportedTotal: reportedGrandTotal,
    adjustedPayableTotal,
    items,
    whatsAppTextFr,
    whatsAppTextAr,
    whatsAppUrlFr,
  };
}

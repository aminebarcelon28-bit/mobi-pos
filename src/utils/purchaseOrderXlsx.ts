/**
 * purchaseOrderXlsx — True Office Open XML (.xlsx) exporter for supplier
 * purchase orders (Bon de commande).
 *
 * Zero-dependency: builds a minimal OOXML package with STORE-only ZIP so it
 * works offline in the browser / Tauri WebView without extra npm packages.
 *
 * Features:
 * - Branded emerald header row (#047857, white bold)
 * - Clean thin table borders (#E2E8F0) + zebra striping
 * - Auto-fitted column widths from content length
 * - Currency formatting `#,##0 "DA"` for unit prices & line amounts
 * - Dynamic formulas: line amount `=D{row}*E{row}`, grand total `=SUM(F..:F..)`
 * - Side-by-side signature / stamp boxes for both parties (merged cells)
 */
import type { PurchaseOrder } from '../types/pos';
import { formatDateTime } from '../types/pos';

export interface PurchaseOrderStoreInfo {
  storeName?: string;
  address?: string;
  phone?: string;
  email?: string;
}

export interface PurchaseOrderItemData {
  productId?: string;
  title: string;
  sku?: string;
  suggestedQty: number;
  unitCost: number;
  totalCost?: number;
}

export interface PurchaseOrderExportData {
  poNumber: string;
  vendorName: string;
  createdAt?: string | number | Date | null;
  notes?: string;
  items: PurchaseOrderItemData[];
  totalAmount?: number;
}

function escapeXml(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colLetter(indexZeroBased: number): string {
  let n = indexZeroBased + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* ── CRC32 (IEEE 802.3) ─────────────────────────────────────────── */
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ── Minimal STORE-only ZIP writer ──────────────────────────────── */
interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function buildZipStore(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const push = (buf: Uint8Array): void => {
    chunks.push(buf);
    offset += buf.length;
  };

  const centralStart = { value: 0 };

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(4, 20, true);
    localHeader.setUint16(6, 0x0800, true); // UTF-8 filenames
    localHeader.setUint16(8, 0, true); // STORE
    localHeader.setUint16(10, 0, true);
    localHeader.setUint16(12, 0x2821, true);
    localHeader.setUint32(14, crc, true);
    localHeader.setUint32(18, size, true);
    localHeader.setUint32(22, size, true);
    localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true);

    const localOffset = offset;
    push(new Uint8Array(localHeader.buffer));
    push(nameBytes);
    push(entry.data);

    const cdHeader = new DataView(new ArrayBuffer(46));
    cdHeader.setUint32(0, 0x02014b50, true);
    cdHeader.setUint16(4, 20, true);
    cdHeader.setUint16(6, 20, true);
    cdHeader.setUint16(8, 0x0800, true);
    cdHeader.setUint16(10, 0, true);
    cdHeader.setUint16(12, 0, true);
    cdHeader.setUint16(14, 0x2821, true);
    cdHeader.setUint32(16, crc, true);
    cdHeader.setUint32(20, size, true);
    cdHeader.setUint32(24, size, true);
    cdHeader.setUint16(28, nameBytes.length, true);
    cdHeader.setUint16(30, 0, true);
    cdHeader.setUint16(32, 0, true);
    cdHeader.setUint16(34, 0, true);
    cdHeader.setUint16(36, 0, true);
    cdHeader.setUint32(38, 0, true);
    cdHeader.setUint32(42, localOffset, true);
    central.push(new Uint8Array(cdHeader.buffer));
    central.push(nameBytes);
    void centralStart;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const c of central) {
    chunks.push(c);
    centralSize += c.length;
  }
  offset += centralSize;

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralOffset, true);
  end.setUint16(20, 0, true);
  chunks.push(new Uint8Array(end.buffer));

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/* ── OOXML parts ────────────────────────────────────────────────── */

function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0 &quot;DA&quot;"/></numFmts>
 <fonts count="8">
  <font><sz val="11"/><color rgb="FF0F172A"/><name val="Calibri"/><family val="2"/></font>
  <font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
  <font><i/><sz val="10"/><color rgb="FFD1FAE5"/><name val="Calibri"/><family val="2"/></font>
  <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
  <font><b/><sz val="11"/><color rgb="FF0F172A"/><name val="Calibri"/><family val="2"/></font>
  <font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
  <font><b/><sz val="12"/><color rgb="FF34D399"/><name val="Calibri"/><family val="2"/></font>
  <font><b/><sz val="9"/><color rgb="FF475569"/><name val="Calibri"/><family val="2"/></font>
 </fonts>
 <fills count="7">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF064E3B"/><bgColor indexed="64"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF047857"/><bgColor indexed="64"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/><bgColor indexed="64"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill>
 </fills>
 <borders count="5">
  <border><left/><right/><top/><bottom/><diagonal/></border>
  <border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right><top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border>
  <border><left style="thin"><color rgb="FF065F46"/></left><right style="thin"><color rgb="FF065F46"/></right><top style="thin"><color rgb="FF065F46"/></top><bottom style="thin"><color rgb="FF065F46"/></bottom><diagonal/></border>
  <border><left style="thin"><color rgb="FF047857"/></left><right style="thin"><color rgb="FF047857"/></right><top style="medium"><color rgb="FF047857"/></top><bottom style="double"><color rgb="FF047857"/></bottom><diagonal/></border>
  <border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom><diagonal/></border>
 </borders>
 <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
 <cellXfs count="14">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="center"/></xf>
  <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment horizontal="left" vertical="center"/></xf>
  <xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment horizontal="left" vertical="center"/></xf>
  <xf numFmtId="0" fontId="3" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
  <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment horizontal="left" vertical="center"/></xf>
  <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
  <xf numFmtId="164" fontId="4" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf>
  <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1"><alignment horizontal="left" vertical="center"/></xf>
  <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
  <xf numFmtId="164" fontId="4" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf>
  <xf numFmtId="0" fontId="5" fillId="2" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
  <xf numFmtId="164" fontId="6" fillId="2" borderId="3" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf>
  <xf numFmtId="0" fontId="7" fillId="5" borderId="4" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
  <xf numFmtId="0" fontId="0" fillId="6" borderId="4" xfId="0" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
 </cellXfs>
 <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

/* Cell helpers — inline strings keep the package free of sharedStrings. */
function strCell(ref: string, style: number, value: string): string {
  return `<c r="${ref}" t="inlineStr" s="${style}"><is><t>${escapeXml(value)}</t></is></c>`;
}

function numCell(ref: string, style: number, value: number): string {
  const v = Number.isFinite(value) ? value : 0;
  return `<c r="${ref}" t="n" s="${style}"><v>${v}</v></c>`;
}

function formulaCell(ref: string, style: number, formula: string, cached: number): string {
  const v = Number.isFinite(cached) ? cached : 0;
  return `<c r="${ref}" s="${style}"><f>${formula}</f><v>${v}</v></c>`;
}

export function purchaseOrderXlsxFilename(po: PurchaseOrderExportData | PurchaseOrder): string {
  const safeVendor = (po.vendorName || 'Fournisseur').replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '');
  return `Bon_Commande_${po.poNumber}_${safeVendor}.xlsx`;
}

export function buildPurchaseOrderXlsx(po: PurchaseOrderExportData | PurchaseOrder, store: PurchaseOrderStoreInfo = {}): Uint8Array {
  const enc = new TextEncoder();
  const storeName = store.storeName || 'MOBI ACCESSORIES';
  const items = po.items || [];

  /* Auto-fitted widths from content (Excel char units, clamped). */
  const maxTitle = items.reduce((m, i) => Math.max(m, (i.title || '').length), 12);
  const maxSku = items.reduce((m, i) => Math.max(m, (i.sku || '').length), 8);
  const wNo = 7;
  const wTitle = Math.min(62, Math.max(30, maxTitle + 4));
  const wSku = Math.min(26, Math.max(14, maxSku + 4));
  const wQty = 11;
  const wPu = 15;
  const wAmt = 17;

  const dateLabel = formatDateTime(po.createdAt ? String(po.createdAt) : undefined);
  const titleText = `BON DE COMMANDE  —  N° ${po.poNumber}`;
  const subtitleText = `${storeName}  •  ${dateLabel}  •  Fournisseur : ${po.vendorName}`;
  const buyerLine = `${storeName}${store.address ? ` — ${store.address}` : ''}${store.phone ? ` — Tél: ${store.phone}` : ''}`;

  const rows: string[] = [];
  const merges: string[] = [];

  // Row 1: branded title banner
  rows.push(
    `<row r="1" ht="30"><c r="A1" t="inlineStr" s="1"><is><t>${escapeXml(titleText)}</t></is></c>` +
      `<c r="B1" t="inlineStr" s="1"><is><t></t></is></c><c r="C1" t="inlineStr" s="1"><is><t></t></is></c>` +
      `<c r="D1" t="inlineStr" s="1"><is><t></t></is></c><c r="E1" t="inlineStr" s="1"><is><t></t></is></c>` +
      `<c r="F1" t="inlineStr" s="1"><is><t></t></is></c></row>`
  );
  merges.push('<mergeCell ref="A1:F1"/>');

  // Row 2: subtitle context
  rows.push(
    `<row r="2" ht="18"><c r="A2" t="inlineStr" s="2"><is><t>${escapeXml(subtitleText)}</t></is></c>` +
      `<c r="B2" t="inlineStr" s="2"><is><t></t></is></c><c r="C2" t="inlineStr" s="2"><is><t></t></is></c>` +
      `<c r="D2" t="inlineStr" s="2"><is><t></t></is></c><c r="E2" t="inlineStr" s="2"><is><t></t></is></c>` +
      `<c r="F2" t="inlineStr" s="2"><is><t></t></is></c></row>`
  );
  merges.push('<mergeCell ref="A2:F2"/>');

  // Row 3: buyer + supplier two-column info (left block A:C, right block D:F)
  rows.push(
    `<row r="3" ht="30">` +
      `${strCell('A3', 12, 'ACHETEUR — MAGASIN')}` +
      `${strCell('B3', 4, buyerLine)}` +
      `${strCell('C3', 4, '')}` +
      `${strCell('D3', 12, 'FOURNISSEUR')}` +
      `${strCell('E3', 4, po.vendorName)}` +
      `${strCell('F3', 4, '')}` +
      `</row>`
  );
  merges.push('<mergeCell ref="B3:C3"/>', '<mergeCell ref="E3:F3"/>');

  // Row 4: payment terms
  rows.push(
    `<row r="4" ht="16">` +
      `${strCell('A4', 4, 'Règlement :')}` +
      `${strCell('B4', 4, 'Paiement à réception / Espèces')}` +
      `${strCell('C4', 4, '')}` +
      `${strCell('D4', 4, po.notes ? `Notes : ${po.notes}` : '')}` +
      `${strCell('E4', 4, '')}` +
      `${strCell('F4', 4, '')}` +
      `</row>`
  );
  merges.push('<mergeCell ref="B4:C4"/>', '<mergeCell ref="D4:F4"/>');

  // Row 5: spacer
  rows.push(`<row r="5" ht="6"></row>`);

  // Row 6: branded table header
  const headerRow = 6;
  rows.push(
    `<row r="${headerRow}" ht="24">` +
      `${strCell(`A${headerRow}`, 3, 'N°')}` +
      `${strCell(`B${headerRow}`, 3, 'Désignation')}` +
      `${strCell(`C${headerRow}`, 3, 'SKU')}` +
      `${strCell(`D${headerRow}`, 3, 'Qté')}` +
      `${strCell(`E${headerRow}`, 3, 'P.U. (DA)')}` +
      `${strCell(`F${headerRow}`, 3, 'Montant (DA)')}` +
      `</row>`
  );

  // Item rows start at 7
  const firstItemRow = headerRow + 1;
  items.forEach((item, idx) => {
    const r = firstItemRow + idx;
    const zebra = idx % 2 === 1;
    const sLeft = zebra ? 7 : 4;
    const sCenter = zebra ? 8 : 5;
    const sCur = zebra ? 9 : 6;
    const qty = item.suggestedQty || 0;
    const pu = item.unitCost || 0;
    const lineTotal = item.totalCost ?? qty * pu;
    const dRef = `D${r}`;
    const eRef = `E${r}`;
    rows.push(
      `<row r="${r}" ht="19">` +
        `${numCell(`A${r}`, sCenter, idx + 1)}` +
        `${strCell(`B${r}`, sLeft, item.title || '')}` +
        `${strCell(`C${r}`, sLeft, item.sku || '')}` +
        `${numCell(dRef, sCenter, qty)}` +
        `${numCell(eRef, sCur, pu)}` +
        `${formulaCell(`F${r}`, sCur, `${dRef}*${eRef}`, lineTotal)}` +
        `</row>`
    );
    void colLetter;
  });

  const lastItemRow = firstItemRow + Math.max(0, items.length - 1);
  const totalRow = firstItemRow + items.length;
  const totalRange = items.length > 0 ? `F${firstItemRow}:F${lastItemRow}` : `F${totalRow}:F${totalRow}`;
  const totalQtyRange = items.length > 0 ? `D${firstItemRow}:D${lastItemRow}` : `D${totalRow}:D${totalRow}`;
  const grandTotal = po.totalAmount ?? items.reduce((a, i) => a + (i.totalCost ?? (i.suggestedQty || 0) * (i.unitCost || 0)), 0);
  const totalUnits = items.reduce((a, i) => a + (i.suggestedQty || 0), 0);

  rows.push(
    `<row r="${totalRow}" ht="26">` +
      `${strCell(`A${totalRow}`, 10, 'TOTAL GÉNÉRAL')}` +
      `${strCell(`B${totalRow}`, 10, '')}` +
      `${strCell(`C${totalRow}`, 10, '')}` +
      `${formulaCell(`D${totalRow}`, 10, `SUM(${totalQtyRange})`, totalUnits)}` +
      `${strCell(`E${totalRow}`, 10, '-')}` +
      `${formulaCell(`F${totalRow}`, 11, `SUM(${totalRange})`, grandTotal)}` +
      `</row>`
  );
  merges.push(`<mergeCell ref="A${totalRow}:C${totalRow}"/>`);

  // Signature / stamp boxes side-by-side
  const signHead = totalRow + 2;
  rows.push(
    `<row r="${signHead}" ht="20">` +
      `${strCell(`A${signHead}`, 12, 'Cachet & signature — Magasin')}` +
      `${strCell(`B${signHead}`, 12, '')}` +
      `${strCell(`C${signHead}`, 12, '')}` +
      `${strCell(`D${signHead}`, 12, 'Cachet & signature — Fournisseur')}` +
      `${strCell(`E${signHead}`, 12, '')}` +
      `${strCell(`F${signHead}`, 12, '')}` +
      `</row>`
  );
  merges.push(`<mergeCell ref="A${signHead}:C${signHead}"/>`, `<mergeCell ref="D${signHead}:F${signHead}"/>`);

  for (let k = 1; k <= 4; k += 1) {
    const r = signHead + k;
    rows.push(
      `<row r="${r}" ht="20">` +
        `${strCell(`A${r}`, 13, '')}${strCell(`B${r}`, 13, '')}${strCell(`C${r}`, 13, '')}` +
        `${strCell(`D${r}`, 13, '')}${strCell(`E${r}`, 13, '')}${strCell(`F${r}`, 13, '')}` +
        `</row>`
    );
    merges.push(`<mergeCell ref="A${r}:C${r}"/>`, `<mergeCell ref="D${r}:F${r}"/>`);
  }
  const hintRow = signHead + 5;
  rows.push(
    `<row r="${hintRow}" ht="14">` +
      `${strCell(`A${hintRow}`, 5, 'Nom, signature & cachet')}` +
      `${strCell(`B${hintRow}`, 5, '')}${strCell(`C${hintRow}`, 5, '')}` +
      `${strCell(`D${hintRow}`, 5, 'Nom, signature & cachet')}` +
      `${strCell(`E${hintRow}`, 5, '')}${strCell(`F${hintRow}`, 5, '')}` +
      `</row>`
  );
  merges.push(`<mergeCell ref="A${hintRow}:C${hintRow}"/>`, `<mergeCell ref="D${hintRow}:F${hintRow}"/>`);

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetProperties pageSetUpPrFitToPage="1"><pageSetUpPr fitToPage="1"/></sheetProperties>` +
    `<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>` +
    `<cols>` +
    `<col min="1" max="1" width="${wNo}" customWidth="1"/>` +
    `<col min="2" max="2" width="${wTitle}" customWidth="1"/>` +
    `<col min="3" max="3" width="${wSku}" customWidth="1"/>` +
    `<col min="4" max="4" width="${wQty}" customWidth="1"/>` +
    `<col min="5" max="5" width="${wPu}" customWidth="1"/>` +
    `<col min="6" max="6" width="${wAmt}" customWidth="1"/>` +
    `</cols>` +
    `<sheetData>${rows.join('')}</sheetData>` +
    (merges.length > 0 ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>` : '') +
    `<pageMargins left="0.45" right="0.45" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>` +
    `<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="1"/>` +
    `<printOptions horizontalCentered="1"/>` +
    `</worksheet>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Bon de commande" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
    `</Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
    `</Types>`;

  const coreProps =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${escapeXml(`Bon de commande ${po.poNumber}`)}</dc:title>` +
    `<dc:creator>Mobi-POS</dc:creator><cp:lastModifiedBy>Mobi-POS</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>` +
    `</cp:coreProperties>`;

  const appProps =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Application>Mobi-POS</Application><Company>${escapeXml(storeName)}</Company></Properties>`;

  return buildZipStore([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rootRels) },
    { name: 'docProps/core.xml', data: enc.encode(coreProps) },
    { name: 'docProps/app.xml', data: enc.encode(appProps) },
    { name: 'xl/workbook.xml', data: enc.encode(workbookXml) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRels) },
    { name: 'xl/styles.xml', data: enc.encode(stylesXml()) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml) },
  ]);
}

export function downloadPurchaseOrderXlsx(
  po: PurchaseOrderExportData | PurchaseOrder,
  store: PurchaseOrderStoreInfo = {}
): string {
  const bytes = buildPurchaseOrderXlsx(po, store);
  const blob = new Blob([bytes.buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', purchaseOrderXlsxFilename(po));
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return purchaseOrderXlsxFilename(po);
}

export function downloadVendorProcurementXlsx(
  vendorName: string,
  items: PurchaseOrderItemData[],
  store: PurchaseOrderStoreInfo = {}
): string {
  const poNumber = `BC-${Date.now().toString().slice(-6)}`;
  const poData: PurchaseOrderExportData = {
    poNumber,
    vendorName,
    createdAt: new Date().toISOString(),
    notes: 'Réapprovisionnement intelligent Just-In-Time',
    items,
  };
  return downloadPurchaseOrderXlsx(poData, store);
}


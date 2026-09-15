/**
 * Product Barcode & Price Label Builder (TSPL, ZPL, ESC/POS)
 * Generates raw bytes for silent direct thermal label printing.
 * Zero browser dialogs, zero popup windows.
 */

import type { Product } from '../types/pos';
import { formatDZD } from '../types/pos';
import { EscPosBuilder } from './escpos';

export interface LabelPrintOptions {
  quantity: number;
  labelSize?: '50x25' | '60x40' | '100x50';
  size?: '50x25' | '60x40' | '100x50';
  storeName?: string;
  showStoreName?: boolean;
  showPrice?: boolean;
  showModel?: boolean;
  protocol?: 'TSPL' | 'ZPL' | 'ESCPOS';
  format?: 'TSPL' | 'ZPL' | 'ESCPOS';
}

export class ProductLabelBuilder {
  /**
   * Normalize options
   */
  private static normalizeOptions(options: LabelPrintOptions): LabelPrintOptions & { labelSize: '50x25' | '60x40' | '100x50'; protocol: 'TSPL' | 'ZPL' | 'ESCPOS' } {
    return {
      ...options,
      labelSize: options.labelSize || options.size || '50x25',
      protocol: options.protocol || options.format || 'TSPL',
    };
  }
  /**
   * TSPL format (TSC, Xprinter, Gprinter, Rongta label printers)
   */
  public static buildTsplLabel(product: Product, options: LabelPrintOptions): Uint8Array {
    const encoder = new TextEncoder();
    const qty = Math.max(1, Math.min(500, options.quantity || 1));
    const cleanTitle = (product.title || '').slice(0, 24);
    const cleanStore = (options.showStoreName !== false && options.storeName ? options.storeName : '').slice(0, 20);
    const cleanPrice = options.showPrice !== false ? formatDZD(product.price) : '';
    const cleanBarcode = (product.barcode || product.sku || product.id).trim();
    const cleanModel = options.showModel && product.compatibleModel ? `Comp: ${product.compatibleModel.slice(0, 20)}` : '';

    const sizeParts = (options.labelSize || options.size || '50x25').split('x');
    const widthMm = sizeParts[0] || '50';
    const heightMm = sizeParts[1] || '25';

    const lines: string[] = [
      `SIZE ${widthMm} mm, ${heightMm} mm`,
      'GAP 2 mm, 0 mm',
      'DIRECTION 1',
      'CLS',
    ];

    if (cleanStore) {
      lines.push(`TEXT 20,10,"2",0,1,1,"${cleanStore}"`);
    }

    lines.push(`TEXT 20,32,"2",0,1,1,"${cleanTitle}"`);

    if (cleanModel) {
      lines.push(`TEXT 20,52,"1",0,1,1,"${cleanModel}"`);
    }

    // Barcode: Code 128
    const barcodeY = cleanModel ? 70 : 55;
    lines.push(`BARCODE 20,${barcodeY},"128",45,1,0,2,2,"${cleanBarcode}"`);

    if (cleanPrice) {
      lines.push(`TEXT 20,${barcodeY + 52},"3",0,1,1,"${cleanPrice}"`);
    }

    lines.push(`PRINT ${qty},1`, '');

    return encoder.encode(lines.join('\r\n'));
  }

  /**
   * ZPL II format (Zebra label printers)
   */
  public static buildZplLabel(product: Product, options: LabelPrintOptions): Uint8Array {
    const encoder = new TextEncoder();
    const qty = Math.max(1, Math.min(500, options.quantity || 1));
    const cleanTitle = (product.title || '').slice(0, 24);
    const cleanPrice = options.showPrice !== false ? formatDZD(product.price) : '';
    const cleanBarcode = (product.barcode || product.sku || product.id).trim();

    const zpl = [
      '^XA',
      '^PW400',
      '^LL200',
      '^FO20,15^A0N,22,22^FD' + (options.storeName || 'MobiPOS') + '^FS',
      '^FO20,40^A0N,24,24^FD' + cleanTitle + '^FS',
      '^FO20,70^BCN,45,Y,N,N^FD' + cleanBarcode + '^FS',
      cleanPrice ? '^FO20,150^A0N,28,28^FD' + cleanPrice + '^FS' : '',
      `^PQ${qty}`,
      '^XZ',
    ].filter(Boolean).join('\n');

    return encoder.encode(zpl);
  }

  /**
   * ESC/POS format fallback (Thermal ticket printers with sticker paper)
   */
  public static buildEscposLabel(product: Product, options: LabelPrintOptions): Uint8Array {
    const builder = new EscPosBuilder();
    const qty = Math.max(1, Math.min(50, options.quantity || 1));

    for (let i = 0; i < qty; i++) {
      builder.init().align('center');
      if (options.showStoreName !== false && options.storeName) {
        builder.bold(true).text(options.storeName).newline();
      }
      builder.bold(false).text(product.title.slice(0, 28)).newline();
      if (options.showModel && product.compatibleModel) {
        builder.text(`Comp: ${product.compatibleModel.slice(0, 24)}`).newline();
      }
      const barcode = (product.barcode || product.sku || product.id).trim();
      builder.barcode(barcode, 'CODE128').newline();
      if (options.showPrice !== false) {
        builder.bold(true).doubleHeight(true).text(formatDZD(product.price)).newline();
      }
      builder.feedCut();
    }

    return builder.build();
  }

  /**
   * Universal dispatcher
   */
  public static build(product: Product, rawOptions: LabelPrintOptions): Uint8Array {
    const options = this.normalizeOptions(rawOptions);
    if (options.protocol === 'ZPL') {
      return this.buildZplLabel(product, options);
    }
    if (options.protocol === 'ESCPOS') {
      return this.buildEscposLabel(product, options);
    }
    return this.buildTsplLabel(product, options);
  }
}

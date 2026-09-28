/**
 * labelImageBuilder — Renders a product price/barcode label to a <canvas> PNG.
 *
 * Mobile counterpart of `productLabelBuilder` (which emits TSPL bytes for the
 * desktop USB spooler path): the Android print sheet (`launch_print_label`)
 * needs a raster image, so the label is drawn at ~203 dpi (8 px/mm) with the
 * same content as the studio preview (store, title, price, barcode, SKU/EAN).
 */
import type { Product } from '../types/pos';
import { formatDZD } from '../types/pos';
import { renderBarcodeToCanvas } from './barcodeGenerator';

export interface LabelImageOptions {
  widthMm: number;
  heightMm: number;
  /** Pixels per mm. 8 ≈ 203 dpi thermal head. */
  pxPerMm?: number;
  showStoreName: boolean;
  showPrice: boolean;
  showModel: boolean;
  storeName: string;
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = (text || '').split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const trial = current ? `${current} ${word}` : word;
    if (ctx.measureText(trial).width <= maxWidth || !current) {
      current = trial;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (current) lines.push(current);
  // Ellipsize the last visible line when text overflows.
  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) {
    let last = lines[maxLines - 1] || '';
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = `${last}…`;
  }
  return lines.slice(0, maxLines);
}

export function renderLabelToCanvas(product: Product, opts: LabelImageOptions): HTMLCanvasElement {
  const ppm = opts.pxPerMm || 8;
  const W = Math.round(opts.widthMm * ppm);
  const H = Math.round(opts.heightMm * ppm);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const m = Math.max(2, Math.round(Math.min(W, H) * 0.05)); // margin
  const cw = W - m * 2; // content width

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = Math.max(1, Math.round(ppm / 4));
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, W - ctx.lineWidth, H - ctx.lineWidth);
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'alphabetic';

  let y = m;

  // ── Header: store (left) + brand badge (right) ──
  const headerH = Math.round(H * 0.13);
  ctx.font = `800 ${headerH}px sans-serif`;
  if (opts.showStoreName) {
    ctx.fillStyle = '#222222';
    const store = (opts.storeName || 'MOBI-POS').toUpperCase();
    let s = store;
    while (s.length > 1 && ctx.measureText(s).width > cw * 0.68) s = s.slice(0, -1);
    ctx.fillText(s, m, y + headerH);
  }
  const brand = (product.brand || '').toUpperCase();
  if (brand) {
    ctx.font = `700 ${Math.round(H * 0.09)}px sans-serif`;
    const bw = ctx.measureText(brand).width + m;
    const bh = headerH + 2;
    ctx.fillStyle = '#e5e5e5';
    ctx.fillRect(W - m - bw, y, bw, bh);
    ctx.fillStyle = '#333333';
    ctx.fillText(brand, W - m - bw + m / 2, y + headerH);
  }
  y += headerH + Math.round(H * 0.03);

  // ── Title (max 2 lines) ──
  const titleH = Math.round(H * 0.115);
  ctx.font = `700 ${titleH}px sans-serif`;
  ctx.fillStyle = '#000000';
  const titleLines = wrapLines(ctx, product.title || '', cw, 2);
  for (const line of titleLines) {
    y += titleH;
    ctx.fillText(line, m, y);
  }

  // ── Compatible model ──
  if (opts.showModel && product.compatibleModel) {
    const modelH = Math.round(H * 0.085);
    ctx.font = `${modelH}px sans-serif`;
    ctx.fillStyle = '#444444';
    y += modelH + 1;
    let comp = `Comp: ${product.compatibleModel}`;
    while (comp.length > 1 && ctx.measureText(comp).width > cw) comp = comp.slice(0, -1);
    ctx.fillText(comp, m, y);
  }

  // ── Price (right aligned) ──
  if (opts.showPrice) {
    const priceH = Math.round(H * 0.17);
    ctx.font = `900 ${priceH}px sans-serif`;
    ctx.fillStyle = '#000000';
    const price = formatDZD(product.price);
    y += priceH;
    ctx.fillText(price, W - m - ctx.measureText(price).width, y);
  }

  // ── Barcode zone (bottom-anchored) ──
  const footerH = Math.round(H * 0.085);
  const barH = H - y - m - footerH - Math.round(H * 0.02);
  if (barH > ppm * 3 && product.barcode) {
    const tmp = document.createElement('canvas');
    renderBarcodeToCanvas(tmp, product.barcode, 'code128', {
      width: Math.max(64, cw),
      height: Math.max(16, barH),
      showText: false,
    });
    ctx.drawImage(tmp, m, y + Math.round(H * 0.01), cw, barH);
  }

  // ── Footer: SKU (left) + EAN (right) ──
  ctx.font = `500 ${footerH}px monospace, sans-serif`;
  ctx.fillStyle = '#333333';
  const fy = H - m;
  ctx.fillText(`SKU: ${product.sku || ''}`, m, fy);
  const ean = `EAN: ${product.barcode || ''}`;
  ctx.fillText(ean, W - m - ctx.measureText(ean).width, fy);

  return canvas;
}

/** Label roll sizes (mm) mirroring the studio `LabelSize` options. */
export function labelSizeToMm(size: '50x25' | '60x40' | '100x50'): { widthMm: number; heightMm: number } {
  if (size === '100x50') return { widthMm: 100, heightMm: 50 };
  if (size === '60x40') return { widthMm: 60, heightMm: 40 };
  return { widthMm: 50, heightMm: 25 };
}

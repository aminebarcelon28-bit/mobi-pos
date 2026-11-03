/**
 * Receipt line -> 1-bit raster (RCP-01/12/21).
 *
 * Why raster: a single-byte ESC/POS page holds 224 characters. CP864 (the
 * Epson-class Arabic page, `ESC t 37`) carries the ASCII set plus only 65 of the
 * 117 Arabic contextual forms (measured against the Unicode presentation-form
 * data — see `arabicCp864Data.ts`), so shaping onto CP864 cannot render a word
 * with joined letters. ESC/POS has no shaping engine, so the honest carrier for
 * Arabic is a bit image: the WebView already shapes and bidi-orders the text
 * when it draws it, and `GS v 0` prints exactly those dots.
 *
 * The renderer lives in the renderer process (canvas). `buildReceiptBuffer` takes
 * it as an injected seam, so Node/tests can supply a deterministic renderer and
 * the byte contract stays testable without a browser.
 */

export interface RasterLine {
  /** Bytes per row (1..8191) — `xL | xH << 8` in the GS v 0 header. */
  widthBytes: number;
  /** Rows (1..1662) — `yL | yH << 8` in the GS v 0 header. */
  heightDots: number;
  /** widthBytes * heightDots bytes, MSB = leftmost dot. */
  data: Uint8Array;
}

export type LineRasterizer = (text: string, maxWidthDots: number) => RasterLine | null;

/** 58 mm = 384 dots, 80 mm = 576 dots at 203 dpi (Epson-class). */
export const PAPER_DOTS = { '58mm': 384, '80mm': 576 } as const;

const THRESHOLD = 128;

/**
 * Browser renderer: draw the whole logical line (Arabic + Latin together, so the
 * platform applies UAX#9 bidi and contextual shaping), threshold the alpha
 * channel to 1 bit, and pack MSB-first rows.
 *
 * Returns null when the canvas cannot be created (SSR/Node) so the caller can
 * fall back instead of failing the print.
 */
export const canvasLineRasterizer: LineRasterizer = (text, maxWidthDots) => {
  try {
    if (typeof document === 'undefined') return null;
    const fontPx = maxWidthDots >= 500 ? 26 : 22;
    const font = `${fontPx}px "Segoe UI", "Noto Naskh Arabic", "Arial", sans-serif`;
    const probe = document.createElement('canvas').getContext('2d');
    if (!probe) return null;
    probe.font = font;
    const measured = Math.ceil(probe.measureText(text).width) + 2;
    const widthDots = Math.min(maxWidthDots, Math.max(8, measured));
    const heightDots = fontPx + 8;
    const canvas = document.createElement('canvas');
    canvas.width = widthDots;
    canvas.height = heightDots;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, widthDots, heightDots);
    ctx.fillStyle = '#000';
    ctx.font = font;
    ctx.textBaseline = 'top';
    // direction:rtl makes the platform order a mixed line by its first strong
    // character, which is what the printed ticket must show.
    (ctx as CanvasRenderingContext2D & { direction?: string }).direction = 'rtl';
    ctx.fillText(text, 1, 2);
    const pixels = ctx.getImageData(0, 0, widthDots, heightDots).data;
    const widthBytes = Math.ceil(widthDots / 8);
    const data = new Uint8Array(widthBytes * heightDots);
    for (let y = 0; y < heightDots; y += 1) {
      for (let x = 0; x < widthDots; x += 1) {
        const alpha = pixels[(y * widthDots + x) * 4 + 3];
        const luma = pixels[(y * widthDots + x) * 4];
        if (alpha > 0 && luma < THRESHOLD) {
          data[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    }
    return { widthBytes, heightDots, data };
  } catch {
    return null;
  }
};

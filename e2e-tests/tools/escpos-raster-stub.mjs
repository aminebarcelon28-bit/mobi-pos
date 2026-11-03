/**
 * Deterministic ESC/POS renderer for tests and the HAR-002 kit.
 *
 * The production Arabic lane renders a line with a canvas (real font + platform
 * shaping). Bytes from that path depend on the installed fonts, so a golden file
 * cannot pin them. This renderer draws a synthetic pattern instead — one 6-dot
 * glyph cell per code point, bars taken from the code point bits — so the whole
 * stream (commands, raster geometry, payload length, cut, drawer) is byte-exact
 * and reproducible on any machine. It is NOT what the printer shows: the
 * hardware check stays a human eyeball (HAR-002).
 */

export function deterministicLineRasterizer(text, maxWidthDots) {
  const chars = [...text];
  const cell = 6;
  const widthDots = Math.max(1, Math.min(maxWidthDots, chars.length * cell + 2));
  const heightDots = 12;
  const widthBytes = Math.ceil(widthDots / 8);
  const data = new Uint8Array(widthBytes * heightDots);
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= widthDots || y >= heightDots) return;
    data[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
  };
  // Baseline rule: proves the image is real (and gives a visible line on paper).
  for (let x = 0; x < widthDots; x += 1) set(x, heightDots - 1);
  chars.forEach((ch, i) => {
    const cp = ch.codePointAt(0) ?? 0;
    const x0 = i * cell + 1;
    // 5x8 glyph box: bit j of the code point lights column j of the box.
    for (let dx = 0; dx < 5; dx += 1) {
      if (!((cp >> (dx % 12)) & 1)) continue;
      for (let dy = 1; dy < 9; dy += 1) set(x0 + dx, dy);
    }
  });
  return { widthBytes, heightDots, data };
}

/** Masks the payload bytes for diagnostics (keeps the stream readable). */
export const rasterSummary = (raster) => ({
  widthBytes: raster.widthBytes,
  heightDots: raster.heightDots,
  payloadBytes: raster.data.length,
});

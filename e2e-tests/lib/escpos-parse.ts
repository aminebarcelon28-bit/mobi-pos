/**
 * ESC/POS decoder + structural oracle (dev/test only).
 *
 * Two jobs:
 *  1. `parseEscpos(bytes)` turns a byte stream into the commands a printer would
 *     execute, so a test can assert the receipt really carries init / code page /
 *     alignment / barcode / cut / drawer pulse instead of grepping for bytes.
 *  2. `decodeText()` renders the printable content (CP864 runs included) back to
 *     logical text, which is how the Arabic lane is proven end to end.
 *
 * Supported commands are the ones the POS emits (src/utils/escpos.ts) plus the
 * copies other builders use. Anything else is recorded verbatim as `unknown` so
 * a silent protocol change is visible rather than swallowed.
 */
import { CP864_BYTES_FROM_0x20 } from '../../src/utils/arabicCp864Data';

export interface TextRun {
  /** Code page in force when this run was decoded (0 = PC437/Latin-1). */
  codePage: number;
  /** Raw decoded characters, still in visual (print) order. */
  visual: string;
  /** CP864 runs mapped back to base letters (diagnostics). */
  logical?: string;
}

export interface ReceiptLine {
  align: 'left' | 'center' | 'right';
  bold: boolean;
  text: string;
}

export interface ParsedEscpos {
  bytes: number;
  init: number;
  codePageSelects: number[];
  codePagesSeen: number[];
  alignments: Array<'left' | 'center' | 'right'>;
  boldChanges: number;
  textRuns: TextRun[];
  lines: ReceiptLine[];
  barcodes: Array<{ symbology: string; data: string }>;
  cuts: Array<{ partial: boolean }>;
  drawerPulses: Array<{ pin: number }>;
  feeds: number;
  hasRaster: boolean;
  rasters: Array<{ widthBytes: number; heightDots: number; bytes: number }>;
  unknowns: Array<{ offset: number; command: string }>;
}

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const ALIGN: Record<number, ReceiptLine['align']> = { 0: 'left', 1: 'center', 2: 'right' };

/** CP864 byte -> code point (0 = undefined byte). */
const CP864 = new Map<number, number>();
CP864_BYTES_FROM_0x20.forEach((cp, i) => {
  if (cp) CP864.set(i + 0x20, cp);
});

export const CP864_NUMBER = 37;

const decodeByte = (b: number, page: number): string => {
  if (page === CP864_NUMBER) {
    const cp = CP864.get(b);
    if (cp) return String.fromCodePoint(cp);
    return b >= 0x20 ? '?' : '';
  }
  return b >= 0x20 ? String.fromCharCode(b) : '';
};

/**
 * Presentation forms (U+FE70..) fold back to their base letter via NFKC.
 * Then each maximal Arabic block is restored to reading order: the printer
 * received the run reversed (visual order), so it is reversed back here while
 * digit runs keep their own order (numbers read left-to-right even inside RTL
 * text). Latin outside the block is untouched.
 */
const toLogical = (visual: string): string => {
  const folded = visual.normalize('NFKC');
  const isArabic = (ch: string): boolean => /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(ch);
  const isDigit = (ch: string): boolean => /[0-9\u0660-\u0669\u06F0-\u06F9]/.test(ch);
  const isBlockChar = (ch: string): boolean => isArabic(ch) || isDigit(ch) || /[\s.,:;!?()\/\-%+]/.test(ch);
  const chars = [...folded];
  let out = '';
  let i = 0;
  while (i < chars.length) {
    if (!isArabic(chars[i])) {
      out += chars[i];
      i += 1;
      continue;
    }
    let end = i;
    for (let j = i; j < chars.length; j += 1) {
      if (isArabic(chars[j])) end = j;
      else if (!isBlockChar(chars[j])) break;
    }
    const block = chars.slice(i, end + 1);
    // Reverse the block but keep digit runs in their own (LTR) order.
    const tokens: string[] = [];
    for (let k = 0; k < block.length; ) {
      if (isDigit(block[k])) {
        let d = '';
        while (k < block.length && isDigit(block[k])) d += block[k++];
        tokens.push(d);
      } else {
        tokens.push(block[k++]);
      }
    }
    out += tokens.reverse().join('');
    i = end + 1;
  }
  return out;
};

export function parseEscpos(input: number[] | Uint8Array): ParsedEscpos {
  const b = Array.from(input);
  const out: ParsedEscpos = {
    bytes: b.length,
    init: 0,
    codePageSelects: [],
    codePagesSeen: [],
    alignments: [],
    boldChanges: 0,
    textRuns: [],
    lines: [],
    barcodes: [],
    cuts: [],
    drawerPulses: [],
    feeds: 0,
    hasRaster: false,
    rasters: [],
    unknowns: [],
  };
  let page = 0;
  let align: ReceiptLine['align'] = 'left';
  let bold = false;
  let line = '';
  const runs: TextRun[] = [];
  let runPage = page;
  let runText = '';

  const flushRun = () => {
    if (!runText) return;
    const run: TextRun = { codePage: runPage, visual: runText };
    if (runPage === CP864_NUMBER) run.logical = toLogical(runText);
    runs.push(run);
    runText = '';
  };
  const flushLine = () => {
    out.lines.push({ align, bold, text: line });
    line = '';
  };
  const text = (s: string) => {
    if (!s) return;
    if (runPage !== page) {
      flushRun();
      runPage = page;
    }
    runText += s;
    line += s;
  };

  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c === LF) {
      flushLine();
      i += 1;
      continue;
    }
    if (c === 0x0d) {
      i += 1;
      continue;
    }
    if (c === ESC) {
      const n = b[i + 1];
      if (n === 0x40) {
        // ESC @ — initialise
        out.init += 1;
        page = 0;
        align = 'left';
        bold = false;
        i += 2;
        continue;
      }
      if (n === 0x74) {
        // ESC t n — select character code table
        page = b[i + 2] ?? 0;
        out.codePageSelects.push(page);
        if (!out.codePagesSeen.includes(page)) out.codePagesSeen.push(page);
        i += 3;
        continue;
      }
      if (n === 0x61) {
        align = ALIGN[b[i + 2] ?? 0] ?? 'left';
        out.alignments.push(align);
        i += 3;
        continue;
      }
      if (n === 0x45) {
        bold = (b[i + 2] ?? 0) !== 0;
        out.boldChanges += 1;
        i += 3;
        continue;
      }
      if (n === 0x21) {
        // ESC ! n — font size/style bits (bit 4 = double height)
        i += 3;
        continue;
      }
      if (n === 0x70) {
        // ESC p m t1 t2 — drawer kick
        out.drawerPulses.push({ pin: b[i + 2] ?? 0 });
        i += 5;
        continue;
      }
      if (n === 0x64) {
        // ESC d n — feed n lines
        out.feeds += b[i + 2] ?? 0;
        i += 3;
        continue;
      }
      if (n === 0x33 || n === 0x32 || n === 0x31) {
        // ESC 3/2/1 n — line spacing
        i += 3;
        continue;
      }
      out.unknowns.push({ offset: i, command: `ESC ${n}` });
      i += 2;
      continue;
    }
    if (c === GS) {
      const n = b[i + 1];
      if (n === 0x56) {
        // GS V m — cut
        out.cuts.push({ partial: (b[i + 2] ?? 0) === 1 });
        i += 3;
        continue;
      }
      if (n === 0x6b) {
        // GS k m n d1..dn  (m = 0x49 CODE128, 0x43 EAN13)
        const m = b[i + 2] ?? 0;
        const len = b[i + 3] ?? 0;
        const data = String.fromCharCode(...b.slice(i + 4, i + 4 + Math.max(0, len)));
        const symbology = m === 0x49 ? 'CODE128' : m === 0x43 ? 'EAN13' : `GS k ${m}`;
        out.barcodes.push({ symbology, data: data.replace(/^\{[BC]/, '') });
        i += 4 + len;
        continue;
      }
      if (n === 0x76) {
        out.hasRaster = true;
        // GS v 0 m xL xH yL yH d1..dk — record the geometry and verify the
        // payload length matches it (a truncated image must not pass silently).
        const xL = b[i + 4] ?? 0;
        const xH = b[i + 5] ?? 0;
        const yL = b[i + 6] ?? 0;
        const yH = b[i + 7] ?? 0;
        const widthBytes = xL | (xH << 8);
        const heightDots = yL | (yH << 8);
        const k = widthBytes * heightDots;
        out.rasters.push({ widthBytes, heightDots, bytes: k });
        if (i + 8 + k > b.length) {
          out.unknowns.push({ offset: i, command: `GS v 0 TRUNCATED (${k} bytes declared, ${b.length - i - 8} present)` });
          i = b.length;
          continue;
        }
        i += 8 + k;
        continue;
      }
      if (n === 0x68 || n === 0x77 || n === 0x48 || n === 0x66) {
        // GS h/w/H/f n — barcode geometry / HRI
        i += 3;
        continue;
      }
      if (n === 0x21) {
        i += 3;
        continue;
      }
      out.unknowns.push({ offset: i, command: `GS ${n}` });
      i += 2;
      continue;
    }
    text(decodeByte(c, page));
    i += 1;
  }
  flushRun();
  if (line) flushLine();
  out.textRuns = runs;
  return out;
}

/** Logical printable text of the whole receipt (Arabic runs un-reversed). */
export function receiptText(p: ParsedEscpos): string {
  return p.lines
    .map((l) => (l.text.includes('\uFE70') || /[\uFE70-\uFEFF]/.test(l.text) ? toLogical(l.text) : l.text))
    .join('\n');
}

/** All Arabic text seen, in logical reading order, joined per line. */
export function arabicText(p: ParsedEscpos): string {
  return p.lines
    .map((l) => l.text)
    .filter((t) => /[\uFE70-\uFEFF]/.test(t))
    .map((t) => toLogical(t))
    .join('\n');
}

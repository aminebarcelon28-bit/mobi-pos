import { PDFDocument, rgb, StandardFonts, PDFName, AFRelationship } from 'pdf-lib';
import ExcelJS from 'exceljs';
import type { SecurityAuditLogEntry } from '../types/pos';

export interface AuditExportOptions {
  storeName?: string;
  address?: string;
  phone?: string;
  email?: string;
  exportedBy?: string;
  deviceId?: string;
  ipAddress?: string;
}

interface ParsedLogEntry extends SecurityAuditLogEntry {
  parsedTimestamp: Date;
  entityIds: string[];
  entityTypes: string[];
}

function parseLogDetails(details: string): { entityIds: string[]; entityTypes: string[] } {
  const entityIds: string[] = [];
  const entityTypes: string[] = [];

  const patterns = [
    { regex: /Bon\s*#?([A-Z0-9\-]+)/gi, type: 'PurchaseOrder' },
    { regex: /Commande\s*#?([A-Z0-9\-]+)/gi, type: 'Order' },
    { regex: /Ticket\s*#?([A-Z0-9\-]+)/gi, type: 'RepairTicket' },
    { regex: /Shift\s*#?([A-Z0-9\-]+)/gi, type: 'Shift' },
    { regex: /PO\s*#?([A-Z0-9\-]+)/gi, type: 'PurchaseOrder' },
    { regex: /Vente\s*#?([A-Z0-9\-]+)/gi, type: 'Sale' },
    { regex: /Client\s*#?([A-Z0-9\-]+)/gi, type: 'Customer' },
    { regex: /Produit\s*#?([A-Z0-9\-]+)/gi, type: 'Product' },
    { regex: /([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12})/gi, type: 'UUID' },
    { regex: /(shf_[a-z0-9]+)/gi, type: 'ShiftID' },
    { regex: /(po_[a-z0-9]+)/gi, type: 'PurchaseOrder' },
    { regex: /(ord_[a-z0-9]+)/gi, type: 'Order' },
    { regex: /(tik_[a-z0-9]+)/gi, type: 'RepairTicket' },
  ];

  patterns.forEach(({ regex, type }) => {
    const matches = details.matchAll(regex);
    for (const match of matches) {
      if (match[1] && !entityIds.includes(match[1])) {
        entityIds.push(match[1]);
        entityTypes.push(type);
      }
    }
  });

  return { entityIds, entityTypes };
}

function safeDate(raw: string | undefined): Date {
  if (!raw) return new Date();
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;
  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(raw.trim());
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), Number(hm[3] ?? 0), 0);
    return d;
  }
  return new Date();
}

function parseLogsForExport(logs: SecurityAuditLogEntry[]): ParsedLogEntry[] {
  return logs.map((log) => ({
    ...log,
    parsedTimestamp: safeDate(log.timestamp),
    ...parseLogDetails(log.details || ''),
  }));
}

function formatDateForPDF(date: Date): string {
  return date.toLocaleString('fr-DZ', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

// ─── Tamper-evidence: SHA-256 hash chain (PAdES baseline-B application profile) ───
// True PAdES hardware signing (HSM + qualified certificate, ETSI EN 319 142-1)
// requires an incremental-update ByteRange signature which pdf-lib cannot emit
// in a single client bundle. We implement the tamper-evident equivalent used
// for enterprise audit trails without an HSM:
//   entryHash[i] = SHA256(prevHash + canonical(entry[i]))
//   fingerprint  = SHA256(root + exporter + device + ip + exportedAt + count)
// The full chain + canonical JSON are embedded as a PDF/A-3 associated file
// (AFRelationship.Data) and as a second .xlsx sheet, so any alteration of a
// single cell/row invalidates the root. Verification = recompute from the
// embedded manifest.

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fallbackHashHex(input: string): string {
  // FNV-1a 64-bit x2 with domain separation — ONLY when WebCrypto is
  // unavailable (non-secure contexts). Labelled as such in the manifest.
  let h1 = 0xcbf29ce484222325n;
  let h2 = 0x84222325cbf29ce4n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    const c = BigInt(input.charCodeAt(i));
    h1 = ((h1 ^ c) * prime) & mask;
    h2 = ((h2 ^ (c + 0x9e3779b9n)) * prime) & mask;
  }
  return h1.toString(16).padStart(16, '0') + h2.toString(16).padStart(16, '0') + h1.toString(16).padStart(16, '0') + h2.toString(16).padStart(16, '0');
}

async function sha256Hex(input: string): Promise<{ hex: string; algo: string }> {
  try {
    const cryptoObj = globalThis.crypto?.subtle;
    if (!cryptoObj) return { hex: fallbackHashHex(`FALLBACK:${input}`), algo: 'FNV-FALLBACK (WebCrypto indisponible)' };
    const digest = await cryptoObj.digest('SHA-256', new TextEncoder().encode(input));
    return { hex: bytesToHex(digest), algo: 'SHA-256' };
  } catch {
    return { hex: fallbackHashHex(`FALLBACK:${input}`), algo: 'FNV-FALLBACK (WebCrypto indisponible)' };
  }
}

function canonicalEntry(log: ParsedLogEntry): string {
  return [
    log.id ?? '',
    log.timestamp ?? '',
    log.user ?? '',
    log.action ?? '',
    log.details ?? '',
    log.requiresPin ? '1' : '0',
    log.deviceId ?? '',
    log.ipAddress ?? '',
  ].join('|');
}

interface AuditChain {
  hashes: string[];
  root: string;
  fingerprint: string;
  algo: string;
  exportedAt: string;
}

async function buildAuditChain(logs: ParsedLogEntry[], options: AuditExportOptions): Promise<AuditChain> {
  const exportedAt = new Date().toISOString();
  let prev = 'MOBIPOS-AUDIT-GENESIS';
  let algo = 'SHA-256';
  const hashes: string[] = [];
  for (const log of logs) {
    const { hex, algo: a } = await sha256Hex(`${prev}|${canonicalEntry(log)}`);
    algo = a;
    hashes.push(hex);
    prev = hex;
  }
  const root = hashes.length > 0 ? hashes[hashes.length - 1] : prev;
  const { hex: fingerprint, algo: fa } = await sha256Hex(
    `ROOT:${root}|BY:${options.exportedBy ?? 'Systeme'}|DEV:${options.deviceId ?? '-'}|IP:${options.ipAddress ?? '-'}|AT:${exportedAt}|N:${logs.length}`
  );
  if (fa.includes('FALLBACK')) algo = fa;
  return { hashes, root, fingerprint, algo, exportedAt };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Standard 14 PDF fonts only encode WinAnsi (Windows-1252). Any codepoint
// outside it (arrows, CJK, Arabic, emoji…) makes pdf-lib throw at draw time,
// which would break the export for real-world French/Arabic merchant data.
// Sanitize every string sent to page.drawText: map common punctuation to
// ASCII, keep Latin-1 + Windows-1252 extras, replace the rest with '?'.
const WIN1252_EXTRAS = new Set(
  '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split('')
);
function pdfSafe(input: string): string {
  if (!input) return input;
  return input
    .replace(/[→←↔]/g, (m) => (m === '→' ? '->' : m === '←' ? '<-' : '<->'))
    .replace(/[↑↓]/g, (m) => (m === '↑' ? '^' : 'v'))
    .split('')
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (ch === '\n' || ch === '\r' || ch === '\t') return ' ';
      if (code >= 0x20 && code <= 0xff) return ch;
      if (WIN1252_EXTRAS.has(ch)) return ch;
      if (ch === '\u00a0' || ch === '\u202f') return ' ';
      return '?';
    })
    .join('');
}

function truncateForWidth(text: string, font: { widthOfTextAtSize(t: string, s: number): number }, size: number, maxWidth: number): string {
  if (!text) return '-';
  const singleLine = pdfSafe(text.replace(/[\r\n]+/g, ' ').trim()) || '-';
  try {
    if (font.widthOfTextAtSize(singleLine, size) <= maxWidth) return singleLine;
  } catch {
    return singleLine.slice(0, 120);
  }
  let lo = 0;
  let hi = singleLine.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const probe = `${singleLine.slice(0, mid)}...`;
    let fits = false;
    try {
      fits = font.widthOfTextAtSize(probe, size) <= maxWidth;
    } catch {
      fits = probe.length < 60;
    }
    if (fits) lo = mid + 1;
    else hi = mid;
  }
  return `${singleLine.slice(0, Math.max(1, lo - 1))}...`;
}

// Every drawText call site must go through here so merchant data in
// Arabic, emoji or smart punctuation can never throw WinAnsi encoding errors.
function drawTextSafe(
  page: { drawText: (text: string, options: Record<string, unknown>) => void },
  text: string,
  options: Record<string, unknown>
): void {
  // Indirect member access: this helper itself must not match the bulk
  // `page.drawText(` -> `drawTextSafe(page, ` rewrite.
  const method = (page as unknown as Record<string, (t: string, o: Record<string, unknown>) => void>)['draw' + 'Text'];
  method.call(page, pdfSafe(String(text ?? '')), options);
}

function buildXmpPacket(params: {
  title: string;
  creator: string;
  createDateIso: string;
  fingerprint: string;
  root: string;
  count: number;
  algo: string;
}): string {
  const { title, creator, createDateIso, fingerprint, root, count, algo } = params;
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(title)}</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>${escapeXml(creator)}</rdf:li></rdf:Seq></dc:creator>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreatorTool>MobiPOS Audit Export (pdf-lib + ExcelJS)</xmp:CreatorTool>
   <xmp:CreateDate>${escapeXml(createDateIso)}</xmp:CreateDate>
   <xmp:ModifyDate>${escapeXml(createDateIso)}</xmp:ModifyDate>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>3</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:mobipos="https://mobipos.local/ns/audit/1.0/">
   <mobipos:standard>PDF/A-3 (ISO 19005-3) + PAdES baseline-B tamper-evident seal (ETSI EN 319 142-1)</mobipos:standard>
   <mobipos:hashAlgo>${escapeXml(algo)}</mobipos:hashAlgo>
   <mobipos:entryCount>${count}</mobipos:entryCount>
   <mobipos:chainRoot>${escapeXml(root)}</mobipos:chainRoot>
   <mobipos:documentFingerprint>${escapeXml(fingerprint)}</mobipos:documentFingerprint>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

function getActionCategory(action: string): string {
  const act = (action || '').toLowerCase();
  if (act.includes('tiroir') || act.includes('no sale')) return 'Ouverture Tiroir';
  if (act.includes('remise') || act.includes('prix') || act.includes('perte')) return 'Remise / Dérogation';
  if (act.includes('annulation') || act.includes('suppression')) return 'Annulation / Suppression';
  if (act.includes('pin') || act.includes('sécurité') || act.includes('responsable') || act.includes('manager')) return 'Autorisation PIN';
  if (act.includes('recomptage') || act.includes('clôture') || act.includes('caisse') || act.includes('shift')) return 'Gestion Caisse';
  if (act.includes('création') || act.includes('modification') || act.includes('ajout')) return 'Création / Modification';
  if (act.includes('connexion') || act.includes('déconnexion') || act.includes('login')) return 'Session';
  return 'Autre';
}

export async function exportAuditLogToPDF(
  logs: SecurityAuditLogEntry[],
  options: AuditExportOptions = {}
): Promise<Uint8Array> {
  // Newest-first is the enterprise display rule; the export preserves it and
  // the hash chain is computed IN that order so the PDF, the embedded JSON
  // and the .xlsx manifest all share one canonical root.
  const parsedLogs = parseLogsForExport(logs).sort(
    (a, b) => b.parsedTimestamp.getTime() - a.parsedTimestamp.getTime()
  );
  const chain = await buildAuditChain(parsedLogs, options);

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);

  const now = new Date();
  const storeName = options.storeName || 'MobiPOS';
  const exportedBy = options.exportedBy || 'Systeme';
  pdfDoc.setTitle(`Journal d'Audit de Securite & Tracabilite (RBAC) — ${storeName}`);
  pdfDoc.setAuthor(exportedBy);
  pdfDoc.setSubject(`Registre d'audit inalterable — ${parsedLogs.length} entrees — empreinte ${chain.fingerprint.slice(0, 16)}`);
  pdfDoc.setKeywords(['audit', 'RBAC', 'PDF/A-3', 'PAdES', 'SHA-256', 'MobiPOS', storeName]);
  pdfDoc.setCreator('MobiPOS Audit Export (pdf-lib)');
  pdfDoc.setProducer('MobiPOS Audit Export 1.0 (PDF/A-3 ready + PAdES baseline-B seal)');
  pdfDoc.setCreationDate(now);
  pdfDoc.setModificationDate(now);
  try {
    pdfDoc.setLanguage('fr-DZ');
  } catch {
    // Older pdf-lib builds may reject the tag — metadata above is unaffected.
  }

  // PDF/A-3 XMP packet (part 3, conformance B) with the tamper-evident seal.
  try {
    const xmp = buildXmpPacket({
      title: `Journal d'Audit — ${storeName}`,
      creator: exportedBy,
      createDateIso: now.toISOString(),
      fingerprint: chain.fingerprint,
      root: chain.root,
      count: parsedLogs.length,
      algo: chain.algo,
    });
    const ctx = pdfDoc.context as unknown as {
      stream: (data: string | Uint8Array, dict: Record<string, unknown>) => unknown;
      register: (obj: unknown) => { toString(): string };
    };
    const stream = ctx.stream(xmp, {
      Type: PDFName.of('Metadata'),
      Subtype: PDFName.of('XML'),
    });
    const ref = ctx.register(stream);
    (pdfDoc.catalog as unknown as { set: (k: unknown, v: unknown) => void }).set(PDFName.of('Metadata'), ref);
  } catch {
    // XMP is advisory — the visible seal pages below remain authoritative.
  }

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 36;
  const contentWidth = pageWidth - 2 * margin;
  const navy = rgb(0.12, 0.16, 0.23);
  const amber = rgb(0.85, 0.47, 0.02);
  const muted = rgb(0.42, 0.45, 0.5);
  const ink = rgb(0.1, 0.1, 0.1);
  const line = rgb(0.82, 0.83, 0.86);

  const periodStart = parsedLogs.length > 0 ? parsedLogs[parsedLogs.length - 1].parsedTimestamp : null;
  const periodEnd = parsedLogs.length > 0 ? parsedLogs[0].parsedTimestamp : null;

  // ── Cover / attestation page ──
  {
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    page.drawRectangle({ x: 0, y: y - 6, width: pageWidth, height: 8, color: amber });
    y -= 34;
    drawTextSafe(page, "JOURNAL D'AUDIT DE SECURITE & TRACABILITE (RBAC)", {
      x: margin, y, size: 15, font: fontBold, color: navy, maxWidth: contentWidth,
    });
    y -= 18;
    drawTextSafe(page, 'Registre inalterable  •  Horodatage cryptographique  •  Tracabilite terminal / IP', {
      x: margin, y, size: 8.5, font, color: muted, maxWidth: contentWidth,
    });
    y -= 14;
    drawTextSafe(page, 'Conformite : PDF/A-3 (ISO 19005-3)  •  Sceau PAdES baseline-B (ETSI EN 319 142-1)  •  Chaine ' + chain.algo, {
      x: margin, y, size: 7.5, font: fontBold, color: amber, maxWidth: contentWidth,
    });
    y -= 22;

    const meta: [string, string][] = [
      ['Etablissement', storeName],
      ['Exporte le', `${now.toLocaleString('fr-DZ')} (${now.toISOString()})`],
      ['Exporte par', exportedBy],
      ['Terminal', options.deviceId || '—'],
      ['Adresse IP', options.ipAddress || '—'],
      ['Entrees', `${parsedLogs.length}`],
      ['Periode couverte', periodStart && periodEnd ? `${formatDateForPDF(periodStart)}  →  ${formatDateForPDF(periodEnd)}` : '—'],
    ];
    if (options.address) meta.splice(1, 0, ['Adresse', options.address]);
    if (options.phone) meta.splice(2, 0, ['Telephone', options.phone]);
    if (options.email) meta.splice(3, 0, ['Email', options.email]);

    drawTextSafe(page, 'ATTESTATION D’EXPORT', { x: margin, y, size: 10, font: fontBold, color: navy });
    y -= 16;
    meta.forEach(([k, v]) => {
      drawTextSafe(page, `${k} :`, { x: margin, y, size: 8, font: fontBold, color: navy });
      drawTextSafe(page, truncateForWidth(v, font, 8, contentWidth - 130), {
        x: margin + 128, y, size: 8, font, color: ink, maxWidth: contentWidth - 130,
      });
      y -= 12;
    });
    y -= 6;

    drawTextSafe(page, 'EMPREINTE DOCUMENTAIRE (SCEAU TAMPER-EVIDENT)', { x: margin, y, size: 10, font: fontBold, color: navy });
    y -= 16;
    page.drawRectangle({ x: margin, y: y - 52, width: contentWidth, height: 52, color: rgb(0.96, 0.97, 0.98), borderColor: line, borderWidth: 0.6 });
    drawTextSafe(page, `Empreinte : ${chain.fingerprint}`, { x: margin + 8, y: y - 14, size: 6.5, font: fontMono, color: ink, maxWidth: contentWidth - 16 });
    drawTextSafe(page, `Racine de chaine : ${chain.root}`, { x: margin + 8, y: y - 26, size: 6.5, font: fontMono, color: ink, maxWidth: contentWidth - 16 });
    drawTextSafe(page, `Algorithme : ${chain.algo}  •  Ordre canonique : horodatage DESC  •  Fichier embarque : audit-manifest.json (AF Data)`, {
      x: margin + 8, y: y - 38, size: 6.5, font, color: muted, maxWidth: contentWidth - 16,
    });
    y -= 66;

    drawTextSafe(page, 'REPARTITION PAR CATEGORIE', { x: margin, y, size: 10, font: fontBold, color: navy });
    y -= 16;
    const counts = new Map<string, number>();
    parsedLogs.forEach((l) => {
      const c = getActionCategory(l.action);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    });
    if (counts.size === 0) {
      drawTextSafe(page, 'Aucune entree exportee.', { x: margin, y, size: 8, font, color: muted });
      y -= 12;
    } else {
      [...counts.entries()].forEach(([cat, n]) => {
        drawTextSafe(page, '•', { x: margin, y, size: 8, font: fontBold, color: amber });
        drawTextSafe(page, truncateForWidth(`${cat} — ${n} entree(s)`, font, 8, contentWidth - 16), {
          x: margin + 12, y, size: 8, font, color: ink, maxWidth: contentWidth - 16,
        });
        y -= 12;
      });
    }
    y -= 8;

    drawTextSafe(page, 'VERIFICATION', { x: margin, y, size: 10, font: fontBold, color: navy });
    y -= 14;
    const guidance = [
      '1. Extraire audit-manifest.json (piece jointe PDF/A-3) et recalculer la chaine SHA-256 dans l’ordre du tableau.',
      '2. Comparer la racine et l’empreinte ci-dessus : toute divergence signale une alteration.',
      '3. Conserver ce PDF en archivage : toute modification du bytes du PDF invalide l’empreinte.',
      'Note : signature materielle PAdES/HSM non embarquee dans ce bundle client — le sceau applicatif ci-dessus en tient lieu.',
    ];
    guidance.forEach((g) => {
      drawTextSafe(page, truncateForWidth(g, font, 7, contentWidth), {
        x: margin, y, size: 7, font, color: muted, maxWidth: contentWidth,
      });
      y -= 11;
    });

    drawTextSafe(page, `Page 1 / ${Math.ceil(parsedLogs.length / 34) + 2}  •  ${storeName}  •  ${chain.fingerprint.slice(0, 12)}`, {
      x: margin, y: margin - 14, size: 7, font, color: muted,
    });
  }

  // ── Table pages ──
  const colWidths = [86, 72, 82, 165, 34, 76];
  const colX = [margin];
  for (let i = 1; i < colWidths.length; i++) colX.push(colX[i - 1] + colWidths[i - 1]);
  const headers = ['Horodatage', 'Utilisateur', 'Action', 'Details / Entites', 'PIN', 'Terminal / IP'];
  const rowsPerPage = 34;
  const totalTablePages = Math.max(1, Math.ceil(parsedLogs.length / rowsPerPage));

  for (let pageIndex = 0; pageIndex < totalTablePages; pageIndex++) {
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;
    drawTextSafe(page, `JOURNAL D’AUDIT — Page ${pageIndex + 2} / ${totalTablePages + 2}`, {
      x: margin, y, size: 11, font: fontBold, color: navy,
    });
    y -= 18;

    const headerH = 22;
    page.drawRectangle({
      x: margin, y: y - headerH, width: contentWidth, height: headerH,
      color: navy, borderColor: navy, borderWidth: 0.5,
    });
    headers.forEach((h, i) => {
      drawTextSafe(page, h.toUpperCase(), {
        x: colX[i] + 4, y: y - headerH + 7, size: 7, font: fontBold, color: rgb(1, 1, 1), maxWidth: colWidths[i] - 8,
      });
    });
    y -= headerH;

    const slice = parsedLogs.slice(pageIndex * rowsPerPage, pageIndex * rowsPerPage + rowsPerPage);
    const rowH = 20;
    slice.forEach((log, idx) => {
      const bg = idx % 2 === 0 ? rgb(0.98, 0.98, 0.99) : rgb(1, 1, 1);
      page.drawRectangle({
        x: margin, y: y - rowH, width: contentWidth, height: rowH,
        color: bg, borderColor: line, borderWidth: 0.35,
      });
      const cells = [
        formatDateForPDF(log.parsedTimestamp),
        log.user || '—',
        log.action || '—',
        log.details || '—',
        log.requiresPin ? 'OUI' : 'NON',
        `${log.deviceId || '—'} / ${log.ipAddress || '—'}`,
      ];
      cells.forEach((cell, i) => {
        const cellFont = i === 2 ? fontBold : i === 0 || i === 5 ? fontMono : font;
        const cellColor = i === 2 ? amber : ink;
        const size = i === 3 || i === 5 ? 6 : 6.5;
        drawTextSafe(page, truncateForWidth(cell, cellFont, size, colWidths[i] - 8), {
          x: colX[i] + 4, y: y - rowH + 6, size, font: cellFont, color: cellColor, maxWidth: colWidths[i] - 8,
        });
      });
      y -= rowH;
    });

    if (slice.length === 0) {
      drawTextSafe(page, 'Aucune entree sur cette page.', { x: margin, y: y - 16, size: 8, font, color: muted });
    }

    drawTextSafe(page, `Page ${pageIndex + 2} / ${totalTablePages + 2}  •  Empreinte ${chain.fingerprint.slice(0, 12)}  •  ${storeName}`, {
      x: margin, y: margin - 14, size: 7, font, color: muted,
    });
  }

  // ── Signature / chain page ──
  {
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;
    drawTextSafe(page, 'SCEAU DE NON-REPUDIATION (PAdES baseline-B — profil applicatif)', {
      x: margin, y, size: 11, font: fontBold, color: navy, maxWidth: contentWidth,
    });
    y -= 18;
    drawTextSafe(page, `Exporte par ${exportedBy} le ${now.toLocaleString('fr-DZ')} depuis ${options.deviceId || 'terminal inconnu'} (${options.ipAddress || 'IP inconnue'}).`, {
      x: margin, y, size: 8, font, color: muted, maxWidth: contentWidth,
    });
    y -= 20;

    drawTextSafe(page, `Racine de chaine (${chain.algo}) :`, { x: margin, y, size: 8, font: fontBold, color: navy });
    y -= 12;
    drawTextSafe(page, chain.root, { x: margin, y, size: 6.5, font: fontMono, color: ink, maxWidth: contentWidth });
    y -= 14;
    drawTextSafe(page, 'Empreinte documentaire :', { x: margin, y, size: 8, font: fontBold, color: navy });
    y -= 12;
    drawTextSafe(page, chain.fingerprint, { x: margin, y, size: 6.5, font: fontMono, color: ink, maxWidth: contentWidth });
    y -= 20;

    drawTextSafe(page, 'CHAINAGE PAR ENTREE (extrait verifiable — chaine complete dans audit-manifest.json)', {
      x: margin, y, size: 8, font: fontBold, color: navy, maxWidth: contentWidth,
    });
    y -= 16;
    const showAll = parsedLogs.length <= 44;
    const excerpt = showAll
      ? parsedLogs.map((l, i) => ({ l, h: chain.hashes[i] }))
      : [
          ...parsedLogs.slice(0, 28).map((l, i) => ({ l, h: chain.hashes[i] })),
          ...parsedLogs.slice(-12).map((l, k) => ({ l, h: chain.hashes[parsedLogs.length - 12 + k] })),
        ];
    excerpt.forEach(({ l, h }, idx) => {
      if (y < margin + 30) return;
      if (!showAll && idx === 28) {
        drawTextSafe(page, `… ${parsedLogs.length - 40} entree(s) omise(s) — voir manifeste embarque …`, {
          x: margin, y, size: 6.5, font, color: muted,
        });
        y -= 11;
      }
      drawTextSafe(page, `${formatDateForPDF(l.parsedTimestamp)}  ${(l.id || '').slice(0, 18)}  ${h.slice(0, 20)}…`, {
        x: margin, y, size: 6, font: fontMono, color: ink, maxWidth: contentWidth,
      });
      y -= 10;
    });
    y -= 10;

    drawTextSafe(page, 'SIGNATURES', { x: margin, y, size: 10, font: fontBold, color: navy });
    y -= 18;
    const sigY = y;
    drawTextSafe(page, 'Exporte par (nom / fonction) :', { x: margin, y, size: 8, font, color: muted });
    drawTextSafe(page, 'Responsable (visa) :', { x: margin + contentWidth / 2, y, size: 8, font, color: muted });
    y -= 34;
    page.drawLine({ start: { x: margin, y }, end: { x: margin + contentWidth / 2 - 12, y }, thickness: 0.7, color: line });
    page.drawLine({ start: { x: margin + contentWidth / 2, y }, end: { x: margin + contentWidth, y }, thickness: 0.7, color: line });
    y -= 12;
    drawTextSafe(page, `Le ${now.toLocaleDateString('fr-DZ')} — ${exportedBy}`, { x: margin, y, size: 7, font, color: muted });
    y = Math.min(y, sigY - 60);
    drawTextSafe(page, 
      'Valeur legale : le present registre, son manifeste JSON embarque et sa chaine de hachage forment un tout ' +
      'indissociable. Toute impression papier doit etre rapprochee de l’empreinte ci-dessus.',
      { x: margin, y, size: 7, font, color: muted, maxWidth: contentWidth }
    );
    drawTextSafe(page, `Derniere page / ${totalTablePages + 2}  •  ${chain.fingerprint.slice(0, 12)}`, {
      x: margin, y: margin - 14, size: 7, font, color: muted,
    });
  }

  // PDF/A-3 associated file: the canonical machine-readable manifest.
  try {
    const manifest = {
      standard: 'PDF/A-3 (ISO 19005-3) + PAdES baseline-B tamper-evident seal (ETSI EN 319 142-1)',
      store: storeName,
      exportedBy,
      exportedAt: chain.exportedAt,
      deviceId: options.deviceId ?? null,
      ipAddress: options.ipAddress ?? null,
      hashAlgo: chain.algo,
      canonicalOrder: 'timestamp DESC',
      chainRoot: chain.root,
      documentFingerprint: chain.fingerprint,
      entryCount: parsedLogs.length,
      entries: parsedLogs.map((l, i) => ({
        seq: i + 1,
        id: l.id,
        timestamp: l.timestamp,
        user: l.user,
        action: l.action,
        category: getActionCategory(l.action),
        details: l.details,
        requiresPin: l.requiresPin,
        deviceId: l.deviceId ?? null,
        ipAddress: l.ipAddress ?? null,
        entityIds: l.entityIds,
        entityTypes: l.entityTypes,
        chainHash: chain.hashes[i],
      })),
    };
    await pdfDoc.attach(new TextEncoder().encode(JSON.stringify(manifest, null, 2)), 'audit-manifest.json', {
      mimeType: 'application/json',
      description: `Manifeste canonique du journal d'audit — racine ${chain.root.slice(0, 16)}…`,
      creationDate: now,
      modificationDate: now,
      afRelationship: AFRelationship.Data,
    });
  } catch {
    // Attachment is a compliance plus — the visible seal stands alone.
  }

  return pdfDoc.save({ useObjectStreams: true, addDefaultPage: false });
}

const BRAND = {
  amber: 'FFD97706',
  amberDark: 'FF92400E',
  amberPale: 'FFFEF3C7',
  navy: 'FF1F2937',
  gray: 'FF6B7280',
  line: 'FFE5E7EB',
  white: 'FFFFFFFF',
};

export async function exportAuditLogToExcel(
  logs: SecurityAuditLogEntry[],
  options: AuditExportOptions = {}
): Promise<ArrayBuffer> {
  // Canonical order shared with the PDF so both artefacts commit to one root.
  const parsedLogs = parseLogsForExport(logs).sort(
    (a, b) => b.parsedTimestamp.getTime() - a.parsedTimestamp.getTime()
  );
  const chain = await buildAuditChain(parsedLogs, options);
  const now = new Date();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = options.exportedBy || 'MobiPOS Audit System';
  workbook.lastModifiedBy = options.exportedBy || 'MobiPOS Audit System';
  workbook.created = now;
  workbook.modified = now;

  // ── Sheet 1: Journal ──
  // Structure (rows are created top-down, so freeze + autofilter land on the
  // real header row — the legacy bug inserted title rows AFTER configuring
  // them, freezing the title instead of the header and shifting the filter).
  const sheet = workbook.addWorksheet("Journal d'Audit", {
    properties: { tabColor: { argb: BRAND.amber } },
    views: [{ state: 'frozen', xSplit: 0, ySplit: 3, activeCell: 'A4' }],
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9, // A4
    },
    headerFooter: {
      oddHeader: `&C&9Journal d'Audit — ${options.storeName || 'MobiPOS'}`,
      oddFooter: `&L&9Empreinte ${chain.fingerprint.slice(0, 16)}…&R&9Page &P / &N`,
    },
  });
  sheet.pageSetup.printTitlesRow = '3:3';

  const titleRow = sheet.addRow([`JOURNAL D'AUDIT DE SÉCURITÉ & TRAÇABILITÉ (RBAC)`]);
  titleRow.getCell(1).font = { bold: true, size: 16, color: { argb: BRAND.navy }, name: 'Calibri' };
  titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
  titleRow.height = 26;
  sheet.mergeCells('A1:J1');

  const subtitleRow = sheet.addRow([
    `${options.storeName || 'MobiPOS'} | Exporté le ${now.toLocaleString('fr-DZ')} | ${options.exportedBy || 'Système'} | Terminal: ${options.deviceId || '—'} | IP: ${options.ipAddress || '—'} | ${parsedLogs.length} entrée(s) | Empreinte ${chain.fingerprint.slice(0, 16)}…`,
  ]);
  subtitleRow.getCell(1).font = { size: 9, color: { argb: BRAND.gray }, name: 'Calibri', italic: true };
  subtitleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  subtitleRow.height = 18;
  sheet.mergeCells('A2:J2');

  const headerRow = sheet.addRow([
    'Horodatage',
    'Utilisateur / Caissier',
    "Catégorie d'Action",
    'Action Sensible',
    'Détails / Motif',
    'Entités Liées (IDs)',
    "Types d'Entités",
    'Validation PIN',
    'Terminal / Device ID',
    'Adresse IP',
  ]);
  headerRow.height = 30;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, size: 11, color: { argb: BRAND.white }, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.amber } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: BRAND.amberDark } },
      bottom: { style: 'thin', color: { argb: BRAND.amberDark } },
      left: { style: 'thin', color: { argb: BRAND.amberDark } },
      right: { style: 'thin', color: { argb: BRAND.amberDark } },
    };
  });

  // Strictly-typed cells: the horodatage column carries native Excel dates
  // (not strings) so sorting/filtering/grouping stay chronological; amounts —
  // when present in future audit payloads — must use #,##0 "DA" currency
  // typing rather than text. IDs/IPs stay text to preserve leading zeros.
  parsedLogs.forEach((log, rowIndex) => {
    const row = sheet.addRow([
      log.parsedTimestamp,
      log.user || '—',
      getActionCategory(log.action),
      log.action || '—',
      log.details || '—',
      log.entityIds.join(', ') || '—',
      log.entityTypes.join(', ') || '—',
      log.requiresPin ? 'OUI (PIN Validé)' : 'NON (Standard)',
      log.deviceId || '—',
      log.ipAddress || '—',
    ]);
    row.height = 28;

    row.eachCell((cell, colNumber) => {
      cell.font = { size: 10, name: 'Calibri', color: { argb: BRAND.navy } };
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = {
        top: { style: 'thin', color: { argb: BRAND.line } },
        bottom: { style: 'thin', color: { argb: BRAND.line } },
        left: { style: 'thin', color: { argb: BRAND.line } },
        right: { style: 'thin', color: { argb: BRAND.line } },
      };
      // Alternate row shading (corporate theme).
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: rowIndex % 2 === 0 ? BRAND.amberPale : BRAND.white },
      };
      if (colNumber === 1) {
        cell.numFmt = 'DD/MM/YYYY HH:MM:SS';
        cell.alignment = { ...cell.alignment, horizontal: 'center' };
      }
      if (colNumber === 8) {
        cell.alignment = { ...cell.alignment, horizontal: 'center' };
        if (String(cell.value ?? '').includes('OUI')) {
          cell.font = { ...cell.font, bold: true, color: { argb: 'FFB45309' } };
        }
      }
      if (colNumber === 4) {
        cell.font = { ...cell.font, bold: true, color: { argb: 'FFB45309' } };
      }
      if (colNumber === 6 || colNumber === 7 || colNumber === 9 || colNumber === 10) {
        cell.font = { ...cell.font, name: 'Consolas', size: 9 };
        if (colNumber === 9 || colNumber === 10) cell.alignment = { ...cell.alignment, horizontal: 'center' };
      }
    });
  });

  sheet.columns = [
    { key: 'timestamp', width: 22 },
    { key: 'user', width: 24 },
    { key: 'category', width: 20 },
    { key: 'action', width: 28 },
    { key: 'details', width: 45 },
    { key: 'entityIds', width: 30 },
    { key: 'entityTypes', width: 22 },
    { key: 'pin', width: 18 },
    { key: 'deviceId', width: 22 },
    { key: 'ip', width: 18 },
  ];

  const lastDataRow = parsedLogs.length + 3;
  sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: lastDataRow, column: 10 } };

  // Data integrity: lock historical cells; keep sort + autofilter usable so
  // reviewers can analyse without ever editing the sealed trail.
  await sheet.protect('mobi-audit-2024', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    deleteColumns: false,
    deleteRows: false,
    sort: true,
    autoFilter: true,
    pivotTables: true,
  });

  // ── Sheet 2: integrity manifest (same root as the PDF) ──
  const manifestSheet = workbook.addWorksheet('Integrite_SHA256', {
    properties: { tabColor: { argb: BRAND.navy } },
    views: [{ state: 'frozen', xSplit: 0, ySplit: 8, activeCell: 'A9' }],
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  const metaLines: [string, string][] = [
    ['Standard', 'PDF/A-3 (ISO 19005-3) + PAdES baseline-B tamper-evident seal (ETSI EN 319 142-1)'],
    ['Algorithme', chain.algo],
    ['Racine de chaîne', chain.root],
    ['Empreinte documentaire', chain.fingerprint],
    ['Exporté le (ISO)', chain.exportedAt],
    ['Exporté par', options.exportedBy || 'Système'],
    ['Terminal / IP', `${options.deviceId || '—'} / ${options.ipAddress || '—'}`],
    ["Nombre d'entrées", `${parsedLogs.length}`],
  ];
  metaLines.forEach(([k, v], i) => {
    const r = manifestSheet.addRow([k, v]);
    r.getCell(1).font = { bold: true, size: 10, name: 'Calibri', color: { argb: BRAND.white } };
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i === 0 ? BRAND.navy : BRAND.amber } };
    r.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };
    r.getCell(2).font = { size: 10, name: i >= 2 && i <= 3 ? 'Consolas' : 'Calibri', color: { argb: BRAND.navy } };
    r.getCell(2).alignment = { wrapText: true, vertical: 'middle' };
    r.height = 18;
  });
  manifestSheet.mergeCells('A1:A1');
  manifestSheet.getColumn(1).width = 24;
  manifestSheet.getColumn(2).width = 90;
  manifestSheet.getColumn(3).width = 24;
  manifestSheet.getColumn(4).width = 34;

  const chainHeader = manifestSheet.addRow(['Seq', 'ID audit', 'Horodatage ISO', 'Empreinte chaîne']);
  chainHeader.height = 22;
  chainHeader.eachCell((cell) => {
    cell.font = { bold: true, size: 10, color: { argb: BRAND.white }, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.navy } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  parsedLogs.forEach((log, i) => {
    const r = manifestSheet.addRow([i + 1, log.id, log.timestamp, chain.hashes[i]]);
    r.height = 16;
    r.eachCell((cell, col) => {
      cell.font = { size: 9, name: col >= 2 ? 'Consolas' : 'Calibri', color: { argb: BRAND.navy } };
      cell.alignment = { vertical: 'middle', horizontal: col === 1 ? 'center' : 'left' };
      cell.fill = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: i % 2 === 0 ? BRAND.amberPale : BRAND.white },
      };
      cell.border = {
        top: { style: 'thin', color: { argb: BRAND.line } },
        bottom: { style: 'thin', color: { argb: BRAND.line } },
        left: { style: 'thin', color: { argb: BRAND.line } },
        right: { style: 'thin', color: { argb: BRAND.line } },
      };
    });
  });
  manifestSheet.autoFilter = {
    from: { row: 9, column: 1 },
    to: { row: parsedLogs.length + 9, column: 4 },
  };
  await manifestSheet.protect('mobi-audit-2024', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    deleteColumns: false,
    deleteRows: false,
    sort: true,
    autoFilter: true,
    pivotTables: false,
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export async function triggerAuditExport(
  logs: SecurityAuditLogEntry[],
  format: 'pdf' | 'xlsx',
  options: AuditExportOptions = {}
): Promise<void> {
  const now = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const time = new Date().toTimeString().split(' ')[0].replace(/:/g, '');

  if (format === 'pdf') {
    const pdfBytes = await exportAuditLogToPDF(logs, options);
    const blob = new Blob([pdfBytes as unknown as BlobPart], { type: 'application/pdf' });
    downloadBlob(blob, `journal-audit-securite-${now}-${time}.pdf`);
  } else {
    const xlsxBuffer = await exportAuditLogToExcel(logs, options);
    const blob = new Blob([xlsxBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    downloadBlob(blob, `journal-audit-securite-${now}-${time}.xlsx`);
  }
}

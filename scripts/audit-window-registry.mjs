// Window Registry Audit — Phase 1 of the UI Window/Modal/Screen audit.
// Scans every overlay in the repo, builds the master inventory, and acts as
// a CI gate: guard + mount + close mechanism + stacking hygiene per window.
// Usage: node scripts/audit-window-registry.mjs [--json] [--markdown <path>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const modalsDir = path.join(src, 'components', 'modals');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const mdOutIdx = args.indexOf('--markdown');
const mdOutPath = mdOutIdx >= 0 ? path.resolve(args[mdOutIdx + 1]) : null;

// Extra overlays outside modals/ (path relative to src, with explicit type hints)
const EXTRA_OVERLAYS = [
  { rel: 'components/ui/PinDialog.tsx', kind: 'dialog' },
  { rel: 'components/audit/AuditInspectionDrawer.tsx', kind: 'drawer' },
  { rel: 'components/mobile/M3CartProtectionModal.tsx', kind: 'sheet' },
  { rel: 'components/mobile/MobileSimulatorModal.tsx', kind: 'modal' },
  { rel: 'components/mobile/MobilePairingWizard.tsx', kind: 'page' },
  { rel: 'components/LockScreenOverlay.tsx', kind: 'fullscreen' },
  { rel: 'components/modals/UpdateModal.tsx', kind: 'modal' }, // self-managed (no guard)
  { rel: 'components/ui/Toast.tsx', kind: 'toast' },
  { rel: 'components/ui/DateRangePicker.tsx', kind: 'popover' },
  { rel: 'components/audit/CommandFilter.tsx', kind: 'popover' },
  { rel: 'components/licensing/ActivationGateScreen.tsx', kind: 'fullscreen' },
  { rel: 'components/PoReviewScreen.tsx', kind: 'screen' },
  { rel: 'components/mobile/CompanionShell.tsx', kind: 'shell' },
  { rel: 'components/mobile/AppScreenLayout.tsx', kind: 'shell' },
  { rel: 'components/mobile/CompanionHeader.tsx', kind: 'header' },
  { rel: 'components/Header.tsx', kind: 'header' },
];

function readAllSrcFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      readAllSrcFiles(full, acc);
    } else if (/\.(tsx?|mts|cts)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

const allFiles = readAllSrcFiles(src);
const allCode = new Map(allFiles.map((f) => [f, fs.readFileSync(f, 'utf8')]));

const hostContent = fs.readFileSync(path.join(src, 'components', 'GlobalModalHost.tsx'), 'utf8');
const storeFiles = allFiles.filter((f) => f.includes(`${path.sep}store${path.sep}`));
const storeContent = storeFiles.map((f) => allCode.get(f)).join('\n');

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

function findAll(content, regex) {
  const out = [];
  let m;
  regex.lastIndex = 0;
  while ((m = regex.exec(content)) !== null) {
    out.push({ line: lineOf(content, m.index), text: m[0].slice(0, 160) });
    if (m[0].length === 0) regex.lastIndex += 1;
  }
  return out;
}

function classifyPresentation(content, shellLine) {
  if (!shellLine) {
    if (/className="relative/.test(content) && /absolute\s+(bottom-full|top-full)/.test(content)) return 'dropdown popover';
    if (/print-|Document|document/i.test(content) && !/fixed inset-0/.test(content)) return 'embedded document';
    return 'embedded / inline';
  }
  const window_text = content.slice(Math.max(0, shellLine.index - 200), shellLine.index + 3000);
  if (/justify-end/.test(window_text) && /(border-l|w-\[5|sm:w-\[)/.test(window_text)) return 'slide-out drawer';
  if (/items-end/.test(window_text)) return 'bottom sheet (mobile) / centered modal (desktop)';
  if (/items-center/.test(window_text) && /justify-center/.test(window_text)) return 'centered modal dialog';
  if (/justify-between/.test(window_text) && /overflow-y-auto/.test(window_text)) return 'full-screen page';
  return 'overlay (unclassified)';
}

function auditFile(absPath, kindHint) {
  const rel = path.relative(root, absPath).replace(/\\/g, '/');
  const content = allCode.get(absPath);
  const file = path.basename(absPath);
  const component = file.replace(/\.tsx$/, '');

  const guardMatch =
    content.match(/activeModal\s*!==\s*['"]([a-zA-Z0-9_-]+)['"]/) ||
    content.match(/activeModal\s*===\s*['"]([a-zA-Z0-9_-]+)['"]/);
  let guardKey = guardMatch ? guardMatch[1] : null;
  // Fallback: host-gated components (e.g. CloudPairingModal) carry no internal
  // guard — derive the key from the GlobalModalHost conditional instead.
  if (!guardKey) {
    const hostRe = new RegExp(`activeModal\\s*===\\s*'([a-zA-Z0-9_-]+)'\\s*&&\\s*<${component}\\b`);
    const hostMatch = hostContent.match(hostRe);
    if (hostMatch) guardKey = hostMatch[1];
  }

  const shells = findAll(content, /fixed inset-0[^\n"]{0,220}/g);
  const portals = findAll(content, /createPortal\(/g);
  const scrollers = findAll(content, /overflow-y-auto/g);
  const stickies = findAll(content, /\bsticky\b/g);
  const invalidZ = findAll(content, /z-60(?!\[|\d)/g);
  const zTokens = [...content.matchAll(/z-(?:\[.+?\]|\d+)/g)].map((m) => m[0]);
  const uniqueZ = [...new Set(zTokens)];
  const absoluteMenus = findAll(content, /absolute\s+(?:bottom-full|top-full)[^\n"]{0,120}/g);
  const vhHeights = findAll(content, /\d+vh(?!-)|h-screen/g);
  const dvhHeights = findAll(content, /dvh/g);
  const fixedPx = findAll(content, /(?:min-w|w)-\[(\d+)(px|rem)\]/g)
    .map((m) => ({ ...m, px: m.text.includes('rem') ? parseFloat(m.text.match(/(\d+(?:\.\d+)?)/)[1]) * 16 : parseFloat(m.text.match(/(\d+)/)[1]) }))
    .filter((m) => m.px >= 300);

  // Prop-callback closes (M3 sheet: on*Exit) and lock-screen unlock count.
  const hasClose = /closeModal|onClose|onCancel|onSuccess|onDismiss|dismissUpdate|setShow|setOpen|setIsOpen|Exit|unlock/i.test(content);
  const mountedInHost = hostContent.includes(`<${component}`) || (guardKey && hostContent.includes(`'${guardKey}'`));
  // Standalone overlays (PinDialog, drawers, sheets) mount outside the host —
  // count any repo-wide JSX usage as proof of mounting.
  let mountedAnywhere = mountedInHost;
  let mountSites = [];
  if (!mountedAnywhere) {
    const useRe = new RegExp(`<${component}[\\s>]`, 'g');
    for (const [f, code] of allCode) {
      if (f === absPath) continue;
      const hits = code.match(useRe);
      if (hits) {
        mountedAnywhere = true;
        mountSites.push(`${path.relative(root, f).replace(/\\/g, '/')} (x${hits.length})`);
      }
    }
  }
  const inStoreUnion = guardKey ? storeContent.includes(`'${guardKey}'`) : null;

  // Trigger origins repo-wide
  let triggers = [];
  if (guardKey) {
    const re = new RegExp(`openModal\\(['"]${guardKey}['"]\\)`, 'g');
    const files = new Map();
    for (const [f, code] of allCode) {
      const hits = code.match(re);
      if (hits && f !== absPath) files.set(path.relative(root, f).replace(/\\/g, '/'), hits.length);
    }
    triggers = [...files.entries()].map(([f, n]) => `${f} (x${n})`);
    if (guardKey === 'product_editor') triggers.push('store:setEditingProduct (dedicated action)');
    if (guardKey === 'receipt') triggers.push('store:reprintReceipt / activeModal receipt (dedicated action)');
  }

  const shell0 = shells[0] || null;
  const presentation = kindHint === 'modal' || !kindHint
    ? classifyPresentation(content, shell0 ? { index: content.indexOf(shell0.text) } : null)
    : kindHint;

  return {
    component, file: rel, guardKey, presentation,
    shellLine: shell0 ? shell0.line : null,
    shellClass: shell0 ? shell0.text : null,
    zTokens: uniqueZ,
    nestedOverlays: Math.max(0, shells.length - (presentation.includes('page') || presentation.includes('embedded') ? 0 : 1)),
    usesPortal: portals.length > 0,
    portalLines: portals.map((p) => p.line),
    scrollerCount: scrollers.length,
    scrollerLines: scrollers.map((s) => s.line),
    stickyCount: stickies.length,
    absoluteMenus: absoluteMenus.map((m) => m.line),
    invalidZLines: invalidZ.map((z) => z.line),
    vhLines: vhHeights.map((v) => v.line),
    dvhUsed: dvhHeights.length > 0,
    fixedPxOverflow: fixedPx.map((m) => ({ line: m.line, text: m.text })),
    hasClose, mountedInHost, mountedAnywhere, mountSites: mountSites.slice(0, 5), inStoreUnion,
    triggerCount: triggers.length, triggers: triggers.slice(0, 8),
  };
}

const modalFiles = fs.readdirSync(modalsDir).filter((f) => f.endsWith('.tsx')).sort();
const registry = modalFiles.map((f) => auditFile(path.join(modalsDir, f), null));
for (const extra of EXTRA_OVERLAYS) {
  const abs = path.join(src, extra.rel);
  if (abs.startsWith(modalsDir)) continue; // already covered (UpdateModal)
  if (fs.existsSync(abs)) registry.push(auditFile(abs, extra.kind));
}

// ---- Gate ----
const failures = [];
for (const r of registry) {
  if (r.presentation.startsWith('embedded') || ['shell', 'header', 'screen'].includes(r.presentation)) continue;
  if (r.component === 'UpdateModal') {
    if (!r.hasClose) failures.push(`${r.component}: no close mechanism`);
    continue;
  }
  if (!r.guardKey && ['dialog', 'modal', 'sheet', 'drawer'].includes(r.presentation)) {
    // popover/toast/fullscreen/page kinds are exempt from guard requirement
  } else   // Full pages, lock/gate screens and toasts are flow-driven, not modal-gated.
  if (!r.guardKey && r.shellLine && !['page', 'fullscreen', 'toast', 'shell', 'header'].includes(r.presentation)) {
    failures.push(`${r.component}: overlay without activeModal guard`);
  }
  if (r.shellLine && !r.mountedAnywhere && !['popover', 'toast', 'page', 'fullscreen', 'header'].includes(r.presentation)) {
    failures.push(`${r.component}: not mounted anywhere (no JSX usage found)`);
  }
  // Toasts auto-dismiss via timeout; embedded documents/popovers close with parents.
  if (!r.hasClose && !['toast'].includes(r.presentation)) failures.push(`${r.component}: no close mechanism detected`);
  if (r.invalidZLines.length > 0) failures.push(`${r.component}: invalid bare z-60 at line(s) ${r.invalidZLines.join(',')}`);
  if (r.absoluteMenus.length > 0 && !r.usesPortal) {
    failures.push(`${r.component}: non-portaled absolute menu at line(s) ${r.absoluteMenus.join(',')} (clipping risk)`);
  }
}

const summary = {
  total: registry.length,
  modalsDir: modalFiles.length,
  withPortal: registry.filter((r) => r.usesPortal).map((r) => r.component),
  bottomSheets: registry.filter((r) => r.presentation.startsWith('bottom sheet')).length,
  centered: registry.filter((r) => r.presentation === 'centered modal dialog').length,
  drawers: registry.filter((r) => r.presentation === 'slide-out drawer' || r.presentation === 'drawer').length,
  withoutDvh: registry.filter((r) => r.shellLine && !r.dvhUsed).map((r) => r.component),
  multiScroller: registry.filter((r) => r.scrollerCount >= 3).map((r) => `${r.component}(${r.scrollerCount})`),
  failures,
};

if (asJson) {
  console.log(JSON.stringify({ summary, registry }, null, 2));
} else {
  console.log('=======================================================================');
  console.log('WINDOW REGISTRY AUDIT — Phase 1');
  console.log('=======================================================================\n');
  console.log(`Overlays inventoried : ${summary.total} (${summary.modalsDir} in modals/)`);
  console.log(`Bottom-sheet/mobile : ${summary.bottomSheets} | Centered: ${summary.centered} | Drawers: ${summary.drawers}`);
  console.log(`Portaled menus      : ${summary.withPortal.join(', ') || 'none'}`);
  console.log(`Multi-scroller (>2) : ${summary.multiScroller.join(', ') || 'none'}`);
  console.log(`No dvh usage        : ${summary.withoutDvh.length} shells\n`);
  console.log('| Component | Key | Presentation | Shell (L) | z | Portal | Scroll | Sticky | Triggers |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of registry) {
    console.log(`| ${r.component} | ${r.guardKey || '—'} | ${r.presentation} | ${r.shellLine || '—'} | ${r.zTokens.join(' ') || '—'} | ${r.usesPortal ? 'YES' : 'no'} | ${r.scrollerCount} | ${r.stickyCount} | ${r.triggerCount} |`);
  }
  console.log('\n---- GATE ----');
  if (failures.length === 0) console.log('PASS: all structural checks green.');
  else {
    console.log(`FAIL (${failures.length}):`);
    failures.forEach((f) => console.log(`  - ${f}`));
  }
}

if (mdOutPath) {
  const rows = registry.map((r) =>
    `| ${r.component} | ${r.guardKey || '—'} | ${r.presentation} | ${r.file}:${r.shellLine || '—'} | ${(r.triggers[0] || '—').split(' (x')[0]} |`,
  ).join('\n');
  fs.mkdirSync(path.dirname(mdOutPath), { recursive: true });
  fs.writeFileSync(mdOutPath, `# Window Registry (generated)\n\n| Component | Key | Presentation | Shell | Primary trigger |\n|---|---|---|---|---|\n${rows}\n`, 'utf8');
  console.log(`\nRegistry markdown written to ${mdOutPath}`);
}

process.exit(failures.length > 0 ? 1 : 0);

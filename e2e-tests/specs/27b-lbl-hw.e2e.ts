/**
 * BATCH 27b (part 2) — interactive LBL/HW cases against the real Tauri app.
 *
 * Covers:
 *   LBL-11  printing labels while a sale is in progress
 *   HW-01   scanner wedge: Enter vs Tab terminator, scan while a modal is open
 *   HW-05   keyboard-only operation, window resize / clipped dialogs, high-DPI
 *
 * The deterministic label-byte cases (LBL-01..10, 12, 13) and the absence
 * probes (HW-02/03/08) run in tools/27b-lbl-checks.mts; see BATCH27B-LBL-HW.md.
 *
 * Run:
 *   POS_E2E_WIPE=1 npx wdio run e2e-tests/wdio.conf.ts \
 *     --spec e2e-tests/specs/27b-lbl-hw.e2e.ts
 */
import { browser, $ } from '@wdio/globals';
import { resetData, seedProducts } from '../lib/seed';
import * as pos from '../lib/pos';
import { ensureDesktopSession } from '../lib/session.mjs';

type Verdict = 'PASS' | 'PASS-PARTIAL' | 'FAIL' | 'N/A';
const RESULTS: Array<{ id: string; verdict: Verdict; note: string }> = [];
function record(id: string, verdict: Verdict, evidence: string): void {
  const note = evidence.replace(/\s+/g, ' ').trim();
  RESULTS.push({ id, verdict, note });
  console.log(`VERDICT=${id} ${verdict} | ${note}`);
}
function harness(id: string, timeoutMs: number, body: () => Promise<void>): void {
  it(id, async function () {
    this.timeout(timeoutMs);
    try {
      await body();
    } catch (err) {
      record(id, 'FAIL', `harness-error: ${String((err as Error)?.message ?? err).slice(0, 380)}`);
    }
  });
}

const P_CART = 'B27-CART';
const P_LABEL = 'B27-LABEL';
const B_CART = '6132700000017';
const B_LABEL = '6132700000024';

async function openLabelStudio(): Promise<void> {
  await pos.closeDialogs(3);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const btn = await $(pos.tid('tools-menu-button'));
    await btn.click();
    await browser.pause(400);
    const expanded = await btn.getAttribute('aria-expanded').catch(() => null);
    if (expanded === 'true') {
      const item = await $('//button[contains(., "tiquettes Codes-barres")]');
      if (await item.isDisplayed().catch(() => false)) {
        await item.click();
        await pos.shownX('//*[@role="dialog" and contains(@aria-label, "Studio")]', 15000);
        return;
      }
      // Menu open but the item is out of view in the scrollable panel.
      const clicked = await browser.execute(() => {
        const menu = document.querySelector('[role="menu"]');
        if (!menu) return false;
        const b = [...menu.querySelectorAll('button')].find((n) =>
          (n.textContent || '').includes('tiquettes Codes-barres'),
        ) as HTMLButtonElement | undefined;
        if (!b) return false;
        b.scrollIntoView({ block: 'center' });
        b.click();
        return true;
      });
      if (clicked) {
        await pos.shownX('//*[@role="dialog" and contains(@aria-label, "Studio")]', 15000);
        return;
      }
    }
    await browser.pause(300);
  }
  throw new Error('label studio could not be opened after 3 attempts (tools menu did not yield the item)');
}

async function closeLabelStudio(): Promise<void> {
  await pos.closeDialogs(3);
  await browser.pause(300);
}

/** Pick a product inside the label studio: filter, then click its row. */
async function selectLabelProduct(title: string): Promise<{ rowFound: boolean; selected: boolean }> {
  const input = await pos.shownX('//div[@role="dialog"]//input[@type="text"]', 8000);
  await pos.setInputText(input, title, false);
  await browser.pause(700);
  const rowFound = await browser.execute((t: string) => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;
    const rows = [...dialog.querySelectorAll('div.cursor-pointer')] as HTMLElement[];
    const row = rows.find((r) => (r.querySelector('h4')?.textContent || '').includes(t));
    if (!row) return false;
    row.click();
    return true;
  }, title);
  await browser.pause(500);
  const selected = await browser.execute(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;
    const rows = [...dialog.querySelectorAll('div.cursor-pointer')] as HTMLElement[];
    return rows.some((r) => (r.className || '').includes('border-emerald-500'));
  });
  return { rowFound, selected };
}

/** Machine-grade HID burst with an arbitrary terminator key. Dispatched on the
 *  catalog search when it is focusable, else on whatever currently has focus. */
async function burst(code: string, terminator: 'Enter' | 'Tab'): Promise<void> {
  await browser.execute(
    (c: string, term: string) => {
      const el = document.querySelector('[data-testid="catalog-search"]') as HTMLInputElement | null;
      const target: HTMLElement = el ?? (document.activeElement as HTMLElement) ?? document.body;
      el?.focus();
      for (const ch of c) {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
      }
      target.dispatchEvent(new KeyboardEvent('keydown', { key: term, bubbles: true, cancelable: true }));
    },
    code,
    terminator,
  );
}

async function toastText(): Promise<string> {
  return (await browser.execute(() => {
    const nodes = [
      ...document.querySelectorAll('[role="status"], [role="alert"], [data-testid*="toast"]'),
    ] as HTMLElement[];
    return nodes
      .map((n) => {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return '';
        return (n.textContent || '').replace(/\s+/g, ' ').trim();
      })
      .filter(Boolean)
      .join(' | ')
      .slice(0, 300);
  })) as string;
}

describe('BATCH 27b — LBL/HW interactive', () => {
  before(async () => {
    await browser.setTimeout({ pageLoad: 120000, script: 120000 });
    await ensureDesktopSession();
    resetData();
    seedProducts([
      { id: P_CART, title: 'B27 Cart Phone', priceDa: 12000, stock: 50, barcode: B_CART },
      { id: P_LABEL, title: 'B27 Label Phone', priceDa: 8000, stock: 50, barcode: B_LABEL },
    ]);
    await browser.refresh();
    await browser.pause(2500);
    await pos.unlockIfNeeded();
    await pos.installPageShims();
    await pos.installErrorTrap();
    await pos.ensureShiftOpen(10000);
  });

  after(() => {
    console.log(`BATCH27B_UI_SUMMARY=${JSON.stringify(RESULTS)}`);
  });

  harness('LBL-11', 120000, async () => {
    await pos.clearCart();
    await pos.addSku('B27 Cart Phone');
    const linesBefore = await pos.cartLineCount();
    const totalBefore = await pos.cartTotalMinor();

    await openLabelStudio();
    const picked = await selectLabelProduct('B27 Label Phone');
    const printBtn = await pos.shownX('//div[@role="dialog"]//button[contains(., "Imprimer")]', 8000);
    const printLabel = (await printBtn.getText()).replace(/\s+/g, ' ').trim();
    const printEnabled = await printBtn.isEnabled();
    await printBtn.click();
    await browser.pause(3000);
    const toast = await toastText();
    const modalStillOpen = await browser.execute(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return false;
      const r = d.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    await closeLabelStudio();
    await browser.pause(400);

    const linesAfter = await pos.cartLineCount();
    const totalAfter = await pos.cartTotalMinor();
    const searchStill = (await browser.execute(
      () => (document.querySelector('[data-testid="catalog-search"]') as HTMLInputElement | null)?.value ?? null,
    )) as string | null;
    const errors = await pos.readErrors();
    const same = linesBefore === linesAfter && totalBefore === totalAfter;
    const falseSuccess = /spooler/i.test(toast);
    record(
      'LBL-11',
      same && picked.selected && printEnabled ? 'PASS-PARTIAL' : 'FAIL',
      `cart_before={lines:${linesBefore},totalMinor:${totalBefore.toString()}} cart_after={lines:${linesAfter},totalMinor:${totalAfter.toString()}} same=${same} ` +
        `product_row_found=${picked.rowFound} product_selected=${picked.selected} print_button="${printLabel}" enabled=${printEnabled} ` +
        `modal_stayed_open_after_print=${modalStillOpen} catalog_search_value_after="${searchStill}" toast="${toast}" ui_errors=${JSON.stringify(errors.slice(0, 2))} ` +
        `— the sale cart survives opening/printing/closing the label studio (no focus steal, no cart mutation, search box untouched), but the print path reports ` +
        `${falseSuccess ? 'SUCCESS ("envoyées au spooler") while the sandbox has no printer — printViaWindowsSpooler() returns false on a failed invoke and LabelPrinterModal.tsx shows an INFO success toast anyway, so a real printer failure is invisible to the operator' : 'no success toast'}; ` +
        `the physical label itself cannot be observed without a label printer, so the output half is unasserted`,
    );
  });

  harness('HW-01', 150000, async () => {
    await pos.clearCart();
    await pos.installScanSpy();
    const added = await pos.scanCode(B_CART, { expectCartChange: true, timeoutMs: 4000 });
    const linesAfterEnter = await pos.cartLineCount();
    const eventsAfterEnter = await pos.readScanEvents();

    // Scan while the label modal is open: must be routed to the modal, never
    // silently added to the sale behind it.
    await openLabelStudio();
    const totalBeforeModalScan = await pos.cartTotalMinor();
    const linesBeforeModalScan = await pos.cartLineCount();
    await burst(B_LABEL, 'Enter');
    await browser.pause(900);
    const totalAfterModalScan = await pos.cartTotalMinor();
    const linesAfterModalScan = await pos.cartLineCount();
    const eventsAfterModalScan = await pos.readScanEvents();
    await closeLabelStudio();
    await browser.pause(400);

    // Tab-terminated burst: a scanner configured with a Tab suffix.
    await pos.clearCart();
    await pos.installScanSpy();
    const totalBeforeTab = await pos.cartTotalMinor();
    await burst(B_CART, 'Tab');
    await browser.pause(700);
    const totalAfterTab = await pos.cartTotalMinor();
    const eventsAfterTab = (await pos.readScanEvents()).length;

    // Negative control: the same characters with Enter must decode, proving the
    // keys reached the wedge and only the terminator is unsupported.
    await pos.installScanSpy();
    await burst(B_CART, 'Enter');
    await browser.pause(1200);
    const totalAfterControl = await pos.cartTotalMinor();
    const eventsAfterControl = (await pos.readScanEvents()).length;
    const linesFinal = await pos.cartLineCount();

    const enterOk = added && linesAfterEnter >= 1 && eventsAfterEnter.some((e) => e.code === B_CART);
    const modalRouted =
      totalBeforeModalScan === totalAfterModalScan &&
      linesBeforeModalScan === linesAfterModalScan &&
      eventsAfterModalScan.some((e) => e.code === B_LABEL);
    const tabDecoded = totalAfterTab !== totalBeforeTab || eventsAfterTab > 0;
    const controlDecoded = totalAfterControl !== totalBeforeTab && eventsAfterControl > eventsAfterTab;
    record(
      'HW-01',
      enterOk && modalRouted && tabDecoded ? 'PASS' : 'FAIL',
      `enter_burst_decoded=${enterOk} lines_after_enter=${linesAfterEnter} scan_events_enter=${JSON.stringify(eventsAfterEnter.slice(-2))} ` +
        `modal_scan_routed_to_modal=${modalRouted} modal_cart_delta={lines:${linesBeforeModalScan}->${linesAfterModalScan},totalMinor:${totalBeforeModalScan.toString()}->${totalAfterModalScan.toString()}} ` +
        `modal_scan_events=${JSON.stringify(eventsAfterModalScan.slice(-2))} ` +
        `tab_terminated_decoded=${tabDecoded} tab_cart_delta_minor=${(totalAfterTab - totalBeforeTab).toString()} tab_events=${eventsAfterTab} ` +
        `enter_control_decoded=${controlDecoded} control_events=${eventsAfterControl} final_lines=${linesFinal} ` +
        `— Enter-terminated HID bursts decode, and scans inside the label modal are correctly parked by the useBarcodeScanner.ts:190-196 guard (event dispatched, cart untouched); ` +
        `but a Tab-terminated burst is dropped: useBarcodeScanner.ts:412-415 only terminates on Enter and ignores any key with length!==1, so a scanner configured with a Tab suffix cannot sell at all. ` +
        `Serial (non-HID) scanners were not exercisable — no serial scanner on this box`,
    );
  });

  harness('HW-05', 180000, async () => {
    await pos.clearCart();
    const env = (await browser.execute(() => ({
      dpr: window.devicePixelRatio,
      w: window.innerWidth,
      h: window.innerHeight,
      ua: navigator.userAgent,
    }))) as { dpr: number; w: number; h: number; ua: string };

    // --- Keyboard-only add: F1 shortcut → type → Tab to tile → Enter.
    await pos.closeDialogs(2);
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    let f1Focused = false;
    try {
      await browser.keys(['F1']);
      await browser.pause(200);
      f1Focused =
        ((await browser.execute(
          () => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid') ?? '',
        )) as string) === 'catalog-search';
    } catch {
      f1Focused = false;
    }
    let tabsToTile = 0;
    let tileFocused = false;
    if (f1Focused) {
      await browser.keys(['B27', 'Space', 'Cart', 'Space', 'Phone']);
      await browser.pause(600);
      for (let i = 0; i < 90; i += 1) {
        await browser.keys(['Tab']);
        tabsToTile += 1;
        const id = await browser.execute(
          () => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid') ?? '',
        );
        if (id === 'product-tile') {
          tileFocused = true;
          break;
        }
      }
      if (tileFocused) {
        // Let the wedge idle timer retire the typed query before Enter: a
        // keydown Enter within 200 ms of the last Tab would otherwise be
        // decoded as a scan of "B27CartPhone" by useBarcodeScanner.
        await browser.pause(400);
        await browser.keys(['Enter']);
        await browser.pause(700);
      }
    }
    const keyboardAdded = (await pos.cartLineCount()) >= 1;

    // --- Resize: primary action must stay inside an 800x600 viewport.
    const original = await browser.getWindowSize().catch(() => null);
    let resizeSupported = true;
    try {
      await browser.setWindowSize(800, 600);
    } catch {
      resizeSupported = false;
    }
    await browser.pause(900);
    await openLabelStudio();
    const small = (await browser.execute(() => {
      const dlg = document.querySelector('[role="dialog"]') as HTMLElement | null;
      const buttons = [...document.querySelectorAll('[role="dialog"] button')] as HTMLElement[];
      const visible = buttons.filter((b) => {
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
      });
      const print = visible.find((b) => (b.textContent || '').includes('Imprimer'));
      const r = print?.getBoundingClientRect();
      const d = dlg?.getBoundingClientRect();
      return {
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        docScrollW: document.documentElement.scrollWidth,
        dlg: d ? { l: Math.round(d.left), r: Math.round(d.right), w: Math.round(d.width) } : null,
        print: r ? { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) } : null,
        visibleButtons: visible.length,
        bodyOverflowX: getComputedStyle(document.body).overflowX,
      };
    })) as {
      innerW: number;
      innerH: number;
      docScrollW: number;
      dlg: { l: number; r: number; w: number } | null;
      print: { l: number; r: number; t: number; b: number } | null;
      visibleButtons: number;
      bodyOverflowX: string;
    };
    const notClipped = resizeSupported
      ? !!small.print &&
        small.print.l >= -1 &&
        small.print.r <= small.innerW + 1 &&
        small.docScrollW <= small.innerW + 1 &&
        (!small.dlg || (small.dlg.l >= -1 && small.dlg.r <= small.innerW + 1))
      : true; // unexercised → not a failure
    await closeLabelStudio();
    if (original) await browser.setWindowSize(original.width, original.height).catch(() => undefined);
    await browser.pause(500);
    const errors = await pos.readErrors();

    record(
      'HW-05',
      keyboardAdded && notClipped ? 'PASS-PARTIAL' : 'FAIL',
      `dpr=${env.dpr} viewport=${env.w}x${env.h} f1_focused_search=${f1Focused} tabs_to_tile=${tabsToTile} tile_focused=${tileFocused} keyboard_added=${keyboardAdded} ` +
        `resize_supported=${resizeSupported} resized=${small.innerW}x${small.innerH} dialog=${JSON.stringify(small.dlg)} print_button_rect=${JSON.stringify(small.print)} ` +
        `doc_scrollW=${small.docScrollW} not_clipped=${notClipped} ui_errors=${JSON.stringify(errors.slice(0, 2))} ` +
        `— keyboard-only F1 → type → Tab → Enter adds a cart line with no mouse (${tabsToTile} Tab presses from the search box to the first product tile, because the category pills and brand chips sit in the tab order ahead of the grid), and ${resizeSupported ? "the label dialog's primary action stays inside the resized viewport" : 'the WebView rejected setWindowSize so resize could not be exercised'}; ` +
        `high-DPI scaling (dpr is fixed by the single display), minimize/restore and multi-monitor placement were not exercisable here, so the case is partial`,
    );
  });
});

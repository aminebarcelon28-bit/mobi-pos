/**
 * UI-side helpers (adapted from the repo's proven `test/helpers/pos.ts`
 * patterns — copied, not imported, so this harness is self-contained and
 * the source tree stays untouched).
 */
import { browser, $, $$, expect } from '@wdio/globals';
import { APP_PIN } from './env';
import { invoke } from './invoke';

export { APP_PIN };

/** data-testid locator. */
export const tid = (id: string) => `[data-testid="${id}"]`;

/** First DISPLAYED match (mobile/desktop twins share testids). */
export async function shown(id: string) {
  const els = await $$(tid(id));
  for (const el of els) {
    if (await el.isDisplayed().catch(() => false)) return el;
  }
  throw new Error(`no displayed element for [data-testid="${id}"]`);
}

/** First DISPLAYED element matching an XPath (waits; throws on timeout).
 * Use when the selector must be structural (aria-label/placeholder) and a
 * hidden twin could precede the visible instance in document order. */
export async function shownX(xpath: string, timeout = 10000) {
  let found: Awaited<ReturnType<typeof $>> | null = null;
  await browser.waitUntil(
    async () => {
      const els = await $$(xpath);
      for (const el of els) {
        if (await el.isDisplayed().catch(() => false)) {
          found = el;
          return true;
        }
      }
      return false;
    },
    { timeout, interval: 200, timeoutMsg: `no displayed element for xpath ${xpath}` },
  );
  return found as unknown as Awaited<ReturnType<typeof $>>;
}

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
/** Parse any fr-DZ/DA display text to integer minor units (BigInt). */
export function displayedToMinor(raw: string): bigint {
  let s = [...raw]
    .map((ch) => {
      const i = ARABIC_INDIC.indexOf(ch);
      return i >= 0 ? String(i) : ch;
    })
    .join('');
  s = s.replace(/٬/g, '').replace(/٫/g, '.');
  // Intl fr-DZ renders the negative sign as U+2212 (not ASCII '-') — normalize.
  s = s.replace(/[−–—]/g, '-');
  s = s.replace(/[^\d.,\-]/g, '');
  const m = /^(-?)([\d.,]*?)(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Cannot parse money text: "${raw}"`);
  const [, sign, intPart, frac = ''] = m;
  const digits = intPart.replace(/[.,]/g, '') || '0';
  const v = BigInt(digits) * 100n + BigInt(frac.padEnd(2, '0'));
  return sign ? -v : v;
}

/** Stub window.print (receipt printing) so modals don't hang. */
export async function stubPrint(): Promise<void> {
  await browser
    .execute(() => {
      window.print = () => {
        window.dispatchEvent(new Event('beforeprint'));
        window.dispatchEvent(new Event('afterprint'));
      };
    })
    .catch(() => {});
}

/** Error trap: collect window errors / unhandled rejections since last reset.
 * The harness convention is that this runs after every page refresh, so it
 * also (re-)installs the page shims in the same pass. */
export async function installErrorTrap(): Promise<void> {
  await installPageShims();
  await browser.execute(() => {
    window.print = () => {
      window.dispatchEvent(new Event('beforeprint'));
      window.dispatchEvent(new Event('afterprint'));
    };
    const w = window as unknown as { __posErrors?: string[]; __posWrapped?: boolean };
    if (w.__posWrapped) {
      w.__posErrors = [];
      return;
    }
    w.__posErrors = [];
    w.__posWrapped = true;
    window.addEventListener('error', (e) => w.__posErrors?.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) =>
      w.__posErrors?.push(String((e as PromiseRejectionEvent).reason)),
    );
  });
}

export async function readErrors(): Promise<string[]> {
  return (await browser.execute(
    () => (window as unknown as { __posErrors?: string[] }).__posErrors ?? [],
  )) as string[];
}

export type BootScreen = 'setup' | 'lock' | 'dashboard';
/** Which boot gate is mounted RIGHT NOW — null while still booting. */
export async function detectBootScreen(): Promise<BootScreen | null> {
  const setup = await $(tid('setup-pin-root'));
  if (await setup.isDisplayed().catch(() => false)) return 'setup';
  const lock = await $(tid('lock-screen'));
  if (await lock.isDisplayed().catch(() => false)) return 'lock';
  const header = await $('header');
  if (await header.isDisplayed().catch(() => false)) return 'dashboard';
  return null;
}

/** Wait until one boot gate is visible (null ⇒ still booting). */
export async function waitForBootGate(timeout = 60000): Promise<BootScreen> {
  await browser.waitUntil(
    async () => (await detectBootScreen()) !== null,
    { timeout, interval: 300, timeoutMsg: 'no boot screen mounted (setup/lock/dashboard)' },
  );
  return (await detectBootScreen()) as BootScreen;
}

/** Setup (fresh container) or lock screen -> dashboard with the app PIN. */
export async function unlockIfNeeded(pin = APP_PIN): Promise<void> {
  await stubPrint();
  await waitForBootGate();
  if ((await detectBootScreen()) === 'setup') {
    await (await $(tid('setup-manager-name'))).setValue('E2E Gerant');
    await (await $(tid('setup-manager-new'))).setValue(pin);
    await (await $(tid('setup-manager-confirm'))).setValue(pin);
    await (await $(tid('setup-save'))).click();
    await browser.waitUntil(
      async () => {
        const s = await detectBootScreen();
        return s === 'lock' || s === 'dashboard';
      },
      { timeout: 120000, timeoutMsg: 'setup did not yield lock/dashboard' },
    );
  }
  if ((await detectBootScreen()) === 'lock') {
    const lock = await $(tid('lock-screen'));
    await lock.waitForDisplayed({ timeout: 20000 });
    const pad = await $(tid('login-pin-pad'));
    await pad.waitForDisplayed({ timeout: 20000 });
    await pad.click();
    await browser.keys(pin.split(''));
    const submit = await $(tid('login-submit'));
    if (await submit.isDisplayed().catch(() => false)) {
      await submit.click();
    }
    await (await $('header')).waitForDisplayed({ timeout: 90000 });
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Input primitives. Empirical findings (PROBE-01..05) that shape these:
 *  1. `element.clearValue()` silently no-ops on this msedgedriver for
 *     controlled React inputs (MoneyInput showed "20 000.00" + typed "10000"
 *     → "20 000.0010000" → parse rejection). Clear with REAL keys instead:
 *     focus → Ctrl+A → Backspace.
 *  2. Typing machine-fast into the sanctioned search target can trip the
 *     wedge-burst barcode decoder on Enter (gaps ≤ 25 ms). The map keys are
 *     barcode + sku + id, so typing a barcode/sku and hitting Enter is a
 *     REAL scan path (cart +1, input cleared). Search tokens that are not
 *     product keys decode to "unrecognized" (no cart effect).
 *  3. Ctrl+A emits keydown 'a' which the wedge state machine accumulates.
 *     For scan flows that must decode the EXACT code, select-all is done via
 *     Selection API (no key events) before typing.
 * ──────────────────────────────────────────────────────────────────────── */

/** Clear an input with real keys (Ctrl+A + Backspace), then type `text`. */
export async function typeReal(
  el: Awaited<ReturnType<typeof $>>,
  text: string,
  pressEnter = true,
): Promise<void> {
  await el.click();
  await browser.keys(['Control', 'a']);
  await browser.keys(['Backspace']);
  if (text) await browser.keys(text.split(''));
  if (pressEnter) await browser.keys(['Enter']);
}

/**
 * Focus an input WITHOUT a center click where possible: center clicks get
 * intercepted by inline overlay buttons (observed on the header search: its
 * clear-X `svg.lucide-x` intercepts `element click intercepted`). Falls back
 * to a plain click only if element-targeted JS focus is unsupported.
 */
export async function setInputText(
  el: Awaited<ReturnType<typeof $>>,
  text: string,
  pressEnter = true,
): Promise<void> {
  try {
    await browser.execute((node: HTMLElement | null) => node?.focus(), el as unknown as HTMLElement);
  } catch {
    await el.click();
  }
  await browser.keys(['Control', 'a']);
  await browser.keys(['Backspace']);
  if (text) await browser.keys(text.split(''));
  if (pressEnter) await browser.keys(['Enter']);
}

/**
 * Focus the header search via the app's own shortcut (F1 — Header.tsx:200-212
 * focuses and selects the text). Click-free: the inline clear-X button
 * intercepts center clicks whenever the field holds text.
 */
export async function focusSearch(): Promise<void> {
  const focused = await browser.execute(
    () => document.activeElement?.getAttribute?.('data-testid') ?? null,
  );
  if (focused === 'catalog-search') return;
  await browser.keys(['F1']);
  await browser.pause(120);
  const now = await browser.execute(
    () => document.activeElement?.getAttribute?.('data-testid') ?? null,
  );
  if (now !== 'catalog-search') {
    throw new Error('F1 shortcut did not focus the catalog search input');
  }
}

/** Set the header catalog search text (F1 focus; see focusSearch). */
export async function setSearchText(text: string, pressEnter = true): Promise<void> {
  await focusSearch();
  await browser.keys(['Control', 'a']);
  await browser.keys(['Backspace']);
  if (text) await browser.keys(text.split(''));
  if (pressEnter) await browser.keys(['Enter']);
}

/** Type digits into a MoneyInput (focus → Ctrl+A → Backspace → digits →
 * Enter commits via blur). Proven in PROBE-05 (total settled exactly). */
export async function typeMoneyInto(el: Awaited<ReturnType<typeof $>>, digits: number | string): Promise<void> {
  await typeReal(el, String(digits), true);
}

/** Select-all on the (header) search input without emitting content keys:
 * focus via the app's F1 shortcut, then set the selection with the Selection
 * API. No single-char keydowns → no wedge-burst pollution, no click →
 * no clear-X interception. */
export async function selectAllNoKeys(_el?: unknown): Promise<void> {
  await focusSearch();
  await browser.execute(() => {
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    try {
      active?.setSelectionRange?.(0, (active.value ?? '').length);
    } catch {
      /* non-text inputs have no selection API */
    }
  });
}

/** First displayed product tile whose text contains `needle` (title span).
 * If the catalog grid renders zero tiles (observed transiently in batch 1),
 * dumps diagnostics + screenshot, then retries once with a cleared search. */
export async function findTile(needle: string) {
  let firstError: Error | null = null;
  try {
    await browser.waitUntil(
      async () => (await $$(tid('product-tile'))).length > 0,
      { timeout: 20000, timeoutMsg: 'no product tiles rendered' },
    );
  } catch (err) {
    firstError = err as Error;
    const diag = await browser.execute(() => {
      const search = document.querySelector(
        '[data-testid="catalog-search"]',
      ) as HTMLInputElement | null;
      return {
        searchValue: search?.value ?? null,
        tileCount: document.querySelectorAll('[data-testid="product-tile"]').length,
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map(
          (d) => d.getAttribute('aria-label') || d.getAttribute('data-testid') || 'dialog',
        ),
        bodySnippet: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
      };
    });
    console.log(`[findTile] EMPTY CATALOG for "${needle}": ${JSON.stringify(diag)}`);
    await browser.saveScreenshot('e2e-tests/results/findTile-empty.png').catch(() => {});
    // Recovery: clear the search so the full catalog renders, then retry once.
    await setSearchText('', false);
    await browser.pause(400);
    await browser.waitUntil(
      async () => (await $$(tid('product-tile'))).length > 0,
      { timeout: 15000, timeoutMsg: `no product tiles even with cleared search (diag: ${JSON.stringify(diag)})` },
    );
    console.log(`[findTile] recovered via cleared search (needle "${needle}")`,
      `firstError=${JSON.stringify(firstError.message)}`);
  }
  const tiles = await $$(tid('product-tile'));
  for (const t of tiles) {
    if (await t.isDisplayed().catch(() => false)) {
      const txt = await t.getText().catch(() => '');
      if (txt.includes(needle)) return t;
    }
  }
  throw new Error(`no displayed product tile containing "${needle}"`);
}

/** Summed quantity of the visible cart lines (0 when no cart panel). */
async function cartQtySum(): Promise<number> {
  return (await browser.execute(() => {
    const inputs = [
      ...document.querySelectorAll('[data-testid="cart-qty-input"]'),
    ] as HTMLInputElement[];
    return inputs.reduce((acc, i) => acc + (Math.abs(Number(i.value)) || 0), 0);
  })) as number;
}

/** Click a catalog tile without tripping over the sticky pricing-tier strip
 * (run-04: 'element click intercepted … Filtrer par niveau de tarification'):
 * centre it first, try the native click, and fall back to a JS click (React's
 * delegated handler fires either way) when any overlay intercepts the pointer
 * at the element's centre point. */
async function clickTile(tile: Awaited<ReturnType<typeof findTile>>): Promise<void> {
  await browser.execute((el: HTMLElement) => {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, tile as unknown as HTMLElement);
  await browser.pause(150);
  try {
    await tile.click();
    return;
  } catch (err) {
    const overlays = await browser
      .execute(() =>
        ([...document.querySelectorAll('[role="dialog"]')] as HTMLElement[])
          .filter((d) => {
            try {
              const r = d.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            } catch {
              return false;
            }
          })
          .map((d) => d.getAttribute('aria-label') ?? d.getAttribute('data-testid') ?? '?'),
      )
      .catch(() => [] as string[]);
    console.log(
      `[addSku] native tile click intercepted — JS-click fallback (open dialogs: ${JSON.stringify(overlays)}): ${String((err as Error).message).slice(0, 140)}`,
    );
  }
  await browser.execute((el: HTMLElement) => el.click(), tile as unknown as HTMLElement);
  await browser.pause(150);
}

/** Add a product via the catalog UI. `searchToken` must NOT be the product's
 * barcode/sku/id (those are wedge keys and Enter would scan-add). Use a title
 * fragment; the tile is picked by `expectTitle ?? searchToken` text. */
export async function addSku(
  searchToken: string,
  opts: { times?: number; expectTitle?: string } = {},
): Promise<void> {
  const { times = 1, expectTitle } = opts;
  await setSearchText(searchToken);
  const tile = await findTile(expectTitle ?? searchToken);
  const qtyBefore = await cartQtySum();
  for (let i = 0; i < times; i++) {
    await clickTile(tile);
    await browser.pause(150);
  }
  // A silently-lost click poisons every downstream assertion — verify the
  // add landed (one merged line per product, so compare the summed quantity).
  try {
    await browser.waitUntil(async () => (await cartQtySum()) >= qtyBefore + times, {
      timeout: 6000,
      interval: 200,
      timeoutMsg: `tile click(s) for "${expectTitle ?? searchToken}" did not change the cart`,
    });
  } catch (err) {
    const diag = await browser.execute(() => ({
      bodySnippet: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
      tiles: document.querySelectorAll('[data-testid="product-tile"]').length,
    }));
    throw new Error(`${(err as Error).message} :: ${JSON.stringify(diag)}`);
  }
  await setSearchText('', false);
}

/** Install a capture spy for `pos:barcode-scanned` (recognized AND
 * unrecognized scans both dispatch it). */
export async function installScanSpy(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as { __posScanSpy?: boolean; __posScanEvents?: unknown[] };
    if (w.__posScanSpy) {
      w.__posScanEvents = [];
      return;
    }
    w.__posScanSpy = true;
    w.__posScanEvents = [];
    window.addEventListener('pos:barcode-scanned', (e) => {
      w.__posScanEvents?.push((e as CustomEvent).detail);
    });
  });
}

export async function readScanEvents(): Promise<{ code: string; multiplier: number }[]> {
  return (await browser.execute(
    () => (window as unknown as { __posScanEvents?: unknown[] }).__posScanEvents ?? [],
  )) as { code: string; multiplier: number }[];
}

/** Synthetic machine-grade HID burst through the REAL wedge listener path
 * (keydown events on the sanctioned search input, ~0 ms gaps + Enter).
 * Fallback for when driver-timing typing fails the ≤25 ms cadence. */
async function wedgeBurstSynthetic(code: string): Promise<void> {
  await browser.execute((c: string) => {
    const el = document.querySelector('[data-testid="catalog-search"]') as HTMLInputElement | null;
    const target: HTMLElement = el ?? document.body;
    el?.focus();
    for (const ch of c) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
    }
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  }, code);
}

/** Scan a barcode through the UI. Fast path: real typing + Enter (wedge).
 * The app dispatches `pos:barcode-scanned` the moment it decodes (~100 ms);
 * that event is the decode signal, so the fallback can only fire for a burst
 * that never decoded at all. Waiting on the cart write instead made a slow
 * post-sale write look like a lost burst and re-sent it 1.2 s later — the
 * second send lands outside the app's 400 ms duplicate-scan debounce and adds
 * a second unit (HARNESS-07). One scan = one dispatch, always.
 * Returns whether the cart changed (false for genuine "unrecognized scan"
 * flows). */
export async function scanCode(
  code: string,
  opts: { expectCartChange?: boolean; timeoutMs?: number } = {},
): Promise<boolean> {
  const { expectCartChange = true, timeoutMs = 2500 } = opts;
  const before = await cartTotalMinor().catch(() => 0n);
  const eventsBefore = (await readScanEvents().catch(() => [])).length;
  const t0 = Date.now();
  const search = await $(tid('catalog-search'));
  await search.waitForDisplayed({ timeout: 20000 });
  await selectAllNoKeys(search);
  await browser.keys(code.split(''));
  await browser.keys(['Enter']);

  let dispatches = 1;
  let events = (await waitScanEventsAtLeast(eventsBefore + 1, timeoutMs)) - eventsBefore;
  if (events === 0) {
    // Re-check immediately before the fallback: only a burst that never
    // decoded may be replayed. A decoded-but-unrecognized scan must not be.
    events = (await waitScanEventsAtLeast(eventsBefore + 1, 100)) - eventsBefore;
    if (events === 0) {
      await wedgeBurstSynthetic(code);
      dispatches += 1;
      events = (await waitScanEventsAtLeast(eventsBefore + 1, timeoutMs)) - eventsBefore;
    }
  }

  let changed = false;
  if (expectCartChange) changed = await waitCartChange(before, timeoutMs);

  console.log(
    `[scan-diag] code=${code} ms=${Date.now() - t0} dispatches=${dispatches} ` +
      `events=${events} changed=${String(changed)}`,
  );
  // Terminal invariant: one scan must reach the app exactly once. The counts
  // name the culprit, so classify instead of guessing:
  //   dispatches >= 2 -> the driver sent twice (harness bug)
  //   dispatches == 1 -> the app handled one scan twice (money bug: double
  //                      line, double charge) - file it, never dedupe it here.
  if (events > 1) {
    const verdict =
      dispatches >= 2
        ? 'HARNESS BUG: the driver sent the code twice - fix scanCode(), never retry past it'
        : 'APP BUG: one scan was handled twice (money bug: double line / double charge) - file it, do not dedupe in the test';
    throw new Error(
      `HARNESS_SCAN_DOUBLE_DISPATCH: scan "${code}" produced ${events} app events ` +
        `from ${dispatches} dispatch(es) - ${verdict}`,
    );
  }
  await selectAllNoKeys(search);
  await browser.keys(['Backspace']);
  if (expectCartChange && !changed) {
    throw new Error(`scan "${code}" produced no cart change (wedge did not decode)`);
  }
  return changed;
}

/** Poll the scan spy until at least `min` events are recorded (or timeout). */
async function waitScanEventsAtLeast(min: number, timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < timeoutMs) {
    n = (await readScanEvents().catch(() => [])).length;
    if (n >= min) return n;
    await new Promise((r) => setTimeout(r, 25));
  }
  return n;
}

/** True once the cart total differs from `before` (poll). */
export async function waitCartChange(before: bigint, timeoutMs: number): Promise<boolean> {
  try {
    await browser.waitUntil(
      async () => (await cartTotalMinor()) !== before,
      { timeout: timeoutMs, interval: 150, timeoutMsg: 'cart unchanged' },
    );
    return true;
  } catch {
    return false;
  }
}

/** Count cart lines (merging products collapse into one line). */
export async function cartLineCount(): Promise<number> {
  const lines = await $$(tid('cart-line'));
  let n = 0;
  for (const l of lines) if (await l.isDisplayed().catch(() => false)) n++;
  return n;
}

export async function cartTotalMinor(): Promise<bigint> {
  const el = await $(tid('cart-total'));
  await el.waitForDisplayed({ timeout: 20000 });
  return displayedToMinor(await el.getText());
}

/** Visible text of every displayed cart line (for price/qty/label parsing). */
export async function cartLineTexts(): Promise<string[]> {
  const lines = await $$(tid('cart-line'));
  const out: string[] = [];
  for (const l of lines) {
    if (await l.isDisplayed().catch(() => false)) out.push(await l.getText().catch(() => ''));
  }
  return out;
}

/** The displayed qty input of the LAST cart line. */
export async function lastQtyInput(): Promise<ReturnType<typeof $>> {
  const inputs = await $$(tid('cart-qty-input'));
  let last: ReturnType<typeof $> | null = null;
  for (const i of inputs) if (await i.isDisplayed().catch(() => false)) last = i;
  if (!last) throw new Error('no displayed cart-qty-input');
  return last;
}

/** Open the cart-discount modal, type a percent (accepts decimals, dot or
 * comma), fill the manager PIN when the gate appears, apply + wait close. */
export async function applyCartDiscountPercent(percent: string, opts: { pin?: string } = {}): Promise<void> {
  await (await $(tid('discount-button'))).click();
  await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 20000 });
  const input = await $(tid('discount-percent'));
  await typeReal(input, percent, false);
  await browser.pause(200);
  if (opts.pin) {
    const pin = await $(tid('discount-pin'));
    await pin.waitForDisplayed({ timeout: 10000, timeoutMsg: 'discount PIN field never appeared' });
    await typeReal(pin, opts.pin, false);
  }
  await (await $(tid('discount-apply'))).click();
  await browser.waitUntil(
    async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
    { timeout: 20000, timeoutMsg: 'discount dialog did not close' },
  );
}

/** Open the price editor on the LAST cart line, enter the new unit price
 * (MoneyInput), optionally fill the manager PIN, apply and settle. */
export async function overrideLastLinePrice(price: string, opts: { pin?: string } = {}): Promise<void> {
  const opens = await $$(tid('price-override-open'));
  let last: ReturnType<typeof $> | null = null;
  for (const o of opens) if (await o.isDisplayed().catch(() => false)) last = o;
  if (!last) throw new Error('no displayed price-override-open');
  await last.click();
  const input = await $(tid('price-override-input'));
  await input.waitForDisplayed({ timeout: 20000 });
  await typeMoneyInto(input, price);
  await browser.pause(250);
  if (opts.pin) {
    const pin = await $(tid('price-override-pin'));
    if (await pin.isDisplayed().catch(() => false)) {
      await typeReal(pin, opts.pin, false);
      await browser.pause(150);
      const readPin = async (): Promise<string> =>
        String(
          (await browser.execute(() => {
            const els = [...document.querySelectorAll('[data-testid="price-override-pin"]')] as HTMLInputElement[];
            return els.length > 0 ? els[els.length - 1].value : '';
          })) ?? '',
        );
      let got = await readPin();
      if (got !== opts.pin) {
        // Keyboard focus flaked (observed run-3: 40% override silently left
        // the line at list price). Set through the controlled-input native
        // setter so React's onChange updates `managerPinInput` (CartPanel).
        await browser.execute((v: string) => {
          const els = [...document.querySelectorAll('[data-testid="price-override-pin"]')] as HTMLInputElement[];
          const el = els[els.length - 1];
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          setter?.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }, opts.pin);
        await browser.pause(120);
        got = await readPin();
      }
      if (got !== opts.pin) {
        throw new Error(`price-override PIN field reads "${got}" — override would be rejected by the PIN gate`);
      }
    }
  }
  await (await $(tid('price-override-apply'))).click();
  // Fail-VISIBLE outcome: Valider closes the popover on success (CartPanel
  // `setEditingPriceProductId(null)`); on rejection the popover stays open
  // with `overrideError` rendered (e.g. "Remise > 20% : PIN Manager requis").
  await browser.waitUntil(
    async () => {
      const st = (await browser.execute(() => {
        const vis = (d: HTMLElement) => {
          try {
            const cs = getComputedStyle(d);
            if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
            const r = d.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          } catch {
            return false;
          }
        };
        const open = ([...document.querySelectorAll('[data-testid="price-override-input"]')] as HTMLElement[]).some(
          vis,
        );
        if (!open) return { open: false, error: '' };
        const errEl = ([...document.querySelectorAll('p')] as HTMLElement[]).find(
          (p) => vis(p) && /PIN|requis|invalide|Erreur|incorrect|Verrouill/i.test(p.textContent || ''),
        );
        return { open: true, error: errEl ? String(errEl.textContent || '').trim() : '' };
      })) as { open: boolean; error: string };
      if (!st.open) return true;
      if (st.error) throw new Error(`price override rejected: ${st.error}`);
      return false;
    },
    { timeout: 15000, interval: 250, timeoutMsg: 'price-override popover never closed after Valider' },
  );
  await browser.pause(150);
}

/** Toggle the LAST cart line to return mode via the "Échange" control
 * (manager PIN gate, CartPanel "Autorisation Retour / Échange"). The button
 * has no data-testid — located by its visible label inside a cart line. */
export async function toggleLastLineReturn(pin = APP_PIN): Promise<void> {
  const btns = await $$('//button[.//span[normalize-space()="Échange"]]');
  let last: Awaited<ReturnType<typeof $>> | null = null;
  for (const b of btns) if (await b.isDisplayed().catch(() => false)) last = b;
  if (!last) throw new Error('no displayed "Échange" toggle on cart lines');
  await last.click();
  const pinInput = await $('//h4[contains(., "Autorisation Retour")]/following::input[@type="password"][1]');
  await pinInput.waitForDisplayed({ timeout: 15000, timeoutMsg: 'return PIN prompt never appeared' });
  await typeReal(pinInput, pin, true); // Enter triggers handleConfirmReturnPin
  await browser.waitUntil(
    async () => !(await pinInput.isDisplayed().catch(() => false)),
    { timeout: 15000, timeoutMsg: 'return PIN prompt did not close after PIN' },
  );
  await browser.pause(250);
}

/** Remove every cart line through the shipped "Vider" control, falling back
 * to per-line removes. Leaves no dialog open and never throws. */
export async function drainCart(): Promise<void> {
  await browser.execute(() => {
    window.confirm = () => true;
  });
  const clear = await $(tid('cart-clear'));
  if (await clear.isDisplayed().catch(() => false)) {
    await clear.click().catch(() => undefined);
    await browser.pause(400);
  }
  if ((await cartLineCount()) > 0) {
    await clearCart().catch(() => undefined);
  }
}

/** Remove every cart line and close lingering dialogs (best-effort, but
 * verifies the postcondition: throws if lines remain). */
export async function clearCart(): Promise<void> {
  await browser.keys(['Escape']).catch(() => {});
  await closeDialogs(3);
  for (let i = 0; i < 60; i++) {
    const btns = await $$(tid('cart-line-remove'));
    const visible: typeof btns = [];
    for (const b of btns) if (await b.isDisplayed().catch(() => false)) visible.push(b);
    if (visible.length === 0) break;
    try {
      await visible[visible.length - 1].click();
    } catch {
      break;
    }
    await browser.pause(80);
  }
  if ((await cartLineCount()) > 0) {
    // Second pass after a settle pause — animations can hold stale buttons.
    await browser.pause(400);
    for (let i = 0; i < 60; i++) {
      const btns = await $$(tid('cart-line-remove'));
      const visible: typeof btns = [];
      for (const b of btns) if (await b.isDisplayed().catch(() => false)) visible.push(b);
      if (visible.length === 0) break;
      try {
        await visible[visible.length - 1].click();
      } catch {
        break;
      }
      await browser.pause(80);
    }
  }
  if ((await cartLineCount()) > 0) {
    throw new Error('clearCart: cart lines remain after two removal passes');
  }
}

/** Close any visible role=dialog overlays (Escape, bounded). */
/** Close visible dialogs by pressing Escape, up to `maxRounds` times. NOTE:
 * the visibility check must NOT use offsetParent — it is ALWAYS null for
 * position:fixed elements (every modal root), which made this a silent no-op
 * that left the customers modal covering the page in run-05. */
export async function closeDialogs(maxRounds = 3): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const open = await browser.execute(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')] as HTMLElement[];
      return dialogs.filter((d) => {
        try {
          const cs = getComputedStyle(d);
          if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
          const r = d.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        } catch {
          return false;
        }
      }).length;
    });
    if (open === 0) return;
    await browser.keys(['Escape']).catch(() => {});
    await browser.pause(250);
  }
}

/** Visible dialog labels/testids — diagnostic. Same fixed predicate as
 * closeDialogs (offsetParent is null for fixed overlays). */
export async function listDialogs(): Promise<string[]> {
  return (await browser.execute(() =>
    ([...document.querySelectorAll('[role="dialog"]')] as HTMLElement[])
      .filter((d) => {
        try {
          const cs = getComputedStyle(d);
          if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
          const r = d.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        } catch {
          return false;
        }
      })
      .map((d) => d.getAttribute('aria-label') ?? d.getAttribute('data-testid') ?? '?'),
  )) as string[];
}

/** Pay exact (cash) flow: checkout -> pay-exact -> confirm. */
export async function payExactFlow(): Promise<void> {
  await (await $(tid('checkout-button'))).click();
  await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
  await (await $(tid('pay-exact'))).click();
  await (await $(tid('pay-confirm'))).click();
  await browser.waitUntil(
    async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
    { timeout: 45000, timeoutMsg: 'pay dialog did not close' },
  );
}

/** Pay with an explicit tendered amount (change preview settles first).
 * NOTE (batch-1 evidence): pressing Enter inside the tendered field CONFIRMS
 * the payment immediately (PaymentModal onKeyDown) — the confirm button then
 * no longer exists. So type WITHOUT Enter (real keys only) and click confirm. */
export async function payTenderedFlow(tenderedDa: number | string): Promise<void> {
  await (await $(tid('checkout-button'))).click();
  await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
  await typeReal(await $(tid('tendered-input')), String(tenderedDa), false);
  await browser.pause(300);
  await (await $(tid('pay-confirm'))).click();
  await browser.waitUntil(
    async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
    { timeout: 45000, timeoutMsg: 'pay dialog did not close' },
  );
}

/** Open a shift through the real UI (both stores agree afterwards).
 * Float entry uses the proven clear+type sequence from PROBE-05. */
export async function openShiftUi(openingDa: number): Promise<void> {
  await (await $(tid('shift-pill'))).click();
  await (await $(tid('shift-open-dialog'))).waitForDisplayed({ timeout: 20000 });
  await (await $(tid('shift-open-direct'))).click();
  const float = await $(tid('shift-open-float'));
  await float.waitForDisplayed({ timeout: 20000 });
  await typeMoneyInto(float, openingDa);
  await browser.waitUntil(
    async () =>
      displayedToMinor(await (await $(tid('shift-open-total'))).getText()) === BigInt(openingDa) * 100n,
    { timeout: 20000, timeoutMsg: 'shift float did not settle' },
  );
  await (await $(tid('shift-open-confirm'))).click();
  await browser.waitUntil(
    async () => !(await $(tid('shift-open-dialog')).isDisplayed().catch(() => false)),
    { timeout: 40000, timeoutMsg: 'shift dialog did not close' },
  );
}

/** Postcondition helper: an OPEN shift exists (Dexie mirror); opens via UI
 * only when missing. Returns the open shift. */
export async function ensureShiftOpen(openingDa = 10000): Promise<DexieShift> {
  const existing = await readOpenShiftDexie();
  if (existing) return existing;
  await openShiftUi(openingDa);
  const opened = await readOpenShiftDexie();
  if (!opened) throw new Error('ensureShiftOpen: shift still missing after UI open');
  return opened;
}

/** Attach a customer to the sale by clicking THE TARGET's row action in the
 * customers modal (aria-label `Sélectionner <name> pour la vente`).
 * Typing + Enter is NOT used: `filteredCustomers` re-derives from
 * `debouncedSearch` (CustomersModal.tsx:372), so an immediate Enter would act
 * on the not-yet-filtered list (observed in run-01: always selected the
 * name-asc first row, "PAY Alpha"). If the target is already attached
 * (`Actif — Désélectionner <name>`), the dialog is closed WITHOUT clicking —
 * clicking would detach the sale's customer. */
export async function selectCustomer(name: string): Promise<void> {
  await (await $(tid('clients-button'))).click();
  await (await $(tid('customers-dialog'))).waitForDisplayed({ timeout: 20000 });
  const tryTarget = async (): Promise<'clicked' | 'already' | null> => {
    const btns = await $$(
      '//div[@data-testid="customers-dialog"]' +
        '//button[starts-with(@aria-label, "Sélectionner ") or starts-with(@aria-label, "Actif")' +
        ' or starts-with(@aria-label, "Sélectionné ") or starts-with(@aria-label, "Désélectionner")]',
    );
    for (const b of btns) {
      if (!(await b.isDisplayed().catch(() => false))) continue;
      const label = (await b.getAttribute('aria-label').catch(() => null)) ?? '';
      if (!label.includes(name)) continue;
      if (
        label.startsWith('Actif') ||
        label.startsWith('Sélectionné ') ||
        label.startsWith('Désélectionner')
      ) {
        return 'already';
      }
      await b.click();
      return 'clicked';
    }
    return null;
  };
  const probeTarget = async (ms: number): Promise<'clicked' | 'already' | null> => {
    let out: 'clicked' | 'already' | null = null;
    try {
      await browser.waitUntil(
        async () => {
          out = await tryTarget();
          return out !== null;
        },
        { timeout: ms, interval: 200 },
      );
    } catch {
      /* keep the last observed outcome — bounded probe */
    }
    return out;
  };
  // The directory list is virtualized (CustomersModal.tsx useVirtualizer :418,
  // two cards per row): only the first ~8 rows mount, so targets past the cut
  // never render. Scan first, then filter through the search box (renders in
  // the default 'list' view, :665-684; 200 ms debounce :48-52) so the target
  // row mounts at the top, then scan again.
  let outcome = await probeTarget(2500);
  if (outcome === null) {
    const filtered = (await browser.execute((text: string) => {
      const vis = (d: HTMLElement) => {
        try {
          const cs = getComputedStyle(d);
          if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
          const r = d.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        } catch {
          return false;
        }
      };
      const dlg = ([...document.querySelectorAll('[data-testid="customers-dialog"]')] as HTMLElement[]).find(vis);
      if (!dlg) return false;
      const el = dlg.querySelector('[data-testid="customer-search"]') as HTMLInputElement | null;
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      setter?.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, name)) as boolean;
    if (filtered) {
      await browser.pause(500); // debounce 200 ms + re-render
      outcome = await probeTarget(15000);
    }
    if (outcome === null) {
      throw new Error(
        `no row action for "${name}" in the customers dialog (virtualized list cut; search filter ${filtered ? 'applied' : 'not available'})`,
      );
    }
  }
  const dialogUp = async (): Promise<boolean> =>
    $(tid('customers-dialog')).isDisplayed().catch(() => false);
  if (outcome === 'clicked') {
    await browser.waitUntil(async () => !(await dialogUp()), {
      timeout: 15000,
      timeoutMsg: `customers dialog stayed open after selecting "${name}"`,
    });
  } else {
    // Already attached — close the modal without toggling the selection off.
    await closeDialogs(2);
    // Never trust the Escape path alone: run-05 proved closeDialogs could
    // silently no-op (offsetParent is null on fixed overlays) and the modal
    // then covered every later click. Verify, fall back to the modal's own
    // close button, and fail loudly if it still refuses to go.
    let closed = !(await dialogUp());
    if (!closed) {
      const x = await $(
        '//div[@data-testid="customers-dialog"]//button[@aria-label="Fermer"]',
      );
      if (await x.isDisplayed().catch(() => false)) {
        await x.click().catch(() => {});
        await browser.pause(300);
      }
      closed = await browser
        .waitUntil(async () => !(await dialogUp()), { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
    }
    if (!closed) {
      const diag = await browser.execute(() => ({
        dialogs: ([...document.querySelectorAll('[role="dialog"]')] as HTMLElement[])
          .filter((d) => {
            try {
              const r = d.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            } catch {
              return false;
            }
          })
          .map((d) => d.getAttribute('aria-label') ?? d.getAttribute('data-testid') ?? '?'),
        focus: (document.activeElement as HTMLElement | null)?.tagName ?? null,
      }));
      throw new Error(
        `customers dialog could not be closed after "already attached" for "${name}" :: ${JSON.stringify(diag)}`,
      );
    }
  }
  await browser.pause(200);
}

/** Clear web mirrors (localStorage + Dexie) WITHOUT refreshing. */
export async function wipeWebMirrors(): Promise<void> {
  await browser.execute(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
    try {
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
  });
  await browser.execute(
    () =>
      new Promise<boolean>((resolve) => {
        try {
          const req = indexedDB.deleteDatabase('MobiPosDB');
          req.onsuccess = () => resolve(true);
          req.onerror = () => resolve(false);
          req.onblocked = () => resolve(false);
        } catch {
          resolve(false);
        }
      }),
  );
}

/** Install page-side helper shims. The spec files are compiled with esbuild
 * keepNames, which emits `__name(fn, "...")` calls into serialized
 * `browser.execute` callbacks; the page must define `__name` BEFORE any such
 * body runs (run-01: "ReferenceError: __name is not defined"). MUST be sent
 * as a raw string script — a compiled callback would itself reference
 * `__name` before it exists. Survives only until the next page reload. */
export async function installPageShims(): Promise<void> {
  await browser.execute(
    'window.__name = window.__name || function (target, value) {' +
      ' try { Object.defineProperty(target, "name", { value: value, configurable: true }); }' +
      ' catch (_e) { /* non-configurable — name stays as-is */ }' +
      ' return target; };',
  );
  await browser.execute(() => {
    const w = window as unknown as { __e2eFShield?: boolean };
    if (w.__e2eFShield) return;
    w.__e2eFShield = true;
    // Shield the bare uppercase 'F' from the app's global function-key
    // preventDefault (useKeyboardHotkeys.ts:62-64 — `e.key.startsWith('F')
    // && e.key.length <= 3` runs with NO input-focus exemption, so typing 'F'
    // into any input is swallowed — an app finding the suite still records;
    // this shield keeps the harness able to type receipts/titles containing
    // 'F' without masking any app state under assertion). Capture-phase
    // stopPropagation on editable targets only: the character still inserts,
    // the global hotkey handler never sees it. F1..F12 (length > 1) and
    // modified combos pass through untouched.
    window.addEventListener(
      'keydown',
      (e) => {
        const t = e.target as HTMLElement | null;
        const editable =
          !!t &&
          (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
        if (editable && e.key === 'F' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.stopPropagation();
        }
      },
      true,
    );
  });
}

/** Wipe mirrors then reload so boot-time reads re-run from SQLite authority.
 * The reload drops page globals — re-install the shims immediately. */
export async function clearWebMirrors(): Promise<void> {
  await wipeWebMirrors();
  await browser.refresh();
  await installPageShims();
}

/** Seed bundle rows into the Dexie `bundles` mirror directly. The app's boot
 * hydration reads bundles from the Dexie mirror ONLY (`operationsAdapter`
 * `getAllBundles` → `dexieDb.bundles`); unlike products, there is no
 * SQLite→Dexie sync for `product_bundles`, so an out-of-band SQLite seed is
 * invisible to the store and a scanned bundle barcode would not resolve
 * (`useBarcodeScanner` reads `store.bundles`). Call AFTER `clearWebMirrors`
 * (Dexie deleted + app rebooted, schema recreated) and reload once more so
 * the store hydrates the rows. Shape: the app's `ProductBundle`. */
export async function seedBundleMirror(
  bundles: { id: string; bundleTitle: string; barcode: string; bundlePrice: number; childSkus: string[] }[],
): Promise<void> {
  // The app's Dexie DB is created lazily by its own first use (e.g. opening a
  // shift) — retry until the `bundles` store exists rather than racing boot.
  const deadline = Date.now() + 60000;
  let last = 'never attempted';
  while (Date.now() < deadline) {
    last = await browser.execute(async (rows: unknown[]) => {
      const idb = (window as unknown as { indexedDB?: IDBFactory }).indexedDB;
      if (!idb) return 'no indexedDB';
      return await new Promise<string>((resolve) => {
        let settled = false;
        const done = (v: string) => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        };
        try {
          const open = idb.open('MobiPosDB');
          open.onerror = () => done('open error');
          open.onblocked = () => done('open blocked');
          open.onsuccess = () => {
            const db = open.result;
            const stores = [...db.objectStoreNames].join(',');
            if (!db.objectStoreNames.contains('bundles')) {
              db.close();
              done(`no bundles store (have: ${stores})`);
              return;
            }
            try {
              const tx = db.transaction('bundles', 'readwrite');
              const store = tx.objectStore('bundles');
              for (const r of rows) store.put(r);
              tx.oncomplete = () => {
                db.close();
                done('ok');
              };
              tx.onerror = () => {
                db.close();
                done('put failed');
              };
              tx.onabort = () => {
                db.close();
                done('put aborted');
              };
            } catch (e) {
              db.close();
              done(`tx error: ${String((e as Error)?.message ?? e)}`);
            }
          };
        } catch (e) {
          done(`open threw: ${String((e as Error)?.message ?? e)}`);
        }
      });
    }, bundles as unknown[]);
    if (last === 'ok') return;
    await browser.pause(750);
  }
  throw new Error(`seedBundleMirror: bundles store never became writable — last: ${last}`);
}

/** Seed `customer_debts` rows into the Dexie `customerDebts` mirror directly.
 *  Same gap as bundles: the app's boot hydration reads the debt ledger from
 *  the Dexie mirror ONLY (`customerAdapter.getAllCustomerDebts` :411-413 →
 *  `dexieDb.customerDebts`), so an out-of-band SQLite seed is invisible to the
 *  store — the Kredy card's history toggle is gated on
 *  `meta.totalMovements > 0` (KredyTab.tsx:1012) and the plan form lives
 *  inside the expanded card, so without this the form is unreachable. The
 *  app's own write path dual-writes Dexie + SQLite
 *  (`customerAdapter.saveCustomerDebt` :359/:375); the harness mirrors both
 *  lanes. Call AFTER the app's Dexie DB exists (schema recreated
 *  post-`clearWebMirrors`) and reload once so the store hydrates the rows. */
export async function seedCustomerDebtMirror(rows: Record<string, unknown>[]): Promise<void> {
  const deadline = Date.now() + 60000;
  let last = 'never attempted';
  while (Date.now() < deadline) {
    last = await browser.execute(async (entries: unknown[]) => {
      const idb = (window as unknown as { indexedDB?: IDBFactory }).indexedDB;
      if (!idb) return 'no indexedDB';
      return await new Promise<string>((resolve) => {
        let settled = false;
        const done = (v: string) => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        };
        try {
          const open = idb.open('MobiPosDB');
          open.onerror = () => done('open error');
          open.onblocked = () => done('open blocked');
          open.onsuccess = () => {
            const db = open.result;
            const stores = [...db.objectStoreNames].join(',');
            if (!db.objectStoreNames.contains('customerDebts')) {
              db.close();
              done(`no customerDebts store (have: ${stores})`);
              return;
            }
            try {
              const tx = db.transaction('customerDebts', 'readwrite');
              const store = tx.objectStore('customerDebts');
              for (const r of entries) store.put(r);
              tx.oncomplete = () => {
                db.close();
                done('ok');
              };
              tx.onerror = () => {
                db.close();
                done('put failed');
              };
              tx.onabort = () => {
                db.close();
                done('put aborted');
              };
            } catch (e) {
              db.close();
              done(`tx error: ${String((e as Error)?.message ?? e)}`);
            }
          };
        } catch (e) {
          done(`open threw: ${String((e as Error)?.message ?? e)}`);
        }
      });
    }, rows as unknown[]);
    if (last === 'ok') return;
    await browser.pause(750);
  }
  throw new Error(`seedCustomerDebtMirror: customerDebts store never became writable — last: ${last}`);
}

export interface DexieShift {
  id: string;
  status: string;
  openingFloat: number;
  cashierName: string;
}

/** Read the active (OPEN) shift from the Dexie mirror. */
export async function readOpenShiftDexie(): Promise<DexieShift | null> {
  return (await browser.execute(async () => {
    const idb = (window as unknown as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) return null;
    return await new Promise<DexieShift | null>((resolve) => {
      try {
        const open = idb.open('MobiPosDB');
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          try {
            const db = open.result;
            if (!db.objectStoreNames.contains('cashSessions')) return resolve(null);
            const req = db
              .transaction('cashSessions', 'readonly')
              .objectStore('cashSessions')
              .getAll();
            req.onerror = () => resolve(null);
            req.onsuccess = () => {
              const rows = (req.result ?? []) as DexieShift[];
              resolve(rows.find((r) => r.status === 'OPEN') ?? null);
            };
          } catch {
            resolve(null);
          }
        };
      } catch {
        resolve(null);
      }
    });
  })) as DexieShift | null;
}

/** Read any Dexie object store (full scan) — for mirror-vs-authority checks. */
export async function readDexieStore<T = unknown>(store: string): Promise<T[]> {
  return (await browser.execute(async (s: string) => {
    const idb = (window as unknown as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) return [];
    return await new Promise<T[]>((resolve) => {
      try {
        const open = idb.open('MobiPosDB');
        open.onerror = () => resolve([]);
        open.onsuccess = () => {
          try {
            const db = open.result;
            if (!db.objectStoreNames.contains(s)) return resolve([]);
            const req = db.transaction(s, 'readonly').objectStore(s).getAll();
            req.onerror = () => resolve([]);
            req.onsuccess = () => resolve((req.result ?? []) as T[]);
          } catch {
            resolve([]);
          }
        };
      } catch {
        resolve([]);
      }
    });
  }, store)) as T[];
}

/** Device identity (adopted sync.device_id). */
export async function deviceId(): Promise<string> {
  const info = await invoke<{ deviceId: string }>('get_device_identity_info');
  return info.deviceId;
}

/** Wait for a fresh sale row (by ledger recentSales delta) and return its id. */
export async function waitNewSaleId(beforeId: string | null, timeoutMs = 45000): Promise<string> {
  let id = '';
  await browser.waitUntil(
    async () => {
      const st = await invoke<{ recentSales: { id: string }[] }>('e2e_get_db_state');
      id = st.recentSales[0]?.id ?? '';
      return id !== '' && id !== beforeId;
    },
    { timeout: timeoutMs, timeoutMsg: 'new sale did not land' },
  );
  return id;
}

/** Newest sale id from the ledger (helper for before/after comparisons). */
export async function latestSaleId(): Promise<string | null> {
  const st = await invoke<{ recentSales: { id: string }[] }>('e2e_get_db_state');
  return st.recentSales[0]?.id ?? null;
}

export interface SaleOut {
  found: boolean;
  id: string;
  receiptNumber: string;
  subtotalDa: number;
  discountTotalDa: number;
  totalDa: number;
  paymentMethod: string;
  cashTenderedDa: number;
  changeDueDa: number;
  status: string;
  lines: { productId: string; quantity: number; appliedPriceDa: number }[];
  tenders: { method: string; amountDa: number }[];
}

export const getSale = (id: string) => invoke<SaleOut>('e2e_get_sale', { id });

export async function expectNoUiErrors(context: string): Promise<void> {
  const errors = await readErrors();
  if (errors.length > 0) {
    // Log, but only assert empty in specs that opt in — many encyclopedia
    // cases intentionally provoke errors.
    console.log(`[ui-errors] ${context}: ${JSON.stringify(errors.slice(0, 5))}`);
  }
}

// ---------------------------------------------------------------------------
// REF — refunds / returns / avoirs (batch 3). RefundModal.tsx contracts:
//  - entry: [data-testid="refund-button"] (BottomBar) → refund-dialog;
//  - search: refund-search (filters by receipt/client); rows: refund-sale-row,
//    each clickable ticket initializes ALL still-refundable lines as CHECKED
//    at qty = remaining (RefundModal.tsx initializeRefundState :243-264);
//  - per line: refund-check-<pid>_<idx>, refund-dec-<pid>_<idx> /
//    refund-inc-<pid>_<idx> (bounded by remainingByItemKey), plus a text-only
//    restock toggle ("Remettre Stock (+n)" ↔ "Rebut / Défectueux");
//  - method buttons are TEXT-ONLY: "Espèces (Cash)" / "Avoir Magasin";
//  - refund-pin (password) + refund-submit (disabled until a line is selected,
//    total > 0 and not submitting).
// EVERY locator filters by computed visibility: the modal renders BOTH the
// mobile card list and the desktop table with the SAME testids (one is
// display:none), so querySelector would pick the hidden twin.
// ---------------------------------------------------------------------------

/** Visible refund-dialog predicate (fixed-overlay-safe, same predicate as closeDialogs). */
export async function refundDialogVisible(): Promise<boolean> {
  const dialogs = await $$(tid('refund-dialog'));
  for (const d of dialogs) {
    if (await d.isDisplayed().catch(() => false)) return true;
  }
  return false;
}

/** JS-click the visible refund-dialog's header X (Escape fallback). The modal
 * re-renders on every store tick, so native clicks on its controls are racy —
 * the same JS-click discipline the PAY spec established for pay-dialog. */
export async function forceCloseRefund(): Promise<void> {
  const clicked = (await browser.execute(() => {
    const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
    const dlg = ([...document.querySelectorAll('[data-testid="refund-dialog"]')] as HTMLElement[]).find(vis);
    if (!dlg) return false;
    const btn = dlg.querySelector('button[aria-label="Fermer"]') as HTMLButtonElement | null;
    if (!btn) return false;
    btn.click();
    return true;
  })) as boolean;
  if (!clicked) await browser.keys(['Escape']).catch(() => {});
  await browser.pause(400);
}

/** Open the refund modal (stale instances force-closed first). */
export async function openRefund(): Promise<void> {
  if (await refundDialogVisible()) {
    console.log('[openRefund] stale refund dialog visible — force-closing it first');
    await forceCloseRefund();
  }
  await closeDialogs(2);
  await (await $(tid('refund-button'))).click();
  await (await $(tid('refund-dialog'))).waitForDisplayed({ timeout: 20000 });
  await browser.pause(350);
}

export async function closeRefund(): Promise<void> {
  if (!(await refundDialogVisible())) return;
  await forceCloseRefund();
  if (await refundDialogVisible()) {
    await browser.keys(['Escape']).catch(() => {});
    await browser.pause(350);
  }
}

/** Type into the refund search field (real keys; clears first), then VERIFY
 *  the readback: the controlled input re-filters on every keystroke and a
 *  fast re-render can drop keys (run-01: catalog search held "RE P500" for
 *  "REF P500", refund search held a mangled receipt → "0 sur 0 tickets
 *  éligibles"). Retries, then falls back to the controlled-input setter. */
export async function refundSearch(text: string): Promise<void> {
  const input = await $(tid('refund-search'));
  await input.waitForDisplayed({ timeout: 10000 });
  const readback = async (): Promise<string> =>
    (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const el = ([...document.querySelectorAll('[data-testid="refund-search"]')] as HTMLInputElement[]).find(vis);
      return el ? el.value : '';
    })) as string;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await typeReal(input, text, false);
    await browser.pause(200);
    const got = await readback();
    if (got === text) {
      await browser.pause(350); // debounce the filtered list
      return;
    }
    console.log(`[refundSearch] keystroke dropped on attempt ${attempt}: "${got}" != "${text}" — retrying`);
  }
  await browser.execute((t: string) => {
    const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
    const el = ([...document.querySelectorAll('[data-testid="refund-search"]')] as HTMLInputElement[]).find(vis);
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, t);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await browser.pause(450);
  const final = await readback();
  if (final !== text) {
    throw new Error(`refund search never held the intended filter (wanted "${text}", readback "${final}")`);
  }
}

export type RefundTicketSelect = 'clicked' | 'disabled' | 'no-row';

/** Click the visible refund-sale-row whose text contains `receipt`.
 *  Returns 'disabled' for the offline-locked variant, 'no-row' after the
 *  timeout (the ticket is not offered / filtered out). */
export async function selectRefundTicket(receipt: string, timeout = 9000): Promise<RefundTicketSelect> {
  try {
    await browser.waitUntil(
      async () =>
        ((await browser.execute(
          (rc: string) => {
            const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
            const rows = ([...document.querySelectorAll('[data-testid="refund-sale-row"]')] as HTMLButtonElement[]).filter(vis);
            return rows.some((r) => (r.textContent || '').includes(rc));
          },
          receipt,
        )) as boolean),
      { timeout, interval: 250 },
    );
  } catch {
    return 'no-row';
  }
  // The offline lock (`RefundModal` `offlineLocked` = offline && !own-shift)
  // is driven by state that resolves asynchronously after the modal opens
  // (online probe, then the stable device id + active shift). Rows render
  // before it lands, so a transient `disabled` must not masquerade as the
  // deliberate offline lock: poll until the row is clickable (or the wait
  // budget expires). Genuinely foreign/past-shift tickets stay disabled for
  // the whole budget and still return 'disabled'.
  const deadline = Date.now() + Math.min(timeout, 6000);
  let out: RefundTicketSelect = 'disabled';
  for (;;) {
    out = (await browser.execute(
      (rc: string) => {
        const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
        const rows = ([...document.querySelectorAll('[data-testid="refund-sale-row"]')] as HTMLButtonElement[]).filter(vis);
        const row = rows.find((r) => (r.textContent || '').includes(rc));
        if (!row) return 'no-row';
        if (row.disabled) return 'disabled';
        row.click();
        return 'clicked';
      },
      receipt,
    )) as RefundTicketSelect;
    if (out !== 'disabled' || Date.now() >= deadline) break;
    await browser.pause(250);
  }
  await browser.pause(450);
  return out;
}

/** Count of visible refund-sale-row tickets. */
export async function refundTicketRowCount(): Promise<number> {
  return (await browser.execute(() => {
    const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
    return ([...document.querySelectorAll('[data-testid="refund-sale-row"]')] as HTMLElement[]).filter(vis).length;
  })) as number;
}

/** True when the visible refund list shows the empty-state text. */
export async function refundListEmpty(): Promise<boolean> {
  return (await browser.execute(() => {
    const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
    const dlg = ([...document.querySelectorAll('[data-testid="refund-dialog"]')] as HTMLElement[]).find(vis);
    if (!dlg) return false;
    return (dlg.textContent || '').includes('Aucun ticket éligible trouvé');
  })) as boolean;
}

/** Displayed refund-total in minor units (BigInt). */
export async function refundTotalMinor(): Promise<bigint> {
  const el = await $(tid('refund-total'));
  return displayedToMinor(await el.getText());
}

/** Current checkbox/qty state of one line (itemKey = `${productId}_${lineIdx}`).
 *  The DESKTOP stepper renders its `+` button WITHOUT a data-testid
 *  (RefundModal.tsx:958 — only the mobile card tags refund-inc-*), so the inc
 *  control is resolved by testid first, then as the last button in the
 *  visible `-` button's holder. */
export async function refundLineState(itemKey: string): Promise<{ checked: boolean; qty: number; decDisabled: boolean; incDisabled: boolean } | null> {
  return (await browser.execute(
    (key: string) => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const resolveInc = (): HTMLButtonElement | null => {
        const tagged = ([...document.querySelectorAll(`[data-testid="refund-inc-${key}"]`)] as HTMLButtonElement[]).find(vis);
        if (tagged) return tagged;
        const dec = ([...document.querySelectorAll(`[data-testid="refund-dec-${key}"]`)] as HTMLButtonElement[]).find(vis);
        const holder = dec?.parentElement;
        if (!holder) return null;
        const btns = [...holder.querySelectorAll('button')] as HTMLButtonElement[];
        return btns.length >= 2 ? btns[btns.length - 1] : null;
      };
      const chk = ([...document.querySelectorAll(`[data-testid="refund-check-${key}"]`)] as HTMLInputElement[]).find(vis);
      const dec = ([...document.querySelectorAll(`[data-testid="refund-dec-${key}"]`)] as HTMLButtonElement[]).find(vis);
      const inc = resolveInc();
      if (!chk && !dec && !inc) return null;
      let qty = NaN;
      if (dec) {
        const span = dec.parentElement?.querySelector('span.num') as HTMLElement | null;
        qty = Number((span?.textContent || '').trim());
      }
      return {
        checked: Boolean(chk?.checked),
        qty,
        decDisabled: dec ? dec.disabled : true,
        incDisabled: inc ? inc.disabled : true,
      };
    },
    itemKey,
  )) as { checked: boolean; qty: number; decDisabled: boolean; incDisabled: boolean } | null;
}

/** Click the visible refund line control (dec/inc/check) — JS click. The
 *  desktop `+` stepper button carries no testid; when the tagged mobile twin
 *  is hidden, fall back to the last button in the visible `-`'s holder. */
export async function clickRefundControl(testId: string): Promise<boolean> {
  const ok = (await browser.execute(
    (id: string) => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      let el: HTMLButtonElement | null = ([...document.querySelectorAll(`[data-testid="${id}"]`)] as HTMLButtonElement[]).find(vis) ?? null;
      if (!el && id.startsWith('refund-inc-')) {
        const key = id.slice('refund-inc-'.length);
        const dec = ([...document.querySelectorAll(`[data-testid="refund-dec-${key}"]`)] as HTMLButtonElement[]).find(vis);
        const holder = dec?.parentElement;
        if (holder) {
          const btns = [...holder.querySelectorAll('button')] as HTMLButtonElement[];
          if (btns.length >= 2) el = btns[btns.length - 1];
        }
      }
      if (!el || el.disabled) return false;
      el.click();
      return true;
    },
    testId,
  )) as boolean;
  await browser.pause(160);
  return ok;
}

/** Drive the quantity stepper until the displayed qty equals `target`. */
export async function setRefundQty(itemKey: string, target: number): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const st = await refundLineState(itemKey);
    if (!st) throw new Error(`refund line "${itemKey}" not found`);
    if (!st.checked) await clickRefundControl(`refund-check-${itemKey}`);
    const cur = (await refundLineState(itemKey))?.qty ?? NaN;
    if (cur === target) return;
    if (cur > target) {
      if (!(await clickRefundControl(`refund-dec-${itemKey}`))) {
        throw new Error(`refund-dec disabled while qty ${cur} > target ${target} (line ${itemKey})`);
      }
    } else {
      if (!(await clickRefundControl(`refund-inc-${itemKey}`))) {
        throw new Error(`refund-inc disabled while qty ${cur} < target ${target} (line ${itemKey})`);
      }
    }
  }
  const finalQty = (await refundLineState(itemKey))?.qty;
  throw new Error(`refund qty for ${itemKey} never reached ${target} (last ${finalQty})`);
}

/** Checked-line count among visible refund checkboxes. */
export async function refundCheckedCount(): Promise<number> {
  return (await browser.execute(() => {
    const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
    return ([...document.querySelectorAll('[data-testid^="refund-check-"]')] as HTMLInputElement[]).filter(
      (c) => vis(c) && c.checked,
    ).length;
  })) as number;
}

export type RefundMethod = 'Espèces' | 'Avoir Client';

/** Click a refund method button (TEXT-ONLY: "Espèces (Cash)" / "Avoir
 *  Magasin") and verify the active styling flipped. */
export async function selectRefundMethod(label: RefundMethod): Promise<void> {
  const visible = label === 'Espèces' ? 'Espèces (Cash)' : 'Avoir Magasin';
  const activeToken = label === 'Espèces' ? 'emerald-500/50' : 'purple-500/50';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const clicked = (await browser.execute(
      (txt: string) => {
        const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
        const dlg = ([...document.querySelectorAll('[data-testid="refund-dialog"]')] as HTMLElement[]).find(vis);
        if (!dlg) return false;
        const btn = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find((b) =>
          (b.textContent || '').includes(txt),
        );
        if (!btn) return false;
        btn.click();
        return true;
      },
      visible,
    )) as boolean;
    if (!clicked) throw new Error(`refund method "${visible}" button not found`);
    await browser.pause(250);
    const active = (await browser.execute(
      (txt: string, token: string) => {
        const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
        const dlg = ([...document.querySelectorAll('[data-testid="refund-dialog"]')] as HTMLElement[]).find(vis);
        if (!dlg) return false;
        const btn = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find((b) =>
          (b.textContent || '').includes(txt),
        );
        return btn ? String(btn.className).includes(token) : false;
      },
      visible,
      activeToken,
    )) as boolean;
    if (active) return;
    console.log(`[selectRefundMethod] "${visible}" not active after attempt ${attempt}`);
  }
  throw new Error(`refund method "${visible}" never became active`);
}

/** Type the manager PIN into refund-pin (no Enter — submit is a click). */
export async function typeRefundPin(pin: string): Promise<void> {
  const input = await $(tid('refund-pin'));
  await input.waitForDisplayed({ timeout: 10000 });
  await typeReal(input, pin, false);
  await browser.pause(200);
}

/** True when the visible refund-submit is disabled. */
export async function refundSubmitDisabled(): Promise<boolean> {
  return (await browser.execute(() => {
    const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
    const btn = ([...document.querySelectorAll('[data-testid="refund-submit"]')] as HTMLButtonElement[]).find(vis);
    return btn ? btn.disabled : true;
  })) as boolean;
}

/** Click refund-submit (JS, visible). `times=2` issues two click() calls in
 *  the SAME task — the double-submit replay probe. */
export async function clickRefundSubmit(times = 1): Promise<boolean> {
  const ok = (await browser.execute(
    (n: number) => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const btn = ([...document.querySelectorAll('[data-testid="refund-submit"]')] as HTMLButtonElement[]).find(vis);
      if (!btn) return false;
      for (let i = 0; i < n; i++) btn.click();
      return true;
    },
    times,
  )) as boolean;
  return ok;
}

/** Visible refund reason <select> (the only select in the dialog). */
async function refundReasonSelect() {
  return await $('//div[@data-testid="refund-dialog"]//select');
}

/** Pick a reason option by visible text ("Autre motif personnalisé..."),
 *  applied through the controlled-input native-setter + change pattern. */
export async function setRefundReason(optionVisibleText: string): Promise<void> {
  const ok = (await browser.execute((txt: string) => {
    const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
    const dlg = ([...document.querySelectorAll('[data-testid="refund-dialog"]')] as HTMLElement[]).find(vis);
    const sel = (dlg?.querySelector('select') ?? null) as HTMLSelectElement | null;
    if (!sel) return false;
    const opt = [...sel.options].find((o) => (o.textContent || '').includes(txt));
    if (!opt) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(sel, opt.value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, optionVisibleText)) as boolean;
  if (!ok) {
    // Fall back to the wdio API (visible text) — still validated below.
    const sel = await refundReasonSelect();
    await sel.selectByVisibleText(optionVisibleText);
  }
  await browser.pause(250);
}

/** Type the free-text reason (appears when reason = Autre). Non-ASCII safe:
 *  addValue with a native-setter fallback (Arabic/emoji payloads). */
export async function typeRefundCustomReason(text: string): Promise<void> {
  const input = await $('//div[@data-testid="refund-dialog"]//input[contains(@placeholder, "Précisez le motif")]');
  await input.waitForDisplayed({ timeout: 10000, timeoutMsg: 'custom reason input never appeared' });
  await input.click();
  await browser.keys(['Control', 'a']);
  await browser.keys(['Backspace']);
  try {
    await input.addValue(text);
  } catch {
    await browser.execute(
      (node: HTMLElement | null, t: string) => {
        if (!node) return;
        const proto = window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter?.call(node, t);
        node.dispatchEvent(new Event('input', { bubbles: true }));
      },
      input as unknown as HTMLElement,
      text,
    );
  }
  await browser.pause(250);
}

/** Toggle the line's restock/defective control (text-only button inside the
 *  line row). Returns the label AFTER the toggle ('Remettre Stock'/'Rebut'). */
export async function toggleRefundRestock(itemKey: string): Promise<string | null> {
  const label = (await browser.execute(
    (key: string) => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const chk = ([...document.querySelectorAll(`[data-testid="refund-check-${key}"]`)] as HTMLElement[]).find(vis);
      if (!chk) return null;
      let el: HTMLElement | null = chk;
      for (let hops = 0; hops < 8 && el; hops++) {
        const btn = ([...el.querySelectorAll('button')] as HTMLButtonElement[]).find((b) =>
          /Remettre Stock|Rebut/.test(b.textContent || ''),
        );
        if (btn) {
          if (btn.disabled) return null;
          btn.click();
          return 'clicked';
        }
        el = el.parentElement;
      }
      return null;
    },
    itemKey,
  )) as string | null;
  await browser.pause(250);
  if (label !== 'clicked') return label;
  return (await browser.execute(
    (key: string) => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const chk = ([...document.querySelectorAll(`[data-testid="refund-check-${key}"]`)] as HTMLElement[]).find(vis);
      if (!chk) return null;
      let el: HTMLElement | null = chk;
      for (let hops = 0; hops < 8 && el; hops++) {
        const btn = ([...el.querySelectorAll('button')] as HTMLButtonElement[]).find((b) =>
          /Remettre Stock|Rebut/.test(b.textContent || ''),
        );
        if (btn) return (btn.textContent || '').trim();
        el = el.parentElement;
      }
      return null;
    },
    itemKey,
  )) as string | null;
}

/** Arm a window.print() counter (stubs from installErrorTrap stay chained —
 *  the refund receipt is printed through printCoordinator → window.print). */
export async function armPrintCounter(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as { print: (...a: unknown[]) => unknown; __refPrintCalls?: number };
    if (!w.print) {
      w.print = () => undefined;
    }
    const prev = w.print.bind(window);
    w.__refPrintCalls = 0;
    w.print = (...args: unknown[]) => {
      w.__refPrintCalls = (w.__refPrintCalls ?? 0) + 1;
      try {
        return prev(...args);
      } catch {
        return undefined;
      }
    };
  });
}

export async function readPrintCalls(): Promise<number> {
  return (await browser.execute(
    () => (window as unknown as { __refPrintCalls?: number }).__refPrintCalls ?? 0,
  )) as number;
}

/** Wrap window.__TAURI_INTERNALS__.invoke to record IPC command names in
 *  order. Under Tauri the receipt/drawer effects never touch window.print —
 *  they are `sqlite_print_raw_escpos` / `sqlite_open_cash_drawer` invokes
 *  (escpos.ts:469-471 → api/hardware.ts → platform/invoke), so this is the
 *  observable proof of the print/drawer channel and of side-effect ORDER.
 *  The shipped bundle reads `window.__TAURI_INTERNALS__.invoke(...)` per call
 *  (verified in dist/assets) — run-02's plain assignment was silently inert
 *  (non-strict execute + a locked property), so the wrap is now identity-
 *  verified with a defineProperty fallback and a window-redirect last resort;
 *  the outcome string lands in __e2eInvokeWrapStatus for the spec to log. */
export async function armInvokeCounter(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__?: { invoke?: (...args: unknown[]) => unknown };
      __e2eInvokeCalls?: string[];
      __e2eInvokeWrapStatus?: string;
      __e2eWrapDone?: boolean;
    };
    w.__e2eInvokeCalls = [];
    const internals = w.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') {
      w.__e2eInvokeWrapStatus = internals ? 'no-invoke-fn' : 'no-internals';
      return;
    }
    if (w.__e2eWrapDone) return; // the wrapper persists across re-arms
    w.__e2eWrapDone = true;
    const orig = internals.invoke.bind(internals);
    const wrapper = (...args: unknown[]) => {
      try {
        (w.__e2eInvokeCalls = w.__e2eInvokeCalls || []).push(String(args[0] ?? ''));
      } catch {
        /* never break the app call path on recorder errors */
      }
      return orig(...args);
    };
    let ok = false;
    try {
      internals.invoke = wrapper; // fast path
      ok = internals.invoke === wrapper; // non-strict assignment may no-op
    } catch {
      /* fall through */
    }
    if (!ok) {
      try {
        Object.defineProperty(internals, 'invoke', { value: wrapper, writable: true, configurable: true });
        ok = internals.invoke === wrapper;
      } catch {
        /* frozen internals — try the window property below */
      }
    }
    if (!ok) {
      try {
        const desc = Object.getOwnPropertyDescriptor(w, '__TAURI_INTERNALS__');
        if (desc && desc.configurable) {
          const clone = Object.create(
            Object.getPrototypeOf(internals),
            Object.getOwnPropertyDescriptors(internals),
          ) as { invoke?: unknown };
          Object.defineProperty(clone, 'invoke', { value: wrapper, writable: true, configurable: true });
          Object.defineProperty(w, '__TAURI_INTERNALS__', { value: clone, writable: true, configurable: true });
          ok = w.__TAURI_INTERNALS__?.invoke === wrapper;
        }
      } catch {
        /* diagnostics below */
      }
    }
    if (ok) {
      w.__e2eInvokeWrapStatus = 'wrapped';
      return;
    }
    try {
      const d = Object.getOwnPropertyDescriptor(internals, 'invoke');
      const wd = Object.getOwnPropertyDescriptor(w, '__TAURI_INTERNALS__');
      w.__e2eInvokeWrapStatus =
        `wrap-failed internals.invoke{writable:${String(d?.writable)},configurable:${String(d?.configurable)}}` +
        ` window.__TAURI_INTERNALS__{writable:${String(wd?.writable)},configurable:${String(wd?.configurable)}}`;
    } catch {
      w.__e2eInvokeWrapStatus = 'wrap-failed (no descriptor access)';
    }
  });
}

/** Outcome of the last armInvokeCounter(): 'wrapped' | 'no-internals' |
 *  'no-invoke-fn' | 'wrap-failed …descriptors…' */
export async function readInvokeWrapStatus(): Promise<string> {
  return (await browser.execute(
    () => (window as unknown as { __e2eInvokeWrapStatus?: string }).__e2eInvokeWrapStatus ?? 'unknown',
  )) as string;
}

/** In-page console tap: records console.error/warn into `__e2eConsoleBuf`.
 *  The sandbox print path fails into `console.error('[ESC/POS Spooler Error]…')`
 *  (escpos.ts:400) because no printer exists while autoPrintEnabled defaults
 *  true (createUISlice.ts:142) — a second, independent side-effect channel
 *  when the invoke wrapper is inert. Re-arming resets the buffer. */
export async function armConsoleTap(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as {
      __e2eConsoleBuf?: string[];
      __e2eConsoleOrig?: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
    };
    if (!w.__e2eConsoleOrig) {
      w.__e2eConsoleOrig = {
        error: console.error.bind(console),
        warn: console.warn.bind(console),
      };
      const rec = (lvl: string, orig: (...a: unknown[]) => void) => (...a: unknown[]) => {
        try {
          const text = a
            .map((x) => {
              if (typeof x === 'string') return x;
              try {
                return JSON.stringify(x)?.slice(0, 200) ?? String(x);
              } catch {
                return String(x);
              }
            })
            .join(' ')
            .slice(0, 400);
          (w.__e2eConsoleBuf = w.__e2eConsoleBuf || []).push(`${lvl}: ${text}`);
        } catch {
          /* never break console */
        }
        return orig(...a);
      };
      console.error = rec('error', w.__e2eConsoleOrig.error);
      console.warn = rec('warn', w.__e2eConsoleOrig.warn);
    }
    w.__e2eConsoleBuf = [];
  });
}

/** All tapped console lines since armConsoleTap(). */
export async function readConsoleLines(): Promise<string[]> {
  return (await browser.execute(
    () => (window as unknown as { __e2eConsoleBuf?: string[] }).__e2eConsoleBuf ?? [],
  )) as string[];
}

/** Count tapped console lines matching a regex source string. */
export async function countConsoleMatching(pattern: string): Promise<number> {
  return (await browser.execute((pat: string) => {
    try {
      const r = new RegExp(pat);
      return ((window as unknown as { __e2eConsoleBuf?: string[] }).__e2eConsoleBuf ?? []).filter((l) =>
        r.test(l),
      ).length;
    } catch {
      return 0;
    }
  }, pattern)) as number;
}

/** All IPC command names seen since armInvokeCounter(), in call order. */
export async function readInvokeCalls(): Promise<string[]> {
  return (await browser.execute(
    () => (window as unknown as { __e2eInvokeCalls?: string[] }).__e2eInvokeCalls ?? [],
  )) as string[];
}

/** Count of recorded IPC calls whose command name starts with any prefix. */
export async function countInvokeCalls(prefixes: string[]): Promise<number> {
  const calls = await readInvokeCalls();
  return calls.filter((c) => prefixes.some((p) => c.startsWith(p))).length;
}

export { expect };

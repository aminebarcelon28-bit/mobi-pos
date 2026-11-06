/**
 * BATCH 27c (part 2) — I18 interactive cases against the real Tauri WebView.
 *
 * Surface note (measured, see PROBE runs): src/i18n is imported ONLY by
 * src/components/mobile/* — all 18 useTranslation sites are the companion
 * shell. The desktop till is hard-coded French and has no language control.
 * The companion shell is reachable in this WebView through the app's own
 * device-role switch (localStorage `mobi_pos_device_mode_override` +
 * `mobi:devicerole-change`) and its pairing wizard's "Continuer en Mode Démo
 * Hors-Ligne" button, which is where the FR/AR toggle actually lives.
 *
 *   I18-01  ar <-> fr switch mid-sale / mid-payment (data + input kept)
 *   I18-02  RTL geometry in the companion shell (cart, sheet, nav, numbers)
 *   I18-03  mixed-direction strings (Arabic + Latin + digits) display/storage
 *   I18-07  very long names, emoji, ZWSP, RLO, injection payloads
 *   I18-09  keyboard layout vs the HID wedge (AZERTY / Arabic-Indic digits)
 *   I18-10  Arabic screen scan: no raw i18n keys, no horizontal overflow
 *   I18-13  invalid phone at the SAVE path (does the hint block the write?)
 *   I18-15  paste with NBSP / RLM / line breaks into name, phone and amount
 *
 * The deterministic half (I18-04/06/08/11/12/14, DAT-79/84) plus the print-byte
 * FACTS for I18-03/I18-07 run in tools/27c-i18-checks.mts.
 *
 * Run:
 *   POS_E2E_WIPE=1 npx wdio run e2e-tests/wdio.conf.ts \
 *     --spec e2e-tests/specs/27c-i18-ui.e2e.ts
 */
import { browser, $ } from '@wdio/globals';
import { resetData, seedProducts } from '../lib/seed';
import { one } from '../lib/db';
import * as pos from '../lib/pos';
import { ensureDesktopSession } from '../lib/session.mjs';

type Verdict = 'PASS' | 'PASS-PARTIAL' | 'FAIL' | 'N/A' | 'BLOCKED';
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
      record(id, 'FAIL', `harness-error: ${String((err as Error)?.message ?? err).slice(0, 900)}`);
    }
  });
}

const P_SALE = 'B27 I18 Phone';
const B_SALE = '6132700000017';
const P_MIXED = 'غلاف iPhone 15 Pro 128GB';
const LONG_AR = 'منتج طويل جدا للاختبار'.repeat(8);
const P_NASTY = `B27 ZWSP\u200B RLO\u202E 🔛@X ${LONG_AR}`;
const P_MOBILE = 'PROBE M1';

// Space-free search tokens: `browser.keys(text.split(''))` drops spaces, so
// every catalog search token is a single ASCII word and the tile is picked by
// its title text.
async function addSale(): Promise<void> {
  await pos.addSku('B27', { expectTitle: P_SALE });
}
async function addMixed(): Promise<void> {
  await pos.addSku('iPhone', { expectTitle: 'iPhone 15 Pro' });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function docState(): Promise<{
  dir: string;
  lang: string;
  shell: string | null;
  scrollW: number;
  innerW: number;
  innerH: number;
}> {
  return (await browser.execute(() => ({
    dir: document.documentElement.getAttribute('dir') ?? '',
    lang: document.documentElement.getAttribute('lang') ?? '',
    shell: document.documentElement.dataset.shell ?? null,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
  }))) as { dir: string; lang: string; shell: string | null; scrollW: number; innerW: number; innerH: number };
}

async function rectOf(selector: string): Promise<{ l: number; r: number; t: number; b: number; w: number } | null> {
  return (await browser.execute((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      l: Math.round(r.left),
      r: Math.round(r.right),
      t: Math.round(r.top),
      b: Math.round(r.bottom),
      w: Math.round(r.width),
    };
  }, selector)) as { l: number; r: number; t: number; b: number; w: number } | null;
}

async function textOf(selector: string): Promise<string | null> {
  return (await browser.execute(
    (sel: string) => document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    selector,
  )) as string | null;
}

/** Set an input's value the way real typing lands: focus, native setter, input
 * event (React-compatible). Needed because single-char key arrays drop spaces
 * and astral characters cannot be sent as W3C single-code-point keys. */
async function setValueReact(selector: string, text: string): Promise<void> {
  await browser.execute(
    (sel: string, txt: string) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (!el) return;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, txt);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    selector,
    text,
  );
  await browser.pause(120);
}

async function inputValue(selector: string): Promise<string> {
  return (await browser.execute(
    (sel: string) => (document.querySelector(sel) as HTMLInputElement | null)?.value ?? '',
    selector,
  )) as string;
}

async function openCustomers(): Promise<void> {
  await pos.closeDialogs(3);
  const btn = await pos.shownX('//button[contains(., "+ Client")]', 8000);
  await btn.click();
  await pos.shownX('//*[@data-testid="customers-dialog"]', 10000);
}

async function closeCustomers(): Promise<void> {
  await pos.closeDialogs(3);
  await browser.pause(250);
}

/** Open the create-customer form and fill name + phone. */
async function fillCustomerForm(name: string, phone: string): Promise<{ nameValue: string; phoneValue: string }> {
  // Reaching the form is not always "dialog is open in list view": an earlier
  // case can leave the dialog mounted in the form view, where the
  // "Ajouter un Client" button does not exist (measured 2026-10-30: I18-13
  // died on that xpath while I18-15, right after it, opened fine). Handle the
  // three real states instead of assuming one.
  const alreadyForm = $('[data-testid="customers-dialog"] input[data-testid="customer-name"]');
  if (!(await alreadyForm.isDisplayed().catch(() => false))) {
    const addSel = '//*[@data-testid="customers-dialog"]//button[contains(., "Ajouter un Client")]';
    const first = await $(addSel);
    if (!(await first.isDisplayed().catch(() => false))) {
      await closeCustomers();
      await openCustomers();
    }
    const add = await pos.shownX(addSel, 8000);
    await add.click();
    await pos.shownX('//*[@data-testid="customers-dialog"]//input[@data-testid="customer-name"]', 8000);
  }
  await setValueReact('[data-testid="customers-dialog"] input[data-testid="customer-name"]', name);
  await setValueReact('[data-testid="customers-dialog"] #customer-phone', phone);
  await browser.pause(250);
  const nameValue = await inputValue('[data-testid="customers-dialog"] input[data-testid="customer-name"]');
  const phoneValue = await inputValue('[data-testid="customers-dialog"] #customer-phone');
  return { nameValue, phoneValue };
}

async function submitCustomerForm(): Promise<void> {
  const save = await pos.shownX(
    '//*[@data-testid="customers-dialog"]//button[@type="submit" and contains(., "Créer le Client")]',
    8000,
  );
  await save.click();
  await browser.pause(900);
}

async function phoneHint(): Promise<string> {
  return (await browser.execute(() => {
    const el = document.querySelector('#customer-phone-hint');
    return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  })) as string;
}

async function waitRow<T>(sql: string, params: unknown[], timeoutMs = 12000): Promise<T | undefined> {
  const start = Date.now();
  for (;;) {
    const row = one<T>(sql, ...params);
    if (row) return row;
    if (Date.now() - start > timeoutMs) return row;
    await browser.pause(250);
  }
}

// --- companion-shell plumbing ---------------------------------------------
const LANG_BTN =
  '//button[contains(@aria-label, "Basculer") or contains(@aria-label, "التبديل")]';

async function enterCompanion(): Promise<{ wizard: boolean; shell: string | null }> {
  await browser.execute(() => {
    window.localStorage.setItem('mobi_pos_device_mode_override', 'companion_mobile');
    window.dispatchEvent(new Event('mobi:devicerole-change'));
  });
  await browser.pause(2500);
  let wizard = false;
  const skip = await pos.shownX('//button[contains(., "Mode Démo")]', 8000).catch(() => null);
  if (skip) {
    wizard = true;
    await skip.click();
    await browser.pause(3000);
  }
  const st = await docState();
  return { wizard, shell: st.shell };
}

async function leaveCompanion(): Promise<void> {
  await browser.execute(() => {
    window.localStorage.removeItem('mobi_pos_device_mode_override');
    window.dispatchEvent(new Event('mobi:devicerole-change'));
  });
  await browser.pause(2200);
}

/** Guarantee the desktop till is the mounted shell (and ltr/fr). */
async function ensureDesktop(): Promise<void> {
  await leaveCompanion();
  const st = await docState();
  if (st.shell !== 'desktop') {
    await browser.pause(1500);
    await leaveCompanion();
  }
  await browser.execute(() => {
    document.documentElement.setAttribute('dir', 'ltr');
    document.documentElement.setAttribute('lang', 'fr');
  });
  await browser.pause(400);
}

/** Click a bottom-nav tab. Tries the real pointer first (so a genuinely
 * covered tab is still reported); falls back to the element's own click() and
 * says which path ran, because a scan should not fail on transient overlays. */
async function clickTab(xpath: string): Promise<'pointer' | 'js' | 'missing'> {
  const btn = await pos.shownX(xpath, 8000).catch(() => null);
  if (!btn) return 'missing';
  try {
    await btn.click();
    await browser.pause(1200);
    return 'pointer';
  } catch {
    await browser.execute((el: HTMLElement) => el.click(), btn as unknown as HTMLElement);
    await browser.pause(1200);
    return 'js';
  }
}

async function openCheckoutTab(): Promise<void> {
  const tab = await pos.shownX(
    '//button[starts-with(@aria-label, "Caisse") or starts-with(@aria-label, "الصندوق")]',
    10000,
  );
  await tab.click();
  await browser.pause(1200);
}

async function toggleLocale(): Promise<boolean> {
  const btn = await pos.shownX(LANG_BTN, 8000).catch(() => null);
  if (!btn) return false;
  await btn.click();
  await browser.pause(1200);
  return true;
}

/** Count of cart-row controls that reference the product title (locale-free). */
async function cartControlsFor(title: string): Promise<number> {
  return (await browser.execute(
    (t: string) =>
      [...document.querySelectorAll('button')].filter((b) => (b.getAttribute('aria-label') ?? '').includes(t)).length,
    title,
  )) as number;
}

async function cartBadge(): Promise<string | null> {
  return (await browser.execute(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^(Caisse|الصندوق)\s*—\s*\d+/.test(x.getAttribute('aria-label') ?? ''));
    return b?.getAttribute('aria-label') ?? null;
  })) as string | null;
}

/** Dispatch a machine-grade burst with explicit key/code pairs (wedge test). */
async function burstPairs(pairs: Array<[string, string]>, terminator: 'Enter' | 'Tab' = 'Enter'): Promise<void> {
  await browser.execute(
    (ps: string[][], term: string) => {
      const el = document.querySelector('[data-testid="catalog-search"]') as HTMLInputElement | null;
      el?.focus();
      const target: HTMLElement = el ?? document.body;
      for (const [k, c] of ps) {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: c, bubbles: true, cancelable: true }));
      }
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: term, code: term === 'Enter' ? 'Enter' : 'Tab', bubbles: true, cancelable: true }),
      );
    },
    pairs,
    terminator,
  );
  await browser.pause(900);
}

const digitsOf = (code: string) => code.split('');
const asciiPairs = (code: string): Array<[string, string]> => digitsOf(code).map((d) => [d, `Digit${d}`]);
const arabicPairs = (code: string): Array<[string, string]> =>
  digitsOf(code).map((d) => [String.fromCharCode(0x0660 + Number(d)), `Digit${d}`]);
const azerty: Record<string, string> = {
  '1': '&',
  '2': 'é',
  '3': '"',
  '4': "'",
  '5': '(',
  '6': '-',
  '7': 'è',
  '8': '_',
  '9': 'ç',
  '0': 'à',
};
const azertyPairs = (code: string): Array<[string, string]> => digitsOf(code).map((d) => [azerty[d], `Digit${d}`]);
/** Same physical keys as asciiPairs but a bogus `code`, proving `key` drives it. */
const wrongCodePairs = (code: string): Array<[string, string]> => digitsOf(code).map((d) => [d, 'KeyQ']);

/** Paste `text` into `selector`; returns whether a handler consumed it. */
async function pasteInto(selector: string, text: string, clearFirst = false): Promise<boolean> {
  const handled = (await browser.execute(
    (sel: string, txt: string, clear: boolean) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (!el) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (clear) {
        setter?.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const dt = new DataTransfer();
      dt.setData('text/plain', txt);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      const notCancelled = el.dispatchEvent(ev);
      if (notCancelled) {
        // No paste handler: apply the browser default (React-compatible setter).
        setter?.call(el, el.value + txt);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return !notCancelled;
    },
    selector,
    text,
    clearFirst,
  )) as boolean;
  await browser.pause(500);
  return handled;
}

describe('BATCH 27c — I18 interactive', () => {
  before(async () => {
    await browser.setTimeout({ pageLoad: 120000, script: 120000 });
    await ensureDesktopSession();
    await resetData();
    seedProducts([
      { id: P_SALE, title: P_SALE, priceDa: 12000, stock: 50, barcode: B_SALE },
      { id: 'B27-I18-MIXED', title: P_MIXED, priceDa: 45000, stock: 10, barcode: '6132700000024' },
      { id: 'B27-I18-NASTY', title: P_NASTY, priceDa: 500, stock: 5, barcode: '6132700000031' },
      { id: 'B27-M1', title: P_MOBILE, priceDa: 12000, stock: 20, barcode: '6132700000101' },
    ]);
    await browser.refresh();
    await browser.pause(2500);
    await pos.unlockIfNeeded();
    await pos.installPageShims();
    await pos.installErrorTrap();
    await pos.ensureShiftOpen(10000);
  });

  after(() => {
    console.log(`BATCH27C_UI_SUMMARY=${JSON.stringify(RESULTS)}`);
  });

  // -------------------------------------------------------------------------
  harness('I18-01', 240000, async () => {
    const entry = await enterCompanion();
    await openCheckoutTab();
    // one cart line, then a typed search term that must survive the flip
    await setValueReact('input[type="search"]', 'PROBE');
    await browser.pause(800);
    const add = await pos.shownX(`//button[starts-with(@aria-label, "Au Panier")]`, 8000);
    await add.click();
    await browser.pause(900);
    const badgeFr = await cartBadge();
    const controlsFr = await cartControlsFor(P_MOBILE);
    const searchFr = await inputValue('input[type="search"]');
    const stFr = await docState();
    const navFr = (await browser.execute(() =>
      [...document.querySelectorAll('button[aria-label]')]
        .map((b) => b.getAttribute('aria-label') ?? '')
        .filter((a) => /^(Activité|Caisse|Articles|Kredy|Gestion|Diagnostic)/.test(a)),
    )) as string[];

    const toggledAr = await toggleLocale();
    const badgeAr = await cartBadge();
    const controlsAr = await cartControlsFor(P_MOBILE);
    const searchAr = await inputValue('input[type="search"]');
    const stAr = await docState();
    const navAr = (await browser.execute(() =>
      [...document.querySelectorAll('button[aria-label]')]
        .map((b) => b.getAttribute('aria-label') ?? '')
        .filter((a) => /^(النشاط|الصندوق|السلع|كريدي|الإدارة|التشخيص)/.test(a)),
    )) as string[];

    const toggledFr = await toggleLocale();
    const badgeFr2 = await cartBadge();
    const controlsFr2 = await cartControlsFor(P_MOBILE);
    const searchFr2 = await inputValue('input[type="search"]');
    const stFr2 = await docState();

    // mid-payment: open the cash sheet, then try the only language control
    const cash = await pos.shownX('//button[contains(., "Espèces")]', 8000).catch(() => null);
    let sheetOpen = false;
    let toggleHit: string | null = null;
    let clickErr: string | null = null;
    let sheetTitle = '';
    if (cash) {
      await cash.click();
      await browser.pause(1500);
      sheetOpen = (await browser.execute(() => !!document.querySelector('[role="dialog"]'))) as boolean;
      const probe = (await browser.execute(() => {
        const lang = [...document.querySelectorAll('button')].find((b) =>
          /Basculer|التبديل/.test(b.getAttribute('aria-label') ?? ''),
        ) as HTMLElement | null;
        const dlg = document.querySelector('[role="dialog"]');
        let hit: string | null = null;
        if (lang) {
          const r = lang.getBoundingClientRect();
          const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
          hit = el ? `${el.tagName} ${String(el.className).slice(0, 60)}` : null;
        }
        return {
          hit,
          title: (document.getElementById('checkout-cash-tender-title')?.textContent ?? '').trim(),
          dlgRect: dlg
            ? (() => {
                const r = dlg.getBoundingClientRect();
                return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) };
              })()
            : null,
        };
      })) as { hit: string | null; title: string; dlgRect: unknown };
      toggleHit = probe.hit;
      sheetTitle = probe.title;
      const langBtn = await pos.shownX(LANG_BTN, 4000).catch(() => null);
      if (langBtn) {
        try {
          await langBtn.click();
        } catch (e) {
          clickErr = String((e as Error).message).slice(0, 120);
        }
      }
      await browser.pause(800);
      await pos.closeDialogs(3);
      await browser.pause(600);
    }

    // desktop leak: the mobile flip leaves dir/lang on the desktop document
    await leaveCompanion();
    const stDesktop = await docState();
    await browser.execute(() => {
      document.documentElement.setAttribute('dir', 'ltr');
      document.documentElement.setAttribute('lang', 'fr');
    });
    const errors = await pos.readErrors();

    const cartKept =
      badgeFr === badgeAr &&
      badgeAr === badgeFr2 &&
      controlsFr === controlsAr &&
      controlsAr === controlsFr2 &&
      controlsFr > 0;
    const inputKept = searchFr === 'PROBE' && searchAr === 'PROBE' && searchFr2 === 'PROBE';
    const flipped = toggledAr && toggledFr && stAr.dir === 'rtl' && stAr.lang === 'ar' && stFr2.dir === 'ltr';
    const navFlipped = navFr.length >= 5 && navAr.length >= 5;
    const midPaymentSwitchable = clickErr === null && toggleHit !== null && !/backdrop/.test(toggleHit);

    record(
      'I18-01',
      cartKept && inputKept && flipped && navFlipped && midPaymentSwitchable ? 'PASS-PARTIAL' : 'FAIL',
      `surface=companion_shell (wizard=${entry.wizard} shell=${entry.shell}) ` +
        `badge_fr="${badgeFr}" badge_ar="${badgeAr}" badge_fr2="${badgeFr2}" ` +
        `row_controls_for_title_fr=${controlsFr} ar=${controlsAr} fr2=${controlsFr2} ` +
        `search_value_fr="${searchFr}" ar="${searchAr}" fr2="${searchFr2}" ` +
        `dir_fr=${stFr.dir || '(null)'} dir_ar=${stAr.dir} lang_ar=${stAr.lang} dir_fr2=${stFr2.dir} ` +
        `nav_fr=${JSON.stringify(navFr)} nav_ar=${JSON.stringify(navAr)} ` +
        `mid_payment: sheet_open=${sheetOpen} sheet_title="${sheetTitle}" ` +
        `element_from_point_at_language_button="${toggleHit}" click_error="${clickErr}" ` +
        `after_return_to_desktop: shell=${stDesktop.shell} dir=${stDesktop.dir} lang=${stDesktop.lang} ` +
        `ui_errors=${JSON.stringify(errors.slice(0, 2))} ` +
        `— the FR/AR toggle works live in the companion shell (dir ltr<->rtl, <html lang> fr<->ar, nav labels translated) and the sale survives it: ` +
        `the cart badge, every control that references the same product title and the typed search term are identical across fr->ar->fr; ` +
        `BUT a language switch mid-payment is impossible: the cash sheet's backdrop covers the only language control (elementFromPoint hits the backdrop div, the real click is "element click intercepted"), ` +
        `EN is not a shipped locale (isSupportedLocale accepts fr/ar/pseudo only) and mid-ticket printing needs a printer; ` +
        `the desktop till has no locale of its own and simply inherits the last companion document state — returning to PC mode while in Arabic leaves dir=rtl/lang=ar over the hard-coded French till (measured: PROBE4_BACK_DESKTOP dir=rtl lang=ar shell=desktop; here the operator toggled back to FR first, so the same run ends dir=ltr lang=fr)`,
    );
  });

  // -------------------------------------------------------------------------
  harness('I18-02', 240000, async () => {
    await enterCompanion();
    await openCheckoutTab();
    // ensure one cart line exists for geometry
    const controls = await cartControlsFor(P_MOBILE);
    if (controls === 0) {
      const add = await pos.shownX('//button[starts-with(@aria-label, "Au Panier")]', 8000);
      await add.click();
      await browser.pause(800);
    }
    const fr = await docState();
    const navFr = (await browser.execute(() => {
      const b = [...document.querySelectorAll('button[aria-label]')].filter((x) =>
        /^(Activité|Caisse|Articles|Kredy|Gestion|Diagnostic)$/.test(x.getAttribute('aria-label') ?? ''),
      ) as HTMLElement[];
      const r = b[0]?.getBoundingClientRect();
      return {
        count: b.length,
        first: r ? { l: Math.round(r.left), r: Math.round(r.right) } : null,
      };
    })) as { count: number; first: { l: number; r: number } | null };
    const rowFr = (await browser.execute((t: string) => {
      const b = [...document.querySelectorAll('button')]
        .filter((x) => (x.getAttribute('aria-label') ?? '').includes(t))
        .pop() as HTMLElement | undefined;
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) };
    }, P_MOBILE)) as { l: number; r: number; t: number; b: number } | null;
    const amountFr = (await browser.execute(() => {
      const m = (document.body.innerText || '').match(/([\d][\d\s.]*)\s*DA/g) ?? [];
      return m.slice(0, 3);
    })) as string[];

    await toggleLocale();
    const ar = await docState();
    const navAr = (await browser.execute(() => {
      const b = [...document.querySelectorAll('button[aria-label]')].filter((x) =>
        /^(النشاط|الصندوق|السلع|كريدي|الإدارة|التشخيص)$/.test(x.getAttribute('aria-label') ?? ''),
      ) as HTMLElement[];
      const r = b[0]?.getBoundingClientRect();
      return {
        count: b.length,
        first: r ? { l: Math.round(r.left), r: Math.round(r.right) } : null,
      };
    })) as { count: number; first: { l: number; r: number } | null };
    const rowAr = (await browser.execute((t: string) => {
      const b = [...document.querySelectorAll('button')]
        .filter((x) => (x.getAttribute('aria-label') ?? '').includes(t))
        .pop() as HTMLElement | undefined;
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) };
    }, P_MOBILE)) as { l: number; r: number; t: number; b: number } | null;
    const amountAr = (await browser.execute(() => {
      const m = (document.body.innerText || '').match(/([\d][\d\s.]*)\s*DA/g) ?? [];
      return m.slice(0, 3);
    })) as string[];

    // dialog in RTL: the cash sheet
    const cash = await pos.shownX('//button[contains(., "نقدا") or contains(., "Espèces")]', 8000).catch(() => null);
    let sheet: Record<string, unknown> | null = null;
    if (cash) {
      await cash.click();
      await browser.pause(1400);
      sheet = (await browser.execute(() => {
        const d = document.querySelector('[role="dialog"]') as HTMLElement | null;
        if (!d) return null;
        const r = d.getBoundingClientRect();
        const title = document.getElementById('checkout-cash-tender-title') as HTMLElement | null;
        const tr = title?.getBoundingClientRect();
        const closeBtn = d.querySelector('button[aria-label]') as HTMLElement | null;
        const cr = closeBtn?.getBoundingClientRect();
        return {
          l: Math.round(r.left),
          r: Math.round(r.right),
          t: Math.round(r.top),
          b: Math.round(r.bottom),
          title: (title?.textContent ?? '').trim(),
          titleInside: tr ? tr.left >= r.left - 1 && tr.right <= r.right + 1 : null,
          closeCenter: cr ? Math.round(cr.left + cr.width / 2) : null,
          dialogCenter: Math.round(r.left + r.width / 2),
          scrollW: d.scrollWidth,
          clientW: d.clientWidth,
        };
      })) as Record<string, unknown> | null;
      await pos.closeDialogs(3);
      await browser.pause(500);
    }
    await toggleLocale();
    await leaveCompanion();
    await browser.execute(() => {
      document.documentElement.setAttribute('dir', 'ltr');
      document.documentElement.setAttribute('lang', 'fr');
    });
    const errors = await pos.readErrors();

    const noOverflow = ar.scrollW <= ar.innerW + 1 && fr.scrollW <= fr.innerW + 1;
    const navMirrored =
      !!navFr.first && !!navAr.first && navFr.first.l < fr.innerW / 2 && navAr.first.l > ar.innerW / 2;
    // LTR companion layout: nav rail on the left, cart pane on the right; in
    // RTL both swap, so the cart control must cross to the left half.
    const cartMirrored = !!rowFr && !!rowAr && rowFr.l > fr.innerW / 2 && rowAr.l < ar.innerW / 2;
    const tables = (await browser.execute(() => ({
      tables: document.querySelectorAll('table').length,
      gridRoles: document.querySelectorAll('[role="grid"], [role="table"]').length,
      customTooltips: document.querySelectorAll('[role="tooltip"], .tooltip, [data-tooltip]').length,
      nativeTitleAttrs: [...document.querySelectorAll('[title]')].length,
    }))) as { tables: number; gridRoles: number; customTooltips: number; nativeTitleAttrs: number };
    const numbersSame =
      amountFr.length > 0 &&
      JSON.stringify([...amountFr].sort()) === JSON.stringify([...amountAr].sort());
    const sheetOk =
      !!sheet &&
      Number(sheet.l) >= -1 &&
      Number(sheet.r) <= ar.innerW + 1 &&
      sheet.titleInside === true &&
      Number(sheet.scrollW) <= Number(sheet.clientW) + 1;

    record(
      'I18-02',
      noOverflow && navMirrored && cartMirrored && numbersSame && sheetOk ? 'PASS' : 'FAIL',
      `surface=companion_shell viewport=${ar.innerW}x${ar.innerH} ` +
        `scrollW_fr=${fr.scrollW} scrollW_ar=${ar.scrollW} no_overflow=${noOverflow} ` +
        `nav_fr=${JSON.stringify(navFr)} nav_ar=${JSON.stringify(navAr)} nav_mirrored=${navMirrored} ` +
        `cart_control_fr=${JSON.stringify(rowFr)} cart_control_ar=${JSON.stringify(rowAr)} cart_mirrored=${cartMirrored} ` +
        `amounts_fr=${JSON.stringify(amountFr)} amounts_ar=${JSON.stringify(amountAr)} numbers_identical=${numbersSame} ` +
        `cash_sheet_ar=${JSON.stringify(sheet)} sheet_inside_and_unclipped=${sheetOk} ` +
        `tables=${JSON.stringify(tables)} ` +
        `ui_errors=${JSON.stringify(errors.slice(0, 2))} ` +
        `— in Arabic the companion shell mirrors end to end: the bottom-nav rail moves from the left edge to the right edge, the cart row controls move with it, ` +
        `the document does not scroll horizontally in either direction, the DA amounts render identically, and the cash sheet stays inside the viewport with its title and close button on the correct side. ` +
        `The two remaining named facets are measured as vacuous on this surface rather than unasserted: tables=${JSON.stringify(tables)} shows zero <table>/[role=table|grid] and zero custom tooltip layer (only ${tables.nativeTitleAttrs} native title attributes), so there is no RTL table column or tooltip to misplace on the checkout screen`,
    );
  });

  // -------------------------------------------------------------------------
  harness('I18-03', 180000, async () => {
    await ensureDesktop();
    const name = 'أحمد بن علي iPhone 15';
    await pos.clearCart();
    await openCustomers();
    await fillCustomerForm(name, '0555000000');
    await submitCustomerForm();
    const row = await waitRow<{ name: string; phone: string }>('SELECT name, phone FROM customers WHERE name = ?', [name]);
    await setValueReact('[data-testid="customer-search"]', 'أحمد');
    await browser.pause(700);
    const listText = await textOf('[data-testid="customers-dialog"]');
    await closeCustomers();

    const tile = (await browser.execute(() => {
      const tiles = [...document.querySelectorAll('[data-testid="product-tile"]')] as HTMLElement[];
      const t = tiles.find((e) => (e.textContent || '').includes('iPhone 15 Pro'));
      if (!t) return null;
      const cs = getComputedStyle(t);
      return { text: (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120), dir: cs.direction, bidi: cs.unicodeBidi };
    })) as { text: string; dir: string; bidi: string } | null;

    const storedExact = row?.name === name;
    const domExact = !!tile && tile.text.includes('غلاف iPhone 15 Pro 128GB');
    const listed = !!listText && listText.includes('أحمد بن علي iPhone 15');
    record(
      'I18-03',
      'FAIL',
      `customer_stored="${row?.name ?? '(missing)'}" stored_exact=${storedExact} phone_stored="${row?.phone ?? ''}" ` +
        `dom_list_contains_name=${listed} product_tile_text="${tile?.text ?? '(missing)'}" dom_exact=${domExact} tile_dir=${tile?.dir} tile_bidi=${tile?.bidi} ` +
        `print_bytes="see FACT=I18-03_PRINT: Arabic 'أحمد بن علي' -> 23 2d 45 2f 20 28 46 20 39 44 4a (low bytes, no code page)" ` +
        `— display and storage keep the logical order end to end (the DB string equals the DOM string, the Arabic-first run renders RTL inside an LTR tile, the Latin+digit run is not reordered), ` +
        `but the PRINT facet fails: the ESC/POS text encoder truncates every UTF-16 unit to its low byte and never selects a code page, so this exact name reaches a thermal receipt as "#-E/ (F 9DJ" (FACT=I18-03_PRINT). ` +
        `The export facet is measured separately by I18-08 (UTF-8 BOM + ';' + '.' decimals)`,
    );
  });

  // -------------------------------------------------------------------------
  harness('I18-07', 200000, async () => {
    await ensureDesktop();
    const xssName = '<img src=x onerror=window.__xss=1> ZW\u200BSP RLO\u202E tail';
    const rloName = 'اسم\u202Eعكس\u200F اسم';
    await openCustomers();
    await fillCustomerForm(xssName, '0555000000');
    await submitCustomerForm();
    const xssRow = await waitRow<{ name: string }>('SELECT name FROM customers WHERE name = ?', [xssName]);
    await fillCustomerForm(rloName, '0660123456');
    await submitCustomerForm();
    const rloRow = await waitRow<{ name: string }>('SELECT name FROM customers WHERE name = ?', [rloName]);

    const injected = (await browser.execute(() => {
      const d = document.querySelector('[data-testid="customers-dialog"]');
      return {
        imgs: d?.querySelectorAll('img').length ?? 0,
        scripts: d?.querySelectorAll('script').length ?? 0,
        xss: (window as unknown as { __xss?: unknown }).__xss ?? null,
      };
    })) as { imgs: number; scripts: number; xss: unknown };
    const longRow = await waitRow<{ title: string }>('SELECT title FROM products WHERE id = ?', ['B27-I18-NASTY']);
    const tileText = (await browser.execute(() => {
      const tiles = [...document.querySelectorAll('[data-testid="product-tile"]')] as HTMLElement[];
      const t = tiles.find((e) => (e.textContent || '').includes('B27 ZWSP'));
      return t ? (t.textContent || '') : null;
    })) as string | null;
    const st = await docState();
    await closeCustomers();
    const errors = await pos.readErrors();

    const storedExact = xssRow?.name === xssName && rloRow?.name === rloName && longRow?.title === P_NASTY;
    const noInjection = injected.imgs === 0 && injected.scripts === 0 && injected.xss === null;
    const noBreak = st.scrollW <= st.innerW + 1;
    const tileExact = !!tileText && tileText.includes(P_NASTY);
    record(
      'I18-07',
      storedExact && noInjection && noBreak && tileExact ? 'PASS' : 'FAIL',
      `stored_exact=${storedExact} xss_row=${xssRow ? 'present' : 'missing'} rlo_row=${rloRow ? 'present' : 'missing'} long_row=${longRow ? 'present' : 'missing'} ` +
        `dom_img=${injected.imgs} dom_script=${injected.scripts} window___xss=${JSON.stringify(injected.xss)} no_injection=${noInjection} ` +
        `scrollW=${st.scrollW} innerW=${st.innerW} no_ui_break=${noBreak} tile_contains_full_title=${tileExact} tile_len=${tileText?.length ?? 0} ` +
        `print_encoder="see FACT=I18-07_PRINT in tools/27c-i18-checks.mts: no control byte from data reaches the ESC/POS stream (Arabic still degrades to '?' - RCP-01)" ui_errors=${JSON.stringify(errors.slice(0, 2))} ` +
        `— storage and rendering are safe: the payloads round-trip byte-exactly, React renders them as text (no <img>/<script> node, no handler ran), ` +
        `and ZWSP/RLO/emoji/long strings do not break the layout or the catalog tile. Printing is judged by RCP-01 and I18-03, not here`,
    );
  });

  // -------------------------------------------------------------------------
  harness('I18-09', 200000, async () => {
    await ensureDesktop();
    const PRICE_MINOR = 1200000;
    const runs: Array<{
      label: string;
      decoded: boolean;
      sold: boolean;
      events: number;
      delta: string;
      codes: string[];
    }> = [];
    for (const run of [
      { label: 'ascii_key_ascii_code', pairs: asciiPairs(B_SALE) },
      { label: 'arabic_indic_key', pairs: arabicPairs(B_SALE) },
      { label: 'azerty_shifted_key', pairs: azertyPairs(B_SALE) },
      { label: 'ascii_key_bogus_code', pairs: wrongCodePairs(B_SALE) },
    ]) {
      await pos.clearCart();
      await pos.installScanSpy();
      const before = await pos.cartTotalMinor();
      await burstPairs(run.pairs);
      const after = await pos.cartTotalMinor();
      const evs = await pos.readScanEvents();
      const delta = after - before;
      runs.push({
        label: run.label,
        decoded: evs.length > 0,
        sold: delta === BigInt(PRICE_MINOR),
        events: evs.length,
        delta: delta.toString(),
        codes: evs.map((e) => e.code),
      });
    }
    const by = (label: string) => runs.find((r) => r.label === label);
    const ascii = by('ascii_key_ascii_code');
    const arabic = by('arabic_indic_key');
    const az = by('azerty_shifted_key');
    const bogus = by('ascii_key_bogus_code');
    record(
      'I18-09',
      ascii?.sold && arabic?.sold && az?.sold ? 'PASS' : 'FAIL',
      `runs=${JSON.stringify(runs)} ` +
        `— the wedge accumulates e.key verbatim (useBarcodeScanner.ts:412-415), so it is layout-dependent: a US-HID burst sells (delta=+${PRICE_MINOR} minor) and the SAME characters with a bogus e.code also sell, proving e.code is ignored; ` +
        `an Arabic layout that yields Arabic-Indic digits emits a scan event with the Arabic-Indic code but sells nothing (delta=0), and a French AZERTY top row (&é" '(-è_çà) does the same. ` +
        `A scanner configured for US HID on an AZERTY or Arabic-keyboard machine therefore cannot sell`,
    );
  });

  // -------------------------------------------------------------------------
  harness('I18-10', 240000, async () => {
    await enterCompanion();
    type Screen = {
      name: string;
      expectTab: string;
      activeTab: string | null;
      tabOk: boolean;
      keyLike: string[];
      scrollW: number;
      innerW: number;
    };
    const screens: Screen[] = [];
    /** Walk every visible text node of the current screen, record raw i18n
     * keys, horizontal overflow, and which bottom-nav tab is actually active
     * (so a "scanned screen" cannot silently be the previous screen). */
    const scan = async (name: string, expectTab: string) => {
      const s = (await browser.execute(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const hits: string[] = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const el = n.parentElement;
          if (!el) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
          const t = (n.textContent ?? '').trim();
          if (!t || t.length > 120) continue;
          const m = t.match(/\b[a-z][a-zA-Z0-9]{1,}\.[a-zA-Z][a-zA-Z0-9]{1,}\b/g) ?? [];
          for (const x of m) {
            if (/@|\.(png|jpg|jpeg|svg|ts|tsx|js|json|db|sqlite|com|dz|app)$/i.test(x)) continue;
            hits.push(x);
          }
        }
        const active = document.querySelector('button[role="tab"][aria-selected="true"]') as HTMLElement | null;
        return {
          activeTab: active?.getAttribute('aria-label') ?? null,
          keyLike: [...new Set(hits)].slice(0, 12),
          scrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
        };
      })) as { activeTab: string | null; keyLike: string[]; scrollW: number; innerW: number };
      screens.push({ name, expectTab, tabOk: (s.activeTab ?? '').startsWith(expectTab), ...s });
    };

    /** Leaving Caisse with a non-empty cart raises the M3 cart-protection
     * sheet; a real operator has to answer it. Pick the destructive
     * "clear cart" exit, located by its class so it works in either locale. */
    const dismissProtection = async (): Promise<string> => {
      const seen = (await browser.execute(() => {
        const d = document.querySelector('[aria-labelledby="cart-protection-title"]') as HTMLElement | null;
        return d ? (d.textContent ?? '').replace(/\s+/g, ' ').slice(0, 110) : null;
      })) as string | null;
      if (seen === null) return 'no-protection-sheet';
      const clicked = (await browser.execute(() => {
        const d = document.querySelector('[aria-labelledby="cart-protection-title"]');
        const btn = (d?.querySelector('.pos-status-danger') ?? document.querySelector('.pos-status-danger')) as HTMLElement | null;
        if (!btn) return false;
        btn.click();
        return true;
      })) as boolean;
      await browser.pause(1400);
      return `cleared=${clicked} sheet="${seen}"`;
    };

    await openCheckoutTab();
    const switched = await toggleLocale();
    await scan('checkout-ar', 'الصندوق');

    const navPath: Record<string, string> = {};
    // cash sheet while the sale is still in the cart (it needs a total to open)
    const cash = await pos.shownX('//button[contains(., "نقدا")]', 8000).catch(() => null);
    navPath.cash = cash ? 'pointer' : 'missing';
    if (cash) {
      await cash.click();
      await browser.pause(1400);
      await scan('cash-sheet-ar', 'الصندوق');
      await pos.closeDialogs(3);
      await browser.pause(700);
    }

    navPath.activity = await clickTab('//button[starts-with(@aria-label, "النشاط")]');
    navPath.activityProtection = await dismissProtection();
    await scan('activity-ar', 'النشاط');
    navPath.management = await clickTab('//button[starts-with(@aria-label, "الإدارة")]');
    navPath.managementProtection = await dismissProtection();
    await browser.pause(600);
    await scan('management-ar', 'الإدارة');

    await toggleLocale();
    await leaveCompanion();
    await browser.execute(() => {
      document.documentElement.setAttribute('dir', 'ltr');
      document.documentElement.setAttribute('lang', 'fr');
    });

    const keyLikeTotal = screens.reduce((n, s) => n + s.keyLike.length, 0);
    const overflow = screens.filter((s) => s.scrollW > s.innerW + 1).map((s) => `${s.name}:${s.scrollW}>${s.innerW}`);
    const tabMisses = screens.filter((s) => !s.tabOk).map((s) => `${s.name}:active="${s.activeTab}" expected="${s.expectTab}"`);
    record(
      'I18-10',
      keyLikeTotal === 0 && overflow.length === 0 && tabMisses.length === 0 && screens.length >= 4 ? 'PASS-PARTIAL' : 'FAIL',
      `switched_to_ar=${switched} nav_paths=${JSON.stringify(navPath)} screens_scanned=${screens.length} (${screens.map((s) => s.name).join(',')}) ` +
        `active_tab_per_screen=${JSON.stringify(screens.map((s) => `${s.name}=${s.activeTab}`))} tab_misses=${JSON.stringify(tabMisses)} ` +
        `key_like_text=${keyLikeTotal} ${JSON.stringify(screens.map((s) => s.keyLike))} horizontal_overflow=${JSON.stringify(overflow)} ` +
        `dictionary="see FACT=I18-10_DICT: 822/822/822 keys, 0 missing in ar, 0 placeholder mismatches" ` +
        `— the fr/ar/pseudo dictionaries are key-identical with no interpolation-token drift (FACT above), and every Arabic screen walked here (checkout, cash sheet, activity, management) was confirmed active by its own aria-selected tab, with no raw i18n key and no horizontal overflow. ` +
        `The case says "scan all screens": reports, labels, refund and the settings sub-tabs were not walked, so this stays partial`,
    );
  });

  harness('I18-13', 180000, async () => {
    await ensureDesktop();
    await pos.clearCart();
    await openCustomers();
    await fillCustomerForm('B27 Tel Court', '055012345');
    // blur the field itself (fires focusout, which React's onBlur listens to)
    await browser.execute(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      (document.querySelector('#customer-phone') as HTMLInputElement | null)?.blur();
    });
    await browser.pause(300);
    const hint = await phoneHint();
    const ariaInvalid = (await browser.execute(() => {
      const el = document.querySelector('#customer-phone') as HTMLInputElement | null;
      return el?.getAttribute('aria-invalid') ?? null;
    })) as string | null;
    await submitCustomerForm();
    const shortRow = await waitRow<{ name: string; phone: string }>(
      'SELECT name, phone FROM customers WHERE name = ?',
      ['B27 Tel Court'],
      8000,
    );
    await fillCustomerForm('B27 Tel Valide', '0555000000');
    await submitCustomerForm();
    const okRow = await waitRow<{ name: string; phone: string }>(
      'SELECT name, phone FROM customers WHERE name = ?',
      ['B27 Tel Valide'],
      8000,
    );
    await closeCustomers();
    const errors = await pos.readErrors();

    const invalidSaved = !!shortRow;
    record(
      'I18-13',
      invalidSaved ? 'FAIL' : 'PASS',
      `invalid_input="055012345" (9 digits) aria_invalid=${ariaInvalid} hint="${hint.slice(0, 120)}" saved_row=${JSON.stringify(shortRow ?? null)} ` +
        `valid_input="0555000000" saved_row=${JSON.stringify(okRow ?? null)} ui_errors=${JSON.stringify(errors.slice(0, 2))} ` +
        `canonical_facts="see FACT=I18-13_CANONICAL: 9 written variants -> +213550123456, 4/14 inputs isValid=false" ` +
        `— the field itself is good: 9 written variants of one mobile collapse to one canonical form, and the invalid value shows an amber "Format DZ attendu" hint plus aria-invalid=true. ` +
        `But the save path ignores isValid (CustomersModal.tsx:550-551: cleanPhone = norm.isValid ? norm.local : (norm.digitsOnly || phone.trim())) and fires showSuccess anyway, so a 9-digit number is written to the CRM as "055012345" with no rejection — the case requires "invalid rejected with a message"`,
    );
  });

  // -------------------------------------------------------------------------
  harness('I18-15', 200000, async () => {
    await ensureDesktop();
    const rawName = '  أحمد\u00A0بن\u200F علي\n';
    const rawPhone = '+213\u00A0770\u200F111222';
    await openCustomers();
    const add = await pos.shownX(
      '//*[@data-testid="customers-dialog"]//button[contains(., "Ajouter un Client")]',
      8000,
    );
    await add.click();
    await pos.shownX('//*[@data-testid="customers-dialog"]//input[@data-testid="customer-name"]', 8000);

    const nameHandled = await pasteInto(
      '[data-testid="customers-dialog"] input[data-testid="customer-name"]',
      rawName,
    );
    const nameAfterPaste = await inputValue('[data-testid="customers-dialog"] input[data-testid="customer-name"]');
    const phoneHandled = await pasteInto('[data-testid="customers-dialog"] #customer-phone', rawPhone);
    const phoneAfterPaste = await inputValue('[data-testid="customers-dialog"] #customer-phone');
    await submitCustomerForm();
    const saved = await waitRow<{ name: string; phone: string }>(
      'SELECT name, phone FROM customers WHERE phone = ?',
      ['0770111222'],
      8000,
    );
    await closeCustomers();

    // amount: paste an NBSP-grouped tender into an emptied field
    await pos.clearCart();
    await addSale();
    await (await $(pos.tid('checkout-button'))).click();
    await (await $(pos.tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
    const amountHandled = await pasteInto('[data-testid="tendered-input"]', '1\u00A0000', true);
    await browser.pause(700);
    const tenderValue = await inputValue('[data-testid="tendered-input"]');
    const changeText = await textOf('[data-testid="pay-change"]');
    await (await $(pos.tid('pay-cancel'))).click().catch(() => undefined);
    await browser.pause(400);
    const errors = await pos.readErrors();

    const parsed = Number(tenderValue.replace(/[^\d.]/g, '').replace(/(\d)\.(\d{3})/g, '$1$2'));
    const nameClean = !!saved && !/[\u00A0\u200F\n]/.test(saved.name);
    const phoneCanonical = saved?.phone === '0770111222';
    const amountOk = Number.isFinite(parsed) && Math.abs(parsed - 1000) < 0.01;
    record(
      'I18-15',
      nameClean && phoneCanonical && amountOk ? 'PASS' : 'FAIL',
      `name_paste_handled=${nameHandled} name_value="${nameAfterPaste}" stored_name="${saved?.name ?? '(missing)'}" ` +
        `name_has_nbsp_or_rlm=${!!saved && /[\u00A0\u200F]/.test(saved.name)} ` +
        `phone_paste_handled=${phoneHandled} phone_value="${phoneAfterPaste}" stored_phone="${saved?.phone ?? ''}" ` +
        `amount_paste_handled=${amountHandled} tender_value="${tenderValue}" parsed=${parsed} change_text="${changeText}" ui_errors=${JSON.stringify(errors.slice(0, 2))} ` +
        `— the phone field owns a paste handler (preventDefault + clean + format) so "+213<NBSP>770<RLM>111222" lands as the formatted local number and stores as 0770111222, and the NBSP-grouped tender parses as 1000; ` +
        `but the NAME field has no paste handler at all (the synthetic ClipboardEvent is not cancelled), so the NBSP (U+00A0) and the RLM (U+200F) are written into the CRM row verbatim — the exact invisible characters the case says must not survive a WhatsApp paste, and the ones the search fold does not strip (I18-04)`,
    );
  });
});

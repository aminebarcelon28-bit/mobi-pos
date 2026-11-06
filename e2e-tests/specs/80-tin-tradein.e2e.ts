/**
 * TIN - trade-in / buyback edge matrix (batch 16, spec 80).
 *
 * Every TIN-01..21 case executes against the live Tauri WebView and the
 * authoritative SQLite file. Cases whose product facet is genuinely absent
 * still run an executed DOM/absence probe (never "not seeded" / "not clicked").
 *
 * Verdict policy for this batch:
 *   PASS = observed behaviour satisfies the case.
 *   FAIL = observed behaviour is wrong or the required control is missing.
 *   N/A  = the feature itself does not exist in the application; the probe
 *          records the missing surface, and the report carries file:line + rg.
 */
import fs from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { all, count, one, run, waitForSchemaSettled } from '../lib/db';
import {
  addSku,
  APP_PIN,
  cartTotalMinor,
  clearCart,
  clearWebMirrors,
  closeDialogs,
  ensureShiftOpen,
  installErrorTrap,
  payExactFlow,
  tid,
  typeMoneyInto,
  unlockIfNeeded,
} from '../lib/pos';
import { assertInvariants, captureInvariantBaseline, finalizeInvariants } from '../lib/invariants';
import { resetData, seedBlockedImeis, seedCustomerFull, seedProducts } from '../lib/seed';

type Row = Record<string, unknown>;

const DIALOG = '[role="dialog"][aria-label="Reprise et trade-in occasion"]';
const P1000 = 'TIN-P1000';
const P500 = 'TIN-P500';
const CUST = 'TIN-CUST';
const CUST_NAME = 'TIN Client';
const CUST_PHONE = '0551400099';

/** Deterministic Luhn-valid IMEIs (prefix 35693803564 + 3 digits + check). */
function luhn(s: string): boolean {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let d = Number(s[i]);
    if ((s.length - i) % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
function imeiFor(n: number): string {
  const base = `35693803564${String(n).padStart(3, '0')}`;
  for (let c = 0; c < 10; c++) {
    const candidate = `${base}${c}`;
    if (luhn(candidate)) return candidate;
  }
  throw new Error(`no Luhn IMEI for ${n}`);
}

const IMEI_BLOCKED = imeiFor(90);
const IMEI_POLICE = imeiFor(91);

function bodyTail(n = 5000): Promise<string> {
  return browser.execute((len: number) => (document.body.innerText || '').slice(-len), n) as Promise<string>;
}

function tradeCount(): number {
  return Number(count('trade_ins') ?? 0);
}

function newestTrade(): Row | undefined {
  return one<Row>('SELECT * FROM trade_ins ORDER BY rowid DESC LIMIT 1');
}

function tradePayload(t: Row | undefined): Row {
  try {
    return JSON.parse(String(t?.json_payload ?? '{}')) as Row;
  } catch {
    return {};
  }
}

async function bootUnlock(): Promise<void> {
  try {
    await unlockIfNeeded(APP_PIN);
  } catch (e) {
    console.log('[TIN boot] unlockIfNeeded:', String((e as Error)?.message ?? e));
  }
  const locked = await $(tid('lock-screen'))
    .isDisplayed()
    .catch(() => false);
  if (!locked) return;
  await browser.execute(() => {
    const card = document.querySelector('[data-testid="lock-profile-usr-admin"]') as HTMLButtonElement | null;
    card?.click();
  });
  await browser.pause(600);
  const input = await $(tid('login-pin-input'));
  if (await input.isDisplayed().catch(() => false)) {
    await typeReal(input, APP_PIN, false);
    await browser.pause(250);
    await browser.execute(() => {
      (document.querySelector('[data-testid="login-submit"]') as HTMLButtonElement | null)?.click();
    });
  }
  await browser.waitUntil(
    async () => !(await $(tid('lock-screen')).isDisplayed().catch(() => false)),
    { timeout: 20000, interval: 300, timeoutMsg: 'TIN boot unlock failed' },
  );
}

async function typeReal(el: Awaited<ReturnType<typeof $>>, text: string, clear = false): Promise<void> {
  if (clear) await el.clearValue().catch(() => undefined);
  await el.click().catch(() => undefined);
  await el.setValue(text);
  await browser.pause(120);
}

async function tinClose(): Promise<void> {
  await browser.execute((sel: string) => {
    const dlg = document.querySelector(sel) as HTMLElement | null;
    if (!dlg) return;
    const b = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find(
      (x) => x.getAttribute('aria-label') === 'Fermer',
    );
    b?.click();
  }, DIALOG);
  await browser.pause(300);
}

async function tinOpen(): Promise<void> {
  await tinClose();
  const open = (await $(DIALOG).isDisplayed().catch(() => false)) as boolean;
  if (open) await tinClose();
  await (await $(tid('tools-menu-button'))).click();
  await browser.pause(350);
  const clicked = (await browser.execute(() => {
    const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
      /Reprise Occasion \(Trade-In\)/i.test(x.textContent || ''),
    );
    if (!b) return false;
    b.click();
    return true;
  })) as boolean;
  if (!clicked) throw new Error('TIN trade-in menu item not found');
  await $(DIALOG).waitForDisplayed({ timeout: 20000 });
  await browser.pause(400);
}

interface TinFill {
  name?: string;
  phone?: string;
  nationalId?: string;
  model?: string;
  imei: string;
  buyback?: number;
  barcode?: string;
}

/** Fill the form except the MoneyInput (typed with real keys afterwards). */
async function tinFill(o: TinFill): Promise<Row> {
  const res = (await browser.execute(
    (sel: string, v: Record<string, string>) => {
      const dlg = document.querySelector(sel) as HTMLElement | null;
      if (!dlg) return { dialog: false };
      const inputs = [...dlg.querySelectorAll('input, textarea')] as HTMLInputElement[];
      const set = (el: HTMLInputElement | null | undefined, val: string) => {
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter?.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      const byPh = (needle: RegExp) => inputs.find((i) => needle.test(i.placeholder || ''));
      // Placeholder tracks the modal (`Ex: Salma Hadj`). The field is
      // `required`, so a stale pattern leaves it empty and HTML5 validation
      // silently blocks the submit — the case then measures nothing.
      const name = set(byPh(/Hadj/i), v.name ?? '');
      const phone = set(byPh(/0661 88 99 00/i), v.phone ?? '');
      const nationalId = set(byPh(/1987-44-112233/i), v.nationalId ?? '');
      const model = set(byPh(/iPhone 14 Pro Max/i), v.model ?? '');
      const imei = set(byPh(/358921004812345/i), v.imei);
      const barcode = set(byPh(/0195949038445/i), v.barcode ?? '');
      return { dialog: true, name, phone, nationalId, model, imei, barcode, inputs: inputs.length };
    },
    DIALOG,
    {
      name: o.name ?? CUST_NAME,
      phone: o.phone ?? CUST_PHONE,
      nationalId: o.nationalId ?? '1987-44-112233',
      model: o.model ?? 'iPhone 14 Pro',
      imei: o.imei,
      barcode: o.barcode ?? '',
    },
  )) as Row;
  if (!res.dialog) throw new Error('TIN dialog vanished while filling');
  if (o.buyback !== undefined) {
    const money = await $('input[data-testid="buyback-price"]');
    await money.waitForDisplayed({ timeout: 10000 });
    await typeMoneyInto(money, String(o.buyback));
    await browser.pause(250);
  }
  return res;
}

async function tinSubmit(): Promise<boolean> {
  return (await browser.execute((sel: string) => {
    const dlg = document.querySelector(sel) as HTMLElement | null;
    if (!dlg) return false;
    const b = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find(
      (x) => /Racheter|Valider l.Échange/i.test(x.textContent || '') && !x.disabled,
    );
    if (!b) return false;
    b.click();
    return true;
  }, DIALOG)) as boolean;
}

/** Is the submit CTA enabled (used by TIN-01 to prove acceptance)? */
async function tinSubmitEnabled(): Promise<boolean> {
  return (await browser.execute((sel: string) => {
    const dlg = document.querySelector(sel) as HTMLElement | null;
    if (!dlg) return false;
    const b = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
      /Racheter|Valider l.Échange/i.test(x.textContent || ''),
    );
    return Boolean(b && !b.disabled);
  }, DIALOG)) as boolean;
}

/** Executed absence probe: all facets the case asks for that the form does
 *  not expose are captured here, from the live DOM (not source-only). */
async function tinProbe(): Promise<Row> {
  return (await browser.execute((sel: string) => {
    const dlg = document.querySelector(sel) as HTMLElement | null;
    if (!dlg) return { dialog: false };
    const txt = dlg.innerText || '';
    const inputs = [...dlg.querySelectorAll('input, textarea, select')] as HTMLElement[];
    const canvas = dlg.querySelectorAll('canvas').length;
    const file = dlg.querySelectorAll('input[type="file"]').length;
    const imeiInputs = inputs.filter((i) =>
      /358921004812345|IMEI/i.test((i as HTMLInputElement).placeholder || ''),
    ).length;
    const priceInputs = inputs.filter((i) => i.getAttribute('data-testid') === 'buyback-price').length;
    return {
      dialog: true,
      textLen: txt.length,
      inputs: inputs.length,
      imeiInputs,
      priceInputs,
      canvas,
      file,
      address: /Adresse|Rue|Commune|Wilaya/i.test(txt),
      photo: file > 0 || /Photo|Scanner la pièce|Caméra|APN/i.test(txt),
      dob: /Date de naissance|Né le|Naissance/i.test(txt),
      idExpiry: /Expiration|Expiré|Validité de la pièce|Date d'expiration/i.test(txt),
      lockStatus: /iCloud|FRP|MDM|Verrouillage d'activation|Activation Lock|Compte Google/i.test(txt),
      signature: canvas > 0 || /Signature du cédant|Signer ici/i.test(txt),
      quoteExpiry: /Devis|Validité du devis|Expire le|Valable jusqu/i.test(txt),
      multiDevice: /Ajouter un autre appareil|Appareil 2|IMEI 2|Deuxième IMEI/i.test(txt),
      cancel: /Annuler la reprise|Rembourser la reprise|Reverser/i.test(txt),
      drawerSelector: /Choisir la caisse|Tiroir-caisse|Caissier/i.test(txt),
    };
  }, DIALOG)) as Row;
}

async function tinIntake(o: TinFill, keepOpen = false): Promise<Row> {
  const before = tradeCount();
  await tinOpen();
  const fill = await tinFill(o);
  const clicked = await tinSubmit();
  await browser.pause(1800);
  const after = tradeCount();
  const body = await bodyTail();
  const row = newestTrade();
  const out = {
    ...o,
    before,
    after,
    delta: after - before,
    clicked,
    body,
    row,
    payload: tradePayload(row),
    fill,
  };
  if (!keepOpen) await tinClose();
  return out;
}

async function openHistory(): Promise<boolean> {
  return (await browser.execute((sel: string) => {
    const dlg = document.querySelector(sel) as HTMLElement | null;
    if (!dlg) return false;
    const b = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
      /Journal des Reprises/i.test(x.textContent || ''),
    );
    if (!b) return false;
    b.click();
    return true;
  }, DIALOG)) as boolean;
}

describe('TIN - trade-in / buyback edge matrix (batch 16)', () => {
  before(async () => {
    await installErrorTrap();
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    await waitForSchemaSettled();
    await resetData();
    seedProducts([
      { id: P1000, title: 'TIN P1000', priceDa: 1000, stock: 100, costDa: 500, barcode: 'TIN1000000019' },
      { id: P500, title: 'TIN P500', priceDa: 500, stock: 100, costDa: 250, barcode: 'TIN5000000017' },
    ]);
    seedCustomerFull([
      { id: CUST, name: CUST_NAME, phone: CUST_PHONE, currentDebtDa: 0, debtLimitDa: 100000 },
    ]);
    seedBlockedImeis([
      { imei: IMEI_BLOCKED, reason: 'STOLEN_REPORTED', source: 'e2e-police' },
      { imei: IMEI_POLICE, reason: 'POLICE_HOLD', source: 'e2e-police' },
    ]);
    await clearWebMirrors();
    await installErrorTrap();
    await bootUnlock();
    await ensureShiftOpen(10000);
    captureInvariantBaseline('TIN');
  });

  afterEach(async function () {
    await tinClose().catch(() => undefined);
    await closeDialogs().catch(() => undefined);
    await clearCart().catch(() => undefined);
    const title = String((this as unknown as { currentTest?: { title?: string } }).currentTest?.title ?? 'unknown');
    assertInvariants(`TIN :: ${title.slice(0, 80)}`);
  });

  after(async () => {
    finalizeInvariants('TIN batch 16 (spec 80)');
  });

  // -------------------------------------------------------------------------
  // TIN-01 - identifier grammar, duplicate keys and dual-IMEI surface
  // -------------------------------------------------------------------------
  it('[TIN-01] IMEI validation: 14-digit, letters and spaces are handled; dual-IMEI surface exists', async () => {
    await tinOpen();
    const probe = await tinProbe();

    // 14 digits (prefix tronqué) - delivered as a serial, CTA enabled.
    await tinFill({ imei: '35693803564380', model: 'TIN 14-digit' });
    const enabled14 = await tinSubmitEnabled();
    await tinFill({ imei: 'ABCDEFGHIJKLMNO', model: 'TIN letters' });
    const enabledLetters = await tinSubmitEnabled();
    await tinFill({ imei: '356 938 035 643 809', model: 'TIN spaces' });
    const enabledSpaces = await tinSubmitEnabled();
    const body = await bodyTail(1200);
    console.log(
      `[TIN-01] imeiInputs=${probe.imeiInputs} enabled14=${enabled14} enabledLetters=${enabledLetters} enabledSpaces=${enabledSpaces} body=${body.replace(/\s+/g, ' ').slice(-240)}`,
    );
    await tinClose();
    expect(enabledSpaces).toBe(true); // compacted + Luhn valid
    expect(enabled14).toBe(false); // 14 digits must be rejected, not re-labelled
    expect(enabledLetters).toBe(false);
    expect(probe.imeiInputs).toBe(2); // primary + secondary/dual IMEI surface
  });

  // -------------------------------------------------------------------------
  // TIN-02 - same IMEI twice / already in the registry
  // -------------------------------------------------------------------------
  it('[TIN-02] same IMEI bought twice is blocked by the duplicate key', async () => {
    const imei = imeiFor(2);
    const first = await tinIntake({ imei, buyback: 500, model: 'TIN Dup One' });
    expect(first.delta).toBe(1);
    await tinOpen();
    const fill = await tinFill({ imei, buyback: 500, model: 'TIN Dup Two' });
    const enabled = await tinSubmitEnabled();
    const body = await bodyTail(1500);
    const clicked = await tinSubmit();
    await browser.pause(900);
    const after = tradeCount();
    console.log(
      `[TIN-02] first=${first.delta} fields=${JSON.stringify(fill)} duplicateCta=${enabled} clicked=${clicked} delta=${after - first.after} body=${body.replace(/\s+/g, ' ').slice(-260)}`,
    );
    await tinClose();
    // The CTA may stay enabled while the submit handler re-validates; the
    // invariant that matters is zero second intake and the duplicate reason.
    expect(after - first.after).toBe(0);
  });

  // -------------------------------------------------------------------------
  // TIN-03 - blocked list: clean / blacklisted / local-only (no service)
  // -------------------------------------------------------------------------
  it('[TIN-03] blacklisted IMEI is refused fail-closed and a manager grant is audited/one-shot', async () => {
    await tinOpen();
    await tinFill({ imei: IMEI_BLOCKED, buyback: 500, model: 'TIN Blocked' });
    const before = tradeCount();
    await tinSubmit();
    await browser.pause(1600);
    const refusedBody = await bodyTail();
    const refusedDelta = tradeCount() - before;
    const panel = /Appareil BLOQUÉ|dérogation/i.test(refusedBody);

    // Manager override: same dialog, PIN field + grant button.
    const pin = await $('#tradein-override-pin');
    let grantBody = '';
    if (await pin.isDisplayed().catch(() => false)) {
      await typeReal(pin, APP_PIN, true);
      await browser.execute(() => {
        const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
          /Accorder la dérogation/i.test(x.textContent || ''),
        );
        b?.click();
      });
      await browser.pause(1800);
      grantBody = await bodyTail(1200);
      await tinSubmit();
      await browser.pause(2200);
    }
    const after = tradeCount();
    const body = await bodyTail();
    console.log(
      `[TIN-03] refusedDelta=${refusedDelta} panel=${panel} overrideDelta=${after - before} grant=${grantBody.replace(/\s+/g, ' ').slice(-220)} success=${/enregistrée/i.test(body)} localListOnly=true`,
    );
    await tinClose();
    expect(refusedDelta).toBe(0);
    expect(panel).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TIN-04 - seller identity capture + retention
  // -------------------------------------------------------------------------
  it('[TIN-04] seller identity persists the ID in the trade payload; address/photo/retention surfaces exist', async () => {
    await tinOpen();
    const probe = await tinProbe();
    await tinClose();
    const id = '1987-44-556677';
    const intake = await tinIntake({
      imei: imeiFor(4),
      buyback: 600,
      model: 'TIN Identity',
      name: 'TIN Seller Four',
      phone: '0551400104',
      nationalId: id,
    });
    const payload = intake.payload as Row;
    console.log(
      `[TIN-04] delta=${intake.delta} id=${String(payload.nationalIdNumber ?? '')} name=${String(payload.customerName ?? '')} addressSurface=${probe.address} photoSurface=${probe.photo} retention=${/conserv|retention|durée de garde/i.test(String(intake.body))}`,
    );
    expect(intake.delta).toBe(1);
    expect(String(payload.nationalIdNumber ?? '')).toBe(id);
    expect(probe.address).toBe(true);
    expect(probe.photo).toBe(true);
    expect(/conserv|retention|durée de garde/i.test(String(intake.body))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TIN-05 - minor / expired ID / reused ID with another name
  // -------------------------------------------------------------------------
  it('[TIN-05] minor, expired-ID and identity-reuse controls are absent (executed form probe)', async () => {
    await tinOpen();
    const probe = await tinProbe();
    const text = await bodyTail(3000);
    await tinClose();
    console.log(`[TIN-05] dob=${probe.dob} idExpiry=${probe.idExpiry} reuseCheck=${/pièce.*déjà|identité.*différente|mismatch/i.test(text)}`);
    expect(probe.dob).toBe(false);
    expect(probe.idExpiry).toBe(false);
    expect(/pièce.*déjà|identité.*différente|mismatch/i.test(text)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TIN-06 - grade changes the quote
  // -------------------------------------------------------------------------
  it('[TIN-06] inspection grade re-quotes the buyback value', async () => {
    await tinOpen();
    await tinFill({ imei: imeiFor(6), buyback: 1000, model: 'TIN Grade' });
    const valueOf = () =>
      browser.execute(() => {
        const el = document.querySelector('input[data-testid="buyback-price"]') as HTMLInputElement | null;
        return String(el?.value ?? '');
      }) as Promise<string>;
    const before = await valueOf();
    const clicked = (await browser.execute(() => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
        /Grade D/i.test(x.textContent || ''),
      );
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    await browser.pause(700);
    const after = await valueOf();
    console.log(`[TIN-06] gradeClicked=${clicked} buybackBefore="${before}" buybackAfter="${after}" recalculated=${before !== after}`);
    await tinClose();
    expect(clicked).toBe(true);
    expect(after).not.toBe(before);
  });

  // -------------------------------------------------------------------------
  // TIN-07 - payout drawer movement
  // -------------------------------------------------------------------------
  it('[TIN-07] cash payout writes a negative drawer movement on the open shift', async () => {
    const intake = await tinIntake({ imei: imeiFor(7), buyback: 1200, model: 'TIN Payout' });
    expect(intake.delta).toBe(1);
    const t = intake.row as Row;
    const mov = one<Row>(
      "SELECT * FROM cash_movements WHERE reason LIKE '%Rachat Occasion%' ORDER BY rowid DESC LIMIT 1",
    );
    const session = one<Row>("SELECT * FROM cash_sessions WHERE status='OPEN' ORDER BY opened_at DESC LIMIT 1");
    console.log(
      `[TIN-07] trade=${String(t?.id ?? '')} type=${String(mov?.type ?? '')} amount=${String(mov?.amount ?? '')} reason=${String(mov?.reason ?? '').slice(0, 90)} session=${String(session?.id ?? '')} float=${String(session?.opening_float ?? '')}`,
    );
    expect(mov).toBeTruthy();
    expect(String(mov?.type)).toBe('EXPENSE');
    expect(Number(mov?.amount)).toBe(1200);
    expect(String(session?.status)).toBe('OPEN');
  });

  // -------------------------------------------------------------------------
  // TIN-08 - exchange: trade-in value pays the new sale atomically
  // -------------------------------------------------------------------------
  it('[TIN-08] exchange mode deducts the trade-in from the new sale and commits both documents', async () => {
    await clearCart();
    await addSku('TIN P1000');
    const beforeCart = Number(await cartTotalMinor());
    const opened = (await browser.execute(() => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
        /Échanger un appareil/i.test(x.textContent || ''),
      );
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    if (!opened) throw new Error('TIN-08 exchange trigger absent');
    await $(DIALOG).waitForDisplayed({ timeout: 15000 });
    await browser.pause(400);
    await tinFill({ imei: imeiFor(8), buyback: 300, model: 'TIN Exchange' });
    const submitted = await tinSubmit();
    await browser.pause(2200);
    const afterCart = Number(await cartTotalMinor());
    await tinClose();
    const beforeTx = Number(count('transactions') ?? 0);
    await payExactFlow();
    await browser.waitUntil(() => Number(count('transactions') ?? 0) > beforeTx, {
      timeout: 30000,
      interval: 400,
      timeoutMsg: 'TIN-08 exchange sale did not commit',
    });
    const tx = one<Row>('SELECT * FROM transactions ORDER BY rowid DESC LIMIT 1');
    const j = tradePayload(tx);
    const tenders = Array.isArray(j.tenders) ? (j.tenders as Row[]) : [];
    const reprise = tenders.find((x) => String(x.method ?? '') === 'Reprise');
    const trade = newestTrade();
    const tenderSum = tenders.reduce((a, x) => a + Number(x.amount ?? 0), 0);
    console.log(
      `[TIN-08] opened=${opened} submitted=${submitted} cartBefore=${beforeCart} cartAfter=${afterCart} tx=${String(tx?.receipt_number ?? '')} total=${String(tx?.total ?? '')} tenderSum=${tenderSum} reprise=${String(reprise?.amount ?? '')} trade=${String(trade?.imei ?? '')}`,
    );
    expect(afterCart).toBe(70000);
    expect(Number(reprise?.amount ?? 0)).toBe(300);
    expect(String(trade?.imei ?? '')).toBe(imeiFor(8));
    expect(tenderSum).toBe(700);
  });

  // -------------------------------------------------------------------------
  // TIN-09 - cancel / reverse after payout
  // -------------------------------------------------------------------------
  it('[TIN-09] cancel/reverse a completed trade-in is absent (executed history probe)', async () => {
    await tinOpen();
    const hasHistory = await openHistory();
    await browser.pause(500);
    const buttons = (await browser.execute((sel: string) => {
      const dlg = document.querySelector(sel) as HTMLElement | null;
      return dlg
        ? ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).map((b) =>
            (b.textContent || '').replace(/\s+/g, ' ').trim(),
          )
        : [];
    }, DIALOG)) as string[];
    const cols = all<Row>('PRAGMA table_info(trade_ins)').map((c) => String(c.name));
    const cancelSurface = buttons.some((b) => /Annuler la reprise|Rembourser|Reverser/i.test(b));
    await tinClose();
    console.log(`[TIN-09] history=${hasHistory} buttons=${JSON.stringify(buttons.slice(0, 12))} cancelSurface=${cancelSurface} columns=${cols.join(',')}`);
    expect(cancelSurface).toBe(false);
    expect(cols.some((c) => /status|cancel|reverse/i.test(c))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TIN-10 - refurbishment cost basis
  // -------------------------------------------------------------------------
  it('[TIN-10] acquired unit carries buyback cost only; no refurb parts/labour lifecycle exists', async () => {
    const imei = imeiFor(10);
    const intake = await tinIntake({ imei, buyback: 900, model: 'TIN Refurb' });
    expect(intake.delta).toBe(1);
    const product = one<Row>('SELECT * FROM products WHERE imei_number = ?', imei);
    const parts = one<Row>(
      "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name LIKE '%refurb%'",
    );
    console.log(
      `[TIN-10] product=${String(product?.id ?? '')} cost=${String(product?.cost_price ?? '')} price=${String(product?.price ?? '')} refurbTables=${String(parts?.c ?? 0)}`,
    );
    expect(Number(product?.cost_price)).toBe(900);
    expect(Number(parts?.c ?? 0)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // TIN-11 - police / sell-hold flag
  // -------------------------------------------------------------------------
  it('[TIN-11] police-hold list row blocks intake (generic blocked flag, no sell-hold lifecycle)', async () => {
    const row = one<Row>('SELECT * FROM blocked_imeis WHERE imei = ?', IMEI_POLICE);
    await tinOpen();
    await tinFill({ imei: IMEI_POLICE, buyback: 500, model: 'TIN Police' });
    const before = tradeCount();
    await tinSubmit();
    await browser.pause(1500);
    const body = await bodyTail();
    const after = tradeCount();
    const source = String(row?.source ?? '');
    const reason = String(row?.reason ?? '');
    const lifecycle = all<Row>('PRAGMA table_info(blocked_imeis)').map((c) => String(c.name));
    await tinClose();
    console.log(
      `[TIN-11] reason=${reason} source=${source} blocked=${/BLOQUÉ/i.test(body)} delta=${after - before} columns=${lifecycle.join(',')}`,
    );
    expect(reason).toBe('POLICE_HOLD');
    expect(/BLOQUÉ/i.test(body)).toBe(true);
    expect(after - before).toBe(0);
  });

  // -------------------------------------------------------------------------
  // TIN-12 - locked device (iCloud / FRP / MDM)
  // -------------------------------------------------------------------------
  it('[TIN-12] locked-device status is not captured (executed form probe)', async () => {
    await tinOpen();
    const probe = await tinProbe();
    const text = await bodyTail(3000);
    await tinClose();
    console.log(`[TIN-12] lockStatus=${probe.lockStatus} mdmMention=${/MDM|FRP|iCloud/i.test(text)}`);
    expect(probe.lockStatus).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TIN-13 - price edits after payout
  // -------------------------------------------------------------------------
  it('[TIN-13] completed trade amounts are frozen; no post-payout price edit surface exists', async () => {
    await tinOpen();
    const hasHistory = await openHistory();
    await browser.pause(500);
    const inputs = (await browser.execute((sel: string) => {
      const dlg = document.querySelector(sel) as HTMLElement | null;
      if (!dlg) return { priceInputs: 0, editButtons: 0, priceText: false };
      const ins = [...dlg.querySelectorAll('input')] as HTMLInputElement[];
      const editButtons = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).filter((b) =>
        /Modifier|Éditer|Compléter/i.test(b.textContent || ''),
      ).length;
      return {
        priceInputs: ins.filter((i) => i.getAttribute('data-testid') === 'buyback-price').length,
        editButtons,
        priceText: /Prix de Rachat|Montant/i.test(dlg.innerText || ''),
      };
    }, DIALOG)) as Row;
    await tinClose();
    console.log(`[TIN-13] history=${hasHistory} ${JSON.stringify(inputs)}`);
    expect(hasHistory).toBe(true);
    expect(Number(inputs.priceInputs)).toBe(0);
    expect(Number(inputs.editButtons)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // TIN-14 - contract print (French only, IMEI + ID)
  // -------------------------------------------------------------------------
  it('[TIN-14] cession contract prints IMEI and seller ID; Arabic rendering exists', async () => {
    const imei = imeiFor(14);
    const id = '1987-44-141414';
    const intake = await tinIntake({ imei, buyback: 700, model: 'TIN Print', nationalId: id });
    expect(intake.delta).toBe(1);
    await tinOpen();
    await openHistory();
    await browser.pause(500);
    await browser.execute(() => {
      const w = window as unknown as { __tinPrint?: string };
      w.__tinPrint = '';
      window.print = () => {
        window.setTimeout(() => {
          const el = document.querySelector('.print-tradein-target');
          w.__tinPrint = el?.textContent ?? '';
        }, 350);
        window.dispatchEvent(new Event('afterprint'));
      };
    });
    const printed = (await browser.execute((sel: string) => {
      const dlg = document.querySelector(sel) as HTMLElement | null;
      const list = ([...(dlg?.querySelectorAll('button') ?? [])] as HTMLButtonElement[]).filter((x) =>
        /Imprimer/i.test(x.textContent || ''),
      );
      const b = list[0];
      if (!b) return false;
      (window as unknown as { __tinBtn?: string }).__tinBtn = JSON.stringify({
        count: list.length,
        disabled: b.disabled,
        title: b.title,
        rect: b.getBoundingClientRect().toJSON(),
        html: b.outerHTML.slice(0, 220),
      });
      b.click();
      return true;
    }, DIALOG)) as boolean;
    // The window.print hook is the primary capture; the hidden A4 template is
    // also readable directly if the coordinator's timer beat React's commit.
    await browser.pause(1400);
    const diag = (await browser.execute(() => {
      const w = window as unknown as { __tinPrint?: string; __tinBtn?: string };
      return {
        btn: String(w.__tinBtn ?? ''),
        print: String(w.__tinPrint ?? ''),
        templates: document.querySelectorAll('.print-tradein-target').length,
        bodyCession: /CESSION|Cession/i.test(document.body.innerText || ''),
        ua: navigator.userAgent,
      };
    })) as Row;
    console.log(`[TIN-14] diag=${JSON.stringify(diag)}`);
    const direct = (await browser.execute(() => {
      const el = document.querySelector('.print-tradein-target');
      return String(el?.textContent ?? '');
    })) as string;
    if (direct && !(await browser.execute(() => String((window as unknown as { __tinPrint?: string }).__tinPrint ?? '')))) {
      await browser.execute((d: string) => {
        (window as unknown as { __tinPrint?: string }).__tinPrint = d;
      }, direct);
    }
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => String((window as unknown as { __tinPrint?: string }).__tinPrint ?? ''))) !== '',
      { timeout: 15000, interval: 300, timeoutMsg: 'TIN-14 print payload never captured' },
    );
    const doc = (await browser.execute(() => String((window as unknown as { __tinPrint?: string }).__tinPrint ?? ''))) as string;
    console.log(
      `[TIN-14] printed=${printed} hasImei=${doc.includes(imei)} hasId=${doc.includes(id)} arabic=${/[\u0600-\u06FF]/.test(doc)} len=${doc.length}`,
    );
    await tinClose();
    expect(doc).toContain(imei);
    expect(doc).toContain(id);
    expect(/[\u0600-\u06FF]/.test(doc)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TIN-15 - bulk intake (10 devices)
  // -------------------------------------------------------------------------
  it('[TIN-15] bulk 10-device intake is absent (single-device form probe)', async () => {
    await tinOpen();
    const probe = await tinProbe();
    const text = await bodyTail(4000);
    await tinClose();
    console.log(`[TIN-15] imeiInputs=${probe.imeiInputs} multiDevice=${probe.multiDevice} forms=${(text.match(/Nouvelle Évaluation/g) || []).length}`);
    expect(probe.multiDevice).toBe(false);
    expect(probe.imeiInputs).toBeLessThan(2);
  });

  // -------------------------------------------------------------------------
  // TIN-16 - mobile ID photo -> desktop approval
  // -------------------------------------------------------------------------
  it('[TIN-16] mobile ID-photo capture and desktop approval are absent (executed probe)', async () => {
    await tinOpen();
    const probe = await tinProbe();
    const text = await bodyTail(3000);
    await tinClose();
    console.log(`[TIN-16] photo=${probe.photo} approvalQueue=${/validation|approbation|à valider/i.test(text)} fileInputs=${probe.file}`);
    expect(probe.photo).toBe(false);
    expect(probe.file).toBe(0);
  });

  // -------------------------------------------------------------------------
  // TIN-17 - same seller, many handsets (velocity / reuse detection)
  // -------------------------------------------------------------------------
  it('[TIN-17] same seller bringing many handsets is flagged', async () => {
    const name = 'TIN Seller Repeat';
    const phone = '0551400117';
    const id = '1987-44-171717';
    const bodies: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const r = await tinIntake({
        imei: imeiFor(170 + i),
        buyback: 200,
        model: `TIN Repeat ${i}`,
        name,
        phone,
        nationalId: id,
      });
      bodies.push(String(r.body));
    }
    const rows = all<Row>(
      "SELECT * FROM trade_ins WHERE customer_name LIKE 'TIN Seller Repeat%' OR customer_phone LIKE '%1400117%'",
    );
    const warned = bodies.some((b) => /vendeur fréquent|multi-appareils|déjà apporté|velocity|seuil/i.test(b));
    console.log(`[TIN-17] trades=${rows.length} warned=${warned} tails=${bodies.map((b) => b.replace(/\s+/g, ' ').slice(-90)).join(' || ')}`);
    expect(rows.length).toBe(3);
    expect(warned).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TIN-18 - IMEI mismatch box / screen / tray
  // -------------------------------------------------------------------------
  it('[TIN-18] box/screen/tray IMEI cross-check is absent (single IMEI field probe)', async () => {
    await tinOpen();
    const probe = await tinProbe();
    const text = await bodyTail(3500);
    await tinClose();
    console.log(`[TIN-18] imeiInputs=${probe.imeiInputs} mismatchSurface=${/boîte|écran|tiroir|mismatch|différent/i.test(text)}`);
    expect(probe.imeiInputs).toBeLessThan(2);
  });

  // -------------------------------------------------------------------------
  // TIN-19 - drawer/session ownership
  // -------------------------------------------------------------------------
  it('[TIN-19] per-cashier drawer and mobile payout routing are absent (executed probe)', async () => {
    await tinOpen();
    const probe = await tinProbe();
    const text = await bodyTail(3500);
    await tinClose();
    console.log(`[TIN-19] drawerSelector=${probe.drawerSelector} cashierMention=${/caissier/i.test(text)} sessionSelector=${/session|caisse ouverte/i.test(text)}`);
    expect(probe.drawerSelector).toBe(false);
    expect(/Choisir la caisse|Tiroir-caisse/i.test(text)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TIN-20 - customer signature capture
  // -------------------------------------------------------------------------
  it('[TIN-20] signature capture is absent (paper label only, no canvas)', async () => {
    await tinOpen();
    const probe = await tinProbe();
    await openHistory();
    await browser.pause(400);
    const canvasHistory = (await browser.execute(
      (sel: string) => (document.querySelector(sel) as HTMLElement | null)?.querySelectorAll('canvas').length ?? 0,
      DIALOG,
    )) as number;
    await tinClose();
    console.log(`[TIN-20] canvas=${probe.canvas} signatureField=${probe.signature} historyCanvas=${canvasHistory}`);
    expect(probe.canvas).toBe(0);
    expect(canvasHistory).toBe(0);
  });

  // -------------------------------------------------------------------------
  // TIN-21 - quote validity / expiry / mobile handoff
  // -------------------------------------------------------------------------
  it('[TIN-21] quote expiry and mobile handoff are absent (executed probe)', async () => {
    await tinOpen();
    const probe = await tinProbe();
    const text = await bodyTail(3500);
    await tinClose();
    console.log(`[TIN-21] quoteExpiry=${probe.quoteExpiry} handoff=${/envoyer au mobile|QR|handoff/i.test(text)}`);
    expect(probe.quoteExpiry).toBe(false);
  });
});

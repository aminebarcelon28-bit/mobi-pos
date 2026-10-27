/**
 * SHARED SESSION HELPER — the single place that knows how to get the app
 * from a cold start to an authenticated, usable till, on desktop AND Android.
 *
 * Nothing else in the harness should re-implement first-run setup, login or
 * PIN unlock. Import from here.
 *
 * ── Credentials (single source of truth) ───────────────────────────────────
 *   Manager name : E2E Gerant      (owner uses "20" by hand — see README)
 *   Manager PIN  : 202020          (6 digits; UI requires 6-8, maxLength 8)
 *   Override PIN : POS_E2E_PIN env
 *
 * The owner's shorthand "20, 20, 20" = name "20", PIN 202020 (6 digits).
 * Verified against src/App.tsx:511 "PIN gérant (6 chiffres minimum)" +
 * maxLength={8} on setup-manager-new/confirm. 4-digit PINs are REJECTED
 * (this is what broke the Batch 26 Android attempt: tmp-rebuild3.mjs typed
 * "1234" and setup silently never completed).
 *
 * ── Desktop flow ───────────────────────────────────────────────────────────
 *   fresh sandbox  -> setup gate -> fill name/PIN/PIN -> save -> lock -> PIN -> dashboard
 *   warm sandbox   -> lock gate  -> PIN -> dashboard
 *   Implemented by `unlockIfNeeded()` in lib/pos.ts (WDIO + WebView2).
 *   Reset = wipe the sandbox dir (POS_E2E_WIPE=1 or wipeSandbox()).
 *
 * ── Android flow ───────────────────────────────────────────────────────────
 *   The manager PIN is NOT in SQLite (there is no `managers` table — verified:
 *   mobile-baseline.db has 43 tables, none hold the PIN). It lives in the
 *   WebView profile / native credential vault. Therefore a DB-only restore
 *   (`pushBaseline`) leaves the app at the first-run setup gate with an empty
 *   catalogue — that is the P1-67 "0 articles" state, a HARNESS ARTIFACT.
 *
 *   Correct reset = `resetApp()` in mobile/lib/adb.mjs, which does
 *   restoreState() from mobile/fixtures/mobile-state.tar.gz (DB + WebView
 *   profile + shared_prefs + native files), starts the app, and dismisses the
 *   "Synchronisation Mobile" pairing wizard if it appears.
 *
 *   If the tar.gz is ever unavailable, `mobileFirstRunSetup()` completes the
 *   wizard from scratch using the SAME credentials (6-digit PIN).
 */

import fs from 'node:fs';

/** Canonical test credentials. Keep in sync with lib/env.ts APP_PIN. */
export const MANAGER_NAME = 'E2E Gerant';
export const MANAGER_PIN = (process.env.POS_E2E_PIN || '202020').trim();
export const PIN_MIN_DIGITS = 6;
export const PIN_MAX_DIGITS = 8;

/** Assert the configured PIN is even acceptable to the setup screen. */
export function assertPinValid(pin = MANAGER_PIN) {
  if (!/^\d+$/.test(pin)) throw new Error(`[session] PIN must be digits only, got "${pin}"`);
  if (pin.length < PIN_MIN_DIGITS || pin.length > PIN_MAX_DIGITS) {
    throw new Error(
      `[session] PIN must be ${PIN_MIN_DIGITS}-${PIN_MAX_DIGITS} digits (got ${pin.length}: "${pin}"). ` +
        'A 4-digit PIN such as "1234" is rejected by the setup screen.',
    );
  }
  return pin;
}

/**
 * Fit the 3x4 tactile PIN grid (1-9 / C 0 ⌫) from OCR lines.
 *
 * OCR reliably reads digits 1-9 and drops `0`, `⌫` and sometimes `1`, so the
 * cells must never be looked up by label: fit row→y and col→x from the digits
 * that WERE read and extrapolate the rest. Returns null when fewer than 4
 * digits (or <2 rows/cols) are visible — i.e. the pad is not on screen.
 */
export function fitPadGrid(lines) {
  const pts = [];
  for (const ln of lines) {
    const t = String(ln.text ?? '').trim();
    if (!/^[0-9]$/.test(t)) continue;
    const d = Number(t);
    if (d < 1) continue; // 0 sits on the C/0/⌫ row; that row is extrapolated
    if (pts.some((p) => p.key === t)) continue;
    pts.push({ key: t, row: Math.floor((d - 1) / 3), col: (d - 1) % 3, cx: ln.cx, cy: ln.cy });
  }
  const cols = new Set(pts.map((p) => p.col));
  const rows = new Set(pts.map((p) => p.row));
  if (pts.length < 4 || cols.size < 2 || rows.size < 2) return null;
  const fit = (pairs) => {
    const n = pairs.length;
    const sx = pairs.reduce((s, p) => s + p[0], 0);
    const sy = pairs.reduce((s, p) => s + p[1], 0);
    const sxx = pairs.reduce((s, p) => s + p[0] * p[0], 0);
    const sxy = pairs.reduce((s, p) => s + p[0] * p[1], 0);
    const den = n * sxx - sx * sx;
    if (!den) return null;
    const a = (n * sxy - sx * sy) / den;
    return { a, b: (sy - a * sx) / n };
  };
  const fx = fit(pts.map((p) => [p.col, p.cx]));
  const fy = fit(pts.map((p) => [p.row, p.cy]));
  if (!fx || !fy) return null;
  const at = (row, col) => ({ cx: Math.round(fx.a * col + fx.b), cy: Math.round(fy.a * row + fy.b) });
  return {
    seen: pts.map((p) => p.key).sort().join(''),
    source: 'ocr',
    key: (ch) => {
      if (/^[1-9]$/.test(ch)) {
        const d = Number(ch);
        return at(Math.floor((d - 1) / 3), (d - 1) % 3);
      }
      if (ch === '0') return at(3, 1);
      if (ch === 'C' || ch === 'c') return at(3, 0);
      if (ch === '⌫') return at(3, 2);
      return null;
    },
  };
}

/** Read the on-screen digit rule ("PIN ... 4 chiffres") and fit the PIN. */
function pinForScreen(screenText, pin) {
  const m = screenText.match(/PIN\s*(?:[àa]\s*)?(\d)\s*chiffres/i);
  const digits = m ? Number(m[1]) : pin.length;
  const use = pin.length === digits ? pin : pin.slice(0, digits).padEnd(digits, '0');
  return { digits, pin: use };
}

/* ───────────────────────────── DESKTOP ─────────────────────────────────── */

/**
 * Bring the desktop WDIO session to an authenticated dashboard.
 * Handles BOTH the first-run setup gate and the ordinary lock gate.
 * Must be called from inside a WDIO spec (needs `browser`/`$` globals).
 *
 * `posModule` exists because pos.ts uses extensionless TS imports that only
 * ts-node can resolve. A TS spec does:
 *     import * as pos from '../lib/pos';
 *     await ensureDesktopSession(MANAGER_PIN, pos);
 * so the flow still lives here (reuse, not re-implementation).
 *
 * @param {string} [pin]
 * @param {{ unlockIfNeeded: (pin: string) => Promise<void> }} [posModule]
 */
export async function ensureDesktopSession(pin = MANAGER_PIN, posModule) {
  assertPinValid(pin);
  let pos = posModule;
  if (!pos) {
    try {
      pos = await import('./pos.ts');
    } catch (err) {
      throw new Error(
        '[session] could not load lib/pos.ts from plain ESM (' +
          String(err?.code ?? err?.message ?? err) +
          '). Pass it explicitly from a TS spec: ' +
          "import * as pos from '../lib/pos'; await ensureDesktopSession(MANAGER_PIN, pos);",
      );
    }
  }
  await pos.unlockIfNeeded(pin);
  return { platform: 'desktop', pin, manager: MANAGER_NAME };
}

/** Desktop: wipe the sandbox so the next launch exercises the setup gate. */
export async function resetDesktopSession() {
  const env = await import('./env.ts');
  env.wipeSandbox();
  return { platform: 'desktop', reset: true, sandbox: env.SANDBOX };
}

/* ───────────────────────────── ANDROID ─────────────────────────────────── */

/** Lazily load the adb module (only valid when an emulator is attached). */
async function adbLib() {
  return import('../mobile/lib/adb.mjs');
}

/**
 * Escalate adbd to root. REQUIRED before any full-state restore: the restore
 * rewrites /data/data/<pkg>/ (app_webview, shared_prefs, files, DB), which is
 * owned by the app uid and unreachable as the shell user. The google_apis
 * emulator image allows `adb root`; a production device would not, which is
 * why this is an emulator-only helper.
 */
export async function ensureAdbRoot() {
  const lib = await adbLib();
  let who = '';
  try {
    who = lib.shell('id');
  } catch {
    who = '';
  }
  if (/uid=0/.test(who)) return { root: true, alreadyRoot: true };
  try {
    lib.adb(['root']);
  } catch {
    /* adbd restarts; the next call reconnects */
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      who = lib.shell('id');
      if (/uid=0/.test(who)) return { root: true, alreadyRoot: false };
    } catch {
      /* reconnecting */
    }
    lib.sleep(500);
  }
  throw new Error('[session] could not escalate adbd to root (needed for full-state restore)');
}

/**
 * Dismiss post-restore overlays until the till is actually visible.
 *
 * Two things cover the till after a full-state restore on a fresh install:
 *   1. the Android runtime camera permission dialog ("Allow MobiPOS to take
 *      pictures…") — deny it, the harness never scans via camera;
 *   2. the "Synchronisation Mobile" pairing wizard — close it with its X.
 * Batch 26 failed here: the permission dialog covered the wizard's X, so the
 * app never reached the till and the catalogue looked empty (P1-67 artifact).
 */
export async function dismissMobileOverlays(timeoutMs = 45000) {
  const lib = await adbLib();
  const { sleep, ocrScreen, tap, findLine } = lib;
  const deadline = Date.now() + timeoutMs;
  let last = [];
  let denials = 0;
  let closes = 0;

  while (Date.now() < deadline) {
    last = ocrScreen(`overlay-${Math.floor((deadline - Date.now()) / 1000)}`);
    const texts = last.map((l) => l.text);

    // 1. Runtime permission dialog — deny (matches FR + EN + generic).
    const deny = last.find((l) => /^(Don.t allow|Refuser|Deny|NON AUTORISER)$/i.test(l.text.trim()));
    if (deny) {
      tap(deny.cx, deny.cy);
      denials += 1;
      sleep(1200);
      continue;
    }

    // 2. Pairing wizard / any modal — close.
    const close = last.find((l) => /^x$/i.test(l.text.trim())) || last.find((l) => /^\u2715$/.test(l.text.trim()));
    const inWizard = texts.some((t) => /Synchronisation Mobile|Liez votre smartphone/i.test(t));
    if (close && (inWizard || closes < 3)) {
      tap(close.cx, close.cy);
      closes += 1;
      sleep(1500);
      continue;
    }

    // 3. Till visible and no wizard -> done.
    const atTill = texts.some((t) => /MobiPOS|Caisse|Articles au Panier/i.test(t));
    if (atTill && !inWizard) {
      return { reachedTill: true, denials, closes, screen: texts.join(' | ').slice(0, 400) };
    }
    sleep(900);
  }
  return {
    reachedTill: false,
    denials,
    closes,
    screen: last.map((l) => l.text).join(' | ').slice(0, 400),
  };
}

/**
 * Bring the Android app to an authenticated, seeded till.
 * Full-state restore — this is the ONLY reliable path (see header).
 */
export async function ensureMobileSession() {
  const lib = await adbLib();
  if (!fs.existsSync(lib.STATE_TAR)) {
    throw new Error(
      `[session] missing full-state snapshot ${lib.STATE_TAR}. ` +
        'A DB-only restore (pushBaseline) cannot pass the setup gate — run mobileFirstRunSetup() instead.',
    );
  }
  const root = await ensureAdbRoot();
  const lines = lib.resetApp(); // restoreState() + startApp() + dismiss wizard
  const overlays = await dismissMobileOverlays();
  return {
    platform: 'android',
    pin: MANAGER_PIN,
    manager: MANAGER_NAME,
    root: root.root,
    reachedTill: overlays.reachedTill,
    denials: overlays.denials,
    closes: overlays.closes,
    screen: overlays.screen || lines.map((l) => l.text).join(' | ').slice(0, 400),
  };
}

/** Android: DB-only seed. Leaves the app at the setup gate — NOT a session. */
export async function seedMobileDbOnly() {
  const lib = await adbLib();
  await ensureAdbRoot();
  lib.pushBaseline();
  return { platform: 'android', seeded: 'db-only', note: 'requires first-run setup afterwards' };
}

/**
 * Android: complete the first-run wizard from scratch with the canonical
 * credentials. Use only when no provisioned snapshot exists.
 * Returns the OCR lines of the post-setup screen.
 */
export async function mobileFirstRunSetup(pin = MANAGER_PIN) {
  assertPinValid(pin);
  const lib = await adbLib();
  const { sleep, ocrScreen, tap, findLine, text } = lib;

  const dump = (tag) => {
    try {
      return ocrScreen(tag);
    } catch {
      return [];
    }
  };
  const flat = (lines) => lines.map((l) => l.text).join(' | ').slice(0, 600);
  const isSetup = (lines) => lines.some((l) => /Configuration initiale|Nom du g|PIN g|Enregistrer l.{0,3}quipe/i.test(l.text));
  const isTill = (lines) =>
    lines.some((l) => /Articles au Panier|CHIFFRE D.AFFAIRES|CAISSE PRINCIPALE/i.test(l.text));

  /** Scroll the setup form to its bottom edge: the PIN fields, the tactile
   *  keypad and the save button only coexist at that offset. Focusing a field
   *  scrolls it into view and can push the pad off-screen, so call this again
   *  after every tap. */
  const toBottom = () => {
    // Swipe in the RIGHT GUTTER (x≈1030, outside the form card). A swipe that
    // starts on the tactile keypad is captured by the pad buttons and the page
    // never moves — that is why earlier runs saw "no keypad" after a tap.
    for (let i = 0; i < 4; i += 1) {
      lib.shell('input swipe 1030 2000 1030 420 320');
      sleep(650);
    }
  };
  /** `input text` appends and this build pre-fills the name field with a
   *  default ("Sami (Gérant)"), so a bare `text()` yields
   *  "Sami (Gérant)E2E Gerant". Clear with select-all (API 31+) plus a
   *  backspace burst in ONE adb call (40 separate round-trips get dropped). */
  const clearField = () => {
    try {
      lib.shell('input keycombination 113 29'); // CTRL_LEFT + A
      sleep(150);
      lib.shell('input keyevent 67'); // delete the selection
    } catch {
      /* keycombination is API 31+; the burst below still clears the tail */
    }
    sleep(150);
    lib.shell(`input keyevent ${Array.from({ length: 40 }, () => 67).join(' ')}`);
    sleep(250);
  };
  const logPinRule = (digits, chosen) => {
    console.log(`[session] setup PIN rule: ${digits} digits -> using ${chosen}`);
  };

  lib.stopApp();
  lib.startApp();
  sleep(8000);

  // Clear the camera-permission dialog and the pairing wizard first — both
  // cover the setup gate on a fresh install.
  await dismissMobileOverlays(45000);

  let lines = dump('setup-detect');
  if (isTill(lines) && !isSetup(lines)) {
    return { platform: 'android', alreadyProvisioned: true, screen: flat(lines) };
  }
  if (!isSetup(lines)) {
    // One more pass: the gate may still be mounting.
    sleep(2500);
    lines = dump('setup-detect2');
  }
  if (!isSetup(lines)) {
    return { platform: 'android', alreadyProvisioned: false, completed: false, screen: flat(lines) };
  }
  // Name — tolerate OCR mojibake (é -> �) by matching the stable prefix.
  // Clear first: `input text` APPENDS, so without this the placeholder
  // ("Sami") is left in front of the typed value.
  const imeShown = () => /mInputShown=true/.test(lib.shell('dumpsys input_method') || '');
  const hideIme = () => {
    // Only press BACK when the soft keyboard is actually up: `input text`
    // does not open it, and a stray BACK on the setup gate exits the app.
    if (imeShown()) {
      lib.key(4);
      sleep(500);
    }
  };
  const nameLabel = findLine(lines, /NOM DU G/i);
  if (nameLabel) {
    tap(nameLabel.cx, nameLabel.cy + 100);
    sleep(600);
    clearField();
    text(MANAGER_NAME);
    sleep(400);
    hideIme();
  }

  // Bring the PIN fields, the tactile keypad and the save button on screen
  // TOGETHER (they fit at the bottom offset on 1080x2424). Coordinates read
  // from one dump then stay valid for the whole entry — scrolling between
  // the fields and the pad is what made earlier attempts tap the wrong row.
  toBottom();
  lines = dump('setup-bottom');

  // The PIN digit rule differs by build: current source says
  // "PIN gérant (6 chiffres minimum)", but older APKs ship "(4 CHIFFRES)".
  // Read the label and pick a PIN of the accepted length.
  const pinRule = lines.map((l) => l.text).join(' ').match(/PIN G[^)]*?(\d)\s*CHIFFRES/i);
  const wantDigits = pinRule ? Number(pinRule[1]) : PIN_MIN_DIGITS;
  const setupPin = pin.length === wantDigits ? pin : pin.slice(0, wantDigits).padEnd(wantDigits, '0');
  logPinRule(wantDigits, setupPin);
  // ── PIN entry ───────────────────────────────────────────────────────────
  // Two build variants exist and the helper must not assume either:
  //   * HEAD / desktop: a normal masked <input> — `input text` works.
  //   * the installed APK: the PIN fields are read-only and a "PAVÉ PIN
  //     TACTILE" keypad drives them ("Touchez un champ PIN, puis composez le
  //     code ici"). `input text` is silently ignored, and the four grey dots
  //     in an empty field are a PLACEHOLDER, not a value — Batch 26 read them
  //     as filled and then blamed the digit rule. Detect the pad, tap it.
  // The pad is a 3×4 grid laid out 1 2 3 / 4 5 6 / 7 8 9 / C 0 ⌫. OCR reliably
  // reads only the middle rows (it drops 1, 0 and ⌫), so NEVER key off the
  // detected labels: fit row→y and col→x from the digits that WERE read and
  // extrapolate the missing cells. That is why the earlier `keys.size >= 10`
  // gate silently fell back to `adb text` — which a read-only field ignores.
  // Grid fitting is shared with mobileLogin (module-level fitPadGrid).
  const gridFrom = fitPadGrid;

  /**
   * Fallback geometry for the 1080x2424 layout, as fractions of the screen.
   * Measured from logs/mob-shots/proof-setup-after.png at the bottom scroll
   * offset (key-box centres, not glyph centres). Used only when OCR misses the
   * pad entirely — a wrong grid cannot pass silently: the tool then finds no
   * manager_pin row and reports FAIL.
   */
  const gridFromScreen = () => {
    const m = String(lib.shell('wm size') || '').match(/(\d+)x(\d+)/);
    if (!m) return null;
    const W = Number(m[1]);
    const H = Number(m[2]);
    const colX = [0.2117, 0.4595, 0.7072].map((f) => Math.round(f * W));
    const rowY = [0.6538, 0.7214, 0.7891, 0.8567].map((f) => Math.round(f * H));
    return {
      seen: 'screen-fractions',
      source: 'geometry',
      key: (ch) => {
        if (/^[1-9]$/.test(ch)) {
          const d = Number(ch);
          return { cx: colX[(d - 1) % 3], cy: rowY[Math.floor((d - 1) / 3)] };
        }
        if (ch === 'C') return { cx: colX[0], cy: rowY[3] };
        if (ch === '0') return { cx: colX[1], cy: rowY[3] };
        if (ch === '⌫') return { cx: colX[2], cy: rowY[3] };
        return null;
      },
    };
  };

  /** Cashier name rows, located geometrically: between the "CAISSIERS (n)"
   *  header and the helper text / keypad caption. Relying on OCR block order
   *  is unsafe (it puts "+ Ajouter un caissier" after the names). */
  const cashierRows = () => {
    const l = dump('cashiers');
    const head = findLine(l, /CAISSIERS/i);
    if (!head) return [];
    const tail = findLine(l, /Chaque PIN|PAV/i);
    const yMax = tail ? tail.cy : head.cy + 700;
    return l
      .filter((x) => x.cy > head.cy + 20 && x.cy < yMax)
      .filter((x) => {
        const t = x.text.trim();
        return t.length >= 2 && !/^[o•·.]+$/.test(t) && !/Ajouter un caissier/i.test(t);
      })
      .slice(0, 9);
  };

  /** screencap occasionally lands on a blank/animating frame -> retry. */
  const padGrid = (seed) => {
    const g0 = seed ? gridFrom(seed) : null;
    if (g0) return g0;
    for (let i = 0; i < 3; i += 1) {
      const l = dump(`pin-pad-${i}`);
      const g = gridFrom(l);
      if (g) return g;
      console.log(`[session] pad scan ${i}: ${l.length} OCR lines, no usable grid`);
      sleep(700);
    }
    console.log('[session] pad scan: falling back to screen-fraction geometry');
    return gridFromScreen();
  };
  const enterPinViaPad = (grid, value, tag) => {
    const clr = grid.key('C');
    if (clr) {
      tap(clr.cx, clr.cy);
      sleep(260);
    }
    for (const ch of value) {
      const k = grid.key(ch);
      if (!k) {
        console.log(`[session] ${tag}: no grid cell for "${ch}"`);
        return false;
      }
      tap(k.cx, k.cy);
      sleep(280);
    }
    console.log(`[session] ${tag}: tapped ${value} on the pad (grid from ${grid.seen})`);
    return true;
  };

  // Field hit boxes: label baseline + 100 px lands inside the input for the
  // name, PIN and confirm rows (verified against the 1080x2424 setup shot).
  const pinLabel = findLine(lines, /PIN G/i);
  if (pinLabel) {
    tap(pinLabel.cx, pinLabel.cy + 100);
    sleep(800);
    toBottom(); // focusing the field scrolls it into view; bring the pad back
  }
  let grid = padGrid();
  const hasPad = Boolean(grid);
  console.log(
    `[session] PIN entry mode: ${hasPad ? `tactile keypad (grid via ${grid.source}, digits seen ${grid.seen})` : 'masked input (adb text)'}`,
  );
  if (hasPad) {
    enterPinViaPad(grid, setupPin, 'manager');
  } else {
    clearField();
    text(setupPin);
    sleep(400);
    hideIme();
  }

  // Confirm — tapping the confirm field moves the keypad target to it.
  lines = dump('setup-after-pin');
  const confirmLabel = findLine(lines, /CONFIRMER/i);
  if (confirmLabel) {
    tap(confirmLabel.cx, confirmLabel.cy + 100);
    sleep(800);
    toBottom();
  }
  if (hasPad) {
    // Re-fit: any auto-scroll moves the pad, and the caption changes.
    grid = padGrid(lines) ?? grid;
    enterPinViaPad(grid, setupPin, 'confirm');
  } else {
    clearField();
    text(setupPin);
    sleep(400);
    hideIme();
  }

  // ── Cashier PINs ────────────────────────────────────────────────────────
  // The form refuses to save while any cashier row is PIN-less:
  // "Code PIN à 4 chiffres requis pour Rachid." Each cashier PIN box sits to
  // the RIGHT of the name, on the same row (verified on the 1080x2424 shot).
  if (hasPad) {
    const wm = String(lib.shell('wm size') || '').match(/(\d+)x(\d+)/);
    const W = wm ? Number(wm[1]) : 1080;
    const rows = cashierRows();
    console.log(`[session] cashier rows: ${rows.map((r) => r.text.trim()).join(', ') || '(none)'}`);
    rows.forEach((row, i) => {
      const cashierPin = String(i + 1).repeat(Math.max(4, wantDigits));
      tap(Math.round(W * 0.627), row.cy);
      sleep(700);
      toBottom();
      const g = padGrid();
      if (!g) {
        console.log(`[session] cashier ${row.text.trim()}: no keypad, skipped`);
        return;
      }
      enterPinViaPad(g, cashierPin, `cashier ${row.text.trim()}`);
    });
  }

  // Submit — we are already at the bottom offset, so the button is on screen.
  hideIme();
  let save = null;
  for (let attempt = 0; attempt < 4 && !save; attempt += 1) {
    lines = dump(`setup-submit-${attempt}`);
    save = findLine(lines, /Enregistrer/i) || findLine(lines, /Terminer|Commencer|Valider|Continuer/i);
    if (!save) {
      lib.shell('input swipe 1030 2000 1030 500 320');
      sleep(1200);
    }
  }
  if (save) {
    tap(save.cx, save.cy);
    sleep(3000);
  }
  await dismissMobileOverlays(30000);
  lines = dump('setup-done');
  let completed = isTill(lines) && !isSetup(lines);
  let login = null;
  if (!completed && /code PIN/i.test(flat(lines))) {
    // Setup succeeded and the app dropped to the cashier lock screen. Finish
    // the flow the way an operator would, then prove the till is actually up.
    login = await mobileLogin(setupPin);
    completed = login.completed === true || login.alreadyUnlocked === true;
    lines = dump('setup-logged-in');
  }
  return {
    platform: 'android',
    alreadyProvisioned: false,
    completed,
    setupPin,
    setupPinDigits: wantDigits,
    login: login ? { completed: login.completed, pinUsed: login.pinUsed, error: login.error } : null,
    screen: flat(lines),
  };
}

/** Android: unlock from the cashier lock screen (account tiles + tactile
 *  keypad). The PIN digit rule is read from the screen ("code PIN � 4
 *  chiffres"), because this APK requires 4 while HEAD/desktop requires 6+. */
export async function mobileLogin(pin = MANAGER_PIN) {
  const lib = await adbLib();
  const { sleep, ocrScreen, tap, findLine } = lib;
  const dump = (t) => {
    try {
      return ocrScreen(t);
    } catch {
      return [];
    }
  };
  const flat = (l) => l.map((x) => x.text).join(" | ").slice(0, 500);
  const atTill = (l) => /Articles au Panier|CAISSE PRINCIPALE|CHIFFRE D.AFFAIRES/i.test(flat(l));

  let lines = dump("login-screen");
  if (atTill(lines)) return { platform: "android", alreadyUnlocked: true, screen: flat(lines) };

  // Multi-account lock screen: the manager tile must be the selected one.
  if (!/code PIN/i.test(flat(lines))) {
    const row = findLine(lines, /ADMIN/i) || findLine(lines, /E2E/i);
    if (row) {
      tap(row.cx, row.cy);
      sleep(1300);
      lines = dump("login-account");
    }
  }

  const wanted = pinForScreen(flat(lines), pin);
  let grid = fitPadGrid(lines);
  if (!grid) {
    sleep(800);
    lines = dump("login-pad");
    grid = fitPadGrid(lines);
  }
  if (!grid) {
    return { platform: "android", completed: false, error: "no tactile keypad found", screen: flat(lines) };
  }
  console.log(`[session] mobile login: tapping ${wanted.pin} (${wanted.digits} digits) on the pad, grid from ${grid.seen}`);
  for (const ch of wanted.pin) {
    const k = grid.key(ch);
    if (!k) break;
    tap(k.cx, k.cy);
    sleep(300);
  }
  sleep(3000);
  lines = dump("login-done");
  return {
    platform: "android",
    completed: atTill(lines),
    pinUsed: wanted.pin,
    screen: flat(lines),
  };
}

/* ───────────────────────────── EVIDENCE ────────────────────────────────── */

/**
 * Post-login proof that the session is real: a DB fact, not "no error seen".
 * Desktop callers pass a query fn and get a compact row-count summary back.
 *
 * @param {(sql: string) => any} runSql
 */
export function sessionEvidence(runSql) {
  return {
    products: runSql('SELECT COUNT(*) n FROM products')?.n ?? null,
    customers: runSql('SELECT COUNT(*) n FROM customers')?.n ?? null,
    openShift: runSql("SELECT COUNT(*) n FROM cash_sessions WHERE closed_at IS NULL")?.n ?? null,
  };
}

export const SESSION_README = `
# Session helper (lib/session.mjs)

Credentials: manager "${MANAGER_NAME}", PIN ${MANAGER_PIN} (6 digits, UI allows 6-8).

| Target  | Get a usable till                | Reset to clean state            |
|---------|----------------------------------|---------------------------------|
| Desktop | ensureDesktopSession()           | resetDesktopSession() / POS_E2E_WIPE=1 |
| Android | ensureMobileSession()            | ensureMobileSession() (re-restores snapshot) |

Never use a 4-digit PIN. Never rely on a DB-only Android restore: the manager
PIN lives in the WebView profile, not SQLite, so pushBaseline() leaves the app
at the first-run setup gate with an empty catalogue (the P1-67 artifact).
`.trim();

export default {
  MANAGER_NAME,
  MANAGER_PIN,
  PIN_MIN_DIGITS,
  PIN_MAX_DIGITS,
  assertPinValid,
  ensureDesktopSession,
  resetDesktopSession,
  ensureMobileSession,
  dismissMobileOverlays,
  seedMobileDbOnly,
  mobileFirstRunSetup,
  mobileLogin,
};

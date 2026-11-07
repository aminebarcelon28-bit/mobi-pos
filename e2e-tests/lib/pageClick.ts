/**
 * Page-context click wrapper that refuses to reach through a modal.
 *
 * `element.click()` inside `browser.execute` bypasses hit-testing; a tile
 * behind the payment dialog therefore activates. This wrapper probes the same
 * geometry the browser would use (displayed twin, `elementFromPoint` at its
 * centre, visible blocking dialogs), asks the pure rule in `clickGuard.ts`, and
 * only then clicks — returning (or throwing) a typed refusal instead of firing
 * behind the modal.
 *
 * The probe and click bodies are RAW STRINGS on purpose: a transpiled function
 * body gets `__name(...)` helper calls injected for named inner closures, and
 * the injected page context has no such helper (that defect broke six MNY
 * cases in the sweep-F census).
 */
import { browser, $$ } from '@wdio/globals';
import {
  clickGuardDecision,
  ClickRefusedError,
  describeClickDecision,
  type ClickDecision,
  type ClickGuardOptions,
  type ClickProbe,
} from './clickGuard';

/** Read-only probe: no clicks, no statements with side effects. */
const PROBE_SCRIPT = `
var el = arguments[0] || null;
var wanted = arguments[1] || null;
function visible(n) {
  try {
    if (!n) return false;
    var cs = getComputedStyle(n);
    if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
    var r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  } catch (e) { return false; }
}
function dialogOf(n) {
  try {
    if (!n || !n.closest) return null;
    var d = n.closest('[role="dialog"],[data-testid$="dialog"],[data-testid$="-overlay"]');
    if (!d || !visible(d)) return null;
    return d.getAttribute('data-testid') || d.getAttribute('aria-label') || d.getAttribute('role') || d.tagName;
  } catch (e) { return null; }
}
function rectOf(n) {
  try {
    var r = n.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  } catch (e) { return null; }
}
function describe(n) {
  if (!n) {
    return { found: false, tag: '', testid: null, aria: null, role: null, disabled: false, displayed: false, rect: null, dialog: null };
  }
  return {
    found: true,
    tag: n.tagName || '',
    testid: n.getAttribute ? n.getAttribute('data-testid') : null,
    aria: n.getAttribute ? n.getAttribute('aria-label') : null,
    role: n.getAttribute ? n.getAttribute('role') : null,
    disabled: n.disabled === true,
    displayed: visible(n),
    rect: rectOf(n),
    dialog: dialogOf(n)
  };
}
var target = el;
if (!target && wanted) {
  var twins = Array.prototype.slice.call(document.querySelectorAll('[data-testid="' + wanted + '"]'));
  for (var i = 0; i < twins.length; i++) {
    if (visible(twins[i]) && twins[i].disabled !== true) { target = twins[i]; break; }
  }
}
var out = { target: describe(target), hit: null, dialogs: [] };
if (!target) return out;
var tr = target.getBoundingClientRect();
out.hit = describe(document.elementFromPoint(Math.round(tr.x + tr.width / 2), Math.round(tr.y + tr.height / 2)));
var roots = Array.prototype.slice.call(
  document.querySelectorAll('[role="dialog"],[data-testid$="dialog"],[data-testid$="-overlay"]')
);
for (var j = 0; j < roots.length; j++) {
  var d = roots[j];
  if (!visible(d)) continue;
  out.dialogs.push({
    name: d.getAttribute('data-testid') || d.getAttribute('aria-label') || d.getAttribute('role') || d.tagName,
    rect: rectOf(d)
  });
}
return out;
`;

/** Click the displayed, enabled twin by testid (the same twin the probe saw). */
const CLICK_TESTID_SCRIPT = `
var wanted = arguments[0] || null;
var twins = Array.prototype.slice.call(document.querySelectorAll('[data-testid="' + wanted + '"]'));
for (var i = 0; i < twins.length; i++) {
  var n = twins[i];
  if (n.disabled === true) continue;
  var cs = getComputedStyle(n);
  if (!cs || cs.display === 'none' || cs.visibility === 'hidden') continue;
  var r = n.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) continue;
  n.click();
  return true;
}
return false;
`;

const CLICK_ELEMENT_SCRIPT = `
var el = arguments[0] || null;
if (!el) return false;
el.click();
return true;
`;

export interface PageClickOptions extends ClickGuardOptions {
  /** Throw `ClickRefusedError` instead of returning the refusal (default true). */
  throwOnRefusal?: boolean;
  /** Log line tag, e.g. the helper name. */
  label?: string;
}

async function probe(target: unknown | null, testid: string | null): Promise<ClickProbe> {
  return (await browser.execute(PROBE_SCRIPT, target, testid)) as ClickProbe;
}

async function decideAndClick(
  got: ClickProbe,
  click: () => Promise<boolean>,
  options: PageClickOptions,
): Promise<ClickDecision> {
  const decision = clickGuardDecision(got, { allowBehindDialog: options.allowBehindDialog });
  const label = options.label ?? 'pageClick';
  if (!decision.allow) {
    console.log(`[${label}] refused: ${describeClickDecision(decision)}`);
    if (options.throwOnRefusal !== false) throw new ClickRefusedError(decision);
    return decision;
  }
  const clicked = await click();
  if (!clicked) {
    const lost: ClickDecision = {
      allow: false,
      refusal: 'NO_TARGET',
      detail: 'target vanished between the probe and the click',
    };
    console.log(`[${label}] refused: ${describeClickDecision(lost)}`);
    if (options.throwOnRefusal !== false) throw new ClickRefusedError(lost);
    return lost;
  }
  await browser.pause(120);
  return decision;
}

/**
 * Click a `data-testid` control, refusing when a visible blocking dialog covers
 * it. Throws `ClickRefusedError` by default so a refusal can never be mistaken
 * for a successful click.
 */
export async function pageClick(
  testid: string,
  options: PageClickOptions = {},
): Promise<ClickDecision> {
  const got = await probe(null, testid);
  return decideAndClick(
    got,
    async () => (await browser.execute(CLICK_TESTID_SCRIPT, testid)) as boolean,
    { label: options.label ?? `pageClick:${testid}`, ...options },
  );
}

/** Same rule, for an element handle the caller already resolved. */
export async function pageClickElement(
  element: unknown,
  options: PageClickOptions = {},
): Promise<ClickDecision> {
  const got = await probe(element, null);
  return decideAndClick(
    got,
    async () => (await browser.execute(CLICK_ELEMENT_SCRIPT, element)) as boolean,
    { label: options.label ?? 'pageClickElement', ...options },
  );
}

/** Probe only — lets a caller log or assert the geometry without clicking. */
export async function probeClick(
  options: { testid?: string; element?: unknown } = {},
): Promise<ClickProbe> {
  return probe(options.element ?? null, options.testid ?? null);
}

/** Quote a string for an XPath literal (single, double, or concat). */
function xpathLiteral(value: string): string {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return `concat(${value
    .split('"')
    .map((part, i) => (i === 0 ? `"${part}"` : `'"', "${part}"`))
    .join(', ')})`;
}

/**
 * Click the first DISPLAYED element matching a CSS/XPath selector through the
 * guard. Used where the control has no testid (title/text-driven SAV buttons).
 */
export async function pageClickSelector(
  selector: string,
  options: PageClickOptions = {},
): Promise<ClickDecision> {
  const all = await $$(selector);
  for (const el of all) {
    if (!(await el.isDisplayed().catch(() => false))) continue;
    return pageClickElement(el, { label: options.label ?? `pageClickSelector:${selector.slice(0, 60)}`, ...options });
  }
  const missing: ClickDecision = {
    allow: false,
    refusal: 'NO_TARGET',
    detail: `selector ${selector.slice(0, 120)} matched no displayed element`,
  };
  if (options.throwOnRefusal !== false) throw new ClickRefusedError(missing);
  return missing;
}

/** Click a button by its `title` attribute (SAV header buttons). */
export async function pageClickByTitle(
  title: string,
  options: PageClickOptions = {},
): Promise<ClickDecision> {
  return pageClickSelector(`//button[@title=${xpathLiteral(title)}]`, {
    label: options.label ?? `pageClickByTitle:${title.slice(0, 32)}`,
    ...options,
  });
}

/** Click the first displayed button whose text contains `text`. */
export async function pageClickByText(
  text: string,
  options: PageClickOptions = {},
): Promise<ClickDecision> {
  return pageClickSelector(`//button[contains(normalize-space(.), ${xpathLiteral(text)})]`, {
    label: options.label ?? `pageClickByText:${text.slice(0, 32)}`,
    ...options,
  });
}

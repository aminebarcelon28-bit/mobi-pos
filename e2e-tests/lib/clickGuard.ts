/**
 * Page-click guard — the decision layer for the CRT-15 defect class.
 *
 * A page-context `element.click()` bypasses hit-testing: it dispatches straight
 * to the handler, so a control *behind* an open modal is activated as if the
 * user had reached through it. The native WebDriver click does not do that
 * (it is refused with "element click intercepted"), which is why the fallback
 * existed in the first place — but the fallback must not defeat the very modal
 * the spec is testing.
 *
 * This module is pure (no WebDriver, no DOM): the probe in `pageClick.ts`
 * gathers the facts, and `clickGuardDecision` decides. Keeping it pure is what
 * makes the rule unit-testable without a running app (CRT-15's regression pin
 * runs against the rule, the E2E case pins the wiring).
 */

export interface ClickRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ClickElement {
  found: boolean;
  tag: string;
  testid: string | null;
  aria: string | null;
  role: string | null;
  disabled: boolean;
  displayed: boolean;
  rect: ClickRect | null;
  /**
   * Name (data-testid / aria-label / role / tag) of the nearest visible
   * blocking-dialog container the element sits INSIDE, or null. A control
   * inside the modal is the modal's own control and is always clickable.
   */
  dialog: string | null;
}

export interface BlockingDialog {
  name: string;
  rect: ClickRect;
}

export interface ClickProbe {
  target: ClickElement;
  /** `document.elementFromPoint` at the target centre (null when no target). */
  hit: ClickElement | null;
  /** Every visible blocking dialog on screen, outermost first. */
  dialogs: BlockingDialog[];
}

export type ClickRefusal =
  | 'NO_TARGET'
  | 'TARGET_HIDDEN'
  | 'TARGET_DISABLED'
  | 'BLOCKED_BY_DIALOG';

export interface ClickDecision {
  allow: boolean;
  refusal?: ClickRefusal;
  /** The dialog that owns the click point, when refusal is BLOCKED_BY_DIALOG. */
  dialog?: string;
  detail: string;
}

export interface ClickGuardOptions {
  /**
   * Opt out of the dialog rule. Reserved for a spec that deliberately probes
   * behind-modal behaviour and asserts the refusal itself; never a default.
   */
  allowBehindDialog?: boolean;
}

export const NO_ELEMENT: ClickElement = {
  found: false,
  tag: '',
  testid: null,
  aria: null,
  role: null,
  disabled: false,
  displayed: false,
  rect: null,
  dialog: null,
};

function name(e: ClickElement): string {
  return e.testid ?? e.aria ?? e.role ?? e.tag ?? '?';
}

/**
 * Decide whether a page-context click may fire.
 *
 * Order matters: an absent/hidden/disabled target is a different failure from a
 * blocked one, and both must stay distinguishable in the log — a middleware
 * "did not become interactable" timeout is what this whole class looked like
 * before the guard existed.
 */
export function clickGuardDecision(
  probe: ClickProbe,
  options: ClickGuardOptions = {},
): ClickDecision {
  const target = probe.target ?? NO_ELEMENT;
  if (!target.found) {
    return { allow: false, refusal: 'NO_TARGET', detail: 'no displayed target element' };
  }
  if (!target.displayed) {
    return {
      allow: false,
      refusal: 'TARGET_HIDDEN',
      detail: `target ${name(target)} is in the DOM but not displayed`,
    };
  }
  if (target.disabled) {
    return {
      allow: false,
      refusal: 'TARGET_DISABLED',
      detail: `target ${name(target)} is disabled`,
    };
  }
  if (options.allowBehindDialog) {
    return { allow: true, detail: 'allowBehindDialog: dialog rule not applied' };
  }

  // The element that actually receives the click at the target's centre. When
  // it belongs to a dialog the target does not (including a second, stacked
  // modal on top of the target's own dialog), the click would reach through it.
  const hit = probe.hit;
  if (hit && hit.found && hit.dialog && hit.dialog !== target.dialog) {
    return {
      allow: false,
      refusal: 'BLOCKED_BY_DIALOG',
      dialog: hit.dialog,
      detail: `centre is covered by dialog ${hit.dialog}, target ${name(target)} is behind it`,
    };
  }

  // A control inside a modal belongs to that modal: clicking it is the flow.
  if (target.dialog) {
    return { allow: true, detail: `target is inside dialog ${target.dialog}` };
  }

  // Fallback for the case where the pointer lands on the document root (a
  // modal backdrop with pointer-events:none): a visible foreign dialog still
  // swallows the click. When the hit point is a real element — including an
  // overlay ABOVE the dialog, such as the lock screen — the hit test in the
  // previous branch already decided, so the list must not veto it.
  const hitIsRoot = !hit || !hit.found || /^(BODY|HTML)$/i.test(hit.tag);
  const foreign = (probe.dialogs ?? []).find((d) => d.name !== target.dialog);
  if (hitIsRoot && foreign) {
    return {
      allow: false,
      refusal: 'BLOCKED_BY_DIALOG',
      dialog: foreign.name,
      detail: `dialog ${foreign.name} is visible and the click point is the document root`,
    };
  }

  return { allow: true, detail: 'no blocking dialog over the target' };
}

/** One-line human form, used by the callers' logs. */
export function describeClickDecision(decision: ClickDecision): string {
  if (decision.allow) return `allow (${decision.detail})`;
  return `refuse ${decision.refusal}${decision.dialog ? ` via ${decision.dialog}` : ''} (${decision.detail})`;
}

/** Error type thrown by the E2E wrapper so a refusal is never a silent no-op. */
export class ClickRefusedError extends Error {
  readonly refusal: ClickRefusal;
  readonly dialog?: string;
  constructor(decision: ClickDecision) {
    super(
      `PAGE_CLICK_REFUSED:${decision.refusal ?? 'UNKNOWN'}` +
        `${decision.dialog ? `:${decision.dialog}` : ''} — ${decision.detail}`,
    );
    this.name = 'ClickRefusedError';
    this.refusal = (decision.refusal ?? 'NO_TARGET') as ClickRefusal;
    this.dialog = decision.dialog;
  }
}

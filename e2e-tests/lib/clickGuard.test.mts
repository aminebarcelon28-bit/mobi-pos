/**
 * Pins for the page-click guard (CRT-15 regression class).
 *
 * The rule under test is what stops `findTile`'s JS fallback from activating a
 * product tile behind an open payment dialog. These cases are the rule table:
 * no target, hidden, disabled, clear, blocked, modal-internal, backdrop-only,
 * and each opt-out.
 *
 * Run: node --import ./scripts/ts-resolve-hook.mjs \
 *   --experimental-strip-types e2e-tests/lib/clickGuard.test.mts
 */
import assert from 'node:assert';
import {
  clickGuardDecision,
  describeClickDecision,
  ClickRefusedError,
  NO_ELEMENT,
  type ClickElement,
  type ClickProbe,
} from './clickGuard';

let n = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  n++;
  assert.strictEqual(String(a), String(b), msg);
};

const el = (patch: Partial<ClickElement> = {}): ClickElement => ({
  ...NO_ELEMENT,
  found: true,
  tag: 'BUTTON',
  testid: 'target',
  displayed: true,
  rect: { x: 10, y: 10, w: 100, h: 40 },
  ...patch,
});

const probe = (patch: Partial<ClickProbe> = {}): ClickProbe => ({
  target: el(),
  hit: el({ testid: 'target' }),
  dialogs: [],
  ...patch,
});

const payDialog = { name: 'pay-dialog', rect: { x: 0, y: 0, w: 800, h: 600 } };

// 1. Absent target is its own refusal, not a silent click.
eq(clickGuardDecision(probe({ target: NO_ELEMENT })).refusal, 'NO_TARGET', 'absent target');
// 2. Present but not displayed.
eq(
  clickGuardDecision(probe({ target: el({ displayed: false }) })).refusal,
  'TARGET_HIDDEN',
  'hidden target',
);
// 3. Displayed but disabled.
eq(
  clickGuardDecision(probe({ target: el({ disabled: true }) })).refusal,
  'TARGET_DISABLED',
  'disabled target',
);
// 4. Nothing in the way: the ordinary case must stay a click.
eq(clickGuardDecision(probe()).allow, true, 'clear target is allowed');

// 5. THE CRT-15 CASE: the tile is displayed, the pay dialog owns its centre.
eq(
  clickGuardDecision(
    probe({ hit: el({ testid: 'pay-dialog', dialog: 'pay-dialog' }), dialogs: [payDialog] }),
  ).refusal,
  'BLOCKED_BY_DIALOG',
  'click behind the pay dialog is refused',
);
eq(
  clickGuardDecision(
    probe({ hit: el({ testid: 'pay-dialog', dialog: 'pay-dialog' }), dialogs: [payDialog] }),
  ).dialog,
  'pay-dialog',
  'refusal names the blocking dialog',
);

// 6. A control belonging to the dialog is the flow, never the defect.
eq(
  clickGuardDecision(
    probe({
      target: el({ testid: 'pay-confirm', dialog: 'pay-dialog' }),
      hit: el({ testid: 'pay-confirm', dialog: 'pay-dialog' }),
      dialogs: [payDialog],
    }),
  ).allow,
  true,
  'modal-internal control is allowed',
);

// 7. Backdrop-only case: elementFromPoint reports the body (backdrop has
//    pointer-events:none) but a dialog is visible and does not contain the
//    target. The pointer would still be swallowed by the modal.
eq(
  clickGuardDecision(
    probe({ hit: el({ tag: 'BODY', testid: null }), dialogs: [payDialog] }),
  ).refusal,
  'BLOCKED_BY_DIALOG',
  'visible foreign dialog blocks when the click point is the document root',
);

// 7b. An overlay ABOVE a lingering dialog (lock screen over a mid-sale pay
//     dialog) is reachable: the hit test names a real element outside the
//     dialog, so the dialog list must not veto the click.
eq(
  clickGuardDecision(
    probe({
      target: el({ testid: 'lock-profile-usr-admin' }),
      hit: el({ testid: 'lock-profile-usr-admin' }),
      dialogs: [payDialog],
    }),
  ).allow,
  true,
  'lock-screen click is not blocked by a dialog beneath it',
);

// 7c. An element outside the viewport has no hit point at all
//     (elementFromPoint(centre) is null). The harness clicks those in page
//     context on purpose (login-submit below the fold on a short window), so a
//     dialog visible elsewhere on the page must not veto them.
eq(
  clickGuardDecision(
    probe({
      target: el({ testid: 'login-submit' }),
      hit: { ...NO_ELEMENT },
      dialogs: [payDialog],
    }),
  ).allow,
  true,
  'off-viewport target is not blocked by a dialog elsewhere on the page',
);

// 8. Two dialogs: a target inside A is still blocked by B.
eq(
  clickGuardDecision(
    probe({
      target: el({ testid: 'refund-submit', dialog: 'refund-dialog' }),
      hit: el({ testid: 'appointment-dialog', dialog: 'appointment-dialog' }),
      dialogs: [{ name: 'refund-dialog', rect: { x: 0, y: 0, w: 10, h: 10 } }, { name: 'appointment-dialog', rect: { x: 0, y: 0, w: 20, h: 20 } }],
    }),
  ).refusal,
  'BLOCKED_BY_DIALOG',
  'a second dialog still blocks a target inside the first',
);

// 9. Opt-out is explicit and remains available for behind-modal probes.
eq(
  clickGuardDecision(
    probe({ hit: el({ dialog: 'pay-dialog' }), dialogs: [payDialog] }),
    { allowBehindDialog: true },
  ).allow,
  true,
  'allowBehindDialog opts out',
);

// 10. A refusal is never a silent no-op: the wrapper error carries the reason.
const err = new ClickRefusedError(
  clickGuardDecision(
    probe({ hit: el({ dialog: 'pay-dialog' }), dialogs: [payDialog] }),
  ),
);
eq(err.refusal, 'BLOCKED_BY_DIALOG', 'error carries the refusal kind');
eq(err.dialog, 'pay-dialog', 'error carries the dialog');
eq(err.message.startsWith('PAGE_CLICK_REFUSED:BLOCKED_BY_DIALOG:pay-dialog'), true, 'error message is typed');

// 11. Log form names the cause (the old bug produced a 20 s middleware timeout
//     with no cause at all).
eq(
  describeClickDecision(
    clickGuardDecision(
      probe({ hit: el({ dialog: 'pay-dialog' }), dialogs: [payDialog] }),
    ),
  ).includes('BLOCKED_BY_DIALOG'),
  true,
  'describe names the refusal',
);

console.log(`clickGuard: ${n}/${n} checks passed`);

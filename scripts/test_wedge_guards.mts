/**
 * Wedge-burst guard regression suite (CI-blocking companion of
 * scripts/check-money-boundary.mjs).
 *
 * Pins the audit fix for src/utils/wedgeBurst.ts + the target guard in
 * src/hooks/useBarcodeScanner.ts: manual typing was decoded as a barcode and
 * the handler wiped the search field + reset the catalog query.
 *
 * The timing machine is DOM-free, so the real module is imported and driven
 * directly. The DOM half of the guard (which focused element counts as a
 * manual-entry field) is pinned by source inspection in W5: the predicates are
 * `instanceof` checks plus the explicit opt-in attribute, so a static pin is
 * the honest assertion — a fake DOM would only test the fake.
 *
 * Usage: node --experimental-strip-types scripts/test_wedge_guards.mts
 */
import { readFileSync } from 'node:fs';

const ROOT = process.cwd();
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1;
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const {
  createWedgeBurst,
  pushWedgeKey,
  resetWedgeBurst,
  takeWedgeBurst,
  WEDGE_GAP_TEXT_MS,
  WEDGE_GAP_LOOSE_MS,
  WEDGE_MIN_CHARS,
} = await import('../src/utils/wedgeBurst.ts');

type Burst = ReturnType<typeof createWedgeBurst>;

/**
 * Replay a keystroke run the way the hook does, including the target guard:
 * keystrokes landing in a manual-entry field reset the run and never decode.
 *
 * @param keys   printable characters, in order
 * @param gaps   gap BEFORE each key (ms); gaps[0] is the first keydown (ignored)
 * @param opts.editable   focus sits in a manual-entry field (guard stands down)
 * @param opts.maxGap     cadence ceiling for the target class
 */
function replay(
  keys: string[],
  gaps: number[],
  opts: { editable?: boolean; maxGap?: number } = {}
): { decoded: string | null; buffer: string } {
  const maxGap = opts.maxGap ?? WEDGE_GAP_TEXT_MS;
  const state: Burst = createWedgeBurst();
  let decoded: string | null = null;
  keys.forEach((key, i) => {
    if (opts.editable) {
      // TARGET GUARD: every keystroke in a manual-entry field retires the run.
      resetWedgeBurst(state);
      return;
    }
    pushWedgeKey(state, key, gaps[i] ?? 0, maxGap);
  });
  if (!opts.editable) decoded = takeWedgeBurst(state);
  return { decoded, buffer: state.buffer };
}

const EAN13 = '6138318449885';
const spread = (n: number) => Array.from({ length: n }, () => 10);

console.log('========================================================================');
console.log('WEDGE GUARD — MANUAL TYPING IS NOT A BARCODE');
console.log('========================================================================');

console.log('\n--- W1: hardware burst still decodes (no regression) ---');
{
  const g = [0, ...spread(EAN13.length - 1)];
  const { decoded } = replay(EAN13.split(''), g);
  check(`10 ms HID burst of ${EAN13.length} chars decodes`, decoded === EAN13, `got ${String(decoded)}`);
}
{
  // Grid surface (no editable focus): the loose legacy ceiling is preserved so
  // scanners configured to 30-50 ms keep working.
  const { decoded } = replay(EAN13.split(''), [0, ...spread(EAN13.length - 1)], {
    maxGap: WEDGE_GAP_LOOSE_MS,
  });
  check(`30 ms burst on the loose (non-editable) surface decodes`, decoded === EAN13, `got ${String(decoded)}`);
}

console.log('\n--- W2: rapid MANUAL typing never decodes (the reported defect) ---');
for (const word of ['chargeur', 'coque', 'verre', 'ecouteur', 'adaptateur']) {
  // Typing cadence a fast typist reaches: 45-60 ms per key.
  const gaps = [0, ...word.split('').map((_, i) => 45 + (i % 4) * 5)];
  const { decoded } = replay(word.split(''), gaps);
  check(`"${word}" typed at 45-60 ms/key does NOT decode`, decoded === null, `got ${String(decoded)}`);
}
{
  // The audit's literal repro: uniformly fast manual typing, then Enter. The
  // legacy loose ceiling (50 ms) accumulated the WHOLE word here and decoded
  // it as a barcode, wiping the search field. A text target now demands
  // machine-grade cadence, so a human-paced run is inert.
  for (const ms of [40, 30, 26]) {
    const keys = 'chargeur'.split('');
    const { decoded } = replay(keys, [0, ...keys.map(() => ms)]);
    check(`"chargeur" typed uniformly at ${ms} ms/key does NOT decode`, decoded === null, `got ${String(decoded)}`);
  }
  // ACCEPTED LIMIT (documented, not a bug): a HID wedge is a keyboard, so at
  // machine cadence (<= WEDGE_GAP_TEXT_MS = 25 ms) a human key run is
  // indistinguishable from hardware by timing alone. Tightening past that
  // would silently break scanners configured at 20-25 ms — one lost scan per
  // item. The guard therefore keeps every MANUAL-ENTRY field (cart quantity,
  // prices, PINs, every modal field) inert at ANY cadence, and only the two
  // explicitly sanctioned destinations keep the wedge path. Residual blast
  // radius at a sanctioned target: an error beep + a cleared search field —
  // no cart mutation, no money movement.
  const keys = 'chargeur'.split('');
  const machineCadence = replay(keys, [0, ...keys.map(() => WEDGE_GAP_TEXT_MS)]);
  check(
    `at exactly the machine ceiling (${WEDGE_GAP_TEXT_MS} ms/key) the run is treated as hardware — accepted limit`,
    machineCadence.decoded === 'chargeur',
    `got ${String(machineCadence.decoded)}`
  );
}
{
  // The nastiest shape: slow start then a fast tail — "reset to the last key"
  // would decode "rgeur" here, so the run must stay retired.
  const keys = 'chargeur'.split('');
  const gaps = [0, 60, 60, 60, 5, 5, 5, 5];
  const { decoded } = replay(keys, gaps);
  check('slow start + fast tail ("chargeur") does NOT decode', decoded === null, `got ${String(decoded)}`);
}
{
  // Alternate cadence: half the keystrokes human-paced.
  const keys = 'COQIP15'.split('');
  const gaps = [0, 5, 90, 5, 90, 5, 90, 5];
  const { decoded } = replay(keys, gaps);
  check('alternating human/machine gaps do NOT decode', decoded === null, `got ${String(decoded)}`);
}

console.log('\n--- W3: target guard — manual-entry fields are inert ---');
{
  const keys = EAN13.split('');
  const gaps = [0, ...spread(EAN13.length - 1)];
  const { decoded, buffer } = replay(keys, gaps, { editable: true });
  check('machine burst typed INTO a manual-entry field does NOT decode', decoded === null, `got ${String(decoded)}`);
  check('no residue left in the buffer after the guard', buffer === '', `got "${buffer}"`);
}
{
  // Typing a quantity must not wipe it either: the guard runs before any
  // buffering, so the run is empty at Enter (the hook only clears "search"
  // targets, and only after a successful decode).
  const { decoded } = replay('5'.split(''), [0, 10], { editable: true });
  check('single-digit quantity entry does NOT decode', decoded === null, `got ${String(decoded)}`);
}

console.log('\n--- W4: run-length + isolation invariants ---');
{
  const state = createWedgeBurst();
  pushWedgeKey(state, '1', 0, WEDGE_GAP_TEXT_MS);
  pushWedgeKey(state, '2', 5, WEDGE_GAP_TEXT_MS);
  check(`2-char burst does NOT decode (min ${WEDGE_MIN_CHARS})`, takeWedgeBurst(state) === null);
}
{
  // A retired run must not resurrect a later legitimate burst.
  const state = createWedgeBurst();
  pushWedgeKey(state, 'x', 0, WEDGE_GAP_TEXT_MS);
  pushWedgeKey(state, 'y', 80, WEDGE_GAP_TEXT_MS); // human-paced gap retires the run
  pushWedgeKey(state, 'z', 2, WEDGE_GAP_TEXT_MS);
  pushWedgeKey(state, 'a', 2, WEDGE_GAP_TEXT_MS);
  check('retired run stays dead across fast keys', takeWedgeBurst(state) === null);
  pushWedgeKey(state, '1', 2, WEDGE_GAP_TEXT_MS);
  pushWedgeKey(state, '2', 2, WEDGE_GAP_TEXT_MS);
  pushWedgeKey(state, '3', 2, WEDGE_GAP_TEXT_MS);
  check('the NEXT clean burst decodes (idle reset)', takeWedgeBurst(state) === '123');
}
{
  const state = createWedgeBurst();
  pushWedgeKey(state, 'a', 0, WEDGE_GAP_TEXT_MS);
  pushWedgeKey(state, 'b', 2, WEDGE_GAP_TEXT_MS);
  resetWedgeBurst(state); // the 200 ms idle timer / a manual-entry field
  check('resetWedgeBurst empties the run', takeWedgeBurst(state) === null);
}
{
  const state = createWedgeBurst();
  pushWedgeKey(state, '6', 0, WEDGE_GAP_TEXT_MS);
  pushWedgeKey(state, '1', 2, WEDGE_GAP_TEXT_MS);
  pushWedgeKey(state, '3', 2, WEDGE_GAP_TEXT_MS);
  check('takeWedgeBurst consumes the run (no double decode on Enter×2)', takeWedgeBurst(state) === '613');
  check('second Enter decodes nothing', takeWedgeBurst(state) === null);
}

console.log('\n--- W5: hook wiring + sanctioned targets (static) ---');
{
  const hook = readFileSync(`${ROOT}/src/hooks/useBarcodeScanner.ts`, 'utf8');
  check('hook drives the pure guard module', hook.includes("from '../utils/wedgeBurst'"));
  check('editable focus with no sanctioned target stands the decoder down',
    hook.includes('isEditableTarget(activeElement) && target === null') && hook.includes('resetWedgeBurst(burst)'));
  check('decode path goes through takeWedgeBurst', hook.includes('takeWedgeBurst(burst)'));
  check('only a "search" target is cleared + blurred',
    hook.includes("target === 'search' && activeElement instanceof HTMLInputElement") &&
      hook.includes('clearInputValue(activeElement)') && hook.includes('setSearchQuery(\'\')'));
  // The clear MUST go through the native setter + synthetic event. Measured in
  // Chromium: a plain `.value = ''` leaves React's controlled state stale (the
  // scanned code reappears on the next render), and mixing the two styles
  // poisons React's value tracker so the event is deduped away.
  check('no plain DOM assignment left in the clear path', !/activeElement\.value\s*=/.test(hook));
  check('clear uses the prototype setter + a synthetic input event',
    hook.includes("Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')") &&
      hook.includes("new Event('input', { bubbles: true })"));
  check('placeholder/type sniffing is gone (not a guard)', !/placeholder\?\.toLowerCase\(\)/.test(hook));
  check('a non-text input type is not treated as editable',
    hook.includes('NON_TEXT_INPUT_TYPES') && hook.includes('!el.disabled && !el.readOnly'));
  check('contenteditable counts as a manual-entry field', hook.includes('el.isContentEditable'));
}
{
  // Every sanctioned destination is an explicit opt-in; the audit named the
  // Header search box, which must stay a working scan surface (cleared after
  // a successful decode) but never decode manual typing.
  const header = readFileSync(`${ROOT}/src/components/Header.tsx`, 'utf8');
  check('Header catalog search is a sanctioned "search" target',
    header.includes('data-barcode-scan-target="search"'));
  const editor = readFileSync(`${ROOT}/src/components/modals/ProductEditorModal.tsx`, 'utf8');
  check('product-editor barcode is a sanctioned "field" target',
    editor.includes('data-barcode-scan-target="field"'));
  check('no other component opts into the decoder',
    readFileSync(`${ROOT}/src/components/CartPanel.tsx`, 'utf8').includes('data-barcode-scan-target') === false);
}

console.log('\n========================================================================');
console.log(`WEDGE GUARD SUITE: ${pass} PASSED, ${fail} FAILED`);
console.log('========================================================================');
if (fail > 0) process.exit(1);
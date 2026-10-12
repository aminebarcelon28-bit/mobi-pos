/**
 * Wedge-burst guard — the PURE half of the USB HID barcode decoder used by
 * `useBarcodeScanner`. No DOM, no React, no store: a small state machine that
 * decides whether a run of keystrokes is a hardware burst or a human typing.
 *
 * Why it exists (audit finding): manual typing under ~60 ms/key followed by
 * Enter was decoded as a barcode. The handler then added whatever it "read",
 * wiped the search field and reset the catalog query, so a cashier typing
 * "chargeur" lost the search they were building.
 *
 * TWO discriminators, both required before a run may decode:
 *
 * 1. TARGET GUARD (in the hook — it needs the DOM): a run is never assembled
 *    from keystrokes aimed at a manual-entry field. `resetWedgeBurst` is called
 *    for every keystroke landing in an editable element that is not an
 *    explicitly sanctioned scan destination.
 *
 * 2. MACHINE-GRADE TIMING (here): a run must be machine-speed end to end. A
 *    HID wedge types at 1-20 ms; the fastest sustained human run is far above
 *    that. A run is permanently retired the instant one gap exceeds the
 *    threshold — a slow start followed by a fast tail ("chargeur" at 60 ms then
 *    20 ms) can never assemble a code, which a "reset to the last key" rule
 *    could not distinguish.
 *
 * Sanctioned destinations opt in with `data-barcode-scan-target`:
 *   "search" — decoded AND cleared afterwards (Header catalog search: the grid
 *              must not stay filtered by a scanned code).
 *   "field"  — decoded only; the component owns its value (product editor
 *              barcode, filled from the scan event).
 * An explicit opt-in list keeps the guard from drifting onto a field that
 * merely looks like a search box (placeholder sniffing is not a guard).
 */

export type ScanTarget = 'search' | 'field' | null;

/** Machine-grade inter-key gap for a run aimed at a sanctioned text target.
 *  A HID wedge types at 1-20 ms; the fastest sustained human run is well above
 *  this. ACCEPTED LIMIT: a wedge IS a keyboard, so a manual run at <= 25 ms is
 *  indistinguishable from hardware by timing alone. Tightening further would
 *  silently break scanners configured at 20-25 ms — one lost scan per item —
 *  so the defence in depth is the target guard: every manual-entry field
 *  (quantity, prices, PINs, modal fields) is inert at ANY cadence, and only
 *  explicitly sanctioned destinations keep the wedge path. */
export const WEDGE_GAP_TEXT_MS = 25;
/**
 * Loose gap for runs with no editable focus (grid / row shortcut surface):
 * unchanged from the legacy rule, so scanners configured to 30-50 ms keep
 * working there. The manual-typing false positive this introduces is only
 * reachable on a NON-editable surface, where no text entry is being destroyed.
 */
export const WEDGE_GAP_LOOSE_MS = 50;
/** Shortest decodable run — a 1-2 keypress is never a barcode. */
export const WEDGE_MIN_CHARS = 3;
/** Idle gap after which an in-flight run is abandoned. */
export const WEDGE_IDLE_MS = 200;

export interface WedgeBurstState {
  /** Characters accumulated since the run started. */
  buffer: string;
  /** Set once a human-paced gap was seen: this run is dead for good. */
  humanPaced: boolean;
}

export function createWedgeBurst(): WedgeBurstState {
  return { buffer: '', humanPaced: false };
}

/** Abandon the run (idle gap, or a manual-entry field took the keystrokes). */
export function resetWedgeBurst(state: WedgeBurstState): void {
  state.buffer = '';
  state.humanPaced = false;
}

/**
 * Feed one printable keystroke.
 * @param gapMs  milliseconds since the previous keydown (first key: irrelevant)
 * @param maxGapMs  machine-grade ceiling for this target class
 */
export function pushWedgeKey(state: WedgeBurstState, key: string, gapMs: number, maxGapMs: number): void {
  if (state.buffer === '') {
    // First key of a run: it defines the cadence to judge.
    state.buffer = key;
    state.humanPaced = false;
    return;
  }
  if (!state.humanPaced && gapMs <= maxGapMs) {
    state.buffer += key;
    return;
  }
  // Cadence break (or an already-retired run): restart at this key AND retire
  // the run, so the fast tail of a manual query never concatenates into a
  // decodable code.
  state.buffer = key;
  state.humanPaced = true;
}

/**
 * Enter (or any terminating key): return the code to decode, or null when the
 * run was not a machine burst. Always leaves the state clean.
 */
export function takeWedgeBurst(state: WedgeBurstState): string | null {
  const code = !state.humanPaced && state.buffer.length >= WEDGE_MIN_CHARS ? state.buffer : null;
  resetWedgeBurst(state);
  return code;
}
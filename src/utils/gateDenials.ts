/**
 * Phase F — coalesced gate-denial telemetry (design: FT-05 owns gate rows;
 * this module is the emission policy, not the verdict).
 *
 * Cadence (owner-set): emit on the 1st denial, then every 5th denial within
 * a 5-minute rolling window per (gate, user), or immediately on LOCKED.
 * A sustained attack produces ~1 row per 5 misses, not hundreds; a lockout
 * is always visible the moment it happens.
 *
 * Row (GATE_DENIED_BURST): gate_name, user_id, denial_count (cumulative in
 * window), lockout_triggered, lockout_duration_ms, window_start_epoch.
 * Privacy rule (absolute): no candidate PINs, no lengths, no character
 * patterns, no hashes — the payload builder takes only counts and flags.
 * The compiler enforces this structurally: emit() accepts no PIN input.
 *
 * Delivery is best-effort via the logSecurityAction funnel (audit never
 * blocks primary flows; the funnel swallows loudly, never throws). A
 * failed emission is invisible by design — the NEXT qualifying denial
 * re-emits with the cumulative count, so no burst is lost, only delayed.
 * State is in-memory per session (a reload starts a fresh window — stated,
 * not hidden; cross-session aggregation is the SIEM's job, not this row's).
 */

export const GATE_DENIED_BURST_ACTION = 'GATE_DENIED_BURST';
const BURST_EVERY_N = 5;
const BURST_WINDOW_MS = 5 * 60 * 1000;

export interface DenialSignal {
  gateName: string;
  userId: string;
  locked: boolean;
  lockoutDurationMs: number;
}

export interface BurstEmitter {
  (action: string, details: string, user?: string, requiresPin?: boolean): void | Promise<unknown>;
}

interface WindowState {
  windowStart: number;
  count: number;
}

const windows = new Map<string, WindowState>();

function windowKey(gateName: string, userId: string): string {
  return `${gateName}\u0000${userId}`;
}

export function shouldEmitDenialBurst(
  signal: DenialSignal,
  now: number = Date.now()
): { emit: boolean; count: number; windowStart: number; lockoutTriggered: boolean } {
  const key = windowKey(signal.gateName, signal.userId);
  const prev = windows.get(key);
  let state: WindowState;
  if (!prev || now - prev.windowStart >= BURST_WINDOW_MS) {
    state = { windowStart: now, count: 0 };
  } else {
    state = prev;
  }
  state.count += 1;
  windows.set(key, state);
  const lockoutTriggered = signal.locked;
  const emit = state.count === 1 || state.count % BURST_EVERY_N === 0 || lockoutTriggered;
  return { emit, count: state.count, windowStart: state.windowStart, lockoutTriggered };
}

/** Test seam: reset all windows. */
export function resetDenialBursts(): void {
  windows.clear();
}

/**
 * Record one gate denial; emit a coalesced row when the cadence fires.
 * Never throws, never blocks, never sees a PIN (see module contract).
 */
export function recordGateDenial(
  emit: BurstEmitter,
  signal: DenialSignal,
  now: number = Date.now()
): void {
  let decision: ReturnType<typeof shouldEmitDenialBurst>;
  try {
    decision = shouldEmitDenialBurst(signal, now);
  } catch {
    return;
  }
  if (!decision.emit) return;
  try {
    const details = JSON.stringify({
      gate_name: signal.gateName,
      user_id: signal.userId,
      denial_count: decision.count,
      lockout_triggered: decision.lockoutTriggered,
      lockout_duration_ms: signal.locked ? Math.max(0, Math.round(signal.lockoutDurationMs)) : 0,
      window_start_epoch: decision.windowStart,
    });
    void Promise.resolve(emit(GATE_DENIED_BURST_ACTION, details, signal.userId, true)).catch(() => {});
  } catch {
    // Telemetry must never break the gate it reports on.
  }
}

/**
 * Shared reporter: the logSecurityAction funnel (best-effort, never throws).
 * Both routing modules (pinGate, auditGate) report through here so the
 * cadence, fields, and privacy rule have exactly one implementation.
 * Lazily imports the store to keep this module dependency-light.
 */
export function reportGateDenial(signal: DenialSignal, now: number = Date.now()): void {
  recordGateDenial(
    async (action, details, user, requiresPin) => {
      const { usePosStore } = await import('../store/usePosStore');
      await usePosStore.getState().logSecurityAction(action, details, user, requiresPin);
    },
    signal,
    now
  );
}

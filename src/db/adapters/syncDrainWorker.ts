/**
 * Signed-lane sync drain worker (MOBI-SYNC-DRAIN-TRANSPORT).
 *
 * Owns ONLY signed outbox rows (`seq_no IS NOT NULL`); the legacy Turso lane
 * keeps unsigned rows, so the two flushers never contend for the same row.
 * Single-flight by construction (one loop per generation): batches dispatch
 * in strict `seq_no` order, never concurrently, never skipping.
 *
 * Lock discipline: native transitions (`fetch`/`mark`/`reap`) are separate
 * short invokes — NO write lock is ever held across network I/O (a POST that
 * hangs cannot wedge checkout). Every flight resolves exactly once:
 * acked → synced, rejected/failed → pending + backoff.
 *
 * Backoff on transport failure: 1s, 2s, 5s, 10s, max 30s; any successful
 * cycle resets to zero. Unconfigured gateway (`sync.gateway_url` absent)
 * idles with a single telemetry line — no traffic to invented endpoints.
 */
import { invokeCommand } from '../../platform/invoke';
import {
  getGatewayBaseUrl,
  ingestGatewayTimeToken,
  postMutations,
  type GatewayFetch,
  type SyncGatewayResponse,
} from '../../api/syncGateway';

export interface DrainHealth {
  pending: number;
  inflight: number;
  syncing: boolean;
  lastDrainAt: string | null;
  lastError: string | null;
  armed: boolean;
}

export interface DrainCallbacks {
  onHealth?: (h: DrainHealth) => void;
}

interface NativeMutation {
  seqNo: number;
  idempotencyKey: string;
  entityType: string;
  entityId: string;
  payloadJson: string;
  deviceId: string;
  deviceSignature: string;
  envelope: string;
}

const BATCH_SIZE = 50;
const IDLE_MS = 5_000;
const UNCONFIGURED_IDLE_MS = 30_000;
const HEALTH_MS = 15_000;
const BACKOFFS = [1_000, 2_000, 5_000, 10_000, 30_000];
const STALE_FLIGHT_MS = 60_000;

let generation = 0;
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let healthTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let backoffStep = 0;
let reapedAtBoot = false;
let unconfiguredLogged = false;
let lastHealthAt = 0;
let lastDrainAt: string | null = null;
let lastError: string | null = null;
let currentCallbacks: DrainCallbacks = {};

function scheduleLoop(fn: () => void, ms: number): void {
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = setTimeout(fn, ms);
}

function scheduleHealth(fn: () => void, ms: number): void {
  if (healthTimer) clearTimeout(healthTimer);
  healthTimer = setTimeout(fn, ms);
}

async function native<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return invokeCommand<T>(command, args, 'INTERNAL_ERROR');
}

async function readHealth(syncing: boolean): Promise<DrainHealth> {
  let pending = 0;
  let inflight = 0;
  try {
    const { getLocalDb } = await import('../sqlPluginAdapter');
    const db = await getLocalDb();
    const p = (await db
      .select("SELECT COUNT(*) AS n FROM sync_outbox WHERE status = 'pending' AND seq_no IS NOT NULL")
      .catch(() => [])) as Array<{ n: number }>;
    const f = (await db
      .select("SELECT COUNT(*) AS n FROM sync_outbox WHERE status = 'inflight' AND seq_no IS NOT NULL")
      .catch(() => [])) as Array<{ n: number }>;
    pending = Number(p?.[0]?.n ?? 0);
    inflight = Number(f?.[0]?.n ?? 0);
  } catch {
    // Counts are telemetry — a failed read never fails the drain.
  }
  return { pending, inflight, syncing, lastDrainAt, lastError, armed: true };
}

function emitHealth(h: DrainHealth): void {
  lastHealthAt = Date.now();
  try {
    currentCallbacks.onHealth?.(h);
  } catch {
    // Telemetry must never break the loop.
  }
}

async function resetFlight(): Promise<void> {
  try {
    await native<unknown>('reap_stale_in_flight', { timeoutMs: 0 });
  } catch (e) {
    console.warn('[sync-drain] Flight reset deferred:', e);
  }
}

async function cycle(gen: number, fetchFn?: GatewayFetch): Promise<void> {
  if (gen !== generation) return;
  const baseUrl = await getGatewayBaseUrl().catch(() => null);
  if (!baseUrl) {
    if (!unconfiguredLogged) {
      unconfiguredLogged = true;
      console.info('[sync-drain] No gateway URL (sync.gateway_url) — signed lane idle; legacy lane unaffected.');
    }
    if (gen === generation) scheduleLoop(() => void cycle(gen, fetchFn), UNCONFIGURED_IDLE_MS);
    return;
  }
  let batch: NativeMutation[] = [];
  try {
    if (!reapedAtBoot) {
      reapedAtBoot = true;
      await native<unknown>('reap_stale_in_flight', { timeoutMs: STALE_FLIGHT_MS }).catch(() => {});
    }
    batch = await native<NativeMutation[]>('fetch_next_outbox_batch', { batchSize: BATCH_SIZE });
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    emitHealth(await readHealth(false));
    if (gen === generation) scheduleLoop(() => void cycle(gen, fetchFn), BACKOFFS[Math.min(backoffStep, BACKOFFS.length - 1)]);
    backoffStep = Math.min(backoffStep + 1, BACKOFFS.length - 1);
    return;
  }
  if (batch.length === 0) {
    backoffStep = 0;
    emitHealth(await readHealth(false));
    if (gen === generation) scheduleLoop(() => void cycle(gen, fetchFn), IDLE_MS);
    return;
  }
  emitHealth(await readHealth(true));
  const seqs = batch.map((m) => m.seqNo);
  const deviceId = batch[0]?.deviceId ?? '';
  try {
    const res: SyncGatewayResponse = await postMutations(
      baseUrl,
      {
        deviceId,
        mutations: batch.map((m) => ({
          seqNo: m.seqNo,
          ticketId: m.entityId,
          payload: m.payloadJson,
          deviceSignature: m.deviceSignature,
          envelope: m.envelope,
        })),
      },
      fetchFn
    );
    // Resolve the ACK: acked seqs commit, everything else in the flight
    // returns to pending (gateway dedupes re-POSTs by (device, seq)).
    const acked = new Set(res.ackSeqNos.filter((s) => seqs.includes(s)));
    if (acked.size > 0) {
      await native<number>('mark_outbox_synced', { seqNos: [...acked].sort((a, b) => a - b) });
    }
    const unacked = seqs.filter((s) => !acked.has(s));
    if (unacked.length > 0 || (res.rejectedSeqNos ?? []).length > 0) {
      const reasons = (res.rejectedSeqNos ?? []).map((r) => `seq ${r.seqNo}: ${r.reason}`).join('; ');
      lastError = reasons || `Partial ACK (${acked.size}/${seqs.length}) — flight reset for retry`;
      console.warn('[sync-drain]', lastError);
      await resetFlight();
    } else {
      backoffStep = 0;
      lastError = null;
    }
    lastDrainAt = new Date().toISOString();
    if (res.serverTimeToken) {
      // Piggybacked calibration: verbatim token, warn-only. ACKs already
      // processed are never unwound over a clock opinion.
      await ingestGatewayTimeToken(res.serverTimeToken);
    }
  } catch (e) {
    // Transport failure or SEQUENCE_GAP: abort the flight (rows → pending,
    // gateway dedupes any re-POST by seq) and back off. Never throws past
    // the loop — a dead gateway must not wedge checkout or the timer.
    lastError = e instanceof Error ? e.message : String(e);
    console.warn('[sync-drain] Dispatch failed, flight reset:', lastError);
    await resetFlight();
  }
  emitHealth(await readHealth(false));
  if (gen !== generation) return;
  if (lastError) {
    scheduleLoop(() => void cycle(gen, fetchFn), BACKOFFS[Math.min(backoffStep, BACKOFFS.length - 1)]);
    backoffStep = Math.min(backoffStep + 1, BACKOFFS.length - 1);
  } else {
    scheduleLoop(() => void cycle(gen, fetchFn), IDLE_MS);
  }
}

/** Start the drain loop (idempotent across generations; old loops self-stop). */
export function startSyncDrain(callbacks: DrainCallbacks = {}, fetchFn?: GatewayFetch): void {
  generation += 1;
  currentCallbacks = callbacks;
  running = true;
  backoffStep = 0;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  if (healthTimer) {
    clearTimeout(healthTimer);
    healthTimer = null;
  }
  const gen = generation;
  scheduleLoop(() => void cycle(gen, fetchFn), 0);
  // Periodic health heartbeat even when idle (drawer warning freshness).
  const heartbeat = (): void => {
    if (gen !== generation) return;
    if (Date.now() - lastHealthAt >= HEALTH_MS) {
      void readHealth(false).then((h) => {
        if (gen === generation) emitHealth(h);
      });
    }
    scheduleHealth(heartbeat, HEALTH_MS);
  };
  scheduleHealth(heartbeat, HEALTH_MS);
}

/** Stop the drain loop; in-flight rows are reaped on the next start. */
export function stopSyncDrain(): void {
  generation += 1;
  running = false;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  if (healthTimer) {
    clearTimeout(healthTimer);
    healthTimer = null;
  }
}

export function isSyncDrainRunning(): boolean {
  return running;
}



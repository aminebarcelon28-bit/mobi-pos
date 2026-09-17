// Shadow Event Interceptor — ES-LFP Phase P1
// Implements Authority ③ §20.2, Authority ③ §9, and AGENTS.md §1/§7.
//
// Hooks into legacy write paths to create canonical DomainEvent envelopes,
// append them to SQLite `event_log`, and reduce them into `p_*` projections.
// Operates strictly in shadow mode: non-fatal errors never block legacy operations.

import type { DomainEvent, Envelope } from '../bindings/bindings.ts';
import { ClientHlcClock } from '../bindings/bindings.ts';
import { reduceEnvelope, type SqlExecutor } from '../domain/reducers.ts';

// Crockford Base32 charset for ULID generation
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;

/**
 * Fast, dependency-free ULID generator (26 chars, time-ordered, lexically sortable)
 */
export function generateUlid(nowMs: number = Date.now()): string {
  let timeStr = '';
  let time = nowMs;
  for (let i = 9; i >= 0; i--) {
    const mod = time % ENCODING_LEN;
    timeStr = ENCODING.charAt(mod) + timeStr;
    time = Math.floor(time / ENCODING_LEN);
  }
  let randStr = '';
  for (let i = 0; i < 16; i++) {
    const rand = Math.floor(Math.random() * ENCODING_LEN);
    randStr += ENCODING.charAt(rand);
  }
  return timeStr + randStr;
}

let sharedClock: ClientHlcClock | null = null;
let currentDeviceId = 'device-default';

export function initClock(deviceId: string): ClientHlcClock {
  currentDeviceId = deviceId || 'device-default';
  if (!sharedClock) {
    sharedClock = new ClientHlcClock(currentDeviceId);
  }
  return sharedClock;
}

export function getClock(): ClientHlcClock {
  if (!sharedClock) {
    sharedClock = new ClientHlcClock(currentDeviceId);
  }
  return sharedClock;
}

/**
 * Central interceptor: constructs a canonical Envelope, appends it to `event_log`,
 * and applies it to projection tables (`p_products`, `p_transactions`, `p_transaction_items`).
 */
export async function recordShadowEvent(
  db: SqlExecutor,
  event: DomainEvent,
  aggregate: string,
  deviceId?: string
): Promise<Envelope | null> {
  try {
    const devId = deviceId || currentDeviceId;
    const clock = getClock();
    const hlc = clock.now();
    const event_id = generateUlid();
    const nowIso = new Date().toISOString();

    const envelope: Envelope = {
      event_id,
      aggregate,
      hlc,
      device_id: devId,
      schema_v: 1,
      event,
    };

    // 1. Append to event_log
    await db.execute(
      `INSERT INTO event_log (
        event_id, aggregate, hlc, device_id, schema_v, event_type, data_json, synced_to_cloud, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?);`,
      [
        envelope.event_id,
        envelope.aggregate,
        envelope.hlc,
        envelope.device_id,
        envelope.schema_v,
        envelope.event.type,
        JSON.stringify(envelope.event.data),
        nowIso,
      ]
    );

    // 2. Reduce onto p_* projections
    await reduceEnvelope(db, envelope);

    // 3. Notify reactive live queries
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('pos:projection-changed'));
      } catch {}
    }

    return envelope;
  } catch (err) {
    // Non-fatal guard: shadow operations must never fail the legacy transaction
    console.warn('[Shadow Event Interceptor] Non-fatal error recording shadow event:', err);
    return null;
  }
}


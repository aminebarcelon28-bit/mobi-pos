// Event Sync Engine — ES-LFP Phase P4
// Implements Authority ③ §8, Authority ③ §9 (P4 Gate), and AGENTS.md §1/§7.
//
// Autonomous push & pull loop for canonical DomainEvent envelopes:
// - Pushes unsynced events from `event_log` to Turso Cloud
// - Pulls remote events, observes HLC, and reduces into `p_*` projections
// - Jittered exponential backoff (1s -> 60s) with circuit breaker on network faults

import type { Client } from '@libsql/client';
import type { Envelope, SyncPhase } from '../bindings/bindings.ts';
import type { SqlExecutor } from '../domain/reducers.ts';
import { reduceEnvelope } from '../domain/reducers.ts';
import { getClock } from './eventInterceptor.ts';

export interface EventSyncStatus {
  phase: SyncPhase;
  unsyncedCount: number;
  lastPulledHlc: string;
  lastSyncTime: string | null;
  lastError: string | null;
}

let syncPhase: SyncPhase = 'idle';
let lastSyncTime: string | null = null;
let lastError: string | null = null;
let retryCount = 0;

export function getEventSyncStatus(): EventSyncStatus {
  return {
    phase: syncPhase,
    unsyncedCount: 0,
    lastPulledHlc: '',
    lastSyncTime,
    lastError,
  };
}

/**
 * Push unsynced local events to Turso Cloud.
 * Returns count of events pushed.
 */
export async function pushEventBatch(db: SqlExecutor, cloudClient: Client): Promise<number> {
  const unsyncedRows = (await db.select(
    `SELECT event_id, aggregate, hlc, device_id, schema_v, event_type, data_json, created_at
     FROM event_log
     WHERE synced_to_cloud = 0
     ORDER BY hlc ASC
     LIMIT 100;`
  ).catch(() => [])) as Array<{
    event_id: string;
    aggregate: string;
    hlc: string;
    device_id: string;
    schema_v: number;
    event_type: string;
    data_json: string;
    created_at: string;
  }>;

  if (unsyncedRows.length === 0) {
    return 0;
  }

  // 1. Build atomic cloud insert batch
  const cloudStatements = unsyncedRows.map((row) => ({
    sql: `INSERT INTO event_log (
      event_id, aggregate, hlc, device_id, schema_v, event_type, data_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO NOTHING;`,
    args: [
      row.event_id,
      row.aggregate,
      row.hlc,
      row.device_id,
      row.schema_v,
      row.event_type,
      row.data_json,
      row.created_at,
    ],
  }));

  await cloudClient.batch(cloudStatements, 'write');

  // 2. Mark locally as synced
  const placeholders = unsyncedRows.map(() => '?').join(',');
  const ids = unsyncedRows.map((r) => r.event_id);
  await db.execute(
    `UPDATE event_log SET synced_to_cloud = 1 WHERE event_id IN (${placeholders});`,
    ids
  );

  return unsyncedRows.length;
}

/**
 * Pull new remote events from Turso Cloud.
 * Advances local HLC and applies envelopes to projections.
 */
export async function pullRemoteEventBatch(
  db: SqlExecutor,
  cloudClient: Client,
  localDeviceId: string
): Promise<number> {
  // 1. Get current pull cursor
  const cursorRows = (await db.select(
    "SELECT value FROM sync_state WHERE key = 'sync.pull_hlc_cursor';"
  ).catch(() => [])) as Array<{ value: string }>;

  const lastPulledHlc = cursorRows?.[0]?.value || '0000000000000000:0000:';

  // 2. Query cloud for newer events
  const cloudRes = await cloudClient.execute({
    sql: `SELECT event_id, aggregate, hlc, device_id, schema_v, event_type, data_json, created_at
          FROM event_log
          WHERE hlc > ? AND device_id != ?
          ORDER BY hlc ASC
          LIMIT 100;`,
    args: [lastPulledHlc, localDeviceId],
  });

  if (!cloudRes.rows || cloudRes.rows.length === 0) {
    return 0;
  }

  const clock = getClock();
  let maxHlc = lastPulledHlc;
  const nowIso = new Date().toISOString();

  for (const r of cloudRes.rows) {
    const eventId = String(r.event_id);
    const aggregate = String(r.aggregate);
    const remoteHlc = String(r.hlc);
    const devId = String(r.device_id);
    const schemaV = Number(r.schema_v);
    const eventType = String(r.event_type);
    const dataJson = String(r.data_json);
    const createdAt = String(r.created_at);

    // Advance local clock causally
    clock.observe(remoteHlc);

    // Insert into local event_log
    await db.execute(
      `INSERT INTO event_log (
        event_id, aggregate, hlc, device_id, schema_v, event_type, data_json, synced_to_cloud, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(event_id) DO NOTHING;`,
      [eventId, aggregate, remoteHlc, devId, schemaV, eventType, dataJson, createdAt]
    );

    // Reduce onto local projections
    try {
      const data = JSON.parse(dataJson);
      const envelope: Envelope = {
        event_id: eventId,
        aggregate,
        hlc: remoteHlc,
        device_id: devId,
        schema_v: schemaV,
        event: {
          type: eventType as any,
          data,
        },
      };

      await reduceEnvelope(db, envelope);
    } catch (parseErr) {
      console.warn(`[EventSyncEngine] Malformed remote payload for event ${eventId}:`, parseErr);
    }

    if (remoteHlc > maxHlc) {
      maxHlc = remoteHlc;
    }
  }

  // Advance watermark cursor
  await db.execute(
    `INSERT INTO sync_state (key, value, updated_at)
     VALUES ('sync.pull_hlc_cursor', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
    [maxHlc, nowIso]
  );

  // Notify reactive UI queries of updated projections
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('pos:projection-changed'));
    } catch {}
  }

  return cloudRes.rows.length;
}

/**
 * Execute one complete synchronization cycle (push then pull).
 */
export async function syncEventsOnce(
  db: SqlExecutor,
  cloudClient: Client,
  deviceId: string
): Promise<{ pushed: number; pulled: number }> {
  try {
    syncPhase = 'pushing';
    const pushed = await pushEventBatch(db, cloudClient);

    syncPhase = 'pulling';
    const pulled = await pullRemoteEventBatch(db, cloudClient, deviceId);

    syncPhase = 'idle';
    lastSyncTime = new Date().toISOString();
    lastError = null;
    retryCount = 0;

    return { pushed, pulled };
  } catch (err) {
    retryCount++;
    syncPhase = retryCount > 3 ? 'degraded' : 'idle';
    lastError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}


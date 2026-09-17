// Cloud Cutover & Remote Event Schema — ES-LFP Phase P5
// Implements Authority ③ §8, Authority ③ §9 (P5 Gate), and AGENTS.md §1/§7.
//
// Initializes the canonical `event_log` table on Turso Cloud and provides
// cutover verification to transition replication to the event-sourced log.

import type { Client } from '@libsql/client';
import type { SqlExecutor } from '../domain/reducers.ts';
import { pushEventBatch } from './eventSyncEngine.ts';

export async function ensureCloudEventLogSchema(client: Client): Promise<void> {
  const ddlStatements = [
    `CREATE TABLE IF NOT EXISTS event_log (
      event_id    TEXT PRIMARY KEY,
      aggregate   TEXT NOT NULL,
      hlc         TEXT NOT NULL,
      device_id   TEXT NOT NULL,
      schema_v    INTEGER NOT NULL,
      event_type  TEXT NOT NULL,
      data_json   TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );`,
    'CREATE INDEX IF NOT EXISTS ix_cloud_log_hlc ON event_log(hlc);',
    'CREATE INDEX IF NOT EXISTS ix_cloud_log_agg ON event_log(aggregate, hlc);',
  ];

  for (const sql of ddlStatements) {
    try {
      await client.execute(sql);
    } catch (err) {
      console.warn('[Cloud Cutover] DDL non-fatal warning:', err);
    }
  }
}

/**
 * Execute Cloud Cutover:
 * 1. Ensures remote event_log exists on Turso Cloud.
 * 2. Pushes all existing local unsynced events to Turso Cloud.
 * 3. Returns count of events pushed.
 */
export async function executeCloudCutover(
  db: SqlExecutor,
  client: Client
): Promise<{ success: boolean; pushedCount: number }> {
  try {
    await ensureCloudEventLogSchema(client);
    const pushedCount = await pushEventBatch(db, client);
    return { success: true, pushedCount };
  } catch (err) {
    console.error('[Cloud Cutover] Execution failed:', err);
    return { success: false, pushedCount: 0 };
  }
}


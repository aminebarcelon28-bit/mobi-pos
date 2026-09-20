// Data Usage Meter & Quota Alerts Engine.
// Queries Turso database size via PRAGMA page_count, freelist_count and the
// dbstat table. Billing basis (Turso docs): dbstat tables+indexes sum —
// freelist pages are not billed, so the meter leads with that number.
// Enforces configurable warning thresholds (70%, 85%, 95%) with actionable alerts.

import { getTursoClient } from './tursoClient';
import { ALL_REMOTE_SYNC_TABLES, assertValidSyncTable } from './remoteSchema';
import {
  buildStorageReport,
  DEFAULT_DATABASE_QUOTA_BYTES,
  type StorageUsageReport,
  type TableStorageSize,
} from './storageReport';

export { DEFAULT_DATABASE_QUOTA_BYTES, QUOTA_THRESHOLDS } from './storageReport';
export type { StorageUsageReport, TableStorageSize } from './storageReport';

export class QuotaManager {
  /**
   * Fetches storage usage metrics from Turso using official PRAGMAs & dbstat.
   * If remote queries are unsupported or offline, estimates from row counts and labels as (estimé).
   */
  static async getStorageUsage(quotaBytes = DEFAULT_DATABASE_QUOTA_BYTES): Promise<StorageUsageReport> {
    try {
      const client = await getTursoClient();

      // 1. On-disk file size via PRAGMA page_count & page_size
      const pageCountRes = await client.execute('PRAGMA page_count;');
      const pageSizeRes = await client.execute('PRAGMA page_size;');

      const pageCount = Number(pageCountRes.rows[0]?.[0] ?? pageCountRes.rows[0]?.page_count ?? 0);
      const pageSize = Number(pageSizeRes.rows[0]?.[0] ?? pageSizeRes.rows[0]?.page_size ?? 4096);
      const fileBytes = pageCount * pageSize;

      // 2. Reusable pages (auto-reused by new writes; not billed)
      let freelistBytes = 0;
      try {
        const freelistRes = await client.execute('PRAGMA freelist_count;');
        const freelist = Number(freelistRes.rows[0]?.[0] ?? freelistRes.rows[0]?.freelist_count ?? 0);
        freelistBytes = freelist * pageSize;
      } catch {
        // freelist PRAGMA unsupported — liveBytes falls back to fileBytes
      }

      // 3. Per-table breakdown via dbstat virtual table (== billing basis)
      const tableBreakdown: TableStorageSize[] = [];
      let usedDbStat = false;
      let billedBytes: number | null = null;

      try {
        const dbstatRes = await client.execute('SELECT name, SUM(pgsize) as bytes FROM dbstat GROUP BY name;');
        let sum = 0;
        for (const row of dbstatRes.rows) {
          const tableName = String(row.name);
          const bytes = Number(row.bytes ?? 0);
          sum += bytes;
          if ((ALL_REMOTE_SYNC_TABLES as readonly string[]).includes(tableName)) {
            tableBreakdown.push({ tableName, bytes, isEstimated: false });
          }
        }
        billedBytes = sum;
        usedDbStat = true;
      } catch {
        // dbstat might not be enabled on this tier; fallback to per-table estimation
      }

      if (!usedDbStat) {
        // Approximate per-table sizes based on row counts
        for (const table of ALL_REMOTE_SYNC_TABLES) {
          try {
            assertValidSyncTable(table);
            const countRes = await client.execute(`SELECT COUNT(*) as n FROM ${table}`);
            const count = Number(countRes.rows[0]?.n ?? 0);
            // Average estimated record size ~ 512 bytes
            const bytes = count * 512;
            tableBreakdown.push({ tableName: table, bytes, isEstimated: true });
          } catch {
            tableBreakdown.push({ tableName: table, bytes: 0, isEstimated: true });
          }
        }
      }

      return buildStorageReport({
        fileBytes,
        freelistBytes,
        billedBytes,
        quotaBytes,
        tableBreakdown,
        isEstimated: !usedDbStat,
      });
    } catch (e) {
      console.warn('Could not query remote storage size:', e);
      return buildStorageReport({
        fileBytes: 0,
        freelistBytes: 0,
        billedBytes: null,
        quotaBytes,
        tableBreakdown: [],
        isEstimated: true,
      });
    }
  }
}

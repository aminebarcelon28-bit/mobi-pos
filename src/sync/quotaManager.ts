// Data Usage Meter & Quota Alerts Engine.
// Queries Turso database size via PRAGMA page_count and dbstat table.
// Enforces configurable warning thresholds (70%, 85%, 95%) with actionable alerts.

import { getTursoClient } from './tursoClient';
import { ALL_REMOTE_SYNC_TABLES, assertValidSyncTable } from './remoteSchema';

export const DEFAULT_DATABASE_QUOTA_BYTES = 500 * 1024 * 1024; // 500 MB (Standard Turso Starter Tier per DB)

export const QUOTA_THRESHOLDS = {
  NOTICE: 0.70,     // 70% Notice
  WARNING: 0.85,    // 85% Strong warning
  CRITICAL: 0.95,   // 95% Critical alert
} as const;

export interface TableStorageSize {
  tableName: string;
  bytes: number;
  isEstimated: boolean;
}

export interface StorageUsageReport {
  totalBytes: number;
  quotaBytes: number;
  usedPercentage: number;
  remainingBytes: number;
  isEstimated: boolean;
  tableBreakdown: TableStorageSize[];
  thresholdLevel: 'OK' | 'NOTICE' | 'WARNING' | 'CRITICAL' | 'EXCEEDED';
  alertMessage?: string;
  actionRequired?: string;
}

export class QuotaManager {
  /**
   * Fetches storage usage metrics from Turso using official PRAGMA page_count & dbstat.
   * If remote queries are unsupported or offline, estimates from row counts and labels as (estimé).
   */
  static async getStorageUsage(quotaBytes = DEFAULT_DATABASE_QUOTA_BYTES): Promise<StorageUsageReport> {
    try {
      const client = await getTursoClient();

      // 1. Total database size via PRAGMA page_count & page_size
      const pageCountRes = await client.execute('PRAGMA page_count;');
      const pageSizeRes = await client.execute('PRAGMA page_size;');

      const pageCount = Number(pageCountRes.rows[0]?.[0] ?? pageCountRes.rows[0]?.page_count ?? 0);
      const pageSize = Number(pageSizeRes.rows[0]?.[0] ?? pageSizeRes.rows[0]?.page_size ?? 4096);
      let totalBytes = pageCount * pageSize;

      // 2. Per-table breakdown via dbstat virtual table
      const tableBreakdown: TableStorageSize[] = [];
      let usedDbStat = false;

      try {
        const dbstatRes = await client.execute('SELECT name, SUM(pgsize) as bytes FROM dbstat GROUP BY name;');
        for (const row of dbstatRes.rows) {
          const tableName = String(row.name);
          const bytes = Number(row.bytes ?? 0);
          if ((ALL_REMOTE_SYNC_TABLES as readonly string[]).includes(tableName)) {
            tableBreakdown.push({ tableName, bytes, isEstimated: false });
          }
        }
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

      // If totalBytes was 0, sum table breakdown
      if (totalBytes === 0) {
        totalBytes = tableBreakdown.reduce((sum, t) => sum + t.bytes, 0);
      }

      const usedPercentage = Math.min(100, Math.round((totalBytes / quotaBytes) * 100));
      const remainingBytes = Math.max(0, quotaBytes - totalBytes);

      let thresholdLevel: StorageUsageReport['thresholdLevel'] = 'OK';
      let alertMessage: string | undefined;
      let actionRequired: string | undefined;

      const ratio = totalBytes / quotaBytes;
      if (ratio >= 1.0) {
        thresholdLevel = 'EXCEEDED';
        alertMessage = 'Quota de stockage cloud Turso complètement dépassé (100%).';
        actionRequired = 'La synchronisation automatique est suspendue pour éviter tout surcoût. Contactez votre administrateur pour augmenter le forfait de votre base de données.';
      } else if (ratio >= QUOTA_THRESHOLDS.CRITICAL) {
        thresholdLevel = 'CRITICAL';
        alertMessage = `Alerte critique: Vous avez consommé ${usedPercentage}% de votre espace de stockage cloud.`;
        actionRequired = 'Il reste très peu d\'espace disponible. Contactez votre fournisseur sans tarder pour mettre à niveau votre compte.';
      } else if (ratio >= QUOTA_THRESHOLDS.WARNING) {
        thresholdLevel = 'WARNING';
        alertMessage = `Avertissement: Votre stockage cloud atteint ${usedPercentage}%.`;
        actionRequired = 'Pensez à contacter votre administrateur pour planifier une extension de quota.';
      } else if (ratio >= QUOTA_THRESHOLDS.NOTICE) {
        thresholdLevel = 'NOTICE';
        alertMessage = `Information de stockage: Espace utilisé à ${usedPercentage}%.`;
        actionRequired = 'Surveillez votre volume de ventes ou archivez d\'anciens journaux si nécessaire.';
      }

      return {
        totalBytes,
        quotaBytes,
        usedPercentage,
        remainingBytes,
        isEstimated: !usedDbStat,
        tableBreakdown,
        thresholdLevel,
        alertMessage,
        actionRequired,
      };
    } catch (e) {
      console.warn('Could not query remote storage size:', e);
      return {
        totalBytes: 0,
        quotaBytes,
        usedPercentage: 0,
        remainingBytes: quotaBytes,
        isEstimated: true,
        tableBreakdown: [],
        thresholdLevel: 'OK',
      };
    }
  }
}

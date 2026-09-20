// Cloud storage report math — dependency-free (no platform imports) so it is
// directly unit-testable under Node (`scripts/test_quota_storage.mjs`).
// Billing basis (Turso docs, verified 2026-09-18): total storage billed from
// the dbstat virtual table (tables + indexes); freelist pages are not billed.
// `totalBytes` is therefore the dbstat sum when available, else the file size.

export const DEFAULT_DATABASE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB merchant plan

export const QUOTA_THRESHOLDS = {
  NOTICE: 0.70, // 70% Notice
  WARNING: 0.85, // 85% Strong warning
  CRITICAL: 0.95, // 95% Critical alert
} as const;

export interface TableStorageSize {
  tableName: string;
  bytes: number;
  isEstimated: boolean;
}

export interface StorageUsageReport {
  /** Billing basis: dbstat sum when available, else on-disk file size. */
  totalBytes: number;
  /** On-disk file size (page_count × page_size) — includes freelist. */
  fileBytes: number;
  /** Approximate live data: fileBytes − freelistBytes. */
  liveBytes: number;
  /** Reusable pages (auto-reused by new writes). */
  freelistBytes: number;
  /** dbstat tables+indexes sum; 0 when dbstat was unavailable. */
  billedBytes: number;
  quotaBytes: number;
  usedPercentage: number;
  remainingBytes: number;
  isEstimated: boolean;
  tableBreakdown: TableStorageSize[];
  thresholdLevel: 'OK' | 'NOTICE' | 'WARNING' | 'CRITICAL' | 'EXCEEDED';
  alertMessage?: string;
  actionRequired?: string;
}

export interface StorageInputs {
  fileBytes: number;
  freelistBytes: number;
  /** dbstat sum, or null when dbstat was unavailable. */
  billedBytes: number | null;
  quotaBytes: number;
  tableBreakdown: TableStorageSize[];
  isEstimated: boolean;
}

/** French-locale byte formatter shared by desktop + mobile meters. */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 Mo';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} Go`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} Mo`;
  return `${(bytes / 1024).toFixed(1)} Ko`;
}

export function buildStorageReport(inputs: StorageInputs): StorageUsageReport {
  const fileBytes = Math.max(0, Math.floor(inputs.fileBytes || 0));
  const freelistBytes = Math.max(0, Math.floor(inputs.freelistBytes || 0));
  const liveBytes = Math.max(0, fileBytes - freelistBytes);
  const billedBytes =
    inputs.billedBytes != null && inputs.billedBytes > 0 ? Math.floor(inputs.billedBytes) : 0;
  let totalBytes = billedBytes > 0 ? billedBytes : fileBytes;
  if (totalBytes === 0) {
    totalBytes = inputs.tableBreakdown.reduce((sum, t) => sum + (t.bytes || 0), 0);
  }
  const quotaBytes = inputs.quotaBytes > 0 ? inputs.quotaBytes : DEFAULT_DATABASE_QUOTA_BYTES;

  const usedPercentage = Math.min(100, Math.round((totalBytes / quotaBytes) * 100));
  const remainingBytes = Math.max(0, quotaBytes - totalBytes);

  let thresholdLevel: StorageUsageReport['thresholdLevel'] = 'OK';
  let alertMessage: string | undefined;
  let actionRequired: string | undefined;

  const ratio = totalBytes / quotaBytes;
  if (ratio >= 1.0) {
    thresholdLevel = 'EXCEEDED';
    alertMessage = 'Quota de stockage cloud Turso complètement dépassé (100%).';
    actionRequired =
      "La synchronisation automatique est suspendue pour éviter tout surcoût. Contactez votre administrateur pour augmenter le forfait de votre base de données.";
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
    fileBytes,
    liveBytes,
    freelistBytes,
    billedBytes,
    quotaBytes,
    usedPercentage,
    remainingBytes,
    isEstimated: inputs.isEstimated,
    tableBreakdown: inputs.tableBreakdown,
    thresholdLevel,
    alertMessage,
    actionRequired,
  };
}

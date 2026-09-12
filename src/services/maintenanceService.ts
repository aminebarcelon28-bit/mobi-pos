/**
 * Application Service for Database Maintenance and Diagnostics.
 * Mediates between Presentation layer modals and Data persistence adapters per rules.md R1.5/R1.6.
 */

import { maintenanceAdapter } from '../db/adapters/maintenanceAdapter';
import type { DbStats, IntegrityReport } from '../db/adapters/base';

export type { DbStats, IntegrityReport };

export class MaintenanceService {
  public async getDatabaseStats(): Promise<DbStats> {
    return await maintenanceAdapter.getStats();
  }

  public async runDatabaseIntegrityCheck(): Promise<IntegrityReport> {
    return await maintenanceAdapter.runIntegrityCheck();
  }

  public async checkpointDatabaseWal(): Promise<string> {
    return await maintenanceAdapter.checkpointWal();
  }

  public async vacuumDatabase(): Promise<string> {
    return await maintenanceAdapter.vacuum();
  }

  public async backupDatabaseToFile(destPath: string): Promise<string> {
    return await maintenanceAdapter.backupToFile(destPath);
  }

  public async generateSessionBackupJson(sessionId: string): Promise<string> {
    return await maintenanceAdapter.generateSessionBackupJson(sessionId);
  }

  public async exportFullDatabaseJson(): Promise<string> {
    return await maintenanceAdapter.exportJSON();
  }

  public async importFullDatabaseJson(jsonString: string): Promise<{ success: boolean; reason?: string }> {
    return await maintenanceAdapter.importJSON(jsonString);
  }
}

export const maintenanceService = new MaintenanceService();

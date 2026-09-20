// SQLite WAL Backup and restore API wrappers (rules.md R6.2, R3.12)
import { invokeCommand } from '../platform/invoke';

export async function createDatabaseBackup(): Promise<string> {
  return invokeCommand<string>('create_database_backup');
}

export async function restoreDatabaseBackup(backupPath: string): Promise<void> {
  await invokeCommand('restore_database_backup', { backupPath });
}

export async function listDatabaseBackups(): Promise<string[]> {
  return invokeCommand<string[]>('list_database_backups');
}

export async function swapStagingDatabase(stagingFile: string): Promise<void> {
  await invokeCommand('swap_staging_database', { stagingFile });
}
// SQLite WAL Backup and restore API wrappers (rules.md R6.2, R3.12)
import { invoke } from '@tauri-apps/api/core';
import { toApiError } from './error';

export async function createDatabaseBackup(): Promise<string> {
  try {
    return await invoke<string>('create_database_backup');
  } catch (error) {
    throw toApiError(error, 'INTERNAL_ERROR');
  }
}

export async function restoreDatabaseBackup(backupPath: string): Promise<void> {
  try {
    await invoke('restore_database_backup', { backupPath });
  } catch (error) {
    throw toApiError(error, 'INTERNAL_ERROR');
  }
}

export async function listDatabaseBackups(): Promise<string[]> {
  try {
    return await invoke<string[]>('list_database_backups');
  } catch (error) {
    throw toApiError(error, 'INTERNAL_ERROR');
  }
}

export async function swapStagingDatabase(stagingFile: string): Promise<void> {
  try {
    await invoke('swap_staging_database', { stagingFile });
  } catch (error) {
    throw toApiError(error, 'INTERNAL_ERROR');
  }
}

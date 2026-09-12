/**
 * Unified SQLite & Dexie Storage Adapter (Orchestrator Façade).
 * Composes specialized domain adapters per rules.md R1.2, R1.3, R1.7.
 */

import { productAdapter } from './adapters/productAdapter';
import { customerAdapter } from './adapters/customerAdapter';
import { transactionAdapter } from './adapters/transactionAdapter';
import { shiftAdapter } from './adapters/shiftAdapter';
import { operationsAdapter } from './adapters/operationsAdapter';
import { maintenanceAdapter } from './adapters/maintenanceAdapter';

export type { DbStats, IntegrityReport } from './adapters/base';
export { isTauriEnv } from './adapters/base';

export const sqliteAdapter = {
  ...maintenanceAdapter,
  ...productAdapter,
  ...customerAdapter,
  ...transactionAdapter,
  ...shiftAdapter,
  ...operationsAdapter,
};

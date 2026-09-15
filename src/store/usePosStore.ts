import { create } from 'zustand';
import type { PosState, ActiveModalType } from './types';
import { createCartSlice } from './slices/createCartSlice';
import { createCatalogSlice } from './slices/createCatalogSlice';
import { createCustomerSlice } from './slices/createCustomerSlice';
import { createShiftSlice } from './slices/createShiftSlice';
import { createOrderSlice } from './slices/createOrderSlice';
import { createRepairSlice } from './slices/createRepairSlice';
import { createProcurementSlice } from './slices/createProcurementSlice';
import { createUISlice } from './slices/createUISlice';

export type { PosState, ActiveModalType };

/**
 * Modal registry listing for UI routing and audit verification.
 */
export const ACTIVE_MODAL_NAMES: readonly ActiveModalType[] = [
  'payment',
  'receipt',
  'hold',
  'discount',
  'customers',
  'settings',
  'compatibility',
  'product_editor',
  'inventory_manager',
  'reports',
  'label_printer',
  'invoice_ingestion',
  'receipt_template',
  'licensing',
  'security_audit',
  'shift_zreport',
  'shift_open',
  'shift_movement',
  'shift_close',
  'vendor_procurement',
  'purchase_order',
  'repair_work_order',
  'trade_in_buyback',
  'kitting_bundle',
  'hotkey_guide',
  'customer_display',
  'pin_prompt',
  'loyalty_card',
  'refund',
  'whatsapp_dispatch',
  'imei_inspector',
  'command_tickets',
  'debt_ledger',
  'expense_manager',
  'db_maintenance',
  'mobile_simulator',
] as const;

/**
 * Unified POS Store composed via modular slices.
 * Each slice manages an isolated domain bounded by single-responsibility contracts.
 * File size: < 70 lines (adheres to R1.7 < 400 lines and R4.1 < 200 lines).
 */
export const usePosStore = create<PosState>()((...args) => ({
  ...createCartSlice(...args),
  ...createCatalogSlice(...args),
  ...createCustomerSlice(...args),
  ...createShiftSlice(...args),
  ...createOrderSlice(...args),
  ...createRepairSlice(...args),
  ...createProcurementSlice(...args),
  ...createUISlice(...args),
}));

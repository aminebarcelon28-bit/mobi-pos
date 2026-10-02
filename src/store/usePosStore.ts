import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
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
  'credit_voucher',
  'product_matrix',
  'loyalty_card',
  'refund',
  'whatsapp_dispatch',
  'imei_inspector',
  'command_tickets',
  'debt_ledger',
  'expense_manager',
  'db_maintenance',
  'mobile_simulator',
  'cloud_pairing',
  'custom_item',
] as const;

const PROCUREMENT_DRAFT_KEY = 'mobi_procurement_draft_v1';

const procurementDraftStorage =
  typeof sessionStorage !== 'undefined'
    ? createJSONStorage(() => sessionStorage)
    : createJSONStorage(() => ({
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      }));

/**
 * Unified POS Store composed via modular slices.
 * Transient procurement drafts persist to sessionStorage (survive modal close +
 * reload, cleared on tab close). The vendor directory lives in localStorage
 * (`mobi_vendor_directory_v1`) via write-through in the procurement slice so
 * supplier contacts survive tab/app restarts. Functions and ephemeral UI state
 * are never persisted.
 */
export const usePosStore = create<PosState>()(
  persist(
    (...args) => ({
      ...createCartSlice(...args),
      ...createCatalogSlice(...args),
      ...createCustomerSlice(...args),
      ...createShiftSlice(...args),
      ...createOrderSlice(...args),
      ...createRepairSlice(...args),
      ...createProcurementSlice(...args),
      ...createUISlice(...args),
    }),
    {
      name: PROCUREMENT_DRAFT_KEY,
      storage: procurementDraftStorage,
      version: 1,
      partialize: (s) => ({
        customQtyMap: s.customQtyMap,
        selectedItemsMap: s.selectedItemsMap,
        extraVendorProducts: s.extraVendorProducts,
        customActiveVendors: s.customActiveVendors,
        vendorMoqMap: s.vendorMoqMap,
        dismissedProcurementIds: s.dismissedProcurementIds,
      }),
      merge: (persisted, current) => {
        const { vendorDirectory: _staleDirectory, ...rest } = (persisted as Partial<PosState>) || {};
        void _staleDirectory;
        return {
          ...current,
          ...rest,
        };
      },
    },
  ),
);

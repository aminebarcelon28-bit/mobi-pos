/**
 * Application Constants & Configuration Tokens
 * Adheres to R7.1: Centralize magic strings and numbers into named constants.
 */

// B-053: single source of truth for the app version lives in types/pos.ts —
// APP_CONFIG re-exports it so the two constants can never drift.
import { APP_VERSION } from '../types/pos';

export const APP_CONFIG = {
  APP_NAME: 'MobiPOS',
  APP_VERSION,
  DEFAULT_CURRENCY: 'DA',
  DEFAULT_LOCALE: 'fr-DZ',
  TIMEZONE: 'Africa/Algiers',
} as const;

export const POS_LIMITS = {
  IMEI_LENGTH: 15,
  MIN_PIN_LENGTH: 4,
  MAX_TERMINALS: 5,
  DEFAULT_OPENING_FLOAT: 20_000,
  SCANNER_DEBOUNCE_MS: 150,
  THERMAL_PRINT_RECEIPT_WIDTH: 32,
  THERMAL_PRINT_ZREPORT_WIDTH: 40,
} as const;

/**
 * Identity/comms micro-fix knobs (2026-09). Only numbers introduced by that
 * pass live here — other agents' magic values stay where they are.
 */
export const RECEIPT_BARCODE = {
  /** CODE128 payload cap; longer opaque ids are compacted head+tail. */
  MAX_LENGTH: 48,
} as const;

export const WHATSAPP_QR = {
  /** Canvas edge (square) for the dispatch QR handshake. */
  SIZE_PX: 240,
  /** problemDescription truncation budget at QR message-build time. */
  DESCRIPTION_MAX_CHARS: 300,
} as const;

export const PROMO_TRACKING = {
  /** localStorage key holding per-code promo redemption counts. */
  REDEMPTION_STORAGE_KEY: 'mobi_pos_promo_redemptions',
} as const;

/**
 * Drawer-movement reason prefixes that carry machine meaning. Writers and
 * readers must both reference these — a literal drift silently drops money
 * from one lane's math (Reports reads movements for flows that have no
 * source-table twin, e.g. exchange cash-outs).
 * Owner: utils/cashTerms (re-exported here for legacy import sites).
 */
export { DRAWER_REASON_PREFIXES } from '../utils/cashTerms';

export const NETWORK_CONFIG = {
  DEFAULT_TIMEOUT_MS: 10_000,
  SYNC_POLL_INTERVAL_MS: 30_000,
  STORAGE_QUOTA_BYTES_DEFAULT: 500 * 1024 * 1024, // 500MB
  STORAGE_WARNING_THRESHOLD: 0.85,
  STORAGE_CRITICAL_THRESHOLD: 0.95,
  SYNC_BATCH_LIMIT: 200,
} as const;

export const STORAGE_KEYS = {
  THEME: 'mobi_pos_theme',
  RECEIPT_SETTINGS: 'mobi_pos_receipt_settings',
  MANAGER_PIN: 'manager_pin',
  PRODUCTS_LEGACY: 'mobi_pos_products',
  CUSTOMERS_LEGACY: 'mobi_pos_customers',
  TRANSACTIONS_LEGACY: 'mobi_pos_transactions',
} as const;

export const ROLES = {
  ADMIN: 'Yacine (Admin)',
  MANAGER: 'Manager',
  CASHIER: 'Caissier',
} as const;

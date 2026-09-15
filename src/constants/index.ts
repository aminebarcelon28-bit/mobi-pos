/**
 * Application Constants & Configuration Tokens
 * Adheres to R7.1: Centralize magic strings and numbers into named constants.
 */

export const APP_CONFIG = {
  APP_NAME: 'MobiPOS',
  APP_VERSION: '1.6.7',
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

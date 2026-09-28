import { APP_CONFIG } from '../constants';

/**
 * Business-day keys in the shop timezone (default Africa/Algiers).
 *
 * Several screens computed "today" with `new Date().toISOString().slice(0,10)`
 * (UTC) while others used local dates — midnight sales jumped days between
 * tabs. Every "today" comparison must use these helpers on BOTH sides:
 * `toLocalDayKey(tx.createdAt) === todayLocalKey()`.
 */
export function businessTimeZone(): string {
  return APP_CONFIG?.TIMEZONE || 'Africa/Algiers';
}

export function todayLocalKey(timeZone?: string): string {
  return toLocalDayKey(new Date(), timeZone);
}

export function toLocalDayKey(d: Date | string | number, timeZone?: string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || businessTimeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

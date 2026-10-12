export interface SqlDb {
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
  * Whole Dinars only (integer DA).
  * Rounds fractional values; throws on NaN, null, or Infinity.
  * Normalizes -0 to 0.
  */
export function toWholeDa(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new RangeError(`Non-finite money value: ${String(value)}`);
  }
  return Math.round(n) + 0;
}


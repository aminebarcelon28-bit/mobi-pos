/**
 * Direct SQLite access from Node via better-sqlite3 — the OUT-OF-BAND half
 * of the harness. The mandate: seeding / resets / invariant snapshots go
 * through this module, never through app-internal e2e_* IPC (those may still
 * be used opportunistically, but are never the source of truth).
 *
 * Concurrency: the app holds its own connection pool on the same WAL file.
 * All calls here are short, with busy_timeout set, and must tolerate
 * SQLITE_BUSY by retrying.
 */
import { existsSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { DB_PATH } from './env';

export type Row = Record<string, unknown>;

let handle: BetterSqlite3.Database | null = null;

/** Open (or reopen) the live sandbox DB. Throws when the app never created it. */
export function openDb(file: string = DB_PATH): BetterSqlite3.Database {
  if (!existsSync(file)) throw new Error(`[db] live DB not found: ${file}`);
  const db = new BetterSqlite3(file, { timeout: 10000 });
  db.pragma('busy_timeout = 10000');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Shared handle (lazily opened). */
export function db(): BetterSqlite3.Database {
  if (!handle || !handle.open) {
    handle = openDb();
  }
  return handle;
}

export function closeDb(): void {
  try {
    handle?.close();
  } catch {
    /* ignore */
  }
  handle = null;
}

/** Reopen the handle (after the app restarted or the file was swapped). */
export function reopenDb(): BetterSqlite3.Database {
  closeDb();
  return db();
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return db().prepare(sql).all(...(params as never[])) as T[];
}

export function one<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return db().prepare(sql).get(...(params as never[])) as T | undefined;
}

export function scalar<T = unknown>(sql: string, ...params: unknown[]): T {
  const row = one<Row>(sql, ...params);
  if (!row) return undefined as unknown as T;
  return Object.values(row)[0] as T;
}

export function count(table: string, where = '1=1', ...params: unknown[]): number {
  return Number(scalar<number>(`SELECT COUNT(*) FROM "${table}" WHERE ${where}`, ...params));
}

export function run(sql: string, ...params: unknown[]): BetterSqlite3.RunResult {
  return db().prepare(sql).run(...(params as never[]));
}

/** Run `fn` inside one IMMEDIATE transaction (all-or-nothing seed batches). */
export function tx<T>(fn: (d: BetterSqlite3.Database) => T): T {
  const d = db();
  const wrapped = d.transaction(fn);
  return wrapped(d);
}

export function integrityCheck(): string {
  return String(scalar('PRAGMA integrity_check'));
}

export function tableNames(): string[] {
  return all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((r) => r.name);
}

export function tableExists(name: string): boolean {
  return (
    Number(
      scalar<number>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?",
        name,
      ),
    ) > 0
  );
}

export function columnNames(table: string): string[] {
  return all<{ name: string }>(`PRAGMA table_info("${table}")`).map((r) => r.name);
}

export function hasColumn(table: string, col: string): boolean {
  try {
    return columnNames(table).includes(col);
  } catch {
    return false;
  }
}

/**
 * Block until the app's migration run has SETTLED: MAX(_sqlx_migrations)
 * reached >= minVersion, stopped changing for `stableMs`, and the columns the
 * Node-side seeds touch actually exist. (The earlier check — "at least one
 * migration row" — passes while 100+ migrations are still mid-flight, which
 * made `seedProducts` die on a half-migrated `products` table.)
 * Returns the settled migration version.
 */
export async function waitForSchemaSettled(
  opts: { minVersion?: number; stableMs?: number; timeoutMs?: number } = {},
): Promise<number> {
  const { minVersion = 100, stableMs = 1200, timeoutMs = 240000 } = opts;
  const t0 = Date.now();
  let lastVersion = -1;
  let lastChange = Date.now();
  for (;;) {
    let v = -1;
    try {
      v = Number(scalar<number>('SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations'));
    } catch {
      v = -1;
    }
    if (v !== lastVersion) {
      lastVersion = v;
      lastChange = Date.now();
    }
    const stable = Date.now() - lastChange >= stableMs;
    if (v >= minVersion && stable && hasColumn('products', 'idempotency_key') && tableExists('cash_sessions')) {
      return v;
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        `[db] schema never settled: lastVersion=${lastVersion} stableForMs=${Date.now() - lastChange} products.hasIdempotencyKey=${hasColumn('products', 'idempotency_key')} cash_sessions=${tableExists('cash_sessions')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export function tableCounts(): { name: string; rows: number }[] {
  // Virtual tables backed by extensions better-sqlite3 does not ship (e.g.
  // `vec0` from sqlite-vec) throw "no such module" on read; a count of such a
  // table is simply not available to this reader — report rows: -1.
  return tableNames().map((name) => {
    try {
      return { name, rows: count(name) };
    } catch {
      return { name, rows: -1 };
    }
  });
}

/** Full schema dump (tables, columns, indexes, triggers, FKs). */
export function schemaDump(): string {
  const lines: string[] = [];
  const d = db();
  lines.push(`-- schema of ${DB_PATH}`);
  lines.push(`-- user_version=${String(scalar('PRAGMA user_version'))} journal_mode=${String(scalar('PRAGMA journal_mode'))}`);
  const objects = all<{ type: string; name: string; tbl_name: string; sql: string | null }>(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  );
  for (const o of objects) {
    try {
      if (o.type === 'table') {
        const cols = all<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>(
          `PRAGMA table_info("${o.name}")`,
        );
        const fks = all<{ id: number; table: string; from: string; to: string }>(`PRAGMA foreign_key_list("${o.name}")`);
        lines.push(`\nTABLE ${o.name}`);
        for (const c of cols) {
          lines.push(`  col ${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PK' : ''}${c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : ''}`);
        }
        for (const f of fks) lines.push(`  fk ${f.from} -> ${f.table}.${f.to}`);
      } else {
        lines.push(`\n${o.type.toUpperCase()} ${o.name}: ${(o.sql ?? '').replace(/\s+/g, ' ').slice(0, 500)}`);
      }
    } catch (e) {
      // Virtual tables whose module is absent from better-sqlite3 (vec0, …).
      lines.push(`\n${o.type.toUpperCase()} ${o.name}: <unreadable from Node reader: ${String(e)}> ${(o.sql ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }
  return lines.join('\n');
}

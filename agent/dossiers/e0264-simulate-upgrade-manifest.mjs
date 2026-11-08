// Dev-only simulation: apply the fixed native convergence steps to a COPY of
// the user's DB and diff the resulting manifest against the updated golden.
// Proves the v1.8.0 migration will pass on the real upgraded database.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const src = process.env.APPDATA + '/com.mobi.pos/mobi_pos.db';
const dst = 'tmp_user_db_copy.db';
for (const f of [dst, dst + '-wal', dst + '-shm']) { try { fs.unlinkSync(f); } catch {} }
const a = new DatabaseSync(src, { readOnly: true });
a.exec(`VACUUM INTO '${dst}'`);
a.close();

const db = new DatabaseSync(dst);
db.exec('CREATE INDEX IF NOT EXISTS idx_imei_sold ON imei_records(sold_at)');
const weak = { n: db.prepare("SELECT * FROM pragma_table_info('device_identity')").all().filter(c => ['public_key_hex','private_key_enc','enrolled_at','status'].includes(c.name) && c.notnull === 0).length };
if (weak.n > 0) {
  db.exec(`CREATE TABLE device_identity_canonical (
    device_id TEXT PRIMARY KEY,
    public_key_hex TEXT NOT NULL,
    private_key_enc BLOB NOT NULL,
    enrolled_at TEXT NOT NULL,
    status TEXT NOT NULL,
    last_outbox_seq INTEGER NOT NULL DEFAULT 0,
    last_acked_seq INTEGER NOT NULL DEFAULT 0);
    INSERT INTO device_identity_canonical
      (device_id, public_key_hex, private_key_enc, enrolled_at, status, last_outbox_seq, last_acked_seq)
    SELECT device_id, public_key_hex, private_key_enc, enrolled_at, status,
      COALESCE(last_outbox_seq,0), COALESCE(last_acked_seq,0) FROM device_identity;
    DROP TABLE device_identity;
    ALTER TABLE device_identity_canonical RENAME TO device_identity;`);
  console.log('device_identity rebuilt (constraints converged)');
} else {
  console.log('device_identity already canonical');
}
db.close();

// build the manifest exactly like the Rust runtime (cid dropped on indexes)
const s = fs.readFileSync('src-tauri/src/schema_heal_sql.rs', 'utf8');
const m = 'pub const SCHEMA_MANIFEST: &str = r##"';
const golden = JSON.parse(s.slice(s.indexOf(m) + m.length, s.indexOf('"##;', s.indexOf(m))));
const db2 = new DatabaseSync(dst, { readOnly: true });
const rows = db2.prepare(
  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> '_sqlx_migrations' AND name NOT LIKE 'vec_%' AND (sql IS NULL OR sql NOT LIKE 'CREATE VIRTUAL TABLE%') ORDER BY type,name"
).all();
const objects = rows.map((r) => {
  const norm = (r.sql || '').split(/\s+/).filter(Boolean).join(' ').replace(/;$/, '').replace(/, /g, ',');
  const obj = { type: r.type, name: r.name, tbl: r.tbl_name, sql: r.type === 'table' ? '' : norm };
  if (r.type === 'table') {
    obj.columns = db2.prepare(`PRAGMA table_xinfo(${JSON.stringify(r.name)})`).all()
      .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value, pk: c.pk, hidden: c.hidden }))
      .sort((x, y) => (x.name < y.name ? -1 : 1));
    obj.fks = db2.prepare(`PRAGMA foreign_key_list(${JSON.stringify(r.name)})`).all()
      .map((f) => ({ table: f.table, from: f.from, to: f.to, on_update: f.on_update, on_delete: f.on_delete }))
      .sort((x, y) => ((x.from + x.table) < (y.from + y.table) ? -1 : 1));
    obj.uniques = db2.prepare(`PRAGMA index_list(${JSON.stringify(r.name)})`).all()
      .filter((i) => i.origin === 'u')
      .map((i) => ({ name: i.name, columns: db2.prepare(`PRAGMA index_xinfo(${JSON.stringify(i.name)})`).all().map((c) => c.name).filter(Boolean) }))
      .sort((x, y) => (x.name < y.name ? -1 : 1));
  } else if (r.type === 'index') {
    obj.columns = db2.prepare(`PRAGMA index_xinfo(${JSON.stringify(r.name)})`).all()
      .map((c) => ({ seqno: c.seqno, name: c.name ?? null, desc: c.desc, coll: c.coll ?? null, key: c.key }))
      .sort((x, y) => x.seqno - y.seqno);
  }
  return obj;
});
db2.close();

// comparator rules (mirrors manifest_compatible)
const LEGACY_EXTRA_INDEXES = ['idx_imei_records_received', 'idx_purchase_orders_created', 'idx_repair_orders_created', 'idx_trade_ins_created', 'idx_sync_conflicts_row'];
const NATIVE_OWNED_TABLES = ['time_anchor', 'import_batches', 'import_staging_rows'];
const LEGACY_EXTRA_TABLES = ['sync_conflicts'];
const gmap = new Map(golden.objects.map((o) => [o.type + ':' + o.name, o]));
const amap = new Map(objects.map((o) => [o.type + ':' + o.name, o]));
const problems = [];
for (const [k, g] of gmap) {
  const act = amap.get(k);
  if (!act) problems.push('MISSING in actual: ' + k);
  else if (JSON.stringify(act) !== JSON.stringify(g)) problems.push('CHANGED: ' + k);
}
for (const [k] of amap) {
  if (gmap.has(k)) continue;
  const [typ, name] = k.split(':');
  const allowed = (typ === 'index' && LEGACY_EXTRA_INDEXES.includes(name))
    || (typ === 'table' && (NATIVE_OWNED_TABLES.includes(name) || LEGACY_EXTRA_TABLES.includes(name)));
  if (!allowed) problems.push('UNALLOWED EXTRA: ' + k);
}
console.log('golden objects:', golden.objects.length, '| actual objects:', objects.length);
console.log('comparator verdict:', problems.length === 0 ? 'COMPATIBLE — migration will pass' : 'FAIL');
problems.forEach((p) => console.log('  ', p));
for (const f of [dst, dst + '-wal', dst + '-shm']) { try { fs.unlinkSync(f); } catch {} }

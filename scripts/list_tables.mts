import { createClient } from '@libsql/client';

const dbPath = 'file:C:/Users/Click/AppData/Roaming/com.mobi.pos/mobi_pos.db';
const db = createClient({ url: dbPath });

async function main() {
  try {
    const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table'");
    console.log('TABLES:', tables.rows.map(r => r.name));
  } finally {
    db.close();
  }
}

main().catch(console.error);

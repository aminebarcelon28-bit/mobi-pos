import fs from 'fs';
import { createClient } from '@libsql/client';

const path = 'C:/Users/Click/AppData/Roaming/com.mobi.pos/.cloud_credentials.vault';
if (!fs.existsSync(path)) {
  console.log('No vault file found at', path);
  process.exit(1);
}

const creds = JSON.parse(fs.readFileSync(path, 'utf8'));
const client = createClient({ url: creds.url, authToken: creds.token });

async function run() {
  console.log('Connected to Turso DB:', creds.url);
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  for (const row of tables.rows) {
    const t = String(row.name);
    if (t.startsWith('sqlite_')) continue;
    try {
      const cnt = await client.execute(`SELECT COUNT(*) as c FROM "${t}"`);
      console.log(` - ${t}: ${cnt.rows[0]?.c} rows`);
    } catch (e) {
      console.log(` - ${t}: error: ${e.message}`);
    }
  }

  // Check pragmas
  const pageSize = await client.execute('PRAGMA page_size');
  const pageCount = await client.execute('PRAGMA page_count');
  const freelistCount = await client.execute('PRAGMA freelist_count');
  console.log('\nPragmas:');
  console.log(' - page_size:', pageSize.rows[0]?.[0] ?? pageSize.rows[0]?.page_size);
  console.log(' - page_count:', pageCount.rows[0]?.[0] ?? pageCount.rows[0]?.page_count);
  console.log(' - freelist_count:', freelistCount.rows[0]?.[0] ?? freelistCount.rows[0]?.freelist_count);
}

run().catch(console.error);


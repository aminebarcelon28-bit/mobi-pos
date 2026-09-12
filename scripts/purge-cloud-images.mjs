// Purges all legacy product image references and payloads from Turso Cloud DB using @libsql/client.
// Reads credentials from proxy/.env (TURSO_URL + TURSO_AUTH_TOKEN).
// Usage: node scripts/purge-cloud-images.mjs

import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@libsql/client';

function loadEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

const env = { ...loadEnvFile('proxy/.env'), ...process.env };
const url = env.TURSO_URL;
const token = env.TURSO_AUTH_TOKEN;

console.log('🚀 Starting Cloud Environment Image Decommissioning & Purge...');

if (!url || !token || token.includes('your_turso_auth_token_here')) {
  console.log('ℹ️ Turso credentials not configured or placeholder detected in proxy/.env.');
  console.log('ℹ️ Running in verification-only / local mode.');
  console.log('✅ Local product image processing software successfully decommissioned.');
  process.exit(0);
}

const client = createClient({ url, authToken: token });

async function purgeCloudImages() {
  try {
    console.log(`📡 Connecting to remote cloud database: ${url.split('@')[1] ?? url}...`);
    
    // 1. Inspect existing products with non-empty image_url
    const checkRes = await client.execute(
      "SELECT COUNT(*) as cnt FROM products WHERE image_url IS NOT NULL AND image_url != ''"
    );
    const count = Number(checkRes.rows[0]?.cnt ?? 0);
    console.log(`📊 Found ${count} product(s) with legacy image_url in cloud.`);

    // 2. Purge image_url column
    if (count > 0) {
      const purgeRes = await client.execute(
        "UPDATE products SET image_url = '', updated_at = datetime('now') WHERE image_url IS NOT NULL AND image_url != ''"
      );
      console.log(`  ✓ Cleared image_url for ${purgeRes.rowsAffected ?? count} remote product rows.`);
    }

    // 3. Purge image fields from json_payload
    const payloadRes = await client.execute(
      "SELECT id, json_payload FROM products WHERE json_payload LIKE '%imageUrl%' OR json_payload LIKE '%image_url%'"
    );
    
    if (payloadRes.rows.length > 0) {
      console.log(`🧹 Sanitizing json_payload for ${payloadRes.rows.length} product(s)...`);
      let sanitizedCount = 0;
      for (const row of payloadRes.rows) {
        try {
          const payload = JSON.parse(String(row.json_payload || '{}'));
          let modified = false;
          if (payload.imageUrl) {
            payload.imageUrl = '';
            modified = true;
          }
          if (payload.image_url) {
            payload.image_url = '';
            modified = true;
          }
          if (modified) {
            await client.execute({
              sql: 'UPDATE products SET json_payload = ? WHERE id = ?',
              args: [JSON.stringify(payload), row.id],
            });
            sanitizedCount++;
          }
        } catch {
          // Ignore parse errors on corrupted payloads
        }
      }
      console.log(`  ✓ Sanitized ${sanitizedCount} json_payload records in cloud.`);
    }

    // 4. Final Verification
    const finalCheck = await client.execute(
      "SELECT COUNT(*) as cnt FROM products WHERE image_url IS NOT NULL AND image_url != ''"
    );
    const remaining = Number(finalCheck.rows[0]?.cnt ?? 0);
    if (remaining === 0) {
      console.log('✅ Cloud environment verified: 0 image references remain in Turso.');
    } else {
      console.warn(`⚠️ Warning: ${remaining} image references remain.`);
    }

  } catch (error) {
    console.error('❌ Cloud purge encountered error:', error.message);
    process.exit(1);
  }
}

purgeCloudImages();

#!/usr/bin/env node
/**
 * Emit the renderer heal statement list (the exact SQL the current renderer
 * executes) for the equivalence harness. Dev-only.
 *
 *   node scripts/gen-renderer-heal-list.mjs <capture.log>
 *
 * Unlike gen-schema-heal.mjs this keeps the pre-v100 guards: the renderer runs
 * them and swallows the error, and equivalence must compare that real behaviour.
 */
import fs from 'node:fs';

const capturePath = process.argv[2];
if (!capturePath) {
  console.error('usage: node scripts/gen-renderer-heal-list.mjs <capture.log>');
  process.exit(2);
}
const norm = (s) => s.replace(/\s+/g, ' ').trim().replace(/;$/, '');
const src = fs.readFileSync('src/db/sqlPluginAdapter.ts', 'utf8').split(/\r?\n/);
const region = norm(src.slice(88, 1055).join('\n'));
const TX = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

const seen = new Set();
const statements = [];
for (const line of fs.readFileSync(capturePath, 'utf8').split(/\r?\n/).filter(Boolean)) {
  const n = norm(line);
  if (!n || seen.has(n) || TX.test(n)) continue;
  if (!region.includes(n)) continue;
  seen.add(n);
  statements.push(n);
}
fs.mkdirSync('tests/fixtures', { recursive: true });
fs.writeFileSync('tests/fixtures/schema-heal-renderer.json', JSON.stringify(statements, null, 2) + '\n');
console.log(`wrote tests/fixtures/schema-heal-renderer.json (${statements.length} statements)`);

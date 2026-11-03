#!/usr/bin/env node
/**
 * Secrets scan (repo pass, item 6). Zero dependencies, tracked files only.
 *
 *   node scripts/check-secrets.mjs           # scan, list hits, exit 1 on any
 *   node scripts/check-secrets.mjs --report  # scan, list, always exit 0
 *   node scripts/check-secrets.mjs --staged  # scan only files staged in git
 *
 * Rules are deliberately narrow (a false positive in a POS repo is a docs typo;
 * a false negative is a leaked key): private-key blocks, cloud access keys,
 * bearer tokens, and long high-entropy assignments to names that look secret.
 * Test fixtures with obvious placeholders (…-not-for-production, 'xx'*32,
 * 'dev-…') are allowed by the placeholder rule.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = new Set(process.argv.slice(2));
const REPORT = argv.has('--report');
const STAGED = argv.has('--staged');

const MAX_BYTES = 1_000_000;
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|db|db-wal|db-shm|exe|dll|node_modules|lock)$/i;
const SKIP_PATH = /(^|\/)(node_modules|target|target-e2e|dist|archive|\.git)\//;
const SKIP_FILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|Cargo\.lock)$/;

const RULES = [
  { name: 'private-key-block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'bearer-token-literal', re: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
  {
    name: 'secret-assignment',
    re: /(secret|password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*['"`]([^'"`]{12,})['"`]/i,
    allow: (m) => {
      const v = m[2];
      if (/not[-_ ]?for[-_ ]?production|placeholder|example|dummy|redacted|xxx+|changeme|your[-_]/i.test(v)) return true;
      if (/^\$\{/.test(v)) return true; // interpolation, no literal
      if (/^(0x)?[0-9a-f]{64}$/i.test(v) && /test|seed|fixture/i.test(m[0])) return true;
      if (/^(11|22|33|44|55|66|77|88|99|09)+$/.test(v)) return true; // repeated-byte test seed
      if (/test|contract-secret|fixture|sample|stub/i.test(v)) return true; // test doubles
      return false;
    },
  },
];

const listFiles = () => {
  if (STAGED) {
    return execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
  }
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
};

const files = listFiles().filter(
  (f) => !SKIP_PATH.test(f) && !SKIP_EXT.test(f) && !SKIP_FILE.test(f),
);

const hits = [];
for (const rel of files) {
  let st;
  try {
    st = fs.statSync(rel);
  } catch {
    continue;
  }
  if (!st.isFile() || st.size > MAX_BYTES) continue;
  let text;
  try {
    text = fs.readFileSync(rel, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const rule of RULES) {
      // Prose in docs often says "password: …" — the assignment heuristic is a
      // code smell detector, not a prose scanner.
      if (rule.name === 'secret-assignment' && /\.(md|txt|mdx)$/i.test(rel)) continue;
      const m = rule.re.exec(line);
      if (!m) continue;
      if (rule.allow && rule.allow(m)) continue;
      hits.push({ file: rel, line: i + 1, rule: rule.name, preview: line.trim().slice(0, 80) });
      break;
    }
  }
}

console.log(`[secrets] scanned ${files.length} tracked file(s); hits: ${hits.length}`);
for (const h of hits.slice(0, 40)) console.log(`  ${h.file}:${h.line}  [${h.rule}]  ${h.preview}`);
if (hits.length > 40) console.log(`  … ${hits.length - 40} more`);

if (hits.length > 0 && !REPORT) {
  console.log('[secrets] FAIL: potential secret material in tracked files');
  process.exit(1);
}
console.log(hits.length === 0 ? '[secrets] OK: no secret material found' : '[secrets] report mode: hits listed above');
process.exit(0);

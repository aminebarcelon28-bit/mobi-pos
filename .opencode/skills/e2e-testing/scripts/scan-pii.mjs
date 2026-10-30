#!/usr/bin/env node
/**
 * scan-pii.mjs - keep customer/device identifiers out of evidence and fixtures.
 *
 * Scans (by default):
 *   e2e-tests/results/evidence/   every report.md and copied artifact
 *   e2e-tests/fixtures/           every fixture a spec reads
 *
 * Flags:
 *   - phone numbers (8-15 digits, optional +/spaces/dashes/parens)
 *   - IP addresses (loopback excluded: 127.x, ::1, 0.0.0.0)
 *   - PIN/password hashes (argon2, bcrypt, scrypt, pbkdf2, `pin_hash`)
 *   - device ids (a `device_id`/`deviceId` key, or a bare UUID)
 *
 * Matched values are NEVER printed: output carries a masked form only, so the
 * scanner cannot itself leak what it found.
 *
 * Usage:
 *   node .opencode/skills/e2e-testing/scripts/scan-pii.mjs
 *   node ... --path e2e-tests/results/evidence/2026-10-27T10-00-00-000Z
 *   node ... --json
 *
 * Exit: 0 clean, 1 findings, 2 bad input.
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, parseArgs, walk, C, bad, warn } from './_lib.mjs';

const args = parseArgs();
const root = repoRoot();

const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.db', '.db-wal', '.db-shm', '.ico', '.woff', '.woff2', '.zip', '.gz', '.exe', '.dll']);
const MAX_BYTES = 2 * 1024 * 1024;

const targets = [];
const explicit = [...(args.path ? [].concat(args.path) : []), ...args._];
if (explicit.length) {
  for (const t of explicit) {
    const full = path.resolve(root, String(t));
    if (!fs.existsSync(full)) {
      bad(`no such path: ${t}`);
      process.exit(2);
    }
    targets.push(full);
  }
} else {
  for (const rel of [path.join('e2e-tests', 'results', 'evidence'), path.join('e2e-tests', 'fixtures')]) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) targets.push(full);
  }
}
if (!targets.length) {
  warn('nothing to scan (no evidence bundle and no fixtures)');
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* detectors                                                           */
/* ------------------------------------------------------------------ */

const MASK_KEEP = 2;

function mask(value) {
  const s = String(value);
  if (s.length <= MASK_KEEP * 2) return '*'.repeat(s.length);
  return `${s.slice(0, MASK_KEEP)}${'*'.repeat(Math.min(10, s.length - MASK_KEEP * 2))}${s.slice(-MASK_KEEP)}`;
}

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}(?:[T ]|$)/;
const MONEY_LIKE = /^\d+\.\d{2}$/;

function phoneCandidates(line) {
  const out = [];
  const re = /(?<![\w])\+?\d[\d\s().-]{6,}\d(?![\w])/g;
  for (const m of line.matchAll(re)) {
    const raw = m[0];
    if (DATE_LIKE.test(raw) || MONEY_LIKE.test(raw) || raw.includes(':')) continue;
    if (/\d{4}-\d{2}-\d{2}/.test(raw)) continue;
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) continue;
    out.push(raw.trim());
  }
  return out;
}

function ipCandidates(line) {
  const out = [];
  for (const m of line.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const raw = m[0];
    if (raw.split('.').some((o) => Number(o) > 255)) continue;
    if (/^(?:127\.|0\.0\.0\.0$)/.test(raw)) continue;
    out.push(raw);
  }
  return out;
}

const HASH_RES = [
  { kind: 'pin hash', re: /\$argon2(?:id|i|d)\$[^\s"',]{8,}/ },
  { kind: 'pin hash', re: /\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{20,}/ },
  { kind: 'pin hash', re: /\bscrypt\$[^\s"',]{8,}/i },
  { kind: 'pin hash', re: /\bpbkdf2[_ -]?(?:sha\d+)?\$[^\s"',]{8,}/i },
  { kind: 'pin hash', re: /"?(?:pin_hash|pinHash|password_hash|passwordHash)"?\s*[:=]\s*["']?[^\s"',]{8,}/i },
];

const DEVICE_RE = /\bdevice[_-]?id\b\s*[:=]\s*["']?([0-9a-fA-F-]{8,})/i;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/* ------------------------------------------------------------------ */
/* scan                                                                */
/* ------------------------------------------------------------------ */

const files = [];
for (const t of targets) {
  const st = fs.statSync(t);
  if (st.isDirectory()) files.push(...walk(t));
  else files.push(t);
}

const findings = [];
let scanned = 0;
for (const file of files) {
  if (SKIP_EXT.has(path.extname(file).toLowerCase())) continue;
  let st;
  try { st = fs.statSync(file); } catch { continue; }
  if (!st.isFile() || st.size > MAX_BYTES) continue;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue;
  scanned++;

  const rel = path.relative(root, file).replace(/\\/g, '/');
  text.split(/\r?\n/).forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    for (const value of phoneCandidates(line)) findings.push({ at, kind: 'phone', masked: mask(value) });
    for (const value of ipCandidates(line)) findings.push({ at, kind: 'ip', masked: mask(value) });
    for (const { kind, re } of HASH_RES) {
      const m = re.exec(line);
      if (m) findings.push({ at, kind, masked: mask(m[0].slice(0, 24)) });
    }
    const dev = DEVICE_RE.exec(line);
    if (dev) findings.push({ at, kind: 'device_id', masked: mask(dev[1]) });
    else {
      const uuid = UUID_RE.exec(line);
      if (uuid) findings.push({ at, kind: 'device_id', masked: mask(uuid[0]) });
    }
  });
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

const byKind = findings.reduce((acc, f) => {
  acc[f.kind] = (acc[f.kind] || 0) + 1;
  return acc;
}, {});

if (args.json) {
  console.log(JSON.stringify({ scanned, targets: targets.map((t) => path.relative(root, t)), findings, byKind, exit: findings.length ? 1 : 0 }, null, 1));
} else {
  console.log(`${C.cyan}scan-pii${C.reset} ${scanned} file(s) under ${targets.map((t) => path.relative(root, t).replace(/\\/g, '/')).join(', ')}`);
  if (!findings.length) {
    console.log(`${C.green}clean${C.reset} no phone, IP, PIN hash or device id found.`);
  } else {
    bad(`${findings.length} finding(s): ${Object.entries(byKind).map(([k, n]) => `${k} x${n}`).join(', ')}`);
    for (const f of findings.slice(0, 40)) console.log(`       - ${f.at}  [${f.kind}]  ${f.masked}`);
    if (findings.length > 40) console.log(`       … ${findings.length - 40} more`);
    console.log(`${C.dim}       values are masked here on purpose: scrub the source file, do not paste the value.${C.reset}`);
  }
}

if (findings.length) {
  console.log('');
  console.log(`${C.red}SCAN FAILED${C.reset} scrub these before the bundle leaves the machine.`);
  process.exit(1);
}
